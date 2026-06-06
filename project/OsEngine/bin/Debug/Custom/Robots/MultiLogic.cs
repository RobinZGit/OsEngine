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
Строка логики — Note(…), справка: Custom\Robots\MultiLogic_LogicHelp.txt (кнопка Help; файл обновляется автоматически).
Парсинг строк «Логика 1…10», общие индикаторы, торговля по сигналам Op/Cl (Regime=On).
*/

namespace OsEngine.Robots.Custom
{
    /// <summary>
    /// Скринер MultiLogic: до 10 независимых торговых логик в строковых параметрах,
    /// общий пул индикаторов без дублей, вход/выход по Op/Cl на закрытии свечи.
    /// </summary>
    public class MultiLogic : BotPanel
    {
        /// <summary>Сигнал экстренного закрытия всех позиций робота (кнопка «Остановить робота и продать всё»).</summary>
        private const string SignalStopRobotAndSellAll = "MultiLogicStopAll";
        /// <summary>Имя вкладки параметров со строками «Логика 1…10» и кнопкой Help.</summary>
        private const string LogicsTabName = "Логики";
        /// <summary>Вкладка общепортфельных индикаторов по кривым портфелей логик (пока только параметры).</summary>
        private const string MetaLogicsTabName = "Металогики";
        /// <summary>Вкладка общепортфельных stop-loss / take-profit по сумме портфелей L1…L10.</summary>
        private const string StopperTabName = "Stopper";
        private const int StopperEquityHistoryCap = 10000;
        private const string SignalPortfolioStopperSl = "MultiLogicPortfolioStopSL";
        private const string SignalPortfolioStopperTp = "MultiLogicPortfolioStopTP";
        private const string UpdateStopperPortfolioBaselineButtonName = "Обновить сумму портфеля SL/TP";
        /// <summary>Главный переключатель режима металогики (распределение Volume по PnlSMA).</summary>
        private const string MetaLogicEnabledParamName = "Металогика включена";
        /// <summary>Кнопка быстрого включения металогики.</summary>
        private const string MetaLogicEnableButtonName = "Включить металогику";

        /// <summary>Относительный путь к файлу справки (от каталога bin); перезаписывается из кода робота.</summary>
        private const string LogicHelpFileRelativePath = @"Custom\Robots\MultiLogic_LogicHelp.txt";

        /// <summary>
        /// Краткая подсказка в параметрах. Полная справка — MultiLogic_LogicHelp.txt (кнопка Help, автообновление).
        /// </summary>
        private const string LogicLineFormatHint =
            "В начале (необязательно): Disabled(true) или Disabled(false) — отключение логики.\n"
            + "Формат: <Индикатор>(параметры) Op[вход] Cl[выход] [SL[…]] [TP[…]] Note(пояснение)\n"
            + "Disabled(…) — только в самом начале строки, до AND/OR, без скобок вокруг.\n"
            + "AND/OR: (фрагмент1) AND (фрагмент2). Примеры:\n"
            + "  Disabled(true) SMA(100) Op[Ab] Cl[Bl]\n"
            + "  SMA(100) Op[Ab] Cl[Bl] SL[2%] TP[6%] Note(trend)\n"
            + "  Disabled(false) (SMA(100) Op[Ab]) AND (ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-])";

        /// <summary>Количество слотов строк логики («Логика 1» … «Логика 10»).</summary>
        private const int LogicSlotCount = 10;
        /// <summary>Префикс SignalTypeOpen позиции: MultiLogic_L1 … MultiLogic_L10.</summary>
        private const string LogicEntrySignalPrefix = "MultiLogic_L";

        /// <summary>Имя кнопки открытия файла справки на вкладке «Логики».</summary>
        private const string LogicsHelpButtonName = "Help";
        /// <summary>Имя кнопки сброса логик и установки строки TrendMultiIndicator в «Логика 1».</summary>
        private const string LogicsSetDefaultButtonName = "Установить логики по умолчанию";
        /// <summary>Кнопка «Установить разнообразные логики-примеры» на вкладке «Логики».</summary>
        private const string LogicsSetSampleDiverseButtonName = "Установить разнообразные логики-примеры";
        /// <summary>Кнопка экспорта JSON-снимка настроек, портфелей логик и позиций.</summary>
        private const string SaveSnapshotButtonName = "Сохранить настройки и результаты";
        /// <summary>Кнопка импорта JSON-снимка.</summary>
        private const string LoadSnapshotButtonName = "Загрузить настройки и результаты";
        /// <summary>Версия формата JSON-снимка MultiLogic.</summary>
        private const string MultiLogicSnapshotFormatVersion = "2";
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

        /// <summary>
        /// «Логика 1» по умолчанию — как TrendMultiIndicatorScreener (лонг): SMA, Stoch, LinReg, ATR, MACD через AND.
        /// «Логика 2» — зеркальный шорт (медвежий IsBearSignal); общие индикаторы на графике не дублируются.
        /// </summary>
        private const string DefaultLogic1TrendMultiIndicator =
            "(SMA(100) Op[Ab] Cl[Bl]) AND "
            + "(Stoch(14-3-3;Lmin=55;Smax=45) Op[K>=55] Cl[K<=45]) AND "
            + "(LinReg(50;Dev=2) Op[AbUp] Cl[BlLo]) AND "
            + "(ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-]) AND "
            + "(MACD(12,26,9) Op[Macd>Sig] Cl[Macd<Sig] Note(TrendMultiIndicator-default-long))";

        /// <summary>
        /// «Логика 2» по умолчанию — шорт как у TrendMultiIndicatorScreener (IsBearSignal / OnlyShort-сторона).
        /// </summary>
        private const string DefaultLogic2TrendMultiIndicatorShort =
            "(SMA(100) Side[S] Op[Bl] Cl[Ab]) AND "
            + "(Stoch(14-3-3;Lmin=55;Smax=45) Op[K<=45] Cl[K>=55]) AND "
            + "(LinReg(50;Dev=2) Op[BlLo] Cl[AbUp]) AND "
            + "(ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-]) AND "
            + "(MACD(12,26,9) Op[Macd<Sig] Cl[Macd>Sig] Note(TrendMultiIndicator-default-short))";

        /// <summary>
        /// Примеры для кнопки «разнообразные логики»: 3 лонга, 3 шорт-тренда, 2 контртрендовых шорта; часть со SL/TP.
        /// </summary>
        private static readonly string[] SampleDiverseLogicStrings =
        {
            "SMA(100) Op[Ab] Cl[Bl] SL[2%] TP[6%] Note(trend-SMA100)",
            "MACD(12,26,9) Op[Macd>Sig] Cl[Macd<Sig] SL[2.5%] TP[7%] Note(trend-MACD)",
            "LinReg(50;Dev=2) Op[AbUp] Cl[BlLo] SL[2ATR] TP[2R] Note(trend-LinReg-breakout)",
            "SMA(100) Side[S] Op[Bl] Cl[Ab] SL[2%] TP[6%] Note(trend-short-SMA100)",
            "MACD(12,26,9) Side[S] Op[Macd<Sig] Cl[Macd>Sig] SL[2.5%] TP[7%] Note(trend-short-MACD)",
            "LinReg(50;Dev=2) Side[S] Op[BlLo] Cl[AbUp] SL[2ATR] TP[2R] Note(trend-short-LinReg)",
            "Stoch(14-3-3;Lmin=75;Smax=25) Side[S] Op[K<=25] Cl[K>=75] SL[2%] TP[4%] Note(counter-Stoch-fade)",
            "Bollinger(20;Dev=2) Side[S] Op[Bl] Cl[Ab] SL[2%] TP[5%] Note(counter-Boll-mid-short)"
        };

