'use strict';

const REF_PATTERN = /^@([A-Z0-9_]+)\(([^)]*)\)\s+([\s\S]+)$/i;

function parseSignalFormula(raw) {
  const text = (raw ?? '').trim();
  if (!text) {
    return { valid: false, indicatorCode: null, params: null, condition: '', errors: ['empty'] };
  }
  const m = text.match(REF_PATTERN);
  if (!m) {
    return { valid: false, indicatorCode: null, params: null, condition: text, errors: ['format'] };
  }
  return {
    valid: true,
    indicatorCode: m[1].toUpperCase(),
    params: m[2].trim(),
    condition: m[3].trim(),
    errors: [],
  };
}

function parseParamSeries(params) {
  const parts = (params ?? '').split(',');
  for (const p of parts) {
    const kv = p.trim().split('=');
    if (kv.length === 2 && kv[0].trim().toLowerCase() === 'series') {
      return kv[1].trim().toUpperCase();
    }
  }
  return 'VALUE';
}

function evaluateCondition(condition, valueByToken) {
  let expr = (condition ?? '').trim();
  if (!expr) return false;

  const tokens = Object.keys(valueByToken).sort((a, b) => b.length - a.length);
  for (const token of tokens) {
    const val = valueByToken[token];
    if (val == null || !Number.isFinite(Number(val))) return false;
    expr = expr.replace(new RegExp(`\\b${token}\\b`, 'gi'), String(Number(val)));
  }

  if (/[A-Za-z_]/.test(expr)) {
    return false;
  }
  if (!/[><=!]/.test(expr)) {
    return false;
  }

  try {
    // eslint-disable-next-line no-new-func
    return Boolean(Function(`"use strict"; return (${expr});`)());
  } catch {
    return false;
  }
}

module.exports = {
  parseSignalFormula,
  parseParamSeries,
  evaluateCondition,
};
