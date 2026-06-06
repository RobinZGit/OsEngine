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
using OsEngine.OsTrader.Panels.Tab.Internal;

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
- Volume TOD (опционально): объём vs среднее в то же время прошлых торговых дней (intraday)
- VWAP (close выше/ниже линии; сброс по календарному дню)
- MACD (линия MACD выше/ниже сигнальной; по умолчанию выкл.)
- ATR (фильтр роста волатильности: ATR вырос на % за lookback свечей)

Each indicator has an enable/disable parameter. Disabled indicators are not created on screener tabs.
По умолчанию включён только SMA; остальные Use* — выкл.
У каждого индикатора — «№ И-группы» (строка, числа через запятую; минус = NOT): индикатор входит во все перечисленные группы; по модулю номера строится ключ И-группы; внутри группы условия связаны И; между группами ИЛИ.

Entry:
Open Long / Short when the grouped formula is satisfied for bull/bear checks (see indicator pass methods).
«Проверять успешность стратегии» (по умолчанию выкл.): на график — TrendMultiIndicatorPortfolio_indicator (Second), параметры как у робота; доп. фильтр только на вход — у каждой активной И-группы серия портфеля растёт 3 свечи подряд; выход/реверс без этой проверки.
«Инверсия логики (покупка и продажа меняются местами)»: бычий → short, медвежий → long (вход, выход, реверс).

If Volume indicator is enabled, current candle volume must be at least (previous volume × (1 + min growth % / 100)).
Optional «Volume: сравнение с тем же временем прошлых дней»: curVol / avg(same TimeStart time on last N trading days) ≥ min ratio.

Exit/Reverse:
If a position exists and opposite signal appears, close and (if allowed) open opposite.
Order execution: «Тип заявок (вход и выход)» — Лимит (default) or Рынок for entries, exits, reverse, schedule, portfolio insurance, stop-all.

Filters (AlgoStart-style):
- Non-trade periods (button opens calendar/time settings).
- Volatility cluster to trade (1–3) with lookback; only tabs in the chosen cluster can open new positions.

Schedule (tab «Расписание»): «Дата-время начала/окончания работы» — пустая строка = выкл.; до начала торговля не идёт; после окончания — закрытие всех позиций скринера по рынку и остановка логики. Форматы: дата, дата+время, только время (дата = календарный день decision time).

Stops (tab «Стопы»): страховка портфеля; фейковый режим и фейковая сумма; опция возобновления торгов при превышении фейковой суммой базы просадки на 0,1%.

MOEX futures / stocks: в OsTrader — бумаги с уже выбранного TInvest и портфеля скринера (коннектор, портфель, ТФ не меняются); в тестере — бумаги из сета Tester.

MOEX futures: префиксы корня, класс Futures (TInvest) или TestClass (тестер); две кнопки — короткий и расширенный список в одно поле; «Обновить фьючерсы» без изменений.

MOEX stocks: тикеры (точное имя), класс Stock rub (TInvest) или TestClass (тестер).
*/

namespace OsEngine.Robots.Custom
{
    /// <summary>
    /// Скринерный трендовый робот: несколько индикаторов, И-группы (AND внутри |№|, OR между |№|),
    /// MOEX reload (TInvest/Tester), расписание, стопы, кластеры волатильности.
    /// </summary>
    public class TrendMultiIndicatorScreener : BotPanel
    {
        private const int NumSma = 1;
        private const int NumRsi = 2;
        private const int NumStoch = 3;
        private const int NumMomentum = 4;
        private const int NumBollinger = 5;
        private const int NumLinReg = 6;
        private const int NumVolumeIndicator = 9;


        private const int NumVwap = 11;
        private const int NumAtr = 12;
        private const int NumMacd = 13;
        private const int NumPortfolioIndicator = 14;

        private const string PortfolioIndicatorType = "TrendMultiIndicatorPortfolio_indicator";
        private const string PortfolioSeriesNamePrefix = "Портфель |";
        private const int PortfolioSuccessRisingBars = 3;

        private const string VwapIndicatorType = "VWAP";


        private const string AreaPrime = "Prime";
        private const string AreaSecond = "Second";

        private const string SignalPortfolioDrawdownStop = "TrendMultiPortfolioDrawdown";
        private const decimal ResumeTradingFakeOverBaselinePercent = 0.1m;
        private const string SignalProfitCollection = "TrendMultiProfitCollection";
        private const string DefaultMoneyMarketFundPrefix = "TMON";
        private const string MoneyMarketFundDoNotBuyOption = "Не закупать";
        private static readonly string[] MoneyMarketFundPrefixOptions = { "TMON", "LQDT", "SBMM", MoneyMarketFundDoNotBuyOption };
        private const decimal DefaultBuyMoneyMarketFundPortfolioThreshold = 999_999_999m;
        private const string SignalStopRobotAndSellAll = "TrendMultiStopAll";
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
        private StrategyParameterBool _checkStrategySuccess;

        /// <summary>Отложенная установка индикаторов после MOEX reload (чарты вкладок ещё не готовы).</summary>
        private int _moexIndicatorsAttachPassId;

        private const int MoexIndicatorsAttachMaxAttempts = 25;

        /// <summary>Пауза между вкладками при «Обновить акции» — снижает гонку ClearJournalsArray в GlobalPositionViewer.</summary>
        private const int MoexStockTabReloadDelayMs = 700;

        private int _moexStockReloadInProgress;

        // стопы (страховка портфеля)
        private StrategyParameterBool _usePortfolioStop;
        private StrategyParameterDecimal _portfolioStopBaselineAmount;
        private StrategyParameterString _portfolioStopDrawdownDate;
        private StrategyParameterDecimal _portfolioStopDrawdownPercent;
        private StrategyParameterBool _usePortfolioTakeProfit;
        private StrategyParameterDecimal _portfolioTakeProfitPercent;
        private StrategyParameterBool _fakeMode;
        private StrategyParameterDecimal _fakePortfolioAmount;
        private StrategyParameterBool _resumeTradingWhenFakeExceedsDrawdownBaseline;
        private StrategyParameterBool _portfolioStopEnableFakeModeOnTrigger;
        private StrategyParameterBool _portfolioTakeProfitEnableFakeModeOnTrigger;
        private StrategyParameterButton _fillPortfolioStopBaselineButton;
        private StrategyParameterButton _enablePortfolioStopsAndRecoveryButton;
        private StrategyParameterButton _disablePortfolioStopsAndRecoveryButton;
        private StrategyParameterInt _timeExitCandles;
        private StrategyParameterBool _usePortfolioPeakDrawdownStop;
        private StrategyParameterDecimal _portfolioPeakDrawdownPercent;
        private StrategyParameterDecimal _portfolioPeakValue;

        // расчёты (целевые суммы портфеля)
        private StrategyParameterDecimal _calculationsTargetAnnualPercent;
        private StrategyParameterDecimal _calculationsInitialPortfolioAmount;
        private StrategyParameterString _calculationsStartDate;
        private StrategyParameterButton _calculationsCalculateButton;
        private StrategyParameterDecimal _calculationsCurrentPortfolioAmount;
        private StrategyParameterDecimal _calculationsAccumulatedTargetAmount;
        private StrategyParameterDecimal _calculationsAccumulatedTargetWithCapitalization;

        private bool _portfolioPeakDirty;
        private DateTime _portfolioPeakLastSaveTime = DateTime.MinValue;
        private const int PortfolioPeakSaveIntervalSeconds = 60;

        // сбор прибыли (денежный фонд)
        private StrategyParameterString _moneyMarketFundPrefix;
        private StrategyParameterDecimal _buyMoneyMarketFundWhenPortfolioExceeds;

        // Shadow virtual portfolio (mirrors real trades when фейковый режим 1 выключен).
        private readonly Dictionary<string, FakePortfolioVirtualPosition> _shadowVirtualPositions =
            new Dictionary<string, FakePortfolioVirtualPosition>(StringComparer.OrdinalIgnoreCase);

        private const string ShadowVirtualPositionsFileSuffix = "ShadowVirtualPositions.txt";
        private bool _shadowPositionsRestoredFromDisk;
        private bool _shadowPositionsDirty;
        private DateTime _shadowPositionsLastSaveTime = DateTime.MinValue;
        private const int ShadowPositionsSaveIntervalSeconds = 30;

        private static readonly FieldInfo SilentParameterDecimalValueField = typeof(StrategyParameterDecimal).GetField(
            "_valueDecimal",
            BindingFlags.Instance | BindingFlags.NonPublic);

        private DateTime _lastPortfolioStopDecisionTime = DateTime.MinValue;

        /// <summary>Барьер «общей свечи» скринера: стопы/фейковая сумма — один раз после всех вкладок.</summary>
        private readonly object _aggregatedCandleLock = new object();
        private DateTime _aggregatedCandleBarrierTime = DateTime.MinValue;
        private readonly HashSet<string> _aggregatedCandleCompletedTabKeys =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        /// <summary>После take profit ждём откат ниже порога, чтобы не срабатывать снова на той же сумме.</summary>
        private bool _portfolioTakeProfitNeedsPullback;

        private bool _loggedTradingModeDiagnostics;
        private bool _loggedFakeModeBlocksRealOrders;
        private bool _loggedZeroVolumeOnEntry;
        private string _lastVolumeCalcFailureReason;
        private bool _loggedConnectorNotReadyForEntry;

        /// <summary>
        /// Цель для возобновления реальной торговли: база портфеля до срабатывания стопа/профита
        /// (не обновлённая «база просадки» после закрытия позиций).
        /// </summary>
        private decimal _fakeModeRecoveryTargetAmount;

        /// <summary>
        /// Портфель (equity) в свечу срабатывания stop loss / просадки от пика — «дно» для частичного возобновления.
        /// </summary>
        private sealed class FakePortfolioVirtualPosition
        {
            public Side Direction;
            public decimal EntryPrice;
            public decimal Volume;
            public DateTime OpenTime;
        }

        private readonly Dictionary<string, FakePortfolioVirtualPosition> _fakePortfolioVirtualPositions =
            new Dictionary<string, FakePortfolioVirtualPosition>(StringComparer.OrdinalIgnoreCase);

        private readonly HashSet<string> _loggedStopNoticeKeys =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        private readonly HashSet<string> _loggedProfitCollectionNoticeKeys =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase);

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
        private StrategyParameterBool _useAtr;
        private StrategyParameterBool _useMacd;

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
        private StrategyParameterBool _useVolumeTodCompare;
        private StrategyParameterInt _volumeTodPastDays;
        private StrategyParameterDecimal _volumeTodMinRelativeRatio;


        private StrategyParameterInt _atrLen;
        private StrategyParameterDecimal _atrGrowPercent;
        private StrategyParameterInt _atrGrowLookBack;

        private StrategyParameterInt _macdFastLen;
        private StrategyParameterInt _macdSlowLen;
        private StrategyParameterInt _macdSignalLen;

        private StrategyParameterString _vwapAndGroup;
        private StrategyParameterString _atrAndGroup;
        private StrategyParameterString _macdAndGroup;

