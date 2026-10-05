#!/usr/bin/env node
/**
 * Починка свечей, испорченных багом resample_prices_to_timeframe (сдвиг dt на +3 часа).
 *
 * Баг: EXTRACT(EPOCH FROM timestamp) считает epoch как UTC, а to_timestamp() возвращает
 * timestamptz → при TimeZone=Europe/Moscow все свечи ресемпла уезжали на +3 часа.
 * Исправлено в sql/load_prices_moex_resample.sql (timestamp 'epoch' + interval).
 *
 * Важно: в «правильном» бакете часто тоже лежит мусор — ресемпл с ON CONFLICT DO UPDATE
 * перетирал легитимную свечу значением из бакета на 3 часа назад. Поэтому починка в 3 фазы:
 *   1) detect  — найти мусорные свечи (O/H/L/C совпадают с окном «offset часов назад» в M1
 *                и НЕ совпадают с агрегатом своего окна);
 *   2) rebuild — пересобрать все поражённые (security, TF) из M1 уже исправленной функцией
 *                (это вернёт правильные значения в правильные бакеты);
 *   3) purge   — удалить оставшиеся мусорные ряды (+3 часа).
 *
 * Запуск:
 *   node scripts/repair-resample-candle-shift.mjs            # dry-run (только отчёт)
 *   node scripts/repair-resample-candle-shift.mjs --apply    # применить (в одной транзакции)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
// pg живёт в api/node_modules — резолвим оттуда, скрипт лежит в scripts/.
const pg = createRequire(path.join(root, 'api', 'package.json'))('pg');

const APPLY = process.argv.includes('--apply');

const RESAMPLE_TIMEFRAME_IDS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]; // M5..H12
const BASE_TIMEFRAME_ID = 1; // M1 — не ресемплится, эталон времени

function readEnv() {
  const file = path.join(root, 'api', '.env');
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return env;
}

// $1 = base timeframe_id, $2 = массив resample-TF, $3 = сдвиг в часах.
const CTE_HEAD = `
WITH cand AS (
    SELECT p.id, p.security_id, p.timeframe_id, p.dt, p.open_price, p.high_price, p.low_price,
           p.close_price, p.volume, p.value, p.contract_prefix, t.sec,
           p.dt - make_interval(hours => $3::int) AS win_from
    FROM prices p
    JOIN timeframes t ON t.id = p.timeframe_id
    WHERE p.timeframe_id = ANY($2::int[])
), shifted AS (
    SELECT c.id,
           count(*)::int AS n,
           (array_agg(b.open_price  ORDER BY b.dt ASC))[1]  AS o,
           max(b.high_price)                                AS h,
           min(b.low_price)                                 AS l,
           (array_agg(b.close_price ORDER BY b.dt DESC))[1] AS c
    FROM cand c
    JOIN prices b
      ON b.security_id = c.security_id
     AND b.timeframe_id = $1
     AND b.dt >= c.dt - make_interval(hours => $3::int)
     AND b.dt <  c.dt - make_interval(hours => $3::int) + make_interval(secs => c.sec)
    GROUP BY c.id
), own AS (
    SELECT c.id,
           (array_agg(b.open_price  ORDER BY b.dt ASC))[1]  AS o,
           max(b.high_price)                                AS h,
           min(b.low_price)                                 AS l,
           (array_agg(b.close_price ORDER BY b.dt DESC))[1] AS c
    FROM cand c
    JOIN prices b
      ON b.security_id = c.security_id
     AND b.timeframe_id = $1
     AND b.dt >= c.dt
     AND b.dt <  c.dt + make_interval(secs => c.sec)
    GROUP BY c.id
)
`;

// Общий предикат мусора: совпадение с окном «offset часов назад» + несовпадение со своим окном.
const GARBAGE_FROM = `
FROM cand g
JOIN shifted s ON s.id = g.id AND s.n > 0
LEFT JOIN own x ON x.id = g.id
WHERE g.open_price = s.o AND g.high_price = s.h AND g.low_price = s.l AND g.close_price = s.c
  AND (x.id IS NULL OR g.open_price <> x.o OR g.high_price <> x.h
       OR g.low_price <> x.l OR g.close_price <> x.c)
`;

const REPORT_SQL =
  CTE_HEAD +
  `SELECT g.security_id, g.timeframe_id, count(*)::int AS n,
          min(g.dt)::date AS date_from, max(g.dt)::date AS date_to
   ${GARBAGE_FROM}
   GROUP BY g.security_id, g.timeframe_id
   ORDER BY n DESC`;

const DELETE_GARBAGE_SQL =
  CTE_HEAD +
  `DELETE FROM prices p USING (SELECT g.id ${GARBAGE_FROM}) g WHERE p.id = g.id RETURNING 1`;

async function main() {
  const env = readEnv();
  const client = new pg.Client({
    host: env.PGHOST || 'localhost',
    port: Number(env.PGPORT || 5432),
    database: env.PGDATABASE || 'multilogictrade',
    user: env.PGUSER || 'postgres',
    password: env.PGPASSWORD || '',
  });
  await client.connect();

  const tzRes = await client.query("SELECT current_setting('TimeZone') AS tz, now() AS now");
  const shiftRes = await client.query(
    `SELECT (EXTRACT(EPOCH FROM now())::bigint / 3600 - EXTRACT(EPOCH FROM (now() AT TIME ZONE 'UTC'))::bigint / 3600) AS h`
  );
  const hours = Number(shiftRes.rows[0].h) || 3;
  const params = [BASE_TIMEFRAME_ID, RESAMPLE_TIMEFRAME_IDS, hours];
  console.log(
    `TimeZone=${tzRes.rows[0].tz} now=${tzRes.rows[0].now.toISOString()} сдвиг=${hours}ч режим=${APPLY ? 'APPLY' : 'DRY-RUN'}`
  );

  const rep = await client.query(REPORT_SQL, params);
  const total = rep.rows.reduce((s, r) => s + r.n, 0);
  console.log(`Мусорных свечей: ${total}; затронуто пар (бумага, TF): ${rep.rows.length}`);
  for (const r of rep.rows.slice(0, 12)) {
    console.log(
      `  sec=${String(r.security_id).padStart(4)} tf=${r.timeframe_id} n=${String(r.n).padStart(5)} ` +
        `${r.date_from.toISOString().slice(0, 10)} .. ${r.date_to.toISOString().slice(0, 10)}`
    );
  }
  if (rep.rows.length > 12) console.log(`  ... ещё ${rep.rows.length - 12} пар`);
  if (!APPLY) {
    console.log('Dry-run: без изменений. Применение — node scripts/repair-resample-candle-shift.mjs --apply');
    await client.end();
    return;
  }
  if (total === 0) {
    console.log('Нечего чинить.');
    await client.end();
    return;
  }

  await client.query('BEGIN');
  try {
    // Фаза 2: пересборка поражённых TF из M1 исправленной процедурой.
    let rebuilt = 0;
    const skipped = [];
    for (const r of rep.rows) {
      const cnt = async () => {
        const c = await client.query(
          'SELECT count(*)::int AS n FROM prices WHERE security_id = $1 AND timeframe_id = $2 AND dt::date BETWEEN $3 AND $4',
          [r.security_id, r.timeframe_id, r.date_from, r.date_to]
        );
        return c.rows[0].n;
      };
      const before = await cnt();
      await client.query('CALL resample_prices_to_timeframe($1, $2, $3, $4, $5)', [
        r.security_id,
        BASE_TIMEFRAME_ID,
        r.timeframe_id,
        r.date_from,
        r.date_to,
      ]);
      const after = await cnt();
      if (after > 0) rebuilt += after;
      if (after === before && before === 0) skipped.push(`${r.security_id}/${r.timeframe_id}`);
    }
    // Фаза 3: удаление мусора (пересборка уже вернула верные значения в верные бакеты).
    const del = await client.query(DELETE_GARBAGE_SQL, params);
    await client.query('COMMIT');
    console.log(`Пересобрано свечей из M1: ${rebuilt}`);
    console.log(`Удалено мусорных рядов: ${del.rowCount}`);
    if (skipped.length) console.log(`Без данных M1 (пропущены): ${skipped.join(', ')}`);
    console.log('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.log('ROLLBACK:', e.message);
  }
  const rep2 = await client.query(REPORT_SQL, params);
  console.log(`Осталось мусорных: ${rep2.rows.reduce((s, r) => s + r.n, 0)}`);
  await client.end();
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
