'use strict';

const RUNNER_INTERVAL_MS = Number(process.env.TRADE_RUNNER_INTERVAL_MS) || 15000;
const STALE_MS = Number(process.env.TRADE_RUNNER_STALE_MS) || 90000;
const MAX_CYCLE_MS = Number(process.env.TRADE_RUNNER_MAX_CYCLE_MS) || 180000;
const LOGIC_TIMEOUT_MS = Number(process.env.TRADE_RUNNER_LOGIC_TIMEOUT_MS) || 120000;
const SIGNAL_TIMEOUT_MS = Number(process.env.TRADE_RUNNER_SIGNAL_TIMEOUT_MS) || 300000;
const WATCHDOG_MS = Number(process.env.TRADE_WATCHDOG_MS) || 30000;

const { writeTechLogEvent } = require('./lib/tech-log');
const { writeErrorLog } = require('./lib/error-log');
const { isUiSessionActive } = require('./lib/trade-runner-session');
const { decorate } = require('./lib/error-codes');
const { pokeTerminalStopWatch } = require('./lib/terminal-stop-watch');
const { tbankHttpPost, DEFAULT_API: TBANK_DEFAULT_API } = require('./lib/tbank-invest-client');

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
    console.error('touch_trade_runner_last_ok failed:', decorate(e.message || e));
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
 * #984: живые последние цены T-Bank для незакрытых подтверждений типа сигнала (#972).
 * Один HTTP-запрос MarketDataService/GetLastPrices на все бумаги; возвращает
 * { "<security_id>": price, ... } для передачи в logic_signal_confirm_finalize(p_live_prices).
 * При ошибке/отсутствии токена возвращает {} — финализатор откатится на свечу.
 */
