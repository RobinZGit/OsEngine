'use strict';

const RUNNER_INTERVAL_MS = Number(process.env.TRADE_RUNNER_INTERVAL_MS) || 15000;
const STALE_MS = Number(process.env.TRADE_RUNNER_STALE_MS) || 90000;
const MAX_CYCLE_MS = Number(process.env.TRADE_RUNNER_MAX_CYCLE_MS) || 180000;
const LOGIC_TIMEOUT_MS = Number(process.env.TRADE_RUNNER_LOGIC_TIMEOUT_MS) || 120000;
const WATCHDOG_MS = Number(process.env.TRADE_WATCHDOG_MS) || 30000;

const { writeTechLogEvent } = require('./lib/tech-log');
const { isUiSessionActive } = require('./lib/trade-runner-session');

const TRADE_CYCLE_LOCK_KEY = 'multilogictrade_run_trade_cycle';

let running = false;
let cycleStartedAt = 0;
/** @type {number} */
let lastOkAtMs = 0;
/** @type {string} */
let lastSkipReason = '';
/** @type {object|null} */
let lastCycleOut = null;
let watchdogRunning = false;

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

async function touchLastOkDb(poolOrClient, source) {
  try {
    await poolOrClient.query(`CALL touch_trade_runner_last_ok($1)`, [source || 'node']);
  } catch (e) {
    // Still mark in-memory so UI does not stay red while cycles run.
    console.error('touch_trade_runner_last_ok failed:', e.message || e);
  }
  lastOkAtMs = Date.now();
}

async function kickStuckDb(poolOrClient) {
  try {
    const { rows } = await poolOrClient.query(
      `SELECT trade_runner_kick_stuck($1) AS r`,
      [Math.max(30, Math.floor(MAX_CYCLE_MS / 1000))]
    );
    return rows[0]?.r || { killed: 0 };
  } catch (_e) {
    try {
      await poolOrClient.query(`SELECT pg_advisory_unlock(hashtext($1))`, [TRADE_CYCLE_LOCK_KEY]);
    } catch (_e2) {
      /* ignore */
    }
    return { killed: 0, unlocked: false, fallback: true };
  }
}

function forceResetBusy(reason) {
  if (!running) return false;
  const age = cycleStartedAt ? Date.now() - cycleStartedAt : 0;
  console.warn(
    `Trade runner force-reset busy flag (${reason}); was running ${Math.round(age / 1000)}s`
  );
  running = false;
  cycleStartedAt = 0;
  return true;
}

/**
 * Цикл сделок: по одной логике за autocommit-запрос.
 * TRADE_RUNNER_ENABLED=0 — отключить fallback.
 * По умолчанию UI не нужен; TRADE_RUNNER_REQUIRE_UI=1 — только при heartbeat Angular.
 */
