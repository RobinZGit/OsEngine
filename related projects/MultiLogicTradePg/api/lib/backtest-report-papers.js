'use strict';

/**
 * Server-side mirror of the per-paper blocks (#848) from
 * web/src/app/logics/backtest-report.ts — graph SVG, indicators, trades,
 * FIFO closes table — for archive persistence (PostgreSQL).
 */

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtMoney(v) {
  return Number(v).toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtNum(v, digits = 2) {
  if (!Number.isFinite(v)) return '—';
  return Number(v).toLocaleString('ru-RU', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** FIFO-раскладка продаж по покупкам (и cover по шортам) для отчёта. */
function buildPaperReportCloseRows(trades, tradeLots) {
  const reportFilled = (t) =>
    (t.status === 'filled' || t.status === 'submitted') &&
    !t.is_shadow &&
    !t.opt_lane;
  const byTime = (a, b) =>
    String(a.bar_dt || a.executed_at).localeCompare(String(b.bar_dt || b.executed_at));

  const opens = trades
    .filter((t) => reportFilled(t) && t.side_name === 'Open' && Number(t.quantity) > 0)
    .sort(byTime);
  const closes = trades
    .filter(
      (t) =>
        reportFilled(t) &&
        t.side_name === 'Close' &&
        t.financial_result != null &&
        Number.isFinite(Number(t.financial_result))
    )
    .sort(byTime);

  const queueKey = (t) => `${t.security_id}:${t.action_name}`;
  const openQueue = new Map();
  const openById = new Map();
  for (const o of opens) {
    const item = { row: o, rem: Number(o.quantity) };
    openById.set(Number(o.id), item);
    const k = queueKey(o);
    const q = openQueue.get(k);
    if (q) q.push(item);
    else openQueue.set(k, [item]);
  }

  const out = [];
  for (const t of closes) {
    const lots = tradeLots?.get(Number(t.id)) ?? [];
    let sources = [];
    const closeQty = Number(t.quantity) || 1;
    const pnlTotal = Number(t.financial_result);

    if (lots.length > 0) {
      sources = lots.map((l) => {
        const oid = Number(l.open_trade_id);
        const o = openById.get(oid);
        return {
          openTradeId: Number.isInteger(oid) && oid > 0 ? oid : null,
          openDt:
            l.open_bar_dt ||
            l.open_executed_at ||
            (o?.row ? o.row.bar_dt || o.row.executed_at : null) ||
            null,
          openPrice:
            l.open_price != null
              ? Number(l.open_price)
              : o?.row && Number(o.row.price) > 0
                ? Number(o.row.price)
                : null,
          quantity: Number(l.quantity),
          pnl: Number(l.financial_result),
          estimated: false,
        };
      });
      for (const l of lots) {
        const oid = Number(l.open_trade_id);
        const item = openById.get(oid);
        if (item && item.rem > 1e-9) {
          item.rem = Math.max(0, item.rem - Number(l.quantity));
        }
      }
    } else {
      const q = openQueue.get(queueKey(t)) ?? [];
      let need = closeQty;
      const matched = [];
      for (let i = 0; i < q.length && need > 1e-9; i++) {
        const item = q[i];
        const take = Math.min(item.rem, need);
        if (take > 1e-9) matched.push({ row: item.row, qty: take });
        item.rem -= take;
        need -= take;
      }
      if (matched.length > 0) {
        const matchedQty = matched.reduce((s, m) => s + m.qty, 0) || closeQty;
        sources = matched.map((m) => ({
          openTradeId: Number(m.row.id) || null,
          openDt: m.row.bar_dt || m.row.executed_at,
          openPrice: Number(m.row.price) > 0 ? Number(m.row.price) : null,
          quantity: m.qty,
          pnl: pnlTotal * (m.qty / matchedQty),
          estimated: true,
        }));
      } else {
        // Закрытие без найденного открытия (остаток с предыдущих периодов).
        sources = [
          {
            openTradeId: null,
            openDt: null,
            openPrice: null,
            quantity: closeQty,
            pnl: pnlTotal,
            estimated: false,
          },
        ];
      }
    }

    out.push({
      closeTradeId: Number(t.id),
      side: t.action_name === 'Short' ? 'Short' : 'Long',
      closeDt: t.bar_dt || t.executed_at,
      closePrice: Number(t.price),
      quantity: closeQty,
      totalPnl: pnlTotal,
      commission: num(t.commission),
      isShadow: !!t.is_shadow,
      sources,
    });
  }
  return out;
}

const PAPER_SERIES_COLORS = [
  '#2563eb',
  '#9333ea',
  '#ea580c',
  '#0891b2',
  '#ca8a04',
  '#db2777',
  '#059669',
  '#4f46e5',
];

const PAPER_PRICE_SCALE_CODES = new Set(['SMA', 'EMA', 'WMA', 'PACC', 'SMAT3']);

/** Серии индикаторов для графика бумаги (то же деление price-scale/osc, что на графике бумаги). */
function buildPaperIndicatorSeries(values) {
  const groups = new Map();
  for (const v of values || []) {
    const key = `${v.indicator_id}:${v.line_code}`;
    const list = groups.get(key) ?? [];
    list.push(v);
    groups.set(key, list);
  }
  const series = [];
  let colorIdx = 0;
  for (const rows of groups.values()) {
    const sample = rows[0];
    if (!sample) continue;
    const onPrice =
      (PAPER_PRICE_SCALE_CODES.has(sample.indicator_code) && sample.line_code === 'VALUE') ||
      ['UPPER', 'MIDDLE', 'LOWER'].includes(sample.line_code);
    series.push({
      indicator_code: sample.indicator_code,
      line_code: sample.line_code,
      line_name: sample.line_name,
      color: PAPER_SERIES_COLORS[colorIdx % PAPER_SERIES_COLORS.length],
      on_price_scale: onPrice,
      is_threshold: !!sample.is_threshold,
      points: rows.map((r) => ({ dt: r.dt, value: Number(r.value) })),
    });
    if (!sample.is_threshold) colorIdx += 1;
  }
  return series;
}

function paperDtMs(raw) {
  if (!raw) return null;
  const t = Date.parse(String(raw).replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
}

function round4(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 1e4) / 1e4 : 0;
}

function round6(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : null;
}

/** Компактные данные графика бумаги для интерактивного рендерера отчёта (зум/пана). */
function paperChartJson(chart) {
  const candles = (chart.candles || [])
    .map((c) => {
      const t = paperDtMs(c.dt);
      if (t == null) return null;
      return [
        t,
        round4(c.open_price),
        round4(c.high_price),
        round4(c.low_price),
        round4(c.close_price),
      ];
    })
    .filter(Boolean);
  const indicators = (chart.indicators || []).map((s) => ({
    code: s.indicator_code || '',
    line: s.line_code || '',
    name: s.line_name || '',
    color: s.color || '#2563eb',
    on: !!s.on_price_scale,
    thr: !!s.is_threshold,
    pts: (s.points || [])
      .map((p) => {
        const t = paperDtMs(p.dt);
        const v = round6(p.value);
        if (t == null || v == null) return null;
        return [t, v];
      })
      .filter(Boolean),
  }));
  const markers = (chart.markers || [])
    .map((m) => {
      const t = paperDtMs(m.dt);
      if (t == null || !Number.isFinite(Number(m.price))) return null;
      return [
        t,
        m.kind === 'open' ? 'open' : 'close',
        round6(m.price),
        m.side === 'short' ? 'short' : 'long',
        !!m.isShadow ? 1 : 0,
      ];
    })
    .filter(Boolean);
  const stops = (chart.stops || [])
    .map((m) => {
      const t = paperDtMs(m.dt);
      if (t == null || !Number.isFinite(Number(m.price))) return null;
      return [t, round6(m.price), m.ruleKind === 'take_profit' ? 'TP' : 'SL', m.label || ''];
    })
    .filter(Boolean);
  const shaded = (chart.shaded || [])
    .map((r) => {
      const a = paperDtMs(r.startDt);
      const b = paperDtMs(r.endDt);
      if (a == null || b == null) return null;
      return [a, b, r.kind || 'normal', r.label || ''];
    })
    .filter(Boolean);
  const pt = (list) =>
    (list || [])
      .map((p) => {
        const t = paperDtMs(p.dt);
        const v = round6(p.value);
        if (t == null || v == null) return null;
        return [t, v];
      })
      .filter(Boolean);
  return JSON.stringify({
    c: candles,
    ind: indicators,
    mk: markers,
    st: stops,
    sh: shaded,
    eq: pt(chart.equity),
    esh: pt(chart.equityShadow),
  })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function fmtAxisNum(v) {
  if (Math.abs(v) >= 1000) return fmtNum(v, 0);
  if (Math.abs(v) >= 100) return fmtNum(v, 1);
  return fmtNum(v, 2);
}

function fmtAxisDt(ms) {
  return new Date(ms).toLocaleString('ru-RU', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function paperChartGeometry(hasOsc) {
  const padL = 58;
  const padR = 20;
  const padT = 8;
  const gap = 8;
  const priceH = 300;
  const oscH = hasOsc ? 110 : 0;
  const pnlH = 126;
  const priceTop = padT;
  const priceBottom = priceTop + priceH;
  const oscTop = priceBottom + gap;
  const oscBottom = oscTop + oscH;
  const pnlTop = oscH > 0 ? oscBottom + gap : priceBottom + gap;
  const pnlBottom = pnlTop + pnlH;
  const h = pnlBottom + 16;
  return {
    w: 960,
    h,
    padL,
    padR,
    priceTop,
    priceH,
    priceBottom,
    oscTop,
    oscH,
    oscBottom,
    pnlTop,
    pnlH,
    pnlBottom,
    hasOsc,
  };
}

function paperTimeDomain(chart) {
  const ms = [];
  const push = (raw) => {
    const t = paperDtMs(raw);
    if (t != null) ms.push(t);
  };
  for (const c of chart.candles || []) push(c.dt);
  for (const m of chart.markers || []) push(m.dt);
  for (const s of chart.stops || []) push(s.dt);
  for (const r of chart.shaded || []) {
    push(r.startDt);
    push(r.endDt);
  }
  for (const p of chart.equity || []) push(p.dt);
  for (const t of chart.trades || []) push(t.bar_dt || t.executed_at);
  if (ms.length === 0) return { t0: 0, t1: 1 };
  let t0 = Math.min(...ms);
  let t1 = Math.max(...ms);
  if (t1 <= t0) t1 = t0 + 24 * 60 * 60 * 1000;
  return { t0, t1 };
}

function paperValueRange(values) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return { min: 0, max: 1 };
  let min = Math.min(...finite);
  let max = Math.max(...finite);
  if (max === min) {
    max += 1;
    min -= 1;
  }
  const pad = (max - min) * 0.06;
  return { min: min - pad, max: max + pad };
}

function paperPriceRange(chart) {
  const v = [];
  for (const c of chart.candles || []) {
    v.push(Number(c.low_price), Number(c.high_price), Number(c.open_price), Number(c.close_price));
  }
  for (const s of chart.indicators || []) {
    if (!s.on_price_scale) continue;
    for (const p of s.points) v.push(Number(p.value));
  }
  for (const m of chart.markers || []) v.push(Number(m.price));
  for (const s of chart.stops || []) v.push(Number(s.price));
  return paperValueRange(v);
}

function paperOscRange(chart) {
  const v = [];
  for (const s of chart.indicators || []) {
    if (s.on_price_scale) continue;
    for (const p of s.points) v.push(Number(p.value));
  }
  return paperValueRange(v);
}

function paperPnlRange(chart) {
  const v = [0];
  for (const p of chart.equity || []) v.push(p.value);
  for (const p of chart.equityShadow || []) v.push(p.value);
  return paperValueRange(v);
}

function shadeColors(kind) {
  switch (kind) {
    case 'inverted':
      return { fill: 'rgba(251, 207, 232, 0.45)', stroke: 'rgba(244, 114, 182, 0.4)', label: '#9d1b4d' };
    case 'long':
      return { fill: 'rgba(134, 239, 172, 0.28)', stroke: 'rgba(74, 222, 128, 0.3)', label: '#15803d' };
    case 'short':
      return { fill: 'rgba(252, 165, 165, 0.28)', stroke: 'rgba(248, 113, 113, 0.3)', label: '#b91c1c' };
    case 'shadow':
    case 'paused':
      return { fill: 'rgba(203, 213, 225, 0.55)', stroke: 'rgba(148, 163, 184, 0.55)', label: '#334155' };
    default:
      return { fill: 'rgba(187, 247, 208, 0.4)', stroke: 'rgba(74, 222, 128, 0.4)', label: '#15803d' };
  }
}

/** Полосы режима бумаги в вертикальной полосе (цена / эквити). */
function paperShadeRects(chart, xOf, top, height, t0, t1, padL, padR, w) {
  const out = [];
  for (const r of chart.shaded || []) {
    const a = paperDtMs(r.startDt);
    const b = paperDtMs(r.endDt);
    if (a == null || b == null) continue;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (hi < t0 || lo > t1) continue;
    const x0 = xOf(Math.max(lo, t0));
    const x1 = xOf(Math.min(hi, t1));
    const c = shadeColors(r.kind);
    const width = Math.max(2, x1 - x0);
    out.push(`<rect x="${x0.toFixed(1)}" y="${top}" width="${width.toFixed(1)}" height="${height}" fill="${c.fill}"/>`);
    out.push(`<rect x="${x0.toFixed(1)}" y="${top}" width="${width.toFixed(1)}" height="${height}" fill="none" stroke="${c.stroke}" stroke-dasharray="3 3"/>`);
    if (r.label) {
      const lx = Math.min(x0 + 4, w - padR - 120);
      out.push(`<text x="${lx.toFixed(1)}" y="${(top + 13).toFixed(1)}" font-size="10" font-weight="600" fill="${c.label}">${esc(r.label)}</text>`);
    }
  }
  return out.join('');
}

/** Горизонтальная сетка с подписями значений. */
function paperGrid(range, yOf, top, bottom, padL, padR, w, formatter) {
  const out = [];
  const n = 5;
  for (let i = 0; i < n; i++) {
    const v = range.min + ((range.max - range.min) * i) / (n - 1);
    const y = yOf(v);
    if (y < top || y > bottom) continue;
    if (!Number.isFinite(v)) continue;
    out.push(`<line x1="${padL}" y1="${y.toFixed(1)}" x2="${w - padR}" y2="${y.toFixed(1)}" stroke="#e2e8f0"/>`);
    out.push(`<text x="${(padL - 6).toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="#64748b">${formatter(v)}</text>`);
  }
  return out.join('');
}

function paperXAxis(t0, t1, xOf, y, padL, padR, w) {
  const out = [];
  const n = 5;
  for (let i = 0; i < n; i++) {
    const t = t0 + ((t1 - t0) * i) / (n - 1);
    const x = xOf(t);
    out.push(`<text x="${x.toFixed(1)}" y="${y}" text-anchor="middle" font-size="10" fill="#64748b">${esc(fmtAxisDt(t))}</text>`);
  }
  return out.join('');
}

function paperCandleBody(chart, xOf, yOf, padL, padR, w, priceTop, priceBottom) {
  const candles = chart.candles || [];
  if (candles.length === 0) {
    return `<text x="${(padL + (w - padL - padR) / 2).toFixed(1)}" y="${((priceTop + priceBottom) / 2).toFixed(1)}" text-anchor="middle" font-size="12" fill="#94a3b8">Нет цен для графика</text>`;
  }
  const stepX = (w - padL - padR) / Math.max(1, candles.length - 1);
  const bw = Math.max(1.6, stepX * 0.62);
  const out = [];
  for (const c of candles) {
    const x = xOf(paperDtMs(c.dt) ?? 0);
    const hi = yOf(Number(c.high_price));
    const lo = yOf(Number(c.low_price));
    const o = yOf(Number(c.open_price));
    const cl = yOf(Number(c.close_price));
    const up = Number(c.close_price) >= Number(c.open_price);
    const color = up ? '#16a34a' : '#dc2626';
    const bodyTop = Math.min(o, cl);
    const bodyH = Math.max(Math.abs(o - cl), 1);
    out.push(`<line x1="${x.toFixed(1)}" y1="${hi.toFixed(1)}" x2="${x.toFixed(1)}" y2="${lo.toFixed(1)}" stroke="${color}"/>`);
    out.push(`<rect x="${(x - bw / 2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${bw.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${color}"/>`);
  }
  return out.join('');
}

function paperLineBody(chart, xOf, yOf, padL, padR, w, priceTop, priceBottom) {
  const candles = chart.candles || [];
  if (candles.length === 0) {
    return `<text x="${(padL + (w - padL - padR) / 2).toFixed(1)}" y="${((priceTop + priceBottom) / 2).toFixed(1)}" text-anchor="middle" font-size="12" fill="#94a3b8">Нет цен для графика</text>`;
  }
  const pts = candles
    .map((c) => {
      const t = paperDtMs(c.dt);
      const v = Number(c.close_price);
      if (t == null || !Number.isFinite(v)) return null;
      return `${xOf(t).toFixed(1)},${yOf(v).toFixed(1)}`;
    })
    .filter((p) => p != null);
  if (pts.length < 2) return '';
  return `<polyline fill="none" stroke="#0f172a" stroke-width="1.6" points="${pts.join(' ')}"/>`;
}

function paperIndicatorLines(chart, xOf, yOf, onPrice) {
  const out = [];
  for (const s of chart.indicators || []) {
    if (s.on_price_scale !== onPrice) continue;
    const pts = s.points
      .map((p) => {
        const t = paperDtMs(p.dt);
        if (t == null || !Number.isFinite(p.value)) return null;
        return `${xOf(t).toFixed(1)},${yOf(Number(p.value)).toFixed(1)}`;
      })
      .filter((p) => p != null);
    if (pts.length < 2) continue;
    const dash = s.is_threshold ? ' stroke-dasharray="4 4"' : '';
    out.push(`<polyline fill="none" stroke="${s.color}" stroke-width="${s.is_threshold ? 1 : 1.5}"${dash} points="${pts.join(' ')}"/>`);
  }
  return out.join('');
}

function paperTradeMarkers(chart, xOf, yOf, priceTop, priceBottom) {
  const out = [];
  for (const m of chart.markers || []) {
    const t = paperDtMs(m.dt);
    if (t == null || !Number.isFinite(m.price)) continue;
    const x = xOf(t);
    const y = yOf(Number(m.price));
    const isOpen = m.kind === 'open';
    const isLong = m.side === 'long';
    const color = m.isShadow
      ? '#94a3b8'
      : isOpen
        ? isLong
          ? '#16a34a'
          : '#dc2626'
        : isLong
          ? '#15803d'
          : '#b91c1c';
    out.push(`<line x1="${x.toFixed(1)}" y1="${priceTop}" x2="${x.toFixed(1)}" y2="${priceBottom}" stroke="${color}" stroke-opacity="${m.isShadow ? 0.16 : 0.28}" stroke-width="2"/>`);
    const size = 9;
    const flap = Math.round(size * 0.78);
    const base = Math.round(size * 0.66);
    const points = isOpen
      ? `${x},${y - size} ${x - flap},${y + base} ${x + flap},${y + base}`
      : `${x},${y + size} ${x - flap},${y - base} ${x + flap},${y - base}`;
    out.push(`<polygon points="${points}" fill="${color}" stroke="#0f172a" stroke-width="0.8" stroke-opacity="${m.isShadow ? 0.6 : 1}"/>`);
  }
  return out.join('');
}

function paperStopMarkers(chart, xOf, yOf, padL, padR, w, priceTop, priceBottom) {
  const out = [];
  for (const m of chart.stops || []) {
    const t = paperDtMs(m.dt);
    if (t == null || !Number.isFinite(m.price)) continue;
    const x = xOf(t);
    const y = yOf(Number(m.price));
    const color = m.ruleKind === 'take_profit' ? '#059669' : '#dc2626';
    const tag = m.ruleKind === 'take_profit' ? 'TP' : 'SL';
    out.push(`<line x1="${x.toFixed(1)}" y1="${priceTop}" x2="${x.toFixed(1)}" y2="${priceBottom}" stroke="${color}" stroke-opacity="0.35" stroke-width="2"/>`);
    out.push(`<line x1="${padL}" y1="${y.toFixed(1)}" x2="${w - padR}" y2="${y.toFixed(1)}" stroke="${color}" stroke-width="1.5" stroke-dasharray="5 3"/>`);
    const label = `${tag} ${m.label || ''}`.trim();
    const ly = Math.max(priceTop + 10, y - 4).toFixed(1);
    out.push(`<text x="${(x + 4).toFixed(1)}" y="${ly}" font-size="10" font-weight="600" fill="${color}">${esc(label)}</text>`);
  }
  return out.join('');
}

function paperOscPanel(chart, xOf, yOf, w, g) {
  if (!g.hasOsc) return '';
  const out = [];
  out.push(`<rect x="${g.padL}" y="${g.oscTop}" width="${w - g.padL - g.padR}" height="${g.oscH}" fill="#fbfbfe"/>`);
  const oscRange = paperOscRange(chart);
  out.push(paperGrid(oscRange, yOf, g.oscTop, g.oscBottom, g.padL, g.padR, w, (v) => fmtAxisNum(v)));
  const zeroY = yOf(0);
  if (zeroY >= g.oscTop && zeroY <= g.oscBottom) {
    out.push(`<line x1="${g.padL}" y1="${zeroY.toFixed(1)}" x2="${w - g.padR}" y2="${zeroY.toFixed(1)}" stroke="#cbd5e1" stroke-dasharray="4 4"/>`);
  }
  out.push(paperIndicatorLines(chart, xOf, yOf, false));
  out.push(`<text x="${(g.padL + 4).toFixed(1)}" y="${(g.oscTop + 14).toFixed(1)}" font-size="10" font-weight="700" fill="#6b7280">OSC</text>`);
  return out.join('');
}

function paperPnlPanel(chart, xOf, yOf, w, g, t0, t1) {
  const out = [];
  out.push(`<rect x="${g.padL}" y="${g.pnlTop}" width="${w - g.padL - g.padR}" height="${g.pnlH}" fill="#f5f3ff"/>`);
  out.push(`<line x1="${g.padL}" y1="${g.pnlTop + 0.5}" x2="${w - g.padR}" y2="${g.pnlTop + 0.5}" stroke="#ddd6fe"/>`);
  out.push(paperShadeRects(chart, xOf, g.pnlTop, g.pnlH, t0, t1, g.padL, g.padR, w));
  const zeroY = yOf(0);
  if (zeroY >= g.pnlTop && zeroY <= g.pnlBottom) {
    out.push(`<line x1="${g.padL}" y1="${zeroY.toFixed(1)}" x2="${w - g.padR}" y2="${zeroY.toFixed(1)}" stroke="#c4b5fd" stroke-dasharray="4 4"/>`);
  }
  const pnl = paperPnlRange(chart);
  const line = (pts, stroke, width, dash) => {
    if (!Array.isArray(pts) || pts.length < 2) return '';
    const coords = pts
      .map((p) => {
        const t = paperDtMs(p.dt);
        if (t == null || !Number.isFinite(p.value)) return null;
        return `${xOf(t).toFixed(1)},${yOf(p.value).toFixed(1)}`;
      })
      .filter((p) => p != null);
    if (coords.length < 2) return '';
    return `<polyline fill="none" stroke="${stroke}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''} points="${coords.join(' ')}"/>`;
  };
  // Теневая эквити — под основной (пунктир).
  out.push(line(chart.equityShadow, '#a78bfa', 2, '5 3'));
  // Эквити бумаги — жирная линия (требование #848).
  out.push(line(chart.equity, '#7c3aed', 3, ''));
  out.push(`<text x="${(g.padL + 4).toFixed(1)}" y="${(g.pnlTop + 13).toFixed(1)}" font-size="10" font-weight="700" fill="#7c3aed">PnL</text>`);
  const last = chart.equity && chart.equity[chart.equity.length - 1];
  if (last && Number.isFinite(last.value)) {
    out.push(`<text x="${(w - g.padR - 2).toFixed(1)}" y="${(g.pnlTop + 13).toFixed(1)}" text-anchor="end" font-size="10" font-weight="600" fill="#6d28d9">${fmtMoney(last.value)}</text>`);
  }
  // Подписи шкалы PnL (мин/макс слева).
  out.push(`<text x="${(g.padL - 6).toFixed(1)}" y="${(g.pnlTop + 10).toFixed(1)}" text-anchor="end" font-size="9" fill="#6d28d9">${fmtMoney(pnl.max)}</text>`);
  out.push(`<text x="${(g.padL - 6).toFixed(1)}" y="${(g.pnlBottom - 4).toFixed(1)}" text-anchor="end" font-size="9" fill="#6d28d9">${fmtMoney(pnl.min)}</text>`);
  return out.join('');
}

/** SVG-варианты ценового графика бумаги: свечи и линия (общая цена и ось времени). */
function paperChartSvgPair(chart) {
  const hasOsc = (chart.indicators || []).some((s) => !s.on_price_scale);
  const g = paperChartGeometry(hasOsc);
  const { t0, t1 } = paperTimeDomain(chart);
  const price = paperPriceRange(chart);
  const pnl = paperPnlRange(chart);
  const plotW = g.w - g.padL - g.padR;
  const xOf = (t) => (t1 > t0 ? g.padL + ((t - t0) / (t1 - t0)) * plotW : g.padL + plotW / 2);
  const priceYOf = (v) => g.priceTop + ((price.max - v) / (price.max - price.min)) * g.priceH;
  const oscYOf = (v) => {
    const r = paperOscRange(chart);
    return g.oscTop + ((r.max - v) / (r.max - r.min || 1)) * g.oscH;
  };
  const pnlYOf = (v) => g.pnlTop + ((pnl.max - v) / (pnl.max - pnl.min || 1)) * g.pnlH;

  // Общие слои как строки; тело цены вставляется через sentinel <!--BODY-->.
  const shared = () => {
    const out = [];
    out.push(`<rect x="${g.padL}" y="${g.priceTop}" width="${plotW}" height="${g.priceH}" fill="#f8fafc"/>`);
    out.push(paperGrid(price, priceYOf, g.priceTop, g.priceBottom, g.padL, g.padR, g.w, (v) => fmtAxisNum(v)));
    out.push(paperShadeRects(chart, xOf, g.priceTop, g.priceH, t0, t1, g.padL, g.padR, g.w));
    out.push(`<!--BODY-->`);
    out.push(paperOscPanel(chart, xOf, oscYOf, g.w, g));
    out.push(paperPnlPanel(chart, xOf, pnlYOf, g.w, g, t0, t1));
    out.push(paperXAxis(t0, t1, xOf, g.h - 6, g.padL, g.padR, g.w));
    return out.join('');
  };
  const overlays = () => {
    const out = [];
    out.push(paperIndicatorLines(chart, xOf, priceYOf, true));
    out.push(paperTradeMarkers(chart, xOf, priceYOf, g.priceTop, g.priceBottom));
    out.push(paperStopMarkers(chart, xOf, priceYOf, g.padL, g.padR, g.w, g.priceTop, g.priceBottom));
    return out.join('');
  };

  const candle = paperCandleBody(chart, xOf, priceYOf, g.padL, g.padR, g.w, g.priceTop, g.priceBottom);
  const line = paperLineBody(chart, xOf, priceYOf, g.padL, g.padR, g.w, g.priceTop, g.priceBottom);
  const parts = shared().split('<!--BODY-->');
  const render = (body) => `<svg viewBox="0 0 ${g.w} ${g.h}" width="100%" height="auto" role="img" class="paper-svg">
${parts[0]}${body}${parts[1]}
${overlays()}
</svg>`;

  return { candle: render(candle), line: render(line) };
}

/** Легенда графика бумаги (цвета индикаторов + эквити). */
function paperChartLegend(chart) {
  const items = [];
  for (const s of chart.indicators || []) {
    const name = `${s.indicator_code}${
      s.line_code && s.line_code !== 'VALUE' ? '/' + s.line_code : ''
    } ${s.line_name || ''}`.trim();
    const swatch = s.is_threshold
      ? `<span class="pl-swatch thr" style="background-image:repeating-linear-gradient(90deg,${s.color} 0 4px,transparent 4px 8px)"></span>`
      : `<span class="pl-swatch" style="background:${s.color}"></span>`;
    items.push(`${swatch}<span>${esc(name)}</span>`);
  }
  if (Array.isArray(chart.equity) && chart.equity.length >= 2) {
    items.push(`<span class="pl-swatch" style="background:#7c3aed"></span><span>Эквити бумаги</span>`);
  }
  if (Array.isArray(chart.equityShadow) && chart.equityShadow.length >= 2) {
    items.push(`<span class="pl-swatch thr" style="background-image:repeating-linear-gradient(90deg,#a78bfa 0 4px,transparent 4px 8px)"></span><span>Эквити shadow</span>`);
  }
  if (items.length === 0) return '';
  return `<div class="pchart-legend">${items.join('<span class="pl-sep"></span>')}</div>`;
}

function paperFifoRows(closes) {
  if (closes.length === 0) {
    return `<tr><td colspan="5" class="muted">Нет закрытых сделок</td></tr>`;
  }
  const out = [];
  for (const c of closes) {
    const op = c.side === 'Long' ? 'Продажа' : 'Закрытие шорта';
    const pnlCls = c.totalPnl >= 0 ? 'pos' : 'neg';
    out.push(`<tr class="pf-close">
      <td>${esc(String(c.closeDt).slice(0, 19).replace('T', ' '))}</td>
      <td>${esc(op)}</td>
      <td class="num">${esc(fmtAxisNum(c.closePrice))}</td>
      <td class="num">${esc(fmtNum(c.quantity, 0))}</td>
      <td class="num ${pnlCls}">${esc(fmtMoney(c.totalPnl))}</td>
    </tr>`);
    if (c.sources.length === 0) {
      out.push(`<tr class="pf-src"><td colspan="5">—</td></tr>`);
    }
    for (const s of c.sources) {
      const src = s.estimated ? '~ из' : 'из';
      const when = s.openDt ? ` · ${String(s.openDt).slice(0, 19).replace('T', ' ')}` : '';
      const px = s.openPrice != null ? ` · цена ${fmtAxisNum(s.openPrice)}` : '';
      const idBit = s.openTradeId != null ? `№${s.openTradeId}` : 'внешний остаток';
      const spnl = s.estimated ? `~${fmtMoney(s.pnl)}` : fmtMoney(s.pnl);
      const spnlCls = s.pnl >= 0 ? 'pos' : 'neg';
      out.push(`<tr class="pf-src">
        <td colspan="2"><span class="pf-arrow">↳ </span>${src} ${esc(idBit)}${esc(when)}${esc(px)}</td>
        <td class="num">—</td>
        <td class="num">${esc(fmtNum(s.quantity, 0))}</td>
        <td class="num ${spnlCls}">${esc(spnl)}</td>
      </tr>`);
    }
  }
  return out.join('');
}

/** HTML-блок одной бумаги: header со сводкой, график (свечи/линия), FIFO-таблица. */
function paperChartBlockHtml(chart, index) {
  const prefix = chart.securityPrefix && chart.securityPrefix.trim()
    ? chart.securityPrefix.trim()
    : chart.securityName;
  const nameId = `${prefix}${chart.securityName !== prefix ? ' ' + chart.securityName : ''} (${chart.securityId})`;
  const pnlCls = chart.pnl >= 0 ? 'pos' : 'neg';
  const hasData =
    (chart.candles && chart.candles.length > 0) ||
    (chart.markers && chart.markers.length > 0) ||
    (Array.isArray(chart.equity) && chart.equity.length >= 2) ||
    (Array.isArray(chart.trades) && chart.trades.length > 0);
  const tintf = chart.timeframeLabel ? ` · ${esc(chart.timeframeLabel)}` : '';
  const metaBits = [
    `сделок: ${chart.dealCount}`,
    `открыто: ${chart.openQty > 0 ? '+' : ''}${chart.openQty}`,
    `П/У: <span class="${pnlCls}">${fmtMoney(chart.pnl)}</span>`,
  ];
  if (chart.lastPrice != null) metaBits.push(`цена: ${fmtAxisNum(chart.lastPrice)}`);
  const hasTrades = Array.isArray(chart.markers) && chart.markers.length > 0;
  const json = paperChartJson(chart);
  const tradeNav = hasTrades
    ? `<span class="pchart-sep"></span><span class="pchart-group">
        <button type="button" class="pp-btn pp-btn-trade" data-pp="tp" onclick="ppc(${index},'tp')" title="Предыдущая сделка (открытие или закрытие)">⟸сд.</button>
        <button type="button" class="pp-btn pp-btn-trade" data-pp="tn" onclick="ppc(${index},'tn')" title="Следующая сделка (открытие или закрытие)">сд.⟹</button>
      </span>`
    : '';
  const body = hasData
    ? `<div class="pp-fs-host" id="ppfs-${index}">
      <div class="pchart-toolbar no-print" role="toolbar" aria-label="Управление графиком">
        <span class="pchart-group" title="Вид графика цены">
          <button type="button" class="pp-btn pp-btn-mode" data-pp="mode1" onclick="ppc(${index},'mode1')" title="Свечной график">▮▮</button>
          <button type="button" class="pp-btn pp-btn-mode" data-pp="mode0" onclick="ppc(${index},'mode0')" title="Линейный график (цены закрытия)">∿</button>
        </span>
        <span class="pchart-sep"></span>
        <span class="pchart-group">
          <button type="button" class="pp-btn" data-pp="zo" onclick="ppc(${index},'zo')" title="Уменьшить масштаб">−</button>
          <button type="button" class="pp-btn" data-pp="zi" onclick="ppc(${index},'zi')" title="Увеличить масштаб">+</button>
          <button type="button" class="pp-btn" data-pp="pl" onclick="ppc(${index},'pl')" title="Сдвинуть назад">◀</button>
          <button type="button" class="pp-btn" data-pp="pr" onclick="ppc(${index},'pr')" title="Сдвинуть вперёд">▶</button>
        </span>
        ${tradeNav}
        <span class="pchart-sep"></span>
        <span class="pchart-group">
          <button type="button" class="pp-btn" data-pp="reset" onclick="ppc(${index},'reset')" title="К исходному масштабу">↺</button>
          <button type="button" class="pp-btn" data-pp="fs" onclick="ppc(${index},'fs')" title="Полный экран">⛶</button>
          <button type="button" class="pp-btn" data-pp="fsx" onclick="ppc(${index},'fs')" title="Выйти из полного экрана" style="display:none">✕</button>
        </span>
      </div>
      <div class="chart paper-chart">
        <div class="pp-chart-plot" id="ppc-${index}"></div>
        ${paperChartLegend(chart)}
      </div>
      <p class="pp-hint no-print">Колёсико / «−» «+» — масштаб · «◀» «▶» — история · «⟸сд.сд.⟹» — сделки · «⛶» — полный экран</p>
    </div>`
    : `<p class="muted">Нет данных для графика.</p>`;
  const chartDataScript = hasData
    ? `<script type="application/json" id="ppd-${index}">${json}</script>`
    : '';

  const priceErr = chart.loadError
    ? `<p class="muted paper-hint">⚠ ${esc(chart.loadError)}</p>`
    : '';

  const fifoNote = chart.closes.some((c) => c.sources.some((s) => s.estimated))
    ? `<p class="muted paper-hint">П/У по строкам «~» распределён пропорционально объёму (FIFO-оценка, если лоты не загружены).</p>`
    : '';

  return `<details class="paper-report" open>
  <summary class="paper-head">
    <span class="paper-head-name">${esc(nameId)}<span class="paper-tf">${tintf}</span></span>
    <span class="paper-meta">${metaBits.join(' · ')}</span>
  </summary>
  <div class="paper-body">
    ${chartDataScript}
    ${body}
    ${priceErr}
    <h3>Сделки бумаги · из какой позиции закрыта (FIFO)</h3>
    <table class="deals paper-fifo">
      <thead><tr><th>Закрытие</th><th>Операция</th><th>Цена</th><th>Кол-во</th><th>П/У</th></tr></thead>
      <tbody>${paperFifoRows(chart.closes)}</tbody>
    </table>
    ${fifoNote}
  </div>
</details>`;
}

function paperChartsSectionHtml(charts) {
  const list = Array.isArray(charts) ? charts : [];
  if (list.length === 0) return '';
  const blocks = list.map((c, i) => paperChartBlockHtml(c, i)).join('\n');
  return `<section class="papers-report">
  <h2>Бумаги — графики и сделки</h2>
  ${blocks}
</section>`;
}

module.exports = {
  buildPaperReportCloseRows,
  buildPaperIndicatorSeries,
  paperChartsSectionHtml,
  paperChartJson,
  paperDtMs,
  fmtAxisNum,
  fmtMoney,
};