async function fetchLivePricesForSecurities(pool, securityIds) {
  const ids = [...new Set((securityIds || []).map((x) => Number(x)).filter((x) => x > 0))];
  if (ids.length === 0) return {};
  const { rows: prefixRows } = await pool.query(
    `SELECT sp.security_id, NULLIF(btrim(COALESCE(sp.tbank_figi, '')), '') AS figi
     FROM security_prefixes sp
     WHERE sp.security_id = ANY($1::int[])`,
    [ids]
  );
  const figis = [
    ...new Set(prefixRows.map((r) => r.figi).filter((f) => f && String(f) !== '0')),
  ];
  if (figis.length === 0) return {};
  const token = (await pool.query('SELECT get_tbank_token() AS t')).rows[0]?.t;
  if (!token) return {};
  const { rows: brokerRows } = await pool.query(
    `SELECT NULLIF(btrim(COALESCE(api_url, '')), '') AS u
     FROM brokers WHERE code = 'T-BANK' LIMIT 1`
  );
  const apiUrl = brokerRows[0]?.u || TBANK_DEFAULT_API;
  const data = await tbankHttpPost(
    apiUrl,
    'tinkoff.public.invest.api.contract.v1.MarketDataService/GetLastPrices',
    token,
    { figi: figis }
  );
  const byFigi = new Map();
  for (const q of Array.isArray(data?.lastPrices) ? data.lastPrices : []) {
    const figi = String(q?.figi || q?.instrumentUid || '').trim();
    const price = Number(q?.price?.units ?? 0) + Number(q?.price?.nano ?? 0) / 1e9;
    if (figi && price > 0) byFigi.set(figi, price);
  }
  const out = {};
  for (const r of prefixRows) {
    const price = r.figi ? byFigi.get(r.figi) : null;
    if (price > 0) out[String(r.security_id)] = price;
  }
  return out;
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
      SELECT l.id, l.is_enabled, COALESCE(l.use_as_terminal_signal, FALSE) AS use_sig
      FROM logics l
      JOIN accounts a ON a.id = l.account_id
      WHERE (l.is_enabled = TRUE OR COALESCE(l.use_as_terminal_signal, FALSE))
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
    let signals = 0;
    let skippedBacktest = 0;
    let logicErrors = 0;

    const { rows: enabledCountRows } = await client.query(
      `
      SELECT COUNT(*)::int AS n
      FROM logics l
      JOIN accounts a ON a.id = l.account_id
      WHERE (l.is_enabled = TRUE OR COALESCE(l.use_as_terminal_signal, FALSE))
        AND a.is_active = TRUE
      `
    );
    const enabledN = enabledCountRows[0]?.n ?? 0;
    skippedBacktest = Math.max(0, enabledN - logics.length);

    for (const row of logics) {
      try {
        await client.query(`SET statement_timeout = ${Math.max(15000, LOGIC_TIMEOUT_MS)}`);
        await client.query(`SET lock_timeout = '15s'`);

        if (row.is_enabled) {
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
            console.error(`cash fund park logic=${row.id}`, decorate(parkErr.message));
          }
        }
        if (row.use_sig) {
          await client.query(`SET statement_timeout = ${Math.max(15000, SIGNAL_TIMEOUT_MS)}`);
          const { rows: signalRows } = await client.query(
            `SELECT process_logic_terminal_signals($1)::int AS n`,
            [row.id]
          );
          signals += Number(signalRows[0]?.n ?? 0);
        }
        processed += 1;
        // Pulse while long multi-logic cycles run — UI stays green.
        await touchLastOkDb(client, 'node-logic');
      } catch (logicErr) {
        logicErrors += 1;
        console.error(`Trade runner logic=${row.id}`, decorate(logicErr.message));
        try {
          await client.query('SET statement_timeout = 0');
        } catch (_e) {
          /* ignore */
        }
      }
    }

    // #994-доработка: пристраиваем фоновый пересчёт рейтинга индикаторов к
    // отработавшим логикам (юниверс — их пары). Не блокирует цикл (см. хелпер).
    scheduleIndicatorRatingForLogics(pool, logics.map((r) => r.id));
    // #994-доработка: если активных/сигнальных логик нет — полный прогон по
    // бумагам с недавними свечами (любой активный ТФ), чтобы рейтинг обновлялся
    // всегда. Троттл по времени внутри run_indicator_rating_test_safe.
    if (logics.length === 0) scheduleIndicatorRatingIdle(pool);

    // #972/#984: финализируем созревшие отложенные подтверждения сигналов — сверяем
    // направление с ЖИВОЙ ценой T-Bank (не со свечой стоп-ТФ, которая у логик не
    // обновляется). Вызов на уровне цикла — срабатывает и при нуле active-логик.
    try {
      await client.query(`SET statement_timeout = ${Math.max(15000, LOGIC_TIMEOUT_MS)}`);
      await client.query(`SET lock_timeout = '15s'`);
      let livePrices = null;
      try {
        const { rows: pendRows } = await client.query(
          `SELECT DISTINCT security_id
           FROM logic_signal_confirm_pending
           WHERE status = 'pending' AND deadline <= CURRENT_TIMESTAMP`
        );
        if (pendRows.length > 0) {
          livePrices = await fetchLivePricesForSecurities(
            pool,
            pendRows.map((r) => r.security_id)
          );
        }
      } catch (priceErr) {
        livePrices = null;
        console.error('confirm live prices', decorate(priceErr.message));
      }
      const liveArg =
        livePrices && Object.keys(livePrices).length > 0 ? JSON.stringify(livePrices) : null;
      const { rows: confirmRows } = await client.query(
        `SELECT logic_signal_confirm_finalize($1::jsonb)::int AS n`,
        [liveArg]
      );
      const confirmed = Number(confirmRows[0]?.n ?? 0);
      if (confirmed > 0) {
        console.log(`confirm finalize created=${confirmed}`);
      }
    } catch (confirmErr) {
      console.error('logic_signal_confirm_finalize', decorate(confirmErr.message));
    }

    // #1002: в конце цикла — общая принудительная проверка стопов СЛ/ТП терминала
    // (та же процедура, что по таймеру сторожа): открытие позиций в этом же цикле
    // закроется сразу, не дожидаясь следующего 10-секундного опроса.
    try {
      pokeTerminalStopWatch();
    } catch (_e) {
      /* стопы — не повод ронять цикл */
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
      signals,
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

/**
 * #994-доработка: событийный рейтинг индикаторов ПО КОНКРЕТНОЙ ЛОГИКЕ — юниверс
 * её пар (бумага × ТФ). Пристраивается к работающей логике (после её цикла),
 * чтобы не ждать медленного полного прогона. Троттл per-logic и advisory lock —
 * внутри run_indicator_rating_for_logic_safe; при 0 (троттл/занято) тихо выходим.
 * #1029: во время бэктеста рейтинг пропускается, а сам прогон ограничен 120 с —
 * иначе его длинная транзакция блокирует подготовку теста.
 */
async function runIndicatorRatingForLogic(pool, logicId) {
  // #1029: пока идёт бэктест, рейтинг не запускаем. Он идёт одной длинной
  // транзакцией и держит блокировки `indicator_values`, из-за чего подготовка
  // теста (`ensure_security_indicator_series`) висела минутами.
  try {
    const { rows: active } = await pool.query(
      `SELECT 1 FROM logic_backtest_runs
        WHERE status IN ('pending', 'loading_prices', 'loading_indicators', 'running')
        LIMIT 1`
    );
    if (active.length > 0) return 0;
  } catch (_e) {
    /* проверка не должна ломать цикл */
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Ограничиваем один прогон рейтинга: раньше стоял 0 (без лимита) и
    // зависший рейтинг блокировал другие процессы на много минут.
    await client.query('SET LOCAL statement_timeout = 120000');
    const { rows } = await client.query(
      `SELECT run_indicator_rating_for_logic_safe($1) AS r`,
      [logicId]
    );
    await client.query('COMMIT');
    const r = Number(rows[0]?.r);
    if (r === 1) {
      console.log(`Indicator rating (logic ${logicId}): ok`);
      await writeTechLogEvent(pool, {
        threadKey: 'trade-runner',
        operation: 'indicator_rating.logic',
        message: `Тест рейтинга индикаторов по логике ${logicId}: выполнено`,
        source: 'node',
        payload: { logic_id: logicId, result: r },
      }).catch(() => {});
    } else if (r === -1) {
      console.error(`Indicator rating (logic ${logicId}): failed (см. indicator_rating_logic_run)`);
    }
    return r;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_e) {
      /* ignore */
    }
    console.error(`Indicator rating (logic ${logicId})`, decorate(err.message));
    return null;
  } finally {
    client.release();
  }
}