        /// <summary>Вкладка скринера: по одной подвкладке на каждый инструмент.</summary>
        private BotTabScreener _screenerTab;
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
        /// <summary>Кнопка «Установить разнообразные логики-примеры» на вкладке «Логики».</summary>
        private StrategyParameterButton _setSampleDiverseLogicsButton;
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
        /// <summary>Вкладки, на которых все robot-индикаторы уже найдены (быстрый выход из TryEnsure).</summary>
        private readonly HashSet<string> _robotIndicatorsReadyTabKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        /// <summary>Последняя свеча, на которой пробовали attach индикаторов на вкладке (антиспам в тестере).</summary>
        private readonly Dictionary<string, int> _robotIndicatorsEnsureLastAttemptCandle =
            new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

        /// <summary>Пауза между вкладками при «Обновить акции» — снижает гонку ClearJournalsArray в GlobalPositionViewer.</summary>
        private const int MoexStockTabReloadDelayMs = 700;

        private int _moexStockReloadInProgress;

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
        /// <summary>Способ задания объёма: Contracts / Contract currency / Deposit percent.</summary>
        private StrategyParameterString _volumeType;
        /// <summary>Числовое значение объёма (зависит от Volume type).</summary>
        private StrategyParameterDecimal _volume;
        /// <summary>База для расчёта % депозита: Prime или код валюты.</summary>
        private StrategyParameterString _tradeAssetInPortfolio;

        private bool _loggedTradingModeDiagnostics;
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

        private StrategyParameterBool _metaLogicEnabled;
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
        private StrategyParameterBool _usePortfolioTakeProfit;
        private StrategyParameterDecimal _portfolioTakeProfitPercent;
        private StrategyParameterBool _stopRobotAfterPortfolioStopLoss;
        private StrategyParameterBool _stopRobotAfterPortfolioTakeProfit;
        private StrategyParameterDecimal _portfolioStopperReferenceEquity;
        private StrategyParameterDecimal _portfolioStopperCurrentEquity;
        private StrategyParameterInt _portfolioStopperLookbackCandles;
        private StrategyParameterButton _updateStopperPortfolioBaselineButton;

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

            _maxPositions = CreateParameter("Max positions (all tabs)", 20, 0, 200, 1);

            _volumeType = CreateParameter(
                "Volume type",
                "Deposit percent",
                new[] { "Contracts", "Contract currency", "Deposit percent" });
            _volume = CreateParameter("Volume", 20, 1.0m, 50, 4);
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

            _logicHelpButton = CreateParameterButton(LogicsHelpButtonName, LogicsTabName);
            _logicHelpButton.UserClickOnButtonEvent += LogicHelpButton_UserClickOnButtonEvent;

            _setDefaultLogicsButton = CreateParameterButton(LogicsSetDefaultButtonName, LogicsTabName);
            _setDefaultLogicsButton.UserClickOnButtonEvent += SetDefaultLogicsButton_UserClickOnButtonEvent;
            _setSampleDiverseLogicsButton = CreateParameterButton(LogicsSetSampleDiverseButtonName, LogicsTabName);
            _setSampleDiverseLogicsButton.UserClickOnButtonEvent += SetSampleDiverseLogicsButton_UserClickOnButtonEvent;

            _logic1 = CreateParameter("Логика 1", DefaultLogic1TrendMultiIndicator, LogicsTabName);
            _logic2 = CreateParameter("Логика 2", DefaultLogic2TrendMultiIndicatorShort, LogicsTabName);
            _logic3 = CreateParameter("Логика 3", "", LogicsTabName);
            _logic4 = CreateParameter("Логика 4", "", LogicsTabName);
            _logic5 = CreateParameter("Логика 5", "", LogicsTabName);
            _logic6 = CreateParameter("Логика 6", "", LogicsTabName);
            _logic7 = CreateParameter("Логика 7", "", LogicsTabName);
            _logic8 = CreateParameter("Логика 8", "", LogicsTabName);
            _logic9 = CreateParameter("Логика 9", "", LogicsTabName);
            _logic10 = CreateParameter("Логика 10", "", LogicsTabName);

            _metaLogicEnabled = CreateParameter(MetaLogicEnabledParamName, false, MetaLogicsTabName);
            _metaLogicEnableButton = CreateParameterButton(MetaLogicEnableButtonName, MetaLogicsTabName);
            _metaLogicEnableButton.UserClickOnButtonEvent += MetaLogicEnableButton_UserClickOnButtonEvent;

            _usePortfolioAdjSma = CreateParameter(PortfolioPnlSmaEnableParamName, true, MetaLogicsTabName);
            _portfolioAdjSmaLen = CreateParameter(
                PortfolioPnlSmaLenParamName,
                100,
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
            _stopperReferenceBaselineLocked = _portfolioStopperReferenceEquity.ValueDecimal != 0m;
            CheckAndWarnMultiLogicResources(force: true);
        }

        /// <summary>
        /// Обработчик изменения параметров пользователем: переподключает кнопки, подсказки и перечитывает все 10 логик.
        /// </summary>
        private void MultiLogic_ParametrsChangeByUser()
        {
            WireLogicTabButtons();
            WireMetaLogicTabButtons();
            WireStopperTabButtons();
            WireMoexTabButtons();
            WireSnapshotButtons();
            WireReferenceYieldButtons();
            RegisterParameterHints();
            _stopperReferenceBaselineLocked = _portfolioStopperReferenceEquity.ValueDecimal != 0m;
            CoalescedTryParseAndApplyAllLogicSlots();
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
                RunOnUiThread(() => TryParseAndApplyAllLogicSlots(logToUser: false));
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
            WireLogicTabButton(LogicsSetSampleDiverseButtonName, SetSampleDiverseLogicsButton_UserClickOnButtonEvent);
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
        }

        private void MetaLogicEnableButton_UserClickOnButtonEvent()
        {
            _metaLogicEnabled.ValueBool = true;
            RepaintParameterGuiTables();
            SaveParameters();
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

            SaveParameters();
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
                _referenceCurrentAnnualPercent.ValueDecimal = 0m;
                _referenceCurrentAnnualPercentWithCap.ValueDecimal = 0m;
                return;
            }

            decimal? currentPortfolio = TryGetRealPortfolioAmountForReference(tab);
            if (!currentPortfolio.HasValue || currentPortfolio.Value <= 0m)
            {
                _referenceCurrentAnnualPercent.ValueDecimal = 0m;
                _referenceCurrentAnnualPercentWithCap.ValueDecimal = 0m;
                return;
            }

            DateTime endDate = GetReferenceCalendarDate(tab, candleTime);
            double elapsedDays = Math.Max(0d, (endDate - startDate.Date).TotalDays);
            if (elapsedDays < 1d)
            {
                _referenceCurrentAnnualPercent.ValueDecimal = 0m;
                _referenceCurrentAnnualPercentWithCap.ValueDecimal = 0m;
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
                _referenceCurrentAnnualPercent.ValueDecimal = roundedSimple;
            }

            if (_referenceCurrentAnnualPercentWithCap.ValueDecimal != roundedCompound)
            {
                _referenceCurrentAnnualPercentWithCap.ValueDecimal = roundedCompound;
            }
        }

