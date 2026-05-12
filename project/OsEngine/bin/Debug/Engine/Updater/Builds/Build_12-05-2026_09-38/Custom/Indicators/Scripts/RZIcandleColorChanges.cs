using System.Collections.Generic;
using System.Drawing;
using OsEngine.Entity;

namespace OsEngine.Indicators
{
    [Indicator("RZIcandleColorChanges")]
    public class RZIgreenRedChanges : Aindicator
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
            if (candles.Count > (_length.ValueInt + 1))
                for (int i = 1; i < _length.ValueInt; i+= _step.ValueInt){
                if ((index - i - _step.ValueInt) < 0) continue;
                if (//true ||
                    ((candles[index - i].Open > candles[index - i].Close) 
                    && (candles[index - i -  _step.ValueInt].Open < candles[index - i  -  _step.ValueInt].Close) 
                    //&& (sсolor == "RG"))
                    //||
                    //((candles[index - i].Open < candles[index - i].Close) 
                   // && (candles[index - i - _step.ValueInt].Open > candles[index - i - _step.ValueInt].Close) 
                    //&& (sсolor == "GR")
                    )
                ) ret++; 
                /*
                if (
                    ((candles[index - i].Open < candles[index - i].Close) 
                    && (candles[index - i - _step.ValueInt].Open > candles[index - i - _step.ValueInt].Close) 
                    //&& (sсolor == "GR")
                    )
                   ) ret--; 
                */
                }
            _series.Values[index] = ret;

        }
    }
}