/*
 * Your rights to use code governed by this license https://github.com/AlexWan/OsEngine/blob/master/LICENSE
 * Ваши права на использование кода регулируются данной лицензией http://o-s-a.net/doc/license_simple_engine.pdf
*/

using System;
using System.Collections.Generic;
using System.Linq;
using OsEngine.Entity;
using OsEngine.Indicators;
using OsEngine.Logging;
using OsEngine.Market;
using OsEngine.Market.Servers;
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
- RZIgreensMinusReds (greens minus reds over lookback)
- Volume (объём текущей свечи vs предыдущая; минимальный рост в %)
- Average Profit Percent Long (средняя доходность лонга в окне: по умолчанию в % от средней Close пары; опционально в цене; пороги long/short)
- DiscreteMidBestPair — в исходниках отключён (#if false в теле класса), код не удалён.

Each indicator has an enable/disable parameter. Disabled indicators are not created on screener tabs.
У каждого индикатора — «№ И-группы» (целое, может быть отрицательным): по модулю номера строится одна И-группа (например 2 и −2 — одна группа); внутри группы условия связаны И. Отрицательный номер означает отрицание условия индикатора (NOT). Разные значения |номера| — разные группы; между группами ИЛИ.

Entry:
Open Long / Short when the grouped formula is satisfied for bull/bear checks (see indicator pass methods).
«Инверсия логики (покупка ↔ продажа)»: если включена — по сигналу бычьей формулы открывается продажа, по медвежьей — покупка (то же при закрытии и реверсе).

If Volume indicator is enabled, current candle volume must be at least (previous volume × (1 + min growth % / 100)).

Exit/Reverse:
If a position exists and opposite signal appears, close and (if allowed) open opposite.

Filters (AlgoStart-style):
- Non-trade periods (button opens calendar/time settings).
- Volatility cluster to trade (1–3) with lookback; only tabs in the chosen cluster can open new positions.
*/

namespace OsEngine.Robots.Custom
{
    public class TrendMultiIndicatorScreener : BotPanel
    {
        // DiscreteMidBestPair: весь связанный код обёрнут в «#if false // DiscreteMidBestPair» … «#endif» (не удалён).
        // Чтобы снова включить индикатор — замените false на true во всех таких директивах в этом файле.

        private const int NumSma = 1;
        private const int NumRsi = 2;
        private const int NumStoch = 3;
        private const int NumMomentum = 4;
        private const int NumBollinger = 5;
        private const int NumLinReg = 6;
        private const int NumRzi = 7;
        private const int NumVolumeIndicator = 9;

        /// <summary>Как в атрибуте [Indicator("...")] у скрипта AverageProfitPercentLong.</summary>
        private const string AverageProfitPercentLongIndicatorType = "Average Profit Percent Long";

        private const int NumAverageProfitPercentLong = 10;
#if false // DiscreteMidBestPair: код сохранён, отключён (замените false на true для включения)
        private const int NumDiscreteMidBestPair = 8;

        /// <summary>Маркер входа для постановки SL/TP по дискретной сетке (см. TryPlaceDiscreteStopAndProfit).</summary>
        private const string SignalOpenWithDiscreteSlTp = "TrendMultiDiscreteSlTp";
#endif

        private const string AreaPrime = "Prime";
        private const string AreaSecond = "Second";

        private BotTabScreener _screenerTab;

        // basic
        private StrategyParameterString _regime;
        private StrategyParameterInt _maxPositions;
        private StrategyParameterInt _slippage;
        private StrategyParameterBool _invertEntryLogic;

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
        private StrategyParameterBool _useRzi;
        private StrategyParameterBool _useVolumeIndicator;
        private StrategyParameterBool _useAverageProfitPercentLong;
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

        private StrategyParameterInt _rziLen;
        private StrategyParameterInt _rziStep;
        private StrategyParameterInt _rziSignalLevel;

        private StrategyParameterDecimal _volumeIndicatorMinGrowthPercent;

        private StrategyParameterInt _avgProfitPercentLongPeriod;
        private StrategyParameterInt _avgProfitPercentLongPairs;
        private StrategyParameterBool _avgProfitPercentLongAsPercent;
        private StrategyParameterDecimal _avgProfitPercentLongBullMin;
        private StrategyParameterDecimal _avgProfitPercentLongBearMax;

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
        private StrategyParameterInt _rziAndGroup;
        private StrategyParameterInt _volumeAndGroup;
        private StrategyParameterInt _avgProfitPercentLongAndGroup;

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

            _screenerTab.CandleFinishedEvent += ScreenerTab_CandleFinishedEvent;

            // basic
            _regime = CreateParameter("Regime", "Off", new[] { "Off", "On", "OnlyLong", "OnlyShort", "OnlyClosePosition" });
            _maxPositions = CreateParameter("Max positions (all tabs)", 20, 0, 200, 1);
            _slippage = CreateParameter("Slippage (steps)", 0, 0, 20, 1);
            _invertEntryLogic = CreateParameter("Инверсия логики (покупка ↔ продажа)", false);

            _checkVolatilityCluster = CreateParameter("Проверка кластера волатильности", false);
            _clusterToTrade = CreateParameter("Volatility cluster to trade", 2, 1, 3, 1);
            _clustersLookBack = CreateParameter("Volatility cluster lookBack", 30, 10, 300, 1);
            _clusterShowLast = CreateParameterButton("Show last clusters");
            _clusterShowLast.UserClickOnButtonEvent += ClusterShowLast_UserClickOnButtonEvent;

            _tradePeriodsShowDialogButton = CreateParameterButton("Non trade periods");
            _tradePeriodsShowDialogButton.UserClickOnButtonEvent += TradePeriodsShowDialogButton_UserClickOnButtonEvent;

            // volume
            _volumeType = CreateParameter("Volume type", "Deposit percent", new[] { "Contracts", "Contract currency", "Deposit percent" });
            _volume = CreateParameter("Volume", 20, 1.0m, 50, 4);
            _tradeAssetInPortfolio = CreateParameter("Asset in portfolio", "Prime");

            // toggles
            _useSma = CreateParameter("Use SMA", true);
            _useRsi = CreateParameter("Use RSI", true);
            _useStoch = CreateParameter("Use Stochastic", true);
            _useMomentum = CreateParameter("Use Momentum", true);
            _useBollinger = CreateParameter("Use Bollinger", true);
            _useLinReg = CreateParameter("Use Linear Regression", true);
            _useRzi = CreateParameter("Use RZIgreensMinusReds", false); //! default false
            _useVolumeIndicator = CreateParameter("Use Volume indicator", false);
            _useAverageProfitPercentLong = CreateParameter("Use Average Profit Percent Long", false);

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

            // RZIgreensMinusReds (script Custom/Indicators/Scripts/RZIgreensMinusReds.cs)
            _rziLen = CreateParameter("RZI lookback candles", 20, 5, 500, 1);
            _rziStep = CreateParameter("RZI step in loop", 1, 1, 20, 1);
            _rziSignalLevel = CreateParameter("RZI signal level (long if >N, short if <-N)", 3, 0, 200, 1);

            _volumeIndicatorMinGrowthPercent = CreateParameter("Volume vs prev candle min growth %", 5m, 0m, 500m, 0.5m);

            // Average Profit Percent Long (Custom/Indicators/Scripts/AverageProfitPercentLong.cs)
            _avgProfitPercentLongPeriod = CreateParameter("Avg Profit % Long period (candles)", 50, 2, 500, 1);
            _avgProfitPercentLongPairs = CreateParameter("Avg Profit % Long random pairs", 100, 1, 2000, 1);
            _avgProfitPercentLongAsPercent = CreateParameter("Avg Profit % Long: % from pair mid price", true);
            _avgProfitPercentLongBullMin = CreateParameter("Avg Profit % Long long: value >", 0m, -1000000m, 1000000m, 0.0001m);
            _avgProfitPercentLongBearMax = CreateParameter("Avg Profit % Long short: value <", 0m, -1000000m, 1000000m, 0.0001m);

            _smaAndGroup = CreateParameter("SMA: № И-группы", 1, -32, 32, 1);
            _rsiAndGroup = CreateParameter("RSI: № И-группы", 1, -32, 32, 1);
            _stochAndGroup = CreateParameter("Stochastic: № И-группы", 1, -32, 32, 1);
            _momAndGroup = CreateParameter("Momentum: № И-группы", 1, -32, 32, 1);
            _bollAndGroup = CreateParameter("Bollinger: № И-группы", 1, -32, 32, 1);
            _linRegAndGroup = CreateParameter("LinReg: № И-группы", 1, -32, 32, 1);
            _rziAndGroup = CreateParameter("RZI: № И-группы", 1, -32, 32, 1);
            _volumeAndGroup = CreateParameter("Volume ind.: № И-группы", 1, -32, 32, 1);
            _avgProfitPercentLongAndGroup = CreateParameter("Avg Profit % Long: № И-группы", 1, -32, 32, 1);

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
            Description = "Trend screener: SMA/RSI/Stoch/Momentum/Bollinger/LinReg/RZI/Volume/Avg Profit % Long; И-группы по |№|, минус = NOT, ИЛИ между |№|; опция инверсии входа; non-trade periods, volatility clusters.";
#endif

            DeleteEvent += TrendMultiIndicatorScreener_DeleteEvent;
        }

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

        private void TradePeriodsShowDialogButton_UserClickOnButtonEvent()
        {
            _tradePeriodsSettings.ShowDialog();
        }

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

        public override string GetNameStrategyType()
        {
            return "TrendMultiIndicatorScreener";
        }

        public override void ShowIndividualSettingsDialog()
        {
        }

        private void TrendMultiIndicatorScreener_ParametrsChangeByUser()
        {
            SyncIndicators();
            _screenerTab.UpdateIndicatorsParameters();
        }

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

            EnsureIndicator(
                NumVolumeIndicator,
                "Volume",
                new List<string>(),
                AreaSecond,
                _useVolumeIndicator.ValueBool);

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

#if false // DiscreteMidBestPair
            EnsureIndicator(
                NumDiscreteMidBestPair,
                "DiscreteMidBestPair",
                new List<string> { _discreteMidBestPairLevels.ValueInt.ToString() },
                AreaPrime,
                _useDiscreteMidBestPair.ValueBool);
#endif
        }

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

        private void ScreenerTab_CandleFinishedEvent(List<Candle> candles, BotTabSimple tab)
        {
            if (_regime.ValueString == "Off")
            {
                return;
            }

            if (candles == null || candles.Count < 50)
            {
                return;
            }

            if (_tradePeriodsSettings.CanTradeThisTime(candles[^1].TimeStart) == false)
            {
                return;
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

            bool bull = IsBullSignal(candles, tab);
            bool bear = IsBearSignal(candles, tab);

            if (_invertEntryLogic.ValueBool)
            {
                bool tmp = bull;
                bull = bear;
                bear = tmp;
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
            if (items.Count == 0)
                return true;

            foreach (var grp in items.GroupBy(x => x.group))
            {
                if (grp.All(x => x.pass))
                    return true;
            }

            return false;
        }

        /// <summary>
        /// Лонг: собирает бычьи проверки всех включённых индикаторов с их «№ И-группы» и передаёт
        /// в <see cref="CombineGroupedOrOfAnds"/> (см. комментарий к полям *_AndGroup выше).
        /// </summary>
        private bool IsBullSignal(List<Candle> candles, BotTabSimple tab)
        {
            decimal close = candles[candles.Count - 1].Close;
            var items = new List<(int group, bool pass)>();

            AddGroupedIndicatorResult(items, _smaAndGroup, BullSmaPasses(close, tab));
            AddGroupedIndicatorResult(items, _rsiAndGroup, BullRsiPasses(close, tab));
            AddGroupedIndicatorResult(items, _stochAndGroup, BullStochPasses(close, tab));
            AddGroupedIndicatorResult(items, _momAndGroup, BullMomentumPasses(close, tab));
            AddGroupedIndicatorResult(items, _bollAndGroup, BullBollingerPasses(close, tab));
            AddGroupedIndicatorResult(items, _linRegAndGroup, BullLinRegPasses(close, tab));
            AddGroupedIndicatorResult(items, _rziAndGroup, BullRziPasses(close, tab));
#if false // DiscreteMidBestPair
            AddGroupedIndicatorResult(items, _discreteAndGroup, BullDiscretePasses(candles, tab));
#endif
            AddGroupedIndicatorResult(items, _volumeAndGroup, BullVolumePasses(candles, tab));
            AddGroupedIndicatorResult(items, _avgProfitPercentLongAndGroup, BullAverageProfitPercentLongPasses(candles, tab));

            return CombineGroupedOrOfAnds(items);
        }

        /// <summary>
        /// Шорт: та же схема И-групп / ИЛИ между группами, что и для лонга, но с медвежьими *Passes.
        /// </summary>
        private bool IsBearSignal(List<Candle> candles, BotTabSimple tab)
        {
            decimal close = candles[candles.Count - 1].Close;
            var items = new List<(int group, bool pass)>();

            AddGroupedIndicatorResult(items, _smaAndGroup, BearSmaPasses(close, tab));
            AddGroupedIndicatorResult(items, _rsiAndGroup, BearRsiPasses(close, tab));
            AddGroupedIndicatorResult(items, _stochAndGroup, BearStochPasses(close, tab));
            AddGroupedIndicatorResult(items, _momAndGroup, BearMomentumPasses(close, tab));
            AddGroupedIndicatorResult(items, _bollAndGroup, BearBollingerPasses(close, tab));
            AddGroupedIndicatorResult(items, _linRegAndGroup, BearLinRegPasses(close, tab));
            AddGroupedIndicatorResult(items, _rziAndGroup, BearRziPasses(close, tab));
#if false // DiscreteMidBestPair
            AddGroupedIndicatorResult(items, _discreteAndGroup, BearDiscretePasses(candles, tab));
#endif
            AddGroupedIndicatorResult(items, _volumeAndGroup, BearVolumePasses(candles, tab));
            AddGroupedIndicatorResult(items, _avgProfitPercentLongAndGroup, BearAverageProfitPercentLongPasses(candles, tab));

            return CombineGroupedOrOfAnds(items);
        }

        private bool? BullSmaPasses(decimal close, BotTabSimple tab)
        {
            if (!_useSma.ValueBool)
                return null;
            Aindicator sma = FindIndicator(tab, NumSma, "Sma");
            if (sma == null)
                return false;
            decimal v = sma.DataSeries[0].Last;
            return v != 0 && close > v;
        }

        private bool? BullRsiPasses(decimal close, BotTabSimple tab)
        {
            if (!_useRsi.ValueBool)
                return null;
            Aindicator rsi = FindIndicator(tab, NumRsi, "Rsi");
            if (rsi == null)
                return false;
            decimal v = rsi.DataSeries[0].Last;
            return v != 0 && v >= _rsiLongMin.ValueDecimal;
        }

        private bool? BullStochPasses(decimal close, BotTabSimple tab)
        {
            if (!_useStoch.ValueBool)
                return null;
            Aindicator st = FindIndicator(tab, NumStoch, "Stochastic");
            if (st == null)
                return false;
            decimal k = st.DataSeries[0].Last;
            return k != 0 && k >= _stochLongMin.ValueDecimal;
        }

        private bool? BullMomentumPasses(decimal close, BotTabSimple tab)
        {
            if (!_useMomentum.ValueBool)
                return null;
            Aindicator mom = FindIndicator(tab, NumMomentum, "Momentum");
            if (mom == null)
                return false;
            decimal v = mom.DataSeries[0].Last;
            return v != 0 && v >= _momLongMin.ValueDecimal;
        }

        private bool? BullBollingerPasses(decimal close, BotTabSimple tab)
        {
            if (!_useBollinger.ValueBool)
                return null;
            Aindicator boll = FindIndicator(tab, NumBollinger, "Bollinger");
            if (boll == null || boll.DataSeries.Count < 2)
                return false;
            decimal up = boll.DataSeries[0].Last;
            decimal down = boll.DataSeries[1].Last;
            if (up == 0 || down == 0)
                return false;
            decimal mid = (up + down) / 2m;
            return close > mid;
        }

        private bool? BullLinRegPasses(decimal close, BotTabSimple tab)
        {
            if (!_useLinReg.ValueBool)
                return null;
            Aindicator lr = FindIndicator(tab, NumLinReg, "LinearRegressionChannelFast_Indicator");
            if (lr == null)
                return false;
            decimal up = lr.DataSeries[0].Last;
            return up != 0 && close > up;
        }

        private bool? BullRziPasses(decimal close, BotTabSimple tab)
        {
            if (!_useRzi.ValueBool)
                return null;
            Aindicator rzi = FindIndicator(tab, NumRzi, "RZIgreensMinusReds");
            if (rzi == null)
                return false;
            decimal v = rzi.DataSeries[0].Last;
            return v > _rziSignalLevel.ValueInt;
        }

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

        private bool? BullVolumePasses(List<Candle> candles, BotTabSimple tab)
        {
            if (!_useVolumeIndicator.ValueBool)
                return null;
            return VolumeIndicatorGrowthOk(candles, tab);
        }

        private bool? BullAverageProfitPercentLongPasses(List<Candle> candles, BotTabSimple tab)
        {
            if (!_useAverageProfitPercentLong.ValueBool)
                return null;
            int period = Math.Max(2, _avgProfitPercentLongPeriod.ValueInt);
            if (candles == null || candles.Count < period)
                return false;
            Aindicator ap = FindIndicator(tab, NumAverageProfitPercentLong, AverageProfitPercentLongIndicatorType);
            if (ap == null || ap.DataSeries == null || ap.DataSeries.Count < 1)
                return false;
            decimal v = ap.DataSeries[0].Last;
            return v > _avgProfitPercentLongBullMin.ValueDecimal;
        }

        private bool? BearSmaPasses(decimal close, BotTabSimple tab)
        {
            if (!_useSma.ValueBool)
                return null;
            Aindicator sma = FindIndicator(tab, NumSma, "Sma");
            if (sma == null)
                return false;
            decimal v = sma.DataSeries[0].Last;
            return v != 0 && close < v;
        }

        private bool? BearRsiPasses(decimal close, BotTabSimple tab)
        {
            if (!_useRsi.ValueBool)
                return null;
            Aindicator rsi = FindIndicator(tab, NumRsi, "Rsi");
            if (rsi == null)
                return false;
            decimal v = rsi.DataSeries[0].Last;
            return v != 0 && v <= _rsiShortMax.ValueDecimal;
        }

        private bool? BearStochPasses(decimal close, BotTabSimple tab)
        {
            if (!_useStoch.ValueBool)
                return null;
            Aindicator st = FindIndicator(tab, NumStoch, "Stochastic");
            if (st == null)
                return false;
            decimal k = st.DataSeries[0].Last;
            return k != 0 && k <= _stochShortMax.ValueDecimal;
        }

        private bool? BearMomentumPasses(decimal close, BotTabSimple tab)
        {
            if (!_useMomentum.ValueBool)
                return null;
            Aindicator mom = FindIndicator(tab, NumMomentum, "Momentum");
            if (mom == null)
                return false;
            decimal v = mom.DataSeries[0].Last;
            return v != 0 && v <= _momShortMax.ValueDecimal;
        }

        private bool? BearBollingerPasses(decimal close, BotTabSimple tab)
        {
            if (!_useBollinger.ValueBool)
                return null;
            Aindicator boll = FindIndicator(tab, NumBollinger, "Bollinger");
            if (boll == null || boll.DataSeries.Count < 2)
                return false;
            decimal up = boll.DataSeries[0].Last;
            decimal down = boll.DataSeries[1].Last;
            if (up == 0 || down == 0)
                return false;
            decimal mid = (up + down) / 2m;
            return close < mid;
        }

        private bool? BearLinRegPasses(decimal close, BotTabSimple tab)
        {
            if (!_useLinReg.ValueBool)
                return null;
            Aindicator lr = FindIndicator(tab, NumLinReg, "LinearRegressionChannelFast_Indicator");
            if (lr == null || lr.DataSeries.Count < 3)
                return false;
            decimal down = lr.DataSeries[2].Last;
            return down != 0 && close < down;
        }

        private bool? BearRziPasses(decimal close, BotTabSimple tab)
        {
            if (!_useRzi.ValueBool)
                return null;
            Aindicator rzi = FindIndicator(tab, NumRzi, "RZIgreensMinusReds");
            if (rzi == null)
                return false;
            decimal v = rzi.DataSeries[0].Last;
            decimal shortBound = -_rziSignalLevel.ValueInt;
            return v < shortBound;
        }

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

        private bool? BearVolumePasses(List<Candle> candles, BotTabSimple tab)
        {
            if (!_useVolumeIndicator.ValueBool)
                return null;
            return VolumeIndicatorGrowthOk(candles, tab);
        }

        private bool? BearAverageProfitPercentLongPasses(List<Candle> candles, BotTabSimple tab)
        {
            if (!_useAverageProfitPercentLong.ValueBool)
                return null;
            int period = Math.Max(2, _avgProfitPercentLongPeriod.ValueInt);
            if (candles == null || candles.Count < period)
                return false;
            Aindicator ap = FindIndicator(tab, NumAverageProfitPercentLong, AverageProfitPercentLongIndicatorType);
            if (ap == null || ap.DataSeries == null || ap.DataSeries.Count < 1)
                return false;
            decimal v = ap.DataSeries[0].Last;
            return v < _avgProfitPercentLongBearMax.ValueDecimal;
        }

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
        private bool VolumeIndicatorGrowthOk(List<Candle> candles, BotTabSimple tab)
        {
            if (!_useVolumeIndicator.ValueBool)
                return true;

            if (candles == null || candles.Count < 2)
                return false;

            Aindicator volInd = FindIndicator(tab, NumVolumeIndicator, "Volume");
            if (volInd == null || volInd.DataSeries.Count < 1)
                return false;

            decimal curVol = candles[candles.Count - 1].Volume;
            decimal prevVol = candles[candles.Count - 2].Volume;
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

        private void TryOpenOnSignal(List<Candle> candles, BotTabSimple tab, bool bull, bool bear)
        {
            decimal close = candles[candles.Count - 1].Close;
            decimal slip = _slippage.ValueInt * tab.Security.PriceStep;
#if false // DiscreteMidBestPair
            string openSignal = DiscreteOpenSignal();

            if (bull && _regime.ValueString != "OnlyShort")
            {
                tab.BuyAtLimit(GetVolume(tab), close + slip, openSignal);
            }
            else if (bear && _regime.ValueString != "OnlyLong")
            {
                tab.SellAtLimit(GetVolume(tab), close - slip, openSignal);
            }
#else
            if (bull && _regime.ValueString != "OnlyShort")
            {
                tab.BuyAtLimit(GetVolume(tab), close + slip);
            }
            else if (bear && _regime.ValueString != "OnlyLong")
            {
                tab.SellAtLimit(GetVolume(tab), close - slip);
            }
#endif
        }

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
                tab.CloseAtLimit(pos, close - slip, pos.OpenVolume);

                if (_regime.ValueString != "OnlyLong" && _regime.ValueString != "OnlyClosePosition")
                {
                    if (_screenerTab.PositionsOpenAll.Count < _maxPositions.ValueInt)
                    {
                        tab.SellAtLimit(GetVolume(tab), close - slip, openSignal);
                    }
                }
            }
            else if (pos.Direction == Side.Sell && bull)
            {
                tab.CloseAtLimit(pos, close + slip, pos.OpenVolume);

                if (_regime.ValueString != "OnlyShort" && _regime.ValueString != "OnlyClosePosition")
                {
                    if (_screenerTab.PositionsOpenAll.Count < _maxPositions.ValueInt)
                    {
                        tab.BuyAtLimit(GetVolume(tab), close + slip, openSignal);
                    }
                }
            }
#else
            if (pos.Direction == Side.Buy && bear)
            {
                tab.CloseAtLimit(pos, close - slip, pos.OpenVolume);

                if (_regime.ValueString != "OnlyLong" && _regime.ValueString != "OnlyClosePosition")
                {
                    if (_screenerTab.PositionsOpenAll.Count < _maxPositions.ValueInt)
                    {
                        tab.SellAtLimit(GetVolume(tab), close - slip);
                    }
                }
            }
            else if (pos.Direction == Side.Sell && bull)
            {
                tab.CloseAtLimit(pos, close + slip, pos.OpenVolume);

                if (_regime.ValueString != "OnlyShort" && _regime.ValueString != "OnlyClosePosition")
                {
                    if (_screenerTab.PositionsOpenAll.Count < _maxPositions.ValueInt)
                    {
                        tab.BuyAtLimit(GetVolume(tab), close + slip);
                    }
                }
            }
#endif
        }

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
    }
}

