using System;
using System.Collections.Generic;
using System.Drawing;
using OsEngine.Entity;

namespace OsEngine.Indicators
{
    /*
     * =============================================================================
     * ИНДИКАТОР Fourier — как читать серии, гармоники и частоты
     * =============================================================================
     *
     * 1. ВХОДНОЙ РЯД
     *    На каждом баре index берётся окно из N последних свечей (параметр «Окно»).
     *    Дискретный сигнал (n = 0 … N−1, n=0 — самая старая свеча в окне, n=N−1 — текущая):
     *
     *        x[n] = (Open[n] + Close[n]) / 2
     *
     * 2. РАЗЛОЖЕНИЕ (тригонометрический ряд на конечном окне)
     *    Сигнал x[n] аппроксимируется суммой гармоник с периодом, укладывающимся в N баров:
     *
     *        x[n] ≈ a₀/2 + Σ_{k=1}^{K} [ aₖ·cos(2π·k·n/N) + bₖ·sin(2π·k·n/N) ]
     *
     *    где K = «Количество гармоник», коэффициенты (дискретные формулы, как в ряде Фурье):
     *
     *        aₖ = (2/N) · Σ_{n=0}^{N-1} x[n] · cos(2π·k·n/N)
     *        bₖ = (2/N) · Σ_{n=0}^{N-1} x[n] · sin(2π·k·n/N)
     *
     *    Постоянная составляющая (нулевая «гармоника», DC, среднее по окну):
     *
     *        a₀/2 = (1/N) · Σ x[n]     (в индикатор отдельной серией не выводится)
     *
     * 3. КАКАЯ СЕРИЯ — КАКАЯ ГАРМОНИКА
     *    Имена серий:  «H{k} cos»  и  «H{k} sin»,  k = 1, 2, …, K.
     *
     *    | Имя серии   | Номер гармоники k | Что хранится на баре index        |
     *    |-------------|-------------------|-----------------------------------|
     *    | H1 cos      | k = 1             | |a₁| — модуль коэффициента cos   |
     *    | H1 sin      | k = 1             | |b₁| — модуль коэффициента sin   |
     *    | H2 cos      | k = 2             | |a₂|                              |
     *    | H2 sin      | k = 2             | |b₂|                              |
     *    | …           | …                 | …                                 |
     *    | Hk cos      | k                 | |aₖ|                              |
     *    | Hk sin      | k                 | |bₖ|                              |
     *
     *    Номер k в названии («H3» → третья гармоника) — это число полных синусоид
     *    cos/sin внутри окна из N баров.
     *
     * 4. ЧАСТОТА ГАРМОНИКИ k
     *    Все частоты ниже — для дискретного времени «шаг = 1 свеча» внутри окна.
     *
     *    а) Нормированная частота (циклов на 1 бар):
     *           f_bar(k) = k / N
     *
     *    б) Период этой гармоники в барах (сколько свечей занимает один полный цикл):
     *           T_bar(k) = N / k
     *
     *    в) Сколько полных циклов укладывается в одно окно N свечей:
     *           cycles_in_window(k) = k   (ровно k периодов 2π на отрезке n=0…N−1)
     *
     *    г) Перевод в календарное время (если длительность одной свечи = Δt):
     *           T_time(k) = (N / k) · Δt
     *       Примеры Δt: M1 → 1 мин, M15 → 15 мин, H1 → 60 мин, D1 → 1 день.
     *       Пример: N=64, k=4, M15 → T_time = (64/4)·15 мин = 240 мин (4 часа на цикл).
     *
     *    д) Частота в герцах (если нужна физическая, редко для трейдинга):
     *           f_Hz(k) = k / (N · Δt_sec),   Δt_sec — длительность свечи в секундах.
     *
     *    Ограничение Найквиста: осмысленные k ≤ N/2. При k > N/2 серии обнуляются.
     *
     * 5. АМПЛИТУДА И ФАЗА ОДНОЙ ГАРМОНИКИ (из пары серий на одном баре)
     *    По |aₖ| и |bₖ| на графике (значения уже без знака) полная амплитуда и фаза
     *    исходной (со знаком) гармоники восстанавливаются так:
     *
     *        Aₖ = sqrt(aₖ² + bₖ²)   — амплитуда колебания цены вокруг среднего
     *        φₖ = atan2(bₖ, aₖ)     — фаза (радианы); сдвиг sin/cos относительно n=0
     *
     *    Вклад k-й гармоники в цену на шаге n внутри окна:
     *
     *        cₖ[n] = aₖ·cos(2π·k·n/N) + bₖ·sin(2π·k·n/N)
     *              = Aₖ·cos(2π·k·n/N − φₖ)
     *
     * 6. СВЯЗЬ СПЕКТРА С ЦЕНОЙ (интуиция)
     *    • H1 (k=1) — самое медленное колебание в окне, период ≈ N баров.
     *    • Большие k — более быстрые «зубцы» внутри окна.
     *    • Рост |aₖ| или |bₖ| на последних барах — усиление соответствующей частоты
     *      на текущем скользящем окне (не путать с глобальным спектром всей истории).
     *
     * 7. ПАРАМЕТРЫ ИНДИКАТОРА
     *    • «Окно (свечей)» = N.
     *    • «Количество гармоник» = K (пар серий cos+sin; всего 2·K линий на графике).
     *
     * =============================================================================
     */

