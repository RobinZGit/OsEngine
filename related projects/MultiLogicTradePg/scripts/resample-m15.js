'use strict';

/**
 * scripts/resample-m15.js
 * Строит M15 (tf=6) из скачанного M10 (tf=5) для заданных периодов через штатную
 * процедуру `resample_prices_to_timeframe` (тот же алгоритм, что использует сама БД).
 *
 * Запуск:
 *   node scripts/resample-m15.js [--sec=1,4,...] [--from=2024-01-01] [--to=2025-12-31]
 */

const path = require('path');
const { Client } = require(path.join(__dirname, '..', 'api', 'node_modules', 'pg'));

const PG = {
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'multilogictrade',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || '111',
};
const SRC_TF = 5; // M10
const DST_TF = 6; // M15

function arg(name, fallback) {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : fallback;
}
const SECURITIES = (arg('sec', '1,4,5,7,13,19,20,24,27,28') || '')
  .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
const FROM = arg('from', '2024-01-01') || '2024-01-01';
const TO = arg('to', '2025-12-31') || '2025-12-31';

async function count(client, secId, tfId, from, to) {
  const r = await client.query(
    `SELECT count(*)::int n FROM prices
     WHERE security_id=$1 AND timeframe_id=$2 AND dt::date BETWEEN $3 AND $4`,
    [secId, tfId, from, to]
  );
  return r.rows[0].n;
}

async function main() {
  const client = new Client(PG);
  await client.connect();
  console.log(`= Ресемпл M10→M15: бумаги ${SECURITIES.join(',')}, ${FROM}..${TO}\n`);
  const summary = [];
  for (const secId of SECURITIES) {
    const src = await count(client, secId, SRC_TF, FROM, TO);
    const dstBefore = await count(client, secId, DST_TF, FROM, TO);
    if (src === 0) { console.log(`  sec=${secId}: нет M10, пропуск`); continue; }
    try {
      await client.query('CALL resample_prices_to_timeframe($1::int,$2::int,$3::int,$4::date,$5::date)', [
        secId, SRC_TF, DST_TF, FROM, TO,
      ]);
      const dstAfter = await count(client, secId, DST_TF, FROM, TO);
      summary.push({ sec: secId, m10: src, m15Before: dstBefore, m15After: dstAfter, m15New: dstAfter - dstBefore });
      console.log(`  sec=${secId}: M10=${src}, M15 ${dstBefore}→${dstAfter} (новых ${dstAfter - dstBefore})`);
    } catch (e) {
      console.log(`  sec=${secId}: ОШИБКА ${e.message}`);
    }
  }
  await client.end();
  console.log('\n=== ИТОГ ===');
  console.table(summary);
}

main().catch((e) => { console.error(e); process.exit(1); });
