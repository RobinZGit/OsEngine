/**
 * Offline grid optimization (test + paper opt_lane books).
 * Combinations = product of (2 * iterations + 1) per enabled param (base ± steps).
 */

export const OPT_GRID_MAX_COMBOS = 81;

export type OptGridParamRow = {
  /** Unique id: `${indicatorCode}:${paramKey}` */
  id: string;
  indicator_code: string;
  param_key: string;
  /** Display label */
  label: string;
  base: number;
  step: number;
  /** Steps each side (+ and −). Default 1 → three values: base−step, base, base+step */
  iterations: number;
  enabled: boolean;
};

export type OptGridConfig = {
  params: OptGridParamRow[];
};

export type OptGridArm = {
  lane: string;
  values: Record<string, number>;
};

export type OptGridResultRow = {
  lane: string;
  values: Record<string, number>;
  finres: number;
  rank?: number;
  is_champion?: boolean;
};

/** Numeric key=value pairs inside @CODE(...), skipping OPT(...) and non-numeric. */
export function parseNumericParamsFromFormula(formula: string): {
  indicator_code: string;
  params: { key: string; value: number }[];
} | null {
  const text = String(formula ?? '').trim();
  const at = text.indexOf('@');
  if (at < 0) return null;
  const open = text.indexOf('(', at);
  if (open < 0) return null;
  const code = text.slice(at + 1, open).trim().toUpperCase();
  if (!/^[A-Z0-9_]+$/.test(code)) return null;
  let depth = 0;
  let close = -1;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return null;
  const inside = text.slice(open + 1, close);
  const parts = splitTopLevelParams(inside);
  const params: { key: string; value: number }[] = [];
  for (const part of parts) {
    const p = part.trim();
    if (!p || /^OPT\s*\(/i.test(p)) continue;
    const eq = p.indexOf('=');
    if (eq <= 0) continue;
    const key = p.slice(0, eq).trim();
    const raw = p.slice(eq + 1).trim();
    if (!key || /series/i.test(key)) continue;
    const num = Number(String(raw).replace(',', '.'));
    if (!Number.isFinite(num)) continue;
    params.push({ key, value: num });
  }
  return { indicator_code: code, params };
}

function splitTopLevelParams(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function defaultStepForParam(paramKey: string, base: number): number {
  const k = paramKey.toLowerCase();
  if (/std_dev|deviation|sigma|mult|dev/.test(k)) return 0.1;
  if (/period|length|len|window|bars|n\b|smooth/.test(k)) return 1;
  if (/pct|percent|rate/.test(k)) return 1;
  const abs = Math.abs(base);
  if (abs >= 100) return Math.max(1, Math.round(abs * 0.05));
  if (abs >= 10) return 1;
  if (abs >= 1) return 0.1;
  return 0.01;
}

/** Dedupe params across all signal formulas of a logic. */
export function collectOptGridParamsFromFormulas(formulas: string[]): OptGridParamRow[] {
  const map = new Map<string, OptGridParamRow>();
  for (const f of formulas) {
    const parsed = parseNumericParamsFromFormula(f);
    if (!parsed) continue;
    for (const p of parsed.params) {
      const id = `${parsed.indicator_code}:${p.key}`;
      if (map.has(id)) continue;
      map.set(id, {
        id,
        indicator_code: parsed.indicator_code,
        param_key: p.key,
        label: `${parsed.indicator_code} · ${p.key}`,
        base: p.value,
        step: defaultStepForParam(p.key, p.value),
        iterations: 1,
        enabled: false,
      });
    }
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, 'ru'));
}

export function valuesForParam(base: number, step: number, iterations: number): number[] {
  const n = Math.max(0, Math.floor(iterations));
  const s = Number(step);
  const b = Number(base);
  if (!Number.isFinite(b) || !Number.isFinite(s) || s === 0) return [b];
  const out: number[] = [];
  for (let i = -n; i <= n; i++) {
    const v = b + i * s;
    out.push(Number(v.toPrecision(12)));
  }
  return out;
}

export function countOptGridCombos(params: OptGridParamRow[]): number {
  const enabled = params.filter((p) => p.enabled);
  if (enabled.length === 0) return 0;
  let n = 1;
  for (const p of enabled) {
    const len = valuesForParam(p.base, p.step, p.iterations).length;
    n *= len;
    if (n > OPT_GRID_MAX_COMBOS * 10) return n;
  }
  return n;
}

export function buildOptGridArms(params: OptGridParamRow[]): OptGridArm[] {
  const enabled = params.filter((p) => p.enabled);
  if (enabled.length === 0) return [];
  let arms: OptGridArm[] = [{ lane: 'grid:', values: {} }];
  for (const p of enabled) {
    const vals = valuesForParam(p.base, p.step, p.iterations);
    const next: OptGridArm[] = [];
    for (const arm of arms) {
      for (const v of vals) {
        const values = { ...arm.values, [p.param_key]: v };
        const parts = Object.keys(values)
          .sort()
          .map((k) => `${k}=${values[k]}`);
        next.push({ lane: `grid:${parts.join('|')}`, values });
      }
    }
    arms = next;
  }
  return arms;
}

/** Rewrite key=value in @CODE(...) params; keep OPT() and series as-is. */
export function rewriteFormulaParamBases(
  formula: string,
  values: Record<string, number>
): string {
  const text = String(formula ?? '');
  const at = text.indexOf('@');
  if (at < 0) return text;
  const open = text.indexOf('(', at);
  if (open < 0) return text;
  let depth = 0;
  let close = -1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return text;
  const inside = text.slice(open + 1, close);
  const parts = splitTopLevelParams(inside).map((part) => {
    const p = part.trim();
    if (!p || /^OPT\s*\(/i.test(p)) return p;
    const eq = p.indexOf('=');
    if (eq <= 0) return p;
    const key = p.slice(0, eq).trim();
    const canon = key.toLowerCase();
    for (const [vk, vv] of Object.entries(values)) {
      if (vk.toLowerCase() === canon && Number.isFinite(vv)) {
        return `${key}=${vv}`;
      }
    }
    return p;
  });
  return text.slice(0, open + 1) + parts.join(',') + text.slice(close);
}
