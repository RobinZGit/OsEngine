'use strict';

/**
 * scripts/download-missing-prices.js
 * Докачка недостающих цен из MOEX ISS (T-Bank из этой машины недоступен: SSL/timeout).
 *
 * Логика:
 *  - Для каждой (security × timeframe) проверяем реальное годовое покрытие в таблице `prices`.
 *  - Для недостающих периодов вызываем load_prices_from_moex_http по частям (по 1 месяцу),
 *    чтобы не ловить таймаут ISS на большом диапазоне и получать подтверждение вставки.
 *  - После докачки сверяем покрытие снова и печатаем итог.
 *
 * Запуск:
 *   node scripts/download-missing-prices.js [--sec=1,4,...] [--tf=5,6]
 *                                           [--from=2024-01-01] [--to=2025-12-31]
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
const SECURITIES = (arg('sec', '1,4,5,7,13,19,20,24,27,28') || '')
  .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
const TIMEFRAMES = (arg('tf', '5,6') || '')
  .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
const FROM = arg('from', '2024-01-01') || '2024-01-01';
const TO = arg('to', '2025-12-31') || '2025-12-31';

const CANDLES_PER_MONTH = { 5: 5000, 6: 2600 }; // ориентировочно для оценки успеха

async function countInRange(client, secId, tfId, from, to) {
  const r = await client.query(
    `SELECT count(*)::int AS n FROM prices
     WHERE security_id=$1 AND timeframe_id=$2 AND dt::date BETWEEN $3 AND $4`,
    [secId, tfId, from, to]
  );
  return r.rows[0].n;
}

function dayChunks(from, to) {
  const chunks = [];
  let cur = new Date(from + 'T00:00:00Z');
  const endD = new Date(to + 'T00:00:00Z');
  while (cur <= endD) {
    const y = cur.getUTCFullYear();
    const m = cur.getUTCMonth() + 1;
    const d = cur.getUTCDate();
    const s = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    chunks.push({ from: s, to: s });
    cur = new Date(Date.UTC(y, m - 1, d + 1));
  }
  return chunks;
}

async function withRetry(fn, retries = 3, delayMs = 3000) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      process.stdout.write(`      (попытка ${i + 1} не удалась: ${String(e.message).slice(0, 80)})\n`);
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

function isoNow() { return new Date().toISOString(); }

async function main() {
  const client = new Client(PG);
  await client.connect();

  console.log(`= Докачка цен из MOEX ISS: бумаги ${SECURITIES.join(',')}, tf ${TIMEFRAMES.join(',')}, ${FROM}..${TO}`);
  console.log(`  начато ${isoNow()}\n`);

  const summary = [];

  for (const secId of SECURITIES) {
    for (const tfId of TIMEFRAMES) {
      const before = await countInRange(client, secId, tfId, FROM, TO);
      console.log(`[sec=${secId} tf=${tfId}] строк в диапазоне ДО: ${before}`);

      const chunks = dayChunks(FROM, TO);
      let loaded = 0;
      let failed = 0;

      for (const ch of chunks) {
        // уже есть свечи в этот день — пропускаем
        const have = await countInRange(client, secId, tfId, ch.from, ch.to);
        if (have > 0) {
          process.stdout.write(`  ${ch.from}: есть (${have})\n`);
          continue;
        }
        try {
          await withRetry(() =>
            client.query('CALL load_prices_from_moex_http($1::int,$2::int,$3::date,$4::date)', [
              secId, tfId, ch.from, ch.to,
            ])
          );
          const after = await countInRange(client, secId, tfId, ch.from, ch.to);
          const dl = after - have;
          loaded += dl;
          process.stdout.write(`  ${ch.from}: +${dl}\n`);
        } catch (e) {
          failed++;
          process.stdout.write(`  ${ch.from}: ОШИБКА ${String(e.message).slice(0, 90)}\n`);
        }
      }

      const after = await countInRange(client, secId, tfId, FROM, TO);
      summary.push({ sec: secId, tf: tfId, before, after, loaded, failed });
      console.log(`  [sec=${secId} tf=${tfId}] ПОСЛЕ: ${after} (докачано ${loaded})\n`);
    }
  }

  await client.end();
  console.log('=== ИТОГ ===');
  console.table(summary.map((s) => ({ ...s })));
  console.log(`\nГотово ${isoNow()}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
