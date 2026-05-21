using System.Collections.Generic;
using System.Drawing;
using OsEngine.Entity;

namespace OsEngine.Indicators
{
    [Indicator("Sma")]
    public class Sma : Aindicator
    {
        private IndicatorParameterInt _length;

        private IndicatorParameterString _candlePoint;

        private IndicatorDataSeries _series;

        public override void OnStateChange(IndicatorState state)
        {
            if (state == IndicatorState.Configure)
            {
                _length = CreateParameterInt("Length", 14);
                _candlePoint = CreateParameterStringCollection("Candle Point", "Close", Entity.CandlePointsArray);
                _series = CreateSeries("Ma", Color.DodgerBlue, IndicatorChartPaintType.Line, true);
            }
        }

        public override void OnProcess(List<Candle> candles, int index)
        {
            if (candles == null || index < 0 || index >= candles.Count)
            {
                return;
            }

            while (_series.Values.Count <= index)
            {
                _series.Values.Add(0);
            }

            if (_length.ValueInt > index)
            {
                _series.Values[index] = 0;
                return;
            }

            _series.Values[index] = candles.Summ(index - _length.ValueInt, index, _candlePoint.ValueString) / _length.ValueInt;
        }
    }
}