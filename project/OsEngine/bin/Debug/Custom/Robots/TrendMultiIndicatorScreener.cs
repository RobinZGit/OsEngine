/*
 * Your rights to use code governed by this license https://github.com/AlexWan/OsEngine/blob/master/LICENSE
 * Ваши права на использование кода регулируются данной лицензией http://o-s-a.net/doc/license_simple_engine.pdf
*/

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using OsEngine.Alerts;
using OsEngine.Candles;
using OsEngine.Candles.Factory;
using OsEngine.Candles.Series;
using OsEngine.Entity;
using OsEngine.Indicators;
using OsEngine.Logging;
using OsEngine.Market;
using OsEngine.Market.Connectors;
using OsEngine.Market.Servers;
using OsEngine.Market.Servers.Optimizer;
using OsEngine.Market.Servers.Tester;
using OsEngine.Charts.CandleChart;
using OsEngine.OsTrader.Panels;
using OsEngine.OsTrader.Panels.Tab;

/*
Description

Screener trend robot using multiple indicators simultaneously:
- SMA
- RSI
- Stochastic
- Momentum
- Bollinger
- Linear Regression Curve
- Volume (объём текущей свечи vs предыдущая; минимальный рост в %)
- VWAP (close выше/ниже линии; сброс по календарному дню)
- MACD (линия MACD выше/ниже сигнальной; по умолчанию выкл.)
- RZIgreensMinusReds, Average Profit Percent Long — в исходниках отключены (#if false), код не удалён.
- ATR (фильтр роста волатильности: ATR вырос на % за lookback свечей)
- DiscreteMidBestPair — в исходниках отключён (#if false в теле класса), код не удалён.

Each indicator has an enable/disable parameter. Disabled indicators are not created on screener tabs.
По умолчанию включён только SMA; остальные Use* — выкл.
У каждого индикатора — «№ И-группы» (целое, может быть отрицательным): по модулю номера строится одна И-группа (например 2 и −2 — одна группа); внутри группы условия связаны И. Отрицательный номер означает отрицание условия индикатора (NOT). Разные значения |номера| — разные группы; между группами ИЛИ.

Entry:
Open Long / Short when the grouped formula is satisfied for bull/bear checks (see indicator pass methods).
«Инверсия логики (покупка ↔ продажа)»: если включена — по сигналу бычьей формулы открывается продажа, по медвежьей — покупка (то же при закрытии и реверсе).

If Volume indicator is enabled, current candle volume must be at least (previous volume × (1 + min growth % / 100)).

Exit/Reverse:
If a position exists and opposite signal appears, close and (if allowed) open opposite.
Order execution: «Тип заявок (вход и выход)» — Лимит (default) or Рынок for entries, exits, reverse, schedule, portfolio insurance, stop-all.

Filters (AlgoStart-style):
- Non-trade periods (button opens calendar/time settings).
- Volatility cluster to trade (1–3) with lookback; only tabs in the chosen cluster can open new positions.

Самоиндикация: фиксация Use* при вкл./первом входе; опция «Проверять вкл/выкл индикаторов»; иначе только ±5% чисел; раз на бар, каждые N свечей.

Schedule (tab «Расписание»): «Дата-время начала/окончания работы» — пустая строка = выкл.; до начала торговля не идёт; после окончания — закрытие всех позиций скринера по рынку и остановка логики. Форматы: дата, дата+время, только время (дата = календарный день decision time).

Stops (tab «Стопы»): трейлинг позиции — в OsTrader встроенный CloseAtTrailingStopMarket по пику цены; в тестере — проверка High/Low свечи. Страховка портфеля — при просадке equity от пика закрыть все позиции скринера (опционально Regime → OnlyClosePosition).

MOEX futures / stocks: в OsTrader — бумаги с уже выбранного TInvest и портфеля скринера (коннектор, портфель, ТФ не меняются); в тестере — бумаги из сета Tester.

MOEX futures: префиксы корня, класс Futures (TInvest) или TestClass (тестер), без фильтра экспирации в тестере.

MOEX stocks: тикеры (точное имя), класс Stock rub (TInvest) или TestClass (тестер).
*/

namespace OsEngine.Robots.Custom
{
    /// <summary>
    /// Скринерный трендовый робот: несколько индикаторов, И-группы (AND внутри |№|, OR между |№|),
    /// MOEX reload (TInvest/Tester), расписание, самоиндикация, стопы, кластеры волатильности.
    /// </summary>
    public class TrendMultiIndicatorScreener : BotPanel
    {
        // DiscreteMidBestPair, RZIgreensMinusReds, Average Profit Percent Long: связанный код в «#if false … #endif» (не удалён).
        // Чтобы снова включить индикатор — замените false на true во всех таких директивах в этом файле.

        private const int NumSma = 1;
        private const int NumRsi = 2;
        private const int NumStoch = 3;
        private const int NumMomentum = 4;
        private const int NumBollinger = 5;
        private const int NumLinReg = 6;
        private const int NumVolumeIndicator = 9;

#if false // RZIgreensMinusReds
        private const int NumRzi = 7;
#endif

#if false // AverageProfitPercentLong
        /// <summary>Как в атрибуте [Indicator("...")] у скрипта AverageProfitPercentLong.</summary>
        private const string AverageProfitPercentLongIndicatorType = "Average Profit Percent Long";

        private const int NumAverageProfitPercentLong = 10;
#endif

        private const int NumVwap = 11;
        private const int NumAtr = 12;
        private const int NumMacd = 13;

        private const string VwapIndicatorType = "VWAP";

#if false // DiscreteMidBestPair: код сохранён, отключён (замените false на true для включения)
        private const int NumDiscreteMidBestPair = 8;

        /// <summary>Маркер входа для постановки SL/TP по дискретной сетке (см. TryPlaceDiscreteStopAndProfit).</summary>
        private const string SignalOpenWithDiscreteSlTp = "TrendMultiDiscreteSlTp";
#endif

        private const string AreaPrime = "Prime";
        private const string AreaSecond = "Second";

        private const string SignalPositionTrailingStop = "TrendMultiTrailPosition";
        private const string SignalPortfolioTrailingStop = "TrendMultiTrailPortfolio";
        private BotTabScreener _screenerTab;

        // basic
        private StrategyParameterButton _resetIndicatorParametersToDefaultButton;
        private StrategyParameterString _regime;
        private StrategyParameterButton _stopRobotAndSellAllButton;
        private StrategyParameterInt _maxPositions;
        private StrategyParameterInt _slippage;
        private StrategyParameterString _orderExecution;
        private StrategyParameterBool _useRandomPriceShift;
        private StrategyParameterDecimal _randomPriceShiftPercent;
        private readonly Random _randomPriceShiftRng = new Random();
        private StrategyParameterBool _invertEntryLogic;

        /*
         * ---------------------------------------------------------------------------
         * самоиндикация (вкладка параметров «самоиндикация»)
         * ---------------------------------------------------------------------------
         * Логика (только при открытии новой позиции):
         * На окне «Свечей назад» строится виртуальный портфель по IsBullSignalAt / IsBearSignalAt.
         * При включении самоиндикации, при её повторном вкл. и при первом входе фиксируется список Use*,
         * которые были включены в этот момент.
         * «Проверять включение/выключение индикаторов» = да: перебор Use* (вкл/выкл) только для них; нет — только ±5% чисел.
         * Подбор при сигнале, не чаще раза на бар и только на свечах, кратных N.
         * Числовые параметры (±5%, не И-группы) — у индикаторов из списка; проверки — снимок шага;
         * пересчёт индикаторов только на текущей вкладке (не весь скринер на каждую попытку).
         * Затем вход как обычно (с учётом «Инверсии логики»). При закрытии позиций не участвует.
         */
        private StrategyParameterBool _useSamoindikatsiya;
        private StrategyParameterInt _samoindikatsiyaCandlesLookback;
        private StrategyParameterInt _samoindikatsiyaRecalcEveryNCandles;
        private StrategyParameterBool _samoindikatsiyaCheckIndicatorOnOff;

        private const decimal SamoindikatsiyaParamAdjustFraction = 0.05m;

        /// <summary>Время последней свечи, на которой уже выполнен подбор параметров (один раз на бар для всего робота).</summary>
        private DateTime _samoindikatsiyaLastOptimizedBarTime = DateTime.MinValue;

        /// <summary>Отложенная установка индикаторов после MOEX reload (чарты вкладок ещё не готовы).</summary>
        private int _moexIndicatorsAttachPassId;

        private const int MoexIndicatorsAttachMaxAttempts = 25;

        /// <summary>Пауза между вкладками при «Обновить акции» — снижает гонку ClearJournalsArray в GlobalPositionViewer.</summary>
        private const int MoexStockTabReloadDelayMs = 700;

        private int _moexStockReloadInProgress;

        /// <summary>Счётчик закрытых свечей (глобально по времени бара) для интервала пересчёта N.</summary>
        private int _samoindikatsiyaGlobalBarCounter;

        private DateTime _samoindikatsiyaLastCountedBarTime = DateTime.MinValue;

        /// <summary>Use* индикаторов, включённых на момент фиксации (вкл. самоиндикации / первый вход).</summary>
        private SamoindikatsiyaIndicatorSnapshot _samoindikatsiyaEnabledAtLock;

        private bool _samoindikatsiyaFirstEntryBaselineCaptured;

        // стопы (трейлинг позиции + страховка портфеля)
        private StrategyParameterBool _usePositionTrailing;
        private StrategyParameterDecimal _positionTrailingPercent;
        private StrategyParameterBool _usePortfolioTrailing;
        private StrategyParameterDecimal _portfolioTrailingDrawdownPercent;
        private StrategyParameterBool _portfolioTrailingSetOnlyCloseRegime;

        private readonly Dictionary<string, decimal> _positionTrailingPeaks =
            new Dictionary<string, decimal>(StringComparer.OrdinalIgnoreCase);

        private decimal _portfolioEquityPeak;
        private string _prevRegimeForPortfolioTrailing;
        private DateTime _lastPortfolioTrailingDecisionTime = DateTime.MinValue;

        // volume
        private StrategyParameterString _volumeType;
        private StrategyParameterDecimal _volume;
        private StrategyParameterString _tradeAssetInPortfolio;

        // indicator toggles
        private StrategyParameterBool _useSma;
        private StrategyParameterBool _useRsi;
        private StrategyParameterBool _useStoch;
        private StrategyParameterBool _useMomentum;
        private StrategyParameterBool _useBollinger;
        private StrategyParameterBool _useLinReg;
        private StrategyParameterBool _useVolumeIndicator;
        private StrategyParameterBool _useVwap;
#if false // RZIgreensMinusReds
        private StrategyParameterBool _useRzi;
#endif
#if false // AverageProfitPercentLong
        private StrategyParameterBool _useAverageProfitPercentLong;
#endif
        private StrategyParameterBool _useAtr;
        private StrategyParameterBool _useMacd;
#if false // DiscreteMidBestPair
        private StrategyParameterBool _useDiscreteMidBestPair;
#endif

        // indicator params
        private StrategyParameterInt _smaLen;

        private StrategyParameterInt _rsiLen;
        private StrategyParameterDecimal _rsiLongMin;
        private StrategyParameterDecimal _rsiShortMax;

        private StrategyParameterInt _stochP1;
        private StrategyParameterInt _stochP2;
        private StrategyParameterInt _stochP3;
        private StrategyParameterDecimal _stochLongMin;
        private StrategyParameterDecimal _stochShortMax;

        private StrategyParameterInt _momLen;
        private StrategyParameterDecimal _momLongMin;
        private StrategyParameterDecimal _momShortMax;

        private StrategyParameterInt _bollLen;
        private StrategyParameterDecimal _bollDev;

        private StrategyParameterInt _linRegLen;
        private StrategyParameterDecimal _linRegDev;

        private StrategyParameterDecimal _volumeIndicatorMinGrowthPercent;

#if false // RZIgreensMinusReds
        private StrategyParameterInt _rziLen;
        private StrategyParameterInt _rziStep;
        private StrategyParameterInt _rziSignalLevel;
#endif

#if false // AverageProfitPercentLong
        private StrategyParameterInt _avgProfitPercentLongPeriod;
        private StrategyParameterInt _avgProfitPercentLongPairs;
        private StrategyParameterBool _avgProfitPercentLongAsPercent;
        private StrategyParameterDecimal _avgProfitPercentLongBullMin;
        private StrategyParameterDecimal _avgProfitPercentLongBearMax;
#endif

        private StrategyParameterInt _atrLen;
        private StrategyParameterDecimal _atrGrowPercent;
        private StrategyParameterInt _atrGrowLookBack;

        private StrategyParameterInt _macdFastLen;
        private StrategyParameterInt _macdSlowLen;
        private StrategyParameterInt _macdSignalLen;

        private StrategyParameterInt _vwapAndGroup;
        private StrategyParameterInt _atrAndGroup;
        private StrategyParameterInt _macdAndGroup;

        /*
         * ---------------------------------------------------------------------------
         * ЛОГИКА «И-ГРУПП» И ОБЩЕГО «ИЛИ» МЕЖДУ ГРУППАМИ (сигналы IsBullSignal / IsBearSignal)
         * ---------------------------------------------------------------------------
         *
         * У каждого индикатора задаётся целое «№ И-группы» (параметры *AndGroup), диапазон в т.ч.
         * отрицательные значения. Ключ блока И — это |номер|: индикаторы с номерами G и −G попадают
         * в одну и ту же группу (один блок для OR между группами).
         *
         * Внутри блока с ключом |G| все условия связаны логическим И (AND). Для положительного номера
         * группы берётся результат *Passes как есть; для отрицательного — инверсия (NOT): индикатор
         * «должен не выполнять» своё обычное условие.
         *
         * Разные |номер| — разные блоки. Блоки между собой — логическое ИЛИ (OR): общий сигнал true,
         * если хотя бы один блок целиком true (все его участники с учётом знака дали true).
         *
         * Примеры:
         *  - SMA=1, RSI=1: как раньше — (SMA ∧ RSI).
         *  - SMA=1, RSI=−1: одна группа |1| — (SMA ∧ ¬RSI).
         *  - SMA=2, RSI=−2: та же группа |2| — (SMA ∧ ¬RSI); с Volume=1 получится (SMA₂∧¬RSI₂) ∨ (Volume₁).
         *  - Номер 0 в настройках не используется как отдельный ключ: для совместимости трактуется как 1.
         *
         * Выключенный индикатор (Use* = false) в расчёт не попадает: для него не вызывается
         * AddGroupedIndicatorResult (методы *Passes возвращают null).
         *
         * Если ни один индикатор не включён, список условий пуст — для совместимости с
         * прежним поведением возвращается true (нет активных фильтров).
         *
         * Реализация: AddGroupedIndicatorResult кладёт (|g|, pass или ¬pass); CombineGroupedOrOfAnds
         * группирует по ключу и для каждой группы проверяет grp.All(x => x.pass); если хотя бы одна
         * группа полностью true — возвращается true; иначе false.
         * ---------------------------------------------------------------------------
         */
        private StrategyParameterInt _smaAndGroup;
        private StrategyParameterInt _rsiAndGroup;
        private StrategyParameterInt _stochAndGroup;
        private StrategyParameterInt _momAndGroup;
        private StrategyParameterInt _bollAndGroup;
        private StrategyParameterInt _linRegAndGroup;
        private StrategyParameterInt _volumeAndGroup;
#if false // RZIgreensMinusReds
        private StrategyParameterInt _rziAndGroup;
#endif
#if false // AverageProfitPercentLong
        private StrategyParameterInt _avgProfitPercentLongAndGroup;
#endif

#if false // DiscreteMidBestPair
        private StrategyParameterInt _discreteMidBestPairLevels;
        private StrategyParameterInt _discreteEntryThreshold;
        private StrategyParameterInt _discreteAndGroup;
#endif

        // Non-trade periods (AlgoStart pattern)
        private NonTradePeriods _tradePeriodsSettings;
        private StrategyParameterButton _tradePeriodsShowDialogButton;

        // Volatility clusters / stage (AlgoStart pattern)
        private StrategyParameterBool _checkVolatilityCluster;
        private StrategyParameterInt _clusterToTrade;
        private StrategyParameterInt _clustersLookBack;
        private StrategyParameterButton _clusterShowLast;
        private VolatilityStageClusters _volatilityStageClusters = new VolatilityStageClusters();
        private DateTime _lastTimeSetClusters;

        /// <summary>Доп. корни тикера MOEX FORTS (в параметре — «человеческий» префикс, на бирже — код серии).</summary>
        private static readonly Dictionary<string, string[]> MoexFuturesPrefixAliases =
            new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase)
            {
                { "CNY", new[] { "CR", "CNYRUBF" } },
                { "SI", new[] { "Si", "SV", "SILV" } },
                { "RUAL", new[] { "RU" } },
            };

        private StrategyParameterString _workStartDateTime;
        private StrategyParameterString _workEndDateTime;

        private DateTime _lastScheduleEndCloseDecisionTime = DateTime.MinValue;

        /// <summary>Макс. виртуальный equity в самоиндикации (защита от OverflowException).</summary>
        private const decimal SamoindikatsiyaMaxVirtualEquity = 1_000_000_000m;

        private StrategyParameterString _moexFuturesTickerPrefixes;
        private StrategyParameterButton _moexFuturesResetPrefixesButton;
        private StrategyParameterButton _moexFuturesLoadButton;
        private StrategyParameterString _moexStockTickerPrefixes;
        private StrategyParameterButton _moexStockResetPrefixesButton;
        private StrategyParameterButton _moexStockLoadButton;

        private const string DefaultMoexFuturesTickerPrefixes =
            "Si,USDRUBF,Eu,EURRUBF,CNY,MX,MM,IMOEXF,RI,BR,BRM,CL,NG,NGM,GD,GLDRUBF,SV,PT,PD,CU,SR,GZ,LK,RN,NK,GN,TT,VB,SN,SG,RL";

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

