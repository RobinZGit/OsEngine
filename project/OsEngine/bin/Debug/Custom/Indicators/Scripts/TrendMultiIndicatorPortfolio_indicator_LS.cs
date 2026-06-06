/*
 * Trend Multi-Indicator Portfolio LS — Long/Short split (no И-groups).
 * All enabled filters participate in one AND: bull = all bull passes, bear = all bear passes.
 *
 * Output series:
 *  1) Portfolio Long   — synthetic P&amp;L from long signals only
 *  2) SMA Portfolio Long — SMA of series 1
 *  3) Portfolio Short  — synthetic P&amp;L from short signals only
 *  4) SMA Portfolio Short — SMA of series 3
 */

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using OsEngine.Entity;

namespace OsEngine.Indicators
{
    // One-arg [Indicator] only: script compiler uses OsEngine.dll; second arg needs rebuilt OsEngine.
    // Until rebuild: select area "Second" in the chart indicator dialog (right column).
    [Indicator("TrendMultiIndicatorPortfolio_indicator_LS")]
    public class TrendMultiIndicatorPortfolio_indicator_LS : Aindicator
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
        private IndicatorParameterBool _useZigZag;

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
        private IndicatorParameterInt _zigZagLen;
        private IndicatorParameterInt _portfolioSmaLen;

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
        private Aindicator _zigZag;

        private const int ZigZagSeriesHighsIndex = 2;
        private const int ZigZagSeriesLowsIndex = 3;

        private IndicatorDataSeries _portfolioLongSeries;
        private IndicatorDataSeries _smaPortfolioLongSeries;
        private IndicatorDataSeries _portfolioShortSeries;
        private IndicatorDataSeries _smaPortfolioShortSeries;

        private readonly SidePortfolioState _longState = new SidePortfolioState();
        private readonly SidePortfolioState _shortState = new SidePortfolioState();

        private sealed class SidePortfolioState
        {
            public decimal Portfolio;
            public int Units;
        }

