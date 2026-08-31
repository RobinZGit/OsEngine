'use strict';

/**
 * strategy-persecurity.js — по-бумажный разрез выбранных стратегий по годам.
 * Берёт фиксированный набор стратегий (по label/режиму) и для каждой бумаги × tf
 * печатает матрицу год-на-год (gross% за 2023/2024/2025/2026), чтобы понять,
 * какие бумаги надёжно работают во всех периодах.
 *
 * По умолчанию фокус на контртрендовых ROC/CCI/CMO и трендовых MACD.
 * Запуск: node scripts/strategy-persecurity.js [--ind=ROC,CCI,CMO,MACD,STOCH]
 */

const path = require('path');
const { Client } = require(path.join(__dirname, '..', 'api', 'node_modules', 'pg'));
const PG = {
  host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'multilogictrade', user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || '111',
};
function arg(name, fb) {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : fb;
}
const SECURITIES = (arg('sec', '1,4,7,19,20,24,27,28') || '').split(',').map(Number).filter((n) => n > 0);
const TIMEFRAMES = (arg('tf', '5,6') || '').split(',').map(Number).filter((n) => n > 0);
const IND_FOCUS = (arg('ind', 'ROC,CCI,CMO,STOCH,MACD') || '').split(',').map((s) => s.trim()).filter(Boolean);

const PERIODS = [
  ['2023', '2023-01-01', '2023-12-31'],
  ['2024', '2024-01-01', '2024-12-31'],
  ['2025', '2025-01-01', '2025-12-31'],
  ['2026', '2026-01-01', '2026-08-31'],
];
const COMMISSION_PCT = 0.05;
const WARM_FRAC = 0.05;

// стратегии-кандидаты наследуются из 4period
const MA_PERIODS = [5, 10, 20, 50, 100];
const FAST_SLOW = [{ f: 8, s: 21, sig: 5 }, { f: 12, s: 26, sig: 9 }, { f: 16, s: 48, sig: 9 }];
const OSC_THRESHOLDS = { RSI: [25, 30, 35], CCI: [-200, -150, -100], CMO: [-50, -40], STOCH: [15, 20, 25], ROC: [-3, -2, -1] };

