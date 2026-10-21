/**
 * #1030: ползунок «строже / мягче» в списке сигналов логики.
 * Меняет числовые параметры индикатора в формуле сигнала: середина (50) —
 * значения не меняются; влево — «строже» (периоды длиннее, пороги уже),
 * вправо — «мягче» (периоды короче, пороги шире).
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

/**
 * Пересчитать параметры формулы под положение ползунка 0..100.
 * 50 — вернуть исходные значения; 0 — строгие границы; 100 — мягкие.
 * Меняются только параметры из bounds и только внутри вызовов @indicatorCode(...):
 * другие индикаторы в той же формуле (например, @ROC рядом с @SMA) не трогаются.
 */
export function applyStrictnessToFormula(
  formula: string,
  bounds: IndicatorParamBound[],
  baseValues: Record<string, number>,
  position: number,
  indicatorCode?: string
): string {
  const p = Math.min(100, Math.max(0, Number(position) || 0)) / 100;
  const byKey = new Map(bounds.map((b) => [b.param_key, b]));
  const rewrite = (text: string): string =>
    text.replace(
      /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(-?\d+(?:[.,]\d+)?)/g,
      (whole, key: string, num: string) => {
        const b = byKey.get(key);
        if (!b) return whole;
        const strict = Number(b.strict_value);
        const loose = Number(b.loose_value);
        if (!Number.isFinite(strict) || !Number.isFinite(loose)) return whole;
        const parsed = Number(num.replace(',', '.'));
        const cur = Number.isFinite(baseValues[key]) ? baseValues[key] : parsed;
        let v: number;
        if (p <= 0.5) {
          v = strict + (cur - strict) * (p / 0.5);
        } else {
          v = cur + (loose - cur) * ((p - 0.5) / 0.5);
        }
        v = b.is_integer ? Math.round(v) : Math.round(v * 100) / 100;
        return `${key}=${v}`;
      }
    );

  const src = String(formula || '');
  const code = String(indicatorCode || '').trim().toUpperCase();
  if (!code) return rewrite(src);

  // Идём по вызовам @CODE( … ) с учётом вложенных скобок (OPT(...)).
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
    if (depth === 0) {
      out += ')';
      cursor = i;
    } else {
      cursor = i;
    }
  }
  return out;
}

