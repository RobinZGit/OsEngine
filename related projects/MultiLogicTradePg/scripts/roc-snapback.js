'use strict';

/**
 * roc-snapback.js — готовая к запуску реализация стратегии «ROC-Snapback».
 *
 * Логика (контртрендовый откат по ROC10):
 *   ROC10(i) = (close[i] - close[i-10]) / close[i-10] * 100
 *   ВХОД (long): ROC10 <= -entry (пересечение снизу вверх, т.е. бар i закрылся ниже порога,
 *                 а на i-1 был выше порога) — покупаем по цене закрытия бара i.
 *   ВЫХОД      : ROC10 >= 0 (возврат к нейтрали) — продаём по закрытию.
 *   Если позиция осталась к концу периода — принудительно закрываем по последней цене.
 *   Комиссия: COMM_PCT % от оборота на каждую сделку.
 *
 * Запуск:
 *   node scripts/roc-snapback.js [--sec=4,7] [--tf=5,6]
 *                               [--from=2023-01-01] [--to=2026-08-31] [--period=YEAR]
 *                               [--entry=-2] [--roc=10]
 *   --period=YEAR — печатает разрез по годам; по умолчанию весь заданный диапазон одной серией.
 *   Вывод: по-бумажный итог + полный список сделок (дата входа/выхода, цены, pnl%).
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

const SECURITIES = (arg('sec', '1,4,7,19,20,24,27,28') || '')
  .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
const TIMEFRAMES = (arg('tf', '5,6') || '')
  .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
const FROM = arg('from', '2023-01-01');
const TO = arg('to', '2026-08-31');
const PERIOD = arg('period', null);            // 'YEAR' = разрез по годам
const ENTRY = Number(arg('entry', '-2'));       // порог входа ROC
const ROC_P = Math.max(1, Number(arg('roc', '10'))); // период ROC

const COMM_PCT = 0.05;                          // % от оборота на сделку
const WARM_FRAC = 0.03;                         // прогрев индикатора

/* ---------- ROC ---------- */
function rocSeries(close, period) {
  const n = close.length;
  const r = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (close[i - period] !== 0) r[i] = ((close[i] - close[i - period]) / close[i - period]) * 100;
  }
  return r;
}

/* ---------- исполнение стратегии на серии баров ---------- */
// rows: [{dt, c}] отсортированные по времени
function runSnapBack(rows) {
  const n = rows.length;
  const close = rows.map((b) => b.c);
  const roc = rocSeries(close, ROC_P);
  const trades = [];
  let position = 0, entryIdx = -1, entryIdx2 = null;

  for (let i = 1; i < n; i++) {
    const r = roc[i], rPrev = roc[i - 1];
    if (r == null || rPrev == null) continue;

    if (position === 0) {
      // вход: пересечение порога снизу вверх, rPrev > ENTRY >= r
      if (rPrev > ENTRY && r <= ENTRY) {
        position = 1;
        entryIdx = i;
      }
    } else {
      // выход: возврат к нейтрали (roc >= 0)
      if (r >= 0 && rPrev < 0) {
        trades.push(closeTrade(rows, entryIdx, i));
        position = 0; entryIdx = -1;
      }
    }
  }
  if (position === 1) trades.push(closeTrade(rows, entryIdx, n - 1)); // принудительное закрытие
  return trades;
}

function closeTrade(rows, a, b) {
  const pnl = ((rows[b].c - rows[a].c) / rows[a].c) * 100 - COMM_PCT;
  return { dtIn: rows[a].dt, dtOut: rows[b].dt, pxIn: rows[a].c, pxOut: rows[b].c, pnl };
}

function summarize(trades) {
  if (!trades.length) return { n: 0 };
  const pnls = trades.map((t) => t.pnl);
  const gross = pnls.reduce((a, b) => a + b, 0);
  const wins = pnls.filter((p) => p > 0).length;
  const gw = pnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
  const gl = Math.abs(pnls.filter((p) => p <= 0).reduce((a, b) => a + b, 0));
  let maxDD = 0, peak = 0, cum = 0;
  for (const p of pnls) { cum += p; if (cum > peak) peak = cum; const dd = peak - cum; if (dd > maxDD) maxDD = dd; }
  return { n: pnls.length, gross, winRate: wins / pnls.length, pf: gl === 0 ? (gw > 0 ? 99 : 0) : gw / gl, maxDD, avg: gross / pnls.length };
}

