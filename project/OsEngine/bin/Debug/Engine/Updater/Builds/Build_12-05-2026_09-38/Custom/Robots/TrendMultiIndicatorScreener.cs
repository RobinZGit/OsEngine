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

Each indicator has an enable/disable parameter. Disabled indicators are not created on screener tabs.

Entry:
Open Long when ALL enabled indicators are bullish.
Open Short when ALL enabled indicators are bearish.

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
        private const int NumSma = 1;
        private const int NumRsi = 2;
        private const int NumStoch = 3;
        private const int NumMomentum = 4;
        private const int NumBollinger = 5;
        private const int NumLinReg = 6;
        private const int NumRzi = 7;

        private const string AreaPrime = "Prime";
        private const string AreaSecond = "Second";

        private BotTabScreener _screenerTab;

        // basic
        private StrategyParameterString _regime;
        private StrategyParameterInt _maxPositions;
        private StrategyParameterInt _slippage;

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

            ParametrsChangeByUser += TrendMultiIndicatorScreener_ParametrsChangeByUser;

            // create only enabled indicators
            SyncIndicators();

            Description = "Trend screener with SMA/RSI/Stoch/Momentum/Bollinger/LinReg/RZI, non-trade periods, volatility clusters.";

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

        private bool IsBullSignal(List<Candle> candles, BotTabSimple tab)
        {
            decimal close = candles[candles.Count - 1].Close;

            if (_useSma.ValueBool)
            {
                Aindicator sma = FindIndicator(tab, NumSma, "Sma");
                if (sma == null) return false;
                decimal v = sma.DataSeries[0].Last;
                if (v == 0 || close <= v) return false;
            }

            if (_useRsi.ValueBool)
            {
                Aindicator rsi = FindIndicator(tab, NumRsi, "Rsi");
                if (rsi == null) return false;
                decimal v = rsi.DataSeries[0].Last;
                if (v == 0 || v < _rsiLongMin.ValueDecimal) return false;
            }

            if (_useStoch.ValueBool)
            {
                Aindicator st = FindIndicator(tab, NumStoch, "Stochastic");
                if (st == null) return false;
                decimal k = st.DataSeries[0].Last;
                if (k == 0 || k < _stochLongMin.ValueDecimal) return false;
            }

            if (_useMomentum.ValueBool)
            {
                Aindicator mom = FindIndicator(tab, NumMomentum, "Momentum");
                if (mom == null) return false;
                decimal v = mom.DataSeries[0].Last;
                if (v == 0 || v < _momLongMin.ValueDecimal) return false;
            }

            if (_useBollinger.ValueBool)
            {
                Aindicator boll = FindIndicator(tab, NumBollinger, "Bollinger");
                if (boll == null) return false;
                if (boll.DataSeries.Count < 2) return false;
                decimal up = boll.DataSeries[0].Last;
                decimal down = boll.DataSeries[1].Last;
                if (up == 0 || down == 0) return false;
                // trend filter: close above mid of band
                decimal mid = (up + down) / 2m;
                if (close <= mid) return false;
            }

            if (_useLinReg.ValueBool)
            {
                Aindicator lr = FindIndicator(tab, NumLinReg, "LinearRegressionChannelFast_Indicator");
                if (lr == null) return false;

                // DataSeries[0] is upper channel line in built-in screener example
                decimal up = lr.DataSeries[0].Last;
                if (up == 0 || close <= up) return false;
            }

            if (_useRzi.ValueBool)
            {
                Aindicator rzi = FindIndicator(tab, NumRzi, "RZIgreensMinusReds");
                if (rzi == null) return false;
                decimal v = rzi.DataSeries[0].Last;
                if (v <= _rziSignalLevel.ValueInt) return false;
            }

            return true;
        }

        private bool IsBearSignal(List<Candle> candles, BotTabSimple tab)
        {
            decimal close = candles[candles.Count - 1].Close;

            if (_useSma.ValueBool)
            {
                Aindicator sma = FindIndicator(tab, NumSma, "Sma");
                if (sma == null) return false;
                decimal v = sma.DataSeries[0].Last;
                if (v == 0 || close >= v) return false;
            }

            if (_useRsi.ValueBool)
            {
                Aindicator rsi = FindIndicator(tab, NumRsi, "Rsi");
                if (rsi == null) return false;
                decimal v = rsi.DataSeries[0].Last;
                if (v == 0 || v > _rsiShortMax.ValueDecimal) return false;
            }

            if (_useStoch.ValueBool)
            {
                Aindicator st = FindIndicator(tab, NumStoch, "Stochastic");
                if (st == null) return false;
                decimal k = st.DataSeries[0].Last;
                if (k == 0 || k > _stochShortMax.ValueDecimal) return false;
            }

            if (_useMomentum.ValueBool)
            {
                Aindicator mom = FindIndicator(tab, NumMomentum, "Momentum");
                if (mom == null) return false;
                decimal v = mom.DataSeries[0].Last;
                if (v == 0 || v > _momShortMax.ValueDecimal) return false;
            }

            if (_useBollinger.ValueBool)
            {
                Aindicator boll = FindIndicator(tab, NumBollinger, "Bollinger");
                if (boll == null) return false;
                if (boll.DataSeries.Count < 2) return false;
                decimal up = boll.DataSeries[0].Last;
                decimal down = boll.DataSeries[1].Last;
                if (up == 0 || down == 0) return false;
                decimal mid = (up + down) / 2m;
                if (close >= mid) return false;
            }

            if (_useLinReg.ValueBool)
            {
                Aindicator lr = FindIndicator(tab, NumLinReg, "LinearRegressionChannelFast_Indicator");
                if (lr == null) return false;

                // DataSeries[2] is lower channel line in built-in screener example
                if (lr.DataSeries.Count < 3) return false;
                decimal down = lr.DataSeries[2].Last;
                if (down == 0 || close >= down) return false;
            }

            if (_useRzi.ValueBool)
            {
                Aindicator rzi = FindIndicator(tab, NumRzi, "RZIgreensMinusReds");
                if (rzi == null) return false;
                decimal v = rzi.DataSeries[0].Last;
                decimal shortBound = -_rziSignalLevel.ValueInt;
                if (v >= shortBound) return false;
            }

            return true;
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

        private void TryOpenOnSignal(List<Candle> candles, BotTabSimple tab, bool bull, bool bear)
        {
            decimal close = candles[candles.Count - 1].Close;
            decimal slip = _slippage.ValueInt * tab.Security.PriceStep;

            if (bull && _regime.ValueString != "OnlyShort")
            {
                tab.BuyAtLimit(GetVolume(tab), close + slip);
            }
            else if (bear && _regime.ValueString != "OnlyLong")
            {
                tab.SellAtLimit(GetVolume(tab), close - slip);
            }
        }

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

