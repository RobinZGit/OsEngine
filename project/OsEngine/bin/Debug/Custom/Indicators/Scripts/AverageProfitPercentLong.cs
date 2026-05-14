using OsEngine.Entity;
using System;
using System.Collections.Generic;
using System.Drawing;

namespace OsEngine.Indicators
{
    /*
     * =============================================================================
     * ИНДИКАТОР «Average Profit Percent Long» — как он работает
     * =============================================================================
     *
     * НАЗНАЧЕНИЕ
     * -----------
     * Оценивает «типичную» прибыль от условной длинной позиции (лонг), если бы вы
     * случайно выбрали момент входа и момент выхода только из свечей фиксированного
     * недавнего окна. Это не реальная торговля и не учёт комиссий.
     *
     * В режиме «в процентах» для каждой пары считается относительное изменение в %:
     * (Close_позже − Close_раньше) / ((Close₁+Close₂)/2) × 100.
     * В серию попадает среднее этих процентов по всем случайным парам.
     *
     * В режиме «абсолют» — среднее (Close_позже − Close_раньше) в единицах цены.
     *
     * ПАРАМЕТРЫ
     * ----------
     * 1) «Период (свечей назад)» — размер окна для выборки пар.
     * 2) «Число случайных пар» — итераций Monte Carlo на бар.
     * 3) «В процентах от средней цены пары» — серия в % или в цене.
     *
     * =============================================================================
     */

    /// <summary>
    /// Средняя по случайным парам свечей доходность виртуального лонга внутри окна:
    /// в процентах от средней Close пары или в абсолютных единицах цены.
    /// </summary>
    [Indicator("Average Profit Percent Long")]
    public class AverageProfitPercentLong : Aindicator
    {
        private static readonly decimal MinMidAbs = 1e-12m;

        private IndicatorParameterInt _period;

        private IndicatorParameterInt _pairsCount;

        private IndicatorParameterBool _asPercent;

        private IndicatorDataSeries _series;

        public override void OnStateChange(IndicatorState state)
        {
            if (state == IndicatorState.Configure)
            {
                _period = CreateParameterInt("Период (свечей назад)", 50);
                _pairsCount = CreateParameterInt("Число случайных пар", 100);
                _asPercent = CreateParameterBool("В процентах от средней цены пары", true);
                _series = CreateSeries("Average Profit Percent Long", Color.SeaGreen, IndicatorChartPaintType.Line, true);
            }
            else if (state == IndicatorState.Dispose)
            {
                _series = null;
            }
        }

        public override void OnProcess(List<Candle> candles, int index)
        {
            int period = Math.Max(2, _period.ValueInt);
            int pairs = Math.Max(1, _pairsCount.ValueInt);
            bool asPercent = _asPercent.ValueBool;

            if (candles == null || index < period - 1)
            {
                _series.Values[index] = 0;
                return;
            }

            int windowStart = index - period + 1;

            long seedBase = candles[index].TimeStart.Ticks ^ (long)period << 16 ^ (long)pairs << 24;
            if (asPercent)
                seedBase ^= 0x5A5A5A5AL;
            int seed = unchecked((int)seedBase);
            var rnd = new Random(seed);

            decimal sum = 0;
            int counted = 0;

            for (int p = 0; p < pairs; p++)
            {
                int o1 = rnd.Next(0, period);
                int o2 = rnd.Next(0, period);
                while (o2 == o1)
                    o2 = rnd.Next(0, period);

                Candle a = candles[windowStart + o1];
                Candle b = candles[windowStart + o2];

                Candle earlier;
                Candle later;
                if (a.TimeStart < b.TimeStart)
                {
                    earlier = a;
                    later = b;
                }
                else if (a.TimeStart > b.TimeStart)
                {
                    earlier = b;
                    later = a;
                }
                else
                {
                    if (windowStart + o1 <= windowStart + o2)
                    {
                        earlier = a;
                        later = b;
                    }
                    else
                    {
                        earlier = b;
                        later = a;
                    }
                }

                decimal diff = later.Close - earlier.Close;

                if (asPercent)
                {
                    decimal mid = (earlier.Close + later.Close) / 2m;
                    if (Math.Abs(mid) < MinMidAbs)
                        continue;
                    sum += 100m * diff / mid;
                    counted++;
                }
                else
                {
                    sum += diff;
                    counted++;
                }
            }

            if (counted == 0)
                _series.Values[index] = 0;
            else
                _series.Values[index] = sum / counted;
        }
    }
}