        public TrendMultiIndicatorScreener(string name, StartProgram startProgram)
            : base(name, startProgram)
        {
            _tradePeriodsSettings = new NonTradePeriods(name);

            _tradePeriodsSettings.NonTradePeriodGeneral.NonTradePeriod1Start = new TimeOfDay() { Hour = 0, Minute = 0 };
            _tradePeriodsSettings.NonTradePeriodGeneral.NonTradePeriod1End = new TimeOfDay() { Hour = 10, Minute = 05 };
            _tradePeriodsSettings.NonTradePeriodGeneral.NonTradePeriod1OnOff = true;

            _tradePeriodsSettings.NonTradePeriodGeneral.NonTradePeriod2Start = new TimeOfDay() { Hour = 13, Minute = 54 };
            _tradePeriodsSettings.NonTradePeriodGeneral.NonTradePeriod2End = new TimeOfDay() { Hour = 14, Minute = 6 };
            _tradePeriodsSettings.NonTradePeriodGeneral.NonTradePeriod2OnOff = false;

            _tradePeriodsSettings.NonTradePeriodGeneral.NonTradePeriod3Start = new TimeOfDay() { Hour = 18, Minute = 1 };
            _tradePeriodsSettings.NonTradePeriodGeneral.NonTradePeriod3End = new TimeOfDay() { Hour = 23, Minute = 58 };
            _tradePeriodsSettings.NonTradePeriodGeneral.NonTradePeriod3OnOff = true;

            _tradePeriodsSettings.TradeInSunday = false;
            _tradePeriodsSettings.TradeInSaturday = false;

            _tradePeriodsSettings.Load();

            TabCreate(BotTabType.Screener);
            _screenerTab = TabsScreener[0];
            RemoveCorruptScreenerTabSetFileIfNeeded();

            _screenerTab.CandleFinishedEvent += ScreenerTab_CandleFinishedEvent;
            _screenerTab.NewTabCreateEvent += ScreenerTab_NewTabCreateEvent;
            _screenerTab.PositionOpeningSuccesEvent += ScreenerTab_PositionOpeningSuccesEvent;

            // basic
            _regime = CreateParameter("Regime", "Off", new[] { "Off", "On", "OnlyLong", "OnlyShort", "OnlyClosePosition" });
            _stopRobotAndSellAllButton = CreateParameterButton("Остановить робота и продать всё");
            _stopRobotAndSellAllButton.UserClickOnButtonEvent += StopRobotAndSellAllButton_UserClickOnButtonEvent;

            _maxPositions = CreateParameter("Max positions (all tabs)", 20, 0, 200, 1);
            _slippage = CreateParameter("Slippage (steps)", 0, 0, 20, 1);
            _orderExecution = CreateParameter(
                "Тип заявок (вход и выход)",
                "Лимит",
                new[] { "Лимит", "Рынок" });
            _invertEntryLogic = CreateParameter("Инверсия логики (покупка ↔ продажа)", false);

            const string samoindikatsiyaTab = "самоиндикация";
            _useSamoindikatsiya = CreateParameter("Самоиндикация включена", false, samoindikatsiyaTab);
            _samoindikatsiyaCandlesLookback = CreateParameter(
                "Свечей назад для самоиндикации",
                30,
                2,
                5000,
                1,
                samoindikatsiyaTab);
            _samoindikatsiyaRecalcEveryNCandles = CreateParameter(
                "Пересчёт каждые N свечей",
                30,
                1,
                10000,
                1,
                samoindikatsiyaTab);
            _samoindikatsiyaCheckIndicatorOnOff = CreateParameter(
                "Проверять включение/выключение индикаторов",
                false,
                samoindikatsiyaTab);
            _useSamoindikatsiya.ValueChange += UseSamoindikatsiya_ValueChange;

            _checkVolatilityCluster = CreateParameter("Проверка кластера волатильности", false);
            _clusterToTrade = CreateParameter("Volatility cluster to trade", 2, 1, 3, 1);
            _clustersLookBack = CreateParameter("Volatility cluster lookBack", 30, 10, 300, 1);
            _clusterShowLast = CreateParameterButton("Show last clusters");
            _clusterShowLast.UserClickOnButtonEvent += ClusterShowLast_UserClickOnButtonEvent;

            _tradePeriodsShowDialogButton = CreateParameterButton("Non trade periods");
            _tradePeriodsShowDialogButton.UserClickOnButtonEvent += TradePeriodsShowDialogButton_UserClickOnButtonEvent;

            const string scheduleTab = "Расписание";
            _workStartDateTime = CreateParameter(
                "Дата-время начала работы (dd.MM.yyyy, dd.MM.yyyy HH:mm, yyyy-MM-dd, HH:mm; пусто = выкл.)",
                "",
                scheduleTab);
            _workEndDateTime = CreateParameter(
                "Дата-время окончания работы (dd.MM.yyyy, dd.MM.yyyy HH:mm, yyyy-MM-dd, HH:mm; пусто = выкл.)",
                "",
                scheduleTab);

            const string stopsTab = "Стопы";
            _usePositionTrailing = CreateParameter("Трейлинг позиции", true, stopsTab);
            _positionTrailingPercent = CreateParameter(
                "Трейлинг позиции, % от пика",
                1m,
                0.1m,
                50m,
                0.1m,
                stopsTab);
            _usePortfolioTrailing = CreateParameter("Страховка портфеля (просадка от пика)", true, stopsTab);
            _portfolioTrailingDrawdownPercent = CreateParameter(
                "Просадка портфеля от пика, %",
                5m,
                0.1m,
                50m,
                0.1m,
                stopsTab);
            _portfolioTrailingSetOnlyCloseRegime = CreateParameter(
                "После страховки: OnlyClosePosition",
                true,
                stopsTab);

            const string moexFuturesTab = "MOEX фьючерсы";
            _moexFuturesTickerPrefixes = CreateParameter(
                "Префиксы корня тикера (T-Инвестиции; ROSN, LKOH; CNY — также CR, CNYRUBF)",
                DefaultMoexFuturesTickerPrefixes,
                moexFuturesTab);
            _moexFuturesResetPrefixesButton = CreateParameterButton("Установить префиксы фьючерсов по умолчанию", moexFuturesTab);
            _moexFuturesResetPrefixesButton.UserClickOnButtonEvent += MoexFuturesResetPrefixesButton_UserClickOnButtonEvent;
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

            // volume
            _volumeType = CreateParameter("Volume type", "Deposit percent", new[] { "Contracts", "Contract currency", "Deposit percent" });
            _volume = CreateParameter("Volume", 20, 1.0m, 50, 4);
            _tradeAssetInPortfolio = CreateParameter("Asset in portfolio", "Prime");

            _resetIndicatorParametersToDefaultButton = CreateParameterButton("Установить параметры индикаторов по умолчанию");
            _resetIndicatorParametersToDefaultButton.UserClickOnButtonEvent += ResetIndicatorParametersToDefaultButton_UserClickOnButtonEvent;

            // toggles
            _useSma = CreateParameter("Use SMA", true);
            _useRsi = CreateParameter("Use RSI", false);
            _useStoch = CreateParameter("Use Stochastic", false);
            _useMomentum = CreateParameter("Use Momentum", false);
            _useBollinger = CreateParameter("Use Bollinger", false);
            _useLinReg = CreateParameter("Use Linear Regression", false);
            _useVolumeIndicator = CreateParameter("Use Volume indicator", false);
            _useVwap = CreateParameter("Use VWAP", false);
#if false // RZIgreensMinusReds
            _useRzi = CreateParameter("Use RZIgreensMinusReds", false);
#endif
#if false // AverageProfitPercentLong
            _useAverageProfitPercentLong = CreateParameter("Use Average Profit Percent Long", false);
#endif
            _useAtr = CreateParameter("Use ATR", false);
            _useMacd = CreateParameter("Use MACD", false);

#if false // DiscreteMidBestPair
            _useDiscreteMidBestPair = CreateParameter("Use DiscreteMidBestPair", false);
#endif

            // SMA
            _smaLen = CreateParameter("SMA length", 100, 5, 300, 1);

            // RSI
            _rsiLen = CreateParameter("RSI length", 14, 2, 100, 1);
            _rsiLongMin = CreateParameter("RSI long min", 55m, 0, 100, 1m);
            _rsiShortMax = CreateParameter("RSI short max", 45m, 0, 100, 1m);

            // Stochastic
            _stochP1 = CreateParameter("Stoch P1", 5, 2, 100, 1);
            _stochP2 = CreateParameter("Stoch P2", 3, 1, 50, 1);
            _stochP3 = CreateParameter("Stoch P3", 3, 1, 50, 1);
            _stochLongMin = CreateParameter("Stoch long min", 55m, 0, 100, 1m);
            _stochShortMax = CreateParameter("Stoch short max", 45m, 0, 100, 1m);

            // Momentum (usually ~100 baseline)
            _momLen = CreateParameter("Momentum length", 15, 2, 200, 1);
            _momLongMin = CreateParameter("Momentum long min", 100m, 0, 300, 1m);
            _momShortMax = CreateParameter("Momentum short max", 100m, 0, 300, 1m);

            // Bollinger
            _bollLen = CreateParameter("Bollinger length", 100, 5, 300, 1);
            _bollDev = CreateParameter("Bollinger deviation", 2m, 0.5m, 5m, 0.1m);

            // Linear Regression Channel Fast
            _linRegLen = CreateParameter("LinReg length", 50, 20, 300, 10);
            _linRegDev = CreateParameter("LinReg deviation", 2m, 1m, 4m, 0.1m);

            _volumeIndicatorMinGrowthPercent = CreateParameter("Volume vs prev candle min growth %", 5m, 0m, 500m, 0.5m);

#if false // RZIgreensMinusReds
            // RZIgreensMinusReds (script Custom/Indicators/Scripts/RZIgreensMinusReds.cs)
            _rziLen = CreateParameter("RZI lookback candles", 20, 5, 500, 1);
            _rziStep = CreateParameter("RZI step in loop", 1, 1, 20, 1);
            _rziSignalLevel = CreateParameter("RZI signal level (long if >N, short if <-N)", 3, 0, 200, 1);
#endif

#if false // AverageProfitPercentLong
            // Average Profit Percent Long (Custom/Indicators/Scripts/AverageProfitPercentLong.cs)
            _avgProfitPercentLongPeriod = CreateParameter("Avg Profit % Long period (candles)", 50, 2, 500, 1);
            _avgProfitPercentLongPairs = CreateParameter("Avg Profit % Long random pairs", 100, 1, 2000, 1);
            _avgProfitPercentLongAsPercent = CreateParameter("Avg Profit % Long: % from pair mid price", true);
            _avgProfitPercentLongBullMin = CreateParameter("Avg Profit % Long long: value >", 0m, -1000000m, 1000000m, 0.0001m);
            _avgProfitPercentLongBearMax = CreateParameter("Avg Profit % Long short: value <", 0m, -1000000m, 1000000m, 0.0001m);
#endif

            _atrLen = CreateParameter("ATR length", 14, 2, 200, 1);
            _atrGrowPercent = CreateParameter("ATR min grow % vs lookback", 3m, 0m, 100m, 0.1m);
            _atrGrowLookBack = CreateParameter("ATR grow lookback (candles)", 5, 1, 500, 1);

            _macdFastLen = CreateParameter("MACD fast length", 12, 2, 100, 1);
            _macdSlowLen = CreateParameter("MACD slow length", 26, 2, 300, 1);
            _macdSignalLen = CreateParameter("MACD signal length", 9, 2, 100, 1);

            _smaAndGroup = CreateParameter("SMA: № И-группы", 1, -32, 32, 1);
            _rsiAndGroup = CreateParameter("RSI: № И-группы", 1, -32, 32, 1);
            _stochAndGroup = CreateParameter("Stochastic: № И-группы", 1, -32, 32, 1);
            _momAndGroup = CreateParameter("Momentum: № И-группы", 1, -32, 32, 1);
            _bollAndGroup = CreateParameter("Bollinger: № И-группы", 1, -32, 32, 1);
            _linRegAndGroup = CreateParameter("LinReg: № И-группы", 1, -32, 32, 1);
            _volumeAndGroup = CreateParameter("Volume ind.: № И-группы", 1, -32, 32, 1);
#if false // RZIgreensMinusReds
            _rziAndGroup = CreateParameter("RZI: № И-группы", 1, -32, 32, 1);
#endif
#if false // AverageProfitPercentLong
            _avgProfitPercentLongAndGroup = CreateParameter("Avg Profit % Long: № И-группы", 1, -32, 32, 1);
#endif
            _vwapAndGroup = CreateParameter("VWAP: № И-группы", 1, -32, 32, 1);
            _atrAndGroup = CreateParameter("ATR: № И-группы", 1, -32, 32, 1);
            _macdAndGroup = CreateParameter("MACD: № И-группы", 1, -32, 32, 1);

            _useRandomPriceShift = CreateParameter("Рандомный сдвиг цен", false);
            _randomPriceShiftPercent = CreateParameter("Рандомность движений, %", 0.1m, 0m, 50m, 0.01m);

#if false // DiscreteMidBestPair
            // DiscreteMidBestPair (Custom/Indicators/Scripts/DiscreteMidBestPair.cs)
            _discreteMidBestPairLevels = CreateParameter("DiscreteMidBestPair levels", 32, 2, 256, 1);
            _discreteEntryThreshold = CreateParameter("Порог входа дискретизации", 1, 0, 256, 1);
            _discreteAndGroup = CreateParameter("DiscreteMidBestPair: № И-группы", 1, -32, 32, 1);
#endif

            ParametrsChangeByUser += TrendMultiIndicatorScreener_ParametrsChangeByUser;

            // create only enabled indicators
            SyncIndicators();

#if false // DiscreteMidBestPair
            Description = "Trend screener with SMA/RSI/Stoch/Momentum/Bollinger/LinReg/RZI/DiscreteMidBestPair, non-trade periods, volatility clusters.";
#else
            Description = "Trend screener: SMA/RSI/Stoch/Momentum/Bollinger/LinReg/Volume/VWAP/ATR/MACD; И-группы по |№|, минус = NOT, ИЛИ между |№|; инверсия входа; non-trade periods, volatility clusters.";
#endif

            DeleteEvent += TrendMultiIndicatorScreener_DeleteEvent;

            if (_useSamoindikatsiya.ValueBool)
            {
                RefreshSamoindikatsiyaEnabledAtLock();
            }
        }

        /// <summary>
        /// Обработчик удаления робота: удаляет настройки нерабочих периодов с диска.
        /// </summary>
        #region События жизненного цикла и UI-кнопки

        private void TrendMultiIndicatorScreener_DeleteEvent()
        {
            try
            {
                _tradePeriodsSettings.Delete();
            }
            catch
            {
                // ignore
            }
        }

        /// <summary>
        /// Кнопка «Non trade periods»: открывает диалог календаря/времени запрета торговли.
        /// </summary>
        private void TradePeriodsShowDialogButton_UserClickOnButtonEvent()
        {
            _tradePeriodsSettings.ShowDialog();
        }

