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



function parseParams(paramsText) {
  const out = {};
  const src = String(paramsText ?? '').trim();
  if (!src) return out;
  const parts = [];
  let buf = '';
  let depthParen = 0;
  let depthBracket = 0;
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      buf += ch;
      if (ch === '\\' && i + 1 < src.length) { buf += src[++i]; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === '\'') { quote = ch; buf += ch; continue; }
    if (ch === '(') depthParen++;
    else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
    else if (ch === '[') depthBracket++;
    else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
    if (ch === ',' && depthParen === 0 && depthBracket === 0) {
      parts.push(buf); buf = ''; continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);
  const coerce = (rawVal) => {
    let v = String(rawVal ?? '').trim();
    if (v === '') return '';
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith('\'') && v.endsWith('\''))) {
      return v.slice(1, -1);
    }
    const lower = v.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
    if (lower === 'null') return null;
    if (/^[+-]?\d+$/.test(v)) { const n = Number(v); if (Number.isSafeInteger(n)) return n; }
    if (/^[+-]?(?:\d+\.\d*|\d*\.\d+|\d+)(?:[eE][+-]?\d+)?$/.test(v)) { const n = Number(v); if (Number.isFinite(n)) return n; }
    return v;
  };
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    const val = coerce(part.slice(eq + 1).trim());
    out[key] = val;
    const lower = key.toLowerCase();
    if (!(lower in out)) out[lower] = val;
  }
  return out;
}

module.exports = {
  parseSignalFormula,
  parseParamSeries,
  evaluateCondition,
};
