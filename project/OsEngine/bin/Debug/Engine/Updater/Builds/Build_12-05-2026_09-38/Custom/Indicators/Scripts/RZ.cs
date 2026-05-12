using System.Collections.Generic;
using System.Drawing;
using OsEngine.Entity;

namespace OsEngine.Indicators
{
    [Indicator("RZ")]
    public class RZ : Aindicator
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
            if (_length.ValueInt > index - 11  )
            {
                _series.Values[index] = 0;
                return;
            }

            _series.Values[index] = 0 + candles.Summ(index - _length.ValueInt - 11, index - 11, _candlePoint.ValueString) / (_length.ValueInt);
        }
    }
}