        /// <summary>
        /// Кнопка «Остановить робота и продать всё»: закрытие позиций скринера по рынку, Regime=Off.
        /// </summary>
        private void StopRobotAndSellAllButton_UserClickOnButtonEvent()
        {
            try
            {
                CloseParameterDialogIfOpen();
                ExecuteStopRobotAndSellAll();
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        /// <summary>
        /// Сохранить правки из окна параметров и закрыть его (перед остановкой робота).
        /// </summary>
        private void CloseParameterDialogIfOpen()
        {
            if (!ParamGuiIsOpen)
            {
                return;
            }

            try
            {
                ApplyPrefixesFromOpenParameterDialog();
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }

            try
            {
                MethodInfo closeMethod = typeof(BotPanel).GetMethod(
                    "CloseParameterDialog",
                    BindingFlags.Instance | BindingFlags.Public);
                if (closeMethod != null)
                {
                    closeMethod.Invoke(this, null);
                    return;
                }

                FieldInfo uiField = typeof(BotPanel).GetField(
                    "_parametersUi",
                    BindingFlags.Instance | BindingFlags.NonPublic);
                if (uiField?.GetValue(this) is System.Windows.Window parametersWindow)
                {
                    parametersWindow.Close();
                }
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        /// <summary>
        /// Закрыть позиции этого робота на всех вкладках скринера по рынку и выключить Regime.
        /// </summary>
        private void ExecuteStopRobotAndSellAll()
        {
            CloseAllBotPositions();
            _positionTrailingPeaks.Clear();
            _portfolioEquityPeak = 0m;
            _lastPortfolioTrailingDecisionTime = DateTime.MinValue;
            _regime.ValueString = "Off";

            string full = NameStrategyUniq
                + ": «Остановить робота и продать всё» — позиции закрыты ("
                + _orderExecution.ValueString + "), Regime=Off.";
            SendNewLogMessage(full, LogMessageType.System);
            SendNewLogMessage(full, LogMessageType.User);
        }

        private void CloseAllBotPositions()
        {
            if (_screenerTab?.Tabs == null)
            {
                return;
            }

            string botType = GetNameStrategyType();

            for (int i = 0; i < _screenerTab.Tabs.Count; i++)
            {
                BotTabSimple t = _screenerTab.Tabs[i];
                if (t?.PositionsOpenAll == null || t.PositionsOpenAll.Count == 0)
                {
                    continue;
                }

                for (int p = 0; p < t.PositionsOpenAll.Count; p++)
                {
                    Position pos = t.PositionsOpenAll[p];
                    if (pos == null || pos.State != PositionStateType.Open || pos.OpenVolume == 0m)
                    {
                        continue;
                    }

                    if (!string.IsNullOrEmpty(pos.NameBotClass) && pos.NameBotClass != botType)
                    {
                        continue;
                    }

                    decimal slip = _slippage.ValueInt * (t.Security?.PriceStep ?? 0m);
                    ExecuteClosePosition(t, pos, pos.OpenVolume, GetCloseLimitPrice(t, pos, slip));
                }
            }
        }

        private bool UseMarketOrderExecution()
        {
            return string.Equals(_orderExecution.ValueString, "Рынок", StringComparison.OrdinalIgnoreCase);
        }

        private decimal GetOpenLongLimitPrice(BotTabSimple tab, decimal close, decimal slip)
        {
            return ApplyRandomPriceShift(close + slip, tab);
        }

        private decimal GetOpenShortLimitPrice(BotTabSimple tab, decimal close, decimal slip)
        {
            return ApplyRandomPriceShift(close - slip, tab);
        }

        private decimal GetCloseLimitPrice(BotTabSimple tab, Position pos, decimal slip)
        {
            decimal close = tab.CandlesAll != null && tab.CandlesAll.Count > 0
                ? tab.CandlesAll[tab.CandlesAll.Count - 1].Close
                : (pos.Direction == Side.Buy ? tab.PriceBestBid : tab.PriceBestAsk);

            if (pos.Direction == Side.Buy)
            {
                return ApplyRandomPriceShift(close - slip, tab);
            }

            return ApplyRandomPriceShift(close + slip, tab);
        }

        private void ExecuteBuyOpen(BotTabSimple tab, decimal volume, decimal limitPrice, string signal = null)
        {
            if (UseMarketOrderExecution())
            {
                if (string.IsNullOrEmpty(signal))
                {
                    tab.BuyAtMarket(volume);
                }
                else
                {
                    tab.BuyAtMarket(volume, signal);
                }

                return;
            }

            decimal price = limitPrice;
            if (string.IsNullOrEmpty(signal))
            {
                tab.BuyAtLimit(volume, price);
            }
            else
            {
                tab.BuyAtLimit(volume, price, signal);
            }
        }

        private void ExecuteSellOpen(BotTabSimple tab, decimal volume, decimal limitPrice, string signal = null)
        {
            if (UseMarketOrderExecution())
            {
                if (string.IsNullOrEmpty(signal))
                {
                    tab.SellAtMarket(volume);
                }
                else
                {
                    tab.SellAtMarket(volume, signal);
                }

                return;
            }

            decimal price = limitPrice;
            if (string.IsNullOrEmpty(signal))
            {
                tab.SellAtLimit(volume, price);
            }
            else
            {
                tab.SellAtLimit(volume, price, signal);
            }
        }

        private void ExecuteClosePosition(
            BotTabSimple tab,
            Position pos,
            decimal volume,
            decimal limitPrice,
            string signal = null)
        {
            if (pos == null || volume <= 0m)
            {
                return;
            }

            if (UseMarketOrderExecution())
            {
                if (string.IsNullOrEmpty(signal))
                {
                    tab.CloseAtMarket(pos, volume);
                }
                else
                {
                    tab.CloseAtMarket(pos, volume, signal);
                }

                return;
            }

            if (string.IsNullOrEmpty(signal))
            {
                tab.CloseAtLimit(pos, limitPrice, volume);
            }
            else
            {
                tab.CloseAtLimit(pos, limitPrice, volume, signal);
            }
        }

        /// <summary>
        /// Кнопка «Show last clusters»: выводит в лог состав кластеров волатильности по вкладкам скринера.
        /// </summary>
        private void ClusterShowLast_UserClickOnButtonEvent()
        {
            try
            {
                string message = "Volatility clusters. Bot " + NameStrategyUniq + "\n";

                message += "Cluster 1... ";
                for (int i = 0; i < _volatilityStageClusters.ClusterOne.Count; i++)
                {
                    message += _volatilityStageClusters.ClusterOne[i].Connector.SecurityName + " | ";
                }
                message += "\n";

                message += "Cluster 2... ";
                for (int i = 0; i < _volatilityStageClusters.ClusterTwo.Count; i++)
                {
                    message += _volatilityStageClusters.ClusterTwo[i].Connector.SecurityName + " | ";
                }
                message += "\n";

                message += "Cluster 3... ";
                for (int i = 0; i < _volatilityStageClusters.ClusterThree.Count; i++)
                {
                    message += _volatilityStageClusters.ClusterThree[i].Connector.SecurityName + " | ";
                }

                SendNewLogMessage(message, LogMessageType.Error);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
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

        /// <summary>
        /// Кнопка «Установить префиксы по умолчанию» на вкладке MOEX фьючерсы: только строка параметра, без подбора бумаг.
        /// </summary>
        private void MoexFuturesResetPrefixesButton_UserClickOnButtonEvent()
        {
            _moexFuturesTickerPrefixes.ValueString = DefaultMoexFuturesTickerPrefixes;
            RepaintParameterGuiTables();
            SendNewLogMessage(
                "Префиксы корня фьючерсов установлены по умолчанию (подбор бумаг не выполнялся).",
                LogMessageType.System);
        }

        /// <summary>
        /// Кнопка «Установить префиксы по умолчанию» на вкладке MOEX акции: только строка параметра, без подбора бумаг.
        /// </summary>
        private void MoexStockResetPrefixesButton_UserClickOnButtonEvent()
        {
            _moexStockTickerPrefixes.ValueString = DefaultMoexStockTickerPrefixes;
            RepaintParameterGuiTables();
            SendNewLogMessage(
                "Тикеры акций установлены по умолчанию (подбор бумаг не выполнялся).",
                LogMessageType.System);
        }

        private void RepaintParameterGuiTables()
        {
            if (ParamGuiSettings != null)
            {
                ParamGuiSettings.RePaintParameterTables();
            }
        }

        /// <summary>
        /// Кнопка «Обновить фьючерсы»: пересборка списка бумаг скринера по префиксам корня FORTS.
        /// </summary>
        #endregion

        #region MOEX: перезагрузка бумаг скринера (TInvest / Tester)

        private void MoexFuturesLoadButton_UserClickOnButtonEvent()
        {
            ReloadMoexScreenerInstruments(MoexScreenerInstrumentMode.Futures);
        }

        /// <summary>
        /// Кнопка «Обновить акции»: пересборка списка бумаг скринера по точным тикерам MOEX.
        /// </summary>
        private void MoexStockLoadButton_UserClickOnButtonEvent()
        {
            if (Interlocked.CompareExchange(ref _moexStockReloadInProgress, 1, 0) != 0)
            {
                SendNewLogMessage(
                    NameStrategyUniq + ": обновление акций уже выполняется.",
                    LogMessageType.System);
                return;
            }

            Task.Run(() =>
            {
                try
                {
                    ReloadMoexScreenerInstruments(MoexScreenerInstrumentMode.Stock);
                }
                finally
                {
                    Interlocked.Exchange(ref _moexStockReloadInProgress, 0);
                }
            });
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
            try
            {
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

                    SafeReloadScreenerIndicatorsOnAllTabsQuiet(logSummary: attempt == 0 || attempt == MoexIndicatorsAttachMaxAttempts);

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
                catch (Exception ex)
                {
                    SendNewLogMessage(
                        NameStrategyUniq + ": установка индикаторов после MOEX — " + ex.Message,
                        LogMessageType.Error);
                }
            });
        }

        private void ScreenerTab_NewTabCreateEvent(BotTabSimple tab)
        {
            if (tab == null)
            {
                return;
            }

            Task.Run(async () =>
            {
                try
                {
                    await Task.Delay(800).ConfigureAwait(false);
                    TryEnsureRobotIndicatorsOnTabIfNeeded(tab);
                }
                catch
                {
                    // ignore background attach errors
                }
            });
        }

        /// <summary>
        /// Установка индикаторов робота на все готовые вкладки (без ReloadIndicatorsOnTabs / SynchFirstTab из ядра).
        /// </summary>
        private int SafeReloadScreenerIndicatorsOnAllTabsQuiet(bool logSummary = true)
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

                if (FindIndicator(tab, ind.Num, ind.Type) == null)
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

                    if (FindIndicator(tab, ind.Num, ind.Type) == null)
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

        /// <summary>Догрузить индикаторы на одной вкладке, если после MOEX reload они не созданы.</summary>
        private void TryEnsureRobotIndicatorsOnTabIfNeeded(BotTabSimple tab)
        {
            if (tab == null || _screenerTab?._indicators == null || !IsTabChartReadyForIndicators(tab))
            {
                return;
            }

            if (!TabIsMissingAnyRobotIndicator(tab))
            {
                return;
            }

            for (int i = 0; i < _screenerTab._indicators.Count; i++)
            {
                IndicatorOnTabs ind = _screenerTab._indicators[i];
                if (ind == null)
                {
                    continue;
                }

                if (FindIndicator(tab, ind.Num, ind.Type) == null)
                {
                    TryAttachRobotIndicatorOnTab(tab, ind);
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
            if (tab == null || ind == null || !IsTabChartReadyForIndicators(tab))
            {
                return false;
            }

            try
            {
                Aindicator existing = FindIndicator(tab, ind.Num, ind.Type);
                if (existing != null)
                {
                    ApplyIndicatorParamsToTab(tab, ind.Num, ind.Type, ind.Parameters);
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

        /// <summary>
        /// Имя типа стратегии для OsEngine.
        /// </summary>
        #endregion

        #region Параметры, расписание

        public override string GetNameStrategyType()
        {
            return "TrendMultiIndicatorScreener";
        }

        /// <summary>
        /// Отдельный диалог настроек не используется.
        /// </summary>
        public override void ShowIndividualSettingsDialog()
        {
        }

        /// <summary>
        /// При изменении параметров: SyncIndicators, обновление параметров на вкладках.
        /// </summary>
        private void TrendMultiIndicatorScreener_ParametrsChangeByUser()
        {
            SyncIndicators();
            RefreshAllTabsIndicatorsSafely();
        }

        private void ResetIndicatorParametersToDefaultButton_UserClickOnButtonEvent()
        {
            ApplyFactoryDefaultIndicatorParameters();

            TrendMultiIndicatorScreener_ParametrsChangeByUser();

            RepaintParameterGuiTables();

            SendNewLogMessage("Параметры индикаторов установлены по умолчанию (значения из кода робота).", LogMessageType.System);
        }

        /// <summary>
        /// Заводские значения только параметров индикаторов — как в конструкторе CreateParameter.
        /// Режим, объём, стопы, MOEX и прочее не меняются.
        /// </summary>
        private void ApplyFactoryDefaultIndicatorParameters()
        {
            _useSma.ValueBool = true;
            _useRsi.ValueBool = false;
            _useStoch.ValueBool = false;
            _useMomentum.ValueBool = false;
            _useBollinger.ValueBool = false;
            _useLinReg.ValueBool = false;
            _useVolumeIndicator.ValueBool = false;
            _useVwap.ValueBool = false;
            _useAtr.ValueBool = false;
            _useMacd.ValueBool = false;

            _smaLen.ValueInt = 100;
            _rsiLen.ValueInt = 14;
            _rsiLongMin.ValueDecimal = 55m;
            _rsiShortMax.ValueDecimal = 45m;
            _stochP1.ValueInt = 5;
            _stochP2.ValueInt = 3;
            _stochP3.ValueInt = 3;
            _stochLongMin.ValueDecimal = 55m;
            _stochShortMax.ValueDecimal = 45m;
            _momLen.ValueInt = 15;
            _momLongMin.ValueDecimal = 100m;
            _momShortMax.ValueDecimal = 100m;
            _bollLen.ValueInt = 100;
            _bollDev.ValueDecimal = 2m;
            _linRegLen.ValueInt = 50;
            _linRegDev.ValueDecimal = 2m;
            _volumeIndicatorMinGrowthPercent.ValueDecimal = 5m;
            _atrLen.ValueInt = 14;
            _atrGrowPercent.ValueDecimal = 3m;
            _atrGrowLookBack.ValueInt = 5;
            _macdFastLen.ValueInt = 12;
            _macdSlowLen.ValueInt = 26;
            _macdSignalLen.ValueInt = 9;
        }

        /// <summary>
        /// Инверсия входа/выхода по параметру «Инверсия логики (покупка ↔ продажа)».
        /// </summary>
        private bool IsEntryLogicInverted()
        {
            return _invertEntryLogic.ValueBool;
        }

        /// <summary>
        /// Время для расписания: в тестере — свеча; в лайве — сервер или свеча.
        /// </summary>
        private static DateTime GetDecisionTime(BotTabSimple tab, DateTime candleTime)
        {
            if (tab != null
                && (tab.StartProgram == StartProgram.IsTester
                    || tab.StartProgram == StartProgram.IsOsOptimizer))
            {
                return candleTime;
            }

            if (tab != null)
            {
                DateTime serverT = tab.TimeServerCurrent;
                if (serverT != DateTime.MinValue)
                {
                    return serverT;
                }
            }

            return candleTime;
        }

        /// <summary>
        /// Календарная дата для парсинга «только время» (HH:mm).
        /// </summary>
        private static DateTime GetCalendarDateForTimeOnly(BotTabSimple tab, DateTime candleTime)
        {
            DateTime t = GetDecisionTime(tab, candleTime);
            if (t == DateTime.MinValue)
            {
                t = candleTime;
            }

            return t.Date;
        }

        /// <summary>
        /// Строковый параметр задан (не пустой и не пробелы).
        /// </summary>
        private static bool IsFilledStringParameter(StrategyParameterString param)
        {
            return param != null && !string.IsNullOrWhiteSpace(param.ValueString);
        }

        /// <summary>
        /// В строке только дата (без времени): нет «:», есть цифры.
        /// </summary>
        private static bool IsDateOnlyScheduleInput(string rawSource)
        {
            if (string.IsNullOrWhiteSpace(rawSource))
            {
                return false;
            }

            string raw = rawSource.Trim();
            return !raw.Contains(':') && ContainsDigit(raw);
        }

        /// <summary>
        /// Есть ли цифра в строке (для отсечения мусора при парсинге даты).
        /// </summary>
        private static bool ContainsDigit(string value)
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
        /// Парсинг даты/времени: dd.MM.yyyy, ISO, только HH:mm (дата — календарный день decision time).
        /// </summary>
        private static bool TryParseFlexibleDateTime(BotTabSimple tab, DateTime candleTime, string rawSource, out DateTime parsed)
        {
            parsed = default;
            if (string.IsNullOrWhiteSpace(rawSource))
            {
                return false;
            }

            string raw = rawSource.Trim();
            if (!ContainsDigit(raw))
            {
                return false;
            }

            DateTime referenceDate = GetCalendarDateForTimeOnly(tab, candleTime);

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
                    if (fmt.StartsWith("HH", StringComparison.Ordinal))
                    {
                        parsed = referenceDate.Add(exact.TimeOfDay);
                    }
                    else
                    {
                        parsed = exact;
                    }

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

        /// <summary>
        /// True, если decision time строго меньше «Дата-время начала работы» (пустой параметр — false).
        /// </summary>
        private bool IsBeforeScheduledWorkStart(BotTabSimple tab, DateTime candleTime, DateTime decisionTime)
        {
            if (!IsFilledStringParameter(_workStartDateTime))
            {
                return false;
            }

            if (!TryParseFlexibleDateTime(tab, candleTime, _workStartDateTime.ValueString, out DateTime workStart))
            {
                return false;
            }

            return decisionTime < workStart;
        }

        /// <summary>
        /// True, если decision time строго больше «Дата-время окончания работы» (пустой параметр — false).
        /// При первом срабатывании на момент времени — закрытие всех позиций скринера по рынку.
        /// </summary>
        private bool HandleScheduledWorkEndIfNeeded(BotTabSimple tab, DateTime candleTime, DateTime decisionTime)
        {
            if (!IsFilledStringParameter(_workEndDateTime))
            {
                return false;
            }

            if (!TryParseFlexibleDateTime(tab, candleTime, _workEndDateTime.ValueString, out DateTime workEnd))
            {
                return false;
            }

            // Только дата без времени — работа включительно до конца этого календарного дня.
            if (IsDateOnlyScheduleInput(_workEndDateTime.ValueString))
            {
                workEnd = workEnd.Date.AddDays(1);
            }

            if (decisionTime <= workEnd)
            {
                return false;
            }

            if (decisionTime != _lastScheduleEndCloseDecisionTime)
            {
                _lastScheduleEndCloseDecisionTime = decisionTime;
                CloseAllBotPositions();
                _positionTrailingPeaks.Clear();

                SendNewLogMessage(
                    "Расписание: окончание работы "
                    + workEnd.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture)
                    + ", decision="
                    + decisionTime.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture)
                    + " — закрыты все позиции скринера.",
                    LogMessageType.Signal);
            }

            return true;
        }

        private static bool IsTesterLikeProgram(BotTabSimple tab)
        {
            return tab != null
                && (tab.StartProgram == StartProgram.IsTester
                    || tab.StartProgram == StartProgram.IsOsOptimizer);
        }

        private static string GetPositionTrailingKey(BotTabSimple tab, Position position)
        {
            return tab.TabName + "|" + position.Number;
        }

        private decimal GetPositionTrailingPercent()
        {
            if (!_usePositionTrailing.ValueBool)
            {
                return 0m;
            }

            return _positionTrailingPercent.ValueDecimal;
        }

        private static decimal ComputeTrailingStopFromPeak(Side direction, decimal peak, decimal percent)
        {
            if (peak <= 0m || percent <= 0m)
            {
                return 0m;
            }

            decimal factor = percent / 100m;
            return direction == Side.Buy
                ? peak * (1m - factor)
                : peak * (1m + factor);
        }

        private static void UpdateTrailingPeakFromCandle(ref decimal peak, Side direction, Candle candle, decimal entryPrice)
        {
            if (direction == Side.Buy)
            {
                decimal candidate = Math.Max(candle.High, entryPrice);
                peak = peak <= 0m ? candidate : Math.Max(peak, candidate);
            }
            else
            {
                decimal candidate = Math.Min(candle.Low, entryPrice);
                peak = peak <= 0m ? candidate : Math.Min(peak, candidate);
            }
        }

        /// <summary>
        /// Текущая стоимость актива портфеля (Prime или выбранный инструмент).
        /// </summary>
        private decimal? TryGetMonitoredPortfolioValue(BotTabSimple tab)
        {
            if (tab == null)
            {
                return null;
            }

            Portfolio myPortfolio = tab.Portfolio;
            if (myPortfolio == null)
            {
                return null;
            }

            if (_tradeAssetInPortfolio.ValueString == "Prime")
            {
                return myPortfolio.ValueCurrent;
            }

            List<PositionOnBoard> positionOnBoard = myPortfolio.GetPositionOnBoard();
            if (positionOnBoard == null)
            {
                return null;
            }

            for (int i = 0; i < positionOnBoard.Count; i++)
            {
                if (positionOnBoard[i].SecurityNameCode == _tradeAssetInPortfolio.ValueString)
                {
                    return positionOnBoard[i].ValueCurrent;
                }
            }

            return null;
        }

        private void UpdatePortfolioTrailingOnRegimeChange(BotTabSimple tab)
        {
            string regime = _regime.ValueString ?? "Off";

            if (_prevRegimeForPortfolioTrailing == regime)
            {
                return;
            }

            if (regime == "Off")
            {
                _portfolioEquityPeak = 0m;
                _lastPortfolioTrailingDecisionTime = DateTime.MinValue;
                _positionTrailingPeaks.Clear();
            }
            else if (_prevRegimeForPortfolioTrailing == "Off" || string.IsNullOrEmpty(_prevRegimeForPortfolioTrailing))
            {
                decimal? value = TryGetMonitoredPortfolioValue(tab);
                _portfolioEquityPeak = value ?? 0m;
            }

            _prevRegimeForPortfolioTrailing = regime;
        }

        private void TryManagePortfolioEquityTrailing(BotTabSimple tab, DateTime decisionTime)
        {
            if (!_usePortfolioTrailing.ValueBool)
            {
                return;
            }

            decimal drawdownPercent = _portfolioTrailingDrawdownPercent.ValueDecimal;
            if (drawdownPercent <= 0m)
            {
                return;
            }

            if (decisionTime == _lastPortfolioTrailingDecisionTime)
            {
                return;
            }

            _lastPortfolioTrailingDecisionTime = decisionTime;

            decimal? currentValue = TryGetMonitoredPortfolioValue(tab);
            if (!currentValue.HasValue || currentValue.Value <= 0m)
            {
                return;
            }

            if (_portfolioEquityPeak <= 0m)
            {
                _portfolioEquityPeak = currentValue.Value;
                return;
            }

            if (currentValue.Value > _portfolioEquityPeak)
            {
                _portfolioEquityPeak = currentValue.Value;
                return;
            }

            decimal floor = _portfolioEquityPeak * (1m - drawdownPercent / 100m);
            if (currentValue.Value > floor)
            {
                return;
            }

            CloseAllBotPositions();
            _positionTrailingPeaks.Clear();

            SendNewLogMessage(
                "Страховка портфеля: просадка "
                + drawdownPercent.ToString(CultureInfo.InvariantCulture)
                + "% от пика "
                + _portfolioEquityPeak.ToString(CultureInfo.InvariantCulture)
                + ", equity="
                + currentValue.Value.ToString(CultureInfo.InvariantCulture),
                LogMessageType.Signal);

            if (_portfolioTrailingSetOnlyCloseRegime.ValueBool)
            {
                _regime.ValueString = "OnlyClosePosition";
            }

            _portfolioEquityPeak = currentValue.Value;
        }

        private void ScreenerTab_PositionOpeningSuccesEvent(Position position, BotTabSimple tab)
        {
            decimal percent = GetPositionTrailingPercent();
            if (percent <= 0m || position == null || tab == null || position.State != PositionStateType.Open)
            {
                return;
            }

            decimal entry = position.EntryPrice;
            if (entry <= 0m)
            {
                entry = tab.PriceBestAsk > 0 ? tab.PriceBestAsk : tab.PriceBestBid;
            }

            if (entry <= 0m)
            {
                return;
            }

            string key = GetPositionTrailingKey(tab, position);
            _positionTrailingPeaks[key] = entry;

            if (!IsTesterLikeProgram(tab) && UseMarketOrderExecution())
            {
                decimal stop = ComputeTrailingStopFromPeak(position.Direction, entry, percent);
                if (stop > 0m)
                {
                    tab.CloseAtTrailingStopMarket(position, stop, SignalPositionTrailingStop);
                }
            }
        }

        private void TryManagePositionTrailingStops(BotTabSimple tab, List<Candle> candles)
        {
            decimal percent = GetPositionTrailingPercent();
            if (percent <= 0m || tab == null || candles == null || candles.Count == 0)
            {
                return;
            }

            List<Position> positions = tab.PositionsOpenAll;
            if (positions == null || positions.Count == 0)
            {
                PrunePositionTrailingPeaksForTab(tab, null);
                return;
            }

            Candle candle = candles[^1];
            HashSet<string> activeKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            for (int i = 0; i < positions.Count; i++)
            {
                Position pos = positions[i];
                if (pos.State != PositionStateType.Open)
                {
                    continue;
                }

                string key = GetPositionTrailingKey(tab, pos);
                activeKeys.Add(key);

                decimal entry = pos.EntryPrice > 0 ? pos.EntryPrice : candle.Close;
                if (!_positionTrailingPeaks.TryGetValue(key, out decimal peak))
                {
                    peak = entry;
                    _positionTrailingPeaks[key] = peak;
                }

                UpdateTrailingPeakFromCandle(ref peak, pos.Direction, candle, entry);
                _positionTrailingPeaks[key] = peak;

                decimal stop = ComputeTrailingStopFromPeak(pos.Direction, peak, percent);
                if (stop <= 0m)
                {
                    continue;
                }

                bool breached = pos.Direction == Side.Buy
                    ? candle.Low <= stop
                    : candle.High >= stop;

                if (!breached)
                {
                    continue;
                }

                if (UseMarketOrderExecution())
                {
                    if (IsTesterLikeProgram(tab))
                    {
                        ExecuteClosePosition(tab, pos, pos.OpenVolume, 0m, SignalPositionTrailingStop);
                    }

                    continue;
                }

                decimal slip = _slippage.ValueInt * tab.Security.PriceStep;
                decimal closePrice = pos.Direction == Side.Buy
                    ? ApplyRandomPriceShift(stop - slip, tab)
                    : ApplyRandomPriceShift(stop + slip, tab);
                ExecuteClosePosition(tab, pos, pos.OpenVolume, closePrice, SignalPositionTrailingStop);
            }

            PrunePositionTrailingPeaksForTab(tab, activeKeys);
        }

        private void PrunePositionTrailingPeaksForTab(BotTabSimple tab, HashSet<string> activeKeysOnTab)
        {
            if (_positionTrailingPeaks.Count == 0 || tab == null)
            {
                return;
            }

            string prefix = tab.TabName + "|";
            List<string> stale = null;

            foreach (string key in _positionTrailingPeaks.Keys)
            {
                if (!key.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                if (activeKeysOnTab == null || !activeKeysOnTab.Contains(key))
                {
                    stale ??= new List<string>();
                    stale.Add(key);
                }
            }

            if (stale == null)
            {
                return;
            }

            for (int i = 0; i < stale.Count; i++)
            {
                _positionTrailingPeaks.Remove(stale[i]);
            }
        }

        #endregion

        #region Индикаторы на вкладках скринера

        private void SyncIndicators()
        {
            EnsureIndicator(
                NumSma,
                "Sma",
                new List<string> { _smaLen.ValueInt.ToString(), "Close" },
                AreaPrime,
                _useSma.ValueBool);

            EnsureIndicator(
                NumRsi,
                "Rsi",
                new List<string> { _rsiLen.ValueInt.ToString(), "Close" },
                AreaSecond,
                _useRsi.ValueBool);

            EnsureIndicator(
                NumStoch,
                "Stochastic",
                new List<string> { _stochP1.ValueInt.ToString(), _stochP2.ValueInt.ToString(), _stochP3.ValueInt.ToString() },
                AreaSecond,
                _useStoch.ValueBool);

            EnsureIndicator(
                NumMomentum,
                "Momentum",
                new List<string> { _momLen.ValueInt.ToString(), "Close" },
                AreaSecond,
                _useMomentum.ValueBool);

            EnsureIndicator(
                NumBollinger,
                "Bollinger",
                new List<string> { _bollLen.ValueInt.ToString(), _bollDev.ValueDecimal.ToString() },
                AreaPrime,
                _useBollinger.ValueBool);

            EnsureIndicator(
                NumLinReg,
                "LinearRegressionChannelFast_Indicator",
                new List<string>
                {
                    _linRegLen.ValueInt.ToString(),
                    "Close",
                    _linRegDev.ValueDecimal.ToString(),
                    _linRegDev.ValueDecimal.ToString()
                },
                AreaPrime,
                _useLinReg.ValueBool);

#if false // RZIgreensMinusReds
            EnsureIndicator(
                NumRzi,
                "RZIgreensMinusReds",
                new List<string>
                {
                    _rziLen.ValueInt.ToString(),
                    _rziStep.ValueInt.ToString(),
                    "Close"
                },
                AreaSecond,
                _useRzi.ValueBool);
#endif

            EnsureIndicator(
                NumVolumeIndicator,
                "Volume",
                new List<string>(),
                AreaSecond,
                _useVolumeIndicator.ValueBool);

#if false // AverageProfitPercentLong
            EnsureIndicator(
                NumAverageProfitPercentLong,
                AverageProfitPercentLongIndicatorType,
                new List<string>
                {
                    _avgProfitPercentLongPeriod.ValueInt.ToString(),
                    _avgProfitPercentLongPairs.ValueInt.ToString(),
                    _avgProfitPercentLongAsPercent.ValueBool.ToString()
                },
                AreaSecond,
                _useAverageProfitPercentLong.ValueBool);
#endif

            EnsureIndicator(
                NumVwap,
                VwapIndicatorType,
                new List<string>(),
                AreaPrime,
                _useVwap.ValueBool);

            EnsureIndicator(
                NumAtr,
                "ATR",
                new List<string> { _atrLen.ValueInt.ToString(), "Absolute" },
                AreaSecond,
                _useAtr.ValueBool);

            EnsureIndicator(
                NumMacd,
                "MACD",
                new List<string>
                {
                    _macdFastLen.ValueInt.ToString(),
                    _macdSlowLen.ValueInt.ToString(),
                    _macdSignalLen.ValueInt.ToString()
                },
                AreaSecond,
                _useMacd.ValueBool);

#if false // DiscreteMidBestPair
            EnsureIndicator(
                NumDiscreteMidBestPair,
                "DiscreteMidBestPair",
                new List<string> { _discreteMidBestPairLevels.ValueInt.ToString() },
                AreaPrime,
                _useDiscreteMidBestPair.ValueBool);
#endif
        }

        /// <summary>
        /// Добавляет или убирает индикатор с заданным номером и типом на всех вкладках.
        /// </summary>
        private void EnsureIndicator(int num, string type, List<string> parameters, string area, bool enabled)
        {
            IndicatorOnTabs existing = _screenerTab._indicators.FirstOrDefault(i => i.Num == num);

            if (enabled)
            {
                if (existing == null)
                {
                    _screenerTab.CreateCandleIndicator(num, type, parameters, area);
                }
                else
                {
                    existing.Type = type;
                    existing.NameArea = area;
                    existing.Parameters = parameters ?? new List<string>();
                }
            }
            else
            {
                if (existing != null)
                {
                    _screenerTab._indicators.Remove(existing);
                }

                string expectedName = num + type + _screenerTab.TabName;

                for (int t = 0; t < _screenerTab.Tabs.Count; t++)
                {
                    BotTabSimple tab = _screenerTab.Tabs[t];
                    if (tab?.Indicators == null || tab.Indicators.Count == 0)
                    {
                        continue;
                    }

                    for (int i = 0; i < tab.Indicators.Count; i++)
                    {
                        if (tab.Indicators[i] != null && tab.Indicators[i].Name == expectedName)
                        {
                            tab.DeleteCandleIndicator(tab.Indicators[i]);
                            i--;
                        }
                    }
                }
            }
        }

        /// <summary>
        /// Минимум свечей для торговли по максимальному периоду включённых индикаторов.
        /// </summary>
        private int GetMinBarsForTradingLogic()
        {
            int min = 50;

            if (_useSma.ValueBool)
            {
                min = Math.Max(min, _smaLen.ValueInt + 2);
            }

            if (_useRsi.ValueBool)
            {
                min = Math.Max(min, _rsiLen.ValueInt + 2);
            }

            if (_useStoch.ValueBool)
            {
                min = Math.Max(min, _stochP1.ValueInt + _stochP2.ValueInt + _stochP3.ValueInt + 2);
            }

            if (_useMomentum.ValueBool)
            {
                min = Math.Max(min, _momLen.ValueInt + 2);
            }

            if (_useBollinger.ValueBool)
            {
                min = Math.Max(min, _bollLen.ValueInt + 2);
            }

            if (_useLinReg.ValueBool)
            {
                min = Math.Max(min, _linRegLen.ValueInt + 2);
            }

#if false // RZIgreensMinusReds
            if (_useRzi.ValueBool)
            {
                min = Math.Max(min, _rziLen.ValueInt + 2);
            }
#endif

#if false // AverageProfitPercentLong
            if (_useAverageProfitPercentLong.ValueBool)
            {
                min = Math.Max(min, _avgProfitPercentLongPeriod.ValueInt + 2);
            }
#endif

            if (_useVwap.ValueBool)
            {
                min = Math.Max(min, 3);
            }

            if (_useAtr.ValueBool)
            {
                min = Math.Max(min, _atrLen.ValueInt + _atrGrowLookBack.ValueInt + 2);
            }

            if (_useMacd.ValueBool)
            {
                min = Math.Max(min, Math.Max(_macdSlowLen.ValueInt, _macdFastLen.ValueInt) + _macdSignalLen.ValueInt + 2);
            }

            return min;
        }

        /// <summary>
        /// Главный цикл: стопы, расписание, фильтры, сигналы, вход/выход/реверс.
        /// </summary>
        #endregion

        #region Торговая логика (сигналы, вход, выход)

        private void ScreenerTab_CandleFinishedEvent(List<Candle> candles, BotTabSimple tab)
        {
            if (candles == null || candles.Count == 0)
            {
                return;
            }

            TryEnsureRobotIndicatorsOnTabIfNeeded(tab);

            DateTime decisionTime = GetDecisionTime(tab, candles[^1].TimeStart);
            UpdatePortfolioTrailingOnRegimeChange(tab);

            if (_regime.ValueString == "Off")
            {
                return;
            }

            if (HandleScheduledWorkEndIfNeeded(tab, candles[^1].TimeStart, decisionTime))
            {
                return;
            }

            if (IsBeforeScheduledWorkStart(tab, candles[^1].TimeStart, decisionTime))
            {
                return;
            }

            TryManagePortfolioEquityTrailing(tab, decisionTime);
            TryManagePositionTrailingStops(tab, candles);

            int minBars = GetMinBarsForTradingLogic();
            if (candles.Count < minBars)
            {
                return;
            }

            if (_tradePeriodsSettings.CanTradeThisTime(candles[^1].TimeStart) == false)
            {
                return;
            }

            if (_useSamoindikatsiya.ValueBool)
            {
                SamoindikatsiyaTickBarCounter(candles[^1].TimeStart);
            }

#if false // DiscreteMidBestPair
            TryPlaceDiscreteStopAndProfit(tab, candles);
#endif

            List<Position> positions = tab.PositionsOpenAll;

            bool haveOpenPos = positions != null && positions.Count > 0 && positions.Any(p => p.State == PositionStateType.Open);
            Position firstOpen = haveOpenPos ? positions.FirstOrDefault(p => p.State == PositionStateType.Open) : null;

            if (haveOpenPos == false
                && _checkVolatilityCluster.ValueBool
                && CheckVolatilityCluster(candles[^1].TimeStart, tab) == false)
            {
                return;
            }

            bool bull;
            bool bear;

            if (!haveOpenPos)
            {
                if (!TryApplySamoindikatsiyaBeforeEntry(candles, tab, out bull, out bear))
                {
                    return;
                }
            }
            else
            {
                bull = IsBullSignal(candles, tab);
                bear = IsBearSignal(candles, tab);

                if (IsEntryLogicInverted())
                {
                    bool tmp = bull;
                    bull = bear;
                    bear = tmp;
                }
            }

            if (!bull && !bear)
            {
                return;
            }

            if (!haveOpenPos)
            {
                if (_regime.ValueString == "OnlyClosePosition")
                {
                    return;
                }

                if (_screenerTab.PositionsOpenAll.Count >= _maxPositions.ValueInt)
                {
                    return;
                }

                TryOpenOnSignal(candles, tab, bull, bear);
                return;
            }

            if (firstOpen == null)
            {
                return;
            }

            TryCloseOrReverse(candles, tab, firstOpen, bull, bear);
        }

        /// <summary>
        /// Вкладка входит в выбранный кластер волатильности (1–3).
        /// </summary>
        private bool CheckVolatilityCluster(DateTime time, BotTabSimple tab)
        {
            int cluster = _clusterToTrade.ValueInt;

            if (cluster == 0)
            {
                return true;
            }

            if (_lastTimeSetClusters == DateTime.MinValue
                || _lastTimeSetClusters != time)
            {
                _volatilityStageClusters.Calculate(_screenerTab.Tabs, _clustersLookBack.ValueInt);
                _lastTimeSetClusters = time;
            }

            List<BotTabSimple> list = null;

            if (cluster == 1)
            {
                list = _volatilityStageClusters.ClusterOne;
            }
            else if (cluster == 2)
            {
                list = _volatilityStageClusters.ClusterTwo;
            }
            else if (cluster == 3)
            {
                list = _volatilityStageClusters.ClusterThree;
            }

            if (list == null)
            {
                return false;
            }

            return list.Find(source => source.Connector.SecurityName == tab.Connector.SecurityName) != null;
        }

        /// <summary>
        /// Добавляет пару для формулы «(И внутри группы по |№|) ИЛИ между разными |№|».
        /// Номер группы может быть отрицательным: тогда в список попадает то же |номер|, но с инвертированным pass (NOT).
        /// Ноль как номер группы не используется как ключ: для совместимости приводится к 1.
        /// Выключенный индикатор: passResult == null — запись не добавляется.
        /// </summary>
        private static void AddGroupedIndicatorResult(List<(int group, bool pass)> items, StrategyParameterInt groupParam, bool? passResult)
        {
            if (!passResult.HasValue)
                return;
            int raw = groupParam.ValueInt;
            if (raw == 0)
                raw = 1;
            int groupKey = Math.Abs(raw);
            bool pass = passResult.Value;
            if (raw < 0)
                pass = !pass;
            items.Add((groupKey, pass));
        }

        /// <summary>
        /// Сводит список (ключ_группы = |исходный_номер|, результат с учётом знака) к одному булеву значению:
        /// внутри каждой группы — И всех pass; между группами — ИЛИ.
        /// Пустой список: true (нет включённых индикаторов — не блокируем вход).
        /// </summary>
        private bool CombineGroupedOrOfAnds(List<(int group, bool pass)> items)
        {
            return CombineGroupedOrOfAnds(items, emptyMeansPass: true);
        }

        /// <param name="emptyMeansPass">false — нет включённых индикаторов ⇒ сигнала нет (для самоиндикации).</param>
        private static bool CombineGroupedOrOfAnds(List<(int group, bool pass)> items, bool emptyMeansPass)
        {
            if (items.Count == 0)
            {
                return emptyMeansPass;
            }

            foreach (var grp in items.GroupBy(x => x.group))
            {
                if (grp.All(x => x.pass))
                {
                    return true;
                }
            }

            return false;
        }

        private static bool SamoindikatsiyaSnapshotHasEnabledIndicator(SamoindikatsiyaIndicatorSnapshot snapshot)
        {
            return snapshot.UseSma
                || snapshot.UseRsi
                || snapshot.UseStoch
                || snapshot.UseMomentum
                || snapshot.UseBollinger
                || snapshot.UseLinReg
                || snapshot.UseVolumeIndicator
                || snapshot.UseVwap
                || snapshot.UseAtr
                || snapshot.UseMacd;
        }

        /// <summary>Есть включённый индикатор с числовыми параметрами для подбора (VWAP не считается).</summary>
        private static bool SamoindikatsiyaSnapshotHasNumericTuning(SamoindikatsiyaIndicatorSnapshot snapshot)
        {
            return snapshot.UseSma
                || snapshot.UseRsi
                || snapshot.UseStoch
                || snapshot.UseMomentum
                || snapshot.UseBollinger
                || snapshot.UseLinReg
                || snapshot.UseVolumeIndicator
                || snapshot.UseAtr
                || snapshot.UseMacd;
        }

        /// <summary>
        /// Значение серии индикатора на свече index; index &lt; 0 — Last.
        /// </summary>
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

        /// <summary>
        /// Снимок настраиваемых параметров индикаторов (без И-групп) для одного шага самоиндикации.
        /// </summary>
        private sealed class SamoindikatsiyaIndicatorSnapshot
        {
            public bool UseSma;
            public bool UseRsi;
            public bool UseStoch;
            public bool UseMomentum;
            public bool UseBollinger;
            public bool UseLinReg;
            public bool UseVolumeIndicator;
            public bool UseVwap;
            public bool UseAtr;
            public bool UseMacd;

            public int SmaLen;
            public int RsiLen;
            public decimal RsiLongMin;
            public decimal RsiShortMax;
            public int StochP1;
            public int StochP2;
            public int StochP3;
            public decimal StochLongMin;
            public decimal StochShortMax;
            public int MomLen;
            public decimal MomLongMin;
            public decimal MomShortMax;
            public int BollLen;
            public decimal BollDev;
            public int LinRegLen;
            public decimal LinRegDev;
            public decimal VolumeIndicatorMinGrowthPercent;
            public int AtrLen;
            public decimal AtrGrowPercent;
            public int AtrGrowLookBack;
            public int MacdFastLen;
            public int MacdSlowLen;
            public int MacdSignalLen;

            public SamoindikatsiyaIndicatorSnapshot Clone()
            {
                return (SamoindikatsiyaIndicatorSnapshot)MemberwiseClone();
            }

            public static SamoindikatsiyaIndicatorSnapshot Capture(TrendMultiIndicatorScreener bot)
            {
                return new SamoindikatsiyaIndicatorSnapshot
                {
                    UseSma = bot._useSma.ValueBool,
                    UseRsi = bot._useRsi.ValueBool,
                    UseStoch = bot._useStoch.ValueBool,
                    UseMomentum = bot._useMomentum.ValueBool,
                    UseBollinger = bot._useBollinger.ValueBool,
                    UseLinReg = bot._useLinReg.ValueBool,
                    UseVolumeIndicator = bot._useVolumeIndicator.ValueBool,
                    UseVwap = bot._useVwap.ValueBool,
                    UseAtr = bot._useAtr.ValueBool,
                    UseMacd = bot._useMacd.ValueBool,
                    SmaLen = bot._smaLen.ValueInt,
                    RsiLen = bot._rsiLen.ValueInt,
                    RsiLongMin = bot._rsiLongMin.ValueDecimal,
                    RsiShortMax = bot._rsiShortMax.ValueDecimal,
                    StochP1 = bot._stochP1.ValueInt,
                    StochP2 = bot._stochP2.ValueInt,
                    StochP3 = bot._stochP3.ValueInt,
                    StochLongMin = bot._stochLongMin.ValueDecimal,
                    StochShortMax = bot._stochShortMax.ValueDecimal,
                    MomLen = bot._momLen.ValueInt,
                    MomLongMin = bot._momLongMin.ValueDecimal,
                    MomShortMax = bot._momShortMax.ValueDecimal,
                    BollLen = bot._bollLen.ValueInt,
                    BollDev = bot._bollDev.ValueDecimal,
                    LinRegLen = bot._linRegLen.ValueInt,
                    LinRegDev = bot._linRegDev.ValueDecimal,
                    VolumeIndicatorMinGrowthPercent = bot._volumeIndicatorMinGrowthPercent.ValueDecimal,
                    AtrLen = bot._atrLen.ValueInt,
                    AtrGrowPercent = bot._atrGrowPercent.ValueDecimal,
                    AtrGrowLookBack = bot._atrGrowLookBack.ValueInt,
                    MacdFastLen = bot._macdFastLen.ValueInt,
                    MacdSlowLen = bot._macdSlowLen.ValueInt,
                    MacdSignalLen = bot._macdSignalLen.ValueInt
                };
            }

            public void Apply(TrendMultiIndicatorScreener bot)
            {
                bot._useSma.ValueBool = UseSma;
                bot._useRsi.ValueBool = UseRsi;
                bot._useStoch.ValueBool = UseStoch;
                bot._useMomentum.ValueBool = UseMomentum;
                bot._useBollinger.ValueBool = UseBollinger;
                bot._useLinReg.ValueBool = UseLinReg;
                bot._useVolumeIndicator.ValueBool = UseVolumeIndicator;
                bot._useVwap.ValueBool = UseVwap;
                bot._useAtr.ValueBool = UseAtr;
                bot._useMacd.ValueBool = UseMacd;
                bot._smaLen.ValueInt = SmaLen;
                bot._rsiLen.ValueInt = RsiLen;
                bot._rsiLongMin.ValueDecimal = RsiLongMin;
                bot._rsiShortMax.ValueDecimal = RsiShortMax;
                bot._stochP1.ValueInt = StochP1;
                bot._stochP2.ValueInt = StochP2;
                bot._stochP3.ValueInt = StochP3;
                bot._stochLongMin.ValueDecimal = StochLongMin;
                bot._stochShortMax.ValueDecimal = StochShortMax;
                bot._momLen.ValueInt = MomLen;
                bot._momLongMin.ValueDecimal = MomLongMin;
                bot._momShortMax.ValueDecimal = MomShortMax;
                bot._bollLen.ValueInt = BollLen;
                bot._bollDev.ValueDecimal = BollDev;
                bot._linRegLen.ValueInt = LinRegLen;
                bot._linRegDev.ValueDecimal = LinRegDev;
                bot._volumeIndicatorMinGrowthPercent.ValueDecimal = VolumeIndicatorMinGrowthPercent;
                bot._atrLen.ValueInt = AtrLen;
                bot._atrGrowPercent.ValueDecimal = AtrGrowPercent;
                bot._atrGrowLookBack.ValueInt = AtrGrowLookBack;
                bot._macdFastLen.ValueInt = MacdFastLen;
                bot._macdSlowLen.ValueInt = MacdSlowLen;
                bot._macdSignalLen.ValueInt = MacdSignalLen;
            }
        }

        /// <summary>
        /// Достаточно свечей на вкладке для Reload индикаторов (иначе SMA и др. падают с ArgumentOutOfRange).
        /// </summary>
        private bool TabCanSafelyReloadIndicators(BotTabSimple tab)
        {
            if (tab == null)
            {
                return false;
            }

            List<Candle> candles = tab.CandlesAll;
            if (candles == null || candles.Count == 0)
            {
                return false;
            }

            return candles.Count >= GetMinBarsForTradingLogic();
        }

        /// <summary>
        /// Обновить параметры индикаторов на всех вкладках, где уже загружена история (без UpdateIndicatorsParameters по всему скринеру).
        /// </summary>
        private void RefreshAllTabsIndicatorsSafely()
        {
            if (_screenerTab?.Tabs == null)
            {
                return;
            }

            for (int i = 0; i < _screenerTab.Tabs.Count; i++)
            {
                RefreshSamoindikatsiyaTabIndicators(_screenerTab.Tabs[i]);
            }
        }

        /// <summary>
        /// После смены параметров робота — пересчитать индикаторы только на одной вкладке (быстро для самоиндикации).
        /// </summary>
        private void RefreshSamoindikatsiyaTabIndicators(BotTabSimple tab)
        {
            if (tab == null)
            {
                return;
            }

            if (_useSma.ValueBool)
            {
                ApplyIndicatorParamsToTab(tab, NumSma, "Sma", new List<string> { _smaLen.ValueInt.ToString(), "Close" });
            }

            if (_useRsi.ValueBool)
            {
                ApplyIndicatorParamsToTab(tab, NumRsi, "Rsi", new List<string> { _rsiLen.ValueInt.ToString(), "Close" });
            }

            if (_useStoch.ValueBool)
            {
                ApplyIndicatorParamsToTab(
                    tab,
                    NumStoch,
                    "Stochastic",
                    new List<string>
                    {
                        _stochP1.ValueInt.ToString(),
                        _stochP2.ValueInt.ToString(),
                        _stochP3.ValueInt.ToString()
                    });
            }

            if (_useMomentum.ValueBool)
            {
                ApplyIndicatorParamsToTab(tab, NumMomentum, "Momentum", new List<string> { _momLen.ValueInt.ToString(), "Close" });
            }

            if (_useBollinger.ValueBool)
            {
                ApplyIndicatorParamsToTab(
                    tab,
                    NumBollinger,
                    "Bollinger",
                    new List<string> { _bollLen.ValueInt.ToString(), _bollDev.ValueDecimal.ToString() });
            }

            if (_useLinReg.ValueBool)
            {
                ApplyIndicatorParamsToTab(
                    tab,
                    NumLinReg,
                    "LinearRegressionChannelFast_Indicator",
                    new List<string>
                    {
                        _linRegLen.ValueInt.ToString(),
                        "Close",
                        _linRegDev.ValueDecimal.ToString(),
                        _linRegDev.ValueDecimal.ToString()
                    });
            }

            if (_useAtr.ValueBool)
            {
                ApplyIndicatorParamsToTab(tab, NumAtr, "ATR", new List<string> { _atrLen.ValueInt.ToString(), "Absolute" });
            }

            if (_useMacd.ValueBool)
            {
                ApplyIndicatorParamsToTab(
                    tab,
                    NumMacd,
                    "MACD",
                    new List<string>
                    {
                        _macdFastLen.ValueInt.ToString(),
                        _macdSlowLen.ValueInt.ToString(),
                        _macdSignalLen.ValueInt.ToString()
                    });
            }
        }

        private void ApplyIndicatorParamsToTab(BotTabSimple tab, int num, string type, List<string> parameterValues)
        {
            Aindicator indicator = FindIndicator(tab, num, type);
            if (indicator?.Parameters == null || parameterValues == null)
            {
                return;
            }

            int count = Math.Min(parameterValues.Count, indicator.Parameters.Count);
            for (int i = 0; i < count; i++)
            {
                IndicatorParameter param = indicator.Parameters[i];
                string raw = parameterValues[i];

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

            if (TabCanSafelyReloadIndicators(tab))
            {
                try
                {
                    indicator.Reload();
                }
                catch (Exception ex)
                {
                    SendNewLogMessage(
                        NameStrategyUniq + " [" + tab.TabName + "]: Reload индикатора " + type + " — " + ex.Message,
                        LogMessageType.Error);
                }
            }
        }

        /// <summary>
        /// Диапазон свечей для виртуального портфеля самоиндикации (нужно endIdx &gt; startIdx).
        /// </summary>
        private bool TryGetSamoindikatsiyaSimulationRange(int candleCount, out int startIdx, out int endIdx)
        {
            startIdx = 0;
            endIdx = candleCount - 1;

            if (candleCount < 2)
            {
                return false;
            }

            int lookback = Math.Max(2, _samoindikatsiyaCandlesLookback.ValueInt);
            int minIdx = GetMinBarsForTradingLogic() - 1;
            startIdx = endIdx - lookback + 1;
            if (startIdx < minIdx)
            {
                startIdx = minIdx;
            }

            return endIdx > startIdx;
        }

        /// <summary>
        /// Виртуальный портфель по сигналам на окне свечей; итоговый equity (старт = 1).
        /// </summary>
        private bool TrySimulateSamoindikatsiyaVirtualEquity(
            List<Candle> candles,
            BotTabSimple tab,
            out decimal finalEquity)
        {
            finalEquity = 1m;

            if (candles == null || tab == null)
            {
                return false;
            }

            if (!TryGetSamoindikatsiyaSimulationRange(candles.Count, out int startIdx, out int endIdx))
            {
                return false;
            }

            string regime = _regime.ValueString ?? "Off";
            bool allowLong = regime != "OnlyShort" && regime != "OnlyClosePosition";
            bool allowShort = regime != "OnlyLong" && regime != "OnlyClosePosition";
            bool allowReverse = regime != "OnlyClosePosition";

            decimal equity = 1m;
            Side virtualSide = Side.None;

            for (int i = startIdx; i <= endIdx; i++)
            {
                if (i > startIdx && virtualSide != Side.None)
                {
                    decimal prevClose = candles[i - 1].Close;
                    decimal curClose = candles[i].Close;
                    if (prevClose <= 0m || curClose <= 0m)
                    {
                        return false;
                    }

                    decimal barFactor = virtualSide == Side.Buy
                        ? curClose / prevClose
                        : prevClose / curClose;

                    if (barFactor <= 0m || barFactor > SamoindikatsiyaMaxVirtualEquity)
                    {
                        return false;
                    }

                    equity *= barFactor;

                    if (equity <= 0m || equity > SamoindikatsiyaMaxVirtualEquity)
                    {
                        return false;
                    }
                }

                bool bull = IsBullSignalAt(candles, tab, i, forSamoindikatsiyaSimulation: true);
                bool bear = IsBearSignalAt(candles, tab, i, forSamoindikatsiyaSimulation: true);

                if (virtualSide == Side.None)
                {
                    if (bull && allowLong)
                    {
                        virtualSide = Side.Buy;
                    }
                    else if (bear && allowShort)
                    {
                        virtualSide = Side.Sell;
                    }
                }
                else if (virtualSide == Side.Buy && bear)
                {
                    if (allowReverse && allowShort)
                    {
                        virtualSide = Side.Sell;
                    }
                    else
                    {
                        virtualSide = Side.None;
                    }
                }
                else if (virtualSide == Side.Sell && bull)
                {
                    if (allowReverse && allowLong)
                    {
                        virtualSide = Side.Buy;
                    }
                    else
                    {
                        virtualSide = Side.None;
                    }
                }
            }

            if (equity <= 0m)
            {
                return false;
            }

            finalEquity = equity;
            return true;
        }

        private bool TryGetSamoindikatsiyaVirtualProfit(
            List<Candle> candles,
            BotTabSimple tab,
            out decimal profit)
        {
            profit = 0m;
            if (!TrySimulateSamoindikatsiyaVirtualEquity(candles, tab, out decimal equity))
            {
                return false;
            }

            profit = equity - 1m;
            return true;
        }

        private static int ClampSamoindikatsiyaInt(StrategyParameterInt param, int value)
        {
            return Math.Max(param.ValueIntStart, Math.Min(param.ValueIntStop, value));
        }

        private static int SamoindikatsiyaAdjustIntDelta(int current)
        {
            return Math.Max(1, (int)Math.Round(current * SamoindikatsiyaParamAdjustFraction, MidpointRounding.AwayFromZero));
        }

        private static decimal ClampSamoindikatsiyaDecimal(StrategyParameterDecimal param, decimal value)
        {
            return Math.Max(param.ValueDecimalStart, Math.Min(param.ValueDecimalStop, value));
        }

        private static decimal SamoindikatsiyaAdjustDecimalDelta(StrategyParameterDecimal param, decimal current)
        {
            decimal raw = current * SamoindikatsiyaParamAdjustFraction;
            decimal step = param.ValueDecimalStep;
            if (step > 0m)
            {
                raw = Math.Round(raw / step, MidpointRounding.AwayFromZero) * step;
            }

            if (raw <= 0m)
            {
                raw = step > 0m ? step : 0.0001m;
            }

            return raw;
        }

        private bool TrySamoindikatsiyaProfitWithSnapshotOverride(
            SamoindikatsiyaIndicatorSnapshot stepBaseline,
            List<Candle> candles,
            BotTabSimple tab,
            Action<SamoindikatsiyaIndicatorSnapshot> applyOverride,
            out decimal profit)
        {
            profit = 0m;
            SamoindikatsiyaIndicatorSnapshot trial = stepBaseline.Clone();
            applyOverride(trial);

            if (!SamoindikatsiyaSnapshotHasEnabledIndicator(trial))
            {
                return false;
            }

            trial.Apply(this);
            RefreshSamoindikatsiyaTabIndicators(tab);
            return TryGetSamoindikatsiyaVirtualProfit(candles, tab, out profit);
        }

        /// <summary>
        /// Use* на момент фиксации: для каждого включённого — проверка выкл/вкл с полного снимка шага.
        /// </summary>
        private void OptimizeSamoindikatsiyaBoolFromStepBaseline(
            SamoindikatsiyaIndicatorSnapshot stepBaseline,
            SamoindikatsiyaIndicatorSnapshot result,
            decimal stepBaselineProfit,
            List<Candle> candles,
            BotTabSimple tab,
            Func<SamoindikatsiyaIndicatorSnapshot, bool> getter,
            Action<SamoindikatsiyaIndicatorSnapshot, bool> setter)
        {
            bool original = getter(stepBaseline);
            bool bestValue = original;
            decimal bestProfit = stepBaselineProfit;

            for (int i = 0; i < 2; i++)
            {
                bool candidate = i == 0;
                if (candidate == original)
                {
                    continue;
                }

                if (TrySamoindikatsiyaProfitWithSnapshotOverride(
                        stepBaseline,
                        candles,
                        tab,
                        s => setter(s, candidate),
                        out decimal profit)
                    && profit > bestProfit)
                {
                    bestProfit = profit;
                    bestValue = candidate;
                }
            }

            setter(result, bestValue);
        }

        /// <summary>Все параметры индикаторов (Use* и числовые) уже созданы в конструкторе.</summary>
        private bool AreIndicatorParametersReadyForSamoindikatsiya()
        {
            return _useSma != null
                && _useRsi != null
                && _useStoch != null
                && _smaLen != null
                && _rsiLongMin != null
                && _stochLongMin != null
                && _smaAndGroup != null
                && _macdSignalLen != null;
        }

        private void RefreshSamoindikatsiyaEnabledAtLock()
        {
            if (!AreIndicatorParametersReadyForSamoindikatsiya())
            {
                return;
            }

            _samoindikatsiyaEnabledAtLock = SamoindikatsiyaIndicatorSnapshot.Capture(this);
        }

        private void ClearSamoindikatsiyaEnabledAtLock()
        {
            _samoindikatsiyaEnabledAtLock = null;
            _samoindikatsiyaFirstEntryBaselineCaptured = false;
        }

        private SamoindikatsiyaIndicatorSnapshot GetSamoindikatsiyaEnabledAtLock()
        {
            if (_samoindikatsiyaEnabledAtLock == null && _useSamoindikatsiya.ValueBool)
            {
                RefreshSamoindikatsiyaEnabledAtLock();
            }

            return _samoindikatsiyaEnabledAtLock;
        }

        private void EnsureSamoindikatsiyaEnabledAtLockForFirstEntry()
        {
            if (!_samoindikatsiyaFirstEntryBaselineCaptured)
            {
                RefreshSamoindikatsiyaEnabledAtLock();
                _samoindikatsiyaFirstEntryBaselineCaptured = true;
            }
        }

        private void UseSamoindikatsiya_ValueChange()
        {
            if (_useSamoindikatsiya.ValueBool)
            {
                if (AreIndicatorParametersReadyForSamoindikatsiya())
                {
                    RefreshSamoindikatsiyaEnabledAtLock();
                }

                _samoindikatsiyaFirstEntryBaselineCaptured = false;
            }
            else
            {
                ClearSamoindikatsiyaEnabledAtLock();
            }
        }

        private void OptimizeSamoindikatsiyaIntFromStepBaseline(
            SamoindikatsiyaIndicatorSnapshot stepBaseline,
            SamoindikatsiyaIndicatorSnapshot result,
            decimal stepBaselineProfit,
            List<Candle> candles,
            BotTabSimple tab,
            StrategyParameterInt param,
            Func<SamoindikatsiyaIndicatorSnapshot, int> getter,
            Action<SamoindikatsiyaIndicatorSnapshot, int> setter)
        {
            int original = getter(stepBaseline);
            int delta = SamoindikatsiyaAdjustIntDelta(original);
            int bestValue = original;
            decimal bestProfit = stepBaselineProfit;

            int plus = ClampSamoindikatsiyaInt(param, original + delta);
            if (plus != original
                && TrySamoindikatsiyaProfitWithSnapshotOverride(
                    stepBaseline,
                    candles,
                    tab,
                    s => setter(s, plus),
                    out decimal plusProfit)
                && plusProfit > bestProfit)
            {
                bestProfit = plusProfit;
                bestValue = plus;
            }

            int minus = ClampSamoindikatsiyaInt(param, original - delta);
            if (minus != original
                && TrySamoindikatsiyaProfitWithSnapshotOverride(
                    stepBaseline,
                    candles,
                    tab,
                    s => setter(s, minus),
                    out decimal minusProfit)
                && minusProfit > bestProfit)
            {
                bestProfit = minusProfit;
                bestValue = minus;
            }

            setter(result, bestValue);
        }

        private void OptimizeSamoindikatsiyaDecimalFromStepBaseline(
            SamoindikatsiyaIndicatorSnapshot stepBaseline,
            SamoindikatsiyaIndicatorSnapshot result,
            decimal stepBaselineProfit,
            List<Candle> candles,
            BotTabSimple tab,
            StrategyParameterDecimal param,
            Func<SamoindikatsiyaIndicatorSnapshot, decimal> getter,
            Action<SamoindikatsiyaIndicatorSnapshot, decimal> setter)
        {
            decimal original = getter(stepBaseline);
            decimal delta = SamoindikatsiyaAdjustDecimalDelta(param, original);
            decimal bestValue = original;
            decimal bestProfit = stepBaselineProfit;

            decimal plus = ClampSamoindikatsiyaDecimal(param, original + delta);
            if (plus != original
                && TrySamoindikatsiyaProfitWithSnapshotOverride(
                    stepBaseline,
                    candles,
                    tab,
                    s => setter(s, plus),
                    out decimal plusProfit)
                && plusProfit > bestProfit)
            {
                bestProfit = plusProfit;
                bestValue = plus;
            }

            decimal minus = ClampSamoindikatsiyaDecimal(param, original - delta);
            if (minus != original
                && TrySamoindikatsiyaProfitWithSnapshotOverride(
                    stepBaseline,
                    candles,
                    tab,
                    s => setter(s, minus),
                    out decimal minusProfit)
                && minusProfit > bestProfit)
            {
                bestProfit = minusProfit;
                bestValue = minus;
            }

            setter(result, bestValue);
        }

        /// <summary>
        /// Пересчёт параметров индикаторов: каждая проверка от снимка на начало шага.
        /// </summary>
        private void OptimizeIndicatorParametersForSamoindikatsiya(List<Candle> candles, BotTabSimple tab)
        {
            if (!TryGetSamoindikatsiyaSimulationRange(candles.Count, out _, out _))
            {
                return;
            }

            SamoindikatsiyaIndicatorSnapshot stepBaseline = SamoindikatsiyaIndicatorSnapshot.Capture(this);
            stepBaseline.Apply(this);
            RefreshSamoindikatsiyaTabIndicators(tab);

            SamoindikatsiyaIndicatorSnapshot enabledAtLock = GetSamoindikatsiyaEnabledAtLock();
            if (enabledAtLock == null
                || !SamoindikatsiyaSnapshotHasEnabledIndicator(enabledAtLock)
                || !TryGetSamoindikatsiyaVirtualProfit(candles, tab, out decimal stepBaselineProfit))
            {
                return;
            }

            SamoindikatsiyaIndicatorSnapshot result = stepBaseline.Clone();
            bool checkOnOff = _samoindikatsiyaCheckIndicatorOnOff.ValueBool;

            if (checkOnOff)
            {
                if (enabledAtLock.UseSma)
                {
                    OptimizeSamoindikatsiyaBoolFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, s => s.UseSma, (s, v) => s.UseSma = v);
                }

                if (enabledAtLock.UseRsi)
                {
                    OptimizeSamoindikatsiyaBoolFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, s => s.UseRsi, (s, v) => s.UseRsi = v);
                }

                if (enabledAtLock.UseStoch)
                {
                    OptimizeSamoindikatsiyaBoolFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, s => s.UseStoch, (s, v) => s.UseStoch = v);
                }

                if (enabledAtLock.UseMomentum)
                {
                    OptimizeSamoindikatsiyaBoolFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, s => s.UseMomentum, (s, v) => s.UseMomentum = v);
                }

                if (enabledAtLock.UseBollinger)
                {
                    OptimizeSamoindikatsiyaBoolFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, s => s.UseBollinger, (s, v) => s.UseBollinger = v);
                }

                if (enabledAtLock.UseLinReg)
                {
                    OptimizeSamoindikatsiyaBoolFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, s => s.UseLinReg, (s, v) => s.UseLinReg = v);
                }

                if (enabledAtLock.UseVolumeIndicator)
                {
                    OptimizeSamoindikatsiyaBoolFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, s => s.UseVolumeIndicator, (s, v) => s.UseVolumeIndicator = v);
                }

                if (enabledAtLock.UseVwap)
                {
                    OptimizeSamoindikatsiyaBoolFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, s => s.UseVwap, (s, v) => s.UseVwap = v);
                }

                if (enabledAtLock.UseAtr)
                {
                    OptimizeSamoindikatsiyaBoolFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, s => s.UseAtr, (s, v) => s.UseAtr = v);
                }

                if (enabledAtLock.UseMacd)
                {
                    OptimizeSamoindikatsiyaBoolFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, s => s.UseMacd, (s, v) => s.UseMacd = v);
                }
            }

            if (enabledAtLock.UseSma && (!checkOnOff || result.UseSma))
            {
                OptimizeSamoindikatsiyaIntFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, _smaLen, s => s.SmaLen, (s, v) => s.SmaLen = v);
            }

            if (enabledAtLock.UseRsi && (!checkOnOff || result.UseRsi))
            {
                OptimizeSamoindikatsiyaIntFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, _rsiLen, s => s.RsiLen, (s, v) => s.RsiLen = v);
                OptimizeSamoindikatsiyaDecimalFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, _rsiLongMin, s => s.RsiLongMin, (s, v) => s.RsiLongMin = v);
                OptimizeSamoindikatsiyaDecimalFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, _rsiShortMax, s => s.RsiShortMax, (s, v) => s.RsiShortMax = v);
            }

            if (enabledAtLock.UseStoch && (!checkOnOff || result.UseStoch))
            {
                OptimizeSamoindikatsiyaIntFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, _stochP1, s => s.StochP1, (s, v) => s.StochP1 = v);
                OptimizeSamoindikatsiyaIntFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, _stochP2, s => s.StochP2, (s, v) => s.StochP2 = v);
                OptimizeSamoindikatsiyaIntFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, _stochP3, s => s.StochP3, (s, v) => s.StochP3 = v);
                OptimizeSamoindikatsiyaDecimalFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, _stochLongMin, s => s.StochLongMin, (s, v) => s.StochLongMin = v);
                OptimizeSamoindikatsiyaDecimalFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, _stochShortMax, s => s.StochShortMax, (s, v) => s.StochShortMax = v);
            }

            if (enabledAtLock.UseMomentum && (!checkOnOff || result.UseMomentum))
            {
                OptimizeSamoindikatsiyaIntFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, _momLen, s => s.MomLen, (s, v) => s.MomLen = v);
                OptimizeSamoindikatsiyaDecimalFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, _momLongMin, s => s.MomLongMin, (s, v) => s.MomLongMin = v);
                OptimizeSamoindikatsiyaDecimalFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, _momShortMax, s => s.MomShortMax, (s, v) => s.MomShortMax = v);
            }

            if (enabledAtLock.UseBollinger && (!checkOnOff || result.UseBollinger))
            {
                OptimizeSamoindikatsiyaIntFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, _bollLen, s => s.BollLen, (s, v) => s.BollLen = v);
                OptimizeSamoindikatsiyaDecimalFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, _bollDev, s => s.BollDev, (s, v) => s.BollDev = v);
            }

            if (enabledAtLock.UseLinReg && (!checkOnOff || result.UseLinReg))
            {
                OptimizeSamoindikatsiyaIntFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, _linRegLen, s => s.LinRegLen, (s, v) => s.LinRegLen = v);
                OptimizeSamoindikatsiyaDecimalFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, _linRegDev, s => s.LinRegDev, (s, v) => s.LinRegDev = v);
            }

            if (enabledAtLock.UseVolumeIndicator && (!checkOnOff || result.UseVolumeIndicator))
            {
                OptimizeSamoindikatsiyaDecimalFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, _volumeIndicatorMinGrowthPercent, s => s.VolumeIndicatorMinGrowthPercent, (s, v) => s.VolumeIndicatorMinGrowthPercent = v);
            }

            if (enabledAtLock.UseAtr && (!checkOnOff || result.UseAtr))
            {
                OptimizeSamoindikatsiyaIntFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, _atrLen, s => s.AtrLen, (s, v) => s.AtrLen = v);
                OptimizeSamoindikatsiyaDecimalFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, _atrGrowPercent, s => s.AtrGrowPercent, (s, v) => s.AtrGrowPercent = v);
                OptimizeSamoindikatsiyaIntFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, _atrGrowLookBack, s => s.AtrGrowLookBack, (s, v) => s.AtrGrowLookBack = v);
            }

            if (enabledAtLock.UseMacd && (!checkOnOff || result.UseMacd))
            {
                OptimizeSamoindikatsiyaIntFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, _macdFastLen, s => s.MacdFastLen, (s, v) => s.MacdFastLen = v);
                OptimizeSamoindikatsiyaIntFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, _macdSlowLen, s => s.MacdSlowLen, (s, v) => s.MacdSlowLen = v);
                OptimizeSamoindikatsiyaIntFromStepBaseline(stepBaseline, result, stepBaselineProfit, candles, tab, _macdSignalLen, s => s.MacdSignalLen, (s, v) => s.MacdSignalLen = v);
            }

            result.Apply(this);
            SyncIndicators();
            RefreshSamoindikatsiyaTabIndicators(tab);
        }

        /// <summary>Учесть закрытие бара (один раз на время свечи для всего робота).</summary>
        private void SamoindikatsiyaTickBarCounter(DateTime barTime)
        {
            if (barTime != _samoindikatsiyaLastCountedBarTime)
            {
                _samoindikatsiyaGlobalBarCounter++;
                _samoindikatsiyaLastCountedBarTime = barTime;
            }
        }

        /// <summary>Текущий бар — свеча пересчёта (каждые N закрытых баров).</summary>
        private bool IsSamoindikatsiyaRecalcCandle()
        {
            int interval = Math.Max(1, _samoindikatsiyaRecalcEveryNCandles.ValueInt);
            return _samoindikatsiyaGlobalBarCounter % interval == 0;
        }

        /// <summary>
        /// Самоиндикация: перед входом — подбор параметров; сигналы пересчитываются после подбора.
        /// </summary>
        private bool TryApplySamoindikatsiyaBeforeEntry(
            List<Candle> candles,
            BotTabSimple tab,
            out bool bull,
            out bool bear)
        {
            bull = false;
            bear = false;

            if (candles == null || tab == null)
            {
                return false;
            }

            if (!_useSamoindikatsiya.ValueBool)
            {
                bull = IsBullSignal(candles, tab);
                bear = IsBearSignal(candles, tab);
                ApplyInvertEntryLogic(ref bull, ref bear);
                return true;
            }

            EnsureSamoindikatsiyaEnabledAtLockForFirstEntry();

            DateTime barTime = candles[^1].TimeStart;
            bool isRecalcCandle = IsSamoindikatsiyaRecalcCandle();
            bool hasEntrySignal = IsBullSignal(candles, tab) || IsBearSignal(candles, tab);

            SamoindikatsiyaIndicatorSnapshot enabledAtLock = GetSamoindikatsiyaEnabledAtLock();

            if (hasEntrySignal
                && isRecalcCandle
                && barTime != _samoindikatsiyaLastOptimizedBarTime
                && enabledAtLock != null
                && SamoindikatsiyaSnapshotHasEnabledIndicator(enabledAtLock)
                && TryGetSamoindikatsiyaSimulationRange(candles.Count, out _, out _))
            {
                OptimizeIndicatorParametersForSamoindikatsiya(candles, tab);
                _samoindikatsiyaLastOptimizedBarTime = barTime;
            }

            bull = IsBullSignal(candles, tab);
            bear = IsBearSignal(candles, tab);
            ApplyInvertEntryLogic(ref bull, ref bear);
            return true;
        }

        private void ApplyInvertEntryLogic(ref bool bull, ref bool bear)
        {
            if (IsEntryLogicInverted())
            {
                bool tmp = bull;
                bull = bear;
                bear = tmp;
            }
        }

        /// <summary>
        /// Бычий сигнал на свече candleIndex (для самоиндикации / исторического прохода).
        /// </summary>
        private bool IsBullSignalAt(
            List<Candle> candles,
            BotTabSimple tab,
            int candleIndex,
            bool forSamoindikatsiyaSimulation = false)
        {
            decimal close = candles[candleIndex].Close;
            var items = new List<(int group, bool pass)>();

            AddGroupedIndicatorResult(items, _smaAndGroup, BullSmaPasses(close, tab, candleIndex));
            AddGroupedIndicatorResult(items, _rsiAndGroup, BullRsiPasses(close, tab, candleIndex));
            AddGroupedIndicatorResult(items, _stochAndGroup, BullStochPasses(close, tab, candleIndex));
            AddGroupedIndicatorResult(items, _momAndGroup, BullMomentumPasses(close, tab, candleIndex));
            AddGroupedIndicatorResult(items, _bollAndGroup, BullBollingerPasses(close, tab, candleIndex));
            AddGroupedIndicatorResult(items, _linRegAndGroup, BullLinRegPasses(close, tab, candleIndex));
            AddGroupedIndicatorResult(items, _volumeAndGroup, BullVolumePasses(candles, tab, candleIndex));
#if false // RZIgreensMinusReds
            AddGroupedIndicatorResult(items, _rziAndGroup, BullRziPasses(close, tab, candleIndex));
#endif
#if false // AverageProfitPercentLong
            AddGroupedIndicatorResult(items, _avgProfitPercentLongAndGroup, BullAverageProfitPercentLongPasses(candles, tab, candleIndex));
#endif
            AddGroupedIndicatorResult(items, _vwapAndGroup, BullVwapPasses(close, tab, candleIndex));
            AddGroupedIndicatorResult(items, _atrAndGroup, BullAtrPasses(tab, candleIndex));
            AddGroupedIndicatorResult(items, _macdAndGroup, BullMacdPasses(tab, candleIndex));

            return CombineGroupedOrOfAnds(items, emptyMeansPass: !forSamoindikatsiyaSimulation);
        }

        /// <summary>
        /// Медвежий сигнал на свече candleIndex (для самоиндикации / исторического прохода).
        /// </summary>
        private bool IsBearSignalAt(
            List<Candle> candles,
            BotTabSimple tab,
            int candleIndex,
            bool forSamoindikatsiyaSimulation = false)
        {
            decimal close = candles[candleIndex].Close;
            var items = new List<(int group, bool pass)>();

            AddGroupedIndicatorResult(items, _smaAndGroup, BearSmaPasses(close, tab, candleIndex));
            AddGroupedIndicatorResult(items, _rsiAndGroup, BearRsiPasses(close, tab, candleIndex));
            AddGroupedIndicatorResult(items, _stochAndGroup, BearStochPasses(close, tab, candleIndex));
            AddGroupedIndicatorResult(items, _momAndGroup, BearMomentumPasses(close, tab, candleIndex));
            AddGroupedIndicatorResult(items, _bollAndGroup, BearBollingerPasses(close, tab, candleIndex));
            AddGroupedIndicatorResult(items, _linRegAndGroup, BearLinRegPasses(close, tab, candleIndex));
            AddGroupedIndicatorResult(items, _volumeAndGroup, BearVolumePasses(candles, tab, candleIndex));
#if false // RZIgreensMinusReds
            AddGroupedIndicatorResult(items, _rziAndGroup, BearRziPasses(close, tab, candleIndex));
#endif
#if false // AverageProfitPercentLong
            AddGroupedIndicatorResult(items, _avgProfitPercentLongAndGroup, BearAverageProfitPercentLongPasses(candles, tab, candleIndex));
#endif
            AddGroupedIndicatorResult(items, _vwapAndGroup, BearVwapPasses(close, tab, candleIndex));
            AddGroupedIndicatorResult(items, _atrAndGroup, BearAtrPasses(tab, candleIndex));
            AddGroupedIndicatorResult(items, _macdAndGroup, BearMacdPasses(tab, candleIndex));

            return CombineGroupedOrOfAnds(items, emptyMeansPass: !forSamoindikatsiyaSimulation);
        }

        /// <summary>
        /// Лонг: собирает бычьи проверки всех включённых индикаторов с их «№ И-группы» и передаёт
        /// в <see cref="CombineGroupedOrOfAnds"/> (см. комментарий к полям *_AndGroup выше).
        /// </summary>
        private bool IsBullSignal(List<Candle> candles, BotTabSimple tab)
        {
            decimal close = candles[candles.Count - 1].Close;
            var items = new List<(int group, bool pass)>();

            int idx = candles.Count - 1;
            AddGroupedIndicatorResult(items, _smaAndGroup, BullSmaPasses(close, tab, idx));
            AddGroupedIndicatorResult(items, _rsiAndGroup, BullRsiPasses(close, tab, idx));
            AddGroupedIndicatorResult(items, _stochAndGroup, BullStochPasses(close, tab, idx));
            AddGroupedIndicatorResult(items, _momAndGroup, BullMomentumPasses(close, tab, idx));
            AddGroupedIndicatorResult(items, _bollAndGroup, BullBollingerPasses(close, tab, idx));
            AddGroupedIndicatorResult(items, _linRegAndGroup, BullLinRegPasses(close, tab, idx));
#if false // DiscreteMidBestPair
            AddGroupedIndicatorResult(items, _discreteAndGroup, BullDiscretePasses(candles, tab));
#endif
            AddGroupedIndicatorResult(items, _volumeAndGroup, BullVolumePasses(candles, tab, idx));
#if false // RZIgreensMinusReds
            AddGroupedIndicatorResult(items, _rziAndGroup, BullRziPasses(close, tab, idx));
#endif
#if false // AverageProfitPercentLong
            AddGroupedIndicatorResult(items, _avgProfitPercentLongAndGroup, BullAverageProfitPercentLongPasses(candles, tab, idx));
#endif
            AddGroupedIndicatorResult(items, _vwapAndGroup, BullVwapPasses(close, tab, idx));
            AddGroupedIndicatorResult(items, _atrAndGroup, BullAtrPasses(tab, idx));
            AddGroupedIndicatorResult(items, _macdAndGroup, BullMacdPasses(tab, idx));

            return CombineGroupedOrOfAnds(items);
        }

        /// <summary>
        /// Шорт: та же схема И-групп / ИЛИ между группами, что и для лонга, но с медвежьими *Passes.
        /// </summary>
        private bool IsBearSignal(List<Candle> candles, BotTabSimple tab)
        {
            decimal close = candles[candles.Count - 1].Close;
            var items = new List<(int group, bool pass)>();

            int idx = candles.Count - 1;
            AddGroupedIndicatorResult(items, _smaAndGroup, BearSmaPasses(close, tab, idx));
            AddGroupedIndicatorResult(items, _rsiAndGroup, BearRsiPasses(close, tab, idx));
            AddGroupedIndicatorResult(items, _stochAndGroup, BearStochPasses(close, tab, idx));
            AddGroupedIndicatorResult(items, _momAndGroup, BearMomentumPasses(close, tab, idx));
            AddGroupedIndicatorResult(items, _bollAndGroup, BearBollingerPasses(close, tab, idx));
            AddGroupedIndicatorResult(items, _linRegAndGroup, BearLinRegPasses(close, tab, idx));
#if false // DiscreteMidBestPair
            AddGroupedIndicatorResult(items, _discreteAndGroup, BearDiscretePasses(candles, tab));
#endif
            AddGroupedIndicatorResult(items, _volumeAndGroup, BearVolumePasses(candles, tab, idx));
#if false // RZIgreensMinusReds
            AddGroupedIndicatorResult(items, _rziAndGroup, BearRziPasses(close, tab, idx));
#endif
#if false // AverageProfitPercentLong
            AddGroupedIndicatorResult(items, _avgProfitPercentLongAndGroup, BearAverageProfitPercentLongPasses(candles, tab, idx));
#endif
            AddGroupedIndicatorResult(items, _vwapAndGroup, BearVwapPasses(close, tab, idx));
            AddGroupedIndicatorResult(items, _atrAndGroup, BearAtrPasses(tab, idx));
            AddGroupedIndicatorResult(items, _macdAndGroup, BearMacdPasses(tab, idx));

            return CombineGroupedOrOfAnds(items);
        }

        /// <summary>
        /// SMA: close выше линии — бычье условие.
        /// </summary>
        private bool? BullSmaPasses(decimal close, BotTabSimple tab, int candleIndex = -1)
        {
            if (!_useSma.ValueBool)
                return null;
            Aindicator sma = FindIndicator(tab, NumSma, "Sma");
            if (sma == null)
                return false;
            decimal v = SeriesValueAt(sma, 0, candleIndex);
            return v != 0 && close > v;
        }

        /// <summary>
        /// RSI ≥ long min.
        /// </summary>
        private bool? BullRsiPasses(decimal close, BotTabSimple tab, int candleIndex = -1)
        {
            if (!_useRsi.ValueBool)
                return null;
            Aindicator rsi = FindIndicator(tab, NumRsi, "Rsi");
            if (rsi == null)
                return false;
            decimal v = SeriesValueAt(rsi, 0, candleIndex);
            return v != 0 && v >= _rsiLongMin.ValueDecimal;
        }

        /// <summary>
        /// Stochastic K ≥ long min.
        /// </summary>
        private bool? BullStochPasses(decimal close, BotTabSimple tab, int candleIndex = -1)
        {
            if (!_useStoch.ValueBool)
                return null;
            Aindicator st = FindIndicator(tab, NumStoch, "Stochastic");
            if (st == null)
                return false;
            decimal k = SeriesValueAt(st, 0, candleIndex);
            return k != 0 && k >= _stochLongMin.ValueDecimal;
        }

        /// <summary>
        /// Momentum ≥ long min.
        /// </summary>
        private bool? BullMomentumPasses(decimal close, BotTabSimple tab, int candleIndex = -1)
        {
            if (!_useMomentum.ValueBool)
                return null;
            Aindicator mom = FindIndicator(tab, NumMomentum, "Momentum");
            if (mom == null)
                return false;
            decimal v = SeriesValueAt(mom, 0, candleIndex);
            return v != 0 && v >= _momLongMin.ValueDecimal;
        }

        /// <summary>
        /// Close выше середины полос.
        /// </summary>
        private bool? BullBollingerPasses(decimal close, BotTabSimple tab, int candleIndex = -1)
        {
            if (!_useBollinger.ValueBool)
                return null;
            Aindicator boll = FindIndicator(tab, NumBollinger, "Bollinger");
            if (boll == null || boll.DataSeries.Count < 2)
                return false;
            decimal up = SeriesValueAt(boll, 0, candleIndex);
            decimal down = SeriesValueAt(boll, 1, candleIndex);
            if (up == 0 || down == 0)
                return false;
            decimal mid = (up + down) / 2m;
            return close > mid;
        }

        /// <summary>
        /// Close выше верхней линии LinReg.
        /// </summary>
        private bool? BullLinRegPasses(decimal close, BotTabSimple tab, int candleIndex = -1)
        {
            if (!_useLinReg.ValueBool)
                return null;
            Aindicator lr = FindIndicator(tab, NumLinReg, "LinearRegressionChannelFast_Indicator");
            if (lr == null)
                return false;
            decimal up = SeriesValueAt(lr, 0, candleIndex);
            return up != 0 && close > up;
        }