async function runTradeCycle(pool, opts = {}) {
  if (running) {
    const age = cycleStartedAt ? Date.now() - cycleStartedAt : 0;
    if (age > MAX_CYCLE_MS || opts.force) {
      forceResetBusy(opts.force ? 'watchdog_force' : 'max_cycle');
      await kickStuckDb(pool);
    } else {
      lastSkipReason = 'node_busy';
      return { skipped: true, reason: 'node_busy', busy_age_ms: age };
    }
  }
  running = true;
  cycleStartedAt = Date.now();
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
      lastSkipReason = 'ui_inactive';
      return { skipped: true, reason: 'ui_inactive', require_ui: true };
    }

    const { rows: lockRows } = await client.query(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS ok`,
      [TRADE_CYCLE_LOCK_KEY]
    );
    if (!lockRows[0]?.ok) {
      lastSkipReason = 'locked';
      return { skipped: true, reason: 'locked' };
    }
    locked = true;

    if (
      !opts.manual &&
      requireUi &&
      !(await isUiSessionActiveDb(client)) &&
      !isUiSessionActive()
    ) {
      lastSkipReason = 'ui_inactive';
      return { skipped: true, reason: 'ui_inactive', require_ui: true };
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
    let logicErrors = 0;

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
      try {
        await client.query(`SET statement_timeout = ${Math.max(15000, LOGIC_TIMEOUT_MS)}`);
        await client.query(`SET lock_timeout = '15s'`);

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
        // Pulse while long multi-logic cycles run — UI stays green.
        await touchLastOkDb(client, 'node-logic');
      } catch (logicErr) {
        logicErrors += 1;
        console.error(`Trade runner logic=${row.id}`, logicErr.message);
        try {
          await client.query('SET statement_timeout = 0');
        } catch (_e) {
          /* ignore */
        }
      }
    }

    try {
      await client.query('SET statement_timeout = 0');
      await client.query('SET lock_timeout = 0');
    } catch (_e) {
      /* ignore */
    }

    const out = {
      processed,
      stops,
      created,
      skipped_backtest: skippedBacktest,
      logic_errors: logicErrors,
      at: new Date().toISOString(),
      source: 'node',
      require_ui: requireUi,
    };
    lastCycleOut = out;
    lastSkipReason = '';

    if (processed === 0 && skippedBacktest > 0 && enabledN > 0) {
      await touchLastOkDb(client, 'node-backtest-skip');
      await writeTechLogEvent(pool, {
        threadKey: 'trade-runner',
        operation: 'cycle.skip',
        message: `Бой пропущен: все ${skippedBacktest} логик в бэктесте`,
        source: 'node',
        payload: out,
      }).catch(() => {});
      return { skipped: true, reason: 'all_in_backtest', ...out };
    }

    await touchLastOkDb(client, opts.force ? 'node-watchdog' : 'node');
    await writeTechLogEvent(pool, {
      threadKey: 'trade-runner',
      operation: 'cycle.node',
      message: `Node cycle: processed=${processed} stops=${stops} created=${created} skip_bt=${skippedBacktest} err=${logicErrors}`,
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
    cycleStartedAt = 0;
  }
}

async function getTradeRunnerHealth(pool) {
  let dbHealth = null;
  try {
    const { rows } = await pool.query(`SELECT trade_runner_health() AS h`);
    dbHealth = rows[0]?.h || null;
  } catch (_e) {
    dbHealth = null;
  }

  const enabledFromDb = Number(dbHealth?.enabled_count ?? 0);
  const ageMs = lastOkAtMs > 0 ? Date.now() - lastOkAtMs : null;
  const nodeFresh = lastOkAtMs > 0 && ageMs != null && ageMs <= STALE_MS;
  const nodeStale =
    enabledFromDb > 0 && (lastOkAtMs <= 0 || (ageMs != null && ageMs > STALE_MS));
  const busyAge = running && cycleStartedAt ? Date.now() - cycleStartedAt : 0;
  const busyStuck = running && busyAge > MAX_CYCLE_MS;
  const requireUi = Boolean(dbHealth?.require_ui);
  const uiActive = Boolean(dbHealth?.ui_active) || isUiSessionActive();

  let status = dbHealth?.status || (enabledFromDb > 0 ? 'stale' : 'idle');
  if (busyStuck) {
    status = 'stale';
  } else if (running) {
    // Cycle in progress — do not paint UI red while work is happening.
    status = 'ok';
  } else if (status === 'stale' && nodeFresh) {
    // DB LAST_OK may lag / CALL failed; Node pulse is authoritative.
    status = 'ok';
  } else if (status === 'ui_required' && (!requireUi || uiActive) && nodeFresh) {
    status = 'ok';
  } else if (!dbHealth && nodeStale) {
    status = 'stale';
  } else if (!dbHealth && enabledFromDb <= 0 && lastOkAtMs > 0) {
    status = 'idle';
  } else if (!dbHealth && !nodeStale && enabledFromDb > 0) {
    status = 'ok';
  }

  const logics = Array.isArray(dbHealth?.logics) ? dbHealth.logics : [];
  const logicStates = {};
  for (const row of logics) {
    const id = Number(row.id);
    if (!Number.isFinite(id)) continue;
    // Keep per-logic stale from DB only — do not force all red when global LAST_OK lags.
    logicStates[id] = {
      stale: Boolean(row.stale),
      last_trade_check_at: row.last_trade_check_at || null,
      account_type: row.account_type || null,
      name: row.name || null,
    };
  }

  return {
    status,
    ok: status === 'ok' || status === 'idle',
    stale: status === 'stale' || status === 'ui_required',
    last_ok_at: dbHealth?.last_ok_at || (lastOkAtMs ? new Date(lastOkAtMs).toISOString() : null),
    age_sec: dbHealth?.age_sec != null ? Number(dbHealth.age_sec) : ageMs != null ? ageMs / 1000 : null,
    stale_sec: Number(dbHealth?.stale_sec ?? STALE_MS / 1000),
    enabled_count: enabledFromDb,
    require_ui: requireUi,
    ui_active: uiActive,
    node_running: running,
    node_busy_age_ms: busyAge,
    node_last_skip: lastSkipReason || null,
    last_cycle: lastCycleOut,
    logics: logicStates,
    at: new Date().toISOString(),
  };
}

async function runWatchdogTick(pool, opts = {}) {
  if (watchdogRunning) return { skipped: true, reason: 'watchdog_busy' };
  watchdogRunning = true;
  try {
    const health = await getTradeRunnerHealth(pool);
    if (health.enabled_count <= 0) {
      return { ok: true, action: 'none', health };
    }
    if (health.status === 'ui_required') {
      return { ok: true, action: 'wait_ui', health };
    }

    const needRaise =
      opts.force ||
      health.stale ||
      health.status === 'stale' ||
      (running && cycleStartedAt && Date.now() - cycleStartedAt > MAX_CYCLE_MS);

    if (!needRaise) {
      return { ok: true, action: 'none', health };
    }

    console.warn(
      `Trade watchdog: raising (status=${health.status} age=${health.age_sec}s busy=${health.node_busy_age_ms}ms)`
    );
    await kickStuckDb(pool);
    forceResetBusy('watchdog_tick');
    // Node — основной подъём (Windows без pg_cron). PG cron watchdog — запасной, если API мёртв.
    const cycle = await runTradeCycle(pool, { force: true });

    await writeTechLogEvent(pool, {
      threadKey: 'trade-runner',
      operation: 'watchdog.raise',
      message: `Watchdog raise: status was ${health.status}`,
      source: 'node',
      payload: { before: health, cycle },
    }).catch(() => {});

    const after = await getTradeRunnerHealth(pool);
    return { ok: true, action: 'raised', cycle, health: after };
  } finally {
    watchdogRunning = false;
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
  console.log(
    `Trade watchdog: every ${WATCHDOG_MS}ms; stale>${STALE_MS}ms; max cycle ${MAX_CYCLE_MS}ms; logic timeout ${LOGIC_TIMEOUT_MS}ms`
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
          `Trade cycle: processed=${out.processed} stops=${out.stops} created=${out.created} skip_bt=${out.skipped_backtest}` +
            (out.logic_errors ? ` err=${out.logic_errors}` : '')
        );
      })
      .catch((err) => {
        console.error('Trade runner cycle error', err.message);
        forceResetBusy('cycle_error');
      });
  }, RUNNER_INTERVAL_MS);

  setInterval(() => {
    runWatchdogTick(pool)
      .then((out) => {
        if (!out || out.action === 'none' || out.action === 'wait_ui') return;
        console.log(`Trade watchdog: action=${out.action}`);
      })
      .catch((err) => {
        console.error('Trade watchdog error', err.message);
        watchdogRunning = false;
      });
  }, WATCHDOG_MS);

  // First health pulse shortly after listen (so UI is not red for 90s on fresh start).
  setTimeout(() => {
    runTradeCycle(pool).catch(() => {});
  }, 3000);
}

module.exports = {
  runTradeCycle,
  startTradeRunner,
  getTradeRunnerHealth,
  runWatchdogTick,
  STALE_MS,
  MAX_CYCLE_MS,
};