/* ---------- загрузка ---------- */
async function load(client, secId, tfId, from, to) {
  const { rows } = await client.query(
    `SELECT to_char(dt,'YYYY-MM-DD HH24:MI:SS') AS dt, close_price::float8 AS c
     FROM prices
     WHERE security_id=$1 AND timeframe_id=$2 AND dt::date BETWEEN $3 AND $4
     ORDER BY dt`,
    [secId, tfId, from, to]
  );
  return rows;
}

const YEAR_BUCKETS = [['2023', '2023-01-01', '2023-12-31'], ['2024', '2024-01-01', '2024-12-31'], ['2025', '2025-01-01', '2025-12-31'], ['2026', '2026-01-01', '2026-08-31']];

async function main() {
  const client = new Client(PG);
  await client.connect();
  console.log(`ROC-Snapback | ROC(${ROC_P}) entry=${ENTRY}% | sec=${SECURITIES.join(',')} tf=${TIMEFRAMES.join(',')} | ${FROM}..${TO}${PERIOD === 'YEAR' ? ' (разрез по годам)' : ''}`);
  console.log('─'.repeat(78));

  for (const secId of SECURITIES) {
    for (const tfId of TIMEFRAMES) {
      if (PERIOD === 'YEAR') {
        // разрез по годам
        const yearRes = [];
        let allTrades = [];
        let hasData = false;
        for (const [yn, f, t] of YEAR_BUCKETS) {
          const rows = await load(client, secId, tfId, f, t);
          if (rows.length < ROC_P + 2) { yearRes.push({ yn, t: null }); continue; }
          hasData = true;
          const warm = Math.floor(rows.length * WARM_FRAC);
          const trades = runSnapBack(rows.slice(warm));
          allTrades = allTrades.concat(trades);
          yearRes.push({ yn, t: summarize(trades) });
        }
        if (!hasData) { console.log(`  sec=${secId} tf=${tfId}: нет данных`); continue; }
        const tot = summarize(allTrades);
        console.log(`\n[sec=${secId} tf=${tfId}] СУММАРНО: n=${tot.n} gross=${tot.gross.toFixed(2)}% win=${(tot.winRate * 100).toFixed(0)}% pf=${tot.pf.toFixed(2)} maxDD=${tot.maxDD.toFixed(2)}%`);
        for (const y of yearRes) {
          if (!y.t || !y.t.n) { console.log(`   ${y.yn}: —`); continue; }
          console.log(`   ${y.yn}: n=${String(y.t.n).padEnd(3)} gross=${String(y.t.gross.toFixed(2)).padStart(7)}% win=${(y.t.winRate * 100).toFixed(0)}%`);
        }
      } else {
        const rows = await load(client, secId, tfId, FROM, TO);
        if (rows.length < ROC_P + 2) { console.log(`  sec=${secId} tf=${tfId}: нет данных`); continue; }
        const warm = Math.floor(rows.length * WARM_FRAC);
        const trades = runSnapBack(rows.slice(warm));
        const s = summarize(trades);
        if (!s.n) console.log(`\n[sec=${secId} tf=${tfId}] n=0 .. нет сделок`);
        else console.log(`\n[sec=${secId} tf=${tfId}] n=${s.n} gross=${s.gross.toFixed(2)}% win=${(s.winRate * 100).toFixed(0)}% pf=${s.pf.toFixed(2)} maxDD=${s.maxDD.toFixed(2)}% avg=${s.avg ? s.avg.toFixed(2) : '-'}%`);
        for (const t of trades) {
          console.log(`   ${t.dtIn} → ${t.dtOut}  px ${t.pxIn.toFixed(2)} → ${t.pxOut.toFixed(2)}  pnl ${t.pnl.toFixed(2)}%`);
        }
      }
    }
  }
  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
