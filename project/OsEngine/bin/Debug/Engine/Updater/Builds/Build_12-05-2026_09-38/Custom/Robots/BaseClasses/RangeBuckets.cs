using System;

public class RangeBuckets
{
    /// <summary>
    /// Диапазон [min, max] по массиву делится на <paramref name="parts"/> равных частей.
    /// Для каждого элемента возвращается номер части: 0 .. parts-1.
    /// </summary>
    /// <param name="values">Исходные числа.</param>
    /// <param name="parts">Число диапазонов (должно быть >= 1).</param>
    public static int[] GetRangeIndices(double[] values, int parts)
    {
        if (values == null) throw new ArgumentNullException(nameof(values));
        if (parts < 1) throw new ArgumentOutOfRangeException(nameof(parts));

        if (values.Length == 0)
            return Array.Empty<int>();

        double min = values[0], max = values[0];
        for (int i = 1; i < values.Length; i++)
        {
            if (values[i] < min) min = values[i];
            if (values[i] > max) max = values[i];
        }

        var result = new int[values.Length];

        double span = max - min;
        if (span == 0)
        {
            for (int i = 0; i < values.Length; i++)
                result[i] = 0;
            return result;
        }

        for (int i = 0; i < values.Length; i++)
        {
            double t = (values[i] - min) / span; // [0, 1]
            int idx = (int)Math.Floor(t * parts);

            if (idx < 0) idx = 0;
            if (idx >= parts) idx = parts - 1; // max попадает в последний диапазон

            result[i] = idx;
        }

        return result;
    }

    /// Перегрузка для int[].
    public static int[] GetRangeIndices(int[] values, int parts)
    {
        if (values == null) throw new ArgumentNullException(nameof(values));

        var d = new double[values.Length];
        for (int i = 0; i < values.Length; i++)
            d[i] = values[i];

        return GetRangeIndices(d, parts);
    }
}