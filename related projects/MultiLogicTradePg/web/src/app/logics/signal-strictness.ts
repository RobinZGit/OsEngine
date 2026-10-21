/**
 * #1030: ползунок «строже / мягче» в списке сигналов логики.
 * Положение 0..100 — АБСОЛЮТНОЕ: 0 = строгая граница параметра, 100 = мягкая,
 * 50 = середина диапазона. Значение параметра в формуле однозначно задаёт
 * положение ползунка, поэтому после сохранения он остаётся там, где его оставили.
 */
export interface IndicatorParamBound {
  indicator_code: string;
  param_key: string;
  /** Значение на «строгом» конце ползунка. */
  strict_value: number;
  /** Значение на «мягком» конце. */
  loose_value: number;
  /** Округление до целого (period и т.п.). */
  is_integer: boolean;
}

/** Числовые параметры key=value, встречающиеся в формуле сигнала. */
export function formulaParamValues(formula: string): Record<string, number> {
  const out: Record<string, number> = {};
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(-?\d+(?:[.,]\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(formula || ''))) != null) {
    const v = Number(m[2].replace(',', '.'));
    if (Number.isFinite(v)) out[m[1]] = v;
  }
  return out;
}

/** Только параметры внутри вызовов @indicatorCode(...) (с учётом вложенных скобок). */
export function indicatorCallParams(
  formula: string,
  indicatorCode?: string
): Record<string, number> {
  const src = String(formula || '');
  const code = String(indicatorCode || '').trim().toUpperCase();
  if (!code) return formulaParamValues(src);
  const out: Record<string, number> = {};
  const marker = `@${code}(`;
  let cursor = 0;
  while (cursor < src.length) {
    const idx = src.toUpperCase().indexOf(marker, cursor);
    if (idx < 0) break;
    let depth = 1;
    let i = idx + marker.length;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') depth -= 1;
      i += 1;
    }
    const inner = src.slice(idx + marker.length, depth === 0 ? i - 1 : i);
    Object.assign(out, formulaParamValues(inner));
    cursor = i;
  }
  return out;
}

/**
 * Пересчитать параметры формулы под абсолютное положение ползунка 0..100.
 * 0 — строгие границы, 100 — мягкие, 50 — середина диапазона.
 * Меняются только параметры из bounds и только внутри вызовов @indicatorCode(...).
 */
export function applyStrictnessToFormula(
  formula: string,
  bounds: IndicatorParamBound[],
  position: number,
  indicatorCode?: string
): string {
  const p = Math.min(100, Math.max(0, Number(position) || 0)) / 100;
  const byKey = new Map(bounds.map((b) => [b.param_key, b]));
  const rewrite = (text: string): string =>
    text.replace(
      /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(-?\d+(?:[.,]\d+)?)/g,
      (whole, key: string) => {
        const b = byKey.get(key);
        if (!b) return whole;
        const strict = Number(b.strict_value);
        const loose = Number(b.loose_value);
        if (!Number.isFinite(strict) || !Number.isFinite(loose)) return whole;
        let v = strict + (loose - strict) * p;
        v = b.is_integer ? Math.round(v) : Math.round(v * 100) / 100;
        return `${key}=${v}`;
      }
    );

  const src = String(formula || '');
  const code = String(indicatorCode || '').trim().toUpperCase();
  if (!code) return rewrite(src);

  const marker = `@${code}(`;
  let out = '';
  let cursor = 0;
  while (cursor < src.length) {
    const idx = src.toUpperCase().indexOf(marker, cursor);
    if (idx < 0) {
      out += src.slice(cursor);
      break;
    }
    out += src.slice(cursor, idx) + src.slice(idx, idx + marker.length);
    let depth = 1;
    let i = idx + marker.length;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') depth -= 1;
      i += 1;
    }
    const inner = src.slice(idx + marker.length, depth === 0 ? i - 1 : i);
    out += rewrite(inner);
    if (depth === 0) out += ')';
    cursor = i;
  }
  return out;
}

/**
 * Положение ползунка, соответствующее текущим параметрам формулы.
 * Среднее по всем параметрам индикатора (каждый нормируется в 0..100).
 * Нет значений/границ — 50 (середина).
 */
export function strictnessPositionFromFormula(
  formula: string,
  bounds: IndicatorParamBound[],
  indicatorCode?: string
): number {
  if (!bounds.length) return 50;
  const values = indicatorCallParams(formula, indicatorCode);
  const positions: number[] = [];
  for (const b of bounds) {
    const cur = values[b.param_key];
    const strict = Number(b.strict_value);
    const loose = Number(b.loose_value);
    if (!Number.isFinite(cur) || !Number.isFinite(strict) || !Number.isFinite(loose)) continue;
    if (strict === loose) continue;
    const p = ((cur - strict) / (loose - strict)) * 100;
    positions.push(Math.min(100, Math.max(0, p)));
  }
  if (!positions.length) return 50;
  const avg = positions.reduce((a, b) => a + b, 0) / positions.length;
  return Math.round(Math.min(100, Math.max(0, avg)));
}
