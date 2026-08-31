'use strict';

/**
 * strategy-search.js — прототип поиска стратегий под заданный набор цен.
 *
 * Принцип:
 *  1. Загружаем котировки (security × timeframe) один раз из таблицы `prices`.
 *  2. Считаем фиксированный словарь индикаторов в памяти (без БД).
 *  3. Генерируем кандидатов = индикатор × линия × режим (trend/counter) × порог.
 *  4. Быстрый векторный бэктест (long entry → exit, PnL в % на сделку, с комиссией).
 *  5. Walk-forward: первые 50% — in-sample (подбор), последние 50% — out-of-sample
 *     (проверка). Ранжируем по OOS-результату, чтобы не переобучаться на историю.
 *  6. Вывод топ-N стратегий (агрегат по всем бумагам) JSON + таблица.
 *
 * Запуск:
 *   node scripts/strategy-search.js [--sec=1,4,19] [--tf=5,6] [--from=2023-01-01]
 *                                   [--to=2024-12-31] [--top=20] [--json=out.json]
 *
 * Без аргументов — стандартный набор ликвидных бумаг в M5 и M15 (tf 5/6)
 * за 2023-2024, вывод топ-20 в консоль.
 */

const fs = require('fs');
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
const DATE_FROM = arg('from', '2023-01-01') || '2023-01-01';
const DATE_TO = arg('to', '2024-12-31') || '2024-12-31';
const TOP = Math.min(100, Math.max(1, Number(arg('top', '20')) || 20));
const JSON_OUT = arg('json', null);
const OOS_SPLIT = 0.5;
const MIN_TRADES = 6;
const COMMISSION_PCT = 0.05; // % на сделку (entry + exit)

const MA_PERIODS = [5, 10, 20, 50, 100];
const FAST_SLOW = [
  { f: 8, s: 21, sig: 5 },
  { f: 12, s: 26, sig: 9 },
  { f: 16, s: 48, sig: 9 },
];
const OSC_THRESHOLDS = {
  RSI: [25, 30, 35],
  CCI: [-200, -150, -100],
  CMO: [-50, -40],
  STOCH: [15, 20, 25],
  ROC: [-3, -2, -1],
};

