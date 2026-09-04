'use strict';

const {
  buildBacktestReportModel,
  renderBacktestReportHtml,
  buildBacktestReportDownloadName,
} = require('./lib/backtest-report');
const { buildPaperChartsForRun } = require('./lib/backtest-paper-charts');
const { LOGIC_TRADE_SELECT_TEST_PANEL } = require('./lib/logic-trade-sql');

/** Prevent overlapping persist for the same run_id. */
const persistInFlight = new Map();

/**
 * Fire-and-forget: never awaited from the bar loop.
 * @param {import('pg').Pool} pool
 * @param {number} runId
 * @param {{ isSnapshot?: boolean }} [opts]
 */
function schedulePersistBacktestReport(pool, runId, opts = {}) {
  const id = Number(runId);
  if (!Number.isInteger(id) || id <= 0) return;
  if (persistInFlight.has(id)) return;

  const job = persistBacktestReport(pool, id, opts)
    .catch((err) => {
      console.error('persistBacktestReport failed', id, err?.message || err);
    })
    .finally(() => {
      persistInFlight.delete(id);
    });
  persistInFlight.set(id, job);
}

async function persistBacktestReport(pool, runId, opts = {}) {
  const isSnapshot = !!opts.isSnapshot;

  const { rows: runRows } = await pool.query(
    `
    SELECT r.id, r.logic_id,
      r.date_from::text AS date_from,
      r.date_to::text AS date_to,
      r.status,
      r.progress_pct::float8 AS progress_pct,
      r.financial_result::float8 AS financial_result,
      r.trades_created,
      r.processed_bars, r.total_bars
    FROM logic_backtest_runs r
    WHERE r.id = $1
    `,
    [runId]
  );
  const run = runRows[0];
  if (!run) return null;

  const { rows: logicRows } = await pool.query(
    `
    SELECT
      l.id,
      l.name,
      a.account_type,
      a.name AS account_name,
      a.account_code,
      COALESCE((
        SELECT NULLIF(replace(btrim(p.param_value), ',', '.'), '')::float8
        FROM logic_params p WHERE p.logic_id = l.id AND p.param_key = 'initial_balance'
          AND btrim(p.param_value) ~ '^-?[0-9]+([.,][0-9]+)?$'
        LIMIT 1
      ), 1000000)::float8 AS initial_balance,
      COALESCE((
        SELECT NULLIF(replace(btrim(p.param_value), ',', '.'), '')::float8
        FROM logic_params p WHERE p.logic_id = l.id AND p.param_key = 'test_initial_balance'
          AND btrim(p.param_value) ~ '^-?[0-9]+([.,][0-9]+)?$'
        LIMIT 1
      ), NULL)::float8 AS test_initial_balance,
      COALESCE((
        SELECT NULLIF(replace(btrim(p.param_value), ',', '.'), '')::float8
        FROM logic_params p WHERE p.logic_id = l.id AND p.param_key = 'base_annual_rate_pct'
          AND btrim(p.param_value) ~ '^-?[0-9]+([.,][0-9]+)?$'
        LIMIT 1
      ), 7)::float8 AS base_annual_rate_pct,
      COALESCE((
        SELECT NULLIF(replace(btrim(p.param_value), ',', '.'), '')::float8
        FROM logic_params p WHERE p.logic_id = l.id AND p.param_key = 'position_size_pct'
          AND btrim(p.param_value) ~ '^-?[0-9]+([.,][0-9]+)?$'
        LIMIT 1
      ), 0)::float8 AS position_size_pct,
      COALESCE((
        SELECT NULLIF(replace(btrim(p.param_value), ',', '.'), '')::int
        FROM logic_params p WHERE p.logic_id = l.id AND p.param_key = 'max_open_positions'
          AND btrim(p.param_value) ~ '^-?[0-9]+$'
        LIMIT 1
      ), 0)::int AS max_open_positions,
      COALESCE((
        SELECT NULLIF(replace(btrim(p.param_value), ',', '.'), '')::float8
        FROM logic_params p WHERE p.logic_id = l.id AND p.param_key = 'commission_pct'
          AND btrim(p.param_value) ~ '^-?[0-9]+([.,][0-9]+)?$'
        LIMIT 1
      ), 0)::float8 AS commission_pct,
      COALESCE((
        SELECT NULLIF(btrim(p.param_value), '')
        FROM logic_params p WHERE p.logic_id = l.id AND p.param_key = 'cost_method'
        LIMIT 1
      ), 'FIFO') AS cost_method,
      COALESCE((
        SELECT lower(btrim(p.param_value)) IN ('1', 'true', 'yes', 'on', 'да')
        FROM logic_params p WHERE p.logic_id = l.id AND p.param_key = 'inversion'
        LIMIT 1
      ), FALSE) AS inversion,
      COALESCE((
        SELECT NULLIF(btrim(p.param_value), '')
        FROM logic_params p WHERE p.logic_id = l.id AND p.param_key = 'cash_fund_code'
        LIMIT 1
      ), '') AS cash_fund_code,
      COALESCE((
        SELECT NULLIF(btrim(p.param_value), '')
        FROM logic_params p WHERE p.logic_id = l.id AND p.param_key = 'timeframe'
        LIMIT 1
      ), 'M15') AS timeframe
    FROM logics l
    LEFT JOIN accounts a ON a.id = l.account_id
    WHERE l.id = $1
    `,
    [run.logic_id]
  );
  const logic = logicRows[0];
  if (!logic) return null;

  const { rows: trades } = await pool.query(
    `${LOGIC_TRADE_SELECT_TEST_PANEL}
    WHERE lt.logic_id = $2
      AND lt.is_test = TRUE
      AND COALESCE(lt.opt_lane, '') = ''
      AND (
        lt.run_id = $3
        OR NOT EXISTS (
          -- #856: сделки ряда прогонов переиспользуют один финальный run_id логики
          -- (champion book), отдельного набора под собственным run_id нет.
          SELECT 1 FROM logic_trades l2
          WHERE l2.logic_id = lt.logic_id AND l2.run_id = $3
        )
      )
    ORDER BY lt.bar_dt ASC NULLS LAST, lt.executed_at ASC, lt.id ASC
    LIMIT 50000`,
    [run.logic_id, run.logic_id, runId]
  );

  const tradeIds = trades.map((t) => Number(t.id)).filter((id) => id > 0);
  /** @type {Map<number, object[]>} */
  const tradeLots = new Map();
  if (tradeIds.length > 0) {
    const { rows: lotRows } = await pool.query(
      `
      SELECT
        l.close_trade_id,
        to_char(ot.executed_at, 'YYYY-MM-DD HH24:MI:SS') AS open_executed_at,
        to_char(ot.bar_dt, 'YYYY-MM-DD HH24:MI:SS') AS open_bar_dt,
        ot.price::float8 AS open_price
      FROM logic_trade_lots l
      LEFT JOIN logic_trades ot ON ot.id = l.open_trade_id
      WHERE l.logic_id = $1
        AND l.close_trade_id = ANY($2::bigint[])
      `,
      [run.logic_id, tradeIds]
    );
    for (const row of lotRows) {
      const cid = Number(row.close_trade_id);
      if (!tradeLots.has(cid)) tradeLots.set(cid, []);
      tradeLots.get(cid).push(row);
    }
  }

  let paramHistory = [];
  try {
    const { rows: histRows } = await pool.query(
      `SELECT logic_opt_param_history_for_report($1, $2) AS h`,
      [run.logic_id, runId]
    );
    const raw = histRows[0]?.h;
    if (Array.isArray(raw)) paramHistory = raw;
    else if (raw && typeof raw === 'object') paramHistory = [raw];
  } catch (err) {
    console.warn('opt param history for report', err?.message || err);
  }

  let signalIndicatorIds = [];
  if (!isSnapshot) {
    try {
      const { rows: sigs } = await pool.query(
        `SELECT DISTINCT indicator_id FROM logic_indicator_signals WHERE logic_id = $1`,
        [run.logic_id]
      );
      signalIndicatorIds = sigs
        .map((s) => Number(s.indicator_id))
        .filter((n) => n > 0);
    } catch (err) {
      console.warn('signal indicators for report', err?.message || err);
    }
  }

  let paperCharts = [];
  if (!isSnapshot) {
    try {
      // #856: если сделки прогона — из champion book другого run_id, окно блоков берём из сделок.
      let chartFrom = run.date_from;
      let chartTo = run.date_to;
      const usesChampionBook =
        trades.length > 0 &&
        trades.some((t) => Number(t.run_id) !== Number(runId));
      if (usesChampionBook) {
        chartFrom = trades[0].bar_dt || trades[0].executed_at;
        chartTo =
          trades[trades.length - 1].bar_dt || trades[trades.length - 1].executed_at;
      }
      paperCharts = await buildPaperChartsForRun(pool, {
        run: { ...run, date_from: chartFrom, date_to: chartTo },
        trades,
        tradeLots,
        signalIndicatorIds,
      });
    } catch (err) {
      console.warn('paper charts for report', runId, err?.message || err);
    }
  }

  const model = buildBacktestReportModel(logic, trades, {
    backtestRun: run,
    tradeLots,
    paramHistory,
    paperCharts,
  });
  const html = renderBacktestReportHtml(model);
  const downloadName = buildBacktestReportDownloadName(model);
  const summary = {
    generatedAt: model.generatedAt,
    runStatus: model.runStatus,
    progressPct: model.progressPct,
    dealCount: model.dealCount,
    all: model.all,
    long: model.long,
    short: model.short,
    params: model.params,
    paramHistory,
    isSnapshot,
    processed_bars: run.processed_bars,
    total_bars: run.total_bars,
  };

  const { rows: upserted } = await pool.query(
    `
    INSERT INTO logic_backtest_reports (
      run_id, logic_id, logic_name, date_from, date_to, timeframe,
      run_status, is_snapshot, deal_count, net_pnl, net_pnl_pct,
      profit_factor, max_drawdown_pct, download_name, summary, html_body,
      created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4::date, $5::date, $6,
      $7, $8, $9, $10, $11,
      $12, $13, $14, $15::jsonb, $16,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT (run_id) DO UPDATE SET
      logic_id = EXCLUDED.logic_id,
      logic_name = EXCLUDED.logic_name,
      date_from = EXCLUDED.date_from,
      date_to = EXCLUDED.date_to,
      timeframe = EXCLUDED.timeframe,
      run_status = EXCLUDED.run_status,
      is_snapshot = EXCLUDED.is_snapshot,
      deal_count = EXCLUDED.deal_count,
      net_pnl = EXCLUDED.net_pnl,
      net_pnl_pct = EXCLUDED.net_pnl_pct,
      profit_factor = EXCLUDED.profit_factor,
      max_drawdown_pct = EXCLUDED.max_drawdown_pct,
      download_name = EXCLUDED.download_name,
      summary = EXCLUDED.summary,
      html_body = EXCLUDED.html_body,
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, run_id, updated_at
    `,
    [
      runId,
      run.logic_id,
      model.logicName,
      model.dateFrom || null,
      model.dateTo || null,
      model.params.timeframe,
      model.runStatus,
      isSnapshot,
      model.dealCount,
      model.all.netPnl,
      model.all.netPnlPct,
      model.all.profitFactor || null,
      model.all.maxDrawdownPct,
      downloadName,
      JSON.stringify(summary),
      html,
    ]
  );

  return upserted[0] ?? null;
}

