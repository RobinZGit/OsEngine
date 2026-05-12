using OsEngine.Entity;
using System;
using System.Collections.Generic;
using System.Drawing;

/*

Создай новый индикатор в папке ...osengine/bin/debug/custom/indicators/scripts. 
Индикатор должен по скрии свечей сделать следующее.
1. Дискретизация - по массиву значений средних цен (candle.Open+candle.close)/2 
   выдать массив целых чисел по принципу попадания цены в диапазон от максимальной 
    до минимальной цены всего массива свечей. номер  диапазона равен этому целому числу. 
2. Поиск наиболее далеко встречающейся пары 
   - логику взять в методе BestAmongPairsInMinMaxRange(int[] arr)
   , но переписать его код в самом индикаторе. 
3. Индикатор должен выдавать на выходе две серии - первая для первого числа пары
  , вторая для второго
4. добавь ему третью серию - номер диапазона, умноженный на часть цены одного диапазона.
    чтобы индикатор можно было положить на область графика

  Формула
Ширина одного диапазона в цене: pricePerRange = (maxMid − minMid) / (levels − 1) (при minMid == maxMid — ноль).
Для текущего бара берётся номер диапазона d = discrete[index].
В серию пишется minMid + d * pricePerRange — это нижняя граница зоны дискретизации в тех же единицах, что и цена, чтобы линию можно было накладывать на основной график.
Чистое произведение d * pricePerRange дало бы величину порядка ширины диапазона, а не уровень цены инструмента, поэтому к нему добавлен minMid. Если нужен именно только сдвиг без minMid, напишите — поменяем одну строку.
  

*/

namespace OsEngine.Indicators
{
    /// <summary>
    /// Дискретизация средних цен (Open+Close)/2 по диапазону [min..max] средних на всём окне свечей;
    /// по массиву уровней ищется пара с максимальной длиной суффикса без подряд встречающейся пары (см. логику BestAmongPairsInMinMaxRange).
    /// </summary>
    [Indicator("DiscreteMidBestPair")]
    public class DiscreteMidBestPair : Aindicator
    {
        private IndicatorParameterInt _discretizationLevels;
        private IndicatorDataSeries _seriesPairFirst;
        private IndicatorDataSeries _seriesPairSecond;
        /// <summary>Номер диапазона × ширина одного диапазона в цене, отнесённый к minMid — линия в шкале цены графика.</summary>
        private IndicatorDataSeries _seriesDiscreteMidPrice;

        public override void OnStateChange(IndicatorState state)
        {
            if (state == IndicatorState.Configure)
            {
                _discretizationLevels = CreateParameterInt("Discretization levels", 32);
                _seriesPairFirst = CreateSeries("Pair first", Color.DodgerBlue, IndicatorChartPaintType.Line, true);
                _seriesPairSecond = CreateSeries("Pair second", Color.OrangeRed, IndicatorChartPaintType.Line, true);
                _seriesDiscreteMidPrice = CreateSeries("Discrete mid (price)", Color.MediumPurple, IndicatorChartPaintType.Line, true);
            }
        }

        public override void OnProcess(List<Candle> candles, int index)
        {
            if (index < 0 || candles == null || candles.Count <= index)
                return;

            int levels = _discretizationLevels.ValueInt;
            if (levels < 2)
                levels = 2;

            int count = index + 1;
            decimal minMid = decimal.MaxValue;
            decimal maxMid = decimal.MinValue;

            for (int i = 0; i < count; i++)
            {
                Candle c = candles[i];
                decimal mid = (c.Open + c.Close) * 0.5m;
                if (mid < minMid) minMid = mid;
                if (mid > maxMid) maxMid = mid;
            }

            var discrete = new int[count];
            decimal pricePerRange = 0;
            if (minMid == maxMid)
            {
                for (int i = 0; i < count; i++)
                    discrete[i] = 0;
            }
            else
            {
                decimal span = maxMid - minMid;
                pricePerRange = span / (levels - 1);
                for (int i = 0; i < count; i++)
                {
                    Candle c = candles[i];
                    decimal mid = (c.Open + c.Close) * 0.5m;
                    double t = (double)((mid - minMid) / span);
                    if (t < 0) t = 0;
                    if (t > 1) t = 1;
                    int bin = (int)Math.Floor(t * (levels - 1));
                    if (bin < 0) bin = 0;
                    if (bin >= levels) bin = levels - 1;
                    discrete[i] = bin;
                }
            }

            (int bestA, int bestB) = ComputeBestAmongPairsInMinMaxRange(discrete);

            _seriesPairFirst.Values[index] = bestA;
            _seriesPairSecond.Values[index] = bestB;
            // На шкале цены: нижняя граница зоны номера d = minMid + d * (цена одного диапазона)
            int d = discrete[index];
            _seriesDiscreteMidPrice.Values[index] = minMid + d * pricePerRange;
        }

        /// <summary>
        /// Аналог BestAmongPairsInMinMaxRange: для пар (a,b) с min(arr) ≤ a,b ≤ max(arr) —
        /// максимальная длина суффикса без подряд встречающейся пары; при равенстве — лексикографически меньшая пара.
        /// </summary>
        private static (int a, int b) ComputeBestAmongPairsInMinMaxRange(int[] arr)
        {
            if (arr == null || arr.Length == 0)
                throw new ArgumentException("Array is null or empty.");

            int n = arr.Length;
            int min = int.MaxValue;
            int max = int.MinValue;
            for (int i = 0; i < n; i++)
            {
                int x = arr[i];
                if (x < min) min = x;
                if (x > max) max = x;
            }

            var lastPairStart = new Dictionary<(int a, int b), int>();
            for (int i = 0; i < n - 1; i++)
                lastPairStart[(arr[i], arr[i + 1])] = i;

            int bestA = min;
            int bestB = min;
            int bestLen = int.MinValue;

            for (int a = min; a <= max; a++)
            {
                for (int b = min; b <= max; b++)
                {
                    int suffixWithoutPair = lastPairStart.TryGetValue((a, b), out int lastStart)
                        ? n - lastStart - 1
                        : n;

                    if (suffixWithoutPair > bestLen
                        || (suffixWithoutPair == bestLen && (a < bestA || (a == bestA && b < bestB))))
                    {
                        bestLen = suffixWithoutPair;
                        bestA = a;
                        bestB = b;
                    }
                }
            }

            return (bestA, bestB);
        }
    }
}