        private BotTabSimple TryGetReferenceMonitoringTab()
        {
            if (_screenerTab?.Tabs == null || _screenerTab.Tabs.Count == 0)
            {
                return null;
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
        /// Записывает MultiLogic_LogicHelp.txt, если содержимое устарело или файла нет.
        /// Сравнение по полному тексту — правки в BuildDefaultHelpText подхватываются без ручного удаления.
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

            string content = LogicLineParser.BuildDefaultHelpText();
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

            File.WriteAllText(path, content, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));

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
                OpenLogicHelpTextFile();
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        /// <summary>Актуализирует файл справки и открывает его в программе по умолчанию.</summary>
        private void OpenLogicHelpTextFile()
        {
            EnsureLogicHelpFileUpToDate(logToUser: true);

            string path = GetLogicHelpFilePath();
            Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
            SendNewLogMessage(
                NameStrategyUniq + " | Справка по логикам: " + path + " (автообновление из MultiLogic.cs).",
                LogMessageType.User);
        }

        /// <summary>
        /// Обработчик «Установить логики по умолчанию»: L1 — лонг TrendMultiIndicator, L2 — шорт, L3…10 — пусто.
        /// </summary>
        private void SetDefaultLogicsButton_UserClickOnButtonEvent()
        {
            try
            {
                ApplyDefaultLogicStrings();

                string msg = NameStrategyUniq
                    + " | Логики по умолчанию: «Логика 1» = TrendMultiIndicator лонг, "
                    + "«Логика 2» = TrendMultiIndicator шорт (SMA+Stoch+LinReg+ATR+MACD, AND); "
                    + "«Логика 3…10» очищены. Применение на графике — по «Принять».";
                SendNewLogMessage(msg, LogMessageType.System);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        /// <summary>
        /// Записывает заводские строки в «Логика 1» (лонг) и «Логика 2» (шорт), очищает «Логика 3» … «Логика 10».
        /// Если окно параметров открыто — только ячейки таблицы (как ручной ввод), без парсинга и SaveParameters.
        /// </summary>
        private void ApplyDefaultLogicStrings()
        {
            string[] slotValues = new string[LogicSlotCount];
            slotValues[0] = DefaultLogic1TrendMultiIndicator;
            slotValues[1] = DefaultLogic2TrendMultiIndicatorShort;
            ApplyLogicSlotStrings(slotValues);
        }

        /// <summary>
        /// Обработчик «Установить разнообразные логики-примеры»: очищает все слоты, в «Логика 1…8» — восемь примеров.
        /// </summary>
        private void SetSampleDiverseLogicsButton_UserClickOnButtonEvent()
        {
            try
            {
                ApplySampleDiverseLogicStrings();

                string msg = NameStrategyUniq
                    + " | Примеры логик: очищены «Логика 1…10»; в «Логика 1…8» — 3 лонга (SMA, MACD, LinReg), "
                    + "3 шорт-тренда (SMA, MACD, LinReg), 2 контртрендовых шорта (Stoch, Bollinger); "
                    + "SL/TP или ATR/R. Применение на графике — по «Принять».";
                SendNewLogMessage(msg, LogMessageType.System);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        /// <summary>Очищает «Логика 1…10» и записывает SampleDiverseLogicStrings в «Логика 1…8».</summary>
        private void ApplySampleDiverseLogicStrings()
        {
            string[] slotValues = new string[LogicSlotCount];
            for (int slot = 1; slot <= LogicSlotCount; slot++)
            {
                int sampleIndex = slot - 1;
                slotValues[slot - 1] = sampleIndex >= 0 && sampleIndex < SampleDiverseLogicStrings.Length
                    ? SampleDiverseLogicStrings[sampleIndex]
                    : "";
            }

            ApplyLogicSlotStrings(slotValues);
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

        /// <summary>Обновляет таблицы параметров в UI после программной смены ValueString.</summary>
        private void RepaintParameterGuiTables()
        {
            if (ParamGuiSettings != null)
            {
                ParamGuiSettings.RePaintParameterTables();
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

            // В тестере индикаторы ставятся при «Принять» (SyncAllLogicIndicators); фоновый attach ломает UI-поток.
            if (StartProgram == StartProgram.IsTester)
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
                + "Off — торговля и проверка сигналов не выполняются.\n"
                + "On — на каждой свече проверяются все включённые логики, вход/выход по Op/Cl.");
            Hint("Остановить робота и продать всё",
                "Экстренная остановка: закрывает все позиции этого робота на вкладках скринера по рынку "
                + "(или лимитом, если рынок недоступен) и переводит Regime в Off.");
            Hint("Max positions (all tabs)",
                "Максимум одновременно открытых позиций робота на всём скринере (все вкладки). "
                + "0 — новые входы запрещены. При нехватке слотов: без металогики — L1, L2, …; "
                + "с металогикой — выше PnlSMA раньше.");
            Hint("Volume type",
                "Способ задания объёма заявки:\n"
                + "Contracts — фиксированное число контрактов;\n"
                + "Contract currency — сумма в валюте контракта;\n"
                + "Deposit percent — доля от актива портфеля (см. Asset in portfolio).");
            Hint("Volume",
                "Общий объём одной «порции» на вкладку. Если на одной свече срабатывает несколько логик — "
                + "без металогики делится поровну; с «Металогика включена» — по |PnlSMA| между логиками с Op "
                + "(знак PnlSMA может перевернуть Buy/Sell). Единицы — см. Volume type.");
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
                + "Файл выбирается в диалоге.");
            Hint(LoadSnapshotButtonName,
                "Загрузить JSON-снимок: заменить параметры, строки логик, портфели и сохранить позиции из файла "
                + "(биржевые позиции не открываются автоматически).");
            Hint(LogicsHelpButtonName,
                "Открыть Custom\\Robots\\MultiLogic_LogicHelp.txt — полная справка; "
                + "файл автоматически обновляется при запуске робота и по этой кнопке.");
            Hint(LogicsSetDefaultButtonName,
                "Записать в «Логика 1» лонг и в «Логика 2» шорт как у TrendMultiIndicatorScreener "
                + "(SMA, Stoch, LinReg, ATR, MACD — AND, заводские параметры); «Логика 3…10» очистить.");
            Hint(LogicsSetSampleDiverseButtonName,
                "Очистить «Логика 1…10» и записать в «Логика 1…8» примеры: 3 лонга, 3 шорт-тренда (Side[S]), "
                + "2 контртрендовых шорта (Stoch, Bollinger), со SL/TP или ATR/R. «Логика 9…10» — пусто.");
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
                "Если включено — на входе Volume делится между логиками с Op пропорционально PnlSMA "
                + "(по кривой портфеля каждой логики); отрицательный PnlSMA переворачивает Buy/Sell. "
                + "При нехватке Max positions приоритет у логик с большим PnlSMA. "
                + "Если выключено — каждая логика входит отдельно, Volume поровну, приоритет L1…L10.");
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
            Hint("Общепортфельный stop-loss (%)",
                "Порог SL: equity ≤ ref × (1 − %/100). По умолчанию 0,4. Ref — equity N свечей назад.");
            Hint("Общепортфельный take-profit: включён",
                "Stopper: рост суммарной equity от ref. По умолчанию выкл.");
            Hint("Общепортфельный take-profit (%)",
                "Порог TP: equity ≥ ref × (1 + %/100). По умолчанию 10.");
            Hint("Останавливать робота после срабатывания stop-loss",
                "После SL — закрыть все позиции робота; Regime=Off, если включено.");
            Hint("Останавливать робота после срабатывания take-profit",
                "После TP — закрыть все позиции; Regime=Off, если включено.");
            Hint("Предыдущая сумма портфеля (техн.)",
                "База SL/TP или lookback; обновляется в начале/конце обработки свечи, кнопкой и после Stopper.");
            Hint("Текущая сумма портфеля (техн.)",
                "Equity L1…L10; перезаписывается в начале и после торговли на каждой закрытой свече вкладки.");
            Hint("Предыдущая сумма портфеля: lookback (свечей)",
                "Если база = 0 — ref из N свечей назад (по умолчанию 5). Кнопка SL/TP или срабатывание фиксируют базу.");
            Hint(UpdateStopperPortfolioBaselineButtonName,
                "Записывает текущую equity L1…L10 в «Предыдущая сумма портфеля» и фиксирует базу SL/TP.");

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
            _regime.ValueString = "Off";
            MaybeSaveLogicPortfolios(force: true);

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

        private void CreateStopperParameters()
        {
            _usePortfolioStopLoss = CreateParameter(
                "Общепортфельный stop-loss: включён",
                false,
                StopperTabName);
            _portfolioStopLossPercent = CreateParameter(
                "Общепортфельный stop-loss (%)",
                0.4m,
                0.01m,
                100m,
                0.01m,
                StopperTabName);
            _usePortfolioTakeProfit = CreateParameter(
                "Общепортфельный take-profit: включён",
                false,
                StopperTabName);
            _portfolioTakeProfitPercent = CreateParameter(
                "Общепортфельный take-profit (%)",
                10m,
                0.1m,
                500m,
                0.1m,
                StopperTabName);
            _stopRobotAfterPortfolioStopLoss = CreateParameter(
                "Останавливать робота после срабатывания stop-loss",
                false,
                StopperTabName);
            _stopRobotAfterPortfolioTakeProfit = CreateParameter(
                "Останавливать робота после срабатывания take-profit",
                false,
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
            _updateStopperPortfolioBaselineButton = CreateParameterButton(
                UpdateStopperPortfolioBaselineButtonName,
                StopperTabName);
            _updateStopperPortfolioBaselineButton.UserClickOnButtonEvent +=
                UpdateStopperPortfolioBaselineButton_UserClickOnButtonEvent;
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

        /// <summary>
        /// Фиксирует текущую equity L1…L10 как базу SL/TP (предыдущая сумма портфеля).
        /// </summary>
        private bool TryApplyUpdateStopperPortfolioBaseline(bool logButtonPress)
        {
            if (logButtonPress)
            {
                SendNewLogMessage(
                    NameStrategyUniq + " | Stopper: нажата «" + UpdateStopperPortfolioBaselineButtonName + "»…",
                    LogMessageType.User);
            }

            RecalculateAllLogicPortfolioUnrealized();
            decimal currentEquity = GetCombinedLogicPortfolioEquity();
            decimal baselineToSet = currentEquity;
            decimal oldReference = _portfolioStopperReferenceEquity.ValueDecimal;

            if (_usePortfolioTakeProfit.ValueBool
                && _portfolioTakeProfitPercent.ValueDecimal > 0m
                && oldReference > 0m
                && currentEquity > 0m)
            {
                decimal ceiling = oldReference * (1m + _portfolioTakeProfitPercent.ValueDecimal / 100m);
                if (currentEquity >= ceiling)
                {
                    baselineToSet = currentEquity;
                    SendNewLogMessage(
                        NameStrategyUniq
                        + " | Stopper: база поднята до текущей equity "
                        + baselineToSet.ToString(CultureInfo.InvariantCulture)
                        + " — иначе take-profit сработал бы сразу.",
                        LogMessageType.User);
                }
            }

            DateTime candleTime = GetStopperReferenceCandleTime();
            ApplyStopperReferenceBaseline(baselineToSet, candleTime, saveParameters: true);

            string msg = NameStrategyUniq
                + " | Stopper: «"
                + UpdateStopperPortfolioBaselineButtonName
                + "» — база (предыдущая сумма) "
                + baselineToSet.ToString(CultureInfo.InvariantCulture)
                + ", текущая "
                + currentEquity.ToString(CultureInfo.InvariantCulture)
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
            _portfolioStopperReferenceEquity.ValueDecimal = baseline;
            _portfolioStopperCurrentEquity.ValueDecimal = GetCombinedLogicPortfolioEquity();
            ResetStopperEquityHistory(baseline, candleTime);

            if (saveParameters)
            {
                SaveParameters();
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

        /// <summary>
        /// Обновляет историю equity и проверяет общепортфельный SL/TP относительно lookback.
        /// </summary>
        /// <returns>true, если сработала защита (закрыты позиции).</returns>
        private bool TryManagePortfolioStopperProtection(BotTabSimple tab, DateTime candleTime)
        {
            decimal currentEquity = GetCombinedLogicPortfolioEquity();

            if (!_usePortfolioStopLoss.ValueBool && !_usePortfolioTakeProfit.ValueBool)
            {
                return false;
            }

            if (candleTime == _stopperLastProtectionCandleTime)
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

            if (_usePortfolioStopLoss.ValueBool && _portfolioStopLossPercent.ValueDecimal > 0m)
            {
                decimal floor = referenceEquity * (1m - _portfolioStopLossPercent.ValueDecimal / 100m);
                if (currentEquity <= floor)
                {
                    return ExecutePortfolioStopperTrigger(
                        tab,
                        candleTime,
                        isTakeProfit: false,
                        referenceEquity,
                        currentEquity,
                        _portfolioStopLossPercent.ValueDecimal,
                        floor);
                }
            }

            if (_usePortfolioTakeProfit.ValueBool && _portfolioTakeProfitPercent.ValueDecimal > 0m)
            {
                decimal ceiling = referenceEquity * (1m + _portfolioTakeProfitPercent.ValueDecimal / 100m);
                if (currentEquity >= ceiling)
                {
                    return ExecutePortfolioStopperTrigger(
                        tab,
                        candleTime,
                        isTakeProfit: true,
                        referenceEquity,
                        currentEquity,
                        _portfolioTakeProfitPercent.ValueDecimal,
                        ceiling);
                }
            }

            return false;
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
        /// Тех. параметры сумм портфеля: в начале свечи — новая точка истории; после торговли — актуализация.
        /// </summary>
        /// <param name="candleTime">Время закрытой свечи вкладки.</param>
        /// <param name="atCandleStart">true — начало обработки свечи; false — после торговли на этой свече.</param>
        /// <remarks>Вызывающий код должен заранее обновить unrealized через RecalculateAllLogicPortfolioUnrealized.</remarks>
        private void RefreshStopperTechEquityDisplay(DateTime candleTime, bool atCandleStart)
        {
            decimal currentEquity = GetCombinedLogicPortfolioEquity();
            if (_portfolioStopperCurrentEquity.ValueDecimal != currentEquity)
            {
                _portfolioStopperCurrentEquity.ValueDecimal = currentEquity;
            }

            if (atCandleStart)
            {
                AppendStopperEquitySnapshot(candleTime, currentEquity);
            }
            else if (_stopperEquityHistory.Count > 0
                && _stopperEquityHistory[_stopperEquityHistory.Count - 1].CandleTime == candleTime)
            {
                _stopperEquityHistory[_stopperEquityHistory.Count - 1].Equity = currentEquity;
            }

            if (!_stopperReferenceBaselineLocked)
            {
                int lookback = Math.Max(1, _portfolioStopperLookbackCandles.ValueInt);
                if (_stopperEquityHistory.Count > lookback)
                {
                    decimal refEquity = _stopperEquityHistory[_stopperEquityHistory.Count - 1 - lookback].Equity;
                    if (_portfolioStopperReferenceEquity.ValueDecimal != refEquity)
                    {
                        _portfolioStopperReferenceEquity.ValueDecimal = refEquity;
                    }
                }
            }
        }

        private bool ExecutePortfolioStopperTrigger(
            BotTabSimple tab,
            DateTime candleTime,
            bool isTakeProfit,
            decimal referenceEquity,
            decimal currentEquity,
            decimal thresholdPercent,
            decimal triggerLevel)
        {
            _stopperLastProtectionCandleTime = candleTime;
            string closeSignal = isTakeProfit ? SignalPortfolioStopperTp : SignalPortfolioStopperSl;
            CloseAllBotPositions(closeSignal);
            MaybeSaveLogicPortfolios(force: true);

            RecalculateAllLogicPortfolioUnrealized();
            decimal postCloseEquity = GetCombinedLogicPortfolioEquity();
            ApplyStopperReferenceBaseline(postCloseEquity, candleTime, saveParameters: false);

            bool stopRobot = isTakeProfit
                ? _stopRobotAfterPortfolioTakeProfit.ValueBool
                : _stopRobotAfterPortfolioStopLoss.ValueBool;
            if (stopRobot)
            {
                _regime.ValueString = "Off";
            }

            SaveParameters();

            string kind = isTakeProfit ? "take-profit" : "stop-loss";
            string msg = NameStrategyUniq
                + " | Stopper: общепортфельный "
                + kind
                + " "
                + thresholdPercent.ToString(CultureInfo.InvariantCulture)
                + "% | ref="
                + referenceEquity.ToString(CultureInfo.InvariantCulture)
                + ", equity="
                + currentEquity.ToString(CultureInfo.InvariantCulture)
                + ", порог="
                + triggerLevel.ToString(CultureInfo.InvariantCulture)
                + ", закрыты все позиции, ref→"
                + postCloseEquity.ToString(CultureInfo.InvariantCulture)
                + (stopRobot ? ", Regime=Off" : ", Regime без изменений")
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
            if (NeedsLogicPortfolioTrackingOnCandle())
            {
                RecalculateAllLogicPortfolioUnrealized();

                if (_metaLogicEnabled.ValueBool)
                {
                    RefreshLogicPortfoliosOnCandle(tab, candles, candleIndex);
                }

                if (IsPortfolioStopperActive())
                {
                    RefreshStopperTechEquityDisplay(candleTime, atCandleStart: true);
                    if (TryManagePortfolioStopperProtection(tab, candleTime))
                    {
                        MaybeRefreshReferenceAnnualYieldThrottled(candleTime, tab, candleIndex);
                        return;
                    }
                }
            }

            if (_regime.ValueString != "Off" && candles.Count >= GetMinBarsForTrading())
            {
                ProcessLogicTradingOnCandle(candles, tab, candleIndex);
                if (NeedsLogicPortfolioTrackingOnCandle())
                {
                    RecalculateAllLogicPortfolioUnrealized();
                }
            }

            if (NeedsLogicPortfolioTrackingOnCandle() && IsPortfolioStopperActive())
            {
                RefreshStopperTechEquityDisplay(candleTime, atCandleStart: false);
            }

            MaybeRefreshReferenceAnnualYieldThrottled(candleTime, tab, candleIndex);
        }

        /// <summary>Лайв / оптимизатор: полный цикл портфеля, stopper, ensure-индикаторов.</summary>
        private void ScreenerTab_CandleFinishedEventFull(
            List<Candle> candles,
            BotTabSimple tab,
            int candleIndex,
            DateTime candleTime)
        {
            TryEnsureRobotIndicatorsOnTabIfNeeded(tab, candleIndex);

            RecalculateAllLogicPortfolioUnrealized();

            RefreshLogicPortfoliosOnCandle(tab, candles, candleIndex);
            if (IsPortfolioStopperActive())
            {
                RefreshStopperTechEquityDisplay(candleTime, atCandleStart: true);
            }

            bool stopperTriggered = IsPortfolioStopperActive()
                && TryManagePortfolioStopperProtection(tab, candleTime);

            if (stopperTriggered)
            {
                RefreshReferenceAnnualYieldDisplay(candleTime, tab);
                MaybeSaveLogicPortfolios(force: false);
                return;
            }

            if (_regime.ValueString != "Off" && candles.Count >= GetMinBarsForTrading())
            {
                ProcessLogicTradingOnCandle(candles, tab, candleIndex);
                RecalculateAllLogicPortfolioUnrealized();
            }

            if (IsPortfolioStopperActive())
            {
                RefreshStopperTechEquityDisplay(candleTime, atCandleStart: false);
            }

            RefreshReferenceAnnualYieldDisplay(candleTime, tab);
            MaybeSaveLogicPortfolios(force: false);
        }

        /// <summary>Нужен ли пересчёт L1…L10 на свече (металогика, stopper или справочный % годовых).</summary>
        private bool NeedsLogicPortfolioTrackingOnCandle()
        {
            if (_metaLogicEnabled.ValueBool || IsPortfolioStopperActive())
            {
                return true;
            }

            return (_referenceInitialPortfolioAmount?.ValueDecimal ?? 0m) > 0m;
        }

        private bool IsPortfolioStopperActive()
        {
            return _usePortfolioStopLoss.ValueBool || _usePortfolioTakeProfit.ValueBool;
        }

        /// <summary>Справочный % годовых в тестере — не каждую свечу (меньше нагрузки на UI параметров).</summary>
        private void MaybeRefreshReferenceAnnualYieldThrottled(DateTime candleTime, BotTabSimple tab, int candleIndex)
        {
            if ((_referenceInitialPortfolioAmount?.ValueDecimal ?? 0m) <= 0m)
            {
                return;
            }

            if (candleIndex > 0 && candleIndex % 20 != 0)
            {
                return;
            }

            RefreshReferenceAnnualYieldDisplay(candleTime, tab);
        }

        /// <summary>
        /// Торговый цикл на одной свече: SL/TP, выходы по Cl, входы по Op.
        /// Volume: поровну или по PnlSMA (если «Металогика включена»).
        /// Max positions: металогика — приоритет по убыванию PnlSMA; иначе L1…L10.
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

                if (!LogicExpressionEvaluator.EvaluateClose(
                        runtime.ParseResult.Root,
                        tab,
                        candles,
                        candleIndex,
                        FindIndicatorForAtom))
                {
                    continue;
                }

                TryCloseLogicPosition(tab, openPos, slotIndex);
            }

            var entryCandidates = new List<int>();
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

                if (!LogicExpressionEvaluator.EvaluateOpen(
                        runtime.ParseResult.Root,
                        tab,
                        candles,
                        candleIndex,
                        FindIndicatorForAtom))
                {
                    continue;
                }

                entryCandidates.Add(slotIndex);
            }

            if (entryCandidates.Count == 0)
            {
                return;
            }

            if (_metaLogicEnabled.ValueBool)
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
                    + (_metaLogicEnabled.ValueBool
                        ? "приоритет по PnlSMA, убывание"
                        : "приоритет по номеру логики")
                    + ").",
                    LogMessageType.System);
            }

            if (_metaLogicEnabled.ValueBool)
            {
                OpenEntryCandidatesByMetaLogicPnlSma(tab, entryCandidates, totalVolume, entriesToOpen);
                return;
            }

            decimal volumePerLogic = RoundVolume(tab, totalVolume / entryCandidates.Count);
            if (volumePerLogic <= 0m)
            {
                return;
            }

            for (int i = 0; i < entriesToOpen; i++)
            {
                int slotIndex = entryCandidates[i];
                LogicSlotRuntime runtime = _logicSlotRuntimes[slotIndex];
                TryOpenLogicPosition(tab, slotIndex, volumePerLogic, runtime.EntrySide);
            }
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
        /// Металогика: Volume делится между логиками с Op пропорционально |PnlSMA|;
        /// знак PnlSMA переворачивает сторону относительно Side логики.
        /// </summary>
        private void OpenEntryCandidatesByMetaLogicPnlSma(
            BotTabSimple tab,
            List<int> entryCandidates,
            decimal totalVolume,
            int entriesToOpen)
        {
            if (tab == null || entryCandidates == null || entriesToOpen <= 0 || totalVolume <= 0m)
            {
                return;
            }

            var weights = new decimal[entriesToOpen];
            decimal sumAbs = 0m;
            for (int i = 0; i < entriesToOpen; i++)
            {
                int slotIndex = entryCandidates[i];
                decimal weight = TryGetLogicPnlSmaAllocationWeight(slotIndex, out decimal w) ? w : 1m;
                if (weight == 0m)
                {
                    weight = 1m;
                }

                weights[i] = weight;
                sumAbs += Math.Abs(weight);
            }

            if (sumAbs <= 0m)
            {
                decimal fallbackVolume = RoundVolume(tab, totalVolume / entriesToOpen);
                for (int i = 0; i < entriesToOpen; i++)
                {
                    int slotIndex = entryCandidates[i];
                    LogicSlotRuntime runtime = _logicSlotRuntimes[slotIndex];
                    TryOpenLogicPosition(tab, slotIndex, fallbackVolume, runtime.EntrySide);
                }

                return;
            }

            decimal allocated = 0m;
            for (int i = 0; i < entriesToOpen; i++)
            {
                int slotIndex = entryCandidates[i];
                LogicSlotRuntime runtime = _logicSlotRuntimes[slotIndex];
                decimal shareVolume = totalVolume * Math.Abs(weights[i]) / sumAbs;
                decimal volume = i == entriesToOpen - 1
                    ? RoundVolume(tab, totalVolume - allocated)
                    : RoundVolume(tab, shareVolume);
                allocated += volume;

                if (volume <= 0m)
                {
                    continue;
                }

                Side entrySide = weights[i] >= 0m ? runtime.EntrySide : FlipEntrySide(runtime.EntrySide);
                TryOpenLogicPosition(tab, slotIndex, volume, entrySide);
            }
        }

        private static Side FlipEntrySide(Side side)
        {
            return side == Side.Buy ? Side.Sell : Side.Buy;
        }

        /// <summary>Вес PnlSMA логики для мета-распределения Volume (last, иначе avg).</summary>
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

            if (meta.PnlSmaLast.HasValue)
            {
                weight = meta.PnlSmaLast.Value;
                return true;
            }

            if (meta.PnlSmaAvg.HasValue)
            {
                weight = meta.PnlSmaAvg.Value;
                return true;
            }

            return false;
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
            Portfolio portfolio = tab?.Portfolio ?? tab?.Connector?.Portfolio;
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

        private static bool ShouldReadPortfolioFromTesterServer(BotTabSimple tab)
        {
            return tab != null
                && (tab.StartProgram == StartProgram.IsTester
                    || tab.StartProgram == StartProgram.IsOsOptimizer);
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

        /// <summary>Тестер/оптимизатор: ValueCurrent или StartPortfolio.</summary>
        private decimal? TryGetTesterPortfolioEquity(BotTabSimple tab)
        {
            if (StartProgram != StartProgram.IsTester && StartProgram != StartProgram.IsOsOptimizer)
            {
                return null;
            }

            if (tab?.Connector?.MyServer is TesterServer tabTester)
            {
                decimal? fromConnector = TryGetFullPortfolioEquityFromPortfolioObject(
                    tab.Connector.Portfolio ?? tab.Portfolio);
                if (fromConnector.HasValue)
                {
                    return fromConnector;
                }

                if (tabTester.StartPortfolio > 0m)
                {
                    return tabTester.StartPortfolio;
                }
            }

            IServer server = FindTesterLikeServer();
            if (server is TesterServer testerServer && testerServer.StartPortfolio > 0m)
            {
                return testerServer.StartPortfolio;
            }

            if (server?.Portfolios != null && server.Portfolios.Count > 0)
            {
                return TryGetFullPortfolioEquityFromPortfolioObject(server.Portfolios[0]);
            }

            return null;
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
                    ? "эмулятор (OsEngine)"
                    : "лайв");

            string msg =
                NameStrategyUniq
                + " | диагностика: Regime="
                + (_regime?.ValueString ?? "?")
                + ", режим="
                + executionMode
                + ", портфель="
                + (realPortfolio.HasValue ? realPortfolio.Value.ToString(CultureInfo.InvariantCulture) : "—");

            if (StartProgram == StartProgram.IsOsTrader && tab?.Connector != null)
            {
                msg += ", коннектор="
                    + (tab.Connector.IsConnected ? "подключён" : "нет")
                    + ", торговля="
                    + (tab.Connector.IsReadyToTrade ? "готова" : "не готова")
                    + ", эмулятор скринера="
                    + (_screenerTab?.EmulatorIsOn == true ? "вкл." : "выкл.");
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
            /// <summary>Средний профит на свечу (PnlSMA avg).</summary>
            public decimal? PnlSmaAvg;
            /// <summary>Последний профит на свечу (PnlSMA last).</summary>
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
                SaveParameters();
                RepaintParameterGuiTables();
                TryParseAndApplyAllLogicSlots(logToUser: true);

                string msg = NameStrategyUniq + " | JSON-снимок загружен: " + path;
                SendNewLogMessage(msg, LogMessageType.User);
                SendNewLogMessage(msg, LogMessageType.System);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
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

        private static void RunOnUiThread(Action action)
        {
            if (action == null)
            {
                return;
            }

            if (System.Windows.Application.Current?.Dispatcher != null)
            {
                System.Windows.Application.Current.Dispatcher.Invoke(action);
            }
            else
            {
                action();
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

            var points = new LogicPortfolioPointDto[runtime.History.Count];
            for (int i = 0; i < runtime.History.Count; i++)
            {
                LogicPortfolioPoint p = runtime.History[i];
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

                for (int i = 0; i < tab.PositionsOpenAll.Count; i++)
                {
                    Position pos = tab.PositionsOpenAll[i];
                    if (!IsOurMultiLogicOpenPosition(pos, botType)
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

            RecalculateLogicPortfolioUnrealized(slot);
            AppendLogicPortfolioPoint(
                slot,
                "close",
                profit,
                GetLogicPortfolioTabKey(tab),
                position.SignalTypeClose,
                candleTime);
            SyncAggregateMetaPortfolioPoint(tab, candleTime, "close", position.SignalTypeClose);
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

            _logicPortfolios[slot].Unrealized = unrealized;
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

            var points = new LogicPortfolioPointDto[runtime.History.Count];
            for (int i = 0; i < runtime.History.Count; i++)
            {
                LogicPortfolioPoint p = runtime.History[i];
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
            /// PnlSMA: первая точка окна = 0, далее delta equity; avg = профит за окно / длина, last = delta последней свечи.
            /// </summary>
            private static void TryPnlSma(
                IReadOnlyList<LogicPortfolioPoint> history,
                int index,
                int length,
                MetaIndicatorValues target)
            {
                if (index >= 1)
                {
                    target.PnlSmaLast = history[index].Equity - history[index - 1].Equity;
                }

                if (index < length - 1)
                {
                    return;
                }

                int start = index - length + 1;
                target.PnlSmaAvg = (history[index].Equity - history[start].Equity) / length;
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

                    SafeReloadLogicIndicatorsOnAllTabsQuiet(logSummary: attempt == 0 || attempt == MoexIndicatorsAttachMaxAttempts);

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

        /// <summary>
        /// Установка индикаторов робота на все готовые вкладки (без ReloadIndicatorsOnTabs / SynchFirstTab из ядра).
        /// </summary>
        private int SafeReloadLogicIndicatorsOnAllTabsQuiet(bool logSummary = true)
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

        /// <summary>Догрузить индикаторы на одной вкладке, если после MOEX reload они не созданы.</summary>
        private void TryEnsureRobotIndicatorsOnTabIfNeeded(BotTabSimple tab, int candleIndex = -1)
        {
            if (tab == null || _screenerTab?._indicators == null || !IsTabChartReadyForIndicators(tab))
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
            if (tab == null || ind == null || !IsTabChartReadyForIndicators(tab))
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
    }
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

    /// <summary>Результат парсинга одной строки «Логика N».</summary>
    public sealed class LogicParseResult
    {
        /// <summary>true — разбор успешен (или пустая строка).</summary>
        public bool Success;
        /// <summary>Логика отключена префиксом Disabled(true) / Disable(true) в начале строки.</summary>
        public bool IsDisabled;
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
    /// Парсер строк логики MultiLogic: Disabled, AND/OR, атомы индикаторов, Op/Cl, SL/TP, Note.
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

                if (ContainsInnerDisableMarker(work))
                {
                    return LogicParseResult.Fail(
                        "Disabled(…) / Disable(…) допустимы только в самом начале строки, до AND/OR, без скобок вокруг.");
                }

                if (string.IsNullOrWhiteSpace(work))
                {
                    return new LogicParseResult
                    {
                        Success = true,
                        IsDisabled = isDisabled,
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
                return new LogicParseResult
                {
                    Success = true,
                    IsDisabled = isDisabled,
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

        /// <summary>Текст справки для файла MultiLogic_LogicHelp.txt (источник — код робота).</summary>
        public static string BuildDefaultHelpText()
        {
            var sb = new StringBuilder();
            sb.AppendLine("MultiLogic — справка по строкам логики");
            sb.AppendLine("(файл Custom\\Robots\\MultiLogic_LogicHelp.txt — автоматически из MultiLogic.cs;");
            sb.AppendLine(" обновляется при запуске робота и по кнопке Help; ручные правки перезаписываются)");
            sb.AppendLine();
            AppendResourceHelp(sb);
            sb.AppendLine("0) Отключение логики (только в самом начале строки, до AND/OR):");
            sb.AppendLine("   Disabled(true)   — логика отключена, индикаторы не создаются");
            sb.AppendLine("   Disabled(false)  — явно включена (то же, что без префикса)");
            sb.AppendLine("   Disable(true/false) — синоним Disabled");
            sb.AppendLine("   Без префикса Disabled — логика включена.");
            sb.AppendLine("   Нельзя внутри скобок фрагмента или после AND/OR — только в начале, без внешних скобок.");
            sb.AppendLine("   Примеры:");
            sb.AppendLine("     Disabled(true) SMA(100) Op[Ab] Cl[Bl]");
            sb.AppendLine("     Disabled(false) (SMA(100) Op[Ab]) AND (ATR(14;Gr=3%;Lb=5) Op[GrOk] Cl[-])");
            sb.AppendLine();
            sb.AppendLine("1) Составная логика (скобки обязательны вокруг каждого фрагмента):");
            sb.AppendLine("   (SMA(100) Op[Ab] Cl[Bl]) AND (Stoch(14-3-3;Lmin=55;Smax=45) Op[K>=55] Cl[K<=45])");
            sb.AppendLine("   (SMA(100) Op[Ab]) OR (SMA(100) Side[S] Op[Bl] Cl[Ab])");
            sb.AppendLine("   Сначала разбираются OR, затем AND, затем атомы.");
            sb.AppendLine();
            sb.AppendLine("2) Один атом (скобки необязательны):");
            sb.AppendLine("   <Индикатор>(параметры) [Side:L|S] Op[вход] Cl[выход] [SL[…]] [TP[…]] Note(пояснение)");
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
            sb.AppendLine("   Macd>Sig / Macd<Sig — линия MACD выше/ниже сигнальной;");
            sb.AppendLine("   AbUp / BlUp — close выше/ниже верхней линии LinReg; Cl[-] — отдельного Cl нет (ATR: на выходе всё равно Op[GrOk]).");
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
            sb.AppendLine("   Номера индикаторов: 101 … " + MaxManagedLogicIndicatorNum + " (общий пул, без дублей).");
            sb.AppendLine();
            sb.AppendLine("================================================================================");
            sb.AppendLine("7) СПРАВОЧНИК ИНДИКАТОРОВ — как записывать (полный набор)");
            sb.AppendLine("================================================================================");
            sb.AppendLine();
            AppendSmaHelp(sb);
            AppendStochHelp(sb);
            AppendAtrHelp(sb);
            AppendLinRegHelp(sb);
            AppendMacdHelp(sb);
            sb.AppendLine("================================================================================");
            sb.AppendLine("8) Торговля (Regime = On)");
            sb.AppendLine("================================================================================");
            sb.AppendLine("   На каждой закрытой свече каждой вкладки скринера проверяются все не-Disabled логики.");
            sb.AppendLine("   Вход: срабатывает составное выражение по Op[…] (AND/OR как в строке).");
            sb.AppendLine("   Выход: по Cl[…]; Cl[-] — атом не задаёт направленный выход (фильтр ATR на выходе = Op[GrOk]).");
            sb.AppendLine("   Side[S] — шорт (Sell), иначе лонг (Buy). Позиция: сигнал MultiLogic_L1 … MultiLogic_L10.");
            sb.AppendLine("   Volume — общий объём; при нескольких входах на одной свече делится поровну между логиками.");
            sb.AppendLine("   Max positions (all tabs) — лимит открытых позиций робота на скринере.");
            sb.AppendLine("   Нехватка слотов: входят логики с меньшим номером (1 раньше 10), остальные пропускаются.");
            sb.AppendLine("   SL/TP: на закрытии свечи проверяется close vs уровни из SL[…]/TP[…] строки логики позиции.");
            sb.AppendLine("   Пробой SL — закрытие с сигналом …_SL; пробой TP — …_TP; иначе выход по Cl[…].");
            return sb.ToString();
        }

        /// <summary>Алиас BuildDefaultHelpText() для обратной совместимости.</summary>
        public static string GetHelpText() => BuildDefaultHelpText();

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
            sb.AppendLine("  Вверху — «Металогика включена», кнопка «Включить металогику», PnlSMA (вкл. и длина);");
            sb.AppendLine("  под PnlSMA — разделитель; ниже — справочные SMA, Stoch, ATR, LinReg, MACD (запись в файлы).");
            sb.AppendLine("  Если металогика включена: Volume на входе делится только между логиками с Op");
            sb.AppendLine("  пропорционально |PnlSMA| (по портфелю логики); знак PnlSMA переворачивает Buy/Sell.");
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
            sb.AppendLine("  PnlSMA (Приведённая SMA): средний профит на свечу (pnlSmaAvg) и последний (pnlSmaLast);");
            sb.AppendLine("  по умолчанию включён только общепортфельный PnlSMA, остальные мета-индикаторы — выкл.");
            sb.AppendLine();
            sb.AppendLine("Вкладка «Stopper» (общепортфельная страховка по сумме L1…L10):");
            sb.AppendLine("  Equity = сумма кривых портфелей всех логик (realized + unrealized MultiLogic_Ln).");
            sb.AppendLine("  «Общепортфельный stop-loss / take-profit: включён» — по умолчанию выкл.; пороги 0,4% и 10%.");
            sb.AppendLine("  Ref (предыдущая сумма) = equity ровно N свечей назад (lookback, по умолчанию 5);");
            sb.AppendLine("  история обновляется на каждом закрытии свечи вкладки скринера.");
            sb.AppendLine("  SL: current ≤ ref × (1 − SL%); TP: current ≥ ref × (1 + TP%). Ref ≤ 0 — проверка пропускается.");
            sb.AppendLine("  При срабатывании — закрытие всех позиций робота; опционально Regime=Off (отдельно для SL и TP).");
            sb.AppendLine("  Техн. суммы обновляются в начале обработки свечи и после торговли на ней (без SaveParameters).");
            sb.AppendLine("  «Обновить сумму портфеля SL/TP» — текущая equity в базу; тех. суммы — в начале и после торговли на свече.");
            sb.AppendLine("  После SL/TP ref = equity после закрытия; база 0 — ref из lookback.");
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
            sb.AppendLine("  LinReg(50)                  — длина канала 50, Dev=2 по умолчанию");
            sb.AppendLine("  LinReg(50;Dev=2)            — длина и отклонение границ, %");
            sb.AppendLine("  LinReg(L=50,Dev=2)          — именованно");
            sb.AppendLine("Сигналы (как TrendMultiIndicatorScreener — канал LinReg):");
            sb.AppendLine("  Op[AbUp]  — close выше верхней линии (лонг)");
            sb.AppendLine("  Cl[BlUp]  — close ниже верхней (выход)");
            sb.AppendLine("  Side[S] Op[BlLo] Cl[AbLo] — шорт от нижней линии");
            sb.AppendLine("Примеры:");
            sb.AppendLine("  Тренд:      LinReg(50;Dev=2) Op[AbUp] Cl[BlUp] SL[2%] TP[6%] Note(trend)");
            sb.AppendLine("  Антитренд:  LinReg(50;Dev=2) Side[S] Op[BlLo] Cl[AbLo] Note(counter-trend)");
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

        /// <summary>Имя класса индикатора OsEngine для CreateCandleIndicator.</summary>
        public static string GetIndicatorTypeName(LogicIndicatorKind kind)
        {
            switch (kind)
            {
                case LogicIndicatorKind.Sma: return "Sma";
                case LogicIndicatorKind.Stoch: return "Stochastic";
                case LogicIndicatorKind.Atr: return "ATR";
                case LogicIndicatorKind.Rsi: return "Rsi";
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
                        atom.GetIntParam("L", 50).ToString(CultureInfo.InvariantCulture),
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
            List<string> orParts = SplitAtTopLevelOperator(input, "OR");
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
            List<string> andParts = SplitAtTopLevelOperator(input, "AND");
            if (andParts.Count > 1)
            {
                LogicExpressionNode node = ParseAtomWrapper(andParts[0]);
                for (int i = 1; i < andParts.Count; i++)
                {
                    node = new LogicCombineNode(LogicCombineOp.And, node, ParseAtomWrapper(andParts[i]));
                }

                return node;
            }

            return ParseAtomWrapper(input);
        }

        /// <summary>Снимает внешние скобки фрагмента и разбирает один атом.</summary>
        private LogicAtomNode ParseAtomWrapper(string input)
        {
            string fragment = input?.Trim() ?? "";
            if (fragment.Length >= 2 && fragment[0] == '(' && TryExtractOuterParentheses(fragment, out string inner))
            {
                fragment = inner.Trim();
            }

            LogicAtom atom = ParseAtom(fragment);
            return new LogicAtomNode(atom);
        }

        /// <summary>
        /// Разбирает один атом: Note, SL, TP, Side, Cl, Op, затем заголовок индикатора и параметры.
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

            ParseIndicatorHeader(work, atom);
            if (atom.Kind == LogicIndicatorKind.Unknown)
            {
                throw new InvalidOperationException("Неизвестный индикатор в: " + input);
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
                case LogicIndicatorKind.Macd:
                    EnsureDefault(atom, "Fast", "12");
                    EnsureDefault(atom, "Slow", "26");
                    EnsureDefault(atom, "Signal", "9");
                    break;
                case LogicIndicatorKind.LinReg:
                    EnsureDefault(atom, "L", "50");
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
        /// Делит строку по оператору AND или OR на части верхнего уровня (вне скобок индикаторов).
        /// </summary>
        private static List<string> SplitAtTopLevelOperator(string input, string op)
        {
            var parts = new List<string>();
            if (string.IsNullOrWhiteSpace(input))
            {
                return parts;
            }

            int depthParen = 0;
            int depthBracket = 0;
            int lastSplit = 0;
            string token = " " + op + " ";

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
                else if (depthParen == 0 && depthBracket == 0 && i + token.Length <= input.Length)
                {
                    if (string.Compare(input, i, token, 0, token.Length, StringComparison.OrdinalIgnoreCase) == 0)
                    {
                        parts.Add(input.Substring(lastSplit, i - lastSplit).Trim());
                        lastSplit = i + token.Length;
                        i = lastSplit - 1;
                    }
                }
            }

            parts.Add(input.Substring(lastSplit).Trim());
            return parts.Where(p => !string.IsNullOrWhiteSpace(p)).ToList();
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
            if (root == null
                || tab == null
                || candles == null
                || position == null
                || findIndicator == null
                || candleIndex < 0
                || candleIndex >= candles.Count
                || position.EntryPrice <= 0m)
            {
                return LogicStopTakeHit.None;
            }

            List<LogicAtom> atoms = LogicLineParser.GetExpressionAtoms(root);
            if (atoms == null || atoms.Count == 0)
            {
                return LogicStopTakeHit.None;
            }

            bool isLong = position.Direction != Side.Sell;
            decimal entry = position.EntryPrice;
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

            return LogicSignalEvaluator.Evaluate(signal, atom, indicator, candles, tab, candleIndex);
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

            string open = atom.OpenSignal.Trim().Replace(" ", "").ToUpperInvariant();
            return open == "GROK"
                || open.Contains("@")
                || open.StartsWith("+", StringComparison.Ordinal);
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

            return LogicSignalEvaluator.Evaluate(signal, atom, indicator, candles, tab, candleIndex);
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
                case LogicIndicatorKind.Macd:
                    return atom.GetIntParam("Slow", 26) + atom.GetIntParam("Signal", 9);
                case LogicIndicatorKind.LinReg:
                    return atom.GetIntParam("L", 50);
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

            string signal = NormalizeSignal(signalCode);
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
            }

            return EvaluateThresholdSignal(signal, atom, indicator, close, candleIndex);
        }

        /// <summary>Нормализует код сигнала: trim, без пробелов, upper case.</summary>
        private static string NormalizeSignal(string signalCode)
        {
            return signalCode.Trim().Replace(" ", "").ToUpperInvariant();
        }

        /// <summary>Проверяет пороговые сигналы K>=, RSI>=, MOM>= и обратные.</summary>
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
}