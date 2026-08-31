'use strict';

/**
 * strategy-3period.js — строгий проверка стратегий на ТРЁХ независимых периодах.
 *
 *   период A (train): 2023-01-01 .. 2024-12-31  — отбор кандидатов
 *   период B (val)  : 2025-01-01 .. 2025-12-31  — проверка (не участвует в отборе)
 *   период C (test) : 2026-01-01 .. 2026-08-31  — независимая проверка
 *
 * 1) На train считаем все кандидаты (фиксированный словарь индикаторов),
 *    оставляем стратегии устойчивые на train (in-sample walk-forward split > 0).
 * 2) Те же ФИКСИРОВАННЫЕ правила прогоняем на val (2025) и test (2026).
 * 3) Ранжируем по совокупной надёжности: стратегия должна быть в плюсе
 *    во всех трёх периодах и на многих бумагах.
 * 4) По-бумажно: какие бумаги давали плюс по большинству стратегий во всех периодах.
 *
 * Запуск:
 *   node scripts/strategy-3period.js [--sec=...] [--tf=...] [--top=30] [--json=out.json]
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
const SECURITIES = (arg('sec', '1,4,7,13,19,20,24,27,28') || '')
  .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
const TIMEFRAMES = (arg('tf', '5,6') || '')
  .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
const TOP = Math.min(60, Math.max(1, Number(arg('top', '30')) || 30));
const JSON_OUT = arg('json', null);

const PERIODS = [
  { name: 'train2023_24', from: '2023-01-01', to: '2024-12-31' },
  { name: 'val2025', from: '2025-01-01', to: '2025-12-31' },
  { name: 'test2026', from: '2026-01-01', to: '2026-08-31' },
];

const MIN_TRADES = 5;
const COMMISSION_PCT = 0.05;

const MA_PERIODS = [5, 10, 20, 50, 100];
const FAST_SLOW = [{ f: 8, s: 21, sig: 5 }, { f: 12, s: 26, sig: 9 }, { f: 16, s: 48, sig: 9 }];
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
  for (const p of [10, 20]) {
    const r = new Array(n).fill(null);
    for (let i = p; i < n; i++) if (close[i - p] !== 0) r[i] = ((close[i] - close[i - p]) / close[i - p]) * 100;
    push('ROC', `ROC${p}`, r);
  }
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
  return { n: pnls.length, gross, winRate, pf, maxDD };
}

function runOn(cand, OHLCV, lo, hi) {
  const close = OHLCV;
  const v = cand.series.v;
  const trades = [];
  let position = 0, entry = null;
  const openSig = (i) => {
    const val = v[i];
    if (val == null) return false;
    if (cand.mode === 'trend') {
      if (cand.open === 'price_above') return close[i].c > val;
      if (cand.open === 'macd_above_zero') return val > 0;
      return false;
    }
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
      return false;
    }
    if (cand.close === 'above') return val > 0 && v[i - 1] != null && v[i - 1] <= 0;
    if (cand.close === 'cross_above_band') return close[i].c >= val;
    return false;
  };
  for (let i = Math.max(1, lo); i < hi; i++) {
    if (position === 0) {
      if (openSig(i)) { position = 1; entry = close[i].c; }
    } else if (closeSig(i)) {
      trades.push({ pnlPct: ((close[i].c - entry) / entry) * 100 - COMMISSION_PCT });
      position = 0; entry = null;
    }
  }
  if (position === 1) trades.push({ pnlPct: ((close[hi - 1].c - entry) / entry) * 100 - COMMISSION_PCT });
  return trades;
}

function buildCandidates(indicators) {
  const byCode = {};
  for (const s of indicators) (byCode[s.code] = byCode[s.code] || []).push(s);
  const cands = [];
  for (const code of ['SMA', 'EMA']) {
    for (const line of byCode[code] || []) cands.push({ series: line, mode: 'trend', open: 'price_above', label: `${code} ${line.line} trend` });
  }
  for (const line of (byCode['MACD'] || [])) {
    if (!line.line.startsWith('SIGNAL')) cands.push({ series: line, mode: 'trend', open: 'macd_above_zero', label: `${line.line} macd>0 trend` });
  }
  for (const code of ['RSI', 'CCI', 'CMO', 'STOCH', 'ROC']) {
    for (const line of (byCode[code] || [])) {
      const ths = OSC_THRESHOLDS[code] || [];
      for (const th of ths) cands.push({ series: line, mode: 'counter', open: 'below', th, close: 'above', label: `${line.code} ${line.line} counter<${th}` });
    }
  }
  for (const line of (byCode['BB'] || [])) {
    if (!line.line.startsWith('UPPER')) cands.push({ series: line, mode: 'counter', open: 'price_below_band', close: 'cross_above_band', label: `BB ${line.line} counter` });
  }
  return cands;
}

async function main() {
  const client = new Client(PG);
  await client.connect();
  console.log(`= Трёхпериодная проверка: бумаги ${SECURITIES.join(',')}, tf ${TIMEFRAMES.join(',')}`);
  console.log(`  train=2023-24, val=2025, test=2026\n`);

  // Карта paper-key: SECID|TFID -> { periodName -> {n, OHLCV, indicators, cands} }
  // Загружаем каждый период отдельно.
  const paperPeriodData = {}; // "sec|tf|period" -> {rows}

  for (const secId of SECURITIES) {
    for (const tfId of TIMEFRAMES) {
      for (const per of PERIODS) {
        const { rows } = await client.query(
          `SELECT to_char(dt,'YYYY-MM-DD HH24:MI:SS') AS dt,
                  open_price::float8 o, high_price::float8 h, low_price::float8 l,
                  close_price::float8 c, volume::float8 v
           FROM prices
           WHERE security_id=$1 AND timeframe_id=$2 AND dt::date BETWEEN $3 AND $4
           ORDER BY dt`,
          [secId, tfId, per.from, per.to]
        );
        paperPeriodData[`${secId}|${tfId}|${per.name}`] = rows;
      }
    }
  }
  await client.end();

  // Для каждого paper прогон train с внутренним split → отбор устойчивых стратегий
  // train split: первые 60% индексов in, последние 40% out, оба должны быть >0.
  const selectedPerPaper = []; // {secId,tfId,cand}
  for (const secId of SECURITIES) {
    for (const tfId of TIMEFRAMES) {
      const rows = paperPeriodData[`${secId}|${tfId}|train2023_24`];
      if (!rows || rows.length < 150) { console.log(`  sec=${secId} tf=${tfId}: train данных мало (${rows ? rows.length : 0}), пропуск`); continue; }
      const n = rows.length;
      const warm = Math.floor(n * 0.05);
      const midI = Math.floor(n * 0.6);
      const indicators = computeIndicators(rows);
      const cands = buildCandidates(indicators);
      let chosen = 0;
      for (const cand of cands) {
        const inT = runOn(cand, rows, warm, midI);
        const outT = runOn(cand, rows, midI, n);
        const inS = stats(inT), outS = stats(outT);
        if (!inS || !outS) continue;
        if (inS.n < MIN_TRADES || outS.n < MIN_TRADES) continue;
        if (inS.gross > 0 && outS.gross > 0) {
          selectedPerPaper.push({ secId, tfId, cand, trainGross: inS.gross + outS.gross });
          chosen++;
        }
      }
      console.log(`  sec=${secId} tf=${tfId}: train выбрано устойчивых=${chosen}/${cands.length}`);
    }
  }

  // Прогон выбранных фиксированных стратегий на val и test
  const results = []; // {secId,tfId,cand, per:{train,val,test}}
  const uniq = new Map();
  for (const sp of selectedPerPaper) {
    const key = secTfKey(sp.secId, sp.tfId, sp.cand);
    if (uniq.has(key)) continue;
    uniq.set(key, true);
    const rec = { secId: sp.secId, tfId: sp.tfId, cand: sp.cand, per: {} };
    for (const per of PERIODS) {
      const rows = paperPeriodData[`${sp.secId}|${sp.tfId}|${per.name}`];
      if (!rows || rows.length < 40) { rec.per[per.name] = null; continue; }
      const n = rows.length;
      const warm = Math.floor(n * 0.05);
      // на val/test считаем индикаторы заново на этом периоде
      // упрощение: индикаторы зависят от цен этого периода — OK
      const indicators = computeIndicators(rows);
      // находим ту же серию по label
      const s = indicators.find((x) => x.code === sp.cand.series.code && x.line === sp.cand.series.line);
      if (!s) { rec.per[per.name] = null; continue; }
      const cand2 = { ...sp.cand, series: s };
      const trades = runOn(cand2, rows, warm, n);
      rec.per[per.name] = stats(trades);
    }
    results.push(rec);
  }

  // Агрегация по стратегии (label) — каждая стратегия собрала сколько paper-точек и в скольких периодах в плюсе
  const agg = new Map();
  for (const r of results) {
    const lbl = r.cand.label;
    if (!agg.has(lbl)) agg.set(lbl, []);
    agg.get(lbl).push(r);
  }

  function countPositive(list, period) {
    let p = 0, tot = 0;
    for (const r of list) { const s = r.per[period]; if (!s || s.n < MIN_TRADES) continue; tot++; if (s.gross > 0) p++; }
    return { p, tot };
  }
  function avgGross(list, period) {
    let s = 0, c = 0;
    for (const r of list) { const x = r.per[period]; if (!x || x.n < MIN_TRADES) continue; s += x.gross; c++; }
    return c ? s / c : 0;
  }

  const ranked = [];
  for (const [lbl, list] of agg) {
    const tr = countPositive(list, 'train2023_24');
    const va = countPositive(list, 'val2025');
    const te = countPositive(list, 'test2026');
    // надёжность: доля положительных в каждом периоде
    const rel = Math.min(tr.p / Math.max(1, tr.tot), va.p / Math.max(1, va.tot), te.p / Math.max(1, te.tot));
    const total = tr.p + va.p + te.p;
    const gTr = avgGross(list, 'train2023_24');
    const gVa = avgGross(list, 'val2025');
    const gTe = avgGross(list, 'test2026');
    ranked.push({
      strategy: lbl, papers: tr.tot,
      trPos: tr.p, vaPos: va.p, tePos: te.p,
      trGross: gTr, vaGross: gVa, teGross: gTe,
      reliability: Number(rel.toFixed(2)),
      strong: tr.p >= 6 && va.p >= 6 && te.p >= 6,
    });
  }
  ranked.sort((a, b) => b.reliability - a.reliability || b.tePos - a.tePos || b.gTe - a.gTe);

  console.log('\n=== Стратегии по надёжности (плюс во всех 3 периодах, фиксированные правила) ===');
  console.log(' стратегия | бум | +train | +val | +test | sGross(tr/val/te) | rel');
  for (const r of ranked.slice(0, TOP)) {
    const flag = r.reliability >= 1.0 ? '  >ВСЕХ' : (r.reliability >= 0.8 ? '  >OK' : '');
    console.log(
      ` ${String(r.strategy).padEnd(30)} | ${String(r.papers).padEnd(4)} | ${String(r.trPos).padEnd(4)} | ${String(r.vaPos).padEnd(4)} | ${String(r.tePos).padEnd(4)} | ${r.trGross.toFixed(1)} / ${r.vaGross.toFixed(1)} / ${r.teGross.toFixed(1)} | ${r.reliability.toFixed(2)}${flag}`
    );
  }

  // === По-бумажный анализ надёжности ===
  console.log('\n=== По-бумажный анализ: сколько стратегий дали плюс на каждой бумаге в каждый период ===');
  const secAgg = new Map();
  for (const r of results) {
    const k = `${r.secId}|${r.tfId}`;
    if (!secAgg.has(k)) secAgg.set(k, { pos: { train2023_24: 0, val2025: 0, test2026: 0 }, tot: 0 });
    const a = secAgg.get(k);
    a.tot++;
    for (const per of PERIODS) {
      const s = r.per[per.name];
      if (s && s.n >= MIN_TRADES && s.gross > 0) a.pos[per.name]++;
    }
  }
  console.log(' paper(sec,tf) | #стр+train | #стр+val | #стр+test | стабильны(3)');
  for (const [k, a] of secAgg) {
    const all3 = (p) => a.pos[p];
    const stable = all3('train2023_24') > 0 && all3('val2025') > 0 && all3('test2026') > 0 ? 'YES' : 'no';
    console.log(` sec${k.padEnd(8)} | ${String(a.pos.train2023_24).padEnd(5)} | ${String(a.pos.val2025).padEnd(5)} | ${String(a.pos.test2026).padEnd(5)} | ${stable}`);
  }

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({
      generated: new Date().toISOString(),
      securities: SECURITIES, timeframes: TIMEFRAMES,
      periods: PERIODS.map((p) => p.name),
      topStrategies: ranked.slice(0, TOP),
      perPaper: [...secAgg.entries()].map(([k, a]) => ({ paper: k, ...a })),
    }, null, 2));
    console.log(`\nJSON: ${JSON_OUT}`);
  }

  function secTfKey(sec, tf, cand) {
    return `${sec}|${tf}|${cand.series.code}|${cand.series.line}|${cand.th}|${cand.mode}`;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
