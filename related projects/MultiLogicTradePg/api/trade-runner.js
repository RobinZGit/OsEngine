'use strict';

const RUNNER_INTERVAL_MS = Number(process.env.TRADE_RUNNER_INTERVAL_MS) || 15000;
const { writeTechLogEvent } = require('./lib/tech-log');
const { isUiSessionActive } = require('./lib/trade-runner-session');

const TRADE_CYCLE_LOCK_KEY = 'multilogictrade_run_trade_cycle';

let running = false;

/**
 * Цикл сделок: по одной логике за autocommit-запрос (не держим lock logic_params
 * на весь прогон всех логик). Логики с активным бэктестом пропускаются.
 * TRADE_RUNNER_ENABLED=0 — отключить fallback.
 * Автозапуск только при активной сессии Angular (heartbeat).
 */
async function runTradeCycle(pool, opts = {}) {
  if (running) return { skipped: true, reason: 'node_busy' };
  if (!opts.manual && !isUiSessionActive()) {
    return { skipped: true, reason: 'ui_inactive' };
  }
  running = true;
  const client = await pool.connect();
  let locked = false;
  try {
    const { rows: lockRows } = await client.query(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS ok`,
      [TRADE_CYCLE_LOCK_KEY]
    );
    if (!lockRows[0]?.ok) {
      return { skipped: true, reason: 'locked' };
    }
    locked = true;

    if (!opts.manual && !(await isUiSessionActiveDb(client))) {
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
      // Каждый SELECT — своя транзакция: locks logic_params/prices отпускаются сразу.
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

async function isUiSessionActiveDb(client) {
  try {
    const { rows } = await client.query(`SELECT trade_runner_ui_is_active() AS ok`);
    return Boolean(rows[0]?.ok);
  } catch (_e) {
    return isUiSessionActive();
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

  console.log(
    `Trade runner fallback: every ${RUNNER_INTERVAL_MS}ms when UI is open; per-logic commit; skip logics in backtest`
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
