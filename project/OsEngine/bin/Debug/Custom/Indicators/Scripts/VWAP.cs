using System;
using System.Collections.Generic;
using System.Drawing;
using OsEngine.Entity;

namespace OsEngine.Indicators
{
    /// <summary>
    /// VWAP (типичная цена HLC/3, взвешенная по объёму). Сброс накопления в начале каждого календарного дня.
    /// </summary>
    [Indicator("VWAP")]
    public class VWAP : Aindicator
    {
        private IndicatorDataSeries _series;

        private decimal _cumTypVol;
        private decimal _cumVol;
        private DateTime _sessionDate = DateTime.MinValue;

        public override void OnStateChange(IndicatorState state)
        {
            if (state == IndicatorState.Configure)
            {
                _series = CreateSeries("VWAP", Color.MediumPurple, IndicatorChartPaintType.Line, true);
            }
            else if (state == IndicatorState.Dispose)
            {
                _series = null;
                _cumTypVol = 0;
                _cumVol = 0;
                _sessionDate = DateTime.MinValue;
            }
        }

        public override void OnProcess(List<Candle> candles, int index)
        {
            if (candles == null || index < 0 || index >= candles.Count)
            {
                return;
            }

            Candle candle = candles[index];
            DateTime day = candle.TimeStart.Date;

            if (index == 0 || day != _sessionDate)
            {
                _sessionDate = day;
                _cumTypVol = 0;
                _cumVol = 0;
            }

            decimal typical = (candle.High + candle.Low + candle.Close) / 3m;
            decimal volume = candle.Volume;

            if (volume <= 0m)
            {
                _series.Values[index] = index > 0 ? _series.Values[index - 1] : typical;
                return;
            }

            _cumTypVol += typical * volume;
            _cumVol += volume;
            _series.Values[index] = _cumVol > 0m ? Math.Round(_cumTypVol / _cumVol, 9) : typical;
        }
    }
}