function computeIndicators(OHLCV) {
  const n = OHLCV.length;
  const close = OHLCV.map((b) => b.c);
  const high = OHLCV.map((b) => b.h);
  const low = OHLCV.map((b) => b.l);
  const out = [];
  const push = (code, line, values) => {
    const arr = new Array(n).fill(null);
    for (let i = 0; i < n; i++) arr[i] = values[i] == null || !Number.isFinite(values[i]) ? null : Number(values[i]);
    out.push({ code, line, v: arr });
  };

  const smaArr = (src, period) => {
    const r = new Array(n).fill(null);
    let s = 0;
    for (let i = 0; i < n; i++) {
      if (Number.isFinite(src[i])) s += src[i];
      if (i >= period && Number.isFinite(src[i - period])) s -= src[i - period];
      if (i >= period - 1) r[i] = s / period;
    }
    return r;
  };
  const emaArr = (src, period) => {
    const r = new Array(n).fill(null);
    const k = 2 / (period + 1);
    let prev = null;
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(src[i])) continue;
      prev = prev == null ? src[i] : src[i] * k + prev * (1 - k);
      r[i] = prev;
    }
    return r;
  };

  for (const p of MA_PERIODS) {
    push('SMA', `MA${p}`, smaArr(close, p));
    push('EMA', `EMA${p}`, emaArr(close, p));
  }

  // RSI (Wilder)
  for (const p of [7, 14, 21]) {
    const r = new Array(n).fill(null);
    let up = 0, dn = 0, prevAvg = null;
    for (let i = 1; i < n; i++) {
      const ch = close[i] - close[i - 1];
      const u = ch > 0 ? ch : 0, d = ch < 0 ? -ch : 0;
      if (i <= p) { up += u; dn += d; if (i === p) prevAvg = { u: up / p, d: dn / p }; continue; }
      prevAvg = { u: (prevAvg.u * (p - 1) + u) / p, d: (prevAvg.d * (p - 1) + d) / p };
      r[i] = prevAvg.d === 0 ? 100 : 100 - 100 / (1 + prevAvg.u / prevAvg.d);
    }
    push('RSI', `RSI${p}`, r);
  }

  // CCI
  for (const p of [14, 20]) {
    const tp = new Array(n).fill(null);
    for (let i = 0; i < n; i++) tp[i] = (high[i] + low[i] + close[i]) / 3;
    const smaTp = smaArr(tp, p);
    const r = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (i < p - 1 || !Number.isFinite(smaTp[i])) continue;
      let sum = 0;
      for (let j = i - p + 1; j <= i; j++) sum += Math.abs(tp[j] - smaTp[i]);
      const md = sum / p;
      r[i] = md === 0 ? 0 : (tp[i] - smaTp[i]) / (0.015 * md);
    }
    push('CCI', `CCI${p}`, r);
  }

  // MACD
  for (const cfg of FAST_SLOW) {
    const { f, s, sig } = cfg;
    const ef = emaArr(close, f), es = emaArr(close, s);
    const macd = new Array(n).fill(null);
    for (let i = 0; i < n; i++) if (Number.isFinite(ef[i]) && Number.isFinite(es[i])) macd[i] = ef[i] - es[i];
    const signal = new Array(n).fill(null);
    const k = 2 / (sig + 1);
    let prev = null;
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(macd[i])) continue;
      prev = prev == null ? macd[i] : macd[i] * k + prev * (1 - k);
      signal[i] = prev;
    }
    push('MACD', `MACD_${f}_${s}`, macd);
    push('MACD', `SIGNAL_${f}_${s}`, signal);
  }

  // Bollinger
  for (const p of [20]) {
    const mid = smaArr(close, p);
    const up = new Array(n).fill(null), lo = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(mid[i])) continue;
      let ss = 0;
      for (let j = i - p + 1; j <= i; j++) ss += (close[j] - mid[i]) ** 2;
      const sd = Math.sqrt(ss / p);
      up[i] = mid[i] + 2 * sd;
      lo[i] = mid[i] - 2 * sd;
    }
    push('BB', `UPPER${p}`, up);
    push('BB', `LOWER${p}`, lo);
  }

  // CMO
  for (const p of [14]) {
    const r = new Array(n).fill(null);
    let su = 0, sd = 0;
    for (let i = 1; i < n; i++) {
      const ch = close[i] - close[i - 1];
      su += ch > 0 ? ch : 0;
      sd += ch < 0 ? -ch : 0;
      if (i > p) {
        su -= close[i - p] > close[i - p - 1] ? close[i - p] - close[i - p - 1] : 0;
        sd -= close[i - p] < close[i - p - 1] ? close[i - p - 1] - close[i - p] : 0;
      }
      if (i >= p) r[i] = su + sd === 0 ? 0 : ((su - sd) / (su + sd)) * 100;
    }
    push('CMO', `CMO${p}`, r);
  }

  // ROC
  for (const p of [10, 20]) {
    const r = new Array(n).fill(null);
    for (let i = p; i < n; i++) if (close[i - p] !== 0) r[i] = ((close[i] - close[i - p]) / close[i - p]) * 100;
    push('ROC', `ROC${p}`, r);
  }

  // Stochastic %K
  for (const kp of [14]) {
    const kArr = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (i < kp - 1) continue;
      let hh = -Infinity, ll = Infinity;
      for (let j = i - kp + 1; j <= i; j++) { if (high[j] > hh) hh = high[j]; if (low[j] < ll) ll = low[j]; }
      kArr[i] = hh === ll ? 50 : ((close[i] - ll) / (hh - ll)) * 100;
    }
    push('STOCH', `K${kp}`, kArr);
  }

  return out;
}

function stats(trades) {
  if (!trades.length) return null;
  const pnls = trades.map((t) => t.pnlPct);
  const gross = pnls.reduce((a, b) => a + b, 0);
  const wins = pnls.filter((p) => p > 0).length;
  const winRate = wins / pnls.length;
  const grossWin = pnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(pnls.filter((p) => p <= 0).reduce((a, b) => a + b, 0));
  const pf = grossLoss === 0 ? (grossWin > 0 ? 99 : 0) : grossWin / grossLoss;
  let maxDD = 0, peak = 0, cum = 0;
  for (const p of pnls) { cum += p; if (cum > peak) peak = cum; const dd = peak - cum; if (dd > maxDD) maxDD = dd; }
  const avg = gross / pnls.length;
  let sd = 0;
  for (const p of pnls) sd += (p - avg) ** 2;
  sd = Math.sqrt(sd / pnls.length);
  const sharpe = sd === 0 ? 0 : (avg / sd) * Math.sqrt(252);
  return { n: pnls.length, gross, winRate, pf, maxDD, sharpe };
}