async function listBacktestReports(pool, { limit = 50, offset = 0, logicId = null } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  const params = [];
  let where = '';
  if (logicId != null && Number.isInteger(Number(logicId)) && Number(logicId) > 0) {
    params.push(Number(logicId));
    where = `WHERE r.logic_id = $${params.length}`;
  }
  params.push(lim, off);
  const { rows } = await pool.query(
    `
    SELECT
      r.id, r.run_id, r.logic_id, r.logic_name,
      r.date_from::text AS date_from,
      r.date_to::text AS date_to,
      r.timeframe, r.run_status, r.is_snapshot,
      r.deal_count,
      r.net_pnl::float8 AS net_pnl,
      r.net_pnl_pct::float8 AS net_pnl_pct,
      r.profit_factor::float8 AS profit_factor,
      r.max_drawdown_pct::float8 AS max_drawdown_pct,
      r.download_name,
      r.created_at, r.updated_at
    FROM logic_backtest_reports r
    ${where}
    ORDER BY r.updated_at DESC, r.id DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params
  );
  return rows;
}

async function getBacktestReport(pool, reportId) {
  const id = Number(reportId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const { rows } = await pool.query(
    `
    SELECT
      r.id, r.run_id, r.logic_id, r.logic_name,
      r.date_from::text AS date_from,
      r.date_to::text AS date_to,
      r.timeframe, r.run_status, r.is_snapshot,
      r.deal_count,
      r.net_pnl::float8 AS net_pnl,
      r.net_pnl_pct::float8 AS net_pnl_pct,
      r.profit_factor::float8 AS profit_factor,
      r.max_drawdown_pct::float8 AS max_drawdown_pct,
      r.download_name, r.summary, r.html_body,
      r.created_at, r.updated_at
    FROM logic_backtest_reports r
    WHERE r.id = $1
    `,
    [id]
  );
  return rows[0] ?? null;
}

async function getBacktestReportNeighbors(pool, reportId) {
  const current = await getBacktestReport(pool, reportId);
  if (!current) return null;
  const { rows: newer } = await pool.query(
    `
    SELECT id FROM logic_backtest_reports
    WHERE (updated_at, id) > ($1::timestamp, $2::bigint)
    ORDER BY updated_at ASC, id ASC
    LIMIT 1
    `,
    [current.updated_at, current.id]
  );
  const { rows: older } = await pool.query(
    `
    SELECT id FROM logic_backtest_reports
    WHERE (updated_at, id) < ($1::timestamp, $2::bigint)
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
    `,
    [current.updated_at, current.id]
  );
  return {
    current,
    prev_id: older[0]?.id ?? null,
    next_id: newer[0]?.id ?? null,
  };
}

module.exports = {
  schedulePersistBacktestReport,
  persistBacktestReport,
  listBacktestReports,
  getBacktestReport,
  getBacktestReportNeighbors,
};
