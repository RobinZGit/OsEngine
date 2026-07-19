#!/usr/bin/env node
/**
 * Парсит актуальные 01_*.sql и 02_*.sql → web/src/assets/schema-offline.json
 * (GitHub Pages / UI без PostgreSQL).
 *
 * Правила:
 * - таблицы: CREATE TABLE + ALTER ADD COLUMN IF NOT EXISTS (идемпотентный 01);
 * - функции/процедуры: все CREATE OR REPLACE из 02, включая HTTP-блок;
 * - дубликаты по (kind, name, args) — побеждает последнее определение (как CREATE OR REPLACE).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const sql01 = path.join(root, '01_multilogictrade_tables_and_data.sql');
const sql02 = path.join(root, '02_multilogictrade_functions_and_procedures.sql');
const out = path.join(root, 'web', 'src', 'assets', 'schema-offline.json');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function unquoteSqlString(s) {
  return s.replace(/^'([\s\S]*)'$/s, '$1').replace(/''/g, "'");
}

function parseTables(sql01Text) {
  const tables = new Map();
  const tableComments = new Map();
  const columnComments = new Map();

  for (const m of sql01Text.matchAll(
    /COMMENT ON TABLE\s+(\w+)\s+IS\s+'((?:''|[^'])*)'/gi
  )) {
    tableComments.set(m[1], unquoteSqlString(`'${m[2]}'`));
  }

  for (const m of sql01Text.matchAll(
    /COMMENT ON COLUMN\s+(\w+)\.(\w+)\s+IS\s+'((?:''|[^'])*)'/gi
  )) {
    columnComments.set(`${m[1]}.${m[2]}`, unquoteSqlString(`'${m[3]}'`));
  }

  for (const m of sql01Text.matchAll(
    /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\)\s*;/gi
  )) {
    const name = m[1];
    const body = m[2];
    const columns = [];
    for (const line of body.split('\n')) {
      const trimmed = line.trim().replace(/,$/, '');
      if (!trimmed || trimmed.startsWith('--') || trimmed.startsWith('CONSTRAINT ')) {
        continue;
      }
      if (/^(PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY)/i.test(trimmed)) {
        continue;
      }
      const colMatch = trimmed.match(/^(\w+)\s+(.+)$/);
      if (!colMatch) continue;
      const colName = colMatch[1];
      let rest = colMatch[2];
      const nullable = !/\bNOT NULL\b/i.test(rest);
      rest = rest.replace(/\bNOT NULL\b/gi, '').replace(/\bNULL\b/gi, '');
      const defaultMatch = rest.match(/\bDEFAULT\s+(.+)$/i);
      let defaultVal = null;
      if (defaultMatch) {
        defaultVal = defaultMatch[1].trim();
        rest = rest.slice(0, defaultMatch.index).trim();
      }
      const type = rest.trim();
      columns.push({
        name: colName,
        type,
        nullable,
        default: defaultVal,
        comment: columnComments.get(`${name}.${colName}`) || null,
      });
    }
    if (!tables.has(name)) {
      tables.set(name, {
        name,
        comment: tableComments.get(name) || null,
        columns: [],
        indexes: [],
        constraints: [],
      });
    }
    const t = tables.get(name);
    t.comment = tableComments.get(name) || t.comment;
    for (const col of columns) {
      if (!t.columns.find((c) => c.name === col.name)) {
        t.columns.push(col);
      }
      const ref = col.type.match(/REFERENCES\s+(\w+)\s*\((\w+)\)/i);
      if (ref) {
        const conName = `${name}_${col.name}_fkey`;
        if (!t.constraints.find((c) => c.name === conName)) {
          t.constraints.push({
            name: conName,
            type: 'FOREIGN KEY',
            definition: `FOREIGN KEY (${col.name}) REFERENCES ${ref[1]}(${ref[2]})`,
          });
        }
      }
      if (/\bPRIMARY KEY\b/i.test(col.type)) {
        const pkName = `${name}_pkey`;
        if (!t.constraints.find((c) => c.name === pkName)) {
          t.constraints.push({
            name: pkName,
            type: 'PRIMARY KEY',
            definition: `PRIMARY KEY (${col.name})`,
          });
        }
      }
    }
  }

  for (const m of sql01Text.matchAll(
    /ALTER TABLE\s+(\w+)\s+ADD COLUMN IF NOT EXISTS\s+(\w+)\s+([^;]+);/gi
  )) {
    const tableName = m[1];
    const colName = m[2];
    let rest = m[3].trim();
    if (!tables.has(tableName)) {
      tables.set(tableName, {
        name: tableName,
        comment: tableComments.get(tableName) || null,
        columns: [],
        indexes: [],
        constraints: [],
      });
    }
    const t = tables.get(tableName);
    if (t.columns.find((c) => c.name === colName)) continue;
    const nullable = !/\bNOT NULL\b/i.test(rest);
    rest = rest.replace(/\bNOT NULL\b/gi, '').replace(/\bNULL\b/gi, '');
    const type = rest.replace(/\bREFERENCES\s+.+/i, '').trim();
    t.columns.push({
      name: colName,
      type,
      nullable,
      default: null,
      comment: columnComments.get(`${tableName}.${colName}`) || null,
    });
  }

  for (const m of sql01Text.matchAll(
    /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS\s+(\w+)\s+ON\s+(\w+)\s*\(([^)]+)\)/gi
  )) {
    const idxName = m[1];
    const tableName = m[2];
    if (!tables.has(tableName)) continue;
    const definition = m[0].replace(/\s+/g, ' ').trim();
    if (!tables.get(tableName).indexes.find((i) => i.name === idxName)) {
      tables.get(tableName).indexes.push({ name: idxName, definition });
    }
  }

  return [...tables.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeArgList(argsBlock) {
  return argsBlock
    .replace(/\s+/g, ' ')
    .trim()
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
    .map((a) => {
      // p_name TYPE DEFAULT … → p_name
      const parts = a.split(/\s+/);
      return parts[0] || a;
    })
    .join(', ');
}

function parseRoutines(sql02Text) {
  const commentRe =
    /COMMENT ON (FUNCTION|PROCEDURE)\s+([^(]+)\(([^)]*)\)\s+IS\s+'((?:''|[^'])*)'/gi;
  const comments = new Map();
  for (const m of sql02Text.matchAll(commentRe)) {
    const kind = m[1].toUpperCase();
    const name = m[2].trim().replace(/^public\./i, '');
    const args = m[3].replace(/\s+/g, ' ').trim();
    comments.set(`${kind}:${name}(${args})`, unquoteSqlString(`'${m[4]}'`));
    // короткий ключ по имени — запасной
    if (!comments.has(`${kind}:${name}`)) {
      comments.set(`${kind}:${name}`, unquoteSqlString(`'${m[4]}'`));
    }
  }

  // Весь 02, включая HTTP — Help должен видеть все routines скрипта.
  const createRe =
    /CREATE OR REPLACE (FUNCTION|PROCEDURE)\s+(\w+)\s*\(([\s\S]*?)\)\s*([\s\S]*?)(?=CREATE OR REPLACE (?:FUNCTION|PROCEDURE)|$)/gi;

  /** @type {Map<string, object>} */
  const byKey = new Map();
  let oid = 900001;

  for (const m of sql02Text.matchAll(createRe)) {
    const kindWord = m[1].toUpperCase();
    const kind = kindWord === 'PROCEDURE' ? 'procedure' : 'function';
    const name = m[2];
    const args = normalizeArgList(m[3]);
    const tail = m[4].trim();

    let result_type = null;
    if (kind === 'function') {
      const ret = tail.match(/^RETURNS\s+(\S+)/i);
      if (ret) result_type = ret[1];
    }

    const source = `CREATE OR REPLACE ${m[1]} ${name}(${m[3].trim()})\n${tail}`.trim();
    const description =
      comments.get(`${kindWord}:${name}(${args})`) ||
      comments.get(`${kindWord}:${name}`) ||
      null;

    const key = `${kind}:${name}(${args})`;
    byKey.set(key, {
      oid: oid++,
      name,
      kind,
      arguments: args,
      result_type,
      description,
      source,
    });
  }

  return [...byKey.values()].sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind)
  );
}