#if false // RZIgreensMinusReds
        /// <summary>
        /// RZI > уровня сигнала.
        /// </summary>
        private bool? BullRziPasses(decimal close, BotTabSimple tab, int candleIndex = -1)
        {
            if (!_useRzi.ValueBool)
                return null;
            Aindicator rzi = FindIndicator(tab, NumRzi, "RZIgreensMinusReds");
            if (rzi == null)
                return false;
            decimal v = SeriesValueAt(rzi, 0, candleIndex);
            return v > _rziSignalLevel.ValueInt;
        }
#endif

#if false // DiscreteMidBestPair
        private bool? BullDiscretePasses(List<Candle> candles, BotTabSimple tab)
        {
            if (!_useDiscreteMidBestPair.ValueBool)
                return null;
            Aindicator dmb = FindIndicator(tab, NumDiscreteMidBestPair, "DiscreteMidBestPair");
            if (dmb == null || dmb.DataSeries.Count < 2)
                return false;
            decimal first = dmb.DataSeries[0].Last;
            decimal second = dmb.DataSeries[1].Last;
            decimal diff = second - first;
            int thr = _discreteEntryThreshold.ValueInt;
            return diff > 0 && diff >= thr;
        }
#endif

        /// <summary>
        /// Рост объёма свечи vs предыдущая.
        /// </summary>
        private bool? BullVolumePasses(List<Candle> candles, BotTabSimple tab, int candleIndex = -1)
        {
            if (!_useVolumeIndicator.ValueBool)
                return null;
            return VolumeIndicatorGrowthOk(candles, tab, candleIndex);
        }

