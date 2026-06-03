/*
 * Trend Multi-Indicator Portfolio — custom indicator (logic aligned with TrendMultiIndicatorScreener).
 * One portfolio series per |И-группа|: AND inside group, minus = NOT.
 * Each bull/bear signal: entry (stack units); opposite signal exits one unit only if position exists.
 */

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.Linq;
using OsEngine.Entity;

namespace OsEngine.Indicators
{
    // One-arg [Indicator] only: script compiler uses OsEngine.dll; second arg needs rebuilt OsEngine.
    // Until rebuild: select area "Second" in the chart indicator dialog (right column).
    [Indicator("TrendMultiIndicatorPortfolio_indicator")]
    public class TrendMultiIndicatorPortfolio_indicator : Aindicator
    {
        private const string ChartAreaName = "Second";
        private const string VwapIndicatorType = "VWAP";

        // --- toggles ---
        private IndicatorParameterBool _useSma;
        private IndicatorParameterBool _useRsi;
        private IndicatorParameterBool _useStoch;
        private IndicatorParameterBool _useMomentum;
        private IndicatorParameterBool _useBollinger;
        private IndicatorParameterBool _useLinReg;
        private IndicatorParameterBool _useVolumeIndicator;
        private IndicatorParameterBool _useVwap;
        private IndicatorParameterBool _useAtr;
        private IndicatorParameterBool _useMacd;
        private IndicatorParameterBool _invertEntryLogic;

        // --- lengths / thresholds (same defaults as TrendMultiIndicatorScreener) ---
        private IndicatorParameterInt _smaLen;
        private IndicatorParameterInt _rsiLen;
        private IndicatorParameterDecimal _rsiLongMin;
        private IndicatorParameterDecimal _rsiShortMax;
        private IndicatorParameterInt _stochP1;
        private IndicatorParameterInt _stochP2;
        private IndicatorParameterInt _stochP3;
        private IndicatorParameterDecimal _stochLongMin;
        private IndicatorParameterDecimal _stochShortMax;
        private IndicatorParameterInt _momLen;
        private IndicatorParameterDecimal _momLongMin;
        private IndicatorParameterDecimal _momShortMax;
        private IndicatorParameterInt _bollLen;
        private IndicatorParameterDecimal _bollDev;
        private IndicatorParameterInt _linRegLen;
        private IndicatorParameterDecimal _linRegDev;
        private IndicatorParameterDecimal _volumeIndicatorMinGrowthPercent;
        private IndicatorParameterBool _useVolumeTodCompare;
        private IndicatorParameterInt _volumeTodPastDays;
        private IndicatorParameterDecimal _volumeTodMinRelativeRatio;
        private IndicatorParameterInt _atrLen;
        private IndicatorParameterDecimal _atrGrowPercent;
        private IndicatorParameterInt _atrGrowLookBack;
        private IndicatorParameterInt _macdFastLen;
        private IndicatorParameterInt _macdSlowLen;
        private IndicatorParameterInt _macdSignalLen;

        // --- И-группы (по умолчанию у каждого индикатора свой номер) ---
        private IndicatorParameterString _smaAndGroup;
        private IndicatorParameterString _rsiAndGroup;
        private IndicatorParameterString _stochAndGroup;
        private IndicatorParameterString _momAndGroup;
        private IndicatorParameterString _bollAndGroup;
        private IndicatorParameterString _linRegAndGroup;
        private IndicatorParameterString _volumeAndGroup;
        private IndicatorParameterString _vwapAndGroup;
        private IndicatorParameterString _atrAndGroup;
        private IndicatorParameterString _macdAndGroup;

        // --- embedded indicators ---
        private Aindicator _sma;
        private Aindicator _rsi;
        private Aindicator _stoch;
        private Aindicator _momentum;
        private Aindicator _bollinger;
        private Aindicator _linReg;
        private Aindicator _volumeInd;
        private Aindicator _vwap;
        private Aindicator _atr;
        private Aindicator _macd;

        private readonly List<int> _groupIds = new List<int>();
        private readonly Dictionary<int, IndicatorDataSeries> _portfolioSeriesByGroup = new Dictionary<int, IndicatorDataSeries>();
        private readonly Dictionary<int, GroupPortfolioState> _groupStates = new Dictionary<int, GroupPortfolioState>();

