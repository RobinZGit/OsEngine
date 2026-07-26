/**
 * MultiLogicTradePg Express API — мост Angular ↔ PostgreSQL.
 *
 * Группы маршрутов (кратко для разработчика / справки UI):
 * - /api/logics, /api/logic-params, signals, stops, securities, trades — торговые логики
 * - /api/securities, /api/prices, /api/security-indicator-series, /api/indicators — рынок и индикаторы
 * - /api/settings/* — T-Bank токен, tech-logging, cleanup; /api/maintenance/cleanup
 * - /api/schema — дерево БД для шестерёнки (obj_description функций/процедур)
 * - trade-runner / backtest / rating-precalc — фоновые циклы
 *
 * Пользовательская справка: иконка книги в шапке Angular.
 * Комментарии SQL: COMMENT ON FUNCTION/PROCEDURE в 01/02 и sql/routine_comments_missing.sql.
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const {
  hashToken,
} = require('./tbank');
const {
  startBacktest,
  getBacktestStatus,
  cancelBacktest,
  resumeOrphanBacktests,
} = require('./logic-backtest');
const {
  listBacktestReports,
  getBacktestReport,
  getBacktestReportNeighbors,
  persistBacktestReport,
} = require('./backtest-report-persist');
const {
  startRatingPrecalc,
  getRatingPrecalcStatus,
} = require('./logic-rating-precalc');
const { runTradeCycle, startTradeRunner } = require('./trade-runner');
const { startMaintenanceScheduler } = require('./maintenance-scheduler');
const {
  touchUiHeartbeatDb,
  clearUiHeartbeatDb,
  isUiSessionActive,
} = require('./lib/trade-runner-session');
const { validateOptFormulaSave } = require('./lib/signal-opt');
const {
  getTradingParams,
  getTradingParamsForLogics,
  saveTradingParams,
  ensureDefaultParams,
  getLogicParamsDetailed,
  syncRealAccountBalancesIfNeeded,
  resetLogicTradingStateOnAccountChange,
} = require('./lib/logic-params');
const { buildLogicBundle, importLogicBundle } = require('./lib/logic-bundle');
const { writeTechLogEvent } = require('./lib/tech-log');
const {
  assertRealTbankAccount,
  sellAllPositions,
  planBuyBonds,
  executeBuyBonds,
  listBondFunds,
  getAccountCash,
} = require('./lib/account-portfolio-actions');

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
    return scopeType !== 'security_inversion' && scopeType !== 'portfolio_resume';
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
      stop_resume_triggered_at_short = NULL
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

const app = express();
const port = Number(process.env.PORT) || 3000;
const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:4200';

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT) || 5432,
  database: process.env.PGDATABASE || 'multilogictrade',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD,
  // Бой (по логикам) + бэктест (×2) + UI poll + прекалк рейтингов
  max: Math.max(10, Math.min(40, Number(process.env.PGPOOL_MAX) || 24)),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
});

app.use(cors({ origin: corsOrigin }));
app.use(express.json());

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, database: process.env.PGDATABASE || 'multilogictrade' });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

app.get('/api/settings/tbank-token', async (req, res) => {
  const validate = req.query.validate === '1' || req.query.validate === 'true';
  try {
    if (validate) {
      const { rows } = await pool.query(
        'SELECT tbank_verify_token() AS status'
      );
      const status = rows[0]?.status ?? {};
      res.json({
        has_token: Boolean(status.has_token),
        valid: Boolean(status.valid),
        error_message: status.error_message ?? null,
      });
      return;
    }
    const { rows } = await pool.query(
      'SELECT tbank_token_is_configured() AS has_token'
    );
    res.json({ has_token: Boolean(rows[0]?.has_token) });
  } catch (err) {
    console.error('GET /api/settings/tbank-token', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings/tbank-token', async (req, res) => {
  const token =
    typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!token) {
    res.status(400).json({ error: 'Укажите токен T-Bank' });
    return;
  }
  try {
    // Сохраняем предыдущий токен: verify идёт после UPSERT — при ошибке откатываем
    const { rows: prevRows } = await pool.query(
      `SELECT btrim(COALESCE(pv.value, '')) AS token
       FROM parameter_values pv
       JOIN parameter_types pt ON pt.id = pv.parameter_type_id
       JOIN parameter_sets ps ON ps.id = pv.parameter_set_id
       WHERE ps.name = 'Default' AND pt.short_name = 'TBANK_API_TOKEN'
       LIMIT 1`
    );
    const previousToken = prevRows[0]?.token || '';

    await pool.query('CALL set_tbank_token($1)', [token]);
    const { rows } = await pool.query('SELECT tbank_verify_token() AS status');
    const status = rows[0]?.status ?? {};
    if (!status.valid) {
      if (previousToken && previousToken !== token) {
        await pool.query('CALL set_tbank_token($1)', [previousToken]);
      }
      res.status(400).json({
        error:
          status.error_message ||
          'T-Bank не принял токен. Предыдущий токен восстановлен.',
        has_token: previousToken !== '',
        valid: false,
        error_message: status.error_message ?? null,
      });
      return;
    }
    res.json({
      ok: true,
      has_token: true,
      valid: true,
      error_message: null,
    });
  } catch (err) {
    console.error('PUT /api/settings/tbank-token', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/settings/tech-logging', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT app_tech_logging_enabled() AS enabled'
    );
    res.json({ enabled: Boolean(rows[0]?.enabled) });
  } catch (err) {
    console.error('GET /api/settings/tech-logging', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings/tech-logging', async (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  try {
    await pool.query('CALL set_app_tech_logging($1)', [enabled]);
    if (enabled) {
      await writeTechLogEvent(pool, {
        threadKey: 'settings',
        operation: 'logging.enabled',
        message: 'Техническое логирование включено (UI)',
        source: 'api',
      });
    }
    res.json({ ok: true, enabled });
  } catch (err) {
    console.error('PUT /api/settings/tech-logging', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/settings/cleanup', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT cleanup_unused_market_data_enabled() AS enabled'
    );
    res.json({ enabled: Boolean(rows[0]?.enabled) });
  } catch (err) {
    console.error('GET /api/settings/cleanup', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings/cleanup', async (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  try {
    await pool.query('CALL set_cleanup_unused_market_data($1)', [enabled]);
    res.json({ ok: true, enabled });
  } catch (err) {
    console.error('PUT /api/settings/cleanup', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/maintenance/cleanup', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT cleanup_trading_disk_space() AS result'
    );
    const result = rows[0]?.result ?? {};
    if (result && result.skipped) {
      return res.status(409).json({
        ok: false,
        skipped: true,
        error: result.message || result.reason || 'cleanup_lock_busy',
        result,
      });
    }
    res.json({ ok: true, result });
  } catch (err) {
    console.error('POST /api/maintenance/cleanup', err);
    const msg = String(err.message || '');
    // Типичные ошибки при пересечении с боем: lock_timeout / statement_timeout
    if (/lock timeout|canceling statement due to|statement timeout/i.test(msg)) {
      return res.status(409).json({
        error:
          'Очистка прервана из‑за блокировок Postgres (бой/загрузка цен). Повторите, когда торговля спокойнее, или выключите галочку.',
        detail: msg,
      });
    }
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/indicators', async (req, res) => {
  const withCalc = req.query.with_calc === '1';
  try {
    const { rows } = await pool.query(
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
        i.sig_trend_def,
        i.sig_ct_def,
        i.sig_profile,
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
      WHERE ($1::boolean = FALSE OR (BTRIM(COALESCE(i.script, '')) <> '' OR BTRIM(COALESCE(i.formula, '')) <> ''))
      GROUP BY i.id
      ORDER BY i.code
    `,
      [withCalc]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/indicators', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/indicators', async (req, res) => {
  const parsed = parseIndicatorCreateBody(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const client = await pool.connect();
  try {
    const { rows: formulaOk } = await client.query(
      'SELECT poly_is_formula($1) AS ok',
      [parsed.formula]
    );
    if (!formulaOk[0]?.ok) {
      res.status(400).json({
        error: 'Формула должна быть многочленной (pp, sma, @RSI, …), не calc_*',
      });
      return;
    }
    await client.query('BEGIN');
    const { rows: inserted } = await client.query(
      `INSERT INTO indicators (code, name, description, category, formula, is_custom, is_active)
       VALUES ($1, $2, $3, $4, $5, TRUE, $6)
       RETURNING id`,
      [
        parsed.code,
        parsed.name,
        parsed.description,
        parsed.category,
        parsed.formula,
        parsed.is_active,
      ]
    );
    const indicatorId = inserted[0].id;
    await client.query(
      `INSERT INTO indicator_value_types
         (indicator_id, code, name, value_type, is_threshold, threshold_value, description, display_order)
       VALUES ($1, 'VALUE', $2, 'float', FALSE, NULL, $3, 1)`,
      [indicatorId, parsed.name, parsed.formula]
    );
    await client.query('COMMIT');
    const full = await fetchIndicatorById(client, indicatorId);
    res.status(201).json(full);
  } catch (err) {
    await client.query('ROLLBACK');
    handleDbError(res, err, 'POST /api/indicators');
  } finally {
    client.release();
  }
});

app.put('/api/indicators/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'Invalid indicator id' });
    return;
  }
  const parsed = parseIndicatorBody(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const { rows: existing } = await pool.query(
      'SELECT id, is_custom FROM indicators WHERE id = $1',
      [id]
    );
    if (existing.length === 0) {
      res.status(404).json({ error: 'Indicator not found' });
      return;
    }
    const isCustom = Boolean(existing[0].is_custom);
    if (parsed.formula !== undefined && isCustom) {
      const { rows: formulaOk } = await pool.query(
        'SELECT poly_is_formula($1) AS ok',
        [parsed.formula]
      );
      if (!parsed.formula || !formulaOk[0]?.ok) {
        res.status(400).json({
          error: 'Формула должна быть многочленной (pp, sma, @RSI, …), не calc_*',
        });
        return;
      }
    }
    if (isCustom) {
      await pool.query(
        `UPDATE indicators
         SET name = $1, description = $2, category = $3, formula = $4, is_active = $5
         WHERE id = $6`,
        [
          parsed.name,
          parsed.description,
          parsed.category,
          parsed.formula ?? null,
          parsed.is_active,
          id,
        ]
      );
    } else {
      await pool.query(
        `UPDATE indicators
         SET name = $1, description = $2, category = $3, script = $4, is_active = $5
         WHERE id = $6`,
        [
          parsed.name,
          parsed.description,
          parsed.category,
          parsed.script,
          parsed.is_active,
          id,
        ]
      );
    }
    const full = await fetchIndicatorById(pool, id);
    res.json(full);
  } catch (err) {
    handleDbError(res, err, 'PUT /api/indicators/:id');
  }
});

app.get('/api/security-indicator-series', async (req, res) => {
  const securityId = parseId(req.query.security_id);
  if (!securityId) {
    res.status(400).json({ error: 'Укажите security_id' });
    return;
  }
  try {
    const { rows } = await pool.query(
      `
      SELECT
        sis.id,
        sis.security_id,
        sis.indicator_id,
        sis.series_code,
        sis.invoke_formula,
        sis.param_period,
        sis.param_fast_period,
        sis.param_slow_period,
        sis.param_signal_period,
        sis.param_std_dev,
        sis.param_k_period,
        sis.param_d_period,
        sis.param_smooth,
        sis.point_count,
        sis.display_order,
        sis.is_active,
        i.code AS indicator_code,
        i.name AS indicator_name
      FROM security_indicator_series sis
      JOIN indicators i ON i.id = sis.indicator_id
      WHERE sis.security_id = $1 AND sis.is_active = TRUE
      ORDER BY sis.display_order, sis.id
    `,
      [securityId]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/security-indicator-series', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/security-indicator-series', async (req, res) => {
  const securityId = parseId(req.body?.security_id);
  const indicatorId = parseId(req.body?.indicator_id);
  const timeframeId = parseId(req.body?.timeframe_id);
  if (!securityId || !indicatorId) {
    res.status(400).json({ error: 'Укажите security_id и indicator_id' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = '15000'`);
    await client.query('CALL ensure_security_indicator_series($1, $2)', [
      securityId,
      indicatorId,
    ]);
    // Расчёт — отдельно через POST /sync (не блокируем добавление серии).
    const { rows } = await client.query(
      `
      SELECT
        sis.id,
        sis.security_id,
        sis.indicator_id,
        sis.series_code,
        sis.invoke_formula,
        sis.point_count,
        sis.display_order,
        sis.is_active,
        i.code AS indicator_code,
        i.name AS indicator_name
      FROM security_indicator_series sis
      JOIN indicators i ON i.id = sis.indicator_id
      WHERE sis.security_id = $1 AND sis.indicator_id = $2 AND sis.is_active = TRUE
      ORDER BY sis.display_order, sis.id
    `,
      [securityId, indicatorId]
    );
    res.status(201).json(rows);
  } catch (err) {
    console.error('POST /api/security-indicator-series', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete('/api/security-indicator-series/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM security_indicator_series WHERE id = $1',
      [id]
    );
    if (rowCount === 0) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    handleDbError(res, err, 'DELETE /api/security-indicator-series/:id');
  }
});

app.post('/api/security-indicator-series/sync', async (req, res) => {
  const securityId = parseId(req.body?.security_id);
  const timeframeId = parseId(req.body?.timeframe_id);
  const indicatorId = parseId(req.body?.indicator_id);
  const endDt = req.body?.end_dt ? String(req.body.end_dt) : null;
  const pointCount = parseId(req.body?.point_count);
  const incremental = req.body?.incremental !== false;
  const runAsync = req.body?.async === true;
  if (!securityId || !timeframeId) {
    res.status(400).json({ error: 'Укажите security_id и timeframe_id' });
    return;
  }

  if (runAsync) {
    res.status(202).json({ ok: true, status: 'started' });
    runIndicatorSyncBackground({
      securityId,
      timeframeId,
      indicatorId,
      endDt,
      pointCount,
      incremental,
    }).catch((err) => {
      console.error('POST /api/security-indicator-series/sync async', err);
    });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = '120000'`);
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
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/security-indicator-series/sync', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/indicators/calculate', async (req, res) => {
  const securityId = parseId(req.body?.security_id);
  const timeframeId = parseId(req.body?.timeframe_id);
  const indicatorId = parseId(req.body?.indicator_id);
  const dateFrom = req.body?.date_from ? String(req.body.date_from) : null;
  const dateTo = req.body?.date_to ? String(req.body.date_to) : null;
  const overwrite = req.body?.overwrite === true;
  if (!securityId || !timeframeId || !indicatorId || !dateFrom || !dateTo) {
    res.status(400).json({
      error: 'Укажите security_id, timeframe_id, indicator_id, date_from, date_to',
    });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = '120000'`);
    await client.query(`SET lock_timeout = '15000'`);
    await client.query(
      `CALL calculate_indicator($1, $2, $3, $4::date, $5::date, $6)`,
      [securityId, timeframeId, indicatorId, dateFrom, dateTo, overwrite]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/indicators/calculate', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/indicator-values', async (req, res) => {
  const securityId = parseId(req.query.security_id);
  const timeframeId = parseId(req.query.timeframe_id);
  const indicatorIdsRaw = req.query.indicator_ids
    ? String(req.query.indicator_ids)
    : '';
  const indicatorIds = indicatorIdsRaw
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  const before = req.query.before ? String(req.query.before) : null;
  const after = req.query.after ? String(req.query.after) : null;
  const limitRaw = Number(req.query.limit);
  // Без лимита UI разворота бумаги забивался 7+ МБ JSON и «висел».
  const limit =
    Number.isInteger(limitRaw) && limitRaw > 0
      ? Math.min(limitRaw, 4000)
      : 1500;
  if (!securityId || !timeframeId || indicatorIds.length === 0) {
    res.status(400).json({
      error: 'Укажите security_id, timeframe_id и indicator_ids (через запятую)',
    });
    return;
  }
  try {
    const params = [securityId, timeframeId, indicatorIds];
    let rangeClause = '';
    if (before) {
      params.push(before);
      rangeClause += ` AND iv.dt <= $${params.length}::timestamp`;
    }
    if (after) {
      params.push(after);
      rangeClause += ` AND iv.dt >= $${params.length}::timestamp`;
    }
    // Если окно не задано — только хвост истории (не вся таблица).
    if (!before && !after) {
      params.push(limit);
      const { rows } = await pool.query(
        `
        SELECT * FROM (
          SELECT
            iv.indicator_id,
            i.code AS indicator_code,
            ivt.code AS line_code,
            ivt.name AS line_name,
            ivt.is_threshold,
            ivt.display_order,
            iv.dt,
            iv.value
          FROM indicator_values iv
          JOIN indicators i ON i.id = iv.indicator_id
          JOIN indicator_value_types ivt ON ivt.id = iv.indicator_value_type_id
          WHERE iv.security_id = $1
            AND iv.timeframe_id = $2
            AND iv.indicator_id = ANY($3::int[])
          ORDER BY iv.dt DESC, iv.indicator_id, ivt.display_order, ivt.id
          LIMIT $4
        ) t
        ORDER BY t.dt, t.indicator_id, t.display_order
        `,
        params
      );
      res.json(rows);
      return;
    }
    params.push(limit);
    const { rows } = await pool.query(
      `
      SELECT * FROM (
        SELECT
          iv.indicator_id,
          i.code AS indicator_code,
          ivt.code AS line_code,
          ivt.name AS line_name,
          ivt.is_threshold,
          ivt.display_order,
          iv.dt,
          iv.value
        FROM indicator_values iv
        JOIN indicators i ON i.id = iv.indicator_id
        JOIN indicator_value_types ivt ON ivt.id = iv.indicator_value_type_id
        WHERE iv.security_id = $1
          AND iv.timeframe_id = $2
          AND iv.indicator_id = ANY($3::int[])
          ${rangeClause}
        ORDER BY iv.dt DESC, iv.indicator_id, ivt.display_order, ivt.id
        LIMIT $${params.length}
      ) t
      ORDER BY t.dt, t.indicator_id, t.display_order
      `,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/indicator-values', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/timeframes', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, tf, full_name, sec, is_active
      FROM timeframes
      WHERE is_active = TRUE
      ORDER BY sec
    `);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/timeframes', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/securities', async (req, res) => {
  const exchangeId = parseId(req.query.exchange_id);
  const kind = req.query.kind === 'futures' ? 'futures' : req.query.kind === 'stock' ? 'stock' : null;
  if (!exchangeId) {
    res.status(400).json({ error: 'Укажите exchange_id' });
    return;
  }
  try {
    let typeFilter = '';
    if (kind === 'stock') {
      typeFilter = `AND st.name IN ('Stock', 'PreferredStock') AND sp.instrument_market = 'stock'`;
    } else if (kind === 'futures') {
      typeFilter = `AND st.name = 'Futures' AND sp.instrument_market = 'futures'`;
    }
    const { rows } = await pool.query(
      `
      SELECT
        s.id,
        s.name,
        s.lot_size,
        st.name AS security_type,
        sp.prefix,
        sp.instrument_market,
        sp.exchange_id,
        e.name AS exchange_name
      FROM securities s
      JOIN security_types st ON st.id = s.security_type_id
      JOIN security_prefixes sp ON sp.security_id = s.id AND sp.exchange_id = $1
      JOIN exchanges e ON e.id = sp.exchange_id
      WHERE 1=1 ${typeFilter}
      ORDER BY s.name
    `,
      [exchangeId]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/securities', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/securities', async (req, res) => {
  const parsed = parseSecurityBody(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const typeName = parsed.kind === 'futures' ? 'Futures' : 'Stock';
    const { rows: typeRows } = await client.query(
      'SELECT id FROM security_types WHERE name = $1',
      [typeName]
    );
    if (typeRows.length === 0) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: `Тип ${typeName} не найден` });
      return;
    }
    const instrumentMarket = parsed.kind === 'futures' ? 'futures' : 'stock';
    const { rows: secRows } = await client.query(
      `INSERT INTO securities (name, security_type_id)
       VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET security_type_id = EXCLUDED.security_type_id
       RETURNING id, name, security_type_id`,
      [parsed.name, typeRows[0].id]
    );
    const securityId = secRows[0].id;
    await client.query(
      `INSERT INTO security_prefixes (security_id, exchange_id, prefix, instrument_market, tbank_figi, note)
       VALUES ($1, $2, $3, $4, NULL, $5)
       ON CONFLICT (security_id, exchange_id) DO UPDATE SET
         prefix = EXCLUDED.prefix,
         instrument_market = EXCLUDED.instrument_market,
         note = EXCLUDED.note`,
      [securityId, parsed.exchange_id, parsed.prefix, instrumentMarket, parsed.note || null]
    );
    await client.query('COMMIT');
    const { rows } = await pool.query(
      `
      SELECT s.id, s.name, st.name AS security_type, sp.prefix, sp.instrument_market,
             sp.exchange_id, e.name AS exchange_name
      FROM securities s
      JOIN security_types st ON st.id = s.security_type_id
      JOIN security_prefixes sp ON sp.security_id = s.id
      JOIN exchanges e ON e.id = sp.exchange_id
      WHERE s.id = $1 AND sp.exchange_id = $2
    `,
      [securityId, parsed.exchange_id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    handleDbError(res, err, 'POST /api/securities');
  } finally {
    client.release();
  }
});

app.get('/api/prices', async (req, res) => {
  const securityId = parseId(req.query.security_id);
  const timeframeId = parseId(req.query.timeframe_id);
  const limitRaw = Number(req.query.limit);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 120;
  const before = req.query.before ? String(req.query.before) : null;
  if (!securityId || !timeframeId) {
    res.status(400).json({ error: 'Укажите security_id и timeframe_id' });
    return;
  }
  try {
    const params = [securityId, timeframeId, limit];
    let beforeClause = '';
    if (before) {
      beforeClause = 'AND dt < $4::timestamp';
      params.push(before);
    }
    const { rows } = await pool.query(
      `
      SELECT
        to_char(p.dt, 'YYYY-MM-DD HH24:MI:SS') AS dt,
        p.open_price, p.high_price, p.low_price, p.close_price, p.volume,
             p.contract_prefix,
             sp.prefix AS group_prefix
      FROM prices p
      LEFT JOIN security_prefixes sp ON sp.security_id = p.security_id
      WHERE p.security_id = $1 AND p.timeframe_id = $2
      ${beforeClause}
      ORDER BY p.dt DESC
      LIMIT $3
    `,
      params
    );
    rows.reverse();
    res.json(rows);
  } catch (err) {
    console.error('GET /api/prices', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/prices/load', async (req, res) => {
  const securityId = parseId(req.body?.security_id);
  const timeframeId = parseId(req.body?.timeframe_id);
  const dateFrom = parseDateString(req.body?.date_from);
  const dateTo = parseDateString(req.body?.date_to);
  if (!securityId || !timeframeId) {
    res.status(400).json({ error: 'Укажите security_id и timeframe_id' });
    return;
  }
  if (!dateFrom || !dateTo) {
    res.status(400).json({ error: 'Укажите date_from и date_to (YYYY-MM-DD)' });
    return;
  }
  if (dateFrom > dateTo) {
    res.status(400).json({ error: 'date_from не может быть позже date_to' });
    return;
  }
  try {
    const { rows: beforeRows } = await pool.query(
      `
      SELECT COUNT(*)::int AS cnt
      FROM prices
      WHERE security_id = $1
        AND timeframe_id = $2
        AND dt >= $3::date
        AND dt < ($4::date + INTERVAL '1 day')
    `,
      [securityId, timeframeId, dateFrom, dateTo]
    );
    const beforeCount = beforeRows[0]?.cnt ?? 0;

    const client = await pool.connect();
    try {
      await client.query(`SET lock_timeout = '15s'`);
      await client.query(`SET statement_timeout = '180s'`);
      await client.query(`CALL load_prices_http($1, $2, $3::date, $4::date)`, [
        securityId,
        timeframeId,
        dateFrom,
        dateTo,
      ]);
    } finally {
      client.release();
    }

    const { rows: logRows } = await pool.query(
      `
      SELECT source, records_loaded, error_message, contract_prefix,
             date_from, date_to
      FROM price_load_log
      WHERE security_id = $1
        AND timeframe_id = $2
        AND date_from >= $3::date
        AND date_to <= $4::date
        AND loaded_at >= (CURRENT_TIMESTAMP - INTERVAL '10 minutes')
      ORDER BY id DESC
      LIMIT 20
    `,
      [securityId, timeframeId, dateFrom, dateTo]
    );

    const tbankLogs = logRows.filter((r) => r.source === 'T-BANK');
    const moexLogs = logRows.filter((r) => r.source === 'MOEX');
    const tbankLog = tbankLogs[0];
    const moexLog = moexLogs[0];
    const contracts = [];
    const seenContracts = new Set();
    for (const row of logRows) {
      if (!row.contract_prefix || seenContracts.has(row.contract_prefix)) continue;
      seenContracts.add(row.contract_prefix);
      contracts.push({
        prefix: row.contract_prefix,
        source: row.source,
        records_loaded: row.records_loaded,
      });
    }
    const tbankTotal = tbankLogs.reduce((s, r) => s + (r.records_loaded ?? 0), 0);
    const moexTotal = moexLogs.reduce((s, r) => s + (r.records_loaded ?? 0), 0);
    const primarySource =
      tbankTotal > 0
        ? 'T-BANK'
        : moexTotal > 0
          ? 'MOEX'
          : tbankLog
            ? 'T-BANK → MOEX'
            : 'T-Bank → MOEX';

    const { rows: afterRows } = await pool.query(
      `
      SELECT COUNT(*)::int AS cnt
      FROM prices
      WHERE security_id = $1
        AND timeframe_id = $2
        AND dt >= $3::date
        AND dt < ($4::date + INTERVAL '1 day')
    `,
      [securityId, timeframeId, dateFrom, dateTo]
    );
    const afterCount = afterRows[0]?.cnt ?? 0;

    res.json({
      ok: true,
      procedure: 'load_prices_http',
      source: primarySource,
      date_from: dateFrom,
      date_to: dateTo,
      candles: Math.max(0, afterCount - beforeCount),
      candles_total: afterCount,
      records_loaded: tbankLogs.reduce((s, r) => s + (r.records_loaded ?? 0), 0)
        + moexLogs.reduce((s, r) => s + (r.records_loaded ?? 0), 0),
      contracts,
      tbank: {
        records: tbankLogs.reduce((s, r) => s + (r.records_loaded ?? 0), 0) || null,
        error: tbankLog?.error_message ?? null,
      },
      moex: {
        records: moexLogs.reduce((s, r) => s + (r.records_loaded ?? 0), 0) || null,
        error: moexLog?.error_message ?? null,
      },
    });
  } catch (err) {
    console.error('POST /api/prices/load', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logics', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        l.id,
        l.name,
        l.account_id,
        l.is_enabled,
        l.note,
        COALESCE(l.portfolio_trading_paused, FALSE) AS portfolio_trading_paused,
        a.account_code,
        a.name AS account_name,
        a.account_type,
        a.broker_id,
        a.is_active AS account_is_active,
        b.code AS broker_code,
        b.name AS broker_name
      FROM logics l
      JOIN accounts a ON a.id = l.account_id
      JOIN brokers b ON b.id = a.broker_id
      ORDER BY l.id
    `);
    // Без T-Bank на каждый poll: остатки из logic_params (бой/enable/смена счёта обновляют сами).
    const paramsByLogic = await getTradingParamsForLogics(
      pool,
      rows.map((r) => r.id)
    );
    const result = rows.map((r) => ({
      ...r,
      ...(paramsByLogic.get(r.id) || {}),
    }));
    res.json(result);
  } catch (err) {
    console.error('GET /api/logics', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logic-params', async (req, res) => {
  const logicId = Number(req.query.logic_id);
  if (!Number.isInteger(logicId) || logicId <= 0) {
    res.status(400).json({ error: 'logic_id required' });
    return;
  }
  try {
    const rows = await getLogicParamsDetailed(pool, logicId);
    const trading = await getTradingParams(pool, logicId);
    res.json({ logic_id: logicId, trading, params: rows });
  } catch (err) {
    console.error('GET /api/logic-params', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/logic-params', async (req, res) => {
  const logicId = Number(req.body?.logic_id);
  if (!Number.isInteger(logicId) || logicId <= 0) {
    res.status(400).json({ error: 'logic_id required' });
    return;
  }
  const parsed = parseLogicTradingParams(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const { rows: exists } = await pool.query(
      'SELECT id FROM logics WHERE id = $1',
      [logicId]
    );
    if (exists.length === 0) {
      res.status(404).json({ error: 'Logic not found' });
      return;
    }
    const trading = await saveTradingParams(pool, logicId, parsed);
    const params = await getLogicParamsDetailed(pool, logicId);
    await writeTechLogEvent(pool, {
      threadKey: `logic:${logicId}:params`,
      operation: 'logic.params.updated',
      message: 'Параметры логики сохранены',
      source: 'api',
      logicId,
      payload: { trading, params },
    });
    res.json({ logic_id: logicId, trading, params });
  } catch (err) {
    console.error('PUT /api/logic-params', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/brokers', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, code, name, api_url, is_active
      FROM brokers
      ORDER BY code
    `);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/brokers', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/brokers', async (req, res) => {
  const parsed = parseBrokerBody(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO brokers (code, name, api_url, is_active)
       VALUES ($1, $2, $3, $4)
       RETURNING id, code, name, api_url, is_active`,
      [parsed.code, parsed.name, parsed.api_url, parsed.is_active]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    handleDbError(res, err, 'POST /api/brokers');
  }
});

app.put('/api/brokers/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'Invalid broker id' });
    return;
  }
  const parsed = parseBrokerBody(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const { rows } = await pool.query(
      `UPDATE brokers SET code = $1, name = $2, api_url = $3, is_active = $4
       WHERE id = $5
       RETURNING id, code, name, api_url, is_active`,
      [parsed.code, parsed.name, parsed.api_url, parsed.is_active, id]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Broker not found' });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    handleDbError(res, err, 'PUT /api/brokers/:id');
  }
});

app.delete('/api/brokers/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'Invalid broker id' });
    return;
  }
  try {
    const { rowCount } = await pool.query('DELETE FROM brokers WHERE id = $1', [id]);
    if (rowCount === 0) {
      res.status(404).json({ error: 'Broker not found' });
      return;
    }
    res.json({ ok: true, id });
  } catch (err) {
    handleDbError(res, err, 'DELETE /api/brokers/:id');
  }
});

app.get('/api/exchanges', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, name FROM exchanges ORDER BY name
    `);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/exchanges', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/exchanges', async (req, res) => {
  const parsed = parseExchangeBody(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO exchanges (name) VALUES ($1) RETURNING id, name`,
      [parsed.name]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    handleDbError(res, err, 'POST /api/exchanges');
  }
});

app.put('/api/exchanges/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'Invalid exchange id' });
    return;
  }
  const parsed = parseExchangeBody(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const { rows } = await pool.query(
      `UPDATE exchanges SET name = $1 WHERE id = $2 RETURNING id, name`,
      [parsed.name, id]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Exchange not found' });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    handleDbError(res, err, 'PUT /api/exchanges/:id');
  }
});

app.delete('/api/exchanges/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'Invalid exchange id' });
    return;
  }
  try {
    const { rowCount } = await pool.query('DELETE FROM exchanges WHERE id = $1', [id]);
    if (rowCount === 0) {
      res.status(404).json({ error: 'Exchange not found' });
      return;
    }
    res.json({ ok: true, id });
  } catch (err) {
    handleDbError(res, err, 'DELETE /api/exchanges/:id');
  }
});

app.get('/api/accounts', async (req, res) => {
  try {
    const brokerId = req.query.broker_id ? Number(req.query.broker_id) : null;
    const withBalance = req.query.with_balance === '1' || req.query.with_balance === 'true';
    const params = [];
    let where = '';
    if (brokerId && Number.isInteger(brokerId) && brokerId > 0) {
      where = 'WHERE a.broker_id = $1';
      params.push(brokerId);
    }
    const { rows } = await pool.query(
      `
      SELECT
        a.id,
        a.broker_id,
        a.account_code,
        a.name,
        a.account_type,
        a.is_efficient,
        a.is_active,
        (a.token_encrypted IS NOT NULL AND btrim(a.token_encrypted) <> '') AS has_token,
        b.code AS broker_code,
        b.name AS broker_name,
        b.api_url AS broker_api_url
      FROM accounts a
      JOIN brokers b ON b.id = a.broker_id
      ${where}
      ORDER BY b.code, a.account_code
      `,
      params
    );
    if (!withBalance) {
      res.json(rows.map(stripAccountSecrets));
      return;
    }
    const enriched = await Promise.all(
      rows.map((row) => enrichAccountBalance(row))
    );
    res.json(enriched.map(stripAccountSecrets));
  } catch (err) {
    console.error('GET /api/accounts', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/accounts/preview-connection', async (req, res) => {
  try {
    const preview = await resolveAccountConnection(req.body);
    if (preview.error) {
      res.status(400).json({ error: preview.error });
      return;
    }
    const resolved = await pgResolveTbankAccount(
      preview.broker_api_url,
      preview.token,
      preview.account_code || null
    );
    let balance = null;
    let balance_error = null;
    try {
      balance = await pgFetchTbankPortfolioBalance(
        preview.broker_api_url,
        preview.token,
        resolved.account_id
      );
    } catch (balErr) {
      balance_error = balErr.message;
    }
    res.json({
      ok: true,
      accounts: resolved.accounts,
      selected_account_id: resolved.account_id,
      selected_account_name: resolved.account_name,
      accounts_found: resolved.accounts.length,
      balance: balance?.amount ?? null,
      balance_currency: balance?.currency ?? null,
      balance_display: balance?.display ?? null,
      balance_error,
    });
  } catch (err) {
    console.error('POST /api/accounts/preview-connection', err);
    res.status(502).json({ error: err.message || 'Не удалось проверить подключение' });
  }
});

app.post('/api/accounts', async (req, res) => {
  let parsed = parseAccountBody(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  parsed = await fillRealTbankAccountFromToken(parsed, req.body?.account_id);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  if (parsed.account_type === 'real' && !parsed.api_token && !parsed._has_stored_token) {
    res.status(400).json({ error: 'Для реального счёта укажите API-токен' });
    return;
  }
  try {
    const tokenFields = tokenFieldsFromParsed(parsed);
    const { rows } = await pool.query(
      `INSERT INTO accounts (broker_id, account_code, name, account_type, is_efficient, is_active, token_encrypted, token_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, broker_id, account_code, name, account_type, is_efficient, is_active,
         (token_encrypted IS NOT NULL AND btrim(token_encrypted) <> '') AS has_token`,
      [
        parsed.broker_id,
        parsed.account_code,
        parsed.name,
        parsed.account_type,
        parsed.is_efficient,
        parsed.is_active,
        tokenFields.token_encrypted,
        tokenFields.token_hash,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    handleDbError(res, err, 'POST /api/accounts');
  }
});

app.put('/api/accounts/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'Invalid account id' });
    return;
  }
  const parsed = parseAccountBody(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  let filled = await fillRealTbankAccountFromToken(parsed, id);
  if (filled.error) {
    res.status(400).json({ error: filled.error });
    return;
  }
  try {
    const tokenUpdate = buildTokenUpdateClause(filled, 8);
    const values = [
      filled.broker_id,
      filled.account_code,
      filled.name,
      filled.account_type,
      filled.is_efficient,
      filled.is_active,
      id,
      ...tokenUpdate.extraValues,
    ];
    const { rows } = await pool.query(
      `UPDATE accounts
       SET broker_id = $1, account_code = $2, name = $3, account_type = $4,
           is_efficient = $5, is_active = $6, updated_at = CURRENT_TIMESTAMP
           ${tokenUpdate.sql}
       WHERE id = $7
       RETURNING id, broker_id, account_code, name, account_type, is_efficient, is_active,
         (token_encrypted IS NOT NULL AND btrim(token_encrypted) <> '') AS has_token`,
      values
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    handleDbError(res, err, 'PUT /api/accounts/:id');
  }
});

app.delete('/api/accounts/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'Invalid account id' });
    return;
  }
  try {
    const { rowCount } = await pool.query('DELETE FROM accounts WHERE id = $1', [id]);
    if (rowCount === 0) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }
    res.json({ ok: true, id });
  } catch (err) {
    handleDbError(res, err, 'DELETE /api/accounts/:id');
  }
});

/** Фонды облигаций для покупки: TBRU, SBGB (RGBITR), OBLG/VTBB (RUCBTRNS). */
app.get('/api/accounts/bond-funds', (_req, res) => {
  res.json(listBondFunds());
});