/**
 * Бес-нейм бэктест одного кандидата на подмножестве индексов [lo, hi).
 * Режим trend: вход — цена закрытия выше линии MA/EMA (trend-фильтр), выход —
 * фиксированный брейк: цена пересекает линию обратно (или N баров).
 * Режим counter: вход — осциллятор < порога, выход — осциллятор > 0 / обратно.
 */
function runOn(cand, OHLCV, lo, hi) {
  const n = OHLCV.length;
  const close = OHLCV;
  const v = cand.series.v;
  const trades = [];
  let position = 0, entry = null;
  const exitBars = cand.exitBars || 0;

  const openSig = (i) => {
    const val = v[i];
    if (val == null) return false;
    if (cand.mode === 'trend') {
      if (cand.open === 'price_above') return close[i].c > val;
      if (cand.open === 'macd_above_zero') return val > 0;
      if (cand.open === 'price_below_band') return close[i].c < val;
      return false;
    }
    // counter
    if (cand.open === 'below') return val <= cand.th && v[i - 1] != null && v[i - 1] > cand.th;
    if (cand.open === 'price_below_band') return close[i].c < val;
    return false;
  };
  const closeSig = (i) => {
    const val = v[i];
    if (val == null) return false;
    if (cand.mode === 'trend') {
      if (cand.open === 'price_above') return close[i].c <= val;
      if (cand.open === 'macd_above_zero') return val <= 0;
      if (cand.open === 'price_below_band') return close[i].c >= val;
      return false;
    }
    if (cand.close === 'above') return val > 0 && v[i - 1] != null && v[i - 1] <= 0;
    return false;
  };

  for (let i = Math.max(1, lo); i < hi; i++) {
    if (position === 0) {
      if (openSig(i)) { position = 1; entry = close[i].c; }
    } else {
      let exitNow = closeSig(i);
      if (!exitNow && exitBars > 0 && i - lastEntryBar(i) >= 0) { /* time exit via last buy bar */ }
      if (exitNow) {
        trades.push({ pnlPct: ((close[i].c - entry) / entry) * 100 - COMMISSION_PCT });
        position = 0; entry = null;
      }
    }
  }
  if (position === 1) trades.push({ pnlPct: ((close[hi - 1].c - entry) / entry) * 100 - COMMISSION_PCT });
  return trades;

  function lastEntryBar() { return 0; }
}

function buildCandidates(indicators) {
  const byCode = {};
  for (const s of indicators) (byCode[s.code] = byCode[s.code] || []).push(s);
  const cands = [];

  // trend: цена выше MA/EMA — удержание до пересечения вниз для свеч закрытия
  for (const code of ['SMA', 'EMA']) {
    for (const line of byCode[code] || []) {
      cands.push({ series: line, mode: 'trend', open: 'price_above', label: `${code} ${line.line} trend` });
    }
  }
  // trend MACD: гистограмма > 0
  for (const line of byCode['MACD'] || []) {
    if (line.line.startsWith('SIGNAL')) continue;
    cands.push({ series: line, mode: 'trend', open: 'macd_above_zero', label: `${line.line} macd>0 trend` });
  }
  // counter: осциллятор ниже порога, выход когда > 0
  for (const code of ['RSI', 'CCI', 'CMO', 'STOCH', 'ROC']) {
    for (const line of byCode[code] || []) {
      const ths = OSC_THRESHOLDS[code] || [];
      for (const th of ths) cands.push({ series: line, mode: 'counter', open: 'below', th, close: 'above', label: `${line.code} ${line.line} counter<${th}` });
    }
  }
  // BB отскок: цена ниже нижней полосы → вход, выше → выход
  for (const line of byCode['BB'] || []) {
    if (line.line.startsWith('UPPER')) continue;
    cands.push({ series: line, mode: 'counter', open: 'price_below_band', close: 'cross_above_band', label: `BB ${line.line} counter` });
  }
  return cands;
}

