/**
 * Shared helpers + stop-scope validators for API route modules.
 * Extracted from server.js (Phase A routers).
 */
const {
  hashToken,
} = require('../tbank');
const {
  startBacktest,
  getBacktestStatus,
  cancelBacktest,
} = require('../logic-backtest');
const { resolveLastOptGridResults } = require('./opt-grid-store');
const {
  listBacktestReports,
  getBacktestReport,
  getBacktestReportNeighbors,
  persistBacktestReport,
} = require('../backtest-report-persist');
const {
  startRatingPrecalc,
  getRatingPrecalcStatus,
} = require('../logic-rating-precalc');
const { runTradeCycle, getTradeRunnerHealth, runWatchdogTick } = require('../trade-runner');
const {
  touchUiHeartbeatDb,
  clearUiHeartbeatDb,
  isUiSessionActive,
} = require('./trade-runner-session');
const { validateOptFormulaSave } = require('./signal-opt');
const {
  getTradingParams,
  getTradingParamsForLogics,
  saveTradingParams,
  ensureDefaultParams,
  getLogicParamsDetailed,
  syncRealAccountBalancesIfNeeded,
  resetLogicTradingStateOnAccountChange,
  resetLogicShadowTradingState,
} = require('./logic-params');
const { buildLogicBundle, importLogicBundle } = require('./logic-bundle');
const { writeTechLogEvent } = require('./tech-log');
const {
  assertRealTbankAccount,
  sellAllPositions,
  closeAllLogicPositions,
  planBuyBonds,
  executeBuyBonds,
  listBondFunds,
  getAccountCash,
} = require('./account-portfolio-actions');

/** Set by createRouteContext(pool) — helpers that formerly closed over server.js pool. */
let dbPool = null;


const VALID_STOP_SCOPES = new Set([
  'security',
  'security_resume',
  'security_inversion',
  'portfolio',
  'portfolio_resume',
  'portfolio_ltp_renew',
  'security_ltp_renew',
]);
const TAKE_PROFIT_SCOPES = new Set([
  'security',
  'portfolio',
  'portfolio_ltp_renew',
  'security_ltp_renew',
]);

function isScopeValidForRuleKind(ruleKind, scopeType) {
  if (ruleKind === 'take_profit') return TAKE_PROFIT_SCOPES.has(scopeType);
  if (ruleKind === 'stop_loss') {
    return (
      VALID_STOP_SCOPES.has(scopeType) &&
      scopeType !== 'security_ltp_renew' &&
      scopeType !== 'portfolio_ltp_renew'
    );
  }
  return false;
}

/** UI: видимы, но нельзя выбрать при создании / смене типа. */
function isScopeChoosableForRuleKind(ruleKind, scopeType) {
  if (!isScopeValidForRuleKind(ruleKind, scopeType)) return false;
  if (ruleKind === 'stop_loss') {
    return scopeType !== 'portfolio_resume';
  }
  if (ruleKind === 'take_profit') {
    return scopeType === 'security';
  }
  return false;
}

const warmupWatchers = new Set();

function localIsoDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function shiftLocalDate(isoDate, days) {
  const d = new Date(`${isoDate}T12:00:00`);
  d.setDate(d.getDate() + days);
  return localIsoDate(d);
}

async function logicNeedsWarmup(pool, logicId) {
  const [{ warmup_pretest, rating_lookback_days }, stopResp] = await Promise.all([
    getTradingParams(pool, logicId),
    pool.query(
      `
      SELECT 1
      FROM logic_stops
      WHERE logic_id = $1
        AND rule_kind = 'stop_loss'
        AND scope_type IN ('security_resume', 'security_inversion')
        AND is_active = TRUE
      LIMIT 1
      `,
      [logicId]
    ),
  ]);
  return {
    enabled: warmup_pretest !== false && stopResp.rows.length > 0,
    lookbackDays: Math.max(1, Math.min(90, Number(rating_lookback_days) || 7)),
  };
}

