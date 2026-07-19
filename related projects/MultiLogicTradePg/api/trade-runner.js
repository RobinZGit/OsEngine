'use strict';

const RUNNER_INTERVAL_MS = Number(process.env.TRADE_RUNNER_INTERVAL_MS) || 15000;
const { writeTechLogEvent } = require('./lib/tech-log');
const { isUiSessionActive } = require('./lib/trade-runner-session');

let running = false;

/**
 * Live robot (тонкая оболочка): только планировщик + UI heartbeat.
 * Торговый мозг — SQL run_trade_cycle() (stops → trades → park, advisory lock внутри).
 * TRADE_RUNNER_ENABLED=0 — отключить.
 */
async function hasActiveBacktest(pool) {
  try {
    const { rows } = await pool.query(
      `
      SELECT 1
      FROM logic_backtest_runs
      WHERE status IN ('pending', 'loading_prices', 'loading_indicators', 'running')
      LIMIT 1
      `
    );
    return rows.length > 0;
  } catch (_e) {
    return false;
  }
}

async function runTradeCycle(pool, opts = {}) {
  if (running) return { skipped: true, reason: 'node_busy' };
  if (!opts.manual && !isUiSessionActive()) {
    return { skipped: true, reason: 'ui_inactive' };
  }
  running = true;
  try {
    if (!opts.manual && !(await isUiSessionActiveDb(pool))) {
      return { skipped: true, reason: 'ui_inactive' };
    }
    // Пока идёт тест — не держим logic_trades (DELETE очистки / SQL-прогон ждут лок).
    if (!opts.manual && (await hasActiveBacktest(pool))) {
      return { skipped: true, reason: 'backtest_active' };
    }

    const { rows } = await pool.query(`SELECT run_trade_cycle() AS result`);
    const result = rows[0]?.result || {};
    const out = {
      ...result,
      at: new Date().toISOString(),
      source: 'sql',
    };

    if (result.skipped) {
      return out;
    }

    await writeTechLogEvent(pool, {
      threadKey: 'trade-runner',
      operation: 'cycle.sql',
      message: `SQL cycle: processed=${result.processed ?? 0} stops=${result.stops ?? 0} created=${result.created ?? 0} skip_bt=${result.skipped_backtest ?? 0}`,
      source: 'node',
      payload: out,
    }).catch(() => {});

    return out;
  } finally {
    running = false;
  }
}

async function isUiSessionActiveDb(poolOrClient) {
  try {
    const { rows } = await poolOrClient.query(`SELECT trade_runner_ui_is_active() AS ok`);
    return Boolean(rows[0]?.ok);
  } catch (_e) {
    return isUiSessionActive();
  }
}

function startTradeRunner(pool) {
  const enabled = process.env.TRADE_RUNNER_ENABLED !== '0';
  if (!enabled) {
    console.log(
      'Trade runner: disabled (TRADE_RUNNER_ENABLED=0, use pg_cron or POST /api/logic-trades/run)'
    );
    return;
  }

  console.log(
    `Trade runner (SQL robot): every ${RUNNER_INTERVAL_MS}ms when UI is open → SELECT run_trade_cycle()`
  );

  setInterval(() => {
    if (!isUiSessionActive()) return;
    runTradeCycle(pool).catch((err) => {
      console.error('Trade runner cycle error', err.message);
    });
  }, RUNNER_INTERVAL_MS);
}

module.exports = {
  runTradeCycle,
  startTradeRunner,
};
