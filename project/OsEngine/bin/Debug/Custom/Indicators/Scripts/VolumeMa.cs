using System;
using System.Collections.Generic;
using System.Drawing;
using OsEngine.Entity;
using OsEngine.Indicators;

namespace OsEngine.Indicators
{
    /// <summary>
    /// Индикатор Volume MA — скользящее среднее объёма с мультипликатором
    /// </summary>
    [Indicator("VolumeMa")]
    public class VolumeMa : Aindicator
    {
        // --- Параметры ---
        private IndicatorParameterInt _maPeriod;
        private IndicatorParameterString _maType;
        private IndicatorParameterDecimal _volumeMultiplier;

        // --- Линии индикатора ---
        private IndicatorDataSeries _volumeMaSeries;
        private IndicatorDataSeries _volumeMaUpperSeries;
        private IndicatorDataSeries _volumeMaLowerSeries;

        public override void OnStateChange(IndicatorState state)
        {
            if (state == IndicatorState.Configure)
            {
                // Параметр: период скользящей средней
                _maPeriod = CreateParameterInt("Volume MA Period", 20);

                // Параметр: тип MA (SMA, EMA)
                _maType = CreateParameterStringCollection(
                    "MA Type", "SMA",
                    new List<string> { "SMA", "EMA" });
                
                //CreateParameterString("MA Type", "SMA");
                //_maType.Values = new List<string> { "SMA", "EMA" };

                // Параметр: мультипликатор объёма
                _volumeMultiplier = CreateParameterDecimal("Volume Multiplier", 1.5m);

                // Основная линия — Volume MA
                _volumeMaSeries = CreateSeries("Volume MA", Color.DodgerBlue, IndicatorChartPaintType.Line, true);

                // Верхняя граница — Volume MA * Multiplier
                _volumeMaUpperSeries = CreateSeries("Volume MA Upper", Color.LimeGreen, IndicatorChartPaintType.Line, true);

                // Нижняя граница — Volume MA / Multiplier
                _volumeMaLowerSeries = CreateSeries("Volume MA Lower", Color.Crimson, IndicatorChartPaintType.Line, true);
            }
        }

        public override void OnProcess(List<Candle> candles, int index)
        {
            if (index < 0 || candles == null || candles.Count == 0)
                return;

            // Получаем объём текущей свечи
            decimal currentVolume = candles[index].Volume;
            int period = _maPeriod.ValueInt;
            decimal multiplier = _volumeMultiplier.ValueDecimal;

            decimal volumeMa = 0;

            // --- Расчёт Volume MA ---
            if (_maType.ValueString == "SMA")
            {
                // Простое скользящее среднее объёма
                decimal sum = 0;
                int startIndex = Math.Max(0, index - period + 1);
                int count = index - startIndex + 1;

                if (count < period)
                {
                    // Недостаточно данных — не рисуем линию
                    _volumeMaSeries.Values[index] = 0;
                    _volumeMaUpperSeries.Values[index] = 0;
                    _volumeMaLowerSeries.Values[index] = 0;
                    return;
                }

                for (int i = startIndex; i <= index; i++)
                {
                    sum += candles[i].Volume;
                }

                volumeMa = sum / period;
            }
            else if (_maType.ValueString == "EMA")
            {
                // Экспоненциальное скользящее среднее объёма
                decimal emaMultiplier = 2m / (period + 1);

                if (index == 0 || _volumeMaSeries.Values[index - 1] == 0)
                {
                    volumeMa = currentVolume;
                }
                else
                {
                    decimal prevEma = _volumeMaSeries.Values[index - 1];
                    volumeMa = (currentVolume - prevEma) * emaMultiplier + prevEma;
                }
            }

            // Записываем значения
            _volumeMaSeries.Values[index] = volumeMa;
            _volumeMaUpperSeries.Values[index] = volumeMa * multiplier;
            _volumeMaLowerSeries.Values[index] = volumeMa / multiplier;
        }

        public string TypeName()
        {
            return "VolumeMa";
        }
    }
}