/** Продать всё на реальном счёте T-Bank (акции, облигации, фонды…; валюту пропускаем). */
app.post('/api/accounts/:id/sell-all', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'Invalid account id' });
    return;
  }
  try {
    const result = await sellAllPositions(pool, id);
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('POST /api/accounts/:id/sell-all', err);
    res.status(status).json({ error: err.message || 'sell-all failed' });
  }
});

/** Свободный кэш реального счёта (для дефолта суммы покупки облигаций). */
app.get('/api/accounts/:id/cash', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'Invalid account id' });
    return;
  }
  try {
    await assertRealTbankAccount(pool, id);
    const cash = await getAccountCash(pool, id);
    res.json({ ok: true, account_id: id, ...cash });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('GET /api/accounts/:id/cash', err);
    res.status(status).json({ error: err.message || 'cash failed' });
  }
});

/**
 * План / покупка облигаций по составу фонда (TBRU / SBGB / OBLG):
 * body: { fund_code?, amount_rub?, execute?: boolean }
 * Жадно от более доходных (часто корп.) к менее (ОФЗ).
 */
app.post('/api/accounts/:id/buy-bonds', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'Invalid account id' });
    return;
  }
  const execute = req.body?.execute === true || req.body?.execute === 'true';
  const opts = {
    fund_code: req.body?.fund_code || 'TBRU',
    amount_rub: req.body?.amount_rub,
  };
  try {
    const result = execute
      ? await executeBuyBonds(pool, id, opts)
      : await planBuyBonds(pool, id, opts);
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('POST /api/accounts/:id/buy-bonds', err);
    res.status(status).json({ error: err.message || 'buy-bonds failed' });
  }
});

