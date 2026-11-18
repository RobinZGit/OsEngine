/**
 * Filter fitting ("Подобрать фильтры") for a logic: evaluate candidate indicator
 * filters on bars of existing trades, compute impact on financial result by
 * excluding open trades (and matched lots/close parts, FIFO partial) when a
 * filter would have blocked the open. No full logic/backtest rerun.
 */
'use strict';

const { parseSignalFormula, parseParamSeries } = require('../lib/signal-formula');
const { LOGIC_TRADE_SELECT } = require('../lib/logic-trade-sql');

function isFiniteNum(v) {
  const n = Number(v);
  return Number.isFinite(n);
}

function toNum(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** Safe condition evaluation: substitute known numeric tokens, allow comparisons/logic. */
function evalCondition(condition, valueByToken) {
  let expr = String(condition || '').trim();
  if (!expr) return { ok: false, reason: 'empty_condition' };
  const tokens = Object.keys(valueByToken).sort((a, b) => b.length - a.length);
  for (const token of tokens) {
    const val = valueByToken[token];
    if (val == null || !Number.isFinite(Number(val))) {
      return { ok: false, reason: 'missing_value', token };
    }
    expr = expr.replace(new RegExp(`\\b${token}\\b`, 'gi'), String(Number(val)));
  }
  // disallow unexpected identifiers
  if (/[A-Za-z_]/.test(expr)) return { ok: false, reason: 'unresolved_token' };
  if (!/[><=!]/.test(expr)) return { ok: false, reason: 'no_comparison' };
  if (!/^[0-9\s+\-*/().,<>=!&|]+$/.test(expr)) return { ok: false, reason: 'bad_chars' };
  try {
    // eslint-disable-next-line no-new-func
    const res = Boolean(Function(`"use strict"; return (${expr});`)());
    return { ok: true, pass: res };
  } catch {
    return { ok: false, reason: 'eval_error' };
  }
}

function paramsStringFromMap(map) {
  if (!map || typeof map !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(map)) {
    if (v === null || v === undefined || v === '') continue;
    parts.push(`${k}=${v}`);
  }
  return parts.join(',');
}

function mergeParams(baseParamsStr, overrides) {
  const out = new Map();
  const base = String(baseParamsStr || '');
  if (base.trim()) {
    for (const part of base.split(',')) {
      const kv = part.split('=');
      if (kv.length >= 2) {
        const key = kv[0].trim();
        const val = kv.slice(1).join('=').trim();
        if (key) out.set(key.toLowerCase(), { key, val });
      }
    }
  }
  if (overrides && typeof overrides === 'object') {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === null || v === undefined || v === '') continue;
      const key = String(k).trim();
      if (!key) continue;
      out.set(key.toLowerCase(), { key, val: String(v) });
    }
  }
  // keep stable-ish order: period-like first then others
  const entries = [...out.values()];
  return entries.map((e) => `${e.key}=${e.val}`).join(',');
}

function buildFormula(indicatorCode, paramsStr, condition) {
  const p = String(paramsStr || '').trim();
  const c = String(condition || '').trim();
  return `@${String(indicatorCode).toUpperCase()}(${p}) ${c}`.trim();
}

async function fetchLogic(pool, logicId) {
  const { rows } = await pool.query(
    `SELECT l.id, l.name, l.account_id, l.is_enabled,
            a.account_code, b.code AS broker_code
       FROM logics l
       JOIN accounts a ON a.id = l.account_id
       LEFT JOIN brokers b ON b.id = a.broker_id
      WHERE l.id = $1`,
    [logicId]
  );
  return rows[0] || null;
}

async function fetchIndicators(pool) {
  const { rows } = await pool.query(
    `SELECT id, code, name, category, sig_trend_def, sig_ct_def, sig_profile, is_active
       FROM indicators
      WHERE is_active = TRUE
      ORDER BY code`
  );
  return rows;
}