#if false // AverageProfitPercentLong
        /// <summary>
        /// Avg Profit % Long > bull min.
        /// </summary>
        private bool? BullAverageProfitPercentLongPasses(List<Candle> candles, BotTabSimple tab, int candleIndex = -1)
        {
            if (!_useAverageProfitPercentLong.ValueBool)
                return null;
            int period = Math.Max(2, _avgProfitPercentLongPeriod.ValueInt);
            int idx = candleIndex >= 0 ? candleIndex : candles.Count - 1;
            if (candles == null || idx < period - 1)
                return false;
            Aindicator ap = FindIndicator(tab, NumAverageProfitPercentLong, AverageProfitPercentLongIndicatorType);
            if (ap == null || ap.DataSeries == null || ap.DataSeries.Count < 1)
                return false;
            decimal v = SeriesValueAt(ap, 0, idx);
            return v > _avgProfitPercentLongBullMin.ValueDecimal;
        }
#endif

        /// <summary>
        /// VWAP: close выше линии (лонг).
        /// </summary>
        private bool? BullVwapPasses(decimal close, BotTabSimple tab, int candleIndex = -1)
        {
            if (!_useVwap.ValueBool)
            {
                return null;
            }

            Aindicator vwap = FindIndicator(tab, NumVwap, VwapIndicatorType);
            if (vwap == null)
            {
                return false;
            }

            decimal v = SeriesValueAt(vwap, 0, candleIndex);
            return v != 0 && close > v;
        }

        /// <summary>
        /// ATR: рост волатильности на % за lookback (фильтр, без направления).
        /// </summary>
        private bool? BullAtrPasses(BotTabSimple tab, int candleIndex = -1)
        {
            return AtrVolatilityFilterPasses(tab, candleIndex);
        }

        /// <summary>
        /// ATR вырос минимум на заданный % относительно значения lookback свечей назад.
        /// </summary>
        private bool? AtrVolatilityFilterPasses(BotTabSimple tab, int candleIndex)
        {
            if (!_useAtr.ValueBool)
            {
                return null;
            }

            Aindicator atr = FindIndicator(tab, NumAtr, "ATR");
            if (atr == null || atr.DataSeries == null || atr.DataSeries.Count == 0)
            {
                return false;
            }

            int lookBack = Math.Max(1, _atrGrowLookBack.ValueInt);
            int idx = candleIndex;

            if (idx < 0)
            {
                if (atr.DataSeries[0].Values == null || atr.DataSeries[0].Values.Count == 0)
                {
                    return false;
                }

                idx = atr.DataSeries[0].Values.Count - 1;
            }

            if (idx < lookBack)
            {
                return false;
            }

            decimal atrLast = SeriesValueAt(atr, 0, idx);
            decimal atrPast = SeriesValueAt(atr, 0, idx - lookBack);

            if (atrLast == 0 || atrPast == 0)
            {
                return false;
            }

            decimal growPercent = atrLast / (atrPast / 100m) - 100m;
            return growPercent >= _atrGrowPercent.ValueDecimal;
        }

        /// <summary>
        /// VWAP: close ниже линии (шорт).
        /// </summary>
        private bool? BearVwapPasses(decimal close, BotTabSimple tab, int candleIndex = -1)
        {
            if (!_useVwap.ValueBool)
            {
                return null;
            }

            Aindicator vwap = FindIndicator(tab, NumVwap, VwapIndicatorType);
            if (vwap == null)
            {
                return false;
            }

            decimal v = SeriesValueAt(vwap, 0, candleIndex);
            return v != 0 && close < v;
        }

        /// <summary>
        /// ATR: тот же фильтр роста волатильности, что и для лонга.
        /// </summary>
        private bool? BearAtrPasses(BotTabSimple tab, int candleIndex = -1)
        {
            return AtrVolatilityFilterPasses(tab, candleIndex);
        }

        /// <summary>
        /// MACD: линия MACD выше сигнальной (лонг).
        /// </summary>
        private bool? BullMacdPasses(BotTabSimple tab, int candleIndex = -1)
        {
            if (!_useMacd.ValueBool)
            {
                return null;
            }

            Aindicator macd = FindIndicator(tab, NumMacd, "MACD");
            if (macd == null || macd.DataSeries.Count < 3)
            {
                return false;
            }

            decimal macdLine = SeriesValueAt(macd, 1, candleIndex);
            decimal signalLine = SeriesValueAt(macd, 2, candleIndex);
            return macdLine != 0 && signalLine != 0 && macdLine > signalLine;
        }

        /// <summary>
        /// MACD: линия MACD ниже сигнальной (шорт).
        /// </summary>
        private bool? BearMacdPasses(BotTabSimple tab, int candleIndex = -1)
        {
            if (!_useMacd.ValueBool)
            {
                return null;
            }

            Aindicator macd = FindIndicator(tab, NumMacd, "MACD");
            if (macd == null || macd.DataSeries.Count < 3)
            {
                return false;
            }

            decimal macdLine = SeriesValueAt(macd, 1, candleIndex);
            decimal signalLine = SeriesValueAt(macd, 2, candleIndex);
            return macdLine != 0 && signalLine != 0 && macdLine < signalLine;
        }

        /// <summary>
        /// SMA: close ниже линии.
        /// </summary>
        private bool? BearSmaPasses(decimal close, BotTabSimple tab, int candleIndex = -1)
        {
            if (!_useSma.ValueBool)
                return null;
            Aindicator sma = FindIndicator(tab, NumSma, "Sma");
            if (sma == null)
                return false;
            decimal v = SeriesValueAt(sma, 0, candleIndex);
            return v != 0 && close < v;
        }

        /// <summary>
        /// RSI ≤ short max.
        /// </summary>
        private bool? BearRsiPasses(decimal close, BotTabSimple tab, int candleIndex = -1)
        {
            if (!_useRsi.ValueBool)
                return null;
            Aindicator rsi = FindIndicator(tab, NumRsi, "Rsi");
            if (rsi == null)
                return false;
            decimal v = SeriesValueAt(rsi, 0, candleIndex);
            return v != 0 && v <= _rsiShortMax.ValueDecimal;
        }

        /// <summary>
        /// Stochastic K ≤ short max.
        /// </summary>
        private bool? BearStochPasses(decimal close, BotTabSimple tab, int candleIndex = -1)
        {
            if (!_useStoch.ValueBool)
                return null;
            Aindicator st = FindIndicator(tab, NumStoch, "Stochastic");
            if (st == null)
                return false;
            decimal k = SeriesValueAt(st, 0, candleIndex);
            return k != 0 && k <= _stochShortMax.ValueDecimal;
        }

        /// <summary>
        /// Momentum ≤ short max.
        /// </summary>
        private bool? BearMomentumPasses(decimal close, BotTabSimple tab, int candleIndex = -1)
        {
            if (!_useMomentum.ValueBool)
                return null;
            Aindicator mom = FindIndicator(tab, NumMomentum, "Momentum");
            if (mom == null)
                return false;
            decimal v = SeriesValueAt(mom, 0, candleIndex);
            return v != 0 && v <= _momShortMax.ValueDecimal;
        }

        /// <summary>
        /// Close ниже середины полос.
        /// </summary>
        private bool? BearBollingerPasses(decimal close, BotTabSimple tab, int candleIndex = -1)
        {
            if (!_useBollinger.ValueBool)
                return null;
            Aindicator boll = FindIndicator(tab, NumBollinger, "Bollinger");
            if (boll == null || boll.DataSeries.Count < 2)
                return false;
            decimal up = SeriesValueAt(boll, 0, candleIndex);
            decimal down = SeriesValueAt(boll, 1, candleIndex);
            if (up == 0 || down == 0)
                return false;
            decimal mid = (up + down) / 2m;
            return close < mid;
        }

        /// <summary>
        /// Close ниже нижней линии LinReg.
        /// </summary>
        private bool? BearLinRegPasses(decimal close, BotTabSimple tab, int candleIndex = -1)
        {
            if (!_useLinReg.ValueBool)
                return null;
            Aindicator lr = FindIndicator(tab, NumLinReg, "LinearRegressionChannelFast_Indicator");
            if (lr == null || lr.DataSeries.Count < 3)
                return false;
            decimal down = SeriesValueAt(lr, 2, candleIndex);
            return down != 0 && close < down;
        }

