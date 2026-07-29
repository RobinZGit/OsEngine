'use strict';

const RUNNER_INTERVAL_MS = Number(process.env.TRADE_RUNNER_INTERVAL_MS) || 15000;
const { writeTechLogEvent } = require('./lib/tech-log');
const { isUiSessionActive } = require('./lib/trade-runner-session');

const TRADE_CYCLE_LOCK_KEY = 'multilogictrade_run_trade_cycle';

let running = false;

/**
 * Env TRADE_RUNNER_REQUIRE_UI=1|0 overrides DB APP_TRADE_RUNNER_REQUIRE_UI.
 * Default (unset / DB 0): headless — cycles run while API is up (server / after install-over).
 */
function requireUiFromEnv() {
  const v = process.env.TRADE_RUNNER_REQUIRE_UI;
  if (v === undefined || v === '') return null;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return null;
}

async function isTradeRunnerUiRequired(client) {
  const env = requireUiFromEnv();
  if (env !== null) return env;
  try {
    const { rows } = await client.query(`SELECT trade_runner_require_ui() AS ok`);
    return Boolean(rows[0]?.ok);
  } catch (_e) {
    return false;
  }
}

async function isUiSessionActiveDb(client) {
  try {
    const { rows } = await client.query(`SELECT trade_runner_ui_is_active() AS ok`);
    return Boolean(rows[0]?.ok);
  } catch (_e) {
    return isUiSessionActive();
  }
}

/**
 * Цикл сделок: по одной логике за autocommit-запрос.
 * TRADE_RUNNER_ENABLED=0 — отключить fallback.
 * По умолчанию UI не нужен; TRADE_RUNNER_REQUIRE_UI=1 — только при heartbeat Angular.
 */
async function runTradeCycle(pool, opts = {}) {
  if (running) return { skipped: true, reason: 'node_busy' };
  running = true;
  const client = await pool.connect();
  let locked = false;
  try {
    const requireUi = await isTradeRunnerUiRequired(client);
    if (
      !opts.manual &&
      requireUi &&
      !isUiSessionActive() &&
      !(await isUiSessionActiveDb(client))
    ) {
      return { skipped: true, reason: 'ui_inactive' };
    }

    const { rows: lockRows } = await client.query(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS ok`,
      [TRADE_CYCLE_LOCK_KEY]
    );
    if (!lockRows[0]?.ok) {
      return { skipped: true, reason: 'locked' };
    }
    locked = true;

    if (
      !opts.manual &&
      requireUi &&
      !(await isUiSessionActiveDb(client)) &&
      !isUiSessionActive()
    ) {
      return { skipped: true, reason: 'ui_inactive' };
    }

    const { rows: logics } = await client.query(
      `
      SELECT l.id
      FROM logics l
      JOIN accounts a ON a.id = l.account_id
      WHERE l.is_enabled = TRUE
        AND a.is_active = TRUE
        AND NOT EXISTS (
          SELECT 1
          FROM logic_backtest_runs r
          WHERE r.logic_id = l.id
            AND r.status = ANY($1::text[])
        )
      ORDER BY l.id
      `,
      [['pending', 'loading_prices', 'loading_indicators', 'running']]
    );

    let processed = 0;
    let created = 0;
    let stops = 0;
    let skippedBacktest = 0;

    const { rows: enabledCountRows } = await client.query(
      `
      SELECT COUNT(*)::int AS n
      FROM logics l
      JOIN accounts a ON a.id = l.account_id
      WHERE l.is_enabled = TRUE AND a.is_active = TRUE
      `
    );
    const enabledN = enabledCountRows[0]?.n ?? 0;
    skippedBacktest = Math.max(0, enabledN - logics.length);

    for (const row of logics) {
      const { rows: stopRows } = await client.query(
        `SELECT process_logic_stops($1)::int AS n`,
        [row.id]
      );
      stops += Number(stopRows[0]?.n ?? 0);

      const { rows: tradeRows } = await client.query(
        `SELECT process_logic_trades($1)::int AS n`,
        [row.id]
      );
      created += Number(tradeRows[0]?.n ?? 0);
      try {
        await client.query(`SELECT logic_park_excess_cash($1)`, [row.id]);
      } catch (parkErr) {
        console.error(`cash fund park logic=${row.id}`, parkErr.message);
      }
      processed += 1;
    }

    const out = {
      processed,
      stops,
      created,
      skipped_backtest: skippedBacktest,
      at: new Date().toISOString(),
      source: 'node',
      require_ui: requireUi,
    };

    if (processed === 0 && skippedBacktest > 0) {
      await writeTechLogEvent(pool, {
        threadKey: 'trade-runner',
        operation: 'cycle.skip',
        message: `Бой пропущен: все ${skippedBacktest} логик в бэктесте`,
        source: 'node',
        payload: out,
      }).catch(() => {});
      return { skipped: true, reason: 'all_in_backtest', ...out };
    }

    await writeTechLogEvent(pool, {
      threadKey: 'trade-runner',
      operation: 'cycle.node',
      message: `Node cycle: processed=${processed} stops=${stops} created=${created} skip_bt=${skippedBacktest}`,
      source: 'node',
      payload: out,
    }).catch(() => {});
    return out;
  } finally {
    if (locked) {
      try {
        await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [TRADE_CYCLE_LOCK_KEY]);
      } catch (_e) {
        /* ignore */
      }
    }
    client.release();
    running = false;
  }
}

function startTradeRunner(pool) {
  const enabled = process.env.TRADE_RUNNER_ENABLED !== '0';
  if (!enabled) {
    console.log(
      'Trade runner fallback: disabled (TRADE_RUNNER_ENABLED=0, use pg_cron or POST /api/logic-trades/run)'
    );
    return;
  }

  const envGate = requireUiFromEnv();
  const mode =
    envGate === true
      ? 'UI required (env)'
      : envGate === false
        ? 'headless (env)'
        : 'headless by default (DB APP_TRADE_RUNNER_REQUIRE_UI)';
  console.log(
    `Trade runner fallback: every ${RUNNER_INTERVAL_MS}ms; ${mode}; per-logic commit; skip logics in backtest`
  );

  setInterval(() => {
    runTradeCycle(pool)
      .then((out) => {
        if (!out) return;
        if (out.skipped) {
          if (out.reason === 'ui_inactive' || out.reason === 'node_busy') return;
          console.log(
            `Trade cycle skip: ${out.reason}` +
              (out.processed != null ? ` (processed=${out.processed})` : '')
          );
          return;
        }
        console.log(
          `Trade cycle: processed=${out.processed} stops=${out.stops} created=${out.created} skip_bt=${out.skipped_backtest}`
        );
      })
      .catch((err) => {
        console.error('Trade runner cycle error', err.message);
      });
  }, RUNNER_INTERVAL_MS);
}

module.exports = {
  runTradeCycle,
  startTradeRunner,
};
