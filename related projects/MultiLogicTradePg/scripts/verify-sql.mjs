#!/usr/bin/env node
/**
 * Проверка SQL-скриптов 00–02 перед сборкой и деплоем.
 * Создаёт временную БД multilogictrade_verify (dev-БД не трогается).
 *
 * Использование:
 *   node scripts/verify-sql.mjs              — полный прогон (нужен pgsql-http)
 *   node scripts/verify-sql.mjs --core-only  — без HTTP-блока (CI / без http)
 *   SKIP_SQL_VERIFY=1 npm run build          — пропуск (не рекомендуется)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const verifyDb = process.env.SQL_VERIFY_DB || 'multilogictrade_verify';
const coreOnly = process.argv.includes('--core-only');

if (process.env.SKIP_SQL_VERIFY === '1') {
  console.log('verify-sql: SKIP_SQL_VERIFY=1 — проверка пропущена');
  process.exit(0);
}

const pgBinCandidates = [
  process.env.PG_BIN,
  'C:/Program Files/PostgreSQL/15/bin',
  'C:/Program Files/PostgreSQL/16/bin',
  '/usr/lib/postgresql/15/bin',
  '/usr/bin',
].filter(Boolean);

function findPsql() {
  for (const dir of pgBinCandidates) {
    const exe = path.join(dir, process.platform === 'win32' ? 'psql.exe' : 'psql');
    if (fs.existsSync(exe)) return exe;
  }
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['psql'], {
    encoding: 'utf8',
  });
  if (which.status === 0 && which.stdout.trim()) {
    return which.stdout.trim().split(/\r?\n/)[0];
  }
  return null;
}

function runPsql(psql, database, args, input = null) {
  const env = { ...process.env, PGCLIENTENCODING: 'UTF8' };
  const result = spawnSync(
    psql,
    ['-h', process.env.PGHOST || 'localhost', '-p', process.env.PGPORT || '5432', '-U', process.env.PGUSER || 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', ...args],
    { encoding: 'utf8', env, input }
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status ?? 1;
}

function sqlFile(name) {
  return path.join(root, name);
}

function prepareSql02(core) {
  const full = fs.readFileSync(sqlFile('02_multilogictrade_functions_and_procedures.sql'), 'utf8');
  if (!core) return full;
  // Обрезаем один раз по pgcron — http-блок идёт ниже и тоже отсекается.
  const marker = '-- @optional-pgcron-block';
  const idx = full.indexOf(marker);
  if (idx === -1) {
    console.error(`verify-sql: маркер ${marker} не найден в 02`);
    process.exit(1);
  }
  return full.slice(0, idx).trimEnd() + '\n';
}

const psql = findPsql();
if (!psql) {
  console.error(
    'verify-sql: psql не найден. Установите PostgreSQL или задайте PG_BIN.\n' +
      'Проверка обязательна перед сборкой — см. .cursor/rules/database-scripts.mdc'
  );
  process.exit(1);
}

console.log(`verify-sql: ${coreOnly ? 'core (без HTTP)' : 'полный'} прогон → БД ${verifyDb}`);
console.log(`verify-sql: psql = ${psql}`);

const recreateDbSteps = [
  `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${verifyDb}' AND pid <> pg_backend_pid();`,
  `DROP DATABASE IF EXISTS ${verifyDb};`,
  `CREATE DATABASE ${verifyDb} ENCODING 'UTF8' TEMPLATE template0;`,
];

for (const sql of recreateDbSteps) {
  const stepCode = runPsql(psql, 'postgres', ['-c', sql]);
  if (stepCode !== 0) {
    console.error('verify-sql: не удалось пересоздать verify-БД');
    process.exit(stepCode);
  }
}

let code;

for (const file of ['01_multilogictrade_tables_and_data.sql']) {
  console.log(`\n==> ${verifyDb} : ${file}`);
  code = runPsql(psql, verifyDb, ['-f', sqlFile(file)]);
  if (code !== 0) {
    console.error(`verify-sql: ОШИБКА в ${file}`);
    process.exit(code);
  }
}

const sql02 = prepareSql02(coreOnly);
console.log(`\n==> ${verifyDb} : 02_multilogictrade_functions_and_procedures.sql${coreOnly ? ' (core)' : ''}`);
code = runPsql(psql, verifyDb, ['-f', '-'], sql02);
if (code !== 0) {
  console.error('verify-sql: ОШИБКА в 02_multilogictrade_functions_and_procedures.sql');
  process.exit(code);
}

console.log('\nverify-sql: OK — скрипты 01/02 применяются без ошибок');
