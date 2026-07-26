/** OPT(param_name, shift_pct) inside @CODE(...) params — on-the-fly optimization. */

export const OPT_MAX_PARAMS_GLOBAL = 3;

export interface OptSpec {
  /** Canonical param key (e.g. std_dev). */
  key: string;
  /** Base numeric value from key=value in the same params. */
  base: number;
  /** Shift percent (e.g. 10 → ±10%). */
  pct: number;
}

export type OptDir = 'up' | 'down';

/** One challenger arm: direction per OPT key. */
export interface OptArm {
  /** Stable lane id, e.g. std_dev:up or period:down|std_dev:up */
  lane: string;
  /** Concrete numeric overrides for each OPT key. */
  values: Record<string, number>;
  dirs: Record<string, OptDir>;
}

const OPT_CALL_RE = /\bOPT\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([0-9]+(?:\.[0-9]+)?)\s*\)/gi;

/** Normalize aliases so OPT(std,10) matches std_dev=2. */
export function canonicalOptParamKey(key: string): string {
  const k = key.trim().toLowerCase();
  const map: Record<string, string> = {
    std: 'std_dev',
    fast: 'fast_period',
    slow: 'slow_period',
    signal: 'signal_period',
    k: 'k_period',
    d: 'd_period',
  };
  return map[k] ?? k;
}

/** Split params by commas at depth 0 (respect nested OPT(...)). */
export function splitParamsTopLevel(params: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  for (let i = 0; i < params.length; i++) {
    const ch = params[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      const t = cur.trim();
      if (t) out.push(t);
      cur = '';
      continue;
    }
    cur += ch;
  }
  const t = cur.trim();
  if (t) out.push(t);
  return out;
}

/** Parse key=value numerics from params (skip OPT(...) tokens). */
export function parseNumericParamMap(params: string): Record<string, number> {
  const map: Record<string, number> = {};
  for (const part of splitParamsTopLevel(params)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = canonicalOptParamKey(part.slice(0, eq));
    const raw = part.slice(eq + 1).trim();
    if (/^OPT\s*\(/i.test(raw)) continue;
    const n = Number(String(raw).replace(',', '.'));
    if (Number.isFinite(n)) map[key] = n;
  }
  return map;
}

/** Extract OPT(name, pct) specs; base from key=value in same params. */
export function extractOptSpecs(params: string | null | undefined): OptSpec[] {
  if (!params?.trim()) return [];
  const bases = parseNumericParamMap(params);
  const byKey = new Map<string, OptSpec>();
  let m: RegExpExecArray | null;
  const re = new RegExp(OPT_CALL_RE.source, 'gi');
  while ((m = re.exec(params)) !== null) {
    const key = canonicalOptParamKey(m[1]);
    const pct = Number(m[2]);
    if (!Number.isFinite(pct) || pct <= 0) continue;
    const base = bases[key];
    if (base == null || !Number.isFinite(base)) continue;
    byKey.set(key, { key, base, pct });
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function optArmValue(base: number, pct: number, dir: OptDir): number {
  const f = dir === 'up' ? 1 + pct / 100 : 1 - pct / 100;
  const v = base * f;
  return Math.round(v * 1e6) / 1e6;
}

/** Build 2^n challenger arms (not including champion). */
export function buildOptArms(specs: OptSpec[]): OptArm[] {
  if (specs.length === 0) return [];
  const n = specs.length;
  const arms: OptArm[] = [];
  const total = 1 << n;
  for (let mask = 0; mask < total; mask++) {
    const values: Record<string, number> = {};
    const dirs: Record<string, OptDir> = {};
    const parts: string[] = [];
    for (let i = 0; i < n; i++) {
      const s = specs[i];
      const dir: OptDir = mask & (1 << i) ? 'up' : 'down';
      dirs[s.key] = dir;
      values[s.key] = optArmValue(s.base, s.pct, dir);
      parts.push(`${s.key}:${dir}`);
    }
    parts.sort();
    arms.push({ lane: parts.join('|'), values, dirs });
  }
  return arms;
}

/**
 * Replace key=base with concrete values for an arm; strip OPT(...) tokens.
 * Champion (values null) → strip OPT only, keep bases.
 */
export function expandFormulaParams(
  params: string,
  values: Record<string, number> | null
): string {
  const parts = splitParamsTopLevel(params);
  const out: string[] = [];
  for (const part of parts) {
    if (/^OPT\s*\(/i.test(part.trim())) continue;
    const eq = part.indexOf('=');
    if (eq <= 0) {
      out.push(part);
      continue;
    }
    const key = canonicalOptParamKey(part.slice(0, eq));
    const rawKey = part.slice(0, eq).trim();
    if (values && Object.prototype.hasOwnProperty.call(values, key)) {
      out.push(`${rawKey}=${values[key]}`);
    } else {
      out.push(part);
    }
  }
  return out.join(',');
}

/** Unique OPT keys from many formulas. */
export function uniqueOptKeysFromFormulas(formulas: string[]): string[] {
  const keys = new Set<string>();
  for (const f of formulas) {
    const params = extractParamsFromFormula(f);
    for (const s of extractOptSpecs(params)) keys.add(s.key);
  }
  return [...keys].sort();
}

/** Balanced extract of @CODE(params) params substring. */
export function extractParamsFromFormula(raw: string): string | null {
  const text = (raw ?? '').trim();
  const at = text.indexOf('@');
  if (at < 0) return null;
  const open = text.indexOf('(', at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i).trim();
    }
  }
  return null;
}

export function optLaneLabel(lane: string): string {
  if (!lane) return '';
  return lane
    .split('|')
    .map((p) => {
      const [k, d] = p.split(':');
      return d === 'up' ? `↑${k}` : `↓${k}`;
    })
    .join(' ');
}