app.post('/api/logics', async (req, res) => {
  const parsed = parseLogicBody(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const { rows } = await pool.query(
      `
      INSERT INTO logics (name, account_id, is_enabled, note)
      VALUES ($1, $2, $3, $4)
      RETURNING id, name, account_id, is_enabled, note
      `,
      [parsed.name, parsed.account_id, parsed.is_enabled, parsed.note]
    );
    const row = rows[0];
    await ensureDefaultParams(pool, row.id);
    await syncRealAccountBalancesIfNeeded(pool, row.id, { force: true });
    const params = await getTradingParams(pool, row.id);
    res.status(201).json({ ...row, ...params });
  } catch (err) {
    console.error('POST /api/logics', err);
    if (err.code === '23505') {
      res.status(409).json({ error: 'Логика с таким именем уже существует' });
      return;
    }
    if (err.code === '23503') {
      res.status(400).json({ error: 'Указан несуществующий счёт' });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

/** Экспорт выбранных логик: params/signals/stops/securities; без тестов и сделок. */
app.post('/api/logics/export', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  try {
    const bundle = await buildLogicBundle(pool, ids);
    res.json(bundle);
  } catch (err) {
    console.error('POST /api/logics/export', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * Импорт bundle: создаёт логики с теми же бумагами/сигналами/стопами/параметрами.
 * Тесты и сделки не импортируются (пустой журнал).
 */
app.post('/api/logics/import', async (req, res) => {
  try {
    const result = await importLogicBundle(pool, req.body);
    res.status(201).json(result);
  } catch (err) {
    console.error('POST /api/logics/import', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/logics/:id/copy', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid logic id' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: sourceRows } = await client.query(
      'SELECT id, name, account_id, note FROM logics WHERE id = $1',
      [id]
    );
    if (sourceRows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Logic not found' });
      return;
    }
    const source = sourceRows[0];
    const baseName = `${source.name} copy`;
    let copyName = baseName;
    for (let i = 2; i <= 100; i += 1) {
      const { rows: existing } = await client.query(
        'SELECT 1 FROM logics WHERE name = $1 LIMIT 1',
        [copyName]
      );
      if (existing.length === 0) break;
      copyName = `${baseName} ${i}`;
    }

    const { rows: inserted } = await client.query(
      `
      INSERT INTO logics (name, account_id, is_enabled, note)
      VALUES ($1, $2, FALSE, $3)
      RETURNING id, name, account_id, is_enabled, note
      `,
      [copyName, source.account_id, source.note]
    );
    const copy = inserted[0];

    await client.query(
      `
      INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
      SELECT $1, param_key, param_value, value_type
      FROM logic_params
      WHERE logic_id = $2
      ON CONFLICT (logic_id, param_key) DO UPDATE SET
        param_value = EXCLUDED.param_value,
        value_type = EXCLUDED.value_type,
        updated_at = CURRENT_TIMESTAMP
      `,
      [copy.id, id]
    );

    await client.query(
      `
      INSERT INTO logic_indicator_signals (
        logic_id, indicator_id, position_event, position_side, signal_kind,
        formula, rating, rating_test, display_order, is_active
      )
      SELECT
        $1, indicator_id, position_event, position_side, signal_kind,
        formula, 0, 0, display_order, is_active
      FROM logic_indicator_signals
      WHERE logic_id = $2
      ORDER BY display_order, id
      `,
      [copy.id, id]
    );

    await client.query(
      `
      INSERT INTO logic_stops (
        logic_id, rule_kind, scope_type, value, value_unit, display_order, is_active
      )
      SELECT $1, rule_kind, scope_type, value, value_unit, display_order, is_active
      FROM logic_stops
      WHERE logic_id = $2
      ORDER BY display_order, id
      `,
      [copy.id, id]
    );

    await client.query(
      `
      INSERT INTO logic_securities (logic_id, security_id, display_order, is_active)
      SELECT $1, security_id, display_order, is_active
      FROM logic_securities
      WHERE logic_id = $2
      ORDER BY display_order, id
      ON CONFLICT (logic_id, security_id) DO NOTHING
      `,
      [copy.id, id]
    );

    await client.query(
      `
      INSERT INTO logic_non_trading_intervals (
        logic_id, day_of_week, time_from, time_to, note, display_order, is_active
      )
      SELECT $1, day_of_week, time_from, time_to, note, display_order, is_active
      FROM logic_non_trading_intervals
      WHERE logic_id = $2
      ORDER BY display_order, id
      `,
      [copy.id, id]
    );

    await client.query('COMMIT');
    // Копия с real-счёта не должна унаследовать paper 1M — остаток с брокера или 0
    await syncRealAccountBalancesIfNeeded(pool, copy.id, { force: true });
    const { rows: fullRows } = await pool.query(
      `
      SELECT
        l.id,
        l.name,
        l.account_id,
        l.is_enabled,
        l.note,
        a.account_code,
        a.name AS account_name,
        a.account_type,
        a.broker_id,
        a.is_active AS account_is_active,
        b.code AS broker_code,
        b.name AS broker_name
      FROM logics l
      JOIN accounts a ON a.id = l.account_id
      JOIN brokers b ON b.id = a.broker_id
      WHERE l.id = $1
      `,
      [copy.id]
    );
    const params = await getTradingParams(pool, copy.id);
    res.status(201).json({ ...(fullRows[0] ?? copy), ...params });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/logics/:id/copy', err);
    if (err.code === '23505') {
      res.status(409).json({ error: 'Could not create a unique copy name' });
      return;
    }
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put('/api/logics/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid logic id' });
    return;
  }
  const parsed = parseLogicBody(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT id, name, account_id, is_enabled FROM logics WHERE id = $1',
      [id]
    );
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Logic not found' });
      return;
    }
    const prevAccountId = Number(existing.rows[0].account_id);
    const accountChanged = prevAccountId !== Number(parsed.account_id);
    const { rows } = await client.query(
      `
      UPDATE logics
      SET name = $1, account_id = $2, is_enabled = $3, note = $4
      WHERE id = $5
      RETURNING id, name, account_id, is_enabled, note
      `,
      [parsed.name, parsed.account_id, parsed.is_enabled, parsed.note, id]
    );

    let account_change = null;
    if (accountChanged) {
      // Боевая история/FINRES + pause state; остатки под новый счёт.
      const cleared = await resetLogicTradingStateOnAccountChange(client, id);
      account_change = {
        from_account_id: prevAccountId,
        to_account_id: Number(parsed.account_id),
        cleared_trades: cleared.cleared_trades,
      };
      await writeTechLogEvent(client, {
        threadKey: `logic:${id}:control`,
        operation: 'logic.account_changed',
        message: 'Счёт логики изменён: история сделок и FINRES очищены',
        source: 'api',
        logicId: id,
        payload: account_change,
      });
    }

    await client.query('COMMIT');
    if (!accountChanged) {
      // Смена на real / уже real — initial/current только с брокера (или 0)
      await syncRealAccountBalancesIfNeeded(pool, id, { force: true });
    }

    let rating_precalc = null;
    // Как «выкл → вкл»: при активной логике после смены счёта — предрасчёт рейтинга.
    if (accountChanged && rows[0].is_enabled) {
      rating_precalc = await startRatingPrecalc(pool, id);
    }

    res.json({
      ...rows[0],
      account_changed: accountChanged,
      account_change,
      rating_precalc,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /api/logics/:id', err);
    if (err.code === '23505') {
      res.status(409).json({ error: 'Логика с таким именем уже существует' });
      return;
    }
    if (err.code === '23503') {
      res.status(400).json({ error: 'Указан несуществующий счёт' });
      return;
    }
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete('/api/logics/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid logic id' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT id, name FROM logics WHERE id = $1',
      [id]
    );
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Logic not found' });
      return;
    }
    // logic_trades.logic_id historically RESTRICT — remove trades/lots before logic.
    await client.query('DELETE FROM logic_trade_lots WHERE logic_id = $1', [id]);
    await client.query('DELETE FROM logic_trades WHERE logic_id = $1', [id]);
    await client.query('DELETE FROM logics WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.json({ ok: true, id });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('DELETE /api/logics/:id', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.patch('/api/logics/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { is_enabled } = req.body;
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid logic id' });
    return;
  }
  if (typeof is_enabled !== 'boolean') {
    res.status(400).json({ error: 'is_enabled must be boolean' });
    return;
  }
  try {
    const { rows: existsRows } = await pool.query(
      `SELECT id FROM logics WHERE id = $1`,
      [id]
    );
    if (existsRows.length === 0) {
      res.status(404).json({ error: 'Logic not found' });
      return;
    }
    if (is_enabled) {
      const warmup = await logicNeedsWarmup(pool, id);
      if (warmup.enabled) {
        const { rows: activeWarmup } = await pool.query(
          `
          SELECT id, date_from, date_to
          FROM logic_backtest_runs
          WHERE logic_id = $1
            AND status IN ('pending', 'loading_prices', 'loading_indicators', 'running')
          ORDER BY id DESC
          LIMIT 1
          `,
          [id]
        );
        if (activeWarmup.length > 0) {
          const run = activeWarmup[0];
          await pool.query(`UPDATE logics SET is_enabled = FALSE WHERE id = $1`, [id]);
          watchWarmupBacktest(pool, id, run.id);
          res.json({
            id,
            is_enabled: false,
            warmup_pretest: {
              started: true,
              run_id: run.id,
              date_from: run.date_from,
              date_to: run.date_to,
            },
          });
          return;
        }
        const dateTo = localIsoDate();
        const dateFrom = shiftLocalDate(dateTo, -(warmup.lookbackDays - 1));
        const runId = await startBacktest(pool, id, dateFrom, dateTo);
        await pool.query(`UPDATE logics SET is_enabled = FALSE WHERE id = $1`, [id]);
        watchWarmupBacktest(pool, id, runId);
        await writeTechLogEvent(pool, {
          threadKey: `logic:${id}:warmup`,
          operation: 'logic.warmup.started',
          message: `Warm-up backtest started before enabling logic`,
          source: 'api',
          logicId: id,
          payload: { run_id: runId, date_from: dateFrom, date_to: dateTo },
        });
        res.json({
          id,
          is_enabled: false,
          warmup_pretest: {
            started: true,
            run_id: runId,
            date_from: dateFrom,
            date_to: dateTo,
          },
        });
        return;
      }
    }
    const { rows } = await pool.query(
      `UPDATE logics SET is_enabled = $1 WHERE id = $2 RETURNING id, is_enabled`,
      [is_enabled, id]
    );
    await writeTechLogEvent(pool, {
      threadKey: `logic:${id}:control`,
      operation: is_enabled ? 'logic.enabled' : 'logic.disabled',
      message: is_enabled ? 'Логика включена' : 'Логика выключена',
      source: 'api',
      logicId: id,
      payload: { is_enabled },
    });
    let rating_precalc = null;
    if (is_enabled) {
      // Остатки с брокера — в фоне, не блокируем ответ UI (раньше блокировал poll списка).
      syncRealAccountBalancesIfNeeded(pool, id, { force: true }).catch(() => {});
      // Фон: не ждём; бой уже включён
      rating_precalc = await startRatingPrecalc(pool, id);
    }
    res.json({ ...rows[0], rating_precalc });
  } catch (err) {
    console.error('PATCH /api/logics/:id', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logics/:id/signal-rating-precalc', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid logic id' });
    return;
  }
  try {
    const { rows } = await pool.query('SELECT id FROM logics WHERE id = $1', [id]);
    if (rows.length === 0) {
      res.status(404).json({ error: 'Logic not found' });
      return;
    }
    const job = await startRatingPrecalc(pool, id);
    res.json(job);
  } catch (err) {
    console.error('POST /api/logics/:id/signal-rating-precalc', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logics/:id/signal-rating-precalc', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid logic id' });
    return;
  }
  res.json(getRatingPrecalcStatus(id));
});

/** История баз OPT / параметров формул для отчёта теста. */
app.get('/api/logics/:id/opt-param-history', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid logic id' });
    return;
  }
  const runRaw = req.query.run_id;
  const runId =
    runRaw != null && String(runRaw).trim() !== ''
      ? Number(runRaw)
      : null;
  try {
    const { rows } = await pool.query(
      `SELECT logic_opt_param_history_for_report($1, $2) AS h`,
      [id, Number.isInteger(runId) && runId > 0 ? runId : null]
    );
    const raw = rows[0]?.h;
    const history = Array.isArray(raw) ? raw : raw ? [raw] : [];
    res.json({ rows: history });
  } catch (err) {
    console.error('GET /api/logics/:id/opt-param-history', err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/logics/:id/trading-params', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid logic id' });
    return;
  }

  const parsed = parseLogicTradingParams(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    const { rows: exists } = await pool.query(
      'SELECT id FROM logics WHERE id = $1',
      [id]
    );
    if (exists.length === 0) {
      res.status(404).json({ error: 'Logic not found' });
      return;
    }
    const trading = await saveTradingParams(pool, id, parsed);
    res.json({ id, ...trading });
  } catch (err) {
    console.error('PATCH /api/logics/:id/trading-params', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logic-indicator-signals', async (req, res) => {
  const logicId = Number(req.query.logic_id);
  if (!Number.isInteger(logicId) || logicId <= 0) {
    res.status(400).json({ error: 'logic_id required' });
    return;
  }
  try {
    const { rows } = await pool.query(
      `
      SELECT
        lis.id,
        lis.logic_id,
        lis.indicator_id,
        lis.position_event,
        lis.position_side,
        lis.signal_kind,
        lis.formula,
        lis.rating,
        lis.rating_test,
        lis.display_order,
        lis.is_active,
        i.code AS indicator_code,
        i.name AS indicator_name
      FROM logic_indicator_signals lis
      JOIN indicators i ON i.id = lis.indicator_id
      WHERE lis.logic_id = $1
      ORDER BY lis.display_order, lis.id
    `,
      [logicId]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/logic-indicator-signals', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logic-signal-ratings/history', async (req, res) => {
  const logicId = Number(req.query.logic_id);
  const isTest = req.query.is_test === '1' || req.query.is_test === 'true';
  const runId = req.query.run_id != null && req.query.run_id !== ''
    ? Number(req.query.run_id)
    : null;
  const signalId = req.query.signal_id != null && req.query.signal_id !== ''
    ? Number(req.query.signal_id)
    : null;
  const securityId = req.query.security_id != null && req.query.security_id !== ''
    ? Number(req.query.security_id)
    : null;
  if (!Number.isInteger(logicId) || logicId <= 0) {
    res.status(400).json({ error: 'logic_id required' });
    return;
  }
  try {
    const { rows: signals } = await pool.query(
      `
      SELECT
        lis.id AS signal_id,
        lis.logic_id,
        lis.position_event,
        lis.position_side,
        lis.signal_kind,
        lis.formula,
        lis.rating,
        lis.rating_test,
        lis.is_active,
        i.code AS indicator_code,
        i.name AS indicator_name
      FROM logic_indicator_signals lis
      JOIN indicators i ON i.id = lis.indicator_id
      WHERE lis.logic_id = $1
        AND ($2::int IS NULL OR lis.id = $2)
      ORDER BY lis.display_order, lis.id
      `,
      [logicId, signalId]
    );

    const histParams = [logicId, isTest];
    let histSql = `
      SELECT h.signal_id, h.bar_dt, h.rating, h.delta, h.security_id, h.run_id
      FROM logic_signal_rating_history h
      WHERE h.logic_id = $1 AND h.is_test = $2
    `;
    if (runId != null && Number.isInteger(runId)) {
      histParams.push(runId);
      histSql += ` AND h.run_id = $${histParams.length}`;
    }
    if (signalId != null && Number.isInteger(signalId)) {
      histParams.push(signalId);
      histSql += ` AND h.signal_id = $${histParams.length}`;
    }
    if (securityId != null && Number.isInteger(securityId)) {
      histParams.push(securityId);
      histSql += ` AND h.security_id = $${histParams.length}`;
    }
    histSql += ' ORDER BY h.signal_id, h.bar_dt, h.id';

    const { rows: hist } = await pool.query(histSql, histParams);
    const bySignal = new Map();
    for (const s of signals) {
      bySignal.set(s.signal_id, {
        ...s,
        // При фильтре по бумаге rating_test в ответе = рейтинг на этой бумаге
        paper_rating: 0,
        points: [],
      });
    }
    for (const h of hist) {
      const row = bySignal.get(h.signal_id);
      if (!row) continue;
      const dt = h.bar_dt;
      const value = Number(h.rating);
      const point = {
        dt,
        value,
        delta: Number(h.delta),
      };
      const pts = row.points;
      const last = pts[pts.length - 1];
      if (last && String(last.dt) === String(dt)) {
        pts[pts.length - 1] = point;
      } else {
        pts.push(point);
      }
      row.paper_rating = value;
    }
    if (securityId != null && Number.isInteger(securityId)) {
      for (const row of bySignal.values()) {
        row.rating_test = row.paper_rating;
      }
    }
    res.json({
      logic_id: logicId,
      is_test: isTest,
      run_id: runId,
      security_id: securityId,
      signals: [...bySignal.values()],
    });
  } catch (err) {
    console.error('GET /api/logic-signal-ratings/history', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logic-indicator-signals', async (req, res) => {
  const logicId = Number(req.body?.logic_id);
  const indicatorId = Number(req.body?.indicator_id);
  const positionEvent = req.body?.position_event;
  const positionSide = req.body?.position_side;
  const signalKind = req.body?.signal_kind;
  const formula = btrimStr(req.body?.formula);
  if (!Number.isInteger(logicId) || logicId <= 0) {
    res.status(400).json({ error: 'logic_id required' });
    return;
  }
  if (!Number.isInteger(indicatorId) || indicatorId <= 0) {
    res.status(400).json({ error: 'indicator_id required' });
    return;
  }
  if (positionEvent !== 'open' && positionEvent !== 'close') {
    res.status(400).json({ error: 'position_event must be open or close' });
    return;
  }
  if (positionSide !== 'long' && positionSide !== 'short') {
    res.status(400).json({ error: 'position_side must be long or short' });
    return;
  }
  if (signalKind !== 'trend' && signalKind !== 'counter') {
    res.status(400).json({ error: 'signal_kind must be trend or counter' });
    return;
  }
  if (!formula) {
    res.status(400).json({ error: 'formula required' });
    return;
  }
  try {
    const optCheck = await validateOptFormulaSave(pool, logicId, formula, null);
    if (!optCheck.ok) {
      res.status(400).json({
        error: optCheck.error,
        opt_existing: optCheck.existing || [],
      });
      return;
    }
    const { rows: orderRows } = await pool.query(
      `SELECT COALESCE(MAX(display_order), 0) + 1 AS next_order
       FROM logic_indicator_signals WHERE logic_id = $1`,
      [logicId]
    );
    const displayOrder = orderRows[0]?.next_order ?? 1;
    const { rows } = await pool.query(
      `
      INSERT INTO logic_indicator_signals
        (logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (logic_id, indicator_id, position_event, position_side, signal_kind) DO UPDATE SET
        formula = EXCLUDED.formula,
        is_active = TRUE
      RETURNING id, logic_id, indicator_id, position_event, position_side, signal_kind, formula, rating, rating_test, display_order, is_active
    `,
      [logicId, indicatorId, positionEvent, positionSide, signalKind, formula, displayOrder]
    );
    const row = rows[0];
    const { rows: meta } = await pool.query(
      `SELECT code AS indicator_code, name AS indicator_name FROM indicators WHERE id = $1`,
      [indicatorId]
    );
    res.status(201).json({ ...row, ...meta[0] });
  } catch (err) {
    console.error('POST /api/logic-indicator-signals', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/logic-indicator-signals/:id', async (req, res) => {
  const id = Number(req.params.id);
  const formula = btrimStr(req.body?.formula);
  const isActive = req.body?.is_active;
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  if (!formula) {
    res.status(400).json({ error: 'formula required' });
    return;
  }
  try {
    const { rows: curRows } = await pool.query(
      `SELECT logic_id FROM logic_indicator_signals WHERE id = $1`,
      [id]
    );
    if (curRows.length === 0) {
      res.status(404).json({ error: 'Signal not found' });
      return;
    }
    const optCheck = await validateOptFormulaSave(
      pool,
      curRows[0].logic_id,
      formula,
      id
    );
    if (!optCheck.ok) {
      res.status(400).json({
        error: optCheck.error,
        opt_existing: optCheck.existing || [],
      });
      return;
    }
    const { rows } = await pool.query(
      `
      UPDATE logic_indicator_signals
      SET formula = $2,
          is_active = COALESCE($3::boolean, is_active)
      WHERE id = $1
      RETURNING id, logic_id, indicator_id, position_event, position_side, signal_kind, formula, rating, rating_test, display_order, is_active
    `,
      [id, formula, isActive === undefined ? null : isActive]
    );
    const row = rows[0];
    const { rows: meta } = await pool.query(
      `SELECT code AS indicator_code, name AS indicator_name FROM indicators WHERE id = $1`,
      [row.indicator_id]
    );
    res.json({ ...row, ...meta[0] });
  } catch (err) {
    console.error('PUT /api/logic-indicator-signals/:id', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/logic-indicator-signals/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM logic_indicator_signals WHERE id = $1',
      [id]
    );
    if (rowCount === 0) {
      res.status(404).json({ error: 'Signal not found' });
      return;
    }
    res.json({ ok: true, id });
  } catch (err) {
    console.error('DELETE /api/logic-indicator-signals/:id', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logic-stops', async (req, res) => {
  const logicId = Number(req.query.logic_id);
  if (!Number.isInteger(logicId) || logicId <= 0) {
    res.status(400).json({ error: 'logic_id required' });
    return;
  }
  try {
    const { rows } = await pool.query(
      `
      SELECT
        id, logic_id, rule_kind, scope_type,
        value::float8 AS value, value_unit,
        display_order, is_active, created_at
      FROM logic_stops
      WHERE logic_id = $1
      ORDER BY rule_kind, display_order, id
      `,
      [logicId]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/logic-stops', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logic-stops', async (req, res) => {
  const logicId = Number(req.body?.logic_id);
  const ruleKind = btrimStr(req.body?.rule_kind);
  const scopeType = btrimStr(req.body?.scope_type);
  const valueUnit = btrimStr(req.body?.value_unit);
  const value = Number(req.body?.value);
  if (!Number.isInteger(logicId) || logicId <= 0) {
    res.status(400).json({ error: 'logic_id required' });
    return;
  }
  if (ruleKind !== 'stop_loss' && ruleKind !== 'take_profit') {
    res.status(400).json({ error: 'rule_kind must be stop_loss or take_profit' });
    return;
  }
  if (!isScopeValidForRuleKind(ruleKind, scopeType)) {
    res.status(400).json({
      error:
        ruleKind === 'take_profit'
          ? 'scope_type for take_profit must be security, portfolio or portfolio_ltp_renew'
          : 'scope_type must be security, security_resume, security_inversion, portfolio or portfolio_resume',
    });
    return;
  }
  if (!isScopeChoosableForRuleKind(ruleKind, scopeType)) {
    res.status(400).json({
      error:
        ruleKind === 'take_profit'
          ? 'take_profit by portfolio is not choosable (only security)'
          : 'this stop-loss scope is not choosable (security_inversion / portfolio_resume)',
    });
    return;
  }
  if (valueUnit !== 'percent' && valueUnit !== 'atr') {
    res.status(400).json({ error: 'value_unit must be percent or atr' });
    return;
  }
  if (!Number.isFinite(value) || value <= 0) {
    res.status(400).json({ error: 'value must be a positive number' });
    return;
  }
  try {
    const { rows: orderRows } = await pool.query(
      `SELECT COALESCE(MAX(display_order), 0) + 1 AS next_order
       FROM logic_stops WHERE logic_id = $1 AND rule_kind = $2`,
      [logicId, ruleKind]
    );
    const displayOrder = orderRows[0]?.next_order ?? 1;
    const { rows } = await pool.query(
      `
      INSERT INTO logic_stops
        (logic_id, rule_kind, scope_type, value, value_unit, display_order)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, logic_id, rule_kind, scope_type,
        value::float8 AS value, value_unit, display_order, is_active, created_at
      `,
      [logicId, ruleKind, scopeType, value, valueUnit, displayOrder]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /api/logic-stops', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/logic-stops/:id', async (req, res) => {
  const id = Number(req.params.id);
  const scopeType = req.body?.scope_type != null ? btrimStr(req.body.scope_type) : null;
  const valueUnit = req.body?.value_unit != null ? btrimStr(req.body.value_unit) : null;
  const value = req.body?.value != null ? Number(req.body.value) : null;
  const isActive = req.body?.is_active;
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  if (valueUnit && valueUnit !== 'percent' && valueUnit !== 'atr') {
    res.status(400).json({ error: 'value_unit must be percent or atr' });
    return;
  }
  if (value != null && (!Number.isFinite(value) || value <= 0)) {
    res.status(400).json({ error: 'value must be a positive number' });
    return;
  }
  try {
    if (scopeType) {
      const { rows: kindRows } = await pool.query(
        'SELECT rule_kind FROM logic_stops WHERE id = $1',
        [id]
      );
      if (kindRows.length === 0) {
        res.status(404).json({ error: 'Stop rule not found' });
        return;
      }
      const ruleKind = kindRows[0].rule_kind;
      if (!isScopeValidForRuleKind(ruleKind, scopeType)) {
        res.status(400).json({
          error:
            ruleKind === 'take_profit'
              ? 'scope_type for take_profit must be security, portfolio or portfolio_ltp_renew'
              : 'scope_type must be security, security_resume, security_inversion, portfolio or portfolio_resume',
        });
        return;
      }
      if (!isScopeChoosableForRuleKind(ruleKind, scopeType)) {
        res.status(400).json({
          error:
            ruleKind === 'take_profit'
              ? 'take_profit by portfolio is not choosable (only security)'
              : 'this stop-loss scope is not choosable (security_inversion / portfolio_resume)',
        });
        return;
      }
    }
    const { rows } = await pool.query(
      `
      UPDATE logic_stops
      SET scope_type = COALESCE($2, scope_type),
          value = COALESCE($3, value),
          value_unit = COALESCE($4, value_unit),
          is_active = COALESCE($5::boolean, is_active)
      WHERE id = $1
      RETURNING id, logic_id, rule_kind, scope_type,
        value::float8 AS value, value_unit, display_order, is_active, created_at
      `,
      [
        id,
        scopeType || null,
        value != null ? value : null,
        valueUnit || null,
        isActive === undefined ? null : isActive,
      ]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Stop rule not found' });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('PUT /api/logic-stops/:id', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/logic-stops/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  try {
    const { rowCount } = await pool.query('DELETE FROM logic_stops WHERE id = $1', [id]);
    if (rowCount === 0) {
      res.status(404).json({ error: 'Stop rule not found' });
      return;
    }
    res.json({ ok: true, id });
  } catch (err) {
    console.error('DELETE /api/logic-stops/:id', err);
    res.status(500).json({ error: err.message });
  }
});

const LOGIC_SECURITY_SELECT = `
  SELECT
    ls.id,
    ls.logic_id,
    ls.security_id,
    ls.display_order,
    ls.is_active,
    ls.created_at,
    ls.real_trading_paused,
    ls.real_trading_paused_long,
    ls.real_trading_paused_short,
    ls.real_trading_inverted,
    ls.stop_resume_equity::float8 AS stop_resume_equity,
    ls.stop_resume_baseline::float8 AS stop_resume_baseline,
    ls.stop_resume_triggered_at,
    ls.stop_resume_equity_long::float8 AS stop_resume_equity_long,
    ls.stop_resume_baseline_long::float8 AS stop_resume_baseline_long,
    ls.stop_resume_triggered_at_long,
    ls.stop_resume_equity_short::float8 AS stop_resume_equity_short,
    ls.stop_resume_baseline_short::float8 AS stop_resume_baseline_short,
    ls.stop_resume_triggered_at_short,
    s.name AS security_name,
    s.lot_size,
    st.name AS security_type,
    sp.prefix,
    sp.instrument_market,
    sp.exchange_id,
    e.name AS exchange_name
  FROM logic_securities ls
  JOIN securities s ON s.id = ls.security_id
  JOIN security_types st ON st.id = s.security_type_id
  LEFT JOIN LATERAL (
    SELECT prefix, instrument_market, exchange_id
    FROM security_prefixes
    WHERE security_id = s.id
    ORDER BY exchange_id
    LIMIT 1
  ) sp ON TRUE
  LEFT JOIN exchanges e ON e.id = sp.exchange_id
`;

app.get('/api/logic-securities', async (req, res) => {
  const logicId = Number(req.query.logic_id);
  if (!Number.isInteger(logicId) || logicId <= 0) {
    res.status(400).json({ error: 'logic_id required' });
    return;
  }
  try {
    const { rows } = await pool.query(
      `${LOGIC_SECURITY_SELECT}
       WHERE ls.logic_id = $1
       ORDER BY ls.display_order, ls.id`,
      [logicId]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/logic-securities', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logic-securities/bulk', async (req, res) => {
  const logicId = Number(req.body?.logic_id);
  const rawIds = req.body?.security_ids;
  if (!Number.isInteger(logicId) || logicId <= 0) {
    res.status(400).json({ error: 'logic_id required' });
    return;
  }
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    res.status(400).json({ error: 'security_ids array required' });
    return;
  }
  const securityIds = [
    ...new Set(
      rawIds
        .map((x) => Number(x))
        .filter((id) => Number.isInteger(id) && id > 0)
    ),
  ];
  if (securityIds.length === 0) {
    res.status(400).json({ error: 'No valid security_ids' });
    return;
  }
  try {
    const { rows: logicRows } = await pool.query(
      'SELECT id FROM logics WHERE id = $1',
      [logicId]
    );
    if (logicRows.length === 0) {
      res.status(404).json({ error: 'Logic not found' });
      return;
    }
    const { rows: inserted } = await pool.query(
      `
      INSERT INTO logic_securities (logic_id, security_id, display_order)
      SELECT
        $1,
        sid,
        COALESCE(
          (SELECT MAX(display_order) FROM logic_securities WHERE logic_id = $1),
          0
        ) + row_number() OVER ()
      FROM unnest($2::int[]) AS sid
      ON CONFLICT (logic_id, security_id) DO UPDATE SET is_active = TRUE
      RETURNING id
      `,
      [logicId, securityIds]
    );
    const ids = inserted.map((r) => r.id);
    if (ids.length === 0) {
      res.json([]);
      return;
    }
    const { rows } = await pool.query(
      `${LOGIC_SECURITY_SELECT} WHERE ls.id = ANY($1::int[]) ORDER BY ls.display_order, ls.id`,
      [ids]
    );
    res.status(201).json(rows);
  } catch (err) {
    console.error('POST /api/logic-securities/bulk', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/logic-securities/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM logic_securities WHERE id = $1',
      [id]
    );
    if (rowCount === 0) {
      res.status(404).json({ error: 'Logic security not found' });
      return;
    }
    res.json({ ok: true, id });
  } catch (err) {
    console.error('DELETE /api/logic-securities/:id', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logics/:id/non-trading-periods', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid logic id' });
    return;
  }
  try {
    await pool.query('SELECT logic_ensure_non_trading_periods($1)', [id]);
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
      [id]
    );
    const trading = await getTradingParams(pool, id);
    res.json({
      logic_id: id,
      use_non_trading_periods: trading.use_non_trading_periods !== false,
      intervals: rows,
    });
  } catch (err) {
    console.error('GET /api/logics/:id/non-trading-periods', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logics/:id/non-trading-periods/moex-defaults', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid logic id' });
    return;
  }
  try {
    const { rows: exists } = await pool.query('SELECT id FROM logics WHERE id = $1', [id]);
    if (exists.length === 0) {
      res.status(404).json({ error: 'Logic not found' });
      return;
    }
    const { rows } = await pool.query(
      'SELECT logic_apply_moex_non_trading_periods($1::INTEGER) AS n',
      [id]
    );
    const { rows: intervals } = await pool.query(
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
      [id]
    );
    const trading = await getTradingParams(pool, id);
    await writeTechLogEvent(pool, {
      threadKey: `logic:${id}:sessions`,
      operation: 'logic.non_trading.moex_defaults',
      message: 'Неторговые периоды установлены как на MOEX',
      source: 'api',
      logicId: id,
      payload: { count: rows[0]?.n ?? intervals.length },
    });
    res.json({
      logic_id: id,
      applied: Number(rows[0]?.n ?? 0),
      use_non_trading_periods: trading.use_non_trading_periods !== false,
      intervals,
    });
  } catch (err) {
    console.error('POST /api/logics/:id/non-trading-periods/moex-defaults', err);
    res.status(500).json({ error: err.message });
  }
});

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

app.post('/api/logics/:id/non-trading-periods', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid logic id' });
    return;
  }
  const day = Math.round(Number(req.body?.day_of_week));
  const timeFrom = parseTimeHm(req.body?.time_from);
  const timeTo = parseTimeHm(req.body?.time_to);
  const note =
    req.body?.note == null || req.body?.note === ''
      ? null
      : String(req.body.note).trim().slice(0, 200);
  if (!Number.isInteger(day) || day < 1 || day > 7) {
    res.status(400).json({ error: 'day_of_week: целое 1…7 (Пн…Вс)' });
    return;
  }
  if (!timeFrom || !timeTo) {
    res.status(400).json({ error: 'time_from / time_to: формат ЧЧ:ММ' });
    return;
  }
  if (timeFrom > timeTo) {
    res.status(400).json({ error: 'time_from не позже time_to' });
    return;
  }
  try {
    const { rows: exists } = await pool.query('SELECT id FROM logics WHERE id = $1', [id]);
    if (exists.length === 0) {
      res.status(404).json({ error: 'Logic not found' });
      return;
    }
    const { rows: ord } = await pool.query(
      `
      SELECT COALESCE(MAX(display_order), 0) + 1 AS n
      FROM logic_non_trading_intervals
      WHERE logic_id = $1
      `,
      [id]
    );
    await pool.query(
      `
      INSERT INTO logic_non_trading_intervals (
        logic_id, day_of_week, time_from, time_to, note, display_order, is_active
      )
      VALUES ($1, $2, $3::time, $4::time, $5, $6, TRUE)
      `,
      [id, day, timeFrom, timeTo, note, Number(ord[0]?.n ?? 1)]
    );
    const trading = await getTradingParams(pool, id);
    res.status(201).json({
      logic_id: id,
      use_non_trading_periods: trading.use_non_trading_periods !== false,
      intervals: await fetchNonTradingIntervals(pool, id),
    });
  } catch (err) {
    console.error('POST /api/logics/:id/non-trading-periods', err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/logic-non-trading-intervals/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid interval id' });
    return;
  }
  const patches = [];
  const vals = [];
  let n = 1;
  if (req.body?.day_of_week !== undefined) {
    const day = Math.round(Number(req.body.day_of_week));
    if (!Number.isInteger(day) || day < 1 || day > 7) {
      res.status(400).json({ error: 'day_of_week: целое 1…7' });
      return;
    }
    patches.push(`day_of_week = $${n++}`);
    vals.push(day);
  }
  if (req.body?.time_from !== undefined) {
    const t = parseTimeHm(req.body.time_from);
    if (!t) {
      res.status(400).json({ error: 'time_from: ЧЧ:ММ' });
      return;
    }
    patches.push(`time_from = $${n++}::time`);
    vals.push(t);
  }
  if (req.body?.time_to !== undefined) {
    const t = parseTimeHm(req.body.time_to);
    if (!t) {
      res.status(400).json({ error: 'time_to: ЧЧ:ММ' });
      return;
    }
    patches.push(`time_to = $${n++}::time`);
    vals.push(t);
  }
  if (req.body?.note !== undefined) {
    const note =
      req.body.note == null || req.body.note === ''
        ? null
        : String(req.body.note).trim().slice(0, 200);
    patches.push(`note = $${n++}`);
    vals.push(note);
  }
  if (req.body?.is_active !== undefined) {
    patches.push(`is_active = $${n++}`);
    vals.push(Boolean(req.body.is_active));
  }
  if (patches.length === 0) {
    res.status(400).json({ error: 'Нечего обновлять' });
    return;
  }
  vals.push(id);
  try {
    const { rows } = await pool.query(
      `
      UPDATE logic_non_trading_intervals
      SET ${patches.join(', ')}
      WHERE id = $${n}
      RETURNING logic_id
      `,
      vals
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Interval not found' });
      return;
    }
    const logicId = rows[0].logic_id;
    const trading = await getTradingParams(pool, logicId);
    res.json({
      logic_id: logicId,
      use_non_trading_periods: trading.use_non_trading_periods !== false,
      intervals: await fetchNonTradingIntervals(pool, logicId),
    });
  } catch (err) {
    console.error('PATCH /api/logic-non-trading-intervals/:id', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/logic-non-trading-intervals/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid interval id' });
    return;
  }
  try {
    const { rows } = await pool.query(
      `
      DELETE FROM logic_non_trading_intervals
      WHERE id = $1
      RETURNING logic_id
      `,
      [id]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Interval not found' });
      return;
    }
    const logicId = rows[0].logic_id;
    const trading = await getTradingParams(pool, logicId);
    res.json({
      ok: true,
      logic_id: logicId,
      use_non_trading_periods: trading.use_non_trading_periods !== false,
      intervals: await fetchNonTradingIntervals(pool, logicId),
    });
  } catch (err) {
    console.error('DELETE /api/logic-non-trading-intervals/:id', err);
    res.status(500).json({ error: err.message });
  }
});

const LOGIC_TRADE_SELECT = `
  SELECT
    lt.id,
    lt.logic_id,
    lt.account_id,
    lt.security_id,
    lt.timeframe_id,
    lt.side_id,
    lt.action_id,
    lt.signal_kind,
    lt.signal_formula,
    lt.quantity,
    lt.price,
    to_char(lt.bar_dt, 'YYYY-MM-DD HH24:MI:SS') AS bar_dt,
    to_char(lt.executed_at, 'YYYY-MM-DD HH24:MI:SS') AS executed_at,
    lt.is_simulated,
    lt.is_fictitious,
    lt.is_shadow,
    lt.is_test,
    lt.run_id,
    lt.trade_reason,
    lt.broker_order_id,
    lt.status,
    lt.commission,
    lt.financial_result,
    lt.note,
    COALESCE(lt.opt_lane, '') AS opt_lane,
    lt.created_at,
    CASE
      WHEN sd.name = 'Open' AND lt.status IN ('filled', 'submitted')
        THEN logic_trade_open_remaining_qty(lt.id)
      ELSE NULL
    END AS remaining_qty,
    s.name AS security_name,
    sp.prefix AS security_prefix,
    sd.name AS side_name,
    ac.name AS action_name,
    tf.tf AS timeframe_tf
  FROM logic_trades lt
  JOIN securities s ON s.id = lt.security_id
  LEFT JOIN LATERAL (
    SELECT prefix FROM security_prefixes WHERE security_id = s.id ORDER BY exchange_id LIMIT 1
  ) sp ON TRUE
  JOIN sides sd ON sd.id = lt.side_id
  JOIN actions ac ON ac.id = lt.action_id
  JOIN timeframes tf ON tf.id = lt.timeframe_id
`;

app.get('/api/logic-trades', async (req, res) => {
  const logicId = Number(req.query.logic_id);
  if (!Number.isInteger(logicId) || logicId <= 0) {
    res.status(400).json({ error: 'logic_id required' });
    return;
  }
  const isTestRaw = req.query.is_test;
  const isTest =
    isTestRaw === '1' || isTestRaw === 'true'
      ? true
      : isTestRaw === '0' || isTestRaw === 'false'
        ? false
        : null;
  const runIdRaw = req.query.run_id;
  const runId =
    runIdRaw != null && runIdRaw !== '' && Number.isFinite(Number(runIdRaw))
      ? Number(runIdRaw)
      : null;
  const limitRaw = Number(req.query.limit);
  // Test runs can exceed 5k closes; panel must load the full latest run or finres != table column.
  const defaultLimit = isTest === true ? 20000 : 100;
  const limitCap = isTest === true ? 50000 : 500;
  const limit = Math.min(
    Math.max(Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : defaultLimit, 1),
    limitCap
  );
  try {
    const params = [logicId];
    let where = 'WHERE lt.logic_id = $1';
    if (isTest === true) {
      where += ' AND lt.is_test = TRUE';
    } else if (isTest === false) {
      where += ' AND lt.is_test = FALSE';
    }
    if (runId != null && runId > 0) {
      params.push(runId);
      where += ` AND lt.run_id = $${params.length}`;
    }
    params.push(limit);
    const { rows } = await pool.query(
      `${LOGIC_TRADE_SELECT}
       ${where}
       ORDER BY lt.executed_at DESC, lt.id DESC
       LIMIT $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/logic-trades', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Full trade dump for analysis (open/close/shadow/rejected/etc. + lots).
 * Query: logic_id, is_test=0|1, optional run_id (test: omit = latest run if any).
 */
app.get('/api/logic-trades/export', async (req, res) => {
  const logicId = Number(req.query.logic_id);
  if (!Number.isInteger(logicId) || logicId <= 0) {
    res.status(400).json({ error: 'logic_id required' });
    return;
  }
  const isTestRaw = req.query.is_test;
  const isTest =
    isTestRaw === '1' || isTestRaw === 'true'
      ? true
      : isTestRaw === '0' || isTestRaw === 'false'
        ? false
        : null;
  if (isTest == null) {
    res.status(400).json({ error: 'is_test required (0 or 1)' });
    return;
  }
  let runId =
    req.query.run_id != null &&
    req.query.run_id !== '' &&
    Number.isFinite(Number(req.query.run_id))
      ? Number(req.query.run_id)
      : null;
  try {
    const { rows: logicRows } = await pool.query(
      `SELECT id, name, is_enabled, note FROM logics WHERE id = $1`,
      [logicId]
    );
    if (logicRows.length === 0) {
      res.status(404).json({ error: 'Logic not found' });
      return;
    }
    const logic = logicRows[0];

    // Same portable definition as logics/export: params, signals, stops, papers, account.
    const logicBundle = await buildLogicBundle(pool, [logicId]);
    const logicDef = logicBundle.logics?.[0] || {
      name: logic.name,
      note: logic.note,
      params: [],
      signals: [],
      stops: [],
      securities: [],
      account: null,
    };
    const tradingParams = await getTradingParams(pool, logicId);
    let nonTradingIntervals = [];
    try {
      await pool.query('SELECT logic_ensure_non_trading_periods($1)', [logicId]);
      nonTradingIntervals = await fetchNonTradingIntervals(pool, logicId);
    } catch (_ntpErr) {
      nonTradingIntervals = [];
    }

    let runMeta = null;
    if (isTest) {
      if (runId == null || runId <= 0) {
        const { rows: runRows } = await pool.query(
          `SELECT id, date_from, date_to, status, financial_result, test_balance,
                  to_char(started_at, 'YYYY-MM-DD HH24:MI:SS') AS started_at,
                  to_char(finished_at, 'YYYY-MM-DD HH24:MI:SS') AS finished_at
           FROM logic_backtest_runs
           WHERE logic_id = $1
           ORDER BY id DESC
           LIMIT 1`,
          [logicId]
        );
        if (runRows.length > 0) {
          runId = Number(runRows[0].id);
          runMeta = runRows[0];
        }
      } else {
        const { rows: runRows } = await pool.query(
          `SELECT id, date_from, date_to, status, financial_result, test_balance,
                  to_char(started_at, 'YYYY-MM-DD HH24:MI:SS') AS started_at,
                  to_char(finished_at, 'YYYY-MM-DD HH24:MI:SS') AS finished_at
           FROM logic_backtest_runs
           WHERE logic_id = $1 AND id = $2`,
          [logicId, runId]
        );
        runMeta = runRows[0] || null;
      }
    }

    const params = [logicId];
    let where = 'WHERE lt.logic_id = $1 AND lt.is_test = $2';
    params.push(isTest);
    if (isTest && runId != null && runId > 0) {
      params.push(runId);
      where += ` AND lt.run_id = $${params.length}`;
    }
    // No status/shadow filter — full dump for analysis.
    const limit = 100000;
    params.push(limit);
    const { rows: trades } = await pool.query(
      `${LOGIC_TRADE_SELECT}
       ${where}
       ORDER BY lt.bar_dt ASC NULLS LAST, lt.executed_at ASC, lt.id ASC
       LIMIT $${params.length}`,
      params
    );

    const tradeIds = trades.map((t) => Number(t.id)).filter((id) => id > 0);
    let lots = [];
    if (tradeIds.length > 0) {
      const { rows: lotRows } = await pool.query(
        `
        SELECT
          l.id,
          l.logic_id,
          l.close_trade_id,
          l.open_trade_id,
          l.action_id,
          l.cost_method,
          l.quantity,
          l.close_amount,
          l.open_amount,
          l.close_commission,
          l.open_commission,
          l.financial_result,
          to_char(l.created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at,
          ac.name AS action_name,
          to_char(ot.executed_at, 'YYYY-MM-DD HH24:MI:SS') AS open_executed_at,
          ot.price AS open_price,
          to_char(ct.executed_at, 'YYYY-MM-DD HH24:MI:SS') AS close_executed_at,
          ct.price AS close_price
        FROM logic_trade_lots l
        JOIN actions ac ON ac.id = l.action_id
        JOIN logic_trades ct ON ct.id = l.close_trade_id
        LEFT JOIN logic_trades ot ON ot.id = l.open_trade_id
        WHERE l.logic_id = $1
          AND (l.close_trade_id = ANY($2::bigint[]) OR l.open_trade_id = ANY($2::bigint[]))
        ORDER BY l.id ASC
        `,
        [logicId, tradeIds]
      );
      lots = lotRows;
    }

    const counts = {
      total: trades.length,
      open: 0,
      close: 0,
      shadow: 0,
      non_shadow: 0,
      simulated: 0,
      fictitious: 0,
      by_status: {},
      by_signal_kind: {},
      with_remaining: 0,
      lots: lots.length,
    };
    for (const t of trades) {
      if (t.side_name === 'Open') counts.open += 1;
      if (t.side_name === 'Close') counts.close += 1;
      if (t.is_shadow) counts.shadow += 1;
      else counts.non_shadow += 1;
      if (t.is_simulated) counts.simulated += 1;
      if (t.is_fictitious) counts.fictitious += 1;
      const st = String(t.status || 'unknown');
      counts.by_status[st] = (counts.by_status[st] || 0) + 1;
      const sk = String(t.signal_kind || 'unknown');
      counts.by_signal_kind[sk] = (counts.by_signal_kind[sk] || 0) + 1;
      if (t.remaining_qty != null && Number(t.remaining_qty) > 0) {
        counts.with_remaining += 1;
      }
    }

    res.json({
      format: 'multilogic-trades-export',
      version: 2,
      exported_at: new Date().toISOString(),
      is_test: isTest,
      // Full logic card for analysis (params, signals, stops, papers, account).
      logic: {
        id: Number(logicDef.id ?? logicId),
        name: logicDef.name,
        note: logicDef.note ?? null,
        is_enabled: Boolean(logic.is_enabled),
        account: logicDef.account ?? null,
        params: logicDef.params ?? [],
        signals: logicDef.signals ?? [],
        stops: logicDef.stops ?? [],
        securities: logicDef.securities ?? [],
      },
      trading_params: tradingParams,
      non_trading_periods: {
        use_non_trading_periods: tradingParams.use_non_trading_periods !== false,
        intervals: nonTradingIntervals,
      },
      run_id: runId,
      run: runMeta,
      counts,
      trades,
      lots,
      note:
        'Complete dump for AI/debug: logic params/signals/stops/papers, trading params, non-trading periods, all trades (open/close/shadow/simulated/fictitious/all statuses) + lots.',
    });
  } catch (err) {
    console.error('GET /api/logic-trades/export', err);
    res.status(500).json({ error: err.message });
  }
});

/** Онлайн-сводка PnL/комиссий по логикам (не хранится отдельным полем). */
app.get('/api/logic-trades/pnl-summary', async (req, res) => {
  const isTestRaw = req.query.is_test;
  const isTest =
    isTestRaw === '0' || isTestRaw === 'false'
      ? false
      : true; // по умолчанию тест — для колонки на главной
  try {
    if (isTest) {
      // Только живые is_test-сделки этой логики (не fallback на runs —
      // иначе после DELETE при новом тесте в таблице «висит» старый financial_result прогона).
      // При наличии run_id берём сделки последнего прогона логики.
      const { rows } = await pool.query(
        `
        -- latest_run: тот же критерий, что getBacktestStatus (ORDER BY id DESC),
        -- иначе колонка «Тест» и блок «Тестирование» суммируют разные прогоны.
        WITH latest_run AS (
          SELECT DISTINCT ON (r.logic_id)
            r.logic_id,
            r.id AS run_id,
            r.date_from::text AS date_from,
            r.date_to::text AS date_to
          FROM logic_backtest_runs r
          ORDER BY r.logic_id, r.id DESC
        )
        SELECT
          lt.logic_id,
          COALESCE(SUM(lt.financial_result), 0)::float8 AS financial_result,
          COALESCE(SUM(COALESCE(lt.commission, 0)), 0)::float8 AS commission,
          COUNT(*)::int AS trade_count,
          MAX(lr.date_from) AS date_from,
          MAX(lr.date_to) AS date_to
        FROM logic_trades lt
        LEFT JOIN latest_run lr ON lr.logic_id = lt.logic_id
        WHERE lt.is_test = TRUE
          AND COALESCE(lt.is_shadow, FALSE) = FALSE
          AND COALESCE(lt.opt_lane, '') = ''
          AND lt.status IN ('filled', 'submitted')
          AND (
            (lt.run_id IS NOT NULL AND lr.run_id IS NOT NULL AND lt.run_id = lr.run_id)
            OR (
              lt.run_id IS NULL
              AND NOT EXISTS (
                SELECT 1
                FROM logic_trades x
                WHERE x.logic_id = lt.logic_id
                  AND x.is_test = TRUE
                  AND x.run_id IS NOT NULL
              )
            )
          )
        GROUP BY lt.logic_id
        HAVING COUNT(*) > 0
        ORDER BY lt.logic_id
        `
      );
      res.json({
        is_test: true,
        rows: rows.map((r) => ({
          logic_id: Number(r.logic_id),
          financial_result: Number(r.financial_result),
          commission: Number(r.commission),
          trade_count: Number(r.trade_count),
          date_from: r.date_from != null ? String(r.date_from) : null,
          date_to: r.date_to != null ? String(r.date_to) : null,
        })),
      });
      return;
    }

    const { rows } = await pool.query(
      `
      SELECT
        lt.logic_id,
        COALESCE(SUM(lt.financial_result), 0)::float8 AS financial_result,
        COALESCE(SUM(COALESCE(lt.commission, 0)), 0)::float8 AS commission,
        COUNT(*)::int AS trade_count
      FROM logic_trades lt
      WHERE lt.is_test = FALSE
        AND COALESCE(lt.is_shadow, FALSE) = FALSE
        AND COALESCE(lt.opt_lane, '') = ''
        AND lt.status IN ('filled', 'submitted')
      GROUP BY lt.logic_id
      HAVING COUNT(*) > 0
      ORDER BY lt.logic_id
      `
    );
    res.json({
      is_test: false,
      rows: rows.map((r) => ({
        logic_id: Number(r.logic_id),
        financial_result: Number(r.financial_result),
        commission: Number(r.commission),
        trade_count: Number(r.trade_count),
      })),
    });
  } catch (err) {
    console.error('GET /api/logic-trades/pnl-summary', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logic-trade-lots', async (req, res) => {
  const tradeId = Number(req.query.trade_id);
  if (!Number.isInteger(tradeId) || tradeId <= 0) {
    res.status(400).json({ error: 'trade_id required' });
    return;
  }
  try {
    const { rows } = await pool.query(
      `
      SELECT
        l.id,
        l.logic_id,
        l.close_trade_id,
        l.open_trade_id,
        l.action_id,
        l.cost_method,
        l.quantity,
        l.close_amount,
        l.open_amount,
        l.close_commission,
        l.open_commission,
        l.financial_result,
        l.created_at,
        ac.name AS action_name,
        ot.executed_at AS open_executed_at,
        ot.price AS open_price,
        ct.executed_at AS close_executed_at,
        ct.price AS close_price
      FROM logic_trade_lots l
      JOIN actions ac ON ac.id = l.action_id
      JOIN logic_trades ct ON ct.id = l.close_trade_id
      LEFT JOIN logic_trades ot ON ot.id = l.open_trade_id
      WHERE l.close_trade_id = $1 OR l.open_trade_id = $1
      ORDER BY l.id ASC
      `,
      [tradeId]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/logic-trade-lots', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logic-trades/run', async (_req, res) => {
  try {
    const result = await runTradeCycle(pool, { manual: true });
    await writeTechLogEvent(pool, {
      threadKey: 'trade-runner',
      operation: 'cycle.manual',
      message: `Ручной запуск: processed=${result.processed ?? 0} created=${result.created ?? 0}`,
      source: 'api',
      payload: result,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('POST /api/logic-trades/run', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logic-trades/heartbeat', async (_req, res) => {
  try {
    await touchUiHeartbeatDb(pool);
    res.json({ ok: true, active: isUiSessionActive() });
  } catch (err) {
    console.error('POST /api/logic-trades/heartbeat', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logic-trades/heartbeat/end', async (_req, res) => {
  try {
    await clearUiHeartbeatDb(pool);
    res.json({ ok: true, active: false });
  } catch (err) {
    console.error('POST /api/logic-trades/heartbeat/end', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logic-trades/close-all', async (req, res) => {
  const logicId = parseInt(String(req.body?.logic_id ?? req.query?.logic_id ?? ''), 10);
  if (!Number.isFinite(logicId) || logicId <= 0) {
    res.status(400).json({ error: 'Укажите logic_id' });
    return;
  }
  try {
    const { rows } = await pool.query(
      'SELECT logic_close_all_positions_at_market($1::INTEGER) AS result',
      [logicId]
    );
    const result = rows[0]?.result ?? {};
    await writeTechLogEvent(pool, {
      threadKey: 'trade-runner',
      operation: 'trade.close_all',
      message: `Закрыть всё: logic=${logicId} closed=${result.closed ?? 0}`,
      source: 'api',
      logicId,
      payload: result,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('POST /api/logic-trades/close-all', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logic-backtest/start', async (req, res) => {
  const logicId = Number(req.body?.logic_id);
  const dateFrom = btrimStr(req.body?.date_from);
  const dateTo = btrimStr(req.body?.date_to);
  if (!Number.isInteger(logicId) || logicId <= 0) {
    res.status(400).json({ error: 'logic_id required' });
    return;
  }
  if (!dateFrom || !dateTo) {
    res.status(400).json({ error: 'date_from and date_to required (YYYY-MM-DD)' });
    return;
  }
  try {
    const { rows: active } = await pool.query(
      `SELECT id FROM logic_backtest_runs
       WHERE logic_id = $1 AND status IN ('pending','loading_prices','loading_indicators','running')
       LIMIT 1`,
      [logicId]
    );
    if (active.length > 0) {
      res.status(409).json({ error: 'Тестирование уже выполняется', run_id: active[0].id });
      return;
    }
    const runId = await startBacktest(pool, logicId, dateFrom, dateTo);
    res.status(202).json({ ok: true, run_id: runId });
  } catch (err) {
    console.error('POST /api/logic-backtest/start', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logic-backtest/status', async (req, res) => {
  const logicId = Number(req.query.logic_id);
  const runId = req.query.run_id != null ? Number(req.query.run_id) : null;
  if (!Number.isInteger(logicId) || logicId <= 0) {
    res.status(400).json({ error: 'logic_id required' });
    return;
  }
  try {
    const row = await getBacktestStatus(pool, logicId, runId);
    if (!row) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    res.json(row);
  } catch (err) {
    console.error('GET /api/logic-backtest/status', err);
    res.status(500).json({ error: err.message });
  }
});

/** All in-progress backtests (UI recover after leaving /operations tab). */
app.get('/api/logic-backtest/active', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT DISTINCT ON (r.logic_id)
        r.id, r.logic_id,
        r.date_from::text AS date_from,
        r.date_to::text AS date_to,
        r.status,
        r.progress_pct::float8 AS progress_pct,
        r.phase_message, r.phase_detail, r.current_bar_dt,
        r.total_bars, r.processed_bars, r.trades_created,
        r.test_balance::float8 AS test_balance,
        r.financial_result::float8 AS financial_result,
        r.cancel_requested, r.error_message, r.started_at, r.finished_at, r.created_at
      FROM logic_backtest_runs r
      WHERE r.status IN ('pending', 'loading_prices', 'loading_indicators', 'running')
      ORDER BY r.logic_id, r.id DESC
      `
    );
    res.json({ rows });
  } catch (err) {
    console.error('GET /api/logic-backtest/active', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logic-backtest/cancel', async (req, res) => {
  const runId = Number(req.body?.run_id);
  if (!Number.isInteger(runId) || runId <= 0) {
    res.status(400).json({ error: 'run_id required' });
    return;
  }
  try {
    const ok = await cancelBacktest(pool, runId);
    if (!ok) {
      res.status(404).json({ error: 'Run not found or already finished' });
      return;
    }
    res.json({ ok: true, run_id: runId });
  } catch (err) {
    console.error('POST /api/logic-backtest/cancel', err);
    res.status(500).json({ error: err.message });
  }
});

/** Archived backtest HTML reports (PostgreSQL). */
app.get('/api/logic-backtest/reports', async (req, res) => {
  try {
    const logicId =
      req.query.logic_id != null && req.query.logic_id !== ''
        ? Number(req.query.logic_id)
        : null;
    const rows = await listBacktestReports(pool, {
      limit: req.query.limit,
      offset: req.query.offset,
      logicId,
    });
    res.json({ rows });
  } catch (err) {
    console.error('GET /api/logic-backtest/reports', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logic-backtest/reports/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'id required' });
    return;
  }
  try {
    const includeHtml =
      req.query.html === '1' ||
      req.query.html === 'true' ||
      req.query.html === undefined;
    const neighbors = await getBacktestReportNeighbors(pool, id);
    if (!neighbors?.current) {
      res.status(404).json({ error: 'Report not found' });
      return;
    }
    const row = { ...neighbors.current };
    if (!includeHtml) {
      delete row.html_body;
    }
    res.json({
      row,
      prev_id: neighbors.prev_id,
      next_id: neighbors.next_id,
    });
  } catch (err) {
    console.error('GET /api/logic-backtest/reports/:id', err);
    res.status(500).json({ error: err.message });
  }
});

/** Rebuild archive for an existing run (manual / backfill). */
app.post('/api/logic-backtest/reports/rebuild', async (req, res) => {
  const runId = Number(req.body?.run_id);
  if (!Number.isInteger(runId) || runId <= 0) {
    res.status(400).json({ error: 'run_id required' });
    return;
  }
  try {
    const row = await persistBacktestReport(pool, runId, { isSnapshot: false });
    if (!row) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    res.json({ ok: true, id: row.id, run_id: row.run_id });
  } catch (err) {
    console.error('POST /api/logic-backtest/reports/rebuild', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tech-log', async (req, res) => {
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
  if (entries.length === 0) {
    res.status(400).json({ error: 'Укажите entries[]' });
    return;
  }
  if (entries.length > 200) {
    res.status(400).json({ error: 'Не более 200 записей за раз' });
    return;
  }

  const client = await pool.connect();
  try {
    const { rows: flagRows } = await client.query(
      'SELECT app_tech_logging_enabled() AS enabled'
    );
    if (!flagRows[0]?.enabled) {
      res.json({ ok: true, inserted: 0, skipped: true });
      return;
    }

    let inserted = 0;
    for (const raw of entries) {
      const traceId = btrimStr(raw.trace_id);
      const spanId = btrimStr(raw.span_id);
      const threadKey = btrimStr(raw.thread_key);
      const operation = btrimStr(raw.operation);
      const phase = btrimStr(raw.phase);
      if (!traceId || !spanId || !threadKey || !operation || !phase) {
        continue;
      }
      if (!['start', 'end', 'event'].includes(phase)) {
        continue;
      }
      await client.query(
        `
        INSERT INTO app_tech_log (
          trace_id, span_id, parent_span_id, thread_key, source, operation, phase,
          started_at, finished_at, duration_ms,
          security_id, timeframe_id, logic_id, sync_gen, message, payload
        ) VALUES (
          $1::uuid, $2, $3, $4, COALESCE(NULLIF($5, ''), 'web'), $6, $7,
          COALESCE($8::timestamptz, CURRENT_TIMESTAMP),
          $9::timestamptz, $10,
          $11, $12, $13, $14, $15, $16::jsonb
        )
        `,
        [
          traceId,
          spanId,
          raw.parent_span_id ? btrimStr(raw.parent_span_id) : null,
          threadKey,
          raw.source ? btrimStr(raw.source) : 'web',
          operation,
          phase,
          raw.started_at ? String(raw.started_at) : null,
          raw.finished_at ? String(raw.finished_at) : null,
          raw.duration_ms != null ? Number(raw.duration_ms) : null,
          parseId(raw.security_id) || null,
          parseId(raw.timeframe_id) || null,
          parseId(raw.logic_id) || null,
          parseId(raw.sync_gen) || null,
          raw.message != null ? String(raw.message) : null,
          raw.payload != null ? JSON.stringify(raw.payload) : null,
        ]
      );
      inserted += 1;
    }
    res.json({ ok: true, inserted });
  } catch (err) {
    console.error('POST /api/tech-log', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/tech-log', async (req, res) => {
  const limit = Math.min(parseId(req.query.limit) || 100, 500);
  const securityId = parseId(req.query.security_id);
  const logicId = parseId(req.query.logic_id);
  const traceId = req.query.trace_id ? String(req.query.trace_id).trim() : null;
  const since = req.query.since ? String(req.query.since).trim() : null;

  const where = [];
  const params = [];
  let idx = 1;
  if (securityId) {
    where.push(`security_id = $${idx++}`);
    params.push(securityId);
  }
  if (logicId) {
    where.push(`logic_id = $${idx++}`);
    params.push(logicId);
  }
  if (traceId) {
    where.push(`trace_id::text = $${idx++}`);
    params.push(traceId);
  }
  if (since) {
    where.push(`created_at >= $${idx++}::timestamptz`);
    params.push(since);
  }
  params.push(limit);
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  try {
    const { rows } = await pool.query(
      `
      SELECT
        id, trace_id::text AS trace_id, span_id, parent_span_id, thread_key, source,
        operation, phase, started_at, finished_at, duration_ms,
        security_id, timeframe_id, logic_id, sync_gen, message, payload, created_at
      FROM app_tech_log
      ${whereSql}
      ORDER BY id DESC
      LIMIT $${idx}
      `,
      params
    );
    res.json({ rows });
  } catch (err) {
    console.error('GET /api/tech-log', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/processes', async (_req, res) => {
  const rows = [];
  try {
    const active = await pool.query(`
      SELECT
        pid,
        state,
        wait_event_type,
        wait_event,
        now() - COALESCE(query_start, xact_start, backend_start) AS age,
        left(regexp_replace(COALESCE(query, ''), '\\s+', ' ', 'g'), 180) AS query
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND state <> 'idle'
      ORDER BY COALESCE(query_start, xact_start, backend_start) NULLS LAST
      LIMIT 20
    `);
    for (const r of active.rows) {
      rows.push({
        type: 'postgres',
        label: `PostgreSQL pid ${r.pid}`,
        status: r.state || 'active',
        detail: r.query || '',
        wait: [r.wait_event_type, r.wait_event].filter(Boolean).join(':') || null,
        age: String(r.age || ''),
      });
    }

    const backtests = await pool.query(`
      SELECT
        r.logic_id,
        l.name AS logic_name,
        r.status,
        COALESCE(r.progress_pct, 0) AS progress_pct,
        r.phase_message,
        r.phase_detail,
        r.started_at
      FROM logic_backtest_runs r
      JOIN logics l ON l.id = r.logic_id
      WHERE r.status IN ('pending', 'loading_prices', 'loading_indicators', 'running')
      ORDER BY r.started_at DESC
      LIMIT 20
    `);
    for (const r of backtests.rows) {
      rows.push({
        type: 'backtest',
        label: `Test: ${r.logic_name}`,
        status: r.status,
        detail: [r.phase_message, r.phase_detail].filter(Boolean).join(' — '),
        progress_pct: Number(r.progress_pct) || 0,
        logic_id: r.logic_id,
        started_at: r.started_at,
      });
    }

    const enabled = await pool.query(`
      SELECT COUNT(*)::int AS cnt
      FROM logics
      WHERE is_enabled = TRUE
    `);
    const enabledCount = Number(enabled.rows[0]?.cnt) || 0;
    if (enabledCount > 0) {
      rows.push({
        type: 'trade_runner',
        label: 'Trade runner',
        status: 'scheduled',
        detail: `${enabledCount} enabled logic(s), Node fallback interval ${process.env.TRADE_RUNNER_INTERVAL_MS || 15000} ms`,
      });
    }

    try {
      const cronExists = await pool.query(`SELECT to_regclass('cron.job') AS job_table`);
      if (cronExists.rows[0]?.job_table) {
        const cron = await pool.query(`
          SELECT jobid, schedule, command, active
          FROM cron.job
          WHERE command ILIKE '%run_trade_cycle%'
          ORDER BY jobid
          LIMIT 10
        `);
        for (const r of cron.rows) {
          rows.push({
            type: 'pg_cron',
            label: `pg_cron job ${r.jobid}`,
            status: r.active ? 'active' : 'disabled',
            detail: `${r.schedule}: ${r.command}`,
          });
        }
      }
    } catch (cronErr) {
      rows.push({
        type: 'pg_cron',
        label: 'pg_cron',
        status: 'unavailable',
        detail: cronErr.message,
      });
    }

    res.json({ rows });
  } catch (err) {
    console.error('GET /api/processes', err);
    res.status(500).json({ error: err.message, rows });
  }
});

function btrimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

/** Живая структура БД multilogictrade (public) */
app.get('/api/schema', async (_req, res) => {
  try {
    const [tablesResult, routinesResult, extensionsResult] = await Promise.all([
      pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `),
      pool.query(`
        SELECT
          p.oid,
          p.proname AS name,
          p.prokind AS kind,
          pg_get_function_identity_arguments(p.oid) AS arguments,
          pg_get_function_result(p.oid) AS result_type,
          obj_description(p.oid, 'pg_proc') AS description
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.prokind IN ('f', 'p')
          -- не тащим функции расширений (pgsql-http и т.п.) — только прикладные из 02
          AND NOT EXISTS (
            SELECT 1
            FROM pg_depend d
            JOIN pg_extension e ON e.oid = d.refobjid
            WHERE d.objid = p.oid
              AND d.deptype = 'e'
          )
        ORDER BY p.prokind, p.proname, p.oid
      `),
      pool.query(`
        SELECT extname AS name, extversion AS version
        FROM pg_extension
        ORDER BY extname
      `),
    ]);

    const tables = [];
    for (const { table_name } of tablesResult.rows) {
      const [columns, indexes, constraints, tableComment] = await Promise.all([
        pool.query(
          `
          SELECT
            c.column_name,
            c.data_type,
            c.udt_name,
            c.is_nullable,
            c.column_default,
            c.character_maximum_length,
            c.numeric_precision,
            c.numeric_scale,
            c.ordinal_position,
            pg_catalog.col_description(cls.oid, c.ordinal_position) AS comment
          FROM information_schema.columns c
          JOIN pg_catalog.pg_class cls ON cls.relname = c.table_name
          JOIN pg_catalog.pg_namespace n ON n.oid = cls.relnamespace AND n.nspname = c.table_schema
          WHERE c.table_schema = 'public' AND c.table_name = $1
          ORDER BY c.ordinal_position
          `,
          [table_name]
        ),
        pool.query(
          `
          SELECT indexname AS name, indexdef AS definition
          FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = $1
          ORDER BY indexname
          `,
          [table_name]
        ),
        pool.query(
          `
          SELECT
            c.conname AS name,
            c.contype AS type,
            pg_get_constraintdef(c.oid) AS definition
          FROM pg_constraint c
          JOIN pg_class rel ON rel.oid = c.conrelid
          JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
          WHERE nsp.nspname = 'public' AND rel.relname = $1
          ORDER BY c.conname
          `,
          [table_name]
        ),
        pool.query(
          `
          SELECT obj_description(c.oid, 'pg_class') AS comment
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = $1
          `,
          [table_name]
        ),
      ]);

      tables.push({
        name: table_name,
        comment: tableComment.rows[0]?.comment || null,
        columns: columns.rows.map(formatColumn),
        indexes: indexes.rows,
        constraints: constraints.rows.map(formatConstraint),
      });
    }

    res.json({
      schema: 'public',
      database: process.env.PGDATABASE || 'multilogictrade',
      sourceMode: 'live',
      sourceNote:
        'Структура из подключённой PostgreSQL (таблицы, колонки, индексы, ограничения; все функции/процедуры public кроме расширений).',
      tables,
      routines: routinesResult.rows.map(formatRoutine),
      extensions: extensionsResult.rows,
    });
  } catch (err) {
    console.error('GET /api/schema', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/schema/routine/:oid/source', async (req, res) => {
  const oid = Number(req.params.oid);
  if (!Number.isInteger(oid) || oid <= 0) {
    res.status(400).json({ error: 'Invalid routine oid' });
    return;
  }
  try {
    const { rows } = await pool.query(
      `
      SELECT
        p.proname AS name,
        p.prokind AS kind,
        pg_get_function_identity_arguments(p.oid) AS arguments,
        pg_get_functiondef(p.oid) AS source
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.oid = $1
      `,
      [oid]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Routine not found' });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /api/schema/routine/:oid/source', err);
    res.status(500).json({ error: err.message });
  }
});

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
  const client = await pool.connect();
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
  const { rows: brokers } = await pool.query(
    'SELECT id, code, api_url FROM brokers WHERE id = $1',
    [parsed.broker_id]
  );
  if (brokers.length === 0 || brokers[0].code !== 'T-BANK') {
    return parsed;
  }

  let token = parsed.api_token;
  if (!token && existingAccountId) {
    const { rows } = await pool.query(
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
    const { rows } = await pool.query(
      `SELECT fetch_tbank_account_balance($1) AS bal`,
      [row.id]
    );
    const bal = rows[0]?.bal ?? {};
    base.balance = bal.amount != null ? Number(bal.amount) : null;
    base.cash_amount = bal.cash_amount != null ? Number(bal.cash_amount) : null;
    base.balance_currency = bal.currency ?? null;
    base.balance_error = bal.error ? String(bal.error) : null;
    // При ошибке T-Bank SQL кладёт display='ошибка' — оставляем, текст в balance_error
    base.balance_display = base.balance_error
      ? bal.display || 'ошибка'
      : bal.display ?? '—';
  } catch (err) {
    base.balance_error = err.message || String(err);
    base.balance_display = 'ошибка';
  }
  return base;
}

async function pgResolveTbankAccount(apiUrl, token, preferredAccountId) {
  const { rows } = await pool.query(
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
}

async function pgFetchTbankPortfolioBalance(apiUrl, token, accountId) {
  const { rows } = await pool.query(
    `SELECT fetch_tbank_portfolio_balance($1, $2, $3) AS bal`,
    [apiUrl, token, accountId]
  );
  const bal = rows[0]?.bal ?? {};
  return {
    amount: bal.amount != null ? Number(bal.amount) : null,
    currency: bal.currency ?? null,
    display: bal.display ?? null,
  };
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
    const { rows: brokers } = await pool.query(
      'SELECT id, code, api_url FROM brokers WHERE id = $1',
      [broker_id]
    );
    brokerRow = brokers[0];
  } else {
    const { rows: brokers } = await pool.query(
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
    const { rows } = await pool.query(
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

app.use((_req, res) => {
  res.status(404).json({
    error: `Маршрут API не найден. Перезапустите web\\MultiLogic_Trade_Progress_Start.bat.`,
  });
});

app.listen(port, () => {
  console.log(`MultiLogicTrade API: http://localhost:${port}`);
  console.log(`CORS origin: ${corsOrigin}`);
  startTradeRunner(pool);
  startMaintenanceScheduler(pool);
  // Interrupted backtests (bat/API kill) stay status=running in DB — continue same run_id.
  resumeOrphanBacktests(pool)
    .then((r) => {
      if (r.scheduled > 0) {
        console.log(
          `Backtest resume: scheduled ${r.scheduled} orphan run(s) of ${r.found} found`
        );
      }
    })
    .catch((err) => console.error('resumeOrphanBacktests', err));
});
