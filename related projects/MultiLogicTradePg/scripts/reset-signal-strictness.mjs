#!/usr/bin/env node
/**
 * #1033: сбросить ползунки «строже / мягче» у всех сигналов на середину.
 * Положение ползунка вычисляется из параметров формулы, поэтому «середина»
 * означает: каждый ограниченный параметр = (strict_value + loose_value) / 2
 * с округлением (целые — до целого, дробные — до 0.01).
 *
 * Меняются только параметры внутри вызовов @ИНДИКАТОР(...) этого сигнала;
 * другие индикаторы в формуле не трогаются.
 *
 * Запуск: node scripts/reset-signal-strictness.mjs [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');

// pg установлен в api/node_modules — резолвим оттуда.
const requireFromApi = createRequire(path.join(root, 'api', 'package.json'));
const pg = requireFromApi('pg');

function readEnv() {
  const file = path.join(root, 'api', '.env');
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const env = readEnv();
const pool = new pg.Pool({
  host: env.PGHOST || 'localhost',
  port: Number(env.PGPORT) || 5432,
  database: env.PGDATABASE || 'multilogictrade',
  user: env.PGUSER || 'postgres',
  password: env.PGPASSWORD,
});

/** Числовые key=value внутри @CODE(...) с учётом вложенных скобок. */
function rewriteIndicatorCalls(formula, code, byKey) {
  const src = String(formula || '');
  const marker = `@${String(code || '').toUpperCase()}(`;
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
    const rewritten = inner.replace(
      /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(-?\d+(?:[.,]\d+)?)/g,
      (whole, key) => {
        const b = byKey.get(key);
        if (!b) return whole;
        const strict = Number(b.strict_value);
        const loose = Number(b.loose_value);
        if (!Number.isFinite(strict) || !Number.isFinite(loose)) return whole;
        const mid = Number.isFinite(Number(b.default_value))
          ? Number(b.default_value)
          : (strict + loose) / 2;
        let v = b.is_integer ? Math.round(mid) : Math.round(mid * 100) / 100;
        return `${key}=${v}`;
      }
    );
    out += rewritten;
    if (depth === 0) out += ')';
    cursor = i;
  }
  return out;
}

async function main() {
  const { rows: bounds } = await pool.query(
    `SELECT indicator_code, param_key, strict_value::float8 AS strict_value,
            loose_value::float8 AS loose_value,
            default_value::float8 AS default_value, is_integer
       FROM indicator_param_bounds`
  );
  const byCode = new Map();
  for (const b of bounds) {
    const code = String(b.indicator_code || '').toUpperCase();
    if (!byCode.has(code)) byCode.set(code, new Map());
    byCode.get(code).set(String(b.param_key), b);
  }

  const { rows: signals } = await pool.query(
    `SELECT lis.id, lis.logic_id, lis.formula, i.code AS indicator_code
       FROM logic_indicator_signals lis
       JOIN indicators i ON i.id = lis.indicator_id
      ORDER BY lis.id`
  );

  let changed = 0;
  for (const s of signals) {
    const boundsForCode = byCode.get(String(s.indicator_code || '').toUpperCase());
    if (!boundsForCode) continue;
    const next = rewriteIndicatorCalls(s.formula, s.indicator_code, boundsForCode);
    if (next === s.formula) continue;
    changed += 1;
    if (dryRun) {
      console.log(
        `[dry] logic=${s.logic_id} signal=${s.id} ${s.formula} → ${next}`
      );
    } else {
      await pool.query(
        `UPDATE logic_indicator_signals SET formula = $2 WHERE id = $1`,
        [s.id, next]
      );
    }
  }
  console.log(
    `${dryRun ? 'DRY-RUN: ' : ''}signals checked=${signals.length}, changed=${changed}`
  );
}

main()
  .catch((err) => {
    console.error('reset-signal-strictness failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