#if false // RZIgreensMinusReds
        /// <summary>
        /// RZI < −уровня.
        /// </summary>
        private bool? BearRziPasses(decimal close, BotTabSimple tab, int candleIndex = -1)
        {
            if (!_useRzi.ValueBool)
                return null;
            Aindicator rzi = FindIndicator(tab, NumRzi, "RZIgreensMinusReds");
            if (rzi == null)
                return false;
            decimal v = SeriesValueAt(rzi, 0, candleIndex);
            decimal shortBound = -_rziSignalLevel.ValueInt;
            return v < shortBound;
        }
#endif

#if false // DiscreteMidBestPair
        private bool? BearDiscretePasses(List<Candle> candles, BotTabSimple tab)
        {
            if (!_useDiscreteMidBestPair.ValueBool)
                return null;
            Aindicator dmb = FindIndicator(tab, NumDiscreteMidBestPair, "DiscreteMidBestPair");
            if (dmb == null || dmb.DataSeries.Count < 2)
                return false;
            decimal first = dmb.DataSeries[0].Last;
            decimal second = dmb.DataSeries[1].Last;
            decimal diff = second - first;
            int thr = _discreteEntryThreshold.ValueInt;
            return diff < 0 && -diff > thr;
        }
#endif

        /// <summary>
        /// Рост объёма (то же условие, что для лонга).
        /// </summary>
        private bool? BearVolumePasses(List<Candle> candles, BotTabSimple tab, int candleIndex = -1)
        {
            if (!_useVolumeIndicator.ValueBool)
                return null;
            return VolumeIndicatorGrowthOk(candles, tab, candleIndex);
        }

