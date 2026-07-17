import { IndicatorRow } from '../models/lookup.model';

/** Краткая подсказка под полем формулы (create / edit). */
export const INDICATOR_FORMULA_HINT =
  'pp, sma(period=20), ema, * — свёртка, @CODE — ряд индикатора. Кнопка «И.» — полный список.';

/** Базовая справка (без каталога индикаторов). */
export const INDICATOR_FORMULA_HELP_BASE = `Многочленная формула — выражение над числовыми рядами (массивами по барам).

Рыночные ряды
  pp — Close; oo, hh, ll, vv — Open, High, Low, Volume

Ядра
  (a; b; c) — коэффициенты фильтра (запятая = точка с запятой)
  Пример: pp * (1; -2; 1) — ускорение цены (PACC)

Операции
  * — свёртка: левый и правый операнды вычисляются как ряды, затем сворачиваются
  #, /# — покомponentное умножение / деление
  +, − — покомponentное сложение / вычитание

Функции sma / ema / ww (источник — close, pp)
  sma — SMA от close, параметры серии по умолчанию
  sma() — то же
  sma(20) — period=20 (позиционно)
  sma(20, VALUE) — period и серия (последний аргумент — серия)
  sma(period=20, series=VALUE) — именованные параметры
  ema(period=20), ww(period=20) — аналогично
  Без () — param_period и VALUE из серии на бумаге

Имена параметров: period, fast_period, slow_period, signal_period, std_dev, k_period, d_period, smooth, series

@CODE — ссылка на индикатор из справочника
  @SMA, @MACD:HISTOGRAM — уже рассчитанные серии на бумаге

SMAT3
  sma(period=20, series=VALUE) * sma(period=20, series=VALUE) * sma(period=20, series=VALUE)`;

const IMPLEMENTED_CODES = new Set([
  'RSI',
  'SMA',
  'EMA',
  'MACD',
  'BB',
  'ATR',
  'STOCH',
  'PACC',
  'SMAT3',
]);

function seriesRef(code: string, seriesCode: string, isThreshold: boolean): string {
  if (isThreshold) return '';
  const main =
    seriesCode === 'VALUE' || seriesCode === code ? `@${code}` : `@${code}:${seriesCode}`;
  return main;
}

/** Каталог индикаторов для справки «И.» (из API /api/indicators). */
export function buildIndicatorCatalogHelp(indicators: IndicatorRow[]): string {
  const lines: string[] = [
    '',
    '─── Справочник индикаторов (@CODE) ───',
    'Доступны для @ только с реализованным расчётом (ниже отмечены ✓).',
    '',
  ];

  const sorted = [...indicators].sort((a, b) => a.code.localeCompare(b.code));
  for (const ind of sorted) {
    const implemented =
      IMPLEMENTED_CODES.has(ind.code) ||
      Boolean(ind.formula?.trim()) ||
      Boolean(ind.script?.trim());
    const mark = implemented ? '✓' : '○';
    const refs: string[] = [];
    const types = (ind.value_types ?? []).filter((t) => !t.is_threshold);
    for (const t of types) {
      const r = seriesRef(ind.code, t.code, t.is_threshold);
      if (r && !refs.includes(r)) refs.push(r);
    }
    if (refs.length === 0 && implemented) refs.push(`@${ind.code}`);

    const inline = ind.formula?.trim() ? `inline: ${ind.formula.trim()}` : '';
    const parts = [`${mark} ${ind.code} — ${ind.name}`];
    if (refs.length) parts.push(`| ${refs.join(', ')}`);
    if (inline) parts.push(`| ${inline}`);
    if (types.length) {
      parts.push(`| серии: ${types.map((t) => t.code).join(', ')}`);
    }
    if (!implemented) parts.push('| расчёт пока не реализован — @ недоступен');
    lines.push(parts.join(' '));
  }

  lines.push('');
  lines.push('Примеры');
  lines.push('  sma(period=20, series=VALUE) * … — SMAT3');
  lines.push('  sma(20)                 — SMA period 20');
  lines.push('  sma                     — SMA, дефолт серии');
  lines.push('  @RSI # pp               — RSI × цена');
  lines.push('  pp * (1; -2; 1)         — PACC');

  return lines.join('\n');
}

export function buildFullFormulaHelp(indicators: IndicatorRow[]): string {
  return INDICATOR_FORMULA_HELP_BASE + buildIndicatorCatalogHelp(indicators);
}