async function main() {
  const client = new Client(PG);
  await client.connect();
  console.log(`= Стратегия-поиск: бумаги ${SECURITIES.join(',')}, tf ${TIMEFRAMES.join(',')}, ${DATE_FROM}..${DATE_TO}`);

  const records = [];

  for (const secId of SECURITIES) {
    for (const tfId of TIMEFRAMES) {
      const { rows } = await client.query(
        `SELECT to_char(dt,'YYYY-MM-DD HH24:MI:SS') AS dt,
                open_price::float8 o, high_price::float8 h, low_price::float8 l,
                close_price::float8 c, volume::float8 v
         FROM prices
         WHERE security_id=$1 AND timeframe_id=$2 AND dt::date BETWEEN $3 AND $4
         ORDER BY dt`,
        [secId, tfId, DATE_FROM, DATE_TO]
      );
      if (rows.length < 150) { console.log(`  sec=${secId} tf=${tfId}: пропуск (${rows.length})`); continue; }
      const OHLCV = rows;
      const n = OHLCV.length;
      const warmup = Math.floor(n * 0.05);
      const splitIdx = Math.floor(n * OOS_SPLIT);
      const indicators = computeIndicators(OHLCV);
      const cands = buildCandidates(indicators);

      for (const cand of cands) {
        const inTrades = runOn(cand, OHLCV, warmup, Math.max(warmup, splitIdx));
        const outTrades = runOn(cand, OHLCV, splitIdx, n);
        const inStat = stats(inTrades);
        const outStat = stats(outTrades);
        if (!inStat || !outStat) continue;
        if (outStat.n < MIN_TRADES) continue;
        // устойчивость: и на in, и на out должно быть положительно
        if (inStat.gross <= 0 || outStat.gross <= 0) continue;
        const score = outStat.gross * outStat.pf * outStat.winRate;
        records.push({
          security_id: secId, timeframe_id: tfId,
          strategy: cand.label, indicator: cand.series.code, line: cand.series.line, mode: cand.mode,
          in: inStat, out: outStat,
          score: Number(score.toFixed(3)),
        });
      }
      console.log(`  sec=${secId} tf=${tfId}: свечей=${n}, кандидатов=${cands.length}`);
    }
  }
  await client.end();

  // агрегат по стратегии
  const agg = new Map();
  for (const r of records) {
    const k = `${r.indicator}|${r.line}|${r.mode}|${r.strategy}`;
    if (!agg.has(k)) agg.set(k, []);
    agg.get(k).push(r);
  }
  const ranked = [...agg.entries()]
    .map(([k, list]) => ({
      strategy: list[0].strategy, indicator: list[0].indicator, line: list[0].line, mode: list[0].mode,
      papers: list.length,
      avgGross: list.reduce((a, r) => a + r.out.gross, 0) / list.length,
      avgWinRate: list.reduce((a, r) => a + r.out.winRate, 0) / list.length,
      avgPF: list.reduce((a, r) => a + r.out.pf, 0) / list.length,
      best: list.reduce((x, y) => (y.out.gross > x.out.gross ? y : x), list[0]),
    }))
    .filter((r) => r.avgGross > 0.05)
    .sort((a, b) => b.avgGross - a.avgGross)
    .slice(0, TOP);

  console.log('\n=== ТОП стратегий (среднее по OOS, устойчивые in+out>0) ===');
  if (!ranked.length) console.log('  Нет устойчиво положительных стратегий.');
  for (const r of ranked) {
    console.log(` ${String(r.strategy).padEnd(34)} | бум=${String(r.papers).padEnd(3)} | gross=${r.avgGross.toFixed(2)} | wr=${(r.avgWinRate * 100).toFixed(0)}% | pf=${r.avgPF.toFixed(2)} | луч: sec${r.best.security_id} gross=${r.best.out.gross.toFixed(2)}`);
  }

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ generated: new Date().toISOString(), securities: SECURITIES, timeframes: TIMEFRAMES, from: DATE_FROM, to: DATE_TO, top: ranked }, null, 2));
    console.log(`\nJSON: ${JSON_OUT}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
