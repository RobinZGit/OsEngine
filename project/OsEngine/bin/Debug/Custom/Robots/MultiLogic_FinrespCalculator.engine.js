/* MultiLogic FINRESP calculator engine (browser). No persistence. */
(function (root) {
  "use strict";

  const DEFAULT_PARAMS = { LR: 20, Strict: 3, SL: 2, TP: 3 };
  const DEFAULT_VOLUME = {
    volumeType: "Deposit percent",
    volume: 10,
    deposit: 1000000,
    maxPositions: 40
  };

  const TREND_REGIME =
    "Strict(@Strict) Regime(LinReg;L=@LR;Dev=2;SlopeLb=3;OnFlip=Close;Entry=MatchSide) ";
  const BOKOVIK_REGIME =
    "Strict(@Strict) Regime(LinReg;L=@LR;Dev=2;SlopeLb=3;SlopeDead=0.05%;OnFlip=Close;Entry=FlatOnly) ";
  const SLTP = " SL[@SL] TP[@TP] ";

  const DEFAULT_LOGIC_LINES = {
    L1: TREND_REGIME +
      "Op(Long(SMA(100)(Ab) AND LinReg(@LR;Dev=2)(AbUp) AND ATR(14;Gr=3%;Lb=5)(GrOk) AND CCI(20;Lmin=100;Smax=-100)(CCI>=100) AND MACD(12,26,9)(Macd>Sig))) " +
      "Cl(Long(SMA(100)(Bl) AND LinReg(@LR;Dev=2)(BlLo) AND CCI(20;Lmin=100;Smax=-100)(CCI<=-100) AND MACD(12,26,9)(Macd<Sig)) OnFlip(Close))" +
      SLTP + "Note(lon-trend)",
    L2: BOKOVIK_REGIME +
      "Op(Long(SMA(100)(Ab) AND Stoch(14-3-3;Lmin=90;Smax=10)(K<=10) AND ATR(14;Gr=3%;Lb=5)(GrOk) AND MACD(12,26,9)(Macd>Sig))) " +
      "Cl(Long(SMA(100)(Bl) AND Stoch(14-3-3;Lmin=90;Smax=10)(K>=90) AND MACD(12,26,9)(Macd<Sig)) OnFlip(Close))" +
      SLTP + "Note(lon-bokovik)",
    L3: TREND_REGIME +
      "Op(Short(SMA(100)(Bl) AND LinReg(@LR;Dev=2)(BlLo) AND ATR(14;Gr=3%;Lb=5)(GrOk) AND CCI(20;Lmin=100;Smax=-100)(CCI<=-100) AND MACD(12,26,9)(Macd<Sig))) " +
      "Cl(Short(SMA(100)(Ab) AND LinReg(@LR;Dev=2)(AbUp) AND CCI(20;Lmin=100;Smax=-100)(CCI>=100) AND MACD(12,26,9)(Macd>Sig)) OnFlip(Close))" +
      SLTP + "Note(short-trend)",
    L4: BOKOVIK_REGIME +
      "Op(Short(SMA(100)(Bl) AND Stoch(14-3-3;Lmin=90;Smax=10)(K>=90) AND ATR(14;Gr=3%;Lb=5)(GrOk) AND MACD(12,26,9)(Macd<Sig))) " +
      "Cl(Short(SMA(100)(Ab) AND Stoch(14-3-3;Lmin=90;Smax=10)(K<=10) AND MACD(12,26,9)(Macd>Sig)) OnFlip(Close))" +
      SLTP + "Note(short-bokovik)"
  };

  const BUILTIN_META = [
    { id: "sma_above", name: "Выше SMA — объём |Close−SMA|", type: "sma_spread", smaLen: 3, side: "above" },
    { id: "sma_below", name: "Ниже SMA — объём |Close−SMA|", type: "sma_spread", smaLen: 3, side: "below" },
    { id: "L1", name: "L1 — лонг, тренд", type: "logic_line", key: "L1" },
    { id: "L2", name: "L2 — лонг, боковик", type: "logic_line", key: "L2" },
    { id: "L3", name: "L3 — шорт, тренд", type: "logic_line", key: "L3" },
    { id: "L4", name: "L4 — шорт, боковик", type: "logic_line", key: "L4" }
  ];

  function substituteParams(line, params) {
    const p = { ...DEFAULT_PARAMS, ...params };
    return String(line || "")
      .replace(/@LR/g, String(p.LR))
      .replace(/@Strict/g, String(p.Strict))
      .replace(/@SL/g, String(p.SL))
      .replace(/@TP/g, String(p.TP));
  }

  function stripDecor(line) {
    return String(line || "")
      .replace(/Strict\([^)]*\)\s*/gi, "")
      .replace(/Regime\([^)]*\)\s*/gi, "")
      .replace(/OnFlip\([^)]*\)/gi, "")
      .replace(/Note\([^)]*\)/gi, "")
      .trim();
  }

  function parseSlTp(line) {
    const slM = line.match(/SL\[([^\]]+)\]/i);
    const tpM = line.match(/TP\[([^\]]+)\]/i);
    const parseAtrMult = (raw) => {
      if (!raw) return 0;
      const t = raw.trim().toUpperCase().replace("ATR", "");
      const n = parseFloat(t);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    return { slAtr: parseAtrMult(slM?.[1]), tpAtr: parseAtrMult(tpM?.[1]) };
  }

  function extractBlock(line, tag) {
    const re = new RegExp(tag + "\\((Long|Short)\\(", "i");
    const m = re.exec(line);
    if (!m) return null;
    const side = m[1].toLowerCase();
    let i = m.index + m[0].length;
    let depth = 1;
    const start = i;
    while (i < line.length && depth > 0) {
      if (line[i] === "(") depth++;
      else if (line[i] === ")") depth--;
      i++;
    }
    const inner = line.slice(start, i - 1);
    return { side, expr: inner.trim() };
  }

  function splitTopLevelAnd(expr) {
    const parts = [];
    let depth = 0;
    let cur = "";
    const s = expr || "";
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (depth === 0 && s.slice(i, i + 5).toUpperCase() === " AND ") {
        if (cur.trim()) parts.push(cur.trim());
        cur = "";
        i += 4;
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
  }

  function parseAtom(atomStr) {
    const s = atomStr.trim();
    const idx = s.indexOf(")(");
    if (idx < 0) return null;
    const namePart = s.slice(0, idx + 1);
    const sigPart = s.slice(idx + 2);
    const m = namePart.match(/^(\w+)\((.*)\)$/);
    if (!m) return null;
    return { kind: m[1].toLowerCase(), params: m[2], signal: sigPart.replace(/^\(|\)$/g, "").trim() };
  }

  function parseParamsMap(raw) {
    const map = {};
    for (const part of String(raw || "").split(";")) {
      const p = part.trim();
      if (!p) continue;
      if (p.includes("=")) {
        const [k, v] = p.split("=");
        map[k.trim()] = v.trim();
      } else if (/^\d+-\d+-\d+$/.test(p)) {
        const [a, b, c] = p.split("-").map(Number);
        map.K1 = a; map.K2 = b; map.D = c;
      } else if (/^\d+,\d+,\d+$/.test(p)) {
        const [a, b, c] = p.split(",").map(Number);
        map.fast = a; map.slow = b; map.signal = c;
      } else if (/^\d+$/.test(p)) {
        map.L = Number(p);
      }
    }
    return map;
  }

  function parseLogicLine(line) {
    const raw = substituteParams(line, {});
    const { slAtr, tpAtr } = parseSlTp(raw);
    const body = stripDecor(raw);
    const op = extractBlock(body, "Op");
    const cl = extractBlock(body, "Cl");
    return {
      slAtr,
      tpAtr,
      opSide: op?.side || "long",
      clSide: cl?.side || op?.side || "long",
      opAtoms: op ? splitTopLevelAnd(op.expr).map(parseAtom).filter(Boolean) : [],
      clAtoms: cl ? splitTopLevelAnd(cl.expr).map(parseAtom).filter(Boolean) : []
    };
  }

  function smaSeries(closes, len) {
    const out = new Array(closes.length).fill(null);
    let sum = 0;
    for (let i = 0; i < closes.length; i++) {
      sum += closes[i];
      if (i >= len) sum -= closes[i - len];
      if (i >= len - 1) out[i] = sum / len;
    }
    return out;
  }

  function emaSeries(values, len) {
    const out = new Array(values.length).fill(null);
    const k = 2 / (len + 1);
    let prev = null;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null) continue;
      if (prev == null) {
        prev = v;
        out[i] = v;
        continue;
      }
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  function atrSeries(candles, len) {
    const out = new Array(candles.length).fill(null);
    const trs = [];
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const prev = i > 0 ? candles[i - 1].close : c.close;
      trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev)));
      if (i >= len - 1) {
        let s = 0;
        for (let j = i - len + 1; j <= i; j++) s += trs[j];
        out[i] = s / len;
      }
    }
    return out;
  }

  function stochSeries(candles, kLen, kSmooth, dSmooth) {
    const kRaw = new Array(candles.length).fill(null);
    for (let i = 0; i < candles.length; i++) {
      if (i < kLen - 1) continue;
      let lo = Infinity, hi = -Infinity;
      for (let j = i - kLen + 1; j <= i; j++) {
        lo = Math.min(lo, candles[j].low);
        hi = Math.max(hi, candles[j].high);
      }
      kRaw[i] = hi === lo ? 50 : (candles[i].close - lo) / (hi - lo) * 100;
    }
    const smooth = (src, n) => {
      const o = new Array(src.length).fill(null);
      let sum = 0;
      for (let i = 0; i < src.length; i++) {
        if (src[i] == null) continue;
        sum += src[i];
        if (i >= n) sum -= src[i - n] ?? 0;
        if (i >= n - 1) o[i] = sum / n;
      }
      return o;
    };
    const k = smooth(kRaw, kSmooth);
    const d = smooth(k, dSmooth);
    return { k, d };
  }

  function linRegSeries(closes, len, devMult) {
    const up = new Array(closes.length).fill(null);
    const center = new Array(closes.length).fill(null);
    const down = new Array(closes.length).fill(null);
    for (let i = len - 1; i < closes.length; i++) {
      let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
      for (let j = 0; j < len; j++) {
        const x = j;
        const y = closes[i - len + 1 + j];
        sumX += x; sumY += y; sumXY += x * y; sumXX += x * x;
      }
      const slope = (len * sumXY - sumX * sumY) / (len * sumXX - sumX * sumX);
      const intercept = (sumY - slope * sumX) / len;
      const c0 = intercept;
      const c1 = intercept + slope * (len - 1);
      let varSum = 0;
      for (let j = 0; j < len; j++) {
        const y = closes[i - len + 1 + j];
        const fit = intercept + slope * j;
        varSum += (y - fit) ** 2;
      }
      const std = Math.sqrt(varSum / len);
      center[i] = c1;
      up[i] = c1 + devMult * std;
      down[i] = c1 - devMult * std;
    }
    return { up, center, down };
  }

  function cciSeries(candles, len) {
    const out = new Array(candles.length).fill(null);
    const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
    for (let i = len - 1; i < candles.length; i++) {
      let s = 0;
      for (let j = i - len + 1; j <= i; j++) s += tp[j];
      const ma = s / len;
      let md = 0;
      for (let j = i - len + 1; j <= i; j++) md += Math.abs(tp[j] - ma);
      md /= len;
      out[i] = md === 0 ? 0 : (tp[i] - ma) / (0.015 * md);
    }
    return out;
  }

  function macdSeries(closes, fast, slow, signal) {
    const ef = emaSeries(closes, fast);
    const es = emaSeries(closes, slow);
    const macd = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
    const sig = emaSeries(macd.map((v) => v ?? 0), signal);
    return { macd, signal: sig };
  }

  class IndicatorCache {
    constructor(candles) {
      this.candles = candles;
      this.closes = candles.map((c) => c.close);
      this._sma = new Map();
      this._atr = new Map();
      this._stoch = new Map();
      this._linreg = new Map();
      this._cci = new Map();
      this._macd = new Map();
    }
    sma(len) {
      const k = len;
      if (!this._sma.has(k)) this._sma.set(k, smaSeries(this.closes, len));
      return this._sma.get(k);
    }
    atr(len) {
      if (!this._atr.has(len)) this._atr.set(len, atrSeries(this.candles, len));
      return this._atr.get(len);
    }
    stoch(k1, k2, d) {
      const key = `${k1}-${k2}-${d}`;
      if (!this._stoch.has(key)) this._stoch.set(key, stochSeries(this.candles, k1, k2, d));
      return this._stoch.get(key);
    }
    linreg(len, dev) {
      const key = `${len};${dev}`;
      if (!this._linreg.has(key)) this._linreg.set(key, linRegSeries(this.closes, len, dev));
      return this._linreg.get(key);
    }
    cci(len) {
      if (!this._cci.has(len)) this._cci.set(len, cciSeries(this.candles, len));
      return this._cci.get(len);
    }
    macd(fast, slow, signal) {
      const key = `${fast},${slow},${signal}`;
      if (!this._macd.has(key)) this._macd.set(key, macdSeries(this.closes, fast, slow, signal));
      return this._macd.get(key);
    }
  }

  function evalThreshold(signal, value, close) {
    const s = signal.replace(/\s+/g, "").toUpperCase();
    const m = s.match(/^(K|CCI|RSI|MOM)(>=|<=|>|<)(-?\d+(?:\.\d+)?)$/);
    if (m) {
      const thr = parseFloat(m[3]);
      switch (m[2]) {
        case ">=": return value >= thr;
        case "<=": return value <= thr;
        case ">": return value > thr;
        case "<": return value < thr;
      }
    }
    if (s === "AB") return close > value;
    if (s === "BL") return close < value;
    return false;
  }

  function evaluateAtom(atom, cache, idx) {
    const c = cache.candles[idx];
    const close = c.close;
    const pm = parseParamsMap(atom.params);
    const sig = atom.signal.replace(/\s+/g, "");
    const sigU = sig.toUpperCase();

    if (atom.kind === "sma") {
      const len = pm.L || parseInt(atom.params, 10) || 100;
      const v = cache.sma(len)[idx];
      if (v == null) return false;
      return evalThreshold(sigU === "AB" ? "AB" : sigU === "BL" ? "BL" : sig, v, close);
    }
    if (atom.kind === "atr") {
      const len = pm.L || 14;
      const lb = parseInt(pm.Lb || pm.lb || "5", 10);
      const gr = parseFloat(String(pm.Gr || pm.gr || "3").replace("%", "")) / 100;
      const atr = cache.atr(len);
      const cur = atr[idx];
      const prev = idx >= lb ? atr[idx - lb] : null;
      if (cur == null || prev == null || prev === 0) return false;
      if (sigU === "GROK" || sigU.includes("GROK")) return cur >= prev * (1 + gr);
      return false;
    }
    if (atom.kind === "stoch") {
      const k1 = pm.K1 || 14, k2 = pm.K2 || 3, d = pm.D || 3;
      const st = cache.stoch(k1, k2, d);
      const k = st.k[idx];
      if (k == null) return false;
      return evalThreshold(sig, k, close);
    }
    if (atom.kind === "linreg") {
      const len = pm.L || parseInt(atom.params, 10) || 20;
      const dev = parseFloat(pm.Dev || pm.dev || "2");
      const lr = cache.linreg(len, dev);
      if (sigU === "ABUP") return lr.up[idx] != null && close > lr.up[idx];
      if (sigU === "BLLO") return lr.down[idx] != null && close < lr.down[idx];
      if (sigU === "ABLO") return lr.down[idx] != null && close > lr.down[idx];
      if (sigU === "BLUP") return lr.up[idx] != null && close < lr.up[idx];
      if (sigU === "SLOPEUP" || sigU === "CENTERUP") {
        const c0 = lr.center[idx - 1], c1 = lr.center[idx];
        return c0 != null && c1 != null && c1 > c0;
      }
      if (sigU === "SLOPEDN" || sigU === "CENTERDN") {
        const c0 = lr.center[idx - 1], c1 = lr.center[idx];
        return c0 != null && c1 != null && c1 < c0;
      }
      return false;
    }
    if (atom.kind === "macd") {
      const fast = pm.fast || 12, slow = pm.slow || 26, signal = pm.signal || 9;
      const md = cache.macd(fast, slow, signal);
      const m = md.macd[idx], s = md.signal[idx];
      if (m == null || s == null) return false;
      if (sigU === "MACD>SIG" || sigU === "MACD>SIG") return m > s;
      if (sigU === "MACD<SIG") return m < s;
      return false;
    }
    if (atom.kind === "cci") {
      const len = pm.L || 20;
      const v = cache.cci(len)[idx];
      if (v == null) return false;
      return evalThreshold(sig, v, close);
    }
    return false;
  }

  function evaluateExpr(atoms, cache, idx) {
    if (!atoms.length) return false;
    return atoms.every((a) => evaluateAtom(a, cache, idx));
  }

  function warmupBars() {
    return 120;
  }

  function calcTradeVolume(price, volConfig) {
    const cfg = { ...DEFAULT_VOLUME, ...volConfig };
    const p = price > 0 ? price : 0;
    if (p <= 0) return 0;
    if (cfg.volumeType === "Contracts") return Math.max(0, cfg.volume);
    if (cfg.volumeType === "Contract currency") return Math.max(0, cfg.volume / p);
    return Math.max(0, (cfg.deposit * cfg.volume / 100) / p);
  }

  function maxAbsPosition(price, volConfig) {
    const lot = calcTradeVolume(price, volConfig);
    const maxPos = Math.max(1, volConfig?.maxPositions ?? DEFAULT_VOLUME.maxPositions);
    return lot * maxPos;
  }

  function pushRow(rows, candle, fields) {
    rows.push({
      time: candle.time,
      close: candle.close,
      ...fields
    });
  }

  function collectChartIndicators(cache, parsed, idx) {
    const ind = {};
    const atoms = [...(parsed?.opAtoms || []), ...(parsed?.clAtoms || [])];
    for (const atom of atoms) {
      const pm = parseParamsMap(atom.params);
      if (atom.kind === "sma") {
        const len = pm.L || parseInt(atom.params, 10) || 100;
        ind.sma = cache.sma(len)[idx];
      }
      if (atom.kind === "linreg") {
        const len = pm.L || parseInt(atom.params, 10) || 20;
        const dev = parseFloat(pm.Dev || pm.dev || "2");
        const lr = cache.linreg(len, dev);
        ind.linregUp = lr.up[idx];
        ind.linregDn = lr.down[idx];
        ind.linregMid = lr.center[idx];
      }
    }
    return ind;
  }

  function simulateLogicLine(candles, parsed, startIdx, endIdx, volConfig) {
    const cache = new IndicatorCache(candles);
    const atr14 = cache.atr(14);
    let pos = 0;
    let cash = 0;
    let entryPrice = null;
    const rows = [];
    const w = Math.max(warmupBars(), 2);
    const from = Math.max(startIdx, w);
    const to = Math.min(endIdx, candles.length - 1);

    const flatten = (price) => {
      if (pos === 0) return 0;
      const vol = Math.abs(pos);
      cash += pos * price;
      pos = 0;
      entryPrice = null;
      return vol;
    };

    for (let i = from; i <= to; i++) {
      const price = candles[i].close;
      let buy = 0;
      let sell = 0;

      if (pos !== 0 && (parsed.slAtr > 0 || parsed.tpAtr > 0)) {
        const a = atr14[i];
        if (a != null && a > 0 && entryPrice != null) {
          let hit = false;
          if (pos > 0) {
            if (parsed.slAtr > 0 && price <= entryPrice - parsed.slAtr * a) hit = true;
            else if (parsed.tpAtr > 0 && price >= entryPrice + parsed.tpAtr * a) hit = true;
          } else {
            if (parsed.slAtr > 0 && price >= entryPrice + parsed.slAtr * a) hit = true;
            else if (parsed.tpAtr > 0 && price <= entryPrice - parsed.tpAtr * a) hit = true;
          }
          if (hit) sell += flatten(price);
        }
      }

      const opHit = evaluateExpr(parsed.opAtoms, cache, i);
      const clHit = evaluateExpr(parsed.clAtoms, cache, i);

      if (pos !== 0 && clHit) sell += flatten(price);
      if (pos === 0 && opHit) {
        const lot = calcTradeVolume(price, volConfig);
        const cap = maxAbsPosition(price, volConfig);
        if (lot > 0 && lot <= cap) {
          pos = parsed.opSide === "long" ? lot : -lot;
          cash -= pos * price;
          entryPrice = price;
          buy = lot;
        }
      }

      const ind = collectChartIndicators(cache, parsed, i);
      pushRow(rows, candles[i], {
        ...ind,
        buy,
        sell,
        pos,
        cash,
        eq: cash + pos * price
      });
    }

    const last = rows.at(-1);
    return {
      rows,
      finresp: last?.eq ?? 0,
      cash: last?.cash ?? 0,
      pos: last?.pos ?? 0,
      buys: rows.reduce((s, r) => s + (r.buy || 0), 0),
      sells: rows.reduce((s, r) => s + (r.sell || 0), 0)
    };
  }

  function simulateSmaSpread(candles, smaLen, side, startIdx, endIdx, volConfig) {
    const closes = candles.map((c) => c.close);
    const sma = smaSeries(closes, smaLen);
    let cash = 0;
    let pos = 0;
    let buys = 0;
    let sells = 0;
    const rows = [];
    const capAt = (price) => maxAbsPosition(price, volConfig);

    for (let i = startIdx; i <= endIdx; i++) {
      const price = closes[i];
      const s = sma[i];
      let buy = 0;
      let sell = 0;
      if (s != null) {
        const d = price - s;
        const scale = calcTradeVolume(price, volConfig) / Math.max(price, 1e-9);
        if (side === "above") {
          buy = Math.max(d, 0) * scale;
          sell = Math.max(-d, 0) * scale;
        } else {
          buy = Math.max(-d, 0) * scale;
          sell = Math.max(d, 0) * scale;
        }
        const cap = capAt(price);
        if (pos + buy - sell > cap) buy = Math.max(0, cap - pos + sell);
        if (pos + buy - sell < -cap) sell = Math.max(0, pos + buy + cap);
        cash += price * (sell - buy);
        pos += buy - sell;
        buys += buy;
        sells += sell;
      }
      rows.push({
        time: candles[i].time,
        close: price,
        sma: s,
        buy,
        sell,
        cash,
        pos,
        eq: cash + pos * price
      });
    }
    const last = rows.at(-1);
    return { rows, finresp: last?.eq ?? 0, cash: last?.cash ?? 0, pos: last?.pos ?? 0, buys, sells };
  }

  function resolveLogicSpec(logicId, customLines, params) {
    const meta = BUILTIN_META.find((m) => m.id === logicId);
    if (!meta) return null;
    if (meta.type === "sma_spread") {
      return { type: "sma_spread", smaLen: meta.smaLen, side: meta.side };
    }
    const line = substituteParams(customLines[meta.key] || DEFAULT_LOGIC_LINES[meta.key], params);
    return { type: "logic_line", parsed: parseLogicLine(line), line };
  }

  function runOnCandles(candles, spec, startIdx, endIdx, params, volConfig) {
    if (!candles?.length) return { rows: [], finresp: 0, cash: 0, pos: 0, buys: 0, sells: 0 };
    const vol = { ...DEFAULT_VOLUME, ...volConfig };
    if (spec.type === "sma_spread") {
      return simulateSmaSpread(candles, spec.smaLen, spec.side, startIdx, endIdx, vol);
    }
    return simulateLogicLine(candles, spec.parsed, startIdx, endIdx, vol);
  }

  async function loadMoexCandles(sec, from, till, interval) {
    const all = [];
    let start = 0;
    while (true) {
      const url = new URL(`https://iss.moex.com/iss/engines/stock/markets/shares/securities/${sec}/candles.json`);
      url.search = new URLSearchParams({ from, till, interval, start: String(start) }).toString();
      const data = await fetch(url).then((r) => {
        if (!r.ok) throw new Error(`MOEX HTTP ${r.status} (${sec})`);
        return r.json();
      });
      const chunk = data?.candles?.data || [];
      if (!chunk.length) break;
      all.push(...chunk);
      if (chunk.length < 500) break;
      start += chunk.length;
      if (start > 20000) break;
    }
    const seen = new Set();
    return all
      .filter((r) => {
        if (seen.has(r[6])) return false;
        seen.add(r[6]);
        return true;
      })
      .map((r) => ({
        open: +r[0],
        close: +r[1],
        high: +r[2],
        low: +r[3],
        volume: +r[5],
        time: r[6],
        sec
      }));
  }

  async function loadMany(secs, from, till, interval) {
    const packs = await Promise.all(secs.map((s) => loadMoexCandles(s, from, till, interval)));
    return packs;
  }

  function aggregateFinresp(perSecResults) {
    let finresp = 0, cash = 0, pos = 0, buys = 0, sells = 0;
    const bySec = {};
    for (const r of perSecResults) {
      finresp += r.finresp;
      cash += r.cash;
      pos += r.pos;
      buys += r.buys;
      sells += r.sells;
      bySec[r.sec] = r.finresp;
    }
    return { finresp, cash, pos, buys, sells, bySec };
  }

  function runMulti(packs, spec, startIdx, endIdx, params, volConfig) {
    const perSec = packs.map((candles) => {
      const sec = candles[0]?.sec || "?";
      const a = Math.max(0, Math.min(startIdx, candles.length - 1));
      const b = Math.max(a, Math.min(endIdx, candles.length - 1));
      const r = runOnCandles(candles, spec, a, b, params, volConfig);
      return { sec, ...r };
    });
    const agg = aggregateFinresp(perSec);
    const chartPack = perSec.length === 1 ? perSec[0] : perSec[0];
    return { perSec, agg, chartRows: chartPack?.rows || [] };
  }

  root.MultiLogicFinrespEngine = {
    DEFAULT_PARAMS,
    DEFAULT_VOLUME,
    DEFAULT_LOGIC_LINES,
    BUILTIN_META,
    calcTradeVolume,
    substituteParams,
    parseLogicLine,
    resolveLogicSpec,
    runOnCandles,
    runMulti,
    loadMany,
    smaSeries
  };
})(typeof window !== "undefined" ? window : globalThis);
