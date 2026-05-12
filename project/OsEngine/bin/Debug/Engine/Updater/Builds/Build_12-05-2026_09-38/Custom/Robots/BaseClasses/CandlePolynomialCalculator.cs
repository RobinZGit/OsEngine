using System;
using System.Collections.Generic;
/*
cursor ai
Класс должен содержать метод, который возвращает  decimal[][] retIndicator. 
На вход методу подается List<candle> candles и decimal[][] koeffs. 
Рассмотрим как многочлен с именем pCandles массив (candle[i].Close+candle[i].Open)/2, 
где последний индекс есть старшая степень многочлена.
Многочленами такого же типа для каждого i являются массивы koeffs[i] и retIndicator{i].
 Пусть символ "*" обозначает произведение многочленов, а символ "+" сумму многочленов. 
 Тогда метод должен вернуть 
 retIndicator = koeffs[0] + koeff[s1]*pCandles + koeffs[2]*pCandles*pCandles + koeffs[3]*pCandles*pCandles*pCandles
 - и так далее
*/
namespace OsEngine.Entity
{
    public static class CandlePolynomialCalculator
    {
        /// <summary>
        /// Build retIndicator = koeffs[0] + koeffs[1]*p + koeffs[2]*p*p + ...,
        /// where p is a polynomial built from candles: p[i] = (Open+Close)/2,
        /// and the last index is the highest degree (standard ascending degree order).
        /// </summary>
        public static decimal[][] BuildRetIndicator(List<Candle> candles, decimal[][] koeffs)
        {
            if (candles == null)
            {
                throw new ArgumentNullException(nameof(candles));
            }

            if (koeffs == null)
            {
                throw new ArgumentNullException(nameof(koeffs));
            }

            decimal[] pCandles = BuildPCandles(candles);

            // retIndicator[0] = total sum
            // retIndicator[i] = i-th term: koeffs[i] * p^i
            decimal[][] retIndicator = new decimal[koeffs.Length == 0 ? 1 : koeffs.Length][];

            decimal[] total = Array.Empty<decimal>();

            // pPow starts as 1 (p^0)
            decimal[] pPow = new decimal[] { 1m };

            for (int i = 0; i < koeffs.Length; i++)
            {
                decimal[] k = koeffs[i] ?? Array.Empty<decimal>();
                decimal[] term = Multiply(k, pPow);
                term = TrimTrailingZeros(term);

                retIndicator[i] = term;
                total = Add(total, term);

                pPow = Multiply(pPow, pCandles);
            }

            total = TrimTrailingZeros(total);

            if (retIndicator.Length == 0)
            {
                return new decimal[][] { total };
            }

            retIndicator[0] = total;
            return retIndicator;
        }

        private static decimal[] BuildPCandles(List<Candle> candles)
        {
            if (candles.Count == 0)
            {
                return Array.Empty<decimal>();
            }

            decimal[] p = new decimal[candles.Count];
            for (int i = 0; i < candles.Count; i++)
            {
                Candle c = candles[i];
                p[i] = (c.Open + c.Close) / 2m;
            }
            return TrimTrailingZeros(p);
        }

        /// <summary>
        /// Polynomial addition, degree order ascending: a[0] + a[1]x + ...
        /// </summary>
        private static decimal[] Add(decimal[] a, decimal[] b)
        {
            int lenA = a?.Length ?? 0;
            int lenB = b?.Length ?? 0;
            int len = Math.Max(lenA, lenB);

            if (len == 0)
            {
                return Array.Empty<decimal>();
            }

            decimal[] res = new decimal[len];

            for (int i = 0; i < len; i++)
            {
                decimal av = i < lenA ? a[i] : 0m;
                decimal bv = i < lenB ? b[i] : 0m;
                res[i] = av + bv;
            }

            return res;
        }

        /// <summary>
        /// Polynomial multiplication (convolution), degree order ascending.
        /// </summary>
        private static decimal[] Multiply(decimal[] a, decimal[] b)
        {
            int lenA = a?.Length ?? 0;
            int lenB = b?.Length ?? 0;

            if (lenA == 0 || lenB == 0)
            {
                return Array.Empty<decimal>();
            }

            decimal[] res = new decimal[lenA + lenB - 1];

            for (int i = 0; i < lenA; i++)
            {
                decimal ai = a[i];
                if (ai == 0m)
                {
                    continue;
                }

                for (int j = 0; j < lenB; j++)
                {
                    res[i + j] += ai * b[j];
                }
            }

            return TrimTrailingZeros(res);
        }

        private static decimal[] TrimTrailingZeros(decimal[] a)
        {
            if (a == null || a.Length == 0)
            {
                return Array.Empty<decimal>();
            }

            int last = a.Length - 1;
            while (last >= 0 && a[last] == 0m)
            {
                last--;
            }

            if (last < 0)
            {
                return Array.Empty<decimal>();
            }

            if (last == a.Length - 1)
            {
                return a;
            }

            decimal[] res = new decimal[last + 1];
            Array.Copy(a, res, res.Length);
            return res;
        }
    }
}

