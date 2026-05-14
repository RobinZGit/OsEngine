using OsEngine.Entity;
using System;
using System.Collections.Generic;
using System.Drawing;

namespace OsEngine.Indicators
{
    /*
     * =============================================================================
     * ИНДИКАТОР «Средняя прибыль Long» (AverageProfitLong) — как он работает
     * =============================================================================
     *
     * НАЗНАЧЕНИЕ
     * -----------
     * Оценивает «типичную» прибыль от условной длинной позиции (лонг), если бы вы
     * случайно выбрали момент входа и момент выхода только из свечей фиксированного
     * недавнего окна. Это не реальная торговля и не учёт комиссий.
     *
     * В режиме «в процентах» для каждой пары считается не сырой ход цены, а
     * относительное изменение в процентах: (Close_позже − Close_раньше) делится на
     * среднюю цену двух свечей пары ((Close₁+Close₂)/2) и умножается на 100.
     * В серию попадает среднее этих процентов по всем случайным парам.
     *
     * В режиме «абсолют» — как раньше: среднее (Close_позже − Close_раньше) в единицах цены.
     *
     * ПАРАМЕТРЫ
     * ----------
     * 1) «Период (свечей назад)» — сколько последних свечей участвуют в выборке.
     * 2) «Число случайных пар» — сколько независимых пар на один бар (Monte Carlo).
     * 3) «В процентах» — если да, серия в %; если нет — в единицах цены инструмента.
     *
     * АЛГОРИТМ НА ОДНОМ БАРЕ (OnProcess для индекса index)
     * ----------------------------------------------------
     * 1. Если данных меньше, чем `period` (index < period - 1), в серию пишется 0.
     * 2. Иначе окно [index - period + 1, index], внутри — `pairs` случайных пар
     *    (две разные свечи, упорядоченные по времени: earlier → later).
     * 3. Для пары: diff = later.Close - earlier.Close.
     *    В процентах: mid = (earlier.Close + later.Close) / 2; если |mid| слишком мало,
     *    пара пропускается (не входит в среднее). Иначе вклад = 100 * diff / mid.
     * 4. Среднее по учтённым парам (в процентах — только по парам с ненулевой серединой).
     *
     * =============================================================================
     */

    /// <summary>
    /// Средняя по случайным парам свечей доходность виртуального лонга внутри окна:
    /// в процентах от средней Close пары или в абсолютных единицах цены.
    /// </summary>
    [Indicator("AverageProfitLong")]
    public class AverageProfitLong : Aindicator
    {
        private static readonly decimal MinMidAbs = 1e-12m;

        /// <summary>Длина окна: сколько последних свечей участвуют в случайном выборе пар.</summary>
        private IndicatorParameterInt _period;

        /// <summary>Сколько независимых случайных пар обрабатывается на одном баре (чем больше — тем гладче среднее).</summary>
        private IndicatorParameterInt _pairsCount;

        /// <summary>Если true — серия в процентах (среднее 100·ΔClose/средняя_цена_пары); иначе — среднее ΔClose в цене.</summary>
        private IndicatorParameterBool _asPercent;

        /// <summary>Одна линия: средняя доходность лонга по описанной схеме.</summary>
        private IndicatorDataSeries _series;

        public override void OnStateChange(IndicatorState state)
        {
            if (state == IndicatorState.Configure)
            {
                _period = CreateParameterInt("Период (свечей назад)", 50);
                _pairsCount = CreateParameterInt("Число случайных пар", 100);
                _asPercent = CreateParameterBool("В процентах от средней цены пары", true);
                _series = CreateSeries("Средняя доходность Long", Color.SeaGreen, IndicatorChartPaintType.Line, true);
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