const indicatorRatingQueue = new Set();
let indicatorRatingQueueRunning = false;

/**
 * Ставит логики в очередь на событийный пересчёт рейтинга. Прогон фоновый и
 * последовательный (тяжёлый), не блокирует цикл сделок. Троттл per-logic
 * отсекает частые повторы (логика обрабатывается каждые ~15 с).
 */
function scheduleIndicatorRatingForLogics(pool, logicIds) {
  for (const id of logicIds || []) {
    const n = Number(id);
    if (Number.isFinite(n) && n > 0) indicatorRatingQueue.add(n);
  }
  if (indicatorRatingQueueRunning || indicatorRatingQueue.size === 0) return;
  indicatorRatingQueueRunning = true;
  (async () => {
    try {
      while (indicatorRatingQueue.size > 0) {
        const id = indicatorRatingQueue.values().next().value;
        indicatorRatingQueue.delete(id);
        await runIndicatorRatingForLogic(pool, id);
      }
    } finally {
      indicatorRatingQueueRunning = false;
    }
  })().catch((err) => {
    indicatorRatingQueueRunning = false;
    console.error('Indicator rating queue', decorate(err.message));
  });
}

const IDLE_RATING_MINUTES = Number(process.env.INDICATOR_RATING_IDLE_MINUTES) || 30;

/**
 * #994-доработка: полный прогон рейтинга индикаторов, когда нет ни одной
 * активной/сигнальной логики. Юниверс — бумаги с недавними свечами (любой
 * активный ТФ). Троттл по времени внутри run_indicator_rating_test_safe, чтобы
 * не сжигать машинное время зря. Фоновый, не блокирует цикл сделок.
 */
function scheduleIndicatorRatingIdle(pool) {
  runIndicatorRatingFull(pool, IDLE_RATING_MINUTES).catch((err) => {
    console.error('Indicator rating (idle)', decorate(err.message));
  });
}

async function runIndicatorRatingFull(pool, minIntervalMinutes) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = 0');
    const { rows } = await client.query(
      `SELECT run_indicator_rating_test_safe($1) AS r`,
      [minIntervalMinutes]
    );
    await client.query('COMMIT');
    const r = Number(rows[0]?.r);
    if (r === 1) {
      console.log('Indicator rating (idle): ok');
      await writeTechLogEvent(pool, {
        threadKey: 'trade-runner',
        operation: 'indicator_rating.idle',
        message: 'Тест рейтинга индикаторов (простой, без логик): выполнено',
        source: 'node',
        payload: { result: r, min_interval_minutes: minIntervalMinutes },
      }).catch(() => {});
    } else if (r === -1) {
      console.error('Indicator rating (idle): failed (см. indicator_rating_run)');
    }
    return r;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_e) {
      /* ignore */
    }
    console.error('Indicator rating (idle)', decorate(err.message));
    return null;
  } finally {
    client.release();
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
        console.error('Trade runner cycle error', decorate(err.message));
        writeErrorLog(pool, {
          level: 'error',
          source: 'trade-runner',
          category: 'runner',
          code: 'TRADE_CYCLE',
          message: err.message || 'Trade cycle error',
          detail: decorate(err.stack || err.message),
        });
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
        console.error('Trade watchdog error', decorate(err.message));
        writeErrorLog(pool, {
          level: 'error',
          source: 'trade-runner',
          category: 'runner',
          code: 'TRADE_WATCHDOG',
          message: err.message || 'Trade watchdog error',
          detail: decorate(err.stack || err.message),
        });
        watchdogRunning = false;
      });
  }, WATCHDOG_MS);

  // #994-доработка: рейтинг индикаторов — не по таймеру, а событийно, пристроен
  // к отработавшим логикам в runTradeCycle (см. scheduleIndicatorRatingForLogics).

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
  runIndicatorRatingForLogic,
  scheduleIndicatorRatingForLogics,
  runIndicatorRatingFull,
  scheduleIndicatorRatingIdle,
  STALE_MS,
  MAX_CYCLE_MS,
};