async function transferWarmupSecurityState(pool, logicId, runId) {
  await pool.query(
    `
    UPDATE logic_securities
    SET
      real_trading_paused = FALSE,
      real_trading_paused_long = FALSE,
      real_trading_paused_short = FALSE,
      real_trading_inverted = FALSE,
      stop_resume_equity = NULL,
      stop_resume_baseline = NULL,
      stop_resume_triggered_at = NULL,
      stop_resume_equity_long = NULL,
      stop_resume_baseline_long = NULL,
      stop_resume_triggered_at_long = NULL,
      stop_resume_equity_short = NULL,
      stop_resume_baseline_short = NULL,
      stop_resume_triggered_at_short = NULL,
      stop_resume_hwm_long = NULL,
      stop_resume_hwm_short = NULL
    WHERE logic_id = $1
    `,
    [logicId]
  );
  await pool.query(
    `
    UPDATE logic_securities ls
    SET
      real_trading_paused_long = COALESCE(st.real_trading_paused_long, FALSE),
      real_trading_paused_short = COALESCE(st.real_trading_paused_short, FALSE),
      real_trading_paused = COALESCE(st.real_trading_paused_long, FALSE)
        OR COALESCE(st.real_trading_paused_short, FALSE)
        OR COALESCE(st.real_trading_paused, FALSE),
      real_trading_inverted = COALESCE(st.real_trading_inverted, FALSE),
      stop_resume_equity_long = st.stop_resume_equity_long,
      stop_resume_baseline_long = st.stop_resume_baseline_long,
      stop_resume_triggered_at_long = CASE
        WHEN COALESCE(st.real_trading_paused_long, FALSE) THEN CURRENT_TIMESTAMP
        ELSE NULL
      END,
      stop_resume_equity_short = st.stop_resume_equity_short,
      stop_resume_baseline_short = st.stop_resume_baseline_short,
      stop_resume_triggered_at_short = CASE
        WHEN COALESCE(st.real_trading_paused_short, FALSE) THEN CURRENT_TIMESTAMP
        ELSE NULL
      END,
      stop_resume_hwm_long = st.stop_resume_hwm_long,
      stop_resume_hwm_short = st.stop_resume_hwm_short,
      stop_resume_equity = NULL,
      stop_resume_baseline = NULL,
      stop_resume_triggered_at = CASE
        WHEN COALESCE(st.real_trading_paused_long, FALSE)
          OR COALESCE(st.real_trading_paused_short, FALSE)
          OR COALESCE(st.real_trading_paused, FALSE)
          OR COALESCE(st.real_trading_inverted, FALSE)
          THEN CURRENT_TIMESTAMP
        ELSE NULL
      END
    FROM logic_backtest_security_state st
    WHERE st.run_id = $2
      AND st.security_id = ls.security_id
      AND ls.logic_id = $1
    `,
    [logicId, runId]
  );
}

function watchWarmupBacktest(pool, logicId, runId) {
  const key = `${logicId}:${runId}`;
  if (warmupWatchers.has(key)) return;
  warmupWatchers.add(key);
  const poll = async () => {
    try {
      const status = await getBacktestStatus(pool, logicId, runId);
      if (!status || ['pending', 'loading_prices', 'loading_indicators', 'running'].includes(status.status)) {
        setTimeout(poll, 2000);
        return;
      }
      if (status.status === 'completed') {
        await transferWarmupSecurityState(pool, logicId, runId);
        const { rows } = await pool.query(
          `UPDATE logics SET is_enabled = TRUE WHERE id = $1 RETURNING id`,
          [logicId]
        );
        if (rows.length > 0) {
          await writeTechLogEvent(pool, {
            threadKey: `logic:${logicId}:warmup`,
            operation: 'logic.warmup.enabled',
            message: `Warm-up completed, logic enabled (run ${runId})`,
            source: 'api',
            logicId,
            payload: { run_id: runId },
          });
          startRatingPrecalc(pool, logicId).catch(() => {});
        }
      } else {
        await writeTechLogEvent(pool, {
          threadKey: `logic:${logicId}:warmup`,
          operation: 'logic.warmup.failed',
          message: `Warm-up finished with status ${status.status}; logic remains disabled`,
          source: 'api',
          logicId,
          payload: { run_id: runId, status },
        });
      }
    } catch (err) {
      console.error('watchWarmupBacktest', err);
      setTimeout(poll, 5000);
      return;
    }
    warmupWatchers.delete(key);
  };
  setTimeout(poll, 2000);
}

/**
 * After API restart / install-over: re-attach warm-up watchers and finish
 * warm-ups that completed while the process was down (checkbox intent = enable).
 */
async function resumeOrphanWarmups(pool) {
  const activeStatuses = ['pending', 'loading_prices', 'loading_indicators', 'running'];
  let watching = 0;
  let finished = 0;

  const { rows: active } = await pool.query(
    `
    SELECT l.id AS logic_id, r.id AS run_id
    FROM logics l
    JOIN logic_backtest_runs r ON r.logic_id = l.id
    WHERE l.is_enabled = FALSE
      AND r.status = ANY($1::text[])
      AND r.id = (
        SELECT MAX(r2.id) FROM logic_backtest_runs r2 WHERE r2.logic_id = l.id
      )
    `,
    [activeStatuses]
  );

  for (const row of active) {
    const need = await logicNeedsWarmup(pool, row.logic_id);
    if (!need.enabled) continue;
    watchWarmupBacktest(pool, row.logic_id, row.run_id);
    watching += 1;
  }

  const { rows: stuck } = await pool.query(
    `
    SELECT DISTINCT ON (e.logic_id)
      e.logic_id,
      (e.payload->>'run_id')::int AS run_id
    FROM app_tech_log e
    JOIN logics l ON l.id = e.logic_id
    JOIN logic_backtest_runs r ON r.id = (e.payload->>'run_id')::int
    WHERE e.operation = 'logic.warmup.started'
      AND e.logic_id IS NOT NULL
      AND l.is_enabled = FALSE
      AND e.created_at > NOW() - INTERVAL '7 days'
      AND r.status = 'completed'
      AND NOT EXISTS (
        SELECT 1
        FROM app_tech_log x
        WHERE x.logic_id = e.logic_id
          AND x.operation IN ('logic.warmup.enabled', 'logic.warmup.failed')
          AND x.created_at >= e.created_at
      )
    ORDER BY e.logic_id, e.created_at DESC
    `
  );

  for (const row of stuck) {
    if (!row.run_id) continue;
    const need = await logicNeedsWarmup(pool, row.logic_id);
    if (!need.enabled) continue;
    try {
      await transferWarmupSecurityState(pool, row.logic_id, row.run_id);
      const { rows } = await pool.query(
        `UPDATE logics SET is_enabled = TRUE WHERE id = $1 RETURNING id`,
        [row.logic_id]
      );
      if (rows.length > 0) {
        finished += 1;
        await writeTechLogEvent(pool, {
          threadKey: `logic:${row.logic_id}:warmup`,
          operation: 'logic.warmup.enabled',
          message: `Warm-up completed after API restart, logic enabled (run ${row.run_id})`,
          source: 'api',
          logicId: row.logic_id,
          payload: { run_id: row.run_id, resumed: true },
        });
        startRatingPrecalc(pool, row.logic_id).catch(() => {});
      }
    } catch (err) {
      console.error('resumeOrphanWarmups finish', row.logic_id, err.message);
    }
  }

  return { watching, finished };
}