        public override void OnStateChange(IndicatorState state)
        {
            if (state != IndicatorState.Configure)
            {
                return;
            }

            NameArea = ChartAreaName;

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
            _useZigZag = CreateParameterBool("Use ZigZag", false);

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
            _zigZagLen = CreateParameterInt("ZigZag length", 14);
            _portfolioSmaLen = CreateParameterInt("Portfolio SMA length", 20);

            _portfolioLongSeries = CreateSeries(
                "Portfolio Long",
                Color.DodgerBlue,
                IndicatorChartPaintType.Line,
                true);
            _portfolioLongSeries.CanReBuildHistoricalValues = true;

            _smaPortfolioLongSeries = CreateSeries(
                "SMA Portfolio Long",
                Color.DeepSkyBlue,
                IndicatorChartPaintType.Line,
                true);
            _smaPortfolioLongSeries.CanReBuildHistoricalValues = true;

            _portfolioShortSeries = CreateSeries(
                "Portfolio Short",
                Color.OrangeRed,
                IndicatorChartPaintType.Line,
                true);
            _portfolioShortSeries.CanReBuildHistoricalValues = true;

            _smaPortfolioShortSeries = CreateSeries(
                "SMA Portfolio Short",
                Color.Gold,
                IndicatorChartPaintType.Line,
                true);
            _smaPortfolioShortSeries.CanReBuildHistoricalValues = true;

            CreateEmbeddedIndicators();
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

            _zigZag = IndicatorsFactory.CreateIndicatorByName("ZigZag", Name + "ZigZag", false);
            BindChildIntParameter(_zigZag, 0, _zigZagLen);
            ProcessIndicator("ZigZag", _zigZag);
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

        public override void OnProcess(List<Candle> candles, int index)
        {
            if (candles == null || index < 0 || index >= candles.Count)
            {
                return;
            }

            EnsureSeriesLength(index);

            if (index == 0)
            {
                ResetSideStates();
            }

            decimal close = candles[index].Close;

            bool bull = IsBullSignal(candles, index);
            bool bear = IsBearSignal(candles, index);

            ApplyLongPortfolioLogic(_longState, bull, bear, close);
            ApplyShortPortfolioLogic(_shortState, bull, bear, close);

            _portfolioLongSeries.Values[index] = _longState.Portfolio;
            _portfolioShortSeries.Values[index] = _shortState.Portfolio;
            _smaPortfolioLongSeries.Values[index] = ComputeSmaOfSeries(_portfolioLongSeries, index, _portfolioSmaLen.ValueInt);
            _smaPortfolioShortSeries.Values[index] = ComputeSmaOfSeries(_portfolioShortSeries, index, _portfolioSmaLen.ValueInt);
        }

        private void EnsureSeriesLength(int index)
        {
            EnsureOneSeriesLength(_portfolioLongSeries, index);
            EnsureOneSeriesLength(_smaPortfolioLongSeries, index);
            EnsureOneSeriesLength(_portfolioShortSeries, index);
            EnsureOneSeriesLength(_smaPortfolioShortSeries, index);
        }

        private static void EnsureOneSeriesLength(IndicatorDataSeries series, int index)
        {
            if (series?.Values == null)
            {
                return;
            }

            while (series.Values.Count <= index)
            {
                series.Values.Add(0m);
            }
        }

        private void ResetSideStates()
        {
            _longState.Portfolio = 0m;
            _longState.Units = 0;
            _shortState.Portfolio = 0m;
            _shortState.Units = 0;
        }

        /// <summary>Long-портфель: bull открывает/наращивает long, bear закрывает long-юниты.</summary>
        private static void ApplyLongPortfolioLogic(SidePortfolioState state, bool bull, bool bear, decimal price)
        {
            if (price <= 0m)
            {
                return;
            }

            if (bear && state.Units > 0)
            {
                state.Portfolio += price;
                state.Units--;
            }

            if (bull)
            {
                state.Portfolio -= price;
                state.Units++;
            }
        }

        /// <summary>Short-портфель: bear открывает/наращивает short, bull закрывает short-юниты.</summary>
        private static void ApplyShortPortfolioLogic(SidePortfolioState state, bool bull, bool bear, decimal price)
        {
            if (price <= 0m)
            {
                return;
            }

            if (bull && state.Units > 0)
            {
                state.Portfolio -= price;
                state.Units--;
            }

            if (bear)
            {
                state.Portfolio += price;
                state.Units++;
            }
        }

        private static decimal ComputeSmaOfSeries(IndicatorDataSeries series, int index, int period)
        {
            if (series?.Values == null || index < 0)
            {
                return 0m;
            }

            int len = Math.Max(1, period);
            int start = Math.Max(0, index - len + 1);
            decimal sum = 0m;
            int count = 0;

            for (int i = start; i <= index; i++)
            {
                if (i >= series.Values.Count)
                {
                    break;
                }

                sum += series.Values[i];
                count++;
            }

            return count > 0 ? sum / count : 0m;
        }

        private bool IsBullSignal(List<Candle> candles, int candleIndex)
        {
            var passes = new List<bool>();
            AddEnabledIndicatorPass(passes, BullSmaPasses(candles, candleIndex));
            AddEnabledIndicatorPass(passes, BullRsiPasses(candles, candleIndex));
            AddEnabledIndicatorPass(passes, BullStochPasses(candles, candleIndex));
            AddEnabledIndicatorPass(passes, BullMomentumPasses(candles, candleIndex));
            AddEnabledIndicatorPass(passes, BullBollingerPasses(candles, candleIndex));
            AddEnabledIndicatorPass(passes, BullLinRegPasses(candles, candleIndex));
            AddEnabledIndicatorPass(passes, BullVolumePasses(candles, candleIndex));
            AddEnabledIndicatorPass(passes, BullVwapPasses(candles, candleIndex));
            AddEnabledIndicatorPass(passes, BullAtrPasses(candleIndex));
            AddEnabledIndicatorPass(passes, BullMacdPasses(candleIndex));
            AddEnabledIndicatorPass(passes, BullZigZagPasses(candleIndex));

            if (passes.Count == 0)
            {
                return false;
            }

            if (!passes.All(x => x))
            {
                return false;
            }

            return !VolumeTodFilterBlocksSignal(candles, candleIndex);
        }

        private bool IsBearSignal(List<Candle> candles, int candleIndex)
        {
            var passes = new List<bool>();
            AddEnabledIndicatorPass(passes, BearSmaPasses(candles, candleIndex));
            AddEnabledIndicatorPass(passes, BearRsiPasses(candles, candleIndex));
            AddEnabledIndicatorPass(passes, BearStochPasses(candles, candleIndex));
            AddEnabledIndicatorPass(passes, BearMomentumPasses(candles, candleIndex));
            AddEnabledIndicatorPass(passes, BearBollingerPasses(candles, candleIndex));
            AddEnabledIndicatorPass(passes, BearLinRegPasses(candles, candleIndex));
            AddEnabledIndicatorPass(passes, BearVolumePasses(candles, candleIndex));
            AddEnabledIndicatorPass(passes, BearVwapPasses(candles, candleIndex));
            AddEnabledIndicatorPass(passes, BearAtrPasses(candleIndex));
            AddEnabledIndicatorPass(passes, BearMacdPasses(candleIndex));
            AddEnabledIndicatorPass(passes, BearZigZagPasses(candleIndex));

            if (passes.Count == 0)
            {
                return false;
            }

            if (!passes.All(x => x))
            {
                return false;
            }

            return !VolumeTodFilterBlocksSignal(candles, candleIndex);
        }

        private static void AddEnabledIndicatorPass(List<bool> passes, bool? passResult)
        {
            if (!passResult.HasValue)
            {
                return;
            }

            passes.Add(passResult.Value);
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

        /// <summary>ZigZag: восходящая нога (последний свинг — low после high).</summary>
        private bool? BullZigZagPasses(int candleIndex)
        {
            if (!_useZigZag.ValueBool)
            {
                return null;
            }

            return ZigZagDirectionPasses(candleIndex, wantUptrend: true);
        }

        /// <summary>ZigZag: нисходящая нога (последний свинг — high после low).</summary>
        private bool? BearZigZagPasses(int candleIndex)
        {
            if (!_useZigZag.ValueBool)
            {
                return null;
            }

            return ZigZagDirectionPasses(candleIndex, wantUptrend: false);
        }

        private bool? ZigZagDirectionPasses(int candleIndex, bool wantUptrend)
        {
            if (_zigZag?.DataSeries == null || _zigZag.DataSeries.Count <= ZigZagSeriesLowsIndex)
            {
                return false;
            }

            List<decimal> zzHigh = _zigZag.DataSeries[ZigZagSeriesHighsIndex].Values;
            List<decimal> zzLow = _zigZag.DataSeries[ZigZagSeriesLowsIndex].Values;

            if (zzHigh == null || zzLow == null || zzHigh.Count == 0 || zzLow.Count == 0)
            {
                return false;
            }

            if (candleIndex < 0)
            {
                candleIndex = Math.Min(zzHigh.Count, zzLow.Count) - 1;
            }

            if (candleIndex < _zigZagLen.ValueInt * 2)
            {
                return false;
            }

            bool uptrend = ZigZagIsUptrendAt(zzLow, zzHigh, candleIndex);
            return uptrend == wantUptrend;
        }

        private static bool ZigZagIsUptrendAt(List<decimal> zzLow, List<decimal> zzHigh, int candleIndex)
        {
            int indexLow = -1;
            int indexHigh = -1;
            int end = Math.Min(candleIndex, Math.Min(zzLow.Count, zzHigh.Count) - 1);

            for (int i = end; i >= 0; i--)
            {
                if (indexLow < 0 && i < zzLow.Count && zzLow[i] != 0)
                {
                    indexLow = i;
                }

                if (indexHigh < 0 && i < zzHigh.Count && zzHigh[i] != 0)
                {
                    indexHigh = i;
                }

                if (indexLow >= 0 && indexHigh >= 0)
                {
                    break;
                }
            }

            if (indexLow < 0 || indexHigh < 0)
            {
                return false;
            }

            return indexLow > indexHigh;
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