function computeIndicators(OHLCV) {
  const n = OHLCV.length;
  const close = OHLCV.map((b) => b.c), high = OHLCV.map((b) => b.h), low = OHLCV.map((b) => b.l);
  const out = [];
  const push = (code, line, values) => {
    const arr = new Array(n).fill(null);
    for (let i = 0; i < n; i++) arr[i] = values[i] == null || !Number.isFinite(values[i]) ? null : Number(values[i]);
    out.push({ code, line, v: arr });
  };
  const smaArr = (src, p) => { const r = new Array(n).fill(null); let s = 0; for (let i = 0; i < n; i++) { if (Number.isFinite(src[i])) s += src[i]; if (i >= p && Number.isFinite(src[i - p])) s -= src[i - p]; if (i >= p - 1) r[i] = s / p; } return r; };
  const emaArr = (src, p) => { const r = new Array(n).fill(null); const k = 2 / (p + 1); let prev = null; for (let i = 0; i < n; i++) { if (!Number.isFinite(src[i])) continue; prev = prev == null ? src[i] : src[i] * k + prev * (1 - k); r[i] = prev; } return r; };
  for (const p of MA_PERIODS) { push('SMA', `MA${p}`, smaArr(close, p)); push('EMA', `EMA${p}`, emaArr(close, p)); }
  for (const p of [7, 14, 21]) {
    const r = new Array(n).fill(null); let up = 0, dn = 0, prevAvg = null;
    for (let i = 1; i < n; i++) { const ch = close[i] - close[i - 1]; const u = ch > 0 ? ch : 0, d = ch < 0 ? -ch : 0; if (i <= p) { up += u; dn += d; if (i === p) prevAvg = { u: up / p, d: dn / p }; continue; } prevAvg = { u: (prevAvg.u * (p - 1) + u) / p, d: (prevAvg.d * (p - 1) + d) / p }; r[i] = prevAvg.d === 0 ? 100 : 100 - 100 / (1 + prevAvg.u / prevAvg.d); }
    push('RSI', `RSI${p}`, r);
  }
  for (const p of [14, 20]) {
    const tp = new Array(n).fill(null); for (let i = 0; i < n; i++) tp[i] = (high[i] + low[i] + close[i]) / 3;
    const smaTp = smaArr(tp, p); const r = new Array(n).fill(null);
    for (let i = 0; i < n; i++) { if (i < p - 1 || !Number.isFinite(smaTp[i])) continue; let sum = 0; for (let j = i - p + 1; j <= i; j++) sum += Math.abs(tp[j] - smaTp[i]); const md = sum / p; r[i] = md === 0 ? 0 : (tp[i] - smaTp[i]) / (0.015 * md); }
    push('CCI', `CCI${p}`, r);
  }
  for (const cfg of FAST_SLOW) {
    const { f, s, sig } = cfg; const ef = emaArr(close, f), es = emaArr(close, s);
    const macd = new Array(n).fill(null); for (let i = 0; i < n; i++) if (Number.isFinite(ef[i]) && Number.isFinite(es[i])) macd[i] = ef[i] - es[i];
    const signal = new Array(n).fill(null); const k = 2 / (sig + 1); let prev = null;
    for (let i = 0; i < n; i++) { if (!Number.isFinite(macd[i])) continue; prev = prev == null ? macd[i] : macd[i] * k + prev * (1 - k); signal[i] = prev; }
    push('MACD', `MACD_${f}_${s}`, macd); push('MACD', `SIGNAL_${f}_${s}`, signal);
  }
  for (const p of [20]) {
    const mid = smaArr(close, p); const up = new Array(n).fill(null), lo = new Array(n).fill(null);
    for (let i = 0; i < n; i++) { if (!Number.isFinite(mid[i])) continue; let ss = 0; for (let j = i - p + 1; j <= i; j++) ss += (close[j] - mid[i]) ** 2; const sd = Math.sqrt(ss / p); up[i] = mid[i] + 2 * sd; lo[i] = mid[i] - 2 * sd; }
    push('BB', `UPPER${p}`, up); push('BB', `LOWER${p}`, lo);
  }
  for (const p of [14]) {
    const r = new Array(n).fill(null); let su = 0, sd = 0;
    for (let i = 1; i < n; i++) { const ch = close[i] - close[i - 1]; su += ch > 0 ? ch : 0; sd += ch < 0 ? -ch : 0; if (i > p) { su -= close[i - p] > close[i - p - 1] ? close[i - p] - close[i - p - 1] : 0; sd -= close[i - p] < close[i - p - 1] ? close[i - p - 1] - close[i - p] : 0; } if (i >= p) r[i] = su + sd === 0 ? 0 : ((su - sd) / (su + sd)) * 100; }
    push('CMO', `CMO${p}`, r);
  }
  for (const p of [10, 20]) { const r = new Array(n).fill(null); for (let i = p; i < n; i++) if (close[i - p] !== 0) r[i] = ((close[i] - close[i - p]) / close[i - p]) * 100; push('ROC', `ROC${p}`, r); }
  for (const kp of [14]) {
    const kArr = new Array(n).fill(null); for (let i = 0; i < n; i++) { if (i < kp - 1) continue; let hh = -Infinity, ll = Infinity; for (let j = i - kp + 1; j <= i; j++) { if (high[j] > hh) hh = high[j]; if (low[j] < ll) ll = low[j]; } kArr[i] = hh === ll ? 50 : ((close[i] - ll) / (hh - ll)) * 100; } push('STOCH', `K${kp}`, kArr);
  }
  return out;
}

function runOn(cand, OHLCV, lo, hi) {
  const close = OHLCV, v = cand.series.v;
  const trades = []; let position = 0, entry = null;
  const openSig = (i) => { const val = v[i]; if (val == null) return false; if (cand.mode === 'trend') { if (cand.open === 'price_above') return close[i].c > val; if (cand.open === 'macd_above_zero') return val > 0; } if (cand.open === 'below') return val <= cand.th && v[i - 1] != null && v[i - 1] > cand.th; return false; };
  const closeSig = (i) => { const val = v[i]; if (val == null) return false; if (cand.mode === 'trend') { if (cand.open === 'price_above') return close[i].c <= val; if (cand.open === 'macd_above_zero') return val <= 0; } if (cand.close === 'above') return val > 0 && v[i - 1] != null && v[i - 1] <= 0; return false; };
  for (let i = Math.max(1, lo); i < hi; i++) {
    if (position === 0) { if (openSig(i)) { position = 1; entry = close[i].c; } }
    else if (closeSig(i)) { trades.push({ p: ((close[i].c - entry) / entry) * 100 - COMMISSION_PCT }); position = 0; entry = null; }
  }
  if (position === 1) trades.push({ p: ((close[hi - 1].c - entry) / entry) * 100 - COMMISSION_PCT });
  return trades;
}
function buildCandidates(ind) {
  const byCode = {}; for (const s of ind) (byCode[s.code] = byCode[s.code] || []).push(s);
  const cands = [];
  for (const code of ['SMA', 'EMA']) for (const line of byCode[code] || []) cands.push({ series: line, mode: 'trend', open: 'price_above', label: `${code} ${line.line} trend`, family: code });
  for (const line of (byCode['MACD'] || [])) if (!line.line.startsWith('SIGNAL')) cands.push({ series: line, mode: 'trend', open: 'macd_above_zero', label: `${line.line} macd>0`, family: 'MACD' });
  for (const code of ['RSI', 'CCI', 'CMO', 'STOCH', 'ROC']) for (const line of (byCode[code] || [])) for (const th of (OSC_THRESHOLDS[code] || [])) cands.push({ series: line, mode: 'counter', open: 'below', th, close: 'above', label: `${line.code} ${line.line} <${th}`, family: code });
  return cands.filter((c) => IND_FOCUS.includes(c.family));
}