        /*
         * ---------------------------------------------------------------------------
         * ЛОГИКА «И-ГРУПП» И ОБЩЕГО «ИЛИ» МЕЖДУ ГРУППАМИ (сигналы IsBullSignal / IsBearSignal)
         * ---------------------------------------------------------------------------
         *
         * У каждого индикатора задаётся строка «№ И-группы» (параметры *AndGroup): числа через запятую.
         * Индикатор может входить в несколько групп. Ключ блока И — |номер|. Отрицательное число
         * в списке означает NOT для этой группы (например «1,-2» → группа 1 как есть, группа 2 с инверсией).
         *
         * Внутри блока с ключом |G| все условия связаны логическим И (AND). Для положительного номера
         * берётся результат *Passes как есть; для отрицательного — инверсия (NOT).
         *
         * Разные |номер| — разные блоки. Блоки между собой — логическое ИЛИ (OR): общий сигнал true,
         * если хотя бы один блок целиком true (все его участники с учётом знака дали true).
         *
         * Примеры:
         *  - SMA=«1», RSI=«1»: (SMA ∧ RSI).
         *  - SMA=«1», RSI=«-1»: (SMA ∧ ¬RSI) в группе |1|.
         *  - SMA=«1,2», Volume=«2»: SMA в группах 1 и 2; (…∧SMA₁) ∨ (SMA₂ ∧ Volume₂).
         *  - Номер 0 трактуется как 1.
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
        private StrategyParameterString _smaAndGroup;
        private StrategyParameterString _rsiAndGroup;
        private StrategyParameterString _stochAndGroup;
        private StrategyParameterString _momAndGroup;
        private StrategyParameterString _bollAndGroup;
        private StrategyParameterString _linRegAndGroup;
        private StrategyParameterString _volumeAndGroup;


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
            _screenerTab.PositionClosingSuccesEvent += ScreenerTab_PositionClosingSuccesEvent;
            _screenerTab.EventsIsOn = true;
            EnsureScreenerChildTabsEventsOn();

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
            _invertEntryLogic = CreateParameter(
                "Инверсия логики (покупка и продажа меняются местами)",
                false);
            _checkStrategySuccess = CreateParameter("Проверять успешность стратегии", false);

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
            _usePortfolioStop = CreateParameter("Stop loss портфеля (просадка от базы)", false, stopsTab);
            _portfolioStopBaselineAmount = CreateParameter(
                "Сумма портфеля (база просадки)",
                0m,
                0m,
                1_000_000_000_000m,
                2,
                stopsTab);
            _portfolioStopDrawdownDate = CreateParameter("Дата просадки", "", stopsTab);
            _portfolioStopDrawdownPercent = CreateParameter(
                "Stop loss портфеля от базы, %",
                0.5m,
                0.1m,
                50m,
                0.1m,
                stopsTab);
            _portfolioStopEnableFakeModeOnTrigger = CreateParameter(
                "Переводить робота в фейковый режим 1 при срабатывании стопа",
                false,
                stopsTab);
            _usePortfolioTakeProfit = CreateParameter("Take profit портфеля (рост от базы)", false, stopsTab);
            _portfolioTakeProfitPercent = CreateParameter(
                "Take profit портфеля от базы, %",
                6m,
                0.1m,
                500m,
                0.1m,
                stopsTab);
            _portfolioTakeProfitEnableFakeModeOnTrigger = CreateParameter(
                "Переводить робота в фейковый режим 1 при срабатывании профита",
                false,
                stopsTab);
            _fakeMode = CreateParameter("Фейковый режим 1", false, stopsTab);
            _fakePortfolioAmount = CreateParameter(
                "Фейковая сумма портфеля",
                0m,
                0m,
                1_000_000_000_000m,
                2,
                stopsTab);
            _resumeTradingWhenFakeExceedsDrawdownBaseline = CreateParameter(
                "Возобновлять торги при достижении предыдущего реального значения",
                false,
                stopsTab);
            _timeExitCandles = CreateParameter(
                "Выход по времени, свечей",
                0,
                0,
                1_000_000,
                1,
                stopsTab);
            _usePortfolioPeakDrawdownStop = CreateParameter(
                "Просадка от пика",
                false,
                stopsTab);
            _portfolioPeakDrawdownPercent = CreateParameter(
                "Просадка от пика, %",
                1m,
                0.1m,
                50m,
                0.1m,
                stopsTab);
            _portfolioPeakValue = CreateParameter(
                "Пик портфеля",
                0m,
                0m,
                1_000_000_000_000m,
                2,
                stopsTab);
            _fillPortfolioStopBaselineButton = CreateParameterButton("Заполнить сумму портфеля", stopsTab);
            _enablePortfolioStopsAndRecoveryButton = CreateParameterButton(
                "Включить стопы и возобновление",
                stopsTab);
            _disablePortfolioStopsAndRecoveryButton = CreateParameterButton(
                "Отключить стопы и восстановление",
                stopsTab);
            WireStopsTabButtons();

            const string profitCollectionTab = "Сбор прибыли";
            _moneyMarketFundPrefix = CreateParameter(
                "Закупать фонд денежного рынка, префикс (TMON, LQDT, SBMM, Не закупать)",
                DefaultMoneyMarketFundPrefix,
                MoneyMarketFundPrefixOptions,
                profitCollectionTab);
            _buyMoneyMarketFundWhenPortfolioExceeds = CreateParameter(
                "Порог суммы портфеля (закупка фонда только на превышение)",
                DefaultBuyMoneyMarketFundPortfolioThreshold,
                0m,
                1_000_000_000_000m,
                2,
                profitCollectionTab);

            const string calculationsTab = "Расчёты";
            _calculationsTargetAnnualPercent = CreateParameter(
                "Целевой процент годовых",
                20m,
                0m,
                1000m,
                0.1m,
                calculationsTab);
            _calculationsInitialPortfolioAmount = CreateParameter(
                "Начальная сумма портфеля",
                0m,
                0m,
                1_000_000_000_000m,
                2,
                calculationsTab);
            _calculationsStartDate = CreateParameter(
                "Дата начала расчётов",
                CalculationsStartDatePlaceholder,
                calculationsTab);
            _calculationsCalculateButton = CreateParameterButton("Рассчитать", calculationsTab);
            _calculationsCalculateButton.UserClickOnButtonEvent += CalculationsCalculateButton_UserClickOnButtonEvent;
            _calculationsCurrentPortfolioAmount = CreateParameter(
                "Текущая сумма портфеля",
                0m,
                0m,
                1_000_000_000_000m,
                2,
                calculationsTab);
            _calculationsAccumulatedTargetAmount = CreateParameter(
                "Накопленная целевая сумма",
                0m,
                0m,
                1_000_000_000_000m,
                2,
                calculationsTab);
            _calculationsAccumulatedTargetWithCapitalization = CreateParameter(
                "Накопленная целевая сумма с капитализацией",
                0m,
                0m,
                1_000_000_000_000m,
                2,
                calculationsTab);
            WireCalculationsTabButtons();

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

            // volume
            _volumeType = CreateParameter("Volume type", "Deposit percent", new[] { "Contracts", "Contract currency", "Deposit percent" });
            _volume = CreateParameter("Volume", 20, 1.0m, 50, 4);
            _tradeAssetInPortfolio = CreateParameter("Asset in portfolio", "Prime");

            _resetIndicatorParametersToDefaultButton = CreateParameterButton("Установить параметры индикаторов по умолчанию");
            _resetIndicatorParametersToDefaultButton.UserClickOnButtonEvent += ResetIndicatorParametersToDefaultButton_UserClickOnButtonEvent;

            // toggles
            _useSma = CreateParameter("Use SMA", true);
            _useRsi = CreateParameter("Use RSI", false);
            _useStoch = CreateParameter("Use Stochastic", true);
            _useMomentum = CreateParameter("Use Momentum", false);
            _useBollinger = CreateParameter("Use Bollinger", false);
            _useLinReg = CreateParameter("Use Linear Regression", true);
            _useVolumeIndicator = CreateParameter("Use Volume indicator", false);
            _useVwap = CreateParameter("Use VWAP", false);
            _useAtr = CreateParameter("Use ATR", true);
            _useMacd = CreateParameter("Use MACD", true);


            // SMA
            _smaLen = CreateParameter("SMA length", 100, 5, 300, 1);

            // RSI
            _rsiLen = CreateParameter("RSI length", 14, 2, 100, 1);
            _rsiLongMin = CreateParameter("RSI long min", 55m, 0, 100, 1m);
            _rsiShortMax = CreateParameter("RSI short max", 45m, 0, 100, 1m);

            // Stochastic
            _stochP1 = CreateParameter("Stoch P1", 14, 2, 100, 1);
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
            _useVolumeTodCompare = CreateParameter(
                "Volume: сравнение с тем же временем прошлых дней",
                false);
            _volumeTodPastDays = CreateParameter("Volume TOD: число прошлых торг. дней", 10, 1, 60, 1);
            _volumeTodMinRelativeRatio = CreateParameter(
                "Volume TOD: мин. отношение к среднему",
                0.8m,
                0.1m,
                5m,
                0.05m);


            _atrLen = CreateParameter("ATR length", 14, 2, 200, 1);
            _atrGrowPercent = CreateParameter("ATR min grow % vs lookback", 3m, 0m, 100m, 0.1m);
            _atrGrowLookBack = CreateParameter("ATR grow lookback (candles)", 5, 1, 500, 1);

            _macdFastLen = CreateParameter("MACD fast length", 12, 2, 100, 1);
            _macdSlowLen = CreateParameter("MACD slow length", 26, 2, 300, 1);
            _macdSignalLen = CreateParameter("MACD signal length", 9, 2, 100, 1);

            _smaAndGroup = CreateParameter("SMA: № И-группы (через запятую)", "1");
            _rsiAndGroup = CreateParameter("RSI: № И-группы (через запятую)", "1");
            _stochAndGroup = CreateParameter("Stochastic: № И-группы (через запятую)", "1");
            _momAndGroup = CreateParameter("Momentum: № И-группы (через запятую)", "1");
            _bollAndGroup = CreateParameter("Bollinger: № И-группы (через запятую)", "1");
            _linRegAndGroup = CreateParameter("LinReg: № И-группы (через запятую)", "1");
            _volumeAndGroup = CreateParameter("Volume ind.: № И-группы (через запятую)", "1");
            _vwapAndGroup = CreateParameter("VWAP: № И-группы (через запятую)", "1");
            _atrAndGroup = CreateParameter("ATR: № И-группы (через запятую)", "1");
            _macdAndGroup = CreateParameter("MACD: № И-группы (через запятую)", "1");

            _useRandomPriceShift = CreateParameter("Рандомный сдвиг цен", false);
            _randomPriceShiftPercent = CreateParameter("Рандомность движений, %", 0.1m, 0m, 50m, 0.01m);


            RegisterParameterHints();

            ParametrsChangeByUser += TrendMultiIndicatorScreener_ParametrsChangeByUser;

            // create only enabled indicators
            SyncIndicators();

            Description = "Trend screener: SMA/RSI/Stoch/Momentum/Bollinger/LinReg/Volume/VWAP/ATR/MACD; И-группы по |№|, минус = NOT, ИЛИ между |№|; инверсия входа; non-trade periods, volatility clusters.";

            DeleteEvent += TrendMultiIndicatorScreener_DeleteEvent;

            LoadShadowVirtualPositionsFromDisk();
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

            TryDeleteShadowVirtualPositionsFile();
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

        private const string PortfolioStopBaselineAmountParamName = "Сумма портфеля (база просадки)";
        private const string FakeModeParamName = "Фейковый режим 1";
        private const string FakePortfolioAmountParamName = "Фейковая сумма портфеля";
        private const string PortfolioStopDrawdownDateParamName = "Дата просадки";

        /// <summary>
        /// Кнопка «Заполнить сумму портфеля»: база и фейковая сумма (одинаково), фейковый режим=выкл., дата.
        /// </summary>
        private const string FillPortfolioStopBaselineButtonName = "Заполнить сумму портфеля";
        private const string EnablePortfolioStopsAndRecoveryButtonName = "Включить стопы и возобновление";
        private const string DisablePortfolioStopsAndRecoveryButtonName = "Отключить стопы и восстановление";

        private const string CalculationsCalculateButtonName = "Рассчитать";
        private const string CalculationsStartDatePlaceholder = "01.01.2500";
        private const string CalculationsTargetAnnualPercentParamName = "Целевой процент годовых";
        private const string CalculationsInitialPortfolioAmountParamName = "Начальная сумма портфеля";
        private const string CalculationsStartDateParamName = "Дата начала расчётов";
        private const string CalculationsCurrentPortfolioAmountParamName = "Текущая сумма портфеля";
        private const string CalculationsAccumulatedTargetAmountParamName = "Накопленная целевая сумма";
        private const string CalculationsAccumulatedTargetWithCapitalizationParamName =
            "Накопленная целевая сумма с капитализацией";

        private const string PortfolioStopLossEnableParamName = "Stop loss портфеля (просадка от базы)";
        private const string PortfolioTakeProfitEnableParamName = "Take profit портфеля (рост от базы)";
        private const string ResumeTradingWhenFakeExceedsBaselineParamName =
            "Возобновлять торги при достижении предыдущего реального значения";
        /// <summary>
        /// Подписка на кнопки вкладки «Стопы» (объекты из Parameters — те же, что в окне настроек).
        /// </summary>
        private void WireStopsTabButtons()
        {
            WireStopsTabButton(
                FillPortfolioStopBaselineButtonName,
                FillPortfolioStopBaselineButton_UserClickOnButtonEvent);
            WireStopsTabButton(
                EnablePortfolioStopsAndRecoveryButtonName,
                EnablePortfolioStopsAndRecoveryButton_UserClickOnButtonEvent);
            WireStopsTabButton(
                DisablePortfolioStopsAndRecoveryButtonName,
                DisablePortfolioStopsAndRecoveryButton_UserClickOnButtonEvent);
        }

        private void WireStopsTabButton(string buttonName, Action handler)
        {
            WireParameterTabButton(buttonName, handler);
        }

        /// <summary>
        /// Подписка на кнопки вкладки «Расчёты».
        /// </summary>
        private void WireCalculationsTabButtons()
        {
            WireParameterTabButton(
                CalculationsCalculateButtonName,
                CalculationsCalculateButton_UserClickOnButtonEvent);
        }

        private void WireParameterTabButton(string buttonName, Action handler)
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

        private void CalculationsCalculateButton_UserClickOnButtonEvent()
        {
            try
            {
                TryApplyCalculations(CalculationsCalculateButtonName, logButtonPress: true);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        /// <summary>
        /// Кнопка «Рассчитать»: текущий портфель и целевые суммы от начальной суммы, даты и % годовых.
        /// </summary>
        private bool TryApplyCalculations(string invokedByButtonName, bool logButtonPress)
        {
            if (logButtonPress && !string.IsNullOrWhiteSpace(invokedByButtonName))
            {
                SendNewLogMessage(
                    NameStrategyUniq + " | Расчёты: нажата «" + invokedByButtonName + "»…",
                    LogMessageType.User);
            }

            decimal initialAmount = _calculationsInitialPortfolioAmount?.ValueDecimal ?? 0m;
            BotTabSimple tab = TryGetPortfolioMonitoringReferenceTab();
            DateTime referenceTime = ResolvePortfolioMonitoringReferenceTime(tab);

            if (initialAmount <= 0m
                || !TryParseCalculationsStartDate(tab, referenceTime, out DateTime startDate))
            {
                SendNewLogMessage(
                    NameStrategyUniq
                    + " | Расчёты: заполните начальную сумму портфеля (> 0) и дату начала расчётов "
                    + "(формат dd.MM.yyyy, не "
                    + CalculationsStartDatePlaceholder
                    + ").",
                    LogMessageType.Error);
                SendNewLogMessage(
                    NameStrategyUniq
                    + " | Расчёты: заполните начальную сумму портфеля (> 0) и дату начала расчётов "
                    + "(формат dd.MM.yyyy, не "
                    + CalculationsStartDatePlaceholder
                    + ").",
                    LogMessageType.User);
                return false;
            }

            DateTime endDate = GetCalendarDateForTimeOnly(tab, referenceTime);
            double elapsedDays = Math.Max(0d, (endDate - startDate).TotalDays);
            double elapsedYears = elapsedDays / 365d;

            decimal annualPercent = _calculationsTargetAnnualPercent?.ValueDecimal ?? 0m;
            decimal rateFraction = annualPercent / 100m;
            decimal targetSimple = initialAmount * (1m + rateFraction * (decimal)elapsedYears);
            double compoundFactor = Math.Pow(1d + (double)rateFraction, elapsedYears);
            decimal targetWithCapitalization = initialAmount * (decimal)compoundFactor;

            targetSimple = Math.Round(targetSimple, 2, MidpointRounding.AwayFromZero);
            targetWithCapitalization = Math.Round(targetWithCapitalization, 2, MidpointRounding.AwayFromZero);

            decimal? currentPortfolio = TryGetPortfolioValueForStopsBaselineFill(tab);
            decimal currentAmount = currentPortfolio ?? 0m;
            currentAmount = Math.Round(currentAmount, 2, MidpointRounding.AwayFromZero);

            SetStrategyParameterDecimalValue(_calculationsCurrentPortfolioAmount, currentAmount, silent: false);
            SetStrategyParameterDecimalValue(_calculationsAccumulatedTargetAmount, targetSimple, silent: false);
            SetStrategyParameterDecimalValue(
                _calculationsAccumulatedTargetWithCapitalization,
                targetWithCapitalization,
                silent: false);

            SaveParametersIgnoringRecentLoadCooldown();
            RequestParameterGuiRepaintOnce();

            string msg =
                NameStrategyUniq
                + " | Расчёты: «"
                + (string.IsNullOrWhiteSpace(invokedByButtonName)
                    ? CalculationsCalculateButtonName
                    : invokedByButtonName)
                + "» — начало "
                + FormatPortfolioStopDate(startDate)
                + ", текущая дата "
                + FormatPortfolioStopDate(endDate)
                + ", дней "
                + elapsedDays.ToString("0", CultureInfo.InvariantCulture)
                + ", % годовых "
                + annualPercent.ToString(CultureInfo.InvariantCulture)
                + ", текущий портфель "
                + currentAmount.ToString(CultureInfo.InvariantCulture)
                + ", цель "
                + targetSimple.ToString(CultureInfo.InvariantCulture)
                + ", цель с капитализацией "
                + targetWithCapitalization.ToString(CultureInfo.InvariantCulture)
                + ".";

            if (!currentPortfolio.HasValue || currentPortfolio.Value <= 0m)
            {
                string modeHint = ShouldReadPortfolioFromTesterServer(tab)
                    ? "тестер (Portfolio сервера тестера: Initial deposit / начальный депозит > 0)"
                    : (_screenerTab?.EmulatorIsOn == true ? "фейк" : "лайв");
                msg += " Текущая сумма портфеля не получена (" + modeHint + ").";
            }

            SendNewLogMessage(msg, LogMessageType.System);
            SendNewLogMessage(msg, LogMessageType.User);
            return true;
        }

        private bool TryParseCalculationsStartDate(BotTabSimple tab, DateTime candleTime, out DateTime parsedDate)
        {
            parsedDate = DateTime.MinValue;
            if (_calculationsStartDate == null
                || string.IsNullOrWhiteSpace(_calculationsStartDate.ValueString))
            {
                return false;
            }

            string raw = _calculationsStartDate.ValueString.Trim();
            if (string.Equals(raw, CalculationsStartDatePlaceholder, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            if (!TryParseFlexibleDateTime(tab, candleTime, raw, out DateTime parsed))
            {
                return false;
            }

            parsedDate = parsed.Date;
            if (parsedDate.Year >= 2500)
            {
                return false;
            }

            return true;
        }

        private void EnablePortfolioStopsAndRecoveryButton_UserClickOnButtonEvent()
        {
            try
            {
                // Сначала база/фейк/пик (как «Заполнить сумму портфеля»), затем вкл. флагов — иначе фейковая сумма могла не попасть в UI.
                bool portfolioFilled = TryApplyFillPortfolioStopBaseline(
                    EnablePortfolioStopsAndRecoveryButtonName,
                    logButtonPress: false);
                ApplyPortfolioStopsAndRecoveryPreset(enabled: true);
                ApplyFakePortfolioAmountFromStopsFill(force: true, refreshParameterGui: true);

                string msg =
                    NameStrategyUniq
                    + " | Стопы: включены stop loss, take profit, возобновление торгов.";
                if (portfolioFilled)
                {
                    msg += " Заполнены база, фейковая сумма, пик и дата (как «Заполнить сумму портфеля»).";
                }
                else
                {
                    msg += " Сумму портфеля заполнить не удалось — см. сообщение об ошибке выше.";
                }

                SendNewLogMessage(msg, LogMessageType.User);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        private void DisablePortfolioStopsAndRecoveryButton_UserClickOnButtonEvent()
        {
            try
            {
                ApplyPortfolioStopsAndRecoveryPreset(enabled: false);
                SendNewLogMessage(
                    NameStrategyUniq
                    + " | Стопы: выключены stop loss, take profit, возобновление торгов.",
                    LogMessageType.User);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        private void ApplyPortfolioStopsAndRecoveryPreset(bool enabled)
        {
            SetStrategyParameterBoolValue(_usePortfolioStop, enabled);
            SetStrategyParameterBoolValue(
                ResolveStrategyParameterBool(PortfolioStopLossEnableParamName),
                enabled);
            SetStrategyParameterBoolValue(_usePortfolioTakeProfit, enabled);
            SetStrategyParameterBoolValue(
                ResolveStrategyParameterBool(PortfolioTakeProfitEnableParamName),
                enabled);
            SetStrategyParameterBoolValue(_resumeTradingWhenFakeExceedsDrawdownBaseline, enabled);
            SetStrategyParameterBoolValue(
                ResolveStrategyParameterBool(ResumeTradingWhenFakeExceedsBaselineParamName),
                enabled);

            if (enabled)
            {
                ApplyFakePortfolioAmountFromStopsFill(force: true, refreshParameterGui: false);
            }

            SaveParametersIgnoringRecentLoadCooldown();
            RequestParameterGuiRepaintOnce();
        }

        /// <summary>
        /// Фейковая сумма = тот же источник, что «Заполнить сумму портфеля» (база или реал./тест).
        /// </summary>
        private void ApplyFakePortfolioAmountFromStopsFill(bool force = false, bool refreshParameterGui = false)
        {
            if (!force)
            {
                decimal currentFake = GetFakePortfolioAmount();
                if (currentFake > 0m)
                {
                    return;
                }
            }

            BotTabSimple tab = TryGetPortfolioMonitoringReferenceTab();
            decimal? value = TryGetPortfolioValueForStopsBaselineFill(tab);
            if (!value.HasValue || value.Value <= 0m)
            {
                StrategyParameterDecimal baselineParam = ResolvePortfolioStopBaselineParameter();
                if (baselineParam != null && baselineParam.ValueDecimal > 0m)
                {
                    value = baselineParam.ValueDecimal;
                }
            }

            if (!value.HasValue || value.Value <= 0m)
            {
                return;
            }

            SetFakePortfolioAmount(value.Value, refreshParameterGui, silent: false);
        }

        private StrategyParameterBool ResolveStrategyParameterBool(string paramName)
        {
            IIStrategyParameter fromList = Parameters?.Find(p => p.Name == paramName);
            return fromList as StrategyParameterBool;
        }

        private static void SetStrategyParameterBoolValue(StrategyParameterBool param, bool value)
        {
            if (param == null)
            {
                return;
            }

            param.ValueBool = value;
        }

        private void FillPortfolioStopBaselineButton_UserClickOnButtonEvent()
        {
            try
            {
                TryApplyFillPortfolioStopBaseline(FillPortfolioStopBaselineButtonName, logButtonPress: true);
            }
            catch (Exception ex)
            {
                SendNewLogMessage(ex.ToString(), LogMessageType.Error);
            }
        }

        /// <summary>
        /// Логика «Заполнить сумму портфеля»: база, фейковая сумма, пик, дата, выкл. фейковый режим 1.
        /// </summary>
        /// <returns>true, если сумма портфеля получена и записана.</returns>
        private bool TryApplyFillPortfolioStopBaseline(string invokedByButtonName, bool logButtonPress)
        {
            if (logButtonPress && !string.IsNullOrWhiteSpace(invokedByButtonName))
            {
                SendNewLogMessage(
                    NameStrategyUniq + " | Стопы: нажата «" + invokedByButtonName + "»…",
                    LogMessageType.User);
            }

            BotTabSimple tab = TryGetPortfolioMonitoringReferenceTab();
            DateTime referenceTime = ResolvePortfolioMonitoringReferenceTime(tab);
            DateTime currentDate = GetCalendarDateForTimeOnly(tab, referenceTime);

            decimal? value = TryGetPortfolioValueForStopsBaselineFill(tab);
            if (value.HasValue && value.Value > 0m)
            {
                decimal baselineToSet = value.Value;
                if (_usePortfolioTakeProfit.ValueBool && _portfolioTakeProfitPercent.ValueDecimal > 0m)
                {
                    decimal? currentPortfolio = TryGetPortfolioValueForStopsBaselineFill(tab);

                    if (currentPortfolio.HasValue && currentPortfolio.Value > 0m)
                    {
                        decimal ceiling = baselineToSet
                            * (1m + _portfolioTakeProfitPercent.ValueDecimal / 100m);
                        if (currentPortfolio.Value >= ceiling)
                        {
                            baselineToSet = currentPortfolio.Value;
                            SendNewLogMessage(
                                NameStrategyUniq
                                + " | Стопы: база поднята до текущего портфеля "
                                + baselineToSet.ToString(CultureInfo.InvariantCulture)
                                + " — иначе take profit сработал бы сразу (портфель уже выше порога).",
                                LogMessageType.User);
                        }
                    }
                }

                ApplyPortfolioStopFieldsToParameters(baselineToSet, currentDate, setAmount: true, silentDecimals: false);
                SetFakePortfolioAmount(baselineToSet, refreshParameterGui: false, silent: false);
                SetPortfolioPeakValue(baselineToSet, silent: false);
                SetFakeMode(false, refreshParameterGui: false, syncPortfolioAmountFromReal: false);
                _portfolioTakeProfitNeedsPullback = false;
                SaveParametersIgnoringRecentLoadCooldown();
                RequestParameterGuiRepaintOnce();

                string actionLabel = string.IsNullOrWhiteSpace(invokedByButtonName)
                    ? "Заполнить сумму портфеля"
                    : invokedByButtonName;
                string msg =
                    NameStrategyUniq
                    + " | Стопы: «"
                    + actionLabel
                    + "» — база "
                    + baselineToSet.ToString(CultureInfo.InvariantCulture)
                    + ", фейковая сумма "
                    + baselineToSet.ToString(CultureInfo.InvariantCulture)
                    + ", пик "
                    + baselineToSet.ToString(CultureInfo.InvariantCulture)
                    + ", фейковый режим=выкл., дата "
                    + FormatPortfolioStopDate(currentDate);
                SendNewLogMessage(msg, LogMessageType.System);
                SendNewLogMessage(msg, LogMessageType.User);
                return true;
            }

            ApplyPortfolioStopFieldsToParameters(0m, currentDate, setAmount: false, silentDecimals: false);
            SetPortfolioPeakValue(0m, silent: false);
            SaveParametersIgnoringRecentLoadCooldown();
            RequestParameterGuiRepaintOnce();

            string modeHint = ShouldReadPortfolioFromTesterServer(tab)
                ? "тестер (Portfolio сервера тестера: Initial deposit / начальный депозит > 0)"
                : (_screenerTab?.EmulatorIsOn == true ? "фейк" : "лайв");
            string failLabel = string.IsNullOrWhiteSpace(invokedByButtonName)
                ? FillPortfolioStopBaselineButtonName
                : invokedByButtonName;
            SendNewLogMessage(
                NameStrategyUniq
                + " | Стопы: «"
                + failLabel
                + "» — дата просадки="
                + FormatPortfolioStopDate(currentDate)
                + ", но сумма портфеля не получена ("
                + modeHint
                + ").",
                LogMessageType.Error);
            return false;
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
            _lastPortfolioStopDecisionTime = DateTime.MinValue;
            _portfolioTakeProfitNeedsPullback = false;
            MaybeSaveShadowVirtualPositions(force: true);
            _regime.ValueString = "Off";

            string full = NameStrategyUniq
                + ": «Остановить робота и продать всё» — отправлено закрытие всех позиций по рынку, Regime=Off.";
            SendNewLogMessage(full, LogMessageType.System);
            SendNewLogMessage(full, LogMessageType.User);
        }

        /// <summary>
        /// Закрыть все открытые позиции робота на вкладках скринера (экстренно, не зависит от «Тип заявок»).
        /// </summary>
        private void CloseAllBotPositions()
        {
            if (_screenerTab?.Tabs == null)
            {
                return;
            }

            string botType = GetNameStrategyType();
            int closeAttempts = 0;
            int skippedNotOurBot = 0;

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

                    if (!IsOurBotPosition(pos))
                    {
                        skippedNotOurBot++;
                        continue;
                    }

                    if (TryExecuteEmergencyClosePosition(tab, pos))
                    {
                        closeAttempts++;
                    }
                }
            }

            if (closeAttempts > 0)
            {
                SendNewLogMessage(
                    NameStrategyUniq + ": экстренное закрытие — позиций: " + closeAttempts + ".",
                    LogMessageType.System);
            }
            else
            {
                SendNewLogMessage(
                    NameStrategyUniq + ": экстренное закрытие — открытых позиций робота не найдено"
                    + (skippedNotOurBot > 0 ? " (пропущено чужих: " + skippedNotOurBot + ")." : "."),
                    LogMessageType.System);
            }
        }

        /// <summary>
        /// Fake/эмулятор — OrderFakeExecute (без проверки IsReadyToTrade); лайв — CloseAtMarket; иначе агрессивный лимит.
        /// </summary>
        private bool TryExecuteEmergencyClosePosition(BotTabSimple tab, Position pos)
        {
            if (tab == null || pos == null || pos.OpenVolume <= 0m)
            {
                return false;
            }

            string security = tab.Connector?.SecurityName ?? tab.TabName ?? "?";
            pos.SignalTypeClose = SignalStopRobotAndSellAll;
            pos.ProfitOrderIsActive = false;
            pos.StopOrderIsActive = false;

            decimal volume = pos.OpenVolume;

            if (TabUsesFakeExecution(tab, pos))
            {
                decimal price = GetEmergencyClosePrice(tab, pos);
                if (price <= 0m)
                {
                    SendNewLogMessage(
                        NameStrategyUniq + " [" + security + "]: fake-закрытие #"
                        + pos.Number + " — нет цены (Bid/Ask/свеча).",
                        LogMessageType.Error);
                    return false;
                }

                DateTime time = tab.TimeServerCurrent;
                if (time == DateTime.MinValue)
                {
                    time = DateTime.Now;
                }

                string fakeCloseFailReason;
                if (!TryExecuteFakeEmergencyClose(tab, pos, volume, price, time, out fakeCloseFailReason))
                {
                    SendNewLogMessage(
                        NameStrategyUniq + " [" + security + "]: fake-закрытие #"
                        + pos.Number + " — " + (fakeCloseFailReason ?? "не удалось создать заявку."),
                        LogMessageType.Error);
                    return false;
                }

                SendNewLogMessage(
                    NameStrategyUniq + " [" + security + "]: fake-закрытие #"
                    + pos.Number + " " + pos.Direction + " vol=" + volume.ToString(CultureInfo.InvariantCulture)
                    + " @ " + price.ToString(CultureInfo.InvariantCulture),
                    LogMessageType.System);
                return true;
            }

            if (tab.Connector != null
                && (!tab.Connector.IsConnected || !tab.Connector.IsReadyToTrade))
            {
                SendNewLogMessage(
                    NameStrategyUniq + " [" + security + "]: закрытие позиции #"
                    + pos.Number + " — нет подключения или торговля недоступна.",
                    LogMessageType.Error);
                return false;
            }

            if (tab.Connector?.MarketOrdersIsSupport == true)
            {
                tab.CloseAtMarket(pos, volume, SignalStopRobotAndSellAll);
                SendNewLogMessage(
                    NameStrategyUniq + " [" + security + "]: закрытие по рынку #"
                    + pos.Number + " vol=" + volume.ToString(CultureInfo.InvariantCulture),
                    LogMessageType.System);
                return true;
            }

            decimal limitPrice = GetEmergencyClosePrice(tab, pos);
            if (limitPrice <= 0m)
            {
                SendNewLogMessage(
                    NameStrategyUniq + " [" + security + "]: лимит-закрытие #"
                    + pos.Number + " — нет цены.",
                    LogMessageType.Error);
                return false;
            }

            tab.CloseAtLimit(pos, limitPrice, volume, SignalStopRobotAndSellAll);
            SendNewLogMessage(
                NameStrategyUniq + " [" + security + "]: агрессивный лимит #"
                + pos.Number + " @ " + limitPrice.ToString(CultureInfo.InvariantCulture),
                LogMessageType.System);
            return true;
        }

        /// <summary>
        /// Fake-закрытие без проверки IsConnected/IsReadyToTrade (CloseAtFake в ядре их требует).
        /// </summary>
        private bool TryExecuteFakeEmergencyClose(
            BotTabSimple tab, Position pos, decimal volume, decimal price, DateTime time, out string failReason)
        {
            failReason = null;

            if (tab == null || pos == null || volume <= 0m)
            {
                failReason = "нет вкладки, позиции или объёма";
                return false;
            }

            Security security = ResolveEmergencyTabSecurity(tab, pos);
            if (security == null)
            {
                failReason = "инструмент (Security) недоступен на вкладке";
                return false;
            }

            if (tab._dealCreator == null)
            {
                tab._dealCreator = new PositionCreator();
            }

            pos.ProfitOrderIsActive = false;
            pos.StopOrderIsActive = false;

            if (tab.Connector != null
                && tab.Connector.IsConnected
                && tab.Connector.IsReadyToTrade)
            {
                for (int i = 0; pos.CloseOrders != null && i < pos.CloseOrders.Count; i++)
                {
                    if (pos.CloseOrders[i].State == OrderStateType.Active)
                    {
                        tab.Connector.OrderCancel(pos.CloseOrders[i]);
                    }
                }

                for (int i = 0; pos.OpenOrders != null && i < pos.OpenOrders.Count; i++)
                {
                    if (pos.OpenOrders[i].State == OrderStateType.Active)
                    {
                        tab.Connector.OrderCancel(pos.OpenOrders[i]);
                    }
                }
            }

            Side sideCloseOrder = pos.Direction == Side.Buy ? Side.Sell : Side.Buy;

            try
            {
                price = tab.RoundPrice(price, security, sideCloseOrder);
            }
            catch
            {
                // RoundPrice в ядре использует tab.Security; при его отсутствии оставляем цену как есть
            }

            if (pos.State == PositionStateType.Done && pos.OpenVolume == 0m)
            {
                failReason = "позиция уже закрыта";
                return false;
            }

            pos.State = PositionStateType.Closing;

            OrderTypeTime orderTypeTime = tab.ManualPositionSupport?.OrderTypeTime ?? OrderTypeTime.Specified;
            bool limitsMakerOnly = tab.ManualPositionSupport?.LimitsMakerOnly ?? false;

            Order closeOrder = tab._dealCreator.CreateCloseOrderForDeal(
                security,
                pos,
                price,
                OrderPriceType.Limit,
                new TimeSpan(1, 1, 1, 1),
                tab.StartProgram,
                orderTypeTime,
                tab.Connector?.ServerFullName ?? string.Empty,
                limitsMakerOnly);

            if (closeOrder == null)
            {
                failReason = "CreateCloseOrderForDeal вернул null (объём позиции 0?)";
                return false;
            }

            closeOrder.SecurityNameCode = pos.SecurityName ?? security.Name;
            closeOrder.SecurityClassCode = !string.IsNullOrWhiteSpace(security.NameClass)
                ? security.NameClass
                : (tab.Connector?.SecurityClass ?? string.Empty);
            closeOrder.PortfolioNumber = pos.PortfolioName;

            if (volume < pos.OpenVolume && closeOrder.Volume != volume)
            {
                closeOrder.Volume = volume;
            }

            pos.AddNewCloseOrder(closeOrder);
            tab.OrderFakeExecute(closeOrder, time);
            return true;
        }

        /// <summary>
        /// Восстановить Security для экстренного fake-закрытия, когда tab.Security == null (коннектор не готов).
        /// </summary>
        private Security ResolveEmergencyTabSecurity(BotTabSimple tab, Position pos)
        {
            if (tab == null)
            {
                return null;
            }

            Security security = tab.Security;
            if (security != null)
            {
                return security;
            }

            security = tab.Connector?.Security;
            if (security != null)
            {
                tab.Security = security;
                return security;
            }

            string secName = pos?.SecurityName ?? tab.Connector?.SecurityName ?? tab.TabName;
            string secClass = tab.Connector?.SecurityClass;

            if (string.IsNullOrWhiteSpace(secClass))
            {
                secClass = TryGetSecurityClassFromPosition(pos);
            }

            if (string.IsNullOrWhiteSpace(secClass) && _screenerTab?.SecuritiesNames != null)
            {
                for (int i = 0; i < _screenerTab.SecuritiesNames.Count; i++)
                {
                    ActivatedSecurity act = _screenerTab.SecuritiesNames[i];
                    if (act == null || string.IsNullOrWhiteSpace(act.SecurityName))
                    {
                        continue;
                    }

                    if (string.Equals(act.SecurityName, secName, StringComparison.OrdinalIgnoreCase))
                    {
                        secClass = act.SecurityClass;
                        break;
                    }
                }
            }

            IServer server = tab.Connector?.MyServer;
            if (server != null && !string.IsNullOrWhiteSpace(secName))
            {
                security = server.GetSecurityForName(secName, secClass ?? string.Empty);
                if (security != null)
                {
                    tab.Security = security;
                    return security;
                }

                if (server.Securities != null)
                {
                    for (int i = 0; i < server.Securities.Count; i++)
                    {
                        Security candidate = server.Securities[i];
                        if (candidate == null || string.IsNullOrWhiteSpace(candidate.Name))
                        {
                            continue;
                        }

                        if (!string.Equals(candidate.Name, secName, StringComparison.OrdinalIgnoreCase))
                        {
                            continue;
                        }

                        tab.Security = candidate;
                        return candidate;
                    }
                }
            }

            if (string.IsNullOrWhiteSpace(secName))
            {
                return null;
            }

            security = new Security
            {
                Name = secName,
                NameClass = secClass ?? string.Empty,
                PriceStep = 0m
            };

            tab.Security = security;
            return security;
        }

        private static string TryGetSecurityClassFromPosition(Position pos)
        {
            if (pos?.OpenOrders != null)
            {
                for (int i = 0; i < pos.OpenOrders.Count; i++)
                {
                    Order order = pos.OpenOrders[i];
                    if (!string.IsNullOrWhiteSpace(order?.SecurityClassCode))
                    {
                        return order.SecurityClassCode;
                    }
                }
            }

            if (pos?.CloseOrders != null)
            {
                for (int i = 0; i < pos.CloseOrders.Count; i++)
                {
                    Order order = pos.CloseOrders[i];
                    if (!string.IsNullOrWhiteSpace(order?.SecurityClassCode))
                    {
                        return order.SecurityClassCode;
                    }
                }
            }

            return null;
        }

        private bool TabUsesFakeExecution(BotTabSimple tab, Position pos)
        {
            if (_screenerTab?.EmulatorIsOn == true)
            {
                return true;
            }

            if (tab?.EmulatorIsOn == true || tab?.Connector?.EmulatorIsOn == true)
            {
                return true;
            }

            if (pos?.SecurityName != null
                && pos.SecurityName.EndsWith(" TestPaper", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            if (pos?.OpenOrders != null && pos.OpenOrders.Count > 0)
            {
                Order openOrder = pos.OpenOrders[0];
                if (openOrder?.SecurityNameCode != null
                    && openOrder.SecurityNameCode.EndsWith(" TestPaper", StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }

            return false;
        }

        private decimal GetEmergencyClosePrice(BotTabSimple tab, Position pos)
        {
            decimal slip = _slippage.ValueInt * (tab.Security?.PriceStep ?? 0m);

            if (pos.Direction == Side.Buy)
            {
                if (tab.PriceBestBid > 0m)
                {
                    return ApplyRandomPriceShift(tab.PriceBestBid - slip, tab);
                }
            }
            else
            {
                if (tab.PriceBestAsk > 0m)
                {
                    return ApplyRandomPriceShift(tab.PriceBestAsk + slip, tab);
                }
            }

            if (tab.CandlesAll != null && tab.CandlesAll.Count > 0)
            {
                return GetCloseLimitPrice(tab, pos, slip);
            }

            if (pos.EntryPrice > 0m)
            {
                return pos.EntryPrice;
            }

            return 0m;
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
            if (IsRealTradingBlockedByFakeMode())
            {
                ApplyFakePortfolioOpen(tab, Side.Buy, volume, limitPrice);
                LogFakeModeBlocksRealOrderOnce();
                return;
            }

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
            if (IsRealTradingBlockedByFakeMode())
            {
                ApplyFakePortfolioOpen(tab, Side.Sell, volume, limitPrice);
                LogFakeModeBlocksRealOrderOnce();
                return;
            }

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

            if (IsRealTradingBlockedByFakeMode())
            {
                if (TryGetFakeVirtualPosition(tab, out FakePortfolioVirtualPosition virtualPosition))
                {
                    ApplyFakePortfolioClose(tab, virtualPosition, limitPrice);
                }

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

        private void SaveParametersIgnoringRecentLoadCooldown()
        {
            if (LastParamLoadTimeField != null)
            {
                LastParamLoadTimeField.SetValue(this, DateTime.MinValue);
            }

            SaveParameters();
        }

        private StrategyParameterDecimal ResolvePortfolioStopBaselineParameter()
        {
            IIStrategyParameter fromList = Parameters?.Find(p => p.Name == PortfolioStopBaselineAmountParamName);
            return (fromList as StrategyParameterDecimal) ?? _portfolioStopBaselineAmount;
        }

        private StrategyParameterString ResolvePortfolioStopDrawdownDateParameter()
        {
            IIStrategyParameter fromList = Parameters?.Find(p => p.Name == PortfolioStopDrawdownDateParamName);
            return (fromList as StrategyParameterString) ?? _portfolioStopDrawdownDate;
        }

        /// <summary>
        /// Полная сумма портфеля (ValueCurrent/ValueBegin), без подстановки rub/борда — для стопов в тестере.
        /// </summary>
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

        /// <summary>
        /// Запись в параметры вкладки «Стопы» (объекты из Parameters — те же, что в окне настроек).
        /// </summary>
        private void ApplyPortfolioStopFieldsToParameters(
            decimal baseline,
            DateTime decisionDate,
            bool setAmount,
            bool silentDecimals = false)
        {
            if (decisionDate != DateTime.MinValue)
            {
                string dateStr = FormatPortfolioStopDate(decisionDate);
                if (_portfolioStopDrawdownDate != null)
                {
                    _portfolioStopDrawdownDate.ValueString = dateStr;
                }

                StrategyParameterString dateParam = ResolvePortfolioStopDrawdownDateParameter();
                if (dateParam != null)
                {
                    dateParam.ValueString = dateStr;
                }
            }

            if (!setAmount || baseline <= 0m)
            {
                return;
            }

            SetStrategyParameterDecimalValue(_portfolioStopBaselineAmount, baseline, silentDecimals);
            SetStrategyParameterDecimalValue(ResolvePortfolioStopBaselineParameter(), baseline, silentDecimals);
        }

        private static void SetStrategyParameterDecimalValue(
            StrategyParameterDecimal param,
            decimal value,
            bool silent)
        {
            if (param == null)
            {
                return;
            }

            if (silent && SilentParameterDecimalValueField != null)
            {
                if (param.ValueDecimal == value)
                {
                    return;
                }

                SilentParameterDecimalValueField.SetValue(param, value);
                return;
            }

            param.ValueDecimal = value;
        }

        /// <summary>
        /// Тестер: IsTester, коннектор Tester на вкладке или сервер Tester в ServerMaster.
        /// </summary>
        private bool ShouldReadPortfolioFromTesterServer(BotTabSimple tab = null)
        {
            if (ShouldUseMoexTesterConnector())
            {
                return true;
            }

            if (tab?.Connector?.ServerType == ServerType.Tester)
            {
                return true;
            }

            if (_screenerTab?.Tabs != null)
            {
                for (int i = 0; i < _screenerTab.Tabs.Count; i++)
                {
                    if (_screenerTab.Tabs[i]?.Connector?.ServerType == ServerType.Tester)
                    {
                        return true;
                    }
                }
            }

            return FindTesterLikeServer() != null;
        }

        /// <summary>
        /// Сумма для кнопки «Заполнить сумму портфеля»: в тестере — GodMode/StartPortfolio, иначе monitored equity.
        /// </summary>
        private decimal? TryGetPortfolioValueForStopsBaselineFill(BotTabSimple tab)
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
                if (fromConnector.HasValue)
                {
                    return fromConnector;
                }
            }

            // Для заполнения базы/фейковой суммы — сначала реальный/тестовый портфель, не симуляция фейка.
            decimal? realMonitored = TryGetRealMonitoredPortfolioValue(tab);
            if (realMonitored.HasValue && realMonitored.Value > 0m)
            {
                return realMonitored;
            }

            if (IsRealTradingBlockedByFakeMode())
            {
                decimal? fakeEquity = TryGetFakePortfolioEffectiveEquity(tab);
                if (fakeEquity.HasValue && fakeEquity.Value > 0m)
                {
                    return fakeEquity;
                }
            }

            decimal? testerFallback = TryGetTesterPortfolioEquity(tab);
            if (testerFallback.HasValue && testerFallback.Value > 0m)
            {
                return testerFallback;
            }

            return TryGetEquityFromLatestBotPosition(tab);
        }

        /// <summary>
        /// Обновить таблицу параметров, если окно открыто (без PaintTable из потока тестера — иначе падение DataGridView).
        /// </summary>
        private void RefreshPortfolioStopParameterDialog()
        {
            if (!ParamGuiIsOpen)
            {
                return;
            }

            RepaintParameterGuiTables();
        }

        private StrategyParameterBool ResolveFakeModeParameter()
        {
            IIStrategyParameter fromList = Parameters?.Find(p => p.Name == FakeModeParamName);
            return (fromList as StrategyParameterBool) ?? _fakeMode;
        }

        private bool IsRealTradingBlockedByFakeMode()
        {
            StrategyParameterBool fakeModeParam = ResolveFakeModeParameter();
            return fakeModeParam != null && fakeModeParam.ValueBool;
        }

        private void SetFakeMode(
            bool enabled,
            decimal recoveryTargetAmount = 0m,
            bool refreshParameterGui = false,
            bool syncPortfolioAmountFromReal = true)
        {
            bool wasFake = IsRealTradingBlockedByFakeMode();

            if (_fakeMode != null)
            {
                _fakeMode.ValueBool = enabled;
            }

            StrategyParameterBool fakeModeParam = ResolveFakeModeParameter();
            if (fakeModeParam != null)
            {
                fakeModeParam.ValueBool = enabled;
            }

            BotTabSimple tab = TryGetPortfolioMonitoringReferenceTab();
            if (enabled)
            {
                decimal newTarget = ResolveFakeModeRecoveryTarget(recoveryTargetAmount, tab);
                if (!wasFake)
                {
                    _fakeModeRecoveryTargetAmount = newTarget;
                }
                else if (newTarget > _fakeModeRecoveryTargetAmount)
                {
                    _fakeModeRecoveryTargetAmount = newTarget;
                }

                if (_fakeModeRecoveryTargetAmount > 0m)
                {
                    SendNewLogMessage(
                        NameStrategyUniq + " | Стопы: фейковый режим вкл., цель возобновления реальной торговли="
                        + _fakeModeRecoveryTargetAmount.ToString(CultureInfo.InvariantCulture),
                        LogMessageType.System);
                }

                if (syncPortfolioAmountFromReal)
                {
                    SyncFakePortfolioAmountFromRealPortfolio(tab, refreshParameterGui: false);
                    EnsureFakePortfolioAmountAlignedWithReal(tab, refreshParameterGui: false);
                }
            }
            else
            {
                _fakeModeRecoveryTargetAmount = 0m;
                _fakePortfolioVirtualPositions.Clear();
                // When we exit fake execution, keep shadow portfolio (it mirrors real trading).
                if (syncPortfolioAmountFromReal)
                {
                    SyncFakePortfolioAmountFromRealPortfolio(tab, refreshParameterGui: false);
                }

                _loggedFakeModeBlocksRealOrders = false;
            }

            if (refreshParameterGui)
            {
                RefreshPortfolioStopParameterDialog();
            }
        }

        private decimal ResolveFakeModeRecoveryTarget(decimal explicitTarget, BotTabSimple tab)
        {
            if (explicitTarget > 0m)
            {
                return explicitTarget;
            }

            StrategyParameterDecimal baselineParam = ResolvePortfolioStopBaselineParameter();
            decimal baseline = baselineParam?.ValueDecimal ?? 0m;
            if (baseline > 0m)
            {
                return baseline;
            }

            decimal? realPortfolio = TryGetRealMonitoredPortfolioValue(tab);
            if (realPortfolio.HasValue && realPortfolio.Value > 0m)
            {
                return realPortfolio.Value;
            }

            decimal fakeAmount = GetFakePortfolioAmount();
            return fakeAmount > 0m ? fakeAmount : 0m;
        }

        private void EnsureFakeModeRecoveryTargetInitialized(BotTabSimple tab)
        {
            if (!IsRealTradingBlockedByFakeMode() || _fakeModeRecoveryTargetAmount > 0m)
            {
                return;
            }

            _fakeModeRecoveryTargetAmount = ResolveFakeModeRecoveryTarget(0m, tab);
            if (_fakeModeRecoveryTargetAmount > 0m)
            {
                SendNewLogMessage(
                    NameStrategyUniq + " | Стопы: цель возобновления реальной торговли="
                    + _fakeModeRecoveryTargetAmount.ToString(CultureInfo.InvariantCulture)
                    + " (фейковый режим включён вручную)",
                    LogMessageType.System);
            }
        }

        private StrategyParameterDecimal ResolveFakePortfolioAmountParameter()
        {
            IIStrategyParameter fromList = Parameters?.Find(p => p.Name == FakePortfolioAmountParamName);
            return (fromList as StrategyParameterDecimal) ?? _fakePortfolioAmount;
        }

        private decimal GetFakePortfolioAmount()
        {
            StrategyParameterDecimal amountParam = ResolveFakePortfolioAmountParameter();
            return amountParam?.ValueDecimal ?? 0m;
        }

        private void SetFakePortfolioAmount(decimal amount, bool refreshParameterGui = false, bool silent = false)
        {
            if (amount < 0m)
            {
                amount = 0m;
            }

            SetStrategyParameterDecimalValue(_fakePortfolioAmount, amount, silent);
            SetStrategyParameterDecimalValue(ResolveFakePortfolioAmountParameter(), amount, silent);

            if (refreshParameterGui)
            {
                RefreshPortfolioStopParameterDialog();
            }
        }

        private void SyncFakePortfolioAmountFromRealPortfolio(
            BotTabSimple tab,
            bool refreshParameterGui = false,
            bool silent = false)
        {
            decimal? realValue = TryGetRealMonitoredPortfolioValue(tab);
            if (!realValue.HasValue || realValue.Value <= 0m)
            {
                realValue = TryGetTesterPortfolioEquity(tab);
            }

            if (realValue.HasValue && realValue.Value > 0m)
            {
                SetFakePortfolioAmount(realValue.Value, refreshParameterGui, silent);
            }
        }

        /// <summary>
        /// Сбрасывает устаревшую «фейковую сумму» из прошлого теста, если она сильно выше реального портфеля.
        /// </summary>
        private void EnsureFakePortfolioAmountAlignedWithReal(
            BotTabSimple tab,
            bool refreshParameterGui = false,
            bool silent = false)
        {
            if (!IsRealTradingBlockedByFakeMode())
            {
                return;
            }

            decimal? realValue = TryGetRealMonitoredPortfolioValue(tab);
            if (!realValue.HasValue || realValue.Value <= 0m)
            {
                realValue = TryGetTesterPortfolioEquity(tab);
            }

            if (!realValue.HasValue || realValue.Value <= 0m)
            {
                return;
            }

            decimal real = realValue.Value;
            decimal fakeAmount = GetFakePortfolioAmount();
            const decimal staleHighFactor = 1.5m;

            if (fakeAmount > 0m && fakeAmount <= real * staleHighFactor)
            {
                return;
            }

            decimal previousFake = fakeAmount;
            SetFakePortfolioAmount(real, refreshParameterGui, silent);

            SendNewLogMessage(
                NameStrategyUniq
                + " | Стопы: фейковая сумма приведена к реальному портфелю "
                + real.ToString(CultureInfo.InvariantCulture)
                + (previousFake > 0m
                    ? " (было " + previousFake.ToString(CultureInfo.InvariantCulture) + ")"
                    : "")
                + ".",
                LogMessageType.User);
            SendNewLogMessage(
                NameStrategyUniq
                + " | Стопы: фейковая сумма="
                + real.ToString(CultureInfo.InvariantCulture)
                + ", реальный портфель="
                + real.ToString(CultureInfo.InvariantCulture),
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

            decimal baseline = _portfolioStopBaselineAmount?.ValueDecimal ?? 0m;
            decimal fakeAmount = GetFakePortfolioAmount();
            decimal? fakeEquity = TryGetFakePortfolioEffectiveEquity(tab);

            string msg =
                NameStrategyUniq
                + " | диагностика: Regime="
                + (_regime?.ValueString ?? "?")
                + ", фейковый режим="
                + (IsRealTradingBlockedByFakeMode() ? "вкл." : "выкл.")
                + ", фейковая сумма="
                + fakeAmount.ToString(CultureInfo.InvariantCulture)
                + ", фейк+PnL="
                + (fakeEquity.HasValue ? fakeEquity.Value.ToString(CultureInfo.InvariantCulture) : "—")
                + ", реальный портфель="
                + (realPortfolio.HasValue ? realPortfolio.Value.ToString(CultureInfo.InvariantCulture) : "—")
                + ", база стопов="
                + baseline.ToString(CultureInfo.InvariantCulture)
                + ", take profit="
                + (_usePortfolioTakeProfit.ValueBool ? "вкл." : "выкл.")
                + ", фейк при профите="
                + (_portfolioTakeProfitEnableFakeModeOnTrigger.ValueBool ? "вкл." : "выкл.")
                + ", эмулятор скринера="
                + (_screenerTab?.EmulatorIsOn == true ? "вкл." : "выкл.")
                + ", stop loss="
                + (_usePortfolioStop.ValueBool ? "вкл." : "выкл.");

            if (_usePortfolioTakeProfit.ValueBool
                && baseline > 0m
                && realPortfolio.HasValue
                && _portfolioTakeProfitPercent.ValueDecimal > 0m)
            {
                decimal tpCeiling = baseline * (1m + _portfolioTakeProfitPercent.ValueDecimal / 100m);
                msg += ", порог take profit="
                    + tpCeiling.ToString(CultureInfo.InvariantCulture);
                if (realPortfolio.Value >= tpCeiling)
                {
                    msg += " (портфель уже выше — возможен немедленный take profit)";
                }
            }

            if (StartProgram == StartProgram.IsOsTrader && tab?.Connector != null)
            {
                msg += ", коннектор="
                    + (tab.Connector.IsConnected ? "подключён" : "нет")
                    + ", торговля="
                    + (tab.Connector.IsReadyToTrade ? "готова" : "не готова");
            }

            SendNewLogMessage(msg, LogMessageType.System);
            SendNewLogMessage(msg, LogMessageType.User);
        }

        private void LogFakeModeBlocksRealOrderOnce()
        {
            if (_loggedFakeModeBlocksRealOrders)
            {
                return;
            }

            _loggedFakeModeBlocksRealOrders = true;
            string msg =
                NameStrategyUniq
                + " | Фейковый режим вкл.: реальные заявки на биржу не отправляются (в логе только «фейковый вход/выход»). "
                + "Для боевой торговли выключите «Фейковый режим 1» на вкладке «Стопы».";
            SendNewLogMessage(msg, LogMessageType.System);
            SendNewLogMessage(msg, LogMessageType.User);
        }

        private void LogZeroVolumeOnEntryOnce(BotTabSimple tab)
        {
            if (_loggedZeroVolumeOnEntry)
            {
                return;
            }

            _loggedZeroVolumeOnEntry = true;
            string security = tab?.Connector?.SecurityName ?? tab?.TabName ?? "?";
            string reason = string.IsNullOrWhiteSpace(_lastVolumeCalcFailureReason)
                ? "неизвестно"
                : _lastVolumeCalcFailureReason;
            string msg =
                NameStrategyUniq
                + " [" + security + "]: объём входа = 0 — заявка не отправлена ("
                + reason
                + "). Проверьте Volume type="
                + (_volumeType?.ValueString ?? "?")
                + ", Volume="
                + (_volume?.ValueDecimal ?? 0m).ToString(CultureInfo.InvariantCulture)
                + ", портфель ("
                + (_tradeAssetInPortfolio?.ValueString ?? "Prime")
                + "), котировки (PriceBestAsk/Close) и подключение коннектора.";
            SendNewLogMessage(msg, LogMessageType.Error);
            SendNewLogMessage(msg, LogMessageType.User);
        }

        private void LogConnectorNotReadyForEntryOnce(BotTabSimple tab)
        {
            if (_loggedConnectorNotReadyForEntry)
            {
                return;
            }

            _loggedConnectorNotReadyForEntry = true;
            string security = tab?.Connector?.SecurityName ?? tab?.TabName ?? "?";
            string msg =
                NameStrategyUniq
                + " [" + security + "]: коннектор не готов к торговле (нет подключения или IsReadyToTrade=false).";
            SendNewLogMessage(msg, LogMessageType.Error);
            SendNewLogMessage(msg, LogMessageType.User);
        }

        private string GetFakePortfolioTabKey(BotTabSimple tab)
        {
            if (tab == null)
            {
                return string.Empty;
            }

            return tab.Connector?.SecurityName ?? tab.TabName ?? tab.GetHashCode().ToString(CultureInfo.InvariantCulture);
        }

        private BotTabSimple FindScreenerTabByFakeKey(string tabKey)
        {
            if (_screenerTab?.Tabs == null || string.IsNullOrWhiteSpace(tabKey))
            {
                return null;
            }

            for (int i = 0; i < _screenerTab.Tabs.Count; i++)
            {
                BotTabSimple childTab = _screenerTab.Tabs[i];
                if (childTab != null && string.Equals(GetFakePortfolioTabKey(childTab), tabKey, StringComparison.OrdinalIgnoreCase))
                {
                    return childTab;
                }
            }

            return null;
        }

        private bool TryGetFakeVirtualPosition(BotTabSimple tab, out FakePortfolioVirtualPosition virtualPosition)
        {
            virtualPosition = null;
            string tabKey = GetFakePortfolioTabKey(tab);
            if (string.IsNullOrWhiteSpace(tabKey))
            {
                return false;
            }

            return _fakePortfolioVirtualPositions.TryGetValue(tabKey, out virtualPosition);
        }

        private int GetScreenerOpenTradeSlotsCount()
        {
            if (IsRealTradingBlockedByFakeMode())
            {
                return _fakePortfolioVirtualPositions.Count;
            }

            return _screenerTab?.PositionsOpenAll?.Count ?? 0;
        }

        private decimal GetMarkPriceForFakePortfolio(BotTabSimple tab, Side direction)
        {
            if (tab == null)
            {
                return 0m;
            }

            if (UseMarketOrderExecution())
            {
                if (direction == Side.Buy && tab.PriceBestAsk > 0m)
                {
                    return tab.PriceBestAsk;
                }

                if (direction == Side.Sell && tab.PriceBestBid > 0m)
                {
                    return tab.PriceBestBid;
                }
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

        private decimal CalculateFakePortfolioProfitAbs(
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

            // In some tester/screener states tab.Security may be null, but we still want fake PnL to move.
            if (tab?.Security == null)
            {
                decimal profitOperationAbsFallback = direction == Side.Buy
                    ? exitPrice - entryPrice
                    : entryPrice - exitPrice;
                return profitOperationAbsFallback * volume;
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

        private decimal CalculateFakePortfolioUnrealizedProfitAbs(BotTabSimple tab, FakePortfolioVirtualPosition virtualPosition)
        {
            if (virtualPosition == null)
            {
                return 0m;
            }

            Side closeSide = virtualPosition.Direction == Side.Buy ? Side.Sell : Side.Buy;
            decimal markPrice = GetMarkPriceForFakePortfolio(tab, closeSide);
            if (markPrice <= 0m)
            {
                return 0m;
            }

            return CalculateFakePortfolioProfitAbs(
                tab,
                virtualPosition.Direction,
                virtualPosition.EntryPrice,
                markPrice,
                virtualPosition.Volume);
        }

        private decimal? TryGetFakePortfolioEffectiveEquity(BotTabSimple tab)
        {
            decimal amount = GetFakePortfolioAmount();
            if (amount <= 0m)
            {
                return null;
            }

            decimal unrealized = 0m;
            foreach (KeyValuePair<string, FakePortfolioVirtualPosition> pair in _fakePortfolioVirtualPositions)
            {
                BotTabSimple childTab = FindScreenerTabByFakeKey(pair.Key) ?? tab;
                unrealized += CalculateFakePortfolioUnrealizedProfitAbs(childTab, pair.Value);
            }

            return amount + unrealized;
        }

        #region shadow virtual portfolio

        private string GetShadowVirtualPositionsFilePath()
        {
            return Path.Combine("Engine", NameStrategyUniq + ShadowVirtualPositionsFileSuffix);
        }

        private void LoadShadowVirtualPositionsFromDisk()
        {
            if (StartProgram == StartProgram.IsTester)
            {
                return;
            }

            string path = GetShadowVirtualPositionsFilePath();
            if (!File.Exists(path))
            {
                return;
            }

            try
            {
                _shadowVirtualPositions.Clear();
                using StreamReader reader = new StreamReader(path);
                string version = reader.ReadLine();
                if (!string.Equals(version, "v1", StringComparison.Ordinal))
                {
                    return;
                }

                while (!reader.EndOfStream)
                {
                    string line = reader.ReadLine();
                    if (string.IsNullOrWhiteSpace(line))
                    {
                        continue;
                    }

                    string[] parts = line.Split('|');
                    if (parts.Length < 5)
                    {
                        continue;
                    }

                    string tabKey = parts[0];
                    if (string.IsNullOrWhiteSpace(tabKey))
                    {
                        continue;
                    }

                    if (!Enum.TryParse(parts[1], out Side dir))
                    {
                        continue;
                    }

                    if (!decimal.TryParse(parts[2], NumberStyles.Number, CultureInfo.InvariantCulture, out decimal entry))
                    {
                        continue;
                    }

                    if (!decimal.TryParse(parts[3], NumberStyles.Number, CultureInfo.InvariantCulture, out decimal vol))
                    {
                        continue;
                    }

                    if (!long.TryParse(parts[4], NumberStyles.Integer, CultureInfo.InvariantCulture, out long ticks))
                    {
                        ticks = 0;
                    }

                    DateTime openTime = ticks > 0 ? new DateTime(ticks, DateTimeKind.Unspecified) : DateTime.MinValue;

                    _shadowVirtualPositions[tabKey] = new FakePortfolioVirtualPosition
                    {
                        Direction = dir,
                        EntryPrice = entry,
                        Volume = vol,
                        OpenTime = openTime
                    };
                }

                _shadowPositionsRestoredFromDisk = true;
                _shadowPositionsDirty = false;
            }
            catch (Exception ex)
            {
                SendNewLogMessage(
                    NameStrategyUniq + " | shadow-virtual: не удалось загрузить позиции: " + ex.Message,
                    LogMessageType.Error);
            }
        }

        private void SaveShadowVirtualPositionsToDisk()
        {
            if (StartProgram == StartProgram.IsTester)
            {
                return;
            }

            try
            {
                string path = GetShadowVirtualPositionsFilePath();
                string directory = Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
                {
                    Directory.CreateDirectory(directory);
                }

                using StreamWriter writer = new StreamWriter(path, false);
                writer.WriteLine("v1");
                foreach (KeyValuePair<string, FakePortfolioVirtualPosition> pair in _shadowVirtualPositions)
                {
                    FakePortfolioVirtualPosition p = pair.Value;
                    if (p == null)
                    {
                        continue;
                    }

                    writer.WriteLine(
                        pair.Key
                        + "|"
                        + p.Direction
                        + "|"
                        + p.EntryPrice.ToString(CultureInfo.InvariantCulture)
                        + "|"
                        + p.Volume.ToString(CultureInfo.InvariantCulture)
                        + "|"
                        + p.OpenTime.Ticks.ToString(CultureInfo.InvariantCulture));
                }
            }
            catch (Exception ex)
            {
                SendNewLogMessage(
                    NameStrategyUniq + " | shadow-virtual: не удалось сохранить позиции: " + ex.Message,
                    LogMessageType.Error);
            }
        }

        private void MaybeSaveShadowVirtualPositions(bool force)
        {
            if (!_shadowPositionsDirty && !force)
            {
                return;
            }

            if (!force && StartProgram == StartProgram.IsTester)
            {
                return;
            }

            DateTime now = DateTime.Now;
            if (!force
                && _shadowPositionsLastSaveTime != DateTime.MinValue
                && (now - _shadowPositionsLastSaveTime).TotalSeconds < ShadowPositionsSaveIntervalSeconds)
            {
                return;
            }

            _shadowPositionsLastSaveTime = now;
            SaveShadowVirtualPositionsToDisk();
            _shadowPositionsDirty = false;
        }

        private void TryDeleteShadowVirtualPositionsFile()
        {
            try
            {
                string path = GetShadowVirtualPositionsFilePath();
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
        #endregion

        private void ApplyFakePortfolioOpen(BotTabSimple tab, Side direction, decimal volume, decimal entryPrice)
        {
            if (tab == null || volume <= 0m || entryPrice <= 0m)
            {
                return;
            }

            string tabKey = GetFakePortfolioTabKey(tab);
            if (string.IsNullOrWhiteSpace(tabKey))
            {
                return;
            }

            _fakePortfolioVirtualPositions[tabKey] = new FakePortfolioVirtualPosition
            {
                Direction = direction,
                EntryPrice = entryPrice,
                Volume = volume,
                OpenTime = tab.CandlesAll != null && tab.CandlesAll.Count > 0
                    ? tab.CandlesAll[tab.CandlesAll.Count - 1].TimeStart
                    : DateTime.MinValue,
            };

            SendNewLogMessage(
                NameStrategyUniq + " | фейковый вход "
                + (direction == Side.Buy ? "Long" : "Short")
                + " [" + tabKey + "], vol="
                + volume.ToString(CultureInfo.InvariantCulture)
                + ", price="
                + entryPrice.ToString(CultureInfo.InvariantCulture)
                + ", фейковая сумма="
                + GetFakePortfolioAmount().ToString(CultureInfo.InvariantCulture),
                LogMessageType.System);

            TryCollectProfitToMoneyMarketFund(tab);
            TryResumeRealTradingWhenFakeExceedsDrawdownBaseline(tab);
        }

        private void ApplyFakePortfolioClose(
            BotTabSimple tab,
            FakePortfolioVirtualPosition virtualPosition,
            decimal exitPrice,
            string reason = null)
        {
            if (tab == null || virtualPosition == null || exitPrice <= 0m)
            {
                return;
            }

            decimal profit = CalculateFakePortfolioProfitAbs(
                tab,
                virtualPosition.Direction,
                virtualPosition.EntryPrice,
                exitPrice,
                virtualPosition.Volume);
            decimal newAmount = GetFakePortfolioAmount() + profit;
            SetFakePortfolioAmount(newAmount);

            string tabKey = GetFakePortfolioTabKey(tab);
            if (!string.IsNullOrWhiteSpace(tabKey))
            {
                _fakePortfolioVirtualPositions.Remove(tabKey);
            }

            SendNewLogMessage(
                NameStrategyUniq + " | фейковый выход "
                + (virtualPosition.Direction == Side.Buy ? "Long" : "Short")
                + " [" + tabKey + "], price="
                + exitPrice.ToString(CultureInfo.InvariantCulture)
                + ", PnL="
                + profit.ToString(CultureInfo.InvariantCulture)
                + ", фейковая сумма="
                + newAmount.ToString(CultureInfo.InvariantCulture)
                + (string.IsNullOrWhiteSpace(reason) ? "" : ", " + reason),
                LogMessageType.System);

            TryCollectProfitToMoneyMarketFund(tab);
            TryResumeRealTradingWhenFakeExceedsDrawdownBaseline(tab);
        }

        private void RealizeAllFakeVirtualPositionsAtMarkPrices(string reason)
        {
            if (_fakePortfolioVirtualPositions.Count == 0)
            {
                return;
            }

            List<string> keys = _fakePortfolioVirtualPositions.Keys.ToList();
            for (int i = 0; i < keys.Count; i++)
            {
                string tabKey = keys[i];
                if (!_fakePortfolioVirtualPositions.TryGetValue(tabKey, out FakePortfolioVirtualPosition virtualPosition))
                {
                    continue;
                }

                BotTabSimple childTab = FindScreenerTabByFakeKey(tabKey);
                if (childTab == null)
                {
                    continue;
                }

                Side closeSide = virtualPosition.Direction == Side.Buy ? Side.Sell : Side.Buy;
                decimal markPrice = GetMarkPriceForFakePortfolio(childTab, closeSide);
                if (markPrice <= 0m)
                {
                    markPrice = virtualPosition.EntryPrice;
                }

                ApplyFakePortfolioClose(childTab, virtualPosition, markPrice, reason);
            }
        }

        private static int CountCandlesSinceTime(List<Candle> candles, DateTime openTime)
        {
            if (candles == null || candles.Count == 0 || openTime == DateTime.MinValue)
            {
                return 0;
            }

            int openIndex = -1;
            for (int i = candles.Count - 1; i >= 0; i--)
            {
                if (candles[i].TimeStart <= openTime)
                {
                    openIndex = i;
                    break;
                }
            }

            if (openIndex < 0)
            {
                // If we cannot map the open time to history, assume it's "old enough".
                return int.MaxValue;
            }

            return (candles.Count - 1) - openIndex;
        }

        private bool TryCloseRealPositionByTime(List<Candle> candles, BotTabSimple tab, Position pos, int timeExitCandles)
        {
            if (pos == null || tab == null || candles == null || candles.Count == 0 || timeExitCandles <= 0)
            {
                return false;
            }

            // "Not in profit" => non-positive PnL.
            if (pos.ProfitPortfolioAbs > 0m)
            {
                return false;
            }

            int openBarsAgo = CountCandlesSinceTime(candles, pos.TimeOpen);
            if (openBarsAgo <= timeExitCandles)
            {
                return false;
            }

            decimal close = candles[candles.Count - 1].Close;
            decimal slip = _slippage.ValueInt * tab.Security.PriceStep;
            decimal limitPrice = pos.Direction == Side.Buy
                ? ApplyRandomPriceShift(close - slip, tab)
                : ApplyRandomPriceShift(close + slip, tab);

            ExecuteClosePosition(tab, pos, pos.OpenVolume, limitPrice, "TimeExit");
            return true;
        }

        private bool TryCloseFakePositionByTime(List<Candle> candles, BotTabSimple tab, FakePortfolioVirtualPosition virtualPosition, int timeExitCandles)
        {
            if (virtualPosition == null || tab == null || candles == null || candles.Count == 0 || timeExitCandles <= 0)
            {
                return false;
            }

            decimal close = candles[candles.Count - 1].Close;
            decimal profit = CalculateFakePortfolioProfitAbs(
                tab,
                virtualPosition.Direction,
                virtualPosition.EntryPrice,
                close,
                virtualPosition.Volume);

            if (profit > 0m)
            {
                return false;
            }

            int openBarsAgo = CountCandlesSinceTime(candles, virtualPosition.OpenTime);
            if (openBarsAgo <= timeExitCandles)
            {
                return false;
            }

            ApplyFakePortfolioClose(tab, virtualPosition, close, "выход по времени");
            return true;
        }

        private decimal? TryGetPortfolioPrimeAssetForVolume(BotTabSimple tab)
        {
            if (IsRealTradingBlockedByFakeMode())
            {
                decimal? fakeEquity = TryGetFakePortfolioEffectiveEquity(tab);
                if (fakeEquity.HasValue && fakeEquity.Value > 0m)
                {
                    return fakeEquity;
                }
            }

            decimal? realValue = TryGetRealMonitoredPortfolioValue(tab);
            return realValue;
        }

        #region Сбор прибыли (денежный фонд)

        private static string NormalizeMoneyMarketFundPrefix(string prefix)
        {
            if (string.IsNullOrWhiteSpace(prefix))
            {
                return string.Empty;
            }

            return prefix.Trim().TrimEnd('@');
        }

        private static bool IsMoneyMarketFundPurchaseDisabled(string prefix)
        {
            string normalized = NormalizeMoneyMarketFundPrefix(prefix);
            if (string.IsNullOrWhiteSpace(normalized))
            {
                return true;
            }

            return string.Equals(normalized, MoneyMarketFundDoNotBuyOption, StringComparison.OrdinalIgnoreCase);
        }

        private bool TryGetActiveMoneyMarketFundPrefix(out string prefix)
        {
            prefix = GetSelectedMoneyMarketFundPrefix();
            if (IsMoneyMarketFundPurchaseDisabled(prefix))
            {
                prefix = string.Empty;
                return false;
            }

            return !string.IsNullOrWhiteSpace(prefix);
        }

        private static bool SecurityNameMatchesMoneyMarketFundPrefix(string securityName, string prefix)
        {
            string normalizedPrefix = NormalizeMoneyMarketFundPrefix(prefix);
            if (string.IsNullOrWhiteSpace(securityName) || string.IsNullOrWhiteSpace(normalizedPrefix))
            {
                return false;
            }

            if (!securityName.StartsWith(normalizedPrefix, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            if (securityName.Length == normalizedPrefix.Length)
            {
                return true;
            }

            char next = securityName[normalizedPrefix.Length];
            return next == '@' || next == '-' || next == '.' || !char.IsLetterOrDigit(next);
        }

        private static bool SecurityMatchesMoneyMarketFundPrefix(Security security, string prefix)
        {
            if (security == null)
            {
                return false;
            }

            return SecurityNameMatchesMoneyMarketFundPrefix(security.Name, prefix)
                || SecurityNameMatchesMoneyMarketFundPrefix(security.NameId, prefix);
        }

        private string GetSelectedMoneyMarketFundPrefix()
        {
            return NormalizeMoneyMarketFundPrefix(_moneyMarketFundPrefix?.ValueString);
        }

        private BotTabSimple TryResolveMoneyMarketFundTab(BotTabSimple referenceTab, string prefix)
        {
            string normalizedPrefix = NormalizeMoneyMarketFundPrefix(prefix);
            if (_screenerTab?.Tabs == null || string.IsNullOrWhiteSpace(normalizedPrefix))
            {
                return null;
            }

            for (int i = 0; i < _screenerTab.Tabs.Count; i++)
            {
                BotTabSimple tab = _screenerTab.Tabs[i];
                if (tab == null)
                {
                    continue;
                }

                if (SecurityNameMatchesMoneyMarketFundPrefix(tab.Connector?.SecurityName, normalizedPrefix)
                    || SecurityMatchesMoneyMarketFundPrefix(tab.Security, normalizedPrefix))
                {
                    return tab;
                }
            }

            BotTabSimple refTab = referenceTab ?? TryGetPortfolioMonitoringReferenceTab();
            if (refTab?.Connector?.MyServer?.Securities == null)
            {
                return null;
            }

            List<Security> securities = refTab.Connector.MyServer.Securities;
            Security matchedSecurity = null;
            for (int s = 0; s < securities.Count; s++)
            {
                Security security = securities[s];
                if (SecurityMatchesMoneyMarketFundPrefix(security, normalizedPrefix))
                {
                    matchedSecurity = security;
                    break;
                }
            }

            if (matchedSecurity == null)
            {
                return null;
            }

            for (int i = 0; i < _screenerTab.Tabs.Count; i++)
            {
                BotTabSimple tab = _screenerTab.Tabs[i];
                if (tab?.Connector == null)
                {
                    continue;
                }

                if (string.Equals(tab.Connector.SecurityName, matchedSecurity.Name, StringComparison.OrdinalIgnoreCase))
                {
                    return tab;
                }
            }

            return null;
        }

        /// <summary>
        /// Оценка стоимости уже купленного фонда (открытые long на вкладке фонда), в рублях.
        /// </summary>
        private decimal GetMoneyMarketFundPositionValueRub(BotTabSimple fundTab)
        {
            if (fundTab == null)
            {
                return 0m;
            }

            List<Position> positions = fundTab.PositionsOpenAll;
            if (positions == null || positions.Count == 0)
            {
                return 0m;
            }

            decimal markPrice = fundTab.PriceBestAsk;
            if (markPrice <= 0m
                && fundTab.CandlesAll != null
                && fundTab.CandlesAll.Count > 0)
            {
                markPrice = fundTab.CandlesAll[fundTab.CandlesAll.Count - 1].Close;
            }

            if (markPrice <= 0m)
            {
                return 0m;
            }

            decimal lotMultiplier = 1m;
            if (fundTab.Security?.Lot > 1m)
            {
                lotMultiplier = fundTab.Security.Lot;
            }

            decimal totalRub = 0m;
            for (int i = 0; i < positions.Count; i++)
            {
                Position position = positions[i];
                if (position == null
                    || position.State != PositionStateType.Open
                    || position.Direction != Side.Buy
                    || position.OpenVolume <= 0m)
                {
                    continue;
                }

                totalRub += position.OpenVolume * markPrice * lotMultiplier;
            }

            return totalRub;
        }

        /// <summary>
        /// Сумма закупки фонда = (реальный портфель − порог) − уже размещено в фонде; не вся сумма портфеля.
        /// </summary>
        private bool TryCalculateMoneyMarketFundPurchaseRub(
            BotTabSimple portfolioTab,
            BotTabSimple fundTab,
            decimal threshold,
            out decimal buyRub,
            out decimal portfolioValue,
            out decimal portfolioExcessRub,
            out decimal fundHeldRub)
        {
            buyRub = 0m;
            portfolioValue = 0m;
            portfolioExcessRub = 0m;
            fundHeldRub = 0m;

            decimal? monitoredPortfolio = TryGetRealMonitoredPortfolioValue(portfolioTab);
            if (!monitoredPortfolio.HasValue || monitoredPortfolio.Value <= threshold)
            {
                return false;
            }

            portfolioValue = monitoredPortfolio.Value;
            portfolioExcessRub = portfolioValue - threshold;
            fundHeldRub = GetMoneyMarketFundPositionValueRub(fundTab);
            buyRub = portfolioExcessRub - fundHeldRub;

            return buyRub > 0m;
        }

        private decimal CalculateMoneyMarketFundBuyVolume(BotTabSimple fundTab, decimal rubAmount)
        {
            if (fundTab == null || rubAmount <= 0m)
            {
                return 0m;
            }

            decimal contractPrice = fundTab.PriceBestAsk;
            if (contractPrice <= 0m
                && fundTab.CandlesAll != null
                && fundTab.CandlesAll.Count > 0)
            {
                contractPrice = fundTab.CandlesAll[fundTab.CandlesAll.Count - 1].Close;
            }

            if (contractPrice <= 0m)
            {
                return 0m;
            }

            decimal volume = rubAmount / contractPrice;

            if (StartProgram == StartProgram.IsOsTrader)
            {
                IServerPermission serverPermission = fundTab.Connector != null
                    ? ServerMaster.GetServerPermission(fundTab.Connector.ServerType)
                    : null;

                if (serverPermission != null
                    && serverPermission.IsUseLotToCalculateProfit
                    && fundTab.Security?.Lot != 0
                    && fundTab.Security.Lot > 1)
                {
                    volume = rubAmount / (contractPrice * fundTab.Security.Lot);
                }

                volume = Math.Floor(volume);
            }
            else
            {
                volume = Math.Round(volume, 6);
            }

            return volume > 0m ? volume : 0m;
        }

        /// <summary>
        /// После сделки: если сумма портfеля выше порога — закупить фонд (TMON и т.п.) на разницу (логика как TmonRebalancer).
        /// </summary>
        private void TryCollectProfitToMoneyMarketFund(BotTabSimple referenceTab)
        {
            if (_regime.ValueString == "Off")
            {
                return;
            }

            if (IsRealTradingBlockedByFakeMode())
            {
                return;
            }

            if (!TryGetActiveMoneyMarketFundPrefix(out string prefix))
            {
                return;
            }

            decimal threshold = _buyMoneyMarketFundWhenPortfolioExceeds?.ValueDecimal
                ?? DefaultBuyMoneyMarketFundPortfolioThreshold;
            if (threshold <= 0m)
            {
                return;
            }

            BotTabSimple portfolioTab = referenceTab ?? TryGetPortfolioMonitoringReferenceTab();

            BotTabSimple fundTab = TryResolveMoneyMarketFundTab(portfolioTab, prefix);
            if (fundTab == null)
            {
                string missingKey = "fundTab|" + prefix;
                if (_loggedProfitCollectionNoticeKeys.Add(missingKey))
                {
                    SendNewLogMessage(
                        NameStrategyUniq
                        + " | Сбор прибыли: вкладка фонда с префиксом «"
                        + prefix
                        + "» не найдена в скринере — добавьте бумагу (TMON@, LQDT@, SBMM@) на тот же коннектор.",
                        LogMessageType.Error);
                }

                return;
            }

            if (!TryCalculateMoneyMarketFundPurchaseRub(
                    portfolioTab,
                    fundTab,
                    threshold,
                    out decimal buyRub,
                    out decimal portfolioValue,
                    out decimal portfolioExcessRub,
                    out decimal fundHeldRub))
            {
                return;
            }

            if (StartProgram == StartProgram.IsOsTrader)
            {
                if (fundTab.IsConnected == false || fundTab.IsReadyToTrade == false)
                {
                    return;
                }
            }

            decimal price = fundTab.PriceBestAsk;
            if (price <= 0m
                && fundTab.CandlesAll != null
                && fundTab.CandlesAll.Count > 0)
            {
                price = fundTab.CandlesAll[fundTab.CandlesAll.Count - 1].Close;
            }

            if (price <= 0m)
            {
                return;
            }

            decimal volume = CalculateMoneyMarketFundBuyVolume(fundTab, buyRub);
            if (volume <= 0m)
            {
                return;
            }

            if (fundTab.PositionOpenLong != null && fundTab.PositionOpenLong.Count > 0)
            {
                fundTab.BuyAtLimitToPosition(fundTab.PositionOpenLong[0], price, volume);
            }
            else
            {
                fundTab.BuyAtLimit(volume, price, SignalProfitCollection);
            }

            SendNewLogMessage(
                NameStrategyUniq
                + " | Сбор прибыли: покупка "
                + prefix
                + " vol="
                + volume.ToString(CultureInfo.InvariantCulture)
                + " @ "
                + price.ToString(CultureInfo.InvariantCulture)
                + " (портfель="
                + portfolioValue.ToString(CultureInfo.InvariantCulture)
                + ", порог="
                + threshold.ToString(CultureInfo.InvariantCulture)
                + ", превышение="
                + portfolioExcessRub.ToString(CultureInfo.InvariantCulture)
                + ", уже в фонде="
                + fundHeldRub.ToString(CultureInfo.InvariantCulture)
                + ", к закупке="
                + buyRub.ToString(CultureInfo.InvariantCulture)
                + " руб.)",
                LogMessageType.System);
        }

        #endregion

        /// <summary>
        /// Если включено — при достижении фейковой суммой цели возобновления выключает фейковый режим.
        /// Фейковая сумма ≥ база до стопа (+0,1%) или ≥ реальный портфель (−0,1%).
        /// </summary>
        private void TryResumeRealTradingWhenFakeExceedsDrawdownBaseline(BotTabSimple tab)
        {
            if (!_resumeTradingWhenFakeExceedsDrawdownBaseline.ValueBool
                || !IsRealTradingBlockedByFakeMode())
            {
                return;
            }

            EnsureFakeModeRecoveryTargetInitialized(tab);

            decimal? fakeEquity = TryGetFakePortfolioEffectiveEquity(tab);
            if (!fakeEquity.HasValue || fakeEquity.Value <= 0m)
            {
                return;
            }

            decimal recoveryTarget = ResolveFakeModeRecoveryTargetAmount(tab);
            if (recoveryTarget <= 0m)
            {
                return;
            }

            decimal targetThreshold = recoveryTarget * (1m + ResumeTradingFakeOverBaselinePercent / 100m);
            bool meetsRecoveryTarget = fakeEquity.Value >= targetThreshold;

            bool meetsRealPortfolio = false;
            decimal? realPortfolio = TryGetRealMonitoredPortfolioValue(tab);
            if (realPortfolio.HasValue && realPortfolio.Value > 0m)
            {
                decimal realThreshold = realPortfolio.Value * (1m - ResumeTradingFakeOverBaselinePercent / 100m);
                meetsRealPortfolio = fakeEquity.Value >= realThreshold;
            }

            if (!meetsRecoveryTarget && !meetsRealPortfolio)
            {
                return;
            }

            string reason = meetsRecoveryTarget
                ? "цель возобновления " + recoveryTarget.ToString(CultureInfo.InvariantCulture)
                  + " (порог=" + targetThreshold.ToString(CultureInfo.InvariantCulture) + ")"
                : "реальный портфель " + realPortfolio.Value.ToString(CultureInfo.InvariantCulture);

            SetFakeMode(false, refreshParameterGui: true);

            string msg =
                NameStrategyUniq
                + " | Стопы: фейковая сумма "
                + fakeEquity.Value.ToString(CultureInfo.InvariantCulture)
                + " достигла "
                + reason
                + " — фейковый режим выключен, торговля возобновлена.";
            SendNewLogMessage(msg, LogMessageType.System);
            SendNewLogMessage(msg, LogMessageType.User);
        }

        private decimal ResolveFakeModeRecoveryTargetAmount(BotTabSimple tab)
        {
            decimal recoveryTarget = _fakeModeRecoveryTargetAmount;
            if (recoveryTarget <= 0m)
            {
                StrategyParameterDecimal baselineParam = ResolvePortfolioStopBaselineParameter();
                recoveryTarget = baselineParam?.ValueDecimal ?? 0m;
            }

            if (recoveryTarget <= 0m)
            {
                decimal? realFallback = TryGetRealMonitoredPortfolioValue(tab);
                if (realFallback.HasValue && realFallback.Value > 0m)
                {
                    recoveryTarget = realFallback.Value;
                }
            }

            return recoveryTarget;
        }

        private void TryResumeRealTradingIfFakeMode(BotTabSimple tab)
        {
            if (IsRealTradingBlockedByFakeMode())
            {
                TryResumeRealTradingWhenFakeExceedsDrawdownBaseline(tab);
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

            if (_screenerTab != null && _screenerTab.EventsIsOn)
            {
                tab.EventsIsOn = true;
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
                    if (ind.Type == PortfolioIndicatorType)
                    {
                        ApplyPortfolioIndicatorParamsFromRobot(existing);
                        TryRebuildPortfolioIndicatorSeries(existing);
                        existing.Reload();
                    }
                    else
                    {
                        ApplyIndicatorParamsToTab(tab, ind.Num, ind.Type, ind.Parameters);
                    }

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

                if (ind.Type == PortfolioIndicatorType)
                {
                    ApplyPortfolioIndicatorParamsFromRobot(created);
                    TryRebuildPortfolioIndicatorSeries(created);
                    created.Reload();
                }

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
            WireStopsTabButtons();
            WireCalculationsTabButtons();
            RegisterParameterHints();
            if (ParamGuiIsOpen)
            {
                RequestParameterGuiRepaintOnce();
            }

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
            _useStoch.ValueBool = true;
            _useMomentum.ValueBool = false;
            _useBollinger.ValueBool = false;
            _useLinReg.ValueBool = true;
            _useVolumeIndicator.ValueBool = false;
            _useVwap.ValueBool = false;
            _useAtr.ValueBool = true;
            _useMacd.ValueBool = true;

            _smaLen.ValueInt = 100;
            _rsiLen.ValueInt = 14;
            _rsiLongMin.ValueDecimal = 55m;
            _rsiShortMax.ValueDecimal = 45m;
            _stochP1.ValueInt = 14;
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

        private const string InvertEntryLogicSwapParamName =
            "Инверсия логики (покупка и продажа меняются местами)";

        private static bool IsInvertEntryLogicSwapParameterName(string name)
        {
            return name == InvertEntryLogicSwapParamName
                   || name == "Инверсия логики сигналов"
                   || name == "Инверсия логики (покупка ↔ продажа)";
        }

        private StrategyParameterBool ResolveInvertEntryLogicSwapParameter()
        {
            if (Parameters != null)
            {
                for (int i = 0; i < Parameters.Count; i++)
                {
                    if (Parameters[i] is StrategyParameterBool param
                        && IsInvertEntryLogicSwapParameterName(param.Name))
                    {
                        return param;
                    }
                }
            }

            return _invertEntryLogic;
        }

        /// <summary>
        /// Покупка ↔ продажа по параметру «Инверсия логики (покупка и продажа меняются местами)».
        /// </summary>
        private bool IsEntryLogicSwapEnabled()
        {
            StrategyParameterBool param = ResolveInvertEntryLogicSwapParameter();
            return param != null && param.ValueBool;
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
                _lastPortfolioStopDecisionTime = DateTime.MinValue;

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

        private static string FormatPortfolioStopDate(DateTime date)
        {
            return date.ToString("dd.MM.yyyy", CultureInfo.InvariantCulture);
        }

        private bool TryParsePortfolioStopDrawdownDate(BotTabSimple tab, DateTime candleTime, out DateTime parsedDate)
        {
            parsedDate = DateTime.MinValue;
            if (_portfolioStopDrawdownDate == null
                || string.IsNullOrWhiteSpace(_portfolioStopDrawdownDate.ValueString))
            {
                return false;
            }

            if (TryParseFlexibleDateTime(tab, candleTime, _portfolioStopDrawdownDate.ValueString, out DateTime parsed))
            {
                parsedDate = parsed.Date;
                return true;
            }

            return false;
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

            // Как вкладка «Portfolio» в OsTrader: server.Portfolios (не только Connector вкладки).
            Portfolio portfolio = TryGetPortfolioFromConnectedServers();
            if (portfolio != null)
            {
                return portfolio;
            }

            portfolio = GetFirstPortfolio();
            if (portfolio != null)
            {
                return portfolio;
            }

            portfolio = tab?.Connector?.Portfolio ?? tab?.Portfolio;
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

            IServer server = ResolvePortfolioMonitoringServer(tab);
            return TryPickPortfolioOnServer(server, ResolvePortfolioMonitoringName(tab, server));
        }

        /// <summary>
        /// Портфель с подключённых серверов — тот же источник, что и вкладка «Portfolio» OsTrader.
        /// </summary>
        private Portfolio TryGetPortfolioFromConnectedServers()
        {
            string preferredName = _screenerTab?.PortfolioName;
            IServer primaryServer = ResolvePortfolioMonitoringServer(null);
            Portfolio primary = TryPickPortfolioOnServer(primaryServer, preferredName);
            if (primary != null)
            {
                return primary;
            }

            List<IServer> servers = ServerMaster.GetServers();
            if (servers == null || servers.Count == 0)
            {
                return null;
            }

            Portfolio best = null;
            decimal bestEquity = 0m;

            for (int i = 0; i < servers.Count; i++)
            {
                IServer server = servers[i];
                if (server == null || server.ServerType == ServerType.Optimizer)
                {
                    continue;
                }

                Portfolio candidate = TryPickPortfolioOnServer(server, preferredName);
                if (candidate == null)
                {
                    continue;
                }

                decimal equity = GetPortfolioEquityForServerSelection(candidate);
                if (equity > bestEquity)
                {
                    bestEquity = equity;
                    best = candidate;
                }
            }

            return best;
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

            Portfolio best = null;
            decimal bestEquity = 0m;

            for (int i = 0; i < server.Portfolios.Count; i++)
            {
                Portfolio portfolio = server.Portfolios[i];
                if (portfolio == null
                    || string.Equals(portfolio.Number, "FinamVirtual", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                decimal equity = GetPortfolioEquityForServerSelection(portfolio);
                if (equity > bestEquity)
                {
                    bestEquity = equity;
                    best = portfolio;
                }
            }

            if (best != null)
            {
                return best;
            }

            for (int i = 0; i < server.Portfolios.Count; i++)
            {
                Portfolio portfolio = server.Portfolios[i];
                if (portfolio != null
                    && !string.Equals(portfolio.Number, "FinamVirtual", StringComparison.OrdinalIgnoreCase))
                {
                    return portfolio;
                }
            }

            return null;
        }

        /// <summary>Выбор «лучшего» портфеля на сервере (ValueCurrent, как на вкладке «Portfolio»).</summary>
        private static decimal GetPortfolioEquityForServerSelection(Portfolio portfolio)
        {
            if (portfolio == null)
            {
                return 0m;
            }

            if (portfolio.ValueCurrent > 0m)
            {
                return portfolio.ValueCurrent;
            }

            if (portfolio.ValueBegin > 0m)
            {
                return portfolio.ValueBegin;
            }

            decimal? fromBoard = TryGetPrimeEquityFromPositionsOnBoard(portfolio);
            return fromBoard ?? 0m;
        }

        /// <summary>
        /// Коннектор для мониторинга портфеля: вкладка → скринер → Tester/TInvest.
        /// </summary>
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

        /// <summary>
        /// Имя портфеля: настройки скринера, вкладка, иначе первый доступный (Tester: GodMode).
        /// </summary>
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

        private DateTime ResolvePortfolioMonitoringReferenceTime(BotTabSimple tab)
        {
            if (tab != null)
            {
                DateTime serverTime = tab.TimeServerCurrent;
                if (serverTime != DateTime.MinValue)
                {
                    return serverTime;
                }

                if (tab.CandlesAll != null && tab.CandlesAll.Count > 0)
                {
                    return tab.CandlesAll[tab.CandlesAll.Count - 1].TimeStart;
                }
            }

            if (ShouldUseMoexTesterConnector())
            {
                IServer server = ResolvePortfolioMonitoringServer(tab);
                if (server is TesterServer tester && tester.ServerTime != DateTime.MinValue)
                {
                    return tester.ServerTime;
                }
            }

            return DateTime.Now;
        }

        /// <summary>
        /// Текущая стоимость актива портфеля (Prime или выбранный инструмент).
        /// </summary>
        private decimal? TryGetMonitoredPortfolioValue(BotTabSimple tab)
        {
            if (IsRealTradingBlockedByFakeMode())
            {
                decimal? fakeEquity = TryGetFakePortfolioEffectiveEquity(tab);
                if (fakeEquity.HasValue && fakeEquity.Value > 0m)
                {
                    return fakeEquity;
                }
            }

            return TryGetRealMonitoredPortfolioValue(tab);
        }

        /// <summary>
        /// Реальная сумма портфеля (без учёта фейковой симуляции).
        /// </summary>
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

            Portfolio myPortfolio = TryResolvePortfolioForMonitoring(tab);
            decimal equity = GetPortfolioDisplayEquity(myPortfolio);
            if (equity > 0m)
            {
                return equity;
            }

            decimal? testerFallback = TryGetTesterPortfolioEquity(tab);
            if (testerFallback.HasValue && testerFallback.Value > 0m)
            {
                return testerFallback;
            }

            return TryGetEquityFromLatestBotPosition(tab);
        }

        /// <summary>
        /// Тестер/оптимизатор: ValueCurrent портфеля GodMode или начальный депозит (StartPortfolio).
        /// </summary>
        private decimal? TryGetTesterPortfolioEquity(BotTabSimple tab)
        {
            // In tester/optimizer we must be able to read Initial deposit even before any trades.
            // Do not rely on a single server reference; scan tester-like servers too.

            if (tab?.Connector?.MyServer is TesterServer tabTester)
            {
                Portfolio connectorPortfolio = tab.Connector.Portfolio ?? tab.Portfolio;
                decimal? fromConnector = TryGetFullPortfolioEquityFromPortfolioObject(connectorPortfolio);
                if (fromConnector.HasValue)
                {
                    return fromConnector;
                }

                if (tabTester.StartPortfolio > 0m)
                {
                    return tabTester.StartPortfolio;
                }
            }

            IServer server = ResolvePortfolioMonitoringServer(tab) ?? FindTesterLikeServer();

            if (server != null)
            {
                string portfolioName = ResolvePortfolioMonitoringName(tab, server);
                Portfolio portfolio = TryPickPortfolioOnServer(server, portfolioName);
                if (portfolio != null)
                {
                    decimal? fromPortfolio = TryGetFullPortfolioEquityFromPortfolioObject(portfolio);
                    if (fromPortfolio.HasValue)
                    {
                        return fromPortfolio;
                    }
                }

                if (server is TesterServer testerServer && testerServer.StartPortfolio > 0m)
                {
                    return testerServer.StartPortfolio;
                }

                if (server.ServerType == ServerType.Optimizer
                    && server.Portfolios != null
                    && server.Portfolios.Count > 0)
                {
                    Portfolio optimizerPortfolio = server.Portfolios[0];
                    if (optimizerPortfolio.ValueCurrent > 0m)
                    {
                        return optimizerPortfolio.ValueCurrent;
                    }

                    if (optimizerPortfolio.ValueBegin > 0m)
                    {
                        return optimizerPortfolio.ValueBegin;
                    }
                }
            }

            // Extra fallback: scan any tester/optimizer server for StartPortfolio / ValueBegin
            List<IServer> servers = ServerMaster.GetServers();
            if (servers != null)
            {
                for (int i = 0; i < servers.Count; i++)
                {
                    IServer s = servers[i];
                    if (s == null || (s.ServerType != ServerType.Tester && s.ServerType != ServerType.Optimizer))
                    {
                        continue;
                    }

                    if (s is TesterServer ts && ts.StartPortfolio > 0m)
                    {
                        return ts.StartPortfolio;
                    }

                    if (s.Portfolios != null && s.Portfolios.Count > 0)
                    {
                        Portfolio p = s.Portfolios[0];
                        if (p != null)
                        {
                            if (p.ValueCurrent > 0m)
                            {
                                return p.ValueCurrent;
                            }

                            if (p.ValueBegin > 0m)
                            {
                                return p.ValueBegin;
                            }
                        }
                    }
                }
            }

            return null;
        }

        private decimal GetPortfolioDisplayEquity(Portfolio portfolio)
        {
            decimal? extracted = ExtractMonitoredPortfolioValue(portfolio);
            return extracted.HasValue ? extracted.Value : 0m;
        }

        private decimal? ExtractMonitoredPortfolioValue(Portfolio portfolio)
        {
            if (portfolio == null)
            {
                return null;
            }

            if (string.Equals(_tradeAssetInPortfolio.ValueString, "Prime", StringComparison.OrdinalIgnoreCase))
            {
                if (portfolio.ValueCurrent > 0m)
                {
                    return portfolio.ValueCurrent;
                }

                if (portfolio.ValueBegin > 0m)
                {
                    return portfolio.ValueBegin;
                }

                return TryGetPrimeEquityFromPositionsOnBoard(portfolio);
            }

            List<PositionOnBoard> positionOnBoard = portfolio.GetPositionOnBoard();
            if (positionOnBoard != null)
            {
                for (int i = 0; i < positionOnBoard.Count; i++)
                {
                    if (positionOnBoard[i].SecurityNameCode == _tradeAssetInPortfolio.ValueString
                        && positionOnBoard[i].ValueCurrent > 0m)
                    {
                        return positionOnBoard[i].ValueCurrent;
                    }
                }
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

        /// <summary>
        /// Если ValueCurrent/ValueBegin = 0, но на борде есть позиции (как на вкладке «Portfolio»).
        /// </summary>
        private static decimal? TryGetPrimeEquityFromPositionsOnBoard(Portfolio portfolio)
        {
            List<PositionOnBoard> positionOnBoard = portfolio?.GetPositionOnBoard();
            if (positionOnBoard == null || positionOnBoard.Count == 0)
            {
                return null;
            }

            for (int i = 0; i < positionOnBoard.Count; i++)
            {
                PositionOnBoard rub = positionOnBoard[i];
                if (string.Equals(rub.SecurityNameCode, "rub", StringComparison.OrdinalIgnoreCase)
                    && rub.ValueCurrent > 0m)
                {
                    return rub.ValueCurrent;
                }
            }

            decimal maxValue = 0m;
            for (int i = 0; i < positionOnBoard.Count; i++)
            {
                if (positionOnBoard[i].ValueCurrent > maxValue)
                {
                    maxValue = positionOnBoard[i].ValueCurrent;
                }
            }

            return maxValue > 0m ? maxValue : null;
        }

        /// <summary>
        /// Фейк/лайв: если портфель коннектора недоступен — equity по последней открытой позиции робота.
        /// </summary>
        private decimal? TryGetEquityFromLatestBotPosition(BotTabSimple tab)
        {
            if (_screenerTab?.Tabs == null || _screenerTab.Tabs.Count == 0)
            {
                return null;
            }

            Position latestOpen = null;
            DateTime latestOpenTime = DateTime.MinValue;

            for (int t = 0; t < _screenerTab.Tabs.Count; t++)
            {
                BotTabSimple childTab = _screenerTab.Tabs[t];
                List<Position> openPositions = childTab?.PositionsOpenAll;
                if (openPositions == null || openPositions.Count == 0)
                {
                    continue;
                }

                for (int i = 0; i < openPositions.Count; i++)
                {
                    Position pos = openPositions[i];
                    if (!IsOurBotPosition(pos)
                        || pos.PortfolioValueOnOpenPosition <= 0m)
                    {
                        continue;
                    }

                    if (pos.TimeOpen >= latestOpenTime)
                    {
                        latestOpenTime = pos.TimeOpen;
                        latestOpen = pos;
                    }
                }
            }

            if (latestOpen == null)
            {
                return null;
            }

            return latestOpen.PortfolioValueOnOpenPosition + latestOpen.ProfitPortfolioAbs;
        }

        private void SetPortfolioStopBaseline(decimal baseline, DateTime decisionDate, bool refreshParameterGui = false)
        {
            ApplyPortfolioStopFieldsToParameters(baseline, decisionDate, setAmount: baseline > 0m);

            if (refreshParameterGui)
            {
                RefreshPortfolioStopParameterDialog();
            }
        }

        private void ResetPortfolioPeak(decimal peak)
        {
            if (peak < 0m)
            {
                peak = 0m;
            }

            SetPortfolioPeakValue(peak);
            MaybeSavePortfolioPeak(force: true);
        }

        private void SetPortfolioPeakValue(decimal value, bool silent = true)
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

            SetStrategyParameterDecimalValue(_portfolioPeakValue, value, silent);

            IIStrategyParameter peakFromList = Parameters?.Find(p => p.Name == "Пик портфеля");
            if (peakFromList is StrategyParameterDecimal peakParam
                && !ReferenceEquals(peakParam, _portfolioPeakValue))
            {
                SetStrategyParameterDecimalValue(peakParam, value, silent);
            }

            _portfolioPeakDirty = true;
        }

        private void MaybeSavePortfolioPeak(bool force)
        {
            if (!_portfolioPeakDirty && !force)
            {
                return;
            }

            if (!force && StartProgram == StartProgram.IsTester)
            {
                // In tester we don't need persistence each candle.
                return;
            }

            DateTime now = DateTime.Now;
            if (!force
                && _portfolioPeakLastSaveTime != DateTime.MinValue
                && (now - _portfolioPeakLastSaveTime).TotalSeconds < PortfolioPeakSaveIntervalSeconds)
            {
                return;
            }

            _portfolioPeakLastSaveTime = now;
            SaveParameters();
            _portfolioPeakDirty = false;
        }

        /// <summary>
        /// При первом входе в новый календарный день (дата просадки &lt; текущей) — зафиксировать базу портфеля.
        /// </summary>
        private void TryRefreshPortfolioStopBaselineOnFirstEntry(BotTabSimple tab, Position position, DateTime decisionTime)
        {
            if (!_usePortfolioStop.ValueBool
                && !_usePortfolioTakeProfit.ValueBool
                || position == null
                || tab == null
                || position.State != PositionStateType.Open
                || !IsOurBotPosition(position))
            {
                return;
            }

            DateTime currentDate = GetCalendarDateForTimeOnly(tab, decisionTime);
            DateTime storedDate = DateTime.MinValue;
            if (TryParsePortfolioStopDrawdownDate(tab, decisionTime, out DateTime parsedStored))
            {
                storedDate = parsedStored;
            }

            if (storedDate >= currentDate)
            {
                return;
            }

            decimal? value = TryGetRealMonitoredPortfolioValue(tab);
            if (!value.HasValue || value.Value <= 0m)
            {
                return;
            }

            SetPortfolioStopBaseline(value.Value, currentDate);
            SendNewLogMessage(
                NameStrategyUniq + " | Стопы: база портфеля "
                + value.Value.ToString(CultureInfo.InvariantCulture)
                + ", дата "
                + FormatPortfolioStopDate(currentDate),
                LogMessageType.System);
        }

        private bool TryManagePortfolioDrawdownStop(BotTabSimple tab, DateTime decisionTime)
        {
            return TryManagePortfolioProtectionStops(tab, decisionTime);
        }

        private bool TryManagePortfolioProtectionStops(BotTabSimple tab, DateTime decisionTime)
        {
            bool stopEnabled = _usePortfolioStop.ValueBool;
            bool takeProfitEnabled = _usePortfolioTakeProfit.ValueBool;
            bool peakStopEnabled = _usePortfolioPeakDrawdownStop != null && _usePortfolioPeakDrawdownStop.ValueBool;

            if (!stopEnabled && !takeProfitEnabled && !peakStopEnabled)
            {
                return false;
            }

            decimal drawdownPercent = stopEnabled ? _portfolioStopDrawdownPercent.ValueDecimal : 0m;
            decimal takeProfitPercent = takeProfitEnabled ? _portfolioTakeProfitPercent.ValueDecimal : 0m;
            decimal peakDrawdownPercent = peakStopEnabled ? (_portfolioPeakDrawdownPercent?.ValueDecimal ?? 0m) : 0m;

            if ((!stopEnabled || drawdownPercent <= 0m)
                && (!takeProfitEnabled || takeProfitPercent <= 0m)
                && (!peakStopEnabled || peakDrawdownPercent <= 0m))
            {
                return false;
            }

            if (decisionTime == _lastPortfolioStopDecisionTime)
            {
                return false;
            }

            decimal? currentMonitored = TryGetPortfolioValueForStopsBaselineFill(tab);
            if (!currentMonitored.HasValue || currentMonitored.Value <= 0m)
            {
                return false;
            }

            // Trailing peak stop: update peak and check drawdown from peak.
            if (peakStopEnabled && peakDrawdownPercent > 0m)
            {
                decimal peak = _portfolioPeakValue?.ValueDecimal ?? 0m;
                if (peak <= 0m)
                {
                    peak = currentMonitored.Value;
                    SetPortfolioPeakValue(peak);
                }
                else if (currentMonitored.Value > peak)
                {
                    peak = currentMonitored.Value;
                    SetPortfolioPeakValue(peak);
                }

                MaybeSavePortfolioPeak(force: false);

                decimal floorFromPeak = peak * (1m - peakDrawdownPercent / 100m);
                if (currentMonitored.Value <= floorFromPeak)
                {
                    _lastPortfolioStopDecisionTime = decisionTime;
                    return ExecutePortfolioPeakDrawdownTrigger(
                        tab,
                        decisionTime,
                        peak,
                        currentMonitored.Value,
                        peakDrawdownPercent,
                        floorFromPeak);
                }
            }

            decimal baseline = _portfolioStopBaselineAmount?.ValueDecimal ?? 0m;
            if (baseline <= 0m)
            {
                return false;
            }

            decimal? currentValue = TryGetPortfolioValueForStopsBaselineFill(tab);
            if (!currentValue.HasValue || currentValue.Value <= 0m)
            {
                return false;
            }

            _lastPortfolioStopDecisionTime = decisionTime;

            if (stopEnabled && drawdownPercent > 0m)
            {
                decimal floor = baseline * (1m - drawdownPercent / 100m);
                if (currentValue.Value <= floor)
                {
                    return ExecutePortfolioProtectionTrigger(
                        tab,
                        decisionTime,
                        baseline,
                        currentValue.Value,
                        isTakeProfit: false,
                        thresholdPercent: drawdownPercent,
                        triggerLevel: floor);
                }
            }

            if (takeProfitEnabled && takeProfitPercent > 0m)
            {
                decimal ceiling = baseline * (1m + takeProfitPercent / 100m);
                if (_portfolioTakeProfitNeedsPullback)
                {
                    decimal releaseLevel = baseline * (1m + (takeProfitPercent - 0.05m) / 100m);
                    if (takeProfitPercent > 0.05m && currentValue.Value < releaseLevel)
                    {
                        _portfolioTakeProfitNeedsPullback = false;
                    }
                }
                else if (currentValue.Value >= ceiling)
                {
                    return ExecutePortfolioProtectionTrigger(
                        tab,
                        decisionTime,
                        baseline,
                        currentValue.Value,
                        isTakeProfit: true,
                        thresholdPercent: takeProfitPercent,
                        triggerLevel: ceiling);
                }
            }

            return false;
        }

        private bool ExecutePortfolioProtectionTrigger(
            BotTabSimple tab,
            DateTime decisionTime,
            decimal baseline,
            decimal currentValue,
            bool isTakeProfit,
            decimal thresholdPercent,
            decimal triggerLevel)
        {
            bool enableFakeModeOnTrigger = isTakeProfit
                ? _portfolioTakeProfitEnableFakeModeOnTrigger.ValueBool
                : _portfolioStopEnableFakeModeOnTrigger.ValueBool;

            CloseAllBotPositions();
            if (IsRealTradingBlockedByFakeMode())
            {
                RealizeAllFakeVirtualPositionsAtMarkPrices("portfolio protection");
            }

            _lastPortfolioStopDecisionTime = DateTime.MinValue;

            DateTime currentDate = GetCalendarDateForTimeOnly(tab, decisionTime);
            decimal? afterCloseValue = TryGetPortfolioValueForStopsBaselineFill(tab);
            decimal newBaseline = afterCloseValue.HasValue && afterCloseValue.Value > 0m
                ? afterCloseValue.Value
                : currentValue;
            SetPortfolioStopBaseline(newBaseline, currentDate);

            if (isTakeProfit)
            {
                _portfolioTakeProfitNeedsPullback = true;
            }

            if (enableFakeModeOnTrigger)
            {
                SetFakeMode(true, recoveryTargetAmount: baseline);
                SendNewLogMessage(
                    NameStrategyUniq
                    + " | Стопы: включён фейковый режим — новые сделки только виртуальные (в тестере реальных заявок не будет).",
                    LogMessageType.User);
            }

            RefreshPortfolioStopParameterDialog();

            string regimeNote = enableFakeModeOnTrigger
                ? "фейковый режим=вкл., Regime без изменений"
                : "торговля по сигналам без изменений (фейковый режим выкл.)";

            string stopKind = isTakeProfit ? "take profit" : "просадка портфеля";
            string portfolioStopHeadline =
                NameStrategyUniq
                + ": *** СТОП «Стопы» — "
                + stopKind
                + " "
                + thresholdPercent.ToString(CultureInfo.InvariantCulture)
                + "% от базы — закрыты все позиции, "
                + regimeNote
                + " ***";

            string levelLabel = isTakeProfit ? "порог take profit" : "порог просадки";
            string portfolioStopMsg =
                NameStrategyUniq + " | страховка портфеля | "
                + (isTakeProfit ? "take profit" : "просадка")
                + " | база="
                + baseline.ToString(CultureInfo.InvariantCulture)
                + ", equity="
                + currentValue.ToString(CultureInfo.InvariantCulture)
                + ", "
                + levelLabel
                + "="
                + triggerLevel.ToString(CultureInfo.InvariantCulture)
                + ", новая база="
                + (_portfolioStopBaselineAmount?.ValueDecimal ?? 0m).ToString(CultureInfo.InvariantCulture)
                + ", дата="
                + FormatPortfolioStopDate(currentDate)
                + ", фейковый режим="
                + (enableFakeModeOnTrigger ? "вкл." : "без изменений");

            string dedupeKey = (isTakeProfit ? "takeprofit|" : "portfolio|") + decisionTime.Ticks;
            LogPortfolioDrawdownStopNotice(dedupeKey, portfolioStopHeadline, portfolioStopMsg);
            return true;
        }

        private bool ExecutePortfolioPeakDrawdownTrigger(
            BotTabSimple tab,
            DateTime decisionTime,
            decimal peak,
            decimal currentValue,
            decimal thresholdPercent,
            decimal triggerLevel)
        {
            bool enableFakeModeOnTrigger = _portfolioStopEnableFakeModeOnTrigger.ValueBool;

            CloseAllBotPositions();
            if (IsRealTradingBlockedByFakeMode())
            {
                RealizeAllFakeVirtualPositionsAtMarkPrices("peak drawdown");
            }

            _lastPortfolioStopDecisionTime = DateTime.MinValue;

            // After protection, reset peak to current equity (or 0 if unknown) to avoid immediate re-trigger loops.
            decimal? afterClose = TryGetPortfolioValueForStopsBaselineFill(tab);
            decimal newPeak = afterClose.HasValue && afterClose.Value > 0m ? afterClose.Value : currentValue;
            SetPortfolioPeakValue(newPeak);
            MaybeSavePortfolioPeak(force: true);

            if (enableFakeModeOnTrigger)
            {
                SetFakeMode(true, recoveryTargetAmount: peak);
                SendNewLogMessage(
                    NameStrategyUniq
                    + " | Стопы: включён фейковый режим — новые сделки только виртуальные (в тестере реальных заявок не будет).",
                    LogMessageType.User);
            }

            RefreshPortfolioStopParameterDialog();

            string regimeNote = enableFakeModeOnTrigger
                ? "фейковый режим=вкл., Regime без изменений"
                : "торговля по сигналам без изменений (фейковый режим выкл.)";

            string portfolioStopHeadline =
                NameStrategyUniq
                + ": *** СТОП «Стопы» — просадка от пика "
                + thresholdPercent.ToString(CultureInfo.InvariantCulture)
                + "% — закрыты все позиции, "
                + regimeNote
                + " ***";

            string portfolioStopMsg =
                NameStrategyUniq + " | страховка портфеля | просадка от пика"
                + " | пик="
                + peak.ToString(CultureInfo.InvariantCulture)
                + ", equity="
                + currentValue.ToString(CultureInfo.InvariantCulture)
                + ", порог просадки="
                + triggerLevel.ToString(CultureInfo.InvariantCulture)
                + ", новый пик="
                + (_portfolioPeakValue?.ValueDecimal ?? 0m).ToString(CultureInfo.InvariantCulture)
                + ", фейковый режим="
                + (enableFakeModeOnTrigger ? "вкл." : "без изменений");

            string dedupeKey = "peak|" + decisionTime.Ticks;
            LogPortfolioDrawdownStopNotice(dedupeKey, portfolioStopHeadline, portfolioStopMsg);
            return true;
        }

        private void ScreenerTab_PositionOpeningSuccesEvent(Position position, BotTabSimple tab)
        {
            if (position == null || tab == null)
            {
                return;
            }

            DateTime candleTime = tab.CandlesAll != null && tab.CandlesAll.Count > 0
                ? tab.CandlesAll[tab.CandlesAll.Count - 1].TimeStart
                : DateTime.Now;
            DateTime decisionTime = GetDecisionTime(tab, candleTime);

            TryRefreshPortfolioStopBaselineOnFirstEntry(tab, position, decisionTime);

            if (!IsOurBotPosition(position) || IsMoneyMarketFundTradeTab(tab))
            {
                return;
            }

            if (string.Equals(position.SignalTypeOpen, SignalProfitCollection, StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            TryCollectProfitToMoneyMarketFund(tab);

            // Shadow virtual portfolio: mirror real trades when фейковый режим 1 выключен.
            if (!IsRealTradingBlockedByFakeMode())
            {
                string tabKey = GetFakePortfolioTabKey(tab);
                if (!string.IsNullOrWhiteSpace(tabKey))
                {
                    decimal entry = position.EntryPrice;
                    if (entry <= 0m && tab?.CandlesAll != null && tab.CandlesAll.Count > 0)
                    {
                        entry = tab.CandlesAll[tab.CandlesAll.Count - 1].Close;
                    }

                    _shadowVirtualPositions[tabKey] = new FakePortfolioVirtualPosition
                    {
                        Direction = position.Direction,
                        EntryPrice = entry,
                        Volume = position.OpenVolume,
                        OpenTime = position.TimeOpen
                    };

                    _shadowPositionsDirty = true;
                    MaybeSaveShadowVirtualPositions(force: false);
                }
            }
        }

        private void ScreenerTab_PositionClosingSuccesEvent(Position position, BotTabSimple tab)
        {
            if (position == null || tab == null || !IsOurBotPosition(position))
            {
                return;
            }

            if (IsMoneyMarketFundTradeTab(tab)
                || string.Equals(position.SignalTypeOpen, SignalProfitCollection, StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            TryCollectProfitToMoneyMarketFund(tab);

            if (!IsRealTradingBlockedByFakeMode())
            {
                string tabKey = GetFakePortfolioTabKey(tab);
                if (!string.IsNullOrWhiteSpace(tabKey))
                {
                    _shadowVirtualPositions.Remove(tabKey);
                    _shadowPositionsDirty = true;
                    MaybeSaveShadowVirtualPositions(force: false);
                }
            }
        }

        private bool IsMoneyMarketFundTradeTab(BotTabSimple tab)
        {
            if (tab == null)
            {
                return false;
            }

            if (TryGetActiveMoneyMarketFundPrefix(out string selectedPrefix)
                && (SecurityNameMatchesMoneyMarketFundPrefix(tab.Connector?.SecurityName, selectedPrefix)
                    || SecurityMatchesMoneyMarketFundPrefix(tab.Security, selectedPrefix)))
            {
                return true;
            }

            for (int i = 0; i < MoneyMarketFundPrefixOptions.Length; i++)
            {
                string prefix = MoneyMarketFundPrefixOptions[i];
                if (IsMoneyMarketFundPurchaseDisabled(prefix))
                {
                    continue;
                }

                if (SecurityNameMatchesMoneyMarketFundPrefix(tab.Connector?.SecurityName, prefix)
                    || SecurityMatchesMoneyMarketFundPrefix(tab.Security, prefix))
                {
                    return true;
                }
            }

            return false;
        }

        private bool IsOurBotPosition(Position position)
        {
            if (position == null)
            {
                return false;
            }

            string botType = GetNameStrategyType();
            return string.IsNullOrEmpty(position.NameBotClass)
                || string.Equals(position.NameBotClass, botType, StringComparison.OrdinalIgnoreCase);
        }

        private void EnsureScreenerChildTabsEventsOn()
        {
            if (_screenerTab?.Tabs == null)
            {
                return;
            }

            for (int i = 0; i < _screenerTab.Tabs.Count; i++)
            {
                BotTabSimple tab = _screenerTab.Tabs[i];
                if (tab != null && !tab.EventsIsOn)
                {
                    tab.EventsIsOn = true;
                }
            }
        }

        /// <summary>
        /// Страховка портфеля: заголовок + детали в System/User/Signal и Error (заметнее в логе OsEngine).
        /// </summary>
        private void LogPortfolioDrawdownStopNotice(string dedupeKey, string headline, string details)
        {
            if (string.IsNullOrWhiteSpace(dedupeKey)
                || string.IsNullOrWhiteSpace(headline)
                || !_loggedStopNoticeKeys.Add(dedupeKey))
            {
                return;
            }

            SendNewLogMessage(headline, LogMessageType.System);
            SendNewLogMessage(headline, LogMessageType.User);
            SendNewLogMessage(headline, LogMessageType.Signal);
            SendNewLogMessage(headline, LogMessageType.Error);

            if (!string.IsNullOrWhiteSpace(details))
            {
                SendNewLogMessage(details, LogMessageType.System);
                SendNewLogMessage(details, LogMessageType.User);
                SendNewLogMessage(details, LogMessageType.Error);
            }

            if (_loggedStopNoticeKeys.Count > 500)
            {
                _loggedStopNoticeKeys.Clear();
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


            EnsureIndicator(
                NumVolumeIndicator,
                "Volume",
                new List<string>(),
                AreaSecond,
                _useVolumeIndicator.ValueBool);


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


            SyncPortfolioIndicator();
        }

        /// <summary>
        /// Индикатор портфеля по И-группам (Second): зеркалит включённые индикаторы и их параметры робота.
        /// </summary>
        private void SyncPortfolioIndicator()
        {
            IndicatorOnTabs existing = _screenerTab._indicators.FirstOrDefault(i => i.Num == NumPortfolioIndicator);

            if (_checkStrategySuccess.ValueBool)
            {
                if (existing == null)
                {
                    var ind = new IndicatorOnTabs
                    {
                        Num = NumPortfolioIndicator,
                        Type = PortfolioIndicatorType,
                        NameArea = AreaSecond,
                        Parameters = new List<string>(),
                        CanDelete = false
                    };
                    _screenerTab._indicators.Add(ind);
                }
                else
                {
                    existing.Type = PortfolioIndicatorType;
                    existing.NameArea = AreaSecond;
                    existing.Parameters = new List<string>();
                    existing.CanDelete = false;
                }
            }
            else if (existing != null)
            {
                _screenerTab._indicators.Remove(existing);
                string expectedName = NumPortfolioIndicator + PortfolioIndicatorType + _screenerTab.TabName;

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

            if (_checkStrategySuccess.ValueBool)
            {
                min = Math.Max(min, PortfolioSuccessRisingBars);
            }

            return min;
        }

        /// <summary>
        /// Главный цикл: стопы, расписание, фильтры, сигналы, вход/выход/реверс.
        /// </summary>
        #endregion

        #region Торговая логика (сигналы, вход, выход)

        private static string GetAggregatedCandleTabKey(BotTabSimple tab)
        {
            if (!string.IsNullOrEmpty(tab?.TabName))
            {
                return tab.TabName;
            }

            return tab?.Connector?.SecurityName ?? "";
        }

        /// <summary>После последней вкладки на candleTime — один sync фейка, пик и проверка стопов.</summary>
        private bool TryFlushAggregatedCandleStopsIfComplete(
            BotTabSimple tab,
            DateTime candleTime,
            DateTime decisionTime)
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

            FlushAggregatedCandleStops(decisionTime);
            return true;
        }

        /// <summary>Суммы на вкладке «Стопы»: один раз на «общую свечу», без SaveParameters на каждой бумаге.</summary>
        private void FlushAggregatedCandleStops(DateTime decisionTime)
        {
            BotTabSimple refTab = TryGetPortfolioMonitoringReferenceTab();
            if (refTab == null && _screenerTab?.Tabs != null && _screenerTab.Tabs.Count > 0)
            {
                refTab = _screenerTab.Tabs[0];
            }

            if (refTab == null)
            {
                return;
            }

            if (!IsRealTradingBlockedByFakeMode())
            {
                SyncFakePortfolioAmountFromRealPortfolio(refTab, refreshParameterGui: false, silent: true);
            }
            else
            {
                EnsureFakePortfolioAmountAlignedWithReal(refTab, refreshParameterGui: false, silent: true);
                TryResumeRealTradingWhenFakeExceedsDrawdownBaseline(refTab);
            }

            TryManagePortfolioDrawdownStop(refTab, decisionTime);
        }

        private void ScreenerTab_CandleFinishedEvent(List<Candle> candles, BotTabSimple tab)
        {
            if (candles == null || candles.Count == 0)
            {
                return;
            }

            DateTime candleTime = candles[^1].TimeStart;

            try
            {
                ScreenerTab_CandleFinishedEventCore(candles, tab);
            }
            finally
            {
                if (_regime.ValueString != "Off")
                {
                    DateTime decisionTime = GetDecisionTime(tab, candleTime);
                    TryFlushAggregatedCandleStopsIfComplete(tab, candleTime, decisionTime);
                }
            }
        }

        private void ScreenerTab_CandleFinishedEventCore(List<Candle> candles, BotTabSimple tab)
        {
            TryEnsureRobotIndicatorsOnTabIfNeeded(tab);

            DateTime decisionTime = GetDecisionTime(tab, candles[^1].TimeStart);

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

            LogTradingModeDiagnosticsOnce(tab);

            if (candles == null || candles.Count == 0)
            {
                return;
            }

            int minBars = GetMinBarsForTradingLogic();
            if (candles.Count < minBars)
            {
                return;
            }

            if (_tradePeriodsSettings.CanTradeThisTime(candles[^1].TimeStart) == false)
            {
                return;
            }


            List<Position> positions = tab.PositionsOpenAll;

            FakePortfolioVirtualPosition fakeOpen = null;
            bool haveFakeOpen = IsRealTradingBlockedByFakeMode()
                && TryGetFakeVirtualPosition(tab, out fakeOpen);
            bool haveOpenPos = haveFakeOpen
                || (positions != null && positions.Count > 0 && positions.Any(p => p.State == PositionStateType.Open));
            Position firstOpen = haveFakeOpen
                ? null
                : (haveOpenPos ? positions.FirstOrDefault(p => p.State == PositionStateType.Open) : null);

            int timeExitCandles = _timeExitCandles?.ValueInt ?? 0;
            if (timeExitCandles > 0 && haveOpenPos)
            {
                // Exit by time: only if position is NOT in profit and open bars > threshold.
                if (fakeOpen != null)
                {
                    if (TryCloseFakePositionByTime(candles, tab, fakeOpen, timeExitCandles))
                    {
                        TryResumeRealTradingIfFakeMode(tab);
                        return;
                    }
                }
                else if (firstOpen != null)
                {
                    if (TryCloseRealPositionByTime(candles, tab, firstOpen, timeExitCandles))
                    {
                        TryResumeRealTradingIfFakeMode(tab);
                        return;
                    }
                }
            }

            if (haveOpenPos == false
                && _checkVolatilityCluster.ValueBool
                && CheckVolatilityCluster(candles[^1].TimeStart, tab) == false)
            {
                return;
            }

            if (!haveOpenPos)
            {
                bool bullEntry = IsBullSignal(candles, tab, checkPortfolioSuccess: true);
                bool bearEntry = IsBearSignal(candles, tab, checkPortfolioSuccess: true);
                ApplyEntryExitSignalTransforms(ref bullEntry, ref bearEntry);

                if (!bullEntry && !bearEntry)
                {
                    return;
                }

                if (_regime.ValueString == "OnlyClosePosition")
                {
                    return;
                }

                if (GetScreenerOpenTradeSlotsCount() >= _maxPositions.ValueInt)
                {
                    return;
                }

                TryOpenOnSignal(candles, tab, bullEntry, bearEntry);
                TryResumeRealTradingIfFakeMode(tab);
                return;
            }

            bool bullExit = IsBullSignal(candles, tab, checkPortfolioSuccess: false);
            bool bearExit = IsBearSignal(candles, tab, checkPortfolioSuccess: false);
            ApplyEntryExitSignalTransforms(ref bullExit, ref bearExit);

            if (fakeOpen != null)
            {
                if (!bullExit && !bearExit)
                {
                    return;
                }

                TryCloseOrReverseFake(candles, tab, fakeOpen, bullExit, bearExit);
                TryResumeRealTradingIfFakeMode(tab);
                return;
            }

            if (firstOpen == null)
            {
                return;
            }

            if (!bullExit && !bearExit)
            {
                return;
            }

            TryCloseOrReverse(candles, tab, firstOpen, bullExit, bearExit);
            TryResumeRealTradingIfFakeMode(tab);
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
        /// Разбор «№ И-группы»: числа через запятую; 0 → 1; минус = NOT в этой группе.
        /// </summary>
        private static List<int> ParseIndicatorGroupNumbers(string raw)
        {
            List<int> result = new List<int>();
            if (string.IsNullOrWhiteSpace(raw))
            {
                result.Add(1);
                return result;
            }

            string[] parts = raw.Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries);
            for (int i = 0; i < parts.Length; i++)
            {
                string part = parts[i].Trim();
                if (part.Length == 0)
                {
                    continue;
                }

                if (!int.TryParse(part, NumberStyles.Integer, CultureInfo.InvariantCulture, out int value)
                    && !int.TryParse(part, NumberStyles.Integer, CultureInfo.CurrentCulture, out value))
                {
                    continue;
                }

                if (value == 0)
                {
                    value = 1;
                }

                result.Add(value);
            }

            if (result.Count == 0)
            {
                result.Add(1);
            }

            return result;
        }

        /// <summary>И-группы (|№|) включённых в работе индикаторов.</summary>
        private HashSet<int> GetActiveIndicatorGroupIds()
        {
            var ids = new HashSet<int>();

            void AddFrom(StrategyParameterString groupParam, bool enabled)
            {
                if (!enabled || groupParam == null)
                {
                    return;
                }

                List<int> parsed = ParseIndicatorGroupNumbers(groupParam.ValueString);
                for (int i = 0; i < parsed.Count; i++)
                {
                    ids.Add(Math.Abs(parsed[i]));
                }
            }

            AddFrom(_smaAndGroup, _useSma.ValueBool);
            AddFrom(_rsiAndGroup, _useRsi.ValueBool);
            AddFrom(_stochAndGroup, _useStoch.ValueBool);
            AddFrom(_momAndGroup, _useMomentum.ValueBool);
            AddFrom(_bollAndGroup, _useBollinger.ValueBool);
            AddFrom(_linRegAndGroup, _useLinReg.ValueBool);
            AddFrom(_volumeAndGroup, _useVolumeIndicator.ValueBool);
            AddFrom(_vwapAndGroup, _useVwap.ValueBool);
            AddFrom(_atrAndGroup, _useAtr.ValueBool);
            AddFrom(_macdAndGroup, _useMacd.ValueBool);

            return ids;
        }

        /// <summary>
        /// Копирует в индикатор портфеля параметры робота (Use*, длины, пороги, И-группы).
        /// </summary>
        private void ApplyPortfolioIndicatorParamsFromRobot(Aindicator indicator)
        {
            if (indicator?.Parameters == null)
            {
                return;
            }

            SetIndicatorParamBool(indicator, InvertEntryLogicSwapParamName, IsEntryLogicSwapEnabled());
            SetIndicatorParamBool(indicator, "Use SMA", _useSma.ValueBool);
            SetIndicatorParamBool(indicator, "Use RSI", _useRsi.ValueBool);
            SetIndicatorParamBool(indicator, "Use Stochastic", _useStoch.ValueBool);
            SetIndicatorParamBool(indicator, "Use Momentum", _useMomentum.ValueBool);
            SetIndicatorParamBool(indicator, "Use Bollinger", _useBollinger.ValueBool);
            SetIndicatorParamBool(indicator, "Use Linear Regression", _useLinReg.ValueBool);
            SetIndicatorParamBool(indicator, "Use Volume indicator", _useVolumeIndicator.ValueBool);
            SetIndicatorParamBool(indicator, "Use VWAP", _useVwap.ValueBool);
            SetIndicatorParamBool(indicator, "Use ATR", _useAtr.ValueBool);
            SetIndicatorParamBool(indicator, "Use MACD", _useMacd.ValueBool);

            SetIndicatorParamInt(indicator, "SMA length", _smaLen.ValueInt);
            SetIndicatorParamInt(indicator, "RSI length", _rsiLen.ValueInt);
            SetIndicatorParamDecimal(indicator, "RSI long min", _rsiLongMin.ValueDecimal);
            SetIndicatorParamDecimal(indicator, "RSI short max", _rsiShortMax.ValueDecimal);
            SetIndicatorParamInt(indicator, "Stoch P1", _stochP1.ValueInt);
            SetIndicatorParamInt(indicator, "Stoch P2", _stochP2.ValueInt);
            SetIndicatorParamInt(indicator, "Stoch P3", _stochP3.ValueInt);
            SetIndicatorParamDecimal(indicator, "Stoch long min", _stochLongMin.ValueDecimal);
            SetIndicatorParamDecimal(indicator, "Stoch short max", _stochShortMax.ValueDecimal);
            SetIndicatorParamInt(indicator, "Momentum length", _momLen.ValueInt);
            SetIndicatorParamDecimal(indicator, "Momentum long min", _momLongMin.ValueDecimal);
            SetIndicatorParamDecimal(indicator, "Momentum short max", _momShortMax.ValueDecimal);
            SetIndicatorParamInt(indicator, "Bollinger length", _bollLen.ValueInt);
            SetIndicatorParamDecimal(indicator, "Bollinger deviation", _bollDev.ValueDecimal);
            SetIndicatorParamInt(indicator, "LinReg length", _linRegLen.ValueInt);
            SetIndicatorParamDecimal(indicator, "LinReg deviation", _linRegDev.ValueDecimal);
            SetIndicatorParamDecimal(indicator, "Volume vs prev candle min growth %", _volumeIndicatorMinGrowthPercent.ValueDecimal);
            SetIndicatorParamBool(indicator, "Volume: сравнение с тем же временем прошлых дней", _useVolumeTodCompare.ValueBool);
            SetIndicatorParamInt(indicator, "Volume TOD: число прошлых торг. дней", _volumeTodPastDays.ValueInt);
            SetIndicatorParamDecimal(indicator, "Volume TOD: мин. отношение к среднему", _volumeTodMinRelativeRatio.ValueDecimal);
            SetIndicatorParamInt(indicator, "ATR length", _atrLen.ValueInt);
            SetIndicatorParamDecimal(indicator, "ATR min grow % vs lookback", _atrGrowPercent.ValueDecimal);
            SetIndicatorParamInt(indicator, "ATR grow lookback (candles)", _atrGrowLookBack.ValueInt);
            SetIndicatorParamInt(indicator, "MACD fast length", _macdFastLen.ValueInt);
            SetIndicatorParamInt(indicator, "MACD slow length", _macdSlowLen.ValueInt);
            SetIndicatorParamInt(indicator, "MACD signal length", _macdSignalLen.ValueInt);

            SetIndicatorParamString(indicator, "SMA: № И-группы (через запятую)", _smaAndGroup.ValueString);
            SetIndicatorParamString(indicator, "RSI: № И-группы (через запятую)", _rsiAndGroup.ValueString);
            SetIndicatorParamString(indicator, "Stochastic: № И-группы (через запятую)", _stochAndGroup.ValueString);
            SetIndicatorParamString(indicator, "Momentum: № И-группы (через запятую)", _momAndGroup.ValueString);
            SetIndicatorParamString(indicator, "Bollinger: № И-группы (через запятую)", _bollAndGroup.ValueString);
            SetIndicatorParamString(indicator, "LinReg: № И-группы (через запятую)", _linRegAndGroup.ValueString);
            SetIndicatorParamString(indicator, "Volume ind.: № И-группы (через запятую)", _volumeAndGroup.ValueString);
            SetIndicatorParamString(indicator, "VWAP: № И-группы (через запятую)", _vwapAndGroup.ValueString);
            SetIndicatorParamString(indicator, "ATR: № И-группы (через запятую)", _atrAndGroup.ValueString);
            SetIndicatorParamString(indicator, "MACD: № И-группы (через запятую)", _macdAndGroup.ValueString);
        }

        private static void SetIndicatorParamBool(Aindicator indicator, string name, bool value)
        {
            IndicatorParameter param = indicator.Parameters.Find(p => p.Name == name);
            if (param is IndicatorParameterBool b)
            {
                b.ValueBool = value;
            }
        }

        private static void SetIndicatorParamInt(Aindicator indicator, string name, int value)
        {
            IndicatorParameter param = indicator.Parameters.Find(p => p.Name == name);
            if (param is IndicatorParameterInt i)
            {
                i.ValueInt = value;
            }
        }

        private static void SetIndicatorParamDecimal(Aindicator indicator, string name, decimal value)
        {
            IndicatorParameter param = indicator.Parameters.Find(p => p.Name == name);
            if (param is IndicatorParameterDecimal d)
            {
                d.ValueDecimal = value;
            }
        }

        private static void SetIndicatorParamString(Aindicator indicator, string name, string value)
        {
            IndicatorParameter param = indicator.Parameters.Find(p => p.Name == name);
            if (param is IndicatorParameterString s)
            {
                s.ValueString = value;
            }
        }

        private static void TryRebuildPortfolioIndicatorSeries(Aindicator indicator)
        {
            if (indicator == null)
            {
                return;
            }

            MethodInfo method = indicator.GetType().GetMethod(
                "RebuildGroupSeriesFromRobot",
                BindingFlags.Public | BindingFlags.Instance);
            method?.Invoke(indicator, null);
        }

        /// <summary>
        /// Серия портфеля по группе: последние 3 значения строго растут (старшая свеча &lt; следующая).
        /// </summary>
        private static bool IsPortfolioSeriesRisingLastBars(Aindicator portfolio, int groupId, int candleIndex)
        {
            if (portfolio?.DataSeries == null)
            {
                return false;
            }

            string seriesName = PortfolioSeriesNamePrefix + groupId + "|";
            IndicatorDataSeries series = portfolio.DataSeries.Find(s => s.Name == seriesName);
            if (series?.Values == null || candleIndex < PortfolioSuccessRisingBars - 1)
            {
                return false;
            }

            if (series.Values.Count <= candleIndex)
            {
                return false;
            }

            decimal v2 = series.Values[candleIndex - 2];
            decimal v1 = series.Values[candleIndex - 1];
            decimal v0 = series.Values[candleIndex];
            return v2 < v1 && v1 < v0;
        }

        /// <summary>
        /// При «Проверять успешность стратегии» (только вход): все активные И-группы — рост портфеля за 3 свечи.
        /// </summary>
        private bool IsPortfolioStrategySuccessful(BotTabSimple tab, int candleIndex)
        {
            if (!_checkStrategySuccess.ValueBool)
            {
                return true;
            }

            Aindicator portfolio = FindIndicator(tab, NumPortfolioIndicator, PortfolioIndicatorType);
            if (portfolio == null)
            {
                return false;
            }

            HashSet<int> groupIds = GetActiveIndicatorGroupIds();
            if (groupIds.Count == 0)
            {
                return true;
            }

            foreach (int groupId in groupIds)
            {
                if (!IsPortfolioSeriesRisingLastBars(portfolio, groupId, candleIndex))
                {
                    return false;
                }
            }

            return true;
        }

        /// <summary>
        /// Добавляет результат индикатора во все группы из строки параметра (|g|, pass с учётом знака).
        /// Выключенный индикатор: passResult == null — запись не добавляется.
        /// </summary>
        private static void AddGroupedIndicatorResult(List<(int group, bool pass)> items, StrategyParameterString groupParam, bool? passResult)
        {
            if (!passResult.HasValue || groupParam == null)
            {
                return;
            }

            List<int> groupNumbers = ParseIndicatorGroupNumbers(groupParam.ValueString);
            bool pass = passResult.Value;

            for (int i = 0; i < groupNumbers.Count; i++)
            {
                int raw = groupNumbers[i];
                int groupKey = Math.Abs(raw);
                bool groupPass = pass;
                if (raw < 0)
                {
                    groupPass = !groupPass;
                }

                items.Add((groupKey, groupPass));
            }
        }

        /// <summary>
        /// Сводит список (ключ_группы = |исходный_номер|, результат с учётом знака) к одному булеву значению:
        /// внутри каждой группы — И всех pass; между группами — ИЛИ.
        /// Пустой список: true (нет включённых индикаторов — не блокируем вход).
        /// </summary>
        private static bool CombineGroupedOrOfAnds(List<(int group, bool pass)> items)
        {
            if (items.Count == 0)
            {
                return true;
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
                RefreshTabIndicators(_screenerTab.Tabs[i]);
            }
        }

        /// <summary>
        /// После смены параметров робота — пересчитать индикаторы на одной вкладке.
        /// </summary>
        private void RefreshTabIndicators(BotTabSimple tab)
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

            if (_checkStrategySuccess.ValueBool)
            {
                Aindicator portfolio = FindIndicator(tab, NumPortfolioIndicator, PortfolioIndicatorType);
                if (portfolio != null)
                {
                    ApplyPortfolioIndicatorParamsFromRobot(portfolio);
                    TryRebuildPortfolioIndicatorSeries(portfolio);
                    portfolio.Reload();
                }
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
        /// Swap покупка↔продажа по параметру «Инверсия логики (покупка и продажа меняются местами)».
        /// </summary>
        private void ApplyEntryExitSignalTransforms(ref bool bull, ref bool bear)
        {
            if (!IsEntryLogicSwapEnabled())
            {
                return;
            }

            bool tmp = bull;
            bull = bear;
            bear = tmp;
        }

        /// <summary>Бычий сигнал на свече candleIndex.</summary>
        private bool IsBullSignalAt(List<Candle> candles, BotTabSimple tab, int candleIndex, bool checkPortfolioSuccess)
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
            AddGroupedIndicatorResult(items, _vwapAndGroup, BullVwapPasses(close, tab, candleIndex));
            AddGroupedIndicatorResult(items, _atrAndGroup, BullAtrPasses(tab, candleIndex));
            AddGroupedIndicatorResult(items, _macdAndGroup, BullMacdPasses(tab, candleIndex));

            if (!CombineGroupedOrOfAnds(items))
            {
                return false;
            }

            if (checkPortfolioSuccess && !IsPortfolioStrategySuccessful(tab, candleIndex))
            {
                return false;
            }

            return !VolumeTodFilterBlocksSignal(candles, candleIndex);
        }

        /// <summary>Медвежий сигнал на свече candleIndex.</summary>
        private bool IsBearSignalAt(List<Candle> candles, BotTabSimple tab, int candleIndex, bool checkPortfolioSuccess)
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
            AddGroupedIndicatorResult(items, _vwapAndGroup, BearVwapPasses(close, tab, candleIndex));
            AddGroupedIndicatorResult(items, _atrAndGroup, BearAtrPasses(tab, candleIndex));
            AddGroupedIndicatorResult(items, _macdAndGroup, BearMacdPasses(tab, candleIndex));

            if (!CombineGroupedOrOfAnds(items))
            {
                return false;
            }

            if (checkPortfolioSuccess && !IsPortfolioStrategySuccessful(tab, candleIndex))
            {
                return false;
            }

            return !VolumeTodFilterBlocksSignal(candles, candleIndex);
        }

        /// <summary>Бычий сигнал на последней свече.</summary>
        private bool IsBullSignal(List<Candle> candles, BotTabSimple tab, bool checkPortfolioSuccess)
        {
            if (candles == null || candles.Count == 0 || tab == null)
            {
                return false;
            }

            return IsBullSignalAt(candles, tab, candles.Count - 1, checkPortfolioSuccess);
        }

        /// <summary>Медвежий сигнал на последней свече.</summary>
        private bool IsBearSignal(List<Candle> candles, BotTabSimple tab, bool checkPortfolioSuccess)
        {
            if (candles == null || candles.Count == 0 || tab == null)
            {
                return false;
            }

            return IsBearSignalAt(candles, tab, candles.Count - 1, checkPortfolioSuccess);
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


        /// <summary>
        /// Рост объёма свечи vs предыдущая.
        /// </summary>
        private bool? BullVolumePasses(List<Candle> candles, BotTabSimple tab, int candleIndex = -1)
        {
            if (!_useVolumeIndicator.ValueBool)
                return null;
            return VolumeIndicatorGrowthOk(candles, tab, candleIndex);
        }


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

            if (candleIndex < 0)
            {
                if (atr.DataSeries[0].Values == null || atr.DataSeries[0].Values.Count == 0)
                {
                    return false;
                }

                candleIndex = atr.DataSeries[0].Values.Count - 1;

                if (candleIndex < 0)
                {
                    return false;
                }
            }

            if (candleIndex < lookBack)
            {
                return false;
            }

            decimal atrLast = SeriesValueAt(atr, 0, candleIndex);
            decimal atrPast = SeriesValueAt(atr, 0, candleIndex - lookBack);

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


        /// <summary>
        /// Рост объёма (то же условие, что для лонга).
        /// </summary>
        private bool? BearVolumePasses(List<Candle> candles, BotTabSimple tab, int candleIndex = -1)
        {
            if (!_useVolumeIndicator.ValueBool)
                return null;
            return VolumeIndicatorGrowthOk(candles, tab, candleIndex);
        }


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
        /// Intraday: curVol / средний объём баров с тем же TimeOfDay на прошлых торговых днях.
        /// </summary>
        private bool VolumeTodIntradayOk(List<Candle> logicCandles, int candleIndex)
        {
            if (logicCandles == null || logicCandles.Count == 0)
            {
                return false;
            }

            int idx = candleIndex >= 0 ? candleIndex : logicCandles.Count - 1;
            if (idx < 0)
            {
                return false;
            }

            Candle cur = logicCandles[idx];
            decimal curVol = cur.Volume;
            if (curVol <= 0m)
            {
                return false;
            }

            TimeSpan slotTime = cur.TimeStart.TimeOfDay;
            DateTime curDate = cur.TimeStart.Date;
            int needDays = Math.Max(1, _volumeTodPastDays.ValueInt);
            decimal minRatio = _volumeTodMinRelativeRatio.ValueDecimal;
            if (minRatio <= 0m)
            {
                minRatio = 0.1m;
            }

            List<decimal> pastVolumes = new List<decimal>(needDays);
            HashSet<DateTime> usedDates = new HashSet<DateTime>();

            for (int i = idx - 1; i >= 0 && pastVolumes.Count < needDays; i--)
            {
                Candle c = logicCandles[i];
                if (c.TimeStart.Date == curDate)
                {
                    continue;
                }

                if (c.TimeStart.TimeOfDay != slotTime)
                {
                    continue;
                }

                if (!usedDates.Add(c.TimeStart.Date))
                {
                    continue;
                }

                pastVolumes.Add(c.Volume);
            }

            if (pastVolumes.Count == 0)
            {
                return false;
            }

            decimal sum = 0m;
            for (int i = 0; i < pastVolumes.Count; i++)
            {
                sum += pastVolumes[i];
            }

            decimal avg = sum / pastVolumes.Count;
            if (avg <= 0m)
            {
                return curVol > 0m;
            }

            return curVol / avg >= minRatio;
        }

        /// <summary>
        /// Глобальный фильтр ликвидности: при включённом TOD блокирует bull/bear сигнал.
        /// </summary>
        private bool VolumeTodFilterBlocksSignal(List<Candle> logicCandles, int candleIndex)
        {
            if (!_useVolumeTodCompare.ValueBool)
            {
                return false;
            }

            return !VolumeTodIntradayOk(logicCandles, candleIndex);
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
            if (StartProgram == StartProgram.IsOsTrader
                && tab?.Connector != null
                && (!tab.Connector.IsConnected || !tab.Connector.IsReadyToTrade))
            {
                LogConnectorNotReadyForEntryOnce(tab);
                return;
            }

            decimal volume = GetVolume(tab);
            if (volume <= 0m)
            {
                LogZeroVolumeOnEntryOnce(tab);
                return;
            }

            decimal close = candles[candles.Count - 1].Close;
            decimal slip = _slippage.ValueInt * tab.Security.PriceStep;
            if (bull && _regime.ValueString != "OnlyShort")
            {
                ExecuteBuyOpen(tab, volume, GetOpenLongLimitPrice(tab, close, slip));
            }
            else if (bear && _regime.ValueString != "OnlyLong")
            {
                ExecuteSellOpen(tab, volume, GetOpenShortLimitPrice(tab, close, slip));
            }
        }

        /// <summary>
        /// Закрытие или реверс виртуальной позиции в фейковом режиме.
        /// </summary>
        private void TryCloseOrReverseFake(
            List<Candle> candles,
            BotTabSimple tab,
            FakePortfolioVirtualPosition virtualPosition,
            bool bull,
            bool bear)
        {
            if (virtualPosition == null)
            {
                return;
            }

            decimal close = candles[candles.Count - 1].Close;
            decimal slip = _slippage.ValueInt * tab.Security.PriceStep;

            if (virtualPosition.Direction == Side.Buy && bear)
            {
                ExecuteFakeCloseOnSignalCandle(tab, virtualPosition, close, slip);

                if (_regime.ValueString != "OnlyLong" && _regime.ValueString != "OnlyClosePosition")
                {
                    if (GetScreenerOpenTradeSlotsCount() < _maxPositions.ValueInt)
                    {
                        ExecuteSellOpen(tab, GetVolume(tab), GetOpenShortLimitPrice(tab, close, slip));
                    }
                }
            }
            else if (virtualPosition.Direction == Side.Sell && bull)
            {
                ExecuteFakeCloseOnSignalCandle(tab, virtualPosition, close, slip);

                if (_regime.ValueString != "OnlyShort" && _regime.ValueString != "OnlyClosePosition")
                {
                    if (GetScreenerOpenTradeSlotsCount() < _maxPositions.ValueInt)
                    {
                        ExecuteBuyOpen(tab, GetVolume(tab), GetOpenLongLimitPrice(tab, close, slip));
                    }
                }
            }
        }

        private void ExecuteFakeCloseOnSignalCandle(
            BotTabSimple tab,
            FakePortfolioVirtualPosition virtualPosition,
            decimal close,
            decimal slip)
        {
            decimal limitPrice = virtualPosition.Direction == Side.Buy
                ? ApplyRandomPriceShift(close - slip, tab)
                : ApplyRandomPriceShift(close + slip, tab);
            ApplyFakePortfolioClose(tab, virtualPosition, limitPrice);
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
            _lastVolumeCalcFailureReason = null;

            if (tab == null)
            {
                _lastVolumeCalcFailureReason = "вкладка=null";
                return 0m;
            }

            decimal volume = 0m;

            if (_volumeType.ValueString == "Contracts")
            {
                volume = _volume.ValueDecimal;
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

                    volume = RoundVolumeWithMinimum(tab, volume);
                }
                else
                {
                    volume = Math.Round(volume, 6);
                    if (volume <= 0m && _volume.ValueDecimal > 0m)
                    {
                        _lastVolumeCalcFailureReason = "объём после округления ≤ 0 (Contract currency)";
                    }
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
                    if (!IsRealTradingBlockedByFakeMode())
                    {
                        SendNewLogMessage(
                            "Can`t found portfolio " + _tradeAssetInPortfolio.ValueString,
                            LogMessageType.Error);
                    }

                    return 0m;
                }

                if (!TryResolveReferencePriceForVolume(tab, out decimal referencePrice))
                {
                    _lastVolumeCalcFailureReason = "нет цены (BestAsk/Bid/Close)=0";
                    return 0m;
                }

                decimal portfolioPrimeAsset = portfolioAsset.Value;
                decimal moneyOnPosition = portfolioPrimeAsset * (_volume.ValueDecimal / 100m);
                decimal lot = tab.Security?.Lot > 0m ? tab.Security.Lot : 1m;
                decimal qty = moneyOnPosition / referencePrice / lot;

                if (tab.StartProgram == StartProgram.IsOsTrader
                    && tab.Security != null
                    && tab.Security.UsePriceStepCostToCalculateVolume
                    && tab.Security.PriceStep != tab.Security.PriceStepCost
                    && tab.Security.PriceStep != 0m
                    && tab.Security.PriceStepCost != 0m)
                {
                    qty = moneyOnPosition / (referencePrice / tab.Security.PriceStep * tab.Security.PriceStepCost);
                }

                if (tab.StartProgram == StartProgram.IsOsTrader)
                {
                    qty = RoundVolumeWithMinimum(tab, qty);
                }
                else
                {
                    qty = Math.Round(qty, 7);
                }

                if (qty <= 0m)
                {
                    _lastVolumeCalcFailureReason =
                        "доля депозита дала < 1 лота (portfolio="
                        + portfolioPrimeAsset.ToString(CultureInfo.InvariantCulture)
                        + ", %="
                        + _volume.ValueDecimal.ToString(CultureInfo.InvariantCulture)
                        + ", price="
                        + referencePrice.ToString(CultureInfo.InvariantCulture)
                        + ")";
                }

                return qty;
            }

            _lastVolumeCalcFailureReason = "неизвестный Volume type";
            return volume;
        }

        /// <summary>BestAsk → BestBid → Close последней свечи (для фьючерсов BestAsk часто 0 до первого стакана).</summary>
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

        private static decimal RoundVolumeWithMinimum(BotTabSimple tab, decimal volume)
        {
            if (tab?.Security == null)
            {
                return Math.Round(volume, 6);
            }

            decimal rounded = Math.Round(volume, tab.Security.DecimalsVolume);
            if (rounded > 0m)
            {
                return rounded;
            }

            if (volume <= 0m)
            {
                return 0m;
            }

            decimal minVolume = tab.Security.Lot > 0m ? tab.Security.Lot : 1m;
            return minVolume;
        }

        private const string HintIndicatorGroup =
            "Номера И-групп через запятую (например: 1, 2 или -3). "
            + "Один индикатор может входить в несколько групп. "
            + "Внутри группы |№| все его условия связаны И; между разными |№| — ИЛИ. "
            + "Минус перед номером — инверсия (NOT) результата в этой группе.";

        private bool _parameterHintsRegistrationLogged;
        private bool _parameterHintsUnsupportedLogged;

        /// <summary>
        /// Подсказки при наведении на строки параметров (reflection — совместимость со старым OsEngine.dll).
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
                "Режим торговли робота.\n"
                + "Off — логика не торгует.\n"
                + "On — покупки и продажи по сигналам.\n"
                + "OnlyLong / OnlyShort — только одна сторона.\n"
                + "OnlyClosePosition — только закрытие открытых позиций, без новых входов.");
            Hint("Остановить робота и продать всё",
                "Экстренная остановка: закрывает все позиции скринера по рынку и переводит Regime в Off.");
            Hint("Max positions (all tabs)",
                "Максимум одновременно открытых позиций по всем вкладкам скринера (суммарный лимит слотов).");
            Hint("Slippage (steps)",
                "Допустимое проскальзывание в шагах цены при выставлении лимитных заявок.");
            Hint("Тип заявок (вход и выход)",
                "Способ исполнения заявок: Лимит (по цене с учётом проскальзывания) или Рынок. "
                + "Применяется к входу, выходу, реверсу, расписанию, стопам портфеля и «продать всё».");
            Hint("Инверсия логики (покупка и продажа меняются местами)",
                "Если включено: покупка и продажа меняются местами — бычий сигнал → продажа, медвежий → покупка "
                + "(то же при закрытии и реверсе).");
            Hint("Проверять успешность стратегии",
                "Если включено: на график — индикатор портфеля по И-группам (Second), параметры как у робота. "
                + "Доп. фильтр только на вход: у каждой активной И-группы серия «Портфель |№|» растёт 3 свечи подряд. "
                + "Выход и реверс — по обычным сигналам, без проверки портфельного индикатора.");
            Hint("Проверка кластера волатильности",
                "Если включено: новые позиции только на вкладках выбранного кластера волатильности.");
            Hint("Volatility cluster to trade",
                "Кластер 1–3 для нового входа. Работает с «Проверка кластера волатильности».");
            Hint("Volatility cluster lookBack", "Число свечей для расчёта кластеров волатильности.");
            Hint("Show last clusters", "Вывести в лог последнее распределение вкладок по кластерам.");
            Hint("Non trade periods", "Календарь периодов, когда новые сделки не открываются.");
            Hint("Дата-время начала работы (dd.MM.yyyy, dd.MM.yyyy HH:mm, yyyy-MM-dd, HH:mm; пусто = выкл.)",
                "До этого момента робот не торгует. Пусто — выкл. Форматы: дата, дата+время, только время.");
            Hint("Дата-время окончания работы (dd.MM.yyyy, dd.MM.yyyy HH:mm, yyyy-MM-dd, HH:mm; пусто = выкл.)",
                "После этого момента — закрытие всех позиций по рынку и остановка. Пусто — выкл.");
            Hint("Stop loss портфеля (просадка от базы)",
                "Страховка: при просадке реального портфеля от базы — закрытие и опционально фейковый режим.");
            Hint("Сумма портфеля (база просадки)",
                "База для stop loss / take profit портфеля. Кнопка «Заполнить сумму портфеля» или вручную.");
            Hint("Дата просадки", "Дата последнего срабатывания стопа портфеля (робот).");
            Hint("Stop loss портфеля от базы, %", "Просадка от базы в % для срабатывания защиты.");
            Hint("Переводить робота в фейковый режим 1 при срабатывании стопа",
                "После stop loss портфеля включить «Фейковый режим 1».");
            Hint("Take profit портфеля (рост от базы)", "Фиксация прибыли портфеля от базы.");
            Hint("Take profit портфеля от базы, %", "Рост от базы в % для take profit.");
            Hint("Переводить робота в фейковый режим 1 при срабатывании профита",
                "После take profit включить «Фейковый режим 1».");
            Hint("Фейковый режим 1",
                "Виртуальные сделки без реальных заявок; shadow-портфель. Стопы — вкладка «Стопы».");
            Hint("Фейковая сумма портфеля", "Сумма виртуального портфеля в фейковом режиме.");
            Hint("Возобновлять торги при достижении предыдущего реального значения",
                "Фейковая сумма ≥ база до стопа (+0,1%) или ≥ реальный портфель (−0,1%) — снова реальная торговля.");
            Hint("Выход по времени, свечей",
                "Закрыть позицию после N свечей, если не в прибыли. 0 — выкл.");
            Hint("Просадка от пика", "Стоп от максимума отслеживаемого портфеля.");
            Hint("Просадка от пика, %", "Просадка от пика в %.");
            Hint("Пик портфеля", "Зафиксированный максимум для стопа «Просадка от пика».");
            Hint("Заполнить сумму портфеля",
                "Подставить текущую сумму в базу и фейковую сумму, выкл. фейковый режим. "
                + "В тестере — GodMode / Initial deposit на вкладке Portfolio сервера тестера.");
            Hint("Включить стопы и возобновление",
                "Сначала как «Заполнить сумму портфеля» (база, фейковая сумма, пик, дата), затем вкл. stop loss, take profit, "
                + "«Возобновлять торги…».");
            Hint("Отключить стопы и восстановление",
                "Выкл.: stop loss, take profit и «Возобновлять торги…».");
            Hint("Закупать фонд денежного рынка, префикс (TMON, LQDT, SBMM, Не закупать)",
                "Покупка ETF при превышении порога портфеля. «Не закупать» — выкл.");
            Hint("Порог суммы портфеля (закупка фонда только на превышение)",
                "Закупка только на сумму превышения над порогом.");
            Hint(CalculationsTargetAnnualPercentParamName,
                "Целевая доходность в % годовых для расчёта накопленных сумм.");
            Hint(CalculationsInitialPortfolioAmountParamName,
                "Стартовая сумма портфеля — вводится вручную. 0 = расчёт не выполняется.");
            Hint(CalculationsStartDateParamName,
                "Дата начала расчёта целевых сумм (dd.MM.yyyy). По умолчанию "
                + CalculationsStartDatePlaceholder
                + " — подсказка формата, замените на реальную дату.");
            Hint(CalculationsCalculateButtonName,
                "Заполнить текущую сумму портфеля и рассчитать накопленные целевые суммы "
                + "(простой процент и с капитализацией) от начальной суммы и даты.");
            Hint(CalculationsCurrentPortfolioAmountParamName,
                "Текущая сумма портфеля — заполняется кнопкой «Рассчитать».");
            Hint(CalculationsAccumulatedTargetAmountParamName,
                "Целевая сумма без капитализации: начальная × (1 + %/100 × дней/365).");
            Hint(CalculationsAccumulatedTargetWithCapitalizationParamName,
                "Целевая сумма с капитализацией: начальная × (1 + %/100)^(дней/365).");
            Hint("Префиксы корня тикера (T-Инвестиции; ROSN, LKOH; CNY — также CR, CNYRUBF)",
                "Корни тикеров фьючерсов для «Обновить фьючерсы».");
            Hint("Установить префиксы фьючерсов по умолчанию", "Стандартный список префиксов фьючерсов.");
            Hint("Установить расширенный список префиксов фьючерсов по умолчанию", "Расширенный список префиксов.");
            Hint("Обновить фьючерсы", "Перезагрузить вкладки по префиксам фьючерсов MOEX.");
            Hint("Тикеры акций (через запятую; T-Инвестиции, точное совпадение с Ticker)",
                "Тикеры акций для «Обновить акции».");
            Hint("Установить тикеры акций по умолчанию", "Стандартный список тикеров акций.");
            Hint("Обновить акции", "Перезагрузить вкладки по тикерам акций.");
            Hint("Volume type", "Объём: контракты, валюта контракта или % депозита актива.");
            Hint("Volume", "Размер позиции в единицах «Volume type».");
            Hint("Asset in portfolio",
                "От какой суммы на счёте считать процент при Volume type = Deposit percent.\n"
                + "Prime — вся стоимость портфеля (ValueCurrent); используется также для стопов, «Расчётов» и мониторинга.\n"
                + "rub или другой код — только баланс этого актива на борде (например, свободный кэш, не весь счёт).");
            Hint("Установить параметры индикаторов по умолчанию",
                "Сброс параметров индикаторов к значениям из кода робота.");
            Hint("Use SMA", "SMA на графике и в сигналах: long — close выше, short — ниже.");
            Hint("Use RSI", "RSI: long ≥ long min, short ≤ short max.");
            Hint("Use Stochastic", "Стохастик по порогам %K.");
            Hint("Use Momentum", "Momentum по порогам long/short.");
            Hint("Use Bollinger", "Bollinger: сигнал от положения close относительно полос.");
            Hint("Use Linear Regression", "Канал линейной регрессии для long/short.");
            Hint("Use Volume indicator", "Фильтр роста объёма свечи и опционально TOD.");
            Hint("Use VWAP", "Long — close выше VWAP, short — ниже.");
            Hint("Use ATR", "Рост ATR на % относительно lookback свечей назад.");
            Hint("Use MACD", "MACD: линия относительно сигнальной.");
            Hint("SMA length", "Период SMA.");
            Hint("RSI length", "Период RSI.");
            Hint("RSI long min", "Минимум RSI для long.");
            Hint("RSI short max", "Максимум RSI для short.");
            Hint("Stoch P1", "Период %K.");
            Hint("Stoch P2", "Сглаживание %K.");
            Hint("Stoch P3", "Период %D.");
            Hint("Stoch long min", "Минимум %K для long.");
            Hint("Stoch short max", "Максимум %K для short.");
            Hint("Momentum length", "Период Momentum.");
            Hint("Momentum long min", "Минимум Momentum для long.");
            Hint("Momentum short max", "Максимум Momentum для short.");
            Hint("Bollinger length", "Период Bollinger.");
            Hint("Bollinger deviation", "Множитель σ для полос.");
            Hint("LinReg length", "Длина канала LinReg.");
            Hint("LinReg deviation", "Отклонение границ канала, %.");
            Hint("Volume vs prev candle min growth %",
                "Мин. рост объёма к предыдущей свече, %.");
            Hint("Volume: сравнение с тем же временем прошлых дней",
                "Сравнение объёма с тем же временем за N торговых дней.");
            Hint("Volume TOD: число прошлых торг. дней", "Число дней для TOD-сравнения объёма.");
            Hint("Volume TOD: мин. отношение к среднему", "Мин. отношение объёма к среднему TOD.");
            Hint("ATR length", "Период ATR.");
            Hint("ATR min grow % vs lookback", "Мин. рост ATR в % к значению N свечей назад.");
            Hint("ATR grow lookback", "Смещение в свечах для сравнения ATR.");
            Hint("MACD fast length", "Быстрая EMA MACD.");
            Hint("MACD slow length", "Медленная EMA MACD.");
            Hint("MACD signal length", "Сигнальная линия MACD.");
            Hint("SMA: № И-группы (через запятую)", HintIndicatorGroup);
            Hint("RSI: № И-группы (через запятую)", HintIndicatorGroup);
            Hint("Stochastic: № И-группы (через запятую)", HintIndicatorGroup);
            Hint("Momentum: № И-группы (через запятую)", HintIndicatorGroup);
            Hint("Bollinger: № И-группы (через запятую)", HintIndicatorGroup);
            Hint("LinReg: № И-группы (через запятую)", HintIndicatorGroup);
            Hint("Volume ind.: № И-группы (через запятую)", HintIndicatorGroup);
            Hint("VWAP: № И-группы (через запятую)", HintIndicatorGroup);
            Hint("ATR: № И-группы (через запятую)", HintIndicatorGroup);
            Hint("MACD: № И-группы (через запятую)", HintIndicatorGroup);
            Hint("Рандомный сдвиг цен", "Случайный сдвиг цен свечей в тестере (не для лайва).");
            Hint("Рандомность движений, %", "Амплитуда случайного сдвига, %.");

            if (!_parameterHintsRegistrationLogged)
            {
                _parameterHintsRegistrationLogged = true;
                SendNewLogMessage(
                    NameStrategyUniq
                    + " | Подсказки параметров зарегистрированы (наведите курсор на строку в окне параметров).",
                    LogMessageType.System);
            }
        }

        #endregion
    }
}

