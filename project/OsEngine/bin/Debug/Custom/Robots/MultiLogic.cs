/*
 * Your rights to use code governed by this license https://github.com/AlexWan/OsEngine/blob/master/LICENSE
 * Ваши права на использование кода регулируются данной лицензией http://o-s-a.net/doc/license_simple_engine.pdf
*/

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using OsEngine.Entity;
using OsEngine.Indicators;
using OsEngine.Logging;
using OsEngine.Market;
using OsEngine.Market.Servers;
using OsEngine.OsTrader.Panels;
using OsEngine.OsTrader.Panels.Tab;
using OsEngine.Charts.CandleChart;
using OsEngine.Market.Servers.Tester;
using OsEngine.Market.Servers.Optimizer;
using OsEngine.Market.Connectors;
using OsEngine.Candles.Series;
using OsEngine.Candles.Factory;
using OsEngine.Candles;
using System.Collections;
using System.Threading.Tasks;
using System.Threading;
using Microsoft.Win32;
using Newtonsoft.Json;

/*
Description

Подготовительный скринер для сравнения нескольких торговых логик.
Строка логики — Note(…), справка: Custom\Robots\MultiLogic_LogicHelp.html (кнопка Help; файл обновляется автоматически).
Парсинг строк «Логика 1…10», общие индикаторы, торговля по сигналам Op/Cl (Regime=On).
*/

namespace OsEngine.Robots.Custom
{
    /*
     * ////////////////////////////////////////////////////////////////////////////////
     * ////////////////////////////////////////////////////////////////////////////////
     * ////////////////////////////////////////////////////////////////////////////////
     * MultiLogic.cs — один файл, четыре логических блока (см. баннеры ниже)
     *  БЛОК 1  MultiLogic (partial)     — движок робота, торговля, Stopper, MOEX…
     *  БЛОК 4  MultiLogic (partial)     — HTML-отчёт результатов (Engine\\*_Report.html)
     *  БЛОК 2  LogicLineParser + типы  — разбор строк «Логика 1…10», AST, индикаторы
     *  БЛОК 3  MultiLogicHelpBuilder   — текст/HTML справки (MultiLogic_LogicHelp.html)
     * ////////////////////////////////////////////////////////////////////////////////
     * ////////////////////////////////////////////////////////////////////////////////
     * ////////////////////////////////////////////////////////////////////////////////
     */

    /// <summary>
    /// Заводские строки «Логика 1…4» — единый источник для CreateParameter, кнопки сброса,
    /// подсказок и раздела «6a) Стандартные логики» в MultiLogic_LogicHelp.html.
    /// </summary>
    internal static class MultiLogicDefaultLogics
    {
        /// <summary>Ссылка на параметр «Длина линейной регрессии» в строках логики (см. LogicLineParser.LinRegLengthParamToken).</summary>
        public const string LinRegLengthRef = "@LR";

        /// <summary>Ссылка на параметр «Strict (строгость)» в строках логики (см. LogicLineParser.StrictnessParamToken).</summary>
        public const string StrictnessRef = "@Strict";

        public const string StrictPrefix = "Strict(" + StrictnessRef + ") ";

        public const string TrendRegimePrefix =
            StrictPrefix
            + "Regime(LinReg;L=" + LinRegLengthRef + ";Dev=2;SlopeLb=3;OnFlip=Close;Entry=MatchSide) ";

        public const string BokovikRegimePrefix =
            StrictPrefix
            + "Regime(LinReg;L=" + LinRegLengthRef + ";Dev=2;SlopeLb=3;SlopeDead=0.05%;OnFlip=Close;Entry=FlatOnly) ";

        public const string Logic1LongTrend =
            TrendRegimePrefix
            + "(SMA(100) Op[Ab] Cl[Bl]) AND "
            + "(LinReg(" + LinRegLengthRef + ";Dev=2) Op[AbUp] Cl[BlLo]) AND "
            + "(ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-]) AND "
            + "(CCI(20;Lmin=100;Smax=-100) Op[CCI>=100] Cl[CCI<=-100]) AND "
            + "(MACD(12,26,9) Op[Macd>Sig] Cl[Macd<Sig] Note(lon-trend))";

        public const string Logic2LongBokovik =
            BokovikRegimePrefix
            + "(SMA(100) Op[Ab] Cl[Bl]) AND "
            + "(Stoch(14-3-3;Lmin=90;Smax=10) Op[K<=10] Cl[K>=90]) AND "
            + "(ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-]) AND "
            + "(MACD(12,26,9) Op[Macd>Sig] Cl[Macd<Sig] Note(lon-bokovik))";

        public const string Logic3ShortTrend =
            TrendRegimePrefix
            + "(SMA(100) Side[S] Op[Bl] Cl[Ab]) AND "
            + "(LinReg(" + LinRegLengthRef + ";Dev=2) Op[BlLo] Cl[AbUp]) AND "
            + "(ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-]) AND "
            + "(CCI(20;Lmin=100;Smax=-100) Op[CCI<=-100] Cl[CCI>=100]) AND "
            + "(MACD(12,26,9) Op[Macd<Sig] Cl[Macd>Sig] Note(short-trend))";

        public const string Logic4ShortBokovik =
            BokovikRegimePrefix
            + "(SMA(100) Side[S] Op[Bl] Cl[Ab]) AND "
            + "(Stoch(14-3-3;Lmin=90;Smax=10) Op[K>=90] Cl[K<=10]) AND "
            + "(ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-]) AND "
            + "(MACD(12,26,9) Op[Macd<Sig] Cl[Macd>Sig] Note(short-bokovik))";

        public static readonly string[] SlotFormulas =
        {
            Logic1LongTrend,
            Logic2LongBokovik,
            Logic3ShortTrend,
            Logic4ShortBokovik
        };

        private static readonly Regex NoteTagRegex = new Regex(
            @"Note\(([^)]*)\)",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

        public static string ExtractNoteTag(string formula)
        {
            if (string.IsNullOrWhiteSpace(formula))
            {
                return "";
            }

            Match match = NoteTagRegex.Match(formula);
            return match.Success ? match.Groups[1].Value.Trim() : "";
        }

        public static string BuildSetDefaultButtonHint()
        {
            return "Записать в «Логика 1…4» заводские строки: L1 "
                + ExtractNoteTag(Logic1LongTrend)
                + ", L2 "
                + ExtractNoteTag(Logic2LongBokovik)
                + ", L3 "
                + ExtractNoteTag(Logic3ShortTrend)
                + ", L4 "
                + ExtractNoteTag(Logic4ShortBokovik)
                + "; L1/L3 — Regime MatchSide, L2/L4 — FlatOnly+SlopeDead; «Логика 5…10» очистить. "
                + "Индикаторы на графике — сразу. Точные формулы — Help → «6a) Стандартные логики».";
        }

        public static string BuildSetDefaultLogMessage()
        {
            return "Логики по умолчанию: L1 "
                + ExtractNoteTag(Logic1LongTrend)
                + ", L2 "
                + ExtractNoteTag(Logic2LongBokovik)
                + ", L3 "
                + ExtractNoteTag(Logic3ShortTrend)
                + ", L4 "
                + ExtractNoteTag(Logic4ShortBokovik)
                + "; L1/L3 Regime MatchSide, L2/L4 FlatOnly+SlopeDead; L5…10 пусто. Индикаторы — сразу.";
        }

        public static void AppendHelpSection6a(StringBuilder sb)
        {
            sb.AppendLine("6a) Стандартные логики L1…L4 (кнопка «Установить логики по умолчанию», вкладка «Логики»)");
            sb.AppendLine("   Записывает четыре строки в «Логика 1…4», очищает «Логика 5…10»; индикаторы на графике — сразу.");
            sb.AppendLine("   Смысл набора: на базе TrendMultiIndicator+CCI — два лонга (тренд и боковик) и два шорта (тренд и боковик).");
            sb.AppendLine("   L1/L3 — Regime MatchSide (вход по наклону LinReg); L2/L4 — Regime FlatOnly (вход во флэте, Stoch от границ).");
            sb.AppendLine("   При Regime=On на одной свече могут сработать L1+L2 (лонг) и L3+L4 (шорт) — разные фильтры, не дубли.");
            sb.AppendLine("   SL/TP в заводских строках не заданы — выход по Cl[…] индикаторов.");
            sb.AppendLine();
            AppendDefaultLogicHelpBlock(sb, 1, "lon-trend", "Лонг, тренд", Logic1LongTrend,
                "Regime MatchSide — Buy при наклоне LinReg вверх; во флэте входов нет; OnFlip=Close при смене наклона.",
                "SMA(100) Op[Ab] Cl[Bl] — цена выше SMA100 (бычий контекст); выход ниже SMA.",
                "LinReg(@LR;Dev=2) Op[AbUp] Cl[BlLo] — пробой верхней границы канала вверх; выход ниже нижней (@LR — параметр «Длина линейной регрессии»).",
                "ATR(14;Gr=3%;Lb=5) Op[GrOk] — фильтр роста волатильности (без отдельного Cl).",
                "CCI(20) Op[CCI>=100] Cl[CCI<=-100] — перекупленность CCI для входа в лонг-тренд.",
                "MACD Op[Macd>Sig] Cl[Macd<Sig] — линия MACD выше сигнальной (импульс вверх).");
            AppendDefaultLogicHelpBlock(sb, 2, "lon-bokovik", "Лонг, боковик", Logic2LongBokovik,
                "Regime FlatOnly+SlopeDead — вход только во флэте LinReg; выход при выходе из флэта (OnFlip=Close).",
                "SMA(100) Op[Ab] — цена выше SMA100.",
                "Stoch Op[K<=10] Cl[K>=90] — вход у нижней границы стохастика (отскок вверх во флэте); выход у верхней.",
                "ATR Op[GrOk] — фильтр волатильности.",
                "MACD Op[Macd>Sig] — импульс вверх (без CCI и LinReg-пробоя — иначе это L1).");
            AppendDefaultLogicHelpBlock(sb, 3, "short-trend", "Шорт, тренд", Logic3ShortTrend,
                "Regime MatchSide — Sell при наклоне LinReg вниз (зеркало L1).",
                "SMA Side[S] Op[Bl] Cl[Ab] — шорт: цена ниже SMA100.",
                "LinReg(@LR) Op[BlLo] Cl[AbUp] — пробой нижней границы вниз; выход выше верхней.",
                "ATR Op[GrOk] — фильтр волатильности.",
                "CCI Op[CCI<=-100] Cl[CCI>=100] — перепроданность CCI для шорт-тренда.",
                "MACD Op[Macd<Sig] Cl[Macd>Sig] — MACD ниже сигнальной.");
            AppendDefaultLogicHelpBlock(sb, 4, "short-bokovik", "Шорт, боковик", Logic4ShortBokovik,
                "Regime FlatOnly — вход во флэте (зеркало L2).",
                "SMA Side[S] Op[Bl] — шорт ниже SMA100.",
                "Stoch Op[K>=90] Cl[K<=10] — вход у верхней границы (откат вниз во флэте).",
                "ATR Op[GrOk] — фильтр волатильности.",
                "MACD Op[Macd<Sig] — импульс вниз.");
            sb.AppendLine();
        }

        private static void AppendDefaultLogicHelpBlock(
            StringBuilder sb,
            int slot,
            string note,
            string title,
            string formula,
            params string[] parts)
        {
            sb.AppendLine("   [[def-l" + slot.ToString(CultureInfo.InvariantCulture) + "]] L"
                + slot.ToString(CultureInfo.InvariantCulture)
                + " — "
                + note
                + " ("
                + title
                + ")");
            sb.AppendLine("     " + formula);
            sb.AppendLine("   Состав:");
            for (int i = 0; i < parts.Length; i++)
            {
                sb.AppendLine("     • " + parts[i]);
            }

            sb.AppendLine();
        }
    }

    /// <summary>Каталог трендовых логик для кнопки «Добавить логику» (вкладка «Логики»).</summary>
    internal static class MultiLogicTrendCatalog
    {
        private sealed class CatalogEntry
        {
            public string Label = "";
            public string Formula = "";
        }

        private static readonly CatalogEntry[] Entries =
        {
            new CatalogEntry
            {
                Label = "1 RSI+Boll лонг (плавный тренд)",
                Formula = MultiLogicDefaultLogics.TrendRegimePrefix
                    + "(SMA(50) Op[Ab] Cl[Bl]) AND "
                    + "(Bollinger(20;Dev=2) Op[AbMid] Cl[BlMid]) AND "
                    + "(RSI(14;Lmin=55;Smax=45) Op[RSI>=55] Cl[RSI<=45]) AND "
                    + "(ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-]) AND "
                    + "(MACD(12,26,9) Op[Macd>Sig] Cl[Macd<Sig] Note(trend-rsi-boll))"
            },
            new CatalogEntry
            {
                Label = "1 RSI+Boll шорт (плавный тренд)",
                Formula = MultiLogicDefaultLogics.TrendRegimePrefix
                    + "(SMA(50) Side[S] Op[Bl] Cl[Ab]) AND "
                    + "(Bollinger(20;Dev=2) Side[S] Op[BlMid] Cl[AbMid]) AND "
                    + "(RSI(14;Lmin=55;Smax=45) Side[S] Op[RSI<=45] Cl[RSI>=55]) AND "
                    + "(ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-]) AND "
                    + "(MACD(12,26,9) Op[Macd<Sig] Cl[Macd>Sig] Note(short-rsi-boll))"
            },
            new CatalogEntry
            {
                Label = "2 Mom+Slope лонг (больше сигналов)",
                Formula = MultiLogicDefaultLogics.TrendRegimePrefix
                    + "(LinReg(" + MultiLogicDefaultLogics.LinRegLengthRef + ";Dev=2;SlopeLb=3) Op[SlopeUp] Cl[-]) AND "
                    + "(Momentum(14;Lmin=100;Smax=100) Op[MOM>=100] Cl[MOM<=100]) AND "
                    + "(SMA(100) Op[Ab] Cl[Bl]) AND "
                    + "(ATR(14;Gr=2%;Lb=5) Op[GrOk] Cl[-] Note(trend-mom-slope))"
            },
            new CatalogEntry
            {
                Label = "2 Mom+Slope шорт (больше сигналов)",
                Formula = MultiLogicDefaultLogics.TrendRegimePrefix
                    + "(LinReg(" + MultiLogicDefaultLogics.LinRegLengthRef + ";Dev=2;SlopeLb=3) Op[SlopeDn] Cl[-]) AND "
                    + "(Momentum(14;Lmin=100;Smax=100) Side[S] Op[MOM<=100] Cl[MOM>=100]) AND "
                    + "(SMA(100) Side[S] Op[Bl] Cl[Ab]) AND "
                    + "(ATR(14;Gr=2%;Lb=5) Op[GrOk] Cl[-] Note(short-mom-slope))"
            },
            new CatalogEntry
            {
                Label = "3 VWAP лонг (сессия / ликвид)",
                Formula = MultiLogicDefaultLogics.TrendRegimePrefix
                    + "(VWAP Op[Ab] Cl[Bl]) AND "
                    + "(SMA(100) Op[Ab] Cl[Bl]) AND "
                    + "(MACD(12,26,9) Op[Macd>Sig] Cl[Macd<Sig]) AND "
                    + "(ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-] Note(trend-vwap))"
            },
            new CatalogEntry
            {
                Label = "3 VWAP шорт (сессия / ликвид)",
                Formula = MultiLogicDefaultLogics.TrendRegimePrefix
                    + "(VWAP Side[S] Op[Bl] Cl[Ab]) AND "
                    + "(SMA(100) Side[S] Op[Bl] Cl[Ab]) AND "
                    + "(MACD(12,26,9) Op[Macd<Sig] Cl[Macd>Sig]) AND "
                    + "(ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-] Note(short-vwap))"
            },
            new CatalogEntry
            {
                Label = "4 Boll break лонг (пробой / всплески)",
                Formula = MultiLogicDefaultLogics.TrendRegimePrefix
                    + "(Bollinger(20;Dev=2) Op[Ab] Cl[Bl]) AND "
                    + "(MACD(12,26,9) Op[Macd>Sig] Cl[Macd<Sig]) AND "
                    + "(RSI(14;Lmin=50;Smax=50) Op[RSI>=50] Cl[RSI<=40]) AND "
                    + "(ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-] Note(trend-boll-break))"
            },
            new CatalogEntry
            {
                Label = "4 Boll break шорт (пробой / всплески)",
                Formula = MultiLogicDefaultLogics.TrendRegimePrefix
                    + "(Bollinger(20;Dev=2) Side[S] Op[Bl] Cl[Ab]) AND "
                    + "(MACD(12,26,9) Op[Macd<Sig] Cl[Macd>Sig]) AND "
                    + "(RSI(14;Lmin=50;Smax=50) Side[S] Op[RSI<=50] Cl[RSI>=60]) AND "
                    + "(ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-] Note(short-boll-break))"
            },
            new CatalogEntry
            {
                Label = "5 Dual SMA лонг (медленный тренд)",
                Formula = MultiLogicDefaultLogics.TrendRegimePrefix
                    + "(SMA(50) Op[Ab] Cl[Bl]) AND "
                    + "(SMA(200) Op[Ab] Cl[Bl]) AND "
                    + "(MACD(12,26,9) Op[Macd>Sig] Cl[Macd<Sig]) AND "
                    + "(ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-] Note(trend-dual-sma))"
            },
            new CatalogEntry
            {
                Label = "5 Dual SMA шорт (медленный тренд)",
                Formula = MultiLogicDefaultLogics.TrendRegimePrefix
                    + "(SMA(50) Side[S] Op[Bl] Cl[Ab]) AND "
                    + "(SMA(200) Side[S] Op[Bl] Cl[Ab]) AND "
                    + "(MACD(12,26,9) Op[Macd<Sig] Cl[Macd>Sig]) AND "
                    + "(ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-] Note(short-dual-sma))"
            },
            new CatalogEntry
            {
                Label = "6 Stoch trend лонг (откат по тренду)",
                Formula = MultiLogicDefaultLogics.TrendRegimePrefix
                    + "(SMA(100) Op[Ab] Cl[Bl]) AND "
                    + "(LinReg(" + MultiLogicDefaultLogics.LinRegLengthRef + ";Dev=2;SlopeLb=3) Op[SlopeUp] Cl[-]) AND "
                    + "(Stoch(14-3-3;Lmin=50;Smax=50) Op[K>=50] Cl[K<=40]) AND "
                    + "(ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-] Note(trend-stoch-pullback))"
            },
            new CatalogEntry
            {
                Label = "6 Stoch trend шорт (откат по тренду)",
                Formula = MultiLogicDefaultLogics.TrendRegimePrefix
                    + "(SMA(100) Side[S] Op[Bl] Cl[Ab]) AND "
                    + "(LinReg(" + MultiLogicDefaultLogics.LinRegLengthRef + ";Dev=2;SlopeLb=3) Op[SlopeDn] Cl[-]) AND "
                    + "(Stoch(14-3-3;Lmin=50;Smax=50) Side[S] Op[K<=50] Cl[K>=60]) AND "
                    + "(ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-] Note(short-stoch-pullback))"
            }
        };

        public static readonly string[] ChoiceLabels = BuildChoiceLabels();

        private static string[] BuildChoiceLabels()
        {
            var labels = new string[Entries.Length];
            for (int i = 0; i < Entries.Length; i++)
            {
                labels[i] = Entries[i].Label;
            }

            return labels;
        }

        public static bool TryResolveFormula(string label, out string formula)
        {
            formula = "";
            if (string.IsNullOrWhiteSpace(label))
            {
                return false;
            }

            string trimmed = label.Trim();
            for (int i = 0; i < Entries.Length; i++)
            {
                if (string.Equals(trimmed, Entries[i].Label, StringComparison.Ordinal))
                {
                    formula = Entries[i].Formula;
                    return true;
                }
            }

            return false;
        }

        /// <summary>Случайно выбирает <paramref name="count"/> различных вариантов из каталога (без повторов).</summary>
        public static CatalogPick[] PickRandomEntries(int count, Random rng)
        {
            if (rng == null || count <= 0 || Entries.Length == 0)
            {
                return Array.Empty<CatalogPick>();
            }

            int pickCount = Math.Min(count, Entries.Length);
            var indices = new int[Entries.Length];
            for (int i = 0; i < Entries.Length; i++)
            {
                indices[i] = i;
            }

            for (int i = Entries.Length - 1; i > 0; i--)
            {
                int j = rng.Next(i + 1);
                (indices[i], indices[j]) = (indices[j], indices[i]);
            }

            var picks = new CatalogPick[pickCount];
            for (int i = 0; i < pickCount; i++)
            {
                CatalogEntry entry = Entries[indices[i]];
                picks[i] = new CatalogPick(entry.Label, entry.Formula);
            }

            return picks;
        }

        public readonly struct CatalogPick
        {
            public CatalogPick(string label, string formula)
            {
                Label = label ?? "";
                Formula = formula ?? "";
            }

            public string Label { get; }
            public string Formula { get; }
        }
    }

    /*
     * ////////////////////////////////////////////////////////////////////////////////
     * ////////////////////////////////////////////////////////////////////////////////
     * ////////////////////////////////////////////////////////////////////////////////
     * БЛОК 1 — ГЛАВНЫЙ ДВИЖОК И ТОРГОВАЯ ЛОГИКА
     * Конструктор, параметры, скринер, Stopper, металогика, портфели, MOEX, индикаторы.
     * ////////////////////////////////////////////////////////////////////////////////
     * ////////////////////////////////////////////////////////////////////////////////
     * ////////////////////////////////////////////////////////////////////////////////
     */

    /// <summary>
    /// Скринер MultiLogic: до 10 независимых торговых логик в строковых параметрах,
    /// общий пул индикаторов без дублей, вход/выход по Op/Cl на закрытии свечи.
    /// </summary>
    public partial class MultiLogic : BotPanel
    {
        #region БЛОК 1 — ГЛАВНЫЙ ДВИЖОК И ТОРГОВАЯ ЛОГИКА

        /// <summary>Сигнал экстренного закрытия всех позиций робота (кнопка «Остановить робота и продать всё»).</summary>
        private const string SignalStopRobotAndSellAll = "MultiLogicStopAll";
        /// <summary>Имя вкладки параметров со строками «Логика 1…10» и кнопкой Help.</summary>
        private const string LogicsTabName = "Логики";
        private const string LogicLinRegLengthParamName = "Длина линейной регрессии";
        private const string LogicLinRegLenIncButtonName = "Увеличить: длина линейной регрессии +5";
        private const string LogicLinRegLenDecButtonName = "Уменьшить: длина линейной регрессии −5";
        private const int LogicLinRegLengthDefault = 50;
        private const int LogicLinRegLengthMin = 5;
        private const int LogicLinRegLengthMax = 300;
        private const int LogicLinRegLengthStep = 5;
        private const string LogicStrictnessParamName = "Strict (строгость)";
        private const string LogicStrictnessIncButtonName = "Увеличить: Strict +1";
        private const string LogicStrictnessDecButtonName = "Уменьшить: Strict −1";
        private const int LogicStrictnessMin = 1;
        private const int LogicStrictnessMax = 5;
        private const int LogicStrictnessDefault = 3;
        private const string MaxPositionsParamName = "Max positions (all tabs)";
        private const string VolumeParamName = "Volume";
        private const string MaxPositionsIncButtonName = "Увеличить: Max positions +5";
        private const string MaxPositionsDecButtonName = "Уменьшить: Max positions −5";
        private const string VolumeIncButtonName = "Увеличить: Volume +5";
        private const string VolumeDecButtonName = "Уменьшить: Volume −5";
        private const int MaxPositionsButtonDelta = 5;
        private const int MaxPositionsMin = 0;
        private const int MaxPositionsMax = 200;
        private const decimal VolumeButtonDelta = 5m;
        private const decimal VolumeMin = 1.0m;
        private const decimal VolumeMax = 50m;
        /// <summary>Вкладка общепортфельных индикаторов по кривым портфелей логик (пока только параметры).</summary>
        private const string MetaLogicsTabName = "Металогики";
        /// <summary>Вкладка общепортфельных stop-loss / take-profit по сумме портфелей L1…L10.</summary>
        private const string StopperTabName = "Stopper";
        private const string PortfolioStopLossPercentParamName = "Общепортфельный stop-loss (%)";
        private const string PortfolioTakeProfitPercentParamName = "Общепортфельный take-profit (%)";
        private const string StopperSlPercentIncButtonName = "Увеличить: общепортфельный stop-loss (%) +0,1";
        private const string StopperSlPercentDecButtonName = "Уменьшить: общепортфельный stop-loss (%) −0,1";
        private const string StopperTpPercentIncButtonName = "Увеличить: общепортфельный take-profit (%) +0,5";
        private const string StopperTpPercentDecButtonName = "Уменьшить: общепортфельный take-profit (%) −0,5";
        private const decimal StopperSlPercentDefault = 0.4m;
        private const decimal StopperTpPercentDefault = 10m;
        private const decimal StopperSlPercentMin = 0.01m;
        private const decimal StopperSlPercentMax = 100m;
        private const decimal StopperSlPercentUiStep = 0.01m;
        private const decimal StopperTpPercentMin = 0.1m;
        private const decimal StopperTpPercentMax = 500m;
        private const decimal StopperTpPercentUiStep = 0.1m;
        private const decimal StopperSlPercentButtonDelta = 0.1m;
        private const decimal StopperTpPercentButtonDelta = 0.5m;
        private const int StopperEquityHistoryCap = 10000;
        private const string SignalPortfolioStopperSl = "MultiLogicPortfolioStopSL";
        private const string SignalPortfolioStopperTp = "MultiLogicPortfolioStopTP";
        private const string SignalPortfolioStopperEodFlat = "MultiLogicPortfolioEodFlat";
        private const string SignalPortfolioStopperPeakSl = "MultiLogicPortfolioPeakSL";
        private const string PortfolioPeakDrawdownEnabledParamName = "Просадка от пика: включена";
        private const string PortfolioPeakDrawdownPercentParamName = "Просадка от пика, %";
        private const string PortfolioPeakValueParamName = "Пик портфеля";
        private const decimal PortfolioPeakDrawdownPercentDefault = 1m;
        private const string StopperEodFlatSellParamName = "Продать всё к времени (ежедневно)";
        private const string StopperEodFlatSellDisabled = "Не продавать";
        private const string SignificantPeakPauseEnabledParamName = "Пауза после значительного пика: включена";
        private const string SignificantPeakAnnualPercentParamName = "Значительный пик: % годовых (мин.)";
        private const string SignificantPeakPauseWidthMultiplierParamName = "Пауза: ширина пика ×";
        private const decimal SignificantPeakAnnualPercentDefault = 100m;
        private const decimal SignificantPeakPauseWidthMultiplierDefault = 10m;
        private const string UpdateStopperPortfolioBaselineButtonName = "Обновить сумму портфеля SL/TP";
        private const string PortfolioStopLossRublesParamName = "Либо stop-loss в рублях";
        private const string PortfolioTakeProfitRublesParamName = "Либо take-profit в рублях";
        /// <summary>После SL/TP: не менять Regime (как бывший false).</summary>
        private const string StopperPostTriggerDisabled = "Отключено";
        /// <summary>После SL/TP: Regime=Off (как бывший true).</summary>
        private const string StopperPostTriggerStopFully = "Останавливать полностью";
        /// <summary>После SL/TP: фейк-торговля в L1…L10; возобновление реальной торговли при достижении текущей суммы.</summary>
        private const string StopperPostTriggerPauseAndResume =
            "Останавливать и возобновлять при достижении текущей суммы в фейк-торговле";
        /// <summary>Старое короткое имя варианта (миграция сохранённых параметров).</summary>
        private const string StopperPostTriggerPauseAndResumeLegacy = "Останавливать и возобновлять";
        private const string StopperPostTriggerAfterStopLossParamName =
            "Останавливать робота после срабатывания stop-loss";
        private const string StopperPostTriggerAfterTakeProfitParamName =
            "Останавливать робота после срабатывания take-profit";
        private static readonly string[] StopperPostTriggerChoices =
        {
            StopperPostTriggerDisabled,
            StopperPostTriggerStopFully,
            StopperPostTriggerPauseAndResume
        };
        /// <summary>Порог выше цели возобновления (как TrendMultiIndicator, +0,1%).</summary>
        private const decimal StopperVirtualResumeOverTargetPercent = 0.1m;
        /// <summary>«Как основной TF» — Stopper на общей свече страницы 1; Min1…Min15 — страница 2 (монитор).</summary>
        private const string StopperMonitorTimeFrameSameAsMain = "Как основной TF";
        private const string StopperMonitorTimeFrameLegacyOff = "Off";
        private const string StopperMonitorTimeFrameParamName = "Stopper: таймфрейм монитора";
        private const string StopperMonitorSecurityParamName = "Stopper: бумага монитора";
        private static readonly string[] StopperMonitorTimeFrameChoices =
        {
            StopperMonitorTimeFrameSameAsMain,
            "Min1",
            "Min2",
            "Min3",
            "Min5",
            "Min10",
            "Min15"
        };
        /// <summary>Главный переключатель режима металогики (распределение Volume по PnlSMA).</summary>
        private const string MetaLogicEnabledParamName = "Металогика включена";
        /// <summary>Кнопка быстрого включения металогики.</summary>
        private const string MetaLogicEnableButtonName = "Включить металогику";
        /// <summary>При включённой металогике — торговать неуспешные логики (PnlSMA&lt;0) с Buy↔Sell; по умолчанию выкл.</summary>
        private const string MetaLogicInversionParamName = "Инверсия (покупка ↔ продажа)";
        /// <summary>На вкладке «Логики»: как в TrendMultiIndicatorScreener — покупка↔продажа и Op↔Cl (bull↔bear).</summary>
        private const string LogicSideInversionParamName = "Инверсия логики (покупка ↔ продажа)";

        /// <summary>Относительный путь к файлу справки (от каталога bin); перезаписывается из кода робота.</summary>
        private const string LogicHelpFileRelativePath = @"Custom\Robots\MultiLogic_LogicHelp.html";

        /// <summary>
        /// Краткая подсказка в параметрах. Полная справка — MultiLogic_LogicHelp.html (кнопка Help, автообновление).
        /// </summary>
        private const string LogicLineFormatHint =
            "В начале (необязательно): Disabled(true/false), Strict(@Strict|1…5) и Regime(…) — режим наклона LinReg.\n"
            + "Формат: <Индикатор>(параметры) Op[вход] Cl[выход] [SL[…]] [TP[…]] Note(пояснение)\n"
            + "Disabled(…) / Strict(…) / Regime(…) — только в начале строки, до AND/OR, без скобок вокруг.\n"
            + "Strict(@Strict) — строгость из параметра «Strict (строгость)»; Strict(4) — явное 1…5; без префикса — параметр робота.\n"
            + "Regime(LinReg;L=@LR;Dev=2;SlopeLb=5;SlopeDead=0.05%;Entry=MatchSide|FlatOnly) — тренд или боковик по наклону LinReg (@LR — параметр «Длина линейной регрессии»).\n"
            + "Составная логика: AND/OR или &&/||; NOT/! перед фрагментом инвертирует Op/Cl (не Buy/Sell).\n"
            + "В Op[…] и Cl[…]: ! / NOT, && / AND, || / OR (как в JavaScript). Примеры:\n"
            + "  Disabled(true) SMA(100) Op[Ab] Cl[Bl]\n"
            + "  NOT LinReg(@LR;Dev=2) Op[AbUp] Cl[BlLo]\n"
            + "  LinReg(@LR;Dev=2) Op[!AbUp||AbLo] Cl[BlLo]\n"
            + "  (SMA(100) Op[Ab] Cl[Bl]) && (ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-])\n"
            + "  SMA(100) Op[Ab] Cl[Bl] SL[2%] TP[6%] Note(trend)\n"
            + "  Disabled(false) (SMA(100) Op[Ab]) AND (ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-])";

        /// <summary>Количество слотов строк логики («Логика 1» … «Логика 10»).</summary>
        private const int LogicSlotCount = 10;
        /// <summary>Префикс SignalTypeOpen позиции: MultiLogic_L1 … MultiLogic_L10.</summary>
        private const string LogicEntrySignalPrefix = "MultiLogic_L";

        /// <summary>Имя кнопки открытия файла справки на вкладке «Логики».</summary>
        private const string LogicsHelpButtonName = "Help";
        /// <summary>Имя кнопки сброса: заводские строки L1…L4 (см. <see cref="MultiLogicDefaultLogics"/>).</summary>
        private const string LogicsSetDefaultButtonName = "Установить логики по умолчанию";
        /// <summary>Кнопка экспорта строк «Логика 1…10» в JSON на вкладке «Логики».</summary>
        private const string ExportLogicsButtonName = "Выгрузить логику";
        /// <summary>Кнопка импорта строк «Логика 1…10» из JSON на вкладке «Логики».</summary>
        private const string ImportLogicsButtonName = "Загрузить логику";
        /// <summary>Очищает все слоты «Логика 1…10».</summary>
        private const string ClearLogicsButtonName = "Очистить логики";
        private const string RandomResetLogicsButtonName = "Сброс логик и случайный выбор";
        private const int RandomResetLogicsFillCount = 6;
        /// <summary>Дубликат экстренной остановки с первой вкладки — на вкладке «Логики».</summary>
        private const string StopRobotAndSellAllLogicsTabButtonName = "Остановить робота и продать всё (логики)";
        /// <summary>Список вариантов для «Добавить логику».</summary>
        private const string AddLogicVariantParamName = "Вариант трендовой логики";
        /// <summary>Записывает выбранный вариант в ближайший пустой слот логики.</summary>
        private const string AddLogicButtonName = "Добавить логику";
        /// <summary>Версия формата JSON-файла только со строками логик.</summary>
        private const string MultiLogicLogicFileFormatVersion = "1";
        /// <summary>Кнопка экспорта JSON-снимка настроек, портфелей логик и позиций.</summary>
        private const string SaveSnapshotButtonName = "Сохранить настройки и результаты";
        /// <summary>Кнопка импорта JSON-снимка.</summary>
        private const string LoadSnapshotButtonName = "Загрузить настройки и результаты";
        /// <summary>Версия формата JSON-снимка MultiLogic.</summary>
        private const string MultiLogicSnapshotFormatVersion = "2";
        /// <summary>Подкаталог Engine для автобэкапов после «Принять»: Engine\{NameStrategyUniq}_ParamsBackups\</summary>
        private const string ParametersBackupFolderSuffix = "_ParamsBackups";
        /// <summary>Макс. число файлов автобэкапа (старые удаляются).</summary>
        private const int ParametersBackupMaxFiles = 200;
        /// <summary>Задержка объединения нескольких ValueChange за одно «Принять» (мс).</summary>
        private const int ParametersBackupCoalesceMs = 150;
        /// <summary>Суффикс файла общепортфельной мета-серии: Engine\{NameStrategyUniq}_MetaAggregate.txt</summary>
        private const string AggregateMetaPortfolioFileNameSuffix = "_MetaAggregate.txt";
        /// <summary>Число полей мета-индикаторов в строке истории v2 (после note).</summary>
        private const int MetaIndicatorSerializedFieldCount = 11;
        /// <summary>Краткое имя мета-индикатора «Приведённая SMA» (средний и последний профит).</summary>
        private const string MetaIndicatorPnlSmaAbbrev = "PnlSMA";
        /// <summary>Параметр включения PnlSMA на вкладке «Металогики» (используется в мета-логике).</summary>
        private const string PortfolioPnlSmaEnableParamName =
            "Общепортфельный Средний и последний профит (PnlSMA): включить";
        /// <summary>Длина окна PnlSMA на вкладке «Металогики».</summary>
        private const string PortfolioPnlSmaLenParamName = "Общепортфельный PnlSMA: длина";
        /// <summary>Последний параметр активного блока мета-логики — под ним рисуется разделитель.</summary>
        private const string MetaLogicsActiveBlockSeparatorUnderParamName = PortfolioPnlSmaLenParamName;
        /// <summary>Суффикс файла портфеля логики на диске: Engine\{NameStrategyUniq}_LogicPortfolio_L1.txt</summary>
        private const string LogicPortfolioFileSuffix = "_LogicPortfolio_L";
        /// <summary>Интервал сброса портфелей логик на диск (сек).</summary>
        private const int LogicPortfolioSaveIntervalSeconds = 30;
        /// <summary>Макс. точек истории портфеля одной логики в файле.</summary>
        private const int LogicPortfolioHistoryCap = 5000;
        /// <summary>Минимальное изменение equity для записи точки candle (абс.).</summary>
        private const decimal LogicPortfolioCandleMinDelta = 0.01m;

        /// <summary>Интервал повторной проверки RAM/диска (сек).</summary>
        private const int ResourceCheckIntervalSeconds = 300;
        /// <summary>Базовая оценка RAM для робота MultiLogic (байт).</summary>
        private const long ResourceEstimateBaseRamBytes = 8L * 1024 * 1024;
        /// <summary>Оценка RAM на одну активную логику (байт).</summary>
        private const long ResourceEstimatePerActiveLogicRamBytes = 768L * 1024;
        /// <summary>Оценка RAM на одну точку истории портфеля (байт).</summary>
        private const long ResourceEstimatePerHistoryPointRamBytes = 256;
        /// <summary>Оценка RAM на вкладку скринера с свечами/индикаторами (байт).</summary>
        private const long ResourceEstimatePerScreenerTabRamBytes = 3L * 1024 * 1024;
        /// <summary>Оценка RAM на уникальный индикатор логики (байт).</summary>
        private const long ResourceEstimatePerUniqueIndicatorRamBytes = 512L * 1024;
        /// <summary>Резерв диска на активную логику (файл портфеля + запас) (байт).</summary>
        private const long ResourceEstimatePerActiveLogicDiskBytes = 600L * 1024;
        /// <summary>Средний размер строки истории портфеля в файле (байт).</summary>
        private const long ResourceEstimatePortfolioHistoryLineDiskBytes = 150;
        /// <summary>Запас под JSON-снимок и прочие файлы Engine (байт).</summary>
        private const long ResourceEstimateSnapshotDiskHeadroomBytes = 5L * 1024 * 1024;

        /// <summary>Основной скринер (страница 1): торговые бумаги и логики.</summary>
        private BotTabScreener _screenerTab;
        /// <summary>Скринер-монитор Stopper (страница 2): одна ликвидная бумага на малом TF.</summary>
        private BotTabScreener _stopMonitorScreenerTab;
        /// <summary>Подписка CandleFinished на странице 2 для Stopper.</summary>
        private bool _stopMonitorScreenerEventsWired;
        /// <summary>Последний TF монитора, применённый к странице 2 (для принудительного пересоздания вкладок).</summary>
        private TimeFrame? _stopMonitorAppliedTimeFrame;
        /// <summary>Единственный экземпляр парсера строк логики (AND/OR, Disabled, Op/Cl).</summary>
        private readonly LogicLineParser _logicLineParser = new LogicLineParser();
        /// <summary>Кэш разобранных логик по индексу слота (1…10); используется при торговле на свече.</summary>
        private LogicSlotRuntime[] _logicSlotRuntimes = new LogicSlotRuntime[LogicSlotCount + 1];
        /// <summary>Соответствие сигнатуры индикатора (тип+параметры+область) → номеру на графике (101…).</summary>
        private Dictionary<string, int> _indicatorSignatureToNum = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

        /// <summary>Кнопка открытия справки на вкладке «Логики».</summary>
        private StrategyParameterButton _logicHelpButton;

        /// <summary>Кнопка «Установить логики по умолчанию» на вкладке «Логики».</summary>
        private StrategyParameterButton _setDefaultLogicsButton;
        /// <summary>Кнопка «Выгрузить логику» на вкладке «Логики».</summary>
        private StrategyParameterButton _exportLogicsButton;
        /// <summary>Кнопка «Загрузить логику» на вкладке «Логики».</summary>
        private StrategyParameterButton _importLogicsButton;
        /// <summary>Кнопка «Очистить логики» на вкладке «Логики».</summary>
        private StrategyParameterButton _clearLogicsButton;
        private StrategyParameterButton _randomResetLogicsButton;
        private StrategyParameterButton _stopRobotAndSellAllLogicsTabButton;
        /// <summary>Выбор варианта для «Добавить логику».</summary>
        private StrategyParameterString _addLogicVariant;
        /// <summary>Кнопка «Добавить логику» на вкладке «Логики».</summary>
        private StrategyParameterButton _addLogicButton;
        /// <summary>Инверсия Buy↔Sell при открытии по всем логикам (вкладка «Логики»).</summary>
        private StrategyParameterBool _logicSideInversion;
        private StrategyParameterInt _logicLinRegLen;
        private StrategyParameterInt _logicStrictness;
        private StrategyParameterButton _logicLinRegLenIncButton;
        private StrategyParameterButton _logicLinRegLenDecButton;
        private StrategyParameterButton _logicStrictnessIncButton;
        private StrategyParameterButton _logicStrictnessDecButton;
        /// <summary>Кнопка экспорта JSON-снимка (первая вкладка параметров).</summary>
        private StrategyParameterButton _saveSnapshotButton;
        /// <summary>Кнопка импорта JSON-снимка.</summary>
        private StrategyParameterButton _loadSnapshotButton;

        private const string ReferenceInitialPortfolioAmountParamName = "Начальная сумма портфеля (справочно)";
        private const string ReferenceLaunchDateParamName = "Дата запуска (справочно)";
        private const string ReferenceCurrentAnnualPercentParamName = "Текущий процент годовых (справочно)";
        private const string ReferenceCurrentAnnualPercentWithCapParamName =
            "Текущий процент годовых с капитализацией (справочно)";
        private const string FillReferencePortfolioBaselineButtonName =
            "Заполнить начальную сумму и дату портфеля";

        /// <summary>База для справочного расчёта % годовых (первая вкладка).</summary>
        private StrategyParameterDecimal _referenceInitialPortfolioAmount;
        private StrategyParameterString _referenceLaunchDate;
        private StrategyParameterDecimal _referenceCurrentAnnualPercent;
        private StrategyParameterDecimal _referenceCurrentAnnualPercentWithCap;
        private StrategyParameterButton _fillReferencePortfolioBaselineButton;

        /// <summary>Портфели эффективности по слотам логики 1…10.</summary>
        private readonly LogicPortfolioRuntime[] _logicPortfolios = new LogicPortfolioRuntime[LogicSlotCount + 1];
        /// <summary>Общая equity L1…L10 и мета-индикаторы по сумме портфелей.</summary>
        private readonly AggregateMetaPortfolioRuntime _aggregateMetaPortfolio = new AggregateMetaPortfolioRuntime();
        private readonly List<StopperEquitySnapshot> _stopperEquityHistory = new List<StopperEquitySnapshot>();
        private DateTime _stopperLastProtectionCandleTime = DateTime.MinValue;
        /// <summary>База SL/TP задана кнопкой или после срабатывания Stopper (не lookback).</summary>
        private bool _stopperReferenceBaselineLocked;
        /// <summary>Есть несохранённые изменения портфелей логик.</summary>
        private bool _logicPortfoliosDirty;
        /// <summary>Время последней записи портфелей на диск.</summary>
        private DateTime _logicPortfoliosLastSaveTime = DateTime.MinValue;
        /// <summary>Время последней проверки RAM/диска.</summary>
        private DateTime _lastResourceCheckUtc = DateTime.MinValue;
        /// <summary>Подпись последнего предупреждения о нехватке ресурсов (антиспам).</summary>
        private string _lastResourceWarningSignature = "";

        /// <summary>Отложенная установка индикаторов после MOEX reload (чарты вкладок ещё не готовы).</summary>
        private int _moexIndicatorsAttachPassId;

        private const int MoexIndicatorsAttachMaxAttempts = 25;
        /// <summary>Интервал свечей между повторными попытками attach, если индикаторы ещё не на вкладке.</summary>
        private const int RobotIndicatorsEnsureRetryCandleInterval = 25;
        /// <summary>Синхронизация кэша ensure-индикаторов (CandleFinishedEvent может идти с нескольких вкладок параллельно).</summary>
        private readonly object _robotIndicatorsEnsureLock = new object();

        /// <summary>Барьер «общей свечи» скринера: тех. Stopper и справочный % — один раз после всех вкладок.</summary>
        private readonly object _aggregatedCandleLock = new object();
        private DateTime _aggregatedCandleBarrierTime = DateTime.MinValue;
        private readonly HashSet<string> _aggregatedCandleCompletedTabKeys =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private int _aggregatedCandleWaveIndex;
        private const int ReferenceYieldRefreshEveryAggregatedWavesInTester = 20;
        private const int ReferenceYieldRefreshEveryAggregatedWavesInLive = 5;
        /// <summary>Вкладки, на которых все robot-индикаторы уже найдены (быстрый выход из TryEnsure).</summary>
        private readonly HashSet<string> _robotIndicatorsReadyTabKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        /// <summary>Последняя свеча, на которой пробовали attach индикаторов на вкладке (антиспам в тестере).</summary>
        private readonly Dictionary<string, int> _robotIndicatorsEnsureLastAttemptCandle =
            new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

        /// <summary>Пауза между вкладками при «Обновить акции» — снижает гонку ClearJournalsArray в GlobalPositionViewer.</summary>
        private const int MoexStockTabReloadDelayMs = 700;

        /// <summary>Доп. корни тикера MOEX FORTS (в параметре — «человеческий» префикс, на бирже — код серии).</summary>
        private static readonly Dictionary<string, string[]> MoexFuturesPrefixAliases =
            new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase)
            {
                { "CNY", new[] { "CR", "CNYRUBF" } },
                { "SI", new[] { "Si", "SV", "SILV" } },
                { "RUAL", new[] { "RU" } },
            };

        private StrategyParameterString _moexFuturesTickerPrefixes;
        private StrategyParameterButton _moexFuturesResetPrefixesButton;
        private StrategyParameterButton _moexFuturesExtendedResetPrefixesButton;
        private StrategyParameterButton _moexFuturesLoadButton;
        private StrategyParameterString _moexStockTickerPrefixes;
        private StrategyParameterButton _moexStockResetPrefixesButton;
        private StrategyParameterButton _moexStockLoadButton;

        private const string DefaultMoexFuturesTickerPrefixes =
            "Si,USDRUBF,Eu,EURRUBF,CNY,MX,MM,IMOEXF,RI,BR,BRM,CL,NG,NGM,GD,GLDRUBF,SV,PT,PD,CU,SR,GZ,LK,RN,NK,GN,TT,VB,SN,SG,RL";

        /// <summary>
        /// ~100 корней FORTS MOEX, упорядочены по убыванию типичной ликвидности (валюта/индексы → сырьё → акции).
        /// </summary>
        private const string DefaultMyFuturesExtendedTickerPrefixes =
            "Si,USDRUBF,Eu,EURRUBF,CNY,CNYRUBF,CR,MX,MM,IMOEXF,MIX,RI,RVI,"
            + "BR,BRM,NG,NGM,GD,GLDRUBF,GL,SV,PT,PD,"
            + "SR,GZ,LK,RN,TT,VB,NK,SN,SG,GN,ME,AF,CH,MG,MT,NM,HY,FE,PH,PI,RL,TN,YD,HS,RT,PL,"
            + "BYN,KZT,TRY,AMD,AZN,CHF,GBP,JPY,CAD,AUD,HKD,INR,UAH,UZS,KGS,TJS,"
            + "CU,AH,CA,ZN,NI,CO,"
            + "SA,WH,KC,CC,CT,SB,"
            + "AK,TR,BM,BS,CI,MTL,POSI,RASP,SF,FLOT,SVCB,AL,KV,GK,KM,HZ,SP,MC,DM,CB,LN,FS,SC,TB,FL,IR,UP";

        private const string DefaultMoexStockTickerPrefixes =
            "AFLT, ALRS, AFKS, BSPB, CHMF, FEES, GAZP, GMKN, HYDR, IRAO, LKOH, MAGN, MOEX, MTSS, MTLRP, "
            + "NVTK, NLMK, PLZL, PIKK, PHOR, ROSN, RUAL, RTKMP, SBER, SBERP, SNGSP, SNGS, TATN, TATNP, UPRO, VTBR";

        /// <summary>Режим перезагрузки MOEX: фьючерсы или акции.</summary>
        private enum MoexScreenerInstrumentMode
        {
            Futures,
            Stock
        }

        /// <summary>Снимок настроек скринера перед MOEX reload (портфель, сервер, ТФ, класс).</summary>
        private struct MoexScreenerPreserveSettings
        {
            public string PortfolioName;
            public ServerType ServerType;
            public string ServerName;
            public TimeFrame TimeFrame;
            public string SecuritiesClass;
        }

        /// <summary>Regime Off/On — включение торговли.</summary>
        private StrategyParameterString _regime;
        /// <summary>Кнопка экстренной остановки и закрытия всех позиций.</summary>
        private StrategyParameterButton _stopRobotAndSellAllButton;
        /// <summary>Лимит открытых позиций на всём скринере.</summary>
        private StrategyParameterInt _maxPositions;
        private StrategyParameterButton _maxPositionsIncButton;
        private StrategyParameterButton _maxPositionsDecButton;
        /// <summary>Способ задания объёма: Contracts / Contract currency / Deposit percent.</summary>
        private StrategyParameterString _volumeType;
        /// <summary>Числовое значение объёма (зависит от Volume type).</summary>
        private StrategyParameterDecimal _volume;
        private StrategyParameterButton _volumeIncButton;
        private StrategyParameterButton _volumeDecButton;
        /// <summary>База для расчёта % депозита: Prime или код валюты.</summary>
        private StrategyParameterString _tradeAssetInPortfolio;

        private bool _loggedTradingModeDiagnostics;
        /// <summary>Однократное сообщение: attach индикаторов только на UI-потоке.</summary>
        private bool _loggedRobotIndicatorsUiThreadAttach;
        private string _lastVolumeCalcFailureReason;
        private bool _loggedMaxPositionsLimit;

        /// <summary>Строковые параметры «Логика 1» … «Логика 10».</summary>
        private StrategyParameterString _logic1;
        private StrategyParameterString _logic2;
        private StrategyParameterString _logic3;
        private StrategyParameterString _logic4;
        private StrategyParameterString _logic5;
        private StrategyParameterString _logic6;
        private StrategyParameterString _logic7;
        private StrategyParameterString _logic8;
        private StrategyParameterString _logic9;
        private StrategyParameterString _logic10;

        /// <summary>Объединяет несколько подряд ValueChange в один TryParse (например, «Принять» после пресета логик).</summary>
        private int _logicParseCoalesceToken;

        /// <summary>Объединяет ValueChange за одно «Принять» в один JSON-бэкап параметров.</summary>
        private int _paramsBackupCoalesceToken;

        /// <summary>После конструктора — разрешить автобэкап (не при стартовой инициализации).</summary>
        private bool _parametersAcceptBackupEnabled;

        /// <summary>Последний принятый снимок: при «Принять» в файл пишется он (состояние до изменения).</summary>
        private MultiLogicSnapshotFile _previousAcceptBackupSnapshot;

        /// <summary>SaveParameters без SyncAllLogicIndicators (кнопки Stopper, справочный % и т.п.).</summary>
        private int _suppressLogicIndicatorResyncDepth;

        /// <summary>Отпечаток «Логика 1…10» после последнего SyncAllLogicIndicators.</summary>
        private string _lastSyncedLogicSlotsFingerprint;

        /// <summary>MOEX «Обновить фьючерсы/акции» — один reload за раз.</summary>
        private int _moexReloadInProgress;

        /// <summary>Однократное сообщение: металогика включена, но PnlSMA ещё не готов — работает обычная логика.</summary>
        private bool _loggedMetaLogicWarmupPending;

        /// <summary>Не спамить логом «все кандидаты отфильтрованы» чаще одного раза на волну общей свечи.</summary>
        private int _lastMetaLogicFilterSkipLogWave = -1;

        /// <summary>Однократная запись в HTML-журнал: PnlSMA готов, металогика активна.</summary>
        private bool _htmlReportMetaLogicReadyLogged;

        private StrategyParameterBool _metaLogicEnabled;
        private StrategyParameterBool _metaLogicInversion;
        private StrategyParameterButton _metaLogicEnableButton;

        /// <summary>Общепортфельные индикаторы (вкладка «Металогики») — расчёт по кривым L1…L10, пока только параметры.</summary>
        private StrategyParameterBool _usePortfolioSma;
        private StrategyParameterInt _portfolioSmaLen;
        private StrategyParameterString _portfolioSmaSource;
        private StrategyParameterBool _usePortfolioStoch;
        private StrategyParameterInt _portfolioStochP1;
        private StrategyParameterInt _portfolioStochP2;
        private StrategyParameterInt _portfolioStochP3;
        private StrategyParameterDecimal _portfolioStochLongMin;
        private StrategyParameterDecimal _portfolioStochShortMax;
        private StrategyParameterBool _usePortfolioAtr;
        private StrategyParameterInt _portfolioAtrLen;
        private StrategyParameterDecimal _portfolioAtrGrowPercent;
        private StrategyParameterInt _portfolioAtrGrowLookBack;
        private StrategyParameterBool _usePortfolioLinReg;
        private StrategyParameterInt _portfolioLinRegLen;
        private StrategyParameterDecimal _portfolioLinRegDev;
        private StrategyParameterBool _usePortfolioMacd;
        private StrategyParameterInt _portfolioMacdFastLen;
        private StrategyParameterInt _portfolioMacdSlowLen;
        private StrategyParameterInt _portfolioMacdSignalLen;
        private StrategyParameterBool _usePortfolioAdjSma;
        private StrategyParameterInt _portfolioAdjSmaLen;
        private StrategyParameterString _portfolioPrevIndicatorVolumeCalc;

        private StrategyParameterBool _usePortfolioStopLoss;
        private StrategyParameterDecimal _portfolioStopLossPercent;
        private StrategyParameterDecimal _portfolioStopLossRubles;
        private StrategyParameterButton _stopperSlPercentIncButton;
        private StrategyParameterButton _stopperSlPercentDecButton;
        private StrategyParameterBool _usePortfolioTakeProfit;
        private StrategyParameterDecimal _portfolioTakeProfitPercent;
        private StrategyParameterDecimal _portfolioTakeProfitRubles;
        private StrategyParameterBool _usePortfolioPeakDrawdownStop;
        private StrategyParameterDecimal _portfolioPeakDrawdownPercent;
        private StrategyParameterDecimal _portfolioPeakValue;
        private StrategyParameterButton _stopperTpPercentIncButton;
        private StrategyParameterButton _stopperTpPercentDecButton;
        private StrategyParameterString _stopperPostTriggerAfterStopLoss;
        private StrategyParameterString _stopperPostTriggerAfterTakeProfit;
        /// <summary>Stopper: пауза реальной торговли, виртуальные сделки в портфелях L1…L10.</summary>
        private bool _stopperVirtualTradingActive;
        /// <summary>Equity (сумма L1…L10), при достижении которой возобновляется реальная торговля.</summary>
        private decimal _stopperVirtualRecoveryTargetEquity;
        private readonly Dictionary<string, StopperVirtualPosition> _stopperVirtualPositions =
            new Dictionary<string, StopperVirtualPosition>(StringComparer.OrdinalIgnoreCase);
        private StrategyParameterDecimal _portfolioStopperReferenceEquity;
        private StrategyParameterDecimal _portfolioStopperCurrentEquity;
        private StrategyParameterInt _portfolioStopperLookbackCandles;
        private StrategyParameterString _stopperMonitorTimeFrame;
        private StrategyParameterString _stopperMonitorSecurity;
        private StrategyParameterString _stopperEodFlatSellTime;
        private StrategyParameterBool _useSignificantPeakTradingPause;
        private StrategyParameterDecimal _significantPeakAnnualPercentMin;
        private StrategyParameterDecimal _significantPeakPauseWidthMultiplier;
        private StrategyParameterButton _updateStopperPortfolioBaselineButton;
        /// <summary>Календарный день последнего EOD flat (не чаще 1 раза в сутки).</summary>
        private DateTime _stopperEodFlatLastFiredTradingDay = DateTime.MinValue;
        /// <summary>День, для которого уже залогирован запрет входов после EOD flat.</summary>
        private DateTime _loggedStopperEodFlatBuyBlockedDay = DateTime.MinValue;
        /// <summary>До этого времени (время свечи) запрещены новые входы после значительного пика equity.</summary>
        private DateTime _significantPeakPauseUntil = DateTime.MinValue;
        /// <summary>Последний обработанный локальный пик (время свечи пика).</summary>
        private DateTime _significantPeakLastEvaluatedPeakTime = DateTime.MinValue;
        /// <summary>Для однократного лога активной паузы по значительному пику.</summary>
        private DateTime _loggedSignificantPeakPauseUntil = DateTime.MinValue;

        /// <summary>
        /// Конструктор робота: создаёт скринер, параметры, подписки на события и первичный разбор логик.
        /// </summary>
        /// <param name="name">Уникальное имя экземпляра робота в OsEngine.</param>
        /// <param name="startProgram">Режим запуска (тестер / OsTrader).</param>
        public MultiLogic(string name, StartProgram startProgram)
            : base(name, startProgram)
        {
            TabCreate(BotTabType.Screener);
            _screenerTab = TabsScreener[0];
            RemoveCorruptScreenerTabSetFileIfNeeded();
            _screenerTab.CandleFinishedEvent += ScreenerTab_CandleFinishedEvent;
            _screenerTab.NewTabCreateEvent += ScreenerTab_NewTabCreateEvent;
            _screenerTab.PositionOpeningSuccesEvent += ScreenerTab_PositionOpeningSuccesEvent;
            _screenerTab.PositionClosingSuccesEvent += ScreenerTab_PositionClosingSuccesEvent;
            _screenerTab.EventsIsOn = true;

            for (int i = 1; i <= LogicSlotCount; i++)
            {
                _logicPortfolios[i] = new LogicPortfolioRuntime();
            }

            _regime = CreateParameter("Regime", "Off", new[] { "Off", "On" });
            _stopRobotAndSellAllButton = CreateParameterButton("Остановить робота и продать всё");
            _stopRobotAndSellAllButton.UserClickOnButtonEvent += StopRobotAndSellAllButton_UserClickOnButtonEvent;

            _saveSnapshotButton = CreateParameterButton(SaveSnapshotButtonName);
            _saveSnapshotButton.UserClickOnButtonEvent += SaveSnapshotButton_UserClickOnButtonEvent;
            _loadSnapshotButton = CreateParameterButton(LoadSnapshotButtonName);
            _loadSnapshotButton.UserClickOnButtonEvent += LoadSnapshotButton_UserClickOnButtonEvent;

            _openHtmlReportMainTabButton = CreateParameterButton(OpenHtmlReportMainTabButtonName);
            _openHtmlReportMainTabButton.UserClickOnButtonEvent += HtmlReportOpenButton_UserClickOnButtonEvent;

            _maxPositions = CreateParameter(MaxPositionsParamName, 40, MaxPositionsMin, MaxPositionsMax, 1);
            _maxPositionsIncButton = CreateParameterButton(MaxPositionsIncButtonName);
            _maxPositionsIncButton.UserClickOnButtonEvent += MaxPositionsIncButton_UserClickOnButtonEvent;
            _maxPositionsDecButton = CreateParameterButton(MaxPositionsDecButtonName);
            _maxPositionsDecButton.UserClickOnButtonEvent += MaxPositionsDecButton_UserClickOnButtonEvent;

            _volumeType = CreateParameter(
                "Volume type",
                "Deposit percent",
                new[] { "Contracts", "Contract currency", "Deposit percent" });
            _volume = CreateParameter(VolumeParamName, 10, VolumeMin, VolumeMax, 4);
            _volumeIncButton = CreateParameterButton(VolumeIncButtonName);
            _volumeIncButton.UserClickOnButtonEvent += VolumeIncButton_UserClickOnButtonEvent;
            _volumeDecButton = CreateParameterButton(VolumeDecButtonName);
            _volumeDecButton.UserClickOnButtonEvent += VolumeDecButton_UserClickOnButtonEvent;
            _tradeAssetInPortfolio = CreateParameter("Asset in portfolio", "Prime");

            _referenceInitialPortfolioAmount = CreateParameter(
                ReferenceInitialPortfolioAmountParamName,
                0m,
                0m,
                1_000_000_000_000m,
                0.01m);
            _referenceLaunchDate = CreateParameter(ReferenceLaunchDateParamName, "");
            _fillReferencePortfolioBaselineButton = CreateParameterButton(FillReferencePortfolioBaselineButtonName);
            _fillReferencePortfolioBaselineButton.UserClickOnButtonEvent +=
                FillReferencePortfolioBaselineButton_UserClickOnButtonEvent;
            _referenceCurrentAnnualPercent = CreateParameter(
                ReferenceCurrentAnnualPercentParamName,
                0m,
                -1_000_000m,
                1_000_000m,
                0.01m);
            _referenceCurrentAnnualPercentWithCap = CreateParameter(
                ReferenceCurrentAnnualPercentWithCapParamName,
                0m,
                -1_000_000m,
                1_000_000m,
                0.01m);

            _setDefaultLogicsButton = CreateParameterButton(LogicsSetDefaultButtonName, LogicsTabName);
            _setDefaultLogicsButton.UserClickOnButtonEvent += SetDefaultLogicsButton_UserClickOnButtonEvent;
            _clearLogicsButton = CreateParameterButton(ClearLogicsButtonName, LogicsTabName);
            _clearLogicsButton.UserClickOnButtonEvent += ClearLogicsButton_UserClickOnButtonEvent;
            _randomResetLogicsButton = CreateParameterButton(RandomResetLogicsButtonName, LogicsTabName);
            _randomResetLogicsButton.UserClickOnButtonEvent += RandomResetLogicsButton_UserClickOnButtonEvent;
            _stopRobotAndSellAllLogicsTabButton = CreateParameterButton(
                StopRobotAndSellAllLogicsTabButtonName,
                LogicsTabName);
            _stopRobotAndSellAllLogicsTabButton.UserClickOnButtonEvent += StopRobotAndSellAllButton_UserClickOnButtonEvent;
            _addLogicVariant = CreateParameter(
                AddLogicVariantParamName,
                MultiLogicTrendCatalog.ChoiceLabels[0],
                MultiLogicTrendCatalog.ChoiceLabels,
                LogicsTabName);
            _addLogicButton = CreateParameterButton(AddLogicButtonName, LogicsTabName);
            _addLogicButton.UserClickOnButtonEvent += AddLogicButton_UserClickOnButtonEvent;
            _logicSideInversion = CreateParameter(LogicSideInversionParamName, false, LogicsTabName);
            _logicLinRegLen = CreateParameter(
                LogicLinRegLengthParamName,
                LogicLinRegLengthDefault,
                LogicLinRegLengthMin,
                LogicLinRegLengthMax,
                1,
                LogicsTabName);
            _logicLinRegLenIncButton = CreateParameterButton(LogicLinRegLenIncButtonName, LogicsTabName);
            _logicLinRegLenIncButton.UserClickOnButtonEvent += LogicLinRegLenIncButton_UserClickOnButtonEvent;
            _logicLinRegLenDecButton = CreateParameterButton(LogicLinRegLenDecButtonName, LogicsTabName);
            _logicLinRegLenDecButton.UserClickOnButtonEvent += LogicLinRegLenDecButton_UserClickOnButtonEvent;
            _logicStrictness = CreateParameter(
                LogicStrictnessParamName,
                LogicStrictnessDefault,
                LogicStrictnessMin,
                LogicStrictnessMax,
                1,
                LogicsTabName);
            _logicStrictnessIncButton = CreateParameterButton(LogicStrictnessIncButtonName, LogicsTabName);
            _logicStrictnessIncButton.UserClickOnButtonEvent += LogicStrictnessIncButton_UserClickOnButtonEvent;
            _logicStrictnessDecButton = CreateParameterButton(LogicStrictnessDecButtonName, LogicsTabName);
            _logicStrictnessDecButton.UserClickOnButtonEvent += LogicStrictnessDecButton_UserClickOnButtonEvent;

            _logic1 = CreateParameter("Логика 1", MultiLogicDefaultLogics.Logic1LongTrend, LogicsTabName);
            _logic2 = CreateParameter("Логика 2", MultiLogicDefaultLogics.Logic2LongBokovik, LogicsTabName);
            _logic3 = CreateParameter("Логика 3", MultiLogicDefaultLogics.Logic3ShortTrend, LogicsTabName);
            _logic4 = CreateParameter("Логика 4", MultiLogicDefaultLogics.Logic4ShortBokovik, LogicsTabName);
            _logic5 = CreateParameter("Логика 5", "", LogicsTabName);
            _logic6 = CreateParameter("Логика 6", "", LogicsTabName);
            _logic7 = CreateParameter("Логика 7", "", LogicsTabName);
            _logic8 = CreateParameter("Логика 8", "", LogicsTabName);
            _logic9 = CreateParameter("Логика 9", "", LogicsTabName);
            _logic10 = CreateParameter("Логика 10", "", LogicsTabName);

            _logicHelpButton = CreateParameterButton(LogicsHelpButtonName, LogicsTabName);
            _logicHelpButton.UserClickOnButtonEvent += LogicHelpButton_UserClickOnButtonEvent;
            _exportLogicsButton = CreateParameterButton(ExportLogicsButtonName, LogicsTabName);
            _exportLogicsButton.UserClickOnButtonEvent += ExportLogicsButton_UserClickOnButtonEvent;
            _importLogicsButton = CreateParameterButton(ImportLogicsButtonName, LogicsTabName);
            _importLogicsButton.UserClickOnButtonEvent += ImportLogicsButton_UserClickOnButtonEvent;

            _metaLogicEnabled = CreateParameter(MetaLogicEnabledParamName, false, MetaLogicsTabName);
            _metaLogicInversion = CreateParameter(MetaLogicInversionParamName, false, MetaLogicsTabName);
            _metaLogicEnableButton = CreateParameterButton(MetaLogicEnableButtonName, MetaLogicsTabName);
            _metaLogicEnableButton.UserClickOnButtonEvent += MetaLogicEnableButton_UserClickOnButtonEvent;

            _usePortfolioAdjSma = CreateParameter(PortfolioPnlSmaEnableParamName, true, MetaLogicsTabName);
            _portfolioAdjSmaLen = CreateParameter(
                PortfolioPnlSmaLenParamName,
                24,
                2,
                500,
                1,
                MetaLogicsTabName);

            _usePortfolioSma = CreateParameter("Общепортфельный SMA: включить", false, MetaLogicsTabName);
            _portfolioSmaLen = CreateParameter("Общепортфельный SMA: длина", 100, 5, 300, 1, MetaLogicsTabName);
            _portfolioSmaSource = CreateParameter(
                "Общепортфельный SMA: источник",
                "Close",
                new[] { "Close", "Open", "High", "Low" },
                MetaLogicsTabName);

            _usePortfolioStoch = CreateParameter("Общепортфельный Stoch: включить", false, MetaLogicsTabName);
            _portfolioStochP1 = CreateParameter("Общепортфельный Stoch: P1", 14, 2, 100, 1, MetaLogicsTabName);
            _portfolioStochP2 = CreateParameter("Общепортфельный Stoch: P2", 3, 1, 50, 1, MetaLogicsTabName);
            _portfolioStochP3 = CreateParameter("Общепортфельный Stoch: P3", 3, 1, 50, 1, MetaLogicsTabName);
            _portfolioStochLongMin = CreateParameter("Общепортфельный Stoch: long min", 55m, 0m, 100m, 1m, MetaLogicsTabName);
            _portfolioStochShortMax = CreateParameter("Общепортфельный Stoch: short max", 45m, 0m, 100m, 1m, MetaLogicsTabName);

            _usePortfolioAtr = CreateParameter("Общепортфельный ATR: включить", false, MetaLogicsTabName);
            _portfolioAtrLen = CreateParameter("Общепортфельный ATR: длина", 14, 2, 200, 1, MetaLogicsTabName);
            _portfolioAtrGrowPercent = CreateParameter(
                "Общепортфельный ATR: min grow % vs lookback",
                3m,
                0m,
                100m,
                0.1m,
                MetaLogicsTabName);
            _portfolioAtrGrowLookBack = CreateParameter(
                "Общепортфельный ATR: grow lookback (candles)",
                5,
                1,
                500,
                1,
                MetaLogicsTabName);

            _usePortfolioLinReg = CreateParameter("Общепортфельный LinReg: включить", false, MetaLogicsTabName);
            _portfolioLinRegLen = CreateParameter("Общепортфельный LinReg: длина", 50, 20, 300, 10, MetaLogicsTabName);
            _portfolioLinRegDev = CreateParameter("Общепортфельный LinReg: deviation", 2m, 1m, 4m, 0.1m, MetaLogicsTabName);

            _usePortfolioMacd = CreateParameter("Общепортфельный MACD: включить", false, MetaLogicsTabName);
            _portfolioMacdFastLen = CreateParameter("Общепортфельный MACD: fast", 12, 2, 100, 1, MetaLogicsTabName);
            _portfolioMacdSlowLen = CreateParameter("Общепортфельный MACD: slow", 26, 2, 300, 1, MetaLogicsTabName);
            _portfolioMacdSignalLen = CreateParameter("Общепортфельный MACD: signal", 9, 2, 100, 1, MetaLogicsTabName);

            _portfolioPrevIndicatorVolumeCalc = CreateParameter(
                "Предыдущий индикатор. Расчёт объёма позиций",
                "",
                MetaLogicsTabName);

            CreateStopperParameters();
            CreateHtmlReportParameters();

            const string moexFuturesTab = "MOEX фьючерсы";
            _moexFuturesTickerPrefixes = CreateParameter(
                "Префиксы корня тикера (T-Инвестиции; ROSN, LKOH; CNY — также CR, CNYRUBF)",
                DefaultMoexFuturesTickerPrefixes,
                moexFuturesTab);
            _moexFuturesResetPrefixesButton = CreateParameterButton("Установить префиксы фьючерсов по умолчанию", moexFuturesTab);
            _moexFuturesResetPrefixesButton.UserClickOnButtonEvent += MoexFuturesResetPrefixesButton_UserClickOnButtonEvent;
            _moexFuturesExtendedResetPrefixesButton = CreateParameterButton(
                "Установить расширенный список префиксов фьючерсов по умолчанию",
                moexFuturesTab);
            _moexFuturesExtendedResetPrefixesButton.UserClickOnButtonEvent +=
                MoexFuturesExtendedResetPrefixesButton_UserClickOnButtonEvent;
            _moexFuturesLoadButton = CreateParameterButton("Обновить фьючерсы", moexFuturesTab);
            _moexFuturesLoadButton.UserClickOnButtonEvent += MoexFuturesLoadButton_UserClickOnButtonEvent;

            const string moexStockTab = "MOEX акции";
            _moexStockTickerPrefixes = CreateParameter(
                "Тикеры акций (через запятую; T-Инвестиции, точное совпадение с Ticker)",
                DefaultMoexStockTickerPrefixes,
                moexStockTab);
            _moexStockResetPrefixesButton = CreateParameterButton("Установить тикеры акций по умолчанию", moexStockTab);
            _moexStockResetPrefixesButton.UserClickOnButtonEvent += MoexStockResetPrefixesButton_UserClickOnButtonEvent;
            _moexStockLoadButton = CreateParameterButton("Обновить акции", moexStockTab);
            _moexStockLoadButton.UserClickOnButtonEvent += MoexStockLoadButton_UserClickOnButtonEvent;

            RegisterParameterHints();
            ParametrsChangeByUser += MultiLogic_ParametrsChangeByUser;

            Description = "MultiLogic: 10 логик, общие индикаторы, торговля по Op/Cl (Regime=On).";

            TryParseAndApplyAllLogicSlots(logToUser: false);
            EnsureLogicHelpFileUpToDate(logToUser: false);
            LoadLogicPortfoliosFromDisk();
            EnsureLogicPortfolioInitPoints();
            InitializeHtmlReportSession();
            _stopperReferenceBaselineLocked = _portfolioStopperReferenceEquity.ValueDecimal != 0m;
            CheckAndWarnMultiLogicResources(force: true);
            LogRegimeStateOnStartup();
            SyncStopMonitorScreenerPage(logToUser: false);
            RefreshPreviousAcceptBackupSnapshot();
            RefreshHtmlReportConfigBaseline();
            _parametersAcceptBackupEnabled = true;
        }

        /// <summary>Один раз при старте — откуда взялся Regime (файл или default Off).</summary>
        private void LogRegimeStateOnStartup()
        {
            SendNewLogMessage(
                NameStrategyUniq
                + " | Regime при старте: "
                + (_regime?.ValueString ?? "?")
                + " (из Engine\\"
                + NameStrategyUniq
                + "Parametrs.txt; если файла не было — по умолчанию Off).",
                LogMessageType.System);
        }

        /// <summary>
        /// Обработчик изменения параметров пользователем: переподключает кнопки, подсказки и перечитывает все 10 логик.
        /// </summary>
        private void MultiLogic_ParametrsChangeByUser()
        {
            WireMainTabButtons();
            WireLogicTabButtons();
            WireMetaLogicTabButtons();
            WireStopperTabButtons();
            WireMoexTabButtons();
            WireSnapshotButtons();
            WireReferenceYieldButtons();
            WireHtmlReportButtons();
            RegisterParameterHints();
            _stopperReferenceBaselineLocked = _portfolioStopperReferenceEquity.ValueDecimal != 0m;
            SyncStopMonitorScreenerPage(logToUser: false);
            TryApplyLogicStrictnessChangeOnParameterAccept();
            if (ShouldResyncLogicIndicatorsOnParameterChange()
                && HaveLogicSlotStringsChangedSinceLastSync())
            {
                CoalescedTryParseAndApplyAllLogicSlots();
            }

            CoalescedSaveParametersAcceptBackup();
            RecordHtmlReportConfigChangesIfAny();
        }

        /// <summary>
        /// После «Принять»: JSON-бэкап состояния до изменения (предыдущий снимок параметров, логик, Regime…).
        /// </summary>
        private async void CoalescedSaveParametersAcceptBackup()
        {
            if (!_parametersAcceptBackupEnabled
                || StartProgram == StartProgram.IsOsOptimizer
                || StartProgram == StartProgram.IsTester)
            {
                return;
            }

            int token = Interlocked.Increment(ref _paramsBackupCoalesceToken);

            try
            {
                await Task.Delay(ParametersBackupCoalesceMs).ConfigureAwait(false);
            }
            catch
            {
                return;
            }

            if (token != _paramsBackupCoalesceToken)
            {
                return;
            }

            RunOnUiThread(
                () =>
                {
                    try
                    {
                        SaveParametersAcceptBackupToDisk();
                    }
                    catch (Exception ex)
                    {
                        SendNewLogMessage(
                            NameStrategyUniq + " | автобэкап параметров: " + ex.Message,
                            LogMessageType.Error);
                    }
                },
                preferAsync: true);
        }

        /// <summary>
        /// Снимок до «Принять» в Engine\{NameStrategyUniq}_ParamsBackups\…; затем обновляется база для следующего раза.
        /// </summary>
        private void SaveParametersAcceptBackupToDisk()
        {
            if (_previousAcceptBackupSnapshot == null)
            {
                RefreshPreviousAcceptBackupSnapshot();
                return;
            }

            string dir = GetParametersBackupDirectory();
            Directory.CreateDirectory(dir);
            string path = Path.Combine(dir, BuildParametersBackupFileName());

            MultiLogicSnapshotFile toWrite = CloneAcceptBackupSnapshot(_previousAcceptBackupSnapshot);
            toWrite.SavedAtUtc = DateTime.UtcNow;
            string json = JsonConvert.SerializeObject(toWrite, Formatting.Indented);
            File.WriteAllText(path, json, new UTF8Encoding(false));
            TrimOldParametersBackups(dir);

            RefreshPreviousAcceptBackupSnapshot();

            SendNewLogMessage(
                NameStrategyUniq + " | автобэкап (параметры до «Принять»): " + path,
                LogMessageType.System);
        }

        /// <summary>Запомнить текущие параметры как «до следующего Принять».</summary>
        private void RefreshPreviousAcceptBackupSnapshot()
        {
            _previousAcceptBackupSnapshot = BuildMultiLogicSnapshot();
        }

        private static MultiLogicSnapshotFile CloneAcceptBackupSnapshot(MultiLogicSnapshotFile source)
        {
            if (source == null)
            {
                return new MultiLogicSnapshotFile();
            }

            string json = JsonConvert.SerializeObject(source);
            return JsonConvert.DeserializeObject<MultiLogicSnapshotFile>(json);
        }

        private string GetParametersBackupDirectory()
        {
            return Path.Combine("Engine", NameStrategyUniq + ParametersBackupFolderSuffix);
        }

        private string BuildParametersBackupFileName()
        {
            return NameStrategyUniq
                + "_Params_"
                + DateTime.Now.ToString("yyyy-MM-dd_HH-mm-ss", CultureInfo.InvariantCulture)
                + ".json";
        }

        private void TrimOldParametersBackups(string dir)
        {
            if (ParametersBackupMaxFiles <= 0 || !Directory.Exists(dir))
            {
                return;
            }

            string[] files;
            try
            {
                files = Directory.GetFiles(dir, NameStrategyUniq + "_Params_*.json");
            }
            catch
            {
                return;
            }

            if (files.Length <= ParametersBackupMaxFiles)
            {
                return;
            }

            Array.Sort(files, (a, b) => File.GetLastWriteTimeUtc(a).CompareTo(File.GetLastWriteTimeUtc(b)));
            int removeCount = files.Length - ParametersBackupMaxFiles;
            for (int i = 0; i < removeCount; i++)
            {
                try
                {
                    File.Delete(files[i]);
                }
                catch
                {
                    // ignore
                }
            }
        }

        /// <summary>
        /// Откладывает перечитывание всех слотов логики: при «Принять» после пресета не парсим 10 раз подряд.
        /// </summary>
        private async void CoalescedTryParseAndApplyAllLogicSlots()
        {
            int token = Interlocked.Increment(ref _logicParseCoalesceToken);

            try
            {
                await Task.Delay(50).ConfigureAwait(false);
            }
            catch
            {
                return;
            }

            if (token != _logicParseCoalesceToken)
            {
                return;
            }

            try
            {
                RunOnUiThread(
                    () => TryParseAndApplyAllLogicSlots(logToUser: false),
                    preferAsync: true);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        /// <summary>Переподписывает кнопки ±5 для Volume и Max positions на главной вкладке параметров.</summary>
        private void WireMainTabButtons()
        {
            WireLogicTabButton(MaxPositionsIncButtonName, MaxPositionsIncButton_UserClickOnButtonEvent);
            WireLogicTabButton(MaxPositionsDecButtonName, MaxPositionsDecButton_UserClickOnButtonEvent);
            WireLogicTabButton(VolumeIncButtonName, VolumeIncButton_UserClickOnButtonEvent);
            WireLogicTabButton(VolumeDecButtonName, VolumeDecButton_UserClickOnButtonEvent);
        }

        private void MaxPositionsIncButton_UserClickOnButtonEvent()
        {
            AdjustMaxPositionsParameter(+MaxPositionsButtonDelta);
        }

        private void MaxPositionsDecButton_UserClickOnButtonEvent()
        {
            AdjustMaxPositionsParameter(-MaxPositionsButtonDelta);
        }

        private void VolumeIncButton_UserClickOnButtonEvent()
        {
            AdjustVolumeParameter(+VolumeButtonDelta);
        }

        private void VolumeDecButton_UserClickOnButtonEvent()
        {
            AdjustVolumeParameter(-VolumeButtonDelta);
        }

        private StrategyParameterInt ResolveMaxPositionsParameter()
        {
            IIStrategyParameter fromList = Parameters?.Find(p => p.Name == MaxPositionsParamName);
            return (fromList as StrategyParameterInt) ?? _maxPositions;
        }

        private StrategyParameterDecimal ResolveVolumeParameter()
        {
            IIStrategyParameter fromList = Parameters?.Find(p => p.Name == VolumeParamName);
            return (fromList as StrategyParameterDecimal) ?? _volume;
        }

        private int ReadMaxPositionsCurrent()
        {
            ApplyPrefixesFromOpenParameterDialog();

            if (TryReadIntParameterFromOpenParameterGui(MaxPositionsParamName, out int fromGui))
            {
                return fromGui;
            }

            return ResolveMaxPositionsParameter()?.ValueInt ?? 40;
        }

        private decimal ReadVolumeCurrent()
        {
            ApplyPrefixesFromOpenParameterDialog();

            if (TryReadDecimalParameterFromOpenParameterGui(VolumeParamName, out decimal fromGui))
            {
                return fromGui;
            }

            return ResolveVolumeParameter()?.ValueDecimal ?? 10m;
        }

        private void ApplyMaxPositionsValue(int next)
        {
            StrategyParameterInt param = ResolveMaxPositionsParameter();
            if (param == null)
            {
                return;
            }

            next = Math.Max(MaxPositionsMin, Math.Min(MaxPositionsMax, next));
            SetStrategyParameterIntSilent(param, next);
            TryApplyIntParameterToOpenParameterGui(MaxPositionsParamName, next);
            _loggedMaxPositionsLimit = false;
            SaveParametersWithoutLogicIndicatorResync();
            RequestParameterGuiRepaintOnce();
            RecordHtmlReportConfigChangesIfAny();
        }

        private void ApplyVolumeValue(decimal next)
        {
            StrategyParameterDecimal param = ResolveVolumeParameter();
            if (param == null)
            {
                return;
            }

            next = Math.Max(VolumeMin, Math.Min(VolumeMax, next));
            SetStrategyParameterDecimalSilent(param, next);
            TryApplyDecimalParameterToOpenParameterGui(VolumeParamName, next);
            SaveParametersWithoutLogicIndicatorResync();
            RequestParameterGuiRepaintOnce();
            RecordHtmlReportConfigChangesIfAny();
        }

        private void AdjustMaxPositionsParameter(int delta)
        {
            try
            {
                int current = ReadMaxPositionsCurrent();
                int next = Math.Max(MaxPositionsMin, Math.Min(MaxPositionsMax, current + delta));
                if (next == current)
                {
                    SendNewLogMessage(
                        NameStrategyUniq
                        + " | "
                        + MaxPositionsParamName
                        + ": "
                        + current
                        + " — изменение "
                        + (delta >= 0 ? "+" : "")
                        + delta
                        + " не выполнено (граница "
                        + MaxPositionsMin
                        + "…"
                        + MaxPositionsMax
                        + ").",
                        LogMessageType.User);
                    return;
                }

                ApplyMaxPositionsValue(next);
                SendNewLogMessage(
                    NameStrategyUniq + " | " + MaxPositionsParamName + ": " + current + " → " + next + ".",
                    LogMessageType.User);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        private void AdjustVolumeParameter(decimal delta)
        {
            try
            {
                decimal current = ReadVolumeCurrent();
                decimal next = Math.Max(VolumeMin, Math.Min(VolumeMax, current + delta));
                if (next == current)
                {
                    SendNewLogMessage(
                        NameStrategyUniq
                        + " | "
                        + VolumeParamName
                        + ": "
                        + current.ToString(CultureInfo.InvariantCulture)
                        + " — изменение "
                        + (delta >= 0m ? "+" : "")
                        + delta.ToString(CultureInfo.InvariantCulture)
                        + " не выполнено (граница "
                        + VolumeMin.ToString(CultureInfo.InvariantCulture)
                        + "…"
                        + VolumeMax.ToString(CultureInfo.InvariantCulture)
                        + ").",
                        LogMessageType.User);
                    return;
                }

                ApplyVolumeValue(next);
                SendNewLogMessage(
                    NameStrategyUniq
                    + " | "
                    + VolumeParamName
                    + ": "
                    + current.ToString(CultureInfo.InvariantCulture)
                    + " → "
                    + next.ToString(CultureInfo.InvariantCulture)
                    + ".",
                    LogMessageType.User);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        /// <summary>Переподписывает обработчики кнопок на вкладке «Логики» (после пересоздания UI параметров).</summary>
        private void WireLogicTabButtons()
        {
            WireLogicTabButton(LogicsHelpButtonName, LogicHelpButton_UserClickOnButtonEvent);
            WireLogicTabButton(LogicsSetDefaultButtonName, SetDefaultLogicsButton_UserClickOnButtonEvent);
            WireLogicTabButton(ExportLogicsButtonName, ExportLogicsButton_UserClickOnButtonEvent);
            WireLogicTabButton(ImportLogicsButtonName, ImportLogicsButton_UserClickOnButtonEvent);
            WireLogicTabButton(ClearLogicsButtonName, ClearLogicsButton_UserClickOnButtonEvent);
            WireLogicTabButton(RandomResetLogicsButtonName, RandomResetLogicsButton_UserClickOnButtonEvent);
            WireLogicTabButton(StopRobotAndSellAllLogicsTabButtonName, StopRobotAndSellAllButton_UserClickOnButtonEvent);
            WireLogicTabButton(AddLogicButtonName, AddLogicButton_UserClickOnButtonEvent);
            WireLogicTabButton(LogicLinRegLenIncButtonName, LogicLinRegLenIncButton_UserClickOnButtonEvent);
            WireLogicTabButton(LogicLinRegLenDecButtonName, LogicLinRegLenDecButton_UserClickOnButtonEvent);
            WireLogicTabButton(LogicStrictnessIncButtonName, LogicStrictnessIncButton_UserClickOnButtonEvent);
            WireLogicTabButton(LogicStrictnessDecButtonName, LogicStrictnessDecButton_UserClickOnButtonEvent);
        }

        private void LogicLinRegLenIncButton_UserClickOnButtonEvent()
        {
            try
            {
                int current = ReadLogicLinRegLengthCurrent();
                if (current >= LogicLinRegLengthMax)
                {
                    SendNewLogMessage(
                        NameStrategyUniq
                        + " | "
                        + LogicLinRegLengthParamName
                        + ": уже максимум ("
                        + LogicLinRegLengthMax
                        + ").",
                        LogMessageType.User);
                    return;
                }

                int next = Math.Min(LogicLinRegLengthMax, current + LogicLinRegLengthStep);
                ApplyLogicLinRegLengthValue(next);
                SendNewLogMessage(
                    NameStrategyUniq + " | " + LogicLinRegLengthParamName + " → " + next + ".",
                    LogMessageType.User);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        private void LogicLinRegLenDecButton_UserClickOnButtonEvent()
        {
            try
            {
                int current = ReadLogicLinRegLengthCurrent();
                if (current <= LogicLinRegLengthMin)
                {
                    SendNewLogMessage(
                        NameStrategyUniq
                        + " | "
                        + LogicLinRegLengthParamName
                        + ": минимум "
                        + LogicLinRegLengthMin
                        + " — уменьшение не выполнено.",
                        LogMessageType.User);
                    return;
                }

                int next = Math.Max(LogicLinRegLengthMin, current - LogicLinRegLengthStep);
                ApplyLogicLinRegLengthValue(next);
                SendNewLogMessage(
                    NameStrategyUniq + " | " + LogicLinRegLengthParamName + " → " + next + ".",
                    LogMessageType.User);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        private void LogicStrictnessIncButton_UserClickOnButtonEvent()
        {
            try
            {
                int current = ReadLogicStrictnessCurrent();
                if (current >= LogicStrictnessMax)
                {
                    SendNewLogMessage(
                        NameStrategyUniq
                        + " | "
                        + LogicStrictnessParamName
                        + ": уже максимум ("
                        + LogicStrictnessMax
                        + ").",
                        LogMessageType.User);
                    return;
                }

                ApplyLogicStrictnessValue(current + 1, current);
                SendNewLogMessage(
                    NameStrategyUniq + " | " + LogicStrictnessParamName + " → " + (current + 1) + ".",
                    LogMessageType.User);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        private void LogicStrictnessDecButton_UserClickOnButtonEvent()
        {
            try
            {
                int current = ReadLogicStrictnessCurrent();
                if (current <= LogicStrictnessMin)
                {
                    SendNewLogMessage(
                        NameStrategyUniq
                        + " | "
                        + LogicStrictnessParamName
                        + ": минимум "
                        + LogicStrictnessMin
                        + " — уменьшение не выполнено.",
                        LogMessageType.User);
                    return;
                }

                ApplyLogicStrictnessValue(current - 1, current);
                SendNewLogMessage(
                    NameStrategyUniq + " | " + LogicStrictnessParamName + " → " + (current - 1) + ".",
                    LogMessageType.User);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        /// <summary>Переподписывает кнопки вкладки «Металогики».</summary>
        private void WireMetaLogicTabButtons()
        {
            WireLogicTabButton(MetaLogicEnableButtonName, MetaLogicEnableButton_UserClickOnButtonEvent);
        }

        /// <summary>Переподписывает кнопки вкладки «Stopper».</summary>
        private void WireStopperTabButtons()
        {
            WireLogicTabButton(
                UpdateStopperPortfolioBaselineButtonName,
                UpdateStopperPortfolioBaselineButton_UserClickOnButtonEvent);
            WireLogicTabButton(StopperSlPercentIncButtonName, StopperSlPercentIncButton_UserClickOnButtonEvent);
            WireLogicTabButton(StopperSlPercentDecButtonName, StopperSlPercentDecButton_UserClickOnButtonEvent);
            WireLogicTabButton(StopperTpPercentIncButtonName, StopperTpPercentIncButton_UserClickOnButtonEvent);
            WireLogicTabButton(StopperTpPercentDecButtonName, StopperTpPercentDecButton_UserClickOnButtonEvent);
        }

        private void MetaLogicEnableButton_UserClickOnButtonEvent()
        {
            _metaLogicEnabled.ValueBool = true;
            RequestParameterGuiRepaintOnce();
            SaveParametersWithoutLogicIndicatorResync();
            SendNewLogMessage(
                NameStrategyUniq + " | Металогика включена (Volume по PnlSMA между логиками с сигналом входа).",
                LogMessageType.System);
        }

        /// <summary>Переподписывает кнопки JSON-снимка на первой вкладке параметров.</summary>
        private void WireSnapshotButtons()
        {
            WireLogicTabButton(SaveSnapshotButtonName, SaveSnapshotButton_UserClickOnButtonEvent);
            WireLogicTabButton(LoadSnapshotButtonName, LoadSnapshotButton_UserClickOnButtonEvent);
        }

        /// <summary>Переподписывает кнопку справочной базы % годовых на первой вкладке.</summary>
        private void WireReferenceYieldButtons()
        {
            WireLogicTabButton(
                FillReferencePortfolioBaselineButtonName,
                FillReferencePortfolioBaselineButton_UserClickOnButtonEvent);
        }

        private void FillReferencePortfolioBaselineButton_UserClickOnButtonEvent()
        {
            try
            {
                TryApplyFillReferencePortfolioBaseline(logButtonPress: true);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        /// <summary>
        /// Заполняет справочные «Начальная сумма» и «Дата запуска» текущей суммой реального портфеля и календарной датой.
        /// </summary>
        private bool TryApplyFillReferencePortfolioBaseline(bool logButtonPress)
        {
            if (logButtonPress)
            {
                SendNewLogMessage(
                    NameStrategyUniq + " | «" + FillReferencePortfolioBaselineButtonName + "»…",
                    LogMessageType.User);
            }

            BotTabSimple tab = TryGetReferenceMonitoringTab();
            if (tab == null && _screenerTab?.Tabs != null && _screenerTab.Tabs.Count > 0)
            {
                tab = _screenerTab.Tabs[0];
            }

            decimal? portfolioAmount = TryGetRealPortfolioAmountForReference(tab);
            if (!portfolioAmount.HasValue || portfolioAmount.Value <= 0m)
            {
                string err = NameStrategyUniq
                    + " | Справочный % годовых: не удалось получить сумму реального портфеля (> 0). "
                    + "Подключите коннектор/портфель или проверьте депозит в тестере.";
                SendNewLogMessage(err, LogMessageType.Error);
                SendNewLogMessage(err, LogMessageType.User);
                return false;
            }

            DateTime candleTime = GetStopperReferenceCandleTime();
            DateTime currentDate = GetReferenceCalendarDate(tab, candleTime);
            decimal roundedAmount = Math.Round(portfolioAmount.Value, 2, MidpointRounding.AwayFromZero);

            _referenceInitialPortfolioAmount.ValueDecimal = roundedAmount;
            _referenceLaunchDate.ValueString = FormatReferenceLaunchDate(currentDate);

            SaveParametersWithoutLogicIndicatorResync();
            RequestParameterGuiRepaintOnce();
            RefreshReferenceAnnualYieldDisplay(candleTime, tab);

            string msg = NameStrategyUniq
                + " | «"
                + FillReferencePortfolioBaselineButtonName
                + "» — начальная сумма "
                + roundedAmount.ToString(CultureInfo.InvariantCulture)
                + ", дата "
                + FormatReferenceLaunchDate(currentDate)
                + ".";
            SendNewLogMessage(msg, LogMessageType.System);
            SendNewLogMessage(msg, LogMessageType.User);
            return true;
        }

        /// <summary>
        /// Пересчитывает справочные % годовых: (текущий портфель − начальный) / начальный / годы;
        /// с капитализацией — (текущий/начальный)^(1/годы) − 1. Портфель — реальный (лайв/тестер), не L1…L10.
        /// </summary>
        private void RefreshReferenceAnnualYieldDisplay(DateTime candleTime, BotTabSimple tab)
        {
            if (_referenceCurrentAnnualPercent == null || _referenceCurrentAnnualPercentWithCap == null)
            {
                return;
            }

            decimal initialAmount = _referenceInitialPortfolioAmount?.ValueDecimal ?? 0m;
            if (initialAmount <= 0m
                || _referenceLaunchDate == null
                || string.IsNullOrWhiteSpace(_referenceLaunchDate.ValueString)
                || !TryParseReferenceLaunchDate(tab, candleTime, out DateTime startDate))
            {
                SetStrategyParameterDecimalSilent(_referenceCurrentAnnualPercent, 0m);
                SetStrategyParameterDecimalSilent(_referenceCurrentAnnualPercentWithCap, 0m);
                return;
            }

            decimal? currentPortfolio = TryGetRealPortfolioAmountForReference(tab);
            if (!currentPortfolio.HasValue || currentPortfolio.Value <= 0m)
            {
                SetStrategyParameterDecimalSilent(_referenceCurrentAnnualPercent, 0m);
                SetStrategyParameterDecimalSilent(_referenceCurrentAnnualPercentWithCap, 0m);
                return;
            }

            DateTime endDate = GetReferenceCalendarDate(tab, candleTime);
            double elapsedDays = Math.Max(0d, (endDate - startDate.Date).TotalDays);
            if (elapsedDays < 1d)
            {
                SetStrategyParameterDecimalSilent(_referenceCurrentAnnualPercent, 0m);
                SetStrategyParameterDecimalSilent(_referenceCurrentAnnualPercentWithCap, 0m);
                return;
            }

            double elapsedYears = elapsedDays / 365d;
            decimal currentAmount = currentPortfolio.Value;
            decimal profitFraction = (currentAmount - initialAmount) / initialAmount;
            decimal simpleAnnual = profitFraction / (decimal)elapsedYears * 100m;
            double ratio = (double)(currentAmount / initialAmount);
            double compoundAnnual = (Math.Pow(ratio, 1d / elapsedYears) - 1d) * 100d;

            decimal roundedSimple = Math.Round(simpleAnnual, 2, MidpointRounding.AwayFromZero);
            decimal roundedCompound = Math.Round((decimal)compoundAnnual, 2, MidpointRounding.AwayFromZero);
            if (_referenceCurrentAnnualPercent.ValueDecimal != roundedSimple)
            {
                SetStrategyParameterDecimalSilent(_referenceCurrentAnnualPercent, roundedSimple);
            }

            if (_referenceCurrentAnnualPercentWithCap.ValueDecimal != roundedCompound)
            {
                SetStrategyParameterDecimalSilent(_referenceCurrentAnnualPercentWithCap, roundedCompound);
            }
        }

        private BotTabSimple TryGetReferenceMonitoringTab()
        {
            return TryGetPortfolioMonitoringReferenceTab();
        }

        /// <summary>Вкладка с подключённым портфелем (для Stopper и справочного %).</summary>
        private BotTabSimple TryGetPortfolioMonitoringReferenceTab()
        {
            if (_screenerTab?.Tabs == null || _screenerTab.Tabs.Count == 0)
            {
                return null;
            }

            for (int i = 0; i < _screenerTab.Tabs.Count; i++)
            {
                BotTabSimple tab = _screenerTab.Tabs[i];
                if (tab?.Connector?.Portfolio != null || tab?.Portfolio != null)
                {
                    return tab;
                }
            }

            return _screenerTab.Tabs[0];
        }

        private static DateTime GetReferenceCalendarDate(BotTabSimple tab, DateTime candleTime)
        {
            if (tab != null && tab.TimeServerCurrent != DateTime.MinValue)
            {
                return tab.TimeServerCurrent.Date;
            }

            return candleTime.Date;
        }

        private static string FormatReferenceLaunchDate(DateTime date)
        {
            return date.ToString("dd.MM.yyyy", CultureInfo.InvariantCulture);
        }

        private bool TryParseReferenceLaunchDate(BotTabSimple tab, DateTime candleTime, out DateTime parsedDate)
        {
            parsedDate = DateTime.MinValue;
            if (_referenceLaunchDate == null || string.IsNullOrWhiteSpace(_referenceLaunchDate.ValueString))
            {
                return false;
            }

            if (!TryParseFlexibleReferenceDateTime(tab, candleTime, _referenceLaunchDate.ValueString, out DateTime parsed))
            {
                return false;
            }

            parsedDate = parsed.Date;
            return true;
        }

        /// <summary>Парсинг даты запуска: dd.MM.yyyy, ISO, HH:mm (дата — календарный день свечи).</summary>
        private static bool TryParseFlexibleReferenceDateTime(
            BotTabSimple tab,
            DateTime candleTime,
            string rawSource,
            out DateTime parsed)
        {
            parsed = default;
            if (string.IsNullOrWhiteSpace(rawSource))
            {
                return false;
            }

            string raw = rawSource.Trim();
            if (!ContainsDigitInString(raw))
            {
                return false;
            }

            DateTime referenceDate = GetReferenceCalendarDate(tab, candleTime);
            string[] formatsFull =
            {
                "dd.MM.yyyy HH:mm:ss",
                "dd.MM.yyyy HH:mm",
                "dd.MM.yyyy",
                "yyyy-MM-dd HH:mm:ss",
                "yyyy-MM-dd HH:mm",
                "yyyy-MM-dd",
                "HH:mm:ss",
                "HH:mm"
            };

            foreach (string fmt in formatsFull)
            {
                if (DateTime.TryParseExact(raw, fmt, CultureInfo.InvariantCulture, DateTimeStyles.None, out DateTime exact))
                {
                    parsed = fmt.StartsWith("HH", StringComparison.Ordinal)
                        ? referenceDate.Add(exact.TimeOfDay)
                        : exact;
                    return true;
                }
            }

            if (DateTime.TryParse(raw, CultureInfo.InvariantCulture, DateTimeStyles.None, out DateTime loose))
            {
                parsed = loose;
                return true;
            }

            if (DateTime.TryParse(raw, new CultureInfo("ru-RU"), DateTimeStyles.None, out DateTime looseRu))
            {
                parsed = looseRu;
                return true;
            }

            return false;
        }

        private static bool ContainsDigitInString(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return false;
            }

            for (int i = 0; i < value.Length; i++)
            {
                if (char.IsDigit(value[i]))
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Находит кнопку-параметр по имени и подписывает/отписывает обработчик клика (без дублирования подписок).
        /// </summary>
        /// <param name="buttonName">Имя параметра-кнопки, например «Help».</param>
        /// <param name="handler">Делегат обработчика нажатия.</param>
        private void WireLogicTabButton(string buttonName, Action handler)
        {
            if (Parameters == null || string.IsNullOrEmpty(buttonName) || handler == null)
            {
                return;
            }

            for (int i = 0; i < Parameters.Count; i++)
            {
                if (Parameters[i] is not StrategyParameterButton button
                    || !string.Equals(button.Name, buttonName, StringComparison.Ordinal))
                {
                    continue;
                }

                button.UserClickOnButtonEvent -= handler;
                button.UserClickOnButtonEvent += handler;
            }
        }

        /// <summary>Полный путь к файлу справки в каталоге запуска OsEngine.</summary>
        private static string GetLogicHelpFilePath()
        {
            return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, LogicHelpFileRelativePath);
        }

        /// <summary>
        /// Записывает MultiLogic_LogicHelp.html, если содержимое устарело или файла нет.
        /// Сравнение по полному тексту — правки в BuildDefaultHelpHtml подхватываются без ручного удаления.
        /// </summary>
        /// <param name="logToUser">Дублировать сообщение об обновлении в пользовательский лог.</param>
        /// <returns>true, если файл создан или перезаписан.</returns>
        private bool EnsureLogicHelpFileUpToDate(bool logToUser)
        {
            string path = GetLogicHelpFilePath();
            string directory = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
            {
                Directory.CreateDirectory(directory);
            }

            string content = LogicLineParser.BuildDefaultHelpHtml();
            if (File.Exists(path))
            {
                try
                {
                    string existing = File.ReadAllText(path, Encoding.UTF8);
                    if (string.Equals(existing, content, StringComparison.Ordinal))
                    {
                        return false;
                    }
                }
                catch (Exception ex)
                {
                    SendNewLogMessage(
                        NameStrategyUniq + " | Не удалось прочитать справку для сравнения: " + ex.Message,
                        LogMessageType.System);
                }
            }

            string tempPath = path + ".tmp";
            File.WriteAllText(tempPath, content, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            if (File.Exists(path))
            {
                File.Delete(path);
            }

            File.Move(tempPath, path);

            string msg = NameStrategyUniq + " | Справка обновлена: " + path;
            SendNewLogMessage(msg, LogMessageType.System);
            if (logToUser)
            {
                SendNewLogMessage(msg, LogMessageType.User);
            }

            return true;
        }

        /// <summary>Обработчик кнопки Help: актуализирует файл справки и открывает его.</summary>
        private void LogicHelpButton_UserClickOnButtonEvent()
        {
            try
            {
                OpenLogicHelpHtmlFile();
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        /// <summary>Актуализирует HTML-справку и открывает её в браузере по умолчанию.</summary>
        private void OpenLogicHelpHtmlFile()
        {
            EnsureLogicHelpFileUpToDate(logToUser: true);

            string path = GetLogicHelpFilePath();
            Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
            SendNewLogMessage(
                NameStrategyUniq + " | Справка по логикам (HTML): " + path + " (автообновление из MultiLogic.cs).",
                LogMessageType.User);
        }

        /// <summary>
        /// Обработчик «Установить логики по умолчанию»: L1…L4 — четыре TrendMultiIndicator+CCI, L5…10 — пусто.
        /// </summary>
        private void SetDefaultLogicsButton_UserClickOnButtonEvent()
        {
            try
            {
                ApplyDefaultLogicStrings();

                string msg = NameStrategyUniq
                    + " | "
                    + MultiLogicDefaultLogics.BuildSetDefaultLogMessage()
                    + " Индикаторы синхронизированы с графиком.";
                SendNewLogMessage(msg, LogMessageType.User);
                SendNewLogMessage(msg, LogMessageType.System);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        /// <summary>
        /// Записывает заводские строки в «Логика 1…4», очищает «Логика 5» … «Логика 10» и сразу применяет на графике.
        /// </summary>
        private void ApplyDefaultLogicStrings()
        {
            int strict = ReadLogicStrictnessCurrent();
            if (strict != LogicStrictnessDefault)
            {
                StrategyParameterInt strictParam = ResolveLogicStrictnessParameter();
                if (strictParam != null)
                {
                    SetStrategyParameterIntSilent(strictParam, LogicStrictnessDefault);
                    TryApplyIntParameterToOpenParameterGui(LogicStrictnessParamName, LogicStrictnessDefault);
                }
            }

            string[] slotValues = new string[LogicSlotCount];
            for (int i = 0; i < MultiLogicDefaultLogics.SlotFormulas.Length; i++)
            {
                slotValues[i] = MultiLogicDefaultLogics.SlotFormulas[i];
            }

            ApplyLogicSlotStringsImmediate(slotValues, logParseToUser: true);
        }

        /// <summary>Очищает «Логика 1…10» (пустые строки) и сразу применяет на графике.</summary>
        private void ApplyClearLogicStrings()
        {
            var slotValues = new string[LogicSlotCount];
            ApplyLogicSlotStringsImmediate(slotValues, logParseToUser: true);
        }

        private void ClearLogicsButton_UserClickOnButtonEvent()
        {
            try
            {
                ApplyClearLogicStrings();
                string msg = NameStrategyUniq
                    + " | «Логика 1…10» очищены; индикаторы синхронизированы с графиком.";
                SendNewLogMessage(msg, LogMessageType.User);
                SendNewLogMessage(msg, LogMessageType.System);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        /// <summary>
        /// Очищает «Логика 1…10» и заполняет «Логика 1…6» шестью случайными вариантами из каталога трендовых логик.
        /// </summary>
        private void RandomResetLogicsButton_UserClickOnButtonEvent()
        {
            try
            {
                ApplyPrefixesFromOpenParameterDialog();

                MultiLogicTrendCatalog.CatalogPick[] picks = MultiLogicTrendCatalog.PickRandomEntries(
                    RandomResetLogicsFillCount,
                    Random.Shared);

                if (picks.Length == 0)
                {
                    SendNewLogMessage(
                        NameStrategyUniq + " | «Сброс логик и случайный выбор»: каталог вариантов пуст.",
                        LogMessageType.Error);
                    return;
                }

                var slotValues = new string[LogicSlotCount];
                var labelParts = new List<string>(picks.Length);
                for (int i = 0; i < picks.Length; i++)
                {
                    slotValues[i] = picks[i].Formula;
                    labelParts.Add("L" + (i + 1).ToString(CultureInfo.InvariantCulture) + ": " + picks[i].Label);
                }

                ApplyLogicSlotStringsImmediate(slotValues, logParseToUser: true);

                string detail = string.Join("; ", labelParts);
                string msg = NameStrategyUniq
                    + " | «Сброс логик и случайный выбор»: очищены «Логика 1…10»; случайно заполнены «Логика 1…"
                    + picks.Length.ToString(CultureInfo.InvariantCulture)
                    + "» ("
                    + detail
                    + "). Индикаторы синхронизированы с графиком.";
                SendNewLogMessage(msg, LogMessageType.User);
                SendNewLogMessage(msg, LogMessageType.System);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        private StrategyParameterString ResolveAddLogicVariantParameter()
        {
            IIStrategyParameter fromList = Parameters?.Find(p =>
                p.Name == AddLogicVariantParamName);
            return (fromList as StrategyParameterString) ?? _addLogicVariant;
        }

        private void AddLogicButton_UserClickOnButtonEvent()
        {
            try
            {
                ApplyPrefixesFromOpenParameterDialog();

                StrategyParameterString variantParam = ResolveAddLogicVariantParameter();
                string label = variantParam?.ValueString ?? "";
                if (!MultiLogicTrendCatalog.TryResolveFormula(label, out string formula))
                {
                    SendNewLogMessage(
                        NameStrategyUniq
                        + " | «Добавить логику»: неизвестный вариант «"
                        + label
                        + "».",
                        LogMessageType.Error);
                    return;
                }

                string[] lines = CaptureLogicLines();
                int targetSlot = TryFindFirstEmptyLogicSlot(lines);
                if (targetSlot < 1)
                {
                    string fullMsg = NameStrategyUniq
                        + " | «Добавить логику»: все слоты «Логика 1…10» заняты — добавление отменено.";
                    SendNewLogMessage(fullMsg, LogMessageType.User);
                    SendNewLogMessage(fullMsg, LogMessageType.System);
                    return;
                }

                lines[targetSlot - 1] = formula;
                ApplyLogicSlotStringsImmediate(lines, logParseToUser: true);

                string okMsg = NameStrategyUniq
                    + " | Вариант «"
                    + label
                    + "» записан в «Логика "
                    + targetSlot.ToString(CultureInfo.InvariantCulture)
                    + "»; индикаторы (SMA, RSI, Bollinger, Momentum, VWAP и др.) синхронизированы с графиком.";
                SendNewLogMessage(okMsg, LogMessageType.User);
                SendNewLogMessage(okMsg, LogMessageType.System);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        /// <summary>Первый слот 1…10 с пустой строкой логики; 0 — нет свободных.</summary>
        private static int TryFindFirstEmptyLogicSlot(IReadOnlyList<string> lines)
        {
            if (lines == null)
            {
                return 0;
            }

            int count = Math.Min(LogicSlotCount, lines.Count);
            for (int slot = 1; slot <= count; slot++)
            {
                if (string.IsNullOrWhiteSpace(lines[slot - 1]))
                {
                    return slot;
                }
            }

            return 0;
        }

        /// <summary>
        /// Записывает строки логики, обновляет окно параметров (если открыто), сохраняет и синхронизирует индикаторы.
        /// </summary>
        private void ApplyLogicSlotStringsImmediate(string[] slotValues, bool logParseToUser)
        {
            if (slotValues == null)
            {
                return;
            }

            ApplyPrefixesFromOpenParameterDialog();
            TryApplyLogicSlotStringsToOpenParameterGui(slotValues);
            CommitLogicSlotStringsToParameters(slotValues);
            SaveParametersWithoutLogicIndicatorResync();
            RequestParameterGuiRepaintOnce();
            RunOnUiThread(
                () => TryParseAndApplyAllLogicSlots(logParseToUser),
                preferAsync: true);
            RecordHtmlReportConfigChangesIfAny();
        }

        private StrategyParameterInt ResolveLogicLinRegLenParameter()
        {
            IIStrategyParameter fromList = Parameters?.Find(p => p.Name == LogicLinRegLengthParamName);
            return (fromList as StrategyParameterInt) ?? _logicLinRegLen;
        }

        private int ReadLogicLinRegLengthCurrent()
        {
            ApplyPrefixesFromOpenParameterDialog();

            if (TryReadIntParameterFromOpenParameterGui(LogicLinRegLengthParamName, out int fromGui))
            {
                return fromGui;
            }

            return ResolveLogicLinRegLenParameter()?.ValueInt ?? LogicLinRegLengthDefault;
        }

        private void ApplyLogicLinRegLengthValue(int next)
        {
            StrategyParameterInt param = ResolveLogicLinRegLenParameter();
            if (param == null)
            {
                return;
            }

            next = Math.Max(LogicLinRegLengthMin, Math.Min(LogicLinRegLengthMax, next));
            SetStrategyParameterIntSilent(param, next);
            TryApplyIntParameterToOpenParameterGui(LogicLinRegLengthParamName, next);
            SaveParametersWithoutLogicIndicatorResync();
            RequestParameterGuiRepaintOnce();
            RunOnUiThread(
                () => TryParseAndApplyAllLogicSlots(logToUser: false),
                preferAsync: true);
            RecordHtmlReportConfigChangesIfAny();
        }

        private StrategyParameterInt ResolveLogicStrictnessParameter()
        {
            IIStrategyParameter fromList = Parameters?.Find(p => p.Name == LogicStrictnessParamName);
            return (fromList as StrategyParameterInt) ?? _logicStrictness;
        }

        private int ReadLogicStrictnessCurrent()
        {
            ApplyPrefixesFromOpenParameterDialog();

            if (TryReadIntParameterFromOpenParameterGui(LogicStrictnessParamName, out int fromGui))
            {
                return LogicStrictnessAdjuster.Clamp(fromGui);
            }

            return LogicStrictnessAdjuster.Clamp(
                ResolveLogicStrictnessParameter()?.ValueInt ?? LogicStrictnessDefault);
        }

        private static int ParseStrictnessFromLogicSlotsFingerprint(string fingerprint)
        {
            if (string.IsNullOrEmpty(fingerprint))
            {
                return LogicStrictnessDefault;
            }

            string[] parts = fingerprint.Split('\u001e');
            if (parts.Length < 2 || !int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out int strict))
            {
                return LogicStrictnessDefault;
            }

            return LogicStrictnessAdjuster.Clamp(strict);
        }

        /// <summary>После «Принять»: если Strict изменили в поле параметра — пересчитать пороги в строках логик.</summary>
        private void TryApplyLogicStrictnessChangeOnParameterAccept()
        {
            int previous = ParseStrictnessFromLogicSlotsFingerprint(_lastSyncedLogicSlotsFingerprint);
            int next = ReadLogicStrictnessCurrent();
            if (next == previous)
            {
                return;
            }

            ApplyLogicStrictnessValue(next, previous);
        }

        private void ApplyLogicStrictnessValue(int next, int previous)
        {
            StrategyParameterInt param = ResolveLogicStrictnessParameter();
            if (param == null)
            {
                return;
            }

            next = LogicStrictnessAdjuster.Clamp(next);
            previous = LogicStrictnessAdjuster.Clamp(previous);
            if (next == previous)
            {
                return;
            }

            SetStrategyParameterIntSilent(param, next);
            TryApplyIntParameterToOpenParameterGui(LogicStrictnessParamName, next);
            SyncLogicParserGlobals();
            SaveParametersWithoutLogicIndicatorResync();
            RequestParameterGuiRepaintOnce();
            RunOnUiThread(
                () => TryParseAndApplyAllLogicSlots(logToUser: false),
                preferAsync: true);
            RecordHtmlReportConfigChangesIfAny();
        }

        /// <summary>
        /// Записывает строки слотов логики: в открытом окне параметров — только в таблицу (до «Принять»),
        /// иначе — в ValueString и перерисовка, как у кнопок префиксов MOEX.
        /// </summary>
        private void ApplyLogicSlotStrings(string[] slotValues)
        {
            if (slotValues == null || slotValues.Length == 0)
            {
                return;
            }

            if (ParamGuiIsOpen && TryApplyLogicSlotStringsToOpenParameterGui(slotValues))
            {
                return;
            }

            for (int slot = 1; slot <= LogicSlotCount; slot++)
            {
                StrategyParameterString param = ResolveLogicParameter(slot);
                if (param == null)
                {
                    continue;
                }

                string value = slot - 1 < slotValues.Length ? slotValues[slot - 1] ?? "" : "";
                param.ValueString = value;
            }

            RequestParameterGuiRepaintOnce();
        }

        /// <summary>
        /// Записывает строки логики в ValueString параметров без ValueChange (для кнопок с немедленным парсингом).
        /// </summary>
        private void CommitLogicSlotStringsToParameters(string[] slotValues)
        {
            if (slotValues == null)
            {
                return;
            }

            for (int slot = 1; slot <= LogicSlotCount; slot++)
            {
                StrategyParameterString param = ResolveLogicParameter(slot);
                if (param == null)
                {
                    continue;
                }

                string value = slot - 1 < slotValues.Length ? slotValues[slot - 1] ?? "" : "";
                SetStrategyParameterStringSilent(param, value);
            }
        }

        /// <summary>
        /// Обновляет ячейки «Логика 1…10» в открытом окне параметров, не трогая объекты параметров.
        /// </summary>
        private bool TryApplyLogicSlotStringsToOpenParameterGui(string[] slotValues)
        {
            if (!ParamGuiIsOpen || slotValues == null)
            {
                return false;
            }

            try
            {
                FieldInfo uiField = typeof(BotPanel).GetField(
                    "_parametersUi",
                    BindingFlags.Instance | BindingFlags.NonPublic);
                object uiObj = uiField?.GetValue(this);
                if (uiObj == null)
                {
                    return false;
                }

                FieldInfo tabsField = uiObj.GetType().GetField(
                    "_tabs",
                    BindingFlags.Instance | BindingFlags.NonPublic);
                if (tabsField?.GetValue(uiObj) is not IList tabs)
                {
                    return false;
                }

                FieldInfo gridField = typeof(ParamTabPainter).GetField(
                    "_grid",
                    BindingFlags.Instance | BindingFlags.NonPublic);
                FieldInfo paramsField = typeof(ParamTabPainter).GetField(
                    "_parameters",
                    BindingFlags.Instance | BindingFlags.NonPublic);
                if (gridField == null || paramsField == null)
                {
                    return false;
                }

                bool anyUpdated = false;

                for (int t = 0; t < tabs.Count; t++)
                {
                    object tab = tabs[t];
                    if (tab == null)
                    {
                        continue;
                    }

                    if (gridField.GetValue(tab) is not System.Windows.Forms.DataGridView grid
                        || paramsField.GetValue(tab) is not List<IIStrategyParameter> parameters)
                    {
                        continue;
                    }

                    void UpdateGridCells()
                    {
                        for (int i = 0; i < parameters.Count; i++)
                        {
                            if (parameters[i].Type != StrategyParameterType.String)
                            {
                                continue;
                            }

                            int slotIndex = ResolveLogicSlotIndexFromParameterName(parameters[i].Name);
                            if (slotIndex < 1 || i >= grid.Rows.Count || grid.Rows[i].Cells.Count <= 1)
                            {
                                continue;
                            }

                            string value = slotIndex - 1 < slotValues.Length
                                ? slotValues[slotIndex - 1] ?? ""
                                : "";
                            grid.Rows[i].Cells[1].Value = value;
                            anyUpdated = true;
                        }
                    }

                    if (grid.InvokeRequired)
                    {
                        grid.Invoke(new Action(UpdateGridCells));
                    }
                    else
                    {
                        UpdateGridCells();
                    }
                }

                return anyUpdated;
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
                return false;
            }
        }

        private static int ResolveLogicSlotIndexFromParameterName(string parameterName)
        {
            for (int slot = 1; slot <= LogicSlotCount; slot++)
            {
                if (string.Equals(parameterName, "Логика " + slot, StringComparison.Ordinal))
                {
                    return slot;
                }
            }

            return -1;
        }

        private bool TryApplyIntParameterToOpenParameterGui(string parameterName, int value)
        {
            if (!ParamGuiIsOpen || string.IsNullOrWhiteSpace(parameterName))
            {
                return false;
            }

            string valueText = value.ToString(CultureInfo.InvariantCulture);
            return TryUpdateOpenParameterGuiCell(
                parameterName,
                StrategyParameterType.Int,
                valueText,
                static (grid, rowIndex, text) => grid.Rows[rowIndex].Cells[1].Value = text);
        }

        private bool TryReadIntParameterFromOpenParameterGui(string parameterName, out int value)
        {
            value = 0;
            if (!ParamGuiIsOpen || string.IsNullOrWhiteSpace(parameterName))
            {
                return false;
            }

            if (!TryReadOpenParameterGuiCell(
                    parameterName,
                    StrategyParameterType.Int,
                    out string raw)
                || string.IsNullOrWhiteSpace(raw))
            {
                return false;
            }

            return int.TryParse(raw.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out value);
        }

        private static bool TryParseBoolParameterRaw(string raw, out bool value)
        {
            value = false;
            if (string.IsNullOrWhiteSpace(raw))
            {
                return false;
            }

            raw = raw.Trim();
            if (bool.TryParse(raw, out value))
            {
                return true;
            }

            if (string.Equals(raw, "1", StringComparison.Ordinal)
                || string.Equals(raw, "да", StringComparison.OrdinalIgnoreCase)
                || string.Equals(raw, "yes", StringComparison.OrdinalIgnoreCase))
            {
                value = true;
                return true;
            }

            if (string.Equals(raw, "0", StringComparison.Ordinal)
                || string.Equals(raw, "нет", StringComparison.OrdinalIgnoreCase)
                || string.Equals(raw, "no", StringComparison.OrdinalIgnoreCase))
            {
                value = false;
                return true;
            }

            return false;
        }

        private bool TryReadBoolParameterFromOpenParameterGui(string parameterName, out bool value)
        {
            value = false;
            if (!ParamGuiIsOpen || string.IsNullOrWhiteSpace(parameterName))
            {
                return false;
            }

            if (!TryReadOpenParameterGuiCell(
                    parameterName,
                    StrategyParameterType.Bool,
                    out string raw))
            {
                return false;
            }

            return TryParseBoolParameterRaw(raw, out value);
        }

        private bool TryReadDecimalParameterFromOpenParameterGui(string parameterName, out decimal value)
        {
            value = 0m;
            if (!ParamGuiIsOpen || string.IsNullOrWhiteSpace(parameterName))
            {
                return false;
            }

            if (!TryReadOpenParameterGuiCell(
                    parameterName,
                    StrategyParameterType.Decimal,
                    out string raw)
                || string.IsNullOrWhiteSpace(raw))
            {
                return false;
            }

            raw = raw.Trim().Replace(',', '.');
            return decimal.TryParse(raw, NumberStyles.Number, CultureInfo.InvariantCulture, out value);
        }

        private bool TryApplyDecimalParameterToOpenParameterGui(string parameterName, decimal value)
        {
            if (!ParamGuiIsOpen || string.IsNullOrWhiteSpace(parameterName))
            {
                return false;
            }

            string valueText = value.ToString(CultureInfo.InvariantCulture);
            return TryUpdateOpenParameterGuiCell(
                parameterName,
                StrategyParameterType.Decimal,
                valueText,
                static (grid, rowIndex, text) => grid.Rows[rowIndex].Cells[1].Value = text);
        }

        private StrategyParameterBool ResolveLogicSideInversionParameter()
        {
            IIStrategyParameter fromList = Parameters?.Find(p => p.Name == LogicSideInversionParamName);
            return (fromList as StrategyParameterBool) ?? _logicSideInversion;
        }

        /// <summary>
        /// «Инверсия логики»: при открытом окне параметров — из ячейки таблицы (без «Принять»), иначе ValueBool.
        /// </summary>
        private bool ReadLogicSideInversionCurrent()
        {
            if (TryReadBoolParameterFromOpenParameterGui(LogicSideInversionParamName, out bool fromGui))
            {
                return fromGui;
            }

            return ResolveLogicSideInversionParameter()?.ValueBool ?? false;
        }

        private delegate void OpenParameterGuiCellWriter(
            System.Windows.Forms.DataGridView grid,
            int rowIndex,
            string text);

        private bool TryUpdateOpenParameterGuiCell(
            string parameterName,
            StrategyParameterType parameterType,
            string text,
            OpenParameterGuiCellWriter writeCell)
        {
            if (writeCell == null)
            {
                return false;
            }

            bool VisitGrid(System.Windows.Forms.DataGridView grid, List<IIStrategyParameter> parameters)
            {
                bool updated = false;

                void UpdateCells()
                {
                    for (int i = 0; i < parameters.Count; i++)
                    {
                        if (parameters[i].Type != parameterType
                            || !string.Equals(parameters[i].Name, parameterName, StringComparison.Ordinal))
                        {
                            continue;
                        }

                        if (i >= grid.Rows.Count || grid.Rows[i].Cells.Count <= 1)
                        {
                            continue;
                        }

                        writeCell(grid, i, text);
                        updated = true;
                    }
                }

                if (grid.InvokeRequired)
                {
                    grid.Invoke(new Action(UpdateCells));
                }
                else
                {
                    UpdateCells();
                }

                return updated;
            }

            return TryForEachOpenParameterGuiGrid(VisitGrid, out bool anyMatched) && anyMatched;
        }

        private bool TryReadOpenParameterGuiCell(
            string parameterName,
            StrategyParameterType parameterType,
            out string raw)
        {
            raw = "";
            string captured = "";

            bool VisitGrid(System.Windows.Forms.DataGridView grid, List<IIStrategyParameter> parameters)
            {
                bool found = false;

                void ReadCells()
                {
                    for (int i = 0; i < parameters.Count; i++)
                    {
                        if (parameters[i].Type != parameterType
                            || !string.Equals(parameters[i].Name, parameterName, StringComparison.Ordinal))
                        {
                            continue;
                        }

                        if (i >= grid.Rows.Count || grid.Rows[i].Cells.Count <= 1)
                        {
                            continue;
                        }

                        object cell = grid.Rows[i].Cells[1].Value;
                        captured = cell?.ToString() ?? "";
                        found = true;
                        return;
                    }
                }

                if (grid.InvokeRequired)
                {
                    grid.Invoke(new Action(ReadCells));
                }
                else
                {
                    ReadCells();
                }

                return found;
            }

            if (!TryForEachOpenParameterGuiGrid(VisitGrid, out bool found)
                || !found)
            {
                return false;
            }

            raw = captured;
            return true;
        }

        private bool TryForEachOpenParameterGuiGrid(
            Func<System.Windows.Forms.DataGridView, List<IIStrategyParameter>, bool> visit,
            out bool anyMatched)
        {
            anyMatched = false;
            if (!ParamGuiIsOpen || visit == null)
            {
                return false;
            }

            try
            {
                FieldInfo uiField = typeof(BotPanel).GetField(
                    "_parametersUi",
                    BindingFlags.Instance | BindingFlags.NonPublic);
                object uiObj = uiField?.GetValue(this);
                if (uiObj == null)
                {
                    return false;
                }

                FieldInfo tabsField = uiObj.GetType().GetField(
                    "_tabs",
                    BindingFlags.Instance | BindingFlags.NonPublic);
                if (tabsField?.GetValue(uiObj) is not IList tabs)
                {
                    return false;
                }

                FieldInfo gridField = typeof(ParamTabPainter).GetField(
                    "_grid",
                    BindingFlags.Instance | BindingFlags.NonPublic);
                FieldInfo paramsField = typeof(ParamTabPainter).GetField(
                    "_parameters",
                    BindingFlags.Instance | BindingFlags.NonPublic);
                if (gridField == null || paramsField == null)
                {
                    return false;
                }

                bool anyGrid = false;
                for (int t = 0; t < tabs.Count; t++)
                {
                    object tab = tabs[t];
                    if (tab == null)
                    {
                        continue;
                    }

                    if (gridField.GetValue(tab) is not System.Windows.Forms.DataGridView grid
                        || paramsField.GetValue(tab) is not List<IIStrategyParameter> parameters)
                    {
                        continue;
                    }

                    anyGrid = true;
                    if (visit(grid, parameters))
                    {
                        anyMatched = true;
                    }
                }

                return anyGrid;
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
                return false;
            }
        }

        /// <summary>Обновляет таблицы параметров в UI после программной смены ValueString.</summary>
        private void RepaintParameterGuiTables()
        {
            if (ParamGuiSettings == null)
            {
                return;
            }

            try
            {
                System.Windows.Threading.Dispatcher dispatcher = System.Windows.Application.Current?.Dispatcher;
                if (dispatcher != null && !dispatcher.CheckAccess())
                {
                    dispatcher.BeginInvoke(
                        new Action(() => ParamGuiSettings.RePaintParameterTables()),
                        System.Windows.Threading.DispatcherPriority.Background);
                    return;
                }

                ParamGuiSettings.RePaintParameterTables();
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        /// <summary>
        /// Один запрос перерисовки окна параметров (два подряд RePaintParameterTables отменяют друг друга).
        /// </summary>
        private void RequestParameterGuiRepaintOnce()
        {
            if (!ParamGuiIsOpen || ParamGuiSettings == null)
            {
                return;
            }

            RepaintParameterGuiTables();
        }

        private static readonly FieldInfo LastParamLoadTimeField = typeof(BotPanel).GetField(
            "_lastParamLoadTime",
            BindingFlags.Instance | BindingFlags.NonPublic);

        /// <summary>Сохранить параметры, обходя cooldown после LoadParameters (как у TrendMultiIndicator).</summary>
        private void SaveParametersIgnoringRecentLoadCooldown()
        {
            if (LastParamLoadTimeField != null)
            {
                LastParamLoadTimeField.SetValue(this, DateTime.MinValue);
            }

            SaveParameters();
        }

        private bool ShouldResyncLogicIndicatorsOnParameterChange()
        {
            return _suppressLogicIndicatorResyncDepth <= 0;
        }

        private void SyncDefaultLinRegLengthToParser()
        {
            int len = _logicLinRegLen?.ValueInt ?? LogicLinRegLengthDefault;
            LogicLineParser.DefaultLinRegLength = Math.Max(LogicLinRegLengthMin, len);
        }

        private void SyncLogicParserGlobals()
        {
            SyncDefaultLinRegLengthToParser();
            LogicLineParser.DefaultStrictness = ReadLogicStrictnessCurrent();
        }

        private string BuildLogicSlotsFingerprint()
        {
            var sb = new StringBuilder(4096);
            sb.Append(_logicLinRegLen?.ValueInt ?? LogicLinRegLengthDefault);
            sb.Append('\u001e');
            sb.Append(_logicStrictness?.ValueInt ?? LogicStrictnessDefault);
            sb.Append('\u001e');
            for (int slot = 1; slot <= LogicSlotCount; slot++)
            {
                StrategyParameterString param = ResolveLogicParameter(slot);
                sb.Append(slot).Append('\u001e');
                sb.Append(param?.ValueString ?? "");
                sb.Append('\u001f');
            }

            return sb.ToString();
        }

        private bool HaveLogicSlotStringsChangedSinceLastSync()
        {
            if (string.IsNullOrEmpty(_lastSyncedLogicSlotsFingerprint))
            {
                return true;
            }

            return !string.Equals(
                BuildLogicSlotsFingerprint(),
                _lastSyncedLogicSlotsFingerprint,
                StringComparison.Ordinal);
        }

        private void MarkLogicSlotsSynced()
        {
            _lastSyncedLogicSlotsFingerprint = BuildLogicSlotsFingerprint();
        }

        /// <summary>
        /// SaveParameters для тех. полей (Stopper, справочный %, Regime) — без SyncAllLogicIndicators на UI.
        /// </summary>
        private void SaveParametersWithoutLogicIndicatorResync()
        {
            _suppressLogicIndicatorResyncDepth++;
            try
            {
                SaveParametersIgnoringRecentLoadCooldown();
            }
            finally
            {
                _suppressLogicIndicatorResyncDepth--;
            }
        }

        private static readonly FieldInfo StrategyParameterDecimalValueField = typeof(StrategyParameterDecimal).GetField(
            "_valueDecimal",
            BindingFlags.Instance | BindingFlags.NonPublic);

        private static readonly FieldInfo StrategyParameterStringValueField = typeof(StrategyParameterString).GetField(
            "_valueString",
            BindingFlags.Instance | BindingFlags.NonPublic);

        private static readonly FieldInfo StrategyParameterIntValueField = typeof(StrategyParameterInt).GetField(
            "_valueInt",
            BindingFlags.Instance | BindingFlags.NonPublic);

        /// <summary>Обновить decimal-параметр без ValueChange (не вызывает SaveParameters/ParametrsChangeByUser).</summary>
        private static void SetStrategyParameterDecimalSilent(StrategyParameterDecimal param, decimal value)
        {
            if (param == null || param.ValueDecimal == value)
            {
                return;
            }

            if (StrategyParameterDecimalValueField != null)
            {
                StrategyParameterDecimalValueField.SetValue(param, value);
                return;
            }

            param.ValueDecimal = value;
        }

        /// <summary>Обновить string-параметр без ValueChange.</summary>
        private static void SetStrategyParameterStringSilent(StrategyParameterString param, string value)
        {
            value ??= "";
            if (param == null || string.Equals(param.ValueString, value, StringComparison.Ordinal))
            {
                return;
            }

            if (StrategyParameterStringValueField != null)
            {
                StrategyParameterStringValueField.SetValue(param, value);
                return;
            }

            param.ValueString = value;
        }

        /// <summary>Обновить int-параметр без ValueChange (не вызывает SaveParameters/ParametrsChangeByUser).</summary>
        private static void SetStrategyParameterIntSilent(StrategyParameterInt param, int value)
        {
            if (param == null || param.ValueInt == value)
            {
                return;
            }

            if (StrategyParameterIntValueField != null)
            {
                StrategyParameterIntValueField.SetValue(param, value);
                return;
            }

            param.ValueInt = value;
        }

        private StrategyParameterString ResolveRegimeParameter()
        {
            IIStrategyParameter fromList = Parameters?.Find(p => p.Name == "Regime");
            return (fromList as StrategyParameterString) ?? _regime;
        }

        private StrategyParameterString ResolveStopperPostTriggerAfterStopLossParameter()
        {
            IIStrategyParameter fromList = Parameters?.Find(p =>
                p.Name == StopperPostTriggerAfterStopLossParamName);
            return (fromList as StrategyParameterString) ?? _stopperPostTriggerAfterStopLoss;
        }

        private StrategyParameterString ResolveStopperPostTriggerAfterTakeProfitParameter()
        {
            IIStrategyParameter fromList = Parameters?.Find(p =>
                p.Name == StopperPostTriggerAfterTakeProfitParamName);
            return (fromList as StrategyParameterString) ?? _stopperPostTriggerAfterTakeProfit;
        }

        private static string NormalizeStopperPostTriggerValue(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw))
            {
                return StopperPostTriggerDisabled;
            }

            string trimmed = raw.Trim();
            if (string.Equals(trimmed, "true", StringComparison.OrdinalIgnoreCase)
                || string.Equals(trimmed, "True", StringComparison.Ordinal)
                || trimmed.IndexOf("полност", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return StopperPostTriggerStopFully;
            }

            if (string.Equals(trimmed, "false", StringComparison.OrdinalIgnoreCase)
                || string.Equals(trimmed, "False", StringComparison.Ordinal)
                || string.Equals(trimmed, StopperPostTriggerDisabled, StringComparison.OrdinalIgnoreCase))
            {
                return StopperPostTriggerDisabled;
            }

            if (string.Equals(trimmed, StopperPostTriggerPauseAndResumeLegacy, StringComparison.Ordinal)
                || trimmed.IndexOf("фейк", StringComparison.OrdinalIgnoreCase) >= 0
                || (trimmed.IndexOf("возобнов", StringComparison.OrdinalIgnoreCase) >= 0
                    && trimmed.IndexOf("полност", StringComparison.OrdinalIgnoreCase) < 0))
            {
                return StopperPostTriggerPauseAndResume;
            }

            for (int i = 0; i < StopperPostTriggerChoices.Length; i++)
            {
                if (string.Equals(trimmed, StopperPostTriggerChoices[i], StringComparison.Ordinal))
                {
                    return StopperPostTriggerChoices[i];
                }
            }

            return StopperPostTriggerDisabled;
        }

        private string GetStopperPostTriggerAction(bool isTakeProfit)
        {
            StrategyParameterString param = isTakeProfit
                ? ResolveStopperPostTriggerAfterTakeProfitParameter()
                : ResolveStopperPostTriggerAfterStopLossParameter();
            return NormalizeStopperPostTriggerValue(param?.ValueString);
        }

        private static bool IsStopperPostTriggerStopFully(string action)
        {
            return string.Equals(action, StopperPostTriggerStopFully, StringComparison.Ordinal);
        }

        private static bool IsStopperPostTriggerPauseAndResume(string action)
        {
            return string.Equals(action, StopperPostTriggerPauseAndResume, StringComparison.Ordinal);
        }

        private bool IsStopperVirtualTradingActive()
        {
            return _stopperVirtualTradingActive;
        }

        private static string BuildStopperVirtualPositionKey(string tabKey, int logicSlot)
        {
            return (tabKey ?? "").Trim() + "|L" + logicSlot.ToString(CultureInfo.InvariantCulture);
        }

        private bool TryGetStopperVirtualPosition(
            BotTabSimple tab,
            int logicSlot,
            out StopperVirtualPosition virtualPosition)
        {
            virtualPosition = null;
            if (!_stopperVirtualTradingActive)
            {
                return false;
            }

            string key = BuildStopperVirtualPositionKey(GetLogicPortfolioTabKey(tab), logicSlot);
            return _stopperVirtualPositions.TryGetValue(key, out virtualPosition);
        }

        private bool HasStopperVirtualPosition(BotTabSimple tab, int logicSlot)
        {
            return TryGetStopperVirtualPosition(tab, logicSlot, out _);
        }

        private decimal GetStopperVirtualPortfolioEquity()
        {
            RecalculateAllLogicPortfolioUnrealized();
            return GetCombinedLogicPortfolioEquity();
        }

        private void EnterStopperVirtualTrading(
            decimal recoveryTargetEquity,
            DateTime candleTime,
            bool isTakeProfit)
        {
            _stopperVirtualTradingActive = true;
            _stopperVirtualRecoveryTargetEquity = recoveryTargetEquity > 0m ? recoveryTargetEquity : 0m;
            _stopperVirtualPositions.Clear();

            string kind = isTakeProfit ? "take-profit" : "stop-loss";
            string msg = NameStrategyUniq
                + " | Stopper "
                + kind
                + ": пауза реальной торговли — сигналы считаются в портфелях L1…L10; цель возобновления="
                + _stopperVirtualRecoveryTargetEquity.ToString(CultureInfo.InvariantCulture)
                + " (equity L1…L10, порог +"
                + StopperVirtualResumeOverTargetPercent.ToString(CultureInfo.InvariantCulture)
                + "%). Regime остаётся "
                + (_regime?.ValueString ?? "?")
                + ".";
            SendNewLogMessage(msg, LogMessageType.System);
            SendNewLogMessage(msg, LogMessageType.User);
        }

        private void TryResumeStopperVirtualTrading(BotTabSimple tab, DateTime candleTime)
        {
            if (IsStopperEodFlatBuyBlocked(candleTime))
            {
                return;
            }

            if (!_stopperVirtualTradingActive || _stopperVirtualRecoveryTargetEquity <= 0m)
            {
                return;
            }

            decimal virtualEquity = GetStopperVirtualPortfolioEquity();
            if (virtualEquity <= 0m)
            {
                return;
            }

            decimal threshold = _stopperVirtualRecoveryTargetEquity
                * (1m + StopperVirtualResumeOverTargetPercent / 100m);
            if (virtualEquity < threshold)
            {
                return;
            }

            _stopperVirtualTradingActive = false;
            _stopperVirtualRecoveryTargetEquity = 0m;
            _stopperVirtualPositions.Clear();

            string msg = NameStrategyUniq
                + " | Stopper: equity L1…L10="
                + virtualEquity.ToString(CultureInfo.InvariantCulture)
                + " достигла цели возобновления (порог="
                + threshold.ToString(CultureInfo.InvariantCulture)
                + ") — реальная торговля возобновлена.";
            SendNewLogMessage(msg, LogMessageType.System);
            SendNewLogMessage(msg, LogMessageType.User);
        }

        private void OpenStopperVirtualPosition(
            BotTabSimple tab,
            int logicSlot,
            decimal volume,
            Side entrySide,
            string signal)
        {
            if (tab == null || volume <= 0m || logicSlot < 1 || logicSlot > LogicSlotCount)
            {
                return;
            }

            string tabKey = GetLogicPortfolioTabKey(tab);
            string key = BuildStopperVirtualPositionKey(tabKey, logicSlot);
            decimal entryPrice = GetMarkPriceForStopperVirtual(tab, entrySide);
            if (entryPrice <= 0m)
            {
                return;
            }

            DateTime candleTime = tab.CandlesAll != null && tab.CandlesAll.Count > 0
                ? tab.CandlesAll[tab.CandlesAll.Count - 1].TimeStart
                : DateTime.Now;

            _stopperVirtualPositions[key] = new StopperVirtualPosition
            {
                TabKey = tabKey,
                LogicSlot = logicSlot,
                Direction = entrySide,
                EntryPrice = entryPrice,
                Volume = volume,
                OpenTime = candleTime,
                SignalTypeOpen = signal ?? BuildLogicEntrySignal(logicSlot)
            };

            RecalculateLogicPortfolioUnrealized(logicSlot);
            AppendLogicPortfolioPoint(logicSlot, "open", 0m, tabKey, signal, candleTime);
            SyncAggregateMetaPortfolioPoint(tab, candleTime, "open", signal);
            RecordHtmlReportTradeEvent(
                logicSlot,
                isOpen: true,
                tabKey: tabKey,
                note: signal,
                delta: 0m,
                candleTime: candleTime,
                positionOpenTime: candleTime,
                positionCloseTime: null);
            _logicPortfoliosDirty = true;
        }

        private void CloseStopperVirtualPosition(
            BotTabSimple tab,
            StopperVirtualPosition virtualPosition,
            int logicSlot,
            string closeSignalSuffix)
        {
            if (tab == null || virtualPosition == null)
            {
                return;
            }

            string key = BuildStopperVirtualPositionKey(virtualPosition.TabKey, logicSlot);
            if (!_stopperVirtualPositions.ContainsKey(key))
            {
                return;
            }

            decimal exitPrice = GetMarkPriceForStopperVirtual(
                tab,
                virtualPosition.Direction == Side.Buy ? Side.Sell : Side.Buy);
            if (exitPrice <= 0m && tab.CandlesAll != null && tab.CandlesAll.Count > 0)
            {
                exitPrice = tab.CandlesAll[tab.CandlesAll.Count - 1].Close;
            }

            decimal entry = virtualPosition.EntryPrice;
            decimal profit = CalculateLogicPortfolioProfitAbs(
                tab,
                virtualPosition.Direction,
                entry,
                exitPrice,
                virtualPosition.Volume);

            _logicPortfolios[logicSlot].Realized += profit;
            _stopperVirtualPositions.Remove(key);

            DateTime candleTime = tab.CandlesAll != null && tab.CandlesAll.Count > 0
                ? tab.CandlesAll[tab.CandlesAll.Count - 1].TimeStart
                : DateTime.Now;

            string closeSignal = (virtualPosition.SignalTypeOpen ?? BuildLogicEntrySignal(logicSlot))
                + (closeSignalSuffix ?? "_Close");

            RecalculateLogicPortfolioUnrealized(logicSlot);
            AppendLogicPortfolioPoint(
                logicSlot,
                "close",
                profit,
                virtualPosition.TabKey,
                closeSignal,
                candleTime);
            SyncAggregateMetaPortfolioPoint(tab, candleTime, "close", closeSignal);
            RecordHtmlReportTradeEvent(
                logicSlot,
                isOpen: false,
                tabKey: virtualPosition.TabKey,
                note: closeSignal,
                delta: profit,
                candleTime: candleTime,
                positionOpenTime: virtualPosition.OpenTime,
                positionCloseTime: candleTime);
            _logicPortfoliosDirty = true;
        }

        private static decimal GetMarkPriceForStopperVirtual(BotTabSimple tab, Side direction)
        {
            if (tab == null)
            {
                return 0m;
            }

            if (direction == Side.Buy && tab.PriceBestAsk > 0m)
            {
                return tab.PriceBestAsk;
            }

            if (direction == Side.Sell && tab.PriceBestBid > 0m)
            {
                return tab.PriceBestBid;
            }

            if (tab.CandlesAll != null && tab.CandlesAll.Count > 0)
            {
                return tab.CandlesAll[tab.CandlesAll.Count - 1].Close;
            }

            if (tab.PriceBestBid > 0m && tab.PriceBestAsk > 0m)
            {
                return (tab.PriceBestBid + tab.PriceBestAsk) / 2m;
            }

            return tab.PriceBestBid > 0m ? tab.PriceBestBid : tab.PriceBestAsk;
        }

        private void ProcessStopperVirtualPositionCloses(
            BotTabSimple tab,
            List<Candle> candles,
            int candleIndex,
            int logicSlotIndex,
            LogicSlotRuntime runtime)
        {
            if (!TryGetStopperVirtualPosition(tab, logicSlotIndex, out StopperVirtualPosition virtualPosition))
            {
                return;
            }

            LogicStopTakeHit stopTakeHit = LogicStopTakeEvaluator.EvaluateStopTake(
                runtime.ParseResult.Root,
                tab,
                candles,
                candleIndex,
                virtualPosition.Direction,
                virtualPosition.EntryPrice,
                FindIndicatorForAtom);

            if (stopTakeHit == LogicStopTakeHit.StopLoss)
            {
                CloseStopperVirtualPosition(tab, virtualPosition, logicSlotIndex, "_SL");
                return;
            }

            if (stopTakeHit == LogicStopTakeHit.TakeProfit)
            {
                CloseStopperVirtualPosition(tab, virtualPosition, logicSlotIndex, "_TP");
                return;
            }

            if (!EvaluateLogicCloseSignal(
                    runtime.ParseResult.Root,
                    tab,
                    candles,
                    candleIndex,
                    logicSlotIndex))
            {
                return;
            }

            CloseStopperVirtualPosition(tab, virtualPosition, logicSlotIndex, "_Close");
        }

        private void ClearStopperVirtualTradingState()
        {
            _stopperVirtualTradingActive = false;
            _stopperVirtualRecoveryTargetEquity = 0m;
            _stopperVirtualPositions.Clear();
        }

        /// <summary>Переводит Regime в Off с записью причины в лог (единственные штатные точки сброса в коде робота).</summary>
        private void TrySetRegimeOff(string reason)
        {
            ClearStopperVirtualTradingState();

            StrategyParameterString regime = ResolveRegimeParameter();
            string before = regime?.ValueString ?? "?";
            if (string.Equals(before, "Off", StringComparison.OrdinalIgnoreCase))
            {
                SendNewLogMessage(
                    NameStrategyUniq + " | Regime уже Off (" + reason + ").",
                    LogMessageType.System);
                return;
            }

            if (regime != null)
            {
                regime.ValueString = "Off";
            }

            string msg = NameStrategyUniq + " | Regime: " + before + " → Off. Причина: " + reason + ".";
            SendNewLogMessage(msg, LogMessageType.User);
            SendNewLogMessage(msg, LogMessageType.System);
        }

        /// <summary>Возвращает параметр «Логика N» по номеру слота 1…10.</summary>
        /// <param name="slotIndex">Номер слота 1…10.</param>
        /// <returns>Строковый параметр или null при неверном индексе.</returns>
        private StrategyParameterString ResolveLogicParameter(int slotIndex)
        {
            switch (slotIndex)
            {
                case 1: return _logic1;
                case 2: return _logic2;
                case 3: return _logic3;
                case 4: return _logic4;
                case 5: return _logic5;
                case 6: return _logic6;
                case 7: return _logic7;
                case 8: return _logic8;
                case 9: return _logic9;
                case 10: return _logic10;
                default: return null;
            }
        }

        /// <summary>
        /// Перечитывает все слоты «Логика 1…10», собирает уникальные индикаторы и синхронизирует график.
        /// </summary>
        /// <param name="logToUser">Дублировать сообщения парсинга в пользовательский лог.</param>
        private void TryParseAndApplyAllLogicSlots(bool logToUser)
        {
            SyncLogicParserGlobals();
            var allAtoms = new List<LogicAtom>();

            for (int slotIndex = 1; slotIndex <= LogicSlotCount; slotIndex++)
            {
                if (TryParseLogicSlot(slotIndex, logToUser, out LogicParseResult result)
                    && result.Success
                    && !result.IsDisabled)
                {
                    allAtoms.AddRange(result.Atoms);
                }
            }

            int uniqueCount = SyncAllLogicIndicators(allAtoms);
            MarkLogicSlotsSynced();
            SendNewLogMessage(
                NameStrategyUniq + " | Уникальных индикаторов на графике: " + uniqueCount + ".",
                LogMessageType.System);
            CheckAndWarnMultiLogicResources(force: false);
        }

        /// <summary>
        /// Обновляет кэш runtime-состояния слота после парсинга (активность, дерево выражения, сторона входа).
        /// </summary>
        /// <param name="logicSlotIndex">Номер слота 1…10.</param>
        /// <param name="result">Результат последнего парсинга строки.</param>
        /// <param name="isActive">true — логика участвует в индикаторах и торговле.</param>
        private void UpdateLogicSlotRuntime(int logicSlotIndex, LogicParseResult result, bool isActive)
        {
            Side entrySide = Side.Buy;
            if (isActive && result?.Root != null)
            {
                entrySide = LogicExpressionEvaluator.ResolveEntrySide(result.Root);
            }

            _logicSlotRuntimes[logicSlotIndex] = new LogicSlotRuntime
            {
                SlotIndex = logicSlotIndex,
                IsActive = isActive,
                ParseResult = result,
                EntrySide = entrySide
            };
        }

        /// <summary>
        /// Парсинг одного слота: обновляет runtime-кэш; индикаторы синхронизируются отдельно для всех слотов.
        /// </summary>
        /// <param name="logicSlotIndex">Номер слота 1…10.</param>
        /// <param name="logToUser">Дублировать сообщения в пользовательский лог.</param>
        /// <param name="result">Результат парсинга (всегда присваивается).</param>
        /// <returns>false только при ошибке разбора непустой строки.</returns>
        private bool TryParseLogicSlot(int logicSlotIndex, bool logToUser, out LogicParseResult result)
        {
            StrategyParameterString logicParam = ResolveLogicParameter(logicSlotIndex);
            string raw = logicParam?.ValueString ?? "";

            if (string.IsNullOrWhiteSpace(raw))
            {
                result = EmptyLogicParseResult;
                UpdateLogicSlotRuntime(logicSlotIndex, result, isActive: false);
                return true;
            }

            result = _logicLineParser.Parse(raw);
            if (!result.Success)
            {
                UpdateLogicSlotRuntime(logicSlotIndex, result, isActive: false);
                string err = NameStrategyUniq
                    + " | Логика "
                    + logicSlotIndex
                    + ": "
                    + string.Join("; ", result.Errors);
                SendNewLogMessage(err, LogMessageType.Error);
                if (logToUser)
                {
                    SendNewLogMessage(err, LogMessageType.User);
                }

                return false;
            }

            if (result.IsDisabled)
            {
                UpdateLogicSlotRuntime(logicSlotIndex, result, isActive: false);
                string disabledMsg = NameStrategyUniq
                    + " | Логика "
                    + logicSlotIndex
                    + ": отключена (Disabled) — не участвует в индикаторах.";
                SendNewLogMessage(disabledMsg, LogMessageType.System);
                if (logToUser)
                {
                    SendNewLogMessage(disabledMsg, LogMessageType.User);
                }

                return true;
            }

            UpdateLogicSlotRuntime(logicSlotIndex, result, isActive: result.Root != null);

            string msg = NameStrategyUniq
                + " | Логика "
                + logicSlotIndex
                + ": распознано индикаторов "
                + result.Atoms.Count
                + " (с учётом AND/OR в строке).";
            SendNewLogMessage(msg, LogMessageType.System);
            if (logToUser)
            {
                SendNewLogMessage(msg, LogMessageType.User);
            }

            return true;
        }

        /// <summary>Пустой успешный результат парсинга (пустая строка логики).</summary>
        private static LogicParseResult EmptyLogicParseResult { get; } = new LogicParseResult
        {
            Success = true,
            IsDisabled = false,
            Atoms = new List<LogicAtom>()
        };

        /// <summary>
        /// Синхронизирует индикаторы по объединённому списку атомов всех логик.
        /// Одинаковые тип+параметры+область → один индикатор на графике.
        /// </summary>
        /// <param name="atomsFromAllLogics">Атомы всех активных логик.</param>
        /// <returns>Число уникальных индикаторов на графике после синхронизации.</returns>
        private int SyncAllLogicIndicators(IReadOnlyList<LogicAtom> atomsFromAllLogics)
        {
            if (_screenerTab == null)
            {
                return 0;
            }

            List<LogicAtom> uniqueAtoms = LogicLineParser.DeduplicateAtomsByIndicatorSignature(atomsFromAllLogics);
            var existingBySignature = GetExistingLogicIndicatorSignatureMap();
            var desired = new Dictionary<int, (string type, List<string> parameters, string area, string signature)>();
            var usedNums = new HashSet<int>();
            var newSignatureToNum = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

            for (int i = 0; i < uniqueAtoms.Count; i++)
            {
                LogicAtom atom = uniqueAtoms[i];
                if (atom == null
                    || atom.Kind == LogicIndicatorKind.Unknown
                    || string.IsNullOrEmpty(atom.IndicatorTypeName))
                {
                    continue;
                }

                string signature = LogicLineParser.BuildIndicatorSignature(atom);
                int num;

                if (existingBySignature.TryGetValue(signature, out num) && !usedNums.Contains(num))
                {
                    // Переиспользуем уже созданный индикатор с теми же параметрами.
                }
                else if (newSignatureToNum.TryGetValue(signature, out int assignedNum))
                {
                    num = assignedNum;
                }
                else
                {
                    num = FindNextFreeLogicIndicatorNum(usedNums);
                    if (num < 0)
                    {
                        SendNewLogMessage(
                            NameStrategyUniq
                            + " | Слишком много уникальных индикаторов (лимит "
                            + LogicLineParser.MaxManagedLogicIndicatorNum
                            + ").",
                            LogMessageType.Error);
                        break;
                    }
                }

                usedNums.Add(num);
                desired[num] = (atom.IndicatorTypeName, atom.ToIndicatorParameters(), atom.ChartArea, signature);
                newSignatureToNum[signature] = num;
            }

            _indicatorSignatureToNum = newSignatureToNum;

            for (int num = LogicLineParser.MinLogicIndicatorNum; num <= LogicLineParser.MaxManagedLogicIndicatorNum; num++)
            {
                if (!desired.ContainsKey(num))
                {
                    RemoveLogicIndicator(num);
                }
            }

            foreach (KeyValuePair<int, (string type, List<string> parameters, string area, string signature)> item in desired)
            {
                EnsureLogicIndicator(item.Key, item.Value.type, item.Value.parameters, item.Value.area);
            }

            InvalidateRobotIndicatorsReadyCache();

            return desired.Count;
        }

        /// <summary>Сброс кэша «индикаторы на вкладке готовы» после синхронизации набора индикаторов.</summary>
        private void InvalidateRobotIndicatorsReadyCache()
        {
            lock (_robotIndicatorsEnsureLock)
            {
                _robotIndicatorsReadyTabKeys.Clear();
                _robotIndicatorsEnsureLastAttemptCandle.Clear();
            }
        }

        /// <summary>Runtime-состояние одного слота «Логика N» для торговли на свече.</summary>
        private sealed class LogicSlotRuntime
        {
            /// <summary>Номер слота 1…10.</summary>
            public int SlotIndex;
            /// <summary>Логика разобрана, не Disabled и имеет выражение.</summary>
            public bool IsActive;
            /// <summary>Последний результат парсинга (дерево AND/OR, атомы, флаг Disabled).</summary>
            public LogicParseResult ParseResult;
            /// <summary>Сторона входа: Buy (лонг) или Sell (шорт) по тегу Side в строке.</summary>
            public Side EntrySide = Side.Buy;
        }

        /// <summary>
        /// Строит карту уже созданных индикаторов робота: сигнатура → номер (101…1099).
        /// Нужна для переиспользования номеров при синхронизации без дублей.
        /// </summary>
        /// <returns>Словарь сигнатура → Num.</returns>
        private Dictionary<string, int> GetExistingLogicIndicatorSignatureMap()
        {
            var map = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            if (_screenerTab?._indicators == null)
            {
                return map;
            }

            for (int i = 0; i < _screenerTab._indicators.Count; i++)
            {
                IndicatorOnTabs ind = _screenerTab._indicators[i];
                if (ind == null
                    || ind.Num < LogicLineParser.MinLogicIndicatorNum
                    || ind.Num > LogicLineParser.MaxManagedLogicIndicatorNum)
                {
                    continue;
                }

                string signature = LogicLineParser.BuildIndicatorSignature(ind.Type, ind.NameArea, ind.Parameters);
                if (!map.ContainsKey(signature))
                {
                    map[signature] = ind.Num;
                }
            }

            return map;
        }

        /// <summary>
        /// Возвращает минимальный свободный номер индикатора в диапазоне 101…1099.
        /// </summary>
        /// <param name="usedNums">Уже занятые номера в текущей синхронизации.</param>
        /// <returns>Номер или -1, если пул исчерпан.</returns>
        private static int FindNextFreeLogicIndicatorNum(HashSet<int> usedNums)
        {
            for (int num = LogicLineParser.MinLogicIndicatorNum; num <= LogicLineParser.MaxManagedLogicIndicatorNum; num++)
            {
                if (!usedNums.Contains(num))
                {
                    return num;
                }
            }

            return -1;
        }

        /// <summary>
        /// Создаёт или обновляет описание индикатора на скринере и перезагружает его на всех вкладках.
        /// </summary>
        /// <param name="num">Номер индикатора (101…1099).</param>
        /// <param name="type">Имя типа OsEngine, например «Sma».</param>
        /// <param name="parameters">Список строковых параметров индикатора.</param>
        /// <param name="area">Область графика: Prime или Second.</param>
        private void EnsureLogicIndicator(int num, string type, List<string> parameters, string area)
        {
            if (_screenerTab == null || string.IsNullOrEmpty(type))
            {
                return;
            }

            IndicatorOnTabs existing = _screenerTab._indicators.FirstOrDefault(i => i.Num == num);
            if (existing == null)
            {
                _screenerTab.CreateCandleIndicator(num, type, parameters ?? new List<string>(), area);
                return;
            }

            existing.Type = type;
            existing.NameArea = area;
            existing.Parameters = parameters ?? new List<string>();
            existing.CanDelete = false;
            _screenerTab.ReloadIndicatorsOnTabs();
        }

        /// <summary>
        /// Удаляет индикатор робота с заданным номером со скринера и со всех дочерних вкладок.
        /// </summary>
        /// <param name="num">Номер индикатора для удаления.</param>
        private void RemoveLogicIndicator(int num)
        {
            if (_screenerTab == null)
            {
                return;
            }

            IndicatorOnTabs existing = _screenerTab._indicators.FirstOrDefault(i => i.Num == num);
            if (existing == null)
            {
                return;
            }

            string expectedName = num + existing.Type + _screenerTab.TabName;
            _screenerTab._indicators.Remove(existing);

            if (_screenerTab.Tabs == null)
            {
                return;
            }

            for (int t = 0; t < _screenerTab.Tabs.Count; t++)
            {
                BotTabSimple tab = _screenerTab.Tabs[t];
                if (tab?.Indicators == null || tab.Indicators.Count == 0)
                {
                    continue;
                }

                for (int i = 0; i < tab.Indicators.Count; i++)
                {
                    if (tab.Indicators[i] is Aindicator ind && ind.Name == expectedName)
                    {
                        tab.DeleteCandleIndicator(ind);
                        i--;
                    }
                }
            }
        }

        /// <summary>
        /// Обработчик появления новой вкладки инструмента: включает события и отложенно ставит индикаторы логик.
        /// </summary>
        /// <param name="tab">Новая вкладка BotTabSimple скринера.</param>
        private void ScreenerTab_NewTabCreateEvent(BotTabSimple tab)
        {
            if (tab == null)
            {
                return;
            }

            if (_screenerTab != null && _screenerTab.EventsIsOn)
            {
                tab.EventsIsOn = true;
            }

            // В тестере индикаторы ставятся при «Принять» (SyncAllLogicIndicators); attach с фона ломает UI.
            if (StartProgram == StartProgram.IsTester)
            {
                return;
            }

            Task.Run(async () =>
            {
                try
                {
                    await Task.Delay(800).ConfigureAwait(false);
                    ScheduleEnsureRobotIndicatorsOnTabIfNeeded(tab);
                }
                catch
                {
                    // ignore background attach errors
                }
            });
        }

        /// <summary>Флаг: подсказки параметров уже зарегистрированы в этом экземпляре робота.</summary>
        private bool _parameterHintsInitialized;
        /// <summary>Флаг: сообщение о недоступности SetToolTipParameter уже выведено в лог.</summary>
        private bool _parameterHintsUnsupportedLogged;
        /// <summary>Флаг: сообщение об успешной регистрации подсказок уже выведено в лог.</summary>
        private bool _parameterHintsRegistrationLogged;

        /// <summary>
        /// Регистрирует всплывающие подсказки (tooltip) для строк параметров через reflection SetToolTipParameter.
        /// </summary>
        private void RegisterParameterHints()
        {
            if (ParamGuiSettings == null)
            {
                return;
            }

            if (_parameterHintsInitialized)
            {
                return;
            }

            _parameterHintsInitialized = true;

            MethodInfo setToolTip = typeof(ParamGuiSettings).GetMethod(
                "SetToolTipParameter",
                BindingFlags.Public | BindingFlags.Instance,
                null,
                new[] { typeof(string), typeof(string) },
                null);

            if (setToolTip == null)
            {
                if (!_parameterHintsUnsupportedLogged)
                {
                    _parameterHintsUnsupportedLogged = true;
                    SendNewLogMessage(
                        NameStrategyUniq
                        + " | Подсказки параметров недоступны: нужна пересборка OsEngine (SetToolTipParameter).",
                        LogMessageType.System);
                }

                return;
            }

            void Hint(string name, string text) => setToolTip.Invoke(ParamGuiSettings, new object[] { name, text });

            Hint("Regime",
                "Режим робота.\n"
                + "Off — торговля и проверка сигналов не выполняются (значение по умолчанию при первом запуске).\n"
                + "On — на каждой свече проверяются все включённые логики, вход/выход по Op/Cl.\n"
                + "Regime→Off в коде только: кнопка «Остановить робота и продать всё» или Stopper SL/TP "
                + "с режимом «Останавливать полностью».");
            Hint("Остановить робота и продать всё",
                "Экстренная остановка: закрывает все позиции этого робота на вкладках скринера по рынку "
                + "(или лимитом, если рынок недоступен) и переводит Regime в Off.");
            Hint("Max positions (all tabs)",
                "Максимум одновременно открытых позиций робота на всём скринере (все вкладки). "
                + "0 — новые входы запрещены. При нехватке слотов: без металогики — L1, L2, …; "
                + "с металогикой — выше PnlSMA раньше.");
            Hint(
                MaxPositionsIncButtonName,
                "Увеличить «"
                + MaxPositionsParamName
                + "» на "
                + MaxPositionsButtonDelta
                + " (максимум "
                + MaxPositionsMax
                + "); сразу, без «Принять».");
            Hint(
                MaxPositionsDecButtonName,
                "Уменьшить «"
                + MaxPositionsParamName
                + "» на "
                + MaxPositionsButtonDelta
                + " (минимум "
                + MaxPositionsMin
                + "); сразу, без «Принять».");
            Hint("Volume type",
                "Способ задания объёма заявки:\n"
                + "Contracts — фиксированное число контрактов;\n"
                + "Contract currency — сумма в валюте контракта;\n"
                + "Deposit percent — доля от актива портфеля (см. Asset in portfolio).");
            Hint("Volume",
                "Общий объём одной «порции» на вкладку. Если на одной свече срабатывает несколько логик — "
                + "без металогики делится поровну; с «Металогика включена» — по PnlSMA между логиками с Op "
                + "(только PnlSMA&gt;0; при «Инверсия» — ещё PnlSMA&lt;0 с Buy↔Sell). Единицы — см. Volume type.");
            Hint(
                VolumeIncButtonName,
                "Увеличить «"
                + VolumeParamName
                + "» на "
                + VolumeButtonDelta.ToString(CultureInfo.InvariantCulture)
                + " (максимум "
                + VolumeMax.ToString(CultureInfo.InvariantCulture)
                + "); сразу, без «Принять».");
            Hint(
                VolumeDecButtonName,
                "Уменьшить «"
                + VolumeParamName
                + "» на "
                + VolumeButtonDelta.ToString(CultureInfo.InvariantCulture)
                + " (минимум "
                + VolumeMin.ToString(CultureInfo.InvariantCulture)
                + "); сразу, без «Принять».");
            Hint("Asset in portfolio",
                "От какой суммы на счёте считать процент при Volume type = Deposit percent.\n"
                + "Prime — вся стоимость портфеля (обычно правильный выбор).\n"
                + "rub или другой код — только баланс этого актива на борде (например, свободные деньги).");
            Hint(
                ReferenceInitialPortfolioAmountParamName,
                "Справочно: база для расчёта % годовых — сумма реального портфеля (лайв/тестер) на момент запуска.");
            Hint(
                ReferenceLaunchDateParamName,
                "Справочно: дата начала отсчёта (dd.MM.yyyy). Заполняется кнопкой или вручную.");
            Hint(
                FillReferencePortfolioBaselineButtonName,
                "Записать текущую сумму реального портфеля и сегодняшнюю дату в справочные поля выше.");
            Hint(
                ReferenceCurrentAnnualPercentParamName,
                "Справочно: (текущий портфель − начальный) / начальный / годы × 100%; обновляется в конце каждой свечи.");
            Hint(
                ReferenceCurrentAnnualPercentWithCapParamName,
                "Справочно: ((текущий/начальный)^(1/годы) − 1) × 100%; обновляется в конце каждой свечи.");
            Hint(SaveSnapshotButtonName,
                "Сохранить JSON: все параметры робота, строки «Логика 1…10», портфели логик и открытые позиции. "
                + "Автобэкап после «Принять» — тот же формат, но значения до изменения (Engine\\{имя}_ParamsBackups\\).");
            Hint(LoadSnapshotButtonName,
                "Загрузить JSON-снимок: заменить параметры, строки логик, портфели и сохранить позиции из файла "
                + "(биржевые позиции не открываются автоматически).");
            Hint(LogicsHelpButtonName,
                "Открыть Custom\\Robots\\MultiLogic_LogicHelp.html — полная справка (светлая HTML-страница); "
                + "файл автоматически обновляется при запуске робота и по этой кнопке.");
            Hint(LogicsSetDefaultButtonName, MultiLogicDefaultLogics.BuildSetDefaultButtonHint());
            Hint(ExportLogicsButtonName,
                "Сохранить строки «Логика 1…10» в JSON-файл (только логики, без параметров и портфелей). "
                + "Если окно параметров открыто — берутся текущие значения из таблицы.");
            Hint(ImportLogicsButtonName,
                "Загрузить строки «Логика 1…10» из JSON-файла того же формата или из полного JSON-снимка "
                + "(используется только блок logicLines). Индикаторы на графике синхронизируются сразу.");
            Hint(ClearLogicsButtonName,
                "Очистить все слоты «Логика 1…10» (пустые строки). Индикаторы снимаются с графика сразу, без выхода из окна параметров.");
            Hint(RandomResetLogicsButtonName,
                "Очистить «Логика 1…10» и случайно заполнить «Логика 1…6» шестью разными вариантами "
                + "из списка «Вариант трендовой логики» (12 пар лонг/шорт: RSI+Boll, Mom+Slope, VWAP, Boll break, "
                + "Dual SMA, Stoch trend). Повторов в одном нажатии нет. Индикаторы на графике — сразу, как у «Добавить логику».");
            Hint(StopRobotAndSellAllLogicsTabButtonName,
                "То же, что «Остановить робота и продать всё» на первой вкладке (дубликат на вкладке «Логики»): "
                + "закрыть все позиции робота на скринере по рынку (или лимитом, если рынок недоступен) "
                + "и перевести Regime в Off.");
            Hint(AddLogicVariantParamName,
                "Вариант трендовой логики для «Добавить логику»: пары лонг/шорт подряд "
                + "(1 RSI+Boll, 2 Mom+Slope, 3 VWAP, 4 Boll break, 5 Dual SMA, 6 Stoch trend).");
            Hint(AddLogicButtonName,
                "Записать выбранный вариант в ближайший пустой слот «Логика 1…10». "
                + "Индикаторы строки (в т.ч. RSI, Bollinger, Momentum, VWAP) создаются на графике сразу, "
                + "как при «Загрузить логику». Если все слоты заняты — сообщение в лог.");
            Hint(
                LogicSideInversionParamName,
                "Если включено — при открытии позиции Buy и Sell меняются местами для всех логик "
                + "(Side[S] и формула не меняются). Закрытие — по фактической позиции и Cl[…], без отдельной инверсии. "
                + "Regime MatchSide учитывает сторону, с которой реально откроем. "
                + "При открытом окне параметров переключение True/False действует сразу на следующих свечах, без «Принять». "
                + "Не путать с «Инверсией» на вкладке «Металогики».");
            Hint(
                LogicLinRegLengthParamName,
                "Длина окна LinReg для всех атомов LinReg(…)/Regime(…), где в формуле указано "
                + LogicLineParser.LinRegLengthParamToken
                + " или L не задан (по умолчанию "
                + LogicLineParser.LinRegLengthParamToken
                + "). Явное число в формуле, например LinReg(80;Dev=2), всегда имеет приоритет. "
                + "Минимум "
                + LogicLinRegLengthMin
                + ". Кнопки ±5 и «Принять» пересобирают LinReg на графике.");
            Hint(
                LogicLinRegLenIncButtonName,
                "Увеличить «"
                + LogicLinRegLengthParamName
                + "» на "
                + LogicLinRegLengthStep
                + " (максимум "
                + LogicLinRegLengthMax
                + "); значение в таблице и индикаторы — сразу.");
            Hint(
                LogicLinRegLenDecButtonName,
                "Уменьшить «"
                + LogicLinRegLengthParamName
                + "» на "
                + LogicLinRegLengthStep
                + " (минимум "
                + LogicLinRegLengthMin
                + "; ниже — не меняет); значение в таблице и индикаторы — сразу.");
            Hint(
                LogicStrictnessParamName,
                "Строгость отбора 1…5 (по умолчанию 3): 1–2 — больше сделок, 4–5 — меньше. "
                + "В строке логики: Strict(@Strict) — ссылка на этот параметр; Strict(4) — явное значение. "
                + "Пороги Lmin/Smax/Gr/… масштабируются при разборе (текст строки — нейтральный, strict=3). "
                + "Кнопки ±1 — сразу, без закрытия окна параметров.");
            Hint(
                LogicStrictnessIncButtonName,
                "Увеличить «"
                + LogicStrictnessParamName
                + "» на 1 (максимум "
                + LogicStrictnessMax
                + ") — ужесточить пороги в строках логик; сразу обновляет таблицу и график, без «Принять».");
            Hint(
                LogicStrictnessDecButtonName,
                "Уменьшить «"
                + LogicStrictnessParamName
                + "» на 1 (минимум "
                + LogicStrictnessMin
                + ") — смягчить пороги в строках логик; сразу обновляет таблицу и график, без «Принять».");
            string logicSlotHintSuffix =
                "\n\nОдинаковый индикатор с теми же параметрами в разных логиках — один экземпляр на графике. "
                + "Regime=On: вход по Op, выход по Cl. Volume делится поровну между сработавшими логиками на свече.";

            Hint("Логика 1", LogicLineFormatHint + logicSlotHintSuffix.Replace("N", "1"));
            Hint("Логика 2", LogicLineFormatHint + logicSlotHintSuffix.Replace("N", "2"));
            Hint("Логика 3", LogicLineFormatHint + logicSlotHintSuffix.Replace("N", "3"));
            Hint("Логика 4", LogicLineFormatHint + logicSlotHintSuffix.Replace("N", "4"));
            Hint("Логика 5", LogicLineFormatHint + logicSlotHintSuffix.Replace("N", "5"));
            Hint("Логика 6", LogicLineFormatHint + logicSlotHintSuffix.Replace("N", "6"));
            Hint("Логика 7", LogicLineFormatHint + logicSlotHintSuffix.Replace("N", "7"));
            Hint("Логика 8", LogicLineFormatHint + logicSlotHintSuffix.Replace("N", "8"));
            Hint("Логика 9", LogicLineFormatHint + logicSlotHintSuffix.Replace("N", "9"));
            Hint("Логика 10", LogicLineFormatHint + logicSlotHintSuffix.Replace("N", "10"));

            Hint(
                MetaLogicEnabledParamName,
                "Если включено — после накопления окна PnlSMA (см. «Общепортфельный PnlSMA: длина») Volume на входе "
                + "делится между логиками с Op и PnlSMA>0 пропорционально PnlSMA; до готовности — как без металогики (Volume поровну, L1…L10). "
                + "Логики с PnlSMA≤0 не торгуют, кроме случая «Инверсия» (см. ниже). При нехватке Max positions — приоритет по PnlSMA.");
            Hint(
                MetaLogicInversionParamName,
                "Только когда металогика уже действует (PnlSMA готов): разрешить логики с отрицательным PnlSMA — "
                + "Buy↔Sell относительно Side строки; Regime(Entry/OnFlip) по фактической стороне входа. "
                + "Volume по |PnlSMA| вместе с положительными. По умолчанию выкл. — только успешные (PnlSMA>0).");
            Hint(
                MetaLogicEnableButtonName,
                "Устанавливает «" + MetaLogicEnabledParamName + "» = true и сохраняет параметры.");
            Hint(
                PortfolioPnlSmaEnableParamName,
                MetaIndicatorPnlSmaAbbrev
                + ": используется в мета-логике (Volume и Max positions); также пишется в файлы L1…L10 и _MetaAggregate.");
            Hint(
                PortfolioPnlSmaLenParamName,
                "Окно " + MetaIndicatorPnlSmaAbbrev + " для мета-логики и всех портфельных серий.");

            Hint("Общепортфельный stop-loss: включён",
                "Stopper: просадка суммарной equity L1…L10 от ref (lookback свечей). По умолчанию выкл.");
            Hint(
                PortfolioStopLossPercentParamName,
                "Порог SL: equity ≤ ref × (1 − %/100). По умолчанию 0,4. Ref — equity N свечей назад. "
                + "Кнопки ± меняют только этот %, галочку «включён» не трогают; значение применяется сразу.");
            Hint(
                StopperSlPercentIncButtonName,
                "Увеличить «"
                + PortfolioStopLossPercentParamName
                + "» на "
                + StopperSlPercentButtonDelta.ToString(CultureInfo.InvariantCulture)
                + " (макс. "
                + StopperSlPercentMax.ToString(CultureInfo.InvariantCulture)
                + ").");
            Hint(
                StopperSlPercentDecButtonName,
                "Уменьшить «"
                + PortfolioStopLossPercentParamName
                + "» на "
                + StopperSlPercentButtonDelta.ToString(CultureInfo.InvariantCulture)
                + " (мин. "
                + StopperSlPercentMin.ToString(CultureInfo.InvariantCulture)
                + ").");
            Hint("Общепортфельный take-profit: включён",
                "Stopper: рост суммарной equity от ref. По умолчанию выкл.");
            Hint(
                PortfolioTakeProfitPercentParamName,
                "Порог TP: equity ≥ ref × (1 + %/100). По умолчанию 10. "
                + "Кнопки ± меняют только этот %, галочку «включён» не трогают; значение применяется сразу.");
            Hint(
                StopperTpPercentIncButtonName,
                "Увеличить «"
                + PortfolioTakeProfitPercentParamName
                + "» на "
                + StopperTpPercentButtonDelta.ToString(CultureInfo.InvariantCulture)
                + " (макс. "
                + StopperTpPercentMax.ToString(CultureInfo.InvariantCulture)
                + ").");
            Hint(
                StopperTpPercentDecButtonName,
                "Уменьшить «"
                + PortfolioTakeProfitPercentParamName
                + "» на "
                + StopperTpPercentButtonDelta.ToString(CultureInfo.InvariantCulture)
                + " (мин. "
                + StopperTpPercentMin.ToString(CultureInfo.InvariantCulture)
                + ").");
            Hint(
                PortfolioStopLossRublesParamName,
                "Альтернатива %: SL при просадке портфеля ≥ N руб от ref (ref − equity). 0 — только %. "
                + "Срабатывает, если выполнен % или рубли (логика ИЛИ). Портфель уже в рублях на MOEX.");
            Hint(
                PortfolioTakeProfitRublesParamName,
                "Альтернатива %: TP при прибыли ≥ N руб от ref (equity − ref). 0 — только %. "
                + "Срабатывает, если выполнен % или рубли (логика ИЛИ).");
            Hint(StopperPostTriggerAfterStopLossParamName,
                "После общепортфельного SL — закрыть все позиции.\n"
                + "Отключено — только закрытие, Regime не меняется.\n"
                + "Останавливать полностью — Regime=Off.\n"
                + StopperPostTriggerPauseAndResume
                + " — реальные заявки не выставляются, сигналы считаются в портфелях L1…L10; "
                + "возобновление, когда equity L1…L10 в фейк-торговле снова ≥ текущей суммы на момент срабатывания (+0,1%).");
            Hint(StopperPostTriggerAfterTakeProfitParamName,
                "После общепортфельного TP — то же, что для stop-loss (три режима).");
            Hint("Предыдущая сумма портфеля (техн.)",
                "База SL/TP или lookback; обновляется в начале/конце обработки свечи, кнопкой и после Stopper.");
            Hint("Текущая сумма портфеля (техн.)",
                "Equity L1…L10; перезаписывается в начале и после торговли на каждой закрытой свече вкладки.");
            Hint("Предыдущая сумма портфеля: lookback (свечей)",
                "Если база = 0 — ref из N свечей назад (по умолчанию 5). Кнопка SL/TP или срабатывание фиксируют базу. "
                + "При Min1…Min15 — N = свечи монитора (страница 2), не страницы 1.");
            Hint(
                StopperMonitorTimeFrameParamName,
                "«Как основной TF» — Stopper на «общей свече» страницы 1; вкладка «2» удаляется. "
                + "Min1…Min15 — страница 2 скринера с бумагой-монитором; SL/TP по её CandleFinished.");
            Hint(
                StopperMonitorSecurityParamName,
                "Бумага на странице 2 (по умолчанию SBER). Нужна только как «часы» для частой проверки портфеля; "
                + "PnL берётся с реального портфеля / L1…L10, не с цены этой бумаги.");
            Hint(UpdateStopperPortfolioBaselineButtonName,
                "Записывает текущий портфель (тестер/лайв) или equity L1…L10 в «Предыдущая сумма портфеля» и фиксирует базу SL/TP.");
            Hint(
                StopperEodFlatSellParamName,
                "«Не продавать» — без действия. Иначе на первой «общей свече» скринера после выбранного времени "
                + "(по часам, 00:00…23:00) один раз в календарный день закрываются все позиции робота "
                + "(тестер, лайв, эмулятор EmulatorIsOn, виртуальные позиции Stopper «пауза»). "
                + "После этой продажи до следующего календарного дня новые входы запрещены; выходы по Cl/SL/TP работают. "
                + "Regime не меняется. Не зависит от общепортфельного SL/TP.");
            Hint(
                PortfolioPeakDrawdownEnabledParamName,
                "Скользящий стоп по сумме equity L1…L10 (как в отчёте), не по депозиту тестера: падение на % от пика — "
                + "закрыть все позиции (без паузы новых входов; пауза — только «Пауза после значительного пика»). "
                + "На графике одной логики маркер может не совпадать с её локальным пиком, "
                + "если другие логики компенсируют. Пик обновляется при новом максимуме суммы.");
            Hint(
                PortfolioPeakDrawdownPercentParamName,
                "Просадка от пика в % для срабатывания (по умолчанию 1). Порог: equity ≤ пик × (1 − %/100).");
            Hint(
                PortfolioPeakValueParamName,
                "Техн.: зафиксированный максимум equity для стопа «Просадка от пика»; обновляется на новых максимумах.");
            Hint(
                SignificantPeakPauseEnabledParamName,
                "По суммарной equity L1…L10: после локального пика, если рост от впадины до пика "
                + "даёт ≥ порога % годовых — временно запретить новые входы (выходы по Cl/SL/TP работают). "
                + "«Просадка от пика» только закрывает позиции и не ставит паузу входов. "
                + "Длительность паузы = (время пика − время начала пика) × множитель.");
            Hint(
                SignificantPeakAnnualPercentParamName,
                "Пик «значительный», если годовая доходность от впадины до максимума ≥ этого % (по умолчанию 100).");
            Hint(
                SignificantPeakPauseWidthMultiplierParamName,
                "Сколько раз умножить ширину пика (интервал впадина→пик) для длительности паузы входов (по умолчанию 10).");
            Hint("Общепортфельный SMA: включить",
                "Справочно: SMA по портфельной серии equity; значения — в файлах портфелей и _MetaAggregate.txt.");
            Hint("Общепортфельный SMA: длина", "Период SMA по всем портфельным сериям (L1…L10 и общая).");
            Hint("Общепортфельный SMA: источник", "Источник цены для SMA (для портфельной серии — зарезервировано под расширение).");
            Hint("Общепортфельный Stoch: включить",
                "Справочно: Stochastic по портфельной серии; выкл. — не считается.");
            Hint("Общепортфельный Stoch: P1", "Период %K (Stochastic по портфелю).");
            Hint("Общепортфельный Stoch: P2", "Сглаживание %K.");
            Hint("Общепортфельный Stoch: P3", "Сглаживание %D.");
            Hint("Общепортфельный Stoch: long min", "Порог %K для бычьего фильтра (зарезервировано).");
            Hint("Общепортфельный Stoch: short max", "Порог %K для медвежьего фильтра (зарезервировано).");
            Hint("Общепортфельный ATR: включить",
                "Справочно: ATR по портфельной серии (волатильность equity); выкл. — не считается.");
            Hint("Общепортфельный ATR: длина", "Период ATR по портфельной серии.");
            Hint("Общепортфельный ATR: min grow % vs lookback",
                "Мин. рост ATR в % относительно значения lookback свечей назад (как фильтр GrOk).");
            Hint("Общепортфельный ATR: grow lookback (candles)", "Lookback для фильтра роста ATR портфеля.");
            Hint("Общепортфельный LinReg: включить",
                "Справочно: канал линейной регрессии по портфельной серии; выкл. — не считается.");
            Hint("Общепортфельный LinReg: длина", "Длина окна LinReg по equity портфелей.");
            Hint("Общепортфельный LinReg: deviation", "Ширина канала LinReg (deviation).");
            Hint("Общепортфельный MACD: включить",
                "Справочно: MACD по портфельной серии; выкл. — не считается.");
            Hint("Общепортфельный MACD: fast", "Быстрая EMA MACD по портфелю.");
            Hint("Общепортфельный MACD: slow", "Медленная EMA MACD по портфелю.");
            Hint("Общепортфельный MACD: signal", "Сигнальная линия MACD по портфелю.");
            Hint(
                "Предыдущий индикатор. Расчёт объёма позиций",
                "Зарезервировано: связь с предыдущим мета-индикатором при расчёте объёма (пока без логики).");

            Hint(
                "Префиксы корня тикера (T-Инвестиции; ROSN, LKOH; CNY — также CR, CNYRUBF)",
                "Корни тикеров FORTS через запятую (Si, CNY, BR…). CNY также ищет CR и CNYRUBF. "
                + "Кнопка «Обновить фьючерсы» пересобирает список бумаг скринера.");
            Hint("Установить префиксы фьючерсов по умолчанию", "Заполнить строку префиксов базовым списком (~30 корней). Подбор бумаг не выполняется.");
            Hint(
                "Установить расширенный список префиксов фьючерсов по умолчанию",
                "Заполнить строку префиксов расширенным списком (~100 корней FORTS). Подбор бумаг не выполняется.");
            Hint("Обновить фьючерсы", "Очистить скринер и добавить фьючерсы MOEX по префиксам (T-Инвестиции или Tester).");
            Hint(
                "Тикеры акций (через запятую; T-Инвестиции, точное совпадение с Ticker)",
                "Точные тикеры MOEX акций (SBER, GAZP…). «Обновить акции» пересобирает вкладки скринера.");
            Hint("Установить тикеры акций по умолчанию", "Заполнить строку типовым списком ликвидных акций MOEX. Подбор бумаг не выполняется.");
            Hint("Обновить акции", "Очистить скринер и добавить акции MOEX по списку тикеров (T-Инвестиции или Tester).");

            Hint(
                HtmlReportEnableParamName,
                "Engine\\{имя}_Report.html — графики и таблицы opens/closes, equity, режим (тестер / лайв / фейк). "
                + "Пишется в тестере, лайве и при включённом эмуляторе OsEngine.");
            Hint(
                HtmlReportIntervalParamName,
                "Минимум "
                + HtmlReportMinIntervalSeconds
                + " с между перезаписями HTML (не на каждой сделке). Принудительно — при Stopper и «Остановить робота».");
            Hint(
                HtmlReportOpenButtonName,
                "Открыть Engine\\{имя}_Report.html в программе по умолчанию.");
            Hint(
                OpenHtmlReportMainTabButtonName,
                "Открыть Engine\\{имя}_Report.html (тестер / лайв / фейк). Перед открытием файл обновляется.");

            RegisterMetaLogicsTabVisualSeparators();

            if (!_parameterHintsRegistrationLogged)
            {
                _parameterHintsRegistrationLogged = true;
                SendNewLogMessage(
                    NameStrategyUniq
                    + " | Подсказки параметров зарегистрированы (наведите курсор на строку в окне параметров).",
                    LogMessageType.System);
            }
        }

        /// <summary>
        /// Разделитель на вкладке «Металогики»: активный блок (мета-логика + PnlSMA) / справочные индикаторы.
        /// </summary>
        private void RegisterMetaLogicsTabVisualSeparators()
        {
            if (ParamGuiSettings == null)
            {
                return;
            }

            ParamGuiSettings.SetBorderUnderParameter(
                MetaLogicsActiveBlockSeparatorUnderParamName,
                System.Drawing.Color.LightGray,
                2);
        }

        /// <summary>Возвращает типовое имя класса робота для OsEngine («MultiLogic»).</summary>
        /// <returns>Имя типа стратегии.</returns>
        public override string GetNameStrategyType()
        {
            return "MultiLogic";
        }

        /// <summary>Отдельное окно настроек не используется.</summary>
        public override void ShowIndividualSettingsDialog()
        {
        }

        /// <summary>Обработчик кнопки «Остановить робота и продать всё».</summary>
        private void StopRobotAndSellAllButton_UserClickOnButtonEvent()
        {
            try
            {
                ExecuteStopRobotAndSellAll();
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        /// <summary>Закрывает все позиции робота на скринере и переводит Regime в Off.</summary>
        private void ExecuteStopRobotAndSellAll()
        {
            CloseAllBotPositions(SignalStopRobotAndSellAll);
            ClearStopperVirtualTradingState();
            TrySetRegimeOff("кнопка «Остановить робота и продать всё»");
            MaybeSaveLogicPortfolios(force: true);
            MaybeWriteHtmlReport(force: true);
            SaveParametersWithoutLogicIndicatorResync();
            RequestParameterGuiRepaintOnce();

            string msg = NameStrategyUniq
                + ": «Остановить робота и продать всё» — закрытие всех позиций по рынку, Regime=Off.";
            SendNewLogMessage(msg, LogMessageType.System);
            SendNewLogMessage(msg, LogMessageType.User);
        }

        /// <summary>
        /// Обходит все вкладки скринера и закрывает открытые позиции, принадлежащие этому роботу.
        /// </summary>
        /// <param name="closeSignal">SignalTypeClose для заявок закрытия.</param>
        private void CloseAllBotPositions(string closeSignal = null)
        {
            if (_screenerTab?.Tabs == null)
            {
                return;
            }

            string signal = string.IsNullOrEmpty(closeSignal) ? SignalStopRobotAndSellAll : closeSignal;
            string botType = GetNameStrategyType();
            int closeAttempts = 0;

            for (int i = 0; i < _screenerTab.Tabs.Count; i++)
            {
                BotTabSimple tab = _screenerTab.Tabs[i];
                if (tab?.PositionsOpenAll == null || tab.PositionsOpenAll.Count == 0)
                {
                    continue;
                }

                for (int p = 0; p < tab.PositionsOpenAll.Count; p++)
                {
                    Position pos = tab.PositionsOpenAll[p];
                    if (pos == null || pos.State != PositionStateType.Open || pos.OpenVolume == 0m)
                    {
                        continue;
                    }

                    if (!string.IsNullOrEmpty(pos.NameBotClass)
                        && !string.Equals(pos.NameBotClass, botType, StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }

                    if (TryClosePositionAtMarket(tab, pos, signal))
                    {
                        closeAttempts++;
                    }
                }
            }

            SendNewLogMessage(
                NameStrategyUniq + ": экстренное закрытие — позиций: " + closeAttempts + ".",
                LogMessageType.System);
        }

        /// <summary>
        /// Закрывает одну позицию по рынку или лимитом (если рынок недоступен).
        /// </summary>
        /// <param name="tab">Вкладка инструмента.</param>
        /// <param name="pos">Открытая позиция.</param>
        /// <returns>true, если заявка на закрытие отправлена.</returns>
        private bool TryClosePositionAtMarket(BotTabSimple tab, Position pos, string closeSignal = null)
        {
            if (tab == null || pos == null || pos.OpenVolume <= 0m)
            {
                return false;
            }

            string signal = string.IsNullOrEmpty(closeSignal) ? SignalStopRobotAndSellAll : closeSignal;
            pos.SignalTypeClose = signal;
            pos.ProfitOrderIsActive = false;
            pos.StopOrderIsActive = false;

            decimal volume = pos.OpenVolume;

            if (tab.Connector != null
                && StartProgram == StartProgram.IsOsTrader
                && (!tab.Connector.IsConnected || !tab.Connector.IsReadyToTrade))
            {
                SendNewLogMessage(
                    NameStrategyUniq + ": закрытие #" + pos.Number + " — нет подключения или торговля недоступна.",
                    LogMessageType.Error);
                return false;
            }

            if (tab.Connector?.MarketOrdersIsSupport == true)
            {
                tab.CloseAtMarket(pos, volume, signal);
                return true;
            }

            decimal price = pos.Direction == Side.Buy ? tab.PriceBestBid : tab.PriceBestAsk;
            if (price <= 0m)
            {
                return false;
            }

            tab.CloseAtLimit(pos, price, volume, signal);
            return true;
        }

        #region Stopper: общепортфельный SL/TP

        private sealed class StopperEquitySnapshot
        {
            public DateTime CandleTime;
            public decimal Equity;
        }

        private static string[] BuildStopperEodFlatSellChoices()
        {
            var choices = new string[25];
            choices[0] = StopperEodFlatSellDisabled;
            for (int hour = 0; hour < 24; hour++)
            {
                choices[hour + 1] = hour.ToString("00", CultureInfo.InvariantCulture) + ":00";
            }

            return choices;
        }

        private void CreateStopperParameters()
        {
            _usePortfolioStopLoss = CreateParameter(
                "Общепортфельный stop-loss: включён",
                false,
                StopperTabName);
            _portfolioStopLossPercent = CreateParameter(
                PortfolioStopLossPercentParamName,
                StopperSlPercentDefault,
                StopperSlPercentMin,
                StopperSlPercentMax,
                StopperSlPercentUiStep,
                StopperTabName);
            _stopperSlPercentIncButton = CreateParameterButton(StopperSlPercentIncButtonName, StopperTabName);
            _stopperSlPercentIncButton.UserClickOnButtonEvent += StopperSlPercentIncButton_UserClickOnButtonEvent;
            _stopperSlPercentDecButton = CreateParameterButton(StopperSlPercentDecButtonName, StopperTabName);
            _stopperSlPercentDecButton.UserClickOnButtonEvent += StopperSlPercentDecButton_UserClickOnButtonEvent;
            _portfolioStopLossRubles = CreateParameter(
                PortfolioStopLossRublesParamName,
                0m,
                0m,
                1_000_000_000_000m,
                0,
                StopperTabName);
            _usePortfolioTakeProfit = CreateParameter(
                "Общепортфельный take-profit: включён",
                false,
                StopperTabName);
            _portfolioTakeProfitPercent = CreateParameter(
                PortfolioTakeProfitPercentParamName,
                StopperTpPercentDefault,
                StopperTpPercentMin,
                StopperTpPercentMax,
                StopperTpPercentUiStep,
                StopperTabName);
            _stopperTpPercentIncButton = CreateParameterButton(StopperTpPercentIncButtonName, StopperTabName);
            _stopperTpPercentIncButton.UserClickOnButtonEvent += StopperTpPercentIncButton_UserClickOnButtonEvent;
            _stopperTpPercentDecButton = CreateParameterButton(StopperTpPercentDecButtonName, StopperTabName);
            _stopperTpPercentDecButton.UserClickOnButtonEvent += StopperTpPercentDecButton_UserClickOnButtonEvent;
            _portfolioTakeProfitRubles = CreateParameter(
                PortfolioTakeProfitRublesParamName,
                0m,
                0m,
                1_000_000_000_000m,
                0,
                StopperTabName);
            _usePortfolioPeakDrawdownStop = CreateParameter(
                PortfolioPeakDrawdownEnabledParamName,
                false,
                StopperTabName);
            _portfolioPeakDrawdownPercent = CreateParameter(
                PortfolioPeakDrawdownPercentParamName,
                PortfolioPeakDrawdownPercentDefault,
                0.1m,
                50m,
                0.1m,
                StopperTabName);
            _portfolioPeakValue = CreateParameter(
                PortfolioPeakValueParamName,
                0m,
                0m,
                1_000_000_000_000m,
                2,
                StopperTabName);
            _useSignificantPeakTradingPause = CreateParameter(
                SignificantPeakPauseEnabledParamName,
                false,
                StopperTabName);
            _significantPeakAnnualPercentMin = CreateParameter(
                SignificantPeakAnnualPercentParamName,
                SignificantPeakAnnualPercentDefault,
                1m,
                10_000m,
                1m,
                StopperTabName);
            _significantPeakPauseWidthMultiplier = CreateParameter(
                SignificantPeakPauseWidthMultiplierParamName,
                SignificantPeakPauseWidthMultiplierDefault,
                0.1m,
                100m,
                0.1m,
                StopperTabName);
            _stopperPostTriggerAfterStopLoss = CreateParameter(
                StopperPostTriggerAfterStopLossParamName,
                StopperPostTriggerDisabled,
                StopperPostTriggerChoices,
                StopperTabName);
            _stopperPostTriggerAfterTakeProfit = CreateParameter(
                StopperPostTriggerAfterTakeProfitParamName,
                StopperPostTriggerDisabled,
                StopperPostTriggerChoices,
                StopperTabName);
            _portfolioStopperReferenceEquity = CreateParameter(
                "Предыдущая сумма портфеля (техн.)",
                0m,
                -1_000_000_000_000m,
                1_000_000_000_000m,
                2,
                StopperTabName);
            _portfolioStopperCurrentEquity = CreateParameter(
                "Текущая сумма портфеля (техн.)",
                0m,
                -1_000_000_000_000m,
                1_000_000_000_000m,
                2,
                StopperTabName);
            _portfolioStopperLookbackCandles = CreateParameter(
                "Предыдущая сумма портфеля: lookback (свечей)",
                5,
                1,
                5000,
                1,
                StopperTabName);
            _stopperMonitorTimeFrame = CreateParameter(
                StopperMonitorTimeFrameParamName,
                StopperMonitorTimeFrameSameAsMain,
                StopperMonitorTimeFrameChoices,
                StopperTabName);
            _stopperMonitorSecurity = CreateParameter(
                StopperMonitorSecurityParamName,
                "SBER",
                StopperTabName);
            _stopperEodFlatSellTime = CreateParameter(
                StopperEodFlatSellParamName,
                StopperEodFlatSellDisabled,
                BuildStopperEodFlatSellChoices(),
                StopperTabName);
            _updateStopperPortfolioBaselineButton = CreateParameterButton(
                UpdateStopperPortfolioBaselineButtonName,
                StopperTabName);
            _updateStopperPortfolioBaselineButton.UserClickOnButtonEvent +=
                UpdateStopperPortfolioBaselineButton_UserClickOnButtonEvent;
        }

        private void StopperSlPercentIncButton_UserClickOnButtonEvent()
        {
            AdjustStopperPercentParameter(
                PortfolioStopLossPercentParamName,
                StopperSlPercentButtonDelta,
                StopperSlPercentMin,
                StopperSlPercentMax,
                StopperSlPercentUiStep);
        }

        private void StopperSlPercentDecButton_UserClickOnButtonEvent()
        {
            AdjustStopperPercentParameter(
                PortfolioStopLossPercentParamName,
                -StopperSlPercentButtonDelta,
                StopperSlPercentMin,
                StopperSlPercentMax,
                StopperSlPercentUiStep);
        }

        private void StopperTpPercentIncButton_UserClickOnButtonEvent()
        {
            AdjustStopperPercentParameter(
                PortfolioTakeProfitPercentParamName,
                StopperTpPercentButtonDelta,
                StopperTpPercentMin,
                StopperTpPercentMax,
                StopperTpPercentUiStep);
        }

        private void StopperTpPercentDecButton_UserClickOnButtonEvent()
        {
            AdjustStopperPercentParameter(
                PortfolioTakeProfitPercentParamName,
                -StopperTpPercentButtonDelta,
                StopperTpPercentMin,
                StopperTpPercentMax,
                StopperTpPercentUiStep);
        }

        private StrategyParameterDecimal ResolvePortfolioStopLossPercentParameter()
        {
            IIStrategyParameter fromList = Parameters?.Find(p => p.Name == PortfolioStopLossPercentParamName);
            return (fromList as StrategyParameterDecimal) ?? _portfolioStopLossPercent;
        }

        private StrategyParameterDecimal ResolvePortfolioTakeProfitPercentParameter()
        {
            IIStrategyParameter fromList = Parameters?.Find(p => p.Name == PortfolioTakeProfitPercentParamName);
            return (fromList as StrategyParameterDecimal) ?? _portfolioTakeProfitPercent;
        }

        private decimal ReadPortfolioStopLossPercentCurrent()
        {
            if (TryReadDecimalParameterFromOpenParameterGui(PortfolioStopLossPercentParamName, out decimal fromGui))
            {
                return fromGui;
            }

            return ResolvePortfolioStopLossPercentParameter()?.ValueDecimal ?? StopperSlPercentDefault;
        }

        private decimal ReadPortfolioTakeProfitPercentCurrent()
        {
            if (TryReadDecimalParameterFromOpenParameterGui(PortfolioTakeProfitPercentParamName, out decimal fromGui))
            {
                return fromGui;
            }

            return ResolvePortfolioTakeProfitPercentParameter()?.ValueDecimal ?? StopperTpPercentDefault;
        }

        private static decimal ClampAndRoundStopperPercent(decimal value, decimal min, decimal max, decimal step)
        {
            value = Math.Max(min, Math.Min(max, value));
            if (step <= 0m)
            {
                return value;
            }

            return Math.Round(value / step, MidpointRounding.AwayFromZero) * step;
        }

        private void AdjustStopperPercentParameter(
            string parameterName,
            decimal delta,
            decimal min,
            decimal max,
            decimal step)
        {
            try
            {
                ApplyPrefixesFromOpenParameterDialog();
                StrategyParameterDecimal param = string.Equals(
                    parameterName,
                    PortfolioStopLossPercentParamName,
                    StringComparison.Ordinal)
                    ? ResolvePortfolioStopLossPercentParameter()
                    : ResolvePortfolioTakeProfitPercentParameter();
                if (param == null)
                {
                    return;
                }

                decimal current = string.Equals(parameterName, PortfolioStopLossPercentParamName, StringComparison.Ordinal)
                    ? ReadPortfolioStopLossPercentCurrent()
                    : ReadPortfolioTakeProfitPercentCurrent();
                decimal next = ClampAndRoundStopperPercent(current + delta, min, max, step);
                if (next == current)
                {
                    SendNewLogMessage(
                        NameStrategyUniq
                        + " | "
                        + parameterName
                        + ": "
                        + current.ToString(CultureInfo.InvariantCulture)
                        + " — изменение "
                        + (delta >= 0m ? "+" : "")
                        + delta.ToString(CultureInfo.InvariantCulture)
                        + " не выполнено (граница "
                        + min.ToString(CultureInfo.InvariantCulture)
                        + "…"
                        + max.ToString(CultureInfo.InvariantCulture)
                        + ").",
                        LogMessageType.User);
                    return;
                }

                ApplyStopperPercentParameterValue(param, parameterName, next);
                SendNewLogMessage(
                    NameStrategyUniq
                    + " | "
                    + parameterName
                    + ": "
                    + current.ToString(CultureInfo.InvariantCulture)
                    + " → "
                    + next.ToString(CultureInfo.InvariantCulture)
                    + ".",
                    LogMessageType.User);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        private void ApplyStopperPercentParameterValue(
            StrategyParameterDecimal param,
            string parameterName,
            decimal next)
        {
            SetStrategyParameterDecimalSilent(param, next);
            TryApplyDecimalParameterToOpenParameterGui(parameterName, next);
            SaveParametersWithoutLogicIndicatorResync();
            RequestParameterGuiRepaintOnce();
        }

        private void UpdateStopperPortfolioBaselineButton_UserClickOnButtonEvent()
        {
            try
            {
                TryApplyUpdateStopperPortfolioBaseline(logButtonPress: true);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        /// <summary>Сумма для кнопки Stopper: тестер StartPortfolio/ValueCurrent, иначе monitored equity.</summary>
        private decimal? TryGetPortfolioValueForStopperBaselineFill(BotTabSimple tab)
        {
            return TryGetRealPortfolioAmountForReference(tab);
        }

        /// <summary>
        /// Equity для Stopper / просадки от пика: сумма L1…L10 (как на графиках логик в отчёте),
        /// не депозит тестера — иначе пик ~10 000 не связан с кривой логики.
        /// </summary>
        private decimal TryGetStopperMonitoredEquity(BotTabSimple tab)
        {
            if (ShouldUseLogicPortfolioEquityForStopper())
            {
                return GetCombinedLogicPortfolioEquity();
            }

            decimal? monitored = TryGetPortfolioValueForStopperBaselineFill(tab);
            if (monitored.HasValue && monitored.Value > 0m)
            {
                return monitored.Value;
            }

            return GetCombinedLogicPortfolioEquity();
        }

        private bool ShouldUseLogicPortfolioEquityForStopper()
        {
            return IsPortfolioStopperActive()
                || IsStopperVirtualTradingActive()
                || (_useSignificantPeakTradingPause?.ValueBool ?? false)
                || IsStopperEodFlatSellConfigured();
        }

        /// <summary>
        /// Фиксирует текущий портфель (тестер/лайв) или equity L1…L10 как базу SL/TP.
        /// </summary>
        private bool TryApplyUpdateStopperPortfolioBaseline(bool logButtonPress)
        {
            if (logButtonPress)
            {
                SendNewLogMessage(
                    NameStrategyUniq + " | Stopper: нажата «" + UpdateStopperPortfolioBaselineButtonName + "»…",
                    LogMessageType.User);
            }

            BotTabSimple tab = TryGetPortfolioMonitoringReferenceTab();
            decimal? monitored = TryGetPortfolioValueForStopperBaselineFill(tab);
            if (!monitored.HasValue || monitored.Value <= 0m)
            {
                RecalculateAllLogicPortfolioUnrealized();
                decimal logicEquity = GetCombinedLogicPortfolioEquity();
                if (logicEquity > 0m)
                {
                    monitored = logicEquity;
                }
            }

            if (!monitored.HasValue || monitored.Value <= 0m)
            {
                string modeHint = ShouldReadPortfolioFromTesterServer(tab)
                    ? "тестер (Portfolio / StartPortfolio > 0)"
                    : (_screenerTab?.EmulatorIsOn == true ? "эмулятор" : "лайв");
                SendNewLogMessage(
                    NameStrategyUniq
                    + " | Stopper: «"
                    + UpdateStopperPortfolioBaselineButtonName
                    + "» — сумма портфеля не получена ("
                    + modeHint
                    + ").",
                    LogMessageType.Error);
                SaveParametersWithoutLogicIndicatorResync();
                RequestParameterGuiRepaintOnce();
                return false;
            }

            decimal currentEquity = monitored.Value;
            decimal baselineToSet = currentEquity;
            decimal oldReference = _portfolioStopperReferenceEquity.ValueDecimal;

            if (_usePortfolioTakeProfit.ValueBool
                && oldReference > 0m
                && currentEquity > 0m
                && TryEvaluatePortfolioTakeProfitTrigger(
                    oldReference,
                    currentEquity,
                    out _,
                    out _))
            {
                baselineToSet = currentEquity;
                SendNewLogMessage(
                    NameStrategyUniq
                    + " | Stopper: база поднята до текущего портфеля "
                    + baselineToSet.ToString(CultureInfo.InvariantCulture)
                    + " — иначе take-profit сработал бы сразу.",
                    LogMessageType.User);
            }

            DateTime candleTime = GetStopperReferenceCandleTime();
            ApplyStopperReferenceBaseline(baselineToSet, candleTime, saveParameters: false);
            SetPortfolioPeakValue(baselineToSet);
            SaveParametersWithoutLogicIndicatorResync();
            RequestParameterGuiRepaintOnce();

            string msg = NameStrategyUniq
                + " | Stopper: «"
                + UpdateStopperPortfolioBaselineButtonName
                + "» — база (предыдущая сумма) "
                + baselineToSet.ToString(CultureInfo.InvariantCulture)
                + ", текущая "
                + currentEquity.ToString(CultureInfo.InvariantCulture)
                + ", пик "
                + (_portfolioPeakValue?.ValueDecimal ?? 0m).ToString(CultureInfo.InvariantCulture)
                + ".";
            SendNewLogMessage(msg, LogMessageType.System);
            SendNewLogMessage(msg, LogMessageType.User);
            return true;
        }

        private void RecalculateAllLogicPortfolioUnrealized()
        {
            for (int slot = 1; slot <= LogicSlotCount; slot++)
            {
                _logicPortfolios[slot].Unrealized = 0m;
            }

            string botType = GetNameStrategyType();
            if (_screenerTab?.Tabs == null)
            {
                return;
            }

            for (int t = 0; t < _screenerTab.Tabs.Count; t++)
            {
                BotTabSimple tab = _screenerTab.Tabs[t];
                if (tab?.PositionsOpenAll == null)
                {
                    continue;
                }

                for (int i = 0; i < tab.PositionsOpenAll.Count; i++)
                {
                    Position pos = tab.PositionsOpenAll[i];
                    if (!IsOurMultiLogicOpenPosition(pos, botType)
                        || !TryParseLogicSlotFromSignal(pos.SignalTypeOpen, out int posSlot))
                    {
                        continue;
                    }

                    _logicPortfolios[posSlot].Unrealized += CalculateLogicPortfolioUnrealizedAbs(tab, pos);
                }
            }

            if (IsStopperVirtualTradingActive())
            {
                foreach (KeyValuePair<string, StopperVirtualPosition> kvp in _stopperVirtualPositions)
                {
                    StopperVirtualPosition virtualPosition = kvp.Value;
                    if (virtualPosition == null
                        || virtualPosition.LogicSlot < 1
                        || virtualPosition.LogicSlot > LogicSlotCount)
                    {
                        continue;
                    }

                    BotTabSimple virtualTab = TryFindScreenerTabByPortfolioKey(virtualPosition.TabKey);
                    if (virtualTab == null)
                    {
                        continue;
                    }

                    _logicPortfolios[virtualPosition.LogicSlot].Unrealized
                        += CalculateStopperVirtualUnrealizedAbs(virtualTab, virtualPosition);
                }
            }
        }

        private DateTime GetStopperReferenceCandleTime()
        {
            DateTime candleTime = DateTime.MinValue;
            for (int slot = 1; slot <= LogicSlotCount; slot++)
            {
                if (_logicPortfolios[slot].LastCandleTime > candleTime)
                {
                    candleTime = _logicPortfolios[slot].LastCandleTime;
                }
            }

            return candleTime != DateTime.MinValue ? candleTime : DateTime.UtcNow;
        }

        private void ApplyStopperReferenceBaseline(decimal baseline, DateTime candleTime, bool saveParameters)
        {
            _stopperReferenceBaselineLocked = true;
            SetStrategyParameterDecimalSilent(_portfolioStopperReferenceEquity, baseline);

            BotTabSimple tab = TryGetPortfolioMonitoringReferenceTab();
            decimal currentEquity = TryGetStopperMonitoredEquity(tab);
            SetStrategyParameterDecimalSilent(_portfolioStopperCurrentEquity, currentEquity);
            ResetStopperEquityHistory(currentEquity, candleTime);

            if (saveParameters)
            {
                SaveParametersWithoutLogicIndicatorResync();
            }
        }

        private void ResetStopperEquityHistory(decimal equity, DateTime candleTime)
        {
            _stopperEquityHistory.Clear();
            _stopperEquityHistory.Add(new StopperEquitySnapshot
            {
                CandleTime = candleTime,
                Equity = equity
            });
        }

        private bool TryResolveStopperReferenceEquity(out decimal referenceEquity)
        {
            if (_stopperReferenceBaselineLocked)
            {
                referenceEquity = _portfolioStopperReferenceEquity.ValueDecimal;
                return true;
            }

            int lookback = Math.Max(1, _portfolioStopperLookbackCandles.ValueInt);
            if (_stopperEquityHistory.Count <= lookback)
            {
                referenceEquity = 0m;
                return false;
            }

            referenceEquity = _stopperEquityHistory[_stopperEquityHistory.Count - 1 - lookback].Equity;
            return true;
        }

        private void SetPortfolioPeakValue(decimal value)
        {
            if (_portfolioPeakValue == null)
            {
                return;
            }

            if (value < 0m)
            {
                value = 0m;
            }

            if (_portfolioPeakValue.ValueDecimal == value)
            {
                return;
            }

            SetStrategyParameterDecimalSilent(_portfolioPeakValue, value);
        }

        private void UpdatePortfolioPeakTracking(decimal currentEquity)
        {
            if (_usePortfolioPeakDrawdownStop == null || !_usePortfolioPeakDrawdownStop.ValueBool)
            {
                return;
            }

            decimal peak = _portfolioPeakValue?.ValueDecimal ?? 0m;
            if (peak > 0m && IsStaleTesterPeakVersusLogicEquity(peak, currentEquity))
            {
                peak = 0m;
                SetPortfolioPeakValue(0m);
            }

            if (peak <= 0m || currentEquity > peak)
            {
                SetPortfolioPeakValue(Math.Max(0m, currentEquity));
            }
        }

        /// <summary>Старый «Пик портфеля» от депозита тестера (~10k) не совместим с equity L1…L10.</summary>
        private static bool IsStaleTesterPeakVersusLogicEquity(decimal peak, decimal logicEquity)
        {
            if (peak < 1000m)
            {
                return false;
            }

            if (logicEquity <= 0m)
            {
                return true;
            }

            return peak > logicEquity * 3m;
        }

        /// <summary>
        /// Обновляет историю equity и проверяет просадку от пика, общепортфельный SL/TP.
        /// </summary>
        /// <returns>true, если сработала защита (закрыты позиции).</returns>
        private bool TryManagePortfolioStopperProtection(BotTabSimple tab, DateTime candleTime)
        {
            decimal currentEquity = TryGetStopperMonitoredEquity(tab);
            bool peakDrawdownEnabled = _usePortfolioPeakDrawdownStop?.ValueBool ?? false;
            bool slTpEnabled = _usePortfolioStopLoss.ValueBool || _usePortfolioTakeProfit.ValueBool;

            if (!peakDrawdownEnabled && !slTpEnabled)
            {
                return false;
            }

            if (peakDrawdownEnabled)
            {
                UpdatePortfolioPeakTracking(currentEquity);
            }

            if (!peakDrawdownEnabled && currentEquity <= 0m)
            {
                return false;
            }

            if (candleTime == _stopperLastProtectionCandleTime)
            {
                return false;
            }

            if (peakDrawdownEnabled
                && TryEvaluatePortfolioPeakDrawdownTrigger(currentEquity, out decimal peak, out decimal floor))
            {
                return ExecutePortfolioPeakDrawdownTrigger(tab, candleTime, peak, currentEquity, floor);
            }

            if (!slTpEnabled)
            {
                return false;
            }

            if (currentEquity <= 0m)
            {
                return false;
            }

            if (!TryResolveStopperReferenceEquity(out decimal referenceEquity))
            {
                return false;
            }

            if (referenceEquity <= 0m)
            {
                return false;
            }

            if (_usePortfolioStopLoss.ValueBool
                && TryEvaluatePortfolioStopLossTrigger(
                    referenceEquity,
                    currentEquity,
                    out decimal slTriggerLevel,
                    out string slThresholdLabel))
            {
                return ExecutePortfolioStopperTrigger(
                    tab,
                    candleTime,
                    isTakeProfit: false,
                    referenceEquity,
                    currentEquity,
                    ReadPortfolioStopLossPercentCurrent(),
                    _portfolioStopLossRubles.ValueDecimal,
                    slTriggerLevel,
                    slThresholdLabel);
            }

            if (_usePortfolioTakeProfit.ValueBool
                && TryEvaluatePortfolioTakeProfitTrigger(
                    referenceEquity,
                    currentEquity,
                    out decimal tpTriggerLevel,
                    out string tpThresholdLabel))
            {
                return ExecutePortfolioStopperTrigger(
                    tab,
                    candleTime,
                    isTakeProfit: true,
                    referenceEquity,
                    currentEquity,
                    ReadPortfolioTakeProfitPercentCurrent(),
                    _portfolioTakeProfitRubles.ValueDecimal,
                    tpTriggerLevel,
                    tpThresholdLabel);
            }

            return false;
        }

        private bool TryEvaluatePortfolioPeakDrawdownTrigger(
            decimal currentEquity,
            out decimal peak,
            out decimal triggerLevel)
        {
            peak = 0m;
            triggerLevel = 0m;
            decimal drawdownPercent = _portfolioPeakDrawdownPercent?.ValueDecimal ?? 0m;
            if (drawdownPercent <= 0m)
            {
                return false;
            }

            peak = _portfolioPeakValue?.ValueDecimal ?? 0m;
            if (peak <= 0m)
            {
                return false;
            }

            triggerLevel = peak * (1m - drawdownPercent / 100m);
            return currentEquity <= triggerLevel;
        }

        private bool ExecutePortfolioPeakDrawdownTrigger(
            BotTabSimple tab,
            DateTime candleTime,
            decimal peak,
            decimal currentEquity,
            decimal triggerLevel)
        {
            _stopperLastProtectionCandleTime = candleTime;
            decimal drawdownPercent = _portfolioPeakDrawdownPercent?.ValueDecimal ?? PortfolioPeakDrawdownPercentDefault;

            CloseAllBotPositions(SignalPortfolioStopperPeakSl);
            CloseAllStopperVirtualPositions("_PeakSl");
            MaybeSaveLogicPortfolios(force: true);

            decimal postCloseEquity = TryGetStopperMonitoredEquity(tab);
            if (postCloseEquity <= 0m)
            {
                RecalculateAllLogicPortfolioUnrealized();
                postCloseEquity = GetCombinedLogicPortfolioEquity();
            }

            SetPortfolioPeakValue(postCloseEquity > 0m ? postCloseEquity : currentEquity);

            string postTriggerAction = GetStopperPostTriggerAction(isTakeProfit: false);
            bool stopFullyPreview = IsStopperPostTriggerStopFully(postTriggerAction);
            RecordHtmlReportPeakDrawdownTrigger(
                candleTime,
                peak,
                currentEquity,
                drawdownPercent,
                triggerLevel,
                postCloseEquity,
                stopFullyPreview);

            MaybeWriteHtmlReport(force: true);

            bool stopFully = IsStopperPostTriggerStopFully(postTriggerAction);
            bool pauseAndResume = IsStopperPostTriggerPauseAndResume(postTriggerAction);
            if (stopFully)
            {
                TrySetRegimeOff("Stopper просадка от пика («" + StopperPostTriggerStopFully + "»)");
            }
            else if (pauseAndResume)
            {
                EnterStopperVirtualTrading(currentEquity, candleTime, isTakeProfit: false);
            }

            SaveParametersWithoutLogicIndicatorResync();

            string msg = NameStrategyUniq
                + " | Stopper: просадка от пика ("
                + drawdownPercent.ToString(CultureInfo.InvariantCulture)
                + "%) | пик="
                + peak.ToString(CultureInfo.InvariantCulture)
                + ", equity="
                + currentEquity.ToString(CultureInfo.InvariantCulture)
                + ", порог="
                + triggerLevel.ToString(CultureInfo.InvariantCulture)
                + ", ref→"
                + postCloseEquity.ToString(CultureInfo.InvariantCulture)
                + (stopFully
                    ? ", Regime=Off"
                    : pauseAndResume
                        ? ", фейк-торговля L1…L10"
                        : ", Regime без изменений")
                + ".";
            SendNewLogMessage(msg, LogMessageType.System);
            SendNewLogMessage(msg, LogMessageType.User);
            return true;
        }

        /// <summary>
        /// Ежедневное «продать всё» по расписанию: первая общая свеча после выбранного часа, не чаще 1 раза в сутки.
        /// Regime не трогаем.
        /// </summary>
        private bool TryExecuteStopperEodFlatSell(BotTabSimple tab, DateTime candleTime)
        {
            string choice = _stopperEodFlatSellTime?.ValueString ?? StopperEodFlatSellDisabled;
            if (string.IsNullOrWhiteSpace(choice)
                || string.Equals(choice.Trim(), StopperEodFlatSellDisabled, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            if (!TryParseStopperEodFlatScheduledTime(choice, out TimeSpan scheduledTime))
            {
                return false;
            }

            if (candleTime.TimeOfDay < scheduledTime)
            {
                return false;
            }

            DateTime tradingDay = candleTime.Date;
            if (_stopperEodFlatLastFiredTradingDay == tradingDay)
            {
                return false;
            }

            if (CountScreenerOpenPositions() <= 0)
            {
                return false;
            }

            _stopperEodFlatLastFiredTradingDay = tradingDay;
            decimal equityBefore = TryGetStopperMonitoredEquity(tab);
            if (equityBefore <= 0m)
            {
                RecalculateAllLogicPortfolioUnrealized();
                equityBefore = GetCombinedLogicPortfolioEquity();
            }

            CloseAllBotPositions(SignalPortfolioStopperEodFlat);
            CloseAllStopperVirtualPositions("_EodFlat");
            MaybeSaveLogicPortfolios(force: true);
            RecordHtmlReportEodFlatSell(candleTime, choice.Trim(), equityBefore);
            LogStopperEodFlatBuyBlockedOnce(candleTime);

            string msg = NameStrategyUniq
                + " | Stopper: ежедневное «продать всё» после "
                + choice.Trim()
                + " (свеча "
                + candleTime.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture)
                + ") — закрытие всех позиций; новые входы запрещены до следующего дня; Regime без изменений.";
            SendNewLogMessage(msg, LogMessageType.System);
            SendNewLogMessage(msg, LogMessageType.User);
            return true;
        }

        private static bool TryParseStopperEodFlatScheduledTime(string choice, out TimeSpan scheduledTime)
        {
            scheduledTime = TimeSpan.Zero;
            if (string.IsNullOrWhiteSpace(choice))
            {
                return false;
            }

            string trimmed = choice.Trim();
            if (DateTime.TryParseExact(
                    trimmed,
                    new[] { "H:mm", "HH:mm", "H:mm:ss", "HH:mm:ss" },
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.None,
                    out DateTime parsed))
            {
                scheduledTime = parsed.TimeOfDay;
                return true;
            }

            if (int.TryParse(trimmed, NumberStyles.Integer, CultureInfo.InvariantCulture, out int hourOnly)
                && hourOnly >= 0
                && hourOnly <= 23)
            {
                scheduledTime = new TimeSpan(hourOnly, 0, 0);
                return true;
            }

            return false;
        }

        private bool IsStopperEodFlatSellConfigured()
        {
            string choice = _stopperEodFlatSellTime?.ValueString ?? StopperEodFlatSellDisabled;
            return !string.IsNullOrWhiteSpace(choice)
                && !string.Equals(choice.Trim(), StopperEodFlatSellDisabled, StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>После срабатывания EOD flat в этот календарный день новые входы запрещены до следующих суток.</summary>
        private bool IsStopperEodFlatBuyBlocked(DateTime candleTime)
        {
            if (!IsStopperEodFlatSellConfigured() || _stopperEodFlatLastFiredTradingDay == DateTime.MinValue)
            {
                return false;
            }

            return _stopperEodFlatLastFiredTradingDay == candleTime.Date;
        }

        /// <summary>Активна пауза новых входов после значительного пика equity (Stopper).</summary>
        private bool IsSignificantPeakTradingPaused(DateTime candleTime)
        {
            if (_useSignificantPeakTradingPause == null || !_useSignificantPeakTradingPause.ValueBool)
            {
                return false;
            }

            return _significantPeakPauseUntil != DateTime.MinValue && candleTime < _significantPeakPauseUntil;
        }

        private bool IsStopperNewEntryBlocked(DateTime candleTime)
        {
            return IsStopperEodFlatBuyBlocked(candleTime)
                || IsSignificantPeakTradingPaused(candleTime);
        }

        /// <summary>
        /// На закрытой свече: локальный пик equity (подтверждён следующей свечой) → годовая доходность впадина→пик.
        /// </summary>
        private void TryUpdateSignificantPeakPause(DateTime candleTime)
        {
            if (_useSignificantPeakTradingPause == null || !_useSignificantPeakTradingPause.ValueBool)
            {
                return;
            }

            if (_stopperEquityHistory.Count < 3)
            {
                return;
            }

            int peakIdx = _stopperEquityHistory.Count - 2;
            decimal peakEquity = _stopperEquityHistory[peakIdx].Equity;
            decimal prevEquity = _stopperEquityHistory[peakIdx - 1].Equity;
            decimal nextEquity = _stopperEquityHistory[peakIdx + 1].Equity;
            if (!(peakEquity >= prevEquity && peakEquity > nextEquity))
            {
                return;
            }

            DateTime peakTime = _stopperEquityHistory[peakIdx].CandleTime;
            if (peakTime <= _significantPeakLastEvaluatedPeakTime)
            {
                return;
            }

            _significantPeakLastEvaluatedPeakTime = peakTime;

            int troughIdx = peakIdx;
            for (int j = peakIdx - 1; j >= 0; j--)
            {
                if (_stopperEquityHistory[j].Equity < _stopperEquityHistory[troughIdx].Equity)
                {
                    troughIdx = j;
                }
                else if (_stopperEquityHistory[j].Equity > _stopperEquityHistory[troughIdx].Equity)
                {
                    break;
                }
            }

            decimal troughEquity = _stopperEquityHistory[troughIdx].Equity;
            if (troughEquity <= 0m || peakEquity <= troughEquity)
            {
                return;
            }

            DateTime troughTime = _stopperEquityHistory[troughIdx].CandleTime;
            if (!TryComputeSignificantPeakAnnualPercent(
                    troughEquity,
                    peakEquity,
                    troughTime,
                    peakTime,
                    out double annualPercent))
            {
                return;
            }

            decimal threshold = _significantPeakAnnualPercentMin?.ValueDecimal ?? SignificantPeakAnnualPercentDefault;
            if (annualPercent < (double)threshold)
            {
                return;
            }

            decimal multiplier = _significantPeakPauseWidthMultiplier?.ValueDecimal ?? SignificantPeakPauseWidthMultiplierDefault;
            if (multiplier < 0.1m)
            {
                multiplier = 0.1m;
            }

            TimeSpan peakWidth = peakTime - troughTime;
            if (peakWidth < TimeSpan.Zero)
            {
                peakWidth = TimeSpan.Zero;
            }

            long pauseTicks = (long)(peakWidth.Ticks * (double)multiplier);
            if (pauseTicks <= 0)
            {
                pauseTicks = peakWidth.Ticks > 0 ? peakWidth.Ticks : TimeSpan.FromHours(1).Ticks;
            }

            DateTime pauseUntil = peakTime + TimeSpan.FromTicks(pauseTicks);
            if (pauseUntil <= _significantPeakPauseUntil && candleTime < _significantPeakPauseUntil)
            {
                return;
            }

            if (pauseUntil > _significantPeakPauseUntil)
            {
                _significantPeakPauseUntil = pauseUntil;
            }

            _loggedSignificantPeakPauseUntil = DateTime.MinValue;
            RecordHtmlReportSignificantPeakPause(candleTime, troughEquity, peakEquity, annualPercent, peakWidth, _significantPeakPauseUntil);

            string msg = NameStrategyUniq
                + " | Stopper: значительный пик equity — ~"
                + FormatSignificantPeakAnnualPercentForDisplay(annualPercent)
                + "% годовых (порог "
                + threshold.ToString(CultureInfo.InvariantCulture)
                + "%), впадина "
                + troughEquity.ToString(CultureInfo.InvariantCulture)
                + " → пик "
                + peakEquity.ToString(CultureInfo.InvariantCulture)
                + ", ширина "
                + peakWidth.ToString(@"d\.hh\:mm", CultureInfo.InvariantCulture)
                + ", пауза входов до "
                + _significantPeakPauseUntil.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture)
                + " (×"
                + multiplier.ToString(CultureInfo.InvariantCulture)
                + "); выходы по Cl/SL/TP без изменений.";
            SendNewLogMessage(msg, LogMessageType.System);
            SendNewLogMessage(msg, LogMessageType.User);
        }

        /// <summary>Годовая доходность впадина→пик; без cast в decimal (избегаем OverflowException).</summary>
        private static bool TryComputeSignificantPeakAnnualPercent(
            decimal troughEquity,
            decimal peakEquity,
            DateTime troughTime,
            DateTime peakTime,
            out double annualPercent)
        {
            annualPercent = 0.0;
            if (troughEquity <= 0m || peakEquity <= troughEquity)
            {
                return false;
            }

            double totalReturn = (double)((peakEquity - troughEquity) / troughEquity);
            if (double.IsNaN(totalReturn) || double.IsInfinity(totalReturn) || totalReturn <= -1.0)
            {
                return false;
            }

            double days = Math.Max((peakTime - troughTime).TotalDays, 1.0 / 24.0);
            double exponent = 365.0 / days;
            if (exponent > 10000.0)
            {
                exponent = 10000.0;
            }

            double growthFactor = Math.Pow(1.0 + totalReturn, exponent);
            if (double.IsNaN(growthFactor) || double.IsNegativeInfinity(growthFactor))
            {
                return false;
            }

            if (double.IsPositiveInfinity(growthFactor))
            {
                annualPercent = double.PositiveInfinity;
                return true;
            }

            annualPercent = (growthFactor - 1.0) * 100.0;
            return !double.IsNaN(annualPercent) && !double.IsNegativeInfinity(annualPercent);
        }

        private static string FormatSignificantPeakAnnualPercentForDisplay(double annualPercent)
        {
            if (double.IsPositiveInfinity(annualPercent) || annualPercent > 1_000_000_000_000.0)
            {
                return ">1e12";
            }

            return annualPercent.ToString("F1", CultureInfo.InvariantCulture);
        }

        private void LogSignificantPeakPauseBlockedOnce(DateTime candleTime)
        {
            if (!IsSignificantPeakTradingPaused(candleTime)
                || _loggedSignificantPeakPauseUntil == _significantPeakPauseUntil)
            {
                return;
            }

            _loggedSignificantPeakPauseUntil = _significantPeakPauseUntil;
            string msg = NameStrategyUniq
                + " | Stopper: пауза после значительного пика — новые входы запрещены до "
                + _significantPeakPauseUntil.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture)
                + " (свеча "
                + candleTime.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture)
                + ").";
            SendNewLogMessage(msg, LogMessageType.System);
        }

        private void LogStopperEodFlatBuyBlockedOnce(DateTime candleTime)
        {
            if (_loggedStopperEodFlatBuyBlockedDay == candleTime.Date)
            {
                return;
            }

            _loggedStopperEodFlatBuyBlockedDay = candleTime.Date;
            string msg = NameStrategyUniq
                + " | Stopper EOD: после продажи по времени новые входы запрещены до следующего календарного дня (свеча "
                + candleTime.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture)
                + ").";
            SendNewLogMessage(msg, LogMessageType.System);
        }

        /// <summary>Закрывает все виртуальные позиции Stopper «пауза» (тестер/лайв/эмулятор).</summary>
        private void CloseAllStopperVirtualPositions(string closeSignalSuffix)
        {
            if (_stopperVirtualPositions.Count == 0)
            {
                return;
            }

            var snapshot = new List<KeyValuePair<string, StopperVirtualPosition>>(_stopperVirtualPositions);
            string suffix = string.IsNullOrEmpty(closeSignalSuffix) ? "_Close" : closeSignalSuffix;

            for (int i = 0; i < snapshot.Count; i++)
            {
                StopperVirtualPosition virtualPosition = snapshot[i].Value;
                if (virtualPosition == null)
                {
                    continue;
                }

                BotTabSimple tab = TryFindScreenerTabByPortfolioKey(virtualPosition.TabKey);
                CloseStopperVirtualPosition(tab, virtualPosition, virtualPosition.LogicSlot, suffix);
            }
        }

        private void RecordHtmlReportEodFlatSell(DateTime candleTime, string scheduledTime, decimal equityBefore)
        {
            if (_htmlReportEnabled == null || !_htmlReportEnabled.ValueBool)
            {
                return;
            }

            lock (_htmlReportRuntimeLock)
            {
                TouchHtmlReportExecutionMode(null);
                HtmlReportExecutionMode mode = ResolveHtmlReportExecutionMode(null);
                decimal postCloseEquity = TryGetStopperMonitoredEquity(TryGetPortfolioMonitoringReferenceTab());
                if (postCloseEquity <= 0m)
                {
                    RecalculateAllLogicPortfolioUnrealized();
                    postCloseEquity = GetCombinedLogicPortfolioEquity();
                }

                string summary = "EOD flat после "
                    + scheduledTime
                    + " | equity "
                    + equityBefore.ToString(CultureInfo.InvariantCulture)
                    + " → "
                    + postCloseEquity.ToString(CultureInfo.InvariantCulture)
                    + ", входы до следующего дня запрещены, Regime без изменений";

                _htmlReportRuntime.StopperEvents.Add(new HtmlReportStopperEvent
                {
                    CandleTime = candleTime,
                    EventTimeUtc = DateTime.UtcNow,
                    Kind = "portfolio_eod_flat",
                    ReferenceEquity = equityBefore,
                    CurrentEquity = equityBefore,
                    ThresholdPercent = 0m,
                    TriggerLevel = 0m,
                    PostCloseEquity = postCloseEquity,
                    RegimeStopped = false,
                    ExecutionModeId = mode.ModeId,
                    ExecutionModeLabel = mode.ModeLabel,
                    Summary = summary
                });

                if (_htmlReportRuntime.StopperEvents.Count > HtmlReportStopperEventsCap)
                {
                    int remove = _htmlReportRuntime.StopperEvents.Count - HtmlReportStopperEventsCap;
                    _htmlReportRuntime.StopperEvents.RemoveRange(0, remove);
                }

                _htmlReportRuntime.RecentEvents.Add(new HtmlReportRecentEvent
                {
                    Seq = 0,
                    CandleTime = candleTime,
                    EventTimeUtc = DateTime.UtcNow,
                    Event = "portfolio_eod_flat",
                    TabKey = "—",
                    LogicSlot = 0,
                    Delta = postCloseEquity - equityBefore,
                    EquityTotal = postCloseEquity,
                    Note = summary,
                    ExecutionModeId = mode.ModeId,
                    ExecutionModeLabel = mode.ModeLabel
                });
                TrimHtmlReportRecentEvents(_htmlReportRuntime.RecentEvents);
                _htmlReportDirty = true;
            }
        }

        private bool TryEvaluatePortfolioStopLossTrigger(
            decimal referenceEquity,
            decimal currentEquity,
            out decimal triggerLevel,
            out string thresholdLabel)
        {
            triggerLevel = referenceEquity;
            thresholdLabel = "";

            decimal pct = ReadPortfolioStopLossPercentCurrent();
            decimal rub = _portfolioStopLossRubles?.ValueDecimal ?? 0m;
            if (pct <= 0m && rub <= 0m)
            {
                return false;
            }

            bool byPercent = false;
            bool byRubles = false;
            decimal pctFloor = referenceEquity;
            decimal rubFloor = referenceEquity;

            if (pct > 0m)
            {
                pctFloor = referenceEquity * (1m - pct / 100m);
                byPercent = currentEquity <= pctFloor;
            }

            if (rub > 0m)
            {
                rubFloor = referenceEquity - rub;
                byRubles = currentEquity <= rubFloor;
            }

            if (!byPercent && !byRubles)
            {
                return false;
            }

            triggerLevel = pct > 0m && rub > 0m
                ? Math.Max(pctFloor, rubFloor)
                : (pct > 0m ? pctFloor : rubFloor);
            thresholdLabel = BuildStopperThresholdLabel(pct, rub, isTakeProfit: false);
            return true;
        }

        private bool TryEvaluatePortfolioTakeProfitTrigger(
            decimal referenceEquity,
            decimal currentEquity,
            out decimal triggerLevel,
            out string thresholdLabel)
        {
            triggerLevel = referenceEquity;
            thresholdLabel = "";

            decimal pct = ReadPortfolioTakeProfitPercentCurrent();
            decimal rub = _portfolioTakeProfitRubles?.ValueDecimal ?? 0m;
            if (pct <= 0m && rub <= 0m)
            {
                return false;
            }

            bool byPercent = false;
            bool byRubles = false;
            decimal pctCeiling = referenceEquity;
            decimal rubCeiling = referenceEquity;

            if (pct > 0m)
            {
                pctCeiling = referenceEquity * (1m + pct / 100m);
                byPercent = currentEquity >= pctCeiling;
            }

            if (rub > 0m)
            {
                rubCeiling = referenceEquity + rub;
                byRubles = currentEquity >= rubCeiling;
            }

            if (!byPercent && !byRubles)
            {
                return false;
            }

            triggerLevel = pct > 0m && rub > 0m
                ? Math.Min(pctCeiling, rubCeiling)
                : (pct > 0m ? pctCeiling : rubCeiling);
            thresholdLabel = BuildStopperThresholdLabel(pct, rub, isTakeProfit: true);
            return true;
        }

        private static string BuildStopperThresholdLabel(decimal thresholdPercent, decimal thresholdRubles, bool isTakeProfit)
        {
            var parts = new List<string>();
            if (thresholdPercent > 0m)
            {
                parts.Add(thresholdPercent.ToString(CultureInfo.InvariantCulture) + "%");
            }

            if (thresholdRubles > 0m)
            {
                parts.Add(thresholdRubles.ToString(CultureInfo.InvariantCulture) + " руб");
            }

            if (parts.Count == 0)
            {
                return isTakeProfit ? "take-profit" : "stop-loss";
            }

            return string.Join(" или ", parts);
        }

        private bool IsStopMonitorSameAsMainTimeFrame()
        {
            string raw = _stopperMonitorTimeFrame?.ValueString ?? StopperMonitorTimeFrameSameAsMain;
            if (string.IsNullOrWhiteSpace(raw))
            {
                return true;
            }

            return string.Equals(raw, StopperMonitorTimeFrameSameAsMain, StringComparison.OrdinalIgnoreCase)
                || string.Equals(raw, StopperMonitorTimeFrameLegacyOff, StringComparison.OrdinalIgnoreCase);
        }

        private void MigrateLegacyStopperMonitorTimeFrameParamIfNeeded()
        {
            if (_stopperMonitorTimeFrame == null)
            {
                return;
            }

            if (!string.Equals(
                    _stopperMonitorTimeFrame.ValueString,
                    StopperMonitorTimeFrameLegacyOff,
                    StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            _stopperMonitorTimeFrame.ValueString = StopperMonitorTimeFrameSameAsMain;
        }

        private bool IsStopMonitorScreenerActive()
        {
            if (IsStopMonitorSameAsMainTimeFrame())
            {
                return false;
            }

            return TryParseStopperMonitorTimeFrame(out _)
                && !string.IsNullOrWhiteSpace(_stopperMonitorSecurity?.ValueString);
        }

        private bool TryParseStopperMonitorTimeFrame(out TimeFrame timeFrame)
        {
            timeFrame = TimeFrame.Min1;
            if (IsStopMonitorSameAsMainTimeFrame())
            {
                return false;
            }

            string raw = (_stopperMonitorTimeFrame?.ValueString ?? "").Trim();
            if (string.IsNullOrEmpty(raw))
            {
                return false;
            }

            return Enum.TryParse(raw, true, out timeFrame);
        }

        private bool IsStopMonitorInstrumentTab(BotTabSimple tab)
        {
            if (tab == null || _stopMonitorScreenerTab?.Tabs == null)
            {
                return false;
            }

            for (int i = 0; i < _stopMonitorScreenerTab.Tabs.Count; i++)
            {
                if (ReferenceEquals(_stopMonitorScreenerTab.Tabs[i], tab))
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Страница 2 скринера: при включённом «Stopper: таймфрейм монитора» — одна бумага (SBER по умолчанию) и проверка SL/TP портфеля.
        /// </summary>
        private void SyncStopMonitorScreenerPage(bool logToUser)
        {
            if (_screenerTab == null)
            {
                return;
            }

            MigrateLegacyStopperMonitorTimeFrameParamIfNeeded();

            if (!IsStopMonitorScreenerActive())
            {
                DestroyStopMonitorScreenerPage();
                if (logToUser)
                {
                    SendNewLogMessage(
                        NameStrategyUniq
                        + " | Stopper-монитор: «"
                        + StopperMonitorTimeFrameSameAsMain
                        + "» — страница 2 скринера удалена, SL/TP на общей свече страницы 1.",
                        LogMessageType.User);
                }
                return;
            }

            EnsureStopMonitorScreenerPageExists();
            if (_stopMonitorScreenerTab == null)
            {
                SendNewLogMessage(
                    NameStrategyUniq + " | Stopper-монитор: не удалось создать страницу 2 скринера.",
                    LogMessageType.Error);
                return;
            }

            if (!TryParseStopperMonitorTimeFrame(out TimeFrame monitorTimeFrame))
            {
                return;
            }

            string securityName = (_stopperMonitorSecurity?.ValueString ?? "").Trim();
            if (string.IsNullOrEmpty(securityName))
            {
                SendNewLogMessage(
                    NameStrategyUniq + " | Stopper-монитор: задайте «" + StopperMonitorSecurityParamName + "».",
                    LogMessageType.Error);
                return;
            }

            CopyMainScreenerConnectionToStopMonitor(monitorTimeFrame);

            if (_stopMonitorAppliedTimeFrame.HasValue && _stopMonitorAppliedTimeFrame.Value != monitorTimeFrame)
            {
                ClearStopMonitorScreenerSecuritiesAndTabs();
            }

            ConfigureStopMonitorScreenerSecurity(securityName);
            ReloadStopMonitorScreenerTabs(monitorTimeFrame);
            _stopMonitorAppliedTimeFrame = monitorTimeFrame;
            WireStopMonitorScreenerEvents(wire: true);

            string msg = NameStrategyUniq
                + " | Stopper-монитор (страница 2): "
                + securityName
                + ", TF="
                + monitorTimeFrame;
            if (_stopMonitorScreenerTab.Tabs != null && _stopMonitorScreenerTab.Tabs.Count > 0)
            {
                msg += ", Connector.TF="
                    + (_stopMonitorScreenerTab.Tabs[0].Connector?.TimeFrame.ToString() ?? "?");
            }

            msg += " — проверка SL/TP портфеля по CandleFinished этой вкладки (не страница 1).";
            SendNewLogMessage(msg, LogMessageType.System);
            if (logToUser)
            {
                SendNewLogMessage(msg, LogMessageType.User);
            }
        }

        private void CopyMainScreenerConnectionToStopMonitor(TimeFrame monitorTimeFrame)
        {
            _stopMonitorScreenerTab.PortfolioName = _screenerTab.PortfolioName;
            _stopMonitorScreenerTab.SecuritiesClass = _screenerTab.SecuritiesClass;
            _stopMonitorScreenerTab.ServerType = _screenerTab.ServerType;
            _stopMonitorScreenerTab.ServerName = _screenerTab.ServerName;
            _stopMonitorScreenerTab.EmulatorIsOn = _screenerTab.EmulatorIsOn;
            _stopMonitorScreenerTab.CandleMarketDataType = _screenerTab.CandleMarketDataType;
            _stopMonitorScreenerTab.CandleCreateMethodType = _screenerTab.CandleCreateMethodType;
            _stopMonitorScreenerTab.CommissionType = _screenerTab.CommissionType;
            _stopMonitorScreenerTab.CommissionValue = _screenerTab.CommissionValue;
            ApplyStopMonitorScreenerTimeFrame(monitorTimeFrame, reconnectTabs: false);
        }

        /// <summary>
        /// TF страницы 2 = параметр «Stopper: таймфрейм монитора», не TF страницы 1.
        /// Синхронизирует screener.TimeFrame, CandleSeriesRealization и коннекторы вкладок.
        /// </summary>
        private void ApplyStopMonitorScreenerTimeFrame(TimeFrame monitorTimeFrame, bool reconnectTabs)
        {
            if (_stopMonitorScreenerTab == null)
            {
                return;
            }

            SyncStopMonitorScreenerCandleSeriesTimeFrame(_stopMonitorScreenerTab, monitorTimeFrame);

            if (reconnectTabs && _stopMonitorScreenerTab.Tabs != null)
            {
                for (int i = 0; i < _stopMonitorScreenerTab.Tabs.Count; i++)
                {
                    ApplyStopMonitorTimeFrameToTab(_stopMonitorScreenerTab.Tabs[i], monitorTimeFrame);
                }
            }

            _stopMonitorScreenerTab.SaveSettings();
        }

        /// <summary>
        /// Поле BotTabScreener.TimeFrame и CandleSeriesRealization должны совпадать: иначе TryCreateTab/UpdateTabSettings
        /// копируют серию с TF страницы 1 (например Min30) поверх выбранного Min5.
        /// </summary>
        private static void SyncStopMonitorScreenerCandleSeriesTimeFrame(BotTabScreener screener, TimeFrame timeFrame)
        {
            if (screener == null)
            {
                return;
            }

            screener.TimeFrame = timeFrame;
            SyncCandleSeriesRealizationTimeFrame(screener.CandleSeriesRealization, timeFrame);
        }

        private static void SyncCandleSeriesRealizationTimeFrame(ACandlesSeriesRealization series, TimeFrame timeFrame)
        {
            if (series == null)
            {
                return;
            }

            if (series is Simple simple)
            {
                simple.TimeFrame = timeFrame;
            }
            else if (series is HeikenAshi heikenAshi)
            {
                heikenAshi.TimeFrame = timeFrame;
            }
            else if (series is TimeShiftCandle timeShiftCandle)
            {
                timeShiftCandle.TimeFrame = timeFrame;
            }

            for (int i = 0; i < series.Parameters.Count; i++)
            {
                ICandleSeriesParameter param = series.Parameters[i];
                if (param.SysName == "TimeFrame"
                    && param.Type == CandlesParameterType.StringCollection)
                {
                    ((CandlesParameterString)param).ValueString = timeFrame.ToString();
                }
            }

            series.OnStateChange(CandleSeriesState.ParametersChange);
        }

        private static void ApplyStopMonitorTimeFrameToTab(BotTabSimple tab, TimeFrame monitorTimeFrame)
        {
            if (tab?.Connector == null)
            {
                return;
            }

            try
            {
                tab.Connector.TimeFrame = monitorTimeFrame;
                SyncCandleSeriesRealizationTimeFrame(tab.Connector.TimeFrameBuilder?.CandleSeriesRealization, monitorTimeFrame);
                tab.TimeFrameBuilder?.Save();
                tab.Connector.Save();
                tab.Connector.ReconnectHard();
            }
            catch
            {
                // ignore reconnect errors during Stopper monitor sync
            }
        }

        /// <summary>
        /// Вторая страница скринера (оранжевая «2») создаётся только при Min1…Min15; иначе вкладка удаляется из робота.
        /// </summary>
        private void EnsureStopMonitorScreenerPageExists()
        {
            if (_stopMonitorScreenerTab != null)
            {
                List<IIBotTab> tabs = GetTabs();
                if (tabs != null && tabs.Contains(_stopMonitorScreenerTab))
                {
                    return;
                }
            }

            TryResolveStopMonitorScreenerTabReference();
            if (_stopMonitorScreenerTab != null)
            {
                List<IIBotTab> tabs = GetTabs();
                if (tabs != null && tabs.Contains(_stopMonitorScreenerTab))
                {
                    return;
                }
            }

            _stopMonitorScreenerTab = null;
            PrepareStopMonitorScreenerPersistedArtifactsBeforeCreate();
            TabCreate(BotTabType.Screener);
            if (TabsScreener == null || TabsScreener.Count == 0)
            {
                return;
            }

            _stopMonitorScreenerTab = TabsScreener[TabsScreener.Count - 1];
            ClearStopMonitorScreenerTradingIndicators();
            RemoveCorruptStopMonitorScreenerTabSetFileIfNeeded();
        }

        /// <summary>
        /// Полное отключение монитора: бумаги, persisted-файлы, вкладка «2» в панели робота.
        /// </summary>
        private void DestroyStopMonitorScreenerPage()
        {
            WireStopMonitorScreenerEvents(wire: false);
            TryResolveStopMonitorScreenerTabReference();

            if (_stopMonitorScreenerTab == null)
            {
                _stopMonitorAppliedTimeFrame = null;
                return;
            }

            ClearStopMonitorScreenerSecuritiesAndTabs(forceReloadUi: true);
            DeleteStopMonitorScreenerPersistedSettings();
            RemoveStopMonitorScreenerBotTab();
            _stopMonitorScreenerTab = null;
            _stopMonitorAppliedTimeFrame = null;
        }

        private void TryResolveStopMonitorScreenerTabReference()
        {
            if (_stopMonitorScreenerTab != null || TabsScreener == null)
            {
                return;
            }

            for (int i = 0; i < TabsScreener.Count; i++)
            {
                if (!ReferenceEquals(TabsScreener[i], _screenerTab))
                {
                    _stopMonitorScreenerTab = TabsScreener[i];
                    return;
                }
            }
        }

        private void RemoveStopMonitorScreenerBotTab()
        {
            if (_stopMonitorScreenerTab == null)
            {
                return;
            }

            List<IIBotTab> tabs = GetTabs();
            int index = tabs?.IndexOf(_stopMonitorScreenerTab) ?? -1;
            if (index < 0)
            {
                try
                {
                    _stopMonitorScreenerTab.StopPaint();
                    _stopMonitorScreenerTab.Delete();
                }
                catch
                {
                    // ignore
                }

                return;
            }

            if (ActiveTab == null && tabs.Count > 0)
            {
                ActiveTab = tabs[0];
            }

            try
            {
                TabDelete(index);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(
                    NameStrategyUniq + " | Stopper-монитор: удаление страницы 2 — " + ex.Message,
                    LogMessageType.System);
                try
                {
                    _stopMonitorScreenerTab.StopPaint();
                    _stopMonitorScreenerTab.Delete();
                    tabs.RemoveAt(index);
                }
                catch
                {
                    // ignore fallback errors
                }
            }
        }

        private void DeleteStopMonitorScreenerPersistedSettings()
        {
            string tabName = _stopMonitorScreenerTab?.TabName ?? GetStopMonitorScreenerTabNameCandidate();
            if (string.IsNullOrWhiteSpace(tabName))
            {
                return;
            }

            string[] suffixes =
            {
                "ScreenerSet.txt",
                "ScreenerTabSet.txt",
                "ScreenerIndicators.txt"
            };

            for (int i = 0; i < suffixes.Length; i++)
            {
                try
                {
                    string path = Path.Combine("Engine", tabName + suffixes[i]);
                    if (File.Exists(path))
                    {
                        File.Delete(path);
                    }
                }
                catch (Exception ex)
                {
                    SendNewLogMessage(
                        NameStrategyUniq + " | Stopper-монитор: " + suffixes[i] + " — " + ex.Message,
                        LogMessageType.System);
                }
            }
        }

        private void ConfigureStopMonitorScreenerSecurity(string securityName)
        {
            if (_stopMonitorScreenerTab.SecuritiesNames == null)
            {
                return;
            }

            string secClass = string.IsNullOrWhiteSpace(_screenerTab.SecuritiesClass)
                ? "TQBR"
                : _screenerTab.SecuritiesClass;

            ClearStopMonitorScreenerSecuritiesAndTabs();

            _stopMonitorScreenerTab.SecuritiesNames.Add(new ActivatedSecurity
            {
                SecurityName = securityName,
                SecurityClass = secClass,
                IsOn = true
            });
            _stopMonitorScreenerTab.SaveSettings();
        }

        private void ClearStopMonitorScreenerSecuritiesAndTabs(bool forceReloadUi = false)
        {
            if (_stopMonitorScreenerTab == null)
            {
                return;
            }

            ClearStopMonitorScreenerTradingIndicators();

            if (_stopMonitorScreenerTab.SecuritiesNames != null)
            {
                _stopMonitorScreenerTab.SecuritiesNames.Clear();
            }

            if (_stopMonitorScreenerTab.Tabs != null)
            {
                for (int i = _stopMonitorScreenerTab.Tabs.Count - 1; i >= 0; i--)
                {
                    BotTabSimple tab = _stopMonitorScreenerTab.Tabs[i];
                    if (tab == null)
                    {
                        _stopMonitorScreenerTab.Tabs.RemoveAt(i);
                        continue;
                    }

                    StripTabCandleIndicatorsQuiet(tab);
                    DeleteStopMonitorTabPersistedChartFiles(tab);
                    tab.Clear();
                    tab.Delete();
                    _stopMonitorScreenerTab.Tabs.RemoveAt(i);
                }
            }

            ClearStopMonitorScreenerPersistedTabListFile();
            _stopMonitorScreenerTab.NeedToReloadTabs = true;
            if (forceReloadUi)
            {
                _stopMonitorScreenerTab.TryReLoadTabs();
            }

            _stopMonitorScreenerTab.SaveSettings();
        }

        /// <summary>
        /// Страница 2 — только «часы» Stopper; индикаторы логик не ставим (иначе ReloadIndicatorsOnTabs → NRE на чарте).
        /// </summary>
        private void ClearStopMonitorScreenerTradingIndicators()
        {
            if (_stopMonitorScreenerTab == null)
            {
                return;
            }

            if (_stopMonitorScreenerTab._indicators != null)
            {
                _stopMonitorScreenerTab._indicators.Clear();
            }

            try
            {
                string path = Path.Combine("Engine", _stopMonitorScreenerTab.TabName + "ScreenerIndicators.txt");
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch (Exception ex)
            {
                SendNewLogMessage(
                    NameStrategyUniq + " | Stopper-монитор: не удалось удалить ScreenerIndicators.txt — " + ex.Message,
                    LogMessageType.System);
            }
        }

        /// <summary>До второго TabCreate — убрать сохранённые индикаторы tab1, иначе ctor BotTabScreener вызовет ReloadIndicatorsOnTabs.</summary>
        private void PrepareStopMonitorScreenerPersistedArtifactsBeforeCreate()
        {
            try
            {
                string path = Path.Combine("Engine", GetStopMonitorScreenerTabNameCandidate() + "ScreenerIndicators.txt");
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch (Exception ex)
            {
                SendNewLogMessage(
                    NameStrategyUniq + " | Stopper-монитор: подготовка tab1 — " + ex.Message,
                    LogMessageType.System);
            }
        }

        private string GetStopMonitorScreenerTabNameCandidate()
        {
            return NameStrategyUniq + "tab1";
        }

        private static void StripTabCandleIndicatorsQuiet(BotTabSimple tab)
        {
            if (tab?.Indicators == null)
            {
                return;
            }

            for (int i = tab.Indicators.Count - 1; i >= 0; i--)
            {
                if (tab.Indicators[i] is Aindicator indicator)
                {
                    try
                    {
                        tab.DeleteCandleIndicator(indicator);
                    }
                    catch
                    {
                        // ignore cleanup errors on monitor tab
                    }
                }
            }
        }

        private void DeleteStopMonitorTabPersistedChartFiles(BotTabSimple tab)
        {
            if (tab == null || string.IsNullOrWhiteSpace(tab.TabName))
            {
                return;
            }

            try
            {
                string chartPath = Path.Combine("Engine", tab.TabName + "_Engine.txt");
                if (File.Exists(chartPath))
                {
                    File.Delete(chartPath);
                }

                string connectorPath = Path.Combine("Engine", tab.TabName + ".txt");
                if (File.Exists(connectorPath))
                {
                    File.Delete(connectorPath);
                }

                string timeFrameBuilderPath = Path.Combine("Engine", tab.TabName + "TimeFrameBuilder.txt");
                if (File.Exists(timeFrameBuilderPath))
                {
                    File.Delete(timeFrameBuilderPath);
                }
            }
            catch (Exception ex)
            {
                SendNewLogMessage(
                    NameStrategyUniq + " | Stopper-монитор: " + tab.TabName + " persisted files — " + ex.Message,
                    LogMessageType.System);
            }
        }

        /// <summary>
        /// Перезагрузка вкладок страницы 2 без индикаторов логик и без TryLoadTabs (старые tab*.txt тянут TF основного скринера).
        /// </summary>
        private void ReloadStopMonitorScreenerTabs(TimeFrame monitorTimeFrame)
        {
            EnsureStopMonitorScreenerCandleInfrastructure(monitorTimeFrame);
            ClearStopMonitorScreenerTradingIndicators();
            ApplyStopMonitorScreenerTimeFrame(monitorTimeFrame, reconnectTabs: false);
            _stopMonitorScreenerTab.NeedToReloadTabs = true;
            _stopMonitorScreenerTab.TryReLoadTabs();
            ApplyStopMonitorScreenerTimeFrame(monitorTimeFrame, reconnectTabs: true);
        }

        private void WireStopMonitorScreenerEvents(bool wire)
        {
            if (_stopMonitorScreenerTab == null)
            {
                return;
            }

            if (wire)
            {
                if (_stopMonitorScreenerEventsWired)
                {
                    return;
                }

                _stopMonitorScreenerTab.CandleFinishedEvent += StopMonitorScreener_CandleFinishedEvent;
                _stopMonitorScreenerTab.EventsIsOn = true;
                _stopMonitorScreenerEventsWired = true;
                return;
            }

            if (!_stopMonitorScreenerEventsWired)
            {
                return;
            }

            _stopMonitorScreenerTab.CandleFinishedEvent -= StopMonitorScreener_CandleFinishedEvent;
            _stopMonitorScreenerEventsWired = false;
        }

        /// <summary>CandleFinished страницы 2 — только общепортфельный Stopper (SL/TP), без торговли по логикам.</summary>
        private void StopMonitorScreener_CandleFinishedEvent(List<Candle> candles, BotTabSimple tab)
        {
            if (!IsStopMonitorScreenerActive()
                || !IsPortfolioStopperActive()
                || candles == null
                || candles.Count == 0
                || tab == null
                || !IsStopMonitorInstrumentTab(tab))
            {
                return;
            }

            DateTime candleTime = candles[candles.Count - 1].TimeStart;
            RecalculateAllLogicPortfolioUnrealized();

            BotTabSimple refTab = TryGetPortfolioMonitoringReferenceTab();
            if (refTab == null)
            {
                refTab = tab;
            }

            RefreshStopperTechEquityDisplayAggregated(refTab, candleTime);
            if (TryManagePortfolioStopperProtection(refTab, candleTime))
            {
                MaybeRefreshReferenceAnnualYieldAfterAggregatedCandle(candleTime, refTab, force: true);
                MaybeSaveLogicPortfolios(force: true);
                RecordHtmlReportEquitySnapshot(candleTime);
                MaybeWriteHtmlReport(force: true);
            }
        }

        private void EnsureStopMonitorScreenerCandleInfrastructure(TimeFrame monitorTimeFrame)
        {
            if (_stopMonitorScreenerTab == null)
            {
                return;
            }

            SyncStopMonitorScreenerCandleSeriesTimeFrame(_stopMonitorScreenerTab, monitorTimeFrame);

            if (_stopMonitorScreenerTab.CandleSeriesRealization == null)
            {
                string seriesType = string.IsNullOrWhiteSpace(_stopMonitorScreenerTab.CandleCreateMethodType)
                    ? "Simple"
                    : _stopMonitorScreenerTab.CandleCreateMethodType;
                _stopMonitorScreenerTab.CandleSeriesRealization =
                    CandleFactory.CreateCandleSeriesRealization(seriesType);
                _stopMonitorScreenerTab.CandleSeriesRealization?.Init(StartProgram);
                SyncStopMonitorScreenerCandleSeriesTimeFrame(_stopMonitorScreenerTab, monitorTimeFrame);
            }

            if (_stopMonitorScreenerTab.CandleSeriesRealization == null
                || _stopMonitorScreenerTab.Tabs == null)
            {
                return;
            }

            string screenerSeriesState = _stopMonitorScreenerTab.CandleSeriesRealization.GetSaveString();
            for (int i = 0; i < _stopMonitorScreenerTab.Tabs.Count; i++)
            {
                EnsureTabCandleSeriesRealization(_stopMonitorScreenerTab.Tabs[i], screenerSeriesState);
                ApplyStopMonitorTimeFrameToTab(_stopMonitorScreenerTab.Tabs[i], monitorTimeFrame);
            }
        }

        private void RemoveCorruptStopMonitorScreenerTabSetFileIfNeeded()
        {
            if (_stopMonitorScreenerTab == null)
            {
                return;
            }

            try
            {
                string path = Path.Combine("Engine", _stopMonitorScreenerTab.TabName + "ScreenerTabSet.txt");
                if (!File.Exists(path))
                {
                    return;
                }

                string content = File.ReadAllText(path, Encoding.UTF8).Trim();
                if (string.IsNullOrEmpty(content) || content == "#")
                {
                    File.Delete(path);
                }
            }
            catch
            {
                // ignore
            }
        }

        private void ClearStopMonitorScreenerPersistedTabListFile()
        {
            if (_stopMonitorScreenerTab == null)
            {
                return;
            }

            try
            {
                string path = Path.Combine("Engine", _stopMonitorScreenerTab.TabName + "ScreenerTabSet.txt");
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch
            {
                // ignore
            }
        }

        private void AppendStopperEquitySnapshot(DateTime candleTime, decimal equity)
        {
            if (_stopperEquityHistory.Count > 0
                && _stopperEquityHistory[_stopperEquityHistory.Count - 1].CandleTime == candleTime)
            {
                _stopperEquityHistory[_stopperEquityHistory.Count - 1].Equity = equity;
                return;
            }

            _stopperEquityHistory.Add(new StopperEquitySnapshot
            {
                CandleTime = candleTime,
                Equity = equity
            });

            while (_stopperEquityHistory.Count > StopperEquityHistoryCap)
            {
                _stopperEquityHistory.RemoveAt(0);
            }
        }

        /// <summary>
        /// Тех. параметры сумм портфеля на «общей свече» скринера (после всех вкладок), не на каждой бумаге.
        /// </summary>
        private void RefreshStopperTechEquityDisplayAggregated(BotTabSimple tab, DateTime candleTime)
        {
            decimal currentEquity = TryGetStopperMonitoredEquity(tab);
            SetStrategyParameterDecimalSilent(_portfolioStopperCurrentEquity, currentEquity);
            AppendStopperEquitySnapshot(candleTime, currentEquity);
            TryUpdateSignificantPeakPause(candleTime);

            if (!_stopperReferenceBaselineLocked)
            {
                int lookback = Math.Max(1, _portfolioStopperLookbackCandles.ValueInt);
                if (_stopperEquityHistory.Count > lookback)
                {
                    decimal refEquity = _stopperEquityHistory[_stopperEquityHistory.Count - 1 - lookback].Equity;
                    SetStrategyParameterDecimalSilent(_portfolioStopperReferenceEquity, refEquity);
                }
            }
        }

        /// <summary>Ключ вкладки для барьера общей свечи.</summary>
        private static string GetAggregatedCandleTabKey(BotTabSimple tab)
        {
            if (!string.IsNullOrEmpty(tab?.TabName))
            {
                return tab.TabName;
            }

            return tab?.Connector?.SecurityName ?? "";
        }

        /// <summary>
        /// Отмечает завершение цикла свечи на вкладке; при последней вкладке — один пересчёт тех. полей и Stopper.
        /// </summary>
        /// <returns>true, если выполнен агрегированный flush (все вкладки отработали).</returns>
        private bool TryFlushAggregatedCandlePortfolioDisplayIfComplete(
            BotTabSimple tab,
            DateTime candleTime,
            int candleIndex)
        {
            string tabKey = GetAggregatedCandleTabKey(tab);
            bool shouldFlush;

            lock (_aggregatedCandleLock)
            {
                if (_aggregatedCandleBarrierTime != candleTime)
                {
                    _aggregatedCandleBarrierTime = candleTime;
                    _aggregatedCandleCompletedTabKeys.Clear();
                }

                if (!string.IsNullOrEmpty(tabKey))
                {
                    _aggregatedCandleCompletedTabKeys.Add(tabKey);
                }

                int totalTabs = _screenerTab?.Tabs?.Count ?? 0;
                if (totalTabs > 0 && _aggregatedCandleCompletedTabKeys.Count < totalTabs)
                {
                    shouldFlush = false;
                }
                else
                {
                    _aggregatedCandleCompletedTabKeys.Clear();
                    shouldFlush = true;
                }
            }

            if (!shouldFlush)
            {
                return false;
            }

            FlushAggregatedCandlePortfolioDisplay(candleTime, candleIndex);
            return true;
        }

        /// <summary>
        /// Один пересчёт после всех вкладок: unrealized, Stopper, справочный % годовых, сохранение портфелей.
        /// </summary>
        private void FlushAggregatedCandlePortfolioDisplay(DateTime candleTime, int candleIndex)
        {
            if (NeedsLogicPortfolioTrackingOnCandle())
            {
                _aggregatedCandleWaveIndex++;

                RecalculateAllLogicPortfolioUnrealized();

                if (_metaLogicEnabled.ValueBool)
                {
                    AppendMetaLogicWarmupPortfolioPoints(candleTime);
                }

                BotTabSimple refTab = TryGetPortfolioMonitoringReferenceTab();
                if (refTab == null && _screenerTab?.Tabs != null && _screenerTab.Tabs.Count > 0)
                {
                    refTab = _screenerTab.Tabs[0];
                }

                if (IsStopperVirtualTradingActive())
                {
                    TryResumeStopperVirtualTrading(refTab, candleTime);
                }

                if (TryExecuteStopperEodFlatSell(refTab, candleTime))
                {
                    MaybeRefreshReferenceAnnualYieldAfterAggregatedCandle(
                        candleTime,
                        refTab,
                        force: true);
                    RecordHtmlReportEquitySnapshot(candleTime);
                    MaybeWriteHtmlReport(force: true);
                }

                if (ShouldRefreshStopperEquityOnAggregatedCandle())
                {
                    if (!IsStopMonitorScreenerActive())
                    {
                        RefreshStopperTechEquityDisplayAggregated(refTab, candleTime);
                        if (IsPortfolioStopperActive()
                            && TryManagePortfolioStopperProtection(refTab, candleTime))
                        {
                            MaybeRefreshReferenceAnnualYieldAfterAggregatedCandle(
                                candleTime,
                                refTab,
                                force: true);
                            MaybeSaveLogicPortfolios(force: false);
                            RecordHtmlReportEquitySnapshot(candleTime);
                            MaybeWriteHtmlReport(force: false);
                            return;
                        }
                    }
                }

                MaybeRefreshReferenceAnnualYieldAfterAggregatedCandle(candleTime, refTab, force: false);
                MaybeSaveLogicPortfolios(force: false);
            }

            RecordHtmlReportEquitySnapshot(candleTime);
            MaybeWriteHtmlReport(force: false);
        }

        /// <summary>Справочный % годовых — реже в тестере/лайве, только на «общей свече» скринера.</summary>
        private void MaybeRefreshReferenceAnnualYieldAfterAggregatedCandle(
            DateTime candleTime,
            BotTabSimple tab,
            bool force)
        {
            if ((_referenceInitialPortfolioAmount?.ValueDecimal ?? 0m) <= 0m)
            {
                return;
            }

            if (!force)
            {
                int every = StartProgram == StartProgram.IsTester
                    ? ReferenceYieldRefreshEveryAggregatedWavesInTester
                    : ReferenceYieldRefreshEveryAggregatedWavesInLive;
                if (_aggregatedCandleWaveIndex > 0 && _aggregatedCandleWaveIndex % every != 0)
                {
                    return;
                }
            }

            RefreshReferenceAnnualYieldDisplay(candleTime, tab);
        }

        private bool ExecutePortfolioStopperTrigger(
            BotTabSimple tab,
            DateTime candleTime,
            bool isTakeProfit,
            decimal referenceEquity,
            decimal currentEquity,
            decimal thresholdPercent,
            decimal thresholdRubles,
            decimal triggerLevel,
            string thresholdLabel)
        {
            _stopperLastProtectionCandleTime = candleTime;
            string closeSignal = isTakeProfit ? SignalPortfolioStopperTp : SignalPortfolioStopperSl;
            CloseAllBotPositions(closeSignal);
            CloseAllStopperVirtualPositions(isTakeProfit ? "_TP" : "_SL");
            MaybeSaveLogicPortfolios(force: true);

            string postTriggerAction = GetStopperPostTriggerAction(isTakeProfit);
            bool stopFullyPreview = IsStopperPostTriggerStopFully(postTriggerAction);
            RecordHtmlReportStopperTrigger(
                candleTime,
                isTakeProfit,
                referenceEquity,
                currentEquity,
                thresholdPercent,
                thresholdRubles,
                triggerLevel,
                thresholdLabel,
                stopFullyPreview);

            MaybeWriteHtmlReport(force: true);

            decimal postCloseEquity = TryGetStopperMonitoredEquity(tab);
            if (postCloseEquity <= 0m)
            {
                RecalculateAllLogicPortfolioUnrealized();
                postCloseEquity = GetCombinedLogicPortfolioEquity();
            }

            ApplyStopperReferenceBaseline(postCloseEquity, candleTime, saveParameters: false);

            bool stopFully = IsStopperPostTriggerStopFully(postTriggerAction);
            bool pauseAndResume = IsStopperPostTriggerPauseAndResume(postTriggerAction);
            if (stopFully)
            {
                string stopReason = isTakeProfit
                    ? "Stopper take-profit («" + StopperPostTriggerStopFully + "»)"
                    : "Stopper stop-loss («" + StopperPostTriggerStopFully + "»)";
                TrySetRegimeOff(stopReason);
            }
            else if (pauseAndResume)
            {
                EnterStopperVirtualTrading(currentEquity, candleTime, isTakeProfit);
            }
            else
            {
                SendNewLogMessage(
                    NameStrategyUniq
                    + " | Stopper: Regime не менялся (режим «"
                    + StopperPostTriggerDisabled
                    + "» после "
                    + (isTakeProfit ? "take-profit" : "stop-loss")
                    + ").",
                    LogMessageType.System);
            }

            SaveParametersWithoutLogicIndicatorResync();

            string kind = isTakeProfit ? "take-profit" : "stop-loss";
            string label = string.IsNullOrWhiteSpace(thresholdLabel)
                ? thresholdPercent.ToString(CultureInfo.InvariantCulture) + "%"
                : thresholdLabel;
            string msg = NameStrategyUniq
                + " | Stopper: общепортфельный "
                + kind
                + " ("
                + label
                + ") | ref="
                + referenceEquity.ToString(CultureInfo.InvariantCulture)
                + ", equity="
                + currentEquity.ToString(CultureInfo.InvariantCulture)
                + ", порог="
                + triggerLevel.ToString(CultureInfo.InvariantCulture)
                + ", закрыты все позиции, ref→"
                + postCloseEquity.ToString(CultureInfo.InvariantCulture)
                + (stopFully
                    ? ", Regime=Off"
                    : pauseAndResume
                        ? ", пауза реальной торговли (виртуальные L1…L10)"
                        : ", Regime без изменений")
                + ".";
            SendNewLogMessage(msg, LogMessageType.User);
            SendNewLogMessage(msg, LogMessageType.System);
            return true;
        }

        #endregion

        /// <summary>
        /// Обработчик закрытия свечи на вкладке скринера: при Regime=On запускает торговую логику.
        /// </summary>
        /// <param name="candles">Список свечей вкладки.</param>
        /// <param name="tab">Вкладка инструмента.</param>
        /// <summary>
        /// Обработчик закрытия свечи: в тестере — облегчённый путь (без attach индикаторов на UI);
        /// в лайве — полный цикл портфеля, stopper, ensure-индикаторов.
        /// </summary>
        private void ScreenerTab_CandleFinishedEvent(List<Candle> candles, BotTabSimple tab)
        {
            if (candles == null || candles.Count == 0 || tab == null)
            {
                return;
            }

            int candleIndex = candles.Count - 1;
            DateTime candleTime = candles[candleIndex].TimeStart;

            if (StartProgram == StartProgram.IsTester)
            {
                ScreenerTab_CandleFinishedEventInTester(candles, tab, candleIndex, candleTime);
                return;
            }

            ScreenerTab_CandleFinishedEventFull(candles, tab, candleIndex, candleTime);
        }

        /// <summary>
        /// Тестер: только торговля и редкое обновление справочного % годовых — без attach индикаторов и тяжёлого портфельного UI.
        /// </summary>
        private void ScreenerTab_CandleFinishedEventInTester(
            List<Candle> candles,
            BotTabSimple tab,
            int candleIndex,
            DateTime candleTime)
        {
            if (_metaLogicEnabled.ValueBool)
            {
                RefreshLogicPortfoliosOnCandle(tab, candles, candleIndex);
            }

            if (_regime.ValueString != "Off" && candles.Count >= GetMinBarsForTrading())
            {
                ProcessLogicTradingOnCandle(candles, tab, candleIndex);
            }

            TryFlushAggregatedCandlePortfolioDisplayIfComplete(tab, candleTime, candleIndex);
        }

        /// <summary>Лайв / оптимизатор: портфель, stopper; индикаторы — отложенно на UI (не с потока свечи).</summary>
        private void ScreenerTab_CandleFinishedEventFull(
            List<Candle> candles,
            BotTabSimple tab,
            int candleIndex,
            DateTime candleTime)
        {
            ScheduleEnsureRobotIndicatorsOnTabIfNeeded(tab, candleIndex);

            RefreshLogicPortfoliosOnCandle(tab, candles, candleIndex);

            if (_regime.ValueString != "Off" && candles.Count >= GetMinBarsForTrading())
            {
                ProcessLogicTradingOnCandle(candles, tab, candleIndex);
            }

            TryFlushAggregatedCandlePortfolioDisplayIfComplete(tab, candleTime, candleIndex);
        }

        /// <summary>Нужен ли пересчёт L1…L10 на свече (металогика, stopper или справочный % годовых).</summary>
        private bool NeedsLogicPortfolioTrackingOnCandle()
        {
            if (_metaLogicEnabled.ValueBool
                || IsPortfolioStopperActive()
                || IsStopperVirtualTradingActive()
                || (_useSignificantPeakTradingPause?.ValueBool ?? false))
            {
                return true;
            }

            if (IsStopperEodFlatSellConfigured())
            {
                return true;
            }

            return (_referenceInitialPortfolioAmount?.ValueDecimal ?? 0m) > 0m;
        }

        private bool IsPortfolioStopperActive()
        {
            return _usePortfolioStopLoss.ValueBool
                || _usePortfolioTakeProfit.ValueBool
                || (_usePortfolioPeakDrawdownStop?.ValueBool ?? false);
        }

        /// <summary>Equity Stopper / пауза после пика / фейк-торговля — на общей свече скринера.</summary>
        private bool ShouldRefreshStopperEquityOnAggregatedCandle()
        {
            return IsPortfolioStopperActive()
                || IsStopperVirtualTradingActive()
                || (_useSignificantPeakTradingPause?.ValueBool ?? false);
        }

        /// <summary>
        /// Торговый цикл на одной свече: SL/TP, выходы по Cl, входы по Op.
        /// Volume: поровну или по PnlSMA (когда металогика включена и PnlSMA готов).
        /// Max positions: металогика — приоритет по PnlSMA; иначе L1…L10.
        /// </summary>
        /// <param name="candles">Свечи вкладки.</param>
        /// <param name="tab">Вкладка инструмента.</param>
        /// <param name="candleIndex">Индекс текущей (закрытой) свечи.</param>
        private void ProcessLogicTradingOnCandle(List<Candle> candles, BotTabSimple tab, int candleIndex)
        {
            LogTradingModeDiagnosticsOnce(tab);

            for (int slotIndex = 1; slotIndex <= LogicSlotCount; slotIndex++)
            {
                LogicSlotRuntime runtime = _logicSlotRuntimes[slotIndex];
                if (runtime == null || !runtime.IsActive || runtime.ParseResult?.Root == null)
                {
                    continue;
                }

                if (IsStopperVirtualTradingActive()
                    && TryGetStopperVirtualPosition(tab, slotIndex, out StopperVirtualPosition virtualRegimePos)
                    && TryCloseStopperVirtualPositionForRegime(
                        tab,
                        virtualRegimePos,
                        slotIndex,
                        runtime,
                        candles,
                        candleIndex))
                {
                    continue;
                }

                Position regimePos = FindOpenLogicPosition(tab, slotIndex);
                if (regimePos != null
                    && TryCloseLogicPositionForRegime(tab, regimePos, slotIndex, runtime, candles, candleIndex))
                {
                    continue;
                }
            }

            for (int slotIndex = 1; slotIndex <= LogicSlotCount; slotIndex++)
            {
                LogicSlotRuntime runtime = _logicSlotRuntimes[slotIndex];
                if (runtime == null || !runtime.IsActive || runtime.ParseResult?.Root == null)
                {
                    continue;
                }

                if (IsStopperVirtualTradingActive())
                {
                    ProcessStopperVirtualPositionCloses(tab, candles, candleIndex, slotIndex, runtime);
                    continue;
                }

                Position openPos = FindOpenLogicPosition(tab, slotIndex);
                if (openPos == null)
                {
                    continue;
                }

                LogicStopTakeHit stopTakeHit = LogicStopTakeEvaluator.EvaluateStopTake(
                    runtime.ParseResult.Root,
                    tab,
                    candles,
                    candleIndex,
                    openPos,
                    FindIndicatorForAtom);

                if (stopTakeHit == LogicStopTakeHit.StopLoss)
                {
                    TryCloseLogicPosition(tab, openPos, slotIndex, "_SL");
                    continue;
                }

                if (stopTakeHit == LogicStopTakeHit.TakeProfit)
                {
                    TryCloseLogicPosition(tab, openPos, slotIndex, "_TP");
                    continue;
                }

                if (!EvaluateLogicCloseSignal(
                        runtime.ParseResult.Root,
                        tab,
                        candles,
                        candleIndex,
                        slotIndex))
                {
                    continue;
                }

                TryCloseLogicPosition(tab, openPos, slotIndex);
            }

            DateTime candleTime = candles[candleIndex].TimeStart;
            bool entryBlocked = IsStopperNewEntryBlocked(candleTime);
            if (entryBlocked)
            {
                LogStopperEodFlatBuyBlockedOnce(candleTime);
                LogSignificantPeakPauseBlockedOnce(candleTime);
            }

            var entryCandidates = new List<int>();
            if (!entryBlocked)
            {
                for (int slotIndex = 1; slotIndex <= LogicSlotCount; slotIndex++)
                {
                    LogicSlotRuntime runtime = _logicSlotRuntimes[slotIndex];
                    if (runtime == null || !runtime.IsActive || runtime.ParseResult?.Root == null)
                    {
                        continue;
                    }

                    if (FindOpenLogicPosition(tab, slotIndex) != null)
                    {
                        continue;
                    }

                    if (HasStopperVirtualPosition(tab, slotIndex))
                    {
                        continue;
                    }

                    if (!EvaluateLogicOpenSignal(
                            runtime.ParseResult.Root,
                            tab,
                            candles,
                            candleIndex,
                            slotIndex))
                    {
                        continue;
                    }

                    if (!AllowsRegimeEntry(slotIndex, runtime, tab, candles, candleIndex))
                    {
                        continue;
                    }

                    entryCandidates.Add(slotIndex);
                }
            }

            if (entryCandidates.Count == 0)
            {
                return;
            }

            bool metaLogicTradingActive = IsMetaLogicTradingActive();
            if (metaLogicTradingActive)
            {
                var preMetaFilterCandidates = new List<int>(entryCandidates);
                FilterMetaLogicEntryCandidates(entryCandidates);
                if (entryCandidates.Count == 0)
                {
                    LogMetaLogicEntryFilterSkip(preMetaFilterCandidates);
                    return;
                }
            }

            if (_metaLogicEnabled.ValueBool && !metaLogicTradingActive && !_loggedMetaLogicWarmupPending)
            {
                _loggedMetaLogicWarmupPending = true;
                SendNewLogMessage(
                    NameStrategyUniq
                    + " | Металогика включена, но PnlSMA ещё не готов (нужно "
                    + Math.Max(2, _portfolioAdjSmaLen.ValueInt)
                    + " точек истории на каждую активную логику; либо у всех PnlSMA=0 — ждём ненулевой equity) "
                    + "— до готовности входы как без металогики (Volume поровну, приоритет L1…L10).",
                    LogMessageType.System);
            }

            if (metaLogicTradingActive)
            {
                SortEntryCandidatesByPnlSmaDescending(entryCandidates);
            }

            decimal totalVolume = GetVolume(tab);
            if (totalVolume <= 0m)
            {
                LogZeroVolumeOnEntryOnce(tab);
                return;
            }

            int maxPositions = _maxPositions.ValueInt;
            if (maxPositions <= 0)
            {
                return;
            }

            int openCount = CountScreenerOpenPositions();
            int freeSlots = maxPositions - openCount;
            if (freeSlots <= 0)
            {
                if (!_loggedMaxPositionsLimit)
                {
                    _loggedMaxPositionsLimit = true;
                    SendNewLogMessage(
                        NameStrategyUniq
                        + " | лимит Max positions ("
                        + maxPositions
                        + ") — дальнейшие входы пропускаются (сообщение однократно).",
                        LogMessageType.System);
                }

                return;
            }

            int entriesToOpen = Math.Min(entryCandidates.Count, freeSlots);
            if (entriesToOpen < entryCandidates.Count)
            {
                var skipped = new List<string>();
                for (int i = entriesToOpen; i < entryCandidates.Count; i++)
                {
                    skipped.Add(entryCandidates[i].ToString(CultureInfo.InvariantCulture));
                }

                SendNewLogMessage(
                    NameStrategyUniq
                    + " | "
                    + tab.Connector?.SecurityName
                    + ": не хватает слотов позиций — пропущены логики "
                    + string.Join(", ", skipped)
                    + " ("
                    + (metaLogicTradingActive
                        ? "приоритет по PnlSMA, убывание"
                        : "приоритет по номеру логики")
                    + ").",
                    LogMessageType.System);
            }

            if (metaLogicTradingActive)
            {
                if (!_htmlReportMetaLogicReadyLogged)
                {
                    _htmlReportMetaLogicReadyLogged = true;
                    RecordHtmlReportMetaLogicReady(tab, candles[candleIndex].TimeStart);
                }

                OpenEntryCandidatesByMetaLogicPnlSma(
                    tab,
                    entryCandidates,
                    totalVolume,
                    entriesToOpen,
                    candles[candleIndex].TimeStart,
                    freeSlots);
                return;
            }

            var plainAllocWeights = new decimal[entriesToOpen];
            for (int i = 0; i < entriesToOpen; i++)
            {
                plainAllocWeights[i] = 1m;
            }

            decimal[] plainVolumes = AllocateVolumeByWeights(tab, totalVolume, plainAllocWeights, entriesToOpen);
            if (plainVolumes.All(v => v <= 0m))
            {
                return;
            }

            var plainLines = new List<HtmlReportMetaLogicAllocationLine>();
            int plainOpened = 0;
            for (int i = 0; i < entriesToOpen; i++)
            {
                int slotIndex = entryCandidates[i];
                LogicSlotRuntime runtime = _logicSlotRuntimes[slotIndex];
                decimal vol = plainVolumes[i];
                if (vol <= 0m)
                {
                    continue;
                }

                TryGetLogicPnlSmaMetrics(slotIndex, out decimal? pnlAvg, out decimal? pnlLast);
                plainLines.Add(new HtmlReportMetaLogicAllocationLine
                {
                    Rank = i + 1,
                    Slot = slotIndex,
                    LogicNote = GetLogicSlotHumanNote(slotIndex),
                    PnlSmaAvg = pnlAvg,
                    PnlSmaLast = pnlLast,
                    AbsWeightSharePct = entriesToOpen > 0 ? 100m / entriesToOpen : 0m,
                    Volume = vol,
                    Side = ResolveLogicOpenSide(runtime).ToString(),
                    Opened = true
                });
                TryOpenLogicPosition(tab, slotIndex, vol, ResolveLogicOpenSide(runtime));
                plainOpened++;
            }

            if (plainOpened == 0)
            {
                return;
            }

            RecordHtmlReportMetaLogicJournalEntry(
                tab,
                candles[candleIndex].TimeStart,
                _metaLogicEnabled.ValueBool ? "warmup" : "plain",
                entryCandidates,
                plainOpened,
                totalVolume,
                freeSlots,
                plainLines,
                _metaLogicEnabled.ValueBool
                    ? "Прогрев: Volume поровну, приоритет L1…L10 (PnlSMA ещё не готов)."
                    : "Металогика выкл.: Volume поровну, приоритет L1…L10.");
        }

        /// <summary>
        /// Минимальное число свечей на вкладке перед торговлей (по периодам индикаторов активных логик).
        /// </summary>
        /// <returns>Число баров с запасом +2.</returns>
        private int GetMinBarsForTrading()
        {
            int minBars = 30;
            for (int slotIndex = 1; slotIndex <= LogicSlotCount; slotIndex++)
            {
                LogicSlotRuntime runtime = _logicSlotRuntimes[slotIndex];
                if (runtime == null || !runtime.IsActive || runtime.ParseResult?.Root == null)
                {
                    continue;
                }

                List<LogicAtom> atoms = LogicLineParser.GetExpressionAtoms(runtime.ParseResult.Root);
                for (int i = 0; i < atoms.Count; i++)
                {
                    minBars = Math.Max(minBars, LogicSignalEvaluator.GetMinBarsRequired(atoms[i]));
                }
            }

            return minBars + 2;
        }

        /// <summary>Формирует SignalTypeOpen для позиции логики: MultiLogic_L{slotIndex}.</summary>
        /// <param name="logicSlotIndex">Номер слота 1…10.</param>
        private static string BuildLogicEntrySignal(int logicSlotIndex)
        {
            return LogicEntrySignalPrefix + logicSlotIndex.ToString(CultureInfo.InvariantCulture);
        }

        /// <summary>
        /// Ищет открытую позицию данного робота на вкладке, открытую по указанной логике.
        /// </summary>
        /// <param name="tab">Вкладка инструмента.</param>
        /// <param name="logicSlotIndex">Номер слота логики 1…10.</param>
        /// <returns>Позиция или null.</returns>
        private Position FindOpenLogicPosition(BotTabSimple tab, int logicSlotIndex)
        {
            if (tab?.PositionsOpenAll == null)
            {
                return null;
            }

            string signal = BuildLogicEntrySignal(logicSlotIndex);
            string botType = GetNameStrategyType();

            for (int i = 0; i < tab.PositionsOpenAll.Count; i++)
            {
                Position pos = tab.PositionsOpenAll[i];
                if (pos == null
                    || pos.State != PositionStateType.Open
                    || pos.OpenVolume <= 0m)
                {
                    continue;
                }

                if (!string.IsNullOrEmpty(pos.NameBotClass)
                    && !string.Equals(pos.NameBotClass, botType, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                if (string.Equals(pos.SignalTypeOpen, signal, StringComparison.OrdinalIgnoreCase))
                {
                    return pos;
                }
            }

            return null;
        }

        /// <summary>
        /// Считает все открытые позиции робота MultiLogic на всём скринере (все вкладки).
        /// </summary>
        /// <returns>Количество открытых позиций.</returns>
        private int CountScreenerOpenPositions()
        {
            if (IsStopperVirtualTradingActive())
            {
                return _stopperVirtualPositions.Count;
            }

            if (_screenerTab?.PositionsOpenAll == null)
            {
                return 0;
            }

            string botType = GetNameStrategyType();
            int count = 0;

            for (int i = 0; i < _screenerTab.PositionsOpenAll.Count; i++)
            {
                Position pos = _screenerTab.PositionsOpenAll[i];
                if (pos == null || pos.State != PositionStateType.Open || pos.OpenVolume <= 0m)
                {
                    continue;
                }

                if (!string.IsNullOrEmpty(pos.NameBotClass)
                    && !string.Equals(pos.NameBotClass, botType, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                count++;
            }

            return count;
        }

        /// <summary>
        /// Находит на вкладке экземпляр индикатора, соответствующий атому логики (по сигнатуре и номеру).
        /// </summary>
        /// <param name="tab">Вкладка инструмента.</param>
        /// <param name="atom">Атом разобранной логики.</param>
        /// <returns>Aindicator или null.</returns>
        private Aindicator FindIndicatorForAtom(BotTabSimple tab, LogicAtom atom)
        {
            if (atom == null || tab == null)
            {
                return null;
            }

            string signature = LogicLineParser.BuildIndicatorSignature(atom);
            if (!_indicatorSignatureToNum.TryGetValue(signature, out int num))
            {
                return null;
            }

            return FindIndicatorOnTab(tab, num, atom.IndicatorTypeName);
        }

        /// <summary>
        /// Ищет индикатор на вкладке по номеру и типу (имя = num+type+TabName скринера).
        /// </summary>
        /// <param name="tab">Вкладка инструмента.</param>
        /// <param name="num">Номер индикатора.</param>
        /// <param name="type">Тип индикатора OsEngine.</param>
        private Aindicator FindIndicatorOnTab(BotTabSimple tab, int num, string type)
        {
            if (tab?.Indicators == null || string.IsNullOrEmpty(type) || _screenerTab == null)
            {
                return null;
            }

            string expectedName = num + type + _screenerTab.TabName;
            for (int i = 0; i < tab.Indicators.Count; i++)
            {
                if (tab.Indicators[i] is Aindicator indicator
                    && string.Equals(indicator.Name, expectedName, StringComparison.Ordinal))
                {
                    return indicator;
                }
            }

            for (int i = 0; i < tab.Indicators.Count; i++)
            {
                if (tab.Indicators[i] is Aindicator indicator
                    && string.Equals(indicator.GetType().Name, type, StringComparison.OrdinalIgnoreCase))
                {
                    return indicator;
                }
            }

            return null;
        }

        /// <summary>
        /// Открывает позицию по логике: BuyAtMarket или SellAtMarket с сигналом MultiLogic_LN.
        /// </summary>
        /// <param name="tab">Вкладка инструмента.</param>
        /// <param name="logicSlotIndex">Номер слота 1…10.</param>
        /// <param name="volume">Объём заявки (уже разделённый между логиками).</param>
        /// <param name="entrySide">Buy — лонг, Sell — шорт.</param>
        private void TryOpenLogicPosition(BotTabSimple tab, int logicSlotIndex, decimal volume, Side entrySide)
        {
            if (tab == null || volume <= 0m)
            {
                return;
            }

            DateTime candleTime = tab.CandlesAll != null && tab.CandlesAll.Count > 0
                ? tab.CandlesAll[tab.CandlesAll.Count - 1].TimeStart
                : DateTime.Now;
            if (IsStopperNewEntryBlocked(candleTime))
            {
                return;
            }

            if (IsStopperVirtualTradingActive())
            {
                OpenStopperVirtualPosition(
                    tab,
                    logicSlotIndex,
                    volume,
                    entrySide,
                    BuildLogicEntrySignal(logicSlotIndex));
                return;
            }

            if (StartProgram == StartProgram.IsOsTrader
                && tab.Connector != null
                && (!tab.Connector.IsConnected || !tab.Connector.IsReadyToTrade))
            {
                return;
            }

            string signal = BuildLogicEntrySignal(logicSlotIndex);
            if (entrySide == Side.Sell)
            {
                tab.SellAtMarket(volume, signal);
            }
            else
            {
                tab.BuyAtMarket(volume, signal);
            }
        }

        /// <summary>
        /// Металогика: Volume делится между отобранными логиками пропорционально PnlSMA (полож.) или |PnlSMA| (отриц. при инверсии);
        /// Buy↔Sell только у логик с PnlSMA&lt;0 при включённой «Инверсии».
        /// </summary>
        private void OpenEntryCandidatesByMetaLogicPnlSma(
            BotTabSimple tab,
            List<int> entryCandidates,
            decimal totalVolume,
            int entriesToOpen,
            DateTime candleTime,
            int freeSlots)
        {
            if (tab == null || entryCandidates == null || entriesToOpen <= 0 || totalVolume <= 0m)
            {
                return;
            }

            var journalLines = new List<HtmlReportMetaLogicAllocationLine>();
            var weights = new decimal[entriesToOpen];
            var allocWeights = new decimal[entriesToOpen];
            for (int i = 0; i < entriesToOpen; i++)
            {
                int slotIndex = entryCandidates[i];
                decimal pnlWeight = TryGetLogicPnlSmaAllocationWeight(slotIndex, out decimal w) ? w : 0m;
                decimal allocWeight = GetMetaLogicAllocationWeight(pnlWeight);
                if (allocWeight <= 0m)
                {
                    allocWeight = 1m;
                }

                weights[i] = pnlWeight;
                allocWeights[i] = allocWeight;
            }

            decimal[] volumes = AllocateVolumeByWeights(tab, totalVolume, allocWeights, entriesToOpen);
            decimal sumAlloc = 0m;
            for (int i = 0; i < entriesToOpen; i++)
            {
                sumAlloc += allocWeights[i];
            }

            int openedCount = 0;
            for (int i = 0; i < entriesToOpen; i++)
            {
                int slotIndex = entryCandidates[i];
                LogicSlotRuntime runtime = _logicSlotRuntimes[slotIndex];
                decimal volume = volumes[i];
                Side entrySide = ResolveMetaOpenSide(runtime, weights[i]);
                bool opened = volume > 0m;
                if (opened)
                {
                    TryOpenLogicPosition(tab, slotIndex, volume, entrySide);
                    openedCount++;
                }

                TryGetLogicPnlSmaMetrics(slotIndex, out decimal? pnlAvg, out decimal? pnlLast);
                journalLines.Add(new HtmlReportMetaLogicAllocationLine
                {
                    Rank = i + 1,
                    Slot = slotIndex,
                    LogicNote = GetLogicSlotHumanNote(slotIndex),
                    PnlSmaAvg = pnlAvg,
                    PnlSmaLast = pnlLast,
                    AbsWeightSharePct = sumAlloc > 0m ? allocWeights[i] / sumAlloc * 100m : 0m,
                    Volume = opened ? volume : 0m,
                    Side = entrySide.ToString(),
                    Opened = opened
                });
            }

            if (openedCount == 0)
            {
                RecordHtmlReportMetaLogicJournalEntry(
                    tab,
                    candleTime,
                    "meta",
                    entryCandidates,
                    0,
                    totalVolume,
                    freeSlots,
                    journalLines,
                    "Металогика: Volume не удалось разделить (слишком малый объём на число логик).");
                return;
            }

            for (int i = entriesToOpen; i < entryCandidates.Count; i++)
            {
                int slotIndex = entryCandidates[i];
                TryGetLogicPnlSmaMetrics(slotIndex, out decimal? pnlAvg, out decimal? pnlLast);
                journalLines.Add(new HtmlReportMetaLogicAllocationLine
                {
                    Rank = i + 1,
                    Slot = slotIndex,
                    LogicNote = GetLogicSlotHumanNote(slotIndex),
                    PnlSmaAvg = pnlAvg,
                    PnlSmaLast = pnlLast,
                    Skipped = true
                });
            }

            RecordHtmlReportMetaLogicJournalEntry(
                tab,
                candleTime,
                "meta",
                entryCandidates,
                openedCount,
                totalVolume,
                freeSlots,
                journalLines,
                "Металогика: Volume по PnlSMA (полож.) / |PnlSMA| (отриц. при инверсии).");
        }

        /// <summary>Оставляет только логики, допустимые для мета-входа: PnlSMA&gt;0; при инверсии ещё PnlSMA&lt;0.</summary>
        private void FilterMetaLogicEntryCandidates(List<int> entryCandidates)
        {
            if (entryCandidates == null || entryCandidates.Count == 0)
            {
                return;
            }

            bool allowNegative = _metaLogicInversion.ValueBool;
            for (int i = entryCandidates.Count - 1; i >= 0; i--)
            {
                int slot = entryCandidates[i];
                if (!TryGetLogicPnlSmaAllocationWeight(slot, out decimal pnlWeight))
                {
                    entryCandidates.RemoveAt(i);
                    continue;
                }

                if (pnlWeight > 0m)
                {
                    continue;
                }

                if (pnlWeight < 0m && allowNegative)
                {
                    continue;
                }

                entryCandidates.RemoveAt(i);
            }
        }

        /// <summary>Вес для доли Volume: PnlSMA если &gt;0; |PnlSMA| если &lt;0 и инверсия включена.</summary>
        private decimal GetMetaLogicAllocationWeight(decimal pnlWeight)
        {
            if (pnlWeight > 0m)
            {
                return pnlWeight;
            }

            if (pnlWeight < 0m && _metaLogicInversion.ValueBool)
            {
                return Math.Abs(pnlWeight);
            }

            return 0m;
        }

        private bool IsMetaLogicInversionActive()
        {
            return IsMetaLogicTradingActive() && _metaLogicInversion.ValueBool;
        }

        /// <summary>
        /// Металогика реально применяется к входам только когда PnlSMA посчитан по каждой активной логике
        /// и хотя бы у одной PnlSMA ≠ 0 (иначе — прогрев, входы как без металогики).
        /// </summary>
        private bool IsMetaLogicTradingActive()
        {
            if (!_metaLogicEnabled.ValueBool || !_usePortfolioAdjSma.ValueBool)
            {
                return false;
            }

            int pnlLen = Math.Max(2, _portfolioAdjSmaLen.ValueInt);
            bool hasActiveLogic = false;
            bool anyNonZeroPnl = false;

            for (int slot = 1; slot <= LogicSlotCount; slot++)
            {
                LogicSlotRuntime runtime = _logicSlotRuntimes[slot];
                if (runtime == null
                    || !runtime.IsActive
                    || runtime.ParseResult?.Root == null
                    || runtime.ParseResult.IsDisabled)
                {
                    continue;
                }

                hasActiveLogic = true;
                if (_logicPortfolios[slot].History.Count < pnlLen)
                {
                    return false;
                }

                if (!TryGetLogicPnlSmaAllocationWeight(slot, out decimal weight))
                {
                    return false;
                }

                if (weight != 0m)
                {
                    anyNonZeroPnl = true;
                }
            }

            return hasActiveLogic && anyNonZeroPnl;
        }

        /// <summary>Диагностика: Op был, но после фильтра PnlSMA не осталось кандидатов.</summary>
        private void LogMetaLogicEntryFilterSkip(List<int> preFilterCandidates)
        {
            if (preFilterCandidates == null || preFilterCandidates.Count == 0)
            {
                return;
            }

            if (_lastMetaLogicFilterSkipLogWave == _aggregatedCandleWaveIndex)
            {
                return;
            }

            _lastMetaLogicFilterSkipLogWave = _aggregatedCandleWaveIndex;

            var parts = new List<string>();
            for (int i = 0; i < preFilterCandidates.Count; i++)
            {
                int slot = preFilterCandidates[i];
                if (TryGetLogicPnlSmaMetrics(slot, out decimal? avg, out decimal? last))
                {
                    parts.Add(
                        "L"
                        + slot
                        + " PnlSMA="
                        + avg.Value.ToString(CultureInfo.InvariantCulture)
                        + " (last="
                        + (last.HasValue ? last.Value.ToString(CultureInfo.InvariantCulture) : "?")
                        + ")");
                }
                else
                {
                    parts.Add("L" + slot + " PnlSMA=?");
                }
            }

            string inversionHint = _metaLogicInversion.ValueBool
                ? "Инверсия вкл. — допускаются PnlSMA<0 с Buy↔Sell и Op↔Cl."
                : "Инверсия выкл. — торгуются только L с PnlSMA>0; при всех ≤0 входы пропускаются.";

            SendNewLogMessage(
                NameStrategyUniq
                + " | Металогика: сигнал Op есть ("
                + string.Join(", ", parts)
                + "), но после фильтра PnlSMA кандидатов нет. "
                + inversionHint,
                LogMessageType.System);
        }

        /// <summary>
        /// По одной точке equity на активную логику за агрегированную свечу — накопление окна PnlSMA при включённой металогике.
        /// </summary>
        private void AppendMetaLogicWarmupPortfolioPoints(DateTime candleTime)
        {
            for (int slot = 1; slot <= LogicSlotCount; slot++)
            {
                LogicSlotRuntime runtime = _logicSlotRuntimes[slot];
                if (runtime == null
                    || !runtime.IsActive
                    || runtime.ParseResult?.Root == null
                    || runtime.ParseResult.IsDisabled)
                {
                    continue;
                }

                LogicPortfolioRuntime portfolio = _logicPortfolios[slot];
                if (portfolio.LastCandleTime == candleTime)
                {
                    continue;
                }

                AppendLogicPortfolioPoint(
                    slot,
                    "candle",
                    0m,
                    "",
                    "meta-equity",
                    candleTime);
                _logicPortfoliosDirty = true;
            }
        }

        /// <summary>
        /// Фактическая сторона открытия: «Инверсия логики» (вкладка «Логики»), затем инверсия PnlSMA&lt;0 (металогика).
        /// Вместе с <see cref="ShouldSwapEntryExitSignals"/> — как ApplyEntryExitSignalTransforms в TrendMultiIndicatorScreener.
        /// </summary>
        private Side ResolveLogicOpenSide(LogicSlotRuntime runtime, decimal? metaPnlWeight = null)
        {
            if (runtime == null)
            {
                return Side.Buy;
            }

            Side side = runtime.EntrySide;
            if (IsLogicSideInversionEnabled())
            {
                side = FlipEntrySide(side);
            }

            if (metaPnlWeight.HasValue && IsMetaLogicNegativeInversionSide(metaPnlWeight.Value))
            {
                side = FlipEntrySide(side);
            }

            return side;
        }

        private bool IsLogicSideInversionEnabled()
        {
            return ReadLogicSideInversionCurrent();
        }

        /// <summary>Buy/Sell на входе при металогике (с учётом «Инверсии логики» и PnlSMA&lt;0).</summary>
        private Side ResolveMetaOpenSide(LogicSlotRuntime runtime, decimal pnlWeight)
        {
            return ResolveLogicOpenSide(runtime, pnlWeight);
        }

        /// <summary>Фактическая сторона входа для Regime (учёт инверсий на открытии).</summary>
        private Side GetRegimeEntrySide(LogicSlotRuntime runtime, int logicSlotIndex)
        {
            decimal? metaWeight = null;
            if (IsMetaLogicTradingActive()
                && TryGetLogicPnlSmaAllocationWeight(logicSlotIndex, out decimal pnlWeight))
            {
                metaWeight = pnlWeight;
            }

            return ResolveLogicOpenSide(runtime, metaWeight);
        }

        private bool IsMetaLogicNegativeInversionSide(decimal pnlWeight)
        {
            return IsMetaLogicInversionActive() && pnlWeight < 0m;
        }

        /// <summary>Вес PnlSMA логики для инверсии металогики (null — металогика не активна).</summary>
        private decimal? TryGetMetaPnlWeightForSlot(int slotIndex)
        {
            if (!IsMetaLogicTradingActive())
            {
                return null;
            }

            if (TryGetLogicPnlSmaAllocationWeight(slotIndex, out decimal weight))
            {
                return weight;
            }

            return null;
        }

        /// <summary>
        /// Как в TrendMultiIndicatorScreener: при инверсии bull↔bear — вход по Cl[…], выход по Op[…], Buy↔Sell.
        /// </summary>
        private bool ShouldSwapEntryExitSignals(decimal? metaPnlWeight)
        {
            bool swap = IsLogicSideInversionEnabled();
            if (metaPnlWeight.HasValue && IsMetaLogicNegativeInversionSide(metaPnlWeight.Value))
            {
                swap = !swap;
            }

            return swap;
        }

        private bool ShouldSwapEntryExitSignals(int logicSlotIndex)
        {
            return ShouldSwapEntryExitSignals(TryGetMetaPnlWeightForSlot(logicSlotIndex));
        }

        /// <summary>Условие входа Op[…] с учётом инверсии логики (при инверсии — Cl[…]).</summary>
        private bool EvaluateLogicOpenSignal(
            LogicExpressionNode root,
            BotTabSimple tab,
            List<Candle> candles,
            int candleIndex,
            int logicSlotIndex)
        {
            decimal? metaPnlWeight = TryGetMetaPnlWeightForSlot(logicSlotIndex);
            if (ShouldSwapEntryExitSignals(metaPnlWeight))
            {
                return LogicExpressionEvaluator.EvaluateClose(
                    root,
                    tab,
                    candles,
                    candleIndex,
                    FindIndicatorForAtom);
            }

            return LogicExpressionEvaluator.EvaluateOpen(
                root,
                tab,
                candles,
                candleIndex,
                FindIndicatorForAtom);
        }

        /// <summary>Условие выхода Cl[…] с учётом инверсии логики (при инверсии — Op[…]).</summary>
        private bool EvaluateLogicCloseSignal(
            LogicExpressionNode root,
            BotTabSimple tab,
            List<Candle> candles,
            int candleIndex,
            int logicSlotIndex)
        {
            decimal? metaPnlWeight = TryGetMetaPnlWeightForSlot(logicSlotIndex);
            if (ShouldSwapEntryExitSignals(metaPnlWeight))
            {
                return LogicExpressionEvaluator.EvaluateOpen(
                    root,
                    tab,
                    candles,
                    candleIndex,
                    FindIndicatorForAtom);
            }

            return LogicExpressionEvaluator.EvaluateClose(
                root,
                tab,
                candles,
                candleIndex,
                FindIndicatorForAtom);
        }

        private static Side FlipEntrySide(Side side)
        {
            return side == Side.Buy ? Side.Sell : Side.Buy;
        }

        /// <summary>Вес PnlSMA логики для мета-распределения Volume (приведённое среднее по окну).</summary>
        private bool TryGetLogicPnlSmaAllocationWeight(int slot, out decimal weight)
        {
            weight = 0m;
            if (slot < 1 || slot > LogicSlotCount)
            {
                return false;
            }

            LogicPortfolioRuntime runtime = _logicPortfolios[slot];
            if (runtime.History.Count == 0)
            {
                return false;
            }

            int pnlLen = Math.Max(2, _portfolioAdjSmaLen.ValueInt);

            if (!_usePortfolioAdjSma.ValueBool)
            {
                return false;
            }

            var cfg = new MetaIndicatorConfig
            {
                UsePnlSma = true,
                PnlSmaLen = pnlLen
            };
            var meta = new MetaIndicatorValues();
            int index = runtime.History.Count - 1;
            MetaIndicatorEquityCalculator.CalculateAt(runtime.History, index, cfg, meta);

            if (!meta.PnlSmaAvg.HasValue)
            {
                return false;
            }

            weight = meta.PnlSmaAvg.Value;
            return true;
        }

        private bool TryGetLogicPnlSmaMetrics(int slot, out decimal? avg, out decimal? last)
        {
            avg = null;
            last = null;
            if (!TryGetLogicPnlSmaAllocationWeight(slot, out decimal weight))
            {
                return false;
            }

            avg = weight;
            LogicPortfolioRuntime runtime = _logicPortfolios[slot];
            if (runtime.History.Count == 0)
            {
                return true;
            }

            int pnlLen = Math.Max(2, _portfolioAdjSmaLen.ValueInt);
            var cfg = new MetaIndicatorConfig
            {
                UsePnlSma = true,
                PnlSmaLen = pnlLen
            };
            var meta = new MetaIndicatorValues();
            MetaIndicatorEquityCalculator.CalculateAt(runtime.History, runtime.History.Count - 1, cfg, meta);
            last = meta.PnlSmaLast;
            return true;
        }

        private string GetLogicSlotHumanNote(int slotIndex)
        {
            if (slotIndex < 1 || slotIndex > LogicSlotCount)
            {
                return "";
            }

            LogicSlotRuntime runtime = _logicSlotRuntimes[slotIndex];
            if (runtime?.ParseResult?.Root == null)
            {
                return "";
            }

            List<LogicAtom> atoms = LogicLineParser.GetExpressionAtoms(runtime.ParseResult.Root);
            for (int i = 0; i < atoms.Count; i++)
            {
                if (!string.IsNullOrWhiteSpace(atoms[i].Comment))
                {
                    return atoms[i].Comment.Trim();
                }
            }

            return "";
        }

        /// <summary>PnlSMA для приоритета Max positions (выше — раньше в очереди на вход).</summary>
        private decimal GetLogicPnlSmaPriorityScore(int slot)
        {
            return TryGetLogicPnlSmaAllocationWeight(slot, out decimal weight)
                ? weight
                : decimal.MinValue;
        }

        /// <summary>Сортирует кандидатов на вход: сначала больший PnlSMA, при равенстве — меньший номер L.</summary>
        private void SortEntryCandidatesByPnlSmaDescending(List<int> entryCandidates)
        {
            if (entryCandidates == null || entryCandidates.Count < 2)
            {
                return;
            }

            entryCandidates.Sort((slotA, slotB) =>
            {
                decimal scoreA = GetLogicPnlSmaPriorityScore(slotA);
                decimal scoreB = GetLogicPnlSmaPriorityScore(slotB);
                int byPnl = scoreB.CompareTo(scoreA);
                if (byPnl != 0)
                {
                    return byPnl;
                }

                return slotA.CompareTo(slotB);
            });
        }

        private Aindicator FindIndicatorForRegime(BotTabSimple tab, LogicRegimeSpec spec)
        {
            if (spec == null || tab == null)
            {
                return null;
            }

            LogicAtom probe = spec.CreateIndicatorProbeAtom();
            return FindIndicatorForAtom(tab, probe);
        }

        private bool TryCloseLogicPositionForRegime(
            BotTabSimple tab,
            Position pos,
            int logicSlotIndex,
            LogicSlotRuntime runtime,
            List<Candle> candles,
            int candleIndex)
        {
            LogicRegimeSpec spec = runtime?.ParseResult?.Regime;
            if (spec == null || pos == null)
            {
                return false;
            }

            if (!spec.CloseOnRegimeMismatch && !spec.EntryFlatOnly && !spec.CloseOnFlat)
            {
                return false;
            }

            Aindicator indicator = FindIndicatorForRegime(tab, spec);
            if (indicator == null)
            {
                return false;
            }

            int sign = LogicRegimeEvaluator.GetSign(spec, indicator, candleIndex);
            Side regimeSide = GetRegimeEntrySide(runtime, logicSlotIndex);
            if (!LogicRegimeEvaluator.ShouldCloseForRegime(spec, regimeSide, sign))
            {
                return false;
            }

            TryCloseLogicPosition(tab, pos, logicSlotIndex, "_RegimeFlip");
            return true;
        }

        private bool TryCloseStopperVirtualPositionForRegime(
            BotTabSimple tab,
            StopperVirtualPosition virtualPosition,
            int logicSlotIndex,
            LogicSlotRuntime runtime,
            List<Candle> candles,
            int candleIndex)
        {
            LogicRegimeSpec spec = runtime?.ParseResult?.Regime;
            if (spec == null || virtualPosition == null)
            {
                return false;
            }

            if (!spec.CloseOnRegimeMismatch && !spec.EntryFlatOnly && !spec.CloseOnFlat)
            {
                return false;
            }

            Aindicator indicator = FindIndicatorForRegime(tab, spec);
            if (indicator == null)
            {
                return false;
            }

            int sign = LogicRegimeEvaluator.GetSign(spec, indicator, candleIndex);
            Side regimeSide = GetRegimeEntrySide(runtime, logicSlotIndex);
            if (!LogicRegimeEvaluator.ShouldCloseForRegime(spec, regimeSide, sign))
            {
                return false;
            }

            CloseStopperVirtualPosition(tab, virtualPosition, logicSlotIndex, "_RegimeFlip");
            return true;
        }

        private bool AllowsRegimeEntry(
            int logicSlotIndex,
            LogicSlotRuntime runtime,
            BotTabSimple tab,
            List<Candle> candles,
            int candleIndex)
        {
            LogicRegimeSpec spec = runtime?.ParseResult?.Regime;
            if (spec == null || (!spec.BlockEntryBySide && !spec.EntryFlatOnly))
            {
                return true;
            }

            Aindicator indicator = FindIndicatorForRegime(tab, spec);
            if (indicator == null)
            {
                return false;
            }

            int sign = LogicRegimeEvaluator.GetSign(spec, indicator, candleIndex);
            return LogicRegimeEvaluator.AllowsEntry(spec, GetRegimeEntrySide(runtime, logicSlotIndex), sign);
        }

        /// <summary>
        /// Закрывает позицию логики по рынку или лимитом; отключает SL/TP ордера на позиции.
        /// </summary>
        /// <param name="tab">Вкладка инструмента.</param>
        /// <param name="pos">Открытая позиция.</param>
        /// <param name="logicSlotIndex">Номер слота для формирования SignalTypeClose.</param>
        /// <param name="closeReasonSuffix">Суффикс сигнала закрытия: _Close, _SL или _TP.</param>
        private void TryCloseLogicPosition(
            BotTabSimple tab,
            Position pos,
            int logicSlotIndex,
            string closeReasonSuffix = "_Close")
        {
            if (tab == null || pos == null || pos.OpenVolume <= 0m)
            {
                return;
            }

            if (IsStopperVirtualTradingActive())
            {
                return;
            }

            string closeSignal = BuildLogicEntrySignal(logicSlotIndex) + closeReasonSuffix;
            pos.SignalTypeClose = closeSignal;
            pos.ProfitOrderIsActive = false;
            pos.StopOrderIsActive = false;

            if (StartProgram == StartProgram.IsOsTrader
                && tab.Connector != null
                && (!tab.Connector.IsConnected || !tab.Connector.IsReadyToTrade))
            {
                return;
            }

            decimal volume = pos.OpenVolume;
            if (tab.Connector?.MarketOrdersIsSupport == true)
            {
                tab.CloseAtMarket(pos, volume, closeSignal);
                return;
            }

            decimal price = pos.Direction == Side.Buy ? tab.PriceBestBid : tab.PriceBestAsk;
            if (price <= 0m && tab.CandlesAll != null && tab.CandlesAll.Count > 0)
            {
                price = tab.CandlesAll[tab.CandlesAll.Count - 1].Close;
            }

            if (price <= 0m)
            {
                return;
            }

            tab.CloseAtLimit(pos, price, volume, closeSignal);
        }

        /// <summary>Округляет объём заявки по DecimalsVolume инструмента (или 6 знаков в тестере).</summary>
        /// <param name="tab">Вкладка с Security.</param>
        /// <param name="volume">Исходный объём.</param>
        private decimal RoundVolume(BotTabSimple tab, decimal volume)
        {
            if (tab == null || volume <= 0m)
            {
                return 0m;
            }

            if (StartProgram == StartProgram.IsOsTrader && tab.Security != null)
            {
                return Math.Round(volume, tab.Security.DecimalsVolume);
            }

            return Math.Round(volume, 6);
        }

        /// <summary>Минимальный шаг объёма (1 контракт или 10^-DecimalsVolume).</summary>
        private decimal GetVolumeQuantum(BotTabSimple tab)
        {
            if (tab?.Security != null && StartProgram == StartProgram.IsOsTrader)
            {
                int decimals = tab.Security.DecimalsVolume;
                if (decimals <= 0)
                {
                    return 1m;
                }

                return (decimal)Math.Pow(10, -decimals);
            }

            return 0.000001m;
        }

        /// <summary>
        /// Делит totalVolume между count слотами пропорционально weights (метод наибольших остатков),
        /// чтобы при целых лотах открывалось несколько позиций, а не одна «последняя».
        /// </summary>
        private decimal[] AllocateVolumeByWeights(
            BotTabSimple tab,
            decimal totalVolume,
            decimal[] weights,
            int count)
        {
            var volumes = new decimal[count];
            if (count <= 0 || totalVolume <= 0m || weights == null || weights.Length < count)
            {
                return volumes;
            }

            decimal sumWeights = 0m;
            for (int i = 0; i < count; i++)
            {
                if (weights[i] > 0m)
                {
                    sumWeights += weights[i];
                }
            }

            if (sumWeights <= 0m)
            {
                for (int i = 0; i < count; i++)
                {
                    weights[i] = 1m;
                }

                sumWeights = count;
            }

            decimal quantum = GetVolumeQuantum(tab);
            if (quantum <= 0m)
            {
                quantum = 1m;
            }

            long totalUnits = (long)Math.Floor(totalVolume / quantum + 0.0000001m);
            if (totalUnits <= 0)
            {
                return volumes;
            }

            var unitShares = new long[count];
            var fractions = new decimal[count];
            long assignedUnits = 0;
            for (int i = 0; i < count; i++)
            {
                decimal exactUnits = totalUnits * (weights[i] / sumWeights);
                long floorUnits = (long)Math.Floor(exactUnits);
                unitShares[i] = floorUnits;
                fractions[i] = exactUnits - floorUnits;
                assignedUnits += floorUnits;
            }

            long remainderUnits = totalUnits - assignedUnits;
            if (remainderUnits > 0)
            {
                var order = new int[count];
                for (int i = 0; i < count; i++)
                {
                    order[i] = i;
                }

                Array.Sort(order, (a, b) => fractions[b].CompareTo(fractions[a]));
                for (long r = 0; r < remainderUnits; r++)
                {
                    unitShares[order[(int)(r % count)]]++;
                }
            }

            for (int i = 0; i < count; i++)
            {
                volumes[i] = unitShares[i] * quantum;
            }

            return volumes;
        }

        /// <summary>
        /// Расчёт объёма заявки по параметрам Volume type / Volume / Asset in portfolio.
        /// Реальный портфель, тестер (StartPortfolio); эмулятор OsEngine — через стандартные заявки.
        /// </summary>
        private decimal GetVolume(BotTabSimple tab)
        {
            _lastVolumeCalcFailureReason = null;

            if (tab == null)
            {
                _lastVolumeCalcFailureReason = "вкладка=null";
                return 0m;
            }

            if (_volumeType.ValueString == "Contracts")
            {
                decimal volume = _volume.ValueDecimal;
                if (volume <= 0m)
                {
                    _lastVolumeCalcFailureReason = "Volume (Contracts) ≤ 0";
                }

                return volume;
            }

            if (_volumeType.ValueString == "Contract currency")
            {
                if (!TryResolveReferencePriceForVolume(tab, out decimal contractPrice))
                {
                    _lastVolumeCalcFailureReason = "нет цены (BestAsk/Bid/Close)=0";
                    return 0m;
                }

                decimal volume = _volume.ValueDecimal / contractPrice;

                if (StartProgram == StartProgram.IsOsTrader && tab.Security != null)
                {
                    IServerPermission serverPermission = ServerMaster.GetServerPermission(tab.Connector.ServerType);

                    if (serverPermission != null
                        && serverPermission.IsUseLotToCalculateProfit
                        && tab.Security.Lot != 0
                        && tab.Security.Lot > 1)
                    {
                        volume = _volume.ValueDecimal / (contractPrice * tab.Security.Lot);
                    }

                    volume = RoundVolume(tab, volume);
                }
                else
                {
                    volume = Math.Round(volume, 6);
                }

                return volume;
            }

            if (_volumeType.ValueString == "Deposit percent")
            {
                decimal? portfolioAsset = TryGetPortfolioPrimeAssetForVolume(tab);
                if (!portfolioAsset.HasValue || portfolioAsset.Value <= 0m)
                {
                    _lastVolumeCalcFailureReason = "портфель Prime/equity ≤ 0 ("
                        + (_tradeAssetInPortfolio?.ValueString ?? "Prime")
                        + ")";
                    SendNewLogMessage(
                        "Can`t found portfolio " + _tradeAssetInPortfolio.ValueString,
                        LogMessageType.Error);

                    return 0m;
                }

                if (!TryResolveReferencePriceForVolume(tab, out decimal referencePrice))
                {
                    _lastVolumeCalcFailureReason = "нет цены (BestAsk/Bid/Close)=0";
                    return 0m;
                }

                decimal moneyOnPosition = portfolioAsset.Value * (_volume.ValueDecimal / 100m);
                decimal lot = tab.Security?.Lot > 0m ? tab.Security.Lot : 1m;
                decimal qty = moneyOnPosition / referencePrice / lot;

                if (StartProgram == StartProgram.IsOsTrader
                    && tab.Security != null
                    && tab.Security.UsePriceStepCostToCalculateVolume
                    && tab.Security.PriceStep != tab.Security.PriceStepCost
                    && tab.Security.PriceStep != 0m
                    && tab.Security.PriceStepCost != 0m)
                {
                    qty = moneyOnPosition / (referencePrice / tab.Security.PriceStep * tab.Security.PriceStepCost);
                }

                return RoundVolume(tab, qty);
            }

            return 0m;
        }

        #region Trading: volume, tester, diagnostics

        private decimal? TryGetPortfolioPrimeAssetForVolume(BotTabSimple tab)
        {
            if (_tradeAssetInPortfolio.ValueString == "Prime")
            {
                decimal? real = TryGetRealMonitoredPortfolioValue(tab);
                if (real.HasValue && real.Value > 0m)
                {
                    return real;
                }

                return TryGetTesterPortfolioEquity(tab);
            }

            Portfolio myPortfolio = tab?.Portfolio ?? tab?.Connector?.Portfolio;
            if (myPortfolio == null)
            {
                return TryGetTesterPortfolioEquity(tab);
            }

            List<PositionOnBoard> positionOnBoard = myPortfolio.GetPositionOnBoard();
            if (positionOnBoard == null)
            {
                return TryGetTesterPortfolioEquity(tab);
            }

            for (int i = 0; i < positionOnBoard.Count; i++)
            {
                if (positionOnBoard[i].SecurityNameCode == _tradeAssetInPortfolio.ValueString)
                {
                    return positionOnBoard[i].ValueCurrent;
                }
            }

            return TryGetTesterPortfolioEquity(tab);
        }

        private decimal? TryGetRealMonitoredPortfolioValue(BotTabSimple tab)
        {
            if (ShouldReadPortfolioFromTesterServer(tab))
            {
                decimal? testerEquity = TryGetTesterPortfolioEquity(tab);
                if (testerEquity.HasValue && testerEquity.Value > 0m)
                {
                    return testerEquity;
                }
            }

            Portfolio portfolio = TryResolvePortfolioForMonitoring(tab);
            return TryGetFullPortfolioEquityFromPortfolioObject(portfolio);
        }

        /// <summary>
        /// Общая сумма реального портфеля для справочного % годовых (лайв ValueCurrent или тестер), не equity L1…L10.
        /// </summary>
        private decimal? TryGetRealPortfolioAmountForReference(BotTabSimple tab)
        {
            if (ShouldReadPortfolioFromTesterServer(tab))
            {
                decimal? fromTester = TryGetTesterPortfolioEquity(tab);
                if (fromTester.HasValue && fromTester.Value > 0m)
                {
                    return fromTester;
                }

                Portfolio connectorPortfolio = tab?.Connector?.Portfolio ?? tab?.Portfolio;
                decimal? fromConnector = TryGetFullPortfolioEquityFromPortfolioObject(connectorPortfolio);
                if (fromConnector.HasValue && fromConnector.Value > 0m)
                {
                    return fromConnector;
                }
            }

            decimal? realMonitored = TryGetRealMonitoredPortfolioValue(tab);
            if (realMonitored.HasValue && realMonitored.Value > 0m)
            {
                return realMonitored;
            }

            decimal? testerFallback = TryGetTesterPortfolioEquity(tab);
            if (testerFallback.HasValue && testerFallback.Value > 0m)
            {
                return testerFallback;
            }

            return null;
        }

        private bool ShouldReadPortfolioFromTesterServer(BotTabSimple tab)
        {
            if (StartProgram == StartProgram.IsTester || StartProgram == StartProgram.IsOsOptimizer)
            {
                return true;
            }

            return tab != null
                && (tab.StartProgram == StartProgram.IsTester
                    || tab.StartProgram == StartProgram.IsOsOptimizer);
        }

        /// <summary>Коннектор для мониторинга портфеля: вкладка → скринер → Tester/TInvest.</summary>
        private IServer ResolvePortfolioMonitoringServer(BotTabSimple tab)
        {
            IServer server = tab?.Connector?.MyServer;
            if (server != null)
            {
                return server;
            }

            if (_screenerTab?.Tabs != null)
            {
                for (int i = 0; i < _screenerTab.Tabs.Count; i++)
                {
                    server = _screenerTab.Tabs[i]?.Connector?.MyServer;
                    if (server != null)
                    {
                        return server;
                    }
                }
            }

            if (ShouldUseMoexTesterConnector())
            {
                return FindTesterLikeServer();
            }

            return FindServerForScreener() ?? FindTInvestServer();
        }

        /// <summary>Имя портфеля: настройки скринера, вкладка, иначе первый на сервере (Tester: GodMode).</summary>
        private string ResolvePortfolioMonitoringName(BotTabSimple tab, IServer server)
        {
            if (server != null)
            {
                if (!string.IsNullOrWhiteSpace(_screenerTab?.PortfolioName))
                {
                    Portfolio byScreener = server.GetPortfolioForName(_screenerTab.PortfolioName);
                    if (byScreener != null)
                    {
                        return byScreener.Number;
                    }
                }

                string tabPortfolioName = tab?.Connector?.PortfolioName;
                if (!string.IsNullOrWhiteSpace(tabPortfolioName))
                {
                    Portfolio byTab = server.GetPortfolioForName(tabPortfolioName);
                    if (byTab != null)
                    {
                        return byTab.Number;
                    }
                }

                if (server.Portfolios != null && server.Portfolios.Count > 0)
                {
                    return server.Portfolios[0].Number;
                }
            }

            if (ShouldUseMoexTesterConnector())
            {
                return "GodMode";
            }

            return _screenerTab?.PortfolioName ?? tab?.Connector?.PortfolioName;
        }

        private static Portfolio TryPickPortfolioOnServer(IServer server, string preferredName)
        {
            if (server?.Portfolios == null || server.Portfolios.Count == 0)
            {
                return null;
            }

            if (!string.IsNullOrWhiteSpace(preferredName))
            {
                Portfolio exact = server.GetPortfolioForName(preferredName);
                if (exact != null)
                {
                    return exact;
                }
            }

            for (int i = 0; i < server.Portfolios.Count; i++)
            {
                Portfolio portfolio = server.Portfolios[i];
                if (portfolio != null)
                {
                    return portfolio;
                }
            }

            return null;
        }

        private Portfolio TryResolvePortfolioForMonitoring(BotTabSimple tab)
        {
            if (ShouldReadPortfolioFromTesterServer(tab))
            {
                IServer testerServer = ResolvePortfolioMonitoringServer(tab) ?? FindTesterLikeServer();
                if (testerServer != null)
                {
                    Portfolio testerPortfolio = TryPickPortfolioOnServer(
                        testerServer,
                        ResolvePortfolioMonitoringName(tab, testerServer));
                    if (testerPortfolio != null)
                    {
                        return testerPortfolio;
                    }
                }
            }

            Portfolio portfolio = tab?.Connector?.Portfolio ?? tab?.Portfolio;
            if (portfolio != null)
            {
                return portfolio;
            }

            if (_screenerTab?.Tabs != null)
            {
                for (int i = 0; i < _screenerTab.Tabs.Count; i++)
                {
                    BotTabSimple childTab = _screenerTab.Tabs[i];
                    portfolio = childTab?.Connector?.Portfolio ?? childTab?.Portfolio;
                    if (portfolio != null)
                    {
                        return portfolio;
                    }
                }
            }

            IServer server = ResolvePortfolioMonitoringServer(tab) ?? FindTesterLikeServer();
            return TryPickPortfolioOnServer(server, ResolvePortfolioMonitoringName(tab, server));
        }

        /// <summary>
        /// Тестер: ValueCurrent после сделок; если GodMode ещё на заводском 1M — депозит из окна тестера (StartPortfolio).
        /// </summary>
        private static decimal? ResolveTesterPortfolioEquity(TesterServer testerServer, Portfolio portfolio)
        {
            if (testerServer == null)
            {
                return TryGetFullPortfolioEquityFromPortfolioObject(portfolio);
            }

            decimal startPortfolio = testerServer.StartPortfolio;
            decimal? fromPortfolio = TryGetFullPortfolioEquityFromPortfolioObject(portfolio);

            if (startPortfolio > 0m && fromPortfolio.HasValue && fromPortfolio.Value > 0m && portfolio != null)
            {
                bool portfolioStillAtBegin = Math.Abs(fromPortfolio.Value - portfolio.ValueBegin) < 0.01m;
                bool beginDiffersFromTesterDeposit = Math.Abs(portfolio.ValueBegin - startPortfolio) > 0.01m;
                if (portfolioStillAtBegin && beginDiffersFromTesterDeposit)
                {
                    return startPortfolio;
                }
            }

            if (fromPortfolio.HasValue && fromPortfolio.Value > 0m)
            {
                return fromPortfolio.Value;
            }

            return startPortfolio > 0m ? startPortfolio : null;
        }

        private static decimal? TryGetFullPortfolioEquityFromPortfolioObject(Portfolio portfolio)
        {
            if (portfolio == null)
            {
                return null;
            }

            if (portfolio.ValueCurrent > 0m)
            {
                return portfolio.ValueCurrent;
            }

            if (portfolio.ValueBegin > 0m)
            {
                return portfolio.ValueBegin;
            }

            return null;
        }

        /// <summary>Тестер/оптимизатор: ValueCurrent или StartPortfolio с подключённого TesterServer.</summary>
        private decimal? TryGetTesterPortfolioEquity(BotTabSimple tab)
        {
            if (StartProgram != StartProgram.IsTester && StartProgram != StartProgram.IsOsOptimizer)
            {
                return null;
            }

            IServer server = ResolvePortfolioMonitoringServer(tab) ?? FindTesterLikeServer();
            if (server == null)
            {
                return null;
            }

            Portfolio portfolio = TryPickPortfolioOnServer(server, ResolvePortfolioMonitoringName(tab, server));
            if (server is TesterServer testerServer)
            {
                return ResolveTesterPortfolioEquity(testerServer, portfolio);
            }

            if (server.ServerType == ServerType.Optimizer
                && server.Portfolios != null
                && server.Portfolios.Count > 0
                && portfolio == null)
            {
                portfolio = server.Portfolios[0];
            }

            return TryGetFullPortfolioEquityFromPortfolioObject(portfolio);
        }

        private static bool TryResolveReferencePriceForVolume(BotTabSimple tab, out decimal price)
        {
            price = 0m;
            if (tab == null)
            {
                return false;
            }

            if (tab.PriceBestAsk > 0m)
            {
                price = tab.PriceBestAsk;
                return true;
            }

            if (tab.PriceBestBid > 0m)
            {
                price = tab.PriceBestBid;
                return true;
            }

            if (tab.CandlesAll != null && tab.CandlesAll.Count > 0)
            {
                decimal close = tab.CandlesAll[tab.CandlesAll.Count - 1].Close;
                if (close > 0m)
                {
                    price = close;
                    return true;
                }
            }

            return false;
        }

        private void LogZeroVolumeOnEntryOnce(BotTabSimple tab)
        {
            string security = tab?.Connector?.SecurityName ?? tab?.TabName ?? "?";
            string reason = string.IsNullOrWhiteSpace(_lastVolumeCalcFailureReason)
                ? "неизвестно"
                : _lastVolumeCalcFailureReason;
            SendNewLogMessage(
                NameStrategyUniq
                + " [" + security + "]: объём входа = 0 — заявка не отправлена ("
                + reason
                + ").",
                LogMessageType.System);
        }

        private void LogTradingModeDiagnosticsOnce(BotTabSimple tab)
        {
            if (_loggedTradingModeDiagnostics)
            {
                return;
            }

            _loggedTradingModeDiagnostics = true;

            decimal? realPortfolio = TryGetRealMonitoredPortfolioValue(tab);
            if (!realPortfolio.HasValue || realPortfolio.Value <= 0m)
            {
                realPortfolio = TryGetTesterPortfolioEquity(tab);
            }

            string executionMode = StartProgram == StartProgram.IsTester ? "тестер"
                : StartProgram == StartProgram.IsOsOptimizer ? "оптимизатор"
                : (_screenerTab?.EmulatorIsOn == true || tab?.EmulatorIsOn == true || tab?.Connector?.EmulatorIsOn == true
                    ? "фейк OsEngine (EmulatorIsOn)"
                    : "лайв");

            string msg =
                NameStrategyUniq
                + " | диагностика: Regime="
                + (_regime?.ValueString ?? "?")
                + ", режим="
                + executionMode
                + ", портфель="
                + (realPortfolio.HasValue ? realPortfolio.Value.ToString(CultureInfo.InvariantCulture) : "—")
                + ", индикаторы робота=UI-поток (не поток свечи/коннектора)";

            if (StartProgram == StartProgram.IsOsTrader && tab?.Connector != null)
            {
                msg += ", коннектор="
                    + (tab.Connector.IsConnected ? "подключён" : "нет")
                    + ", торговля="
                    + (tab.Connector.IsReadyToTrade ? "готова" : "не готова")
                    + ", эмулятор OsEngine (EmulatorIsOn)="
                    + (_screenerTab?.EmulatorIsOn == true
                        || tab?.EmulatorIsOn == true
                        || tab?.Connector?.EmulatorIsOn == true
                        ? "вкл."
                        : "выкл.")
                    + " (заявки через ядро OsEngine, не «Фейковый режим 1» робота)";
            }

            SendNewLogMessage(msg, LogMessageType.System);
        }

        #endregion

        /// <summary>Возвращает текущие строки всех 10 слотов логики (для внешнего API / отладки).</summary>

        /// <summary>Переподписывает обработчики кнопок на вкладках MOEX (после пересоздания UI параметров).</summary>
        private void WireMoexTabButtons()
        {
            WireMoexTabButton("Установить префиксы фьючерсов по умолчанию", MoexFuturesResetPrefixesButton_UserClickOnButtonEvent);
            WireMoexTabButton(
                "Установить расширенный список префиксов фьючерсов по умолчанию",
                MoexFuturesExtendedResetPrefixesButton_UserClickOnButtonEvent);
            WireMoexTabButton("Обновить фьючерсы", MoexFuturesLoadButton_UserClickOnButtonEvent);
            WireMoexTabButton("Установить тикеры акций по умолчанию", MoexStockResetPrefixesButton_UserClickOnButtonEvent);
            WireMoexTabButton("Обновить акции", MoexStockLoadButton_UserClickOnButtonEvent);
        }

        private void WireMoexTabButton(string buttonName, Action handler)
        {
            WireLogicTabButton(buttonName, handler);
        }

        /// <summary>
        /// Сохранить значения из открытого окна параметров (как «Обновить»), без BotPanel.ApplyOpenParameterDialogEdits — совместимо со старой OsEngine.dll.
        /// </summary>
        private void ApplyPrefixesFromOpenParameterDialog()
        {
            if (!ParamGuiIsOpen)
            {
                return;
            }

            try
            {
                MethodInfo applyMethod = typeof(BotPanel).GetMethod(
                    "ApplyOpenParameterDialogEdits",
                    BindingFlags.Instance | BindingFlags.Public);
                if (applyMethod != null)
                {
                    applyMethod.Invoke(this, null);
                    return;
                }

                FieldInfo uiField = typeof(BotPanel).GetField(
                    "_parametersUi",
                    BindingFlags.Instance | BindingFlags.NonPublic);
                object uiObj = uiField?.GetValue(this);
                if (uiObj == null)
                {
                    return;
                }

                Type uiType = uiObj.GetType();
                MethodInfo saveAll = uiType.GetMethod(
                    "SaveEditedValuesFromGui",
                    BindingFlags.Instance | BindingFlags.Public);
                if (saveAll != null)
                {
                    saveAll.Invoke(uiObj, null);
                    return;
                }

                FieldInfo tabsField = uiType.GetField(
                    "_tabs",
                    BindingFlags.Instance | BindingFlags.NonPublic);
                if (tabsField?.GetValue(uiObj) is IList tabs)
                {
                    for (int i = 0; i < tabs.Count; i++)
                    {
                        object tab = tabs[i];
                        tab?.GetType().GetMethod("Save", BindingFlags.Instance | BindingFlags.Public)?.Invoke(tab, null);
                    }
                }
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        private void MoexFuturesResetPrefixesButton_UserClickOnButtonEvent()
        {
            ApplyMoexFuturesPrefixString(
                DefaultMoexFuturesTickerPrefixes,
                "Префиксы корня фьючерсов установлены по умолчанию (подбор бумаг не выполнялся).");
        }

        private void MoexFuturesExtendedResetPrefixesButton_UserClickOnButtonEvent()
        {
            ApplyMoexFuturesPrefixString(
                DefaultMyFuturesExtendedTickerPrefixes,
                "Расширенный список префиксов фьючерсов установлен по умолчанию (~100 корней, подбор бумаг не выполнялся).");
        }

        private void ApplyMoexFuturesPrefixString(string prefixes, string logMessage)
        {
            _moexFuturesTickerPrefixes.ValueString = prefixes;
            RepaintParameterGuiTables();
            SendNewLogMessage(logMessage, LogMessageType.System);
        }

        private void MoexStockResetPrefixesButton_UserClickOnButtonEvent()
        {
            _moexStockTickerPrefixes.ValueString = DefaultMoexStockTickerPrefixes;
            RepaintParameterGuiTables();
            SendNewLogMessage(
                "Тикеры акций установлены по умолчанию (подбор бумаг не выполнялся).",
                LogMessageType.System);
        }

        #region Logic portfolio per slot + JSON snapshot export/import

        private sealed class MetaIndicatorValues
        {
            public decimal? Sma;
            public decimal? StochK;
            public decimal? StochD;
            public decimal? Atr;
            public decimal? LinRegCenter;
            public decimal? LinRegUp;
            public decimal? LinRegDown;
            public decimal? MacdLine;
            public decimal? MacdSignal;
            /// <summary>Приведённое среднее PnlSMA: mean(E_i − E_start) по окну.</summary>
            public decimal? PnlSmaAvg;
            /// <summary>Последняя приведённая точка: E_end − E_start окна.</summary>
            public decimal? PnlSmaLast;
        }

        private sealed class MetaIndicatorConfig
        {
            public bool UseSma;
            public int SmaLen;
            public bool UseStoch;
            public int StochP1;
            public int StochP2;
            public int StochP3;
            public bool UseAtr;
            public int AtrLen;
            public bool UseLinReg;
            public int LinRegLen;
            public decimal LinRegDev;
            public bool UseMacd;
            public int MacdFastLen;
            public int MacdSlowLen;
            public int MacdSignalLen;
            public bool UsePnlSma;
            public int PnlSmaLen;

            public bool HasAnyEnabled =>
                UseSma || UseStoch || UseAtr || UseLinReg || UseMacd || UsePnlSma;
        }

        private sealed class StopperVirtualPosition
        {
            public string TabKey = "";
            public int LogicSlot;
            public Side Direction;
            public decimal EntryPrice;
            public decimal Volume;
            public DateTime OpenTime;
            public string SignalTypeOpen = "";
        }

        private sealed class LogicPortfolioPoint
        {
            public long Seq;
            public DateTime EventTimeUtc;
            public DateTime CandleTime;
            public string Event = "";
            public decimal Delta;
            public decimal Equity;
            public decimal Realized;
            public decimal Unrealized;
            public string TabKey = "";
            public string Note = "";
            public MetaIndicatorValues Meta = new MetaIndicatorValues();
        }

        private sealed class LogicPortfolioRuntime
        {
            public decimal Realized;
            public decimal Unrealized;
            public decimal Equity => Realized + Unrealized;
            public long LastSeq;
            public DateTime LastCandleTime = DateTime.MinValue;
            public DateTime LastSaveUtc = DateTime.MinValue;
            public readonly List<LogicPortfolioPoint> History = new List<LogicPortfolioPoint>();
        }

        private sealed class AggregateMetaPortfolioRuntime
        {
            public long LastSeq;
            public DateTime LastCandleTime = DateTime.MinValue;
            public DateTime LastSaveUtc = DateTime.MinValue;
            public readonly List<LogicPortfolioPoint> History = new List<LogicPortfolioPoint>();
        }

        private sealed class MultiLogicSnapshotFile
        {
            public string FormatVersion = MultiLogicSnapshotFormatVersion;
            public string RobotType = "MultiLogic";
            public string StrategyName = "";
            public DateTime SavedAtUtc;
            public Dictionary<string, string> Parameters = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            public string[] LogicLines = Array.Empty<string>();
            public LogicPortfolioSnapshotDto[] LogicPortfolios = Array.Empty<LogicPortfolioSnapshotDto>();
            public AggregateMetaPortfolioSnapshotDto AggregateMetaPortfolio;
            public MultiLogicPositionSnapshotDto[] OpenPositions = Array.Empty<MultiLogicPositionSnapshotDto>();
        }

        /// <summary>JSON-файл только со строками «Логика 1…10» (кнопки «Выгрузить/Загрузить логику»).</summary>
        private sealed class MultiLogicLogicExportFile
        {
            public string FormatVersion = MultiLogicLogicFileFormatVersion;
            public string RobotType = "MultiLogic";
            public string StrategyName = "";
            public DateTime ExportedAtUtc;
            public string[] LogicLines = Array.Empty<string>();
        }

        private sealed class LogicPortfolioSnapshotDto
        {
            public int Slot;
            public decimal Realized;
            public decimal Unrealized;
            public long LastSeq;
            public LogicPortfolioPointDto[] History = Array.Empty<LogicPortfolioPointDto>();
        }

        private sealed class LogicPortfolioPointDto
        {
            public long Seq;
            public DateTime EventTimeUtc;
            public DateTime CandleTime;
            public string Event = "";
            public decimal Delta;
            public decimal Equity;
            public decimal Realized;
            public decimal Unrealized;
            public string TabKey = "";
            public string Note = "";
            public MetaIndicatorValuesDto Meta;
        }

        private sealed class MetaIndicatorValuesDto
        {
            public decimal? Sma;
            public decimal? StochK;
            public decimal? StochD;
            public decimal? Atr;
            public decimal? LinRegCenter;
            public decimal? LinRegUp;
            public decimal? LinRegDown;
            public decimal? MacdLine;
            public decimal? MacdSignal;
            public decimal? PnlSmaAvg;
            public decimal? PnlSmaLast;
        }

        private sealed class AggregateMetaPortfolioSnapshotDto
        {
            public long LastSeq;
            public LogicPortfolioPointDto[] History = Array.Empty<LogicPortfolioPointDto>();
        }

        private sealed class MultiLogicPositionSnapshotDto
        {
            public string TabKey = "";
            public int LogicSlot;
            public string Direction = "";
            public decimal EntryPrice;
            public decimal Volume;
            public DateTime OpenTime;
            public string SignalTypeOpen = "";
            public int PositionNumber;
        }

        private void SaveSnapshotButton_UserClickOnButtonEvent()
        {
            try
            {
                if (!TryPromptSaveJsonFile(out string path))
                {
                    return;
                }

                MultiLogicSnapshotFile snapshot = BuildMultiLogicSnapshot();
                string json = JsonConvert.SerializeObject(snapshot, Formatting.Indented);
                File.WriteAllText(path, json, new UTF8Encoding(false));
                MaybeSaveLogicPortfolios(force: true);

                string msg = NameStrategyUniq + " | JSON-снимок сохранён: " + path;
                SendNewLogMessage(msg, LogMessageType.User);
                SendNewLogMessage(msg, LogMessageType.System);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        private void LoadSnapshotButton_UserClickOnButtonEvent()
        {
            try
            {
                if (!TryPromptOpenJsonFile(out string path))
                {
                    return;
                }

                string json = File.ReadAllText(path, Encoding.UTF8);
                MultiLogicSnapshotFile snapshot = JsonConvert.DeserializeObject<MultiLogicSnapshotFile>(json);
                if (snapshot == null)
                {
                    SendNewLogMessage(NameStrategyUniq + " | JSON-снимок: пустой файл.", LogMessageType.Error);
                    return;
                }

                if (!string.Equals(snapshot.FormatVersion, MultiLogicSnapshotFormatVersion, StringComparison.Ordinal)
                    && !string.Equals(snapshot.FormatVersion, "1", StringComparison.Ordinal))
                {
                    SendNewLogMessage(
                        NameStrategyUniq
                        + " | JSON-снимок: неподдерживаемая версия "
                        + snapshot.FormatVersion,
                        LogMessageType.Error);
                    return;
                }

                ApplyMultiLogicSnapshot(snapshot);
                MaybeSaveLogicPortfolios(force: true);
                SaveParametersWithoutLogicIndicatorResync();
                RequestParameterGuiRepaintOnce();
                RunOnUiThread(
                    () => TryParseAndApplyAllLogicSlots(logToUser: true),
                    preferAsync: true);

                string msg = NameStrategyUniq + " | JSON-снимок загружен: " + path;
                SendNewLogMessage(msg, LogMessageType.User);
                SendNewLogMessage(msg, LogMessageType.System);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        private void ExportLogicsButton_UserClickOnButtonEvent()
        {
            try
            {
                if (!TryPromptSaveLogicFile(out string path))
                {
                    return;
                }

                ApplyPrefixesFromOpenParameterDialog();
                MultiLogicLogicExportFile exportFile = BuildMultiLogicLogicExportFile();
                string json = JsonConvert.SerializeObject(exportFile, Formatting.Indented);
                File.WriteAllText(path, json, new UTF8Encoding(false));

                string msg = NameStrategyUniq + " | Логики выгружены в файл: " + path;
                SendNewLogMessage(msg, LogMessageType.User);
                SendNewLogMessage(msg, LogMessageType.System);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        private void ImportLogicsButton_UserClickOnButtonEvent()
        {
            try
            {
                if (!TryPromptOpenLogicFile(out string path))
                {
                    return;
                }

                string json = File.ReadAllText(path, Encoding.UTF8);
                if (!TryParseLogicLinesFromJson(json, out string[] logicLines, out string error))
                {
                    SendNewLogMessage(
                        NameStrategyUniq + " | Загрузка логики: " + (error ?? "неизвестная ошибка."),
                        LogMessageType.Error);
                    return;
                }

                ApplyLogicSlotStringsImmediate(logicLines, logParseToUser: true);

                string msg = NameStrategyUniq + " | Логики загружены из файла: " + path;
                SendNewLogMessage(msg, LogMessageType.User);
                SendNewLogMessage(msg, LogMessageType.System);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        private MultiLogicLogicExportFile BuildMultiLogicLogicExportFile()
        {
            return new MultiLogicLogicExportFile
            {
                StrategyName = NameStrategyUniq,
                ExportedAtUtc = DateTime.UtcNow,
                LogicLines = CaptureLogicLines()
            };
        }

        private bool TryParseLogicLinesFromJson(string json, out string[] logicLines, out string error)
        {
            logicLines = null;
            error = null;

            if (string.IsNullOrWhiteSpace(json))
            {
                error = "пустой файл";
                return false;
            }

            MultiLogicLogicExportFile exportFile = JsonConvert.DeserializeObject<MultiLogicLogicExportFile>(json);
            if (exportFile?.LogicLines != null && exportFile.LogicLines.Length == LogicSlotCount)
            {
                if (!string.IsNullOrWhiteSpace(exportFile.FormatVersion)
                    && !string.Equals(exportFile.FormatVersion, MultiLogicLogicFileFormatVersion, StringComparison.Ordinal))
                {
                    error = "неподдерживаемая версия " + exportFile.FormatVersion;
                    return false;
                }

                logicLines = exportFile.LogicLines;
                return true;
            }

            MultiLogicSnapshotFile snapshot = JsonConvert.DeserializeObject<MultiLogicSnapshotFile>(json);
            if (snapshot?.LogicLines != null && snapshot.LogicLines.Length == LogicSlotCount)
            {
                logicLines = snapshot.LogicLines;
                return true;
            }

            error = "файл не содержит ровно " + LogicSlotCount + " строк logicLines («Логика 1…10»)";
            return false;
        }

        private bool TryPromptSaveLogicFile(out string path)
        {
            path = null;
            try
            {
                string selectedPath = null;
                RunOnUiThread(() =>
                {
                    var dialog = new SaveFileDialog
                    {
                        Filter = "MultiLogic logics (*.json)|*.json|All files (*.*)|*.*",
                        FileName = NameStrategyUniq + "_MultiLogicLogics.json",
                        DefaultExt = ".json",
                        InitialDirectory = AppDomain.CurrentDomain.BaseDirectory
                    };
                    if (dialog.ShowDialog() == true)
                    {
                        selectedPath = dialog.FileName;
                    }
                });
                path = selectedPath;
                return !string.IsNullOrWhiteSpace(path);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
                return false;
            }
        }

        private bool TryPromptOpenLogicFile(out string path)
        {
            path = null;
            try
            {
                string selectedPath = null;
                RunOnUiThread(() =>
                {
                    var dialog = new OpenFileDialog
                    {
                        Filter =
                            "MultiLogic logics (*.json)|*.json|MultiLogic snapshot (*.json)|*.json|All files (*.*)|*.*",
                        InitialDirectory = AppDomain.CurrentDomain.BaseDirectory
                    };
                    if (dialog.ShowDialog() == true)
                    {
                        selectedPath = dialog.FileName;
                    }
                });
                path = selectedPath;
                return !string.IsNullOrWhiteSpace(path);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
                return false;
            }
        }

        private bool TryPromptSaveJsonFile(out string path)
        {
            path = null;
            try
            {
                string selectedPath = null;
                RunOnUiThread(() =>
                {
                    var dialog = new SaveFileDialog
                    {
                        Filter = "MultiLogic JSON (*.json)|*.json|All files (*.*)|*.*",
                        FileName = NameStrategyUniq + "_MultiLogicSnapshot.json",
                        DefaultExt = ".json",
                        InitialDirectory = AppDomain.CurrentDomain.BaseDirectory
                    };
                    if (dialog.ShowDialog() == true)
                    {
                        selectedPath = dialog.FileName;
                    }
                });
                path = selectedPath;
                return !string.IsNullOrWhiteSpace(path);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
                return false;
            }
        }

        private bool TryPromptOpenJsonFile(out string path)
        {
            path = null;
            try
            {
                string selectedPath = null;
                RunOnUiThread(() =>
                {
                    var dialog = new OpenFileDialog
                    {
                        Filter = "MultiLogic JSON (*.json)|*.json|All files (*.*)|*.*",
                        InitialDirectory = AppDomain.CurrentDomain.BaseDirectory
                    };
                    if (dialog.ShowDialog() == true)
                    {
                        selectedPath = dialog.FileName;
                    }
                });
                path = selectedPath;
                return !string.IsNullOrWhiteSpace(path);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
                return false;
            }
        }

        private static void RunOnUiThread(Action action, bool preferAsync = false)
        {
            if (action == null)
            {
                return;
            }

            System.Windows.Threading.Dispatcher dispatcher = System.Windows.Application.Current?.Dispatcher;
            if (dispatcher == null)
            {
                action();
                return;
            }

            if (dispatcher.CheckAccess())
            {
                action();
                return;
            }

            if (preferAsync)
            {
                dispatcher.BeginInvoke(action, System.Windows.Threading.DispatcherPriority.Background);
            }
            else
            {
                dispatcher.Invoke(action);
            }
        }

        private MultiLogicSnapshotFile BuildMultiLogicSnapshot()
        {
            var snapshot = new MultiLogicSnapshotFile
            {
                StrategyName = NameStrategyUniq,
                SavedAtUtc = DateTime.UtcNow,
                Parameters = CaptureParameterValues(),
                LogicLines = CaptureLogicLines(),
                LogicPortfolios = BuildLogicPortfolioSnapshotDtos(),
                AggregateMetaPortfolio = BuildAggregateMetaPortfolioSnapshotDto(),
                OpenPositions = CaptureOpenPositionSnapshots()
            };
            return snapshot;
        }

        private void ApplyMultiLogicSnapshot(MultiLogicSnapshotFile snapshot)
        {
            if (snapshot.LogicLines != null && snapshot.LogicLines.Length == LogicSlotCount)
            {
                for (int i = 0; i < LogicSlotCount; i++)
                {
                    StrategyParameterString param = ResolveLogicParameter(i + 1);
                    if (param != null)
                    {
                        param.ValueString = snapshot.LogicLines[i] ?? "";
                    }
                }
            }

            if (snapshot.Parameters != null)
            {
                ApplyParameterValues(snapshot.Parameters);
            }

            if (snapshot.LogicPortfolios != null)
            {
                for (int i = 0; i < snapshot.LogicPortfolios.Length; i++)
                {
                    ApplyLogicPortfolioSnapshotDto(snapshot.LogicPortfolios[i]);
                }
            }

            if (snapshot.AggregateMetaPortfolio != null)
            {
                ApplyAggregateMetaPortfolioSnapshotDto(snapshot.AggregateMetaPortfolio);
            }

            if (snapshot.OpenPositions != null && snapshot.OpenPositions.Length > 0)
            {
                SaveOpenPositionsCompanionFile(snapshot.OpenPositions);
                SendNewLogMessage(
                    NameStrategyUniq
                    + " | JSON-снимок: сохранено "
                    + snapshot.OpenPositions.Length
                    + " открытых позиций (справочно; заявки на биржу не выставлялись).",
                    LogMessageType.System);
            }

            _logicPortfoliosDirty = true;
            CheckAndWarnMultiLogicResources(force: true);
            RefreshPreviousAcceptBackupSnapshot();
        }

        private void SaveOpenPositionsCompanionFile(MultiLogicPositionSnapshotDto[] positions)
        {
            if (StartProgram == StartProgram.IsTester || positions == null)
            {
                return;
            }

            try
            {
                string path = Path.Combine("Engine", NameStrategyUniq + "_OpenPositionsSnapshot.json");
                string json = JsonConvert.SerializeObject(positions, Formatting.Indented);
                File.WriteAllText(path, json, new UTF8Encoding(false));
            }
            catch (Exception ex)
            {
                SendNewLogMessage(
                    NameStrategyUniq + " | не удалось сохранить снимок позиций: " + ex.Message,
                    LogMessageType.Error);
            }
        }

        private Dictionary<string, string> CaptureParameterValues()
        {
            var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (Parameters == null)
            {
                return dict;
            }

            for (int i = 0; i < Parameters.Count; i++)
            {
                IIStrategyParameter param = Parameters[i];
                if (param == null || param is StrategyParameterButton)
                {
                    continue;
                }

                dict[param.Name] = GetParameterValueAsString(param);
            }

            return dict;
        }

        private static string GetParameterValueAsString(IIStrategyParameter param)
        {
            switch (param)
            {
                case StrategyParameterString s:
                    return s.ValueString ?? "";
                case StrategyParameterInt ii:
                    return ii.ValueInt.ToString(CultureInfo.InvariantCulture);
                case StrategyParameterDecimal dec:
                    return dec.ValueDecimal.ToString(CultureInfo.InvariantCulture);
                case StrategyParameterBool b:
                    return b.ValueBool.ToString(CultureInfo.InvariantCulture);
                case StrategyParameterTimeOfDay t:
                    return t.Value.ToString();
                default:
                    return "";
            }
        }

        private void ApplyParameterValues(Dictionary<string, string> values)
        {
            if (Parameters == null || values == null)
            {
                return;
            }

            for (int i = 0; i < Parameters.Count; i++)
            {
                IIStrategyParameter param = Parameters[i];
                if (param == null
                    || param is StrategyParameterButton
                    || !values.TryGetValue(param.Name, out string raw))
                {
                    continue;
                }

                if (param.Name.StartsWith("Логика ", StringComparison.Ordinal))
                {
                    continue;
                }

                switch (param)
                {
                    case StrategyParameterString s:
                        s.ValueString = raw;
                        break;
                    case StrategyParameterInt ii when int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out int iv):
                        ii.ValueInt = iv;
                        break;
                    case StrategyParameterDecimal dec when decimal.TryParse(raw, NumberStyles.Number, CultureInfo.InvariantCulture, out decimal dv):
                        dec.ValueDecimal = dv;
                        break;
                    case StrategyParameterBool b when bool.TryParse(raw, out bool bv):
                        b.ValueBool = bv;
                        break;
                }
            }
        }

        private string[] CaptureLogicLines()
        {
            var lines = new string[LogicSlotCount];
            for (int slot = 1; slot <= LogicSlotCount; slot++)
            {
                StrategyParameterString param = ResolveLogicParameter(slot);
                lines[slot - 1] = param?.ValueString ?? "";
            }

            return lines;
        }

        private LogicPortfolioSnapshotDto[] BuildLogicPortfolioSnapshotDtos()
        {
            var list = new LogicPortfolioSnapshotDto[LogicSlotCount];
            for (int slot = 1; slot <= LogicSlotCount; slot++)
            {
                LogicPortfolioRuntime runtime = _logicPortfolios[slot];
                list[slot - 1] = ToLogicPortfolioSnapshotDto(slot, runtime);
            }

            return list;
        }

        private static LogicPortfolioSnapshotDto ToLogicPortfolioSnapshotDto(int slot, LogicPortfolioRuntime runtime)
        {
            if (runtime == null)
            {
                return new LogicPortfolioSnapshotDto { Slot = slot };
            }

            var dto = new LogicPortfolioSnapshotDto
            {
                Slot = slot,
                Realized = runtime.Realized,
                Unrealized = runtime.Unrealized,
                LastSeq = runtime.LastSeq
            };

            if (runtime.History.Count == 0)
            {
                return dto;
            }

            LogicPortfolioPoint[] historySnapshot = runtime.History.ToArray();
            var points = new LogicPortfolioPointDto[historySnapshot.Length];
            for (int i = 0; i < historySnapshot.Length; i++)
            {
                LogicPortfolioPoint p = historySnapshot[i];
                points[i] = new LogicPortfolioPointDto
                {
                    Seq = p.Seq,
                    EventTimeUtc = p.EventTimeUtc,
                    CandleTime = p.CandleTime,
                    Event = p.Event,
                    Delta = p.Delta,
                    Equity = p.Equity,
                    Realized = p.Realized,
                    Unrealized = p.Unrealized,
                    TabKey = p.TabKey,
                    Note = p.Note,
                    Meta = ToMetaIndicatorValuesDto(p.Meta)
                };
            }

            dto.History = points;
            return dto;
        }

        private void ApplyLogicPortfolioSnapshotDto(LogicPortfolioSnapshotDto dto)
        {
            if (dto == null || dto.Slot < 1 || dto.Slot > LogicSlotCount)
            {
                return;
            }

            LogicPortfolioRuntime runtime = _logicPortfolios[dto.Slot];
            runtime.Realized = dto.Realized;
            runtime.Unrealized = dto.Unrealized;
            runtime.LastSeq = dto.LastSeq;
            runtime.History.Clear();

            if (dto.History != null)
            {
                for (int i = 0; i < dto.History.Length; i++)
                {
                    LogicPortfolioPointDto p = dto.History[i];
                    if (p == null)
                    {
                        continue;
                    }

                    runtime.History.Add(new LogicPortfolioPoint
                    {
                        Seq = p.Seq,
                        EventTimeUtc = p.EventTimeUtc,
                        CandleTime = p.CandleTime,
                        Event = p.Event ?? "",
                        Delta = p.Delta,
                        Equity = p.Equity,
                        Realized = p.Realized,
                        Unrealized = p.Unrealized,
                        TabKey = p.TabKey ?? "",
                        Note = p.Note ?? "",
                        Meta = FromMetaIndicatorValuesDto(p.Meta)
                    });
                }

                runtime.LastCandleTime = runtime.History.Count > 0
                    ? runtime.History[runtime.History.Count - 1].CandleTime
                    : DateTime.MinValue;
            }

            RecalculateLogicPortfolioMetaHistory(dto.Slot);
        }

        private MultiLogicPositionSnapshotDto[] CaptureOpenPositionSnapshots()
        {
            var list = new List<MultiLogicPositionSnapshotDto>();
            if (_screenerTab?.Tabs == null)
            {
                return list.ToArray();
            }

            string botType = GetNameStrategyType();
            for (int t = 0; t < _screenerTab.Tabs.Count; t++)
            {
                BotTabSimple tab = _screenerTab.Tabs[t];
                if (tab?.PositionsOpenAll == null)
                {
                    continue;
                }

                List<Position> openPositionsSnapshot = tab.PositionsOpenAll.ToList();
                for (int i = 0; i < openPositionsSnapshot.Count; i++)
                {
                    Position pos = openPositionsSnapshot[i];
                    if (pos == null
                        || !IsOurMultiLogicOpenPosition(pos, botType)
                        || !TryParseLogicSlotFromSignal(pos.SignalTypeOpen, out int slot))
                    {
                        continue;
                    }

                    list.Add(new MultiLogicPositionSnapshotDto
                    {
                        TabKey = GetLogicPortfolioTabKey(tab),
                        LogicSlot = slot,
                        Direction = pos.Direction.ToString(),
                        EntryPrice = pos.EntryPrice,
                        Volume = pos.OpenVolume,
                        OpenTime = pos.TimeOpen,
                        SignalTypeOpen = pos.SignalTypeOpen,
                        PositionNumber = pos.Number
                    });
                }
            }

            return list.ToArray();
        }

        private void ScreenerTab_PositionOpeningSuccesEvent(Position position, BotTabSimple tab)
        {
            if (position == null
                || tab == null
                || position.State != PositionStateType.Open
                || !TryParseLogicSlotFromSignal(position.SignalTypeOpen, out int slot))
            {
                return;
            }

            if (!string.IsNullOrEmpty(position.NameBotClass)
                && !string.Equals(position.NameBotClass, GetNameStrategyType(), StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            DateTime candleTime = tab.CandlesAll != null && tab.CandlesAll.Count > 0
                ? tab.CandlesAll[tab.CandlesAll.Count - 1].TimeStart
                : DateTime.Now;

            RecalculateLogicPortfolioUnrealized(slot);
            AppendLogicPortfolioPoint(
                slot,
                "open",
                0m,
                GetLogicPortfolioTabKey(tab),
                position.SignalTypeOpen,
                candleTime);
            SyncAggregateMetaPortfolioPoint(tab, candleTime, "open", position.SignalTypeOpen);
            RecordHtmlReportTradeEvent(
                slot,
                isOpen: true,
                tabKey: GetLogicPortfolioTabKey(tab),
                note: position.SignalTypeOpen,
                delta: 0m,
                candleTime: candleTime,
                positionOpenTime: position.TimeOpen,
                positionCloseTime: null);
            _logicPortfoliosDirty = true;
        }

        private void ScreenerTab_PositionClosingSuccesEvent(Position position, BotTabSimple tab)
        {
            if (position == null
                || tab == null
                || !TryParseLogicSlotFromSignal(position.SignalTypeOpen, out int slot))
            {
                return;
            }

            if (!string.IsNullOrEmpty(position.NameBotClass)
                && !string.Equals(position.NameBotClass, GetNameStrategyType(), StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            decimal exitPrice = position.ClosePrice;
            if (exitPrice <= 0m && tab.CandlesAll != null && tab.CandlesAll.Count > 0)
            {
                exitPrice = tab.CandlesAll[tab.CandlesAll.Count - 1].Close;
            }

            decimal entry = position.EntryPrice;
            if (entry <= 0m && exitPrice > 0m)
            {
                entry = exitPrice;
            }

            decimal profit = CalculateLogicPortfolioProfitAbs(tab, position.Direction, entry, exitPrice, position.MaxVolume);
            _logicPortfolios[slot].Realized += profit;

            DateTime candleTime = tab.CandlesAll != null && tab.CandlesAll.Count > 0
                ? tab.CandlesAll[tab.CandlesAll.Count - 1].TimeStart
                : DateTime.Now;

            DateTime closeTime = position.TimeClose;
            if (closeTime == default || closeTime <= position.TimeOpen)
            {
                closeTime = candleTime;
            }

            RecalculateLogicPortfolioUnrealized(slot);
            AppendLogicPortfolioPoint(
                slot,
                "close",
                profit,
                GetLogicPortfolioTabKey(tab),
                position.SignalTypeClose,
                candleTime);
            SyncAggregateMetaPortfolioPoint(tab, candleTime, "close", position.SignalTypeClose);
            RecordHtmlReportTradeEvent(
                slot,
                isOpen: false,
                tabKey: GetLogicPortfolioTabKey(tab),
                note: position.SignalTypeClose,
                delta: profit,
                candleTime: candleTime,
                positionOpenTime: position.TimeOpen,
                positionCloseTime: closeTime);
            _logicPortfoliosDirty = true;
        }

        private void RefreshLogicPortfoliosOnCandle(BotTabSimple tab, List<Candle> candles, int candleIndex)
        {
            if (tab == null || candles == null || candleIndex < 0 || candleIndex >= candles.Count)
            {
                return;
            }

            DateTime candleTime = candles[candleIndex].TimeStart;
            for (int slot = 1; slot <= LogicSlotCount; slot++)
            {
                decimal prevEquity = _logicPortfolios[slot].Equity;
                decimal newEquity = _logicPortfolios[slot].Equity;
                decimal delta = newEquity - prevEquity;

                if (Math.Abs(delta) < LogicPortfolioCandleMinDelta)
                {
                    continue;
                }

                AppendLogicPortfolioPoint(
                    slot,
                    "candle",
                    delta,
                    GetLogicPortfolioTabKey(tab),
                    "mtm",
                    candleTime);
                _logicPortfoliosDirty = true;
            }

            RefreshAggregateMetaPortfolioOnCandle(tab, candleTime);
        }

        private void RecalculateLogicPortfolioUnrealized(int slot)
        {
            if (slot < 1 || slot > LogicSlotCount)
            {
                return;
            }

            decimal unrealized = 0m;
            string botType = GetNameStrategyType();

            if (_screenerTab?.Tabs != null)
            {
                for (int t = 0; t < _screenerTab.Tabs.Count; t++)
                {
                    BotTabSimple tab = _screenerTab.Tabs[t];
                    if (tab?.PositionsOpenAll == null)
                    {
                        continue;
                    }

                    for (int i = 0; i < tab.PositionsOpenAll.Count; i++)
                    {
                        Position pos = tab.PositionsOpenAll[i];
                        if (!IsOurMultiLogicOpenPosition(pos, botType)
                            || !TryParseLogicSlotFromSignal(pos.SignalTypeOpen, out int posSlot)
                            || posSlot != slot)
                        {
                            continue;
                        }

                        unrealized += CalculateLogicPortfolioUnrealizedAbs(tab, pos);
                    }
                }
            }

            if (IsStopperVirtualTradingActive())
            {
                foreach (KeyValuePair<string, StopperVirtualPosition> kvp in _stopperVirtualPositions)
                {
                    StopperVirtualPosition virtualPosition = kvp.Value;
                    if (virtualPosition == null || virtualPosition.LogicSlot != slot)
                    {
                        continue;
                    }

                    BotTabSimple virtualTab = TryFindScreenerTabByPortfolioKey(virtualPosition.TabKey);
                    if (virtualTab == null)
                    {
                        continue;
                    }

                    unrealized += CalculateStopperVirtualUnrealizedAbs(virtualTab, virtualPosition);
                }
            }

            _logicPortfolios[slot].Unrealized = unrealized;
        }

        private BotTabSimple TryFindScreenerTabByPortfolioKey(string tabKey)
        {
            if (string.IsNullOrWhiteSpace(tabKey) || _screenerTab?.Tabs == null)
            {
                return null;
            }

            for (int t = 0; t < _screenerTab.Tabs.Count; t++)
            {
                BotTabSimple tab = _screenerTab.Tabs[t];
                if (string.Equals(GetLogicPortfolioTabKey(tab), tabKey.Trim(), StringComparison.OrdinalIgnoreCase))
                {
                    return tab;
                }
            }

            return null;
        }

        private decimal CalculateStopperVirtualUnrealizedAbs(
            BotTabSimple tab,
            StopperVirtualPosition virtualPosition)
        {
            if (virtualPosition == null || virtualPosition.EntryPrice <= 0m || virtualPosition.Volume <= 0m)
            {
                return 0m;
            }

            decimal mark = GetMarkPriceForStopperVirtual(
                tab,
                virtualPosition.Direction == Side.Buy ? Side.Sell : Side.Buy);
            if (mark <= 0m)
            {
                return 0m;
            }

            return CalculateLogicPortfolioProfitAbs(
                tab,
                virtualPosition.Direction,
                virtualPosition.EntryPrice,
                mark,
                virtualPosition.Volume);
        }

        private void AppendLogicPortfolioPoint(
            int slot,
            string eventName,
            decimal delta,
            string tabKey,
            string note,
            DateTime candleTime)
        {
            LogicPortfolioRuntime runtime = _logicPortfolios[slot];
            runtime.LastSeq++;
            var point = new LogicPortfolioPoint
            {
                Seq = runtime.LastSeq,
                EventTimeUtc = DateTime.UtcNow,
                CandleTime = candleTime,
                Event = eventName ?? "",
                Delta = delta,
                Equity = runtime.Equity,
                Realized = runtime.Realized,
                Unrealized = runtime.Unrealized,
                TabKey = tabKey ?? "",
                Note = note ?? ""
            };

            runtime.History.Add(point);
            TrimLogicPortfolioHistory(runtime);
            runtime.LastCandleTime = candleTime;
            TryCalculateMetaIndicatorsForPoint(slot, point);
        }

        private static void TrimLogicPortfolioHistory(LogicPortfolioRuntime runtime)
        {
            if (runtime == null)
            {
                return;
            }

            while (runtime.History.Count > LogicPortfolioHistoryCap)
            {
                runtime.History.RemoveAt(0);
            }
        }

        private void EnsureLogicPortfolioInitPoints()
        {
            for (int slot = 1; slot <= LogicSlotCount; slot++)
            {
                LogicPortfolioRuntime runtime = _logicPortfolios[slot];
                if (runtime.History.Count > 0)
                {
                    continue;
                }

                runtime.LastSeq = 1;
                var initPoint = new LogicPortfolioPoint
                {
                    Seq = 1,
                    EventTimeUtc = DateTime.UtcNow,
                    CandleTime = DateTime.UtcNow,
                    Event = "init",
                    Delta = 0m,
                    Equity = 0m,
                    Realized = 0m,
                    Unrealized = 0m,
                    Note = "init"
                };
                runtime.History.Add(initPoint);
                TryCalculateMetaIndicatorsForPoint(slot, initPoint);
                _logicPortfoliosDirty = true;
            }
        }

        private string GetLogicPortfolioFilePath(int slot)
        {
            return Path.Combine(
                "Engine",
                NameStrategyUniq + LogicPortfolioFileSuffix + slot.ToString(CultureInfo.InvariantCulture) + ".txt");
        }

        private void LoadLogicPortfoliosFromDisk()
        {
            if (StartProgram == StartProgram.IsTester)
            {
                EnsureLogicPortfolioInitPoints();
                return;
            }

            for (int slot = 1; slot <= LogicSlotCount; slot++)
            {
                LoadLogicPortfolioFromDisk(slot);
            }

            LoadAggregateMetaPortfolioFromDisk();
            EnsureLogicPortfolioInitPoints();
        }

        private void LoadLogicPortfolioFromDisk(int slot)
        {
            string path = GetLogicPortfolioFilePath(slot);
            if (!File.Exists(path))
            {
                return;
            }

            try
            {
                LogicPortfolioRuntime runtime = _logicPortfolios[slot];
                runtime.History.Clear();
                using StreamReader reader = new StreamReader(path, Encoding.UTF8);
                string version = reader.ReadLine();
                if (!string.Equals(version, "v1", StringComparison.Ordinal)
                    && !string.Equals(version, "v2", StringComparison.Ordinal))
                {
                    return;
                }

                string stateLine = reader.ReadLine();
                ParseLogicPortfolioStateLine(stateLine, runtime);

                reader.ReadLine();
                string headerLine = reader.ReadLine();
                if (string.Equals(version, "v2", StringComparison.Ordinal)
                    && headerLine != null
                    && headerLine.StartsWith("METAHDR|", StringComparison.Ordinal))
                {
                    headerLine = reader.ReadLine();
                }

                while (!reader.EndOfStream)
                {
                    string line = reader.ReadLine();
                    if (string.IsNullOrWhiteSpace(line)
                        || line.StartsWith("seq|", StringComparison.Ordinal))
                    {
                        continue;
                    }

                    LogicPortfolioPoint point = ParseLogicPortfolioHistoryLine(line);
                    if (point != null)
                    {
                        runtime.History.Add(point);
                    }
                }

                TrimLogicPortfolioHistory(runtime);
                RecalculateLogicPortfolioMetaHistory(slot);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(
                    NameStrategyUniq + " | портфель L" + slot + ": ошибка чтения: " + ex.Message,
                    LogMessageType.Error);
            }
        }

        private static void ParseLogicPortfolioStateLine(string line, LogicPortfolioRuntime runtime)
        {
            if (runtime == null || string.IsNullOrWhiteSpace(line) || !line.StartsWith("STATE|", StringComparison.Ordinal))
            {
                return;
            }

            string[] parts = line.Split('|');
            if (parts.Length < 4)
            {
                return;
            }

            decimal.TryParse(parts[1], NumberStyles.Number, CultureInfo.InvariantCulture, out runtime.Realized);
            decimal.TryParse(parts[2], NumberStyles.Number, CultureInfo.InvariantCulture, out runtime.Unrealized);
            long.TryParse(parts[3], NumberStyles.Integer, CultureInfo.InvariantCulture, out runtime.LastSeq);
        }

        private static LogicPortfolioPoint ParseLogicPortfolioHistoryLine(string line)
        {
            string[] p = line.Split('|');
            if (p.Length < 9)
            {
                return null;
            }

            if (!long.TryParse(p[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out long seq))
            {
                return null;
            }

            DateTime.TryParse(p[1], CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTime eventUtc);
            DateTime.TryParse(p[2], CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTime candleTime);
            decimal.TryParse(p[4], NumberStyles.Number, CultureInfo.InvariantCulture, out decimal delta);
            decimal.TryParse(p[5], NumberStyles.Number, CultureInfo.InvariantCulture, out decimal equity);
            decimal.TryParse(p[6], NumberStyles.Number, CultureInfo.InvariantCulture, out decimal realized);
            decimal.TryParse(p[7], NumberStyles.Number, CultureInfo.InvariantCulture, out decimal unrealized);

            return new LogicPortfolioPoint
            {
                Seq = seq,
                EventTimeUtc = eventUtc,
                CandleTime = candleTime,
                Event = p[3],
                Delta = delta,
                Equity = equity,
                Realized = realized,
                Unrealized = unrealized,
                TabKey = p.Length > 8 ? p[8] : "",
                Note = p.Length > 9 ? p[9] : "",
                Meta = ParseMetaIndicatorFields(p, 10)
            };
        }

        private void SaveLogicPortfolioToDisk(int slot)
        {
            if (StartProgram == StartProgram.IsTester)
            {
                return;
            }

            LogicPortfolioRuntime runtime = _logicPortfolios[slot];
            string path = GetLogicPortfolioFilePath(slot);
            string directory = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
            {
                Directory.CreateDirectory(directory);
            }

            using StreamWriter writer = new StreamWriter(path, false, new UTF8Encoding(false));
            MetaIndicatorConfig metaConfig = BuildLpMetaIndicatorConfig(slot);
            bool writeMeta = metaConfig.HasAnyEnabled;
            writer.WriteLine(writeMeta ? "v2" : "v1");
            writer.WriteLine(
                "STATE|"
                + runtime.Realized.ToString(CultureInfo.InvariantCulture)
                + "|"
                + runtime.Unrealized.ToString(CultureInfo.InvariantCulture)
                + "|"
                + runtime.LastSeq.ToString(CultureInfo.InvariantCulture)
                + "|"
                + runtime.LastCandleTime.ToString("O", CultureInfo.InvariantCulture)
                + "|"
                + DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture));
            writer.WriteLine("CAP|" + LogicPortfolioHistoryCap.ToString(CultureInfo.InvariantCulture));
            if (writeMeta)
            {
                writer.WriteLine(BuildMetaHistoryHeaderLine());
            }

            writer.WriteLine(writeMeta
                ? "seq|eventUtc|candleTime|event|delta|equity|realized|unrealized|tab|note|meta"
                : "seq|eventUtc|candleTime|event|delta|equity|realized|unrealized|tab|note");

            for (int i = 0; i < runtime.History.Count; i++)
            {
                LogicPortfolioPoint point = runtime.History[i];
                writer.Write(point.Seq.ToString(CultureInfo.InvariantCulture));
                writer.Write("|");
                writer.Write(point.EventTimeUtc.ToString("O", CultureInfo.InvariantCulture));
                writer.Write("|");
                writer.Write(point.CandleTime.ToString("O", CultureInfo.InvariantCulture));
                writer.Write("|");
                writer.Write(point.Event);
                writer.Write("|");
                writer.Write(point.Delta.ToString(CultureInfo.InvariantCulture));
                writer.Write("|");
                writer.Write(point.Equity.ToString(CultureInfo.InvariantCulture));
                writer.Write("|");
                writer.Write(point.Realized.ToString(CultureInfo.InvariantCulture));
                writer.Write("|");
                writer.Write(point.Unrealized.ToString(CultureInfo.InvariantCulture));
                writer.Write("|");
                writer.Write(point.TabKey);
                writer.Write("|");
                writer.Write(point.Note);
                if (writeMeta)
                {
                    writer.Write("|");
                    writer.Write(SerializeMetaIndicatorValues(point.Meta));
                }

                writer.WriteLine();
            }

            runtime.LastSaveUtc = DateTime.UtcNow;
        }

        private void MaybeSaveLogicPortfolios(bool force)
        {
            if (!_logicPortfoliosDirty && !force)
            {
                return;
            }

            if (!force && StartProgram == StartProgram.IsTester)
            {
                return;
            }

            DateTime now = DateTime.UtcNow;
            if (!force
                && _logicPortfoliosLastSaveTime != DateTime.MinValue
                && (now - _logicPortfoliosLastSaveTime).TotalSeconds < LogicPortfolioSaveIntervalSeconds)
            {
                return;
            }

            for (int slot = 1; slot <= LogicSlotCount; slot++)
            {
                SaveLogicPortfolioToDisk(slot);
            }

            SaveAggregateMetaPortfolioToDisk();

            _logicPortfoliosLastSaveTime = now;
            _logicPortfoliosDirty = false;
            CheckAndWarnMultiLogicResources(force: false);
        }

        private static bool IsOurMultiLogicOpenPosition(Position pos, string botType)
        {
            if (pos == null || pos.State != PositionStateType.Open || pos.OpenVolume <= 0m)
            {
                return false;
            }

            if (!string.IsNullOrEmpty(pos.NameBotClass)
                && !string.Equals(pos.NameBotClass, botType, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            return TryParseLogicSlotFromSignal(pos.SignalTypeOpen, out _);
        }

        private static bool TryParseLogicSlotFromSignal(string signal, out int slot)
        {
            slot = 0;
            if (string.IsNullOrWhiteSpace(signal)
                || !signal.StartsWith(LogicEntrySignalPrefix, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            string tail = signal.Substring(LogicEntrySignalPrefix.Length);
            int digitCount = 0;
            while (digitCount < tail.Length && char.IsDigit(tail[digitCount]))
            {
                digitCount++;
            }

            if (digitCount == 0)
            {
                return false;
            }

            if (!int.TryParse(tail.Substring(0, digitCount), NumberStyles.Integer, CultureInfo.InvariantCulture, out slot))
            {
                return false;
            }

            return slot >= 1 && slot <= LogicSlotCount;
        }

        private static string GetLogicPortfolioTabKey(BotTabSimple tab)
        {
            if (tab == null)
            {
                return "";
            }

            if (!string.IsNullOrWhiteSpace(tab.Connector?.SecurityName))
            {
                return tab.Connector.SecurityName.Trim();
            }

            if (tab.Security != null && !string.IsNullOrWhiteSpace(tab.Security.Name))
            {
                return tab.Security.Name.Trim();
            }

            return tab.TabName ?? "";
        }

        private decimal CalculateLogicPortfolioUnrealizedAbs(BotTabSimple tab, Position pos)
        {
            if (pos == null || pos.EntryPrice <= 0m || pos.OpenVolume <= 0m)
            {
                return 0m;
            }

            Side closeSide = pos.Direction == Side.Buy ? Side.Sell : Side.Buy;
            decimal mark = closeSide == Side.Sell ? tab.PriceBestBid : tab.PriceBestAsk;
            if (mark <= 0m && tab.CandlesAll != null && tab.CandlesAll.Count > 0)
            {
                mark = tab.CandlesAll[tab.CandlesAll.Count - 1].Close;
            }

            if (mark <= 0m)
            {
                return 0m;
            }

            return CalculateLogicPortfolioProfitAbs(tab, pos.Direction, pos.EntryPrice, mark, pos.OpenVolume);
        }

        private decimal CalculateLogicPortfolioProfitAbs(
            BotTabSimple tab,
            Side direction,
            decimal entryPrice,
            decimal exitPrice,
            decimal volume)
        {
            if (volume <= 0m || entryPrice <= 0m || exitPrice <= 0m)
            {
                return 0m;
            }

            if (tab?.Security == null)
            {
                decimal raw = direction == Side.Buy ? exitPrice - entryPrice : entryPrice - exitPrice;
                return raw * volume;
            }

            Security security = tab.Security;
            decimal profitOperationAbs = direction == Side.Buy
                ? exitPrice - entryPrice
                : entryPrice - exitPrice;

            decimal priceStep = security.PriceStep > 0m ? security.PriceStep : 0m;
            decimal priceStepCost = security.PriceStepCost > 0m ? security.PriceStepCost : 1m;
            decimal lots = security.Lot > 0m ? security.Lot : 1m;

            IServerPermission permission = StartProgram == StartProgram.IsOsTrader && tab.Connector != null
                ? ServerMaster.GetServerPermission(tab.Connector.ServerType)
                : null;
            bool isLotServer = permission != null && permission.IsUseLotToCalculateProfit;

            if (isLotServer)
            {
                if (priceStep != 0m)
                {
                    return (profitOperationAbs / priceStep) * priceStepCost * volume * lots;
                }

                return profitOperationAbs * priceStepCost * volume * lots;
            }

            if (priceStep != 0m)
            {
                return (profitOperationAbs / priceStep) * priceStepCost * volume;
            }

            return profitOperationAbs * priceStepCost * volume;
        }

        #region Meta-indicator calculation and persistence

        private MetaIndicatorConfig BuildLpMetaIndicatorConfig(int slot)
        {
            return BuildAggregateMetaIndicatorConfig();
        }

        private MetaIndicatorConfig BuildAggregateMetaIndicatorConfig()
        {
            return new MetaIndicatorConfig
            {
                UseSma = _usePortfolioSma.ValueBool,
                SmaLen = _portfolioSmaLen.ValueInt,
                UseStoch = _usePortfolioStoch.ValueBool,
                StochP1 = _portfolioStochP1.ValueInt,
                StochP2 = _portfolioStochP2.ValueInt,
                StochP3 = _portfolioStochP3.ValueInt,
                UseAtr = _usePortfolioAtr.ValueBool,
                AtrLen = _portfolioAtrLen.ValueInt,
                UseLinReg = _usePortfolioLinReg.ValueBool,
                LinRegLen = _portfolioLinRegLen.ValueInt,
                LinRegDev = _portfolioLinRegDev.ValueDecimal,
                UseMacd = _usePortfolioMacd.ValueBool,
                MacdFastLen = _portfolioMacdFastLen.ValueInt,
                MacdSlowLen = _portfolioMacdSlowLen.ValueInt,
                MacdSignalLen = _portfolioMacdSignalLen.ValueInt,
                UsePnlSma = _usePortfolioAdjSma.ValueBool,
                PnlSmaLen = _portfolioAdjSmaLen.ValueInt
            };
        }

        private void TryCalculateMetaIndicatorsForPoint(int slot, LogicPortfolioPoint point)
        {
            MetaIndicatorConfig cfg = BuildLpMetaIndicatorConfig(slot);
            if (!cfg.HasAnyEnabled || point == null)
            {
                return;
            }

            IReadOnlyList<LogicPortfolioPoint> history = _logicPortfolios[slot].History;
            MetaIndicatorEquityCalculator.CalculateAt(history, history.Count - 1, cfg, point.Meta);
        }

        private void RecalculateLogicPortfolioMetaHistory(int slot)
        {
            MetaIndicatorConfig cfg = BuildLpMetaIndicatorConfig(slot);
            if (!cfg.HasAnyEnabled)
            {
                return;
            }

            LogicPortfolioRuntime runtime = _logicPortfolios[slot];
            for (int i = 0; i < runtime.History.Count; i++)
            {
                MetaIndicatorEquityCalculator.CalculateAt(runtime.History, i, cfg, runtime.History[i].Meta);
            }
        }

        private void RecalculateAggregateMetaHistory()
        {
            MetaIndicatorConfig cfg = BuildAggregateMetaIndicatorConfig();
            if (!cfg.HasAnyEnabled)
            {
                return;
            }

            for (int i = 0; i < _aggregateMetaPortfolio.History.Count; i++)
            {
                MetaIndicatorEquityCalculator.CalculateAt(
                    _aggregateMetaPortfolio.History,
                    i,
                    cfg,
                    _aggregateMetaPortfolio.History[i].Meta);
            }
        }

        private decimal GetCombinedLogicPortfolioEquity()
        {
            decimal total = 0m;
            for (int slot = 1; slot <= LogicSlotCount; slot++)
            {
                total += _logicPortfolios[slot].Equity;
            }

            return total;
        }

        private void SyncAggregateMetaPortfolioPoint(
            BotTabSimple tab,
            DateTime candleTime,
            string eventName,
            string note)
        {
            MetaIndicatorConfig cfg = BuildAggregateMetaIndicatorConfig();
            if (!cfg.HasAnyEnabled)
            {
                return;
            }

            decimal total = GetCombinedLogicPortfolioEquity();
            decimal prevEquity = _aggregateMetaPortfolio.History.Count > 0
                ? _aggregateMetaPortfolio.History[_aggregateMetaPortfolio.History.Count - 1].Equity
                : 0m;
            AppendAggregateMetaPortfolioPoint(
                eventName,
                total - prevEquity,
                GetLogicPortfolioTabKey(tab),
                note ?? "",
                candleTime,
                total);
        }

        private void RefreshAggregateMetaPortfolioOnCandle(BotTabSimple tab, DateTime candleTime)
        {
            MetaIndicatorConfig cfg = BuildAggregateMetaIndicatorConfig();
            if (!cfg.HasAnyEnabled)
            {
                return;
            }

            decimal total = GetCombinedLogicPortfolioEquity();
            decimal prevEquity = _aggregateMetaPortfolio.History.Count > 0
                ? _aggregateMetaPortfolio.History[_aggregateMetaPortfolio.History.Count - 1].Equity
                : 0m;
            decimal delta = total - prevEquity;
            if (_aggregateMetaPortfolio.History.Count > 0 && Math.Abs(delta) < LogicPortfolioCandleMinDelta)
            {
                return;
            }

            AppendAggregateMetaPortfolioPoint(
                "candle",
                delta,
                GetLogicPortfolioTabKey(tab),
                "mtm",
                candleTime,
                total);
        }

        private void AppendAggregateMetaPortfolioPoint(
            string eventName,
            decimal delta,
            string tabKey,
            string note,
            DateTime candleTime,
            decimal totalEquity)
        {
            AggregateMetaPortfolioRuntime runtime = _aggregateMetaPortfolio;
            runtime.LastSeq++;
            var point = new LogicPortfolioPoint
            {
                Seq = runtime.LastSeq,
                EventTimeUtc = DateTime.UtcNow,
                CandleTime = candleTime,
                Event = eventName ?? "",
                Delta = delta,
                Equity = totalEquity,
                Realized = totalEquity,
                Unrealized = 0m,
                TabKey = tabKey ?? "",
                Note = note ?? ""
            };

            runtime.History.Add(point);
            TrimPortfolioHistoryList(runtime.History);
            runtime.LastCandleTime = candleTime;
            MetaIndicatorEquityCalculator.CalculateAt(
                runtime.History,
                runtime.History.Count - 1,
                BuildAggregateMetaIndicatorConfig(),
                point.Meta);
        }

        private static void TrimPortfolioHistoryList(List<LogicPortfolioPoint> history)
        {
            if (history == null)
            {
                return;
            }

            while (history.Count > LogicPortfolioHistoryCap)
            {
                history.RemoveAt(0);
            }
        }

        private string GetAggregateMetaPortfolioFilePath()
        {
            return Path.Combine("Engine", NameStrategyUniq + AggregateMetaPortfolioFileNameSuffix);
        }

        private void LoadAggregateMetaPortfolioFromDisk()
        {
            if (StartProgram == StartProgram.IsTester)
            {
                return;
            }

            string path = GetAggregateMetaPortfolioFilePath();
            if (!File.Exists(path))
            {
                return;
            }

            try
            {
                AggregateMetaPortfolioRuntime runtime = _aggregateMetaPortfolio;
                runtime.History.Clear();
                using StreamReader reader = new StreamReader(path, Encoding.UTF8);
                string version = reader.ReadLine();
                if (!string.Equals(version, "v2", StringComparison.Ordinal))
                {
                    return;
                }

                string stateLine = reader.ReadLine();
                ParseAggregateMetaStateLine(stateLine, runtime);
                reader.ReadLine();
                if (!reader.EndOfStream)
                {
                    reader.ReadLine();
                }

                while (!reader.EndOfStream)
                {
                    string line = reader.ReadLine();
                    if (string.IsNullOrWhiteSpace(line) || line.StartsWith("seq|", StringComparison.Ordinal))
                    {
                        continue;
                    }

                    LogicPortfolioPoint point = ParseLogicPortfolioHistoryLine(line);
                    if (point != null)
                    {
                        runtime.History.Add(point);
                    }
                }

                TrimPortfolioHistoryList(runtime.History);
                RecalculateAggregateMetaHistory();
            }
            catch (Exception ex)
            {
                SendNewLogMessage(
                    NameStrategyUniq + " | MetaAggregate: ошибка чтения: " + ex.Message,
                    LogMessageType.Error);
            }
        }

        private static void ParseAggregateMetaStateLine(string line, AggregateMetaPortfolioRuntime runtime)
        {
            if (runtime == null || string.IsNullOrWhiteSpace(line) || !line.StartsWith("STATE|", StringComparison.Ordinal))
            {
                return;
            }

            string[] parts = line.Split('|');
            if (parts.Length < 4)
            {
                return;
            }

            long.TryParse(parts[3], NumberStyles.Integer, CultureInfo.InvariantCulture, out runtime.LastSeq);
            if (parts.Length > 4
                && DateTime.TryParse(parts[4], CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTime candleTime))
            {
                runtime.LastCandleTime = candleTime;
            }
        }

        private void SaveAggregateMetaPortfolioToDisk()
        {
            if (StartProgram == StartProgram.IsTester)
            {
                return;
            }

            MetaIndicatorConfig cfg = BuildAggregateMetaIndicatorConfig();
            if (!cfg.HasAnyEnabled)
            {
                return;
            }

            AggregateMetaPortfolioRuntime runtime = _aggregateMetaPortfolio;
            string path = GetAggregateMetaPortfolioFilePath();
            string directory = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
            {
                Directory.CreateDirectory(directory);
            }

            using StreamWriter writer = new StreamWriter(path, false, new UTF8Encoding(false));
            writer.WriteLine("v2");
            writer.WriteLine(
                "STATE|"
                + GetCombinedLogicPortfolioEquity().ToString(CultureInfo.InvariantCulture)
                + "|0|"
                + runtime.LastSeq.ToString(CultureInfo.InvariantCulture)
                + "|"
                + runtime.LastCandleTime.ToString("O", CultureInfo.InvariantCulture)
                + "|"
                + DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture));
            writer.WriteLine("CAP|" + LogicPortfolioHistoryCap.ToString(CultureInfo.InvariantCulture));
            writer.WriteLine(BuildMetaHistoryHeaderLine());
            writer.WriteLine("seq|eventUtc|candleTime|event|delta|equity|realized|unrealized|tab|note|meta");

            for (int i = 0; i < runtime.History.Count; i++)
            {
                LogicPortfolioPoint point = runtime.History[i];
                writer.Write(point.Seq.ToString(CultureInfo.InvariantCulture));
                writer.Write("|");
                writer.Write(point.EventTimeUtc.ToString("O", CultureInfo.InvariantCulture));
                writer.Write("|");
                writer.Write(point.CandleTime.ToString("O", CultureInfo.InvariantCulture));
                writer.Write("|");
                writer.Write(point.Event);
                writer.Write("|");
                writer.Write(point.Delta.ToString(CultureInfo.InvariantCulture));
                writer.Write("|");
                writer.Write(point.Equity.ToString(CultureInfo.InvariantCulture));
                writer.Write("|");
                writer.Write(point.Realized.ToString(CultureInfo.InvariantCulture));
                writer.Write("|");
                writer.Write(point.Unrealized.ToString(CultureInfo.InvariantCulture));
                writer.Write("|");
                writer.Write(point.TabKey);
                writer.Write("|");
                writer.Write(point.Note);
                writer.Write("|");
                writer.WriteLine(SerializeMetaIndicatorValues(point.Meta));
            }

            runtime.LastSaveUtc = DateTime.UtcNow;
        }

        private AggregateMetaPortfolioSnapshotDto BuildAggregateMetaPortfolioSnapshotDto()
        {
            MetaIndicatorConfig cfg = BuildAggregateMetaIndicatorConfig();
            if (!cfg.HasAnyEnabled)
            {
                return null;
            }

            AggregateMetaPortfolioRuntime runtime = _aggregateMetaPortfolio;
            var dto = new AggregateMetaPortfolioSnapshotDto
            {
                LastSeq = runtime.LastSeq
            };

            if (runtime.History.Count == 0)
            {
                return dto;
            }

            LogicPortfolioPoint[] historySnapshot = runtime.History.ToArray();
            var points = new LogicPortfolioPointDto[historySnapshot.Length];
            for (int i = 0; i < historySnapshot.Length; i++)
            {
                LogicPortfolioPoint p = historySnapshot[i];
                points[i] = new LogicPortfolioPointDto
                {
                    Seq = p.Seq,
                    EventTimeUtc = p.EventTimeUtc,
                    CandleTime = p.CandleTime,
                    Event = p.Event,
                    Delta = p.Delta,
                    Equity = p.Equity,
                    Realized = p.Realized,
                    Unrealized = p.Unrealized,
                    TabKey = p.TabKey,
                    Note = p.Note,
                    Meta = ToMetaIndicatorValuesDto(p.Meta)
                };
            }

            dto.History = points;
            return dto;
        }

        private void ApplyAggregateMetaPortfolioSnapshotDto(AggregateMetaPortfolioSnapshotDto dto)
        {
            if (dto == null)
            {
                return;
            }

            AggregateMetaPortfolioRuntime runtime = _aggregateMetaPortfolio;
            runtime.LastSeq = dto.LastSeq;
            runtime.History.Clear();

            if (dto.History != null)
            {
                for (int i = 0; i < dto.History.Length; i++)
                {
                    LogicPortfolioPointDto p = dto.History[i];
                    if (p == null)
                    {
                        continue;
                    }

                    runtime.History.Add(new LogicPortfolioPoint
                    {
                        Seq = p.Seq,
                        EventTimeUtc = p.EventTimeUtc,
                        CandleTime = p.CandleTime,
                        Event = p.Event ?? "",
                        Delta = p.Delta,
                        Equity = p.Equity,
                        Realized = p.Realized,
                        Unrealized = p.Unrealized,
                        TabKey = p.TabKey ?? "",
                        Note = p.Note ?? "",
                        Meta = FromMetaIndicatorValuesDto(p.Meta)
                    });
                }

                runtime.LastCandleTime = runtime.History.Count > 0
                    ? runtime.History[runtime.History.Count - 1].CandleTime
                    : DateTime.MinValue;
            }

            RecalculateAggregateMetaHistory();
        }

        private static MetaIndicatorValuesDto ToMetaIndicatorValuesDto(MetaIndicatorValues meta)
        {
            if (meta == null)
            {
                return null;
            }

            return new MetaIndicatorValuesDto
            {
                Sma = meta.Sma,
                StochK = meta.StochK,
                StochD = meta.StochD,
                Atr = meta.Atr,
                LinRegCenter = meta.LinRegCenter,
                LinRegUp = meta.LinRegUp,
                LinRegDown = meta.LinRegDown,
                MacdLine = meta.MacdLine,
                MacdSignal = meta.MacdSignal,
                PnlSmaAvg = meta.PnlSmaAvg,
                PnlSmaLast = meta.PnlSmaLast
            };
        }

        private static MetaIndicatorValues FromMetaIndicatorValuesDto(MetaIndicatorValuesDto dto)
        {
            if (dto == null)
            {
                return new MetaIndicatorValues();
            }

            return new MetaIndicatorValues
            {
                Sma = dto.Sma,
                StochK = dto.StochK,
                StochD = dto.StochD,
                Atr = dto.Atr,
                LinRegCenter = dto.LinRegCenter,
                LinRegUp = dto.LinRegUp,
                LinRegDown = dto.LinRegDown,
                MacdLine = dto.MacdLine,
                MacdSignal = dto.MacdSignal,
                PnlSmaAvg = dto.PnlSmaAvg,
                PnlSmaLast = dto.PnlSmaLast
            };
        }

        private static string BuildMetaHistoryHeaderLine()
        {
            return "METAHDR|sma|stochK|stochD|atr|linRegCenter|linRegUp|linRegDown|macdLine|macdSignal|pnlSmaAvg|pnlSmaLast";
        }

        private static string SerializeMetaIndicatorValues(MetaIndicatorValues meta)
        {
            if (meta == null)
            {
                return string.Join(";", Enumerable.Repeat(string.Empty, MetaIndicatorSerializedFieldCount));
            }

            return FormatMetaField(meta.Sma)
                + ";"
                + FormatMetaField(meta.StochK)
                + ";"
                + FormatMetaField(meta.StochD)
                + ";"
                + FormatMetaField(meta.Atr)
                + ";"
                + FormatMetaField(meta.LinRegCenter)
                + ";"
                + FormatMetaField(meta.LinRegUp)
                + ";"
                + FormatMetaField(meta.LinRegDown)
                + ";"
                + FormatMetaField(meta.MacdLine)
                + ";"
                + FormatMetaField(meta.MacdSignal)
                + ";"
                + FormatMetaField(meta.PnlSmaAvg)
                + ";"
                + FormatMetaField(meta.PnlSmaLast);
        }

        private static string FormatMetaField(decimal? value)
        {
            return value.HasValue
                ? value.Value.ToString(CultureInfo.InvariantCulture)
                : string.Empty;
        }

        private static MetaIndicatorValues ParseMetaIndicatorFields(string[] parts, int startIndex)
        {
            var meta = new MetaIndicatorValues();
            if (parts == null || parts.Length <= startIndex)
            {
                return meta;
            }

            int available = parts.Length - startIndex;
            if (available >= 1)
            {
                meta.Sma = ParseMetaField(parts[startIndex]);
            }

            if (available >= 2)
            {
                meta.StochK = ParseMetaField(parts[startIndex + 1]);
            }

            if (available >= 3)
            {
                meta.StochD = ParseMetaField(parts[startIndex + 2]);
            }

            if (available >= 4)
            {
                meta.Atr = ParseMetaField(parts[startIndex + 3]);
            }

            if (available >= 5)
            {
                meta.LinRegCenter = ParseMetaField(parts[startIndex + 4]);
            }

            if (available >= 6)
            {
                meta.LinRegUp = ParseMetaField(parts[startIndex + 5]);
            }

            if (available >= 7)
            {
                meta.LinRegDown = ParseMetaField(parts[startIndex + 6]);
            }

            if (available >= 8)
            {
                meta.MacdLine = ParseMetaField(parts[startIndex + 7]);
            }

            if (available >= 9)
            {
                meta.MacdSignal = ParseMetaField(parts[startIndex + 8]);
            }

            if (available >= 10)
            {
                meta.PnlSmaAvg = ParseMetaField(parts[startIndex + 9]);
            }

            if (available >= 11)
            {
                meta.PnlSmaLast = ParseMetaField(parts[startIndex + 10]);
            }

            return meta;
        }

        private static decimal? ParseMetaField(string text)
        {
            if (string.IsNullOrWhiteSpace(text))
            {
                return null;
            }

            if (decimal.TryParse(text, NumberStyles.Number, CultureInfo.InvariantCulture, out decimal value))
            {
                return value;
            }

            return null;
        }

        private static class MetaIndicatorEquityCalculator
        {
            public static void CalculateAt(
                IReadOnlyList<LogicPortfolioPoint> history,
                int index,
                MetaIndicatorConfig cfg,
                MetaIndicatorValues target)
            {
                if (history == null || target == null || cfg == null || index < 0 || index >= history.Count)
                {
                    return;
                }

                if (cfg.UseSma)
                {
                    target.Sma = TrySma(history, index, Math.Max(1, cfg.SmaLen));
                }

                if (cfg.UseStoch)
                {
                    TryStoch(history, index, cfg, target);
                }

                if (cfg.UseAtr)
                {
                    target.Atr = TryAtr(history, index, Math.Max(1, cfg.AtrLen));
                }

                if (cfg.UseLinReg)
                {
                    TryLinReg(history, index, cfg, target);
                }

                if (cfg.UseMacd)
                {
                    TryMacd(history, index, cfg, target);
                }

                if (cfg.UsePnlSma)
                {
                    TryPnlSma(history, index, Math.Max(1, cfg.PnlSmaLen), target);
                }
            }

            /// <summary>
            /// PnlSMA (приведённая SMA): avg = mean(E_i − E_start) по окну; last = E_end − E_start.
            /// </summary>
            private static void TryPnlSma(
                IReadOnlyList<LogicPortfolioPoint> history,
                int index,
                int length,
                MetaIndicatorValues target)
            {
                if (history == null || target == null || index < length - 1 || length <= 0)
                {
                    return;
                }

                int start = index - length + 1;
                decimal equityStart = history[start].Equity;
                decimal sumAdjusted = 0m;
                for (int i = start; i <= index; i++)
                {
                    sumAdjusted += history[i].Equity - equityStart;
                }

                target.PnlSmaAvg = sumAdjusted / length;
                target.PnlSmaLast = history[index].Equity - equityStart;
            }

            private static decimal? TrySma(IReadOnlyList<LogicPortfolioPoint> history, int index, int length)
            {
                if (index < length - 1)
                {
                    return null;
                }

                decimal sum = 0m;
                for (int i = index - length + 1; i <= index; i++)
                {
                    sum += history[i].Equity;
                }

                return sum / length;
            }

            private static void TryStoch(
                IReadOnlyList<LogicPortfolioPoint> history,
                int index,
                MetaIndicatorConfig cfg,
                MetaIndicatorValues target)
            {
                int p1 = Math.Max(1, cfg.StochP1);
                int p2 = Math.Max(1, cfg.StochP2);
                int p3 = Math.Max(1, cfg.StochP3);
                int minIndex = p1 + p2 + p3 - 3;
                if (index < minIndex)
                {
                    return;
                }

                var rawK = new List<decimal>(p2 + p3);
                for (int k = index - p2 - p3 + 2; k <= index; k++)
                {
                    rawK.Add(RawStochK(history, k, p1));
                }

                decimal smoothedK = SimpleAverage(rawK, rawK.Count - p2, rawK.Count - 1);
                var kSeries = new List<decimal>(p3);
                for (int d = index - p3 + 1; d <= index; d++)
                {
                    var window = new List<decimal>(p2);
                    for (int k = d - p2 + 1; k <= d; k++)
                    {
                        window.Add(RawStochK(history, k, p1));
                    }

                    kSeries.Add(SimpleAverage(window, 0, window.Count - 1));
                }

                target.StochK = smoothedK;
                target.StochD = SimpleAverage(kSeries, 0, kSeries.Count - 1);
            }

            private static decimal RawStochK(IReadOnlyList<LogicPortfolioPoint> history, int index, int period)
            {
                decimal highest = decimal.MinValue;
                decimal lowest = decimal.MaxValue;
                for (int i = index - period + 1; i <= index; i++)
                {
                    decimal equity = history[i].Equity;
                    if (equity > highest)
                    {
                        highest = equity;
                    }

                    if (equity < lowest)
                    {
                        lowest = equity;
                    }
                }

                if (highest == lowest)
                {
                    return 50m;
                }

                return (history[index].Equity - lowest) / (highest - lowest) * 100m;
            }

            private static decimal? TryAtr(IReadOnlyList<LogicPortfolioPoint> history, int index, int length)
            {
                if (index < length)
                {
                    return null;
                }

                decimal sum = 0m;
                for (int i = index - length + 1; i <= index; i++)
                {
                    sum += Math.Abs(history[i].Equity - history[i - 1].Equity);
                }

                return sum / length;
            }

            private static void TryLinReg(
                IReadOnlyList<LogicPortfolioPoint> history,
                int index,
                MetaIndicatorConfig cfg,
                MetaIndicatorValues target)
            {
                int length = Math.Max(2, cfg.LinRegLen);
                if (index < length - 1)
                {
                    return;
                }

                int start = index - length + 1;
                CalculateLinearRegression(history, start, index, out decimal slope, out decimal intercept, out decimal stdDev);
                decimal center = intercept + slope * (length - 1);
                target.LinRegCenter = center;
                target.LinRegUp = center + cfg.LinRegDev * stdDev;
                target.LinRegDown = center - cfg.LinRegDev * stdDev;
            }

            private static void TryMacd(
                IReadOnlyList<LogicPortfolioPoint> history,
                int index,
                MetaIndicatorConfig cfg,
                MetaIndicatorValues target)
            {
                int fast = Math.Max(2, cfg.MacdFastLen);
                int slow = Math.Max(fast + 1, cfg.MacdSlowLen);
                int signal = Math.Max(1, cfg.MacdSignalLen);
                if (index < slow - 1)
                {
                    return;
                }

                decimal fastEma = ComputeEma(history, index, fast);
                decimal slowEma = ComputeEma(history, index, slow);
                decimal macdLine = fastEma - slowEma;
                target.MacdLine = macdLine;

                if (index < slow + signal - 2)
                {
                    return;
                }

                var macdSeries = new List<decimal>(signal);
                for (int i = index - signal + 1; i <= index; i++)
                {
                    decimal f = ComputeEma(history, i, fast);
                    decimal s = ComputeEma(history, i, slow);
                    macdSeries.Add(f - s);
                }

                target.MacdSignal = ComputeEmaFromValues(macdSeries, macdSeries.Count - 1, signal);
            }

            private static decimal ComputeEma(IReadOnlyList<LogicPortfolioPoint> history, int index, int period)
            {
                if (index < period - 1)
                {
                    return 0m;
                }

                decimal k = 2m / (period + 1);
                decimal ema = history[index - period + 1].Equity;
                for (int i = index - period + 2; i <= index; i++)
                {
                    ema = history[i].Equity * k + ema * (1m - k);
                }

                return ema;
            }

            private static decimal ComputeEmaFromValues(IReadOnlyList<decimal> values, int index, int period)
            {
                if (index < period - 1)
                {
                    return 0m;
                }

                decimal k = 2m / (period + 1);
                decimal ema = values[index - period + 1];
                for (int i = index - period + 2; i <= index; i++)
                {
                    ema = values[i] * k + ema * (1m - k);
                }

                return ema;
            }

            private static void CalculateLinearRegression(
                IReadOnlyList<LogicPortfolioPoint> history,
                int startIndex,
                int endIndex,
                out decimal slope,
                out decimal intercept,
                out decimal stdDev)
            {
                int n = endIndex - startIndex + 1;
                decimal sumX = 0m;
                decimal sumY = 0m;
                decimal sumX2 = 0m;
                decimal sumXY = 0m;

                for (int i = 0; i < n; i++)
                {
                    decimal x = i;
                    decimal y = history[startIndex + i].Equity;
                    sumX += x;
                    sumY += y;
                    sumX2 += x * x;
                    sumXY += x * y;
                }

                decimal denom = n * sumX2 - sumX * sumX;
                if (denom == 0m)
                {
                    slope = 0m;
                    intercept = history[endIndex].Equity;
                    stdDev = 0m;
                    return;
                }

                slope = (n * sumXY - sumX * sumY) / denom;
                intercept = (sumY - slope * sumX) / n;

                decimal sumSq = 0m;
                for (int i = 0; i < n; i++)
                {
                    decimal x = i;
                    decimal fitted = intercept + slope * x;
                    decimal diff = history[startIndex + i].Equity - fitted;
                    sumSq += diff * diff;
                }

                stdDev = n > 1 ? (decimal)Math.Sqrt((double)(sumSq / n)) : 0m;
            }

            private static decimal SimpleAverage(IReadOnlyList<decimal> values, int start, int end)
            {
                if (values == null || end < start)
                {
                    return 0m;
                }

                decimal sum = 0m;
                int count = 0;
                for (int i = start; i <= end; i++)
                {
                    sum += values[i];
                    count++;
                }

                return count > 0 ? sum / count : 0m;
            }
        }

        #endregion

        #endregion

        #region Resource availability (RAM / disk advisory)

        private struct MultiLogicResourceEstimate
        {
            public int ActiveLogicCount;
            public int TotalHistoryPoints;
            public int ScreenerTabCount;
            public int UniqueIndicatorCount;
            public long PortfolioFilesDiskBytes;
            public long LargestPortfolioFileBytes;
            public long EstimatedRamBytes;
            public long EstimatedDiskBytes;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
        private struct MEMORYSTATUSEX
        {
            public uint dwLength;
            public uint dwMemoryLoad;
            public ulong ullTotalPhys;
            public ulong ullAvailPhys;
            public ulong ullTotalPageFile;
            public ulong ullAvailPageFile;
            public ulong ullTotalVirtual;
            public ulong ullAvailVirtual;
            public ulong ullAvailExtendedVirtual;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX lpBuffer);

        /// <summary>
        /// Оценивает потребность MultiLogic в RAM/диске и предупреждает, если ресурсов ПК недостаточно.
        /// Только сообщение в лог — торговлю не блокирует.
        /// </summary>
        /// <param name="force">true — проверить сразу; false — не чаще ResourceCheckIntervalSeconds.</param>
        private void CheckAndWarnMultiLogicResources(bool force)
        {
            DateTime now = DateTime.UtcNow;
            if (!force
                && _lastResourceCheckUtc != DateTime.MinValue
                && (now - _lastResourceCheckUtc).TotalSeconds < ResourceCheckIntervalSeconds)
            {
                return;
            }

            _lastResourceCheckUtc = now;

            if (!TryGetAvailablePhysicalMemoryBytes(out long freeRamBytes)
                || !TryGetFreeDiskBytesForEngine(out long freeDiskBytes))
            {
                return;
            }

            MultiLogicResourceEstimate estimate = BuildMultiLogicResourceEstimate();
            bool ramInsufficient = freeRamBytes < estimate.EstimatedRamBytes;
            bool diskInsufficient = freeDiskBytes < estimate.EstimatedDiskBytes;

            if (!ramInsufficient && !diskInsufficient)
            {
                _lastResourceWarningSignature = "";
                return;
            }

            long ramShortage = ramInsufficient ? estimate.EstimatedRamBytes - freeRamBytes : 0L;
            long diskShortage = diskInsufficient ? estimate.EstimatedDiskBytes - freeDiskBytes : 0L;

            string signature =
                estimate.ActiveLogicCount
                + "|"
                + estimate.TotalHistoryPoints
                + "|"
                + estimate.ScreenerTabCount
                + "|"
                + estimate.EstimatedRamBytes
                + "|"
                + estimate.EstimatedDiskBytes
                + "|"
                + freeRamBytes
                + "|"
                + freeDiskBytes;

            if (string.Equals(signature, _lastResourceWarningSignature, StringComparison.Ordinal))
            {
                return;
            }

            _lastResourceWarningSignature = signature;

            var sb = new StringBuilder();
            sb.Append(NameStrategyUniq);
            sb.Append(" | Ресурсы ПК: для текущей конфигурации MultiLogic (активных логик ");
            sb.Append(estimate.ActiveLogicCount);
            sb.Append(", точек истории портфелей ");
            sb.Append(estimate.TotalHistoryPoints);
            sb.Append(", вкладок скринера ");
            sb.Append(estimate.ScreenerTabCount);
            sb.Append(", индикаторов ");
            sb.Append(estimate.UniqueIndicatorCount);
            sb.Append(") оценка потребности: RAM ~");
            sb.Append(FormatResourceSize(estimate.EstimatedRamBytes));
            sb.Append(", диск ~");
            sb.Append(FormatResourceSize(estimate.EstimatedDiskBytes));

            if (estimate.PortfolioFilesDiskBytes > 0)
            {
                sb.Append(" (файлы портфелей сейчас ");
                sb.Append(FormatResourceSize(estimate.PortfolioFilesDiskBytes));
                if (estimate.LargestPortfolioFileBytes > 0)
                {
                    sb.Append(", крупнейший ");
                    sb.Append(FormatResourceSize(estimate.LargestPortfolioFileBytes));
                }

                sb.Append(')');
            }

            sb.Append(". Свободно: RAM ");
            sb.Append(FormatResourceSize(freeRamBytes));
            sb.Append(", диск ");
            sb.Append(FormatResourceSize(freeDiskBytes));
            sb.Append(". ");

            if (ramInsufficient && diskInsufficient)
            {
                sb.Append("Недостаточно ресурсов: нужно ещё ~");
                sb.Append(FormatResourceSize(ramShortage));
                sb.Append(" RAM и ~");
                sb.Append(FormatResourceSize(diskShortage));
                sb.Append(" на диске.");
            }
            else if (ramInsufficient)
            {
                sb.Append("Недостаточно RAM: нужно ещё ~");
                sb.Append(FormatResourceSize(ramShortage));
                sb.Append(" (уменьшите число активных логик или историю портфелей).");
            }
            else
            {
                sb.Append("Недостаточно места на диске: нужно ещё ~");
                sb.Append(FormatResourceSize(diskShortage));
                sb.Append(" (история портфелей или JSON-снимки занимают много места).");
            }

            string msg = sb.ToString();
            SendNewLogMessage(msg, LogMessageType.Error);
            SendNewLogMessage(msg, LogMessageType.User);
        }

        private MultiLogicResourceEstimate BuildMultiLogicResourceEstimate()
        {
            int activeLogics = CountActiveLogicSlots();
            int historyPoints = CountTotalPortfolioHistoryPoints();
            int tabCount = _screenerTab?.Tabs?.Count ?? 0;
            int uniqueIndicators = _indicatorSignatureToNum?.Count ?? 0;
            long portfolioDiskBytes = GetLogicPortfolioFilesSizeOnDisk(out long largestFileBytes);

            long estimatedRam =
                ResourceEstimateBaseRamBytes
                + activeLogics * ResourceEstimatePerActiveLogicRamBytes
                + historyPoints * ResourceEstimatePerHistoryPointRamBytes
                + tabCount * ResourceEstimatePerScreenerTabRamBytes
                + uniqueIndicators * ResourceEstimatePerUniqueIndicatorRamBytes;

            long projectedHistoryGrowth = 0L;
            if (activeLogics > 0)
            {
                long maxHistoryPoints = (long)activeLogics * LogicPortfolioHistoryCap;
                long remainingPoints = Math.Max(0L, maxHistoryPoints - historyPoints);
                projectedHistoryGrowth = remainingPoints * ResourceEstimatePortfolioHistoryLineDiskBytes;
            }

            long estimatedDisk =
                portfolioDiskBytes
                + activeLogics * ResourceEstimatePerActiveLogicDiskBytes
                + projectedHistoryGrowth
                + ResourceEstimateSnapshotDiskHeadroomBytes;

            return new MultiLogicResourceEstimate
            {
                ActiveLogicCount = activeLogics,
                TotalHistoryPoints = historyPoints,
                ScreenerTabCount = tabCount,
                UniqueIndicatorCount = uniqueIndicators,
                PortfolioFilesDiskBytes = portfolioDiskBytes,
                LargestPortfolioFileBytes = largestFileBytes,
                EstimatedRamBytes = estimatedRam,
                EstimatedDiskBytes = estimatedDisk
            };
        }

        private int CountActiveLogicSlots()
        {
            int count = 0;
            for (int slot = 1; slot <= LogicSlotCount; slot++)
            {
                LogicSlotRuntime runtime = _logicSlotRuntimes[slot];
                if (runtime == null || !runtime.IsActive || runtime.ParseResult == null)
                {
                    continue;
                }

                if (!runtime.ParseResult.Success || runtime.ParseResult.IsDisabled)
                {
                    continue;
                }

                count++;
            }

            return count;
        }

        private int CountTotalPortfolioHistoryPoints()
        {
            int total = 0;
            for (int slot = 1; slot <= LogicSlotCount; slot++)
            {
                LogicPortfolioRuntime runtime = _logicPortfolios[slot];
                if (runtime?.History != null)
                {
                    total += runtime.History.Count;
                }
            }

            return total;
        }

        private long GetLogicPortfolioFilesSizeOnDisk(out long largestFileBytes)
        {
            largestFileBytes = 0L;
            if (StartProgram == StartProgram.IsTester)
            {
                return 0L;
            }

            long total = 0L;
            for (int slot = 1; slot <= LogicSlotCount; slot++)
            {
                string path = GetLogicPortfolioFilePath(slot);
                if (!File.Exists(path))
                {
                    continue;
                }

                try
                {
                    long len = new FileInfo(path).Length;
                    total += len;
                    if (len > largestFileBytes)
                    {
                        largestFileBytes = len;
                    }
                }
                catch
                {
                    // ignore unreadable file
                }
            }

            return total;
        }

        private static bool TryGetAvailablePhysicalMemoryBytes(out long availableBytes)
        {
            availableBytes = 0L;
            if (OperatingSystem.IsWindows())
            {
                MEMORYSTATUSEX status = new MEMORYSTATUSEX
                {
                    dwLength = (uint)Marshal.SizeOf<MEMORYSTATUSEX>()
                };

                if (GlobalMemoryStatusEx(ref status))
                {
                    availableBytes = (long)Math.Min(long.MaxValue, status.ullAvailPhys);
                    return availableBytes > 0L;
                }
            }

            return false;
        }

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto, BestFitMapping = false)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetDiskFreeSpaceEx(
            string lpDirectoryName,
            out ulong lpFreeBytesAvailable,
            out ulong lpTotalNumberOfBytes,
            out ulong lpTotalNumberOfFreeBytes);

        private static bool TryGetFreeDiskBytesForEngine(out long freeBytes)
        {
            freeBytes = 0L;
            try
            {
                string engineDirectory = Path.GetFullPath("Engine");
                if (!GetDiskFreeSpaceEx(
                        engineDirectory,
                        out ulong freeAvailable,
                        out _,
                        out _))
                {
                    return false;
                }

                freeBytes = freeAvailable > (ulong)long.MaxValue
                    ? long.MaxValue
                    : (long)freeAvailable;
                return freeBytes > 0L;
            }
            catch
            {
                return false;
            }
        }

        private static string FormatResourceSize(long bytes)
        {
            if (bytes <= 0L)
            {
                return "0 МБ";
            }

            const double mb = 1024d * 1024d;
            const double gb = 1024d * 1024d * 1024d;

            if (bytes >= gb)
            {
                return (bytes / gb).ToString("0.##", CultureInfo.InvariantCulture) + " ГБ";
            }

            return (bytes / mb).ToString("0.##", CultureInfo.InvariantCulture) + " МБ";
        }

        #endregion

        #region MOEX: перезагрузка бумаг скринера (TInvest / Tester)

        private void MoexFuturesLoadButton_UserClickOnButtonEvent()
        {
            RunMoexReloadOnUiThread(MoexScreenerInstrumentMode.Futures);
        }

        /// <summary>
        /// Кнопка «Обновить акции»: пересборка списка бумаг скринера по точным тикерам MOEX.
        /// </summary>
        private void MoexStockLoadButton_UserClickOnButtonEvent()
        {
            RunMoexReloadOnUiThread(MoexScreenerInstrumentMode.Stock);
        }

        /// <summary>MOEX reload на UI-потоке, без параллельных пересборок скринера.</summary>
        private void RunMoexReloadOnUiThread(MoexScreenerInstrumentMode mode)
        {
            if (Interlocked.CompareExchange(ref _moexReloadInProgress, 1, 0) != 0)
            {
                string kind = mode == MoexScreenerInstrumentMode.Futures ? "фьючерсов" : "акций";
                SendNewLogMessage(
                    NameStrategyUniq + ": обновление " + kind + " уже выполняется.",
                    LogMessageType.System);
                return;
            }

            RunOnUiThread(
                () =>
                {
                    try
                    {
                        ReloadMoexScreenerInstruments(mode);
                    }
                    catch (Exception ex)
                    {
                        SendNewLogMessage(ex.ToString(), LogMessageType.Error);
                    }
                    finally
                    {
                        Interlocked.Exchange(ref _moexReloadInProgress, 0);
                    }
                },
                preferAsync: true);
        }

        /// <summary>
        /// Общая логика MOEX reload: коннектор, класс бумаг, фильтры, очистка, добавление ActivatedSecurity, перезагрузка вкладок.
        /// </summary>
        private void ReloadMoexScreenerInstruments(MoexScreenerInstrumentMode mode)
        {
            try
            {
                ApplyPrefixesFromOpenParameterDialog();

                bool isFutures = mode == MoexScreenerInstrumentMode.Futures;
                StrategyParameterString prefixesParam = isFutures
                    ? _moexFuturesTickerPrefixes
                    : _moexStockTickerPrefixes;

                List<string> prefixes = ParseTickerPrefixes(prefixesParam?.ValueString);
                if (prefixes.Count == 0)
                {
                    string fillHint = isFutures
                        ? "заполните «Префиксы корня тикера фьючерса» (через запятую)"
                        : "заполните «Тикеры акций» (через запятую)";
                    SendNewLogMessage(
                        NameStrategyUniq + ": " + fillHint + ", затем снова нажмите кнопку.",
                        LogMessageType.Error);
                    return;
                }

                bool useTester = ShouldUseMoexTesterConnector();
                bool preserveLiveScreenerSetup = !useTester && HasConfiguredLiveScreenerConnection();
                MoexScreenerPreserveSettings preserved = preserveLiveScreenerSetup
                    ? CaptureMoexScreenerPreserveSettings()
                    : default;

                if (!useTester && !preserveLiveScreenerSetup
                    && !TryValidateLiveScreenerBeforeMoexReload(out string setupError))
                {
                    SendNewLogMessage(NameStrategyUniq + ": " + setupError, LogMessageType.Error);
                    return;
                }

                if (!TryApplyMoexConnectorToScreener(useTester, out string connectorError))
                {
                    SendNewLogMessage(NameStrategyUniq + ": " + connectorError, LogMessageType.Error);
                    return;
                }

                IServer server = useTester ? FindTesterLikeServer() : ResolveMoexLiveServer();
                if (server == null)
                {
                    string notFound = useTester
                        ? "не найден коннектор Tester. Укажите папку с файлами истории в настройках тестера."
                        : "не найден коннектор «Т-Инвестиции» (TInvest). Подключите его в OsEngine или выберите в настройках скринера.";
                    SendNewLogMessage(NameStrategyUniq + ": " + notFound, LogMessageType.Error);
                    return;
                }

                List<Security> instrumentsToScan = GetMoexReloadInstrumentList(server, useTester);
                if (instrumentsToScan == null || instrumentsToScan.Count == 0)
                {
                    string emptyMsg = useTester
                        ? "в сете нет бумаг с таймфреймом «" + _screenerTab.TimeFrame
                          + "» (как в настройках скринера). В окне Tester в таблице инструментов для каждой строки выберите ТФ "
                          + _screenerTab.TimeFrame + " в колонке таймфрейма, перезагрузите сет — затем снова «Обновить»."
                        : "у коннектора «" + server.ServerNameAndPrefix + "» пустой список бумаг. Дождитесь загрузки инструментов или проверьте подключение.";
                    SendNewLogMessage(NameStrategyUniq + ": " + emptyMsg, LogMessageType.Error);
                    return;
                }

                string targetClass = useTester
                    ? "TestClass"
                    : ResolveMoexTargetSecuritiesClass(server, mode, prefixes);
                if (string.IsNullOrEmpty(targetClass))
                {
                    string classHint = isFutures ? "класс фьючерсов" : "класс акций (Stock)";
                    SendNewLogMessage(
                        NameStrategyUniq + ": на коннекторе «" + server.ServerNameAndPrefix + "» не найден " + classHint + ".",
                        LogMessageType.Error);
                    return;
                }

                int clearedSecurities = isFutures
                    ? ClearAllScreenerSecuritiesAndTabs()
                    : ClearMoexStockSecuritiesForReload();
                string previousClass = _screenerTab.SecuritiesClass;
                if (useTester || string.IsNullOrWhiteSpace(_screenerTab.SecuritiesClass))
                {
                    _screenerTab.SecuritiesClass = targetClass;
                }

                DateTime now =
                    _screenerTab?.Tabs != null && _screenerTab.Tabs.Count > 0
                        ? _screenerTab.Tabs[0].TimeServerCurrent
                        : DateTime.Now;
                if (now == DateTime.MinValue)
                {
                    now = DateTime.Now;
                }

                int instrumentsTotal = 0;
                int matchedPrefixAny = 0;
                int matchedPrefixEligible = 0;
                int skippedExpired = 0;
                int skippedClass = 0;
                List<string> syncedNames = new List<string>();
                List<ActivatedSecurity> pendingStockSecurities = isFutures ? null : new List<ActivatedSecurity>();

                bool testerLike = IsTesterLikeServer(server);

                for (int i = 0; i < instrumentsToScan.Count; i++)
                {
                    Security sec = instrumentsToScan[i];
                    if (!IsScreenerInstrument(sec, server, mode))
                    {
                        continue;
                    }

                    instrumentsTotal++;

                    if (!SecurityMatchesPrefixes(sec, prefixes, mode))
                    {
                        continue;
                    }

                    matchedPrefixAny++;

                    if (isFutures
                        && !testerLike
                        && sec.Expiration != DateTime.MinValue
                        && sec.Expiration.Date < now.Date)
                    {
                        skippedExpired++;
                        continue;
                    }

                    matchedPrefixEligible++;

                    string secClass = GetSecurityClassName(sec);
                    if (!string.Equals(secClass, targetClass, StringComparison.OrdinalIgnoreCase))
                    {
                        skippedClass++;
                        continue;
                    }

                    ActivatedSecurity activated = new ActivatedSecurity
                    {
                        SecurityName = sec.Name,
                        SecurityClass = secClass,
                        IsOn = true
                    };

                    if (isFutures)
                    {
                        _screenerTab.SecuritiesNames.Add(activated);
                    }
                    else
                    {
                        pendingStockSecurities.Add(activated);
                    }

                    if (syncedNames.Count < 30)
                    {
                        syncedNames.Add(sec.Name);
                    }
                }

                int syncedTotal = isFutures
                    ? _screenerTab.SecuritiesNames?.Count ?? 0
                    : pendingStockSecurities.Count;

                if (syncedTotal == 0)
                {
                    string kindLabel = isFutures ? "фьючерсов" : "акций";
                    string msg = NameStrategyUniq + ": не найдено " + kindLabel + " по списку ["
                        + string.Join(", ", prefixes) + "]. ";
                    msg += "Всего " + kindLabel + " у коннектора: " + instrumentsTotal + ".";
                    msg += " По списку подошло (все): " + matchedPrefixAny + ".";
                    msg += " По списку и прошло фильтры: " + matchedPrefixEligible + ".";
                    if (skippedExpired > 0)
                    {
                        msg += " Отсечено по экспирации: " + skippedExpired + ".";
                    }

                    if (skippedClass > 0)
                    {
                        msg += " Отсечено (не класс «" + targetClass + "»): " + skippedClass + ".";
                    }

                    if (matchedPrefixEligible == 0 && isFutures)
                    {
                        if (useTester && instrumentsTotal > 0 && matchedPrefixAny == 0)
                        {
                            msg += " В подключённом сете тестера (ТФ «" + _screenerTab.TimeFrame
                                + "») нет фьючерсов с корнями [" + string.Join(", ", prefixes) + "].";
                            msg += " Сейчас в сете (корни): "
                                + FormatTesterFuturesRootsDiagnostic(instrumentsToScan, server, mode) + ".";
                            msg += " " + FormatTesterSetTimeFrameDiagnostic(server, _screenerTab.TimeFrame) + ".";
                            msg += " Учитываются только строки сета с галочкой и ТФ = «" + _screenerTab.TimeFrame
                                + "» (не все файлы из папки датасета). Добавьте в Tester файлы (Si-6.26, CRZ5, …)"
                                + " с этим ТФ или допишите префикс под фактическое имя (напр. JPY для JPYRUBTODTOM).";
                        }
                        else
                        {
                            msg += useTester
                                ? " В сете нужны имена фьючерсов (ROSN-6.26, CRZ5), а не спот (ROSN). Для CNY на FORTS часто серия CR."
                                : " Совпадений по корню тикера (и не истёкших по дате) нет (для CNY на FORTS часто код серии CR; вечный — CNYRUBF).";
                            if (useTester && instrumentsTotal > 0)
                            {
                                msg += " В сете: " + FormatTesterFuturesRootsDiagnostic(instrumentsToScan, server, mode) + ".";
                            }
                        }
                    }
                    else if (matchedPrefixEligible == 0 && !isFutures)
                    {
                        msg += useTester
                            ? " В сете — спот-файлы (SBER.txt, GAZP.txt), не фьючерсы (ROSN-6.26). Тикер = имя файла без расширения."
                            : " Проверьте T-Инвестиции, класс «Stock rub» и точные тикеры (SBER, GAZP, …).";
                    }

                    if (useTester && instrumentsToScan.Count > 0 && instrumentsTotal == 0)
                    {
                        msg += " На ТФ «" + _screenerTab.TimeFrame + "» в сете: " + instrumentsToScan.Count + " файл(ов).";
                        msg += " Примеры: " + FormatTesterSetNameSamples(instrumentsToScan, 4) + ".";
                    }

                    SendNewLogMessage(msg, LogMessageType.Error);
                    return;
                }

                if (preserveLiveScreenerSetup)
                {
                    RestoreMoexScreenerPreserveSettings(preserved);
                }

                int tabsBefore = _screenerTab.Tabs?.Count ?? 0;
                string reloadNote = isFutures
                    ? ApplyMoexScreenerReload()
                    : ApplyMoexStockScreenerReloadStaggered(pendingStockSecurities);
                int tabsAfter = _screenerTab.Tabs?.Count ?? 0;
                int tabsCreated = Math.Max(0, tabsAfter - tabsBefore);

                string instrumentWord = isFutures ? "фьючерс(ов)" : "акций";
                string ok = NameStrategyUniq + ": очищено бумаг скринера: " + clearedSecurities + ".";
                ok += " Класс: «" + targetClass + "»"
                    + (string.IsNullOrEmpty(previousClass) || string.Equals(previousClass, targetClass, StringComparison.OrdinalIgnoreCase)
                        ? "."
                        : " (было «" + previousClass + "»).");
                ok += " Коннектор: «" + server.ServerNameAndPrefix + "», портфель: «"
                    + (_screenerTab.PortfolioName ?? "") + "», ТФ: " + _screenerTab.TimeFrame + ".";
                ok += " Добавлено " + syncedTotal + " " + instrumentWord + " по списку ["
                    + string.Join(", ", prefixes) + "].";

                if (tabsCreated > 0)
                {
                    ok += " Создано вкладок: " + tabsCreated + ".";
                }

                if (!string.IsNullOrEmpty(reloadNote))
                {
                    ok += " " + reloadNote;
                }

                if (syncedNames.Count > 0)
                {
                    ok += " Инструменты: " + string.Join(", ", syncedNames) + ".";
                }

                SendNewLogMessage(ok, LogMessageType.System);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        /// <summary>
        /// Очищает SecuritiesNames и удаляет все дочерние вкладки скринера; сбрасывает файл ScreenerTabSet.
        /// </summary>
        private int ClearAllScreenerSecuritiesAndTabs()
        {
            int clearedList = 0;
            if (_screenerTab.SecuritiesNames != null)
            {
                clearedList = _screenerTab.SecuritiesNames.Count;
                _screenerTab.SecuritiesNames.Clear();
            }

            int clearedTabs = 0;
            if (_screenerTab.Tabs != null)
            {
                for (int i = _screenerTab.Tabs.Count - 1; i >= 0; i--)
                {
                    BotTabSimple tab = _screenerTab.Tabs[i];
                    if (tab == null)
                    {
                        _screenerTab.Tabs.RemoveAt(i);
                        continue;
                    }

                    clearedTabs++;
                    tab.Clear();
                    tab.Delete();
                    _screenerTab.Tabs.RemoveAt(i);
                }
            }

            ClearScreenerPersistedTabListFile();
            _screenerTab.SaveSettings();
            _screenerTab.NeedToReloadTabs = true;

            TryInvokeScreenerRePaintSecuritiesGrid();

            if (clearedTabs > clearedList)
            {
                clearedList = clearedTabs;
            }

            return clearedList;
        }

        /// <summary>
        /// MOEX акции: очистить список бумаг без ручного удаления вкладок (вкладки снимет TryReLoadTabs).
        /// Без SaveSettings — меньше лишних ReloadRiskJournals / ClearJournalsArray.
        /// </summary>
        private int ClearMoexStockSecuritiesForReload()
        {
            int clearedList = 0;
            if (_screenerTab.SecuritiesNames != null)
            {
                clearedList = _screenerTab.SecuritiesNames.Count;
                _screenerTab.SecuritiesNames.Clear();
            }

            ClearScreenerPersistedTabListFile();
            _screenerTab.NeedToReloadTabs = true;
            TryInvokeScreenerRePaintSecuritiesGrid();
            return clearedList;
        }

        /// <summary>Пустой ScreenerTabSet.txt ломает BotTabScreener.TryLoadTabs() при любом старте (трейдер, тестер).</summary>
        private void RemoveCorruptScreenerTabSetFileIfNeeded()
        {
            if (string.IsNullOrEmpty(_screenerTab?.TabName))
            {
                return;
            }

            try
            {
                string path = Path.Combine("Engine", _screenerTab.TabName + "ScreenerTabSet.txt");
                if (!File.Exists(path))
                {
                    return;
                }

                string firstLine;
                using (StreamReader reader = new StreamReader(path))
                {
                    firstLine = reader.ReadLine();
                }

                if (firstLine == null || firstLine.Length == 0)
                {
                    File.Delete(path);
                }
            }
            catch
            {
                // ignore
            }
        }

        /// <summary>Удалить файл списка вкладок перед пересборкой списка бумаг.</summary>
        private void ClearScreenerPersistedTabListFile()
        {
            if (string.IsNullOrEmpty(_screenerTab?.TabName))
            {
                return;
            }

            try
            {
                string path = Path.Combine("Engine", _screenerTab.TabName + "ScreenerTabSet.txt");
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch
            {
                // ignore
            }
        }

        /// <summary>
        /// Через reflection вызывает RePaintSecuritiesGrid у BotTabScreener для обновления таблицы бумаг.
        /// </summary>
        private void TryInvokeScreenerRePaintSecuritiesGrid()
        {
            RunOnUiThread(TryInvokeScreenerRePaintSecuritiesGridCore, preferAsync: true);
        }

        private void TryInvokeScreenerRePaintSecuritiesGridCore()
        {
            try
            {
                if (_screenerTab == null)
                {
                    return;
                }

                MethodInfo repaint = _screenerTab.GetType().GetMethod(
                    "RePaintSecuritiesGrid",
                    BindingFlags.Instance | BindingFlags.NonPublic);
                repaint?.Invoke(_screenerTab, null);
            }
            catch
            {
                // ignore
            }
        }

        /// <summary>
        /// True, если сервер — Tester или Optimizer (особые правила имён и TestClass).
        /// </summary>
        private static bool IsTesterLikeServer(IServer server)
        {
            return server != null
                && (server.ServerType == ServerType.Tester
                    || server.ServerType == ServerType.Optimizer);
        }

        /// <summary>В тестере — только инструменты подключённого сета (SecuritiesTester), не посторонние файлы истории.</summary>
        private List<Security> GetMoexReloadInstrumentList(IServer server, bool useTester)
        {
            if (!useTester)
            {
                return server?.Securities;
            }

            return BuildTesterConnectedSetSecurities(server, _screenerTab.TimeFrame);
        }

        /// <summary>
        /// Имена как в SecuritiesTester.Security.Name и тот же TimeFrame, что у скринера —
        /// иначе OsEngine снимает галочки «в торгах» и предлагает удалить вкладки.
        /// </summary>
        private static List<Security> BuildTesterConnectedSetSecurities(IServer server, TimeFrame requiredTimeFrame)
        {
            List<SecurityTester> testers = TryGetSecuritiesTesterList(server);
            if (testers == null || testers.Count == 0)
            {
                return new List<Security>();
            }

            Dictionary<string, Security> byTesterName = new Dictionary<string, Security>(StringComparer.OrdinalIgnoreCase);

            for (int i = 0; i < testers.Count; i++)
            {
                SecurityTester st = testers[i];
                if (st?.Security == null || string.IsNullOrEmpty(st.Security.Name))
                {
                    continue;
                }

                if (st.TimeFrame != requiredTimeFrame)
                {
                    continue;
                }

                string testerName = st.Security.Name.Trim();

                if (byTesterName.ContainsKey(testerName))
                {
                    continue;
                }

                Security sec = new Security();
                sec.LoadFromString(st.Security.GetSaveStr());
                sec.Name = testerName;
                if (string.IsNullOrWhiteSpace(sec.NameClass))
                {
                    sec.NameClass = "TestClass";
                }

                string tickerKey = GetTesterInstrumentTicker(testerName);
                sec.SecurityType = IsMoexFuturesStyleName(tickerKey)
                    ? SecurityType.Futures
                    : SecurityType.Stock;

                byTesterName[testerName] = sec;
            }

            return byTesterName.Values.ToList();
        }

        /// <summary>
        /// Возвращает SecuritiesTester с TesterServer или OptimizerServer.
        /// </summary>
        private static List<SecurityTester> TryGetSecuritiesTesterList(IServer server)
        {
            if (server is TesterServer testerServer)
            {
                return testerServer.SecuritiesTester;
            }

            if (server is OptimizerServer optimizerServer)
            {
                return optimizerServer.SecuritiesTester;
            }

            return null;
        }

        /// <summary>
        /// Фильтр типа инструмента: фьючерс/акция; в тестере — по стилю имени, в лайве — по SecurityType.
        /// </summary>
        private static bool IsScreenerInstrument(Security sec, IServer server, MoexScreenerInstrumentMode mode)
        {
            if (sec == null || string.IsNullOrEmpty(sec.Name))
            {
                return false;
            }

            if (IsTesterLikeServer(server))
            {
                string ticker = GetTesterInstrumentTicker(sec.Name);
                return mode == MoexScreenerInstrumentMode.Futures
                    ? IsMoexFuturesStyleName(ticker)
                    : IsMoexStockStyleName(ticker);
            }

            return mode == MoexScreenerInstrumentMode.Futures
                ? sec.SecurityType == SecurityType.Futures
                : sec.SecurityType == SecurityType.Stock;
        }

        /// <summary>Спот: только буквы, без даты/серии FORTS (ROSN, SBER, SBERP).</summary>
        private static bool IsPlainEquityTicker(string ticker)
        {
            if (string.IsNullOrWhiteSpace(ticker))
            {
                return false;
            }

            string t = NormalizeFuturesTicker(ticker);
            if (t.Length == 0 || t.Length > 6)
            {
                return false;
            }

            if (t.EndsWith("RUBF", StringComparison.OrdinalIgnoreCase)
                || t.EndsWith("TOM", StringComparison.OrdinalIgnoreCase)
                || t.EndsWith("TOD", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            for (int i = 0; i < t.Length; i++)
            {
                if (!char.IsLetter(t[i]))
                {
                    return false;
                }
            }

            return true;
        }

        /// <summary>Фьючерс: ROSN-6.26, CRZ5, CNYRUBF и т.п., не голый тикер акции.</summary>
        private static bool IsMoexFuturesStyleName(string ticker)
        {
            if (string.IsNullOrWhiteSpace(ticker))
            {
                return false;
            }

            string t = NormalizeFuturesTicker(ticker);

            if (IsPlainEquityTicker(t))
            {
                return false;
            }

            int dash = t.IndexOf('-');
            if (dash > 0 && dash < t.Length - 1)
            {
                for (int i = dash + 1; i < t.Length; i++)
                {
                    if (char.IsDigit(t[i]))
                    {
                        return true;
                    }
                }
            }

            if (t.EndsWith("RUBF", StringComparison.OrdinalIgnoreCase)
                || t.EndsWith("TOM", StringComparison.OrdinalIgnoreCase)
                || t.EndsWith("TOD", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            string fortBase = TryExtractMoexFortsSeriesBase(t);
            if (fortBase.Length > 0 && fortBase.Length < t.Length)
            {
                int len = t.Length;
                if (len >= 3 && char.IsLetter(t[len - 2]) && char.IsDigit(t[len - 1]))
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Спот MOEX: проходит IsPlainEquityTicker и не является фьючерсным именем.
        /// </summary>
        private static bool IsMoexStockStyleName(string ticker)
        {
            string t = NormalizeFuturesTicker(ticker);
            return IsPlainEquityTicker(t) && !IsMoexFuturesStyleName(t);
        }

        /// <summary>
        /// Сопоставление бумаги со списком: акции — точный тикер; фьючерсы — корень/префикс.
        /// </summary>
        private static bool SecurityMatchesPrefixes(Security sec, List<string> prefixes, MoexScreenerInstrumentMode mode)
        {
            return mode == MoexScreenerInstrumentMode.Stock
                ? SecurityExactTickerMatchesAnyPrefix(sec, prefixes)
                : SecurityLetterRootMatchesAnyPrefix(sec, prefixes);
        }

        /// <summary>
        /// Точное совпадение Name/NameId с одним из тикеров (с учётом расширения файла в тестере).
        /// </summary>
        private static bool SecurityExactTickerMatchesAnyPrefix(Security sec, List<string> prefixes)
        {
            if (sec == null || prefixes == null || prefixes.Count == 0)
            {
                return false;
            }

            string[] candidates = { sec.Name, sec.NameId };
            for (int c = 0; c < candidates.Length; c++)
            {
                if (string.IsNullOrWhiteSpace(candidates[c]))
                {
                    continue;
                }

                string name = NormalizeFuturesTicker(candidates[c].Trim());
                string testerTicker = GetTesterInstrumentTicker(candidates[c]);
                for (int i = 0; i < prefixes.Count; i++)
                {
                    if (string.Equals(name, prefixes[i], StringComparison.OrdinalIgnoreCase)
                        || (!string.IsNullOrEmpty(testerTicker)
                            && string.Equals(testerTicker, prefixes[i], StringComparison.OrdinalIgnoreCase)))
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        /// <summary>
        /// NameClass бумаги или Stock/Futures/TestClass по SecurityType.
        /// </summary>
        private static string GetSecurityClassName(Security sec)
        {
            if (sec == null)
            {
                return "TestClass";
            }

            if (!string.IsNullOrWhiteSpace(sec.NameClass))
            {
                return sec.NameClass;
            }

            if (sec.SecurityType == SecurityType.Stock)
            {
                return "Stock";
            }

            if (sec.SecurityType == SecurityType.Futures)
            {
                return SecurityType.Futures.ToString();
            }

            return "TestClass";
        }

        /// <summary>
        /// Определяет класс фьючерсов на сервере (TInvest: Futures; иначе SPBFUT).
        /// </summary>
        private static string DetectFuturesSecuritiesClass(IServer server)
        {
            if (server?.ServerType == ServerType.TInvest)
            {
                return DetectTInvestFuturesSecuritiesClass(server);
            }

            return DetectMoexSecuritiesClass(server, MoexScreenerInstrumentMode.Futures, "SPBFUT");
        }

        /// <summary>TInvest: NameClass = «Futures», не SPBFUT.</summary>
        private static string DetectTInvestFuturesSecuritiesClass(IServer server)
        {
            if (server?.Securities == null || server.Securities.Count == 0)
            {
                return null;
            }

            int futuresCount = 0;
            for (int i = 0; i < server.Securities.Count; i++)
            {
                Security sec = server.Securities[i];
                if (IsScreenerInstrument(sec, server, MoexScreenerInstrumentMode.Futures))
                {
                    futuresCount++;
                }
            }

            return futuresCount > 0 ? SecurityType.Futures.ToString() : null;
        }

        /// <summary>
        /// Определяет класс акций на сервере (TInvest — через DetectTInvestStockSecuritiesClass).
        /// </summary>
        private static string DetectStockSecuritiesClass(IServer server)
        {
            if (server?.ServerType == ServerType.TInvest)
            {
                return DetectTInvestStockSecuritiesClass(server);
            }

            return DetectMoexSecuritiesClass(server, MoexScreenerInstrumentMode.Stock, "Stock");
        }

        /// <summary>TInvest: NameClass вида «Stock rub», не «Stock usd» по всему списку.</summary>
        private static string DetectTInvestStockSecuritiesClass(IServer server)
        {
            return DetectTInvestStockSecuritiesClass(server, null);
        }

        /// <summary>
        /// TInvest: класс Stock* с максимальным числом бумаг; при списке тикеров — только по ним; приоритет Stock rub. Перегрузка: класс только среди бумаг из списка тикеров.
        /// </summary>
        private static string DetectTInvestStockSecuritiesClass(IServer server, List<string> tickerPrefixes)
        {
            if (server?.Securities == null || server.Securities.Count == 0)
            {
                return null;
            }

            Dictionary<string, int> classCounts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            bool filterByTickers = tickerPrefixes != null && tickerPrefixes.Count > 0;

            for (int i = 0; i < server.Securities.Count; i++)
            {
                Security sec = server.Securities[i];
                if (!IsScreenerInstrument(sec, server, MoexScreenerInstrumentMode.Stock))
                {
                    continue;
                }

                if (filterByTickers && !SecurityExactTickerMatchesAnyPrefix(sec, tickerPrefixes))
                {
                    continue;
                }

                string className = GetSecurityClassName(sec);
                if (!className.StartsWith("Stock", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                if (!classCounts.ContainsKey(className))
                {
                    classCounts[className] = 0;
                }

                classCounts[className]++;
            }

            return PickBestMoexStockClass(classCounts);
        }

        /// <summary>
        /// Выбор класса акций: предпочтение Stock rub, иначе класс с максимальным счётчиком.
        /// </summary>
        private static string PickBestMoexStockClass(Dictionary<string, int> classCounts)
        {
            if (classCounts == null || classCounts.Count == 0)
            {
                return null;
            }

            const string moexRubClass = "Stock rub";
            if (classCounts.TryGetValue(moexRubClass, out int rubCount) && rubCount > 0)
            {
                return moexRubClass;
            }

            string bestClass = null;
            int bestCount = 0;
            foreach (KeyValuePair<string, int> pair in classCounts)
            {
                if (pair.Value > bestCount)
                {
                    bestCount = pair.Value;
                    bestClass = pair.Key;
                }
            }

            return bestClass;
        }

        /// <summary>
        /// Класс для MOEX reload: по тикерам на TInvest, иначе общий Detect*.
        /// </summary>
        private static string ResolveMoexTargetSecuritiesClass(
            IServer server,
            MoexScreenerInstrumentMode mode,
            List<string> prefixes)
        {
            if (server == null)
            {
                return null;
            }

            bool isFutures = mode == MoexScreenerInstrumentMode.Futures;

            if (server.ServerType == ServerType.TInvest && prefixes != null && prefixes.Count > 0)
            {
                string fromTickers = isFutures
                    ? DetectTInvestFuturesSecuritiesClassForTickers(server, prefixes)
                    : DetectTInvestStockSecuritiesClass(server, prefixes);
                if (!string.IsNullOrEmpty(fromTickers))
                {
                    return fromTickers;
                }
            }

            return isFutures
                ? DetectFuturesSecuritiesClass(server)
                : DetectStockSecuritiesClass(server);
        }

        /// <summary>
        /// Класс фьючерсов только среди бумаг, подошедших под префиксы пользователя.
        /// </summary>
        private static string DetectTInvestFuturesSecuritiesClassForTickers(IServer server, List<string> prefixes)
        {
            if (server?.Securities == null || server.Securities.Count == 0 || prefixes == null || prefixes.Count == 0)
            {
                return null;
            }

            Dictionary<string, int> classCounts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

            for (int i = 0; i < server.Securities.Count; i++)
            {
                Security sec = server.Securities[i];
                if (!IsScreenerInstrument(sec, server, MoexScreenerInstrumentMode.Futures))
                {
                    continue;
                }

                if (!SecurityLetterRootMatchesAnyPrefix(sec, prefixes))
                {
                    continue;
                }

                string className = GetSecurityClassName(sec);
                if (!classCounts.ContainsKey(className))
                {
                    classCounts[className] = 0;
                }

                classCounts[className]++;
            }

            if (classCounts.Count == 0)
            {
                return null;
            }

            string futuresClass = SecurityType.Futures.ToString();
            if (classCounts.TryGetValue(futuresClass, out int futuresCount) && futuresCount > 0)
            {
                return futuresClass;
            }

            string bestClass = null;
            int bestCount = 0;
            foreach (KeyValuePair<string, int> pair in classCounts)
            {
                if (pair.Value > bestCount)
                {
                    bestCount = pair.Value;
                    bestClass = pair.Key;
                }
            }

            return bestClass;
        }

        /// <summary>
        /// True в тестере/оптимизаторе — не переключать на TInvest.
        /// </summary>
        private bool ShouldUseMoexTesterConnector()
        {
            return StartProgram == StartProgram.IsTester
                || StartProgram == StartProgram.IsOsOptimizer;
        }

        /// <summary>
        /// В лайве заданы TInvest, имя сервера и портфель в настройках скринера. Перегрузка: проверка по переданной вкладке скринера.
        /// </summary>
        private static bool HasConfiguredLiveScreenerConnection(BotTabScreener screenerTab)
        {
            return screenerTab != null
                && screenerTab.ServerType == ServerType.TInvest
                && !string.IsNullOrWhiteSpace(screenerTab.ServerName)
                && !string.IsNullOrWhiteSpace(screenerTab.PortfolioName);
        }

        /// <summary>
        /// В лайве заданы TInvest, имя сервера и портфель в настройках скринера.
        /// </summary>
        private bool HasConfiguredLiveScreenerConnection()
        {
            return HasConfiguredLiveScreenerConnection(_screenerTab);
        }

        /// <summary>
        /// Снимок портфеля, сервера, ТФ и класса бумаг перед MOEX reload. Перегрузка: снимок настроек переданного скринера.
        /// </summary>
        private static MoexScreenerPreserveSettings CaptureMoexScreenerPreserveSettings(BotTabScreener screenerTab)
        {
            return new MoexScreenerPreserveSettings
            {
                PortfolioName = screenerTab?.PortfolioName,
                ServerType = screenerTab?.ServerType ?? ServerType.None,
                ServerName = screenerTab?.ServerName,
                TimeFrame = screenerTab?.TimeFrame ?? TimeFrame.Min1,
                SecuritiesClass = screenerTab?.SecuritiesClass
            };
        }

        /// <summary>
        /// Снимок портфеля, сервера, ТФ и класса бумаг перед MOEX reload.
        /// </summary>
        private MoexScreenerPreserveSettings CaptureMoexScreenerPreserveSettings()
        {
            return CaptureMoexScreenerPreserveSettings(_screenerTab);
        }

        /// <summary>
        /// Восстанавливает снимок настроек скринера после добавления бумаг.
        /// </summary>
        private void RestoreMoexScreenerPreserveSettings(MoexScreenerPreserveSettings preserved)
        {
            if (_screenerTab == null)
            {
                return;
            }

            if (!string.IsNullOrWhiteSpace(preserved.PortfolioName))
            {
                _screenerTab.PortfolioName = preserved.PortfolioName;
            }

            if (preserved.ServerType != ServerType.None)
            {
                _screenerTab.ServerType = preserved.ServerType;
            }

            if (!string.IsNullOrWhiteSpace(preserved.ServerName))
            {
                _screenerTab.ServerName = preserved.ServerName;
            }

            _screenerTab.TimeFrame = preserved.TimeFrame;

            if (!string.IsNullOrWhiteSpace(preserved.SecuritiesClass))
            {
                _screenerTab.SecuritiesClass = preserved.SecuritiesClass;
            }
        }

        /// <summary>
        /// Проверка перед первым MOEX reload: сервер, портфель и их наличие на коннекторе.
        /// </summary>
        private bool TryValidateLiveScreenerBeforeMoexReload(out string error)
        {
            error = null;

            if (_screenerTab == null)
            {
                error = "скринер не инициализирован.";
                return false;
            }

            if (_screenerTab.ServerType != ServerType.TInvest
                || string.IsNullOrWhiteSpace(_screenerTab.ServerName))
            {
                error = "в настройках вкладки скринера выберите подключение T-Инвестиции (t-invest / t-invest 2), затем нажмите кнопку снова.";
                return false;
            }

            if (string.IsNullOrWhiteSpace(_screenerTab.PortfolioName))
            {
                error = "в настройках вкладки скринера выберите портфель, затем нажмите кнопку снова.";
                return false;
            }

            IServer server = FindServerForScreener() ?? FindTInvestServerByScreenerName(_screenerTab.ServerName);
            if (server == null)
            {
                error = "коннектор «" + _screenerTab.ServerName.Trim()
                    + "» не найден среди подключённых T-Инвестиции.";
                return false;
            }

            if (!PortfolioExistsOnServer(server, _screenerTab.PortfolioName))
            {
                error = "портфель «" + _screenerTab.PortfolioName.Trim()
                    + "» не найден на коннекторе «" + server.ServerNameAndPrefix + "».";
                return false;
            }

            return true;
        }

        /// <summary>
        /// Есть ли портфель с таким Number на сервере.
        /// </summary>
        private static bool PortfolioExistsOnServer(IServer server, string portfolioName)
        {
            if (server?.Portfolios == null || string.IsNullOrWhiteSpace(portfolioName))
            {
                return false;
            }

            string name = portfolioName.Trim();
            for (int i = 0; i < server.Portfolios.Count; i++)
            {
                Portfolio p = server.Portfolios[i];
                if (p != null && string.Equals(p.Number, name, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Совпадение имени сервера скринера с ServerNameAndPrefix (t-invest / TInvest_t-invest).
        /// </summary>
        private static bool ServerNamesMatch(string screenerServerName, IServer server)
        {
            if (server == null || string.IsNullOrWhiteSpace(screenerServerName))
            {
                return false;
            }

            string wanted = screenerServerName.Trim();
            string full = server.ServerNameAndPrefix?.Trim() ?? string.Empty;

            if (wanted.Length == 0 || full.Length == 0)
            {
                return false;
            }

            if (string.Equals(wanted, full, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            if (full.EndsWith("_" + wanted, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            int underscore = full.IndexOf('_');
            if (underscore >= 0 && underscore < full.Length - 1)
            {
                string suffix = full.Substring(underscore + 1);
                if (string.Equals(wanted, suffix, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }

            return string.Equals(wanted, server.ServerType.ToString(), StringComparison.OrdinalIgnoreCase)
                && string.Equals(full, server.ServerType.ToString(), StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>
        /// Ищет TInvest-сервер по имени из настроек скринера (полное или суффикс).
        /// </summary>
        private static IServer FindTInvestServerByScreenerName(string screenerServerName)
        {
            if (string.IsNullOrWhiteSpace(screenerServerName))
            {
                return null;
            }

            List<IServer> servers = ServerMaster.GetServers();
            if (servers == null || servers.Count == 0)
            {
                return null;
            }

            IServer partialMatch = null;

            for (int i = 0; i < servers.Count; i++)
            {
                IServer s = servers[i];
                if (s == null || s.ServerType != ServerType.TInvest)
                {
                    continue;
                }

                if (!ServerNamesMatch(screenerServerName, s))
                {
                    continue;
                }

                if (s.Securities != null && s.Securities.Count > 0)
                {
                    return s;
                }

                if (partialMatch == null)
                {
                    partialMatch = s;
                }
            }

            return partialMatch;
        }

        /// <summary>
        /// В лайве не меняет коннектор, если уже настроен TInvest; иначе назначает первый TInvest.
        /// </summary>
        private bool TryApplyMoexConnectorToScreener(bool useTester, out string error)
        {
            error = null;

            if (useTester)
            {
                IServer server = FindTesterLikeServer();
                if (server == null)
                {
                    error = "В тестере не найден коннектор Tester. Проверьте настройки тестирования.";
                    return false;
                }

                _screenerTab.ServerType = server.ServerType;
                if (server.ServerType == ServerType.Tester)
                {
                    _screenerTab.ServerName = ServerType.Tester.ToString();
                }
                else if (server.ServerType == ServerType.Optimizer)
                {
                    _screenerTab.ServerName = ServerType.Optimizer.ToString();
                }
                else
                {
                    _screenerTab.ServerName = server.ServerNameAndPrefix;
                }

                return true;
            }

            if (HasConfiguredLiveScreenerConnection()
                || (_screenerTab.ServerType == ServerType.TInvest
                    && !string.IsNullOrWhiteSpace(_screenerTab.ServerName)))
            {
                return true;
            }

            IServer tInvest = FindTInvestServer();
            if (tInvest == null)
            {
                error = "Сначала подключите коннектор «Т-Инвестиции» (TInvest) в OsEngine или выберите его в настройках скринера (подключение и портфель).";
                return false;
            }

            _screenerTab.ServerType = ServerType.TInvest;
            _screenerTab.ServerName = tInvest.ServerNameAndPrefix;
            return true;
        }

        /// <summary>
        /// Сервер для MOEX в лайве: из настроек скринера, иначе первый TInvest с бумагами.
        /// </summary>
        private IServer ResolveMoexLiveServer()
        {
            if (_screenerTab != null
                && _screenerTab.ServerType == ServerType.TInvest
                && !string.IsNullOrWhiteSpace(_screenerTab.ServerName))
            {
                IServer configured = FindServerForScreener() ?? FindTInvestServerByScreenerName(_screenerTab.ServerName);
                if (configured != null)
                {
                    return configured;
                }
            }

            return FindTInvestServer();
        }

        /// <summary>
        /// Первый Tester/Optimizer с непустым списком бумаг.
        /// </summary>
        private static IServer FindTesterLikeServer()
        {
            List<IServer> servers = ServerMaster.GetServers();
            if (servers == null || servers.Count == 0)
            {
                return null;
            }

            IServer firstTester = null;

            for (int i = 0; i < servers.Count; i++)
            {
                IServer s = servers[i];
                if (s == null)
                {
                    continue;
                }

                if (s.ServerType != ServerType.Tester && s.ServerType != ServerType.Optimizer)
                {
                    continue;
                }

                if (firstTester == null)
                {
                    firstTester = s;
                }

                if (s.Securities != null && s.Securities.Count > 0)
                {
                    return s;
                }
            }

            return firstTester;
        }

        /// <summary>
        /// Первый TInvest с загруженными бумагами (fallback).
        /// </summary>
        private static IServer FindTInvestServer()
        {
            List<IServer> servers = ServerMaster.GetServers();
            if (servers == null || servers.Count == 0)
            {
                return null;
            }

            IServer firstTInvest = null;

            for (int i = 0; i < servers.Count; i++)
            {
                IServer s = servers[i];
                if (s == null || s.ServerType != ServerType.TInvest)
                {
                    continue;
                }

                if (firstTInvest == null)
                {
                    firstTInvest = s;
                }

                if (s.Securities != null && s.Securities.Count > 0)
                {
                    return s;
                }
            }

            return firstTInvest;
        }

        /// <summary>
        /// Подсчёт классов на сервере; preferredClass или TestClass в тестере.
        /// </summary>
        private static string DetectMoexSecuritiesClass(IServer server, MoexScreenerInstrumentMode mode, string preferredClass)
        {
            if (server?.Securities == null || server.Securities.Count == 0)
            {
                return null;
            }

            bool testerLike = IsTesterLikeServer(server);
            Dictionary<string, int> classCounts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

            for (int i = 0; i < server.Securities.Count; i++)
            {
                Security sec = server.Securities[i];
                if (!IsScreenerInstrument(sec, server, mode))
                {
                    continue;
                }

                string className = GetSecurityClassName(sec);

                if (!classCounts.ContainsKey(className))
                {
                    classCounts[className] = 0;
                }

                classCounts[className]++;
            }

            if (classCounts.Count == 0)
            {
                return testerLike ? "TestClass" : null;
            }

            if (!testerLike
                && !string.IsNullOrEmpty(preferredClass)
                && classCounts.TryGetValue(preferredClass, out int preferredCount)
                && preferredCount > 0)
            {
                return preferredClass;
            }

            if (testerLike && classCounts.ContainsKey("TestClass"))
            {
                return "TestClass";
            }

            string bestClass = null;
            int bestCount = 0;
            foreach (KeyValuePair<string, int> pair in classCounts)
            {
                if (pair.Value > bestCount)
                {
                    bestCount = pair.Value;
                    bestClass = pair.Key;
                }
            }

            return bestClass;
        }

        /// <summary>
        /// IServer по ServerType и ServerName скринера.
        /// </summary>
        private IServer FindServerForScreener()
        {
            List<IServer> servers = ServerMaster.GetServers();
            if (servers == null || servers.Count == 0)
            {
                return null;
            }

            for (int i = 0; i < servers.Count; i++)
            {
                IServer s = servers[i];
                if (s == null)
                {
                    continue;
                }

                if (s.ServerType != _screenerTab.ServerType)
                {
                    continue;
                }

                if (string.IsNullOrEmpty(_screenerTab.ServerName))
                {
                    if (string.Equals(s.ServerNameAndPrefix, _screenerTab.ServerType.ToString(), StringComparison.Ordinal))
                    {
                        return s;
                    }

                    continue;
                }

                if (ServerNamesMatch(_screenerTab.ServerName, s))
                {
                    return s;
                }
            }

            return FindTInvestServerByScreenerName(_screenerTab.ServerName);
        }

        /// <summary>
        /// Сохранение, ожидание TInvest, TryReLoadTabs, повтор при неполном создании вкладок.
        /// </summary>
        private string ApplyMoexScreenerReload()
        {
            EnsureScreenerCandleInfrastructure();

            if (!ShouldUseMoexTesterConnector())
            {
                IServer server = ResolveMoexLiveServer();
                WaitForMoexServerReady(server, 8000);
            }

            _screenerTab.SaveSettings();
            RunMoexScreenerTabsReloadPass();

            int expectedTabs = CountActivatedScreenerSecurities();
            int tabsAfterFirst = _screenerTab.Tabs?.Count ?? 0;

            if (expectedTabs > 0 && tabsAfterFirst < expectedTabs)
            {
                ScheduleMoexScreenerTabsReloadRetry(expectedTabs, attempt: 1);
                return "Вкладки догружаются (повтор через 2 с после подключения T-Инвест)…";
            }

            return BuildMoexScreenerReloadResultNote();
        }

        /// <summary>
        /// MOEX акции: по одной бумаге и пауза между TryReLoadTabs — меньше гонок GlobalPositionViewer.ClearJournalsArray.
        /// </summary>
        private string ApplyMoexStockScreenerReloadStaggered(List<ActivatedSecurity> securities)
        {
            if (securities == null || securities.Count == 0)
            {
                return string.Empty;
            }

            EnsureScreenerCandleInfrastructure();

            if (!ShouldUseMoexTesterConnector())
            {
                IServer server = ResolveMoexLiveServer();
                WaitForMoexServerReady(server, 8000);
            }

            SendNewLogMessage(
                NameStrategyUniq + ": обновление акций — поэтапное создание вкладок (" + securities.Count + ")…",
                LogMessageType.System);

            List<IndicatorOnTabs> indicatorSnapshot = SnapshotScreenerIndicators();
            _screenerTab._indicators.Clear();

            if (_screenerTab.SecuritiesNames == null)
            {
                return BuildMoexScreenerReloadResultNote();
            }

            _screenerTab.SecuritiesNames.Clear();
            _screenerTab.NeedToReloadTabs = true;
            _screenerTab.TryLoadTabs();
            _screenerTab.TryReLoadTabs();
            Thread.Sleep(MoexStockTabReloadDelayMs);

            for (int i = 0; i < securities.Count; i++)
            {
                _screenerTab.SecuritiesNames.Add(securities[i]);
                _screenerTab.NeedToReloadTabs = true;
                _screenerTab.TryReLoadTabs();

                if (i < securities.Count - 1)
                {
                    Thread.Sleep(MoexStockTabReloadDelayMs);
                }
            }

            RestoreScreenerIndicators(indicatorSnapshot);
            ScheduleMoexIndicatorsAttach(attempt: 0);
            TryInvokeScreenerRePaintSecuritiesGrid();
            _screenerTab.SaveSettings();

            int expectedTabs = CountActivatedScreenerSecurities();
            int tabsAfterFirst = _screenerTab.Tabs?.Count ?? 0;

            if (expectedTabs > 0 && tabsAfterFirst < expectedTabs)
            {
                ScheduleMoexScreenerTabsReloadRetry(expectedTabs, attempt: 1);
                return "Вкладки догружаются (повтор через 2 с после подключения T-Инвест)…";
            }

            return BuildMoexScreenerReloadResultNote();
        }

        /// <summary>
        /// Текст ошибки, если вкладки не созданы (портфель/сервер).
        /// </summary>
        private string BuildMoexScreenerReloadResultNote()
        {
            if (_screenerTab.Tabs != null && _screenerTab.Tabs.Count > 0)
            {
                return string.Empty;
            }

            if (string.IsNullOrEmpty(_screenerTab.PortfolioName))
            {
                return "Вкладки не созданы: в скринере не задан портфель (Portfolio).";
            }

            if (_screenerTab.ServerType == ServerType.None)
            {
                return "Вкладки не созданы: в скринере не выбран сервер/коннектор.";
            }

            return "Вкладки не созданы: откройте настройки вкладки скринера и проверьте портфель, сервер и класс бумаг.";
        }

        /// <summary>
        /// Число бумаг с IsOn в SecuritiesNames.
        /// </summary>
        private int CountActivatedScreenerSecurities()
        {
            if (_screenerTab?.SecuritiesNames == null)
            {
                return 0;
            }

            int count = 0;
            for (int i = 0; i < _screenerTab.SecuritiesNames.Count; i++)
            {
                if (_screenerTab.SecuritiesNames[i]?.IsOn == true)
                {
                    count++;
                }
            }

            return count;
        }

        /// <summary>
        /// Один проход TryLoadTabs/TryReLoadTabs с инициализацией CandleSeriesRealization.
        /// Индикаторы на время пересоздания вкладок снимаются: иначе TryReLoadTabs вызывает ReloadIndicatorsOnTabs
        /// на ещё не готовых чартах (NullReferenceException в ChartCandleMaster.CreateIndicator).
        /// </summary>
        private void RunMoexScreenerTabsReloadPass()
        {
            EnsureScreenerCandleInfrastructure();
            EnsureExistingScreenerTabsCandleInfrastructure();

            List<IndicatorOnTabs> indicatorSnapshot = SnapshotScreenerIndicators();
            _screenerTab._indicators.Clear();

            _screenerTab.NeedToReloadTabs = true;
            _screenerTab.TryLoadTabs();
            _screenerTab.TryReLoadTabs();

            RestoreScreenerIndicators(indicatorSnapshot);
            ScheduleMoexIndicatorsAttach(attempt: 0);
            TryInvokeScreenerRePaintSecuritiesGrid();
        }

        /// <summary>Копия списка индикаторов скринера (для временного снятия на MOEX reload).</summary>
        private List<IndicatorOnTabs> SnapshotScreenerIndicators()
        {
            var snapshot = new List<IndicatorOnTabs>();
            if (_screenerTab?._indicators == null)
            {
                return snapshot;
            }

            for (int i = 0; i < _screenerTab._indicators.Count; i++)
            {
                IndicatorOnTabs src = _screenerTab._indicators[i];
                if (src == null)
                {
                    continue;
                }

                var copy = new IndicatorOnTabs();
                copy.SetFromStr(src.GetSaveStr());
                snapshot.Add(copy);
            }

            return snapshot;
        }

        private void RestoreScreenerIndicators(List<IndicatorOnTabs> snapshot)
        {
            if (_screenerTab == null)
            {
                return;
            }

            if (_screenerTab._indicators == null)
            {
                _screenerTab._indicators = new List<IndicatorOnTabs>();
            }

            _screenerTab._indicators.Clear();
            if (snapshot == null)
            {
                return;
            }

            for (int i = 0; i < snapshot.Count; i++)
            {
                if (snapshot[i] != null)
                {
                    _screenerTab._indicators.Add(snapshot[i]);
                }
            }
        }

        /// <summary>
        /// Отложенно: индикаторы на каждую готовую вкладку (без SynchFirstTab; ChartCandle не обязателен — в тестере он часто null до отрисовки).
        /// </summary>
        private void ScheduleMoexIndicatorsAttach(int attempt)
        {
            int passId = Interlocked.Increment(ref _moexIndicatorsAttachPassId);

            Task.Run(async () =>
            {
                try
                {
                    int delayMs = attempt == 0 ? 1500 : 2500;
                    await Task.Delay(delayMs).ConfigureAwait(false);

                    if (passId != _moexIndicatorsAttachPassId || _screenerTab == null)
                    {
                        return;
                    }

                    bool logSummary = attempt == 0 || attempt == MoexIndicatorsAttachMaxAttempts;
                    SafeReloadLogicIndicatorsOnAllTabsQuiet(
                        logSummary,
                        onUiComplete: () => ContinueMoexIndicatorsAttachAfterUiPass(passId, attempt));
                }
                catch (Exception ex)
                {
                    SendNewLogMessage(
                        NameStrategyUniq + ": установка индикаторов после MOEX — " + ex.Message,
                        LogMessageType.Error);
                }
            });
        }

        private void ContinueMoexIndicatorsAttachAfterUiPass(int passId, int attempt)
        {
            if (passId != _moexIndicatorsAttachPassId || _screenerTab == null)
            {
                return;
            }

            if (!MoexIndicatorsAttachStillNeeded())
            {
                return;
            }

            if (attempt < MoexIndicatorsAttachMaxAttempts)
            {
                ScheduleMoexIndicatorsAttach(attempt + 1);
                return;
            }

            SendNewLogMessage(
                NameStrategyUniq + ": индикаторы не установлены полностью — " + BuildMoexIndicatorsAttachDiagnostic(),
                LogMessageType.Error);
        }

        /// <summary>
        /// Установка индикаторов робота на все готовые вкладки (без ReloadIndicatorsOnTabs / SynchFirstTab из ядра).
        /// Если вызов не с UI — ставит работу в очередь BeginInvoke (не блокирует поток свечи/фона).
        /// </summary>
        private void SafeReloadLogicIndicatorsOnAllTabsQuiet(bool logSummary = true, Action onUiComplete = null)
        {
            void work()
            {
                try
                {
                    SafeReloadLogicIndicatorsOnAllTabsQuietImpl(logSummary);
                }
                finally
                {
                    onUiComplete?.Invoke();
                }
            }

            System.Windows.Threading.Dispatcher dispatcher = System.Windows.Application.Current?.Dispatcher;
            if (dispatcher == null || dispatcher.CheckAccess())
            {
                work();
                return;
            }

            RunOnUiThread(work, preferAsync: true);
        }

        private int SafeReloadLogicIndicatorsOnAllTabsQuietImpl(bool logSummary)
        {
            if (_screenerTab?._indicators == null || _screenerTab.Tabs == null)
            {
                return 0;
            }

            int attached = 0;
            int skipped = 0;

            for (int i = 0; i < _screenerTab._indicators.Count; i++)
            {
                IndicatorOnTabs ind = _screenerTab._indicators[i];
                if (ind == null)
                {
                    continue;
                }

                for (int t = 0; t < _screenerTab.Tabs.Count; t++)
                {
                    BotTabSimple tab = _screenerTab.Tabs[t];
                    if (!IsTabChartReadyForIndicators(tab))
                    {
                        skipped++;
                        continue;
                    }

                    if (TryAttachRobotIndicatorOnTab(tab, ind))
                    {
                        attached++;
                    }
                }
            }

            if (logSummary && attached > 0)
            {
                SendNewLogMessage(
                    NameStrategyUniq + ": индикаторы на вкладках скринера обновлены (успешно: " + attached + ").",
                    LogMessageType.System);
            }

            if (logSummary && skipped > 0)
            {
                SendNewLogMessage(
                    NameStrategyUniq + ": часть вкладок пропущена (бумага/chartMaster не готовы): " + skipped + ".",
                    LogMessageType.System);
            }

            return attached;
        }

        /// <summary>Нужны ли ещё попытки установки индикаторов (бумага/chartMaster/сами индикаторы).</summary>
        private bool MoexIndicatorsAttachStillNeeded()
        {
            if (_screenerTab?.Tabs == null || _screenerTab.Tabs.Count == 0)
            {
                return true;
            }

            if (_screenerTab._indicators == null || _screenerTab._indicators.Count == 0)
            {
                return false;
            }

            for (int t = 0; t < _screenerTab.Tabs.Count; t++)
            {
                BotTabSimple tab = _screenerTab.Tabs[t];
                if (tab == null)
                {
                    continue;
                }

                if (string.IsNullOrWhiteSpace(tab.Connector?.SecurityName))
                {
                    return true;
                }

                if (TryGetTabChartMaster(tab) == null)
                {
                    return true;
                }

                if (TabIsMissingAnyRobotIndicator(tab))
                {
                    return true;
                }
            }

            return false;
        }

        private bool TabIsMissingAnyRobotIndicator(BotTabSimple tab)
        {
            for (int i = 0; i < _screenerTab._indicators.Count; i++)
            {
                IndicatorOnTabs ind = _screenerTab._indicators[i];
                if (ind == null)
                {
                    continue;
                }

                if (FindIndicatorOnTab(tab, ind.Num, ind.Type) == null)
                {
                    return true;
                }
            }

            return false;
        }

        private string BuildMoexIndicatorsAttachDiagnostic()
        {
            if (_screenerTab?.Tabs == null || _screenerTab.Tabs.Count == 0)
            {
                return "нет вкладок скринера";
            }

            List<string> parts = new List<string>();

            for (int t = 0; t < _screenerTab.Tabs.Count; t++)
            {
                BotTabSimple tab = _screenerTab.Tabs[t];
                if (tab == null)
                {
                    continue;
                }

                string sec = tab.Connector?.SecurityName;
                if (string.IsNullOrWhiteSpace(sec))
                {
                    parts.Add((tab.TabName ?? "?") + ": бумага не задана");
                    continue;
                }

                if (TryGetTabChartMaster(tab) == null)
                {
                    parts.Add(sec + ": chartMaster отсутствует");
                    continue;
                }

                if (!TabIsMissingAnyRobotIndicator(tab))
                {
                    continue;
                }

                List<string> missingTypes = new List<string>();
                for (int i = 0; i < _screenerTab._indicators.Count; i++)
                {
                    IndicatorOnTabs ind = _screenerTab._indicators[i];
                    if (ind == null)
                    {
                        continue;
                    }

                    if (FindIndicatorOnTab(tab, ind.Num, ind.Type) == null)
                    {
                        missingTypes.Add(ind.Type);
                    }
                }

                parts.Add(sec + ": нет " + string.Join(", ", missingTypes));
            }

            if (parts.Count == 0)
            {
                return "вкладки ждут подключения бумаги (повторите «Обновить»)";
            }

            return string.Join("; ", parts);
        }

        /// <summary>
        /// Догрузка индикаторов робота на UI-потоке (не с потока свечи / коннектора).
        /// В тестере attach только при «Принять» (SyncAllLogicIndicators).
        /// </summary>
        private void ScheduleEnsureRobotIndicatorsOnTabIfNeeded(BotTabSimple tab, int candleIndex = -1)
        {
            if (tab == null || StartProgram == StartProgram.IsTester)
            {
                return;
            }

            if (!_loggedRobotIndicatorsUiThreadAttach)
            {
                _loggedRobotIndicatorsUiThreadAttach = true;
                SendNewLogMessage(
                    NameStrategyUniq
                    + " | Robot indicators: attach на UI-потоке (BeginInvoke), не с потока свечи/коннектора.",
                    LogMessageType.System);
            }

            RunOnUiThread(
                () => TryEnsureRobotIndicatorsOnTabIfNeeded(tab, candleIndex),
                preferAsync: true);
        }

        /// <summary>Догрузить индикаторы на одной вкладке, если после MOEX reload они не созданы (вызывать с UI).</summary>
        private void TryEnsureRobotIndicatorsOnTabIfNeeded(BotTabSimple tab, int candleIndex = -1)
        {
            if (tab == null
                || _screenerTab?._indicators == null
                || IsStopMonitorInstrumentTab(tab)
                || !IsTabChartReadyForIndicators(tab))
            {
                return;
            }

            string tabKey = tab.TabName;
            if (string.IsNullOrEmpty(tabKey))
            {
                return;
            }

            lock (_robotIndicatorsEnsureLock)
            {
                if (_robotIndicatorsReadyTabKeys.Contains(tabKey))
                {
                    return;
                }

                if (!TabIsMissingAnyRobotIndicator(tab))
                {
                    _robotIndicatorsReadyTabKeys.Add(tabKey);
                    return;
                }

                if (candleIndex >= 0
                    && _robotIndicatorsEnsureLastAttemptCandle.TryGetValue(tabKey, out int lastAttemptCandle)
                    && candleIndex - lastAttemptCandle < RobotIndicatorsEnsureRetryCandleInterval)
                {
                    return;
                }

                if (candleIndex >= 0)
                {
                    _robotIndicatorsEnsureLastAttemptCandle[tabKey] = candleIndex;
                }
            }

            for (int i = 0; i < _screenerTab._indicators.Count; i++)
            {
                IndicatorOnTabs ind = _screenerTab._indicators[i];
                if (ind == null)
                {
                    continue;
                }

                if (FindIndicatorOnTab(tab, ind.Num, ind.Type) == null)
                {
                    TryAttachRobotIndicatorOnTab(tab, ind);
                }
            }

            if (!TabIsMissingAnyRobotIndicator(tab))
            {
                lock (_robotIndicatorsEnsureLock)
                {
                    _robotIndicatorsReadyTabKeys.Add(tabKey);
                }
            }
        }

        private bool IsTabChartReadyForIndicators(BotTabSimple tab)
        {
            if (tab == null || string.IsNullOrWhiteSpace(tab.Connector?.SecurityName))
            {
                return false;
            }

            return TryGetTabChartMaster(tab) != null;
        }

        private static ChartCandleMaster TryGetTabChartMaster(BotTabSimple tab)
        {
            if (tab == null)
            {
                return null;
            }

            try
            {
                FieldInfo field = typeof(BotTabSimple).GetField(
                    "_chartMaster",
                    BindingFlags.Instance | BindingFlags.NonPublic);
                return field?.GetValue(tab) as ChartCandleMaster;
            }
            catch
            {
                return null;
            }
        }

        /// <summary>Создать/обновить индикатор на одной вкладке; false — пропуск без вызова ядра на неготовый чарт.</summary>
        private bool TryAttachRobotIndicatorOnTab(BotTabSimple tab, IndicatorOnTabs ind)
        {
            if (tab == null || ind == null || IsStopMonitorInstrumentTab(tab) || !IsTabChartReadyForIndicators(tab))
            {
                return false;
            }

            try
            {
                Aindicator existing = FindIndicatorOnTab(tab, ind.Num, ind.Type);
                if (existing != null)
                {
                    CopyIndicatorOnTabsParameters(ind, existing);
                    existing.Reload();
                    return true;
                }

                Aindicator newIndicator = IndicatorsFactory.CreateIndicatorByName(
                    ind.Type,
                    ind.Num + ind.Type + _screenerTab.TabName,
                    false);
                if (newIndicator == null)
                {
                    return false;
                }

                newIndicator.CanDelete = ind.CanDelete;
                CopyIndicatorOnTabsParameters(ind, newIndicator);

                Aindicator created;
                try
                {
                    created = (Aindicator)tab.CreateCandleIndicator(newIndicator, ind.NameArea);
                }
                catch (Exception ex)
                {
                    SendNewLogMessage(
                        NameStrategyUniq + " [" + tab.TabName + "] «" + ind.Type + "»: " + ex.Message,
                        LogMessageType.Error);
                    return false;
                }

                if (created == null)
                {
                    return false;
                }

                created.CanDelete = ind.CanDelete;
                created.Save();
                return true;
            }
            catch (Exception ex)
            {
                SendNewLogMessage(
                    NameStrategyUniq + " [" + tab.TabName + "] «" + ind.Type + "»: " + ex.Message,
                    LogMessageType.Error);
                return false;
            }
        }

        private static void CopyIndicatorOnTabsParameters(IndicatorOnTabs ind, Aindicator newIndicator)
        {
            if (ind?.Parameters == null || newIndicator?.Parameters == null)
            {
                return;
            }

            if (ind.Parameters.Count != newIndicator.Parameters.Count)
            {
                return;
            }

            for (int i2 = 0; i2 < ind.Parameters.Count; i2++)
            {
                IndicatorParameter param = newIndicator.Parameters[i2];
                string raw = ind.Parameters[i2];

                if (param.Type == IndicatorParameterType.Int)
                {
                    ((IndicatorParameterInt)param).ValueInt = Convert.ToInt32(raw, CultureInfo.InvariantCulture);
                }
                else if (param.Type == IndicatorParameterType.Decimal)
                {
                    ((IndicatorParameterDecimal)param).ValueDecimal = raw.ToDecimal();
                }
                else if (param.Type == IndicatorParameterType.Bool)
                {
                    ((IndicatorParameterBool)param).ValueBool = Convert.ToBoolean(raw, CultureInfo.InvariantCulture);
                }
                else if (param.Type == IndicatorParameterType.String)
                {
                    ((IndicatorParameterString)param).ValueString = raw;
                }
            }
        }

        /// <summary>
        /// Отложенный повтор перезагрузки вкладок (до 5 раз) после подключения TInvest.
        /// </summary>
        private void ScheduleMoexScreenerTabsReloadRetry(int expectedTabs, int attempt)
        {
            if (attempt > 5 || _screenerTab == null)
            {
                return;
            }

            Task.Run(async () =>
            {
                try
                {
                    await Task.Delay(2000).ConfigureAwait(false);

                    if (!ShouldUseMoexTesterConnector())
                    {
                        WaitForMoexServerReady(ResolveMoexLiveServer(), 10000);
                    }

                    RunMoexScreenerTabsReloadPass();

                    int tabsCount = _screenerTab.Tabs?.Count ?? 0;
                    if (expectedTabs > 0 && tabsCount < expectedTabs && attempt < 5)
                    {
                        ScheduleMoexScreenerTabsReloadRetry(expectedTabs, attempt + 1);
                        return;
                    }

                    if (tabsCount > 0)
                    {
                        string ok = NameStrategyUniq + ": догрузка вкладок скринера завершена (" + tabsCount + ").";
                        SendNewLogMessage(ok, LogMessageType.System);
                    }
                }
                catch (Exception ex)
                {
                    SendNewLogMessage(ex.ToString(), LogMessageType.Error);
                }
            });
        }

        /// <summary>
        /// Ожидание Connect и непустого Securities на сервере.
        /// </summary>
        private static bool WaitForMoexServerReady(IServer server, int maxWaitMs)
        {
            if (server == null || maxWaitMs <= 0)
            {
                return false;
            }

            DateTime deadline = DateTime.Now.AddMilliseconds(maxWaitMs);
            while (DateTime.Now < deadline)
            {
                if (server.ServerStatus == ServerConnectStatus.Connect)
                {
                    if (server.Securities == null || server.Securities.Count == 0)
                    {
                        Thread.Sleep(250);
                        continue;
                    }

                    return true;
                }

                Thread.Sleep(250);
            }

            return server.ServerStatus == ServerConnectStatus.Connect;
        }

        /// <summary>
        /// Создаёт CandleSeriesRealization у скринера и дочерних вкладок при необходимости.
        /// </summary>
        private void EnsureScreenerCandleInfrastructure()
        {
            if (_screenerTab == null)
            {
                return;
            }

            if (_screenerTab.CandleSeriesRealization == null)
            {
                string seriesType = string.IsNullOrWhiteSpace(_screenerTab.CandleCreateMethodType)
                    ? "Simple"
                    : _screenerTab.CandleCreateMethodType;
                _screenerTab.CandleSeriesRealization = CandleFactory.CreateCandleSeriesRealization(seriesType);
                _screenerTab.CandleSeriesRealization?.Init(StartProgram);
            }

            EnsureExistingScreenerTabsCandleInfrastructure();
        }

        /// <summary>
        /// Проставляет CandleSeriesRealization на всех существующих вкладках скринера.
        /// </summary>
        private void EnsureExistingScreenerTabsCandleInfrastructure()
        {
            if (_screenerTab?.Tabs == null || _screenerTab.CandleSeriesRealization == null)
            {
                return;
            }

            string screenerSeriesState = _screenerTab.CandleSeriesRealization.GetSaveString();

            for (int i = 0; i < _screenerTab.Tabs.Count; i++)
            {
                EnsureTabCandleSeriesRealization(_screenerTab.Tabs[i], screenerSeriesState);
            }
        }

        /// <summary>
        /// Инициализирует CandleSeriesRealization на коннекторе вкладки из состояния скринера.
        /// </summary>
        private void EnsureTabCandleSeriesRealization(BotTabSimple tab, string screenerSeriesState)
        {
            if (tab?.Connector?.TimeFrameBuilder == null)
            {
                return;
            }

            TimeFrameBuilder builder = tab.Connector.TimeFrameBuilder;
            if (builder.CandleSeriesRealization == null)
            {
                string seriesType = string.IsNullOrWhiteSpace(tab.Connector.CandleCreateMethodType)
                    ? "Simple"
                    : tab.Connector.CandleCreateMethodType;
                builder.CandleSeriesRealization = CandleFactory.CreateCandleSeriesRealization(seriesType);
                builder.CandleSeriesRealization?.Init(StartProgram);
            }

            if (builder.CandleSeriesRealization == null)
            {
                return;
            }

            if (!string.IsNullOrEmpty(screenerSeriesState))
            {
                builder.CandleSeriesRealization.SetSaveString(screenerSeriesState);
                builder.CandleSeriesRealization.OnStateChange(CandleSeriesState.ParametersChange);
            }
        }

        /// <summary>
        /// Разбор строки префиксов/тикеров через запятую без дубликатов.
        /// </summary>
        #endregion

        #region MOEX: тикеры, классы бумаг, поиск серверов

        private static List<string> ParseTickerPrefixes(string raw)
        {
            List<string> result = new List<string>();
            if (string.IsNullOrWhiteSpace(raw))
            {
                return result;
            }

            string[] parts = raw.Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries);
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < parts.Length; i++)
            {
                string p = parts[i].Trim();
                if (p.Length == 0 || seen.Contains(p))
                {
                    continue;
                }

                seen.Add(p);
                result.Add(p);
            }

            return result;
        }

        /// <summary>
        /// Корень FORTS бумаги совпадает с одним из префиксов (с алиасами CNY→CR).
        /// </summary>
        private static bool SecurityLetterRootMatchesAnyPrefix(Security sec, List<string> prefixes)
        {
            if (sec == null || prefixes == null || prefixes.Count == 0)
            {
                return false;
            }

            HashSet<string> tickersToTry = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            string[] candidates = { sec.Name, sec.NameFull, sec.NameId };
            for (int c = 0; c < candidates.Length; c++)
            {
                if (string.IsNullOrWhiteSpace(candidates[c]))
                {
                    continue;
                }

                string raw = candidates[c].Trim();
                string testerTicker = GetTesterInstrumentTicker(raw);
                if (!string.IsNullOrEmpty(testerTicker))
                {
                    tickersToTry.Add(testerTicker);
                }

                string normalized = NormalizeFuturesTicker(raw);
                if (!string.IsNullOrEmpty(normalized))
                {
                    tickersToTry.Add(normalized);
                }
            }

            foreach (string ticker in tickersToTry)
            {
                if (TickerLetterRootMatchesAnyPrefix(ticker, prefixes))
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Сводка по подключённому сету тестера: сколько строк всего и сколько на ТФ скринера.
        /// </summary>
        private static string FormatTesterSetTimeFrameDiagnostic(IServer server, TimeFrame requiredTimeFrame)
        {
            List<SecurityTester> testers = TryGetSecuritiesTesterList(server);
            if (testers == null || testers.Count == 0)
            {
                return "сет тестера пуст";
            }

            int totalRows = testers.Count;
            int onTf = 0;
            int futuresOnTf = 0;
            List<string> namesOnTf = new List<string>();

            for (int i = 0; i < testers.Count; i++)
            {
                SecurityTester st = testers[i];
                if (st?.Security == null || st.TimeFrame != requiredTimeFrame)
                {
                    continue;
                }

                onTf++;
                string name = GetTesterInstrumentTicker(st.Security.Name);
                if (string.IsNullOrEmpty(name))
                {
                    name = st.Security.Name?.Trim() ?? "";
                }

                if (!string.IsNullOrEmpty(name))
                {
                    namesOnTf.Add(name);
                }

                Security sec = new Security();
                sec.LoadFromString(st.Security.GetSaveStr());
                sec.Name = name;
                if (IsMoexFuturesStyleName(name))
                {
                    futuresOnTf++;
                }
            }

            string sample = namesOnTf.Count == 0
                ? "—"
                : string.Join(", ", namesOnTf.Take(20))
                + (namesOnTf.Count > 20 ? ", …" : "");

            return "всего в сете " + totalRows + " строк; на ТФ «" + requiredTimeFrame + "»: "
                + onTf + " (фьючерсных имён: " + futuresOnTf + "): " + sample;
        }

        /// <summary>
        /// Для сообщения об ошибке: корни FORTS бумаг в сете тестера.
        /// </summary>
        private static string FormatTesterFuturesRootsDiagnostic(
            List<Security> instruments,
            IServer server,
            MoexScreenerInstrumentMode mode)
        {
            if (instruments == null || instruments.Count == 0)
            {
                return "—";
            }

            List<string> parts = new List<string>();
            for (int i = 0; i < instruments.Count && parts.Count < 12; i++)
            {
                Security sec = instruments[i];
                if (!IsScreenerInstrument(sec, server, mode))
                {
                    continue;
                }

                string name = GetTesterInstrumentTicker(sec?.Name ?? "");
                if (string.IsNullOrEmpty(name))
                {
                    name = NormalizeFuturesTicker(sec?.Name ?? "");
                }

                if (string.IsNullOrEmpty(name))
                {
                    continue;
                }

                string root = ExtractFuturesLetterRoot(name);
                parts.Add(string.IsNullOrEmpty(root) || string.Equals(root, name, StringComparison.OrdinalIgnoreCase)
                    ? name
                    : name + "→" + root);
            }

            return parts.Count == 0 ? "—" : string.Join(", ", parts);
        }

        /// <summary>Tester: Security.Name = имя файла истории (SBER.txt, ROSN-6.26.csv).</summary>
        private static string GetTesterInstrumentTicker(string rawName)
        {
            if (string.IsNullOrWhiteSpace(rawName))
            {
                return string.Empty;
            }

            string t = rawName.Trim();
            int slash = t.LastIndexOf('\\');
            int slash2 = t.LastIndexOf('/');
            int sep = Math.Max(slash, slash2);
            if (sep >= 0 && sep < t.Length - 1)
            {
                t = t.Substring(sep + 1).Trim();
            }

            int dot = t.LastIndexOf('.');
            if (dot > 0)
            {
                t = t.Substring(0, dot).Trim();
            }

            return NormalizeFuturesTicker(t);
        }

        /// <summary>
        /// Примеры имён из сета тестера для сообщения об ошибке.
        /// </summary>
        private static string FormatTesterSetNameSamples(List<Security> instruments, int maxCount)
        {
            if (instruments == null || instruments.Count == 0 || maxCount <= 0)
            {
                return "—";
            }

            int take = Math.Min(maxCount, instruments.Count);
            List<string> parts = new List<string>(take);
            for (int i = 0; i < take; i++)
            {
                string raw = instruments[i]?.Name;
                if (string.IsNullOrWhiteSpace(raw))
                {
                    continue;
                }

                string ticker = GetTesterInstrumentTicker(raw);
                parts.Add(string.IsNullOrEmpty(ticker) || string.Equals(ticker, raw, StringComparison.OrdinalIgnoreCase)
                    ? raw
                    : raw + "→" + ticker);
            }

            return parts.Count == 0 ? "—" : string.Join(", ", parts);
        }

        /// <summary>Quik: «CRZ5+SPBFUT» → «CRZ5»; иные суффиксы после «+» отбрасываются.</summary>
        private static string NormalizeFuturesTicker(string ticker)
        {
            if (string.IsNullOrWhiteSpace(ticker))
            {
                return string.Empty;
            }

            string t = ticker.Trim();
            int plus = t.IndexOf('+');
            if (plus > 0)
            {
                t = t.Substring(0, plus).Trim();
            }

            return t;
        }

        /// <summary>
        /// Префикс пользователя + биржевые алиасы (CNY→CR).
        /// </summary>
        private static IEnumerable<string> ExpandPrefixWithMoexAliases(string userPrefix)
        {
            if (string.IsNullOrWhiteSpace(userPrefix))
            {
                yield break;
            }

            yield return userPrefix.Trim();

            if (MoexFuturesPrefixAliases.TryGetValue(userPrefix.Trim(), out string[] aliases))
            {
                for (int i = 0; i < aliases.Length; i++)
                {
                    if (!string.IsNullOrWhiteSpace(aliases[i]))
                    {
                        yield return aliases[i].Trim();
                    }
                }
            }
        }

        /// <summary>
        /// Корень для сопоставления с префиксом: до «-»/«.»; код FORTS вида CRZ5/LKZ5 → буквы до месяца (CR, LK);
        /// иначе буквы с начала (CNYRUBF → CNYRUBF).
        /// </summary>
        private static string ExtractFuturesLetterRoot(string ticker)
        {
            if (string.IsNullOrWhiteSpace(ticker))
            {
                return string.Empty;
            }

            string t = GetTesterInstrumentTicker(ticker);
            if (string.IsNullOrEmpty(t))
            {
                t = NormalizeFuturesTicker(ticker);
            }
            else
            {
                t = NormalizeFuturesTicker(t);
            }
            int dash = t.IndexOf('-');
            if (dash > 0)
            {
                return t.Substring(0, dash).Trim();
            }

            int dot = t.IndexOf('.');
            if (dot > 0)
            {
                bool allLettersBeforeDot = true;
                for (int k = 0; k < dot; k++)
                {
                    if (!char.IsLetter(t[k]))
                    {
                        allLettersBeforeDot = false;
                        break;
                    }
                }

                if (allLettersBeforeDot)
                {
                    return t.Substring(0, dot).Trim();
                }
            }

            string fortBase = TryExtractMoexFortsSeriesBase(t);
            if (fortBase.Length > 0)
            {
                return fortBase;
            }

            int end = 0;
            while (end < t.Length && char.IsLetter(t[end]))
            {
                end++;
            }

            return end > 0 ? t.Substring(0, end) : string.Empty;
        }

        /// <summary>Краткий код серии FORTS: CRZ5 → CR, SiH6 → Si (последние 2 символа — месяц и год).</summary>
        private static string TryExtractMoexFortsSeriesBase(string ticker)
        {
            if (ticker.Length < 3)
            {
                return string.Empty;
            }

            int len = ticker.Length;
            char yearCh = ticker[len - 1];
            char monthCh = ticker[len - 2];

            if (!char.IsLetter(monthCh) || !char.IsDigit(yearCh))
            {
                return string.Empty;
            }

            string basePart = ticker.Substring(0, len - 2);
            if (basePart.Length < 1)
            {
                return string.Empty;
            }

            for (int i = 0; i < basePart.Length; i++)
            {
                if (!char.IsLetter(basePart[i]))
                {
                    return string.Empty;
                }
            }

            return basePart;
        }

        /// <summary>
        /// Совпадение корня с префиксом (включая вложенные префиксы).
        /// </summary>
        private static bool RootMatchesExpandedPrefix(string root, string expandedPrefix)
        {
            if (root.Length == 0 || string.IsNullOrWhiteSpace(expandedPrefix))
            {
                return false;
            }

            if (string.Equals(root, expandedPrefix, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            if (expandedPrefix.Length <= root.Length
                && root.StartsWith(expandedPrefix, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            if (root.Length <= expandedPrefix.Length
                && expandedPrefix.StartsWith(root, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            return false;
        }

        /// <summary>
        /// Корень тикера подходит под любой префикс из списка.
        /// </summary>
        private static bool TickerLetterRootMatchesAnyPrefix(string ticker, List<string> prefixes)
        {
            string normalized = GetTesterInstrumentTicker(ticker);
            if (string.IsNullOrEmpty(normalized))
            {
                normalized = NormalizeFuturesTicker(ticker);
            }
            else
            {
                normalized = NormalizeFuturesTicker(normalized);
            }

            string root = ExtractFuturesLetterRoot(normalized);

            if (root.Length == 0 && normalized.Length == 0)
            {
                return false;
            }

            for (int i = 0; i < prefixes.Count; i++)
            {
                foreach (string expanded in ExpandPrefixWithMoexAliases(prefixes[i]))
                {
                    if (string.IsNullOrWhiteSpace(expanded))
                    {
                        continue;
                    }

                    if (root.Length > 0 && RootMatchesExpandedPrefix(root, expanded))
                    {
                        return true;
                    }

                    if (normalized.Length > 0
                        && expanded.Length <= normalized.Length
                        && normalized.StartsWith(expanded, StringComparison.OrdinalIgnoreCase))
                    {
                        return true;
                    }

                    if (normalized.Length > 0
                        && expanded.Length >= 2
                        && normalized.IndexOf(expanded, StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        #endregion


        public IReadOnlyList<string> GetConfiguredLogicNames()
        {
            return new[]
            {
                _logic1?.ValueString ?? "",
                _logic2?.ValueString ?? "",
                _logic3?.ValueString ?? "",
                _logic4?.ValueString ?? "",
                _logic5?.ValueString ?? "",
                _logic6?.ValueString ?? "",
                _logic7?.ValueString ?? "",
                _logic8?.ValueString ?? "",
                _logic9?.ValueString ?? "",
                _logic10?.ValueString ?? "",
            };
        }

        #endregion
    }

    /*
     * ////////////////////////////////////////////////////////////////////////////////
     * ////////////////////////////////////////////////////////////////////////////////
     * ////////////////////////////////////////////////////////////////////////////////
     * БЛОК 4 — HTML-ОТЧЁТ ПО РЕЗУЛЬТАТАМ ТЕСТИРОВАНИЯ / ЛАЙВА
     * Файл Engine\{имя робота}_Report.html · графики equity, металогика, сделки.
     * ////////////////////////////////////////////////////////////////////////////////
     * ////////////////////////////////////////////////////////////////////////////////
     * ////////////////////////////////////////////////////////////////////////////////
     */
    public partial class MultiLogic
    {
        #region БЛОК 4 — HTML-ОТЧЁТ (_Report.html)

        private const string HtmlReportTabName = "Отчёт";
        private const string HtmlReportEnableParamName = "HTML-отчёт: включить";
        private const string HtmlReportIntervalParamName = "HTML-отчёт: интервал (сек)";
        private const string HtmlReportOpenButtonName = "Открыть HTML-отчёт";
        /// <summary>Кнопка на первой вкладке — открыть Engine\{имя}_Report.html.</summary>
        private const string OpenHtmlReportMainTabButtonName = "Открыть HTML-файл результатов тестирования";
        private const string HtmlReportFileSuffix = "_Report.html";
        private const int HtmlReportDefaultIntervalSeconds = 90;
        private const int HtmlReportMinIntervalSeconds = 30;
        private const int HtmlReportRecentEventsCap = 200;
        private const int HtmlReportClosedTradesCap = 1500;
        private const int HtmlReportOpenFallbackEventsCap = 100;
        private const int HtmlReportMetaLogicJournalCap = 300;
        private const int HtmlReportEquitySnapshotsCap = 2500;
        private const int HtmlReportStopperEventsCap = 100;
        private const int HtmlReportConfigChangeJournalCap = 500;
        private const string HtmlReportFormatVersion = "4";

        private static readonly string[] HtmlReportGlobalTradingParamNames =
        {
            "Regime",
            LogicLinRegLengthParamName,
            "Max positions (all tabs)",
            "Volume type",
            "Volume",
            "Asset in portfolio",
            MetaLogicEnabledParamName,
            MetaLogicInversionParamName,
            PortfolioPnlSmaEnableParamName,
            PortfolioPnlSmaLenParamName,
            "Общепортфельный SMA: включить",
            "Общепортфельный SMA: длина",
            "Общепортфельный SMA: источник",
            "Общепортфельный Stoch: включить",
            "Общепортфельный Stoch: P1",
            "Общепортфельный Stoch: P2",
            "Общепортфельный Stoch: P3",
            "Общепортфельный Stoch: long min",
            "Общепортфельный Stoch: short max",
            "Общепортфельный ATR: включить",
            "Общепортфельный ATR: длина",
            "Общепортфельный ATR: min grow % vs lookback",
            "Общепортфельный ATR: grow lookback (candles)",
            "Общепортфельный LinReg: включить",
            "Общепортфельный LinReg: длина",
            "Общепортфельный LinReg: deviation",
            "Общепортфельный MACD: включить",
            "Общепортфельный MACD: fast",
            "Общепортфельный MACD: slow",
            "Общепортфельный MACD: signal",
            "Предыдущий индикатор. Расчёт объёма позиций",
            "Общепортфельный stop-loss: включён",
            "Общепортфельный stop-loss (%)",
            PortfolioStopLossRublesParamName,
            "Общепортфельный take-profit: включён",
            "Общепортфельный take-profit (%)",
            PortfolioTakeProfitRublesParamName,
            StopperPostTriggerAfterStopLossParamName,
            StopperPostTriggerAfterTakeProfitParamName,
            "Предыдущая сумма портфеля: lookback (свечей)",
            StopperMonitorTimeFrameParamName,
            StopperMonitorSecurityParamName,
            StopperEodFlatSellParamName
        };

        private StrategyParameterBool _htmlReportEnabled;
        private StrategyParameterInt _htmlReportIntervalSec;
        private StrategyParameterButton _htmlReportOpenButton;
        private StrategyParameterButton _openHtmlReportMainTabButton;

        private readonly MultiLogicHtmlReportRuntime _htmlReportRuntime = new MultiLogicHtmlReportRuntime();
        private readonly object _htmlReportRuntimeLock = new object();
        private bool _htmlReportDirty;
        private DateTime _htmlReportLastWriteUtc = DateTime.MinValue;
        private long _htmlReportConfigChangeSeq;
        private bool _htmlReportConfigBaselineReady;
        private string[] _htmlReportConfigBaselineLogicLines = new string[LogicSlotCount];
        private Dictionary<string, string> _htmlReportConfigBaselineParams =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        private sealed class MultiLogicHtmlReportRuntime
        {
            public DateTime SessionStartedUtc = DateTime.UtcNow;
            public int OpensTotal;
            public int ClosesTotal;
            public readonly Dictionary<string, HtmlReportInstrumentStats> ByInstrument =
                new Dictionary<string, HtmlReportInstrumentStats>(StringComparer.OrdinalIgnoreCase);
            public readonly Dictionary<int, HtmlReportLogicStats> ByLogic =
                new Dictionary<int, HtmlReportLogicStats>();
            public readonly Dictionary<string, HtmlReportDayBucket> ByDay =
                new Dictionary<string, HtmlReportDayBucket>(StringComparer.OrdinalIgnoreCase);
            public readonly Dictionary<string, int> CloseReasons =
                new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            public readonly Dictionary<string, decimal> CloseReasonPnL =
                new Dictionary<string, decimal>(StringComparer.OrdinalIgnoreCase);
            public readonly List<HtmlReportRecentEvent> RecentEvents = new List<HtmlReportRecentEvent>();
            public readonly List<HtmlReportClosedTrade> ClosedTrades = new List<HtmlReportClosedTrade>();
            public readonly List<HtmlReportMetaLogicJournalEntry> MetaLogicJournal =
                new List<HtmlReportMetaLogicJournalEntry>();
            public readonly List<HtmlReportEquitySnapshot> EquitySnapshots = new List<HtmlReportEquitySnapshot>();
            public readonly Dictionary<int, List<HtmlReportLogicSnapshotPoint>> LogicSnapshots =
                new Dictionary<int, List<HtmlReportLogicSnapshotPoint>>();
            public readonly List<HtmlReportStopperEvent> StopperEvents = new List<HtmlReportStopperEvent>();
            public readonly List<HtmlReportModeSegment> ModeHistory = new List<HtmlReportModeSegment>();
            public readonly List<HtmlReportConfigChangeEntry> ConfigChangeJournal =
                new List<HtmlReportConfigChangeEntry>();
            public string ActiveModeId = "";
        }

        private sealed class HtmlReportConfigChangeEntry
        {
            public long Id;
            public DateTime CandleTime;
            public DateTime EventTimeUtc;
            public string Category = "";
            public int LogicSlot;
            public string ParamName = "";
            public string Summary = "";
            public string OldValue = "";
            public string NewValue = "";
            public string OldLogicLine = "";
            public string NewLogicLine = "";
            public bool AffectsGlobalChart;
            public bool AffectsLogicChart;
        }

        private sealed class HtmlReportLogicSnapshotPoint
        {
            public DateTime CandleTime;
            public decimal Equity;
            public decimal Realized;
            public decimal Unrealized;
            public int OpensCumulative;
            public int ClosesCumulative;
            public int OpenPositionsNow;
        }

        private sealed class HtmlReportStopperEvent
        {
            public DateTime CandleTime;
            public DateTime EventTimeUtc;
            public string Kind = "";
            public decimal ReferenceEquity;
            public decimal CurrentEquity;
            public decimal ThresholdPercent;
            public decimal TriggerLevel;
            public decimal PostCloseEquity;
            public bool RegimeStopped;
            public string ExecutionModeId = "";
            public string ExecutionModeLabel = "";
            public string Summary = "";
        }

        private sealed class HtmlReportInstrumentStats
        {
            public string TabKey = "";
            public int Opens;
            public int Closes;
            public decimal RealizedPnL;
        }

        private sealed class HtmlReportLogicStats
        {
            public int Slot;
            public int Opens;
            public int Closes;
            public decimal RealizedPnL;
            public decimal PnLPortfolioStopSL;
            public decimal PnLPortfolioStopTP;
            public decimal PnLPortfolioEodFlat;
            public decimal PnLLogicStopLoss;
            public decimal PnLLogicTakeProfit;
            public decimal PnLSignalClose;
            public decimal PnLRegimeFlip;
            public decimal PnLStopRobot;
            public decimal PnLOther;
        }

        private sealed class HtmlReportDayBucket
        {
            public string DayKey = "";
            public int Opens;
            public int Closes;
        }

        private sealed class HtmlReportRecentEvent
        {
            public long Seq;
            public DateTime CandleTime;
            public DateTime EventTimeUtc;
            public string Event = "";
            public string TabKey = "";
            public int LogicSlot;
            public decimal Delta;
            public decimal EquityTotal;
            public string Note = "";
            public string ExecutionModeId = "";
            public string ExecutionModeLabel = "";
        }

        private sealed class HtmlReportEquitySnapshot
        {
            public DateTime CandleTime;
            public decimal EquityTotal;
            public decimal RealizedTotal;
            public decimal UnrealizedTotal;
            public int OpenPositionsCount;
            public int OpensTotal;
            public int ClosesTotal;
            public string ExecutionModeId = "";
            public string ExecutionModeLabel = "";
        }

        private sealed class HtmlReportClosedTrade
        {
            public string TabKey = "";
            public int LogicSlot;
            public DateTime OpenTime;
            public DateTime CloseTime;
            public decimal Delta;
            public string Note = "";
            public string CloseReason = "";
            public string DurationLabel = "";
        }

        private sealed class HtmlReportMetaLogicAllocationLine
        {
            public int Rank;
            public int Slot;
            public string LogicNote = "";
            public decimal? PnlSmaAvg;
            public decimal? PnlSmaLast;
            public decimal AbsWeightSharePct;
            public decimal Volume;
            public string Side = "";
            public bool Opened;
            public bool Skipped;
        }

        private sealed class HtmlReportMetaLogicJournalEntry
        {
            public DateTime CandleTime;
            public DateTime EventTimeUtc;
            public string TabKey = "";
            /// <summary>meta — PnlSMA; warmup — мета вкл., окно не готово; plain — мета выкл.; ready — PnlSMA стал готов.</summary>
            public string Mode = "";
            public int CandidatesTotal;
            public int EntriesOpened;
            public decimal TotalVolume;
            public int FreeSlots;
            public string Summary = "";
            public readonly List<HtmlReportMetaLogicAllocationLine> Lines =
                new List<HtmlReportMetaLogicAllocationLine>();
        }

        private sealed class HtmlReportModeSegment
        {
            public DateTime FromUtc;
            public DateTime? ToUtc;
            public string ModeId = "";
            public string ModeLabel = "";
            public string StartProgram = "";
            public bool EmulatorIsOn;
        }

        private sealed class HtmlReportExecutionMode
        {
            public string ModeId = "";
            public string ModeLabel = "";
            public string StartProgram = "";
            public bool EmulatorIsOn;
        }

        private void CreateHtmlReportParameters()
        {
            _htmlReportEnabled = CreateParameter(HtmlReportEnableParamName, true, HtmlReportTabName);
            _htmlReportIntervalSec = CreateParameter(
                HtmlReportIntervalParamName,
                HtmlReportDefaultIntervalSeconds,
                HtmlReportMinIntervalSeconds,
                3600,
                10,
                HtmlReportTabName);
            _htmlReportOpenButton = CreateParameterButton(HtmlReportOpenButtonName, HtmlReportTabName);
            _htmlReportOpenButton.UserClickOnButtonEvent += HtmlReportOpenButton_UserClickOnButtonEvent;
        }

        private void WireHtmlReportButtons()
        {
            WireLogicTabButton(HtmlReportOpenButtonName, HtmlReportOpenButton_UserClickOnButtonEvent);
            WireLogicTabButton(OpenHtmlReportMainTabButtonName, HtmlReportOpenButton_UserClickOnButtonEvent);
        }

        private void HtmlReportOpenButton_UserClickOnButtonEvent()
        {
            MaybeWriteHtmlReport(force: true);
            OpenHtmlReportFile();
        }

        private void InitializeHtmlReportSession()
        {
            lock (_htmlReportRuntimeLock)
            {
                _htmlReportRuntime.SessionStartedUtc = DateTime.UtcNow;
                TouchHtmlReportExecutionMode(null);
                _htmlReportDirty = true;
            }

            MaybeWriteHtmlReport(force: true);
        }

        private HtmlReportExecutionMode ResolveHtmlReportExecutionMode(BotTabSimple tab)
        {
            var mode = new HtmlReportExecutionMode
            {
                StartProgram = StartProgram.ToString()
            };

            if (StartProgram == StartProgram.IsTester)
            {
                mode.ModeId = "tester";
                mode.ModeLabel = "Тестер";
                mode.EmulatorIsOn = false;
                return mode;
            }

            if (StartProgram == StartProgram.IsOsOptimizer)
            {
                mode.ModeId = "optimizer";
                mode.ModeLabel = "Оптимизатор";
                mode.EmulatorIsOn = false;
                return mode;
            }

            bool emulator = _screenerTab?.EmulatorIsOn == true
                || tab?.EmulatorIsOn == true
                || tab?.Connector?.EmulatorIsOn == true;
            mode.EmulatorIsOn = emulator;

            if (emulator)
            {
                mode.ModeId = "fake";
                mode.ModeLabel = "Фейк (эмулятор OsEngine)";
                return mode;
            }

            mode.ModeId = "live";
            mode.ModeLabel = "Лайв (биржа)";
            return mode;
        }

        private void TouchHtmlReportExecutionMode(BotTabSimple tab)
        {
            HtmlReportExecutionMode mode = ResolveHtmlReportExecutionMode(tab);
            MultiLogicHtmlReportRuntime rt = _htmlReportRuntime;

            if (string.Equals(rt.ActiveModeId, mode.ModeId, StringComparison.OrdinalIgnoreCase)
                && rt.ModeHistory.Count > 0)
            {
                HtmlReportModeSegment last = rt.ModeHistory[rt.ModeHistory.Count - 1];
                if (last.EmulatorIsOn == mode.EmulatorIsOn
                    && string.Equals(last.StartProgram, mode.StartProgram, StringComparison.OrdinalIgnoreCase))
                {
                    return;
                }
            }

            if (rt.ModeHistory.Count > 0)
            {
                HtmlReportModeSegment prev = rt.ModeHistory[rt.ModeHistory.Count - 1];
                if (!prev.ToUtc.HasValue)
                {
                    prev.ToUtc = DateTime.UtcNow;
                }
            }

            rt.ModeHistory.Add(new HtmlReportModeSegment
            {
                FromUtc = DateTime.UtcNow,
                ModeId = mode.ModeId,
                ModeLabel = mode.ModeLabel,
                StartProgram = mode.StartProgram,
                EmulatorIsOn = mode.EmulatorIsOn
            });
            rt.ActiveModeId = mode.ModeId;
            _htmlReportDirty = true;
        }

        private void RecordHtmlReportTradeEvent(
            int slot,
            bool isOpen,
            string tabKey,
            string note,
            decimal delta,
            DateTime candleTime,
            DateTime? positionOpenTime = null,
            DateTime? positionCloseTime = null)
        {
            if (_htmlReportEnabled == null || !_htmlReportEnabled.ValueBool || slot < 1 || slot > LogicSlotCount)
            {
                return;
            }

            lock (_htmlReportRuntimeLock)
            {
                RecordHtmlReportTradeEventCore(
                    slot,
                    isOpen,
                    tabKey,
                    note,
                    delta,
                    candleTime,
                    positionOpenTime,
                    positionCloseTime);
            }
        }

        private void RecordHtmlReportTradeEventCore(
            int slot,
            bool isOpen,
            string tabKey,
            string note,
            decimal delta,
            DateTime candleTime,
            DateTime? positionOpenTime = null,
            DateTime? positionCloseTime = null)
        {
            TouchHtmlReportExecutionMode(null);
            HtmlReportExecutionMode mode = ResolveHtmlReportExecutionMode(null);
            MultiLogicHtmlReportRuntime rt = _htmlReportRuntime;
            string dayKey = candleTime.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

            if (!rt.ByLogic.TryGetValue(slot, out HtmlReportLogicStats logic))
            {
                logic = new HtmlReportLogicStats { Slot = slot };
                rt.ByLogic[slot] = logic;
            }

            if (isOpen)
            {
                rt.OpensTotal++;
            }
            else
            {
                rt.ClosesTotal++;
                string reason = ClassifyHtmlReportCloseReason(note);
                if (!rt.CloseReasons.ContainsKey(reason))
                {
                    rt.CloseReasons[reason] = 0;
                }

                rt.CloseReasons[reason]++;
                AccumulateHtmlReportCloseReasonPnL(rt.CloseReasonPnL, reason, delta);
                AddHtmlReportLogicClosePnLByReason(logic, reason, delta);

                if (positionOpenTime.HasValue && positionCloseTime.HasValue)
                {
                    rt.ClosedTrades.Add(new HtmlReportClosedTrade
                    {
                        TabKey = string.IsNullOrWhiteSpace(tabKey) ? "?" : tabKey.Trim(),
                        LogicSlot = slot,
                        OpenTime = positionOpenTime.Value,
                        CloseTime = positionCloseTime.Value,
                        Delta = delta,
                        Note = note ?? "",
                        CloseReason = reason,
                        DurationLabel = FormatHtmlReportTradeDuration(
                            positionOpenTime.Value,
                            positionCloseTime.Value)
                    });
                    TrimHtmlReportClosedTrades(rt.ClosedTrades);
                }
            }

            if (!rt.ByDay.TryGetValue(dayKey, out HtmlReportDayBucket day))
            {
                day = new HtmlReportDayBucket { DayKey = dayKey };
                rt.ByDay[dayKey] = day;
            }

            if (isOpen)
            {
                day.Opens++;
            }
            else
            {
                day.Closes++;
            }

            string instrumentKey = string.IsNullOrWhiteSpace(tabKey) ? "?" : tabKey.Trim();
            if (!rt.ByInstrument.TryGetValue(instrumentKey, out HtmlReportInstrumentStats inst))
            {
                inst = new HtmlReportInstrumentStats { TabKey = instrumentKey };
                rt.ByInstrument[instrumentKey] = inst;
            }

            if (isOpen)
            {
                inst.Opens++;
            }
            else
            {
                inst.Closes++;
                inst.RealizedPnL += delta;
            }

            if (isOpen)
            {
                logic.Opens++;
            }
            else
            {
                logic.Closes++;
                logic.RealizedPnL += delta;
            }

            rt.RecentEvents.Add(new HtmlReportRecentEvent
            {
                Seq = _logicPortfolios[slot].LastSeq,
                CandleTime = candleTime,
                EventTimeUtc = DateTime.UtcNow,
                Event = isOpen ? "open" : "close",
                TabKey = instrumentKey,
                LogicSlot = slot,
                Delta = delta,
                EquityTotal = GetCombinedLogicPortfolioEquity(),
                Note = note ?? "",
                ExecutionModeId = mode.ModeId,
                ExecutionModeLabel = mode.ModeLabel
            });

            TrimHtmlReportRecentEvents(rt.RecentEvents);
            RecordHtmlReportLogicSnapshotCore(slot, candleTime);
            _htmlReportDirty = true;
        }

        private int CountOpenPositionsForLogicSlot(int slot)
        {
            if (slot < 1 || slot > LogicSlotCount || _screenerTab?.Tabs == null)
            {
                return 0;
            }

            string botType = GetNameStrategyType();
            int count = 0;

            for (int t = 0; t < _screenerTab.Tabs.Count; t++)
            {
                BotTabSimple tab = _screenerTab.Tabs[t];
                if (tab?.PositionsOpenAll == null)
                {
                    continue;
                }

                for (int i = 0; i < tab.PositionsOpenAll.Count; i++)
                {
                    Position pos = tab.PositionsOpenAll[i];
                    if (!IsOurMultiLogicOpenPosition(pos, botType)
                        || !TryParseLogicSlotFromSignal(pos.SignalTypeOpen, out int posSlot)
                        || posSlot != slot)
                    {
                        continue;
                    }

                    count++;
                }
            }

            return count;
        }

        private void RecordHtmlReportLogicSnapshot(int slot, DateTime candleTime)
        {
            if (_htmlReportEnabled == null || !_htmlReportEnabled.ValueBool
                || slot < 1 || slot > LogicSlotCount)
            {
                return;
            }

            lock (_htmlReportRuntimeLock)
            {
                RecordHtmlReportLogicSnapshotCore(slot, candleTime);
            }
        }

        private void RecordHtmlReportLogicSnapshotCore(int slot, DateTime candleTime)
        {
            MultiLogicHtmlReportRuntime rt = _htmlReportRuntime;
            if (!rt.LogicSnapshots.TryGetValue(slot, out List<HtmlReportLogicSnapshotPoint> list))
            {
                list = new List<HtmlReportLogicSnapshotPoint>();
                rt.LogicSnapshots[slot] = list;
            }

            rt.ByLogic.TryGetValue(slot, out HtmlReportLogicStats stats);
            LogicPortfolioRuntime portfolio = _logicPortfolios[slot];
            list.Add(new HtmlReportLogicSnapshotPoint
            {
                CandleTime = candleTime,
                Equity = portfolio.Equity,
                Realized = portfolio.Realized,
                Unrealized = portfolio.Unrealized,
                OpensCumulative = stats?.Opens ?? 0,
                ClosesCumulative = stats?.Closes ?? 0,
                OpenPositionsNow = CountOpenPositionsForLogicSlot(slot)
            });

            if (list.Count > HtmlReportEquitySnapshotsCap)
            {
                int remove = list.Count - HtmlReportEquitySnapshotsCap;
                list.RemoveRange(0, remove);
            }
        }

        private void RecordHtmlReportEquitySnapshot(DateTime candleTime)
        {
            if (!_htmlReportEnabled.ValueBool)
            {
                return;
            }

            lock (_htmlReportRuntimeLock)
            {
                RecordHtmlReportEquitySnapshotCore(candleTime);
            }
        }

        private void RecordHtmlReportEquitySnapshotCore(DateTime candleTime)
        {
            TouchHtmlReportExecutionMode(null);
            HtmlReportExecutionMode mode = ResolveHtmlReportExecutionMode(null);
            decimal realized = 0m;
            decimal unrealized = 0m;
            for (int slot = 1; slot <= LogicSlotCount; slot++)
            {
                realized += _logicPortfolios[slot].Realized;
                unrealized += _logicPortfolios[slot].Unrealized;
            }

            _htmlReportRuntime.EquitySnapshots.Add(new HtmlReportEquitySnapshot
            {
                CandleTime = candleTime,
                EquityTotal = realized + unrealized,
                RealizedTotal = realized,
                UnrealizedTotal = unrealized,
                OpenPositionsCount = CountScreenerOpenPositions(),
                OpensTotal = _htmlReportRuntime.OpensTotal,
                ClosesTotal = _htmlReportRuntime.ClosesTotal,
                ExecutionModeId = mode.ModeId,
                ExecutionModeLabel = mode.ModeLabel
            });

            if (_htmlReportRuntime.EquitySnapshots.Count > HtmlReportEquitySnapshotsCap)
            {
                int remove = _htmlReportRuntime.EquitySnapshots.Count - HtmlReportEquitySnapshotsCap;
                _htmlReportRuntime.EquitySnapshots.RemoveRange(0, remove);
            }

            for (int slot = 1; slot <= LogicSlotCount; slot++)
            {
                RecordHtmlReportLogicSnapshotCore(slot, candleTime);
            }

            _htmlReportDirty = true;
        }

        private void RecordHtmlReportStopperTrigger(
            DateTime candleTime,
            bool isTakeProfit,
            decimal referenceEquity,
            decimal currentEquity,
            decimal thresholdPercent,
            decimal thresholdRubles,
            decimal triggerLevel,
            string thresholdLabel,
            bool regimeStopped)
        {
            if (_htmlReportEnabled == null || !_htmlReportEnabled.ValueBool)
            {
                return;
            }

            lock (_htmlReportRuntimeLock)
            {
                RecordHtmlReportStopperTriggerCore(
                    candleTime,
                    isTakeProfit,
                    referenceEquity,
                    currentEquity,
                    thresholdPercent,
                    thresholdRubles,
                    triggerLevel,
                    thresholdLabel,
                    regimeStopped);
            }
        }

        private void RecordHtmlReportStopperTriggerCore(
            DateTime candleTime,
            bool isTakeProfit,
            decimal referenceEquity,
            decimal currentEquity,
            decimal thresholdPercent,
            decimal thresholdRubles,
            decimal triggerLevel,
            string thresholdLabel,
            bool regimeStopped)
        {
            TouchHtmlReportExecutionMode(null);
            HtmlReportExecutionMode mode = ResolveHtmlReportExecutionMode(null);
            string kind = isTakeProfit ? "portfolio_take_profit" : "portfolio_stop_loss";
            string kindLabel = isTakeProfit ? "Take-profit" : "Stop-loss";
            decimal postCloseEquity = TryGetStopperMonitoredEquity(TryGetPortfolioMonitoringReferenceTab());
            if (postCloseEquity <= 0m)
            {
                RecalculateAllLogicPortfolioUnrealized();
                postCloseEquity = GetCombinedLogicPortfolioEquity();
            }

            string label = string.IsNullOrWhiteSpace(thresholdLabel)
                ? BuildStopperThresholdLabel(thresholdPercent, thresholdRubles, isTakeProfit)
                : thresholdLabel;
            string summary = kindLabel
                + " "
                + label
                + " | ref="
                + referenceEquity.ToString(CultureInfo.InvariantCulture)
                + ", equity="
                + currentEquity.ToString(CultureInfo.InvariantCulture)
                + ", порог="
                + triggerLevel.ToString(CultureInfo.InvariantCulture)
                + ", ref→"
                + postCloseEquity.ToString(CultureInfo.InvariantCulture)
                + (regimeStopped ? ", Regime=Off" : "");

            _htmlReportRuntime.StopperEvents.Add(new HtmlReportStopperEvent
            {
                CandleTime = candleTime,
                EventTimeUtc = DateTime.UtcNow,
                Kind = kind,
                ReferenceEquity = referenceEquity,
                CurrentEquity = currentEquity,
                ThresholdPercent = thresholdPercent,
                TriggerLevel = triggerLevel,
                PostCloseEquity = postCloseEquity,
                RegimeStopped = regimeStopped,
                ExecutionModeId = mode.ModeId,
                ExecutionModeLabel = mode.ModeLabel,
                Summary = summary
            });

            if (_htmlReportRuntime.StopperEvents.Count > HtmlReportStopperEventsCap)
            {
                int remove = _htmlReportRuntime.StopperEvents.Count - HtmlReportStopperEventsCap;
                _htmlReportRuntime.StopperEvents.RemoveRange(0, remove);
            }

            _htmlReportRuntime.RecentEvents.Add(new HtmlReportRecentEvent
            {
                Seq = 0,
                CandleTime = candleTime,
                EventTimeUtc = DateTime.UtcNow,
                Event = kind,
                TabKey = "—",
                LogicSlot = 0,
                Delta = currentEquity - referenceEquity,
                EquityTotal = currentEquity,
                Note = summary,
                ExecutionModeId = mode.ModeId,
                ExecutionModeLabel = mode.ModeLabel
            });
            TrimHtmlReportRecentEvents(_htmlReportRuntime.RecentEvents);
            _htmlReportDirty = true;
        }

        private void RecordHtmlReportPeakDrawdownTrigger(
            DateTime candleTime,
            decimal peakEquity,
            decimal currentEquity,
            decimal thresholdPercent,
            decimal triggerLevel,
            decimal postCloseEquity,
            bool regimeStopped)
        {
            if (_htmlReportEnabled == null || !_htmlReportEnabled.ValueBool)
            {
                return;
            }

            lock (_htmlReportRuntimeLock)
            {
                TouchHtmlReportExecutionMode(null);
                HtmlReportExecutionMode mode = ResolveHtmlReportExecutionMode(null);
                string summary = "Просадка от пика "
                    + thresholdPercent.ToString(CultureInfo.InvariantCulture)
                    + "% | пик="
                    + peakEquity.ToString(CultureInfo.InvariantCulture)
                    + ", equity="
                    + currentEquity.ToString(CultureInfo.InvariantCulture)
                    + ", порог="
                    + triggerLevel.ToString(CultureInfo.InvariantCulture)
                    + ", ref→"
                    + postCloseEquity.ToString(CultureInfo.InvariantCulture)
                    + (regimeStopped ? ", Regime=Off" : "");

                AddHtmlReportStopperEvent(
                    candleTime,
                    "portfolio_peak_drawdown",
                    peakEquity,
                    currentEquity,
                    thresholdPercent,
                    triggerLevel,
                    postCloseEquity,
                    regimeStopped,
                    mode,
                    summary);
            }
        }

        private void RecordHtmlReportSignificantPeakPause(
            DateTime candleTime,
            decimal troughEquity,
            decimal peakEquity,
            double annualPercent,
            TimeSpan peakWidth,
            DateTime pauseUntil)
        {
            if (_htmlReportEnabled == null || !_htmlReportEnabled.ValueBool)
            {
                return;
            }

            lock (_htmlReportRuntimeLock)
            {
                TouchHtmlReportExecutionMode(null);
                HtmlReportExecutionMode mode = ResolveHtmlReportExecutionMode(null);
                decimal threshold = _significantPeakAnnualPercentMin?.ValueDecimal ?? SignificantPeakAnnualPercentDefault;
                string summary = "Пауза: значительный пик ~"
                    + FormatSignificantPeakAnnualPercentForDisplay(annualPercent)
                    + "% годовых (порог "
                    + threshold.ToString(CultureInfo.InvariantCulture)
                    + "%), "
                    + troughEquity.ToString(CultureInfo.InvariantCulture)
                    + " → "
                    + peakEquity.ToString(CultureInfo.InvariantCulture)
                    + ", ширина "
                    + peakWidth.ToString(@"d\.hh\:mm", CultureInfo.InvariantCulture)
                    + ", входы до "
                    + pauseUntil.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture);

                AddHtmlReportStopperEvent(
                    candleTime,
                    "portfolio_significant_peak_pause",
                    troughEquity,
                    peakEquity,
                    threshold,
                    peakEquity,
                    peakEquity,
                    false,
                    mode,
                    summary);
            }
        }

        private void AddHtmlReportStopperEvent(
            DateTime candleTime,
            string kind,
            decimal referenceEquity,
            decimal currentEquity,
            decimal thresholdPercent,
            decimal triggerLevel,
            decimal postCloseEquity,
            bool regimeStopped,
            HtmlReportExecutionMode mode,
            string summary)
        {
            _htmlReportRuntime.StopperEvents.Add(new HtmlReportStopperEvent
            {
                CandleTime = candleTime,
                EventTimeUtc = DateTime.UtcNow,
                Kind = kind,
                ReferenceEquity = referenceEquity,
                CurrentEquity = currentEquity,
                ThresholdPercent = thresholdPercent,
                TriggerLevel = triggerLevel,
                PostCloseEquity = postCloseEquity,
                RegimeStopped = regimeStopped,
                ExecutionModeId = mode.ModeId,
                ExecutionModeLabel = mode.ModeLabel,
                Summary = summary
            });

            if (_htmlReportRuntime.StopperEvents.Count > HtmlReportStopperEventsCap)
            {
                int remove = _htmlReportRuntime.StopperEvents.Count - HtmlReportStopperEventsCap;
                _htmlReportRuntime.StopperEvents.RemoveRange(0, remove);
            }

            _htmlReportRuntime.RecentEvents.Add(new HtmlReportRecentEvent
            {
                Seq = 0,
                CandleTime = candleTime,
                EventTimeUtc = DateTime.UtcNow,
                Event = kind,
                TabKey = "—",
                LogicSlot = 0,
                Delta = currentEquity - referenceEquity,
                EquityTotal = currentEquity,
                Note = summary,
                ExecutionModeId = mode.ModeId,
                ExecutionModeLabel = mode.ModeLabel
            });
            TrimHtmlReportRecentEvents(_htmlReportRuntime.RecentEvents);
            _htmlReportDirty = true;
        }

        private static void TrimHtmlReportRecentEvents(List<HtmlReportRecentEvent> events)
        {
            if (events.Count <= HtmlReportRecentEventsCap)
            {
                return;
            }

            events.RemoveRange(0, events.Count - HtmlReportRecentEventsCap);
        }

        private static void TrimHtmlReportClosedTrades(List<HtmlReportClosedTrade> trades)
        {
            if (trades.Count <= HtmlReportClosedTradesCap)
            {
                return;
            }

            trades.RemoveRange(0, trades.Count - HtmlReportClosedTradesCap);
        }

        private static string FormatHtmlReportTradeDuration(DateTime openTime, DateTime closeTime)
        {
            if (openTime == default || closeTime == default || closeTime < openTime)
            {
                return "—";
            }

            TimeSpan span = closeTime - openTime;
            if (span.TotalDays >= 1d)
            {
                return span.Days.ToString(CultureInfo.InvariantCulture)
                    + "д "
                    + span.Hours.ToString(CultureInfo.InvariantCulture)
                    + "ч";
            }

            if (span.TotalHours >= 1d)
            {
                return ((int)span.TotalHours).ToString(CultureInfo.InvariantCulture)
                    + "ч "
                    + span.Minutes.ToString(CultureInfo.InvariantCulture)
                    + "мин";
            }

            if (span.TotalMinutes >= 1d)
            {
                return ((int)span.TotalMinutes).ToString(CultureInfo.InvariantCulture) + "мин";
            }

            return ((int)span.TotalSeconds).ToString(CultureInfo.InvariantCulture) + "с";
        }

        private static void AccumulateHtmlReportCloseReasonPnL(
            Dictionary<string, decimal> closeReasonPnL,
            string reason,
            decimal delta)
        {
            if (closeReasonPnL == null || string.IsNullOrWhiteSpace(reason))
            {
                return;
            }

            if (!closeReasonPnL.ContainsKey(reason))
            {
                closeReasonPnL[reason] = 0m;
            }

            closeReasonPnL[reason] += delta;
        }

        private static void AddHtmlReportLogicClosePnLByReason(
            HtmlReportLogicStats logic,
            string reason,
            decimal delta)
        {
            if (logic == null || string.IsNullOrWhiteSpace(reason))
            {
                return;
            }

            switch (reason)
            {
                case "PortfolioStopSL":
                case "PortfolioPeakDrawdown":
                    logic.PnLPortfolioStopSL += delta;
                    break;
                case "PortfolioStopTP":
                    logic.PnLPortfolioStopTP += delta;
                    break;
                case "PortfolioEodFlat":
                    logic.PnLPortfolioEodFlat += delta;
                    break;
                case "StopLoss":
                    logic.PnLLogicStopLoss += delta;
                    break;
                case "TakeProfit":
                    logic.PnLLogicTakeProfit += delta;
                    break;
                case "SignalClose":
                    logic.PnLSignalClose += delta;
                    break;
                case "RegimeFlip":
                    logic.PnLRegimeFlip += delta;
                    break;
                case "StopRobot":
                    logic.PnLStopRobot += delta;
                    break;
                default:
                    logic.PnLOther += delta;
                    break;
            }
        }

        private static decimal SumHtmlReportCloseReasonPnL(
            Dictionary<string, decimal> closeReasonPnL,
            params string[] reasons)
        {
            if (closeReasonPnL == null || reasons == null || reasons.Length == 0)
            {
                return 0m;
            }

            decimal sum = 0m;
            for (int i = 0; i < reasons.Length; i++)
            {
                string reason = reasons[i];
                if (!string.IsNullOrWhiteSpace(reason)
                    && closeReasonPnL.TryGetValue(reason, out decimal part))
                {
                    sum += part;
                }
            }

            return sum;
        }

        private static string HtmlReportCloseReasonLabel(string reason)
        {
            switch (reason)
            {
                case "PortfolioStopSL":
                    return "Общепортф. stop-loss";
                case "PortfolioPeakDrawdown":
                    return "Просадка от пика";
                case "PortfolioStopTP":
                    return "Общепортф. take-profit";
                case "PortfolioEodFlat":
                    return "Ежедневная продажа по времени";
                case "StopLoss":
                    return "SL логики (SL[…] в строке)";
                case "TakeProfit":
                    return "TP логики (TP[…] в строке)";
                case "SignalClose":
                    return "По сигналу Cl (обычное закрытие)";
                case "RegimeFlip":
                    return "Regime(LinReg) — OnFlip=Close";
                case "StopRobot":
                    return "Остановить робота и продать всё";
                default:
                    return string.IsNullOrWhiteSpace(reason) ? "Прочее" : reason;
            }
        }

        private static List<object> BuildHtmlReportCloseReasonsList(
            Dictionary<string, int> closeReasons,
            Dictionary<string, decimal> closeReasonPnL)
        {
            var rows = new List<object>();
            if (closeReasons == null || closeReasons.Count == 0)
            {
                return rows;
            }

            foreach (KeyValuePair<string, int> kv in closeReasons.OrderByDescending(p => p.Value).ThenBy(p => p.Key, StringComparer.Ordinal))
            {
                decimal pnl = 0m;
                if (closeReasonPnL != null)
                {
                    closeReasonPnL.TryGetValue(kv.Key, out pnl);
                }

                rows.Add(new
                {
                    reason = kv.Key,
                    label = HtmlReportCloseReasonLabel(kv.Key),
                    count = kv.Value,
                    pnl
                });
            }

            return rows;
        }

        private object BuildHtmlReportClosePnLSummary(MultiLogicHtmlReportRuntime rt)
        {
            Dictionary<string, decimal> pnl = rt?.CloseReasonPnL;
            Dictionary<string, int> counts = rt?.CloseReasons;

            decimal portfolioSl = SumHtmlReportCloseReasonPnL(pnl, "PortfolioStopSL");
            decimal portfolioTp = SumHtmlReportCloseReasonPnL(pnl, "PortfolioStopTP");
            decimal portfolioEod = SumHtmlReportCloseReasonPnL(pnl, "PortfolioEodFlat");
            decimal logicSl = SumHtmlReportCloseReasonPnL(pnl, "StopLoss");
            decimal logicTp = SumHtmlReportCloseReasonPnL(pnl, "TakeProfit");
            decimal signalClose = SumHtmlReportCloseReasonPnL(pnl, "SignalClose");
            decimal regimeFlip = SumHtmlReportCloseReasonPnL(pnl, "RegimeFlip");
            decimal stopRobot = SumHtmlReportCloseReasonPnL(pnl, "StopRobot");
            decimal other = SumHtmlReportCloseReasonPnL(pnl, "Other");

            // fix typo - I used wrong name
            decimal portfolioSlTpSum = portfolioSl + portfolioTp;
            decimal portfolioStopAndEodSum = portfolioSlTpSum + portfolioEod;
            decimal logicStopTakeSum = logicSl + logicTp;
            decimal allStopTakeSum = portfolioStopAndEodSum + logicStopTakeSum;
            decimal realizedFromTrackedCloses = pnl?.Values.Sum() ?? 0m;

            int CountFor(string key)
            {
                if (counts != null && counts.TryGetValue(key, out int c))
                {
                    return c;
                }

                return 0;
            }

            bool eodFlatEnabled = IsStopperEodFlatSellConfigured();

            return new
            {
                portfolioStopSL = portfolioSl,
                portfolioStopTP = portfolioTp,
                portfolioSlTpSum,
                portfolioEodFlat = portfolioEod,
                portfolioStopAndEodSum,
                portfolioEodFlatEnabled = eodFlatEnabled,
                portfolioEodFlatCount = CountFor("PortfolioEodFlat"),
                logicStopLoss = logicSl,
                logicTakeProfit = logicTp,
                logicStopTakeSum,
                allStopTakeSum,
                signalClose,
                regimeFlip,
                stopRobot,
                other,
                realizedFromTrackedCloses,
                portfolioStopSLCount = CountFor("PortfolioStopSL"),
                portfolioStopTPCount = CountFor("PortfolioStopTP"),
                logicStopLossCount = CountFor("StopLoss"),
                logicTakeProfitCount = CountFor("TakeProfit"),
                signalCloseCount = CountFor("SignalClose")
            };
        }

        private static string ClassifyHtmlReportCloseReason(string note)
        {
            if (string.IsNullOrWhiteSpace(note))
            {
                return "Other";
            }

            string n = note;
            if (n.IndexOf("_RegimeFlip", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "RegimeFlip";
            }

            if (string.Equals(n, SignalPortfolioStopperSl, StringComparison.OrdinalIgnoreCase))
            {
                return "PortfolioStopSL";
            }

            if (string.Equals(n, SignalPortfolioStopperPeakSl, StringComparison.OrdinalIgnoreCase))
            {
                return "PortfolioPeakDrawdown";
            }

            if (string.Equals(n, SignalPortfolioStopperTp, StringComparison.OrdinalIgnoreCase))
            {
                return "PortfolioStopTP";
            }

            if (string.Equals(n, SignalPortfolioStopperEodFlat, StringComparison.OrdinalIgnoreCase))
            {
                return "PortfolioEodFlat";
            }

            if (n.IndexOf("_EodFlat", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "PortfolioEodFlat";
            }

            if (n.IndexOf("_SL", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "StopLoss";
            }

            if (n.IndexOf("_TP", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "TakeProfit";
            }

            if (n.IndexOf("_Close", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "SignalClose";
            }

            if (string.Equals(n, SignalStopRobotAndSellAll, StringComparison.OrdinalIgnoreCase))
            {
                return "StopRobot";
            }

            return "Other";
        }

        private string GetHtmlReportFilePath()
        {
            return Path.Combine("Engine", NameStrategyUniq + HtmlReportFileSuffix);
        }

        private void OpenHtmlReportFile()
        {
            string path = Path.GetFullPath(GetHtmlReportFilePath());
            if (!File.Exists(path))
            {
                SendNewLogMessage(
                    NameStrategyUniq + " | HTML-отчёт не найден: " + path,
                    LogMessageType.User);
                return;
            }

            try
            {
                Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                SendNewLogMessage(
                    NameStrategyUniq + " | не удалось открыть HTML-отчёт: " + ex.Message,
                    LogMessageType.Error);
            }
        }

        private void MaybeWriteHtmlReport(bool force)
        {
            if (_htmlReportEnabled == null || !_htmlReportEnabled.ValueBool)
            {
                return;
            }

            if (!force && !_htmlReportDirty)
            {
                return;
            }

            int interval = _htmlReportIntervalSec?.ValueInt ?? HtmlReportDefaultIntervalSeconds;
            interval = Math.Max(HtmlReportMinIntervalSeconds, interval);
            DateTime now = DateTime.UtcNow;
            if (!force
                && _htmlReportLastWriteUtc != DateTime.MinValue
                && (now - _htmlReportLastWriteUtc).TotalSeconds < interval)
            {
                return;
            }

            try
            {
                string html;
                lock (_htmlReportRuntimeLock)
                {
                    TouchHtmlReportExecutionMode(null);
                    html = BuildHtmlReportDocument();
                }

                string path = GetHtmlReportFilePath();
                string directory = Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
                {
                    Directory.CreateDirectory(directory);
                }

                string tempPath = path + ".tmp";
                File.WriteAllText(tempPath, html, new UTF8Encoding(false));
                if (File.Exists(path))
                {
                    File.Delete(path);
                }

                File.Move(tempPath, path);
                _htmlReportLastWriteUtc = now;
                _htmlReportDirty = false;
                EnsureLogicHelpFileUpToDate(logToUser: false);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(
                    NameStrategyUniq + " | HTML-отчёт: ошибка записи: " + ex.Message,
                    LogMessageType.Error);
            }
        }

        private List<object> BuildHtmlReportOpenPositionRows()
        {
            var rows = new List<object>();
            MultiLogicPositionSnapshotDto[] current = CaptureOpenPositionSnapshots();
            for (int i = 0; i < current.Length; i++)
            {
                MultiLogicPositionSnapshotDto p = current[i];
                rows.Add(new
                {
                    tabKey = p.TabKey,
                    logicSlot = p.LogicSlot,
                    direction = p.Direction,
                    entryPrice = p.EntryPrice,
                    volume = p.Volume,
                    openTime = p.OpenTime.ToString("O", CultureInfo.InvariantCulture),
                    signalTypeOpen = p.SignalTypeOpen,
                    status = "open"
                });
            }

            if (rows.Count > 0)
            {
                return rows;
            }

            MultiLogicHtmlReportRuntime rt = _htmlReportRuntime;
            List<HtmlReportRecentEvent> recentEventsSnapshot = rt.RecentEvents.ToList();
            List<HtmlReportRecentEvent> openEvents = recentEventsSnapshot
                .Where(e => string.Equals(e.Event, "open", StringComparison.OrdinalIgnoreCase))
                .OrderByDescending(e => e.CandleTime)
                .ThenByDescending(e => e.Seq)
                .Take(HtmlReportOpenFallbackEventsCap)
                .ToList();

            for (int i = 0; i < openEvents.Count; i++)
            {
                HtmlReportRecentEvent e = openEvents[i];
                rows.Add(new
                {
                    tabKey = e.TabKey,
                    logicSlot = e.LogicSlot,
                    direction = "—",
                    entryPrice = (decimal?)null,
                    volume = (decimal?)null,
                    openTime = e.CandleTime.ToString("O", CultureInfo.InvariantCulture),
                    signalTypeOpen = e.Note ?? "",
                    status = "event"
                });
            }

            return rows;
        }

        private static string GetLogicLineForReportDisplay(int slot, StrategyParameterString logicParam)
        {
            string raw = logicParam?.ValueString?.Trim() ?? "";
            if (string.IsNullOrEmpty(raw))
            {
                return "";
            }

            string withoutNote = Regex.Replace(
                raw,
                @"\bNote\s*\([^)]*\)",
                "",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant).Trim();
            withoutNote = Regex.Replace(
                withoutNote,
                @"\b(?:Коммент|Cm)\s*\([^)]*\)",
                "",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant).Trim();
            return string.IsNullOrWhiteSpace(withoutNote) ? raw : withoutNote;
        }

        private void RefreshHtmlReportConfigBaseline()
        {
            _htmlReportConfigBaselineLogicLines = CaptureLogicLines();
            _htmlReportConfigBaselineParams = CaptureParameterValues();
            _htmlReportConfigBaselineReady = true;
        }

        private void RecordHtmlReportConfigChangesIfAny()
        {
            if (!_htmlReportConfigBaselineReady)
            {
                RefreshHtmlReportConfigBaseline();
                return;
            }

            string[] currentLines = CaptureLogicLines();
            Dictionary<string, string> currentParams = CaptureParameterValues();
            DateTime candleTime = GetStopperReferenceCandleTime();
            DateTime eventUtc = DateTime.UtcNow;
            bool any = false;

            for (int slot = 1; slot <= LogicSlotCount; slot++)
            {
                string oldLine = _htmlReportConfigBaselineLogicLines[slot - 1] ?? "";
                string newLine = currentLines[slot - 1] ?? "";
                if (string.Equals(oldLine, newLine, StringComparison.Ordinal))
                {
                    continue;
                }

                any = true;
                AppendHtmlReportConfigChange(
                    candleTime,
                    eventUtc,
                    "logic_line",
                    slot,
                    "Логика " + slot.ToString(CultureInfo.InvariantCulture),
                    "L" + slot.ToString(CultureInfo.InvariantCulture) + ": изменена формула логики",
                    "",
                    "",
                    oldLine,
                    newLine,
                    affectsGlobalChart: true,
                    affectsLogicChart: true);
            }

            _htmlReportConfigBaselineParams.TryGetValue(LogicSideInversionParamName, out string oldInversion);
            currentParams.TryGetValue(LogicSideInversionParamName, out string newInversion);
            oldInversion ??= "";
            newInversion ??= "";
            if (!string.Equals(oldInversion, newInversion, StringComparison.OrdinalIgnoreCase))
            {
                any = true;
                string oldInversionLabel = FormatHtmlReportLogicInversionStateLabel(oldInversion);
                string newInversionLabel = FormatHtmlReportLogicInversionStateLabel(newInversion);
                AppendHtmlReportConfigChange(
                    candleTime,
                    eventUtc,
                    "logic_inversion",
                    0,
                    LogicSideInversionParamName,
                    BuildHtmlReportLogicInversionChangeSummary(oldInversion, newInversion),
                    oldInversionLabel,
                    newInversionLabel,
                    "",
                    "",
                    affectsGlobalChart: true,
                    affectsLogicChart: true);
            }

            for (int i = 0; i < HtmlReportGlobalTradingParamNames.Length; i++)
            {
                string paramName = HtmlReportGlobalTradingParamNames[i];
                _htmlReportConfigBaselineParams.TryGetValue(paramName, out string oldVal);
                currentParams.TryGetValue(paramName, out string newVal);
                oldVal ??= "";
                newVal ??= "";
                if (string.Equals(oldVal, newVal, StringComparison.Ordinal))
                {
                    continue;
                }

                any = true;
                string category = ClassifyHtmlReportConfigParamCategory(paramName);
                AppendHtmlReportConfigChange(
                    candleTime,
                    eventUtc,
                    category,
                    0,
                    paramName,
                    paramName + ": " + TruncateHtmlReportConfigValue(oldVal) + " → " + TruncateHtmlReportConfigValue(newVal),
                    oldVal,
                    newVal,
                    "",
                    "",
                    affectsGlobalChart: true,
                    affectsLogicChart: true);
            }

            if (any)
            {
                RefreshHtmlReportConfigBaseline();
                _htmlReportDirty = true;
            }
        }

        private void AppendHtmlReportConfigChange(
            DateTime candleTime,
            DateTime eventUtc,
            string category,
            int logicSlot,
            string paramName,
            string summary,
            string oldValue,
            string newValue,
            string oldLogicLine,
            string newLogicLine,
            bool affectsGlobalChart,
            bool affectsLogicChart)
        {
            lock (_htmlReportRuntimeLock)
            {
                long id = ++_htmlReportConfigChangeSeq;
                _htmlReportRuntime.ConfigChangeJournal.Add(new HtmlReportConfigChangeEntry
                {
                    Id = id,
                    CandleTime = candleTime,
                    EventTimeUtc = eventUtc,
                    Category = category ?? "",
                    LogicSlot = logicSlot,
                    ParamName = paramName ?? "",
                    Summary = summary ?? "",
                    OldValue = oldValue ?? "",
                    NewValue = newValue ?? "",
                    OldLogicLine = oldLogicLine ?? "",
                    NewLogicLine = newLogicLine ?? "",
                    AffectsGlobalChart = affectsGlobalChart,
                    AffectsLogicChart = affectsLogicChart
                });

                while (_htmlReportRuntime.ConfigChangeJournal.Count > HtmlReportConfigChangeJournalCap)
                {
                    _htmlReportRuntime.ConfigChangeJournal.RemoveAt(0);
                }

                _htmlReportDirty = true;
            }
        }

        private static string FormatHtmlReportConfigBoolLabel(string raw)
        {
            if (bool.TryParse(raw, out bool value))
            {
                return value ? "да" : "нет";
            }

            return string.IsNullOrWhiteSpace(raw) ? "—" : raw;
        }

        private static string FormatHtmlReportLogicInversionStateLabel(string raw)
        {
            if (bool.TryParse(raw, out bool enabled))
            {
                return enabled
                    ? "Включена — покупка ↔ продажа, Op ↔ Cl (как TMIS)"
                    : "Отключена — без инверсии логики";
            }

            return string.IsNullOrWhiteSpace(raw) ? "—" : raw;
        }

        private static string BuildHtmlReportLogicInversionChangeSummary(string oldRaw, string newRaw)
        {
            string oldLabel = FormatHtmlReportLogicInversionStateLabel(oldRaw);
            string newLabel = FormatHtmlReportLogicInversionStateLabel(newRaw);
            return "Инверсия логики (покупка ↔ продажа): " + oldLabel + " → " + newLabel;
        }

        private static string TruncateHtmlReportConfigValue(string value, int maxLen = 120)
        {
            if (string.IsNullOrEmpty(value))
            {
                return "—";
            }

            if (value.Length <= maxLen)
            {
                return value;
            }

            return value.Substring(0, maxLen) + "…";
        }

        private static string ClassifyHtmlReportConfigParamCategory(string paramName)
        {
            if (string.Equals(paramName, "Regime", StringComparison.OrdinalIgnoreCase))
            {
                return "regime";
            }

            if (string.Equals(paramName, "Volume type", StringComparison.OrdinalIgnoreCase)
                || string.Equals(paramName, "Volume", StringComparison.OrdinalIgnoreCase)
                || string.Equals(paramName, "Asset in portfolio", StringComparison.OrdinalIgnoreCase)
                || string.Equals(paramName, "Max positions (all tabs)", StringComparison.OrdinalIgnoreCase))
            {
                return "volume";
            }

            if (paramName.IndexOf("stop-loss", StringComparison.OrdinalIgnoreCase) >= 0
                || paramName.IndexOf("take-profit", StringComparison.OrdinalIgnoreCase) >= 0
                || paramName.IndexOf("Stopper", StringComparison.OrdinalIgnoreCase) >= 0
                || string.Equals(paramName, "Предыдущая сумма портфеля: lookback (свечей)", StringComparison.OrdinalIgnoreCase))
            {
                return "stopper";
            }

            if (string.Equals(paramName, MetaLogicEnabledParamName, StringComparison.OrdinalIgnoreCase)
                || string.Equals(paramName, MetaLogicInversionParamName, StringComparison.OrdinalIgnoreCase)
                || paramName.IndexOf("PnlSMA", StringComparison.OrdinalIgnoreCase) >= 0
                || paramName.IndexOf("Общепортфельный", StringComparison.OrdinalIgnoreCase) >= 0
                || paramName.IndexOf("Предыдущий индикатор", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "meta";
            }

            return "trading";
        }

        private string BuildHtmlReportDocument()
        {
            HtmlReportExecutionMode mode = ResolveHtmlReportExecutionMode(null);
            MultiLogicHtmlReportRuntime rt = _htmlReportRuntime;
            List<HtmlReportEquitySnapshot> equitySnapshots = rt.EquitySnapshots.ToList();
            List<HtmlReportModeSegment> modeHistorySnapshot = rt.ModeHistory.ToList();
            List<HtmlReportStopperEvent> stopperEventsSnapshot = rt.StopperEvents.ToList();
            List<HtmlReportClosedTrade> closedTradesSnapshot = rt.ClosedTrades.ToList();
            List<HtmlReportRecentEvent> recentEventsSnapshot = rt.RecentEvents.ToList();
            List<HtmlReportMetaLogicJournalEntry> metaLogicJournalSnapshot = rt.MetaLogicJournal.ToList();
            List<HtmlReportConfigChangeEntry> configChangeJournalSnapshot = rt.ConfigChangeJournal.ToList();
            Dictionary<string, int> closeReasonsSnapshot = new Dictionary<string, int>(rt.CloseReasons);
            Dictionary<string, decimal> closeReasonPnLSnapshot = new Dictionary<string, decimal>(rt.CloseReasonPnL);
            decimal equityTotal = GetCombinedLogicPortfolioEquity();
            decimal realizedTotal = 0m;
            decimal unrealizedTotal = 0m;
            for (int slot = 1; slot <= LogicSlotCount; slot++)
            {
                realizedTotal += _logicPortfolios[slot].Realized;
                unrealizedTotal += _logicPortfolios[slot].Unrealized;
            }

            var reportData = new
            {
                formatVersion = HtmlReportFormatVersion,
                robotType = "MultiLogic",
                strategyName = NameStrategyUniq,
                generatedAtUtc = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture),
                reportIntervalSec = _htmlReportIntervalSec?.ValueInt ?? HtmlReportDefaultIntervalSeconds,
                regime = _regime?.ValueString ?? "?",
                sessionStartedUtc = rt.SessionStartedUtc.ToString("O", CultureInfo.InvariantCulture),
                executionMode = new
                {
                    modeId = mode.ModeId,
                    modeLabel = mode.ModeLabel,
                    startProgram = mode.StartProgram,
                    emulatorIsOn = mode.EmulatorIsOn
                },
                modeHistory = modeHistorySnapshot.Select(m => new
                {
                    fromUtc = m.FromUtc.ToString("O", CultureInfo.InvariantCulture),
                    toUtc = m.ToUtc?.ToString("O", CultureInfo.InvariantCulture),
                    modeId = m.ModeId,
                    modeLabel = m.ModeLabel,
                    startProgram = m.StartProgram,
                    emulatorIsOn = m.EmulatorIsOn
                }).ToList(),
                summary = new
                {
                    equityTotal,
                    realizedTotal,
                    unrealizedTotal,
                    opensTotal = rt.OpensTotal,
                    closesTotal = rt.ClosesTotal,
                    openPositionsCount = CountScreenerOpenPositions(),
                    activeLogicSlots = CountActiveLogicSlots(),
                    stopperTriggersTotal = stopperEventsSnapshot.Count
                },
                equitySeries = new
                {
                    aggregate = equitySnapshots.Select(p => new
                    {
                        t = p.CandleTime.ToString("O", CultureInfo.InvariantCulture),
                        equity = p.EquityTotal,
                        realized = p.RealizedTotal,
                        unrealized = p.UnrealizedTotal,
                        modeId = p.ExecutionModeId,
                        modeLabel = p.ExecutionModeLabel
                    }).ToList(),
                    byLogic = BuildHtmlReportLogicEquitySeries()
                },
                logicPortfolios = BuildHtmlReportLogicPortfolios(),
                positionCountSeries = equitySnapshots.Select(p => new
                {
                    t = p.CandleTime.ToString("O", CultureInfo.InvariantCulture),
                    openCount = p.OpenPositionsCount,
                    closesTotal = p.ClosesTotal,
                    opensTotal = p.OpensTotal
                }).ToList(),
                tradeBuckets = new
                {
                    total = rt.ByDay.Values.ToList()
                        .OrderBy(d => d.DayKey, StringComparer.Ordinal)
                        .Select(d => new { day = d.DayKey, opens = d.Opens, closes = d.Closes })
                        .ToList(),
                    byInstrument = rt.ByInstrument.Values.ToList()
                        .OrderByDescending(i => i.Opens + i.Closes)
                        .Select(i => new
                        {
                            tabKey = i.TabKey,
                            opens = i.Opens,
                            closes = i.Closes,
                            realizedPnL = i.RealizedPnL
                        })
                        .ToList(),
                    byLogicSlot = rt.ByLogic.Values.ToList()
                        .OrderBy(l => l.Slot)
                        .Select(l => new
                        {
                            slot = l.Slot,
                            opens = l.Opens,
                            closes = l.Closes,
                            realizedPnL = l.RealizedPnL,
                            equity = _logicPortfolios[l.Slot].Equity,
                            pnlSignalClose = l.PnLSignalClose,
                            pnlLogicStopLoss = l.PnLLogicStopLoss,
                            pnlLogicTakeProfit = l.PnLLogicTakeProfit,
                            pnlLogicStopTakeSum = l.PnLLogicStopLoss + l.PnLLogicTakeProfit,
                            pnlPortfolioStopSL = l.PnLPortfolioStopSL,
                            pnlPortfolioStopTP = l.PnLPortfolioStopTP,
                            pnlPortfolioEodFlat = l.PnLPortfolioEodFlat,
                            pnlPortfolioSlTpSum = l.PnLPortfolioStopSL + l.PnLPortfolioStopTP,
                            pnlPortfolioStopAndEodSum = l.PnLPortfolioStopSL + l.PnLPortfolioStopTP + l.PnLPortfolioEodFlat,
                            pnlRegimeFlip = l.PnLRegimeFlip,
                            pnlStopRobot = l.PnLStopRobot,
                            pnlOther = l.PnLOther
                        })
                        .ToList()
                },
                closeReasons = closeReasonsSnapshot,
                closeReasonPnL = closeReasonPnLSnapshot,
                closeReasonsList = BuildHtmlReportCloseReasonsList(closeReasonsSnapshot, closeReasonPnLSnapshot),
                closePnLSummary = BuildHtmlReportClosePnLSummary(rt),
                stopperEvents = stopperEventsSnapshot.Select((s, stopperIndex) => new
                {
                    id = stopperIndex + 1,
                    candleTime = s.CandleTime.ToString("O", CultureInfo.InvariantCulture),
                    eventUtc = s.EventTimeUtc.ToString("O", CultureInfo.InvariantCulture),
                    kind = s.Kind,
                    referenceEquity = s.ReferenceEquity,
                    currentEquity = s.CurrentEquity,
                    thresholdPercent = s.ThresholdPercent,
                    triggerLevel = s.TriggerLevel,
                    postCloseEquity = s.PostCloseEquity,
                    regimeStopped = s.RegimeStopped,
                    executionModeId = s.ExecutionModeId,
                    executionModeLabel = s.ExecutionModeLabel,
                    summary = s.Summary
                }).ToList(),
                closedTrades = closedTradesSnapshot.Select(t => new
                {
                    tabKey = t.TabKey,
                    logicSlot = t.LogicSlot,
                    openTime = t.OpenTime.ToString("O", CultureInfo.InvariantCulture),
                    closeTime = t.CloseTime.ToString("O", CultureInfo.InvariantCulture),
                    delta = t.Delta,
                    note = t.Note,
                    closeReason = t.CloseReason,
                    duration = t.DurationLabel
                }).ToList(),
                openPositions = BuildHtmlReportOpenPositionRows(),
                closedTradesTotal = rt.ClosesTotal,
                closedTradesShown = closedTradesSnapshot.Count,
                recentEvents = recentEventsSnapshot.Select(e => new
                {
                    seq = e.Seq,
                    candleTime = e.CandleTime.ToString("O", CultureInfo.InvariantCulture),
                    eventUtc = e.EventTimeUtc.ToString("O", CultureInfo.InvariantCulture),
                    eventName = e.Event,
                    tabKey = e.TabKey,
                    logicSlot = e.LogicSlot,
                    delta = e.Delta,
                    equityTotal = e.EquityTotal,
                    note = e.Note,
                    executionModeId = e.ExecutionModeId,
                    executionModeLabel = e.ExecutionModeLabel
                }).ToList(),
                metaLogic = BuildHtmlReportMetaLogicSnapshot(),
                metaLogicJournal = metaLogicJournalSnapshot.Select(j => new
                {
                    candleTime = j.CandleTime.ToString("O", CultureInfo.InvariantCulture),
                    eventUtc = j.EventTimeUtc.ToString("O", CultureInfo.InvariantCulture),
                    tabKey = j.TabKey,
                    mode = j.Mode,
                    candidatesTotal = j.CandidatesTotal,
                    entriesOpened = j.EntriesOpened,
                    totalVolume = j.TotalVolume,
                    freeSlots = j.FreeSlots,
                    summary = j.Summary,
                    lines = j.Lines.ToList().Select(l => new
                    {
                        rank = l.Rank,
                        slot = l.Slot,
                        logicNote = l.LogicNote,
                        pnlSmaAvg = l.PnlSmaAvg,
                        pnlSmaLast = l.PnlSmaLast,
                        weightSharePct = l.AbsWeightSharePct,
                        volume = l.Volume,
                        side = l.Side,
                        opened = l.Opened,
                        skipped = l.Skipped
                    }).ToList()
                }).ToList(),
                configChangeJournal = configChangeJournalSnapshot.Select(c => new
                {
                    id = c.Id,
                    candleTime = c.CandleTime.ToString("O", CultureInfo.InvariantCulture),
                    eventUtc = c.EventTimeUtc.ToString("O", CultureInfo.InvariantCulture),
                    category = c.Category,
                    logicSlot = c.LogicSlot,
                    paramName = c.ParamName,
                    summary = c.Summary,
                    oldValue = c.OldValue,
                    newValue = c.NewValue,
                    oldLogicLine = c.OldLogicLine,
                    newLogicLine = c.NewLogicLine,
                    affectsGlobalChart = c.AffectsGlobalChart,
                    affectsLogicChart = c.AffectsLogicChart
                }).ToList()
            };

            string json = JsonConvert.SerializeObject(reportData, Formatting.None);
            string jsonForScript = json.Replace("</", "<\\/");

            var sb = new StringBuilder(65536);
            sb.AppendLine("<!DOCTYPE html>");
            sb.AppendLine("<html lang=\"ru\">");
            sb.AppendLine("<head>");
            sb.AppendLine("<meta charset=\"utf-8\">");
            sb.AppendLine("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">");
            sb.AppendLine("<title>MultiLogic — " + HtmlEncode(NameStrategyUniq) + "</title>");
            sb.AppendLine("<style>");
            AppendHtmlReportStyles(sb);
            sb.AppendLine("</style>");
            sb.AppendLine("</head>");
            sb.AppendLine("<body>");
            sb.AppendLine("<header class=\"hdr\">");
            sb.AppendLine("<h1>MultiLogic — " + HtmlEncode(NameStrategyUniq) + "</h1>");
            sb.AppendLine("<p class=\"sub\">Обновлено: <span id=\"gen-time\"></span> · Regime: "
                + HtmlEncode(_regime?.ValueString ?? "?")
                + " · интервал записи: "
                + (_htmlReportIntervalSec?.ValueInt ?? HtmlReportDefaultIntervalSeconds)
                + " с</p>");
            sb.AppendLine("<div id=\"mode-badges\"></div>");
            sb.AppendLine("</header>");
            sb.AppendLine("<section class=\"kpi\" id=\"kpi\"></section>");
            sb.AppendLine("<section class=\"portfolio-equity-report\">");
            sb.AppendLine("<h2>Портфель — общий equity (сумма L1…L10)</h2>");
            sb.AppendLine("<div id=\"equity-chart-aggregate\" class=\"chart chart-portfolio\"></div>");
            sb.AppendLine("<h2 class=\"logic-breakdown-title\">Портфель по логикам</h2>");
            sb.AppendLine("<p class=\"sub\">Под общим графиком — каждая активная логика: формула, equity и накопленные открытия/закрытия.</p>");
            sb.AppendLine("<div id=\"logic-portfolio-charts\"></div>");
            sb.AppendLine("<h2 class=\"logic-breakdown-title\">Журнал изменений параметров (входы / выходы)</h2>");
            sb.AppendLine("<p class=\"sub\">Все изменения логик, Regime, объёма, металогики и Stopper. На графиках equity — вертикальные полосы и ссылки на строку журнала.</p>");
            sb.AppendLine("<div class=\"tbl-wrap\"><table id=\"config-change-journal\"><thead><tr><th>#</th><th>Время</th><th>Категория</th><th>L</th><th>Параметр</th><th>Было</th><th>Стало</th><th>Формула была</th><th>Формула стала</th></tr></thead><tbody></tbody></table></div>");
            sb.AppendLine("</section>");
            sb.AppendLine("<details class=\"report-fold report-fold-stopper\">");
            sb.AppendLine("<summary>Общепортфельный Stopper (SL / TP)</summary>");
            sb.AppendLine("<div class=\"fold-body\">");
            sb.AppendLine("<p class=\"sub\">Срабатывания общепортфельного stop-loss и take-profit — <strong>жирным</strong> в таблице ниже.</p>");
            sb.AppendLine("<div class=\"tbl-wrap\"><table id=\"stopper-events\"><thead><tr><th>Время</th><th>Режим</th><th>Тип</th><th>Ref</th><th>Equity</th><th>%</th><th>Порог</th><th>Ref после</th><th>Regime Off</th><th>Описание</th></tr></thead><tbody></tbody></table></div>");
            sb.AppendLine("</div></details>");
            sb.AppendLine("<section><h2>Металогика — текущее состояние</h2><div id=\"meta-logic-status\" class=\"sub\"></div>");
            sb.AppendLine("<div class=\"tbl-wrap\"><table id=\"meta-logic-priority\"><thead><tr><th>#</th><th>L</th><th>Note</th><th>PnlSMA avg</th><th>PnlSMA last</th><th>Equity</th><th>Hist</th><th>Готов</th></tr></thead><tbody></tbody></table></div></section>");
            sb.AppendLine("<details class=\"report-fold report-fold-meta-journal\">");
            sb.AppendLine("<summary>Журнал металогики (входы и распределение Volume)</summary>");
            sb.AppendLine("<div class=\"fold-body\"><div class=\"tbl-wrap\"><table id=\"meta-logic-journal\"><thead><tr><th>Время</th><th>Tab</th><th>Режим</th><th>Канд.</th><th>Открыто</th><th>Volume</th><th>Слоты</th><th>Детали (L / PnlSMA / % / Vol / Side)</th></tr></thead><tbody></tbody></table></div></div>");
            sb.AppendLine("</details>");
            sb.AppendLine("<section><h2>Открытые и закрытые позиции (от времени)</h2>");
            sb.AppendLine("<p class=\"sub chart-legend\"><span class=\"lg-open\">● открытия (накопл.)</span> · <span class=\"lg-close\">● закрытия (накопл.)</span></p>");
            sb.AppendLine("<div id=\"position-count-chart\" class=\"chart\"></div></section>");
            sb.AppendLine("<section class=\"chart-section\"><h2>Открытия / закрытия — портфель (по дням)</h2>");
            sb.AppendLine("<div id=\"trades-total-chart\" class=\"chart bars\"></div>");
            sb.AppendLine("<details class=\"report-fold report-fold-inline\">");
            sb.AppendLine("<summary>Таблица по дням (Opens / Closes)</summary>");
            sb.AppendLine("<div class=\"fold-body\"><div class=\"tbl-wrap\"><table id=\"trades-total-table\"><thead><tr><th>День</th><th>Opens</th><th>Closes</th></tr></thead><tbody></tbody></table></div></div>");
            sb.AppendLine("</details></section>");
            sb.AppendLine("<details class=\"report-fold report-fold-strip report-fold-instruments\">");
            sb.AppendLine("<summary>По инструменту</summary>");
            sb.AppendLine("<div class=\"fold-body\"><div class=\"tbl-wrap\"><table id=\"by-instrument\"><thead><tr><th>Инструмент</th><th>Opens</th><th>Closes</th><th>Realized PnL</th></tr></thead><tbody></tbody></table></div></div>");
            sb.AppendLine("</details>");
            sb.AppendLine("<section><h2>Финансовый результат по причинам закрытия</h2>");
            sb.AppendLine("<p class=\"sub\">Раздельно: общепортфельный SL/TP, ежедневная продажа по времени (если включена), SL/TP из строки логики (SL[…]/TP[…]), обычные выходы по Cl.</p>");
            sb.AppendLine("<div id=\"close-pnl-summary\"></div>");
            sb.AppendLine("<div class=\"tbl-wrap\"><table id=\"close-pnl-summary-table\"><thead><tr><th>Группа</th><th>Кол-во</th><th>Фин. результат</th></tr></thead><tbody></tbody></table></div></section>");
            sb.AppendLine("<section><h2>По логике (фин. результат по типам выхода)</h2><div class=\"tbl-wrap\"><table id=\"by-logic\"><thead><tr><th>L</th><th>Opens</th><th>Closes</th><th>Realized</th><th>Cl</th><th>SL лог.</th><th>TP лог.</th><th>SL+TP лог.</th><th>SL портф.</th><th>TP портф.</th><th>EOD</th><th>SL+TP портф.</th><th>Equity</th></tr></thead><tbody></tbody></table></div></section>");
            sb.AppendLine("<section><h2>Причины закрытия</h2><div id=\"close-reasons\"></div>");
            sb.AppendLine("<div class=\"tbl-wrap\"><table id=\"close-reasons-table\"><thead><tr><th>Причина</th><th>Кол-во</th><th>Фин. результат</th></tr></thead><tbody></tbody></table></div></section>");
            sb.AppendLine("<section><h2>История режимов</h2><div class=\"tbl-wrap\"><table id=\"mode-history\"><thead><tr><th>С</th><th>По</th><th>Режим</th><th>StartProgram</th><th>Эмулятор</th></tr></thead><tbody></tbody></table></div></section>");
            sb.AppendLine("<details class=\"report-fold report-fold-positions\">");
            sb.AppendLine("<summary>Открытые позиции</summary>");
            sb.AppendLine("<div class=\"fold-body\"><p class=\"sub\" id=\"open-positions-hint\"></p>");
            sb.AppendLine("<div class=\"tbl-wrap\"><table id=\"open-positions\"><thead><tr><th>Статус</th><th>Инструмент</th><th>L</th><th>Side</th><th>Vol</th><th>Entry</th><th>Открытие</th><th>Signal</th></tr></thead><tbody></tbody></table></div></div>");
            sb.AppendLine("</details>");
            sb.AppendLine("<details class=\"report-fold report-fold-positions\">");
            sb.AppendLine("<summary>Закрытые позиции</summary>");
            sb.AppendLine("<div class=\"fold-body\"><p class=\"sub\" id=\"closed-trades-hint\"></p>");
            sb.AppendLine("<div class=\"tbl-wrap\"><table id=\"closed-trades\"><thead><tr><th>Инструмент</th><th>L</th><th>Открытие</th><th>Закрытие</th><th>Длительность</th><th>Фин. результат</th><th>Причина</th><th>Note</th></tr></thead><tbody></tbody></table></div></div>");
            sb.AppendLine("</details>");
            sb.AppendLine("<details class=\"report-fold report-fold-events\">");
            sb.AppendLine("<summary>Последние события</summary>");
            sb.AppendLine("<div class=\"fold-body\"><div class=\"tbl-wrap\"><table id=\"recent-events\"><thead><tr><th>Время</th><th>Режим</th><th>Ev</th><th>Tab</th><th>L</th><th>Δ</th><th>Note</th></tr></thead><tbody></tbody></table></div></div>");
            sb.AppendLine("</details>");
            sb.AppendLine("<footer><p>Файл: Engine\\" + HtmlEncode(NameStrategyUniq + HtmlReportFileSuffix) + " · формат v"
                + HtmlReportFormatVersion
                + "</p></footer>");
            sb.AppendLine("<script type=\"application/json\" id=\"multilogic-report-data\">");
            sb.AppendLine(jsonForScript);
            sb.AppendLine("</script>");
            sb.AppendLine("<script>");
            AppendHtmlReportRenderScript(sb);
            sb.AppendLine("</script>");
            sb.AppendLine("</body></html>");
            return sb.ToString();
        }

        private static List<object> BuildLogicEquitySeriesPoints(LogicPortfolioRuntime portfolio)
        {
            var points = new List<object>();
            if (portfolio == null || portfolio.History.Count == 0)
            {
                return points;
            }

            int step = Math.Max(1, portfolio.History.Count / 400);
            for (int i = 0; i < portfolio.History.Count; i += step)
            {
                LogicPortfolioPoint p = portfolio.History[i];
                points.Add(new
                {
                    t = p.CandleTime.ToString("O", CultureInfo.InvariantCulture),
                    equity = p.Equity,
                    realized = p.Realized,
                    unrealized = p.Unrealized
                });
            }

            LogicPortfolioPoint last = portfolio.History[portfolio.History.Count - 1];
            if ((portfolio.History.Count - 1) % step != 0)
            {
                points.Add(new
                {
                    t = last.CandleTime.ToString("O", CultureInfo.InvariantCulture),
                    equity = last.Equity,
                    realized = last.Realized,
                    unrealized = last.Unrealized
                });
            }

            return points;
        }

        private List<object> BuildLogicEquitySeriesForReport(int slot, LogicPortfolioRuntime portfolio)
        {
            MultiLogicHtmlReportRuntime rt = _htmlReportRuntime;
            if (rt.LogicSnapshots.TryGetValue(slot, out List<HtmlReportLogicSnapshotPoint> snaps)
                && snaps.Count > 0)
            {
                return DownsampleHtmlReportLogicSnapshots(
                    snaps.ToList(),
                    p => new
                    {
                        t = p.CandleTime.ToString("O", CultureInfo.InvariantCulture),
                        equity = p.Equity,
                        realized = p.Realized,
                        unrealized = p.Unrealized
                    });
            }

            return BuildLogicEquitySeriesPoints(portfolio);
        }

        private List<object> BuildLogicTradeSeriesForReport(int slot)
        {
            MultiLogicHtmlReportRuntime rt = _htmlReportRuntime;
            if (rt.LogicSnapshots.TryGetValue(slot, out List<HtmlReportLogicSnapshotPoint> snaps)
                && snaps.Count > 0)
            {
                return DownsampleHtmlReportLogicSnapshots(
                    snaps.ToList(),
                    p => new
                    {
                        t = p.CandleTime.ToString("O", CultureInfo.InvariantCulture),
                        opensTotal = p.OpensCumulative,
                        closesTotal = p.ClosesCumulative,
                        openCount = p.OpenPositionsNow
                    });
            }

            return RebuildLogicTradeSeriesFromEvents(slot, rt);
        }

        private static List<object> DownsampleHtmlReportLogicSnapshots<T>(
            List<HtmlReportLogicSnapshotPoint> snaps,
            Func<HtmlReportLogicSnapshotPoint, T> projector)
        {
            var points = new List<object>();
            if (snaps == null || snaps.Count == 0)
            {
                return points;
            }

            int step = Math.Max(1, snaps.Count / 400);
            for (int i = 0; i < snaps.Count; i += step)
            {
                points.Add(projector(snaps[i]));
            }

            HtmlReportLogicSnapshotPoint last = snaps[snaps.Count - 1];
            if ((snaps.Count - 1) % step != 0)
            {
                points.Add(projector(last));
            }

            return points;
        }

        private List<object> RebuildLogicTradeSeriesFromEvents(int slot, MultiLogicHtmlReportRuntime rt)
        {
            var points = new List<object>();
            if (rt == null)
            {
                return points;
            }

            List<HtmlReportRecentEvent> events = rt.RecentEvents.ToList()
                .Where(e => e.LogicSlot == slot && (e.Event == "open" || e.Event == "close"))
                .OrderBy(e => e.CandleTime)
                .ThenBy(e => e.Seq)
                .ToList();

            if (events.Count == 0)
            {
                return points;
            }

            int opens = 0;
            int closes = 0;
            for (int i = 0; i < events.Count; i++)
            {
                HtmlReportRecentEvent e = events[i];
                if (e.Event == "open")
                {
                    opens++;
                }
                else
                {
                    closes++;
                }

                points.Add(new
                {
                    t = e.CandleTime.ToString("O", CultureInfo.InvariantCulture),
                    opensTotal = opens,
                    closesTotal = closes,
                    openCount = Math.Max(0, opens - closes)
                });
            }

            return points;
        }

        private object BuildHtmlReportLogicEquitySeries()
        {
            var dict = new Dictionary<string, List<object>>();
            for (int slot = 1; slot <= LogicSlotCount; slot++)
            {
                LogicPortfolioRuntime portfolio = _logicPortfolios[slot];
                List<object> points = BuildLogicEquitySeriesForReport(slot, portfolio);
                if (points.Count == 0)
                {
                    continue;
                }

                string key = "L" + slot.ToString(CultureInfo.InvariantCulture);
                dict[key] = points;
            }

            return dict;
        }

        private List<object> BuildHtmlReportLogicPortfolios()
        {
            var rows = new List<object>();
            MultiLogicHtmlReportRuntime rt = _htmlReportRuntime;

            for (int slot = 1; slot <= LogicSlotCount; slot++)
            {
                LogicSlotRuntime runtime = _logicSlotRuntimes[slot];
                LogicPortfolioRuntime portfolio = _logicPortfolios[slot];
                bool active = runtime != null
                    && runtime.IsActive
                    && runtime.ParseResult != null
                    && runtime.ParseResult.Success
                    && !runtime.ParseResult.IsDisabled
                    && runtime.ParseResult.Root != null;

                rt.ByLogic.TryGetValue(slot, out HtmlReportLogicStats tradeStats);
                int opens = tradeStats?.Opens ?? 0;
                int closes = tradeStats?.Closes ?? 0;
                List<object> series = BuildLogicEquitySeriesForReport(slot, portfolio);
                List<object> tradeSeries = BuildLogicTradeSeriesForReport(slot);
                StrategyParameterString logicParam = ResolveLogicParameter(slot);
                string logicLine = GetLogicLineForReportDisplay(slot, logicParam);
                int snapshotPoints = rt.LogicSnapshots.TryGetValue(slot, out List<HtmlReportLogicSnapshotPoint> snaps)
                    ? snaps.Count
                    : 0;

                if (!active && opens == 0 && closes == 0 && string.IsNullOrWhiteSpace(logicLine))
                {
                    continue;
                }

                rows.Add(new
                {
                    slot,
                    label = "L" + slot.ToString(CultureInfo.InvariantCulture),
                    note = GetLogicSlotHumanNote(slot),
                    logicLine,
                    active,
                    equity = portfolio.Equity,
                    realized = portfolio.Realized,
                    unrealized = portfolio.Unrealized,
                    opens,
                    closes,
                    historyPoints = portfolio.History.Count,
                    snapshotPoints,
                    series,
                    tradeSeries
                });
            }

            return rows;
        }

        private object BuildHtmlReportMetaLogicSnapshot()
        {
            bool enabled = _metaLogicEnabled?.ValueBool ?? false;
            bool pnlSmaEnabled = _usePortfolioAdjSma?.ValueBool ?? false;
            int pnlLen = Math.Max(2, _portfolioAdjSmaLen?.ValueInt ?? 0);
            bool tradingActive = IsMetaLogicTradingActive();

            var ranked = new List<(int slot, decimal score, decimal? avg, decimal? last)>();
            var slotRows = new List<object>();

            for (int slot = 1; slot <= LogicSlotCount; slot++)
            {
                LogicSlotRuntime runtime = _logicSlotRuntimes[slot];
                bool active = runtime != null
                    && runtime.IsActive
                    && runtime.ParseResult?.Root != null
                    && !runtime.ParseResult.IsDisabled;
                TryGetLogicPnlSmaMetrics(slot, out decimal? avg, out decimal? last);
                bool slotReady = active
                    && pnlSmaEnabled
                    && _logicPortfolios[slot].History.Count >= pnlLen
                    && avg.HasValue;
                decimal score = avg ?? decimal.MinValue;
                if (active)
                {
                    ranked.Add((slot, score, avg, last));
                }

                slotRows.Add(new
                {
                    slot,
                    active,
                    logicNote = GetLogicSlotHumanNote(slot),
                    side = active ? ResolveLogicOpenSide(runtime).ToString() : "",
                    pnlSmaAvg = avg,
                    pnlSmaLast = last,
                    equity = _logicPortfolios[slot].Equity,
                    realized = _logicPortfolios[slot].Realized,
                    unrealized = _logicPortfolios[slot].Unrealized,
                    historyPoints = _logicPortfolios[slot].History.Count,
                    pnlReady = slotReady
                });
            }

            ranked.Sort((a, b) =>
            {
                int cmp = b.score.CompareTo(a.score);
                return cmp != 0 ? cmp : a.slot.CompareTo(b.slot);
            });

            var priorityOrder = new List<object>();
            for (int i = 0; i < ranked.Count; i++)
            {
                priorityOrder.Add(new
                {
                    rank = i + 1,
                    slot = ranked[i].slot,
                    logicNote = GetLogicSlotHumanNote(ranked[i].slot),
                    pnlSmaAvg = ranked[i].avg,
                    pnlSmaLast = ranked[i].last,
                    priorityScore = ranked[i].score == decimal.MinValue ? (decimal?)null : ranked[i].score
                });
            }

            string statusLabel;
            if (!enabled)
            {
                statusLabel = "Металогика выключена — Volume поровну, приоритет L1…L10.";
            }
            else if (!pnlSmaEnabled)
            {
                statusLabel = "Металогика включена, но PnlSMA выключен — действует обычная логика.";
            }
            else if (!tradingActive)
            {
                statusLabel = "Прогрев: нужно "
                    + pnlLen
                    + " точек истории на каждую активную логику — пока обычная логика.";
            }
            else
            {
                statusLabel = "Металогика активна — Volume по PnlSMA>0; при инверсии ещё |PnlSMA| для PnlSMA<0.";
            }

            return new
            {
                enabled,
                inversion = _metaLogicInversion?.ValueBool ?? false,
                inversionActive = IsMetaLogicInversionActive(),
                pnlSmaEnabled,
                pnlSmaLen = pnlLen,
                tradingActive,
                warmupPending = enabled && pnlSmaEnabled && !tradingActive,
                statusLabel,
                priorityOrder,
                slots = slotRows
            };
        }

        private void RecordHtmlReportMetaLogicReady(BotTabSimple tab, DateTime candleTime)
        {
            if (_htmlReportEnabled == null || !_htmlReportEnabled.ValueBool)
            {
                return;
            }

            var lines = new List<HtmlReportMetaLogicAllocationLine>();
            int rank = 0;
            for (int slot = 1; slot <= LogicSlotCount; slot++)
            {
                LogicSlotRuntime runtime = _logicSlotRuntimes[slot];
                if (runtime == null
                    || !runtime.IsActive
                    || runtime.ParseResult?.Root == null
                    || runtime.ParseResult.IsDisabled)
                {
                    continue;
                }

                rank++;
                TryGetLogicPnlSmaMetrics(slot, out decimal? pnlAvg, out decimal? pnlLast);
                lines.Add(new HtmlReportMetaLogicAllocationLine
                {
                    Rank = rank,
                    Slot = slot,
                    LogicNote = GetLogicSlotHumanNote(slot),
                    PnlSmaAvg = pnlAvg,
                    PnlSmaLast = pnlLast
                });
            }

            RecordHtmlReportMetaLogicJournalEntry(
                tab,
                candleTime,
                "ready",
                new List<int>(),
                0,
                0m,
                0,
                lines,
                "PnlSMA готов — металогика начинает влиять на входы.");
        }

        private void RecordHtmlReportMetaLogicJournalEntry(
            BotTabSimple tab,
            DateTime candleTime,
            string mode,
            List<int> candidateOrder,
            int entriesOpened,
            decimal totalVolume,
            int freeSlots,
            List<HtmlReportMetaLogicAllocationLine> lines,
            string summary)
        {
            if (_htmlReportEnabled == null || !_htmlReportEnabled.ValueBool)
            {
                return;
            }

            lock (_htmlReportRuntimeLock)
            {
                var entry = new HtmlReportMetaLogicJournalEntry
                {
                    CandleTime = candleTime,
                    EventTimeUtc = DateTime.UtcNow,
                    TabKey = tab != null ? GetLogicPortfolioTabKey(tab) : "",
                    Mode = mode ?? "",
                    CandidatesTotal = candidateOrder?.Count ?? 0,
                    EntriesOpened = entriesOpened,
                    TotalVolume = totalVolume,
                    FreeSlots = freeSlots,
                    Summary = summary ?? ""
                };

                if (lines != null)
                {
                    entry.Lines.AddRange(lines);
                }

                _htmlReportRuntime.MetaLogicJournal.Add(entry);
                TrimHtmlReportMetaLogicJournal(_htmlReportRuntime.MetaLogicJournal);
                _htmlReportDirty = true;
            }
        }

        private static void TrimHtmlReportMetaLogicJournal(List<HtmlReportMetaLogicJournalEntry> journal)
        {
            if (journal.Count <= HtmlReportMetaLogicJournalCap)
            {
                return;
            }

            journal.RemoveRange(0, journal.Count - HtmlReportMetaLogicJournalCap);
        }

        private static string HtmlEncode(string text)
        {
            if (string.IsNullOrEmpty(text))
            {
                return "";
            }

            return text
                .Replace("&", "&amp;")
                .Replace("<", "&lt;")
                .Replace(">", "&gt;")
                .Replace("\"", "&quot;");
        }

        private static void AppendHtmlReportStyles(StringBuilder sb)
        {
            sb.AppendLine(":root{--paper-bg:#ede4d3;--paper-surface:#faf5eb;--paper-card:#f5eedc;--paper-border:#d4c4a8;--text:#3d3429;--muted:#7a6f5c;--accent:#8b6914;--accent-soft:#f3ead6;}");
            sb.AppendLine("body{font-family:Segoe UI,Georgia,system-ui,sans-serif;margin:0;padding:16px 20px 40px;background:var(--paper-bg);color:var(--text);}");
            sb.AppendLine(".hdr h1{margin:0 0 6px;font-size:1.35rem;color:#2c2419;}");
            sb.AppendLine(".sub{margin:0 0 10px;color:var(--muted);font-size:.9rem;}");
            sb.AppendLine(".badge{display:inline-block;padding:4px 10px;border-radius:999px;font-size:.85rem;font-weight:600;margin:0 6px 6px 0;border:1px solid var(--paper-border);}");
            sb.AppendLine(".badge-tester{background:#dbeafe;color:#1e3a8a;}");
            sb.AppendLine(".badge-optimizer{background:#ede9fe;color:#5b21b6;}");
            sb.AppendLine(".badge-fake{background:#fde68a;color:#78350f;}");
            sb.AppendLine(".badge-live{background:#bbf7d0;color:#14532d;}");
            sb.AppendLine(".kpi{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin:16px 0 24px;}");
            sb.AppendLine(".kpi .card{background:var(--paper-card);border:1px solid var(--paper-border);border-radius:8px;padding:12px;box-shadow:0 1px 2px rgba(61,52,41,.06);}");
            sb.AppendLine(".kpi .lbl{font-size:.75rem;color:var(--muted);}");
            sb.AppendLine(".kpi .val{font-size:1.15rem;font-weight:600;margin-top:4px;color:#2c2419;}");
            sb.AppendLine("section{margin:24px 0;}");
            sb.AppendLine("h2{font-size:1.05rem;border-bottom:1px solid var(--paper-border);padding-bottom:6px;color:#2c2419;}");
            sb.AppendLine(".chart{background:var(--paper-surface);border:1px solid var(--paper-border);border-radius:8px;padding:8px;min-height:120px;overflow-x:hidden;box-sizing:border-box;width:100%;}");
            sb.AppendLine(".chart-portfolio{min-height:220px;}");
            sb.AppendLine(".portfolio-equity-report{margin:8px 0 32px;}");
            sb.AppendLine(".logic-breakdown-title{margin-top:28px;margin-bottom:8px;}");
            sb.AppendLine(".logic-portfolio-block{margin:18px 0 24px;padding:14px 16px;background:var(--paper-card);border:1px solid var(--paper-border);border-radius:10px;box-shadow:0 1px 2px rgba(61,52,41,.05);}");
            sb.AppendLine(".logic-portfolio-block h3{margin:0 0 10px;font-size:1.02rem;color:#2c2419;}");
            sb.AppendLine(".logic-formula-line{margin:0 0 10px;padding:10px 12px;background:var(--paper-surface);border:1px solid var(--paper-border);border-radius:6px;font-size:.78rem;line-height:1.5;white-space:pre-wrap;word-break:break-word;font-family:Consolas,Monaco,monospace;color:#3d3429;max-height:220px;overflow:auto;}");
            sb.AppendLine(".logic-portfolio-meta{margin:0 0 10px;font-size:.85rem;}");
            sb.AppendLine(".logic-equity-chart{min-height:200px;}");
            sb.AppendLine(".logic-trade-chart{min-height:180px;margin-top:8px;}");
            sb.AppendLine(".logic-chart-title{margin:12px 0 4px;font-size:.88rem;color:var(--muted);}");
            sb.AppendLine(".tbl-wrap{overflow-x:auto;}");
            sb.AppendLine("table{border-collapse:collapse;width:100%;font-size:.85rem;}");
            sb.AppendLine("th,td{border:1px solid var(--paper-border);padding:6px 8px;text-align:left;}");
            sb.AppendLine("th{background:var(--paper-card);color:#2c2419;}");
            sb.AppendLine("tr:nth-child(even){background:rgba(212,196,168,.18);}");
            sb.AppendLine("tr.stopper-row{font-weight:700;background:linear-gradient(90deg,#fff8e7 0%,#faf5eb 100%);}");
            sb.AppendLine("tr.stopper-row td{color:#2c2419;}");
            sb.AppendLine("tr.stopper-row-sl{border-left:4px solid #b45309;}");
            sb.AppendLine("tr.stopper-row-tp{border-left:4px solid #15803d;}");
            sb.AppendLine("tr.stopper-row-eod{border-left:4px solid #6366f1;}");
            sb.AppendLine("footer{margin-top:32px;color:var(--muted);font-size:.8rem;}");
            sb.AppendLine(".bar-open{fill:#2d7a46;}.bar-close{fill:#b91c1c;}");
            sb.AppendLine(".eq-line{fill:none;stroke:#1d4ed8;stroke-width:2;}");
            sb.AppendLine(".pos-open-line{fill:none;stroke:#15803d;stroke-width:2;}");
            sb.AppendLine(".pos-close-line{fill:none;stroke:#b91c1c;stroke-width:2;}");
            sb.AppendLine(".chart-legend .lg-open{color:#15803d;}.chart-legend .lg-close{color:#b91c1c;}");
            sb.AppendLine(".chart-svg{display:block;width:100%;max-width:100%;}");
            sb.AppendLine(".chart-grid{stroke:#d4c4a8;stroke-width:1;opacity:.55;}");
            sb.AppendLine(".chart-axis-line{stroke:#b8a88c;stroke-width:1;}");
            sb.AppendLine(".chart-axis-text{font-size:10px;fill:#7a6f5c;font-family:Segoe UI,sans-serif;}");
            sb.AppendLine(".chart-config-band-even{fill:#f5f0e6;}");
            sb.AppendLine(".chart-config-band-odd{fill:#ffffff;}");
            sb.AppendLine(".chart-config-marker{fill:#b45309;stroke:#fff;stroke-width:1;opacity:.92;}");
            sb.AppendLine(".chart-config-marker-link{cursor:pointer;}");
            sb.AppendLine(".chart-stopper-marker-link{cursor:pointer;}");
            sb.AppendLine("#stopper-events tbody tr[id]{scroll-margin-top:80px;}");
            sb.AppendLine("#stopper-events tbody tr:target{background:#fef3c7;}");
            sb.AppendLine(".cfg-journal-formula{font-size:11px;white-space:pre-wrap;word-break:break-word;max-width:420px;margin:0;}");
            sb.AppendLine("#config-change-journal tbody tr[id]{scroll-margin-top:80px;}");
            sb.AppendLine("#config-change-journal tbody tr:target{background:#fef3c7;}");
            sb.AppendLine("section.chart-section{margin:24px 0;}");
            sb.AppendLine("details.report-fold{margin:16px 0;border:1px solid var(--paper-border);border-radius:8px;background:var(--paper-surface);box-shadow:0 1px 2px rgba(61,52,41,.05);}");
            sb.AppendLine("details.report-fold summary{cursor:pointer;list-style:none;font-size:1.02rem;font-weight:600;padding:12px 16px;color:#2c2419;border-bottom:1px solid transparent;user-select:none;}");
            sb.AppendLine("details.report-fold summary::-webkit-details-marker{display:none;}");
            sb.AppendLine("details.report-fold summary::before{content:'▸ ';color:var(--accent);font-weight:700;}");
            sb.AppendLine("details.report-fold[open] summary::before{content:'▾ ';}");
            sb.AppendLine("details.report-fold[open] summary{border-bottom-color:var(--paper-border);}");
            sb.AppendLine("details.report-fold .fold-body{padding:12px 16px 16px;}");
            sb.AppendLine("details.report-fold .fold-body .sub{margin-top:0;}");
            sb.AppendLine("details.report-fold-inline{margin-top:12px;}");
            sb.AppendLine("details.report-fold-strip summary{background:linear-gradient(90deg,var(--paper-card) 0%,var(--paper-surface) 100%);border-left:4px solid var(--accent);}");
            sb.AppendLine("details.report-fold-instruments{margin:20px 0;}");
            sb.AppendLine("details.report-fold-stopper summary{border-left:4px solid #b45309;}");
            sb.AppendLine("details.report-fold-meta-journal summary{border-left:4px solid #6366f1;}");
            sb.AppendLine("details.report-fold-positions summary{border-left:4px solid #15803d;}");
            sb.AppendLine("details.report-fold-events summary{border-left:4px solid #7a6f5c;}");
        }

        private static void AppendHtmlReportRenderScript(StringBuilder sb)
        {
            sb.AppendLine(@"(function(){
  var raw=document.getElementById('multilogic-report-data').textContent;
  var d=JSON.parse(raw);
  document.getElementById('gen-time').textContent=d.generatedAtUtc||'';
  function pick(o){
    for(var i=1;i<arguments.length;i++){
      var k=arguments[i];
      if(o&&o[k]!=null&&o[k]!==''){return o[k];}
    }
    return null;
  }
  var mode=d.executionMode||{};
  var modeId=pick(mode,'modeId','ModeId')||'live';
  var modeLabel=pick(mode,'modeLabel','ModeLabel')||'?';
  var emulatorOn=!!pick(mode,'emulatorIsOn','EmulatorIsOn');
  var badgeClass='badge badge-'+modeId;
  var badges=document.getElementById('mode-badges');
  if(badges){
    badges.innerHTML='<span class=""'+badgeClass+'"">Текущий режим: '+modeLabel+'</span>';
    if(emulatorOn){badges.innerHTML+='<span class=""badge badge-fake"">EmulatorIsOn</span>';}
  }
  function fmt(n){if(n==null||n==='')return '—';return Number(n).toLocaleString('ru-RU',{maximumFractionDigits:2});}
  function card(l,v){return '<div class=""card""><div class=""lbl"">'+l+'</div><div class=""val"">'+v+'</div></div>';}
  function fillStopperEvents(rows){
    var tb=document.querySelector('#stopper-events tbody'); if(!tb)return;
    tb.innerHTML='';
    var list=(rows||[]).slice().reverse();
    if(!list.length){tb.innerHTML='<tr><td colspan=""10"">— срабатываний пока нет —</td></tr>';return;}
    for(var i=0;i<list.length;i++){
      var s=list[i];
      var tr=document.createElement('tr');
      tr.id='stopper-j-'+(pick(s,'id','Id')||(list.length-i));
      var kindCls='stopper-row-sl';
      var kindLbl='Stop-loss';
      if(s.kind==='portfolio_take_profit'){kindCls='stopper-row-tp';kindLbl='Take-profit';}
      else if(s.kind==='portfolio_peak_drawdown'){kindCls='stopper-row-sl';kindLbl='Просадка от пика';}
      else if(s.kind==='portfolio_significant_peak_pause'){kindCls='stopper-row-tp';kindLbl='Пауза: значит. пик';}
      else if(s.kind==='portfolio_eod_flat'){kindCls='stopper-row-eod';kindLbl='EOD flat';}
      tr.className='stopper-row '+kindCls;
      var cells=[s.candleTime||'',s.executionModeLabel||'',kindLbl,fmt(s.referenceEquity),fmt(s.currentEquity),
        s.thresholdPercent!=null?Number(s.thresholdPercent).toLocaleString('ru-RU'):'—',
        fmt(s.triggerLevel),fmt(s.postCloseEquity),s.regimeStopped?'да':'нет',s.summary||''];
      for(var j=0;j<cells.length;j++){var td=document.createElement('td');td.textContent=cells[j]==null?'':String(cells[j]);tr.appendChild(td);}
      tb.appendChild(tr);
    }
  }
  function renderMetaLogicStatus(m){
    var st=document.getElementById('meta-logic-status');
    if(!st)return;
    if(!m){st.textContent='—';return;}
    var html=(m.statusLabel||'');
    if(m.enabled){
      html+=' · PnlSMA '+(m.pnlSmaEnabled?'вкл':'выкл')+' · окно '+(m.pnlSmaLen||'?');
      if(m.inversionActive) html+=' · инверсия неуспешных (PnlSMA<0)';
      else if(m.inversion) html+=' · инверсия (ожид.)';
      if(m.tradingActive) html+=' · <span class=""lg-open"">активна</span>';
      else if(m.warmupPending) html+=' · <span class=""lg-close"">прогрев</span>';
    }
    st.innerHTML=html;
    var rankBySlot={};
    (m.priorityOrder||[]).forEach(function(p){rankBySlot[p.slot]=p.rank;});
    var activeSlots=(m.slots||[]).filter(function(s){return s.active;});
    activeSlots.sort(function(a,b){
      var ra=rankBySlot[a.slot]||999, rb=rankBySlot[b.slot]||999;
      return ra-rb || a.slot-b.slot;
    });
    fillTable('meta-logic-priority',activeSlots,function(row){
      return [rankBySlot[row.slot]||'—','L'+row.slot,row.logicNote||'',fmt(row.pnlSmaAvg),fmt(row.pnlSmaLast),fmt(row.equity),row.historyPoints,row.pnlReady?'да':'нет'];
    });
  }
  function fillMetaLogicJournal(rows){
    fillTable('meta-logic-journal',(rows||[]).slice().reverse(),function(j){
      var mode=j.mode||'';
      var modeLbl=mode;
      if(mode==='meta') modeLbl='мета';
      else if(mode==='warmup') modeLbl='прогрев';
      else if(mode==='plain') modeLbl='обычная';
      else if(mode==='ready') modeLbl='готов';
      var det=(j.lines||[]).map(function(l){
        if(l.skipped) return 'L'+l.slot+' пропуск';
        var s='L'+l.slot;
        if(l.logicNote) s+=' '+l.logicNote;
        s+=' w='+fmt(l.pnlSmaAvg);
        if(l.weightSharePct!=null) s+=' '+Number(l.weightSharePct).toFixed(1)+'%';
        if(l.volume) s+=' vol='+fmt(l.volume);
        if(l.side) s+=' '+l.side;
        return s;
      }).join('; ');
      return [j.candleTime||'',j.tabKey||'',modeLbl,j.candidatesTotal,j.entriesOpened,fmt(j.totalVolume),j.freeSlots,det+(j.summary?(' · '+j.summary):'')];
    });
  }
  function closeReasonLabel(r){
    var rs=pick(r,'reason','Reason')||'';
    if(rs==='RegimeFlip')return 'Regime(LinReg) — OnFlip=Close';
    return pick(r,'label','Label')||rs||'?';
  }
  function renderClosePnLSummary(d){
    var s=d.closePnLSummary||{};
    var box=document.getElementById('close-pnl-summary');
    var rows=[
      {g:'По сигналу Cl (обычное закрытие)',c:pick(s,'signalCloseCount'),v:pick(s,'signalClose')},
      {g:'SL логики (SL[…] в строке)',c:pick(s,'logicStopLossCount'),v:pick(s,'logicStopLoss')},
      {g:'TP логики (TP[…] в строке)',c:pick(s,'logicTakeProfitCount'),v:pick(s,'logicTakeProfit')},
      {g:'Сумма SL+TP логики',c:(pick(s,'logicStopLossCount')||0)+(pick(s,'logicTakeProfitCount')||0),v:pick(s,'logicStopTakeSum')},
      {g:'Общепортф. stop-loss',c:pick(s,'portfolioStopSLCount'),v:pick(s,'portfolioStopSL')},
      {g:'Общепортф. take-profit',c:pick(s,'portfolioStopTPCount'),v:pick(s,'portfolioStopTP')},
      {g:'Ежедневная продажа по времени',c:pick(s,'portfolioEodFlatCount'),v:pick(s,'portfolioEodFlat'),eod:true},
      {g:'Сумма общепортф. SL+TP',c:(pick(s,'portfolioStopSLCount')||0)+(pick(s,'portfolioStopTPCount')||0),v:pick(s,'portfolioSlTpSum')},
      {g:'Сумма общепортф. SL+TP+EOD',c:(pick(s,'portfolioStopSLCount')||0)+(pick(s,'portfolioStopTPCount')||0)+(pick(s,'portfolioEodFlatCount')||0),v:pick(s,'portfolioStopAndEodSum')},
      {g:'Все SL/TP/EOD (портфель + логика)',c:null,v:pick(s,'allStopTakeSum')},
      {g:'Итого по закрытиям (сумма строк)',c:null,v:pick(s,'realizedFromTrackedCloses')}
    ];
    if(box){
      var eodOn=!!pick(s,'portfolioEodFlatEnabled');
      var hint=eodOn?'Параметр «Продать всё к времени» включён.':'Параметр «Продать всё к времени» = «Не продавать».';
      box.innerHTML='<p class=""sub"">'+hint+'</p>';
    }
    fillTable('close-pnl-summary-table',rows.filter(function(r){
      if(r.eod&&!pick(s,'portfolioEodFlatEnabled')&&(pick(s,'portfolioEodFlatCount')||0)===0&&(pick(s,'portfolioEodFlat')||0)===0){return false;}
      return true;
    }),function(r){return [r.g,r.c==null?'—':r.c,fmt(r.v)];});
  }
  function renderCloseReasons(d){
    var cr=document.getElementById('close-reasons');
    var list=d.closeReasonsList||[];
    if(!list.length&&d.closeReasons){
      list=Object.keys(d.closeReasons).map(function(k){
        var pnl=d.closeReasonPnL&&d.closeReasonPnL[k]!=null?d.closeReasonPnL[k]:0;
        return {reason:k,label:k,count:d.closeReasons[k],pnl:pnl};
      });
      list.sort(function(a,b){return (b.count||0)-(a.count||0);});
    }
    if(cr){
      if(!list.length){cr.innerHTML='<p class=""sub"">— нет закрытий в сессии —</p>';}
      else{cr.innerHTML=list.map(function(r){
        return '<span class=""badge"">'+closeReasonLabel(r)+': '+(r.count||0)+' / '+fmt(pick(r,'pnl','Pnl'))+'</span> ';
      }).join('');}
    }
    fillTable('close-reasons-table',list,function(r){return [closeReasonLabel(r),r.count||0,fmt(pick(r,'pnl','Pnl'))];});
  }
  function renderOpenPositions(d){
    var hint=document.getElementById('open-positions-hint');
    var rows=d.openPositions||[];
    var hasOpen=rows.some(function(p){return pick(p,'status','Status')==='open';});
    if(hint){
      if(!rows.length){hint.textContent='На момент отчёта открытых позиций нет.';}
      else if(hasOpen){hint.textContent='Текущие открытые позиции робота.';}
      else{hint.textContent='Открытых позиций сейчас нет — ниже последние события open из журнала ('+rows.length+').';}
    }
    fillTable('open-positions',rows,function(p){
      var st=pick(p,'status','Status')||'';
      var stLbl=st==='open'?'открыта':(st==='event'?'событие open':'—');
      return [stLbl,pick(p,'tabKey','TabKey')||'',pick(p,'logicSlot','LogicSlot')?'L'+pick(p,'logicSlot','LogicSlot'):'—',pick(p,'direction','Direction')||'—',fmt(pick(p,'volume','Volume')),fmt(pick(p,'entryPrice','EntryPrice')),pick(p,'openTime','OpenTime')||'',pick(p,'signalTypeOpen','SignalTypeOpen')||''];
    });
  }
  function renderClosedTrades(d){
    var hint=document.getElementById('closed-trades-hint');
    var rows=(d.closedTrades||[]).slice().reverse();
    var total=d.closedTradesTotal!=null?d.closedTradesTotal:(d.summary&&d.summary.closesTotal);
    if(hint){
      if(!rows.length){hint.textContent='Закрытых сделок в отчёте пока нет.';}
      else if(total!=null&&total>rows.length){hint.textContent='Показаны последние '+rows.length+' из '+total+' закрытий сессии.';}
      else{hint.textContent='Всего закрытий в сессии: '+rows.length+'.';}
    }
    var reasonLabels={
      PortfolioStopSL:'Общепортф. SL',PortfolioStopTP:'Общепортф. TP',PortfolioPeakDrawdown:'Просадка от пика',PortfolioEodFlat:'EOD продажа',
      StopLoss:'SL логики',TakeProfit:'TP логики',SignalClose:'Cl',RegimeFlip:'LinReg OnFlip',StopRobot:'Стоп робота',Other:'Прочее'
    };
    fillTable('closed-trades',rows,function(t){
      var rs=pick(t,'closeReason','CloseReason')||'';
      return [pick(t,'tabKey','TabKey')||'',pick(t,'logicSlot','LogicSlot')?'L'+pick(t,'logicSlot','LogicSlot'):'—',pick(t,'openTime','OpenTime')||'',pick(t,'closeTime','CloseTime')||'',pick(t,'duration','Duration')||'—',fmt(pick(t,'delta','Delta')),reasonLabels[rs]||rs,pick(t,'note','Note')||''];
    });
  }
  function fillTable(id,rows,proj,rowHook){
    var tb=document.querySelector('#'+id+' tbody'); if(!tb)return;
    tb.innerHTML='';
    if(!rows||!rows.length){tb.innerHTML='<tr><td colspan=""9"">—</td></tr>';return;}
    for(var i=0;i<rows.length;i++){
      var cells=proj(rows[i]); var tr=document.createElement('tr');
      if(rowHook){rowHook(tr,rows[i]);}
      for(var j=0;j<cells.length;j++){var td=document.createElement('td');td.textContent=cells[j]==null?'':String(cells[j]);tr.appendChild(td);}
      tb.appendChild(tr);
    }
  }
  var logicChartColors=['#1d4ed8','#15803d','#b45309','#7c3aed','#0e7490','#be123c','#4d7c0f','#c2410c','#5b21b6','#0369a1'];
  function niceNum(range,round){
    var exp=Math.floor(Math.log10(range));
    var f=range/Math.pow(10,exp);
    var nf;
    if(round){if(f<1.5)nf=1;else if(f<3)nf=2;else if(f<7)nf=5;else nf=10;}
    else{if(f<=1)nf=1;else if(f<=2)nf=2;else if(f<=5)nf=5;else nf=10;}
    return nf*Math.pow(10,exp);
  }
  function niceTicks(min,max,maxTicks){
    var range=niceNum(max-min,false);
    var tickSpacing=niceNum(range/(maxTicks-1),true);
    var graphMin=Math.floor(min/tickSpacing)*tickSpacing;
    var graphMax=Math.ceil(max/tickSpacing)*tickSpacing;
    var ticks=[];
    for(var v=graphMin;v<=graphMax+tickSpacing*0.501;v+=tickSpacing){ticks.push(v);}
    return {min:graphMin,max:graphMax,ticks:ticks};
  }
  function formatChartDate(iso){
    if(!iso)return '';
    var d=new Date(iso);
    if(isNaN(d.getTime()))return String(iso).substring(0,16);
    var dd=('0'+d.getDate()).slice(-2);
    var mm=('0'+(d.getMonth()+1)).slice(-2);
    var yy=String(d.getFullYear()).slice(-2);
    var hh=('0'+d.getHours()).slice(-2);
    var mi=('0'+d.getMinutes()).slice(-2);
    return dd+'.'+mm+'.'+yy+' '+hh+':'+mi;
  }
  function formatAxisNumber(n){
    if(n==null||isNaN(n))return '';
    var a=Math.abs(n);
    if(a>=1e6)return (n/1e6).toLocaleString('ru-RU',{maximumFractionDigits:1})+'M';
    if(a>=1e4)return (n/1e3).toLocaleString('ru-RU',{maximumFractionDigits:1})+'k';
    return Number(n).toLocaleString('ru-RU',{maximumFractionDigits:0});
  }
  function pickSparseIndices(count,maxTicks){
    var n=Math.max(1,count);
    var tc=Math.min(maxTicks||6,Math.max(2,n));
    var idx=[];
    for(var i=0;i<tc;i++){idx.push(Math.round(i*(n-1)/(tc-1||1)));}
    return idx;
  }
  function padChartSeries(series){
    if(!series||!series.length)return series||[];
    if(series.length>=2)return series;
    var p=series[0],dup={};
    for(var k in p){if(Object.prototype.hasOwnProperty.call(p,k)){dup[k]=p[k];}}
    return [p,dup];
  }
  function chartPlotWidth(el){
    var w=0;
    if(el){
      w=el.clientWidth;
      if(w<80){
        var p=el.parentElement;
        while(p&&w<80){w=p.clientWidth;p=p.parentElement;}
      }
    }
    if(w<80){w=window.innerWidth;}
    return Math.max(320,w-16);
  }
  function findSeriesIndexByTime(series,timeKey,isoTime){
    if(!series||!series.length||!isoTime)return 0;
    var target=new Date(isoTime).getTime();
    if(isNaN(target))return 0;
    var best=0;
    for(var i=0;i<series.length;i++){
      var pt=new Date(series[i][timeKey]).getTime();
      if(isNaN(pt))continue;
      if(pt<=target)best=i;
      else break;
    }
    return best;
  }
  function filterConfigChangesForGlobal(journal){
    return (journal||[]).filter(function(e){return !!pick(e,'affectsGlobalChart','AffectsGlobalChart');});
  }
  function filterConfigChangesForLogic(journal,slot){
    return (journal||[]).filter(function(e){
      var cat=pick(e,'category','Category')||'';
      if(cat==='logic_inversion')return true;
      if(cat==='logic_line'){
        var ls=Number(pick(e,'logicSlot','LogicSlot'))||0;
        return ls===slot;
      }
      return !!pick(e,'affectsGlobalChart','AffectsGlobalChart');
    });
  }
  function configCategoryLabel(cat){
    if(cat==='logic_line')return 'Логика';
    if(cat==='logic_inversion')return 'Инверсия';
    if(cat==='regime')return 'Regime';
    if(cat==='stopper')return 'Stopper';
    if(cat==='volume')return 'Объём';
    if(cat==='meta')return 'Металогика';
    return 'Торговля';
  }
  function configChangeHint(entry){
    var s=pick(entry,'summary','Summary')||'';
    if(s)return s;
    var pn=pick(entry,'paramName','ParamName')||'';
    return pn||('#'+(pick(entry,'id','Id')||'?'));
  }
  function appendConfigBandRects(svg,series,changes,x0,x1,y0,y1,timeKey){
    if(!changes||!changes.length||!series||series.length<2)return svg;
    var n=series.length;
    var changeIdx=[];
    for(var ci=0;ci<changes.length;ci++){
      var idx=findSeriesIndexByTime(series,timeKey,pick(changes[ci],'candleTime','CandleTime')||pick(changes[ci],'t','T'));
      if(changeIdx.indexOf(idx)<0){changeIdx.push(idx);}
    }
    changeIdx.sort(function(a,b){return a-b;});
    var segments=[];
    var segStart=0;
    for(var bi=0;bi<changeIdx.length;bi++){
      var cut=changeIdx[bi];
      if(cut>segStart){segments.push({from:segStart,to:cut-1});}
      segStart=cut;
    }
    if(segStart<=n-1){segments.push({from:segStart,to:n-1});}
    if(!segments.length){segments.push({from:0,to:n-1});}
    var bandSvg='';
    for(var si=0;si<segments.length;si++){
      var seg=segments[si];
      var xFrom=x0+(x1-x0)*seg.from/(n-1||1);
      var xTo=x0+(x1-x0)*seg.to/(n-1||1);
      var cls=(si%2===0)?'chart-config-band-even':'chart-config-band-odd';
      bandSvg+='<rect class=""'+cls+'"" x=""'+xFrom+'"" y=""'+y0+'"" width=""'+(Math.max(1,xTo-xFrom+((seg.to===n-1)?0:0)))+'"" height=""'+(y1-y0)+'""/>';
    }
    return bandSvg+svg;
  }
  function appendConfigChangeMarkers(svg,series,changes,x0,x1,y0,y1,timeKey){
    if(!changes||!changes.length||!series||!series.length)return svg;
    var n=series.length;
    var markerSvg='';
    for(var mi=0;mi<changes.length;mi++){
      var ch=changes[mi];
      var idx=findSeriesIndexByTime(series,timeKey,pick(ch,'candleTime','CandleTime')||pick(ch,'t','T'));
      var cx=x0+(x1-x0)*idx/(n-1||1);
      var cy=y0+8;
      var id=pick(ch,'id','Id');
      var hint=configChangeHint(ch).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/\x22/g,'&quot;');
      var href='#cfg-j-'+id;
      markerSvg+='<a class=""chart-config-marker-link"" href=""'+href+'""><title>'+hint+'</title>';
      markerSvg+='<circle class=""chart-config-marker"" cx=""'+cx+'"" cy=""'+cy+'"" r=""4""/>';
      markerSvg+='<line x1=""'+cx+'"" y1=""'+y0+'"" x2=""'+cx+'"" y2=""'+y1+'"" stroke=""#d97706"" stroke-width=""1"" stroke-dasharray=""3,3"" opacity="".45""/>';
      markerSvg+='</a>';
    }
    return svg+markerSvg;
  }
  function appendStopperMarkers(svg,series,events,x0,x1,y0,y1,timeKey){
    if(!events||!events.length||!series||!series.length)return svg;
    var n=series.length;
    var markerSvg='';
    for(var si=0;si<events.length;si++){
      var ev=events[si];
      var kind=pick(ev,'kind','Kind')||'';
      if(kind!=='portfolio_stop_loss'&&kind!=='portfolio_take_profit'
        &&kind!=='portfolio_peak_drawdown'&&kind!=='portfolio_significant_peak_pause')continue;
      var idx=findSeriesIndexByTime(series,timeKey,pick(ev,'candleTime','CandleTime')||pick(ev,'t','T'));
      var cx=x0+(x1-x0)*idx/(n-1||1);
      var isTp=kind==='portfolio_take_profit'||kind==='portfolio_significant_peak_pause';
      var stroke=isTp?'#15803d':'#dc2626';
      var lbl='Общепортф. stop-loss';
      if(kind==='portfolio_take_profit')lbl='Общепортф. take-profit';
      else if(kind==='portfolio_peak_drawdown')lbl='Просадка от пика';
      else if(kind==='portfolio_significant_peak_pause')lbl='Пауза: значит. пик';
      var hint=(pick(ev,'summary','Summary')||lbl).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/\x22/g,'&quot;');
      var sid=pick(ev,'id','Id');
      if(sid==null||sid==='')sid=si+1;
      var href='#stopper-j-'+sid;
      markerSvg+='<a class=""chart-stopper-marker-link"" href=""'+href+'""><title>'+hint+'</title>';
      markerSvg+='<line x1=""'+cx+'"" y1=""'+y0+'"" x2=""'+cx+'"" y2=""'+y1+'"" stroke=""'+stroke+'"" stroke-width=""1"" opacity="".55""/>';
      markerSvg+='<circle cx=""'+cx+'"" cy=""'+(y0+7)+'"" r=""3"" fill=""'+stroke+'"" stroke=""#fff"" stroke-width=""1"" opacity="".9""/>';
      markerSvg+='</a>';
    }
    return svg+markerSvg;
  }
  function fillConfigChangeJournal(journal){
    var tb=document.querySelector('#config-change-journal tbody');
    if(!tb)return;
    tb.innerHTML='';
    var list=(journal||[]).slice();
    if(!list.length){
      tb.innerHTML='<tr><td colspan=""9"">— изменений параметров пока не зафиксировано —</td></tr>';
      return;
    }
    for(var i=0;i<list.length;i++){
      var e=list[i];
      var tr=document.createElement('tr');
      tr.id='cfg-j-'+(pick(e,'id','Id')||'');
      tr.className='cfg-journal-row';
      var slotVal=Number(pick(e,'logicSlot','LogicSlot'))||0;
      var cat=configCategoryLabel(pick(e,'category','Category')||'');
      var oldFormula=pick(e,'oldLogicLine','OldLogicLine')||'';
      var newFormula=pick(e,'newLogicLine','NewLogicLine')||'';
      var oldVal=pick(e,'oldValue','OldValue')||'';
      var newVal=pick(e,'newValue','NewValue')||'';
      var cells=[
        pick(e,'id','Id')||'',
        pick(e,'candleTime','CandleTime')||'',
        cat,
        slotVal>0?('L'+slotVal):'—',
        pick(e,'paramName','ParamName')||'',
        oldFormula?'—':(oldVal||'—'),
        newFormula?'—':(newVal||'—'),
        oldFormula||'—',
        newFormula||'—'
      ];
      for(var j=0;j<cells.length;j++){
        var td=document.createElement('td');
        if(j===7&&oldFormula){
          var pre=document.createElement('pre');
          pre.className='cfg-journal-formula';
          pre.textContent=oldFormula;
          td.appendChild(pre);
        }else if(j===8&&newFormula){
          var pre2=document.createElement('pre');
          pre2.className='cfg-journal-formula';
          pre2.textContent=newFormula;
          td.appendChild(pre2);
        }else{
          td.textContent=cells[j]==null?'':String(cells[j]);
        }
        tr.appendChild(td);
      }
      tb.appendChild(tr);
    }
  }
  function renderLineChart(el,series,lines,opts){
    opts=opts||{};
    if(!el)return;
    series=padChartSeries(series);
    if(!series||!series.length){el.textContent=opts.emptyText||'Нет данных';return;}
    var plotH=opts.plotHeight||160;
    var padL=opts.padLeft||76,padR=14,padT=12,padB=30;
    var w=chartPlotWidth(el);
    var h=plotH+padT+padB;
    var x0=padL,x1=w-padR,y0=padT,y1=padT+plotH;
    var allY=[];
    for(var li=0;li<lines.length;li++){
      var acc=lines[li].accessor;
      for(var pi=0;pi<series.length;pi++){allY.push(Number(acc(series[pi])));}
    }
    var rawMin=Math.min.apply(null,allY),rawMax=Math.max.apply(null,allY);
    if(!isFinite(rawMin)||!isFinite(rawMax)){el.textContent=opts.emptyText||'Нет данных';return;}
    if(rawMin===rawMax){rawMin-=1;rawMax+=1;}
    var yAxis=niceTicks(rawMin,rawMax,opts.yTicks||5);
    var yMin=yAxis.min,yMax=yAxis.max,yTicks=yAxis.ticks;
    var n=series.length;
    var xTickIdx=pickSparseIndices(n,opts.xTicks||6);
    var dateKey=opts.timeKey||'t';
    var configChanges=opts.configChanges||[];
    var stopperEvents=opts.stopperEvents||[];
    var svg='<svg width=""100%"" height=""'+h+'"" viewBox=""0 0 '+w+' '+h+'"" preserveAspectRatio=""none"" class=""chart-svg"">';
    svg=appendConfigBandRects(svg,series,configChanges,x0,x1,y0,y1,dateKey);
    for(var yi=0;yi<yTicks.length;yi++){
      var v=yTicks[yi];
      var gy=y1-(y1-y0)*(v-yMin)/(yMax-yMin);
      svg+='<line class=""chart-grid"" x1=""'+x0+'"" y1=""'+gy+'"" x2=""'+x1+'"" y2=""'+gy+'""/>';
      svg+='<text class=""chart-axis-text"" x=""'+(x0-6)+'"" y=""'+(gy+3)+'"" text-anchor=""end"">'+formatAxisNumber(v)+'</text>';
    }
    for(var xi=0;xi<xTickIdx.length;xi++){
      var idx=xTickIdx[xi];
      var gx=x0+(x1-x0)*idx/(n-1||1);
      svg+='<line class=""chart-grid"" x1=""'+gx+'"" y1=""'+y0+'"" x2=""'+gx+'"" y2=""'+y1+'""/>';
      svg+='<text class=""chart-axis-text"" x=""'+gx+'"" y=""'+(y1+16)+'"" text-anchor=""middle"">'+formatChartDate(series[idx][dateKey])+'</text>';
    }
    svg+='<line class=""chart-axis-line"" x1=""'+x0+'"" y1=""'+y1+'"" x2=""'+x1+'"" y2=""'+y1+'""/>';
    svg+='<line class=""chart-axis-line"" x1=""'+x0+'"" y1=""'+y0+'"" x2=""'+x0+'"" y2=""'+y1+'""/>';
    for(var lj=0;lj<lines.length;lj++){
      var line=lines[lj];
      var pts=series.map(function(p,i){
        var x=x0+(x1-x0)*i/(n-1||1);
        var y=y1-(y1-y0)*(Number(line.accessor(p))-yMin)/(yMax-yMin);
        return x+','+y;
      }).join(' ');
      var cls=line.className?' class=""'+line.className+'""':'';
      var stroke=line.color?' stroke=""'+line.color+'""':'';
      var sw=' stroke-width=""'+(line.strokeWidth||2)+'""';
      svg+='<polyline fill=""none""'+cls+stroke+sw+' points=""'+pts+'""/>';
    }
    svg=appendConfigChangeMarkers(svg,series,configChanges,x0,x1,y0,y1,dateKey);
    svg=appendStopperMarkers(svg,series,stopperEvents,x0,x1,y0,y1,dateKey);
    svg+='</svg>';
    el.innerHTML=svg;
  }
  function renderEquityChart(el,series,opts){
    opts=opts||{};
    renderLineChart(el,series,[{
      color:opts.color||'#1d4ed8',
      strokeWidth:opts.strokeWidth||2,
      accessor:function(p){return Number(pick(p,'equity','Equity'));}
    }],{
      plotHeight:opts.height||160,
      emptyText:'Нет данных equity',
      yTicks:5,
      xTicks:6,
      configChanges:opts.configChanges||[],
      stopperEvents:opts.stopperEvents||[]
    });
  }
  function renderTradeCountChart(el,series,opts){
    opts=opts||{};
    renderLineChart(el,series,[
      {className:'pos-open-line',accessor:function(p){return Number(p.opensTotal)||0;}},
      {className:'pos-close-line',accessor:function(p){return Number(p.closesTotal)||0;}}
    ],{
      plotHeight:opts.height||150,
      emptyText:'Нет данных по открытиям/закрытиям',
      yTicks:5,
      xTicks:6,
      configChanges:opts.configChanges||[],
      stopperEvents:opts.stopperEvents||[]
    });
  }
  function formatLogicLineForDisplay(line){
    if(!line)return '';
    var s=String(line);
    var regimeEnd=s.indexOf('Entry=MatchSide)');
    if(regimeEnd<0){regimeEnd=s.indexOf('Entry=FlatOnly)');}
    if(regimeEnd>=0){
      regimeEnd=s.indexOf(')',regimeEnd)+1;
      if(regimeEnd>0&&regimeEnd<s.length){s=s.substring(0,regimeEnd)+'\n'+s.substring(regimeEnd).trim();}
    }
    return s.replace(/\) AND \(/g,')\nAND (');
  }
  function renderPortfolioEquityReport(d){
    var agg=d.equitySeries&&d.equitySeries.aggregate;
    var globalChanges=filterConfigChangesForGlobal(d.configChangeJournal);
    var stopperEv=d.stopperEvents||[];
    renderEquityChart(document.getElementById('equity-chart-aggregate'),agg,{
      height:190,
      strokeWidth:2.5,
      color:'#1d4ed8',
      configChanges:globalChanges,
      stopperEvents:stopperEv
    });
    var root=document.getElementById('logic-portfolio-charts');
    if(!root)return;
    root.innerHTML='';
    var logics=(d.logicPortfolios||[]).filter(function(lg){
      return lg.active||(lg.opens||0)>0||(lg.closes||0)>0||(lg.logicLine&&String(lg.logicLine).length>0);
    });
    if(!logics.length){
      root.innerHTML='<p class=""sub"">Нет логик с историей equity или настроенной строкой.</p>';
      return;
    }
    for(var i=0;i<logics.length;i++){
      var lg=logics[i];
      var block=document.createElement('div');
      block.className='logic-portfolio-block';
      var title=document.createElement('h3');
      var titleText='L'+lg.slot;
      if(lg.active===false){titleText+=' (неактивна)';}
      title.textContent=titleText;
      block.appendChild(title);
      var pre=document.createElement('pre');
      pre.className='logic-formula-line';
      pre.textContent=lg.logicLine?formatLogicLineForDisplay(lg.logicLine):'— строка логики не задана —';
      block.appendChild(pre);
      var meta=document.createElement('p');
      meta.className='sub logic-portfolio-meta';
      var metaParts=[];
      if(lg.note){metaParts.push('Название: '+lg.note);}
      metaParts.push('Equity: '+fmt(lg.equity));
      metaParts.push('Realized: '+fmt(lg.realized));
      metaParts.push('Unrealized: '+fmt(lg.unrealized));
      metaParts.push('Opens: '+(lg.opens||0));
      metaParts.push('Closes: '+(lg.closes||0));
      if(lg.historyPoints!=null){metaParts.push('hist: '+lg.historyPoints);}
      if(lg.snapshotPoints!=null){metaParts.push('snap: '+lg.snapshotPoints);}
      meta.textContent=metaParts.join(' · ');
      block.appendChild(meta);
      var eqTitle=document.createElement('p');
      eqTitle.className='logic-chart-title';
      eqTitle.textContent='Equity';
      block.appendChild(eqTitle);
      var chart=document.createElement('div');
      chart.className='chart logic-equity-chart';
      block.appendChild(chart);
      var tradeTitle=document.createElement('p');
      tradeTitle.className='logic-chart-title chart-legend';
      tradeTitle.innerHTML='<span class=""lg-open"">● открытия (накопл.)</span> · <span class=""lg-close"">● закрытия (накопл.)</span>';
      block.appendChild(tradeTitle);
      var tradeChart=document.createElement('div');
      tradeChart.className='chart logic-trade-chart';
      block.appendChild(tradeChart);
      root.appendChild(block);
      try{
        var colors=logicChartColors||['#1d4ed8'];
        var color=colors[(lg.slot-1)%colors.length];
        var logicChanges=filterConfigChangesForLogic(d.configChangeJournal,lg.slot);
        renderEquityChart(chart,lg.series,{height:160,color:color,configChanges:logicChanges,stopperEvents:stopperEv});
        renderTradeCountChart(tradeChart,lg.tradeSeries||lg.series,{height:150,configChanges:logicChanges,stopperEvents:stopperEv});
      }catch(chartErr){
        chart.textContent='Ошибка графика: '+chartErr;
      }
    }
  }
  function renderPositionCounts(series){
    var el=document.getElementById('position-count-chart');
    if(!el)return;
    if(!series||!series.length){el.textContent='Нет данных';return;}
    var step=Math.max(1,Math.floor(series.length/600));
    var sampled=[];
    for(var i=0;i<(series||[]).length;i+=step){sampled.push(series[i]);}
    if(sampled.length&&sampled[sampled.length-1]!==series[series.length-1]){sampled.push(series[series.length-1]);}
    renderLineChart(el,sampled,[
      {className:'pos-open-line',accessor:function(p){return Number(p.opensTotal)||0;}},
      {className:'pos-close-line',accessor:function(p){return Number(p.closesTotal)||0;}}
    ],{plotHeight:160,emptyText:'Нет данных',yTicks:5,xTicks:6});
  }
  function renderDayBars(rows){
    var el=document.getElementById('trades-total-chart'); if(!el||!rows||!rows.length){el.textContent='Нет данных';return;}
    var w=Math.max(400,rows.length*36),h=140,pad=20,bw=14;
    var max=1; rows.forEach(function(r){max=Math.max(max,pick(r,'opens','Opens')||0,pick(r,'closes','Closes')||0);});
    var svg='<svg width=""'+w+'"" height=""'+h+'"">';
    for(var i=0;i<rows.length;i++){
      var x=pad+i*32;
      var ho=(h-30)*(pick(rows[i],'opens','Opens')||0)/max;
      var hc=(h-30)*(pick(rows[i],'closes','Closes')||0)/max;
      svg+='<rect class=""bar-open"" x=""'+(x)+'"" y=""'+(h-10-ho)+'"" width=""'+bw+'"" height=""'+ho+'""/>';
      svg+='<rect class=""bar-close"" x=""'+(x+bw+2)+'"" y=""'+(h-10-hc)+'"" width=""'+bw+'"" height=""'+hc+'""/>';
    }
    svg+='</svg>'; el.innerHTML=svg;
  }
  function renderMultiLogicReportBody(d){
    var s=d.summary||{};
    var kpi=document.getElementById('kpi');
    if(kpi){
      var cps=d.closePnLSummary||{};
      kpi.innerHTML=card('Equity',fmt(s.equityTotal))+card('Realized',fmt(s.realizedTotal))+card('Unrealized',fmt(s.unrealizedTotal))
        +card('Opens',s.opensTotal||0)+card('Closes',s.closesTotal||0)+card('Open pos',s.openPositionsCount||0)
        +card('Cl (фин.)',fmt(pick(cps,'signalClose')))+card('SL+TP лог.',fmt(pick(cps,'logicStopTakeSum')))
        +card('Портф. SL+TP+EOD',fmt(pick(cps,'portfolioStopAndEodSum')))+card('EOD продажа',fmt(pick(cps,'portfolioEodFlat')))+card('Stopper событий',s.stopperTriggersTotal||0);
    }
    try{fillStopperEvents(d.stopperEvents);}catch(e1){console.error(e1);}
    try{renderMetaLogicStatus(d.metaLogic);}catch(e2){console.error(e2);}
    try{fillMetaLogicJournal(d.metaLogicJournal);}catch(e3){console.error(e3);}
    try{renderPortfolioEquityReport(d);}catch(e4){console.error(e4);}
    try{fillConfigChangeJournal(d.configChangeJournal);}catch(e4b){console.error(e4b);}
    try{renderPositionCounts(d.positionCountSeries);}catch(e5){console.error(e5);}
    try{renderDayBars(d.tradeBuckets&&d.tradeBuckets.total);}catch(e6){console.error(e6);}
    try{fillTable('trades-total-table',d.tradeBuckets&&d.tradeBuckets.total,function(r){return [pick(r,'day','DayKey')||'',pick(r,'opens','Opens')||0,pick(r,'closes','Closes')||0];});}catch(e7){console.error(e7);}
    try{fillTable('by-instrument',d.tradeBuckets&&d.tradeBuckets.byInstrument,function(r){return [pick(r,'tabKey','TabKey')||'',pick(r,'opens','Opens')||0,pick(r,'closes','Closes')||0,fmt(pick(r,'realizedPnL','RealizedPnL'))];});}catch(e8){console.error(e8);}
    try{fillTable('by-logic',d.tradeBuckets&&d.tradeBuckets.byLogicSlot,function(r){
      return ['L'+pick(r,'slot','Slot'),pick(r,'opens','Opens')||0,pick(r,'closes','Closes')||0,fmt(pick(r,'realizedPnL','RealizedPnL')),
        fmt(pick(r,'pnlSignalClose')),fmt(pick(r,'pnlLogicStopLoss')),fmt(pick(r,'pnlLogicTakeProfit')),fmt(pick(r,'pnlLogicStopTakeSum')),
        fmt(pick(r,'pnlPortfolioStopSL')),fmt(pick(r,'pnlPortfolioStopTP')),fmt(pick(r,'pnlPortfolioEodFlat')),fmt(pick(r,'pnlPortfolioSlTpSum')),
        fmt(pick(r,'equity','Equity'))];
    });}catch(e9){console.error(e9);}
    try{renderClosePnLSummary(d);}catch(e9b){console.error(e9b);}
    try{renderCloseReasons(d);}catch(e10){console.error(e10);}
    try{fillTable('mode-history',d.modeHistory,function(m){
      return [pick(m,'fromUtc','FromUtc')||'',pick(m,'toUtc','ToUtc')||'…',pick(m,'modeLabel','ModeLabel')||pick(m,'modeId','ModeId')||'',pick(m,'startProgram','StartProgram')||'',pick(m,'emulatorIsOn','EmulatorIsOn')?'да':'нет'];
    });}catch(e11){console.error(e11);}
    try{renderOpenPositions(d);}catch(e12){console.error(e12);}
    try{renderClosedTrades(d);}catch(e13){console.error(e13);}
    try{fillTable('recent-events',(d.recentEvents||[]).slice().reverse(),function(e){
      return [pick(e,'candleTime','CandleTime')||'',pick(e,'executionModeLabel','ExecutionModeLabel')||'',pick(e,'eventName','eventName','Event','event')||'',pick(e,'tabKey','TabKey')||'',pick(e,'logicSlot','LogicSlot')?'L'+pick(e,'logicSlot','LogicSlot'):'—',fmt(pick(e,'delta','Delta')),pick(e,'note','Note')||''];
    },function(tr,e){
      var ev=pick(e,'eventName','Event','event')||'';
      if(ev==='portfolio_stop_loss'||ev==='portfolio_peak_drawdown'){tr.className='stopper-row stopper-row-sl';}
      else if(ev==='portfolio_take_profit'||ev==='portfolio_significant_peak_pause'){tr.className='stopper-row stopper-row-tp';}
      else if(ev==='portfolio_eod_flat'){tr.className='stopper-row stopper-row-eod';}
    });}catch(e14){console.error(e14);}
  }
  renderMultiLogicReportBody(d);
  var chartResizeTimer;
  function scheduleChartReflow(){
    clearTimeout(chartResizeTimer);
    chartResizeTimer=setTimeout(function(){renderMultiLogicReportBody(d);},120);
  }
  window.addEventListener('resize',scheduleChartReflow);
  requestAnimationFrame(function(){
    requestAnimationFrame(scheduleChartReflow);
  });
})();");
        }
        #endregion
    }

    /*
     * ////////////////////////////////////////////////////////////////////////////////
     * ////////////////////////////////////////////////////////////////////////////////
     * ////////////////////////////////////////////////////////////////////////////////
     * БЛОК 2 — ПАРСИНГ СТРОК ЛОГИКИ
     * LogicIndicatorKind, LogicAtom, LogicParseResult, LogicLineParser — Disabled, Regime,
     * AND/OR/NOT, Op/Cl, SL/TP, сигнатуры индикаторов для графика.
     * ////////////////////////////////////////////////////////////////////////////////
     * ////////////////////////////////////////////////////////////////////////////////
     * ////////////////////////////////////////////////////////////////////////////////
     */
    #region БЛОК 2 — ПАРСИНГ СТРОК ЛОГИКИ

    /// <summary>Тип индикатора в строке логики (соответствует классу OsEngine).</summary>
    public enum LogicIndicatorKind
    {
        /// <summary>Не распознан или пустое имя.</summary>
        Unknown,
        /// <summary>Simple Moving Average.</summary>
        Sma,
        /// <summary>Stochastic.</summary>
        Stoch,
        /// <summary>Average True Range (фильтр роста волатильности).</summary>
        Atr,
        /// <summary>Relative Strength Index.</summary>
        Rsi,
        /// <summary>Commodity Channel Index (отклонение от типичной цены).</summary>
        Cci,
        /// <summary>MACD.</summary>
        Macd,
        /// <summary>Linear Regression Channel.</summary>
        LinReg,
        /// <summary>Bollinger Bands.</summary>
        Bollinger,
        /// <summary>Momentum.</summary>
        Momentum,
        /// <summary>VWAP.</summary>
        Vwap,
        /// <summary>Volume (рост объёма свечи).</summary>
        Volume
    }

    /// <summary>Оператор объединения фрагментов в составной строке логики.</summary>
    public enum LogicCombineOp
    {
        /// <summary>Логическое И — все фрагменты должны выполниться.</summary>
        And,
        /// <summary>Логическое ИЛИ — достаточно одного фрагмента.</summary>
        Or
    }

    /// <summary>
    /// Один фрагмент логики: индикатор с параметрами, сигналами Op/Cl, SL/TP и пометкой Note.
    /// </summary>
    public sealed class LogicAtom
    {
        /// <summary>Распознанный тип индикатора.</summary>
        public LogicIndicatorKind Kind;
        /// <summary>Именованные параметры индикатора и пороги сигналов (Lmin, Gr, Lb…).</summary>
        public Dictionary<string, string> Params = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        /// <summary>Код сигнала входа из Op[…], например Ab, K>=55, GrOk.</summary>
        public string OpenSignal = "";
        /// <summary>Код сигнала выхода из Cl[…]; «-» — не участвует в выходе.</summary>
        public string CloseSignal = "";
        /// <summary>Сторона: L (лонг) или S (шорт); пусто — лонг по умолчанию.</summary>
        public string Side = "";
        /// <summary>Стоп-лосс из SL[…] (процент, ATR или R — см. LogicStopTakeEvaluator).</summary>
        public string StopLoss = "";
        /// <summary>Тейк-профит из TP[…] (процент, ATR или кратность R к SL).</summary>
        public string TakeProfit = "";
        /// <summary>Текст из Note(…) — только для человека.</summary>
        public string Comment = "";
        /// <summary>Исходный текст фрагмента до разбора тегов.</summary>
        public string RawFragment = "";
        /// <summary>NOT/! перед индикатором: инвертировать результат Op и Cl для этого атома.</summary>
        public bool InvertSignals;

        /// <summary>Имя типа индикатора для CreateCandleIndicator.</summary>
        public string IndicatorTypeName => LogicLineParser.GetIndicatorTypeName(Kind);

        /// <summary>Область графика: Prime или Second.</summary>
        public string ChartArea => LogicLineParser.GetChartArea(Kind);

        /// <summary>Список параметров для OsEngine в порядке, требуемом индикатором.</summary>
        public List<string> ToIndicatorParameters() => LogicLineParser.BuildIndicatorParameters(this);

        /// <summary>Возвращает строковый параметр атома или значение по умолчанию.</summary>
        /// <param name="key">Ключ параметра (регистронезависимо).</param>
        /// <param name="defaultValue">Значение, если ключ отсутствует или пуст.</param>
        public string GetParam(string key, string defaultValue = "")
        {
            return Params.TryGetValue(key, out string value) && !string.IsNullOrWhiteSpace(value)
                ? value
                : defaultValue;
        }

        /// <summary>Возвращает целочисленный параметр атома или значение по умолчанию.</summary>
        /// <param name="key">Ключ параметра.</param>
        /// <param name="defaultValue">Значение по умолчанию.</param>
        public int GetIntParam(string key, int defaultValue)
        {
            if (!Params.TryGetValue(key, out string raw) || string.IsNullOrWhiteSpace(raw))
            {
                return defaultValue;
            }

            if (int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out int value))
            {
                return value;
            }

            if (decimal.TryParse(raw, NumberStyles.Number, CultureInfo.InvariantCulture, out decimal dec))
            {
                return (int)dec;
            }

            return defaultValue;
        }

        /// <summary>Возвращает decimal-параметр атома; символ % в конце строки отбрасывается.</summary>
        /// <param name="key">Ключ параметра.</param>
        /// <param name="defaultValue">Значение по умолчанию.</param>
        public decimal GetDecimalParam(string key, decimal defaultValue)
        {
            if (!Params.TryGetValue(key, out string raw) || string.IsNullOrWhiteSpace(raw))
            {
                return defaultValue;
            }

            raw = raw.Trim().TrimEnd('%');
            return decimal.TryParse(raw, NumberStyles.Number, CultureInfo.InvariantCulture, out decimal value)
                ? value
                : defaultValue;
        }

        /// <summary>Длина окна LinReg с учётом @LR и параметра робота.</summary>
        public int GetLinRegLength()
        {
            if (Kind != LogicIndicatorKind.LinReg)
            {
                return LogicLineParser.ResolveLinRegLength(null, LogicLineParser.DefaultLinRegLength);
            }

            Params.TryGetValue("L", out string raw);
            return LogicLineParser.ResolveLinRegLength(raw, LogicLineParser.DefaultLinRegLength);
        }
    }

    /// <summary>Узел дерева выражения логики (атом или AND/OR).</summary>
    public abstract class LogicExpressionNode
    {
    }

    /// <summary>Лист дерева: один атом индикатора с Op/Cl.</summary>
    public sealed class LogicAtomNode : LogicExpressionNode
    {
        /// <summary>Разобранный атом.</summary>
        public LogicAtom Atom;

        /// <summary>Создаёт узел-лист.</summary>
        /// <param name="atom">Атом логики.</param>
        public LogicAtomNode(LogicAtom atom)
        {
            Atom = atom;
        }
    }

    /// <summary>Узел объединения двух подвыражений оператором AND или OR.</summary>
    public sealed class LogicCombineNode : LogicExpressionNode
    {
        /// <summary>AND или OR.</summary>
        public LogicCombineOp Op;
        /// <summary>Левое поддерево.</summary>
        public LogicExpressionNode Left;
        /// <summary>Правое поддерево.</summary>
        public LogicExpressionNode Right;

        /// <summary>Создаёт узел AND/OR.</summary>
        /// <param name="op">Тип оператора.</param>
        /// <param name="left">Левый операнд.</param>
        /// <param name="right">Правый операнд.</param>
        public LogicCombineNode(LogicCombineOp op, LogicExpressionNode left, LogicExpressionNode right)
        {
            Op = op;
            Left = left;
            Right = right;
        }
    }

    /// <summary>Узел инверсии NOT: true, если внутреннее подвыражение ложно (и наоборот).</summary>
    public sealed class LogicNotNode : LogicExpressionNode
    {
        /// <summary>Подвыражение (атом, AND/OR или вложенный NOT).</summary>
        public LogicExpressionNode Inner;

        /// <summary>Создаёт узел NOT.</summary>
        /// <param name="inner">Операнд.</param>
        public LogicNotNode(LogicExpressionNode inner)
        {
            Inner = inner;
        }
    }

    /// <summary>Режим наклона LinReg из префикса Regime(…) в начале строки логики.</summary>
    public sealed class LogicRegimeSpec
    {
        /// <summary>Источник режима (пока только LinReg).</summary>
        public LogicIndicatorKind SourceKind = LogicIndicatorKind.LinReg;
        /// <summary>Параметры: L, Dev, SlopeLb, SlopeDead (Slope* только для логики, не на график).</summary>
        public Dictionary<string, string> Params = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        /// <summary>Regime(Auto…) — взять L/Dev/SlopeLb из первого LinReg с Op[SlopeUp/Dn/Match].</summary>
        public bool AutoResolve;
        /// <summary>OnFlip=Close — закрывать позицию слота при наклоне против Side.</summary>
        public bool CloseOnRegimeMismatch;
        /// <summary>Entry=MatchSide — блокировать вход, если наклон не совпадает с Side.</summary>
        public bool BlockEntryBySide;
        /// <summary>Entry=FlatOnly — вход только при флэте (|Δ| ≤ SlopeDead).</summary>
        public bool EntryFlatOnly;
        /// <summary>OnFlat=Close для MatchSide — закрывать открытую позицию при флэте.</summary>
        public bool CloseOnFlat = true;

        public int GetIntParam(string key, int defaultValue)
        {
            if (!Params.TryGetValue(key, out string raw) || string.IsNullOrWhiteSpace(raw))
            {
                return defaultValue;
            }

            return int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out int value)
                ? value
                : defaultValue;
        }

        public decimal GetDecimalParam(string key, decimal defaultValue)
        {
            if (!Params.TryGetValue(key, out string raw) || string.IsNullOrWhiteSpace(raw))
            {
                return defaultValue;
            }

            return decimal.TryParse(raw, NumberStyles.Number, CultureInfo.InvariantCulture, out decimal value)
                ? value
                : defaultValue;
        }

        /// <summary>Длина LinReg в Regime(…): L=@LR или параметр робота, если L не задан.</summary>
        public int GetLinRegLength()
        {
            Params.TryGetValue("L", out string raw);
            return LogicLineParser.ResolveLinRegLength(raw, LogicLineParser.DefaultLinRegLength);
        }

        /// <summary>Мёртвая зона наклона: абсолютное число или доля от центра (SuffixDead=0.05%).</summary>
        public decimal GetSlopeDeadZone(decimal centerReference)
        {
            if (!Params.TryGetValue("SlopeDead", out string raw) || string.IsNullOrWhiteSpace(raw))
            {
                return 0m;
            }

            raw = raw.Trim();
            if (raw.EndsWith("%", StringComparison.Ordinal))
            {
                string pctText = raw.Substring(0, raw.Length - 1).Trim();
                if (decimal.TryParse(pctText, NumberStyles.Number, CultureInfo.InvariantCulture, out decimal pct))
                {
                    return Math.Abs(centerReference) * pct / 100m;
                }

                return 0m;
            }

            return decimal.TryParse(raw, NumberStyles.Number, CultureInfo.InvariantCulture, out decimal abs)
                ? abs
                : 0m;
        }

        /// <summary>Атом для поиска LinReg на графике (без Op/Cl).</summary>
        public LogicAtom CreateIndicatorProbeAtom()
        {
            var atom = new LogicAtom { Kind = SourceKind };
            foreach (KeyValuePair<string, string> pair in Params)
            {
                if (string.Equals(pair.Key, "SlopeLb", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(pair.Key, "SlopeDead", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                atom.Params[pair.Key] = pair.Value;
            }

            LogicLineParser.ApplyDefaultParamsForAtom(atom);
            return atom;
        }
    }

    /// <summary>Знак наклона центра LinReg и проверки Entry/Close для Regime(…).</summary>
    public static class LogicRegimeEvaluator
    {
        /// <summary>+1 вверх, -1 вниз, 0 флэт/нет данных.</summary>
        public static int GetSign(LogicRegimeSpec spec, Aindicator indicator, int candleIndex)
        {
            if (spec == null || indicator?.DataSeries == null || indicator.DataSeries.Count < 2)
            {
                return 0;
            }

            int lookBack = Math.Max(1, spec.GetIntParam("SlopeLb", 3));
            int prevIndex = candleIndex - lookBack;
            if (prevIndex < 0)
            {
                return 0;
            }

            decimal centerNow = LogicSignalEvaluator.SeriesValueAtPublic(indicator, 1, candleIndex);
            decimal centerPrev = LogicSignalEvaluator.SeriesValueAtPublic(indicator, 1, prevIndex);
            if (centerNow == 0m || centerPrev == 0m)
            {
                return 0;
            }

            decimal delta = centerNow - centerPrev;
            decimal deadZone = spec.GetSlopeDeadZone(centerNow);
            if (delta > deadZone)
            {
                return 1;
            }

            if (delta < -deadZone)
            {
                return -1;
            }

            return 0;
        }

        public static int GetSignFromAtom(LogicAtom atom, Aindicator indicator, int candleIndex)
        {
            if (atom == null)
            {
                return 0;
            }

            var spec = new LogicRegimeSpec
            {
                SourceKind = atom.Kind,
                Params = new Dictionary<string, string>(atom.Params, StringComparer.OrdinalIgnoreCase)
            };
            return GetSign(spec, indicator, candleIndex);
        }

        public static bool AllowsEntry(LogicRegimeSpec spec, Side entrySide, int sign)
        {
            if (spec == null)
            {
                return true;
            }

            if (spec.EntryFlatOnly)
            {
                return sign == 0;
            }

            if (spec.BlockEntryBySide)
            {
                return AllowsEntryMatchSide(entrySide, sign);
            }

            return true;
        }

        public static bool AllowsEntryMatchSide(Side entrySide, int sign)
        {
            if (sign > 0)
            {
                return entrySide == Side.Buy;
            }

            if (sign < 0)
            {
                return entrySide == Side.Sell;
            }

            return false;
        }

        public static bool ShouldCloseForRegime(LogicRegimeSpec spec, Side entrySide, int sign)
        {
            if (spec == null)
            {
                return false;
            }

            if (spec.EntryFlatOnly)
            {
                return sign != 0;
            }

            if (!spec.CloseOnRegimeMismatch)
            {
                return spec.CloseOnFlat && sign == 0;
            }

            if (sign > 0)
            {
                return entrySide == Side.Sell;
            }

            if (sign < 0)
            {
                return entrySide == Side.Buy;
            }

            return spec.CloseOnFlat;
        }

        public static bool AllowsEntry(Side entrySide, int sign, bool blockEntryBySide)
        {
            if (!blockEntryBySide)
            {
                return true;
            }

            return AllowsEntryMatchSide(entrySide, sign);
        }

        public static bool ShouldCloseForRegimeMismatch(Side entrySide, int sign, bool closeOnRegimeMismatch)
        {
            if (!closeOnRegimeMismatch)
            {
                return false;
            }

            if (sign > 0)
            {
                return entrySide == Side.Sell;
            }

            if (sign < 0)
            {
                return entrySide == Side.Buy;
            }

            return true;
        }
    }

    /// <summary>Результат парсинга одной строки «Логика N».</summary>
    public sealed class LogicParseResult
    {
        /// <summary>true — разбор успешен (или пустая строка).</summary>
        public bool Success;
        /// <summary>Логика отключена префиксом Disabled(true) / Disable(true) в начале строки.</summary>
        public bool IsDisabled;
        /// <summary>Строгость отбора 1…5 (из Strict(…) или параметр робота).</summary>
        public int Strictness = LogicStrictnessAdjuster.Neutral;
        /// <summary>Префикс Regime(…) — наклон LinReg, закрытие и фильтр входа.</summary>
        public LogicRegimeSpec Regime;
        /// <summary>Список текстов ошибок при Success=false.</summary>
        public List<string> Errors = new List<string>();
        /// <summary>Корень дерева AND/OR; null для пустой строки.</summary>
        public LogicExpressionNode Root;
        /// <summary>Уникальные атомы для создания индикаторов (пусто при Disabled).</summary>
        public List<LogicAtom> Atoms = new List<LogicAtom>();

        /// <summary>Фабрика результата с ошибкой.</summary>
        /// <param name="error">Текст ошибки.</param>
        /// <returns>LogicParseResult с Success=false.</returns>
        public static LogicParseResult Fail(string error)
        {
            return new LogicParseResult
            {
                Success = false,
                Errors = new List<string> { error }
            };
        }
    }

    /// <summary>
    /// Масштаб порогов индикаторов по Strict 1…5 (3 — без изменений). Меняет Lmin/Smax/Gr/SlopeDead/Dev и числа в Op/Cl.
    /// </summary>
    public static class LogicStrictnessAdjuster
    {
        public const int Min = 1;
        public const int Max = 5;
        public const int Neutral = 3;

        private enum ThresholdKind
        {
            LongMin,
            ShortMaxSigned,
            ShortMaxPositive,
            AtrGrowthPercent,
            SlopeDeadPercent,
            LinRegDeviation
        }

        public static int Clamp(int value)
        {
            if (value < Min)
            {
                return Min;
            }

            if (value > Max)
            {
                return Max;
            }

            return value;
        }

        private static int Offset(int strict)
        {
            return Clamp(strict) - Neutral;
        }

        private static decimal ScaleFromNeutral(decimal neutral, ThresholdKind kind, int strict)
        {
            int off = Offset(strict);
            if (off == 0 || neutral == 0m)
            {
                return neutral;
            }

            decimal factor = 1m;
            switch (kind)
            {
                case ThresholdKind.LongMin:
                    factor = 1m + off * 0.10m;
                    return ClampScaled(neutral, neutral * factor, 0.76m, 1.24m);
                case ThresholdKind.ShortMaxSigned:
                    factor = 1m + off * 0.10m;
                    return ClampScaled(neutral, neutral * factor, 0.76m, 1.24m);
                case ThresholdKind.ShortMaxPositive:
                    factor = 1m - off * 0.10m;
                    return ClampScaled(neutral, neutral * factor, 0.76m, 1.24m);
                case ThresholdKind.AtrGrowthPercent:
                    factor = 1m + off * 0.12m;
                    return ClampScaled(neutral, neutral * factor, 0.65m, 1.35m);
                case ThresholdKind.SlopeDeadPercent:
                    factor = 1m - off * 0.10m;
                    return ClampScaled(neutral, neutral * factor, 0.70m, 1.30m);
                case ThresholdKind.LinRegDeviation:
                    factor = 1m - off * 0.08m;
                    return ClampScaled(neutral, neutral * factor, 0.88m, 1.12m);
                default:
                    return neutral;
            }
        }

        private static decimal ClampScaled(decimal neutral, decimal scaled, decimal minRatio, decimal maxRatio)
        {
            decimal lo = neutral * minRatio;
            decimal hi = neutral * maxRatio;
            if (scaled < lo)
            {
                return lo;
            }

            if (scaled > hi)
            {
                return hi;
            }

            return scaled;
        }

        private static decimal ToNeutral(decimal value, ThresholdKind kind, int strict)
        {
            int off = Offset(strict);
            if (off == 0 || value == 0m)
            {
                return value;
            }

            switch (kind)
            {
                case ThresholdKind.LongMin:
                    return value / (1m + off * 0.10m);
                case ThresholdKind.ShortMaxSigned:
                    return value / (1m + off * 0.10m);
                case ThresholdKind.ShortMaxPositive:
                    return value / (1m - off * 0.10m);
                case ThresholdKind.AtrGrowthPercent:
                    return value / (1m + off * 0.12m);
                case ThresholdKind.SlopeDeadPercent:
                    return value / (1m - off * 0.10m);
                case ThresholdKind.LinRegDeviation:
                    return value / (1m - off * 0.08m);
                default:
                    return value;
            }
        }

        private static decimal TransitionThreshold(decimal value, ThresholdKind kind, int fromStrict, int toStrict)
        {
            if (fromStrict == toStrict)
            {
                return value;
            }

            decimal neutral = ToNeutral(value, kind, fromStrict);
            return ScaleFromNeutral(neutral, kind, toStrict);
        }

        private static ThresholdKind ClassifyShortMax(decimal value)
        {
            return value < 0m ? ThresholdKind.ShortMaxSigned : ThresholdKind.ShortMaxPositive;
        }

        private static string FormatThreshold(decimal value)
        {
            decimal rounded = decimal.Round(value, 4, MidpointRounding.AwayFromZero);
            if (rounded == decimal.Truncate(rounded))
            {
                return ((long)rounded).ToString(CultureInfo.InvariantCulture);
            }

            return rounded.ToString("0.####", CultureInfo.InvariantCulture);
        }

        /// <summary>Масштабирует пороги атомов и Regime при разборе строки (нейтральные значения в тексте, strict≠3).</summary>
        public static void ApplyToParsedLogic(List<LogicAtom> atoms, LogicRegimeSpec regime, int strict)
        {
            strict = Clamp(strict);
            if (strict == Neutral)
            {
                return;
            }

            if (atoms != null)
            {
                for (int i = 0; i < atoms.Count; i++)
                {
                    ApplyToAtom(atoms[i], strict);
                }
            }

            if (regime != null)
            {
                ApplyToRegime(regime, strict);
            }
        }

        private static void ApplyToAtom(LogicAtom atom, int strict)
        {
            if (atom == null)
            {
                return;
            }

            ScaleDecimalParam(atom.Params, "Lmin", ThresholdKind.LongMin, strict);
            ScaleDecimalParam(atom.Params, "Smax", null, strict, resolveShortMaxKind: true);
            ScaleDecimalParam(atom.Params, "Gr", ThresholdKind.AtrGrowthPercent, strict, percentSuffix: true);
            ScaleDecimalParam(atom.Params, "Dev", ThresholdKind.LinRegDeviation, strict);
            atom.OpenSignal = ScaleSignalThresholds(atom.OpenSignal, strict);
            atom.CloseSignal = ScaleSignalThresholds(atom.CloseSignal, strict);
        }

        private static void ApplyToRegime(LogicRegimeSpec regime, int strict)
        {
            ScaleDecimalParam(regime.Params, "Dev", ThresholdKind.LinRegDeviation, strict);
            ScaleDecimalParam(regime.Params, "SlopeDead", ThresholdKind.SlopeDeadPercent, strict, percentSuffix: true);
        }

        private static void ScaleDecimalParam(
            Dictionary<string, string> dict,
            string key,
            ThresholdKind? kind,
            int strict,
            bool percentSuffix = false,
            bool resolveShortMaxKind = false)
        {
            if (dict == null
                || !dict.TryGetValue(key, out string raw)
                || string.IsNullOrWhiteSpace(raw))
            {
                return;
            }

            raw = raw.Trim();
            string suffix = "";
            if (percentSuffix && raw.EndsWith("%", StringComparison.Ordinal))
            {
                suffix = "%";
                raw = raw.Substring(0, raw.Length - 1).Trim();
            }

            if (!decimal.TryParse(raw, NumberStyles.Number, CultureInfo.InvariantCulture, out decimal value))
            {
                return;
            }

            ThresholdKind resolvedKind = kind
                ?? (resolveShortMaxKind ? ClassifyShortMax(value) : ThresholdKind.LongMin);
            dict[key] = FormatThreshold(ScaleFromNeutral(value, resolvedKind, strict)) + suffix;
        }

        public static string ScaleSignalThresholds(string signal, int strict)
        {
            if (string.IsNullOrWhiteSpace(signal) || Clamp(strict) == Neutral)
            {
                return signal;
            }

            string line = signal;
            line = Regex.Replace(
                line,
                @"(?i)(CCI>=)(-?\d+(?:\.\d+)?)",
                m => TransformMatch(m.Groups[1].Value, m.Groups[2].Value, ThresholdKind.LongMin, Neutral, strict));
            line = Regex.Replace(
                line,
                @"(?i)(CCI<=)(-?\d+(?:\.\d+)?)",
                m =>
                {
                    decimal.TryParse(m.Groups[2].Value, NumberStyles.Number, CultureInfo.InvariantCulture, out decimal v);
                    ThresholdKind k = v <= 0m ? ThresholdKind.ShortMaxSigned : ThresholdKind.ShortMaxPositive;
                    return TransformMatch(m.Groups[1].Value, m.Groups[2].Value, k, Neutral, strict);
                });
            line = Regex.Replace(
                line,
                @"(?i)(CCI<)(-?\d+(?:\.\d+)?)",
                m =>
                {
                    decimal.TryParse(m.Groups[2].Value, NumberStyles.Number, CultureInfo.InvariantCulture, out decimal v);
                    ThresholdKind k = v <= 0m ? ThresholdKind.ShortMaxSigned : ThresholdKind.ShortMaxPositive;
                    return TransformMatch(m.Groups[1].Value, m.Groups[2].Value, k, Neutral, strict);
                });
            line = Regex.Replace(
                line,
                @"(?i)(K>=)(-?\d+(?:\.\d+)?)",
                m => TransformMatch(m.Groups[1].Value, m.Groups[2].Value, ThresholdKind.LongMin, Neutral, strict));
            line = Regex.Replace(
                line,
                @"(?i)(K<=)(-?\d+(?:\.\d+)?)",
                m => TransformMatch(m.Groups[1].Value, m.Groups[2].Value, ThresholdKind.ShortMaxPositive, Neutral, strict));
            line = Regex.Replace(
                line,
                @"(?i)(RSI>=)(-?\d+(?:\.\d+)?)",
                m => TransformMatch(m.Groups[1].Value, m.Groups[2].Value, ThresholdKind.LongMin, Neutral, strict));
            line = Regex.Replace(
                line,
                @"(?i)(RSI<=)(-?\d+(?:\.\d+)?)",
                m => TransformMatch(m.Groups[1].Value, m.Groups[2].Value, ThresholdKind.ShortMaxPositive, Neutral, strict));
            line = Regex.Replace(
                line,
                @"(?i)(MOM>=)(-?\d+(?:\.\d+)?)",
                m => TransformMatch(m.Groups[1].Value, m.Groups[2].Value, ThresholdKind.LongMin, Neutral, strict));
            line = Regex.Replace(
                line,
                @"(?i)(MOM<=)(-?\d+(?:\.\d+)?)",
                m => TransformMatch(m.Groups[1].Value, m.Groups[2].Value, ThresholdKind.ShortMaxPositive, Neutral, strict));
            line = Regex.Replace(
                line,
                @"(?i)(MOM<)(-?\d+(?:\.\d+)?)",
                m => TransformMatch(m.Groups[1].Value, m.Groups[2].Value, ThresholdKind.ShortMaxPositive, Neutral, strict));
            return line;
        }

        public static string TransformLogicLine(string line, int fromStrict, int toStrict)
        {
            if (string.IsNullOrWhiteSpace(line) || fromStrict == toStrict)
            {
                return line;
            }

            fromStrict = Clamp(fromStrict);
            toStrict = Clamp(toStrict);
            int savedStrict = LogicLineParser.DefaultStrictness;
            try
            {
                LogicLineParser.DefaultStrictness = fromStrict;
                line = Regex.Replace(
                    line,
                    @"(?i)(Lmin=)(-?\d+(?:\.\d+)?)",
                    m => TransformMatch(m.Groups[1].Value, m.Groups[2].Value, ThresholdKind.LongMin, fromStrict, toStrict));
                line = Regex.Replace(
                    line,
                    @"(?i)(Smax=)(-?\d+(?:\.\d+)?)",
                    m =>
                    {
                        decimal.TryParse(m.Groups[2].Value, NumberStyles.Number, CultureInfo.InvariantCulture, out decimal v);
                        ThresholdKind kind = ClassifyShortMax(v);
                        return TransformMatch(m.Groups[1].Value, m.Groups[2].Value, kind, fromStrict, toStrict);
                    });
                line = Regex.Replace(
                    line,
                    @"(?i)(Gr=)(-?\d+(?:\.\d+)?)(%?)",
                    m => TransformMatch(m.Groups[1].Value, m.Groups[2].Value, ThresholdKind.AtrGrowthPercent, fromStrict, toStrict)
                        + m.Groups[3].Value);
                line = Regex.Replace(
                    line,
                    @"(?i)(SlopeDead=)(-?\d+(?:\.\d+)?)(%?)",
                    m => TransformMatch(m.Groups[1].Value, m.Groups[2].Value, ThresholdKind.SlopeDeadPercent, fromStrict, toStrict)
                        + m.Groups[3].Value);
                line = Regex.Replace(
                    line,
                    @"(?i)(Dev=)(-?\d+(?:\.\d+)?)",
                    m => TransformMatch(m.Groups[1].Value, m.Groups[2].Value, ThresholdKind.LinRegDeviation, fromStrict, toStrict));

                line = Regex.Replace(
                    line,
                    @"(?i)(CCI>=)(-?\d+(?:\.\d+)?)",
                    m => TransformMatch(m.Groups[1].Value, m.Groups[2].Value, ThresholdKind.LongMin, fromStrict, toStrict));
                line = Regex.Replace(
                    line,
                    @"(?i)(CCI<=)(-?\d+(?:\.\d+)?)",
                    m =>
                    {
                        decimal.TryParse(m.Groups[2].Value, NumberStyles.Number, CultureInfo.InvariantCulture, out decimal v);
                        ThresholdKind kind = v <= 0m ? ThresholdKind.ShortMaxSigned : ThresholdKind.ShortMaxPositive;
                        return TransformMatch(m.Groups[1].Value, m.Groups[2].Value, kind, fromStrict, toStrict);
                    });
                line = Regex.Replace(
                    line,
                    @"(?i)(CCI<)(-?\d+(?:\.\d+)?)",
                    m =>
                    {
                        decimal.TryParse(m.Groups[2].Value, NumberStyles.Number, CultureInfo.InvariantCulture, out decimal v);
                        ThresholdKind kind = v <= 0m ? ThresholdKind.ShortMaxSigned : ThresholdKind.ShortMaxPositive;
                        return TransformMatch(m.Groups[1].Value, m.Groups[2].Value, kind, fromStrict, toStrict);
                    });
                line = Regex.Replace(
                    line,
                    @"(?i)(K>=)(-?\d+(?:\.\d+)?)",
                    m => TransformMatch(m.Groups[1].Value, m.Groups[2].Value, ThresholdKind.LongMin, fromStrict, toStrict));
                line = Regex.Replace(
                    line,
                    @"(?i)(K<=)(-?\d+(?:\.\d+)?)",
                    m => TransformMatch(m.Groups[1].Value, m.Groups[2].Value, ThresholdKind.ShortMaxPositive, fromStrict, toStrict));
                line = Regex.Replace(
                    line,
                    @"(?i)(RSI>=)(-?\d+(?:\.\d+)?)",
                    m => TransformMatch(m.Groups[1].Value, m.Groups[2].Value, ThresholdKind.LongMin, fromStrict, toStrict));
                line = Regex.Replace(
                    line,
                    @"(?i)(RSI<=)(-?\d+(?:\.\d+)?)",
                    m => TransformMatch(m.Groups[1].Value, m.Groups[2].Value, ThresholdKind.ShortMaxPositive, fromStrict, toStrict));
                line = Regex.Replace(
                    line,
                    @"(?i)(MOM>=)(-?\d+(?:\.\d+)?)",
                    m => TransformMatch(m.Groups[1].Value, m.Groups[2].Value, ThresholdKind.LongMin, fromStrict, toStrict));
                line = Regex.Replace(
                    line,
                    @"(?i)(MOM<=)(-?\d+(?:\.\d+)?)",
                    m => TransformMatch(m.Groups[1].Value, m.Groups[2].Value, ThresholdKind.ShortMaxPositive, fromStrict, toStrict));
                line = Regex.Replace(
                    line,
                    @"(?i)(MOM<)(-?\d+(?:\.\d+)?)",
                    m => TransformMatch(m.Groups[1].Value, m.Groups[2].Value, ThresholdKind.ShortMaxPositive, fromStrict, toStrict));
                return line;
            }
            finally
            {
                LogicLineParser.DefaultStrictness = savedStrict;
            }
        }

        private static string TransformMatch(
            string prefix,
            string numberText,
            ThresholdKind kind,
            int fromStrict,
            int toStrict)
        {
            if (!decimal.TryParse(numberText, NumberStyles.Number, CultureInfo.InvariantCulture, out decimal value))
            {
                return prefix + numberText;
            }

            return prefix + FormatThreshold(TransitionThreshold(value, kind, fromStrict, toStrict));
        }
    }

    /// <summary>
    /// Парсер строк логики MultiLogic: Disabled, NOT, AND/OR, атомы индикаторов, Op/Cl, SL/TP, Note.
    /// </summary>
    public sealed class LogicLineParser
    {
        /// <summary>Максимум атомов на один слот (исторический запас; общий пул 101…1099).</summary>
        public const int IndicatorsPerSlot = 99;
        /// <summary>База нумерации индикаторов (100 → первый номер 101).</summary>
        public const int SlotIndicatorNumBase = 100;
        /// <summary>Число слотов логики для расчёта верхней границы номеров.</summary>
        public const int LogicSlotsForIndicators = 10;
        /// <summary>Первый номер управляемого индикатора робота.</summary>
        public const int MinLogicIndicatorNum = SlotIndicatorNumBase + 1;
        /// <summary>Последний номер в общем пуле индикаторов (1099).</summary>
        public const int MaxManagedLogicIndicatorNum = SlotIndicatorNumBase * LogicSlotsForIndicators + IndicatorsPerSlot;

        /// <summary>Имена индикаторов для regex (поиск формулы, IsLogicFormulaContent, подсветка HTML).</summary>
        internal const string IndicatorNamesRegexFragment =
            "SMA|Stoch|Stochastic|ATR|LinReg|LR|LinearRegression|MACD|Macd|CCI|RSI|Rsi|Momentum|Mom|Boll|Bollinger|VWAP";

        /// <summary>Длина LinReg из параметра робота «Длина линейной регрессии» (в строке логики: L=@LR или LinReg(@LR;…)).</summary>
        public const string LinRegLengthParamToken = "@LR";

        public const int DefaultLinRegLengthFallback = 50;

        public const int MinLinRegLength = 5;

        /// <summary>Текущее значение параметра «Длина линейной регрессии» перед Parse (устанавливает MultiLogic).</summary>
        public static int DefaultLinRegLength { get; set; } = DefaultLinRegLengthFallback;

        /// <summary>Строгость из параметра робота «Strict (строгость)» (в строке: Strict(@Strict) или без префикса).</summary>
        public const string StrictnessParamToken = "@Strict";

        /// <summary>Strict (строгость) 1…5; 3 — пороги в строке без масштабирования.</summary>
        public static int DefaultStrictness { get; set; } = LogicStrictnessAdjuster.Neutral;

        /// <summary>true — токен ссылается на параметр Strict робота.</summary>
        public static bool IsStrictnessParamReference(string raw)
        {
            return !string.IsNullOrWhiteSpace(raw)
                && raw.Trim().Equals(StrictnessParamToken, StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>Строгость 1…5: @Strict → параметр робота, иначе явное число.</summary>
        public static int ResolveStrictness(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw))
            {
                return LogicStrictnessAdjuster.Clamp(DefaultStrictness);
            }

            raw = raw.Trim();
            if (IsStrictnessParamReference(raw))
            {
                return LogicStrictnessAdjuster.Clamp(DefaultStrictness);
            }

            if (int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out int iv))
            {
                return LogicStrictnessAdjuster.Clamp(iv);
            }

            if (decimal.TryParse(raw, NumberStyles.Number, CultureInfo.InvariantCulture, out decimal dec))
            {
                return LogicStrictnessAdjuster.Clamp((int)dec);
            }

            throw new InvalidOperationException(
                "Strict(…): ожидается "
                + StrictnessParamToken
                + " или число "
                + LogicStrictnessAdjuster.Min
                + "…"
                + LogicStrictnessAdjuster.Max
                + ", получено: "
                + raw);
        }

        /// <summary>true — токен ссылается на параметр робота, а не на явное число.</summary>
        public static bool IsLinRegLengthParamReference(string raw)
        {
            return !string.IsNullOrWhiteSpace(raw)
                && raw.Trim().Equals(LinRegLengthParamToken, StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>Число свечей LinReg: явное L в формуле или параметр робота для @LR / пустого L.</summary>
        public static int ResolveLinRegLength(string raw, int fallbackWhenMissing)
        {
            if (string.IsNullOrWhiteSpace(raw))
            {
                return Math.Max(MinLinRegLength, DefaultLinRegLength);
            }

            raw = raw.Trim();
            if (IsLinRegLengthParamReference(raw))
            {
                return Math.Max(MinLinRegLength, DefaultLinRegLength);
            }

            if (int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out int iv))
            {
                return Math.Max(2, iv);
            }

            if (decimal.TryParse(raw, NumberStyles.Number, CultureInfo.InvariantCulture, out decimal dec))
            {
                return Math.Max(2, (int)dec);
            }

            return Math.Max(MinLinRegLength, fallbackWhenMissing);
        }

        /// <summary>
        /// Разбирает сырую строку логики: префикс Disabled, дерево AND/OR, список атомов.
        /// </summary>
        /// <param name="raw">Текст из параметра «Логика N».</param>
        /// <returns>LogicParseResult с деревом, атомами или ошибками.</returns>
        public LogicParseResult Parse(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw))
            {
                return new LogicParseResult
                {
                    Success = true,
                    IsDisabled = false,
                    Root = null,
                    Atoms = new List<LogicAtom>()
                };
            }

            try
            {
                string work = raw.Trim();
                bool isDisabled = false;
                if (TryExtractLeadingDisabled(ref work, out bool disabledFlag))
                {
                    isDisabled = disabledFlag;
                }

                int lineStrict = DefaultStrictness;
                if (TryExtractLeadingStrict(ref work, out int parsedStrict))
                {
                    lineStrict = parsedStrict;
                }

                LogicRegimeSpec regime = null;
                if (TryExtractLeadingRegime(ref work, out LogicRegimeSpec parsedRegime))
                {
                    regime = parsedRegime;
                }

                if (ContainsInnerDisableMarker(work))
                {
                    return LogicParseResult.Fail(
                        "Disabled(…) / Disable(…) допустимы только в самом начале строки, до AND/OR, без скобок вокруг.");
                }

                if (ContainsInnerStrictMarker(work))
                {
                    return LogicParseResult.Fail(
                        "Strict(…) допустим только в самом начале строки (после Disabled), до AND/OR, без скобок вокруг.");
                }

                if (ContainsInnerRegimeMarker(work))
                {
                    return LogicParseResult.Fail(
                        "Regime(…) допустим только в самом начале строки (после Disabled и Strict), до AND/OR, без скобок вокруг.");
                }

                if (string.IsNullOrWhiteSpace(work))
                {
                    return new LogicParseResult
                    {
                        Success = true,
                        IsDisabled = isDisabled,
                        Strictness = lineStrict,
                        Regime = regime,
                        Root = null,
                        Atoms = new List<LogicAtom>()
                    };
                }

                LogicExpressionNode root = ParseExpression(work);
                if (root == null)
                {
                    return LogicParseResult.Fail("Пустое выражение после разбора.");
                }

                var atoms = isDisabled ? new List<LogicAtom>() : CollectAtoms(root);
                if (!isDisabled && regime != null)
                {
                    if (regime.AutoResolve)
                    {
                        TryResolveRegimeFromExpressionAtoms(atoms, regime);
                    }

                    ValidateRegimeSpec(regime);
                    EnsureRegimeIndicatorInAtoms(atoms, regime);
                }

                if (!isDisabled)
                {
                    LogicStrictnessAdjuster.ApplyToParsedLogic(atoms, regime, lineStrict);
                }

                return new LogicParseResult
                {
                    Success = true,
                    IsDisabled = isDisabled,
                    Strictness = lineStrict,
                    Regime = regime,
                    Root = root,
                    Atoms = atoms
                };
            }
            catch (Exception ex)
            {
                return LogicParseResult.Fail(ex.Message);
            }
        }

        /// <summary>Regex для поиска Disabled/Disable внутри выражения (ошибка размещения).</summary>
        private static readonly Regex InnerDisableMarkerRegex = new Regex(
            @"\b(Disabled|Disable)\s*\(",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        /// <summary>
        /// Извлекает префикс Disabled(true/false) или Disable(true/false) из начала строки.
        /// </summary>
        /// <param name="input">Строка логики; после вызова — остаток без префикса.</param>
        /// <param name="isDisabled">true, если в скобках было true.</param>
        /// <returns>true, если префикс найден и разобран.</returns>
        private static bool TryExtractLeadingDisabled(ref string input, out bool isDisabled)
        {
            isDisabled = false;
            input = input?.Trim() ?? "";
            if (input.Length == 0)
            {
                return false;
            }

            int nameLen = 0;
            if (StartsWithIgnoreCaseAt(input, 0, "Disabled", out nameLen))
            {
                // ok
            }
            else if (StartsWithIgnoreCaseAt(input, 0, "Disable", out nameLen))
            {
                if (nameLen < input.Length && char.ToLowerInvariant(input[nameLen]) == 'd')
                {
                    return false;
                }
            }
            else
            {
                return false;
            }

            int pos = nameLen;
            while (pos < input.Length && char.IsWhiteSpace(input[pos]))
            {
                pos++;
            }

            if (pos >= input.Length || input[pos] != '(')
            {
                return false;
            }

            if (!TryReadBalancedParenthesesContent(input, pos, out string content))
            {
                throw new InvalidOperationException("Не закрыты скобки в Disabled(…) / Disable(…).");
            }

            string value = content.Trim();
            if (value.Equals("true", StringComparison.OrdinalIgnoreCase))
            {
                isDisabled = true;
            }
            else if (value.Equals("false", StringComparison.OrdinalIgnoreCase))
            {
                isDisabled = false;
            }
            else
            {
                throw new InvalidOperationException(
                    "Disabled(…) / Disable(…): допустимы только true или false, получено: " + value);
            }

            input = input.Substring(pos + content.Length + 2).Trim();
            return true;
        }

        /// <summary>Regex для поиска Regime(…) внутри выражения (ошибка размещения).</summary>
        private static readonly Regex InnerRegimeMarkerRegex = new Regex(
            @"\bRegime\s*\(",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        private static readonly Regex InnerStrictMarkerRegex = new Regex(
            @"\bStrict\s*\(",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        /// <summary>Извлекает префикс Strict(@Strict) или Strict(1…5) из начала строки (после Disabled).</summary>
        private static bool TryExtractLeadingStrict(ref string input, out int strictness)
        {
            strictness = DefaultStrictness;
            input = input?.Trim() ?? "";
            if (input.Length == 0)
            {
                return false;
            }

            if (!StartsWithIgnoreCaseAt(input, 0, "Strict", out int nameLen))
            {
                return false;
            }

            int pos = nameLen;
            while (pos < input.Length && char.IsWhiteSpace(input[pos]))
            {
                pos++;
            }

            if (pos >= input.Length || input[pos] != '(')
            {
                return false;
            }

            if (!TryReadBalancedParenthesesContent(input, pos, out string content))
            {
                throw new InvalidOperationException("Не закрыты скобки в Strict(…).");
            }

            strictness = ResolveStrictness(content);
            input = input.Substring(pos + content.Length + 2).Trim();
            return true;
        }

        /// <summary>
        /// Извлекает префикс Regime(…) из начала строки (после Disabled).
        /// </summary>
        private static bool TryExtractLeadingRegime(ref string input, out LogicRegimeSpec spec)
        {
            spec = null;
            input = input?.Trim() ?? "";
            if (input.Length == 0)
            {
                return false;
            }

            if (!StartsWithIgnoreCaseAt(input, 0, "Regime", out int nameLen))
            {
                return false;
            }

            int pos = nameLen;
            while (pos < input.Length && char.IsWhiteSpace(input[pos]))
            {
                pos++;
            }

            if (pos >= input.Length || input[pos] != '(')
            {
                return false;
            }

            if (!TryReadBalancedParenthesesContent(input, pos, out string content))
            {
                throw new InvalidOperationException("Не закрыты скобки в Regime(…).");
            }

            spec = ParseRegimeContent(content);
            input = input.Substring(pos + content.Length + 2).Trim();
            return true;
        }

        private static LogicRegimeSpec ParseRegimeContent(string content)
        {
            var spec = new LogicRegimeSpec();
            if (string.IsNullOrWhiteSpace(content))
            {
                throw new InvalidOperationException("Regime(…): пустое содержимое.");
            }

            string[] parts = content.Split(';');
            bool sourceSet = false;
            for (int i = 0; i < parts.Length; i++)
            {
                string part = parts[i].Trim();
                if (part.Length == 0)
                {
                    continue;
                }

                int eq = part.IndexOf('=');
                if (eq < 0)
                {
                    if (sourceSet)
                    {
                        throw new InvalidOperationException("Regime(…): неизвестный фрагмент «" + part + "».");
                    }

                    if (part.Equals("Auto", StringComparison.OrdinalIgnoreCase))
                    {
                        spec.AutoResolve = true;
                        sourceSet = true;
                        continue;
                    }

                    if (part.Equals("LinReg", StringComparison.OrdinalIgnoreCase)
                        || part.Equals("LR", StringComparison.OrdinalIgnoreCase)
                        || part.Equals("LinearRegression", StringComparison.OrdinalIgnoreCase))
                    {
                        spec.SourceKind = LogicIndicatorKind.LinReg;
                        sourceSet = true;
                        continue;
                    }

                    throw new InvalidOperationException("Regime(…): источник должен быть LinReg или Auto, получено: " + part);
                }

                string key = NormalizeParamKey(part.Substring(0, eq).Trim());
                string value = part.Substring(eq + 1).Trim();
                if (string.Equals(key, "OnFlip", StringComparison.OrdinalIgnoreCase))
                {
                    spec.CloseOnRegimeMismatch = value.Equals("Close", StringComparison.OrdinalIgnoreCase)
                        || value.Equals("CloseOnFlip", StringComparison.OrdinalIgnoreCase)
                        || value.Equals("true", StringComparison.OrdinalIgnoreCase);
                    continue;
                }

                if (string.Equals(key, "Entry", StringComparison.OrdinalIgnoreCase))
                {
                    if (value.Equals("FlatOnly", StringComparison.OrdinalIgnoreCase)
                        || value.Equals("Chop", StringComparison.OrdinalIgnoreCase)
                        || value.Equals("Flat", StringComparison.OrdinalIgnoreCase)
                        || value.Equals("Bokovik", StringComparison.OrdinalIgnoreCase))
                    {
                        spec.EntryFlatOnly = true;
                        spec.BlockEntryBySide = false;
                    }
                    else if (value.Equals("MatchSide", StringComparison.OrdinalIgnoreCase)
                        || value.Equals("Side", StringComparison.OrdinalIgnoreCase)
                        || value.Equals("Trend", StringComparison.OrdinalIgnoreCase)
                        || value.Equals("true", StringComparison.OrdinalIgnoreCase))
                    {
                        spec.EntryFlatOnly = false;
                        spec.BlockEntryBySide = true;
                    }
                    else if (value.Equals("Off", StringComparison.OrdinalIgnoreCase)
                        || value.Equals("false", StringComparison.OrdinalIgnoreCase))
                    {
                        spec.EntryFlatOnly = false;
                        spec.BlockEntryBySide = false;
                    }

                    continue;
                }

                if (string.Equals(key, "OnFlat", StringComparison.OrdinalIgnoreCase))
                {
                    spec.CloseOnFlat = value.Equals("Close", StringComparison.OrdinalIgnoreCase)
                        || value.Equals("true", StringComparison.OrdinalIgnoreCase);
                    if (value.Equals("Keep", StringComparison.OrdinalIgnoreCase)
                        || value.Equals("false", StringComparison.OrdinalIgnoreCase))
                    {
                        spec.CloseOnFlat = false;
                    }

                    continue;
                }

                if (string.Equals(key, "Source", StringComparison.OrdinalIgnoreCase))
                {
                    if (value.Equals("LinReg", StringComparison.OrdinalIgnoreCase)
                        || value.Equals("LR", StringComparison.OrdinalIgnoreCase))
                    {
                        spec.SourceKind = LogicIndicatorKind.LinReg;
                        sourceSet = true;
                    }
                    else if (value.Equals("Auto", StringComparison.OrdinalIgnoreCase))
                    {
                        spec.AutoResolve = true;
                        sourceSet = true;
                    }
                    else
                    {
                        throw new InvalidOperationException("Regime(…): неизвестный Source=" + value);
                    }

                    continue;
                }

                spec.Params[key] = value;
                if (string.Equals(key, "L", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(key, "Dev", StringComparison.OrdinalIgnoreCase))
                {
                    sourceSet = true;
                }
            }

            if (!sourceSet && !spec.AutoResolve)
            {
                throw new InvalidOperationException(
                    "Regime(…): укажите LinReg, Auto или параметры L=…;Dev=….");
            }

            return spec;
        }

        private static void ValidateRegimeSpec(LogicRegimeSpec spec)
        {
            if (spec == null)
            {
                return;
            }

            if (spec.SourceKind != LogicIndicatorKind.LinReg)
            {
                throw new InvalidOperationException("Regime(…): поддерживается только LinReg.");
            }

            if (!spec.CloseOnRegimeMismatch && !spec.BlockEntryBySide && !spec.EntryFlatOnly)
            {
                throw new InvalidOperationException(
                    "Regime(…): укажите OnFlip=Close, Entry=MatchSide и/или Entry=FlatOnly.");
            }
        }

        private static void TryResolveRegimeFromExpressionAtoms(List<LogicAtom> atoms, LogicRegimeSpec spec)
        {
            if (spec == null || atoms == null)
            {
                return;
            }

            for (int i = 0; i < atoms.Count; i++)
            {
                LogicAtom atom = atoms[i];
                if (atom == null || atom.Kind != LogicIndicatorKind.LinReg)
                {
                    continue;
                }

                string open = atom.OpenSignal?.Replace(" ", "").ToUpperInvariant() ?? "";
                if (!open.Contains("SLOPEUP") && !open.Contains("SLOPEDN") && !open.Contains("SLOPEMATCH"))
                {
                    continue;
                }

                spec.SourceKind = LogicIndicatorKind.LinReg;
                CopyRegimeChartParamsFromAtom(atom, spec);
                return;
            }

            for (int i = 0; i < atoms.Count; i++)
            {
                LogicAtom atom = atoms[i];
                if (atom == null || atom.Kind != LogicIndicatorKind.LinReg)
                {
                    continue;
                }

                spec.SourceKind = LogicIndicatorKind.LinReg;
                CopyRegimeChartParamsFromAtom(atom, spec);
                return;
            }

            throw new InvalidOperationException(
                "Regime(Auto…): в строке не найден LinReg для параметров режима.");
        }

        private static void CopyRegimeChartParamsFromAtom(LogicAtom atom, LogicRegimeSpec spec)
        {
            if (atom == null || spec == null)
            {
                return;
            }

            CopyIfPresent(atom, spec, "L");
            CopyIfPresent(atom, spec, "Dev");
            CopyIfPresent(atom, spec, "SlopeLb");
            CopyIfPresent(atom, spec, "SlopeDead");
        }

        private static void CopyIfPresent(LogicAtom atom, LogicRegimeSpec spec, string key)
        {
            if (atom.Params.TryGetValue(key, out string value) && !string.IsNullOrWhiteSpace(value))
            {
                spec.Params[key] = value;
            }
        }

        private static void EnsureRegimeIndicatorInAtoms(List<LogicAtom> atoms, LogicRegimeSpec spec)
        {
            if (atoms == null || spec == null)
            {
                return;
            }

            LogicAtom probe = spec.CreateIndicatorProbeAtom();
            string signature = BuildIndicatorSignature(probe);
            for (int i = 0; i < atoms.Count; i++)
            {
                if (BuildIndicatorSignature(atoms[i]).Equals(signature, StringComparison.OrdinalIgnoreCase))
                {
                    return;
                }
            }

            atoms.Add(probe);
        }

        /// <summary>Проверяет, есть ли Regime(…) не в начале строки (недопустимо).</summary>
        private static bool ContainsInnerRegimeMarker(string text)
        {
            return !string.IsNullOrWhiteSpace(text) && InnerRegimeMarkerRegex.IsMatch(text);
        }

        private static bool ContainsInnerStrictMarker(string text)
        {
            return !string.IsNullOrWhiteSpace(text) && InnerStrictMarkerRegex.IsMatch(text);
        }

        /// <summary>Проверяет, есть ли Disabled(…) не в начале строки (недопустимо).</summary>
        private static bool ContainsInnerDisableMarker(string text)
        {
            return !string.IsNullOrWhiteSpace(text) && InnerDisableMarkerRegex.IsMatch(text);
        }

        /// <summary>Проверяет, начинается ли подстрока с prefix (без учёта регистра).</summary>
        private static bool StartsWithIgnoreCaseAt(string text, int index, string prefix, out int prefixLength)
        {
            prefixLength = prefix.Length;
            if (index < 0 || index + prefixLength > text.Length)
            {
                prefixLength = 0;
                return false;
            }

            return string.Compare(text, index, prefix, 0, prefixLength, StringComparison.OrdinalIgnoreCase) == 0;
        }

        /// <summary>
        /// Номер индикатора по схеме слота (legacy): 100*slot + index; для графика используется общий пул.
        /// </summary>
        public static int GetIndicatorNumForAtom(int logicSlotIndex, int atomIndexInSlot)
        {
            return SlotIndicatorNumBase * logicSlotIndex + atomIndexInSlot;
        }

        /// <summary>
        /// Уникальная сигнатура индикатора для дедупликации: type|area|param1|param2…
        /// </summary>
        public static string BuildIndicatorSignature(string type, string area, IList<string> parameters)
        {
            var paramList = parameters ?? Array.Empty<string>();
            return type + "|" + area + "|" + string.Join("\u001f", paramList);
        }

        /// <summary>Сигнатура индикатора по атому логики.</summary>
        public static string BuildIndicatorSignature(LogicAtom atom)
        {
            if (atom == null)
            {
                return "";
            }

            return BuildIndicatorSignature(atom.IndicatorTypeName, atom.ChartArea, atom.ToIndicatorParameters());
        }

        /// <summary>Убирает дубликаты атомов с одинаковой сигнатурой индикатора, сохраняя порядок.</summary>
        public static List<LogicAtom> DeduplicateAtomsByIndicatorSignature(IEnumerable<LogicAtom> atoms)
        {
            var result = new List<LogicAtom>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (atoms == null)
            {
                return result;
            }

            foreach (LogicAtom atom in atoms)
            {
                if (atom == null)
                {
                    continue;
                }

                string signature = BuildIndicatorSignature(atom);
                if (seen.Add(signature))
                {
                    result.Add(atom);
                }
            }

            return result;
        }

        /// <summary>Собирает все атомы из дерева выражения (для торговли и MinBars).</summary>
        public static List<LogicAtom> GetExpressionAtoms(LogicExpressionNode root)
        {
            if (root == null)
            {
                return new List<LogicAtom>();
            }

            return CollectAtoms(root);
        }


        /// <summary>Текст справки — см. <see cref="MultiLogicHelpBuilder"/> (блок 3).</summary>
        public static string BuildDefaultHelpText() => MultiLogicHelpBuilder.BuildDefaultHelpText();

        /// <summary>HTML-справка — см. <see cref="MultiLogicHelpBuilder"/> (блок 3).</summary>
        public static string BuildDefaultHelpHtml() => MultiLogicHelpBuilder.BuildDefaultHelpHtml();

        /// <summary>Алиас справки — см. <see cref="MultiLogicHelpBuilder"/> (блок 3).</summary>
        public static string GetHelpText() => MultiLogicHelpBuilder.GetHelpText();



        /// <summary>Имя класса индикатора OsEngine для CreateCandleIndicator.</summary>
        public static string GetIndicatorTypeName(LogicIndicatorKind kind)
        {
            switch (kind)
            {
                case LogicIndicatorKind.Sma: return "Sma";
                case LogicIndicatorKind.Stoch: return "Stochastic";
                case LogicIndicatorKind.Atr: return "ATR";
                case LogicIndicatorKind.Rsi: return "Rsi";
                case LogicIndicatorKind.Cci: return "CCI";
                case LogicIndicatorKind.Macd: return "MACD";
                case LogicIndicatorKind.LinReg: return "LinearRegressionChannelFast_Indicator";
                case LogicIndicatorKind.Bollinger: return "Bollinger";
                case LogicIndicatorKind.Momentum: return "Momentum";
                case LogicIndicatorKind.Vwap: return "VWAP";
                case LogicIndicatorKind.Volume: return "Volume";
                default: return "";
            }
        }

        /// <summary>Область графика для индикатора: Prime (свечи) или Second (осциллятор).</summary>
        public static string GetChartArea(LogicIndicatorKind kind)
        {
            switch (kind)
            {
                case LogicIndicatorKind.Sma:
                case LogicIndicatorKind.Bollinger:
                case LogicIndicatorKind.LinReg:
                case LogicIndicatorKind.Vwap:
                    return "Prime";
                default:
                    return "Second";
            }
        }

        /// <summary>Формирует список параметров индикатора OsEngine из атома (с дефолтами).</summary>
        public static List<string> BuildIndicatorParameters(LogicAtom atom)
        {
            if (atom == null)
            {
                return new List<string>();
            }

            switch (atom.Kind)
            {
                case LogicIndicatorKind.Sma:
                    return new List<string>
                    {
                        atom.GetIntParam("L", 100).ToString(CultureInfo.InvariantCulture),
                        atom.GetParam("Src", "Close")
                    };
                case LogicIndicatorKind.Stoch:
                    return new List<string>
                    {
                        atom.GetIntParam("P1", 14).ToString(CultureInfo.InvariantCulture),
                        atom.GetIntParam("P2", 3).ToString(CultureInfo.InvariantCulture),
                        atom.GetIntParam("P3", 3).ToString(CultureInfo.InvariantCulture)
                    };
                case LogicIndicatorKind.Atr:
                    return new List<string>
                    {
                        atom.GetIntParam("L", 14).ToString(CultureInfo.InvariantCulture),
                        "Absolute"
                    };
                case LogicIndicatorKind.Rsi:
                    return new List<string>
                    {
                        atom.GetIntParam("L", 14).ToString(CultureInfo.InvariantCulture),
                        "Close"
                    };
                case LogicIndicatorKind.Cci:
                    return new List<string>
                    {
                        atom.GetIntParam("L", 20).ToString(CultureInfo.InvariantCulture),
                        ResolveCciCandlePoint(atom.GetParam("Src", "Typical"))
                    };
                case LogicIndicatorKind.Macd:
                    return new List<string>
                    {
                        atom.GetIntParam("Fast", 12).ToString(CultureInfo.InvariantCulture),
                        atom.GetIntParam("Slow", 26).ToString(CultureInfo.InvariantCulture),
                        atom.GetIntParam("Signal", 9).ToString(CultureInfo.InvariantCulture)
                    };
                case LogicIndicatorKind.LinReg:
                {
                    decimal dev = atom.GetDecimalParam("Dev", 2m);
                    string devStr = dev.ToString(CultureInfo.InvariantCulture);
                    return new List<string>
                    {
                        atom.GetLinRegLength().ToString(CultureInfo.InvariantCulture),
                        "Close",
                        devStr,
                        devStr
                    };
                }
                case LogicIndicatorKind.Bollinger:
                    return new List<string>
                    {
                        atom.GetIntParam("L", 100).ToString(CultureInfo.InvariantCulture),
                        atom.GetDecimalParam("Dev", 2m).ToString(CultureInfo.InvariantCulture)
                    };
                case LogicIndicatorKind.Momentum:
                    return new List<string>
                    {
                        atom.GetIntParam("L", 15).ToString(CultureInfo.InvariantCulture),
                        "Close"
                    };
                case LogicIndicatorKind.Vwap:
                case LogicIndicatorKind.Volume:
                    return new List<string>();
                default:
                    return new List<string>();
            }
        }

        /// <summary>Рекурсивно собирает атомы из дерева (с дедупликацией по Kind+Params).</summary>
        private static List<LogicAtom> CollectAtoms(LogicExpressionNode node)
        {
            var list = new List<LogicAtom>();
            CollectAtomsRecursive(node, list);
            return DeduplicateAtoms(list);
        }

        /// <summary>Обход дерева: добавляет атомы из листьев в target.</summary>
        private static void CollectAtomsRecursive(LogicExpressionNode node, List<LogicAtom> target)
        {
            if (node == null)
            {
                return;
            }

            if (node is LogicAtomNode atomNode)
            {
                target.Add(atomNode.Atom);
                return;
            }

            if (node is LogicCombineNode combine)
            {
                CollectAtomsRecursive(combine.Left, target);
                CollectAtomsRecursive(combine.Right, target);
                return;
            }

            if (node is LogicNotNode notNode)
            {
                CollectAtomsRecursive(notNode.Inner, target);
            }
        }

        /// <summary>Убирает дубликаты атомов внутри одной строки (одинаковые Kind и Params).</summary>
        private static List<LogicAtom> DeduplicateAtoms(List<LogicAtom> atoms)
        {
            var result = new List<LogicAtom>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            for (int i = 0; i < atoms.Count; i++)
            {
                LogicAtom atom = atoms[i];
                string key = atom.Kind + "|" + string.Join(";", atom.Params.OrderBy(p => p.Key).Select(p => p.Key + "=" + p.Value));
                if (seen.Add(key))
                {
                    result.Add(atom);
                }
            }

            return result;
        }

        /// <summary>Разбирает выражение верхнего уровня с оператором OR (низший приоритет).</summary>
        private LogicExpressionNode ParseExpression(string input)
        {
            List<string> orParts = SplitAtTopLevelLogicOperators(input, LogicCombineOp.Or);
            if (orParts.Count > 1)
            {
                LogicExpressionNode node = ParseAndExpression(orParts[0]);
                for (int i = 1; i < orParts.Count; i++)
                {
                    node = new LogicCombineNode(LogicCombineOp.Or, node, ParseAndExpression(orParts[i]));
                }

                return node;
            }

            return ParseAndExpression(input);
        }

        /// <summary>Разбирает фрагмент с оператором AND (средний приоритет).</summary>
        private LogicExpressionNode ParseAndExpression(string input)
        {
            List<string> andParts = SplitAtTopLevelLogicOperators(input, LogicCombineOp.And);
            if (andParts.Count > 1)
            {
                LogicExpressionNode node = ParseNotExpression(andParts[0]);
                for (int i = 1; i < andParts.Count; i++)
                {
                    node = new LogicCombineNode(LogicCombineOp.And, node, ParseNotExpression(andParts[i]));
                }

                return node;
            }

            return ParseNotExpression(input);
        }

        /// <summary>Разбирает префикс NOT / ! перед атомом или скобочным подвыражением.</summary>
        private LogicExpressionNode ParseNotExpression(string input)
        {
            string fragment = input?.Trim() ?? "";
            int notCount = 0;
            while (TryExtractLeadingNot(ref fragment))
            {
                notCount++;
            }

            LogicExpressionNode node = ParsePrimary(fragment);
            for (int i = 0; i < notCount; i++)
            {
                node = new LogicNotNode(node);
            }

            return node;
        }

        /// <summary>Атом или подвыражение в круглых скобках (&&/||/AND/OR внутри).</summary>
        private LogicExpressionNode ParsePrimary(string input)
        {
            string fragment = input?.Trim() ?? "";
            if (fragment.Length >= 2
                && fragment[0] == '('
                && TryExtractOuterParentheses(fragment, out string inner)
                && ContainsTopLevelLogicOperators(inner))
            {
                return ParseExpression(inner.Trim());
            }

            return ParseAtomNode(fragment);
        }

        /// <summary>true, если во фрагменте есть AND/OR/&&/|| верхнего уровня.</summary>
        private static bool ContainsTopLevelLogicOperators(string input)
        {
            return SplitAtTopLevelLogicOperators(input, LogicCombineOp.And).Count > 1
                || SplitAtTopLevelLogicOperators(input, LogicCombineOp.Or).Count > 1;
        }

        /// <summary>true, если в Op[…]/Cl[…] есть NOT/!, &&/|| или AND/OR.</summary>
        public static bool SignalExpressionHasOperators(string signalCode)
        {
            string input = signalCode?.Trim() ?? "";
            if (input.Length == 0)
            {
                return false;
            }

            string probe = input;
            if (TryExtractLeadingNot(ref probe))
            {
                return true;
            }

            return ContainsTopLevelLogicOperators(input);
        }

        /// <summary>Делит Op/Cl-строку по AND/&& или OR/|| верхнего уровня.</summary>
        public static List<string> SplitSignalExpressionAtTopLevel(string input, LogicCombineOp op)
        {
            return SplitAtTopLevelLogicOperators(input, op);
        }

        /// <summary>Снимает ведущий NOT / NOT- / ! из Op/Cl-фрагмента.</summary>
        public static bool TryStripSignalLeadingNot(ref string input)
        {
            return TryExtractLeadingNot(ref input);
        }

        /// <summary>Снимает внешние скобки (…) вокруг Op/Cl-фрагмента.</summary>
        public static bool TryExtractSignalOuterParentheses(string input, out string inner)
        {
            return TryExtractOuterParentheses(input, out inner);
        }

        /// <summary>Снимает внешние скобки фрагмента и разбирает один атом.</summary>
        private LogicAtomNode ParseAtomNode(string input)
        {
            string fragment = input?.Trim() ?? "";
            if (fragment.Length >= 2 && fragment[0] == '(' && TryExtractOuterParentheses(fragment, out string inner))
            {
                fragment = inner.Trim();
            }

            LogicAtom atom = ParseAtom(fragment);
            return new LogicAtomNode(atom);
        }

        /// <summary>Снимает один ведущий NOT / NOT- / ! (регистронезависимо).</summary>
        private static bool TryExtractLeadingNot(ref string input)
        {
            input = input?.Trim() ?? "";
            if (input.Length >= 1 && input[0] == '!')
            {
                input = input.Substring(1).TrimStart();
                return true;
            }

            if (input.Length < 3)
            {
                return false;
            }

            if (!StartsWithIgnoreCaseAt(input, 0, "NOT", out int nameLen))
            {
                return false;
            }

            if (input.Length > nameLen && char.IsLetter(input[nameLen]))
            {
                if (TryGetIndicatorNamePrefix(input, nameLen, out string gluedName, out _)
                    && ParseIndicatorName(gluedName) != LogicIndicatorKind.Unknown)
                {
                    input = input.Substring(nameLen).TrimStart();
                    return true;
                }

                return false;
            }

            input = input.Substring(nameLen).TrimStart();
            if (input.StartsWith("-", StringComparison.Ordinal))
            {
                input = input.Substring(1).TrimStart();
            }

            return true;
        }

        /// <summary>Имя индикатора до «(» или до конца фрагмента.</summary>
        private static bool TryGetIndicatorNamePrefix(
            string input,
            int startIndex,
            out string name,
            out int endExclusive)
        {
            name = "";
            endExclusive = startIndex;
            if (string.IsNullOrEmpty(input) || startIndex < 0 || startIndex >= input.Length)
            {
                return false;
            }

            int openIdx = input.IndexOf('(', startIndex);
            if (openIdx < 0)
            {
                name = input.Substring(startIndex).Trim();
                endExclusive = input.Length;
            }
            else
            {
                name = input.Substring(startIndex, openIdx - startIndex).Trim();
                endExclusive = openIdx;
            }

            return name.Length > 0;
        }

        /// <summary>Частая опечатка L!inReg → !LinReg (NOT перед именем, не внутри).</summary>
        private static void TryNormalizeMisplacedBangNot(ref string work)
        {
            if (string.IsNullOrWhiteSpace(work))
            {
                return;
            }

            int bangIdx = work.IndexOf('!');
            if (bangIdx <= 0)
            {
                return;
            }

            int openIdx = work.IndexOf('(');
            if (openIdx >= 0 && bangIdx >= openIdx)
            {
                return;
            }

            string relocated = "!" + work.Substring(0, bangIdx) + work.Substring(bangIdx + 1);
            if (!TryGetIndicatorNamePrefix(relocated, 1, out string name, out _))
            {
                return;
            }

            if (ParseIndicatorName(name) != LogicIndicatorKind.Unknown)
            {
                work = relocated;
            }
        }

        /// <summary>
        /// Разбирает один атом: Note, SL, TP, Side, Cl, Op, NOT/! у индикатора, затем заголовок и параметры.
        /// </summary>
        private LogicAtom ParseAtom(string input)
        {
            string work = input.Trim();
            if (string.IsNullOrEmpty(work))
            {
                throw new InvalidOperationException("Пустой фрагмент логики.");
            }

            var atom = new LogicAtom { RawFragment = work };

            work = ExtractRepeatedTag(work, atom, new[] { "Note", "Коммент", "Cm" }, value => atom.Comment = value);
            work = ExtractBracketTag(work, "SL", value => atom.StopLoss = value);
            work = ExtractBracketTag(work, "TP", value => atom.TakeProfit = value);
            work = ExtractSideTag(work, atom);
            work = ExtractBracketTag(work, "Cl", value => atom.CloseSignal = value);
            work = ExtractBracketTag(work, "Op", value => atom.OpenSignal = value);

            work = work.Trim();
            work = StripRedundantOuterParentheses(work);
            if (string.IsNullOrEmpty(work))
            {
                throw new InvalidOperationException("Не найден индикатор в: " + input);
            }

            TryNormalizeMisplacedBangNot(ref work);

            while (TryExtractLeadingNot(ref work))
            {
                atom.InvertSignals = !atom.InvertSignals;
            }

            ParseIndicatorHeader(work, atom);
            if (atom.Kind == LogicIndicatorKind.Unknown)
            {
                string hint = work.IndexOf('!') >= 0
                    ? " Проверьте NOT/! перед именем индикатора: NOT LinReg, !LinReg или NOTLinReg (не L!inReg)."
                    : "";
                throw new InvalidOperationException("Неизвестный индикатор в: " + input + hint);
            }

            ApplyDefaultParams(atom);
            return atom;
        }

        /// <summary>
        /// Убирает одну пару внешних скобок вокруг атома, если строка целиком в (…).
        /// </summary>
        private static string StripRedundantOuterParentheses(string work)
        {
            string trimmed = work?.Trim() ?? "";
            if (trimmed.Length >= 2
                && trimmed[0] == '('
                && TryExtractOuterParentheses(trimmed, out string inner))
            {
                return inner.Trim();
            }

            return trimmed;
        }

        /// <summary>Подставляет значения по умолчанию для параметров индикатора, если не заданы в строке.</summary>
        private static void ApplyDefaultParams(LogicAtom atom)
        {
            ApplyDefaultParamsCore(atom);
        }

        /// <summary>Публичная обёртка для Regime(…) и probe-атомов.</summary>
        public static void ApplyDefaultParamsForAtom(LogicAtom atom)
        {
            ApplyDefaultParamsCore(atom);
        }

        private static void ApplyDefaultParamsCore(LogicAtom atom)
        {
            switch (atom.Kind)
            {
                case LogicIndicatorKind.Sma:
                    EnsureDefault(atom, "L", "100");
                    EnsureDefault(atom, "Src", "Close");
                    break;
                case LogicIndicatorKind.Stoch:
                    EnsureDefault(atom, "P1", "14");
                    EnsureDefault(atom, "P2", "3");
                    EnsureDefault(atom, "P3", "3");
                    EnsureDefault(atom, "Lmin", "55");
                    EnsureDefault(atom, "Smax", "45");
                    break;
                case LogicIndicatorKind.Atr:
                    EnsureDefault(atom, "L", "14");
                    EnsureDefault(atom, "Gr", "3");
                    EnsureDefault(atom, "Lb", "5");
                    break;
                case LogicIndicatorKind.Rsi:
                    EnsureDefault(atom, "L", "14");
                    EnsureDefault(atom, "Lmin", "55");
                    EnsureDefault(atom, "Smax", "45");
                    break;
                case LogicIndicatorKind.Cci:
                    EnsureDefault(atom, "L", "20");
                    EnsureDefault(atom, "Src", "Typical");
                    EnsureDefault(atom, "Lmin", "100");
                    EnsureDefault(atom, "Smax", "-100");
                    break;
                case LogicIndicatorKind.Macd:
                    EnsureDefault(atom, "Fast", "12");
                    EnsureDefault(atom, "Slow", "26");
                    EnsureDefault(atom, "Signal", "9");
                    break;
                case LogicIndicatorKind.LinReg:
                    EnsureDefault(atom, "L", LinRegLengthParamToken);
                    EnsureDefault(atom, "Dev", "2");
                    break;
                case LogicIndicatorKind.Bollinger:
                    EnsureDefault(atom, "L", "100");
                    EnsureDefault(atom, "Dev", "2");
                    break;
                case LogicIndicatorKind.Momentum:
                    EnsureDefault(atom, "L", "15");
                    EnsureDefault(atom, "Lmin", "100");
                    EnsureDefault(atom, "Smax", "100");
                    break;
            }
        }

        /// <summary>Записывает defaultValue в Params, если ключ отсутствует или пуст.</summary>
        private static void EnsureDefault(LogicAtom atom, string key, string value)
        {
            if (!atom.Params.ContainsKey(key) || string.IsNullOrWhiteSpace(atom.Params[key]))
            {
                atom.Params[key] = value;
            }
        }

        /// <summary>Извлекает имя индикатора и тело скобок (…) в Params атома.</summary>
        private static void ParseIndicatorHeader(string work, LogicAtom atom)
        {
            int openIdx = work.IndexOf('(');
            if (openIdx < 0)
            {
                atom.Kind = ParseIndicatorName(work.Trim());
                return;
            }

            string name = work.Substring(0, openIdx).Trim();
            atom.Kind = ParseIndicatorName(name);
            if (!TryReadBalancedParenthesesContent(work, openIdx, out string paramsBody))
            {
                throw new InvalidOperationException("Не закрыты скобки параметров индикатора: " + work);
            }

            ParseIndicatorParams(paramsBody, atom);
        }

        /// <summary>Сопоставляет текстовое имя индикатора с LogicIndicatorKind.</summary>
        private static LogicIndicatorKind ParseIndicatorName(string name)
        {
            if (string.IsNullOrWhiteSpace(name))
            {
                return LogicIndicatorKind.Unknown;
            }

            switch (name.Trim().Replace(" ", "").ToUpperInvariant())
            {
                case "SMA": return LogicIndicatorKind.Sma;
                case "STOCH":
                case "STOCHASTIC": return LogicIndicatorKind.Stoch;
                case "ATR": return LogicIndicatorKind.Atr;
                case "RSI": return LogicIndicatorKind.Rsi;
                case "CCI": return LogicIndicatorKind.Cci;
                case "MACD": return LogicIndicatorKind.Macd;
                case "LINREG":
                case "LR":
                case "LINEARREGRESSION": return LogicIndicatorKind.LinReg;
                case "BOLL":
                case "BOLLINGER": return LogicIndicatorKind.Bollinger;
                case "MOM":
                case "MOMENTUM": return LogicIndicatorKind.Momentum;
                case "VWAP": return LogicIndicatorKind.Vwap;
                case "VOL":
                case "VOLUME": return LogicIndicatorKind.Volume;
                default: return LogicIndicatorKind.Unknown;
            }
        }

        /// <summary>Разбирает тело скобок индикатора: секции через ;, позиционные и именованные параметры.</summary>
        private static void ParseIndicatorParams(string body, LogicAtom atom)
        {
            if (string.IsNullOrWhiteSpace(body))
            {
                return;
            }

            string[] sections = body.Split(';');
            for (int s = 0; s < sections.Length; s++)
            {
                string section = sections[s].Trim();
                if (string.IsNullOrEmpty(section))
                {
                    continue;
                }

                if (section.Contains("="))
                {
                    ParseNamedSection(section, atom);
                    continue;
                }

                if (section.Contains(",") && !section.Contains("-"))
                {
                    ParseCommaSection(section, atom);
                    continue;
                }

                if (section.Contains("-") && atom.Kind == LogicIndicatorKind.Stoch)
                {
                    string[] dash = section.Split('-');
                    if (dash.Length >= 3)
                    {
                        atom.Params["P1"] = dash[0].Trim();
                        atom.Params["P2"] = dash[1].Trim();
                        atom.Params["P3"] = dash[2].Trim();
                        continue;
                    }
                }

                if (section.StartsWith("+", StringComparison.Ordinal) && section.Contains("@") && atom.Kind == LogicIndicatorKind.Atr)
                {
                    ParseAtrGrowShorthand(section, atom);
                    continue;
                }

                if (section.StartsWith("+", StringComparison.Ordinal) && section.EndsWith("%", StringComparison.Ordinal) && atom.Kind == LogicIndicatorKind.Atr)
                {
                    atom.Params["Gr"] = section.Trim('+').TrimEnd('%');
                    continue;
                }

                if (section.StartsWith("@", StringComparison.Ordinal) && atom.Kind == LogicIndicatorKind.Atr)
                {
                    atom.Params["Lb"] = section.TrimStart('@');
                    continue;
                }

                if (section.Contains("@") && atom.Kind == LogicIndicatorKind.Atr)
                {
                    ParseAtrGrowShorthand(section, atom);
                    continue;
                }

                AssignPositionalToken(section, atom, s);
            }
        }

        /// <summary>Краткая запись роста ATR: +3%@5 → Gr и Lb.</summary>
        private static void ParseAtrGrowShorthand(string section, LogicAtom atom)
        {
            int at = section.IndexOf('@');
            if (at > 0)
            {
                string grow = section.Substring(0, at).Trim().Trim('+').TrimEnd('%');
                string lb = section.Substring(at + 1).Trim();
                if (!string.IsNullOrEmpty(grow))
                {
                    atom.Params["Gr"] = grow;
                }

                if (!string.IsNullOrEmpty(lb))
                {
                    atom.Params["Lb"] = lb;
                }
            }
        }

        /// <summary>Именованная секция параметров: Key=Value или Key:Value.</summary>
        private static void ParseNamedSection(string section, LogicAtom atom)
        {
            string[] pairs = section.Split(',');
            for (int i = 0; i < pairs.Length; i++)
            {
                string pair = pairs[i].Trim();
                int eq = pair.IndexOf('=');
                if (eq <= 0)
                {
                    continue;
                }

                string key = NormalizeParamKey(pair.Substring(0, eq).Trim());
                string value = pair.Substring(eq + 1).Trim().TrimEnd('%');
                if (!string.IsNullOrEmpty(key))
                {
                    atom.Params[key] = value;
                }
            }
        }

        /// <summary>Секция с запятыми: MACD(12,26,9) и аналоги.</summary>
        private static void ParseCommaSection(string section, LogicAtom atom)
        {
            string[] parts = section.Split(',');
            switch (atom.Kind)
            {
                case LogicIndicatorKind.Macd when parts.Length >= 3:
                    atom.Params["Fast"] = parts[0].Trim();
                    atom.Params["Slow"] = parts[1].Trim();
                    atom.Params["Signal"] = parts[2].Trim();
                    break;
                case LogicIndicatorKind.Stoch when parts.Length >= 3:
                    atom.Params["P1"] = parts[0].Trim();
                    atom.Params["P2"] = parts[1].Trim();
                    atom.Params["P3"] = parts[2].Trim();
                    break;
                default:
                    for (int i = 0; i < parts.Length; i++)
                    {
                        AssignPositionalToken(parts[i].Trim(), atom, i);
                    }

                    break;
            }
        }

        /// <summary>Назначает позиционный токен параметру по типу индикатора и индексу.</summary>
        private static void AssignPositionalToken(string token, LogicAtom atom, int index)
        {
            token = token.Trim().TrimEnd('%');
            switch (atom.Kind)
            {
                case LogicIndicatorKind.Sma:
                case LogicIndicatorKind.Rsi:
                case LogicIndicatorKind.Cci:
                case LogicIndicatorKind.Momentum:
                case LogicIndicatorKind.Atr:
                case LogicIndicatorKind.Bollinger:
                case LogicIndicatorKind.LinReg:
                    if (index == 0)
                    {
                        atom.Params["L"] = token;
                    }
                    else if (index == 1 && atom.Kind == LogicIndicatorKind.Bollinger)
                    {
                        atom.Params["Dev"] = token;
                    }
                    else if (index == 1 && atom.Kind == LogicIndicatorKind.LinReg)
                    {
                        atom.Params["Dev"] = token;
                    }
                    else if (index == 1 && atom.Kind == LogicIndicatorKind.Cci)
                    {
                        atom.Params["Src"] = token;
                    }

                    break;
                case LogicIndicatorKind.Stoch:
                    if (index == 0)
                    {
                        atom.Params["P1"] = token;
                    }
                    else if (index == 1)
                    {
                        atom.Params["P2"] = token;
                    }
                    else if (index == 2)
                    {
                        atom.Params["P3"] = token;
                    }

                    break;
                case LogicIndicatorKind.Macd:
                    if (index == 0)
                    {
                        atom.Params["Fast"] = token;
                    }
                    else if (index == 1)
                    {
                        atom.Params["Slow"] = token;
                    }
                    else if (index == 2)
                    {
                        atom.Params["Signal"] = token;
                    }

                    break;
            }
        }

        /// <summary>Нормализует Src атома CCI к допустимой точке свечи OsEngine CCI.</summary>
        private static string ResolveCciCandlePoint(string src)
        {
            if (string.IsNullOrWhiteSpace(src))
            {
                return "Typical";
            }

            string normalized = src.Trim();
            char first = char.ToUpperInvariant(normalized[0]);
            if (first == 'C')
            {
                return "Close";
            }

            if (first == 'O')
            {
                return "Open";
            }

            if (first == 'H')
            {
                return "High";
            }

            if (first == 'L')
            {
                return "Low";
            }

            if (first == 'M')
            {
                return "Median";
            }

            return "Typical";
        }

        /// <summary>Нормализует ключ параметра (L, P1, Gr, Lmin…).</summary>
        private static string NormalizeParamKey(string key)
        {
            switch (key.Replace(" ", "").ToUpperInvariant())
            {
                case "L":
                case "LEN":
                case "LENGTH": return "L";
                case "P1":
                case "K":
                case "K1": return "P1";
                case "P2":
                case "K2": return "P2";
                case "P3":
                case "D": return "P3";
                case "LMIN":
                case "LONGMIN": return "Lmin";
                case "SMAX":
                case "SHORTMAX": return "Smax";
                case "GR":
                case "GROW": return "Gr";
                case "LB":
                case "LOOKBACK": return "Lb";
                case "SLOPELB":
                case "SLOPELBARS": return "SlopeLb";
                case "SLOPEDEAD":
                case "SLOPEDZ": return "SlopeDead";
                case "DEV": return "Dev";
                case "SRC":
                case "SOURCE": return "Src";
                case "FAST": return "Fast";
                case "SLOW": return "Slow";
                case "SIGNAL": return "Signal";
                default: return key;
            }
        }

        /// <summary>Извлекает тег Side:L или Side:S из фрагмента атома.</summary>
        private static string ExtractSideTag(string work, LogicAtom atom)
        {
            work = ExtractNamedValueTag(work, "Side", value =>
            {
                atom.Side = value.Trim().ToUpperInvariant();
            });
            return work;
        }

        /// <summary>Извлекает повторяющиеся теги Note / Коммент / Cm со скобками (…).</summary>
        private static string ExtractRepeatedTag(string work, LogicAtom atom, string[] tagNames, Action<string> assign)
        {
            for (int pass = 0; pass < 4; pass++)
            {
                bool found = false;
                for (int i = 0; i < tagNames.Length; i++)
                {
                    string before = work;
                    work = ExtractNamedValueTag(work, tagNames[i], assign);
                    if (!string.Equals(before, work, StringComparison.Ordinal))
                    {
                        found = true;
                    }
                }

                if (!found)
                {
                    break;
                }
            }

            return work;
        }

        /// <summary>Извлекает тег со значением в квадратных скобках: Op[…], Cl[…], SL[…].</summary>
        private static string ExtractBracketTag(string work, string tagName, Action<string> assign)
        {
            string pattern = tagName + "[";
            int idx = work.IndexOf(pattern, StringComparison.OrdinalIgnoreCase);
            while (idx >= 0)
            {
                int start = idx + pattern.Length;
                int end = work.IndexOf(']', start);
                if (end < 0)
                {
                    break;
                }

                assign(work.Substring(start, end - start).Trim());
                work = (work.Substring(0, idx) + work.Substring(end + 1)).Trim();
                idx = work.IndexOf(pattern, StringComparison.OrdinalIgnoreCase);
            }

            return work;
        }

        /// <summary>Извлекает тег со значением в круглых скобках или квадратных: Side(…), Note(…).</summary>
        private static string ExtractNamedValueTag(string work, string tagName, Action<string> assign)
        {
            int idx = work.IndexOf(tagName, StringComparison.OrdinalIgnoreCase);
            while (idx >= 0)
            {
                int pos = idx + tagName.Length;
                while (pos < work.Length && char.IsWhiteSpace(work[pos]))
                {
                    pos++;
                }

                if (pos >= work.Length)
                {
                    break;
                }

                if (work[pos] == '(')
                {
                    if (!TryReadBalancedParenthesesContent(work, pos, out string inner))
                    {
                        break;
                    }

                    assign(inner);
                    work = (work.Substring(0, idx) + work.Substring(pos + inner.Length + 2)).Trim();
                }
                else if (work[pos] == '[')
                {
                    int end = work.IndexOf(']', pos);
                    if (end < 0)
                    {
                        break;
                    }

                    assign(work.Substring(pos + 1, end - pos - 1));
                    work = (work.Substring(0, idx) + work.Substring(end + 1)).Trim();
                }
                else if (work[pos] == ':')
                {
                    pos++;
                    int end = pos;
                    while (end < work.Length && !char.IsWhiteSpace(work[end]))
                    {
                        end++;
                    }

                    assign(work.Substring(pos, end - pos));
                    work = (work.Substring(0, idx) + work.Substring(end)).Trim();
                }
                else
                {
                    break;
                }

                idx = work.IndexOf(tagName, StringComparison.OrdinalIgnoreCase);
            }

            return work;
        }

        /// <summary>
        /// Делит строку по AND/&& или OR/|| на части верхнего уровня (вне скобок индикаторов и Op/Cl).
        /// </summary>
        private static List<string> SplitAtTopLevelLogicOperators(string input, LogicCombineOp op)
        {
            var parts = new List<string>();
            if (string.IsNullOrWhiteSpace(input))
            {
                return parts;
            }

            int depthParen = 0;
            int depthBracket = 0;
            int lastSplit = 0;

            for (int i = 0; i < input.Length; i++)
            {
                char c = input[i];
                if (c == '(')
                {
                    depthParen++;
                }
                else if (c == ')' && depthParen > 0)
                {
                    depthParen--;
                }
                else if (c == '[')
                {
                    depthBracket++;
                }
                else if (c == ']' && depthBracket > 0)
                {
                    depthBracket--;
                }
                else if (depthParen == 0 && depthBracket == 0
                         && TryMatchLogicOperator(input, i, op, out int tokenLength))
                {
                    parts.Add(input.Substring(lastSplit, i - lastSplit).Trim());
                    lastSplit = i + tokenLength;
                    i = lastSplit - 1;
                }
            }

            parts.Add(input.Substring(lastSplit).Trim());
            return parts.Where(p => !string.IsNullOrWhiteSpace(p)).ToList();
        }

        private static bool TryMatchLogicOperator(string input, int index, LogicCombineOp op, out int length)
        {
            length = 0;
            if (op == LogicCombineOp.Or)
            {
                if (index + 1 < input.Length && input[index] == '|' && input[index + 1] == '|')
                {
                    length = 2;
                    return true;
                }

                return TryMatchLogicWordOperator(input, index, "OR", out length);
            }

            if (index + 1 < input.Length && input[index] == '&' && input[index + 1] == '&')
            {
                length = 2;
                return true;
            }

            return TryMatchLogicWordOperator(input, index, "AND", out length);
        }

        private static bool TryMatchLogicWordOperator(string input, int index, string word, out int length)
        {
            length = 0;
            if (index > 0 && !char.IsWhiteSpace(input[index - 1]))
            {
                return false;
            }

            if (!StartsWithIgnoreCaseAt(input, index, word, out int wordLen))
            {
                return false;
            }

            int end = index + wordLen;
            if (end < input.Length && !char.IsWhiteSpace(input[end]))
            {
                return false;
            }

            length = wordLen;
            return true;
        }

        /// <summary>
        /// Делит строку по оператору AND или OR на части верхнего уровня (вне скобок индикаторов).
        /// </summary>
        private static List<string> SplitAtTopLevelOperator(string input, string op)
        {
            LogicCombineOp combineOp = string.Equals(op, "OR", StringComparison.OrdinalIgnoreCase)
                ? LogicCombineOp.Or
                : LogicCombineOp.And;
            return SplitAtTopLevelLogicOperators(input, combineOp);
        }

        /// <summary>Проверяет, что вся строка — одна пара внешних скобок (…).</summary>
        private static bool TryExtractOuterParentheses(string input, out string inner)
        {
            inner = null;
            if (string.IsNullOrWhiteSpace(input) || input[0] != '(')
            {
                return false;
            }

            if (!TryReadBalancedParenthesesContent(input, 0, out inner))
            {
                return false;
            }

            string tail = input.Substring(inner.Length + 2).Trim();
            return tail.Length == 0;
        }

        /// <summary>Читает содержимое сбалансированных круглых скобок, начиная с openIndex.</summary>
        private static bool TryReadBalancedParenthesesContent(string input, int openIndex, out string inner)
        {
            inner = null;
            if (openIndex < 0 || openIndex >= input.Length || input[openIndex] != '(')
            {
                return false;
            }

            int depth = 0;
            for (int i = openIndex; i < input.Length; i++)
            {
                if (input[i] == '(')
                {
                    depth++;
                }
                else if (input[i] == ')')
                {
                    depth--;
                    if (depth == 0)
                    {
                        inner = input.Substring(openIndex + 1, i - openIndex - 1);
                        return true;
                    }
                }
            }

            return false;
        }
    }

    /// <summary>Результат проверки SL/TP по позиции на свече.</summary>
    public enum LogicStopTakeHit
    {
        /// <summary>Уровни не заданы или close не пробил SL/TP.</summary>
        None = 0,
        /// <summary>Close пробил стоп-лосс.</summary>
        StopLoss = 1,
        /// <summary>Close пробил тейк-профит.</summary>
        TakeProfit = 2
    }

    /// <summary>
    /// Расчёт и проверка SL/TP из атомов логики: % от входа, ATR, кратность R к SL.
    /// В одной логике: самый жёсткий SL и самый дальний TP.
    /// </summary>
    public static class LogicStopTakeEvaluator
    {
        /// <summary>Делегат поиска индикатора на вкладке по атому.</summary>
        public delegate Aindicator FindIndicatorHandler(BotTabSimple tab, LogicAtom atom);

        private enum StopTakeFormat
        {
            None = 0,
            Percent = 1,
            AtrMultiple = 2,
            RiskMultiple = 3
        }

        private struct ParsedStopTake
        {
            public StopTakeFormat Format;
            public decimal Value;
        }

        /// <summary>
        /// Проверяет пробой SL/TP на закрытии свечи для открытой позиции логики.
        /// </summary>
        public static LogicStopTakeHit EvaluateStopTake(
            LogicExpressionNode root,
            BotTabSimple tab,
            List<Candle> candles,
            int candleIndex,
            Position position,
            FindIndicatorHandler findIndicator)
        {
            if (position == null)
            {
                return LogicStopTakeHit.None;
            }

            return EvaluateStopTake(
                root,
                tab,
                candles,
                candleIndex,
                position.Direction,
                position.EntryPrice,
                findIndicator);
        }

        /// <summary>
        /// Проверяет пробой SL/TP на закрытии свечи по направлению и цене входа (в т.ч. виртуальные позиции Stopper).
        /// </summary>
        public static LogicStopTakeHit EvaluateStopTake(
            LogicExpressionNode root,
            BotTabSimple tab,
            List<Candle> candles,
            int candleIndex,
            Side direction,
            decimal entryPrice,
            FindIndicatorHandler findIndicator)
        {
            if (root == null
                || tab == null
                || candles == null
                || findIndicator == null
                || candleIndex < 0
                || candleIndex >= candles.Count
                || entryPrice <= 0m)
            {
                return LogicStopTakeHit.None;
            }

            List<LogicAtom> atoms = LogicLineParser.GetExpressionAtoms(root);
            if (atoms == null || atoms.Count == 0)
            {
                return LogicStopTakeHit.None;
            }

            bool isLong = direction != Side.Sell;
            decimal entry = entryPrice;
            decimal close = candles[candleIndex].Close;
            LogicAtom atrAtom = FindFirstAtrAtom(atoms);
            decimal? atrValue = TryGetAtrValue(atrAtom, tab, candleIndex, findIndicator);

            decimal? stopPrice = ResolveAggregatedStopPrice(
                atoms,
                entry,
                isLong,
                atrValue,
                tab,
                candleIndex,
                findIndicator,
                atrAtom);

            decimal? takePrice = ResolveAggregatedTakePrice(
                atoms,
                entry,
                isLong,
                stopPrice,
                atrValue,
                tab,
                candleIndex,
                findIndicator,
                atrAtom);

            if (stopPrice.HasValue && IsStopLossHit(isLong, close, stopPrice.Value))
            {
                return LogicStopTakeHit.StopLoss;
            }

            if (takePrice.HasValue && IsTakeProfitHit(isLong, close, takePrice.Value))
            {
                return LogicStopTakeHit.TakeProfit;
            }

            return LogicStopTakeHit.None;
        }

        private static decimal? ResolveAggregatedStopPrice(
            IReadOnlyList<LogicAtom> atoms,
            decimal entry,
            bool isLong,
            decimal? atrValue,
            BotTabSimple tab,
            int candleIndex,
            FindIndicatorHandler findIndicator,
            LogicAtom atrAtom)
        {
            decimal? aggregated = null;

            for (int i = 0; i < atoms.Count; i++)
            {
                LogicAtom atom = atoms[i];
                if (atom == null || string.IsNullOrWhiteSpace(atom.StopLoss))
                {
                    continue;
                }

                if (!TryParseStopTake(atom.StopLoss, out ParsedStopTake parsed)
                    || parsed.Format == StopTakeFormat.None
                    || parsed.Format == StopTakeFormat.RiskMultiple)
                {
                    continue;
                }

                decimal? price = TryComputeStopPrice(
                    parsed,
                    entry,
                    isLong,
                    ResolveAtrValueForAtom(atom, atrAtom, atrValue, tab, candleIndex, findIndicator));

                if (!price.HasValue)
                {
                    continue;
                }

                aggregated = TightenStopPrice(aggregated, price.Value, isLong);
            }

            return aggregated;
        }

        private static decimal? ResolveAggregatedTakePrice(
            IReadOnlyList<LogicAtom> atoms,
            decimal entry,
            bool isLong,
            decimal? stopPrice,
            decimal? atrValue,
            BotTabSimple tab,
            int candleIndex,
            FindIndicatorHandler findIndicator,
            LogicAtom atrAtom)
        {
            decimal? aggregated = null;

            for (int i = 0; i < atoms.Count; i++)
            {
                LogicAtom atom = atoms[i];
                if (atom == null || string.IsNullOrWhiteSpace(atom.TakeProfit))
                {
                    continue;
                }

                if (!TryParseStopTake(atom.TakeProfit, out ParsedStopTake parsed)
                    || parsed.Format == StopTakeFormat.None)
                {
                    continue;
                }

                decimal? price = TryComputeTakePrice(
                    parsed,
                    entry,
                    isLong,
                    stopPrice,
                    ResolveAtrValueForAtom(atom, atrAtom, atrValue, tab, candleIndex, findIndicator));

                if (!price.HasValue)
                {
                    continue;
                }

                aggregated = WidenTakePrice(aggregated, price.Value, isLong);
            }

            return aggregated;
        }

        private static decimal? TryComputeStopPrice(
            ParsedStopTake parsed,
            decimal entry,
            bool isLong,
            decimal? atrValue)
        {
            switch (parsed.Format)
            {
                case StopTakeFormat.Percent:
                    return isLong
                        ? entry * (1m - parsed.Value / 100m)
                        : entry * (1m + parsed.Value / 100m);
                case StopTakeFormat.AtrMultiple:
                    if (!atrValue.HasValue || atrValue.Value <= 0m)
                    {
                        return null;
                    }

                    return isLong
                        ? entry - parsed.Value * atrValue.Value
                        : entry + parsed.Value * atrValue.Value;
                default:
                    return null;
            }
        }

        private static decimal? TryComputeTakePrice(
            ParsedStopTake parsed,
            decimal entry,
            bool isLong,
            decimal? stopPrice,
            decimal? atrValue)
        {
            switch (parsed.Format)
            {
                case StopTakeFormat.Percent:
                    return isLong
                        ? entry * (1m + parsed.Value / 100m)
                        : entry * (1m - parsed.Value / 100m);
                case StopTakeFormat.AtrMultiple:
                    if (!atrValue.HasValue || atrValue.Value <= 0m)
                    {
                        return null;
                    }

                    return isLong
                        ? entry + parsed.Value * atrValue.Value
                        : entry - parsed.Value * atrValue.Value;
                case StopTakeFormat.RiskMultiple:
                    if (!stopPrice.HasValue)
                    {
                        return null;
                    }

                    decimal risk = Math.Abs(entry - stopPrice.Value);
                    if (risk <= 0m)
                    {
                        return null;
                    }

                    return isLong
                        ? entry + parsed.Value * risk
                        : entry - parsed.Value * risk;
                default:
                    return null;
            }
        }

        private static decimal? ResolveAtrValueForAtom(
            LogicAtom atom,
            LogicAtom sharedAtrAtom,
            decimal? sharedAtrValue,
            BotTabSimple tab,
            int candleIndex,
            FindIndicatorHandler findIndicator)
        {
            if (atom != null && atom.Kind == LogicIndicatorKind.Atr)
            {
                return TryGetAtrValue(atom, tab, candleIndex, findIndicator);
            }

            return sharedAtrValue;
        }

        private static LogicAtom FindFirstAtrAtom(IReadOnlyList<LogicAtom> atoms)
        {
            for (int i = 0; i < atoms.Count; i++)
            {
                if (atoms[i]?.Kind == LogicIndicatorKind.Atr)
                {
                    return atoms[i];
                }
            }

            return null;
        }

        private static decimal? TryGetAtrValue(
            LogicAtom atrAtom,
            BotTabSimple tab,
            int candleIndex,
            FindIndicatorHandler findIndicator)
        {
            if (atrAtom == null)
            {
                return null;
            }

            Aindicator indicator = findIndicator(tab, atrAtom);
            if (indicator == null)
            {
                return null;
            }

            decimal atr = SeriesValueAt(indicator, 0, candleIndex);
            return atr > 0m ? atr : (decimal?)null;
        }

        private static bool TryParseStopTake(string raw, out ParsedStopTake parsed)
        {
            parsed = default;
            if (string.IsNullOrWhiteSpace(raw))
            {
                return false;
            }

            string text = raw.Trim().Replace(" ", "").ToUpperInvariant();
            if (text.EndsWith("%", StringComparison.Ordinal))
            {
                string percentPart = text.Substring(0, text.Length - 1);
                if (decimal.TryParse(percentPart, NumberStyles.Number, CultureInfo.InvariantCulture, out decimal percent)
                    && percent > 0m)
                {
                    parsed = new ParsedStopTake { Format = StopTakeFormat.Percent, Value = percent };
                    return true;
                }

                return false;
            }

            if (text.EndsWith("ATR", StringComparison.Ordinal))
            {
                string atrPart = text.Substring(0, text.Length - 3);
                if (decimal.TryParse(atrPart, NumberStyles.Number, CultureInfo.InvariantCulture, out decimal atrMult)
                    && atrMult > 0m)
                {
                    parsed = new ParsedStopTake { Format = StopTakeFormat.AtrMultiple, Value = atrMult };
                    return true;
                }

                return false;
            }

            if (text.EndsWith("R", StringComparison.Ordinal))
            {
                string riskPart = text.Substring(0, text.Length - 1);
                if (decimal.TryParse(riskPart, NumberStyles.Number, CultureInfo.InvariantCulture, out decimal riskMult)
                    && riskMult > 0m)
                {
                    parsed = new ParsedStopTake { Format = StopTakeFormat.RiskMultiple, Value = riskMult };
                    return true;
                }

                return false;
            }

            return false;
        }

        private static decimal TightenStopPrice(decimal? current, decimal candidate, bool isLong)
        {
            if (!current.HasValue)
            {
                return candidate;
            }

            return isLong
                ? Math.Max(current.Value, candidate)
                : Math.Min(current.Value, candidate);
        }

        private static decimal WidenTakePrice(decimal? current, decimal candidate, bool isLong)
        {
            if (!current.HasValue)
            {
                return candidate;
            }

            return isLong
                ? Math.Max(current.Value, candidate)
                : Math.Min(current.Value, candidate);
        }

        private static bool IsStopLossHit(bool isLong, decimal close, decimal stopPrice)
        {
            return isLong ? close <= stopPrice : close >= stopPrice;
        }

        private static bool IsTakeProfitHit(bool isLong, decimal close, decimal takePrice)
        {
            return isLong ? close >= takePrice : close <= takePrice;
        }

        private static decimal SeriesValueAt(Aindicator indicator, int seriesIndex, int candleIndex)
        {
            if (indicator?.DataSeries == null || seriesIndex >= indicator.DataSeries.Count)
            {
                return 0m;
            }

            IndicatorDataSeries series = indicator.DataSeries[seriesIndex];
            if (series?.Values == null || series.Values.Count == 0)
            {
                return 0m;
            }

            if (candleIndex < 0 || candleIndex >= series.Values.Count)
            {
                return series.Last;
            }

            return series.Values[candleIndex];
        }
    }

    /// <summary>
    /// Вычисление составного выражения логики (AND/OR) для сигналов входа Op и выхода Cl на свече.
    /// </summary>
    public static class LogicExpressionEvaluator
    {
        /// <summary>Делегат поиска индикатора на вкладке по атому (реализуется в MultiLogic).</summary>
        public delegate Aindicator FindIndicatorHandler(BotTabSimple tab, LogicAtom atom);

        /// <summary>Проверяет, выполнено ли условие входа Op по всему дереву выражения.</summary>
        /// <param name="root">Корень дерева AND/OR.</param>
        /// <param name="tab">Вкладка инструмента.</param>
        /// <param name="candles">Свечи вкладки.</param>
        /// <param name="candleIndex">Индекс свечи для проверки.</param>
        /// <param name="findIndicator">Поиск Aindicator по атому.</param>
        public static bool EvaluateOpen(
            LogicExpressionNode root,
            BotTabSimple tab,
            List<Candle> candles,
            int candleIndex,
            FindIndicatorHandler findIndicator)
        {
            return Evaluate(root, tab, candles, candleIndex, forClose: false, findIndicator);
        }

        /// <summary>Проверяет, выполнено ли условие выхода Cl по всему дереву (Cl[-] не участвует в Cl).</summary>
        public static bool EvaluateClose(
            LogicExpressionNode root,
            BotTabSimple tab,
            List<Candle> candles,
            int candleIndex,
            FindIndicatorHandler findIndicator)
        {
            return EvaluateCloseNode(root, tab, candles, candleIndex, findIndicator) == true;
        }

        /// <summary>
        /// Определяет сторону входа: Side[S] / SHORT / SELL → Sell, иначе Buy.
        /// </summary>
        /// <param name="root">Дерево выражения.</param>
        /// <returns>Side.Buy или Side.Sell.</returns>
        public static Side ResolveEntrySide(LogicExpressionNode root)
        {
            List<LogicAtom> atoms = LogicLineParser.GetExpressionAtoms(root);
            for (int i = 0; i < atoms.Count; i++)
            {
                string side = atoms[i].Side;
                if (string.Equals(side, "S", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(side, "SHORT", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(side, "SELL", StringComparison.OrdinalIgnoreCase))
                {
                    return Side.Sell;
                }
            }

            return Side.Buy;
        }

        /// <summary>Рекурсивная оценка узла дерева для входа Op.</summary>
        private static bool Evaluate(
            LogicExpressionNode node,
            BotTabSimple tab,
            List<Candle> candles,
            int candleIndex,
            bool forClose,
            FindIndicatorHandler findIndicator)
        {
            if (node == null || tab == null || candles == null || findIndicator == null)
            {
                return false;
            }

            if (node is LogicAtomNode atomNode)
            {
                return EvaluateAtom(atomNode.Atom, tab, candles, candleIndex, forClose, findIndicator);
            }

            if (node is LogicCombineNode combine)
            {
                bool left = Evaluate(combine.Left, tab, candles, candleIndex, forClose, findIndicator);
                bool right = Evaluate(combine.Right, tab, candles, candleIndex, forClose, findIndicator);
                return combine.Op == LogicCombineOp.And ? left && right : left || right;
            }

            if (node is LogicNotNode notNode)
            {
                return !Evaluate(notNode.Inner, tab, candles, candleIndex, forClose, findIndicator);
            }

            return false;
        }

        /// <summary>Рекурсивная оценка Cl: Cl[-] пропускается; фильтр ATR с Cl[-] проверяется по Op[GrOk].</summary>
        private static bool? EvaluateCloseNode(
            LogicExpressionNode node,
            BotTabSimple tab,
            List<Candle> candles,
            int candleIndex,
            FindIndicatorHandler findIndicator)
        {
            if (node == null || tab == null || candles == null || findIndicator == null)
            {
                return false;
            }

            if (node is LogicAtomNode atomNode)
            {
                return EvaluateAtomClose(atomNode.Atom, tab, candles, candleIndex, findIndicator);
            }

            if (node is LogicCombineNode combine)
            {
                bool? left = EvaluateCloseNode(combine.Left, tab, candles, candleIndex, findIndicator);
                bool? right = EvaluateCloseNode(combine.Right, tab, candles, candleIndex, findIndicator);
                return combine.Op == LogicCombineOp.And
                    ? CombineCloseAnd(left, right)
                    : CombineCloseOr(left, right);
            }

            if (node is LogicNotNode notNode)
            {
                bool? inner = EvaluateCloseNode(notNode.Inner, tab, candles, candleIndex, findIndicator);
                return inner.HasValue ? (bool?)!inner.Value : null;
            }

            return false;
        }

        private static bool? CombineCloseAnd(bool? left, bool? right)
        {
            if (!left.HasValue && !right.HasValue)
            {
                return null;
            }

            if (!left.HasValue)
            {
                return right;
            }

            if (!right.HasValue)
            {
                return left;
            }

            return left.Value && right.Value;
        }

        private static bool? CombineCloseOr(bool? left, bool? right)
        {
            if (!left.HasValue && !right.HasValue)
            {
                return null;
            }

            if (!left.HasValue)
            {
                return right;
            }

            if (!right.HasValue)
            {
                return left;
            }

            return left.Value || right.Value;
        }

        /// <summary>Оценка одного атома для выхода Cl.</summary>
        private static bool? EvaluateAtomClose(
            LogicAtom atom,
            BotTabSimple tab,
            List<Candle> candles,
            int candleIndex,
            FindIndicatorHandler findIndicator)
        {
            if (atom == null)
            {
                return false;
            }

            string signal = atom.CloseSignal;
            if (IsNeutralCloseSignal(signal))
            {
                if (ShouldApplyOpenFilterOnClose(atom))
                {
                    signal = atom.OpenSignal;
                }
                else
                {
                    return null;
                }
            }

            if (string.IsNullOrWhiteSpace(signal))
            {
                return null;
            }

            Aindicator indicator = findIndicator(tab, atom);
            if (indicator == null)
            {
                return false;
            }

            return InvertAtomSignalResult(
                atom,
                LogicSignalEvaluator.Evaluate(signal, atom, indicator, candles, tab, candleIndex));
        }

        private static bool? InvertAtomSignalResult(LogicAtom atom, bool? value)
        {
            if (!value.HasValue)
            {
                return null;
            }

            bool result = value.Value;
            if (atom != null && atom.InvertSignals)
            {
                result = !result;
            }

            return result;
        }

        private static bool InvertAtomSignalResult(LogicAtom atom, bool value)
        {
            if (atom != null && atom.InvertSignals)
            {
                return !value;
            }

            return value;
        }

        /// <summary>Cl[-]: для ATR-фильтра на выходе оставляем Op[GrOk] (как в TrendMultiIndicator).</summary>
        private static bool ShouldApplyOpenFilterOnClose(LogicAtom atom)
        {
            if (atom == null || string.IsNullOrWhiteSpace(atom.OpenSignal))
            {
                return false;
            }

            if (atom.Kind == LogicIndicatorKind.Atr)
            {
                return true;
            }

            string open = atom.OpenSignal?.Replace(" ", "").ToUpperInvariant() ?? "";
            return open.Contains("GROK")
                || open.Contains("@")
                || open.Contains("+")
                || open.Contains("&&")
                || open.Contains("||")
                || open.Contains("!");
        }

        /// <summary>Оценка одного атома: выбор Op или Cl и вызов LogicSignalEvaluator.</summary>
        private static bool EvaluateAtom(
            LogicAtom atom,
            BotTabSimple tab,
            List<Candle> candles,
            int candleIndex,
            bool forClose,
            FindIndicatorHandler findIndicator)
        {
            if (atom == null)
            {
                return false;
            }

            string signal = forClose ? atom.CloseSignal : atom.OpenSignal;
            if (forClose && IsNeutralCloseSignal(signal))
            {
                return false;
            }

            if (string.IsNullOrWhiteSpace(signal))
            {
                return false;
            }

            Aindicator indicator = findIndicator(tab, atom);
            if (indicator == null)
            {
                return false;
            }

            return InvertAtomSignalResult(
                atom,
                LogicSignalEvaluator.Evaluate(signal, atom, indicator, candles, tab, candleIndex));
        }

        /// <summary>true, если Cl[-] / пусто / none — атом не участвует в выходе.</summary>
        private static bool IsNeutralCloseSignal(string signal)
        {
            if (string.IsNullOrWhiteSpace(signal))
            {
                return true;
            }

            string trimmed = signal.Trim();
            return trimmed == "-"
                || string.Equals(trimmed, "none", StringComparison.OrdinalIgnoreCase);
        }
    }

    /// <summary>
    /// Проверка кодов сигналов Op/Cl на свече: Ab, Bl, GrOk, K>=, MACD, LinReg и пороги индикаторов.
    /// </summary>
    public static class LogicSignalEvaluator
    {
        /// <summary>
        /// Минимальная длина истории для индикатора атома (для GetMinBarsForTrading).
        /// </summary>
        /// <param name="atom">Атом логики.</param>
        public static int GetMinBarsRequired(LogicAtom atom)
        {
            if (atom == null)
            {
                return 20;
            }

            switch (atom.Kind)
            {
                case LogicIndicatorKind.Sma:
                    return atom.GetIntParam("L", 100);
                case LogicIndicatorKind.Stoch:
                    return atom.GetIntParam("P1", 14) + atom.GetIntParam("P2", 3) + atom.GetIntParam("P3", 3);
                case LogicIndicatorKind.Atr:
                    return atom.GetIntParam("L", 14) + atom.GetIntParam("Lb", 5);
                case LogicIndicatorKind.Rsi:
                    return atom.GetIntParam("L", 14);
                case LogicIndicatorKind.Cci:
                    return atom.GetIntParam("L", 20) + 1;
                case LogicIndicatorKind.Macd:
                    return atom.GetIntParam("Slow", 26) + atom.GetIntParam("Signal", 9);
                case LogicIndicatorKind.LinReg:
                    return atom.GetLinRegLength() + atom.GetIntParam("SlopeLb", 3);
                case LogicIndicatorKind.Bollinger:
                    return atom.GetIntParam("L", 100);
                case LogicIndicatorKind.Momentum:
                    return atom.GetIntParam("L", 15);
                default:
                    return 20;
            }
        }

        /// <summary>
        /// Главная точка: true, если сигнал signalCode выполнен на свече candleIndex.
        /// </summary>
        /// <param name="signalCode">Код из Op[…] или Cl[…].</param>
        /// <param name="atom">Атом (пороги Lmin, Gr, Lb…).</param>
        /// <param name="indicator">Экземпляр индикатора на вкладке.</param>
        /// <param name="candles">Свечи.</param>
        /// <param name="tab">Вкладка (зарезервировано для расширений).</param>
        /// <param name="candleIndex">Индекс свечи.</param>
        public static bool Evaluate(
            string signalCode,
            LogicAtom atom,
            Aindicator indicator,
            List<Candle> candles,
            BotTabSimple tab,
            int candleIndex)
        {
            if (atom == null || indicator == null || candles == null || string.IsNullOrWhiteSpace(signalCode))
            {
                return false;
            }

            if (candleIndex < 0 || candleIndex >= candles.Count)
            {
                return false;
            }

            string work = signalCode.Trim();
            while (work.Length >= 2
                   && work[0] == '('
                   && LogicLineParser.TryExtractSignalOuterParentheses(work, out string unwrapped))
            {
                work = unwrapped.Trim();
            }

            if (LogicLineParser.SignalExpressionHasOperators(work))
            {
                return EvaluateSignalExpression(work, atom, indicator, candles, tab, candleIndex);
            }

            return EvaluateSingleSignal(NormalizeSignal(work), atom, indicator, candles, tab, candleIndex);
        }

        /// <summary>Составное Op/Cl: ||, &&, NOT/! (приоритет как в JS).</summary>
        private static bool EvaluateSignalExpression(
            string signalCode,
            LogicAtom atom,
            Aindicator indicator,
            List<Candle> candles,
            BotTabSimple tab,
            int candleIndex)
        {
            List<string> orParts = LogicLineParser.SplitSignalExpressionAtTopLevel(signalCode, LogicCombineOp.Or);
            if (orParts.Count > 1)
            {
                for (int i = 0; i < orParts.Count; i++)
                {
                    if (EvaluateSignalAndExpression(orParts[i], atom, indicator, candles, tab, candleIndex))
                    {
                        return true;
                    }
                }

                return false;
            }

            return EvaluateSignalAndExpression(signalCode, atom, indicator, candles, tab, candleIndex);
        }

        private static bool EvaluateSignalAndExpression(
            string signalCode,
            LogicAtom atom,
            Aindicator indicator,
            List<Candle> candles,
            BotTabSimple tab,
            int candleIndex)
        {
            List<string> andParts = LogicLineParser.SplitSignalExpressionAtTopLevel(signalCode, LogicCombineOp.And);
            if (andParts.Count > 1)
            {
                for (int i = 0; i < andParts.Count; i++)
                {
                    if (!EvaluateSignalNotExpression(andParts[i], atom, indicator, candles, tab, candleIndex))
                    {
                        return false;
                    }
                }

                return true;
            }

            return EvaluateSignalNotExpression(signalCode, atom, indicator, candles, tab, candleIndex);
        }

        private static bool EvaluateSignalNotExpression(
            string signalCode,
            LogicAtom atom,
            Aindicator indicator,
            List<Candle> candles,
            BotTabSimple tab,
            int candleIndex)
        {
            string fragment = signalCode?.Trim() ?? "";
            bool invert = false;
            while (LogicLineParser.TryStripSignalLeadingNot(ref fragment))
            {
                invert = !invert;
            }

            while (fragment.Length >= 2
                   && fragment[0] == '('
                   && LogicLineParser.TryExtractSignalOuterParentheses(fragment, out string inner))
            {
                fragment = inner.Trim();
            }

            bool result;
            if (LogicLineParser.SignalExpressionHasOperators(fragment))
            {
                result = EvaluateSignalExpression(fragment, atom, indicator, candles, tab, candleIndex);
            }
            else
            {
                result = EvaluateSingleSignal(NormalizeSignal(fragment), atom, indicator, candles, tab, candleIndex);
            }

            return invert ? !result : result;
        }

        /// <summary>Один код сигнала после нормализации (без &&/||/NOT).</summary>
        private static bool EvaluateSingleSignal(
            string signal,
            LogicAtom atom,
            Aindicator indicator,
            List<Candle> candles,
            BotTabSimple tab,
            int candleIndex)
        {
            if (signal.Length == 0 || signal == "-" || signal == "NONE")
            {
                return false;
            }

            decimal close = candles[candleIndex].Close;

            if (atom.Kind == LogicIndicatorKind.Atr
                && (signal == "GROK" || signal.Contains("@") || signal.StartsWith("+", StringComparison.Ordinal)))
            {
                return EvaluateAtrGrowth(atom, indicator, candleIndex, signal);
            }

            switch (signal)
            {
                case "AB":
                    return CloseAbove(indicator, 0, close, candleIndex);
                case "BL":
                    return CloseBelow(indicator, 0, close, candleIndex);
                case "ABUP":
                    return CloseAbove(indicator, 0, close, candleIndex);
                case "BLUP":
                    return CloseBelow(indicator, 0, close, candleIndex);
                case "BLLO":
                    return CloseBelow(indicator, 2, close, candleIndex);
                case "ABLO":
                    return CloseAbove(indicator, 2, close, candleIndex);
                case "ABMID":
                    return CloseAboveBollMid(indicator, close, candleIndex);
                case "BLMID":
                    return CloseBelowBollMid(indicator, close, candleIndex);
                case "MACD>SIG":
                    return MacdAboveSignal(indicator, candleIndex);
                case "MACD<SIG":
                    return MacdBelowSignal(indicator, candleIndex);
                case "SLOPEUP":
                case "REGUP":
                case "CENTERUP":
                    return LinRegCenterSlopeUp(atom, indicator, candleIndex);
                case "SLOPEDN":
                case "REGDN":
                case "CENTERDN":
                    return LinRegCenterSlopeDown(atom, indicator, candleIndex);
            }

            return EvaluateThresholdSignal(signal, atom, indicator, close, candleIndex);
        }

        /// <summary>LinReg: центр канала (серия 1) вырос за SlopeLb свечей.</summary>
        private static bool LinRegCenterSlopeUp(LogicAtom atom, Aindicator indicator, int candleIndex)
        {
            return TryEvaluateLinRegCenterSlope(atom, indicator, candleIndex, requireUp: true);
        }

        /// <summary>LinReg: центр канала (серия 1) упал за SlopeLb свечей.</summary>
        private static bool LinRegCenterSlopeDown(LogicAtom atom, Aindicator indicator, int candleIndex)
        {
            return TryEvaluateLinRegCenterSlope(atom, indicator, candleIndex, requireUp: false);
        }

        private static bool TryEvaluateLinRegCenterSlope(
            LogicAtom atom,
            Aindicator indicator,
            int candleIndex,
            bool requireUp)
        {
            int sign = LogicRegimeEvaluator.GetSignFromAtom(atom, indicator, candleIndex);
            return requireUp ? sign > 0 : sign < 0;
        }

        /// <summary>Нормализует код сигнала: trim, без пробелов, upper case.</summary>
        private static string NormalizeSignal(string signalCode)
        {
            return signalCode.Trim().Replace(" ", "").ToUpperInvariant();
        }

        /// <summary>Проверяет пороговые сигналы K>=, RSI>=, CCI>=, MOM>= и обратные.</summary>
        private static bool EvaluateThresholdSignal(
            string signal,
            LogicAtom atom,
            Aindicator indicator,
            decimal close,
            int candleIndex)
        {
            if (TryCompareIndicatorThreshold(signal, "K>=", atom, "Lmin", 55m, indicator, 0, candleIndex, greaterOrEqual: true))
            {
                return true;
            }

            if (TryCompareIndicatorThreshold(signal, "K<=", atom, "Smax", 45m, indicator, 0, candleIndex, greaterOrEqual: false))
            {
                return true;
            }

            if (TryCompareIndicatorThreshold(signal, "RSI>=", atom, "Lmin", 55m, indicator, 0, candleIndex, greaterOrEqual: true))
            {
                return true;
            }

            if (TryCompareIndicatorThreshold(signal, "RSI<=", atom, "Smax", 45m, indicator, 0, candleIndex, greaterOrEqual: false))
            {
                return true;
            }

            if (TryCompareIndicatorThreshold(signal, "CCI>=", atom, "Lmin", 100m, indicator, 0, candleIndex, greaterOrEqual: true))
            {
                return true;
            }

            if (TryCompareIndicatorThreshold(signal, "CCI<=", atom, "Smax", -100m, indicator, 0, candleIndex, greaterOrEqual: false))
            {
                return true;
            }

            if (TryCompareIndicatorThreshold(signal, "CCI<", atom, "Smax", -100m, indicator, 0, candleIndex, greaterOrEqual: false))
            {
                return true;
            }

            if (TryCompareIndicatorThreshold(signal, "MOM>=", atom, "Lmin", 100m, indicator, 0, candleIndex, greaterOrEqual: true))
            {
                return true;
            }

            if (TryCompareIndicatorThreshold(signal, "MOM<=", atom, "Smax", 100m, indicator, 0, candleIndex, greaterOrEqual: false))
            {
                return true;
            }

            if (TryCompareIndicatorThreshold(signal, "MOM<", atom, "Smax", 100m, indicator, 0, candleIndex, greaterOrEqual: false))
            {
                return true;
            }

            return false;
        }

        /// <summary>Сравнивает значение серии индикатора с порогом из сигнала или Params атома.</summary>
        private static bool TryCompareIndicatorThreshold(
            string signal,
            string prefix,
            LogicAtom atom,
            string paramKey,
            decimal defaultThreshold,
            Aindicator indicator,
            int seriesIndex,
            int candleIndex,
            bool greaterOrEqual)
        {
            if (!signal.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            string tail = signal.Substring(prefix.Length);
            decimal threshold;
            if (string.Equals(tail, "LMIN", StringComparison.OrdinalIgnoreCase)
                || string.Equals(tail, "L", StringComparison.OrdinalIgnoreCase))
            {
                threshold = atom.GetDecimalParam("Lmin", defaultThreshold);
            }
            else if (string.Equals(tail, "SMAX", StringComparison.OrdinalIgnoreCase)
                || string.Equals(tail, "S", StringComparison.OrdinalIgnoreCase))
            {
                threshold = atom.GetDecimalParam("Smax", defaultThreshold);
            }
            else if (!decimal.TryParse(tail, NumberStyles.Number, CultureInfo.InvariantCulture, out threshold))
            {
                return false;
            }

            decimal value = SeriesValueAt(indicator, seriesIndex, candleIndex);
            if (value == 0m)
            {
                return false;
            }

            return greaterOrEqual ? value >= threshold : value <= threshold;
        }

        /// <summary>Фильтр ATR: рост ≥ Gr% относительно значения Lb свечей назад.</summary>
        private static bool EvaluateAtrGrowth(LogicAtom atom, Aindicator indicator, int candleIndex, string signal)
        {
            int lookBack = Math.Max(1, atom.GetIntParam("Lb", 5));
            decimal growPercent = atom.GetDecimalParam("Gr", 3m);

            if (!string.IsNullOrWhiteSpace(signal) && signal != "GROK")
            {
                ParseAtrGrowthShorthand(signal, ref growPercent, ref lookBack);
            }

            if (candleIndex < lookBack)
            {
                return false;
            }

            decimal atrLast = SeriesValueAt(indicator, 0, candleIndex);
            decimal atrPast = SeriesValueAt(indicator, 0, candleIndex - lookBack);
            if (atrLast == 0m || atrPast == 0m)
            {
                return false;
            }

            decimal actualGrow = atrLast / (atrPast / 100m) - 100m;
            return actualGrow >= growPercent;
        }

        /// <summary>Разбирает краткую запись +3%@5 в Gr и Lb.</summary>
        private static void ParseAtrGrowthShorthand(string signal, ref decimal growPercent, ref int lookBack)
        {
            string s = signal.TrimStart('+');
            int atIndex = s.IndexOf('@');
            if (atIndex > 0)
            {
                string growPart = s.Substring(0, atIndex).TrimEnd('%');
                if (decimal.TryParse(growPart, NumberStyles.Number, CultureInfo.InvariantCulture, out decimal grow))
                {
                    growPercent = grow;
                }

                string lbPart = s.Substring(atIndex + 1);
                if (int.TryParse(lbPart, NumberStyles.Integer, CultureInfo.InvariantCulture, out int lb))
                {
                    lookBack = Math.Max(1, lb);
                }
            }
        }

        /// <summary>Close выше значения серии индикатора.</summary>
        private static bool CloseAbove(Aindicator indicator, int seriesIndex, decimal close, int candleIndex)
        {
            decimal line = SeriesValueAt(indicator, seriesIndex, candleIndex);
            return line != 0m && close > line;
        }

        /// <summary>Close ниже значения серии индикатора.</summary>
        private static bool CloseBelow(Aindicator indicator, int seriesIndex, decimal close, int candleIndex)
        {
            decimal line = SeriesValueAt(indicator, seriesIndex, candleIndex);
            return line != 0m && close < line;
        }

        /// <summary>Bollinger: close выше середины полос.</summary>
        private static bool CloseAboveBollMid(Aindicator indicator, decimal close, int candleIndex)
        {
            if (indicator.DataSeries == null || indicator.DataSeries.Count < 2)
            {
                return false;
            }

            decimal up = SeriesValueAt(indicator, 0, candleIndex);
            decimal down = SeriesValueAt(indicator, 1, candleIndex);
            if (up == 0m || down == 0m)
            {
                return false;
            }

            decimal mid = (up + down) / 2m;
            return close > mid;
        }

        /// <summary>Bollinger: close ниже середины полос.</summary>
        private static bool CloseBelowBollMid(Aindicator indicator, decimal close, int candleIndex)
        {
            if (indicator.DataSeries == null || indicator.DataSeries.Count < 2)
            {
                return false;
            }

            decimal up = SeriesValueAt(indicator, 0, candleIndex);
            decimal down = SeriesValueAt(indicator, 1, candleIndex);
            if (up == 0m || down == 0m)
            {
                return false;
            }

            decimal mid = (up + down) / 2m;
            return close < mid;
        }

        /// <summary>MACD: линия MACD выше сигнальной (серии 1 и 2).</summary>
        private static bool MacdAboveSignal(Aindicator indicator, int candleIndex)
        {
            if (indicator.DataSeries == null || indicator.DataSeries.Count < 3)
            {
                return false;
            }

            decimal macdLine = SeriesValueAt(indicator, 1, candleIndex);
            decimal signalLine = SeriesValueAt(indicator, 2, candleIndex);
            return macdLine != 0m && signalLine != 0m && macdLine > signalLine;
        }

        /// <summary>MACD: линия MACD ниже сигнальной.</summary>
        private static bool MacdBelowSignal(Aindicator indicator, int candleIndex)
        {
            if (indicator.DataSeries == null || indicator.DataSeries.Count < 3)
            {
                return false;
            }

            decimal macdLine = SeriesValueAt(indicator, 1, candleIndex);
            decimal signalLine = SeriesValueAt(indicator, 2, candleIndex);
            return macdLine != 0m && signalLine != 0m && macdLine < signalLine;
        }

        /// <summary>Значение серии индикатора на свече; при index &lt; 0 — Last.</summary>
        public static decimal SeriesValueAtPublic(Aindicator indicator, int seriesIndex, int candleIndex)
        {
            return SeriesValueAt(indicator, seriesIndex, candleIndex);
        }

        private static decimal SeriesValueAt(Aindicator indicator, int seriesIndex, int candleIndex)
        {
            if (indicator?.DataSeries == null || seriesIndex >= indicator.DataSeries.Count)
            {
                return 0m;
            }

            IndicatorDataSeries series = indicator.DataSeries[seriesIndex];
            if (series?.Values == null || series.Values.Count == 0)
            {
                return 0m;
            }

            if (candleIndex < 0 || candleIndex >= series.Values.Count)
            {
                return series.Last;
            }

            return series.Values[candleIndex];
        }
    }

    #endregion


    /*
     * ////////////////////////////////////////////////////////////////////////////////
     * ////////////////////////////////////////////////////////////////////////////////
     * ////////////////////////////////////////////////////////////////////////////////
     * БЛОК 3 — СПРАВКА (HELP): ТЕКСТ И HTML-ФАЙЛ
     * MultiLogic_LogicHelp.html · BuildDefaultHelpText / BuildDefaultHelpHtml · подсветка формул.
     * ////////////////////////////////////////////////////////////////////////////////
     * ////////////////////////////////////////////////////////////////////////////////
     * ////////////////////////////////////////////////////////////////////////////////
     */
    #region БЛОК 3 — СПРАВКА (MultiLogic_LogicHelp.html)

    /// <summary>Генерация plain-текста и HTML-справки по строкам логики MultiLogic.</summary>
    public static class MultiLogicHelpBuilder
    {
        /// <summary>Версия HTML-справки; при изменении структуры или текста — увеличить (форсирует перезапись файла).</summary>
        private const string LogicHelpFormatVersion = "7";

        /// <summary>Текст справки (plain) — источник для HTML; также для отладки.</summary>
        public static string BuildDefaultHelpText()
        {
            var sb = new StringBuilder();
            sb.AppendLine("MultiLogic — справка по строкам логики");
            sb.AppendLine("(файл Custom\\Robots\\MultiLogic_LogicHelp.html — автоматически из MultiLogic.cs;");
            sb.AppendLine(" обновляется при запуске робота и по кнопке Help; ручные правки перезаписываются)");
            sb.AppendLine();
            AppendResourceHelp(sb);
            sb.AppendLine("0) Отключение логики (только в самом начале строки, до AND/OR/&&/||):");
            sb.AppendLine("   Disabled(true)   — логика отключена, индикаторы не создаются");
            sb.AppendLine("   Disabled(false)  — явно включена (то же, что без префикса)");
            sb.AppendLine("   Disable(true/false) — синоним Disabled");
            sb.AppendLine("   Без префикса Disabled — логика включена.");
            sb.AppendLine("   Нельзя внутри скобок фрагмента или после AND/OR/&&/|| — только в начале, без внешних скобок.");
            sb.AppendLine("   Примеры:");
            sb.AppendLine("     Disabled(true) SMA(100) Op[Ab] Cl[Bl]");
            sb.AppendLine("     Disabled(false) (SMA(100) Op[Ab]) AND (ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-])");
            sb.AppendLine();
            sb.AppendLine("0a) Strict — строгость отбора (необязательно, в начале строки, после Disabled, до Regime):");
            sb.AppendLine("   Strict(@Strict) — значение из параметра «Strict (строгость)» на вкладке «Логики» (как @LR).");
            sb.AppendLine("   Strict(4)       — явное 1…5 для этой строки (не зависит от параметра робота).");
            sb.AppendLine("   Без Strict(…)   — используется параметр робота. Подробно — раздел «6b) Strict».");
            sb.AppendLine("   Пример: Strict(@Strict) Regime(LinReg;L=@LR;…) (SMA(100) Op[Ab] Cl[Bl]) …");
            sb.AppendLine();
            sb.AppendLine("0b) Regime — режим наклона LinReg (необязательно, только в начале строки, после Disabled и Strict):");
            sb.AppendLine("   Regime(LinReg;L=@LR;Dev=2;SlopeLb=5;SlopeDead=0.05%;OnFlip=Close;Entry=MatchSide;OnFlat=Close)");
            sb.AppendLine("   Entry=MatchSide  — Buy при наклоне вверх, Sell вниз; во флэте входа нет");
            sb.AppendLine("   Entry=FlatOnly   — вход только во флэте (|Δ| ≤ SlopeDead); при выходе из флэта — RegimeFlip");
            sb.AppendLine("   OnFlip=Close     — закрыть, если наклон против Side (MatchSide) или вышли из флэта (FlatOnly)");
            sb.AppendLine("   OnFlat=Close     — MatchSide: закрыть позицию во флэте; OnFlat=Keep — не закрывать во флэте (FlatOnly)");
            sb.AppendLine("   SlopeLb=5        — сравнить центр канала (серия 1) с центром N свечей назад");
            sb.AppendLine("   SlopeDead=0.05%  — мёртвая зона |Δцентра|; внутри — флэт");
            sb.AppendLine("   Regime(Auto;OnFlip=Close;Entry=MatchSide) — параметры из первого LinReg с Op[SlopeUp/Dn] в строке");
            sb.AppendLine("   Op[SlopeUp] / Op[SlopeDn] в атоме LinReg — альтернатива Entry=MatchSide внутри AND");
            sb.AppendLine("   L1/L3: Regime(…;SlopeLb=3;OnFlip=Close;Entry=MatchSide) — Buy при наклоне вверх, Sell вниз.");
            sb.AppendLine("   L2/L4: Regime(…;SlopeLb=3;SlopeDead=0.05%;OnFlip=Close;Entry=FlatOnly) — вход только во флэте; выход при тренде.");
            sb.AppendLine("   SlopeDead и OnFlat в defaults не заданы — можно добавить вручную (см. параметры Regime выше).");
            sb.AppendLine();
            sb.AppendLine("1) Составная логика (скобки обязательны вокруг каждого фрагмента):");
            sb.AppendLine("   (SMA(100) Op[Ab] Cl[Bl]) AND (Stoch(14-3-3;Lmin=55;Smax=45) Op[K>=55] Cl[K<=45])");
            sb.AppendLine("   (SMA(100) Op[Ab] Cl[Bl]) && (Stoch(14-3-3;Lmin=55;Smax=45) Op[K>=55] Cl[K<=45])");
            sb.AppendLine("   (SMA(100) Op[Ab]) OR (SMA(100) Side[S] Op[Bl] Cl[Ab])");
            sb.AppendLine("   (SMA(100) Op[Ab]) || (SMA(100) Side[S] Op[Bl] Cl[Ab])");
            sb.AppendLine("   NOT LinReg(@LR;Dev=2) Op[AbUp] Cl[BlLo]  — инверсия Op/Cl атома (не Buy↔Sell)");
            sb.AppendLine("   (SMA(100) Op[Ab] Cl[Bl]) && NOT (LinReg(@LR;Dev=2) Op[AbUp] Cl[BlLo])");
            sb.AppendLine("   Приоритет между фрагментами: || / OR, затем && / AND, затем NOT / !, затем атом.");
            sb.AppendLine("   Подробно — раздел «1a) Логические операторы» ниже.");
            sb.AppendLine();
            AppendLogicOperatorsHelp(sb);
            sb.AppendLine("2) Один атом (скобки необязательны):");
            sb.AppendLine("   <Индикатор>(параметры) [Side:L|S] Op[вход] Cl[выход] [SL[…]] [TP[…]] Note(пояснение)");
            sb.AppendLine("   NOT / ! / NOT- перед именем индикатора — инверсия Op/Cl (true↔false), Side не меняется.");
            sb.AppendLine("   Note(…) — только для человека, на исполнение и график не влияет. Лучше в конце строки.");
            sb.AppendLine("   (Парсер также понимает устаревшие теги Коммент(…) и Cm(…).)");
            sb.AppendLine();
            sb.AppendLine("3) Параметры индикатора (общие правила):");
            sb.AppendLine("   позиционно: Stoch(14-3-3), SMA(100), ATR(14;+3%;@5)");
            sb.AppendLine("   именованно: Stoch(K1=14,K2=3,D=3,Lmin=55,Smax=45), SMA(L=100,Src=Close)");
            sb.AppendLine();
            sb.AppendLine("4) Сигналы Op / Cl (как TrendMultiIndicatorScreener):");
            sb.AppendLine("   Ab — close выше линии; Bl — close ниже; GrOk — ATR вырос (фильтр);");
            sb.AppendLine("   K>=55 / K<=45 — стохастик; K>=Lmin / K<=Smax — пороги из параметров;");
            sb.AppendLine("   CCI>=100 / CCI<=-100 — CCI (пороги Lmin/Smax в строке);");
            sb.AppendLine("   Macd>Sig / Macd<Sig — линия MACD выше/ниже сигнальной;");
            sb.AppendLine("   AbUp / BlUp — close выше/ниже верхней линии LinReg; Cl[-] — отдельного Cl нет (ATR: на выходе всё равно Op[GrOk]).");
            sb.AppendLine("   Составные Op/Cl с !, NOT, &&, || — см. раздел «1a) Логические операторы».");
            sb.AppendLine();
            sb.AppendLine("5) SL / TP (необязательно, в той же строке):");
            sb.AppendLine("   SL[2%] TP[6%]  — процент от входа; SL[1.5ATR]; TP[2R] (R — кратность к расстоянию SL).");
            sb.AppendLine("   В одной логике несколько атомов: самый жёсткий SL, самый дальний TP.");
            sb.AppendLine("   ATR для SL[…ATR] — из первого ATR-атома той же логики.");
            sb.AppendLine();
            sb.AppendLine("6) Слоты «Логика 1…10»: при изменении любой строки робот перечитывает все 10 параметров.");
            sb.AppendLine("   Непустая включённая логика — её индикаторы добавляются в общий набор.");
            sb.AppendLine("   Одинаковые индикатор с теми же параметрами в разных логиках — один экземпляр на графике.");
            sb.AppendLine("   Другие параметры — отдельный индикатор. Пустые/Disabled логики индикаторы не добавляют.");
            sb.AppendLine("   Номера индикаторов: 101 … " + LogicLineParser.MaxManagedLogicIndicatorNum + " (общий пул, без дублей).");
            sb.AppendLine();
            MultiLogicDefaultLogics.AppendHelpSection6a(sb);
            sb.AppendLine("6b) Strict (строгость отбора) — параметр на вкладке «Логики», целое 1…5, по умолчанию 3.");
            sb.AppendLine("   В начале строки (после Disabled, до Regime): Strict(@Strict) или Strict(4).");
            sb.AppendLine("   @Strict — токен параметра робота (как @LR для длины LinReg); число 1…5 — фиксированная строгость логики.");
            sb.AppendLine("   Без префикса Strict(…) используется параметр «Strict (строгость)».");
            sb.AppendLine("   1–2 — мягче (больше сделок); 4–5 — строже (меньше сделок); 3 — пороги в тексте без масштабирования.");
            sb.AppendLine("   В строке хранятся нейтральные пороги (как при strict=3); парсер масштабирует Lmin/Smax/Gr/SlopeDead/Dev");
            sb.AppendLine("   и числа в Op/Cl (CCI, K, RSI, MOM) при разборе. Кнопки ±1 меняют параметр и сразу перепарсивают логики.");
            sb.AppendLine("   Пример: Strict(@Strict) Regime(LinReg;L=@LR;…) (SMA(100) Op[Ab] Cl[Bl]) …");
            sb.AppendLine("   Для одной логики жёстче остальных: Strict(5) … (остальные с Strict(@Strict) или без префикса).");
            sb.AppendLine("================================================================================");
            sb.AppendLine("7) СПРАВОЧНИК ИНДИКАТОРОВ — как записывать (полный набор)");
            sb.AppendLine("================================================================================");
            sb.AppendLine();
            AppendSmaHelp(sb);
            AppendStochHelp(sb);
            AppendAtrHelp(sb);
            AppendLinRegHelp(sb);
            AppendMacdHelp(sb);
            AppendCciHelp(sb);
            AppendRsiHelp(sb);
            AppendBollingerHelp(sb);
            AppendMomentumHelp(sb);
            AppendVwapHelp(sb);
            sb.AppendLine("================================================================================");
            sb.AppendLine("8) Торговля (Regime = On)");
            sb.AppendLine("================================================================================");
            sb.AppendLine("   На каждой закрытой свече каждой вкладки скринера проверяются все не-Disabled логики.");
            sb.AppendLine("   Вход: срабатывает составное выражение по Op[…] (||/OR, &&/AND, NOT/! между фрагментами).");
            sb.AppendLine("   Выход: по Cl[…] (те же операторы внутри Cl[…] и NOT у атома); Cl[-] — атом не задаёт направленный выход.");
            sb.AppendLine("   Side[S] — шорт (Sell), иначе лонг (Buy). Позиция: сигнал MultiLogic_L1 … MultiLogic_L10.");
            sb.AppendLine("   «Инверсия логики (покупка ↔ продажа)» (вкладка «Логики», по умолчанию выкл.): как в TrendMultiIndicatorScreener —");
            sb.AppendLine("   bull↔bear: вход по Cl[…] вместо Op[…], выход по Op[…] вместо Cl[…], Buy↔Sell (NOT в строке не меняется).");
            sb.AppendLine("   Volume — общий объём; при нескольких входах на одной свече делится поровну между логиками.");
            sb.AppendLine("   Max positions (all tabs) — лимит открытых позиций робота на скринере.");
            sb.AppendLine("   Нехватка слотов: входят логики с меньшим номером (1 раньше 10), остальные пропускаются.");
            sb.AppendLine("   SL/TP: на закрытии свечи проверяется close vs уровни из SL[…]/TP[…] строки логики позиции.");
            sb.AppendLine("   Пробой SL — закрытие с сигналом …_SL; пробой TP — …_TP; иначе выход по Cl[…].");
            return sb.ToString();
        }

        /// <summary>Полное описание NOT, &&, || между фрагментами и внутри Op/Cl.</summary>
        private static void AppendLogicOperatorsHelp(StringBuilder sb)
        {
            sb.AppendLine("1a) Логические операторы (NOT, &&, || — в стиле JavaScript)");
            sb.AppendLine("--------------------------------------------------------------------------------");
            sb.AppendLine();
            sb.AppendLine("A) Между фрагментами (скобочные атомы в одной строке «Логика N»):");
            sb.AppendLine("   OR  — слово OR с пробелами, или оператор ||");
            sb.AppendLine("   AND — слово AND с пробелами, или оператор &&");
            sb.AppendLine("   NOT — префикс NOT, NOT- или ! перед фрагментом (атом или (подвыражение))");
            sb.AppendLine("   Приоритет (как в JS): сначала ||, затем &&, затем NOT/!, затем атом.");
            sb.AppendLine("   Скобки (…) группируют подвыражение: NOT ((A) && (B)).");
            sb.AppendLine();
            sb.AppendLine("   Примеры между фрагментами:");
            sb.AppendLine("     (SMA(100) Op[Ab] Cl[Bl]) && (ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-])");
            sb.AppendLine("     (SMA(100) Op[Ab] Cl[Bl]) || (SMA(100) Side[S] Op[Bl] Cl[Ab])");
            sb.AppendLine("     NOT LinReg(@LR;Dev=2) Op[AbUp] Cl[BlLo]");
            sb.AppendLine("     !LinReg(@LR;Dev=2) Op[AbUp] Cl[BlLo]          — то же, что NOT");
            sb.AppendLine("     (SMA(100) Op[Ab] Cl[Bl]) && NOT (LinReg(@LR;Dev=2) Op[AbUp] Cl[BlLo])");
            sb.AppendLine();
            sb.AppendLine("B) NOT у всего атома (перед именем индикатора, после Side/SL/TP/Note):");
            sb.AppendLine("   NOT / ! / NOT- перед SMA, LinReg, Stoch… инвертирует логический результат Op и Cl");
            sb.AppendLine("   (true↔false). Side[S]/Side[L] и Buy/Sell НЕ меняются — только «сработало / не сработало».");
            sb.AppendLine("   Пример: NOT LinReg(@LR;Dev=2) Op[AbUp] Cl[BlLo]");
            sb.AppendLine("   → если AbUp без NOT был бы true — вход по этому атому блокируется (ни Buy, ни Sell);");
            sb.AppendLine("   → если AbUp без NOT был бы false — условие Op становится true (вход возможен, сторона как в Side).");
            sb.AppendLine("   Cl инвертируется так же: Cl сработал ↔ Cl не сработал. Это не шорт вместо лонга.");
            sb.AppendLine("   Переворот Buy↔Sell и Op↔Cl — «Инверсия логики» или «Инверсия» для PnlSMA<0 при металогике; NOT не меняет Side.");
            sb.AppendLine("   Можно комбинировать с NOT между фрагментами: NOT (NOT LinReg(...) Op[AbUp]) — двойное отрицание.");
            sb.AppendLine();
            sb.AppendLine("C) Внутри Op[…] и Cl[…] (только сигналы ЭТОГО индикатора атома):");
            sb.AppendLine("   ! или NOT перед кодом сигнала — отрицание одного условия");
            sb.AppendLine("   && или AND — оба условия должны выполниться");
            sb.AppendLine("   || или OR  — достаточно одного условия");
            sb.AppendLine("   Приоритет внутри Op/Cl: ||, затем &&, затем !/NOT, затем код сигнала.");
            sb.AppendLine("   Скобки внутри Op/Cl: Op[(AbUp||AbLo) && !BlLo].");
            sb.AppendLine();
            sb.AppendLine("   Примеры внутри Op/Cl (LinReg):");
            sb.AppendLine("     Op[AbUp]                  — close выше верхней линии");
            sb.AppendLine("     Op[!AbUp]  Op[NOT AbUp]   — close НЕ выше верхней");
            sb.AppendLine("     Op[AbUp && AbLo]         — выше верхней И выше нижней (сильный тренд в канале)");
            sb.AppendLine("     Op[AbUp || AbLo]          — выше верхней ИЛИ выше нижней");
            sb.AppendLine("     Op[(AbUp||AbLo) && !BlUp] — (выше верхней или нижней) и не ниже верхней");
            sb.AppendLine("     Cl[BlLo]  Cl[!BlLo]       — выход по обычному или инвертированному BlLo");
            sb.AppendLine();
            sb.AppendLine("   Примеры (Stoch): Op[K>=55 && K<=80]  Cl[K<=45 || K>=90]");
            sb.AppendLine("   Примеры (CCI):  Op[CCI>=100]  Cl[CCI<=-100]  Op[!CCI>=100]");
            sb.AppendLine();
            sb.AppendLine("D) Что НЕ смешивается:");
            sb.AppendLine("   Внутри одного Op[…] нельзя ссылаться на другой индикатор (MACD>Sig только в атоме MACD).");
            sb.AppendLine("   Disabled(…) — только в самом начале строки логики, не внутри Op/Cl.");
            sb.AppendLine("   SL/TP не поддерживают &&/|| — только один уровень SL[…] TP[…] на атом.");
            sb.AppendLine();
            sb.AppendLine("E) Таблица записи (эквиваленты):");
            sb.AppendLine("   ИЛИ между фрагментами     OR          ||");
            sb.AppendLine("   И между фрагментами       AND         &&");
            sb.AppendLine("   НЕ фрагмент               NOT  NOT-  !");
            sb.AppendLine("   НЕ сигнал в Op/Cl         NOT AbUp    !AbUp");
            sb.AppendLine();
        }

        /// <summary>Алиас BuildDefaultHelpText() для обратной совместимости.</summary>
        public static string GetHelpText() => BuildDefaultHelpText();

        /// <summary>HTML-справка (светлая тема) для MultiLogic_LogicHelp.html.</summary>
        public static string BuildDefaultHelpHtml()
        {
            var toc = new List<(string id, string title)>();
            string body = ConvertHelpPlainTextToHtml(BuildDefaultHelpText(), toc);
            return WrapLogicHelpHtmlDocument(body, toc);
        }

        private static string WrapLogicHelpHtmlDocument(string bodyHtml, List<(string id, string title)> toc)
        {
            var sb = new StringBuilder(bodyHtml.Length + 4096);
            sb.AppendLine("<!DOCTYPE html>");
            sb.AppendLine("<html lang=\"ru\">");
            sb.AppendLine("<head>");
            sb.AppendLine("<meta charset=\"utf-8\">");
            sb.AppendLine("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">");
            sb.AppendLine("<title>MultiLogic — справка по строкам логики</title>");
            sb.AppendLine("<style>");
            AppendLogicHelpHtmlStyles(sb);
            sb.AppendLine("</style>");
            sb.AppendLine("</head>");
            sb.AppendLine("<body>");
            sb.AppendLine("<header class=\"help-hdr\">");
            sb.AppendLine("<h1>MultiLogic — справка по строкам логики</h1>");
            sb.AppendLine("<p class=\"help-sub\">Светлая HTML-версия · файл <code>Custom\\Robots\\MultiLogic_LogicHelp.html</code> · "
                + "генерируется автоматически из <code>MultiLogic.cs</code></p>");
            sb.AppendLine("<p class=\"help-sub\">Версия справки: "
                + LogicHelpFormatVersion
                + " · обновлено: "
                + DateTime.Now.ToString("dd.MM.yyyy HH:mm", CultureInfo.InvariantCulture)
                + "</p>");
            sb.AppendLine("</header>");
            sb.AppendLine("<div class=\"help-layout\">");
            if (toc.Count > 0)
            {
                sb.AppendLine("<nav class=\"help-toc\" aria-label=\"Содержание\">");
                sb.AppendLine("<div class=\"help-toc-title\">Содержание</div>");
                sb.AppendLine("<ol>");
                for (int i = 0; i < toc.Count; i++)
                {
                    sb.AppendLine("<li><a href=\"#"
                        + HelpHtmlEncode(toc[i].id)
                        + "\">"
                        + HelpHtmlEncode(toc[i].title)
                        + "</a></li>");
                }

                sb.AppendLine("</ol>");
                sb.AppendLine("</nav>");
            }

            sb.AppendLine("<main class=\"help-main\">");
            sb.Append(bodyHtml);
            sb.AppendLine("</main>");
            sb.AppendLine("</div>");
            sb.AppendLine("<footer class=\"help-ftr\">MultiLogic · OsEngine Custom Robots · справка только для чтения (правки в коде робота)</footer>");
            sb.AppendLine("</body>");
            sb.AppendLine("</html>");
            return sb.ToString();
        }

        private static void AppendLogicHelpHtmlStyles(StringBuilder sb)
        {
            sb.AppendLine(":root{--bg:#f4f6fa;--paper:#fff;--text:#1a1d26;--muted:#5c6370;--border:#dde2eb;--accent:#2563eb;--accent-soft:#eef4ff;--code-bg:#eef1f6;--example-bg:#f0f7ff;--example-border:#c7daf5;}");
            sb.AppendLine("*{box-sizing:border-box;}");
            sb.AppendLine("body{margin:0;font-family:Segoe UI,system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);line-height:1.6;font-size:15px;}");
            sb.AppendLine(".help-hdr{background:linear-gradient(180deg,#fff 0%,var(--accent-soft) 100%);border-bottom:1px solid var(--border);padding:1.5rem 1.75rem 1.25rem;}");
            sb.AppendLine(".help-hdr h1{margin:0 0 .4rem;font-size:1.65rem;font-weight:700;color:#111827;}");
            sb.AppendLine(".help-sub{margin:.2rem 0;color:var(--muted);font-size:.92rem;}");
            sb.AppendLine(".help-layout{max-width:1100px;margin:0 auto;padding:1.25rem 1rem 3rem;display:grid;grid-template-columns:240px 1fr;gap:1.5rem;align-items:start;}");
            sb.AppendLine("@media(max-width:860px){.help-layout{grid-template-columns:1fr;}.help-toc{position:static!important;}}");
            sb.AppendLine(".help-toc{position:sticky;top:12px;background:var(--paper);border:1px solid var(--border);border-radius:10px;padding:.85rem 1rem;box-shadow:0 1px 3px rgba(0,0,0,.06);}");
            sb.AppendLine(".help-toc-title{font-weight:600;font-size:.85rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin-bottom:.5rem;}");
            sb.AppendLine(".help-toc ol{margin:0;padding-left:1.15rem;font-size:.88rem;}");
            sb.AppendLine(".help-toc li{margin:.35rem 0;}");
            sb.AppendLine(".help-toc a{color:var(--accent);text-decoration:none;}");
            sb.AppendLine(".help-toc a:hover{text-decoration:underline;}");
            sb.AppendLine(".help-main{background:var(--paper);border:1px solid var(--border);border-radius:12px;padding:1.5rem 1.75rem 2rem;box-shadow:0 1px 4px rgba(0,0,0,.05);}");
            sb.AppendLine(".help-main>h1:first-child{display:none;}");
            sb.AppendLine("h2{font-size:1.28rem;margin:2rem 0 .85rem;padding-bottom:.35rem;border-bottom:2px solid var(--accent);color:#111827;scroll-margin-top:12px;}");
            sb.AppendLine("h2:first-child{margin-top:0;}");
            sb.AppendLine("h3{font-size:1.05rem;margin:1.35rem 0 .6rem;color:#374151;}");
            sb.AppendLine("h3.sec{font-size:1.12rem;color:#1f2937;border-left:4px solid var(--accent);padding-left:.55rem;}");
            sb.AppendLine("h4.def-logic{font-size:1rem;margin:1.1rem 0 .45rem;color:#1e3a5f;border-left:4px solid #d97706;padding-left:.55rem;scroll-margin-top:12px;}");
            sb.AppendLine(".help-toc a.toc-major{font-weight:600;}");
            sb.AppendLine(".help-toc ol ol{margin:.25rem 0 .15rem;padding-left:1rem;font-size:.84rem;}");
            sb.AppendLine("p{margin:.55rem 0;}");
            sb.AppendLine("p.meta{color:var(--muted);font-size:.93rem;}");
            sb.AppendLine("ul{margin:.4rem 0 .75rem;padding-left:1.35rem;}");
            sb.AppendLine("li{margin:.3rem 0;}");
            sb.AppendLine("code{font-family:Consolas,Monaco,monospace;background:var(--code-bg);padding:.12em .38em;border-radius:4px;font-size:.88em;color:#0f172a;}");
            sb.AppendLine(".logic-formula-group{margin:.55rem 0 1.1rem;}");
            sb.AppendLine(".logic-formula{display:block;width:fit-content;max-width:100%;margin:.32rem 0;padding:.48rem .72rem;background:linear-gradient(135deg,#fffbeb 0%,#fff 60%);border:1px solid #e7c96f;border-left:4px solid #d97706;border-radius:8px;box-shadow:0 1px 2px rgba(217,119,6,.1);overflow-x:auto;}");
            sb.AppendLine(".logic-formula-code{font-family:Consolas,\"Courier New\",monospace;font-size:.84rem;font-weight:500;line-height:1.55;white-space:pre-wrap;word-break:break-word;color:#0f172a;}");
            sb.AppendLine(".logic-formula-inline{font-family:Consolas,\"Courier New\",monospace;font-size:.84em;font-weight:500;background:#fffbeb;padding:.1em .42em;border-radius:5px;border:1px solid #e7c96f;white-space:normal;word-break:break-word;}");
            sb.AppendLine(".logic-formula-label{font-weight:600;color:#374151;margin-right:.25rem;}");
            sb.AppendLine(".logic-formula-comment{font-family:Segoe UI,system-ui,sans-serif;font-size:.9rem;color:var(--muted);font-weight:400;}");
            sb.AppendLine(".lf-ind{color:#1d4ed8;font-weight:600;}.lf-op{color:#047857;font-weight:700;}.lf-cl{color:#b91c1c;font-weight:700;}");
            sb.AppendLine(".lf-kw{color:#c2410c;font-weight:700;}.lf-regime{color:#7c3aed;font-weight:600;}.lf-side{color:#0e7490;font-weight:600;}");
            sb.AppendLine(".lf-sl{color:#9333ea;font-weight:600;}.lf-note-tag{color:#64748b;font-weight:600;}");
            sb.AppendLine("pre.example{background:var(--example-bg);border:1px solid var(--example-border);border-radius:8px;padding:.75rem 1rem;margin:.65rem 0 1rem;overflow-x:auto;font-family:Consolas,Monaco,monospace;font-size:.84rem;line-height:1.45;color:#0f172a;white-space:pre-wrap;word-break:break-word;}");
            sb.AppendLine("a{color:var(--accent);}");
            sb.AppendLine(".help-ftr{text-align:center;padding:1.5rem;color:var(--muted);font-size:.82rem;border-top:1px solid var(--border);}");
        }

        private static bool IsHelpMajorSeparatorLine(string trimmed)
        {
            return trimmed.Length >= 8 && trimmed.All(c => c == '=');
        }

        private static string HelpSectionAnchorFromTitle(string title)
        {
            Match numbered = Regex.Match(title, @"^(\d+[a-z]?)\)", RegexOptions.CultureInvariant);
            if (numbered.Success)
            {
                return "topic-" + numbered.Groups[1].Value;
            }

            string slug = Regex.Replace(title.ToLowerInvariant(), @"[^a-z0-9а-яё]+", "-", RegexOptions.CultureInvariant)
                .Trim('-');
            if (slug.Length > 48)
            {
                slug = slug.Substring(0, 48).Trim('-');
            }

            return string.IsNullOrEmpty(slug) ? "section" : slug;
        }

        private static string ConvertHelpPlainTextToHtml(string plain, List<(string id, string title)> toc)
        {
            var sb = new StringBuilder(plain.Length * 2);
            string[] lines = plain.Split(new[] { "\r\n", "\n" }, StringSplitOptions.None);
            bool inList = false;
            bool inExample = false;
            var exampleLines = new List<string>();
            int h2Index = 0;
            int metaLines = 0;

            void CloseList()
            {
                if (!inList)
                {
                    return;
                }

                sb.AppendLine("</ul>");
                inList = false;
            }

            void FlushExample()
            {
                if (!inExample)
                {
                    return;
                }

                sb.AppendLine("<div class=\"logic-formula-group\">");
                for (int e = 0; e < exampleLines.Count; e++)
                {
                    AppendLogicFormulaHtmlBlock(sb, exampleLines[e]);
                }

                sb.AppendLine("</div>");
                exampleLines.Clear();
                inExample = false;
            }

            for (int i = 0; i < lines.Length; i++)
            {
                string line = lines[i];
                if (IsHelpExampleLine(line))
                {
                    CloseList();
                    if (!inExample)
                    {
                        inExample = true;
                    }

                    exampleLines.Add(line.TrimStart());
                    continue;
                }

                FlushExample();

                if (string.IsNullOrWhiteSpace(line))
                {
                    CloseList();
                    continue;
                }

                string trimmed = line.Trim();
                if (IsHelpMajorSeparatorLine(trimmed))
                {
                    CloseList();
                    if (i + 2 < lines.Length
                        && IsHelpMajorSeparatorLine(lines[i + 2].Trim())
                        && !string.IsNullOrWhiteSpace(lines[i + 1]))
                    {
                        string title = lines[i + 1].Trim();
                        i += 2;
                        h2Index++;
                        string id = "sec-" + h2Index.ToString(CultureInfo.InvariantCulture);
                        toc?.Add((id, title));
                        sb.AppendLine("<h2 id=\"" + id + "\">" + HelpHtmlEncode(title) + "</h2>");
                    }

                    continue;
                }

                if (trimmed.StartsWith("----", StringComparison.Ordinal))
                {
                    CloseList();
                    string subTitle = trimmed.Trim('-').Trim();
                    if (!string.IsNullOrEmpty(subTitle))
                    {
                        string subId = HelpSectionAnchorFromTitle(subTitle);
                        toc?.Add((subId, subTitle));
                        sb.AppendLine("<h3 id=\"" + subId + "\">" + HelpHtmlEncode(subTitle) + "</h3>");
                    }

                    continue;
                }

                if (trimmed.StartsWith("[[def-l", StringComparison.Ordinal))
                {
                    CloseList();
                    int endTag = trimmed.IndexOf("]]", StringComparison.Ordinal);
                    string anchor = endTag > 2 ? trimmed.Substring(2, endTag - 2) : "def-l";
                    string heading = endTag >= 0 ? trimmed.Substring(endTag + 2).Trim() : trimmed;
                    toc?.Add((anchor, heading));
                    sb.AppendLine("<h4 id=\"" + HelpHtmlEncode(anchor) + "\" class=\"def-logic\">"
                        + HelpHtmlEncode(heading)
                        + "</h4>");
                    continue;
                }

                if (Regex.IsMatch(trimmed, @"^\d+[a-z]?\)", RegexOptions.CultureInvariant))
                {
                    CloseList();
                    string secId = HelpSectionAnchorFromTitle(trimmed);
                    toc?.Add((secId, trimmed));
                    sb.AppendLine("<h3 class=\"sec\" id=\"" + secId + "\">" + HelpHtmlEncode(trimmed) + "</h3>");
                    continue;
                }

                if (i == 0)
                {
                    sb.AppendLine("<h1>" + HelpHtmlEncode(trimmed) + "</h1>");
                    continue;
                }

                if (metaLines < 2 && trimmed.StartsWith("(", StringComparison.Ordinal))
                {
                    metaLines++;
                    sb.AppendLine("<p class=\"meta\">" + HelpHtmlEncode(trimmed) + "</p>");
                    continue;
                }

                if (trimmed.StartsWith("•", StringComparison.Ordinal)
                    || trimmed.StartsWith("\u2022", StringComparison.Ordinal))
                {
                    if (!inList)
                    {
                        sb.AppendLine("<ul>");
                        inList = true;
                    }

                    string bulletText = trimmed.TrimStart('•', '\u2022').Trim();
                    sb.AppendLine("<li>" + FormatHelpLineWithInlineCode(bulletText) + "</li>");
                    continue;
                }

                if (line.StartsWith("   ", StringComparison.Ordinal))
                {
                    if (!inList)
                    {
                        sb.AppendLine("<ul>");
                        inList = true;
                    }

                    if (TrySplitLogicFormulaLine(trimmed, out string formula, out string comment, out string label))
                    {
                        sb.Append("<li>");
                        if (!string.IsNullOrEmpty(label))
                        {
                            sb.Append("<span class=\"logic-formula-label\">");
                            sb.Append(HelpHtmlEncode(label));
                            sb.Append(": </span>");
                        }

                        sb.Append("<code class=\"logic-formula-inline\">");
                        sb.Append(HighlightLogicFormulaHtml(formula));
                        sb.Append("</code>");
                        if (!string.IsNullOrWhiteSpace(comment))
                        {
                            sb.Append("<span class=\"logic-formula-comment\"> — ");
                            sb.Append(HelpHtmlEncode(comment));
                            sb.Append("</span>");
                        }

                        sb.AppendLine("</li>");
                    }
                    else
                    {
                        sb.AppendLine("<li>" + FormatHelpLineWithInlineCode(trimmed) + "</li>");
                    }

                    continue;
                }

                CloseList();
                sb.AppendLine("<p>" + FormatHelpLineWithInlineCode(trimmed) + "</p>");
            }

            FlushExample();
            CloseList();
            return sb.ToString();
        }

        private static bool IsHelpExampleLine(string line)
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                return false;
            }

            return TrySplitLogicFormulaLine(line.TrimStart(), out _, out _, out _)
                || IsLogicFormulaContent(line.TrimStart());
        }

        private static void AppendLogicFormulaHtmlBlock(StringBuilder sb, string rawLine)
        {
            if (!TrySplitLogicFormulaLine(rawLine, out string formula, out string comment, out string label)
                && !IsLogicFormulaContent(rawLine.Trim()))
            {
                sb.Append("<div class=\"logic-formula\"><code class=\"logic-formula-code\">");
                sb.Append(HelpHtmlEncode(rawLine.Trim()));
                sb.AppendLine("</code></div>");
                return;
            }

            if (string.IsNullOrWhiteSpace(formula))
            {
                formula = rawLine.Trim();
                comment = null;
                label = null;
            }

            sb.Append("<div class=\"logic-formula\">");
            if (!string.IsNullOrEmpty(label))
            {
                sb.Append("<span class=\"logic-formula-label\">");
                sb.Append(HelpHtmlEncode(label));
                sb.Append(": </span>");
            }

            sb.Append("<code class=\"logic-formula-code\">");
            sb.Append(HighlightLogicFormulaHtml(formula));
            sb.Append("</code>");
            if (!string.IsNullOrWhiteSpace(comment))
            {
                sb.Append("<span class=\"logic-formula-comment\"> — ");
                sb.Append(HelpHtmlEncode(comment));
                sb.Append("</span>");
            }

            sb.AppendLine("</div>");
        }

        private static bool TrySplitLogicFormulaLine(
            string line,
            out string formula,
            out string comment,
            out string label)
        {
            formula = null;
            comment = null;
            label = null;
            if (string.IsNullOrWhiteSpace(line))
            {
                return false;
            }

            string work = line.Trim();
            int commentSep = work.IndexOf(" — ", StringComparison.Ordinal);
            if (commentSep < 0)
            {
                commentSep = work.IndexOf(" - ", StringComparison.Ordinal);
            }

            if (commentSep > 0)
            {
                comment = work.Substring(commentSep + 3).Trim();
                work = work.Substring(0, commentSep).Trim();
            }

            int formulaStart = FindLogicFormulaStartIndex(work);
            if (formulaStart < 0 || !IsLogicFormulaContent(work.Substring(formulaStart).Trim()))
            {
                return false;
            }

            if (formulaStart > 0)
            {
                label = work.Substring(0, formulaStart).Trim().TrimEnd(':').Trim();
                if (string.IsNullOrEmpty(label))
                {
                    label = null;
                }
            }

            formula = work.Substring(formulaStart).Trim();
            return true;
        }

        private static int FindLogicFormulaStartIndex(string text)
        {
            if (string.IsNullOrEmpty(text))
            {
                return -1;
            }

            string ind = LogicLineParser.IndicatorNamesRegexFragment;
            Match match = Regex.Match(
                text,
                "(Regime\\s*\\(|Disabled\\s*\\(|Disable\\s*\\(|\\(|NOT\\s+(Regime|Disabled|LinReg|SMA|Stoch|ATR|MACD|CCI|RSI|Rsi|Momentum|Mom|Boll|Bollinger|VWAP|\\()"
                + "|!\\s*(LinReg|SMA|Stoch|RSI|Rsi|Momentum|Mom|Boll|Bollinger|VWAP|\\()"
                + "|\\b(" + ind + ")\\s*\\()",
                RegexOptions.CultureInvariant);
            return match.Success ? match.Index : -1;
        }

        private static bool IsLogicFormulaContent(string text)
        {
            if (string.IsNullOrWhiteSpace(text))
            {
                return false;
            }

            if (text.Contains("Op[", StringComparison.Ordinal)
                || text.Contains("Cl[", StringComparison.Ordinal)
                || text.Contains("SL[", StringComparison.Ordinal)
                || text.Contains("TP[", StringComparison.Ordinal))
            {
                return true;
            }

            if (text.StartsWith("Regime(", StringComparison.OrdinalIgnoreCase)
                || text.StartsWith("Disabled(", StringComparison.OrdinalIgnoreCase)
                || text.StartsWith("Disable(", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            if (text.StartsWith("(", StringComparison.Ordinal)
                && (text.Contains(" Op[", StringComparison.Ordinal)
                    || text.Contains(" Cl[", StringComparison.Ordinal)
                    || text.Contains(" && ", StringComparison.Ordinal)
                    || text.Contains(" || ", StringComparison.Ordinal)
                    || text.Contains(" AND ", StringComparison.OrdinalIgnoreCase)
                    || text.Contains(" OR ", StringComparison.OrdinalIgnoreCase)))
            {
                return true;
            }

            if (Regex.IsMatch(
                    text,
                    @"\b(" + LogicLineParser.IndicatorNamesRegexFragment + @")\s*\(",
                    RegexOptions.CultureInvariant))
            {
                return true;
            }

            if (Regex.IsMatch(
                    text,
                    @"^NOT\s+(Regime|Disabled|LinReg|SMA|Stoch|ATR|MACD|CCI|RSI|Rsi|Momentum|Mom|Boll|Bollinger|VWAP|\()",
                    RegexOptions.CultureInvariant | RegexOptions.IgnoreCase))
            {
                return true;
            }

            if (Regex.IsMatch(
                    text,
                    @"^!\s*(LinReg|SMA|Stoch|\()",
                    RegexOptions.CultureInvariant | RegexOptions.IgnoreCase))
            {
                return true;
            }

            return false;
        }

        private static string HighlightLogicFormulaHtml(string rawFormula)
        {
            if (string.IsNullOrWhiteSpace(rawFormula))
            {
                return string.Empty;
            }

            string encoded = HelpHtmlEncode(rawFormula.Trim());
            encoded = Regex.Replace(
                encoded,
                @"\b(Regime|Disabled|Disable|Strict)\(",
                "<span class=\"lf-regime\">$1</span>(",
                RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
            encoded = Regex.Replace(
                encoded,
                Regex.Escape(LogicLineParser.StrictnessParamToken),
                "<span class=\"lf-param-ref\">" + LogicLineParser.StrictnessParamToken + "</span>",
                RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
            encoded = Regex.Replace(
                encoded,
                @"\b(AND|OR|NOT)\b",
                "<span class=\"lf-kw\">$1</span>",
                RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
            encoded = Regex.Replace(
                encoded,
                @"(&amp;&amp;|\|\|)",
                "<span class=\"lf-kw\">$1</span>",
                RegexOptions.CultureInvariant);
            encoded = Regex.Replace(
                encoded,
                @"\b(" + LogicLineParser.IndicatorNamesRegexFragment + @")\(",
                "<span class=\"lf-ind\">$1</span>(",
                RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
            encoded = Regex.Replace(
                encoded,
                @"\bSide\[([LS])\]",
                "<span class=\"lf-side\">Side[$1]</span>",
                RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
            encoded = Regex.Replace(
                encoded,
                @"\bOp\[",
                "<span class=\"lf-op\">Op</span>[",
                RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
            encoded = Regex.Replace(
                encoded,
                @"\bCl\[",
                "<span class=\"lf-cl\">Cl</span>[",
                RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
            encoded = Regex.Replace(
                encoded,
                @"\bSL\[",
                "<span class=\"lf-sl\">SL</span>[",
                RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
            encoded = Regex.Replace(
                encoded,
                @"\bTP\[",
                "<span class=\"lf-sl\">TP</span>[",
                RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
            encoded = Regex.Replace(
                encoded,
                @"\bNote\(",
                "<span class=\"lf-note-tag\">Note</span>(",
                RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
            return encoded;
        }

        private static string FormatHelpLineWithInlineCode(string text)
        {
            if (string.IsNullOrEmpty(text))
            {
                return string.Empty;
            }

            var sb = new StringBuilder(text.Length + 32);
            int i = 0;
            while (i < text.Length)
            {
                int codeStart = FindHelpInlineCodeStart(text, i);
                if (codeStart < 0)
                {
                    sb.Append(HelpHtmlEncode(text.Substring(i)));
                    break;
                }

                if (codeStart > i)
                {
                    sb.Append(HelpHtmlEncode(text.Substring(i, codeStart - i)));
                }

                int codeEnd = FindHelpInlineCodeEnd(text, codeStart);
                if (codeEnd < 0)
                {
                    sb.Append(HelpHtmlEncode(text.Substring(codeStart)));
                    break;
                }

                sb.Append("<code>");
                sb.Append(HelpHtmlEncode(text.Substring(codeStart, codeEnd - codeStart + 1)));
                sb.Append("</code>");
                i = codeEnd + 1;
            }

            return sb.ToString();
        }

        private static int FindHelpInlineCodeStart(string text, int from)
        {
            for (int i = from; i < text.Length; i++)
            {
                if (text[i] == 'O' && i + 2 < text.Length && text[i + 1] == 'p' && text[i + 2] == '[')
                {
                    return i;
                }

                if (text[i] == 'C' && i + 2 < text.Length && text[i + 1] == 'l' && text[i + 2] == '[')
                {
                    return i;
                }

                if (text[i] == 'S' && i + 2 < text.Length && text[i + 1] == 'L' && text[i + 2] == '[')
                {
                    return i;
                }

                if (text[i] == 'T' && i + 2 < text.Length && text[i + 1] == 'P' && text[i + 2] == '[')
                {
                    return i;
                }

                if (text[i] == 'R' && text.Substring(i).StartsWith("Regime(", StringComparison.Ordinal))
                {
                    return i;
                }

                if (text[i] == 'D' && text.Substring(i).StartsWith("Disabled(", StringComparison.Ordinal))
                {
                    return i;
                }
            }

            return -1;
        }

        private static int FindHelpInlineCodeEnd(string text, int start)
        {
            if (start >= text.Length)
            {
                return -1;
            }

            if (text[start] == 'R' || text[start] == 'D')
            {
                int depth = 0;
                for (int i = start; i < text.Length; i++)
                {
                    if (text[i] == '(')
                    {
                        depth++;
                    }
                    else if (text[i] == ')')
                    {
                        depth--;
                        if (depth == 0)
                        {
                            return i;
                        }
                    }
                }

                return text.Length - 1;
            }

            for (int i = start; i < text.Length; i++)
            {
                if (text[i] == ']')
                {
                    return i;
                }
            }

            return -1;
        }

        private static string HelpHtmlEncode(string text)
        {
            if (string.IsNullOrEmpty(text))
            {
                return string.Empty;
            }

            return text
                .Replace("&", "&amp;")
                .Replace("<", "&lt;")
                .Replace(">", "&gt;")
                .Replace("\"", "&quot;");
        }

        /// <summary>Обзор: RAM/диск, портфели логик, JSON-снимок (в начале справки).</summary>
        private static void AppendResourceHelp(StringBuilder sb)
        {
            sb.AppendLine("================================================================================");
            sb.AppendLine("ОБЗОР: ресурсы ПК, портфели логик, сохранение состояния");
            sb.AppendLine("================================================================================");
            sb.AppendLine("MultiLogic считает эффективный портфель отдельно для каждой логики L1…L10");
            sb.AppendLine("(старт 0, может быть отрицательным): realized + unrealized по сделкам MultiLogic_Ln.");
            sb.AppendLine();
            sb.AppendLine("Файлы портфелей (лайв, не тестер):");
            sb.AppendLine("  Engine\\{имя робота}_LogicPortfolio_L1.txt … _L10.txt");
            sb.AppendLine("  История до 5000 точек на логику; сброс на диск ~раз в 30 с при изменениях.");
            sb.AppendLine();
            sb.AppendLine("HTML-отчёт (вкладка «Отчёт», Engine\\{имя}_Report.html):");
            sb.AppendLine("  Пишется в тестере, лайве и при фейке (эмулятор OsEngine, EmulatorIsOn).");
            sb.AppendLine("  В шапке — текущий режим (тестер / лайв / фейк / оптимизатор) и история смены режимов.");
            sb.AppendLine("  Графики equity, открытых/закрытых позиций от времени и opens/closes по дням;");
            sb.AppendLine("  блок «Металогика»: текущий статус, порядок приоритета L1…L10 по PnlSMA, веса и журнал входов;");
            sb.AppendLine("  таблицы по инструментам, логикам L1…L10, закрытым позициям (с длительностью), причинам закрытия.");
            sb.AppendLine("  Интервал перезаписи — параметр «HTML-отчёт: интервал (сек)» (по умолчанию 90; не на каждой сделке).");
            sb.AppendLine("  Кнопка «Открыть HTML-отчёт» (вкладка «Отчёт») — открыть файл в браузере.");
            sb.AppendLine("  На первой вкладке — «Открыть HTML-файл результатов тестирования» (то же действие).");
            sb.AppendLine();
            sb.AppendLine("Первая вкладка параметров:");
            sb.AppendLine("  «Сохранить настройки и результаты» — JSON (параметры, все 10 строк логик,");
            sb.AppendLine("    портфели, открытые позиции); файл выбираете сами.");
            sb.AppendLine("  «Загрузить настройки и результаты» — подставить всё из JSON (биржевые заявки");
            sb.AppendLine("    по позициям не выставляются).");
            sb.AppendLine("  Справочный % годовых (внизу вкладки): «Заполнить начальную сумму и дату портфеля»");
            sb.AppendLine("    — текущий реальный портфель (лайв/тестер) и дата; далее в конце каждой свечи");
            sb.AppendLine("    пересчёт линейного % и % с капитализацией (не сумма L1…L10).");
            sb.AppendLine();
            sb.AppendLine("Контроль ресурсов ПК (только предупреждение в лог, торговлю не блокирует):");
            sb.AppendLine("  Сравнивается свободная RAM и место на диске (каталог Engine\\) с оценкой нагрузки:");
            sb.AppendLine("  — число активных логик;");
            sb.AppendLine("  — точки истории портфелей в памяти;");
            sb.AppendLine("  — вкладки скринера и уникальные индикаторы;");
            sb.AppendLine("  — размер файлов портфелей на диске (в т.ч. крупнейший файл).");
            sb.AppendLine("  Проверка: при старте, после смены логик, загрузки JSON, сохранения портфелей;");
            sb.AppendLine("  повтор того же предупреждения — не чаще ~5 минут.");
            sb.AppendLine("  Если ресурсов мало — в лог пишется, сколько нужно RAM/диска и сколько не хватает;");
            sb.AppendLine("  уменьшите число активных логик, вкладок скринера или объём истории портфелей.");
            sb.AppendLine();
            sb.AppendLine("Вкладка «Металогики» (сразу после «Логики»):");
            sb.AppendLine("  Вверху — «Металогика включена», «Инверсия (покупка ↔ продажа)», кнопка «Включить металогику»,");
            sb.AppendLine("  PnlSMA (вкл. и длина); под PnlSMA — разделитель; ниже — SMA, Stoch, ATR, LinReg, MACD.");
            sb.AppendLine("  Пока «Металогика включена», но по каждой активной логике не накопилось окно PnlSMA");
            sb.AppendLine("  (длина — «Общепортфельный PnlSMA: длина», по одной точке equity на свечу) — входы как без металогики:");
            sb.AppendLine("  Volume поровну, приоритет Max positions L1…L10, без переворота по PnlSMA.");
            sb.AppendLine("  После готовности PnlSMA: Volume делится между логиками с Op и PnlSMA>0 пропорционально PnlSMA;");
            sb.AppendLine("  логики с PnlSMA≤0 не торгуют (PnlSMA=0 тоже исключается).");
            sb.AppendLine("  «Инверсия (покупка ↔ продажа)» — только когда металогика уже действует (PnlSMA готов):");
            sb.AppendLine("  разрешить PnlSMA<0 с Buy↔Sell и Op↔Cl (как инверсия логики); доля Volume по |PnlSMA|. По умолчанию выкл.");
            sb.AppendLine("  Сумма объёмов новых входов на свече не превышает Volume (первая вкладка).");
            sb.AppendLine("  Max positions: при нехватке слотов — приоритет логик с большим PnlSMA.");
            sb.AppendLine("  Если металогика выключена — как раньше: каждая логика отдельно, Volume поровну, L1…L10.");
            sb.AppendLine("  Общепортфельные SMA, Stoch, ATR, LinReg, MACD, PnlSMA — один набор параметров;");
            sb.AppendLine("  расчёт по кривой equity каждой логики L1…L10 и по сумме (файлы _LogicPortfolio_Ln, _MetaAggregate).");
            sb.AppendLine("  Отдельных «ЛП1…ЛП10» в параметрах нет — настройки общие для всех портфельных серий.");
            sb.AppendLine("  При включённом мета-индикаторе робот считает его по серии equity портфеля");
            sb.AppendLine("  (если на вкладке графика нет соответствующего индикатора) и пишет значения в файл");
            sb.AppendLine("  портфеля (v2, поле meta) и Engine\\{имя}_MetaAggregate.txt для общепортфельных.");
            sb.AppendLine("  JSON-снимок v2 включает meta в истории портфелей и блок AggregateMetaPortfolio.");
            sb.AppendLine("  PnlSMA (Приведённая SMA): pnlSmaAvg = mean(E_i − E_start) по окну; pnlSmaLast = E_end − E_start;");
            sb.AppendLine("  металогика использует pnlSmaAvg; по умолчанию включён PnlSMA, длина окна — 24 свечи.");
            sb.AppendLine();
            sb.AppendLine("Вкладка «Stopper» (общепортфельная страховка по сумме L1…L10):");
            sb.AppendLine("  Equity = сумма кривых портфелей всех логик (realized + unrealized MultiLogic_Ln).");
            sb.AppendLine("  «Общепортфельный stop-loss / take-profit: включён» — по умолчанию выкл.; пороги 0,4% и 10%.");
            sb.AppendLine("  Ref (предыдущая сумма) = equity ровно N свечей назад (lookback, по умолчанию 5);");
            sb.AppendLine("  история обновляется на каждом закрытии свечи вкладки скринера.");
            sb.AppendLine("  SL: current ≤ ref × (1 − SL%); TP: current ≥ ref × (1 + TP%). Ref ≤ 0 — проверка пропускается.");
            sb.AppendLine("  При срабатывании — закрытие всех позиций робота; для SL и TP отдельно: «Отключено», «Останавливать полностью» (Regime=Off),");
            sb.AppendLine("  «Останавливать и возобновлять при достижении текущей суммы в фейк-торговле» (реальные заявки не выставляются, сигналы в L1…L10;");
            sb.AppendLine("  возобновление реальной торговли при equity фейк-портфеля ≥ текущей суммы на момент срабатывания +0,1%).");
            sb.AppendLine("  Техн. суммы обновляются в начале обработки свечи и после торговли на ней (без SaveParameters).");
            sb.AppendLine("  «Обновить сумму портфеля SL/TP» — текущая equity в базу; тех. суммы — в начале и после торговли на свече.");
            sb.AppendLine("  После SL/TP ref = equity после закрытия; база 0 — ref из lookback.");
            sb.AppendLine("  «Stopper: таймфрейм монитора» («Как основной TF» / Min1…Min15): «Как основной TF» — проверка на общей свече страницы 1;");
            sb.AppendLine("    страница 2 скринера удаляется (вкладка «2» пропадает), робот не нагружается; Min1…Min15 — создаётся вторая страница (оранжевая «2») с «Stopper: бумага монитора»");
            sb.AppendLine("    (по умолчанию SBER). SL/TP сравнивает текущую сумму L1…L10 с «Предыдущая сумма» на вкладке Stopper");
            sb.AppendLine("    по CandleFinished страницы 2 (чаще основного TF); lookback N — в свечах монитора, не страницы 1.");
            sb.AppendLine();
        }

        /// <summary>Добавляет в справку раздел по SMA.</summary>
        private static void AppendSmaHelp(StringBuilder sb)
        {
            sb.AppendLine("--- SMA (Simple Moving Average) ---");
            sb.AppendLine("Имя в строке: SMA");
            sb.AppendLine("Параметры (на график):");
            sb.AppendLine("  SMA(100)                    — длина 100, источник Close");
            sb.AppendLine("  SMA(L=100)                  — то же, явно");
            sb.AppendLine("  SMA(L=100,Src=Close)        — длина и источник (Close)");
            sb.AppendLine("Сигналы:");
            sb.AppendLine("  Op[Ab]  — close > SMA (лонг);  Cl[Bl] — close < SMA (выход из лонга)");
            sb.AppendLine("  Side[S] Op[Bl] Cl[Ab]       — шорт: close < SMA / выход close > SMA");
            sb.AppendLine("Примеры:");
            sb.AppendLine("  Тренд:      SMA(100) Op[Ab] Cl[Bl] SL[2%] TP[6%] Note(trend)");
            sb.AppendLine("  Антитренд:  SMA(100) Side[S] Op[Bl] Cl[Ab] SL[2%] TP[6%] Note(counter-trend)");
            sb.AppendLine("  С ATR:      (SMA(100) Op[Ab] Cl[Bl]) AND (ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-])");
            sb.AppendLine();
        }

        /// <summary>Добавляет в справку раздел по Stochastic.</summary>
        private static void AppendStochHelp(StringBuilder sb)
        {
            sb.AppendLine("--- Stochastic (Stoch) ---");
            sb.AppendLine("Имя в строке: Stoch  (или Stochastic)");
            sb.AppendLine("Параметры индикатора (P1-P2-P3 на график):");
            sb.AppendLine("  Stoch(14-3-3)                              — периоды 14, 3, 3");
            sb.AppendLine("  Stoch(14,3,3)                              — через запятую");
            sb.AppendLine("  Stoch(K1=14,K2=3,D=3)                      — именованно");
            sb.AppendLine("Пороги сигнала (только в строке логики, не на график):");
            sb.AppendLine("  ;Lmin=55;Smax=45  или  ;L=55;S=45");
            sb.AppendLine("Сигналы:");
            sb.AppendLine("  Op[K>=55] / Op[K>=Lmin]  — %K выше порога (лонг)");
            sb.AppendLine("  Cl[K<=45] / Cl[K<=Smax]  — %K ниже порога (выход)");
            sb.AppendLine("Примеры:");
            sb.AppendLine("  Тренд:      Stoch(14-3-3;Lmin=55;Smax=45) Op[K>=55] Cl[K<=45] Note(trend)");
            sb.AppendLine("  Антитренд:  Stoch(14-3-3;Lmin=55;Smax=45) Side[S] Op[K<=45] Cl[K>=55] Note(counter-trend)");
            sb.AppendLine();
        }

        /// <summary>Добавляет в справку раздел по ATR.</summary>
        private static void AppendAtrHelp(StringBuilder sb)
        {
            sb.AppendLine("--- ATR (фильтр роста волатильности, без направления) ---");
            sb.AppendLine("Имя в строке: ATR");
            sb.AppendLine("Параметры индикатора:");
            sb.AppendLine("  ATR(14)                     — период 14");
            sb.AppendLine("  ATR(L=14)                   — то же");
            sb.AppendLine("Пороги роста (в строке логики):");
            sb.AppendLine("  ;Gr=3%;Lb=5   — ATR вырос ≥ 3% относительно значения 5 свечей назад");
            sb.AppendLine("  ;+3%@5        — краткая запись Gr/Lb");
            sb.AppendLine("Сигналы:");
            sb.AppendLine("  Op[GrOk]  или  Op[+3%@5]  — фильтр «волатильность выросла»");
            sb.AppendLine("  Cl[-]                     — отдельного выхода по ATR нет");
            sb.AppendLine("Примеры:");
            sb.AppendLine("  Фильтр:     ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-] Note(volatility-filter)");
            sb.AppendLine("  С SMA:      (SMA(100) Op[Ab] Cl[Bl]) AND (ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-])");
            sb.AppendLine();
        }

        /// <summary>Добавляет в справку раздел по Linear Regression.</summary>
        private static void AppendLinRegHelp(StringBuilder sb)
        {
            sb.AppendLine("--- Linear Regression (LinReg) ---");
            sb.AppendLine("Имя в строке: LinReg  (или LR, LinearRegression)");
            sb.AppendLine("Параметры индикатора:");
            sb.AppendLine("  LinReg(@LR)                 — длина из параметра «Длина линейной регрессии», Dev=2");
            sb.AppendLine("  LinReg(@LR;Dev=2)           — длина из параметра, отклонение границ");
            sb.AppendLine("  LinReg(50;Dev=2)            — явная длина 50 (не из параметра)");
            sb.AppendLine("  LinReg(L=@LR,Dev=2)         — именованно, длина из параметра");
            sb.AppendLine("Сигналы (как TrendMultiIndicatorScreener — канал LinReg):");
            sb.AppendLine("  Op[AbUp]  — close выше верхней линии (лонг)");
            sb.AppendLine("  Cl[BlUp]  — close ниже верхней (выход)");
            sb.AppendLine("  Side[S] Op[BlLo] Cl[AbLo] — шорт от нижней линии");
            sb.AppendLine("Пороги наклона (только в строке логики, не на график):");
            sb.AppendLine("  ;SlopeLb=3  — сравнить центр канала с центром 3 свечи назад");
            sb.AppendLine("  ;SlopeDead=0 — мёртвая зона |Δцентра| (по умолчанию 0)");
            sb.AppendLine("  Op[SlopeUp] — центр LinReg растёт (Δ > SlopeDead); лонг-режим");
            sb.AppendLine("  Op[SlopeDn] — центр падает (Δ < -SlopeDead); шорт-режим");
            sb.AppendLine("  Cl[-] с Op[SlopeUp/Dn] — атом только фильтр режима, без своего выхода");
            sb.AppendLine("Примеры:");
            sb.AppendLine("  Тренд:      LinReg(@LR;Dev=2) Op[AbUp] Cl[BlUp] SL[2%] TP[6%] Note(trend)");
            sb.AppendLine("  Антитренд:  LinReg(@LR;Dev=2) Side[S] Op[BlLo] Cl[AbLo] Note(counter-trend)");
            sb.AppendLine();
        }

        /// <summary>Добавляет в справку раздел по MACD.</summary>
        private static void AppendMacdHelp(StringBuilder sb)
        {
            sb.AppendLine("--- MACD ---");
            sb.AppendLine("Имя в строке: MACD  (или Macd)");
            sb.AppendLine("Параметры индикатора:");
            sb.AppendLine("  MACD(12,26,9)               — fast, slow, signal");
            sb.AppendLine("  MACD(Fast=12,Slow=26,Signal=9)");
            sb.AppendLine("Сигналы:");
            sb.AppendLine("  Op[Macd>Sig]  — линия MACD выше сигнальной (лонг)");
            sb.AppendLine("  Cl[Macd<Sig]  — MACD ниже сигнальной (выход / шорт)");
            sb.AppendLine("Примеры:");
            sb.AppendLine("  Тренд:      MACD(12,26,9) Op[Macd>Sig] Cl[Macd<Sig] SL[2%] TP[6%] Note(trend)");
            sb.AppendLine("  Антитренд:  MACD(12,26,9) Side[S] Op[Macd<Sig] Cl[Macd>Sig] Note(counter-trend)");
            sb.AppendLine();
        }

        /// <summary>Добавляет в справку раздел по CCI (Commodity Channel Index).</summary>
        private static void AppendCciHelp(StringBuilder sb)
        {
            sb.AppendLine("--- CCI (Commodity Channel Index) ---");
            sb.AppendLine("Имя в строке: CCI");
            sb.AppendLine("Параметры индикатора (на график):");
            sb.AppendLine("  CCI(20)                     — длина 20, источник Typical (H+L+C)/3");
            sb.AppendLine("  CCI(L=20)                   — то же, явно");
            sb.AppendLine("  CCI(L=20,Src=Typical)       — длина и точка свечи (Typical, Close, Open, High, Low, Median)");
            sb.AppendLine("  CCI(20;Src=Close)           — через точку с запятой");
            sb.AppendLine("Пороги сигнала (только в строке логики, не на график):");
            sb.AppendLine("  ;Lmin=100;Smax=-100  или  ;L=100;S=-100  — классические уровни перекупленности/перепроданности");
            sb.AppendLine("Сигналы:");
            sb.AppendLine("  Op[CCI>=100] / Op[CCI>=Lmin]  — CCI выше порога (лонг от силы / контртренд — по смыслу стратегии)");
            sb.AppendLine("  Cl[CCI<=-100] / Cl[CCI<=Smax] — CCI ниже порога (выход)");
            sb.AppendLine("  Op[CCI<=-100] Side[S]         — шорт при CCI ниже −100 (контртренд)");
            sb.AppendLine("Примеры:");
            sb.AppendLine("  Контртренд: CCI(20;Lmin=100;Smax=-100) Side[S] Op[CCI>=100] Cl[CCI<=-100] Note(CCI-fade-short)");
            sb.AppendLine("  С фильтром:  (SMA(100) Op[Ab] Cl[Bl]) AND (CCI(20;Lmin=-100;Smax=-200) Op[CCI<=-100] Cl[CCI>=0] Note(pullback))");
            sb.AppendLine("  Не включён в логики по умолчанию и не входит в металогики (только строки «Логика 1…10»).");
            sb.AppendLine();
        }

        /// <summary>Добавляет в справку раздел по RSI.</summary>
        private static void AppendRsiHelp(StringBuilder sb)
        {
            sb.AppendLine("--- RSI (Relative Strength Index) ---");
            sb.AppendLine("Имя в строке: RSI  (или Rsi)");
            sb.AppendLine("Параметры индикатора (на график):");
            sb.AppendLine("  RSI(14)                     — длина 14, источник Close");
            sb.AppendLine("  RSI(L=14)                   — то же, явно");
            sb.AppendLine("Пороги сигнала (только в строке логики, не на график):");
            sb.AppendLine("  ;Lmin=55;Smax=45  или  ;L=55;S=45");
            sb.AppendLine("Сигналы:");
            sb.AppendLine("  Op[RSI>=55] / Op[RSI>=Lmin]  — RSI выше порога (лонг / сила)");
            sb.AppendLine("  Cl[RSI<=45] / Cl[RSI<=Smax]  — RSI ниже порога (выход)");
            sb.AppendLine("Примеры:");
            sb.AppendLine("  Тренд:      RSI(14;Lmin=55;Smax=45) Op[RSI>=55] Cl[RSI<=45] Note(trend-rsi)");
            sb.AppendLine("  С Boll:     (Bollinger(20;Dev=2) Op[AbMid] Cl[BlMid]) AND (RSI(14;Lmin=55;Smax=45) Op[RSI>=55] Cl[RSI<=45])");
            sb.AppendLine();
        }

        /// <summary>Добавляет в справку раздел по Bollinger Bands.</summary>
        private static void AppendBollingerHelp(StringBuilder sb)
        {
            sb.AppendLine("--- Bollinger Bands (Bollinger / Boll) ---");
            sb.AppendLine("Имя в строке: Bollinger  (или Boll)");
            sb.AppendLine("Параметры индикатора (на график):");
            sb.AppendLine("  Bollinger(20)               — длина 20, Dev=2 по умолчанию");
            sb.AppendLine("  Bollinger(20;Dev=2)         — длина и отклонение");
            sb.AppendLine("  Bollinger(L=100,Dev=2)      — именованно");
            sb.AppendLine("Сигналы:");
            sb.AppendLine("  Op[Ab]  — close выше верхней полосы;  Cl[Bl] — close ниже нижней");
            sb.AppendLine("  Op[AbMid] — close выше середины полос; Cl[BlMid] — ниже середины");
            sb.AppendLine("  Side[S] Op[Bl] Cl[Ab]       — шорт от нижней полосы");
            sb.AppendLine("Примеры:");
            sb.AppendLine("  Пробой:     Bollinger(20;Dev=2) Op[Ab] Cl[Bl] Note(trend-boll-break)");
            sb.AppendLine("  Плавный:    Bollinger(20;Dev=2) Op[AbMid] Cl[BlMid] Note(trend-boll-mid)");
            sb.AppendLine("  Контртренд: Bollinger(20;Dev=2) Side[S] Op[Bl] Cl[Ab] Note(counter-Boll)");
            sb.AppendLine();
        }

        /// <summary>Добавляет в справку раздел по Momentum.</summary>
        private static void AppendMomentumHelp(StringBuilder sb)
        {
            sb.AppendLine("--- Momentum (Mom) ---");
            sb.AppendLine("Имя в строке: Momentum  (или Mom)");
            sb.AppendLine("Параметры индикатора (на график):");
            sb.AppendLine("  Momentum(14)                — длина 14, источник Close");
            sb.AppendLine("  Momentum(L=15)              — то же, явно");
            sb.AppendLine("Пороги сигнала (только в строке логики, не на график):");
            sb.AppendLine("  ;Lmin=100;Smax=100  — базовая линия ~100 (как в TrendMultiIndicator)");
            sb.AppendLine("Сигналы:");
            sb.AppendLine("  Op[MOM>=100] / Op[MOM>=Lmin]  — Momentum выше порога (лонг)");
            sb.AppendLine("  Cl[MOM<=100] / Cl[MOM<=Smax]  — Momentum ниже порога (выход)");
            sb.AppendLine("  Side[S] Op[MOM<=100] Cl[MOM>=100] — шорт при MOM ≤ порога");
            sb.AppendLine("Примеры:");
            sb.AppendLine("  Тренд:      Momentum(14;Lmin=100;Smax=100) Op[MOM>=100] Cl[MOM<=100] Note(trend-mom)");
            sb.AppendLine("  С LinReg:   (LinReg(@LR;Dev=2;SlopeLb=3) Op[SlopeUp] Cl[-]) AND (Momentum(14;Lmin=100;Smax=100) Op[MOM>=100] Cl[MOM<=100])");
            sb.AppendLine();
        }

        /// <summary>Добавляет в справку раздел по VWAP.</summary>
        private static void AppendVwapHelp(StringBuilder sb)
        {
            sb.AppendLine("--- VWAP (Volume Weighted Average Price) ---");
            sb.AppendLine("Имя в строке: VWAP");
            sb.AppendLine("Параметры индикатора: без параметров (сессионный VWAP на графике Prime).");
            sb.AppendLine("Сигналы:");
            sb.AppendLine("  Op[Ab]  — close > VWAP (лонг);  Cl[Bl] — close < VWAP (выход из лонга)");
            sb.AppendLine("  Side[S] Op[Bl] Cl[Ab]       — шорт: close < VWAP / выход close > VWAP");
            sb.AppendLine("Примеры:");
            sb.AppendLine("  Тренд:      VWAP Op[Ab] Cl[Bl] Note(trend-vwap)");
            sb.AppendLine("  С фильтром: (VWAP Op[Ab] Cl[Bl]) AND (SMA(100) Op[Ab] Cl[Bl]) AND (MACD(12,26,9) Op[Macd>Sig] Cl[Macd<Sig])");
            sb.AppendLine();
        }


    }

    #endregion
}