    /// <summary>
    /// Дискретный ряд Фурье средней цены (Open+Close)/2 на скользящем окне.
    /// Серии «H{k} cos» / «H{k} sin» — модули коэффициентов aₖ, bₖ; см. комментарий в начале файла.
    /// </summary>
    [Indicator("Fourier")]
    public class Fourier : Aindicator
    {
        private IndicatorParameterInt _window;
        private IndicatorParameterInt _harmonicsCount;

        /// <summary>Пары серий: индекс [k−1] ↔ гармоника k (см. EnsureHarmonicSeries).</summary>
        private readonly List<IndicatorDataSeries> _cosSeries = new List<IndicatorDataSeries>();
        private readonly List<IndicatorDataSeries> _sinSeries = new List<IndicatorDataSeries>();

        private static readonly Color[] SeriesColors =
        {
            Color.DodgerBlue,
            Color.OrangeRed,
            Color.MediumSeaGreen,
            Color.MediumPurple,
            Color.Goldenrod,
            Color.Teal,
            Color.Crimson,
            Color.SlateBlue,
            Color.DarkCyan,
            Color.Chocolate,
            Color.SteelBlue,
            Color.OliveDrab,
            Color.IndianRed,
            Color.DarkMagenta,
            Color.DarkGoldenrod,
            Color.CadetBlue
        };

        public override void OnStateChange(IndicatorState state)
        {
            if (state == IndicatorState.Configure)
            {
                _window = CreateParameterInt("Окно (свечей)", 64);
                _harmonicsCount = CreateParameterInt("Количество гармоник", 5);
                EnsureHarmonicSeries(GetHarmonicsLimit());
            }
            else if (state == IndicatorState.Dispose)
            {
                _cosSeries.Clear();
                _sinSeries.Clear();
            }
        }

        public override void OnProcess(List<Candle> candles, int index)
        {
            if (candles == null || index < 0 || index >= candles.Count)
            {
                return;
            }

            int window = GetWindowLimit();
            int harmonics = GetHarmonicsLimit();
            EnsureHarmonicSeries(harmonics);

            if (index < window - 1)
            {
                WriteZeroAt(index, harmonics);
                return;
            }

            // Окно n = 0..N−1: x[n] = (Open+Close)/2; на выходе для гармоники k — |aₖ|, |bₖ|.
            int start = index - window + 1;
            double[] samples = new double[window];

            for (int n = 0; n < window; n++)
            {
                Candle c = candles[start + n];
                samples[n] = (double)((c.Open + c.Close) * 0.5m);
            }

            // k = 1..maxHarmonic; частота f_bar = k/N, период T_bar = N/k баров.
            int maxHarmonic = Math.Min(harmonics, window / 2);
            double invN = 1.0 / window;
            double twoPiOverN = 2.0 * Math.PI * invN;

            for (int k = 1; k <= maxHarmonic; k++)
            {
                // aₖ = (2/N)·Σ x[n]·cos(2πkn/N),  bₖ = (2/N)·Σ x[n]·sin(2πkn/N)
                double sumCos = 0.0;
                double sumSin = 0.0;
                double angleK = twoPiOverN * k;

                for (int n = 0; n < window; n++)
                {
                    double angle = angleK * n;
                    sumCos += samples[n] * Math.Cos(angle);
                    sumSin += samples[n] * Math.Sin(angle);
                }

                double aK = 2.0 * invN * sumCos;
                double bK = 2.0 * invN * sumSin;

                // В серии — |aₖ|, |bₖ|; полная амплитуда Aₖ = sqrt(aₖ²+bₖ²), фаза φₖ = atan2(bₖ,aₖ).
                _cosSeries[k - 1].Values[index] = (decimal)Math.Abs(aK);
                _sinSeries[k - 1].Values[index] = (decimal)Math.Abs(bK);
            }

            for (int k = maxHarmonic; k < harmonics; k++)
            {
                _cosSeries[k].Values[index] = 0m;
                _sinSeries[k].Values[index] = 0m;
            }
        }

        private int GetWindowLimit()
        {
            int w = _window?.ValueInt ?? 64;
            if (w < 4)
            {
                w = 4;
            }

            if (w > 4096)
            {
                w = 4096;
            }

            return w;
        }

        private int GetHarmonicsLimit()
        {
            int h = _harmonicsCount?.ValueInt ?? 5;
            if (h < 1)
            {
                h = 1;
            }

            if (h > 32)
            {
                h = 32;
            }

            return h;
        }

        /// <summary>
        /// Создаёт серии для гармоник 1..harmonics.
        /// H{k} cos → |aₖ|,  H{k} sin → |bₖ|;  f_bar = k/N,  T_bar = N/k свечей.
        /// </summary>
        private void EnsureHarmonicSeries(int harmonics)
        {
            while (_cosSeries.Count < harmonics)
            {
                int k = _cosSeries.Count + 1;
                Color color = SeriesColors[(_cosSeries.Count * 2) % SeriesColors.Length];
                Color colorSin = SeriesColors[(_cosSeries.Count * 2 + 1) % SeriesColors.Length];

                // k в имени = номер гармоники; период в барах = N/k (N — текущее «Окно»).
                _cosSeries.Add(CreateSeries(
                    "H" + k + " cos",
                    color,
                    IndicatorChartPaintType.Line,
                    true));

                _sinSeries.Add(CreateSeries(
                    "H" + k + " sin",
                    colorSin,
                    IndicatorChartPaintType.Line,
                    true));
            }
        }

        private void WriteZeroAt(int index, int harmonics)
        {
            for (int k = 0; k < harmonics && k < _cosSeries.Count; k++)
            {
                _cosSeries[k].Values[index] = 0m;
                _sinSeries[k].Values[index] = 0m;
            }
        }
    }
}
