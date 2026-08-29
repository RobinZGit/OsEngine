'use strict';

/**
 * Interactive parts for per-paper chart blocks in the archive backtest report:
 *  - toolbar with zoom/pan/trade-nav/mode/fullscreen controls (mirrors the
 *    in-app expanded paper chart);
 *  - client-side SVG re-renderer driven by embedded JSON data.
 * No template literals / backticks inside the client script string (it is
 * emitted as-is into the report <script> block).
 */

const css = `
.pchart-toolbar { display:flex; align-items:center; flex-wrap:wrap; gap:.4rem; justify-content:flex-end; margin-bottom:.45rem; }
.pchart-group { display:inline-flex; align-items:center; gap:.3rem; }
.pchart-sep { width:1px; height:1.05rem; background:var(--line); margin:0 .05rem; }
.pp-btn { min-width:1.85rem; height:1.75rem; padding:0 .45rem; border:1px solid var(--line); border-radius:7px; background:#fff; color:#334155; font-size:.85rem; line-height:1; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; }
.pp-btn:hover { border-color:#94a3b8; background:#f8fafc; }
.pp-btn[disabled] { opacity:.45; cursor:default; }
.pp-btn.active { background:#0f766e; border-color:#0f766e; color:#fff; }
.pp-btn-mode { font-size:.8rem; }
.pp-btn-trade { font-size:.74rem; }
.pp-hint { margin:.45rem 0 0; font-size:.72rem; color:#94a3b8; }
.pp-chart-plot { width:100%; }
.pp-fs-host { position:relative; }
.pp-fs-on { position:fixed; inset:0; z-index:9999; background:#f8fafc; padding:.9rem 1rem 1.4rem; overflow:auto; display:flex; flex-direction:column; }
.pp-fs-on .pchart-toolbar { flex-shrink:0; }
.pp-fs-on .chart { flex:1 1 auto; min-height:58vh; display:flex; flex-direction:column; }
.pp-fs-on .pp-chart-plot { flex:1 1 auto; }
.pp-fs-on .paper-svg { width:100%; height:100%; }
@media print { .pp-hint { display:none !important; } }
`;