function rewriteFormulaBasesNode(formula, values) {
  const text = String(formula ?? '');
  const at = text.indexOf('@');
  if (at < 0) return text;
  const open = text.indexOf('(', at);
  if (open < 0) return text;
  let depth = 0;
  let close = -1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return text;
  const inside = text.slice(open + 1, close);
  const parts = [];
  let cur = '';
  let d = 0;
  for (let i = 0; i < inside.length; i++) {
    const ch = inside[i];
    if (ch === '(') d++;
    else if (ch === ')') d = Math.max(0, d - 1);
    if (ch === ',' && d === 0) {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());

  const out = parts.map((p) => {
    if (!p || /^OPT\s*\(/i.test(p)) return p;
    const eq = p.indexOf('=');
    if (eq <= 0) return p;
    const key = p.slice(0, eq).trim();
    const canon = key.toLowerCase();
    for (const [vk, vv] of Object.entries(values || {})) {
      if (String(vk).toLowerCase() === canon && Number.isFinite(Number(vv))) {
        return `${key}=${vv}`;
      }
    }
    return p;
  });
  return text.slice(0, open + 1) + out.join(',') + text.slice(close);
}

function parseTimeHm(raw) {
  const s = String(raw ?? '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h < 0 || h > 23 || min < 0 || min > 59) {
    return null;
  }
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

async function fetchNonTradingIntervals(pool, logicId) {
  const { rows } = await pool.query(
    `
    SELECT
      id,
      logic_id,
      day_of_week,
      to_char(time_from, 'HH24:MI') AS time_from,
      to_char(time_to, 'HH24:MI') AS time_to,
      note,
      display_order,
      is_active
    FROM logic_non_trading_intervals
    WHERE logic_id = $1
    ORDER BY day_of_week, time_from, id
    `,
    [logicId]
  );
  return rows;
}

function btrimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function formatColumn(col) {
  let type = col.data_type;
  if (col.character_maximum_length) {
    type += `(${col.character_maximum_length})`;
  } else if (col.data_type === 'numeric' && col.numeric_precision) {
    type += `(${col.numeric_precision}${col.numeric_scale != null ? `,${col.numeric_scale}` : ''})`;
  } else if (col.data_type === 'USER-DEFINED') {
    type = col.udt_name;
  }
  return {
    name: col.column_name,
    type,
    nullable: col.is_nullable === 'YES',
    default: col.column_default,
    comment: col.comment || null,
  };
}

function formatConstraint(c) {
  const types = { p: 'PRIMARY KEY', f: 'FOREIGN KEY', u: 'UNIQUE', c: 'CHECK', x: 'EXCLUDE' };
  return {
    name: c.name,
    type: types[c.type] || c.type,
    definition: c.definition,
  };
}

function formatRoutine(r) {
  return {
    oid: r.oid,
    name: r.name,
    kind: r.kind === 'p' ? 'procedure' : 'function',
    arguments: r.arguments || '',
    result_type: r.result_type || null,
    description: r.description || null,
  };
}

function parseLogicTradingParams(body) {
  const out = { reset_balance: Boolean(body?.reset_balance) };
  let hasField = false;

  if (body?.timeframe !== undefined) {
    const tf = String(body.timeframe).trim().toUpperCase();
    if (!/^[A-Z0-9]+$/.test(tf)) {
      return { error: 'Таймфрейм: код вида M15, H1, D1' };
    }
    out.timeframe = tf;
    hasField = true;
  }

  if (body?.position_size_base !== undefined) {
    const base = String(body.position_size_base || '')
      .trim()
      .toLowerCase();
    if (
      base !== 'free_cash' &&
      base !== 'portfolio' &&
      base !== 'portfolio_incl_fund'
    ) {
      return {
        error:
          'База расчёта лота: свободные деньги, весь портфель без фонда или с фондом',
      };
    }
    out.position_size_base = base;
    hasField = true;
  }

  if (body?.position_size_pct !== undefined) {
    const v = Number(body.position_size_pct);
    if (!Number.isFinite(v) || v <= 0 || v > 100) {
      return { error: '% депозита: число от 0.01 до 100' };
    }
    out.position_size_pct = v;
    hasField = true;
  }

  if (body?.max_open_positions !== undefined) {
    const v = Number(body.max_open_positions);
    if (!Number.isInteger(v) || v <= 0) {
      return { error: 'Макс. позиций: целое число > 0' };
    }
    out.max_open_positions = v;
    hasField = true;
  }

  if (body?.max_order_amount !== undefined) {
    if (body.max_order_amount === null || body.max_order_amount === '') {
      out.max_order_amount = null;
    } else {
      const v = Number(body.max_order_amount);
      if (!Number.isFinite(v) || v < 0) {
        return { error: 'Макс. сумма на сделку: число ≥ 0 или пусто' };
      }
      out.max_order_amount = v;
    }
    hasField = true;
  }

  // Защита от займа при резком движении: буфер цены и гэп-фильтр входа (0–50 или пусто).
  for (const key of ['order_gap_buffer_pct', 'max_open_gap_pct']) {
    if (body?.[key] !== undefined) {
      if (body[key] === null || body[key] === '') {
        out[key] = null;
      } else {
        const v = Number(body[key]);
        if (!Number.isFinite(v) || v < 0 || v > 50) {
          return { error: `${key}: число от 0 до 50 или пусто` };
        }
        out[key] = v;
      }
      hasField = true;
    }
  }

  if (body?.initial_balance !== undefined) {
    if (body.initial_balance === null || body.initial_balance === '') {
      out.initial_balance = null;
    } else {
      const v = Number(body.initial_balance);
      if (!Number.isFinite(v) || v < 0) {
        return { error: 'Начальный остаток: число ≥ 0 или пусто' };
      }
      out.initial_balance = v;
    }
    hasField = true;
  }

  if (body?.commission_pct !== undefined) {
    const v = Number(body.commission_pct);
    if (!Number.isFinite(v) || v < 0 || v > 100) {
      return { error: '% комиссии: число от 0 до 100' };
    }
    out.commission_pct = v;
    hasField = true;
  }

  if (body?.cost_method !== undefined) {
    const m = String(body.cost_method).trim().toUpperCase();
    if (m !== 'FIFO' && m !== 'AVERAGE') {
      return { error: 'Метод PnL: FIFO или AVERAGE' };
    }
    out.cost_method = m;
    hasField = true;
  }

  if (body?.stop_loss_timeframe !== undefined) {
    const tf = String(body.stop_loss_timeframe).trim().toUpperCase();
    if (!/^[A-Z0-9]+$/.test(tf)) {
      return { error: 'Таймфрейм SL: код вида M5, M15, H1' };
    }
    out.stop_loss_timeframe = tf;
    hasField = true;
  }

  if (body?.base_annual_rate_pct !== undefined) {
    const v = Number(body.base_annual_rate_pct);
    if (!Number.isFinite(v) || v < 0 || v > 1000) {
      return { error: 'Базовая ставка (% годовых): число от 0 до 1000' };
    }
    out.base_annual_rate_pct = v;
    hasField = true;
  }

  if (body?.rating_lookback_days !== undefined) {
    const v = Math.round(Number(body.rating_lookback_days));
    if (!Number.isInteger(v) || v < 1 || v > 90) {
      return { error: 'Дней предрасчёта рейтинга: целое от 1 до 90' };
    }
    out.rating_lookback_days = v;
    hasField = true;
  }

  if (body?.inversion !== undefined) {
    out.inversion = Boolean(body.inversion);
    hasField = true;
  }

  if (body?.warmup_pretest !== undefined) {
    out.warmup_pretest = Boolean(body.warmup_pretest);
    hasField = true;
  }

  if (body?.resume_sl_no_reduce !== undefined) {
    out.resume_sl_no_reduce = Boolean(body.resume_sl_no_reduce);
    hasField = true;
  }

  if (body?.cash_fund_code !== undefined) {
    const code = String(body.cash_fund_code ?? '')
      .trim()
      .toUpperCase();
    if (!['', 'TMON', 'LQDT', 'SBMM'].includes(code)) {
      return { error: 'Денежный фонд: пусто, TMON, LQDT или SBMM' };
    }
    out.cash_fund_code = code;
    hasField = true;
  }

  if (body?.cash_fund_threshold !== undefined) {
    const v = Number(body.cash_fund_threshold);
    if (!Number.isFinite(v) || v < 0) {
      return { error: 'Порог свободных денег: число ≥ 0' };
    }
    out.cash_fund_threshold = v;
    hasField = true;
  }

  if (body?.use_non_trading_periods !== undefined) {
    out.use_non_trading_periods = Boolean(body.use_non_trading_periods);
    hasField = true;
  }

  if (body?.close_positions_eod !== undefined) {
    out.close_positions_eod = Boolean(body.close_positions_eod);
    hasField = true;
  }

  if (body?.sell_futures_before_expiry !== undefined) {
    out.sell_futures_before_expiry = Boolean(body.sell_futures_before_expiry);
    hasField = true;
  }

  if (body?.sell_futures_days_before_expiry !== undefined) {
    const v = Math.round(Number(body.sell_futures_days_before_expiry));
    if (!Number.isInteger(v) || v < 0 || v > 365) {
      return { error: 'Дней до экспирации: целое от 0 до 365' };
    }
    out.sell_futures_days_before_expiry = v;
    hasField = true;
  }

  if (body?.order_execution !== undefined) {
    const raw = String(body.order_execution ?? '')
      .trim()
      .toLowerCase();
    if (raw !== 'market' && raw !== 'limit' && raw !== 'l' && raw !== '') {
      return { error: 'Тип исполнения: market или limit' };
    }
    out.order_execution = raw === 'limit' || raw === 'l' ? 'limit' : 'market';
    hasField = true;
  }

  if (body?.opt_eval_candles !== undefined) {
    const v = Math.round(Number(body.opt_eval_candles));
    if (!Number.isInteger(v) || v < 1 || v > 500) {
      return { error: 'Свечей окна OPT: целое от 1 до 500' };
    }
    out.opt_eval_candles = v;
    hasField = true;
  }

  if (!hasField) {
    return { error: 'Укажите параметры торговли' };
  }
  return out;
}

function parseLogicBody(body) {
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const account_id = Number(body?.account_id);
  const is_enabled =
    body?.is_enabled === undefined ? true : Boolean(body.is_enabled);
  const note =
    body?.note == null || body.note === '' ? null : String(body.note).trim();

  if (!name) {
    return { error: 'Укажите имя логики' };
  }
  if (name.length > 100) {
    return { error: 'Имя логики не длиннее 100 символов' };
  }
  if (note != null && note.length > 2000) {
    return { error: 'Примечание не длиннее 2000 символов' };
  }
  if (!Number.isInteger(account_id) || account_id <= 0) {
    return { error: 'Выберите счёт' };
  }
  return { name, account_id, is_enabled, note };
}

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function parseDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const d = new Date(`${value}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return value;
}

function parseBrokerBody(body) {
  const code = typeof body?.code === 'string' ? body.code.trim() : '';
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const api_url =
    body?.api_url == null || body.api_url === ''
      ? null
      : String(body.api_url).trim();
  const is_active = body?.is_active === undefined ? true : Boolean(body.is_active);

  if (!code) return { error: 'Укажите код брокера' };
  if (code.length > 50) return { error: 'Код брокера не длиннее 50 символов' };
  if (!name) return { error: 'Укажите название брокера' };
  if (name.length > 100) return { error: 'Название брокера не длиннее 100 символов' };
  if (api_url && api_url.length > 255) return { error: 'URL API слишком длинный' };
  return { code, name, api_url, is_active };
}

function parseExchangeBody(body) {
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) return { error: 'Укажите название площадки' };
  if (name.length > 50) return { error: 'Название площадки не длиннее 50 символов' };
  return { name };
}

function parseIndicatorBody(body) {
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const description =
    body?.description == null || body.description === ''
      ? null
      : String(body.description).trim();
  const category =
    body?.category == null || body.category === ''
      ? null
      : String(body.category).trim();
  const script =
    body?.script == null || body.script === ''
      ? null
      : String(body.script).trim();
  let formula;
  if (body?.formula !== undefined) {
    formula =
      body.formula == null || body.formula === ''
        ? null
        : String(body.formula).trim();
  }
  const is_active = body?.is_active === undefined ? true : Boolean(body.is_active);

  if (!name) return { error: 'Укажите название индикатора' };
  if (name.length > 100) return { error: 'Название индикатора не длиннее 100 символов' };
  if (category && category.length > 50) return { error: 'Категория не длиннее 50 символов' };
  const out = { name, description, category, script, is_active };
  if (formula !== undefined) out.formula = formula;
  return out;
}

function parseIndicatorCreateBody(body) {
  const code =
    typeof body?.code === 'string' ? body.code.trim().toUpperCase() : '';
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const description =
    body?.description == null || body.description === ''
      ? null
      : String(body.description).trim();
  const category =
    body?.category == null || body.category === ''
      ? null
      : String(body.category).trim();
  const formula =
    typeof body?.formula === 'string' ? body.formula.trim() : '';
  const is_active = body?.is_active === undefined ? true : Boolean(body.is_active);

  if (!code) return { error: 'Укажите код индикатора' };
  if (!/^[A-Z][A-Z0-9_]{0,19}$/.test(code)) {
    return {
      error: 'Код: латиница A–Z, цифры и _, до 20 символов, начинается с буквы',
    };
  }
  if (!name) return { error: 'Укажите название индикатора' };
  if (name.length > 100) return { error: 'Название индикатора не длиннее 100 символов' };
  if (category && category.length > 50) return { error: 'Категория не длиннее 50 символов' };
  if (!formula) return { error: 'Укажите формулу индикатора' };
  return { code, name, description, category, formula, is_active };
}

async function runIndicatorSyncBackground({
  securityId,
  timeframeId,
  indicatorId,
  endDt,
  pointCount,
  incremental,
}) {
  const client = await dbPool.connect();
  try {
    await client.query(`SET statement_timeout = '300000'`);
    if (indicatorId) {
      await client.query(
        'CALL sync_security_indicator_series_for_indicator($1, $2, $3, $4::timestamp, $5, $6)',
        [securityId, indicatorId, timeframeId, endDt, pointCount, incremental]
      );
    } else {
      await client.query(
        'CALL sync_security_indicator_series_all($1, $2, $3::timestamp, $4, $5)',
        [securityId, timeframeId, endDt, pointCount, incremental]
      );
    }
  } catch (err) {
    console.error('background indicator sync failed', {
      securityId,
      timeframeId,
      indicatorId,
      error: err.message,
    });
  } finally {
    client.release();
  }
}

async function fetchIndicatorById(db, id) {
  const { rows } = await db.query(
    `
    SELECT
      i.id,
      i.code,
      i.name,
      i.script,
      i.formula,
      i.is_custom,
      i.description,
      i.category,
      i.is_active,
      COALESCE(
        json_agg(
          json_build_object(
            'id', vt.id,
            'code', vt.code,
            'name', vt.name,
            'value_type', vt.value_type,
            'is_threshold', vt.is_threshold,
            'threshold_value', vt.threshold_value,
            'display_order', vt.display_order
          )
          ORDER BY vt.display_order, vt.id
        ) FILTER (WHERE vt.id IS NOT NULL),
        '[]'::json
      ) AS value_types
    FROM indicators i
    LEFT JOIN indicator_value_types vt ON vt.indicator_id = i.id
    WHERE i.id = $1
    GROUP BY i.id
  `,
    [id]
  );
  return rows[0] ?? null;
}

function parseSecurityBody(body) {
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const prefix = typeof body?.prefix === 'string' ? body.prefix.trim().toUpperCase() : '';
  const exchange_id = Number(body?.exchange_id);
  const kind = body?.kind === 'futures' ? 'futures' : 'stock';
  const note =
    body?.note == null || body.note === '' ? null : String(body.note).trim();

  if (!name) return { error: 'Укажите название бумаги' };
  if (name.length > 200) return { error: 'Название не длиннее 200 символов' };
  if (!prefix) return { error: 'Укажите тикер (prefix)' };
  if (prefix.length > 50) return { error: 'Тикер не длиннее 50 символов' };
  if (!Number.isInteger(exchange_id) || exchange_id <= 0) {
    return { error: 'Выберите торговую площадку' };
  }
  return { name, prefix, exchange_id, kind, note };
}

function parseAccountBody(body) {
  const broker_id = Number(body?.broker_id);
  const account_code =
    typeof body?.account_code === 'string' ? body.account_code.trim() : '';
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const account_type = body?.account_type === 'real' ? 'real' : 'fake';
  const is_efficient = Boolean(body?.is_efficient);
  const is_active = body?.is_active === undefined ? true : Boolean(body.is_active);

  let api_token;
  if (body?.clear_token === true) {
    api_token = '';
  } else if (body?.api_token !== undefined) {
    api_token = typeof body.api_token === 'string' ? body.api_token.trim() : '';
  }

  if (!Number.isInteger(broker_id) || broker_id <= 0) {
    return { error: 'Выберите брокера' };
  }
  const isReal = account_type === 'real';
  if (!isReal && !account_code) return { error: 'Укажите код счёта' };
  if (account_code && account_code.length > 100) {
    return { error: 'Код счёта не длиннее 100 символов' };
  }
  if (!isReal && !name) return { error: 'Укажите название счёта' };
  if (name && name.length > 100) return { error: 'Название счёта не длиннее 100 символов' };
  return {
    broker_id,
    account_code,
    name,
    account_type,
    is_efficient,
    is_active,
    api_token,
  };
}

async function fillRealTbankAccountFromToken(parsed, existingAccountId) {
  if (parsed.account_type !== 'real') {
    return parsed;
  }
  const { rows: brokers } = await dbPool.query(
    'SELECT id, code, api_url FROM brokers WHERE id = $1',
    [parsed.broker_id]
  );
  if (brokers.length === 0 || brokers[0].code !== 'T-BANK') {
    return parsed;
  }

  let token = parsed.api_token;
  if (!token && existingAccountId) {
    const { rows } = await dbPool.query(
      'SELECT token_encrypted FROM accounts WHERE id = $1',
      [existingAccountId]
    );
    token = rows[0]?.token_encrypted || '';
    if (token) parsed._has_stored_token = true;
  }

  if (!token) {
    if (!parsed.account_code) {
      return { error: 'Укажите API-токен T-Bank' };
    }
    return parsed;
  }

  try {
    const resolved = await pgResolveTbankAccount(
      brokers[0].api_url,
      token,
      parsed.account_code || null
    );
    parsed.account_code = resolved.account_id;
    if (!parsed.name) {
      parsed.name =
        resolved.account_name || `T-Bank ${String(resolved.account_id).slice(0, 8)}`;
    }
    return parsed;
  } catch (err) {
    return { error: err.message };
  }
}

function tokenFieldsFromParsed(parsed) {
  const token = parsed.api_token || null;
  return {
    token_encrypted: token,
    token_hash: token ? hashToken(token) : null,
  };
}

function buildTokenUpdateClause(parsed, startIndex) {
  if (parsed.api_token === undefined) {
    return { sql: '', extraValues: [] };
  }
  if (parsed.api_token === '') {
    return {
      sql: ', token_encrypted = NULL, token_hash = NULL',
      extraValues: [],
    };
  }
  return {
    sql: `, token_encrypted = $${startIndex}, token_hash = $${startIndex + 1}`,
    extraValues: [parsed.api_token, hashToken(parsed.api_token)],
  };
}

function stripAccountSecrets(row) {
  const { broker_api_url, token_encrypted, ...safe } = row;
  return safe;
}

async function enrichAccountBalance(row) {
  const base = {
    ...row,
    balance: null,
    balance_currency: null,
    balance_display: '—',
    balance_error: null,
  };
  if (row.account_type === 'fake') {
    base.balance_display = 'демо';
    return base;
  }
  if (!row.has_token) {
    return base;
  }
  if (row.broker_code !== 'T-BANK') {
    base.balance_display = 'н/д';
    return base;
  }
  try {
    // Prefer Node TLS (Russian CA); SQL pgsql-http often fails with self-signed chain.
    const {
      resolveTbankAccount,
      fetchPortfolioBalance,
      DEFAULT_API,
    } = require('./tbank-invest-client');
    const { rows: tokRows } = await dbPool.query(
      `SELECT btrim(a.token_encrypted) AS token,
              COALESCE(NULLIF(btrim(b.api_url), ''), $2) AS api_url,
              a.account_code
       FROM accounts a
       JOIN brokers b ON b.id = a.broker_id
       WHERE a.id = $1`,
      [row.id, DEFAULT_API]
    );
    const tok = tokRows[0];
    if (!tok?.token) {
      return base;
    }
    const resolved = await resolveTbankAccount(
      tok.api_url,
      tok.token,
      tok.account_code || null
    );
    const bal = await fetchPortfolioBalance(
      tok.api_url,
      tok.token,
      resolved.account_id
    );
    base.balance = bal.amount != null ? Number(bal.amount) : null;
    base.cash_amount = bal.cash_amount != null ? Number(bal.cash_amount) : null;
    base.balance_currency = bal.currency ?? null;
    base.balance_error = null;
    base.balance_display = bal.display ?? '—';
  } catch (err) {
    try {
      const { rows } = await dbPool.query(
        `SELECT fetch_tbank_account_balance($1) AS bal`,
        [row.id]
      );
      const bal = rows[0]?.bal ?? {};
      base.balance = bal.amount != null ? Number(bal.amount) : null;
      base.cash_amount = bal.cash_amount != null ? Number(bal.cash_amount) : null;
      base.balance_currency = bal.currency ?? null;
      base.balance_error = bal.error ? String(bal.error) : null;
      base.balance_display = base.balance_error
        ? bal.display || 'ошибка'
        : bal.display ?? '—';
    } catch (_sqlErr) {
      base.balance_error = err.message || String(err);
      base.balance_display = 'ошибка';
    }
  }
  return base;
}

async function pgResolveTbankAccount(apiUrl, token, preferredAccountId) {
  // Prefer Node fetch + Russian Trusted CA (pgsql-http/libcurl often fails SSL on Windows).
  const {
    resolveTbankAccount,
    DEFAULT_API,
  } = require('./tbank-invest-client');
  try {
    return await resolveTbankAccount(
      apiUrl || DEFAULT_API,
      token,
      preferredAccountId || null
    );
  } catch (nodeErr) {
    try {
      const { rows } = await dbPool.query(
        `SELECT resolve_tbank_account($1, $2, $3) AS r`,
        [apiUrl, token, preferredAccountId || null]
      );
      const r = rows[0]?.r ?? {};
      const accounts = Array.isArray(r.accounts) ? r.accounts : [];
      return {
        accounts,
        account_id: r.account_id ?? '',
        account_name: r.account_name ?? '',
      };
    } catch (_sqlErr) {
      throw nodeErr;
    }
  }
}

async function pgFetchTbankPortfolioBalance(apiUrl, token, accountId) {
  const {
    fetchPortfolioBalance,
    DEFAULT_API,
  } = require('./tbank-invest-client');
  try {
    return await fetchPortfolioBalance(apiUrl || DEFAULT_API, token, accountId);
  } catch (nodeErr) {
    try {
      const { rows } = await dbPool.query(
        `SELECT fetch_tbank_portfolio_balance($1, $2, $3) AS bal`,
        [apiUrl, token, accountId]
      );
      const bal = rows[0]?.bal ?? {};
      return {
        amount: bal.amount != null ? Number(bal.amount) : null,
        cash_amount: bal.cash_amount != null ? Number(bal.cash_amount) : null,
        currency: bal.currency ?? null,
        display: bal.display ?? null,
      };
    } catch (_sqlErr) {
      throw nodeErr;
    }
  }
}

async function resolveAccountConnection(body) {
  const broker_id = Number(body?.broker_id);
  const account_code =
    typeof body?.account_code === 'string' ? body.account_code.trim() : '';
  const account_id = body?.account_id ? Number(body.account_id) : null;
  let api_token =
    typeof body?.api_token === 'string' ? body.api_token.trim() : '';

  let brokerRow;
  if (Number.isInteger(broker_id) && broker_id > 0) {
    const { rows: brokers } = await dbPool.query(
      'SELECT id, code, api_url FROM brokers WHERE id = $1',
      [broker_id]
    );
    brokerRow = brokers[0];
  } else {
    const { rows: brokers } = await dbPool.query(
      "SELECT id, code, api_url FROM brokers WHERE code = 'T-BANK' LIMIT 1"
    );
    brokerRow = brokers[0];
  }

  if (!brokerRow) {
    return { error: 'Брокер T-Bank не найден в справочнике' };
  }
  if (brokerRow.code !== 'T-BANK') {
    return { error: 'Проверка по токену пока поддерживается только для T-Bank' };
  }

  if (!api_token && account_id) {
    const { rows } = await dbPool.query(
      'SELECT token_encrypted FROM accounts WHERE id = $1',
      [account_id]
    );
    api_token = rows[0]?.token_encrypted || '';
  }
  if (!api_token) {
    return { error: 'Укажите API-токен' };
  }

  return {
    token: api_token,
    account_code: account_code || null,
    broker_api_url: brokerRow.api_url,
    broker_id: brokerRow.id,
  };
}

function handleDbError(res, err, label) {
  console.error(label, err);
  if (err.code === '23505') {
    res.status(409).json({ error: 'Запись с такими ключевыми полями уже существует' });
    return;
  }
  if (err.code === '23503') {
    res.status(400).json({
      error: 'Нельзя удалить или изменить: есть связанные записи в других таблицах',
    });
    return;
  }
  res.status(500).json({ error: err.message });
}

/** Bundle for route modules: pool + shared fns + service imports already required above. */
function createRouteContext(pool) {
  dbPool = pool;
  return {
    pool,
    hashToken,
    startBacktest,
    getBacktestStatus,
    cancelBacktest,
    resolveLastOptGridResults,
    listBacktestReports,
    getBacktestReport,
    getBacktestReportNeighbors,
    persistBacktestReport,
    startRatingPrecalc,
    getRatingPrecalcStatus,
    runTradeCycle,
    getTradeRunnerHealth,
    runWatchdogTick,
    touchUiHeartbeatDb,
    clearUiHeartbeatDb,
    isUiSessionActive,
    validateOptFormulaSave,
    getTradingParams,
    getTradingParamsForLogics,
    saveTradingParams,
    ensureDefaultParams,
    getLogicParamsDetailed,
    syncRealAccountBalancesIfNeeded,
    resetLogicTradingStateOnAccountChange,
    resetLogicShadowTradingState,
    buildLogicBundle,
    importLogicBundle,
    writeTechLogEvent,
    assertRealTbankAccount,
    sellAllPositions,
    closeAllLogicPositions,
    planBuyBonds,
    executeBuyBonds,
    listBondFunds,
    getAccountCash,
    VALID_STOP_SCOPES,
    TAKE_PROFIT_SCOPES,
    isScopeValidForRuleKind,
    isScopeChoosableForRuleKind,
    warmupWatchers,
    localIsoDate,
    shiftLocalDate,
    logicNeedsWarmup,
    transferWarmupSecurityState,
    watchWarmupBacktest,
    resumeOrphanWarmups,
    rewriteFormulaBasesNode,
    parseTimeHm,
    fetchNonTradingIntervals,
    btrimStr,
    formatColumn,
    formatConstraint,
    formatRoutine,
    parseLogicTradingParams,
    parseLogicBody,
    parseId,
    parseDateString,
    parseBrokerBody,
    parseExchangeBody,
    parseIndicatorBody,
    parseIndicatorCreateBody,
    runIndicatorSyncBackground,
    fetchIndicatorById,
    parseSecurityBody,
    parseAccountBody,
    fillRealTbankAccountFromToken,
    tokenFieldsFromParsed,
    buildTokenUpdateClause,
    stripAccountSecrets,
    enrichAccountBalance,
    pgResolveTbankAccount,
    pgFetchTbankPortfolioBalance,
    resolveAccountConnection,
    handleDbError,
  };
}

module.exports = {
  createRouteContext,
  resumeOrphanWarmups,
};
