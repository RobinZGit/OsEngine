using System.Collections.Generic;
using System.Drawing;
using OsEngine.Entity;

namespace OsEngine.Indicators
{
    [Indicator("RZIgreensMinusReds")]
    public class RZIgreensMinusReds : Aindicator
    {
        private IndicatorParameterInt _length;
        
        private IndicatorParameterInt _step;

        private IndicatorParameterString _candlePoint;

        private IndicatorDataSeries _series;

        public override void OnStateChange(IndicatorState state)
        {
            if (state == IndicatorState.Configure)
            {
                _length = CreateParameterInt("Смотреть свечей назад", 80);
                _step = CreateParameterInt("Шаг в цикле подсчета по свечам", 1);
                _candlePoint = CreateParameterStringCollection("Candle Point", "Close", Entity.CandlePointsArray);
                _series = CreateSeries("Ma", Color.DodgerBlue, IndicatorChartPaintType.Line, true);
            }
        }

        public override void OnProcess(List<Candle> candles, int index)
        {
            if (_length.ValueInt > index - 1  )
            {
                _series.Values[index] = 0;
                return;
            }
            int ret = 0;
            if (candles.Count > 0)
                for (int i = 1; i < _length.ValueInt; i+= _step.ValueInt)
                  if (candles[index - i].Open < candles[index - i].Close) ret++; else ret--;
            _series.Values[index] =  ret;

          
            //_series.Values[index] = 0 + candles.Summ(index - _length.ValueInt - 11, index - 11, _candlePoint.ValueString) / (_length.ValueInt);
        }
    }
}