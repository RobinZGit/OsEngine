#!/usr/bin/env node
/**
 * Парсит 01_*.sql и 02_*.sql → assets/schema-offline.json для GitHub Pages
 * (когда API/PostgreSQL недоступны).
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
    for (const col of columns) {
      if (!t.columns.find((c) => c.name === col.name)) {
        t.columns.push(col);
      }
      // Offline: FK из inline REFERENCES — для вкладки «Диаграмма»
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
    const refMatch = rest.match(/\bREFERENCES\s+.+/i);
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

function parseRoutines(sql02Text) {
  const routines = [];
  const commentRe =
    /COMMENT ON (FUNCTION|PROCEDURE)\s+([^(]+)\(([^)]*)\)\s+IS\s+'((?:''|[^'])*)'/gi;
  const comments = new Map();
  for (const m of sql02Text.matchAll(commentRe)) {
    const key = `${m[1].toUpperCase()}:${m[2].trim()}(${m[3].trim()})`;
    comments.set(key, unquoteSqlString(`'${m[4]}'`));
  }

  const skipHttp = sql02Text.indexOf('-- HTTP-ЗАГРУЗКА:');
  const coreSql =
    skipHttp > 0 ? sql02Text.slice(0, skipHttp) : sql02Text;

  const createRe =
    /CREATE OR REPLACE (FUNCTION|PROCEDURE)\s+(\w+)\s*\(([\s\S]*?)\)\s*([\s\S]*?)(?=CREATE OR REPLACE (?:FUNCTION|PROCEDURE)|-- HTTP-ЗАГРУЗКА:|-- ===== КОНЕЦ|$)/gi;

  let oid = 900001;
  for (const m of coreSql.matchAll(createRe)) {
    const kind = m[1].toLowerCase() === 'procedure' ? 'procedure' : 'function';
    const name = m[2];
    const argsBlock = m[3].replace(/\s+/g, ' ').trim();
    const tail = m[4].trim();
    const args = argsBlock
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
      .map((a) => {
        const parts = a.split(/\s+/);
        return parts[0];
      })
      .join(', ');

    let result_type = null;
    if (kind === 'function') {
      const ret = tail.match(/^RETURNS\s+(\S+)/i);
      if (ret) result_type = ret[1];
    }

    const source = `CREATE OR REPLACE ${m[1]} ${name}(${m[3].trim()})\n${tail}`.trim();
    const commentKey = `${m[1].toUpperCase()}:${name}(${args.replace(/\s/g, '')})`;
    let description = null;
    for (const [k, v] of comments) {
      if (k.includes(name)) description = v;
    }

    routines.push({
      oid: oid++,
      name,
      kind,
      arguments: args,
      result_type,
      description,
      source,
    });
  }

  return routines.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind)
  );
}

function main() {
  const sql01Text = read(sql01);
  const sql02Text = read(sql02);

  const schema = {
    schema: 'public',
    database: 'multilogictrade',
    sourceMode: 'offline',
    sourceNote:
      'Структура из SQL-скриптов репозитория (01, 02). PostgreSQL не подключена.',
    generatedFrom: [
      '01_multilogictrade_tables_and_data.sql',
      '02_multilogictrade_functions_and_procedures.sql',
    ],
    tables: parseTables(sql01Text),
    routines: parseRoutines(sql02Text),
    extensions: [{ name: 'http', version: 'опционально (блок HTTP в 02)' }],
  };

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(schema, null, 2), 'utf8');
  console.log(
    `schema-offline.json: ${schema.tables.length} tables, ${schema.routines.length} routines`
  );
}

main();
