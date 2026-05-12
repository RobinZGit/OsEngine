//RZIbigChangesCount
using System.Collections.Generic;
using System.Drawing;
using OsEngine.Entity;

namespace OsEngine.Indicators
{
    [Indicator("RZIbigChangesCount")]
    public class RZIbigChangesCount : Aindicator
    {
        private IndicatorParameterInt _length;
        
        private IndicatorParameterInt _step;

        private IndicatorParameterDecimal _nPercPorog;

        private IndicatorParameterString _candlePoint;

        private IndicatorDataSeries _series;

        private IndicatorDataSeries _seriesTest;

        public override void OnStateChange(IndicatorState state)
        {
            if (state == IndicatorState.Configure)
            {
                _length = CreateParameterInt("Смотреть свечей назад", 80);
                _step = CreateParameterInt("Шаг в цикле подсчета по свечам", 1);
                _nPercPorog = CreateParameterDecimal("При превышении данного процента средей ценой изменение считается большим", 0.04m);
                _candlePoint = CreateParameterStringCollection("Candle Point", "Close", Entity.CandlePointsArray);
                _series = CreateSeries("Ma", Color.DodgerBlue, IndicatorChartPaintType.Line, true);
                //_seriesTest = CreateSeries("Test", Color.DarkGreen, IndicatorChartPaintType.Line, true);
            }
        }

        public override void OnProcess(List<Candle> candles, int index)
        {
            if (_length.ValueInt > index - 1  )
            {
                _series.Values[index] = 0;
                return;
            }
            decimal ret = 0m;
            decimal nPercPorog = _nPercPorog.ValueDecimal;
            if (index > (_length.ValueInt + 1))
                for (int i = 1; i < _length.ValueInt; i+= _step.ValueInt){
                    if ((index - i -  _step.ValueInt) < 0) continue;
                    decimal delta = 1m - (((candles[index - i - _step.ValueInt].Close + candles[index - i - _step.ValueInt].Open) / 2m) 
                                      / ((candles[index - i].Close + candles[index - i].Open + 0.00001m)/2m))
                                    ;
                    if (
                        ((delta > (nPercPorog / 100m)) //&& (sсolor == "green"))
                       //||
                        //((delta < -(nPercPorog / 100m)) && (sсolor == "red")
                        )
                    ) ret = ret + 1.0m;
                }      
            _series.Values[index] = ret;

        }
    }
}