async function main() {
  const client = new Client(PG); await client.connect();
  console.log(`= По-бумажный разрез (фокус: ${IND_FOCUS.join(',')}), sec=${SECURITIES.join(',')}, tf=${TIMEFRAMES.join(',')}`);
  // грузим все периоды
  const data = {};
  for (const sec of SECURITIES) for (const tf of TIMEFRAMES) for (const [yn, f, t] of PERIODS) {
    const r = await client.query(`SELECT to_char(dt,'YYYY-MM-DD HH24:MI:SS') dt, open_price::float8 o, high_price::float8 h, low_price::float8 l, close_price::float8 c, volume::float8 v FROM prices WHERE security_id=$1 AND timeframe_id=$2 AND dt::date BETWEEN $3 AND $4 ORDER BY dt`, [sec, tf, f, t]);
    data[`${sec}|${tf}|${yn}`] = r.rows;
  }
  await client.end();

  // для каждой бумаги×tf собрать список набранных кандидатов и gross по годам
  const out = [];
  for (const sec of SECURITIES) for (const tf of TIMEFRAMES) {
    const rows23 = data[`${sec}|${tf}|2023`];
    if (!rows23 || rows23.length < 150) continue;
    const n = rows23.length; const warm = Math.floor(n * WARM_FRAC);
    const cands = buildCandidates(computeIndicators(rows23));
    for (const cand of cands) {
      const rec = { paper: `${sec}|${tf}`, strat: cand.label, family: cand.family, yrs: {} };
      for (const [yn] of PERIODS) {
        const rows = data[`${sec}|${tf}|${yn}`];
        if (!rows || rows.length < 40) { rec.yrs[yn] = null; continue; }
        const ind = computeIndicators(rows);
        const s = ind.find((x) => x.code === cand.series.code && x.line === cand.series.line);
        if (!s) { rec.yrs[yn] = null; continue; }
        const trades = runOn({ ...cand, series: s }, rows, Math.floor(rows.length * WARM_FRAC), rows.length);
        const g = trades.reduce((a, t) => a + t.p, 0);
        rec.yrs[yn] = Number(g.toFixed(2));
      }
      out.push(rec);
    }
  }

  // Таблица 1: по стратегиям — кол-во бумаг, где gross>0 в каждом году
  const agg = new Map();
  for (const r of out) { if (!agg.has(r.strat)) agg.set(r.strat, { family: r.family, pos: { 2023: 0, 2024: 0, 2025: 0, 2026: 0 }, tot: 0 }); const a = agg.get(r.strat); a.tot++; for (const y of ['2023', '2024', '2025', '2026']) if (r.yrs[y] != null && r.yrs[y] > 0) a.pos[y]++; }
  console.log('\n=== Стратегия: сколько бумаг в плюсе по годам (из N) ===');
  const list = [...agg.entries()].sort((a, b) => (b[1].pos['2023'] + b[1].pos['2024'] + b[1].pos['2025'] + b[1].pos['2026']) - (a[1].pos['2023'] + a[1].pos['2024'] + a[1].pos['2025'] + a[1].pos['2026']));
  for (const [strat, a] of list) {
    console.log(` ${String(strat).padEnd(22)} | бум=${String(a.tot).padEnd(3)} | 23:${String(a.pos['2023']).padEnd(3)} 24:${String(a.pos['2024']).padEnd(3)} 25:${String(a.pos['2025']).padEnd(3)} 26:${String(a.pos['2026']).padEnd(3)}`);
  }

  // Таблица 2: по бумагам — стратегия в плюсе хотя бы в скольких годах
  console.log('\n=== По-бумажно: число стратегий (из семейства) в плюсе по годам ===');
  const paperAgg = new Map();
  for (const r of out) { const [sec, tf] = r.paper.split('|'); if (Number(tf) === 5) continue; // сводим к одной строке на бумагу — используем tf6
    if (!paperAgg.has(sec)) paperAgg.set(sec, { pos: { 2023: 0, 2024: 0, 2025: 0, 2026: 0 }, tot: 0, always: 0 }); const a = paperAgg.get(sec); a.tot++; let all = true; for (const y of ['2023', '2024', '2025', '2026']) { if (r.yrs[y] != null && r.yrs[y] > 0) a.pos[y]++; else all = false; } if (all) a.always++; }
  for (const [sec, a] of paperAgg) {
    console.log(` sec=${String(sec).padEnd(4)} | 23:${String(a.pos['2023']).padEnd(3)} 24:${String(a.pos['2024']).padEnd(3)} 25:${String(a.pos['2025']).padEnd(3)} 26:${String(a.pos['2026']).padEnd(3)} | всегда(4года)=${a.always}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