        private static readonly Color[] GroupSeriesColors =
        {
            Color.DodgerBlue, Color.Orange, Color.MediumSeaGreen, Color.MediumVioletRed,
            Color.Goldenrod, Color.Teal, Color.SlateBlue, Color.Chocolate,
            Color.Crimson, Color.DarkCyan, Color.DarkOrange, Color.DimGray,
            Color.DeepPink, Color.Olive, Color.Navy, Color.Maroon
        };

        private sealed class GroupPortfolioState
        {
            public decimal Portfolio;
            public int LongUnits;
            public int ShortUnits;
        }

        public override void OnStateChange(IndicatorState state)
        {
            if (state != IndicatorState.Configure)
            {
                return;
            }

            NameArea = ChartAreaName;

            _invertEntryLogic = CreateParameterBool(
                "Инверсия логики (покупка и продажа меняются местами)",
                false);

            _useSma = CreateParameterBool("Use SMA", true);
            _useRsi = CreateParameterBool("Use RSI", false);
            _useStoch = CreateParameterBool("Use Stochastic", false);
            _useMomentum = CreateParameterBool("Use Momentum", false);
            _useBollinger = CreateParameterBool("Use Bollinger", false);
            _useLinReg = CreateParameterBool("Use Linear Regression", false);
            _useVolumeIndicator = CreateParameterBool("Use Volume indicator", false);
            _useVwap = CreateParameterBool("Use VWAP", false);
            _useAtr = CreateParameterBool("Use ATR", false);
            _useMacd = CreateParameterBool("Use MACD", false);

            _smaLen = CreateParameterInt("SMA length", 100);
            _rsiLen = CreateParameterInt("RSI length", 14);
            _rsiLongMin = CreateParameterDecimal("RSI long min", 55m);
            _rsiShortMax = CreateParameterDecimal("RSI short max", 45m);
            _stochP1 = CreateParameterInt("Stoch P1", 14);
            _stochP2 = CreateParameterInt("Stoch P2", 3);
            _stochP3 = CreateParameterInt("Stoch P3", 3);
            _stochLongMin = CreateParameterDecimal("Stoch long min", 55m);
            _stochShortMax = CreateParameterDecimal("Stoch short max", 45m);
            _momLen = CreateParameterInt("Momentum length", 15);
            _momLongMin = CreateParameterDecimal("Momentum long min", 100m);
            _momShortMax = CreateParameterDecimal("Momentum short max", 100m);
            _bollLen = CreateParameterInt("Bollinger length", 100);
            _bollDev = CreateParameterDecimal("Bollinger deviation", 2m);
            _linRegLen = CreateParameterInt("LinReg length", 50);
            _linRegDev = CreateParameterDecimal("LinReg deviation", 2m);
            _volumeIndicatorMinGrowthPercent = CreateParameterDecimal("Volume vs prev candle min growth %", 5m);
            _useVolumeTodCompare = CreateParameterBool("Volume: сравнение с тем же временем прошлых дней", false);
            _volumeTodPastDays = CreateParameterInt("Volume TOD: число прошлых торг. дней", 10);
            _volumeTodMinRelativeRatio = CreateParameterDecimal("Volume TOD: мин. отношение к среднему", 0.8m);
            _atrLen = CreateParameterInt("ATR length", 14);
            _atrGrowPercent = CreateParameterDecimal("ATR min grow % vs lookback", 3m);
            _atrGrowLookBack = CreateParameterInt("ATR grow lookback (candles)", 5);
            _macdFastLen = CreateParameterInt("MACD fast length", 12);
            _macdSlowLen = CreateParameterInt("MACD slow length", 26);
            _macdSignalLen = CreateParameterInt("MACD signal length", 9);

            _smaAndGroup = CreateParameterString("SMA: № И-группы (через запятую)", "1");
            _rsiAndGroup = CreateParameterString("RSI: № И-группы (через запятую)", "2");
            _stochAndGroup = CreateParameterString("Stochastic: № И-группы (через запятую)", "3");
            _momAndGroup = CreateParameterString("Momentum: № И-группы (через запятую)", "4");
            _bollAndGroup = CreateParameterString("Bollinger: № И-группы (через запятую)", "5");
            _linRegAndGroup = CreateParameterString("LinReg: № И-группы (через запятую)", "6");
            _volumeAndGroup = CreateParameterString("Volume ind.: № И-группы (через запятую)", "7");
            _vwapAndGroup = CreateParameterString("VWAP: № И-группы (через запятую)", "8");
            _atrAndGroup = CreateParameterString("ATR: № И-группы (через запятую)", "9");
            _macdAndGroup = CreateParameterString("MACD: № И-группы (через запятую)", "10");

            CreateEmbeddedIndicators();
            RebuildGroupSeries();
        }