#if false // AverageProfitPercentLong
        /// <summary>
        /// Avg Profit % Long < bear max.
        /// </summary>
        private bool? BearAverageProfitPercentLongPasses(List<Candle> candles, BotTabSimple tab, int candleIndex = -1)
        {
            if (!_useAverageProfitPercentLong.ValueBool)
                return null;
            int period = Math.Max(2, _avgProfitPercentLongPeriod.ValueInt);
            int idx = candleIndex >= 0 ? candleIndex : candles.Count - 1;
            if (candles == null || idx < period - 1)
                return false;
            Aindicator ap = FindIndicator(tab, NumAverageProfitPercentLong, AverageProfitPercentLongIndicatorType);
            if (ap == null || ap.DataSeries == null || ap.DataSeries.Count < 1)
                return false;
            decimal v = SeriesValueAt(ap, 0, idx);
            return v < _avgProfitPercentLongBearMax.ValueDecimal;
        }
#endif

        /// <summary>
        /// Поиск индикатора на вкладке по номеру+типу+TabName или по имени типа.
        /// </summary>
        private Aindicator FindIndicator(BotTabSimple tab, int num, string type)
        {
            if (tab == null || tab.Indicators == null || tab.Indicators.Count == 0)
            {
                return null;
            }

            string expectedName = num + type + _screenerTab.TabName;

            for (int i = 0; i < tab.Indicators.Count; i++)
            {
                if (tab.Indicators[i] != null && tab.Indicators[i].Name == expectedName)
                {
                    return tab.Indicators[i] as Aindicator;
                }
            }

            // Fallback: try by type name (in case naming differs due to user manipulation)
            for (int i = 0; i < tab.Indicators.Count; i++)
            {
                if (tab.Indicators[i] is Aindicator ai && ai.GetType().Name.Equals(type, StringComparison.OrdinalIgnoreCase))
                {
                    return ai;
                }
            }

            return null;
        }

        /// <summary>
        /// Индикатор Volume: объём текущей (закрытой) свечи не ниже чем у предыдущей, увеличенный на заданный %.
        /// </summary>
        private bool VolumeIndicatorGrowthOk(List<Candle> candles, BotTabSimple tab, int candleIndex = -1)
        {
            if (!_useVolumeIndicator.ValueBool)
                return true;

            if (candles == null || candles.Count < 2)
                return false;

            int idx = candleIndex >= 0 ? candleIndex : candles.Count - 1;
            if (idx < 1)
                return false;

            Aindicator volInd = FindIndicator(tab, NumVolumeIndicator, "Volume");
            if (volInd == null || volInd.DataSeries.Count < 1)
                return false;

            decimal curVol = candles[idx].Volume;
            decimal prevVol = candles[idx - 1].Volume;
            decimal pct = _volumeIndicatorMinGrowthPercent.ValueDecimal;

            if (prevVol <= 0m)
                return curVol > 0m;

            decimal minRequired = prevVol * (1m + pct / 100m);
            return curVol >= minRequired;
        }