const script = `
(function () {
  'use strict';
  var DATA = window.__ppd = window.__ppd || {};
  var ST = window.__pps = window.__pps || {};
  var G = window.__ppg = window.__ppg || {};

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function fix(v, d) { return Number(v).toFixed(d); }
  function fmt(v, d) { return Number(v).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function fmtAxisNum(v) { var a = Math.abs(v); if (a >= 1000) return fmt(v, 0); if (a >= 100) return fmt(v, 1); return fmt(v, 2); }
  function fmtMoney(v) { return fmt(Math.round(Number(v) * 100) / 100, 2); }
  function fmtAxisDt(ms) { var d = new Date(ms); var p = function (x) { return (x < 10 ? '0' : '') + x; }; return p(d.getMonth() + 1) + '.' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); }

  function getData(id) {
    var d = DATA[id];
    if (d) return d;
    var el = document.getElementById('ppd-' + id);
    if (!el) return null;
    try { d = JSON.parse(el.textContent); DATA[id] = d; return d; }
    catch (e) { return null; }
  }

  function geom(d) {
    var hasOsc = false, k;
    for (k = 0; k < d.ind.length; k++) if (!d.ind[k].on) { hasOsc = true; break; }
    var hasPnl = d.eq.length >= 2 || d.esh.length >= 2;
    var w = 960, padL = 58, padR = 20, padT = 8, gap = 8, priceH = 300, oscH = hasOsc ? 110 : 0, pnlH = 126;
    var priceTop = padT, priceBottom = priceTop + priceH;
    var oscTop = priceBottom + gap, oscBottom = oscTop + oscH;
    var pnlTop = hasOsc ? oscBottom + gap : priceBottom + gap, pnlBottom = pnlTop + pnlH;
    return { w: w, padL: padL, padR: padR, plotW: w - padL - padR, priceTop: priceTop, priceH: priceH, priceBottom: priceBottom, oscTop: oscTop, oscH: oscH, oscBottom: oscBottom, pnlTop: pnlTop, pnlH: pnlH, pnlBottom: pnlBottom, h: pnlBottom + 16, hasOsc: hasOsc, hasPnl: hasPnl };
  }

  function domain(d) {
    var minT = Infinity, maxT = -Infinity;
    function push(t) { t = Number(t); if (!Number.isFinite(t)) return; if (t < minT) minT = t; if (t > maxT) maxT = t; }
    var i;
    for (i = 0; i < d.c.length; i++) push(d.c[i][0]);
    for (i = 0; i < d.mk.length; i++) push(d.mk[i][0]);
    for (i = 0; i < d.st.length; i++) push(d.st[i][0]);
    for (i = 0; i < d.sh.length; i++) { push(d.sh[i][0]); push(d.sh[i][1]); }
    for (i = 0; i < d.eq.length; i++) push(d.eq[i][0]);
    for (i = 0; i < d.esh.length; i++) push(d.esh[i][0]);
    if (!Number.isFinite(minT)) { minT = 0; maxT = 1; }
    if (maxT <= minT) maxT = minT + 86400000;
    return { t0: minT, t1: maxT };
  }

  function range(vals) {
    var minV = Infinity, maxV = -Infinity, i;
    for (i = 0; i < vals.length; i++) { var v = vals[i]; if (!Number.isFinite(v)) continue; if (v < minV) minV = v; if (v > maxV) maxV = v; }
    if (vals.length === 0 || !Number.isFinite(minV)) return { min: 0, max: 1 };
    if (maxV === minV) { maxV += 1; minV -= 1; }
    var pad = (maxV - minV) * 0.06;
    return { min: minV - pad, max: maxV + pad };
  }

  function shadeColor(k) {
    if (k === 'inverted') return { fill: 'rgba(251, 207, 232, 0.45)', stroke: 'rgba(244, 114, 182, 0.4)', label: '#9d1b4d' };
    if (k === 'long') return { fill: 'rgba(134, 239, 172, 0.28)', stroke: 'rgba(74, 222, 128, 0.3)', label: '#15803d' };
    if (k === 'short') return { fill: 'rgba(252, 165, 165, 0.28)', stroke: 'rgba(248, 113, 113, 0.3)', label: '#b91c1c' };
    if (k === 'shadow' || k === 'paused') return { fill: 'rgba(203, 213, 225, 0.55)', stroke: 'rgba(148, 163, 184, 0.55)', label: '#334155' };
    return { fill: 'rgba(187, 247, 208, 0.4)', stroke: 'rgba(74, 222, 128, 0.4)', label: '#15803d' };
  }

  function ensure(id, d) {
    if (!ST[id]) {
      var n = d.c.length;
      var cw0 = Math.min(7, 882 / Math.max(1, n));
      ST[id] = { cw: null, cw0: cw0, viewStart: 0, mode: 1 };
    }
    var st = ST[id];
    if (st.cw0 == null || st.cw0 <= 0) st.cw0 = Math.min(7, 882 / Math.max(1, d.c.length));
    return st;
  }

  function win(id, d) {
    var st = ensure(id, d);
    var n = d.c.length;
    if (n === 0) { var dm = domain(d); return { start: 0, count: 0, t0: dm.t0, t1: dm.t1, cw: 7, maxStart: 0, cw0: st.cw0 }; }
    var cw0 = st.cw0;
    var raw = st.cw == null ? cw0 : st.cw;
    if (raw > 24) raw = 24;
    if (raw < 0.6) raw = 0.6;
    var count = Math.min(n, Math.max(2, Math.floor(882 / raw)));
    var maxStart = n - count;
    var start = Math.max(0, Math.min(st.viewStart || 0, maxStart));
    var cw = 882 / count;
    var t0 = d.c[start][0], t1 = d.c[start + count - 1][0];
    return { start: start, count: count, cw: cw, cw0: cw0, t0: t0, t1: t1, maxStart: maxStart, n: n };
  }

  function xOf(g, t, wd) { return g.padL + ((t - wd.t0) / (wd.t1 - wd.t0 || 1)) * g.plotW; }
  function yPrice(g, v, r) { return g.priceTop + ((r.max - v) / (r.max - r.min || 1)) * g.priceH; }
  function yOsc(g, v, r) { return g.oscTop + ((r.max - v) / (r.max - r.min || 1)) * g.oscH; }
  function yPnl(g, v, r) { return g.pnlTop + ((r.max - v) / (r.max - r.min || 1)) * g.pnlH; }

  function ranges(d, wd) {
    var i, k, pv = [], ov = [], ev = [0];
    for (i = 0; i < wd.count; i++) { var c = d.c[wd.start + i]; pv.push(c[1], c[2], c[3], c[4]); }
    for (k = 0; k < d.ind.length; k++) {
      var ind = d.ind[k], pts = ind.pts;
      for (i = 0; i < pts.length; i++) {
        var P = pts[i];
        if (P[0] < wd.t0 || P[0] > wd.t1) continue;
        if (ind.on) pv.push(P[1]); else ov.push(P[1]);
      }
    }
    for (i = 0; i < d.mk.length; i++) { var m = d.mk[i]; if (m[0] >= wd.t0 && m[0] <= wd.t1) pv.push(m[2]); }
    for (i = 0; i < d.st.length; i++) { var s1 = d.st[i]; if (s1[0] >= wd.t0 && s1[0] <= wd.t1) pv.push(s1[1]); }
    for (i = 0; i < d.eq.length; i++) { var E = d.eq[i]; if (E[0] >= wd.t0 && E[0] <= wd.t1) ev.push(E[1]); }
    for (i = 0; i < d.esh.length; i++) { var ES = d.esh[i]; if (ES[0] >= wd.t0 && ES[0] <= wd.t1) ev.push(ES[1]); }
    return { priceR: range(pv), oscR: range(ov), pnlR: range(ev) };
  }

  function gridSvg(g, r, yOf, top, bottom) {
    var out = [], n = 5, i;
    for (i = 0; i < n; i++) {
      var v = r.min + ((r.max - r.min) * i) / (n - 1);
      var y = yOf(v);
      if (y < top || y > bottom || !Number.isFinite(v)) continue;
      out.push('<line x1="' + g.padL + '" y1="' + fix(y, 1) + '" x2="' + (g.w - g.padR) + '" y2="' + fix(y, 1) + '" stroke="#e2e8f0"/>');
      out.push('<text x="' + fix(g.padL - 6, 1) + '" y="' + fix(y + 3, 1) + '" text-anchor="end" font-size="10" fill="#64748b">' + fmtAxisNum(v) + '</text>');
    }
    return out.join('');
  }

  function shadesSvg(d, wd, g, yOf, top, height) {
    var out = [], i;
    for (i = 0; i < d.sh.length; i++) {
      var r = d.sh[i], a = r[0], b = r[1];
      var lo = Math.min(a, b), hi = Math.max(a, b);
      if (hi < wd.t0 || lo > wd.t1) continue;
      var x0 = xOf(g, Math.max(lo, wd.t0), wd), x1 = xOf(g, Math.min(hi, wd.t1), wd);
      var c = shadeColor(r[2]), wdt = Math.max(2, x1 - x0);
      out.push('<rect x="' + fix(x0, 1) + '" y="' + top + '" width="' + fix(wdt, 1) + '" height="' + height + '" fill="' + c.fill + '"/>');
      out.push('<rect x="' + fix(x0, 1) + '" y="' + top + '" width="' + fix(wdt, 1) + '" height="' + height + '" fill="none" stroke="' + c.stroke + '" stroke-dasharray="3 3"/>');
      if (r[3]) {
        var lx = Math.min(x0 + 4, g.w - g.padR - 120);
        out.push('<text x="' + fix(lx, 1) + '" y="' + (top + 13) + '" font-size="10" font-weight="600" fill="' + c.label + '">' + esc(r[3]) + '</text>');
      }
    }
    return out.join('');
  }

  function axisSvg(g, wd) {
    var out = [], n = 5, i, y = g.h - 6;
    for (i = 0; i < n; i++) {
      var t = wd.t0 + ((wd.t1 - wd.t0) * i) / (n - 1);
      var x = xOf(g, t, wd);
      out.push('<text x="' + fix(x, 1) + '" y="' + y + '" text-anchor="middle" font-size="10" fill="#64748b">' + fmtAxisDt(t) + '</text>');
    }
    return out.join('');
  }

  function candlesSvg(d, wd, g, yOf) {
    var out = [], i, cw = wd.cw, bw = Math.max(1.6, cw * 0.62);
    for (i = 0; i < wd.count; i++) {
      var c = d.c[wd.start + i];
      var x = xOf(g, c[0], wd);
      var hi = yOf(c[2]), lo = yOf(c[3]), o = yOf(c[1]), cl = yOf(c[4]);
      var up = c[4] >= c[1], col = up ? '#16a34a' : '#dc2626';
      var bt = Math.min(o, cl), bh = Math.max(Math.abs(o - cl), 1);
      out.push('<line x1="' + fix(x, 1) + '" y1="' + fix(hi, 1) + '" x2="' + fix(x, 1) + '" y2="' + fix(lo, 1) + '" stroke="' + col + '"/>');
      out.push('<rect x="' + fix(x - bw / 2, 1) + '" y="' + fix(bt, 1) + '" width="' + fix(bw, 1) + '" height="' + fix(bh, 1) + '" fill="' + col + '"/>');
    }
    return out.join('');
  }

  function lineSvg(d, wd, g, yOf) {
    var out = [], i, coords = [];
    for (i = 0; i < wd.count; i++) {
      var c = d.c[wd.start + i];
      coords.push(fix(xOf(g, c[0], wd), 1) + ',' + fix(yOf(c[4]), 1));
    }
    if (coords.length < 2) return '';
    out.push('<polyline fill="none" stroke="#0f172a" stroke-width="1.6" points="' + coords.join(' ') + '"/>');
    return out.join('');
  }

  function indicatorSvg(d, wd, g, yOf, onPrice, plotLeft, plotRight) {
    var out = [], k;
    for (k = 0; k < d.ind.length; k++) {
      var s = d.ind[k];
      if (s.on !== onPrice) continue;
      var coords = [], pts = s.pts, i;
      for (i = 0; i < pts.length; i++) {
        var P = pts[i];
        if (P[0] < wd.t0 || P[0] > wd.t1) continue;
        coords.push(fix(xOf(g, P[0], wd), 1) + ',' + fix(yOf(P[1]), 1));
      }
      if (coords.length < 2) continue;
      var dash = s.thr ? ' stroke-dasharray="4 4"' : '';
      out.push('<polyline fill="none" stroke="' + s.color + '" stroke-width="' + (s.thr ? 1 : 1.5) + '"' + dash + ' points="' + coords.join(' ') + '"/>');
    }
    return out.join('');
  }

  function markersSvg(d, wd, g, yOf) {
    var out = [], i;
    for (i = 0; i < d.mk.length; i++) {
      var m = d.mk[i];
      if (m[0] < wd.t0 || m[0] > wd.t1) continue;
      var x = xOf(g, m[0], wd), y = yOf(m[2]);
      var isOpen = m[1] === 'open', isLong = m[3] === 'long', isShadow = !!m[4];
      var color = isShadow ? '#94a3b8' : isOpen ? (isLong ? '#16a34a' : '#dc2626') : (isLong ? '#15803d' : '#b91c1c');
      out.push('<line x1="' + fix(x, 1) + '" y1="' + g.priceTop + '" x2="' + fix(x, 1) + '" y2="' + g.priceBottom + '" stroke="' + color + '" stroke-opacity="' + (isShadow ? '0.16' : '0.28') + '" stroke-width="2"/>');
      var size = 9, flap = 7, base = 6;
      var points = isOpen ? (x + ',' + (y - size) + ' ' + (x - flap) + ',' + (y + base) + ' ' + (x + flap) + ',' + (y + base)) : (x + ',' + (y + size) + ' ' + (x - flap) + ',' + (y - base) + ' ' + (x + flap) + ',' + (y - base));
      out.push('<polygon points="' + points + '" fill="' + color + '" stroke="#0f172a" stroke-width="0.8" stroke-opacity="' + (isShadow ? '0.6' : '1') + '"/>');
    }
    return out.join('');
  }

  function stopsSvg(d, wd, g, yOf) {
    var out = [], i;
    for (i = 0; i < d.st.length; i++) {
      var m = d.st[i];
      if (m[0] < wd.t0 || m[0] > wd.t1) continue;
      var x = xOf(g, m[0], wd), y = yOf(m[1]);
      var isTp = m[2] === 'TP', color = isTp ? '#059669' : '#dc2626', tag = isTp ? 'TP' : 'SL';
      out.push('<line x1="' + fix(x, 1) + '" y1="' + g.priceTop + '" x2="' + fix(x, 1) + '" y2="' + g.priceBottom + '" stroke="' + color + '" stroke-opacity="0.35" stroke-width="2"/>');
      out.push('<line x1="' + g.padL + '" y1="' + fix(y, 1) + '" x2="' + (g.w - g.padR) + '" y2="' + fix(y, 1) + '" stroke="' + color + '" stroke-width="1.5" stroke-dasharray="5 3"/>');
      var label = (tag + ' ' + (m[3] || '')).trim();
      var ly = Math.max(g.priceTop + 10, y - 4);
      out.push('<text x="' + fix(x + 4, 1) + '" y="' + fix(ly, 1) + '" font-size="10" font-weight="600" fill="' + color + '">' + esc(label) + '</text>');
    }
    return out.join('');
  }

  function equityPoly(d, wd, g, yOf, key) {
    var coords = [], i, list = key === 'esh' ? d.esh : d.eq;
    for (i = 0; i < list.length; i++) {
      var P = list[i];
      if (P[0] < wd.t0 || P[0] > wd.t1) continue;
      var nx = xOf(g, P[0], wd);
      if (coords.length) {
        var prev = Number(coords[coords.length - 1].split(',')[0]);
        if (Math.abs(nx - prev) < 0.01) continue;
      }
      coords.push(fix(nx, 1) + ',' + fix(yOf(P[1]), 1));
    }
    return coords;
  }

  function render(id) {
    var d = getData(id);
    if (!d) return;
    var hostEl = document.getElementById('ppc-' + id);
    if (!hostEl) return;
    var g = G[id] || (G[id] = geom(d));
    var wd = win(id, d);
    var st = ST[id];
    var rg = ranges(d, wd);
    var xf = function (t) { return xOf(g, t, wd); };
    var yf = function (v) { return yPrice(g, v, rg.priceR); };
    var yo = function (v) { return yOsc(g, v, rg.oscR); };
    var yp = function (v) { return yPnl(g, v, rg.pnlR); };

    var out = [];
    out.push('<svg viewBox="0 0 ' + g.w + ' ' + g.h + '" width="100%" height="auto" role="img" class="paper-svg">');
    out.push('<rect x="' + g.padL + '" y="' + g.priceTop + '" width="' + g.plotW + '" height="' + g.priceH + '" fill="#f8fafc"/>');
    out.push(gridSvg(g, rg.priceR, yf, g.priceTop, g.priceBottom));
    out.push(shadesSvg(d, wd, g, yf, g.priceTop, g.priceH));
    if (st.mode === 1) out.push(candlesSvg(d, wd, g, yf));
    else out.push(lineSvg(d, wd, g, yf));
    out.push(indicatorSvg(d, wd, g, yf, true, g.padL, g.w - g.padR));
    out.push(markersSvg(d, wd, g, yf));
    out.push(stopsSvg(d, wd, g, yf));

    if (g.hasOsc) {
      out.push('<rect x="' + g.padL + '" y="' + g.oscTop + '" width="' + g.plotW + '" height="' + g.oscH + '" fill="#fbfbfe"/>');
      out.push(gridSvg(g, rg.oscR, yo, g.oscTop, g.oscBottom));
      var zeroO = yo(0);
      if (zeroO >= g.oscTop && zeroO <= g.oscBottom) out.push('<line x1="' + g.padL + '" y1="' + fix(zeroO, 1) + '" x2="' + (g.w - g.padR) + '" y2="' + fix(zeroO, 1) + '" stroke="#cbd5e1" stroke-dasharray="4 4"/>');
      out.push(indicatorSvg(d, wd, g, yo, false, g.padL, g.w - g.padR));
      out.push('<text x="' + (g.padL + 4) + '" y="' + (g.oscTop + 14) + '" font-size="10" font-weight="700" fill="#6b7280">OSC</text>');
    }

    if (g.hasPnl) {
      out.push('<rect x="' + g.padL + '" y="' + g.pnlTop + '" width="' + g.plotW + '" height="' + g.pnlH + '" fill="#f5f3ff"/>');
      out.push('<line x1="' + g.padL + '" y1="' + (g.pnlTop + 0.5) + '" x2="' + (g.w - g.padR) + '" y2="' + (g.pnlTop + 0.5) + '" stroke="#ddd6fe"/>');
      out.push(shadesSvg(d, wd, g, yp, g.pnlTop, g.pnlH));
      var zeroY = yp(0);
      if (zeroY >= g.pnlTop && zeroY <= g.pnlBottom) out.push('<line x1="' + g.padL + '" y1="' + fix(zeroY, 1) + '" x2="' + (g.w - g.padR) + '" y2="' + fix(zeroY, 1) + '" stroke="#c4b5fd" stroke-dasharray="4 4"/>');
      var sh = equityPoly(d, wd, g, yp, 'esh');
      if (sh.length >= 2) out.push('<polyline fill="none" stroke="#a78bfa" stroke-width="2" stroke-dasharray="5 3" points="' + sh.join(' ') + '"/>');
      var e1 = equityPoly(d, wd, g, yp, 'eq');
      if (e1.length >= 2) out.push('<polyline fill="none" stroke="#7c3aed" stroke-width="3" points="' + e1.join(' ') + '"/>');
      out.push('<text x="' + (g.padL + 4) + '" y="' + (g.pnlTop + 13) + '" font-size="10" font-weight="700" fill="#7c3aed">PnL</text>');
      out.push('<text x="' + fix(g.padL - 6, 1) + '" y="' + (g.pnlTop + 10) + '" text-anchor="end" font-size="9" fill="#6d28d9">' + fmtMoney(rg.pnlR.max) + '</text>');
      out.push('<text x="' + fix(g.padL - 6, 1) + '" y="' + (g.pnlBottom - 4) + '" text-anchor="end" font-size="9" fill="#6d28d9">' + fmtMoney(rg.pnlR.min) + '</text>');
    }

    out.push(axisSvg(g, wd));
    out.push('</svg>');
    hostEl.innerHTML = out.join('');
    updateButtons(id, wd, st, d);
  }

  function updateButtons(id, wd, st, d) {
    var hostEl = document.getElementById('ppfs-' + id);
    if (!hostEl) return;
    var btns = hostEl.querySelectorAll('button.pp-btn');
    var i;
    for (i = 0; i < btns.length; i++) btns[i].disabled = false;
    var zoomOut = hostEl.querySelector('[data-pp="zo"]');
    var pl = hostEl.querySelector('[data-pp="pl"]');
    var pr = hostEl.querySelector('[data-pp="pr"]');
    var modeC = hostEl.querySelector('[data-pp="mode1"]');
    var modeL = hostEl.querySelector('[data-pp="mode0"]');
    var fsOn = hostEl.classList.contains('pp-fs-on');
    if (zoomOut) zoomOut.disabled = !st.cw || st.cw <= st.cw0 + 0.001;
    if (pl) pl.disabled = wd.start <= 0;
    if (pr) pr.disabled = wd.start >= wd.maxStart;
    if (modeC) modeC.classList.toggle('active', st.mode === 1);
    if (modeL) modeL.classList.toggle('active', st.mode === 0);
    var fsBtn = hostEl.querySelector('[data-pp="fs"]');
    var fsClose = hostEl.querySelector('[data-pp="fsx"]');
    if (fsBtn) fsBtn.style.display = fsOn ? 'none' : '';
    if (fsClose) fsClose.style.display = fsOn ? '' : 'none';
  }

  function attachWheel(id) {
    var el = document.getElementById('ppc-' + id);
    if (!el || el.getAttribute('data-pp-wheel') === '1') return;
    el.setAttribute('data-pp-wheel', '1');
    el.addEventListener('wheel', function (e) {
      e.preventDefault();
      var d = getData(id); if (!d) return;
      var st = ensure(id, d);
      var cw0 = st.cw0;
      var cur = st.cw == null ? cw0 : st.cw;
      var next = e.deltaY < 0 ? cur * 1.15 : cur / 1.15;
      next = Math.max(cw0, Math.min(24, next));
      st.cw = next;
      render(id);
    }, { passive: false });
  }

  window.ppc = function (id, cmd) {
    var d = getData(id);
    if (!d) return;
    var st = ensure(id, d);
    if (cmd === 'mode1') { st.mode = 1; render(id); return; }
    if (cmd === 'mode0') { st.mode = 0; render(id); return; }
    if (cmd === 'zi') {
      var curA = st.cw == null ? st.cw0 : st.cw;
      st.cw = Math.min(24, curA * 1.25);
      render(id); return;
    }
    if (cmd === 'zo') {
      var curB = st.cw == null ? st.cw0 : st.cw;
      var nxt = curB / 1.25;
      if (nxt <= st.cw0 + 0.001) { st.cw = null; st.viewStart = 0; }
      else st.cw = nxt;
      render(id); return;
    }
    if (cmd === 'pl') {
      var w1 = win(id, d);
      st.viewStart = Math.max(0, st.viewStart - Math.max(5, Math.floor(w1.count / 4)));
      render(id); return;
    }
    if (cmd === 'pr') {
      var w2 = win(id, d);
      st.viewStart = Math.min(w2.maxStart, st.viewStart + Math.max(5, Math.floor(w2.count / 4)));
      render(id); return;
    }
    if (cmd === 'reset') { st.cw = null; st.viewStart = 0; render(id); return; }
    if (cmd === 'fs') {
      var hostEl = document.getElementById('ppfs-' + id);
      if (hostEl) {
        var on = hostEl.classList.toggle('pp-fs-on');
        document.body.style.overflow = on ? 'hidden' : '';
        updateButtons(id, win(id, d), st, d);
      }
      return;
    }
    if (cmd === 'tp') { tradeNav(id, -1); return; }
    if (cmd === 'tn') { tradeNav(id, 1); return; }
    render(id);
  };

  function tradeNav(id, dir) {
    var d = getData(id);
    if (!d || !d.mk.length) return;
    var st = ensure(id, d);
    var w1 = win(id, d);
    var anchor = w1.t0 + (w1.t1 - w1.t0) * 0.65;
    var times = [], i;
    for (i = 0; i < d.mk.length; i++) times.push(d.mk[i][0]);
    times.sort(function (a, b) { return a - b; });
    var target = null;
    if (dir < 0) { for (i = 0; i < times.length; i++) { if (times[i] < anchor) target = times[i]; else break; } }
    else { for (i = 0; i < times.length; i++) { if (times[i] > anchor + 1) { target = times[i]; break; } } }
    if (target == null) return;
    var idx = 0;
    for (i = 0; i < d.c.length; i++) { if (d.c[i][0] <= target) idx = i; else break; }
    var maxStart = Math.max(0, d.c.length - w1.count);
    st.viewStart = Math.max(0, Math.min(idx - Math.floor(w1.count * 0.65), maxStart));
    render(id);
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      document.querySelectorAll('.pp-fs-on').forEach(function (el) {
        var id = Number(el.id.replace('ppfs-', ''));
        el.classList.remove('pp-fs-on');
        document.body.style.overflow = '';
        var d = getData(id);
        if (d) updateButtons(id, win(id, d), ensure(id, d), d);
      });
    }
  });

  function init() {
    var tags = document.querySelectorAll('script[id^="ppd-"]');
    var i;
    for (i = 0; i < tags.length; i++) {
      var id = parseInt(tags[i].id.slice(4), 10);
      if (!Number.isFinite(id)) continue;
      render(id);
      attachWheel(id);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
`;

module.exports = { css, script };