        private void CreateEmbeddedIndicators()
        {
            _sma = IndicatorsFactory.CreateIndicatorByName("Sma", Name + "Sma", false);
            BindChildIntParameter(_sma, 0, _smaLen);
            SetChildStringParameter(_sma, 1, "Close");
            ProcessIndicator("Sma", _sma);

            // RSI script has only Length (no Candle Point parameter).
            _rsi = IndicatorsFactory.CreateIndicatorByName("RSI", Name + "RSI", false);
            BindChildIntParameter(_rsi, 0, _rsiLen);
            ProcessIndicator("RSI", _rsi);

            _stoch = IndicatorsFactory.CreateIndicatorByName("Stochastic", Name + "Stoch", false);
            BindChildIntParameter(_stoch, 0, _stochP1);
            BindChildIntParameter(_stoch, 1, _stochP2);
            BindChildIntParameter(_stoch, 2, _stochP3);
            ProcessIndicator("Stochastic", _stoch);

            _momentum = IndicatorsFactory.CreateIndicatorByName("Momentum", Name + "Momentum", false);
            BindChildIntParameter(_momentum, 0, _momLen);
            SetChildStringParameter(_momentum, 1, "Close");
            ProcessIndicator("Momentum", _momentum);

            _bollinger = IndicatorsFactory.CreateIndicatorByName("Bollinger", Name + "Bollinger", false);
            BindChildIntParameter(_bollinger, 0, _bollLen);
            BindChildDecimalParameter(_bollinger, 1, _bollDev);
            ProcessIndicator("Bollinger", _bollinger);

            // LinReg: 0=Length, 1=Candle Point, 2=Up deviation, 3=Down deviation.
            _linReg = IndicatorsFactory.CreateIndicatorByName("LinearRegressionChannelFast_Indicator", Name + "LinReg", false);
            BindChildIntParameter(_linReg, 0, _linRegLen);
            SetChildStringParameter(_linReg, 1, "Close");
            BindChildDecimalParameter(_linReg, 2, _linRegDev);
            BindChildDecimalParameter(_linReg, 3, _linRegDev);
            ProcessIndicator("LinReg", _linReg);

            _volumeInd = IndicatorsFactory.CreateIndicatorByName("Volume", Name + "Volume", false);
            ProcessIndicator("Volume", _volumeInd);

            _vwap = IndicatorsFactory.CreateIndicatorByName(VwapIndicatorType, Name + "VWAP", false);
            ProcessIndicator("VWAP", _vwap);

            _atr = IndicatorsFactory.CreateIndicatorByName("ATR", Name + "ATR", false);
            BindChildIntParameter(_atr, 0, _atrLen);
            SetChildStringParameter(_atr, 1, "Absolute");
            ProcessIndicator("ATR", _atr);

            _macd = IndicatorsFactory.CreateIndicatorByName("MACD", Name + "MACD", false);
            BindChildIntParameter(_macd, 0, _macdFastLen);
            BindChildIntParameter(_macd, 1, _macdSlowLen);
            BindChildIntParameter(_macd, 2, _macdSignalLen);
            ProcessIndicator("MACD", _macd);
        }

        private static void BindChildIntParameter(Aindicator indicator, int index, IndicatorParameterInt source)
        {
            if (indicator?.Parameters == null || source == null || index < 0 || index >= indicator.Parameters.Count)
            {
                return;
            }

            if (indicator.Parameters[index] is IndicatorParameterInt target)
            {
                target.Bind(source);
            }
        }

        private static void BindChildDecimalParameter(Aindicator indicator, int index, IndicatorParameterDecimal source)
        {
            if (indicator?.Parameters == null || source == null || index < 0 || index >= indicator.Parameters.Count)
            {
                return;
            }

            if (indicator.Parameters[index] is IndicatorParameterDecimal target)
            {
                target.Bind(source);
            }
        }

