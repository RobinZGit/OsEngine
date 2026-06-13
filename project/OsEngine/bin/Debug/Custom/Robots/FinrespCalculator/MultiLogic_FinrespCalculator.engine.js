/*
 * MultiLogic FINRESP calculator engine (browser). No persistence.
 *
 * Термины (как в Pascal/VBA и в этом файле):
 *   — «функция» — подпрограмма, возвращающая значение (return);
 *   — «процедура» — подпрограмма без результата (void); в JS тоже function, но без return.
 *
 * Основные блоки:
 *   parseLogicLine / resolveLogicSpec — разбор строки Op/Cl и сборка spec для симуляции;
 *   simulateLogicLine — одна логика L1…L5 на свечах;
 *   simulateMultiLogicStack — несколько L-логик по приоритету (как слоты MultiLogic);
 *   runMulti / runMultiAsync — портфель инструментов + portfolio stopper;
 *   loadManyDetailed — загрузка свечей MOEX.
 */
(function (root) {
  "use strict";

  const DEFAULT_PARAMS = { LR: 20, Strict: 3, SL: 2, TP: 3, slTpAtrLen: 14 };
  const DEFAULT_STOPPER = {
    useSl: false,
    useTp: false,
    slMult: 2,
    tpMult: 3,
    atrLen: 14,
    refEquity: 0
  };
  const DEFAULT_VOLUME = {
    volumeType: "Deposit percent",
    volume: 10,
    deposit: 1000000,
    maxPositions: 40,
    commissionPct: 0
  };
  const DEFAULT_COMMISSION = { type: "Percent", value: 0.04 };

  function normalizeCommission(cfg) {
    const c = cfg || DEFAULT_COMMISSION;
    const type = c.type === "OneLotFix" || c.type === "Percent" ? c.type : "None";
    const value = Math.max(0, Number(c.value) || 0);
    if (type === "None" || value <= 0) return { type: "None", value: 0 };
    return { type, value };
  }

  function tradeCommission(volume, price, commissionCfg) {
    const cfg = normalizeCommission(commissionCfg);
    const vol = Math.abs(Number(volume) || 0);
    const px = Math.max(0, Number(price) || 0);
    if (vol <= 0 || px <= 0) return 0;
    if (cfg.type === "Percent") return vol * px * (cfg.value / 100);
    if (cfg.type === "OneLotFix") return vol * cfg.value;
    return 0;
  }

  const INDICATOR_OPTIONS = Object.freeze([
    { key: "sma", label: "SMA" },
    { key: "atr", label: "ATR" },
    { key: "stoch", label: "Stoch" },
    { key: "linreg", label: "LinReg" },
    { key: "macd", label: "MACD" },
    { key: "cci", label: "CCI" },
    { key: "bollinger", label: "Bollinger" },
    { key: "momentum", label: "Momentum" },
    { key: "vwap", label: "VWAP" }
  ]);
  const INDICATOR_KEYS = INDICATOR_OPTIONS.map((x) => x.key);
  const INDICATOR_KEY_SET = new Set(INDICATOR_KEYS);

  const DEFAULT_STOCK_TICKERS_RAW =
    "AFLT, ALRS, AFKS, BSPB, CHMF, FEES, GAZP, GMKN, HYDR, IRAO, LKOH, MAGN, MOEX, MTSS, MTLRP, "
    + "NVTK, NLMK, PLZL, PIKK, PHOR, ROSN, RUAL, RTKMP, SBER, SBERP, SNGSP, SNGS, TATN, TATNP, UPRO, VTBR";

  const DEFAULT_FUTURES_PREFIXES_RAW =
    "Si,USDRUBF,Eu,EURRUBF,CNY,MX,MM,IMOEXF,RI,BR,BRM,CL,NG,NGM,GD,GLDRUBF,SV,PT,PD,CU,SR,GZ,LK,RN,NK,GN,TT,VB,SN,SG,RL";

  const MOEX_FUTURES_PREFIX_ALIASES = {
    CNY: ["CR", "CNYRUBF"],
    SI: ["Si", "SV", "SILV"],
    RUAL: ["RU"]
  };

  function parseTickerPrefixes(raw) {
    const result = [];
    const seen = new Set();
    for (const part of String(raw || "").split(",")) {
      const p = part.trim();
      if (!p) continue;
      const key = p.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(p);
    }
    return result;
  }

  function tryExtractMoexFortsSeriesBase(ticker) {
    if (ticker.length < 3) return "";
    const len = ticker.length;
    const monthCh = ticker[len - 2];
    const yearCh = ticker[len - 1];
    if (!/[A-Za-z]/.test(monthCh) || !/\d/.test(yearCh)) return "";
    const basePart = ticker.substring(0, len - 2);
    if (!basePart.length) return "";
    for (let i = 0; i < basePart.length; i++) {
      if (!/[A-Za-z]/.test(basePart[i])) return "";
    }
    return basePart;
  }

  function extractFuturesLetterRoot(ticker) {
    const t = String(ticker || "").trim();
    if (!t) return "";
    const dash = t.indexOf("-");
    if (dash > 0) return t.substring(0, dash).trim();
    const dot = t.indexOf(".");
    if (dot > 0) {
      let allLetters = true;
      for (let k = 0; k < dot; k++) {
        if (!/[A-Za-z]/.test(t[k])) { allLetters = false; break; }
      }
      if (allLetters) return t.substring(0, dot).trim();
    }
    const fortBase = tryExtractMoexFortsSeriesBase(t);
    if (fortBase) return fortBase;
    let end = 0;
    while (end < t.length && /[A-Za-z]/.test(t[end])) end++;
    return end > 0 ? t.substring(0, end) : "";
  }

  function expandPrefixWithMoexAliases(userPrefix) {
    const p = String(userPrefix || "").trim();
    if (!p) return [];
    const out = [p];
    const aliases = MOEX_FUTURES_PREFIX_ALIASES[p.toUpperCase()];
    if (aliases) out.push(...aliases);
    return out;
  }

  function rootMatchesExpandedPrefix(root, expandedPrefix) {
    if (!root || !expandedPrefix) return false;
    const r = root;
    const e = expandedPrefix;
    if (r.toUpperCase() === e.toUpperCase()) return true;
    if (e.length <= r.length && r.toUpperCase().startsWith(e.toUpperCase())) return true;
    if (r.length <= e.length && e.toUpperCase().startsWith(r.toUpperCase())) return true;
    return false;
  }

  function stockTickerMatches(secid, prefixes) {
    const name = String(secid || "").trim().toUpperCase();
    return prefixes.some((p) => name === String(p).trim().toUpperCase());
  }

  function normMoexDate(value) {
    if (!value) return "";
    return String(value).slice(0, 10);
  }

  function isPerpetualFuture(secid) {
    const s = String(secid || "").trim().toUpperCase();
    return /RUBF$/.test(s) || s === "IMOEXF";
  }

  function futuresMatchesCalcPeriod(sec, from, till) {
    const last = normMoexDate(sec.LASTTRADEDATE);
    const first = normMoexDate(sec.FIRSTTRADEDATE);
    if (isPerpetualFuture(sec.SECID)) {
      return !last || last >= from;
    }
    if (last && last < from) return false;
    if (first && first > till) return false;
    if (first && first < from) return false;
    return true;
  }

  function futuresTickerMatches(secid, prefixes) {
    const normalized = String(secid || "").trim();
    const root = extractFuturesLetterRoot(normalized);
    if (!root && !normalized) return false;
    for (const p of prefixes) {
      for (const expanded of expandPrefixWithMoexAliases(p)) {
        if (!expanded) continue;
        if (root && rootMatchesExpandedPrefix(root, expanded)) return true;
        if (expanded.length <= normalized.length
          && normalized.toUpperCase().startsWith(expanded.toUpperCase())) return true;
        if (expanded.length >= 2
          && normalized.toUpperCase().includes(expanded.toUpperCase())) return true;
      }
    }
    return false;
  }

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
      SLTP + "Note(short-bokovik)",
    L5: TREND_REGIME +
      "Op(Long(SMA(100)(Ab) AND LinReg(@LR;Dev=2)(AbUp) AND Bollinger(20;Dev=2)(AbUp) AND VWAP()(Ab) AND ATR(14;Gr=3%;Lb=5)(GrOk) AND Stoch(14-3-3;Lmin=80;Smax=20)(K>=80) AND CCI(20;Lmin=100;Smax=-100)(CCI>=100) AND Momentum(10)(MOM>0) AND MACD(12,26,9)(Macd>Sig))) " +
      "Cl(Long(SMA(100)(Bl) AND LinReg(@LR;Dev=2)(BlLo) AND Bollinger(20;Dev=2)(BlLo) AND VWAP()(Bl) AND Stoch(14-3-3;Lmin=80;Smax=20)(K<=20) AND CCI(20;Lmin=100;Smax=-100)(CCI<=-100) AND Momentum(10)(MOM<0) AND MACD(12,26,9)(Macd<Sig)) OnFlip(Close)) " +
      "Op(Short(SMA(100)(Bl) AND LinReg(@LR;Dev=2)(BlLo) AND Bollinger(20;Dev=2)(BlLo) AND VWAP()(Bl) AND ATR(14;Gr=3%;Lb=5)(GrOk) AND Stoch(14-3-3;Lmin=80;Smax=20)(K<=20) AND CCI(20;Lmin=100;Smax=-100)(CCI<=-100) AND Momentum(10)(MOM<0) AND MACD(12,26,9)(Macd<Sig))) " +
      "Cl(Short(SMA(100)(Ab) AND LinReg(@LR;Dev=2)(AbUp) AND Bollinger(20;Dev=2)(AbUp) AND VWAP()(Ab) AND Stoch(14-3-3;Lmin=80;Smax=20)(K>=80) AND CCI(20;Lmin=100;Smax=-100)(CCI>=100) AND Momentum(10)(MOM>0) AND MACD(12,26,9)(Macd>Sig)) OnFlip(Close))" +
      SLTP + "Note(LmaxTrend)"
  };

  const BUILTIN_META = [
    { id: "L5", name: "L5 — LmaxTrend, лонг+шорт тренд", type: "logic_line", key: "L5" },
    { id: "L1", name: "L1 — лонг, тренд", type: "logic_line", key: "L1" },
    { id: "L2", name: "L2 — лонг, боковик", type: "logic_line", key: "L2" },
    { id: "L3", name: "L3 — шорт, тренд", type: "logic_line", key: "L3" },
    { id: "L4", name: "L4 — шорт, боковик", type: "logic_line", key: "L4" },
    { id: "sma_below", name: "Ниже SMA — объём |Close−SMA|", type: "sma_spread", smaLen: 3, side: "below" },
    { id: "sma_above", name: "Выше SMA — объём |Close−SMA|", type: "sma_spread", smaLen: 3, side: "above" }
  ];

  const ORDER_BOOK_TREND_TOKEN = "@OBT";
  const DEFAULT_OB_IMBALANCE = 0.12;

  function substituteParams(line, params) {
    const p = { ...DEFAULT_PARAMS, ...params };
    return String(line || "")
      .replace(/@LR/g, String(p.LR))
      .replace(/@Strict/g, String(p.Strict))
      .replace(/@SL/g, String(p.SL))
      .replace(/@TP/g, String(p.TP));
  }

  function logicUsesObTrend(line) {
    return /\B@OBT\b/i.test(String(line || ""));
  }

  /** trend | anti | notrend — по Regime/маркерам в строке логики. */
  function detectObTrendMode(line, logicKey) {
    const l = String(line || "");
    if (/@OBT\s*\(\s*anti\s*\)/i.test(l) || /Entry=FlatOnly/i.test(l)) return "anti";
    if (/@OBT\s*\(\s*flat\s*\)/i.test(l) || String(logicKey || "") === "L4" || /боковик/i.test(l)) return "notrend";
    return "trend";
  }

  function sumOrderBookLevels(ob, depth) {
    const d = Math.max(1, Math.min(+(depth || 0) || 5, 20));
    let bidVol = 0;
    let askVol = 0;
    for (const b of (ob?.bids || []).slice(0, d)) bidVol += Math.max(0, +(b?.quantity || 0));
    for (const a of (ob?.asks || []).slice(0, d)) askVol += Math.max(0, +(a?.quantity || 0));
    return { bidVol, askVol, total: bidVol + askVol };
  }

  function evaluateOrderBookTrend(ob, tradeSide, mode, minImb) {
    const thr = Number.isFinite(minImb) ? minImb : DEFAULT_OB_IMBALANCE;
    const { bidVol, askVol, total } = sumOrderBookLevels(ob, 5);
    if (total < 1) {
      return { ok: false, imb: 0, mode, bidVol, askVol, reason: "пустой стакан" };
    }
    const imb = (bidVol - askVol) / total;
    const buy = tradeSide === "buy";
    if (mode === "anti") {
      const ok = buy ? imb <= -thr : imb >= thr;
      return {
        ok,
        imb,
        mode,
        bidVol,
        askVol,
        reason: ok ? "анти-тренд по стакану" : `imb=${imb.toFixed(3)} (нужно ${buy ? "≤" : "≥"}${buy ? -thr : thr})`
      };
    }
    if (mode === "notrend") {
      const ok = Math.abs(imb) < thr;
      return {
        ok,
        imb,
        mode,
        bidVol,
        askVol,
        reason: ok ? "боковик по стакану" : `|imb|=${Math.abs(imb).toFixed(3)} (нужно <${thr})`
      };
    }
    const ok = buy ? imb >= thr : imb <= -thr;
    return {
      ok,
      imb,
      mode,
      bidVol,
      askVol,
      reason: ok ? "тренд по стакану" : `imb=${imb.toFixed(3)} (нужно ${buy ? "≥" : "≤"}${buy ? thr : -thr})`
    };
  }

  function stripDecor(line) {
    return String(line || "")
      .replace(/Strict\([^)]*\)\s*/gi, "")
      .replace(/Regime\([^)]*\)\s*/gi, "")
      .replace(/OnFlip\([^)]*\)/gi, "")
      .replace(/Note\([^)]*\)/gi, "")
      .replace(/@OBT\s*(\([^)]*\))?\s*/gi, "")
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
    return extractBlocks(line, tag)[0] || null;
  }

  function extractBlocks(line, tag) {
    const blocks = [];
    const scanRe = new RegExp(tag + "\\((Long|Short)\\(", "ig");
    let m = scanRe.exec(line);
    while (m) {
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
      blocks.push({ side, expr: inner.trim() });
      scanRe.lastIndex = i;
      m = scanRe.exec(line);
    }
    return blocks;
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

  function defaultIndicatorSelection() {
    const out = {};
    for (const key of INDICATOR_KEYS) out[key] = true;
    return out;
  }

  function normalizeIndicatorSelection(selection) {
    if (selection == null) return defaultIndicatorSelection();
    const out = {};
    for (const key of INDICATOR_KEYS) out[key] = false;
    if (Array.isArray(selection)) {
      for (const key of selection) {
        const k = indicatorKey(key);
        if (INDICATOR_KEY_SET.has(k)) out[k] = true;
      }
      return out;
    }
    if (typeof selection === "string") {
      return normalizeIndicatorSelection(selection.split(",").map((x) => x.trim()));
    }
    if (typeof selection === "object") {
      for (const [key, value] of Object.entries(selection)) {
        const k = indicatorKey(key);
        if (INDICATOR_KEY_SET.has(k)) out[k] = !!value;
      }
      return out;
    }
    return defaultIndicatorSelection();
  }

  function enabledIndicatorSet(selection) {
    const normalized = normalizeIndicatorSelection(selection);
    return new Set(INDICATOR_KEYS.filter((key) => normalized[key]));
  }

  function filterAtomsByIndicators(atoms, indicatorSelection) {
    const enabled = enabledIndicatorSet(indicatorSelection);
    return (atoms || []).filter((atom) => {
      const kind = indicatorKey(atom?.kind);
      return !INDICATOR_KEY_SET.has(kind) || enabled.has(kind);
    });
  }

  function isIndicatorEnabled(indicatorSelection, key) {
    return !!normalizeIndicatorSelection(indicatorSelection)[indicatorKey(key)];
  }

  function indicatorKey(kind) {
    const k = String(kind || "").toLowerCase();
    if (k === "bolinger" || k === "boll" || k === "bb" || k === "polenger") return "bollinger";
    if (k === "mom") return "momentum";
    if (k === "vwma") return "vwap";
    return k;
  }

  function parseLogicLine(line, params, indicatorSelection) {
    const raw = substituteParams(line, params || DEFAULT_PARAMS);
    const { slAtr, tpAtr } = parseSlTp(raw);
    const body = stripDecor(raw);
    const opBlocks = extractBlocks(body, "Op");
    const clBlocks = extractBlocks(body, "Cl");
    const firstOp = opBlocks[0];
    const firstCl = clBlocks[0];
    const atomsForSide = (blocks, side) => blocks
      .filter((block) => block.side === side)
      .flatMap((block) => splitTopLevelAnd(block.expr).map(parseAtom).filter(Boolean));
    const opLongAtoms = filterAtomsByIndicators(atomsForSide(opBlocks, "long"), indicatorSelection);
    const opShortAtoms = filterAtomsByIndicators(atomsForSide(opBlocks, "short"), indicatorSelection);
    const clLongAtoms = filterAtomsByIndicators(atomsForSide(clBlocks, "long"), indicatorSelection);
    const clShortAtoms = filterAtomsByIndicators(atomsForSide(clBlocks, "short"), indicatorSelection);
    return {
      slAtr,
      tpAtr,
      opSide: firstOp?.side || "long",
      clSide: firstCl?.side || firstOp?.side || "long",
      opAtoms: [...opLongAtoms, ...opShortAtoms],
      clAtoms: [...clLongAtoms, ...clShortAtoms],
      opLongAtoms,
      opShortAtoms,
      clLongAtoms,
      clShortAtoms,
      indicators: normalizeIndicatorSelection(indicatorSelection)
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

  function bollingerSeries(closes, len, devMult) {
    const up = new Array(closes.length).fill(null);
    const center = new Array(closes.length).fill(null);
    const down = new Array(closes.length).fill(null);
    for (let i = len - 1; i < closes.length; i++) {
      let sum = 0;
      for (let j = i - len + 1; j <= i; j++) sum += closes[j];
      const ma = sum / len;
      let varSum = 0;
      for (let j = i - len + 1; j <= i; j++) varSum += (closes[j] - ma) ** 2;
      const std = Math.sqrt(varSum / len);
      center[i] = ma;
      up[i] = ma + devMult * std;
      down[i] = ma - devMult * std;
    }
    return { up, center, down };
  }

  function momentumSeries(closes, len) {
    const out = new Array(closes.length).fill(null);
    for (let i = len; i < closes.length; i++) {
      out[i] = closes[i] - closes[i - len];
    }
    return out;
  }

  function vwapSeries(candles) {
    const out = new Array(candles.length).fill(null);
    let pvSum = 0;
    let volSum = 0;
    let currentDay = null;
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const day = String(c.time || "").slice(0, 10);
      if (day && day !== currentDay) {
        currentDay = day;
        pvSum = 0;
        volSum = 0;
      }
      const price = (c.high + c.low + c.close) / 3;
      const vol = Number.isFinite(c.volume) && c.volume > 0 ? c.volume : 1;
      pvSum += price * vol;
      volSum += vol;
      if (volSum > 0) out[i] = pvSum / volSum;
    }
    return out;
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
      this._bollinger = new Map();
      this._momentum = new Map();
      this._vwap = new Map();
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
    bollinger(len, dev) {
      const key = `${len};${dev}`;
      if (!this._bollinger.has(key)) this._bollinger.set(key, bollingerSeries(this.closes, len, dev));
      return this._bollinger.get(key);
    }
    momentum(len) {
      if (!this._momentum.has(len)) this._momentum.set(len, momentumSeries(this.closes, len));
      return this._momentum.get(len);
    }
    vwap() {
      if (!this._vwap.has("session")) this._vwap.set("session", vwapSeries(this.candles));
      return this._vwap.get("session");
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
    const kind = indicatorKey(atom.kind);

    if (kind === "sma") {
      const len = pm.L || parseInt(atom.params, 10) || 100;
      const v = cache.sma(len)[idx];
      if (v == null) return false;
      return evalThreshold(sigU === "AB" ? "AB" : sigU === "BL" ? "BL" : sig, v, close);
    }
    if (kind === "atr") {
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
    if (kind === "stoch") {
      const k1 = pm.K1 || 14, k2 = pm.K2 || 3, d = pm.D || 3;
      const st = cache.stoch(k1, k2, d);
      const k = st.k[idx];
      if (k == null) return false;
      return evalThreshold(sig, k, close);
    }
    if (kind === "linreg") {
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
    if (kind === "bollinger") {
      const len = pm.L || parseInt(atom.params, 10) || 20;
      const dev = parseFloat(pm.Dev || pm.dev || "2");
      const bb = cache.bollinger(len, dev);
      if (sigU === "ABUP") return bb.up[idx] != null && close > bb.up[idx];
      if (sigU === "BLLO") return bb.down[idx] != null && close < bb.down[idx];
      if (sigU === "ABLO") return bb.down[idx] != null && close > bb.down[idx];
      if (sigU === "BLUP") return bb.up[idx] != null && close < bb.up[idx];
      if (sigU === "AB" || sigU === "ABMID") return bb.center[idx] != null && close > bb.center[idx];
      if (sigU === "BL" || sigU === "BLMID") return bb.center[idx] != null && close < bb.center[idx];
      if (sigU === "SLOPEUP" || sigU === "CENTERUP") {
        const c0 = bb.center[idx - 1], c1 = bb.center[idx];
        return c0 != null && c1 != null && c1 > c0;
      }
      if (sigU === "SLOPEDN" || sigU === "CENTERDN") {
        const c0 = bb.center[idx - 1], c1 = bb.center[idx];
        return c0 != null && c1 != null && c1 < c0;
      }
      return false;
    }
    if (kind === "momentum") {
      const len = pm.L || parseInt(atom.params, 10) || 10;
      const v = cache.momentum(len)[idx];
      if (v == null) return false;
      return evalThreshold(sig, v, close);
    }
    if (kind === "vwap") {
      const v = cache.vwap()[idx];
      if (v == null) return false;
      if (sigU === "AB") return close > v;
      if (sigU === "BL") return close < v;
      if (sigU === "SLOPEUP" || sigU === "CENTERUP") {
        const p = cache.vwap()[idx - 1];
        return p != null && v > p;
      }
      if (sigU === "SLOPEDN" || sigU === "CENTERDN") {
        const p = cache.vwap()[idx - 1];
        return p != null && v < p;
      }
      return false;
    }
    if (kind === "macd") {
      const fast = pm.fast || 12, slow = pm.slow || 26, signal = pm.signal || 9;
      const md = cache.macd(fast, slow, signal);
      const m = md.macd[idx], s = md.signal[idx];
      if (m == null || s == null) return false;
      if (sigU === "MACD>SIG" || sigU === "MACD>SIG") return m > s;
      if (sigU === "MACD<SIG") return m < s;
      return false;
    }
    if (kind === "cci") {
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

  function resolveVolCommission(volConfig) {
    const cfg = volConfig?.commission;
    if (cfg != null && typeof cfg === "object" && cfg.type) {
      return normalizeCommission(cfg);
    }
    const pct = Number(volConfig?.commissionPct);
    if (Number.isFinite(pct)) {
      return normalizeCommission({ type: "Percent", value: pct });
    }
    return normalizeCommission(DEFAULT_COMMISSION);
  }

  function normalizedVolConfig(volConfig) {
    const vol = { ...DEFAULT_VOLUME, ...volConfig };
    vol.commission = resolveVolCommission(vol);
    return vol;
  }

  function commissionCost(price, volume, volConfig) {
    const vol = volConfig?.commission ? volConfig : normalizedVolConfig(volConfig);
    return tradeCommission(volume, price, vol.commission);
  }

  function pushRow(rows, candle, fields) {
    if (!candle) return;
    rows.push({
      time: candle.time,
      close: candle.close,
      ...fields
    });
  }

  function simulateNoSignalRows(candles, startIdx, endIdx, options) {
    const initial = options?.initial || {};
    const cash = initial.cash || 0;
    const pos = initial.pos || 0;
    const commissionPaid = initial.commission || 0;
    const rows = [];
    const from = Math.max(0, startIdx);
    const to = Math.min(endIdx, candles.length - 1);
    for (let i = from; i <= to; i++) {
      const price = candles[i]?.close || 0;
      pushRow(rows, candles[i], {
        buy: 0,
        sell: 0,
        posStop: null,
        cash,
        pos,
        commission: commissionPaid,
        eq: cash + pos * price
      });
    }
    const last = rows.at(-1);
    return {
      rows,
      finresp: last?.eq ?? 0,
      cash: last?.cash ?? cash,
      pos: last?.pos ?? pos,
      commission: commissionPaid,
      buys: 0,
      sells: 0
    };
  }

  function longestPack(packs) {
    if (!packs?.length) return [];
    return packs.reduce((best, p) => ((p?.length || 0) > (best?.length || 0) ? p : best), packs[0]);
  }

  function collectChartIndicators(cache, parsed, idx) {
    const ind = {};
    const atoms = [...(parsed?.opAtoms || []), ...(parsed?.clAtoms || [])];
    for (const atom of atoms) {
      const pm = parseParamsMap(atom.params);
      const kind = indicatorKey(atom.kind);
      if (kind === "sma") {
        const len = pm.L || parseInt(atom.params, 10) || 100;
        ind.sma = cache.sma(len)[idx];
      }
      if (kind === "linreg") {
        const len = pm.L || parseInt(atom.params, 10) || 20;
        const dev = parseFloat(pm.Dev || pm.dev || "2");
        const lr = cache.linreg(len, dev);
        ind.linregUp = lr.up[idx];
        ind.linregDn = lr.down[idx];
        ind.linregMid = lr.center[idx];
      }
      if (kind === "bollinger") {
        const len = pm.L || parseInt(atom.params, 10) || 20;
        const dev = parseFloat(pm.Dev || pm.dev || "2");
        const bb = cache.bollinger(len, dev);
        ind.bollingerUp = bb.up[idx];
        ind.bollingerDn = bb.down[idx];
        ind.bollingerMid = bb.center[idx];
      }
      if (kind === "vwap") {
        ind.vwap = cache.vwap()[idx];
      }
    }
    return ind;
  }

  /**
   * Сигналы одной строки логики на баре i: вход long/short (Op) и выход (Cl).
   * @returns {{ longOpHit, shortOpHit, longClHit, shortClHit }}
   */
  function logicLineBarSignals(parsed, cache, i) {
    const opLongAtoms = parsed.opLongAtoms || (parsed.opSide === "long" ? parsed.opAtoms : []);
    const opShortAtoms = parsed.opShortAtoms || (parsed.opSide === "short" ? parsed.opAtoms : []);
    const clLongAtoms = parsed.clLongAtoms || (parsed.clSide === "long" ? parsed.clAtoms : []);
    const clShortAtoms = parsed.clShortAtoms || (parsed.clSide === "short" ? parsed.clAtoms : []);
    return {
      longOpHit: evaluateExpr(opLongAtoms, cache, i),
      shortOpHit: evaluateExpr(opShortAtoms, cache, i),
      longClHit: evaluateExpr(clLongAtoms, cache, i),
      shortClHit: evaluateExpr(clShortAtoms, cache, i)
    };
  }

  /**
   * Симуляция нескольких L1…L5 на одном инструменте (стек по приоритету).
   * Порядок specs[] = порядок выбора в UI (сверху вниз).
   * На каждом баре: если позиции нет — перебор логик до первого входа;
   * если позиция открыта — SL/TP и Cl только у activeIdx (логика, открывшая сделку).
   * @param {object[]} specs — элементы resolveLogicSpec с type === "logic_line"
   */
  function simulateMultiLogicStack(candles, specs, startIdx, endIdx, volConfig, options, params) {
    const opts = options || {};
    const logicSpecs = (specs || []).filter((s) => s && s.type === "logic_line" && !s.disabled);
    if (!logicSpecs.length) return simulateNoSignalRows(candles, startIdx, endIdx, options);
    if (logicSpecs.length === 1) {
      const parsed = applySlTpParams({ ...logicSpecs[0].parsed }, params || DEFAULT_PARAMS);
      return simulateLogicLine(candles, parsed, startIdx, endIdx, volConfig, options);
    }
    const p = { ...DEFAULT_PARAMS, ...params };
    const parsedList = logicSpecs.map((s) => applySlTpParams({ ...s.parsed }, p));
    const signalCandles = opts.signalCandles || candles;
    const cache = opts.indicatorCache || new IndicatorCache(signalCandles);
    const atrLenSet = new Set(parsedList.map((x) => x.slTpAtrLen || DEFAULT_PARAMS.slTpAtrLen));
    const atrByLen = new Map([...atrLenSet].map((len) => [len, cache.atr(len)]));
    const initial = opts.initial || {};
    let pos = initial.pos || 0;
    let cash = initial.cash || 0;
    let entryPrice = initial.entryPrice ?? null;
    let commissionPaid = initial.commission || 0;
    let activeIdx = -1;
    const rows = [];
    const w = Math.max(warmupBars(), 2);
    const from = opts.skipWarmup ? Math.max(startIdx, 0) : Math.max(startIdx, w);
    const to = Math.min(endIdx, candles.length - 1);
    const barSpan = Math.max(1, to - from + 1);
    const barProgressStep = opts.yieldUi
      ? Math.max(1, Math.floor(barSpan / 24))
      : Math.max(1, Math.floor(barSpan / 48));

    const flatten = (price) => {
      if (pos === 0) return 0;
      const vol = Math.abs(pos);
      cash += pos * price;
      const comm = commissionCost(price, vol, volConfig);
      cash -= comm;
      commissionPaid += comm;
      pos = 0;
      entryPrice = null;
      activeIdx = -1;
      return vol;
    };

    for (let i = from; i <= to; i++) {
      if (typeof opts.shouldCancel === "function" && opts.shouldCancel()) break;
      const price = candles[i].close;
      let buy = 0;
      let sell = 0;
      let posStop = null;

      if (typeof opts.onProgress === "function" && (i === to || (i - from) % barProgressStep === 0)) {
        opts.onProgress(i - from + 1, barSpan, candles[i]?.time);
      }

      if (pos !== 0 && activeIdx >= 0 && activeIdx < parsedList.length) {
        const parsed = parsedList[activeIdx];
        if (parsed.slAtr > 0 || parsed.tpAtr > 0) {
          const a = atrByLen.get(parsed.slTpAtrLen || DEFAULT_PARAMS.slTpAtrLen)?.[i];
          if (a != null && a > 0 && entryPrice != null) {
            let hit = false;
            if (pos > 0) {
              if (parsed.slAtr > 0 && price <= entryPrice - parsed.slAtr * a) {
                hit = true;
                posStop = "sl";
              } else if (parsed.tpAtr > 0 && price >= entryPrice + parsed.tpAtr * a) {
                hit = true;
                posStop = "tp";
              }
            } else {
              if (parsed.slAtr > 0 && price >= entryPrice + parsed.slAtr * a) {
                hit = true;
                posStop = "sl";
              } else if (parsed.tpAtr > 0 && price <= entryPrice - parsed.tpAtr * a) {
                hit = true;
                posStop = "tp";
              }
            }
            if (hit) sell += flatten(price);
          }
        }
        if (pos !== 0) {
          const sig = logicLineBarSignals(parsed, cache, i);
          if (pos > 0 && (sig.longClHit || sig.shortOpHit)) sell += flatten(price);
          else if (pos < 0 && (sig.shortClHit || sig.longOpHit)) sell += flatten(price);
        }
      }

      if (pos === 0) {
        activeIdx = -1;
        for (let si = 0; si < parsedList.length; si++) {
          const sig = logicLineBarSignals(parsedList[si], cache, i);
          if (sig.longOpHit === sig.shortOpHit) continue;
          const lot = calcTradeVolume(price, volConfig);
          const cap = maxAbsPosition(price, volConfig);
          if (lot <= 0 || lot > cap) continue;
          pos = sig.longOpHit ? lot : -lot;
          cash -= pos * price;
          const comm = commissionCost(price, lot, volConfig);
          cash -= comm;
          commissionPaid += comm;
          entryPrice = price;
          buy = lot;
          activeIdx = si;
          break;
        }
      }

      const chartParsed = activeIdx >= 0 ? parsedList[activeIdx] : parsedList[0];
      const ind = collectChartIndicators(cache, chartParsed, i);
      pushRow(rows, candles[i], {
        ...ind,
        buy,
        sell,
        posStop,
        pos,
        cash,
        commission: commissionPaid,
        eq: cash + pos * price
      });
    }

    const last = rows.at(-1);
    return {
      rows,
      finresp: last?.eq ?? 0,
      cash: last?.cash ?? 0,
      pos: last?.pos ?? 0,
      commission: commissionPaid,
      buys: rows.reduce((s, r) => s + (r.buy || 0), 0),
      sells: rows.reduce((s, r) => s + (r.sell || 0), 0),
      entryPrice
    };
  }

  function simulateLogicLine(candles, parsed, startIdx, endIdx, volConfig, options) {
    const opts = options || {};
    const signalCandles = opts.signalCandles || candles;
    const cache = opts.indicatorCache || new IndicatorCache(signalCandles);
    const atrLen = parsed.slTpAtrLen || DEFAULT_PARAMS.slTpAtrLen;
    const atrSlTp = cache.atr(atrLen);
    const initial = opts.initial || {};
    let pos = initial.pos || 0;
    let cash = initial.cash || 0;
    let entryPrice = initial.entryPrice ?? null;
    let commissionPaid = initial.commission || 0;
    const rows = [];
    const w = Math.max(warmupBars(), 2);
    const from = opts.skipWarmup ? Math.max(startIdx, 0) : Math.max(startIdx, w);
    const to = Math.min(endIdx, candles.length - 1);

    const flatten = (price) => {
      if (pos === 0) return 0;
      const vol = Math.abs(pos);
      cash += pos * price;
      const comm = commissionCost(price, vol, volConfig);
      cash -= comm;
      commissionPaid += comm;
      pos = 0;
      entryPrice = null;
      return vol;
    };

    const barSpan = Math.max(1, to - from + 1);
    const barProgressStep = opts.yieldUi
      ? Math.max(1, Math.floor(barSpan / 24))
      : Math.max(1, Math.floor(barSpan / 48));

    for (let i = from; i <= to; i++) {
      if (typeof opts.shouldCancel === "function" && opts.shouldCancel()) break;
      const price = candles[i].close;
      let buy = 0;
      let sell = 0;

      if (typeof opts.onProgress === "function" && (i === to || (i - from) % barProgressStep === 0)) {
        opts.onProgress(i - from + 1, barSpan, candles[i]?.time);
      }

      let posStop = null;
      if (pos !== 0 && (parsed.slAtr > 0 || parsed.tpAtr > 0)) {
        const a = atrSlTp[i];
        if (a != null && a > 0 && entryPrice != null) {
          let hit = false;
          if (pos > 0) {
            if (parsed.slAtr > 0 && price <= entryPrice - parsed.slAtr * a) {
              hit = true;
              posStop = "sl";
            } else if (parsed.tpAtr > 0 && price >= entryPrice + parsed.tpAtr * a) {
              hit = true;
              posStop = "tp";
            }
          } else {
            if (parsed.slAtr > 0 && price >= entryPrice + parsed.slAtr * a) {
              hit = true;
              posStop = "sl";
            } else if (parsed.tpAtr > 0 && price <= entryPrice - parsed.tpAtr * a) {
              hit = true;
              posStop = "tp";
            }
          }
          if (hit) sell += flatten(price);
        }
      }

      const opLongAtoms = parsed.opLongAtoms || (parsed.opSide === "long" ? parsed.opAtoms : []);
      const opShortAtoms = parsed.opShortAtoms || (parsed.opSide === "short" ? parsed.opAtoms : []);
      const clLongAtoms = parsed.clLongAtoms || (parsed.clSide === "long" ? parsed.clAtoms : []);
      const clShortAtoms = parsed.clShortAtoms || (parsed.clSide === "short" ? parsed.clAtoms : []);
      const longOpHit = evaluateExpr(opLongAtoms, cache, i);
      const shortOpHit = evaluateExpr(opShortAtoms, cache, i);
      const longClHit = evaluateExpr(clLongAtoms, cache, i);
      const shortClHit = evaluateExpr(clShortAtoms, cache, i);

      if (pos > 0 && (longClHit || shortOpHit)) sell += flatten(price);
      else if (pos < 0 && (shortClHit || longOpHit)) sell += flatten(price);
      if (pos === 0 && longOpHit !== shortOpHit) {
        const lot = calcTradeVolume(price, volConfig);
        const cap = maxAbsPosition(price, volConfig);
        if (lot > 0 && lot <= cap) {
          pos = longOpHit ? lot : -lot;
          cash -= pos * price;
          const comm = commissionCost(price, lot, volConfig);
          cash -= comm;
          commissionPaid += comm;
          entryPrice = price;
          buy = lot;
        }
      }

      const ind = collectChartIndicators(cache, parsed, i);
      pushRow(rows, candles[i], {
        ...ind,
        buy,
        sell,
        posStop,
        pos,
        cash,
        commission: commissionPaid,
        eq: cash + pos * price
      });
    }

    const last = rows.at(-1);
    return {
      rows,
      finresp: last?.eq ?? 0,
      cash: last?.cash ?? 0,
      pos: last?.pos ?? 0,
      commission: commissionPaid,
      buys: rows.reduce((s, r) => s + (r.buy || 0), 0),
      sells: rows.reduce((s, r) => s + (r.sell || 0), 0),
      entryPrice
    };
  }

  function simulateSmaSpread(candles, smaLen, side, startIdx, endIdx, volConfig, options) {
    const opts = options || {};
    const signalCandles = opts.signalCandles || candles;
    const slAtr = Math.max(0, Number(opts.slAtr) || 0);
    const tpAtr = Math.max(0, Number(opts.tpAtr) || 0);
    const atrLen = Math.max(2, Number(opts.slTpAtrLen) || DEFAULT_PARAMS.slTpAtrLen);
    const useStops = slAtr > 0 || tpAtr > 0;
    const cache = opts.indicatorCache || (useStops ? new IndicatorCache(signalCandles) : null);
    const atrSlTp = useStops ? cache.atr(atrLen) : null;
    const signalCloses = signalCandles.map((c) => c.close);
    const tradeCloses = candles.map((c) => c.close);
    const sma = cache ? cache.sma(smaLen) : smaSeries(signalCloses, smaLen);
    const initial = opts.initial || {};
    let cash = initial.cash || 0;
    let pos = initial.pos || 0;
    let entryPrice = initial.entryPrice ?? null;
    let commissionPaid = initial.commission || 0;
    let buys = 0;
    let sells = 0;
    const rows = [];
    const capAt = (price) => maxAbsPosition(price, volConfig);
    const from = Math.max(0, startIdx);
    const to = Math.min(endIdx, candles.length - 1);
    const barSpan = Math.max(1, to - from + 1);
    const barProgressStep = opts.yieldUi
      ? Math.max(1, Math.floor(barSpan / 24))
      : Math.max(1, Math.floor(barSpan / 48));

    for (let i = from; i <= to; i++) {
      const candle = candles[i];
      if (!candle) continue;
      if (typeof opts.onProgress === "function" && (i === to || (i - from) % barProgressStep === 0)) {
        opts.onProgress(i - from + 1, barSpan, candles[i]?.time);
      }
      const price = tradeCloses[i];
      const signalPrice = signalCloses[i];
      const s = sma[i];
      let buy = 0;
      let sell = 0;
      let posStop = null;
      const posBefore = pos;

      if (useStops && pos !== 0 && entryPrice != null) {
        const a = atrSlTp[i];
        if (a != null && a > 0) {
          let hit = false;
          if (pos > 0) {
            if (slAtr > 0 && price <= entryPrice - slAtr * a) {
              hit = true;
              posStop = "sl";
            } else if (tpAtr > 0 && price >= entryPrice + tpAtr * a) {
              hit = true;
              posStop = "tp";
            }
          } else {
            if (slAtr > 0 && price >= entryPrice + slAtr * a) {
              hit = true;
              posStop = "sl";
            } else if (tpAtr > 0 && price <= entryPrice - tpAtr * a) {
              hit = true;
              posStop = "tp";
            }
          }
          if (hit) {
            cash += pos * price;
            const comm = commissionCost(price, Math.abs(pos), volConfig);
            cash -= comm;
            commissionPaid += comm;
            sells += Math.abs(pos);
            pos = 0;
            entryPrice = null;
          }
        }
      }

      if (s != null) {
        const d = signalPrice - s;
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
        const comm = commissionCost(price, buy + sell, volConfig);
        cash -= comm;
        commissionPaid += comm;
        pos += buy - sell;
        buys += buy;
        sells += sell;
      }

      if (pos === 0) {
        entryPrice = null;
      } else if (posBefore === 0 || Math.sign(pos) !== Math.sign(posBefore)) {
        entryPrice = price;
      }

      rows.push({
        time: candle.time,
        close: price,
        sma: s,
        buy,
        sell,
        posStop,
        cash,
        pos,
        commission: commissionPaid,
        eq: cash + pos * (price || 0)
      });
    }
    const last = rows.at(-1);
    return {
      rows,
      finresp: last?.eq ?? 0,
      cash: last?.cash ?? 0,
      pos: last?.pos ?? 0,
      commission: commissionPaid,
      buys,
      sells,
      entryPrice
    };
  }

  function applySlTpParams(parsed, params) {
    const p = { ...DEFAULT_PARAMS, ...params };
    parsed.slAtr = Math.max(0, Number(p.SL) || 0);
    parsed.tpAtr = Math.max(0, Number(p.TP) || 0);
    parsed.slTpAtrLen = Math.max(2, Number(p.slTpAtrLen) || DEFAULT_PARAMS.slTpAtrLen);
    return parsed;
  }

  /**
   * Одна встроенная или пользовательская логика → spec для runOnCandles.
   * @param {string} logicId — id из BUILTIN_META (L1…L5, sma_below, …)
   */
  function resolveLogicSpec(logicId, customLines, params, indicatorSelection) {
    const meta = BUILTIN_META.find((m) => m.id === logicId);
    if (!meta) return null;
    const p = { ...DEFAULT_PARAMS, ...params };
    if (meta.type === "sma_spread") {
      return {
        type: "sma_spread",
        smaLen: meta.smaLen,
        side: meta.side,
        slAtr: Math.max(0, Number(p.SL) || 0),
        tpAtr: Math.max(0, Number(p.TP) || 0),
        slTpAtrLen: Math.max(2, Number(p.slTpAtrLen) || DEFAULT_PARAMS.slTpAtrLen),
        disabled: !isIndicatorEnabled(indicatorSelection, "sma"),
        indicators: normalizeIndicatorSelection(indicatorSelection)
      };
    }
    const line = substituteParams(customLines[meta.key] || DEFAULT_LOGIC_LINES[meta.key], p);
    const parsed = applySlTpParams(parseLogicLine(line, p, indicatorSelection), p);
    return { type: "logic_line", parsed, line, logicId: meta.id };
  }

  /**
   * Несколько выбранных логик → один spec.
   * 2+ logic_line → { type: "multi_logic", specs, logicIds };
   * одна логика или SMA → обычный spec (sma_spread / logic_line).
   * SMA не смешивается в стек с L1…L5 — при нескольких id берётся первая допустимая одиночная.
   */
  function resolveLogicSpecStack(logicIds, customLines, params, indicatorSelection) {
    const ids = (Array.isArray(logicIds) ? logicIds : [logicIds]).map(String).filter(Boolean);
    if (!ids.length) return null;
    const specs = ids.map((id) => resolveLogicSpec(id, customLines, params, indicatorSelection)).filter(Boolean);
    if (!specs.length) return null;
    const logicSpecs = specs.filter((s) => s.type === "logic_line" && !s.disabled);
    if (specs.length === 1) return specs[0];
    if (logicSpecs.length >= 2) {
      return { type: "multi_logic", specs: logicSpecs, logicIds: logicSpecs.map((s) => s.logicId).filter(Boolean) };
    }
    return specs[0];
  }

  /**
   * Прогон spec по одному ряду свечей (один инструмент, окно startIdx…endIdx).
   * multi_logic → simulateMultiLogicStack; logic_line → simulateLogicLine; sma_spread → simulateSmaSpread.
   */
  function runOnCandles(candles, spec, startIdx, endIdx, params, volConfig, options) {
    if (!candles?.length) {
      return { rows: [], finresp: 0, cash: 0, pos: 0, commission: 0, buys: 0, sells: 0, entryPrice: null };
    }
    if (!spec || spec.disabled) return simulateNoSignalRows(candles, startIdx, endIdx, options);
    const vol = normalizedVolConfig(volConfig);
    if (spec.type === "multi_logic") {
      return simulateMultiLogicStack(candles, spec.specs, startIdx, endIdx, vol, options, params);
    }
    if (spec.type === "sma_spread") {
      return simulateSmaSpread(candles, spec.smaLen, spec.side, startIdx, endIdx, vol, {
        ...options,
        slAtr: spec.slAtr,
        tpAtr: spec.tpAtr,
        slTpAtrLen: spec.slTpAtrLen
      });
    }
    const parsed = applySlTpParams({ ...spec.parsed }, params || DEFAULT_PARAMS);
    return simulateLogicLine(candles, parsed, startIdx, endIdx, vol, options);
  }

  async function runOnCandlesYielding(candles, spec, startIdx, endIdx, params, volConfig, options) {
    const opts = options || {};
    const a = startIdx;
    const b = endIdx;
    const span = Math.max(1, b - a + 1);
    if (!candles?.length || b < a) {
      return { rows: [], finresp: 0, cash: 0, pos: 0, commission: 0, buys: 0, sells: 0, entryPrice: null };
    }

    const signalCandles = opts.signalCandles || candles;
    const indicatorCache = opts.indicatorCache || new IndicatorCache(signalCandles);
    const chunkSize = yieldChunkSize(span);
    let initial = { ...(opts.initial || {}) };
    const allRows = [];
    let buys = 0;
    let sells = 0;
    let commission = 0;
    let first = true;

    for (let ca = a; ca <= b; ca += chunkSize) {
      if (typeof opts.shouldCancel === "function" && opts.shouldCancel()) break;
      const cb = Math.min(b, ca + chunkSize - 1);
      const chunkOpts = {
        ...opts,
        signalCandles,
        indicatorCache,
        yieldUi: !!opts.yieldUi,
        initial,
        skipWarmup: !first || opts.skipWarmup,
        onProgress: typeof opts.onProgress === "function"
          ? (doneInChunk, chunkSpan, candleTime) => {
            const doneInRange = (ca - a) + Math.max(0, Math.min(chunkSpan, doneInChunk));
            opts.onProgress(doneInRange, span, candleTime);
          }
          : null
      };
      const r = runOnCandles(candles, spec, ca, cb, params, volConfig, chunkOpts);
      if (r.rows?.length) allRows.push(...r.rows);
      buys += r.buys || 0;
      sells += r.sells || 0;
      commission = r.commission ?? commission;
      const last = r.rows?.at(-1);
      if (last) {
        initial = {
          cash: last.cash,
          pos: last.pos,
          commission: last.commission,
          entryPrice: r.entryPrice ?? initial.entryPrice ?? null
        };
      }
      const doneInRange = cb - a + 1;
      if (typeof opts.onProgress === "function") {
        opts.onProgress(doneInRange, span, candles[cb]?.time);
      }
      if (opts.yieldUi) await delay(0);
      first = false;
    }

    const last = allRows.at(-1);
    return {
      rows: allRows,
      finresp: last?.eq ?? 0,
      cash: last?.cash ?? 0,
      pos: last?.pos ?? 0,
      commission,
      buys,
      sells,
      entryPrice: initial.entryPrice ?? null
    };
  }

  function findCandleIndexByTime(candles, time) {
    if (!candles?.length || !time) return -1;
    return candles.findIndex((c) => c.time === time);
  }

  function findCandleIndexAtOrBefore(candles, time) {
    if (!candles?.length || !time) return -1;
    let idx = -1;
    for (let i = 0; i < candles.length; i++) {
      const t = candles[i]?.time;
      if (!t) continue;
      if (t <= time) idx = i;
      else break;
    }
    return idx;
  }

  function indicesForTimeRange(candles, tStart, tEnd) {
    if (!candles?.length || !tStart || !tEnd) return null;
    let a = -1;
    let b = -1;
    for (let i = 0; i < candles.length; i++) {
      const t = candles[i]?.time;
      if (!t) continue;
      if (t < tStart) continue;
      if (t > tEnd) break;
      if (a < 0) a = i;
      b = i;
    }
    if (a < 0 || b < a) return null;
    return { a, b };
  }

  function findRowIdxAtOrBefore(rows, time) {
    if (!rows?.length || !time) return -1;
    let idx = -1;
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i]?.time) continue;
      if (rows[i].time <= time) idx = i;
      else break;
    }
    return idx;
  }

  function equityAtTime(perSecItem, time) {
    const idx = findRowIdxAtOrBefore(perSecItem.rows, time);
    return idx >= 0 ? perSecItem.rows[idx].eq : 0;
  }

  /**
   * Оптимизация stopper (вариант 1): equity одного инструмента на каждую свечу times[].
   * Два указателя по отсортированным rows/time — O(rows + times), без повторного линейного поиска
   * equityAtTime на каждой итерации цикла stopper × каждый инструмент.
   */
  function buildPerSecEquitySeries(rows, times) {
    if (!times?.length) return [];
    if (!rows?.length) return times.map(() => 0);
    const out = new Array(times.length);
    let rowIdx = -1;
    let lastEq = 0;
    for (let t = 0; t < times.length; t++) {
      const time = times[t];
      while (rowIdx + 1 < rows.length && rows[rowIdx + 1].time <= time) {
        rowIdx += 1;
        lastEq = rows[rowIdx].eq;
      }
      out[t] = rowIdx >= 0 ? lastEq : 0;
    }
    return out;
  }

  /** Суммарная equity портфеля и ряды по инструментам — для быстрого сканирования stopper. */
  function buildPortfolioEquitySeries(perSec, times) {
    if (!perSec?.length || !times?.length) {
      return { total: [], perInstrument: [] };
    }
    const perInstrument = perSec.map((p) => buildPerSecEquitySeries(p.rows, times));
    const total = times.map((_, t) => {
      let sum = 0;
      for (let s = 0; s < perInstrument.length; s++) sum += perInstrument[s][t] || 0;
      return sum;
    });
    return { total, perInstrument };
  }

  function buildPortfolioEquityRows(perSec, times) {
    if (!perSec?.length || !times?.length) return [];
    const { total } = buildPortfolioEquitySeries(perSec, times);
    return times.map((time, i) => ({ time, eq: total[i] }));
  }

  function portfolioEquityAtr(history, index, length) {
    if (!history?.length || index < length) return null;
    let sum = 0;
    for (let i = index - length + 1; i <= index; i++) {
      const cur = history[i];
      const prev = history[i - 1];
      if (!cur || !prev) return null;
      sum += Math.abs(cur.equity - prev.equity);
    }
    return sum / length;
  }

  function recomputePerSecTotals(perSecItem) {
    const last = perSecItem.rows.at(-1);
    perSecItem.finresp = last?.eq ?? 0;
    perSecItem.cash = last?.cash ?? 0;
    perSecItem.pos = last?.pos ?? 0;
    perSecItem.commission = last?.commission ?? 0;
    perSecItem.buys = perSecItem.rows.reduce((s, r) => s + (r.buy || 0), 0);
    perSecItem.sells = perSecItem.rows.reduce((s, r) => s + (r.sell || 0), 0);
  }

  function flattenRowAtIdx(perSecItem, rowIdx, volConfig) {
    const row = { ...perSecItem.rows[rowIdx] };
    if (row.pos !== 0) {
      const price = row.close;
      row.sell = (row.sell || 0) + Math.abs(row.pos);
      row.cash += row.pos * price;
      const comm = commissionCost(price, Math.abs(row.pos), volConfig);
      row.cash -= comm;
      row.commission = (row.commission || 0) + comm;
      row.pos = 0;
      row.eq = row.cash;
    }
    return row;
  }

  function flattenAndResimTail(perSecItem, candles, spec, triggerTime, endTime, params, volConfig, runOptions) {
    const rowIdx = findRowIdxAtOrBefore(perSecItem.rows, triggerTime);
    if (rowIdx < 0) return;
    const triggerRow = flattenRowAtIdx(perSecItem, rowIdx, volConfig);
    const head = perSecItem.rows.slice(0, rowIdx);
    const localEnd = findCandleIndexAtOrBefore(candles, endTime);
    if (localEnd < 0) {
      perSecItem.rows = [...head, triggerRow];
      recomputePerSecTotals(perSecItem);
      return;
    }
    const candleIdx = findCandleIndexAtOrBefore(candles, triggerTime);
    if (candleIdx < 0 || candleIdx >= localEnd) {
      perSecItem.rows = [...head, triggerRow];
      recomputePerSecTotals(perSecItem);
      return;
    }
    const initial = {
      pos: 0,
      cash: triggerRow.cash,
      entryPrice: null,
      commission: triggerRow.commission || 0
    };
    // Оптимизация stopper (вариант 2): indicatorCache с первого FINRESP-прохода —
    // ряды SMA/Stoch/ATR/… уже в памяти, хвост после триггера не пересчитывает индикаторы с нуля.
    const tail = runOnCandles(
      candles,
      spec,
      candleIdx + 1,
      localEnd,
      params,
      volConfig,
      { initial, skipWarmup: true, ...(runOptions || {}) }
    );
    perSecItem.rows = [...head, triggerRow, ...tail.rows];
    recomputePerSecTotals(perSecItem);
  }

  function applyPortfolioStopper(perSec, packs, spec, times, endTime, params, volConfig, cfg, signalPacks, progressOpts) {
    const stopper = { ...DEFAULT_STOPPER, ...cfg };
    const events = [];
    const onProgress = progressOpts?.onProgress;
    const stopperTotal = Math.max(1, times?.length || 1);
    if ((!stopper.useSl && !stopper.useTp) || !perSec.length || !packs.length) {
      return { perSec, stopper: { events } };
    }

    if (!times?.length) return { perSec, stopper: { events } };

    let referenceEquity = stopper.refEquity > 0 ? stopper.refEquity : null;
    let scanFrom = 0;
    const equityHistory = [];
    let stopperStep = 0;
    // Предрасчёт equity по всем инструментам; после триггера пересобираем (rows меняются).
    let portfolioEq = buildPortfolioEquitySeries(perSec, times);

    while (scanFrom < times.length) {
      let triggered = false;

      for (let t = scanFrom; t < times.length; t++) {
        if (typeof progressOpts?.shouldCancel === "function" && progressOpts.shouldCancel()) {
          return { perSec, stopper: { events, referenceEquity, cancelled: true } };
        }
        const time = times[t];
        stopperStep = Math.min(stopperTotal, stopperStep + 1);
        if (onProgress) onProgress(stopperStep, stopperTotal, time);
        const totalEq = portfolioEq.total[t] ?? 0;

        if (referenceEquity == null) referenceEquity = totalEq;
        equityHistory.push({ equity: totalEq, time });
        const idx = equityHistory.length - 1;
        const atrLen = Math.max(1, stopper.atrLen || DEFAULT_STOPPER.atrLen);
        if (idx < atrLen) continue;

        const atr = portfolioEquityAtr(equityHistory, idx, atrLen);
        if (atr == null || atr <= 0) continue;

        let kind = null;
        let triggerLevel = referenceEquity;
        if (stopper.useSl && stopper.slMult > 0 && totalEq <= referenceEquity - stopper.slMult * atr) {
          kind = "sl";
          triggerLevel = referenceEquity - stopper.slMult * atr;
        } else if (stopper.useTp && stopper.tpMult > 0 && totalEq >= referenceEquity + stopper.tpMult * atr) {
          kind = "tp";
          triggerLevel = referenceEquity + stopper.tpMult * atr;
        }
        if (!kind) continue;

        const refAtTrigger = referenceEquity;
        for (let s = 0; s < perSec.length; s++) {
          const runOptions = {
            ...(signalPacks?.[s] ? { signalCandles: signalPacks[s] } : {}),
            ...(perSec[s].indicatorCache ? { indicatorCache: perSec[s].indicatorCache } : {})
          };
          flattenAndResimTail(perSec[s], packs[s], spec, time, endTime, params, volConfig, runOptions);
        }
        events.push({
          kind,
          time,
          equity: totalEq,
          referenceEquity: refAtTrigger,
          atr,
          triggerLevel
        });
        portfolioEq = buildPortfolioEquitySeries(perSec, times);
        referenceEquity = portfolioEq.total[t] ?? totalEq;
        scanFrom = t + 1;
        triggered = true;
        break;
      }
      if (!triggered) break;
    }

    return { perSec, stopper: { events, referenceEquity } };
  }

  function moexFileProtocolHint() {
    if (typeof location !== "undefined" && location.protocol === "file:") {
      return " Страница открыта как file:// — браузер блокирует MOEX (CORS). "
        + "Запустите serve-calculator.ps1 в этой папке или откройте через GitHub Pages / http://localhost.";
    }
    return "";
  }

  async function moexFetchJson(url, context, timeoutMs = 45000) {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const r = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
      if (!r.ok) throw new Error(`MOEX HTTP ${r.status}${context ? ` (${context})` : ""}`);
      return r.json();
    } catch (err) {
      const msg = err?.message || String(err);
      if (err?.name === "AbortError") {
        throw new Error(`MOEX: таймаут ${Math.round(timeoutMs / 1000)} с${context ? ` (${context})` : ""}.${moexFileProtocolHint()}`);
      }
      if (/Failed to fetch|NetworkError|Load failed|Network request failed/i.test(msg)) {
        throw new Error(`MOEX недоступен (сеть/CORS): ${msg}.${moexFileProtocolHint()}`);
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function candlesUrl(sec, market) {
    if (market === "futures") {
      return `https://iss.moex.com/iss/engines/futures/markets/forts/securities/${sec}/candles.json`;
    }
    return `https://iss.moex.com/iss/engines/stock/markets/shares/securities/${sec}/candles.json`;
  }

  async function fetchIssSecIds(baseUrl, columns, filterFn) {
    const ids = [];
    const seen = new Set();
    let start = 0;
    while (true) {
      const url = new URL(baseUrl);
      url.searchParams.set("iss.meta", "off");
      if (columns) url.searchParams.set("securities.columns", columns);
      url.searchParams.set("start", String(start));
      const data = await moexFetchJson(url, "securities");
      const chunk = data?.securities?.data || [];
      const cols = data?.securities?.columns || [];
      if (!chunk.length) break;
      for (const row of chunk) {
        const obj = Object.fromEntries(cols.map((c, i) => [c, row[i]]));
        if (filterFn && !filterFn(obj)) continue;
        const id = obj.SECID;
        if (id && !seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
      if (chunk.length < 100) break;
      start += chunk.length;
      if (start > 20000) break;
    }
    return ids.sort();
  }

  function listShareTickers(stockPrefixesRaw) {
    return parseTickerPrefixes(stockPrefixesRaw || DEFAULT_STOCK_TICKERS_RAW);
  }

  async function fetchShareList(stockPrefixesRaw) {
    return listShareTickers(stockPrefixesRaw);
  }

  function listFuturesPrefixes(futuresPrefixesRaw) {
    return parseTickerPrefixes(futuresPrefixesRaw || DEFAULT_FUTURES_PREFIXES_RAW);
  }

  async function fetchFuturesList(futuresPrefixesRaw, period) {
    const prefixes = parseTickerPrefixes(futuresPrefixesRaw || DEFAULT_FUTURES_PREFIXES_RAW);
    if (!prefixes.length) return [];
    const today = new Date().toISOString().slice(0, 10);
    const from = normMoexDate(period?.from) || today;
    const till = normMoexDate(period?.till) || from;
    return fetchIssSecIds(
      "https://iss.moex.com/iss/engines/futures/markets/forts/securities.json",
      "SECID,ASSETCODE,LASTTRADEDATE,FIRSTTRADEDATE,BOARDID",
      (o) => o.BOARDID === "RFUD"
        && o.ASSETCODE
        && futuresTickerMatches(o.SECID, prefixes)
        && futuresMatchesCalcPeriod(o, from, till)
    );
  }

  function isFullFuturesSecid(secid) {
    const s = String(secid || "").trim();
    if (!s) return false;
    if (isPerpetualFuture(s)) return true;
    return /-\d/.test(s) || /\d/.test(s.slice(-2));
  }

  async function expandFuturesSelection(selectedSecs, futuresPrefixesRaw, period) {
    const selected = new Set((selectedSecs || []).map((s) => String(s || "").trim()).filter(Boolean));
    if (!selected.size) return [];
    const all = await fetchFuturesList(futuresPrefixesRaw, period);
    const prefixList = listFuturesPrefixes(futuresPrefixesRaw);
    const allPrefixesSelected = prefixList.length > 0
      && prefixList.every((p) => selected.has(p))
      && selected.size === prefixList.length;
    if (allPrefixesSelected) return all;
    const out = new Set();
    for (const sec of all) {
      if (selected.has(sec)) {
        out.add(sec);
        continue;
      }
      for (const sel of selected) {
        if (isFullFuturesSecid(sel)) continue;
        if (futuresTickerMatches(sec, [sel])) {
          out.add(sec);
          break;
        }
      }
    }
    for (const sel of selected) {
      if (isFullFuturesSecid(sel)) out.add(sel);
    }
    return [...out].sort();
  }

  async function resolveFuturesMoexSec(secOrPrefix, period) {
    const key = String(parseTickerPrefixes(secOrPrefix)[0] || "").trim();
    if (!key) return null;
    if (isFullFuturesSecid(key)) return key;
    const today = new Date().toISOString().slice(0, 10);
    const from = normMoexDate(period?.from) || today;
    const till = normMoexDate(period?.till) || from;
    const keyUpper = key.toUpperCase();
    let exact = null;
    let front = null;
    let start = 0;
    while (true) {
      const url = new URL("https://iss.moex.com/iss/engines/futures/markets/forts/securities.json");
      url.searchParams.set("iss.meta", "off");
      url.searchParams.set("securities.columns", "SECID,ASSETCODE,LASTTRADEDATE,FIRSTTRADEDATE,BOARDID");
      url.searchParams.set("start", String(start));
      const data = await moexFetchJson(url, key);
      const chunk = data?.securities?.data || [];
      const cols = data?.securities?.columns || [];
      if (!chunk.length) break;
      for (const row of chunk) {
        const o = Object.fromEntries(cols.map((c, i) => [c, row[i]]));
        if (o.BOARDID !== "RFUD" || !o.ASSETCODE) continue;
        if (!futuresMatchesCalcPeriod(o, from, till)) continue;
        const secid = String(o.SECID || "");
        if (secid.toUpperCase() !== keyUpper && !futuresTickerMatches(secid, [key])) continue;
        if (secid.toUpperCase() === keyUpper) exact = o;
        if (!front || String(o.LASTTRADEDATE) < String(front.LASTTRADEDATE)) front = o;
      }
      if (chunk.length < 100) break;
      start += chunk.length;
      if (start > 20000) break;
    }
    return exact?.SECID || front?.SECID || null;
  }

  async function resolveFuturesContract(secOrPrefix, period) {
    return resolveFuturesMoexSec(secOrPrefix, period);
  }

  const AGGREGATED_INTERVALS = {
    "5": { moexInterval: "1", minutes: 5 },
    "15": { moexInterval: "1", minutes: 15 }
  };

  function resolveIntervalLoad(interval) {
    const key = String(interval);
    const agg = AGGREGATED_INTERVALS[key];
    if (agg) {
      return { cacheInterval: key, moexInterval: agg.moexInterval, aggMinutes: agg.minutes };
    }
    return { cacheInterval: key, moexInterval: key, aggMinutes: 0 };
  }

  function aggregateCandles(candles, minutes) {
    if (!candles?.length || minutes <= 1) return candles || [];
    const ms = minutes * 60 * 1000;
    const buckets = new Map();
    for (const c of candles) {
      const t = new Date(String(c.time).replace(" ", "T")).getTime();
      if (!Number.isFinite(t)) continue;
      const key = Math.floor(t / ms);
      let b = buckets.get(key);
      if (!b) {
        buckets.set(key, {
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          time: c.time,
          sec: c.sec,
          market: c.market,
          key
        });
      } else {
        b.high = Math.max(b.high, c.high);
        b.low = Math.min(b.low, c.low);
        b.close = c.close;
        b.volume += c.volume;
        b.time = c.time;
      }
    }
    return [...buckets.values()]
      .sort((a, b) => a.key - b.key)
      .map(({ key, ...rest }) => rest);
  }

  async function loadMoexCandles(sec, from, till, interval, market = "shares") {
    const all = [];
    let start = 0;
    while (true) {
      const url = new URL(candlesUrl(sec, market));
      url.search = new URLSearchParams({ from, till, interval, start: String(start) }).toString();
      const data = await moexFetchJson(url, sec);
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
        sec,
        market
      }));
  }

  async function loadMoexCandlesResolved(sec, from, till, interval, market = "shares") {
    const { moexInterval, aggMinutes } = resolveIntervalLoad(interval);
    const raw = await loadMoexCandles(sec, from, till, moexInterval, market);
    return aggMinutes > 1 ? aggregateCandles(raw, aggMinutes) : raw;
  }

  function quotationToNumber(q) {
    if (!q) return 0;
    return Number(q.units ?? 0) + Number(q.nano ?? 0) / 1e9;
  }

  function tbankTimeToMs(time) {
    if (!time) return NaN;
    if (typeof time === "string") return new Date(time).getTime();
    if (time.seconds != null) {
      return Number(time.seconds) * 1000 + Math.floor(Number(time.nanos || 0) / 1e6);
    }
    return NaN;
  }

  function formatCandleTimeMsk(ms) {
    if (!Number.isFinite(ms)) return "";
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Moscow",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).formatToParts(new Date(ms));
    const g = (t) => parts.find((p) => p.type === t)?.value || "00";
    return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`;
  }

  function tbankIntervalForCalcTf(tf) {
    const map = {
      "1": "CANDLE_INTERVAL_1_MIN",
      "5": "CANDLE_INTERVAL_5_MIN",
      "10": "CANDLE_INTERVAL_10_MIN",
      "15": "CANDLE_INTERVAL_15_MIN",
      "60": "CANDLE_INTERVAL_HOUR",
      "24": "CANDLE_INTERVAL_DAY"
    };
    return map[String(tf)] || "CANDLE_INTERVAL_HOUR";
  }

  function tbankCandleChunkDays(tf) {
    if (String(tf) === "24") return 365;
    if (String(tf) === "60") return 7;
    return 1;
  }

  function liveTbankTailHours(tf) {
    const map = { "1": 8, "5": 24, "10": 36, "15": 48, "60": 168, "24": 720 };
    return map[String(tf)] || 24;
  }

  function parseTbankHistoricCandles(candles, sec, market) {
    const out = [];
    for (const c of candles || []) {
      const ms = tbankTimeToMs(c.time);
      if (!Number.isFinite(ms)) continue;
      out.push({
        open: quotationToNumber(c.open),
        high: quotationToNumber(c.high),
        low: quotationToNumber(c.low),
        close: quotationToNumber(c.close),
        volume: Number(c.volume ?? 0),
        time: formatCandleTimeMsk(ms),
        sec,
        market
      });
    }
    return out.sort((a, b) => a.time.localeCompare(b.time));
  }

  const CANDLE_CACHE_VERSION = 2;
  const CANDLE_CACHE_DB_NAME = "MultiLogicFinrespCandlesDB";
  const CANDLE_CACHE_STORE = "candles";

  function cacheNormDay(value) {
    if (!value) return "";
    return String(value).slice(0, 10);
  }

  function mergeCandleSeries(existing, incoming) {
    const map = new Map();
    for (const c of existing || []) {
      if (c?.time) map.set(c.time, c);
    }
    for (const c of incoming || []) {
      if (c?.time) map.set(c.time, { ...c });
    }
    return [...map.values()].sort((a, b) => String(a.time).localeCompare(String(b.time)));
  }

  function createCandleCache(options) {
    const dbName = options?.dbName || CANDLE_CACHE_DB_NAME;
    const storeName = options?.storeName || CANDLE_CACHE_STORE;
    let dbPromise = null;
    let cachedStats = {
      entries: 0,
      bars: 0,
      usage: null,
      quota: null,
      storage: "IndexedDB",
      dbName,
      ready: false
    };

    function requireIndexedDb() {
      if (typeof indexedDB === "undefined") {
        throw new Error("IndexedDB недоступен в этом браузере");
      }
    }

    function openDb() {
      if (dbPromise) return dbPromise;
      requireIndexedDb();
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName, CANDLE_CACHE_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(storeName)) {
            db.createObjectStore(storeName, { keyPath: "key" });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
        req.onblocked = () => reject(new Error("IndexedDB заблокирован другой вкладкой"));
      }).catch((err) => {
        dbPromise = null;
        throw err;
      });
      return dbPromise;
    }

    function txStore(db, mode) {
      return db.transaction(storeName, mode).objectStore(storeName);
    }

    function requestPromise(req) {
      return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("IndexedDB request failed"));
      });
    }

    function txDone(tx) {
      return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
        tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
      });
    }

    function entryKey(market, sec, interval) {
      return `${market}:${String(sec || "").trim().toUpperCase()}:${String(interval)}`;
    }

    function entryCoverage(entry) {
      if (!entry?.candles?.length) return null;
      return {
        from: cacheNormDay(entry.candles[0].time),
        till: cacheNormDay(entry.candles.at(-1).time)
      };
    }

    function entryCovers(entry, from, till) {
      const cov = entryCoverage(entry);
      if (!cov) return false;
      return cov.from <= cacheNormDay(from) && cov.till >= cacheNormDay(till);
    }

    function filterCandlesByRange(candles, from, till) {
      const f = cacheNormDay(from);
      const t = cacheNormDay(till);
      return candles.filter((c) => {
        const d = cacheNormDay(c.time);
        return d >= f && d <= t;
      });
    }

    function clonePack(candles, requestedSec, market) {
      return candles.map((c) => ({ ...c, sec: requestedSec, market }));
    }

    async function estimateStorage() {
      if (typeof navigator === "undefined" || !navigator.storage?.estimate) return;
      try {
        const est = await navigator.storage.estimate();
        cachedStats = {
          ...cachedStats,
          usage: Number.isFinite(est.usage) ? est.usage : null,
          quota: Number.isFinite(est.quota) ? est.quota : null
        };
      } catch (_) { /* estimate is optional */ }
    }

    async function recomputeStats() {
      const db = await openDb();
      let entriesCount = 0;
      let bars = 0;
      await new Promise((resolve, reject) => {
        const req = txStore(db, "readonly").openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            resolve();
            return;
          }
          const entry = cursor.value;
          entriesCount += 1;
          bars += entry?.candles?.length || 0;
          cursor.continue();
        };
        req.onerror = () => reject(req.error || new Error("IndexedDB cursor failed"));
      });
      cachedStats = { ...cachedStats, entries: entriesCount, bars, ready: true };
      await estimateStorage();
    }

    async function getEntry(key) {
      const db = await openDb();
      return requestPromise(txStore(db, "readonly").get(key));
    }

    async function putEntry(entry) {
      const db = await openDb();
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(entry);
      await txDone(tx);
    }

    function normalizeEntryForExport(entry) {
      if (!entry) return null;
      const { key, ...rest } = entry;
      return rest;
    }

    return {
      async load() {
        await recomputeStats();
      },
      async get(requestedSec, market, interval, from, till, altSec) {
        const keys = [entryKey(market, requestedSec, interval)];
        if (altSec) keys.push(entryKey(market, altSec, interval));
        for (const key of keys) {
          const entry = await getEntry(key);
          if (!entry || String(entry.interval) !== String(interval)) continue;
          if (!entryCovers(entry, from, till)) continue;
          const filtered = filterCandlesByRange(entry.candles, from, till);
          if (!filtered.length) continue;
          return clonePack(filtered, requestedSec, market);
        }
        return null;
      },
      async put(requestedSec, market, interval, moexSec, candles) {
        if (!candles?.length) return;
        const key = entryKey(market, requestedSec, interval);
        const normalized = candles.map((c) => ({
          ...c,
          sec: moexSec || requestedSec,
          market
        }));
        const existing = await getEntry(key);
        const oldBars = existing?.candles?.length || 0;
        const merged = mergeCandleSeries(existing?.candles, normalized);
        await putEntry({
          key,
          requestedSec,
          moexSec: moexSec || requestedSec,
          market,
          interval: String(interval),
          candles: merged,
          updatedAt: new Date().toISOString()
        });
        cachedStats = {
          ...cachedStats,
          entries: cachedStats.entries + (existing ? 0 : 1),
          bars: cachedStats.bars - oldBars + merged.length,
          ready: true
        };
        estimateStorage();
      },
      async clear() {
        const db = await openDb();
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).clear();
        await txDone(tx);
        cachedStats = { ...cachedStats, entries: 0, bars: 0, ready: true };
        await estimateStorage();
      },
      async exportJson() {
        const db = await openDb();
        const entries = {};
        await new Promise((resolve, reject) => {
          const req = txStore(db, "readonly").openCursor();
          req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) {
              resolve();
              return;
            }
            entries[cursor.key] = normalizeEntryForExport(cursor.value);
            cursor.continue();
          };
          req.onerror = () => reject(req.error || new Error("IndexedDB export failed"));
        });
        return JSON.stringify({
          version: CANDLE_CACHE_VERSION,
          entries,
          exportedAt: new Date().toISOString()
        });
      },
      async importJson(jsonStr, merge = true) {
        const data = typeof jsonStr === "string" ? JSON.parse(jsonStr) : jsonStr;
        if (!data?.entries || (data.version !== 1 && data.version !== CANDLE_CACHE_VERSION)) {
          throw new Error("Неверный формат файла базы цен");
        }
        if (!merge) await this.clear();
        for (const [key, entry] of Object.entries(data.entries)) {
          if (!entry?.candles?.length) continue;
          const existing = merge ? await getEntry(key) : null;
          if (existing?.candles?.length) {
            await putEntry({
              ...existing,
              ...entry,
              key,
              candles: mergeCandleSeries(existing.candles, entry.candles)
            });
          } else {
            await putEntry({ ...entry, key });
          }
        }
        await recomputeStats();
        return cachedStats.entries;
      },
      stats() {
        return { ...cachedStats };
      }
    };
  }

  async function loadInstrumentSec(sec, from, till, interval, market, cache, options) {
    const opts = options || {};
    const requestedSec = sec;
    try {
      let moexSec = sec;
      if (market === "futures") {
        moexSec = await resolveFuturesContract(sec, { from, till });
        if (!moexSec) {
          return { ok: false, error: "нет активного контракта MOEX для префикса", requestedSec };
        }
      }
      if (cache && !opts.forceMoex) {
        const cached = await cache.get(requestedSec, market, interval, from, till, moexSec);
        if (cached?.length >= 3) {
          return { ok: true, pack: cached, requestedSec, fromCache: true };
        }
      }
      const candles = await loadMoexCandlesResolved(moexSec, from, till, interval, market);
      if (!candles.length) {
        return { ok: false, error: "нет свечей MOEX за выбранный период", requestedSec };
      }
      if (cache) await cache.put(requestedSec, market, interval, moexSec, candles);
      return { ok: true, pack: candles, requestedSec, fromCache: false };
    } catch (err) {
      return { ok: false, error: err?.message || String(err), requestedSec };
    }
  }

  async function refreshLiveMoexPacks(instruments, from, till, interval, existingByKey, cache, onProgress) {
    const byKey = new Map(existingByKey || []);
    const failures = [];
    const list = instruments || [];
    let done = 0;
    const queue = [...list];
    const workers = Array.from(
      { length: Math.max(1, Math.min(4, list.length > 8 ? 4 : 2)) },
      async () => {
        while (queue.length) {
          const inst = queue.shift();
          if (!inst) continue;
          const sec = inst.sec;
          const market = inst.market || "shares";
          const r = await loadInstrumentSec(sec, from, till, interval, market, cache, { forceMoex: true });
          done += 1;
          if (onProgress) onProgress(done, list.length, sec, market, { fromCache: false });
          if (r.ok) {
            const key = `${market}:${String(sec || "").trim().toUpperCase()}`;
            const prev = byKey.get(key) || [];
            const merged = mergeCandleSeries(prev, r.pack);
            byKey.set(key, merged.map((c) => ({ ...c, sec, market })));
          } else {
            failures.push({ sec: r.requestedSec || sec, market, error: r.error });
          }
        }
      }
    );
    await Promise.all(workers);
    return { byKey, failures };
  }

  async function loadManyDetailed(secs, from, till, interval, market = "shares", concurrency, onProgress, cache, shouldCancel) {
    const packs = [];
    const failures = [];
    const queue = [...secs];
    let done = 0;
    const workers = Array.from(
      { length: Math.max(1, concurrency && secs.length > 12 ? concurrency : 1) },
      async () => {
        while (queue.length) {
          if (typeof shouldCancel === "function" && shouldCancel()) break;
          const sec = queue.shift();
          if (!sec) break;
          const r = await loadInstrumentSec(sec, from, till, interval, market, cache);
          if (r.ok) packs.push(r.pack);
          else failures.push({ sec: r.requestedSec || sec, market, error: r.error });
          done += 1;
          if (onProgress) onProgress(done, secs.length, sec, { fromCache: !!r.fromCache });
        }
      }
    );
    await Promise.all(workers);
    packs.sort((a, b) => (a[0]?.sec || "").localeCompare(b[0]?.sec || ""));
    return { packs, failures };
  }

  async function loadMany(secs, from, till, interval, market = "shares") {
    const { packs } = await loadManyDetailed(secs, from, till, interval, market);
    return packs;
  }

  async function loadManyBatched(secs, from, till, interval, market, concurrency, onProgress) {
    const { packs } = await loadManyDetailed(secs, from, till, interval, market, concurrency, onProgress);
    return packs;
  }

  function aggregateFinresp(perSecResults) {
    let finresp = 0, cash = 0, pos = 0, commission = 0, buys = 0, sells = 0;
    const bySec = {};
    for (const r of perSecResults) {
      finresp += r.finresp;
      cash += r.cash;
      pos += r.pos;
      commission += r.commission || 0;
      buys += r.buys;
      sells += r.sells;
      bySec[r.sec] = r.finresp;
    }
    return { finresp, cash, pos, commission, buys, sells, bySec };
  }

  const RANDOM_PRICE_SHIFT_MAX = 0.001;

  function applyRandomPriceShift(packs, maxPct = RANDOM_PRICE_SHIFT_MAX) {
    if (!packs?.length || maxPct <= 0) return packs;
    return packs.map((pack) =>
      pack.map((c) => {
        const r = (Math.random() * 2 - 1) * maxPct;
        const m = 1 + r;
        const open = c.open * m;
        const close = c.close * m;
        let high = c.high * m;
        let low = c.low * m;
        high = Math.max(high, open, close);
        low = Math.min(low, open, close);
        return { ...c, open, high, low, close };
      })
    );
  }

  function delay(ms = 0) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function formatProgressTime(time) {
    if (!time) return "";
    const s = String(time).trim();
    if (s.length >= 16) return s.slice(0, 16);
    return s;
  }

  function finrespProgressText(sec, doneBars, totalBars, candleTime) {
    const done = Math.max(0, Math.min(totalBars || 0, Math.round(doneBars || 0)));
    const total = Math.max(0, Math.round(totalBars || 0));
    const barsPart = total > 0 ? ` · ${done}/${total} свечей` : "";
    const t = formatProgressTime(candleTime);
    const timePart = t ? ` · ${t}` : "";
    return `Расчёт FINRESP: ${sec}${barsPart}${timePart}`;
  }

  function stopperProgressText(doneBars, totalBars, candleTime) {
    const done = Math.max(0, Math.min(totalBars || 0, Math.round(doneBars || 0)));
    const total = Math.max(0, Math.round(totalBars || 0));
    const barsPart = total > 0 ? ` · ${done}/${total} свечей` : "";
    const t = formatProgressTime(candleTime);
    const timePart = t ? ` · ${t}` : "";
    return `Stopper портфеля${barsPart}${timePart}`;
  }

  function yieldChunkSize(span) {
    if (span <= 96) return span;
    return Math.max(24, Math.min(72, Math.floor(span / 14)));
  }

  const CALC_PROGRESS = { LOAD_MAX: 33, FINRESP_START: 33, FINRESP_MAX: 66, RUN_MAX: 99 };

  function lerpCalcProgress(from, to, fraction) {
    const f = Math.max(0, Math.min(1, +fraction || 0));
    return from + (to - from) * f;
  }

  function emitFinrespPhaseProgress(options, done, total, text, finrespEnd, sec, candleTime) {
    const end = finrespEnd ?? CALC_PROGRESS.FINRESP_MAX;
    const t = Math.max(1, +total || 1);
    const d = Math.max(0, Math.min(t, +done || 0));
    emitRunProgress(
      options,
      lerpCalcProgress(CALC_PROGRESS.FINRESP_START, end, d / t),
      text,
      { phase: "finresp", done: d, total: t, candleTime: candleTime || null, sec: sec || "" }
    );
  }

  function emitStopperPhaseProgress(options, done, total, text, candleTime) {
    const t = Math.max(1, +total || 1);
    const d = Math.max(0, Math.min(t, +done || 0));
    emitRunProgress(
      options,
      lerpCalcProgress(CALC_PROGRESS.FINRESP_MAX, CALC_PROGRESS.RUN_MAX, d / t),
      text,
      { phase: "stopper", done: d, total: t, candleTime: candleTime || null, sec: "" }
    );
  }

  function emitRunProgress(options, pct, text, detail) {
    if (typeof options?.onProgress === "function") {
      options.onProgress(Math.max(0, Math.min(CALC_PROGRESS.RUN_MAX, pct)), text, detail || null);
    }
  }

  function shouldAbortRun(options) {
    return typeof options?.shouldCancel === "function" && options.shouldCancel();
  }

  async function emitRunProgressAsync(options, pct, text, detail) {
    emitRunProgress(options, pct, text, detail);
    if (options?.yieldUi) await delay(0);
  }

  function runMultiPlan(packs, startIdx, endIdx) {
    const emptyAgg = aggregateFinresp([]);
    const ref = longestPack(packs);
    if (!ref.length) {
      return {
        empty: true,
        emptyAgg,
        aRef: 0,
        bRef: 0,
        tStart: null,
        tEnd: null,
        times: [],
        workUnits: [],
        totalBars: 1
      };
    }
    const aRef = Math.max(0, Math.min(startIdx, ref.length - 1));
    const bRef = Math.max(aRef, Math.min(endIdx, ref.length - 1));
    const tStart = ref[aRef]?.time;
    const tEnd = ref[bRef]?.time;
    const times = [];
    for (let i = aRef; i <= bRef; i++) {
      const t = ref[i]?.time;
      if (t) times.push(t);
    }
    const workUnits = [];
    for (let pi = 0; pi < packs.length; pi++) {
      const candles = packs[pi];
      const range = indicesForTimeRange(candles, tStart, tEnd);
      if (!range) continue;
      workUnits.push({
        pi,
        sec: candles[0]?.sec || "?",
        bars: Math.max(1, range.b - range.a + 1),
        range
      });
    }
    return {
      empty: false,
      emptyAgg,
      aRef,
      bRef,
      tStart,
      tEnd,
      times,
      workUnits,
      totalBars: workUnits.reduce((sum, w) => sum + w.bars, 0) || 1
    };
  }

  /**
   * FINRESP по всем packs: по каждому инструменту runOnCandles, затем aggregateFinresp
   * и опционально applyPortfolioStopper (портфельный @SL/@TP по equity).
   */
  function runMulti(packs, spec, startIdx, endIdx, params, volConfig, stopperConfig, options) {
    const opts = options || {};
    const signalPacks = opts.signalPacks;
    const plan = runMultiPlan(packs, startIdx, endIdx);
    if (plan.empty) {
      return {
        perSec: [],
        skipped: [],
        agg: plan.emptyAgg,
        preStopperAgg: plan.emptyAgg,
        stopper: { events: [] },
        a: 0,
        b: 0
      };
    }
    const { aRef, bRef, tStart, tEnd, times, workUnits, totalBars } = plan;
    const cfg = stopperConfig && (stopperConfig.useSl || stopperConfig.useTp) ? stopperConfig : null;
    const stopperBars = cfg ? Math.max(1, times?.length || 1) : 0;
    const finrespEnd = cfg ? CALC_PROGRESS.FINRESP_MAX : CALC_PROGRESS.RUN_MAX;
    let doneBars = 0;
    const perSec = [];
    const activePacks = [];
    const activeSignalPacks = [];
    const skipped = [];

    emitFinrespPhaseProgress(opts, 0, totalBars, "Расчёт FINRESP: старт", finrespEnd, "", null);

    for (let pi = 0; pi < packs.length; pi++) {
      if (shouldAbortRun(opts)) break;
      const candles = packs[pi];
      const sec = candles[0]?.sec || "?";
      const range = indicesForTimeRange(candles, tStart, tEnd);
      if (!range) {
        skipped.push({ sec, error: "нет свечей в выбранном окне" });
        continue;
      }
      const unit = workUnits.find((w) => w.pi === pi);
      const signalCandles = signalPacks?.[pi] || candles;
      // Кэш индикаторов на весь расчёт: FINRESP + хвосты stopper (см. flattenAndResimTail).
      const indicatorCache = cfg ? new IndicatorCache(signalCandles) : null;
      const runOpts = {
        ...(signalPacks ? { signalCandles } : {}),
        ...(indicatorCache ? { indicatorCache } : {}),
        shouldCancel: opts.shouldCancel,
        onProgress: unit
          ? (doneInInstrument, instrumentBars, candleTime) => {
            const absolute = doneBars + Math.max(0, Math.min(instrumentBars, doneInInstrument));
            emitFinrespPhaseProgress(
              opts,
              absolute,
              totalBars,
              finrespProgressText(unit.sec, absolute, totalBars, candleTime),
              finrespEnd,
              unit.sec,
              candleTime
            );
          }
          : undefined
      };
      const r = runOnCandles(candles, spec, range.a, range.b, params, volConfig, runOpts);
      if (!r.rows?.length) {
        skipped.push({ sec, error: "нет данных для расчёта в выбранном окне" });
        continue;
      }
      if (unit) {
        doneBars += unit.bars;
        emitFinrespPhaseProgress(
          opts,
          doneBars,
          totalBars,
          finrespProgressText(sec, doneBars, totalBars, candles[range.b]?.time),
          finrespEnd,
          sec,
          candles[range.b]?.time
        );
      }
      perSec.push({
        sec,
        ...r,
        ...(indicatorCache ? { indicatorCache } : {})
      });
      activePacks.push(candles);
      if (signalPacks) activeSignalPacks.push(signalCandles);
      if (shouldAbortRun(opts)) break;
    }

    const preStopperAgg = aggregateFinresp(perSec);
    let stopper = { events: [] };
    if (!shouldAbortRun(opts) && cfg && perSec.length) {
      const applied = applyPortfolioStopper(
        perSec,
        activePacks,
        spec,
        times,
        tEnd,
        params,
        volConfig,
        cfg,
        signalPacks ? activeSignalPacks : null,
        {
          shouldCancel: opts.shouldCancel,
          onProgress: (doneInStopper, stopperTotal, candleTime) => {
            emitStopperPhaseProgress(
              opts,
              doneInStopper,
              stopperTotal,
              stopperProgressText(doneInStopper, stopperTotal, candleTime),
              candleTime
            );
          }
        }
      );
      stopper = applied.stopper;
      emitStopperPhaseProgress(
        opts,
        stopperBars,
        stopperBars,
        stopperProgressText(stopperBars, stopperBars, times.at(-1)),
        times.at(-1)
      );
    }
    if (!shouldAbortRun(opts)) {
      emitRunProgress(opts, CALC_PROGRESS.RUN_MAX, "Расчёт FINRESP: готово");
    }
    const agg = aggregateFinresp(perSec);
    return {
      perSec,
      skipped,
      agg,
      preStopperAgg,
      stopper,
      cancelled: shouldAbortRun(opts),
      a: aRef,
      b: bRef,
      tStart,
      tEnd
    };
  }

  async function runMultiAsync(packs, spec, startIdx, endIdx, params, volConfig, stopperConfig, options) {
    const opts = { ...(options || {}), yieldUi: true };
    const signalPacks = opts.signalPacks;
    const plan = runMultiPlan(packs, startIdx, endIdx);
    if (plan.empty) {
      return {
        perSec: [],
        skipped: [],
        agg: plan.emptyAgg,
        preStopperAgg: plan.emptyAgg,
        stopper: { events: [] },
        a: 0,
        b: 0
      };
    }
    const { aRef, bRef, tStart, tEnd, times, workUnits, totalBars } = plan;
    const cfg = stopperConfig && (stopperConfig.useSl || stopperConfig.useTp) ? stopperConfig : null;
    const stopperBars = cfg ? Math.max(1, times?.length || 1) : 0;
    const finrespEnd = cfg ? CALC_PROGRESS.FINRESP_MAX : CALC_PROGRESS.RUN_MAX;
    let doneBars = 0;
    const perSec = [];
    const activePacks = [];
    const activeSignalPacks = [];
    const skipped = [];

    await emitRunProgressAsync(opts, CALC_PROGRESS.FINRESP_START, "Расчёт FINRESP: старт", { phase: "finresp", done: 0, total: totalBars });

    for (let pi = 0; pi < packs.length; pi++) {
      if (shouldAbortRun(opts)) break;
      const candles = packs[pi];
      const sec = candles[0]?.sec || "?";
      const range = indicesForTimeRange(candles, tStart, tEnd);
      if (!range) {
        skipped.push({ sec, error: "нет свечей в выбранном окне" });
        continue;
      }
      const unit = workUnits.find((w) => w.pi === pi);
      const signalCandles = signalPacks?.[pi] || candles;
      const indicatorCache = cfg ? new IndicatorCache(signalCandles) : null;
      const runOpts = {
        ...(signalPacks ? { signalCandles } : {}),
        ...(indicatorCache ? { indicatorCache } : {}),
        yieldUi: true,
        shouldCancel: opts.shouldCancel,
        onProgress: unit
          ? (doneInInstrument, instrumentBars, candleTime) => {
            const absolute = doneBars + Math.max(0, Math.min(instrumentBars, doneInInstrument));
            emitFinrespPhaseProgress(
              opts,
              absolute,
              totalBars,
              finrespProgressText(unit.sec, absolute, totalBars, candleTime),
              finrespEnd,
              unit.sec,
              candleTime
            );
          }
          : undefined
      };
      const r = await runOnCandlesYielding(candles, spec, range.a, range.b, params, volConfig, runOpts);
      if (!r.rows?.length) {
        skipped.push({ sec, error: "нет данных для расчёта в выбранном окне" });
        continue;
      }
      if (unit) {
        doneBars += unit.bars;
        await emitRunProgressAsync(
          opts,
          lerpCalcProgress(CALC_PROGRESS.FINRESP_START, finrespEnd, doneBars / totalBars),
          finrespProgressText(sec, doneBars, totalBars, candles[range.b]?.time),
          { phase: "finresp", done: doneBars, total: totalBars, candleTime: candles[range.b]?.time, sec }
        );
      }
      perSec.push({
        sec,
        ...r,
        ...(indicatorCache ? { indicatorCache } : {})
      });
      activePacks.push(candles);
      if (signalPacks) activeSignalPacks.push(signalCandles);
      if (shouldAbortRun(opts)) break;
    }

    const preStopperAgg = aggregateFinresp(perSec);
    let stopper = { events: [] };
    if (!shouldAbortRun(opts) && cfg && perSec.length) {
      const applied = applyPortfolioStopper(
        perSec,
        activePacks,
        spec,
        times,
        tEnd,
        params,
        volConfig,
        cfg,
        signalPacks ? activeSignalPacks : null,
        {
          shouldCancel: opts.shouldCancel,
          onProgress: (doneInStopper, stopperTotal, candleTime) => {
            emitStopperPhaseProgress(
              opts,
              doneInStopper,
              stopperTotal,
              stopperProgressText(doneInStopper, stopperTotal, candleTime),
              candleTime
            );
          }
        }
      );
      stopper = applied.stopper;
      await emitRunProgressAsync(
        opts,
        lerpCalcProgress(CALC_PROGRESS.FINRESP_MAX, CALC_PROGRESS.RUN_MAX, 1),
        stopperProgressText(stopperBars, stopperBars, times.at(-1)),
        { phase: "stopper", done: stopperBars, total: stopperBars, candleTime: times.at(-1) }
      );
    }
    if (!shouldAbortRun(opts)) {
      await emitRunProgressAsync(opts, CALC_PROGRESS.RUN_MAX, "Расчёт FINRESP: готово");
    }
    const agg = aggregateFinresp(perSec);
    return {
      perSec,
      skipped,
      agg,
      preStopperAgg,
      stopper,
      cancelled: shouldAbortRun(opts),
      a: aRef,
      b: bRef,
      tStart,
      tEnd
    };
  }

  root.MultiLogicFinrespEngine = {
    CALC_PROGRESS,
    DEFAULT_PARAMS,
    DEFAULT_STOPPER,
    DEFAULT_VOLUME,
    DEFAULT_COMMISSION,
    normalizeCommission,
    tradeCommission,
    INDICATOR_OPTIONS,
    DEFAULT_LOGIC_LINES,
    BUILTIN_META,
    calcTradeVolume,
    ORDER_BOOK_TREND_TOKEN,
    DEFAULT_OB_IMBALANCE,
    logicUsesObTrend,
    detectObTrendMode,
    sumOrderBookLevels,
    evaluateOrderBookTrend,
    substituteParams,
    parseLogicLine,
    normalizeIndicatorSelection,
    resolveLogicSpec,
    resolveLogicSpecStack,
    runOnCandles,
    runMulti,
    runMultiAsync,
    buildPortfolioEquityRows,
    loadMany,
    loadManyBatched,
    loadManyDetailed,
    loadInstrumentSec,
    refreshLiveMoexPacks,
    mergeCandleSeries,
    listShareTickers,
    listFuturesPrefixes,
    resolveFuturesContract,
    DEFAULT_STOCK_TICKERS_RAW,
    DEFAULT_FUTURES_PREFIXES_RAW,
    parseTickerPrefixes,
    stockTickerMatches,
    futuresTickerMatches,
    fetchShareList,
    fetchFuturesList,
    expandFuturesSelection,
    futuresMatchesCalcPeriod,
    isFullFuturesSecid,
    createCandleCache,
    CANDLE_CACHE_VERSION,
    moexFileProtocolHint,
    resolveIntervalLoad,
    aggregateCandles,
    quotationToNumber,
    tbankTimeToMs,
    formatCandleTimeMsk,
    tbankIntervalForCalcTf,
    tbankCandleChunkDays,
    liveTbankTailHours,
    parseTbankHistoricCandles,
    applyRandomPriceShift,
    RANDOM_PRICE_SHIFT_MAX,
    smaSeries
  };
})(typeof window !== "undefined" ? window : globalThis);
