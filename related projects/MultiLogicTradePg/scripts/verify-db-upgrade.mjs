/**
 * Sanity-check: upgrade path keeps marker data (same idea as installer DbMode=upgrade).
 * Uses temporary DB multilogictrade_upgrade_verify — does not touch multilogictrade.
 *
 * Usage: PGPASSWORD=111 node scripts/verify-db-upgrade.mjs
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = 'multilogictrade_upgrade_verify';
const markerName = 'ZZ_UPGRADE_MARKER_LOGIC';

function findPsql() {
  const candidates = [
    process.env.PSQL,
    'psql',
    'C:\\Program Files\\PostgreSQL\\15\\bin\\psql.exe',
    'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe',
  ].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  throw new Error('psql not found. Set PSQL= path to psql.exe');
}

function psql(psqlBin, database, args) {
  const env = { ...process.env, PGPASSWORD: process.env.PGPASSWORD || '111' };
  const r = spawnSync(
    psqlBin,
    ['-U', process.env.PGUSER || 'postgres', '-h', process.env.PGHOST || 'localhost', '-d', database, '-v', 'ON_ERROR_STOP=1', ...args],
    { encoding: 'utf8', env },
  );
  if (r.status !== 0) {
    console.error(r.stdout);
    console.error(r.stderr);
    throw new Error(`psql failed (${database}): ${args.join(' ')}`);
  }
  return (r.stdout || '').trim();
}

const psqlBin = findPsql();
console.log('psql:', psqlBin);

psql(psqlBin, 'postgres', [
  '-c',
  `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}' AND pid <> pg_backend_pid();`,
]);
psql(psqlBin, 'postgres', ['-c', `DROP DATABASE IF EXISTS ${db} WITH (FORCE);`]);
psql(psqlBin, 'postgres', ['-c', `CREATE DATABASE ${db} ENCODING 'UTF8' TEMPLATE template0;`]);

const sql01 = path.join(root, '01_multilogictrade_tables_and_data.sql');
const sql02 = path.join(root, '02_multilogictrade_functions_and_procedures.sql');
const dropRoutines = path.join(root, 'sql', 'drop_public_routines.sql');
for (const f of [sql01, sql02, dropRoutines]) {
  if (!fs.existsSync(f)) throw new Error(`Missing ${f}`);
}

console.log('Initial 01 + 02...');
psql(psqlBin, db, ['-f', sql01]);
// Core-only 02 if file is huge with HTTP — still OK if http extension missing may fail at end.
// Strip optional HTTP for verify like CI.
const sql02Text = fs.readFileSync(sql02, 'utf8');
const marker = '-- @optional-http-block';
const core02 = path.join(root, 'scripts', '_tmp_upgrade_02_core.sql');
const idx = sql02Text.indexOf(marker);
fs.writeFileSync(core02, idx >= 0 ? sql02Text.slice(0, idx) : sql02Text);
psql(psqlBin, db, ['-f', core02]);

psql(psqlBin, db, [
  '-c',
  `INSERT INTO logics (name, account_id, is_enabled)
   SELECT '${markerName}', a.id, FALSE FROM accounts a WHERE a.account_code = 'FAKE-EFF-001' LIMIT 1
   ON CONFLICT (name) DO NOTHING;`,
]);
const idBefore = psql(psqlBin, db, ['-t', '-A', '-c', `SELECT id FROM logics WHERE name = '${markerName}';`]);
if (!idBefore) throw new Error('Marker logic was not inserted');
console.log('Marker logic id:', idBefore);

console.log('Upgrade: drop routines + 01 + 02...');
psql(psqlBin, db, ['-f', dropRoutines]);
psql(psqlBin, db, ['-f', sql01]);
psql(psqlBin, db, ['-f', core02]);

const idAfter = psql(psqlBin, db, ['-t', '-A', '-c', `SELECT id FROM logics WHERE name = '${markerName}';`]);
const fnCount = psql(psqlBin, db, [
  '-t',
  '-A',
  '-c',
  `SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public';`,
]);

fs.unlinkSync(core02);
psql(psqlBin, 'postgres', ['-c', `DROP DATABASE IF EXISTS ${db} WITH (FORCE);`]);

if (idAfter !== idBefore) {
  throw new Error(`Marker logic lost or id changed: before=${idBefore} after=${idAfter}`);
}
if (Number(fnCount) < 50) {
  throw new Error(`Too few public routines after upgrade: ${fnCount}`);
}

console.log('OK: marker preserved, public routines:', fnCount);