        private static void SetChildStringParameter(Aindicator indicator, int index, string value)
        {
            if (indicator?.Parameters == null || index < 0 || index >= indicator.Parameters.Count)
            {
                return;
            }

            if (indicator.Parameters[index] is IndicatorParameterString target)
            {
                target.ValueString = value;
            }
        }

        /// <summary>Пересборка серий портфеля после синхронизации параметров с роботом.</summary>
        public void RebuildGroupSeriesFromRobot()
        {
            RebuildGroupSeries();
        }

        private void RebuildGroupSeries()
        {
            _groupIds.Clear();
            _portfolioSeriesByGroup.Clear();
            _groupStates.Clear();

            SortedSet<int> ids = new SortedSet<int>();
            if (_useSma.ValueBool)
            {
                CollectGroupIds(ids, _smaAndGroup);
            }

            if (_useRsi.ValueBool)
            {
                CollectGroupIds(ids, _rsiAndGroup);
            }

            if (_useStoch.ValueBool)
            {
                CollectGroupIds(ids, _stochAndGroup);
            }

            if (_useMomentum.ValueBool)
            {
                CollectGroupIds(ids, _momAndGroup);
            }

            if (_useBollinger.ValueBool)
            {
                CollectGroupIds(ids, _bollAndGroup);
            }

            if (_useLinReg.ValueBool)
            {
                CollectGroupIds(ids, _linRegAndGroup);
            }

            if (_useVolumeIndicator.ValueBool)
            {
                CollectGroupIds(ids, _volumeAndGroup);
            }

            if (_useVwap.ValueBool)
            {
                CollectGroupIds(ids, _vwapAndGroup);
            }

            if (_useAtr.ValueBool)
            {
                CollectGroupIds(ids, _atrAndGroup);
            }

            if (_useMacd.ValueBool)
            {
                CollectGroupIds(ids, _macdAndGroup);
            }

            if (ids.Count == 0)
            {
                ids.Add(1);
            }

            int colorIndex = 0;
            foreach (int groupId in ids)
            {
                _groupIds.Add(groupId);
                Color color = GroupSeriesColors[colorIndex % GroupSeriesColors.Length];
                colorIndex++;

                IndicatorDataSeries series = CreateSeries(
                    "Портфель |" + groupId + "|",
                    color,
                    IndicatorChartPaintType.Line,
                    true);
                series.CanReBuildHistoricalValues = true;

                _portfolioSeriesByGroup[groupId] = series;
                _groupStates[groupId] = new GroupPortfolioState();
            }
        }

        private static void CollectGroupIds(SortedSet<int> ids, IndicatorParameterString groupParam)
        {
            if (groupParam == null)
            {
                return;
            }

            List<int> parsed = ParseIndicatorGroupNumbers(groupParam.ValueString);
            for (int i = 0; i < parsed.Count; i++)
            {
                ids.Add(Math.Abs(parsed[i]));
            }
        }

        public override void OnProcess(List<Candle> candles, int index)
        {
            if (candles == null || index < 0 || index >= candles.Count)
            {
                return;
            }

            EnsureSeriesLength(index);

            if (index == 0)
            {
                ResetAllGroupStates();
            }

            decimal close = candles[index].Close;

            for (int g = 0; g < _groupIds.Count; g++)
            {
                int groupId = _groupIds[g];
                bool bull = IsBullSignalForGroup(candles, groupId, index);
                bool bear = IsBearSignalForGroup(candles, groupId, index);
                ApplyEntryExitSignalTransforms(ref bull, ref bear);

                GroupPortfolioState state = _groupStates[groupId];
                ApplyTrendLogic(state, bull, bear, close);
                _portfolioSeriesByGroup[groupId].Values[index] = state.Portfolio;
            }
        }

        private void EnsureSeriesLength(int index)
        {
            foreach (int groupId in _groupIds)
            {
                IndicatorDataSeries series = _portfolioSeriesByGroup[groupId];
                while (series.Values.Count <= index)
                {
                    series.Values.Add(0m);
                }
            }
        }

        private void ResetAllGroupStates()
        {
            foreach (int groupId in _groupIds)
            {
                GroupPortfolioState state = _groupStates[groupId];
                state.Portfolio = 0m;
                state.LongUnits = 0;
                state.ShortUnits = 0;
            }
        }

