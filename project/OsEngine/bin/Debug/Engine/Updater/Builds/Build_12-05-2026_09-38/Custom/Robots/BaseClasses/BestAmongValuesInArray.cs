using System;
using System.Collections.Generic;

public static class MaxAbsentSuffixFromEnd
{
    /// <summary>
    /// Для каждого значения v из массива: длина самого длинного суффикса arr[k..n-1],
    /// в котором v не встречается (эквивалентно: n - 1 - lastIndex(v)).
    /// Возвращает v с максимальной длиной; при равенстве — наименьшее v.
    /// </summary>
    public static int BestAmongValuesInArray(int[] arr)
    {
        if (arr == null || arr.Length == 0)
            throw new ArgumentException("Array is null or empty.");

        var last = new Dictionary<int, int>();
        for (int i = 0; i < arr.Length; i++)
            last[arr[i]] = i;

        int n = arr.Length;
        int bestValue = 0;
        int bestLen = int.MinValue;

        foreach (var kv in last)
        {
            int v = kv.Key;
            int lastIdx = kv.Value;
            int suffixWithoutV = n - 1 - lastIdx;

            if (suffixWithoutV > bestLen || (suffixWithoutV == bestLen && v < bestValue))
            {
                bestLen = suffixWithoutV;
                bestValue = v;
            }
        }

        return bestValue;
    }

    /// <summary>
    /// Если можно взять любое целое: любое число, которого нет в массве, даёт суффикс длины n.
    /// Возвращает, например, минимальное целое, отсутствующее в массиве (если есть "дырки" между min и max).
    /// Иначе max+1.
    /// </summary>
    public static int BestIfAnyIntegerAllowed(int[] arr)
    {
        if (arr == null || arr.Length == 0)
            throw new ArgumentException("Array is null or empty.");

        var set = new HashSet<int>(arr);
        int min = int.MaxValue, max = int.MinValue;
        foreach (int x in arr)
        {
            if (x < min) min = x;
            if (x > max) max = x;
        }

        for (int v = min; v <= max; v++)
        {
            if (!set.Contains(v))
                return v;
        }

        return max + 1;
    }
}