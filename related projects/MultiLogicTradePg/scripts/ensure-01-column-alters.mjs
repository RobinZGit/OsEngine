/**
 * Ensures each CREATE TABLE IF NOT EXISTS in 01 has matching
 * ALTER TABLE … ADD COLUMN IF NOT EXISTS for every non-PK column,
 * with an upgrade comment. Idempotent — safe to re-run.
 *
 * - Strips line (--) and block comments inside CREATE before parsing columns.
 * - Removes prior upgrade blocks and orphan mid-file ADD COLUMN lines
 *   for the same table/column (so formula etc. are not skipped).
 *
 * Usage: node scripts/ensure-01-column-alters.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql01Path = path.join(root, '01_multilogictrade_tables_and_data.sql');

const UPGRADE_COMMENT =
  '-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above.';

/**
 * Parse CREATE TABLE IF NOT EXISTS name ( ... );
 * Returns { table, columns: [{ name, def }], createEnd, createStart }
 */
function parseCreateTables(sql) {
  const results = [];
  const re = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const table = m[1];
    const startParen = m.index + m[0].length - 1;
    let depth = 0;
    let i = startParen;
    for (; i < sql.length; i++) {
      const ch = sql[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue;
    let body = sql.slice(startParen + 1, i);
    // Strip SQL comments inside CREATE so "-- foo, bar" is not parsed as columns.
    body = body.replace(/--[^\n]*/g, '');
    body = body.replace(/\/\*[\s\S]*?\*\//g, '');
    // end of statement after );
    let end = i + 1;
    while (end < sql.length && /\s/.test(sql[end])) end++;
    if (sql[end] === ';') end++;

    const columns = [];
    const parts = splitTopLevel(body);
    for (const part of parts) {
      const t = part.trim();
      if (!t) continue;
      if (/^(CONSTRAINT|PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|EXCLUDE)\b/i.test(t)) continue;
      const colMatch = t.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s+(.+)$/s);
      if (!colMatch) continue;
      const name = colMatch[1];
      const def = colMatch[2].trim();
      const isSerialPk =
        /^id$/i.test(name) && /\b(SERIAL|BIGSERIAL|SMALLSERIAL)\b/i.test(def);
      columns.push({ name, def, isSerialPk });
    }

    results.push({
      table,
      columns,
      createEnd: end,
      createStart: m.index,
    });
  }
  return results;
}

function splitTopLevel(body) {
  const parts = [];
  let cur = '';
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function alterDefFromCreate(def) {
  let d = def
    .replace(/\bPRIMARY\s+KEY\b/gi, '')
    .replace(/\bUNIQUE\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  // ADD COLUMN … NOT NULL without DEFAULT fails on non-empty tables.
  if (/\bNOT\s+NULL\b/i.test(d) && !/\bDEFAULT\b/i.test(d)) {
    d = d.replace(/\bNOT\s+NULL\b/gi, '').replace(/\s+/g, ' ').trim();
  }
  return d;
}

/** Remove generated upgrade blocks and orphan ADD COLUMN lines for CREATE columns. */
function stripManagedAlters(sql, tables) {
  let out = sql.replace(
    /\n-- Upgrade existing DBs: CREATE IF NOT EXISTS does not add columns; keep in sync with CREATE above\.\n(?:ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS[^\n]*\n)+/g,
    '\n',
  );

  const managed = new Set();
  for (const t of tables) {
    for (const col of t.columns) {
      if (col.isSerialPk) continue;
      managed.add(`${t.table.toLowerCase()}.${col.name.toLowerCase()}`);
    }
  }

  out = out.replace(
    /^ALTER TABLE\s+(\w+)\s+ADD COLUMN IF NOT EXISTS\s+(\w+)[^\n]*\n/gim,
    (line, table, col) => {
      const key = `${table.toLowerCase()}.${col.toLowerCase()}`;
      return managed.has(key) ? '' : line;
    },
  );

  return out;
}

let sql = fs.readFileSync(sql01Path, 'utf8');
let tables = parseCreateTables(sql);
sql = stripManagedAlters(sql, tables);
// Offsets change after strip — re-parse.
tables = parseCreateTables(sql);

const insertions = [];
let added = 0;

for (const t of tables) {
  const lines = [];
  for (const col of t.columns) {
    if (col.isSerialPk) continue;
    const adef = alterDefFromCreate(col.def);
    if (!adef) continue;
    lines.push(
      `ALTER TABLE ${t.table} ADD COLUMN IF NOT EXISTS ${col.name} ${adef};`,
    );
    added++;
  }
  if (lines.length === 0) continue;
  const block = `\n${UPGRADE_COMMENT}\n${lines.join('\n')}\n`;
  insertions.push({ at: t.createEnd, block, table: t.table });
}

insertions.sort((a, b) => b.at - a.at);
for (const ins of insertions) {
  sql = sql.slice(0, ins.at) + ins.block + sql.slice(ins.at);
}

fs.writeFileSync(sql01Path, sql);
console.log(
  `Tables scanned: ${tables.length}; ALTER ADD COLUMN lines: ${added}; blocks inserted: ${insertions.length}`,
);
console.log(`Updated: ${sql01Path}`);