        /// <summary>
        /// Вход по каждому сигналу (можно наращивать «штуки»). Выход противоположным сигналом — только если есть что закрыть.
        /// </summary>
        private static void ApplyTrendLogic(GroupPortfolioState state, bool bull, bool bear, decimal price)
        {
            if (price <= 0m)
            {
                return;
            }

            if (bear)
            {
                if (state.LongUnits > 0)
                {
                    state.Portfolio += price;
                    state.LongUnits--;
                }

                state.Portfolio += price;
                state.ShortUnits++;
            }

            if (bull)
            {
                if (state.ShortUnits > 0)
                {
                    state.Portfolio -= price;
                    state.ShortUnits--;
                }

                state.Portfolio -= price;
                state.LongUnits++;
            }
        }

        private void ApplyEntryExitSignalTransforms(ref bool bull, ref bool bear)
        {
            if (_invertEntryLogic == null || !_invertEntryLogic.ValueBool)
            {
                return;
            }

            bool tmp = bull;
            bull = bear;
            bear = tmp;
        }

        private bool IsBullSignalForGroup(List<Candle> candles, int groupId, int candleIndex)
        {
            var items = new List<(int group, bool pass)>();
            AddGroupedIndicatorResultForGroup(items, groupId, _smaAndGroup, BullSmaPasses(candles, candleIndex));
            AddGroupedIndicatorResultForGroup(items, groupId, _rsiAndGroup, BullRsiPasses(candles, candleIndex));
            AddGroupedIndicatorResultForGroup(items, groupId, _stochAndGroup, BullStochPasses(candles, candleIndex));
            AddGroupedIndicatorResultForGroup(items, groupId, _momAndGroup, BullMomentumPasses(candles, candleIndex));
            AddGroupedIndicatorResultForGroup(items, groupId, _bollAndGroup, BullBollingerPasses(candles, candleIndex));
            AddGroupedIndicatorResultForGroup(items, groupId, _linRegAndGroup, BullLinRegPasses(candles, candleIndex));
            AddGroupedIndicatorResultForGroup(items, groupId, _volumeAndGroup, BullVolumePasses(candles, candleIndex));
            AddGroupedIndicatorResultForGroup(items, groupId, _vwapAndGroup, BullVwapPasses(candles, candleIndex));
            AddGroupedIndicatorResultForGroup(items, groupId, _atrAndGroup, BullAtrPasses(candleIndex));
            AddGroupedIndicatorResultForGroup(items, groupId, _macdAndGroup, BullMacdPasses(candleIndex));

            if (items.Count == 0)
            {
                return false;
            }

            if (!items.All(x => x.pass))
            {
                return false;
            }

            return !VolumeTodFilterBlocksSignal(candles, candleIndex);
        }

        private bool IsBearSignalForGroup(List<Candle> candles, int groupId, int candleIndex)
        {
            var items = new List<(int group, bool pass)>();
            AddGroupedIndicatorResultForGroup(items, groupId, _smaAndGroup, BearSmaPasses(candles, candleIndex));
            AddGroupedIndicatorResultForGroup(items, groupId, _rsiAndGroup, BearRsiPasses(candles, candleIndex));
            AddGroupedIndicatorResultForGroup(items, groupId, _stochAndGroup, BearStochPasses(candles, candleIndex));
            AddGroupedIndicatorResultForGroup(items, groupId, _momAndGroup, BearMomentumPasses(candles, candleIndex));
            AddGroupedIndicatorResultForGroup(items, groupId, _bollAndGroup, BearBollingerPasses(candles, candleIndex));
            AddGroupedIndicatorResultForGroup(items, groupId, _linRegAndGroup, BearLinRegPasses(candles, candleIndex));
            AddGroupedIndicatorResultForGroup(items, groupId, _volumeAndGroup, BearVolumePasses(candles, candleIndex));
            AddGroupedIndicatorResultForGroup(items, groupId, _vwapAndGroup, BearVwapPasses(candles, candleIndex));
            AddGroupedIndicatorResultForGroup(items, groupId, _atrAndGroup, BearAtrPasses(candleIndex));
            AddGroupedIndicatorResultForGroup(items, groupId, _macdAndGroup, BearMacdPasses(candleIndex));

            if (items.Count == 0)
            {
                return false;
            }

            if (!items.All(x => x.pass))
            {
                return false;
            }

            return !VolumeTodFilterBlocksSignal(candles, candleIndex);
        }

