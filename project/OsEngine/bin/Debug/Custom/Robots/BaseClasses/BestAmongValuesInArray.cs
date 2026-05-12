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

    /// <summary>
    /// Для упорядоченной пары (a, b), где min(arr) ≤ a, b ≤ max(arr): длина самого длинного суффикса,
    /// в котором нет подряд идущих элементов …, a, b, … (последнее вхождение пары начинается в индексе i,
    /// если arr[i]==a и arr[i+1]==b; длина суффикса без этой пары = n - i - 1).
    /// Если пара как соседние значения никогда не встречается, считается длина n.
    /// Возвращает пару с максимальной длиной; при равенстве — лексикографически наименьшая (a, b).
    /// </summary>
    public static (int a, int b) BestAmongPairsInMinMaxRange(int[] arr)
    {
        if (arr == null || arr.Length == 0)
            throw new ArgumentException("Array is null or empty.");

        int n = arr.Length;
        int min = int.MaxValue, max = int.MinValue;
        foreach (int x in arr)
        {
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