function main() {
  const sql01Text = read(sql01);
  const sql02Text = read(sql02);

  const tables = parseTables(sql01Text);
  const routines = parseRoutines(sql02Text);
  const createCount = [
    ...sql02Text.matchAll(/CREATE OR REPLACE (FUNCTION|PROCEDURE)\s+\w+/gi),
  ].length;

  const schema = {
    schema: 'public',
    database: 'multilogictrade',
    sourceMode: 'offline',
    sourceNote:
      'Структура из SQL-скриптов репозитория (01 таблицы + ALTER; 02 все функции/процедуры, последнее определение при дублях). PostgreSQL не подключена.',
    generatedFrom: [
      '01_multilogictrade_tables_and_data.sql',
      '02_multilogictrade_functions_and_procedures.sql',
    ],
    generatedAt: new Date().toISOString(),
    stats: {
      tables: tables.length,
      routines: routines.length,
      createStatementsIn02: createCount,
      dedupedFromCreates: createCount - routines.length,
    },
    tables,
    routines,
    extensions: [{ name: 'http', version: 'опционально (блок HTTP в 02)' }],
  };

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(schema, null, 2), 'utf8');
  console.log(
    `schema-offline.json: ${tables.length} tables, ${routines.length} routines` +
      (createCount !== routines.length
        ? ` (deduped from ${createCount} CREATE in 02)`
        : '')
  );
}

main();