#if false // DiscreteMidBestPair
        private string DiscreteOpenSignal()
        {
            return _useDiscreteMidBestPair.ValueBool ? SignalOpenWithDiscreteSlTp : "";
        }

        /// <summary>
        /// Ширина одного дискретного диапазона в цене (как в DiscreteMidBestPair): (maxMid−minMid)/(levels−1) по всем свечам окна.
        /// </summary>
        private bool TryComputeDiscreteRangeStep(List<Candle> candles, out decimal rangeStep)
        {
            rangeStep = 0;
            if (candles == null || candles.Count == 0)
                return false;

            int levels = _discreteMidBestPairLevels.ValueInt;
            if (levels < 2)
                levels = 2;

            decimal minMid = decimal.MaxValue;
            decimal maxMid = decimal.MinValue;
            for (int i = 0; i < candles.Count; i++)
            {
                Candle c = candles[i];
                decimal mid = (c.Open + c.Close) * 0.5m;
                if (mid < minMid) minMid = mid;
                if (mid > maxMid) maxMid = mid;
            }

            if (minMid == maxMid)
                return false;

            rangeStep = (maxMid - minMid) / (levels - 1);
            return rangeStep > 0;
        }

        /// <summary>
        /// SL: на один диапазон ниже входа (лонг) или выше (шорт). TP: цена одного диапазона × (уровень1 − уровень2) от индикатора, в цене: entry − rangeStep×(first−second) (линия активации тейка).
        /// </summary>
        private void TryPlaceDiscreteStopAndProfit(BotTabSimple tab, List<Candle> candles)
        {
            if (!_useDiscreteMidBestPair.ValueBool
                || tab == null
                || candles == null
                || candles.Count == 0)
            {
                return;
            }

            if (!TryComputeDiscreteRangeStep(candles, out decimal rangeStep))
                return;

            Aindicator dmb = FindIndicator(tab, NumDiscreteMidBestPair, "DiscreteMidBestPair");
            if (dmb == null || dmb.DataSeries.Count < 2)
                return;

            decimal first = dmb.DataSeries[0].Last;
            decimal second = dmb.DataSeries[1].Last;
            decimal slip = _slippage.ValueInt * tab.Security.PriceStep;

            List<Position> open = tab.PositionsOpenAll;
            if (open == null || open.Count == 0)
                return;

            for (int i = 0; i < open.Count; i++)
            {
                Position pos = open[i];
                if (pos == null || pos.State != PositionStateType.Open || pos.OpenVolume == 0)
                    continue;
                if (pos.SignalTypeOpen != SignalOpenWithDiscreteSlTp)
                    continue;
                if (!string.IsNullOrEmpty(pos.NameBotClass) && pos.NameBotClass != GetNameStrategyType())
                    continue;
                if (pos.StopOrderIsActive && pos.ProfitOrderIsActive)
                    continue;

                decimal entry = pos.EntryPrice;
                decimal diffLevels = first - second;
                decimal profitRedLine = entry - rangeStep * diffLevels;

                if (pos.Direction == Side.Buy)
                {
                    if (!pos.StopOrderIsActive)
                    {
                        decimal stopRed = tab.RoundPrice(entry - rangeStep, tab.Security, Side.Sell);
                        decimal stopOrd = tab.RoundPrice(stopRed - slip, tab.Security, Side.Sell);
                        tab.CloseAtStop(pos, stopRed, stopOrd);
                    }

                    if (!pos.ProfitOrderIsActive && diffLevels != 0)
                    {
                        decimal pr = tab.RoundPrice(profitRedLine, tab.Security, Side.Sell);
                        decimal po = tab.RoundPrice(pr - slip, tab.Security, Side.Sell);
                        tab.CloseAtProfit(pos, pr, po);
                    }
                }
                else if (pos.Direction == Side.Sell)
                {
                    if (!pos.StopOrderIsActive)
                    {
                        decimal stopRed = tab.RoundPrice(entry + rangeStep, tab.Security, Side.Buy);
                        decimal stopOrd = tab.RoundPrice(stopRed + slip, tab.Security, Side.Buy);
                        tab.CloseAtStop(pos, stopRed, stopOrd);
                    }

                    if (!pos.ProfitOrderIsActive && diffLevels != 0)
                    {
                        decimal pr = tab.RoundPrice(profitRedLine, tab.Security, Side.Buy);
                        decimal po = tab.RoundPrice(pr + slip, tab.Security, Side.Buy);
                        tab.CloseAtProfit(pos, pr, po);
                    }
                }
            }
        }
#endif

        /// <summary>
        /// Случайный сдвиг цены заявки в пределах ±«Рандомность движений, %» (после проскальзывания).
        /// </summary>
        private decimal ApplyRandomPriceShift(decimal price, BotTabSimple tab)
        {
            if (!_useRandomPriceShift.ValueBool || price <= 0m)
            {
                return price;
            }

            decimal percent = _randomPriceShiftPercent.ValueDecimal;
            if (percent <= 0m)
            {
                return price;
            }

            double maxFraction = (double)percent / 100.0;
            double offset = (_randomPriceShiftRng.NextDouble() * 2.0 - 1.0) * maxFraction;
            decimal shifted = price * (1m + (decimal)offset);

            decimal step = tab?.Security?.PriceStep ?? 0m;
            if (step > 0m)
            {
                shifted = Math.Round(shifted / step, MidpointRounding.AwayFromZero) * step;
            }

            return shifted > 0m ? shifted : price;
        }

        /// <summary>
        /// Открытие лонга/шорта по лимиту с учётом Regime, проскальзывания и опционального рандомного сдвига цены.
        /// </summary>
        private void TryOpenOnSignal(List<Candle> candles, BotTabSimple tab, bool bull, bool bear)
        {
            decimal close = candles[candles.Count - 1].Close;
            decimal slip = _slippage.ValueInt * tab.Security.PriceStep;
#if false // DiscreteMidBestPair
            string openSignal = DiscreteOpenSignal();

            if (bull && _regime.ValueString != "OnlyShort")
            {
                ExecuteBuyOpen(tab, GetVolume(tab), GetOpenLongLimitPrice(tab, close, slip), openSignal);
            }
            else if (bear && _regime.ValueString != "OnlyLong")
            {
                ExecuteSellOpen(tab, GetVolume(tab), GetOpenShortLimitPrice(tab, close, slip), openSignal);
            }
#else
            if (bull && _regime.ValueString != "OnlyShort")
            {
                ExecuteBuyOpen(tab, GetVolume(tab), GetOpenLongLimitPrice(tab, close, slip));
            }
            else if (bear && _regime.ValueString != "OnlyLong")
            {
                ExecuteSellOpen(tab, GetVolume(tab), GetOpenShortLimitPrice(tab, close, slip));
            }
#endif
        }

        /// <summary>
        /// Закрытие или реверс позиции при противоположном сигнале.
        /// </summary>
        private void TryCloseOrReverse(List<Candle> candles, BotTabSimple tab, Position pos, bool bull, bool bear)
        {
            if (pos.State != PositionStateType.Open)
            {
                return;
            }

            decimal close = candles[candles.Count - 1].Close;
            decimal slip = _slippage.ValueInt * tab.Security.PriceStep;
#if false // DiscreteMidBestPair
            string openSignal = DiscreteOpenSignal();

            if (pos.Direction == Side.Buy && bear)
            {
                ExecuteCloseOnSignalCandle(pos, tab, close, slip);

                if (_regime.ValueString != "OnlyLong" && _regime.ValueString != "OnlyClosePosition")
                {
                    if (_screenerTab.PositionsOpenAll.Count < _maxPositions.ValueInt)
                    {
                        ExecuteSellOpen(tab, GetVolume(tab), GetOpenShortLimitPrice(tab, close, slip), openSignal);
                    }
                }
            }
            else if (pos.Direction == Side.Sell && bull)
            {
                ExecuteCloseOnSignalCandle(pos, tab, close, slip);

                if (_regime.ValueString != "OnlyShort" && _regime.ValueString != "OnlyClosePosition")
                {
                    if (_screenerTab.PositionsOpenAll.Count < _maxPositions.ValueInt)
                    {
                        ExecuteBuyOpen(tab, GetVolume(tab), GetOpenLongLimitPrice(tab, close, slip), openSignal);
                    }
                }
            }
#else
            if (pos.Direction == Side.Buy && bear)
            {
                ExecuteCloseOnSignalCandle(pos, tab, close, slip);

                if (_regime.ValueString != "OnlyLong" && _regime.ValueString != "OnlyClosePosition")
                {
                    if (_screenerTab.PositionsOpenAll.Count < _maxPositions.ValueInt)
                    {
                        ExecuteSellOpen(tab, GetVolume(tab), GetOpenShortLimitPrice(tab, close, slip));
                    }
                }
            }
            else if (pos.Direction == Side.Sell && bull)
            {
                ExecuteCloseOnSignalCandle(pos, tab, close, slip);

                if (_regime.ValueString != "OnlyShort" && _regime.ValueString != "OnlyClosePosition")
                {
                    if (_screenerTab.PositionsOpenAll.Count < _maxPositions.ValueInt)
                    {
                        ExecuteBuyOpen(tab, GetVolume(tab), GetOpenLongLimitPrice(tab, close, slip));
                    }
                }
            }
#endif
        }

        private void ExecuteCloseOnSignalCandle(Position pos, BotTabSimple tab, decimal close, decimal slip)
        {
            decimal limitPrice = pos.Direction == Side.Buy
                ? ApplyRandomPriceShift(close - slip, tab)
                : ApplyRandomPriceShift(close + slip, tab);
            ExecuteClosePosition(tab, pos, pos.OpenVolume, limitPrice);
        }

        /// <summary>
        /// Расчёт объёма заявки: контракты, валюта контракта или % депозита.
        /// </summary>
        private decimal GetVolume(BotTabSimple tab)
        {
            decimal volume = 0;

            if (_volumeType.ValueString == "Contracts")
            {
                volume = _volume.ValueDecimal;
            }
            else if (_volumeType.ValueString == "Contract currency")
            {
                decimal contractPrice = tab.PriceBestAsk;
                volume = _volume.ValueDecimal / contractPrice;

                if (StartProgram == StartProgram.IsOsTrader)
                {
                    IServerPermission serverPermission = ServerMaster.GetServerPermission(tab.Connector.ServerType);

                    if (serverPermission != null &&
                        serverPermission.IsUseLotToCalculateProfit &&
                        tab.Security.Lot != 0 &&
                        tab.Security.Lot > 1)
                    {
                        volume = _volume.ValueDecimal / (contractPrice * tab.Security.Lot);
                    }

                    volume = Math.Round(volume, tab.Security.DecimalsVolume);
                }
                else
                {
                    volume = Math.Round(volume, 6);
                }
            }
            else if (_volumeType.ValueString == "Deposit percent")
            {
                Portfolio myPortfolio = tab.Portfolio;

                if (myPortfolio == null)
                {
                    return 0;
                }

                decimal portfolioPrimeAsset = 0;

                if (_tradeAssetInPortfolio.ValueString == "Prime")
                {
                    portfolioPrimeAsset = myPortfolio.ValueCurrent;
                }
                else
                {
                    List<PositionOnBoard> positionOnBoard = myPortfolio.GetPositionOnBoard();

                    if (positionOnBoard == null)
                    {
                        return 0;
                    }

                    for (int i = 0; i < positionOnBoard.Count; i++)
                    {
                        if (positionOnBoard[i].SecurityNameCode == _tradeAssetInPortfolio.ValueString)
                        {
                            portfolioPrimeAsset = positionOnBoard[i].ValueCurrent;
                            break;
                        }
                    }
                }

                if (portfolioPrimeAsset == 0)
                {
                    SendNewLogMessage("Can`t found portfolio " + _tradeAssetInPortfolio.ValueString, LogMessageType.Error);
                    return 0;
                }

                decimal moneyOnPosition = portfolioPrimeAsset * (_volume.ValueDecimal / 100);

                decimal qty = moneyOnPosition / tab.PriceBestAsk / tab.Security.Lot;

                if (tab.StartProgram == StartProgram.IsOsTrader)
                {
                    if (tab.Security.UsePriceStepCostToCalculateVolume
                        && tab.Security.PriceStep != tab.Security.PriceStepCost
                        && tab.PriceBestAsk != 0
                        && tab.Security.PriceStep != 0
                        && tab.Security.PriceStepCost != 0)
                    {
                        qty = moneyOnPosition / (tab.PriceBestAsk / tab.Security.PriceStep * tab.Security.PriceStepCost);
                    }

                    qty = Math.Round(qty, tab.Security.DecimalsVolume);
                }
                else
                {
                    qty = Math.Round(qty, 7);
                }

                return qty;
            }

            return volume;
        }

        #endregion
    }
}