async function fetchParamBounds(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT indicator_code, param_key,
              strict_value::float8 AS strict_value,
              loose_value::float8 AS loose_value,
              default_value::float8 AS default_value,
              is_integer
         FROM indicator_param_bounds`
    );
    return rows;
  } catch {
    return [];
  }
}

function pickDefaultParamValue(boundRow) {
  if (!boundRow) return null;
  if (boundRow.default_value != null && isFiniteNum(boundRow.default_value)) {
    return boundRow.is_integer ? Math.round(Number(boundRow.default_value)) : Number(boundRow.default_value);
  }
  const s = Number(boundRow.strict_value);
  const l = Number(boundRow.loose_value);
  if (!Number.isFinite(s) || !Number.isFinite(l)) return null;
  const mid = (s + l) / 2;
  return boundRow.is_integer ? Math.round(mid) : Number(mid);
}

async function fetchScope(pool, logicId) {
  // Prefer combat trades with realized lots/results; if not enough, supplement with latest test run.
  const lotsBaseSql = `
    SELECT l.id AS lot_id,
           l.logic_id,
           l.close_trade_id,
           l.open_trade_id,
           l.action_id,
           l.quantity,
           l.financial_result,
           ot.bar_dt AS open_bar_dt,
           ot.security_id AS open_security_id,
           ot.timeframe_id AS open_timeframe_id,
           ot.side_id AS open_side_id,
           ot.action_id AS open_action_id,
           COALESCE(ot.is_test, FALSE) AS open_is_test,
           ot.run_id AS open_run_id,
           ot.status AS open_status,
           ct.status AS close_status
      FROM logic_trade_lots l
      JOIN logic_trades ct ON ct.id = l.close_trade_id
      JOIN logic_trades ot ON ot.id = l.open_trade_id
     WHERE l.logic_id = $1
       AND l.financial_result IS NOT NULL
       AND ct.status IN ('filled','submitted')
       AND ot.status IN ('filled','submitted')
  `;
  const { rows: combatLots } = await pool.query(
    `${lotsBaseSql} AND COALESCE(ot.is_test, FALSE) = FALSE ORDER BY l.id ASC`,
    [logicId]
  );
  let scope = 'combat';
  let lots = combatLots;
  let supplementRunId = null;
  const MIN = 10;
  // Count unique open trades with completed result as "deals" proxy, but lots drive P&L.
  const uniqueOpens = (arr) => new Set(arr.map((x) => String(x.open_trade_id))).size;
  if (uniqueOpens(lots) < MIN) {
    // find latest test run with lots
    const { rows: runs } = await pool.query(
      `SELECT ot.run_id, MAX(l.id) AS max_lot_id
         FROM logic_trade_lots l
         JOIN logic_trades ot ON ot.id = l.open_trade_id
        WHERE l.logic_id = $1
          AND COALESCE(ot.is_test, FALSE) = TRUE
          AND ot.run_id IS NOT NULL
          AND l.financial_result IS NOT NULL
        GROUP BY ot.run_id
        ORDER BY max_lot_id DESC
        LIMIT 1`,
      [logicId]
    );
    if (runs.length) {
      supplementRunId = runs[0].run_id;
      const { rows: testLots } = await pool.query(
        `${lotsBaseSql} AND COALESCE(ot.is_test, FALSE) = TRUE AND ot.run_id = $2 ORDER BY l.id ASC`,
        [logicId, supplementRunId]
      );
      // supplement: add test lots for opens not already present? simpler: if combat empty use test; else append missing opens' lots
      if (lots.length === 0) {
        lots = testLots;
        scope = 'test';
      } else {
        const have = new Set(lots.map((x) => String(x.open_trade_id)));
        const extra = testLots.filter((x) => !have.has(String(x.open_trade_id)));
        if (extra.length) {
          lots = lots.concat(extra);
          scope = 'mixed';
        }
      }
    } else if (lots.length === 0) {
      // fallback: any test lots without run_id
      const { rows: testLotsAny } = await pool.query(
        `${lotsBaseSql} AND COALESCE(ot.is_test, FALSE) = TRUE ORDER BY l.id ASC`,
        [logicId]
      );
      lots = testLotsAny;
      scope = lots.length ? 'test' : 'none';
    }
  }

  // open trades metadata for evaluation (distinct opens in scope)
  const openIds = [...new Set(lots.map((x) => Number(x.open_trade_id)).filter(Number.isFinite))];
  let opens = [];
  if (openIds.length) {
    const { rows } = await pool.query(
      `SELECT lt.id AS open_trade_id,
              lt.security_id,
              lt.timeframe_id,
              lt.bar_dt,
              to_char(lt.bar_dt, 'YYYY-MM-DD HH24:MI:SS') AS bar_dt_text,
              lt.side_id,
              lt.action_id,
              sd.name AS side_name,
              ac.name AS action_name
         FROM logic_trades lt
         JOIN sides sd ON sd.id = lt.side_id
         JOIN actions ac ON ac.id = lt.action_id
        WHERE lt.id = ANY($1::bigint[])`,
      [openIds]
    );
    opens = rows;
  }
  return { scope, lots, opens, supplementRunId };
}

async function fetchPricesForBars(pool, bars) {
  // bars: [{security_id,timeframe_id,bar_dt}]
  const unique = new Map();
  for (const b of bars) {
    const k = `${b.security_id}|${b.timeframe_id}|${new Date(b.bar_dt).toISOString()}`;
    if (!unique.has(k)) unique.set(k, b);
  }
  const list = [...unique.values()];
  if (list.length === 0) return new Map();
  // query in chunks
  const out = new Map();
  const chunkSize = 200;
  for (let i = 0; i < list.length; i += chunkSize) {
    const chunk = list.slice(i, i + chunkSize);
    const values = [];
    const tuples = [];
    let p = 1;
    for (const b of chunk) {
      tuples.push(`($${p++}::int,$${p++}::int,$${p++}::timestamp)`);
      values.push(b.security_id, b.timeframe_id, b.bar_dt);
    }
    const sql = `
      SELECT p.security_id, p.timeframe_id, p.dt, p.close_price
        FROM prices p
        JOIN (VALUES ${tuples.join(',')}) AS v(security_id,timeframe_id,dt)
          ON p.security_id=v.security_id AND p.timeframe_id=v.timeframe_id AND p.dt=v.dt
    `;
    const { rows } = await pool.query(sql, values);
    for (const r of rows) {
      const k = `${r.security_id}|${r.timeframe_id}|${new Date(r.dt).toISOString()}`;
      out.set(k, r.close_price == null ? null : Number(r.close_price));
    }
  }
  return out;
}

async function fetchIndicatorValuesForBars(pool, requests) {
  // requests: [{indicator_id, series_code, security_id, timeframe_id, bar_dt}]
  const unique = new Map();
  for (const r of requests) {
    const k = `${r.indicator_id}|${String(r.series_code).toUpperCase()}|${r.security_id}|${r.timeframe_id}|${new Date(r.bar_dt).toISOString()}`;
    if (!unique.has(k)) unique.set(k, r);
  }
  const list = [...unique.values()];
  const out = new Map();
  if (list.length === 0) return out;
  const chunkSize = 150;
  for (let i = 0; i < list.length; i += chunkSize) {
    const chunk = list.slice(i, i + chunkSize);
    const values = [];
    const tuples = [];
    let p = 1;
    for (const r of chunk) {
      tuples.push(`($${p++}::int,$${p++}::text,$${p++}::int,$${p++}::int,$${p++}::timestamp)`);
      values.push(r.indicator_id, String(r.series_code).toUpperCase(), r.security_id, r.timeframe_id, r.bar_dt);
    }
    const sql = `
      SELECT iv.indicator_id, upper(ivt.code) AS series_code,
             iv.security_id, iv.timeframe_id, iv.dt, iv.value
        FROM indicator_values iv
        JOIN indicator_value_types ivt ON ivt.id = iv.indicator_value_type_id
        JOIN (VALUES ${tuples.join(',')}) AS v(indicator_id,series_code,security_id,timeframe_id,dt)
          ON iv.indicator_id=v.indicator_id
         AND upper(ivt.code)=upper(v.series_code)
         AND iv.security_id=v.security_id
         AND iv.timeframe_id=v.timeframe_id
         AND iv.dt=v.dt
    `;
    try {
      const { rows } = await pool.query(sql, values);
      for (const r of rows) {
        const k = `${r.indicator_id}|${String(r.series_code).toUpperCase()}|${r.security_id}|${r.timeframe_id}|${new Date(r.dt).toISOString()}`;
        out.set(k, r.value == null ? null : Number(r.value));
      }
    } catch (err) {
      // ignore chunk errors, leave missing
    }
  }
  return out;
}

function buildIndicatorDefaultParams(indicatorCode, boundsByCode) {
  // defaults similar to frontend shared/signal-formula defaults, but we can be generic:
  const code = String(indicatorCode || '').toUpperCase();
  const bounds = boundsByCode.get(code) || [];
  const params = {};
  // series defaults by common cases
  if (['BB', 'LINREG', 'SQUARE'].includes(code)) params.series = 'MIDDLE';
  else if (code === 'MACD') params.series = 'MACD';
  else if (code === 'STOCH') params.series = 'K';
  else params.series = 'VALUE';
  // period-like params from bounds defaults
  for (const b of bounds) {
    const key = String(b.param_key);
    const dv = pickDefaultParamValue(b);
    if (dv != null) params[key] = dv;
  }
  // known multi-param defaults if bounds incomplete
  if (code === 'MACD') {
    if (params.fast_period == null) params.fast_period = 12;
    if (params.slow_period == null) params.slow_period = 26;
    if (params.signal_period == null) params.signal_period = 9;
  }
  if (code === 'STOCH') {
    if (params.k_period == null) params.k_period = 14;
    if (params.d_period == null) params.d_period = 3;
    if (params.smooth == null) params.smooth = 3;
  }
  if (code === 'BB') {
    if (params.period == null) params.period = 20;
    if (params.std_dev == null) params.std_dev = 2;
  }
  if (params.period == null && bounds.length === 0) params.period = 20;
  return params;
}

async function analyzeLogicFilters(pool, logicId, body) {
  const logic = await fetchLogic(pool, logicId);
  if (!logic) throw Object.assign(new Error('Logic not found'), { status: 404 });
  const indicators = await fetchIndicators(pool);
  const bounds = await fetchParamBounds(pool);
  const boundsByCode = new Map();
  for (const b of bounds) {
    const code = String(b.indicator_code || '').toUpperCase();
    if (!boundsByCode.has(code)) boundsByCode.set(code, []);
    boundsByCode.get(code).push(b);
  }

  const scopeData = await fetchScope(pool, logicId);
  const lots = scopeData.lots || [];
  const opens = scopeData.opens || [];
  const openById = new Map(opens.map((o) => [String(o.open_trade_id), o]));
  const baselinePnl = lots.reduce((s, l) => s + toNum(l.financial_result, 0), 0);
  const uniqueOpenIds = [...new Set(lots.map((l) => String(l.open_trade_id)))];
  const completedDeals = uniqueOpenIds.length;

  // selected indicators filter: if provided, only those; else all
  const selectedIds = Array.isArray(body?.indicator_ids)
    ? new Set(body.indicator_ids.map((x) => Number(x)).filter(Number.isFinite))
    : null;
  const selectedCodes = Array.isArray(body?.indicator_codes)
    ? new Set(body.indicator_codes.map((x) => String(x).toUpperCase()))
    : null;
  let candidates = indicators.filter((ind) => ind.sig_trend_def || ind.sig_ct_def);
  if (selectedIds && selectedIds.size) candidates = candidates.filter((i) => selectedIds.has(Number(i.id)));
  if (selectedCodes && selectedCodes.size) candidates = candidates.filter((i) => selectedCodes.has(String(i.code).toUpperCase()));

  // per-indicator user params overrides: { [code or id]: {param:value,...} }
  const paramOverrides = body?.params_by_code && typeof body.params_by_code === 'object' ? body.params_by_code : {};

  // prefetch prices for all open bars
  const openBars = opens.map((o) => ({ security_id: o.security_id, timeframe_id: o.timeframe_id, bar_dt: o.bar_dt }));
  const priceMap = await fetchPricesForBars(pool, openBars);

  // Prepare results per candidate
  const results = [];
  // precompute per candidate+direction pass map lazily with batched indicator value fetches per candidate
  for (const ind of candidates) {
    const code = String(ind.code).toUpperCase();
    const overrides = paramOverrides[code] || paramOverrides[String(ind.id)] || {};
    const defParams = buildIndicatorDefaultParams(code, boundsByCode);
    const mergedParams = { ...defParams, ...overrides };
    // ensure series present
    if (!mergedParams.series) mergedParams.series = 'VALUE';
    const paramsStr = paramsStringFromMap(mergedParams);
    const seriesCode = String(mergedParams.series || 'VALUE').toUpperCase();

    // need indicator values for all open bars for this indicator/series (params like period do not affect stored series except which indicator definition? stored values are per indicator_id+series+sec+tf+dt; period is implicit in computed indicator values - we assume values correspond to default/computed params? This is an approximation.)
    const ivReqs = opens.map((o) => ({
      indicator_id: ind.id,
      series_code: seriesCode,
      security_id: o.security_id,
      timeframe_id: o.timeframe_id,
      bar_dt: o.bar_dt,
    }));
    const ivMap = await fetchIndicatorValuesForBars(pool, ivReqs);

    const directions = [
      { key: 'trend', label: 'trend', condition: String(ind.sig_trend_def || '').trim() },
      { key: 'counter', label: 'counter', condition: String(ind.sig_ct_def || '').trim() },
    ];
    const dirResults = [];
    for (const dir of directions) {
      if (!dir.condition) {
        dirResults.push({ direction: dir.key, available: false, reason: 'no_condition' });
        continue;
      }
      // pass/fail per open_trade_id
      const passByOpen = new Map();
      let missing = 0;
      let evaluated = 0;
      for (const o of opens) {
        const oid = String(o.open_trade_id);
        const k = `${o.security_id}|${o.timeframe_id}|${new Date(o.bar_dt).toISOString()}`;
        const close = priceMap.get(k);
        const ivk = `${ind.id}|${seriesCode}|${o.security_id}|${o.timeframe_id}|${new Date(o.bar_dt).toISOString()}`;
        const indVal = ivMap.get(ivk);
        if (close == null || !Number.isFinite(Number(close)) || indVal == null || !Number.isFinite(Number(indVal))) {
          missing += 1;
          passByOpen.set(oid, null);
          continue;
        }
        const tokens = {
          VALUE: Number(indVal),
          [seriesCode]: Number(indVal),
          PP: Number(close),
          CLOSE: Number(close),
          PRICE: Number(close),
          OPEN: Number(close), // fallback
          HIGH: Number(close),
          LOW: Number(close),
        };
        const ev = evalCondition(dir.condition, tokens);
        if (!ev.ok) {
          missing += 1;
          passByOpen.set(oid, null);
        } else {
          evaluated += 1;
          passByOpen.set(oid, Boolean(ev.pass));
        }
      }
      // compute P&L with filter: include lot only if its open passes (null => treat as pass to avoid over-filtering on missing data)
      let pnlWith = 0;
      let pnlExcluded = 0;
      let lotsExcluded = 0;
      let lotsKept = 0;
      let opensExcluded = new Set();
      let opensAffected = new Set();
      for (const lot of lots) {
        const oid = String(lot.open_trade_id);
        const pass = passByOpen.get(oid);
        if (pass === false) {
          pnlExcluded += toNum(lot.financial_result, 0);
          lotsExcluded += 1;
          opensExcluded.add(oid);
          opensAffected.add(oid);
        } else {
          pnlWith += toNum(lot.financial_result, 0);
          lotsKept += 1;
        }
      }
      const delta = pnlWith - baselinePnl; // equals -pnlExcluded
      const denom = Math.abs(baselinePnl) > 1e-9 ? Math.abs(baselinePnl) : null;
      const efficiencyPct = denom != null ? (delta / denom) * 100 : null;
      dirResults.push({
        direction: dir.key,
        condition: dir.condition,
        formula: buildFormula(code, paramsStr, dir.condition),
        params: mergedParams,
        series: seriesCode,
        evaluated_opens: evaluated,
        missing_opens: missing,
        pnl_with_filter: Number(pnlWith.toFixed(6)),
        pnl_excluded: Number(pnlExcluded.toFixed(6)),
        delta_pnl: Number(delta.toFixed(6)),
        efficiency_pct: efficiencyPct == null ? null : Number(efficiencyPct.toFixed(4)),
        lots_kept: lotsKept,
        lots_excluded: lotsExcluded,
        opens_excluded: opensExcluded.size,
      });
    }
    // pick best direction by efficiency (higher better); if nulls, prefer available with max delta
    const validDirs = dirResults.filter((d) => d.available !== false);
    let best = null;
    for (const d of validDirs) {
      if (!best) best = d;
      else {
        const a = d.efficiency_pct == null ? -Infinity : d.efficiency_pct;
        const b = best.efficiency_pct == null ? -Infinity : best.efficiency_pct;
        if (a > b || (a === b && (d.delta_pnl || 0) > (best.delta_pnl || 0))) best = d;
      }
    }
    results.push({
      indicator_id: ind.id,
      indicator_code: code,
      indicator_name: ind.name,
      category: ind.category,
      is_default: code === 'SMA',
      params: mergedParams,
      params_bounds: (boundsByCode.get(code) || []).map((b) => ({
        param_key: b.param_key,
        strict_value: b.strict_value,
        loose_value: b.loose_value,
        default_value: b.default_value,
        is_integer: b.is_integer,
      })),
      directions: dirResults,
      best_direction: best ? best.direction : null,
      best_efficiency_pct: best ? best.efficiency_pct : null,
      best_delta_pnl: best ? best.delta_pnl : null,
      best_formula: best ? best.formula : null,
    });
  }

  // sort: SMA first, then by best_efficiency desc, then name
  results.sort((a, b) => {
    if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
    const ea = a.best_efficiency_pct == null ? -Infinity : a.best_efficiency_pct;
    const eb = b.best_efficiency_pct == null ? -Infinity : b.best_efficiency_pct;
    if (eb !== ea) return eb - ea;
    return String(a.indicator_name || a.indicator_code).localeCompare(String(b.indicator_name || b.indicator_code));
  });

  return {
    logic_id: logicId,
    logic_name: logic.name,
    scope: scopeData.scope,
    supplement_run_id: scopeData.supplementRunId,
    baseline: {
      pnl: Number(baselinePnl.toFixed(6)),
      lots: lots.length,
      completed_opens: completedDeals,
    },
    enough: completedDeals >= 10,
    min_required: 10,
    candidates: results,
    note: 'Efficiency % = (PnL_with_filter - PnL_baseline) / |PnL_baseline| * 100. Lots matched by FIFO allocations (logic_trade_lots). Missing indicator/price values on open bar => treated as pass (not filtered). Indicator values are taken from stored indicator_values for the selected series; period-specific recompute is not performed if stored values are absent.',
  };
}

async function applySelectedFilters(pool, logicId, body) {
  const selected = Array.isArray(body?.selected) ? body.selected : [];
  if (!selected.length) return { added: [], added_count: 0 };
  const { rows: exists } = await pool.query('SELECT id FROM logics WHERE id = $1', [logicId]);
  if (!exists.length) throw Object.assign(new Error('Logic not found'), { status: 404 });
  const sides = ['long', 'short'];
  const added = [];
  for (const item of selected) {
    const indicatorId = Number(item.indicator_id);
    if (!Number.isInteger(indicatorId) || indicatorId <= 0) continue;
    const direction = item.direction === 'counter' ? 'counter' : 'trend';
    const formula = String(item.formula || '').trim();
    if (!formula) continue;
    for (const side of sides) {
      try {
        const { rows } = await pool.query(
          `INSERT INTO logic_indicator_signals
            (logic_id, indicator_id, position_event, position_side, signal_kind, signal_acts_on, signal_confirm_sec, formula, is_active, display_order)
           VALUES ($1,$2,'open',$3,$4,'security',0,$5,TRUE,
             COALESCE((SELECT MAX(display_order)+1 FROM logic_indicator_signals WHERE logic_id=$1), 1))
           RETURNING id, logic_id, indicator_id, position_event, position_side, signal_kind, formula, is_active`,
          [logicId, indicatorId, side, direction, formula]
        );
        if (rows[0]) added.push(rows[0]);
      } catch (err) {
        // continue on individual insert errors
        added.push({ error: err.message, indicator_id: indicatorId, position_side: side });
      }
    }
  }
  return { added, added_count: added.filter((x) => x && x.id).length };
}

module.exports = function registerFilterAnalysisRoutes(app, ctx) {
  const { pool } = ctx;

  app.get('/api/logics/:id/filter-analysis/context', async (req, res) => {
    const logicId = Number(req.params.id);
    if (!Number.isInteger(logicId) || logicId <= 0) {
      res.status(400).json({ error: 'Invalid logic id' });
      return;
    }
    try {
      const logic = await fetchLogic(pool, logicId);
      if (!logic) { res.status(404).json({ error: 'Logic not found' }); return; }
      const scope = await fetchScope(pool, logicId);
      const indicators = await fetchIndicators(pool);
      const bounds = await fetchParamBounds(pool);
      const boundsByCode = {};
      for (const b of bounds) {
        const c = String(b.indicator_code || '').toUpperCase();
        (boundsByCode[c] = boundsByCode[c] || []).push(b);
      }
      const candidates = indicators.filter((i) => i.sig_trend_def || i.sig_ct_def).map((i) => {
        const code = String(i.code).toUpperCase();
        const params = buildIndicatorDefaultParams(code, new Map([[code, boundsByCode[code] || []]]));
        const series = String(params.series || 'VALUE').toUpperCase();
        const trendCond = String(i.sig_trend_def || '').trim();
        const counterCond = String(i.sig_ct_def || '').trim();
        return {
          indicator_id: i.id,
          indicator_code: code,
          indicator_name: i.name,
          category: i.category,
          is_default: code === 'SMA',
          params,
          series,
          params_bounds: boundsByCode[code] || [],
          trend_formula: trendCond ? buildFormula(code, paramsStringFromMap(params), trendCond) : null,
          counter_formula: counterCond ? buildFormula(code, paramsStringFromMap(params), counterCond) : null,
          trend_condition: trendCond || null,
          counter_condition: counterCond || null,
        };
      }).sort((a,b)=> (a.is_default!==b.is_default ? (a.is_default?-1:1) : String(a.indicator_name||a.indicator_code).localeCompare(String(b.indicator_name||b.indicator_code))));
      const lots = scope.lots || [];
      const baselinePnl = lots.reduce((s,l)=>s+toNum(l.financial_result,0),0);
      const completedOpens = new Set(lots.map(l=>String(l.open_trade_id))).size;
      res.json({
        logic_id: logicId,
        scope: scope.scope,
        supplement_run_id: scope.supplementRunId,
        baseline: { pnl: Number(baselinePnl.toFixed(6)), lots: lots.length, completed_opens: completedOpens },
        enough: completedOpens >= 10,
        min_required: 10,
        candidates,
      });
    } catch (err) {
      console.error('GET /api/logics/:id/filter-analysis/context', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/logics/:id/filter-analysis', async (req, res) => {
    const logicId = Number(req.params.id);
    if (!Number.isInteger(logicId) || logicId <= 0) {
      res.status(400).json({ error: 'Invalid logic id' });
      return;
    }
    try {
      const result = await analyzeLogicFilters(pool, logicId, req.body || {});
      res.json(result);
    } catch (err) {
      console.error('POST /api/logics/:id/filter-analysis', err);
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/logics/:id/filter-analysis/apply', async (req, res) => {
    const logicId = Number(req.params.id);
    if (!Number.isInteger(logicId) || logicId <= 0) {
      res.status(400).json({ error: 'Invalid logic id' });
      return;
    }
    try {
      const result = await applySelectedFilters(pool, logicId, req.body || {});
      res.json(result);
    } catch (err) {
      console.error('POST /api/logics/:id/filter-analysis/apply', err);
      res.status(err.status || 500).json({ error: err.message });
    }
  });
};