        private static void AddGroupedIndicatorResultForGroup(
            List<(int group, bool pass)> items,
            int targetGroupId,
            IndicatorParameterString groupParam,
            bool? passResult)
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
                if (groupKey != targetGroupId)
                {
                    continue;
                }

                bool groupPass = pass;
                if (raw < 0)
                {
                    groupPass = !groupPass;
                }

                items.Add((groupKey, groupPass));
            }
        }

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

        private static decimal SeriesValueAt(Aindicator indicator, int seriesIndex, int candleIndex)
        {
            if (indicator?.DataSeries == null || seriesIndex >= indicator.DataSeries.Count)
            {
                return 0m;
            }

            List<decimal> values = indicator.DataSeries[seriesIndex].Values;
            if (values == null || candleIndex < 0 || candleIndex >= values.Count)
            {
                return 0m;
            }

            return values[candleIndex];
        }

        #region Indicator pass rules (TrendMultiIndicatorScreener)

        private bool? BullSmaPasses(List<Candle> candles, int candleIndex)
        {
            if (!_useSma.ValueBool)
            {
                return null;
            }

            decimal close = candles[candleIndex].Close;
            decimal v = SeriesValueAt(_sma, 0, candleIndex);
            return v != 0 && close > v;
        }

        private bool? BearSmaPasses(List<Candle> candles, int candleIndex)
        {
            if (!_useSma.ValueBool)
            {
                return null;
            }

            decimal close = candles[candleIndex].Close;
            decimal v = SeriesValueAt(_sma, 0, candleIndex);
            return v != 0 && close < v;
        }

        private bool? BullRsiPasses(List<Candle> candles, int candleIndex)
        {
            if (!_useRsi.ValueBool)
            {
                return null;
            }

            decimal v = SeriesValueAt(_rsi, 0, candleIndex);
            return v != 0 && v >= _rsiLongMin.ValueDecimal;
        }

        private bool? BearRsiPasses(List<Candle> candles, int candleIndex)
        {
            if (!_useRsi.ValueBool)
            {
                return null;
            }

            decimal v = SeriesValueAt(_rsi, 0, candleIndex);
            return v != 0 && v <= _rsiShortMax.ValueDecimal;
        }

        private bool? BullStochPasses(List<Candle> candles, int candleIndex)
        {
            if (!_useStoch.ValueBool)
            {
                return null;
            }

            decimal k = SeriesValueAt(_stoch, 0, candleIndex);
            return k != 0 && k >= _stochLongMin.ValueDecimal;
        }

        private bool? BearStochPasses(List<Candle> candles, int candleIndex)
        {
            if (!_useStoch.ValueBool)
            {
                return null;
            }

            decimal k = SeriesValueAt(_stoch, 0, candleIndex);
            return k != 0 && k <= _stochShortMax.ValueDecimal;
        }

        private bool? BullMomentumPasses(List<Candle> candles, int candleIndex)
        {
            if (!_useMomentum.ValueBool)
            {
                return null;
            }

            decimal v = SeriesValueAt(_momentum, 0, candleIndex);
            return v != 0 && v >= _momLongMin.ValueDecimal;
        }

        private bool? BearMomentumPasses(List<Candle> candles, int candleIndex)
        {
            if (!_useMomentum.ValueBool)
            {
                return null;
            }

            decimal v = SeriesValueAt(_momentum, 0, candleIndex);
            return v != 0 && v <= _momShortMax.ValueDecimal;
        }

        private bool? BullBollingerPasses(List<Candle> candles, int candleIndex)
        {
            if (!_useBollinger.ValueBool)
            {
                return null;
            }

            decimal close = candles[candleIndex].Close;
            decimal up = SeriesValueAt(_bollinger, 0, candleIndex);
            decimal down = SeriesValueAt(_bollinger, 1, candleIndex);
            if (up == 0 || down == 0)
            {
                return false;
            }

            decimal mid = (up + down) / 2m;
            return close > mid;
        }

        private bool? BearBollingerPasses(List<Candle> candles, int candleIndex)
        {
            if (!_useBollinger.ValueBool)
            {
                return null;
            }

            decimal close = candles[candleIndex].Close;
            decimal up = SeriesValueAt(_bollinger, 0, candleIndex);
            decimal down = SeriesValueAt(_bollinger, 1, candleIndex);
            if (up == 0 || down == 0)
            {
                return false;
            }

            decimal mid = (up + down) / 2m;
            return close < mid;
        }

        private bool? BullLinRegPasses(List<Candle> candles, int candleIndex)
        {
            if (!_useLinReg.ValueBool)
            {
                return null;
            }

            decimal close = candles[candleIndex].Close;
            decimal up = SeriesValueAt(_linReg, 0, candleIndex);
            return up != 0 && close > up;
        }

        private bool? BearLinRegPasses(List<Candle> candles, int candleIndex)
        {
            if (!_useLinReg.ValueBool)
            {
                return null;
            }

            decimal close = candles[candleIndex].Close;
            decimal down = SeriesValueAt(_linReg, 2, candleIndex);
            return down != 0 && close < down;
        }

        private bool? BullVolumePasses(List<Candle> candles, int candleIndex)
        {
            if (!_useVolumeIndicator.ValueBool)
            {
                return null;
            }

            return VolumeIndicatorGrowthOk(candles, candleIndex);
        }

        private bool? BearVolumePasses(List<Candle> candles, int candleIndex)
        {
            if (!_useVolumeIndicator.ValueBool)
            {
                return null;
            }

            return VolumeIndicatorGrowthOk(candles, candleIndex);
        }

        private bool? BullVwapPasses(List<Candle> candles, int candleIndex)
        {
            if (!_useVwap.ValueBool)
            {
                return null;
            }

            decimal close = candles[candleIndex].Close;
            decimal v = SeriesValueAt(_vwap, 0, candleIndex);
            return v != 0 && close > v;
        }

        private bool? BearVwapPasses(List<Candle> candles, int candleIndex)
        {
            if (!_useVwap.ValueBool)
            {
                return null;
            }

            decimal close = candles[candleIndex].Close;
            decimal v = SeriesValueAt(_vwap, 0, candleIndex);
            return v != 0 && close < v;
        }

        private bool? BullAtrPasses(int candleIndex)
        {
            return AtrVolatilityFilterPasses(candleIndex);
        }

        private bool? BearAtrPasses(int candleIndex)
        {
            return AtrVolatilityFilterPasses(candleIndex);
        }

        private bool? AtrVolatilityFilterPasses(int candleIndex)
        {
            if (!_useAtr.ValueBool)
            {
                return null;
            }

            int lookBack = Math.Max(1, _atrGrowLookBack.ValueInt);
            if (candleIndex < lookBack)
            {
                return false;
            }

            decimal atrLast = SeriesValueAt(_atr, 0, candleIndex);
            decimal atrPast = SeriesValueAt(_atr, 0, candleIndex - lookBack);
            if (atrLast == 0 || atrPast == 0)
            {
                return false;
            }

            decimal growPercent = atrLast / (atrPast / 100m) - 100m;
            return growPercent >= _atrGrowPercent.ValueDecimal;
        }

        private bool? BullMacdPasses(int candleIndex)
        {
            if (!_useMacd.ValueBool)
            {
                return null;
            }

            decimal macdLine = SeriesValueAt(_macd, 1, candleIndex);
            decimal signalLine = SeriesValueAt(_macd, 2, candleIndex);
            return macdLine != 0 && signalLine != 0 && macdLine > signalLine;
        }

        private bool? BearMacdPasses(int candleIndex)
        {
            if (!_useMacd.ValueBool)
            {
                return null;
            }

            decimal macdLine = SeriesValueAt(_macd, 1, candleIndex);
            decimal signalLine = SeriesValueAt(_macd, 2, candleIndex);
            return macdLine != 0 && signalLine != 0 && macdLine < signalLine;
        }

        private bool VolumeIndicatorGrowthOk(List<Candle> candles, int candleIndex)
        {
            if (candles == null || candleIndex < 1)
            {
                return false;
            }

            decimal curVol = candles[candleIndex].Volume;
            decimal prevVol = candles[candleIndex - 1].Volume;
            decimal pct = _volumeIndicatorMinGrowthPercent.ValueDecimal;

            if (prevVol <= 0m)
            {
                return curVol > 0m;
            }

            decimal minRequired = prevVol * (1m + pct / 100m);
            return curVol >= minRequired;
        }

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

        private bool VolumeTodFilterBlocksSignal(List<Candle> logicCandles, int candleIndex)
        {
            if (!_useVolumeTodCompare.ValueBool)
            {
                return false;
            }

            return !VolumeTodIntradayOk(logicCandles, candleIndex);
        }

        #endregion
    }
}
