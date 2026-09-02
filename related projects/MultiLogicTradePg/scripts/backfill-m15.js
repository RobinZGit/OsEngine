'use strict';

/**
 * scripts/backfill-m15.js
 * Докачка M15 (tf=6) на MOEX ISS c resample из M10 (interval=10) для интрадей-TF,
 * где MOEX не отдаёт interval=15/30 напрямую (0 свечей).
 *
 * Для каждой (security × месяц) проверяет фактическое покрытие M15 в таблице `prices`
 * и, если баров мало, вызывает load_prices_moex_resample_chunked — тот идёт по дням,
 * поэтому каждый вызов укладывается в statement_timeout (в отличие от большого диапазона разом).
 *
 * Запуск:
 *   node scripts/backfill-m15.js [--sec=1,2,...] [--tf=6]
 *                                [--from=2026-01-01] [--to=2026-05-31] [--min=100]
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

function arg(name, fallback) {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : fallback;
}

// 34 бумаги логики «ROC Snapback» (id=8937) по умолчанию
const DEFAULT_SEC = Array.from({ length: 34 }, (_, i) => i + 1).join(',');
const SECURITIES = (arg('sec', DEFAULT_SEC) || '')
  .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
const TF = Number(arg('tf', '6') || 6);
const FROM = arg('from', '2026-01-01') || '2026-01-01';
const TO = arg('to', '2026-05-31') || '2026-05-31';
const MIN_BARS = Number(arg('min', '100') || 100);

function monthChunks(from, to) {
  const chunks = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const [toY, toM] = [Number(to.slice(0, 4)), Number(to.slice(5, 7))];
  while (y < toY || (y === toY && m <= toM)) {
    const s = `${y}-${String(m).padStart(2, '0')}-01`;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const e = `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
    chunks.push({ from: s, to: e });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return chunks;
}

async function countInRange(client, secId, from, to) {
  const r = await client.query(
    `SELECT count(*)::int AS n FROM prices
     WHERE security_id=$1 AND timeframe_id=$2 AND dt::date BETWEEN $3 AND $4`,
    [secId, TF, from, to]
  );
  return r.rows[0].n;
}

async function withRetry(fn, retries = 3, delayMs = 4000) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      process.stdout.write(`      (попытка ${i + 1} не удалась: ${String(e.message).slice(0, 90)})\n`);
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

function isoNow() { return new Date().toISOString(); }

async function main() {
  const client = new Client(PG);
  await client.connect();

  console.log(`= Докачка M${TF <= 6 ? '15' : TF} из MOEX (M10+resample): ${SECURITIES.length} бумаг, ${FROM}..${TO}`);
  console.log(`  начато ${isoNow()}\n`);

  const chunks = monthChunks(FROM, TO);
  const summary = [];

  for (const secId of SECURITIES) {
    let secLoaded = 0;
    let secDone = true;
    for (const ch of chunks) {
      const have = await countInRange(client, secId, ch.from, ch.to);
      if (have >= MIN_BARS) {
        process.stdout.write(`  [sec=${secId}] ${ch.from}..${ch.to}: есть (${have})\n`);
        continue;
      }
      secDone = false;
      try {
        await withRetry(async () => {
          await client.query(
            'CALL load_prices_moex_resample_chunked($1::int,$2::int,$3::date,$4::date)',
            [secId, TF, ch.from, ch.to]
          );
        });
        const after = await countInRange(client, secId, ch.from, ch.to);
        secLoaded += after - have;
        process.stdout.write(`  [sec=${secId}] ${ch.from}..${ch.to}: было ${have}, стало ${after}\n`);
      } catch (e) {
        process.stdout.write(`  [sec=${secId}] ${ch.from}..${ch.to}: ОШИБКА ${String(e.message).slice(0, 90)}\n`);
      }
    }
    summary.push({ sec: secId, loaded: secLoaded, done: secDone ? 'yes' : 'no' });
  }

  await client.end();
  console.log('=== ИТОГ ===');
  console.table(summary);
  console.log(`\nГотово ${isoNow()}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
