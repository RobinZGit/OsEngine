'use strict';

const OPT_MAX_PARAMS_GLOBAL = 3;

function canonicalOptParamKey(key) {
  const k = String(key || '')
    .trim()
    .toLowerCase();
  const map = {
    std: 'std_dev',
    fast: 'fast_period',
    slow: 'slow_period',
    signal: 'signal_period',
    k: 'k_period',
    d: 'd_period',
  };
  return map[k] || k;
}

function splitParamsTopLevel(params) {
  const out = [];
  let cur = '';
  let depth = 0;
  const s = String(params || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
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

function parseNumericParamMap(params) {
  const map = {};
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

function extractParamsFromFormula(raw) {
  const text = String(raw || '').trim();
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

function extractOptSpecs(params) {
  if (!params || !String(params).trim()) return [];
  const bases = parseNumericParamMap(params);
  const byKey = new Map();
  const re = /\bOPT\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([0-9]+(?:\.[0-9]+)?)\s*\)/gi;
  let m;
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

function uniqueOptKeysFromFormulas(formulas) {
  const keys = new Set();
  for (const f of formulas || []) {
    const params = extractParamsFromFormula(f);
    for (const s of extractOptSpecs(params)) keys.add(s.key);
  }
  return [...keys].sort();
}

/**
 * Validate saving formula for logicId.
 * @returns {{ ok: true } | { ok: false, error: string, existing: object[] }}
 */
async function validateOptFormulaSave(pool, logicId, newFormula, excludeSignalId) {
  const specs = extractOptSpecs(extractParamsFromFormula(newFormula));
  if (specs.length === 0) {
    return { ok: true };
  }
  // OPT without base value
  const params = extractParamsFromFormula(newFormula) || '';
  const re = /\bOPT\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,/gi;
  let m;
  const named = [];
  while ((m = re.exec(params)) !== null) named.push(canonicalOptParamKey(m[1]));
  for (const k of named) {
    if (!specs.find((s) => s.key === k)) {
      return {
        ok: false,
        error: `OPT(${k},…): задайте базовое значение ${k}=… в той же формуле`,
        existing: [],
      };
    }
  }

  const { rows } = await pool.query(
    `
    SELECT lis.logic_id, l.name AS logic_name, lis.id AS signal_id, lis.formula
    FROM logic_indicator_signals lis
    JOIN logics l ON l.id = lis.logic_id
    WHERE lis.is_active = TRUE
      AND ($1::INTEGER IS NULL OR lis.id <> $1)
    `,
    [excludeSignalId != null ? Number(excludeSignalId) : null]
  );

  const usage = []; // { key, logic_id, logic_name, signal_id }
  const keysElsewhere = new Set();
  for (const row of rows) {
    const ks = uniqueOptKeysFromFormulas([row.formula]);
    for (const k of ks) {
      keysElsewhere.add(k);
      usage.push({
        key: k,
        logic_id: row.logic_id,
        logic_name: row.logic_name,
        signal_id: row.signal_id,
      });
    }
  }

  // Keys already on this logic (other signals) — allowed to repeat same key
  const { rows: sameLogic } = await pool.query(
    `
    SELECT id, formula FROM logic_indicator_signals
    WHERE logic_id = $1 AND is_active = TRUE
      AND ($2::INTEGER IS NULL OR id <> $2)
    `,
    [logicId, excludeSignalId != null ? Number(excludeSignalId) : null]
  );
  const keysThisLogic = new Set(uniqueOptKeysFromFormulas(sameLogic.map((r) => r.formula)));

  const newKeys = specs.map((s) => s.key);
  const merged = new Set([...keysElsewhere]);
  // Remove keys that belong only to this logic (will be re-counted from sibling + new)
  for (const k of keysThisLogic) {
    // keys on this logic are not "elsewhere" for cap — rebuild global without this logic
  }

  // Global unique keys = all logics except current, plus union of current logic after save
  const { rows: otherLogicRows } = await pool.query(
    `
    SELECT lis.formula
    FROM logic_indicator_signals lis
    WHERE lis.is_active = TRUE AND lis.logic_id <> $1
    `,
    [logicId]
  );
  const globalOther = new Set(uniqueOptKeysFromFormulas(otherLogicRows.map((r) => r.formula)));
  const afterThis = new Set([
    ...uniqueOptKeysFromFormulas(sameLogic.map((r) => r.formula)),
    ...newKeys,
  ]);
  const global = new Set([...globalOther, ...afterThis]);

  if (global.size > OPT_MAX_PARAMS_GLOBAL) {
    const existingList = [...globalOther].sort();
    return {
      ok: false,
      error:
        `Запрещено оптимизировать больше ${OPT_MAX_PARAMS_GLOBAL} параметров. ` +
        `Уже есть OPT: ${existingList.length ? existingList.join(', ') : '—'}. ` +
        `После сохранения стало бы: ${[...global].sort().join(', ')}.`,
      existing: usage.filter((u) => u.logic_id !== logicId),
    };
  }
  return { ok: true };
}

module.exports = {
  OPT_MAX_PARAMS_GLOBAL,
  canonicalOptParamKey,
  extractOptSpecs,
  extractParamsFromFormula,
  uniqueOptKeysFromFormulas,
  validateOptFormulaSave,
};
