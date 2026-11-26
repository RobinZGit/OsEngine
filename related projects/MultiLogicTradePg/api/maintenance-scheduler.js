'use strict';

const CLEANUP_CHECK_MS = Number(process.env.CLEANUP_CHECK_MS) || 60 * 60 * 1000; // hourly check
const CLEANUP_MIN_INTERVAL_MS = Number(process.env.CLEANUP_MIN_INTERVAL_MS) || 24 * 60 * 60 * 1000;

// Журнал ошибок «Мониторинг системы»: храним 24 ч, чистим каждый час (+ на старте).
const ERROR_LOG_RETENTION_HOURS = Number(process.env.ERROR_LOG_RETENTION_HOURS) || 24;
const ERROR_LOG_PURGE_CHECK_MS =
  Number(process.env.ERROR_LOG_PURGE_CHECK_MS) || 60 * 60 * 1000; // hourly

// Брокерская сверка (цена исполнения + комиссия → пересборка PnL боевых сделок).
// Лечит зависший finres, записанный по предварительной цене до финального fill.
const BROKER_FEE_SYNC_CHECK_MS =
  Number(process.env.BROKER_FEE_SYNC_CHECK_MS) || 5 * 60 * 1000; // каждые 5 минут

// Фоновый предрасчёт значений индикаторов: некритичный, прерываемый.
const INDICATOR_PRECALC_CHECK_MS =
  Number(process.env.INDICATOR_PRECALC_CHECK_MS) || 2 * 60 * 1000; // каждые 2 минуты
const INDICATOR_PRECALC_STEP_DELAY_MS =
  Number(process.env.INDICATOR_PRECALC_STEP_DELAY_MS) || 15000; // пауза между шагами
const INDICATOR_PRECALC_MAX_STEPS_PER_TICK =
  Number(process.env.INDICATOR_PRECALC_MAX_STEPS_PER_TICK) || 3;

let running = false;
let feeSyncRunning = false;
let terminalFeeSyncRunning = false;
let errorPurgeRunning = false;
let indicatorPrecalcRunning = false;

/**
 * Windows / no-pg_cron fallback: if APP_CLEANUP_DISK is on and last run > 24h,
 * call run_cleanup_if_enabled().
 */
async function maybeRunScheduledCleanup(pool) {
  if (running) return { skipped: true, reason: 'busy' };
  running = true;
  try {
    const { rows: enabledRows } = await pool.query(
      'SELECT cleanup_unused_market_data_enabled() AS enabled'
    );
    if (!enabledRows[0]?.enabled) {
      return { skipped: true, reason: 'disabled' };
    }

    const { rows: lastRows } = await pool.query(
      'SELECT app_cleanup_last_at() AS last_at'
    );
    const lastAt = lastRows[0]?.last_at ? new Date(lastRows[0].last_at) : null;
    if (lastAt && Number.isFinite(lastAt.getTime())) {
      const age = Date.now() - lastAt.getTime();
      if (age < CLEANUP_MIN_INTERVAL_MS) {
        return { skipped: true, reason: 'too_soon', last_at: lastAt.toISOString() };
      }
    }

    const { rows } = await pool.query('SELECT run_cleanup_if_enabled() AS result');
    return { ok: true, result: rows[0]?.result ?? {} };
  } catch (err) {
    console.error('Scheduled cleanup error', err.message);
    return { ok: false, error: err.message };
  } finally {
    running = false;
  }
}

/**
 * Периодическая сверка боевых сделок с T-Bank (GetOrderState): финальная цена
 * исполнения и комиссия → сразу пересобираются пакеты/PnL закрытий.
 * Отключается APP_BROKER_FEE_SYNC=0.
 */
async function maybeSyncBrokerFees(pool) {
  if (process.env.APP_BROKER_FEE_SYNC === '0') {
    return { skipped: true, reason: 'disabled' };
  }
  if (feeSyncRunning) return { skipped: true, reason: 'busy' };
  feeSyncRunning = true;
  try {
    const { rows } = await pool.query(
      'SELECT logic_sync_real_trade_broker_fees(NULL) AS result'
    );
    const result = rows[0]?.result ?? {};
    if (Number(result.updated) > 0 || result.rebuild_error) {
      console.log(
        `Broker fee sync: updated=${result.updated} refinalized=${result.refinalized}` +
          (result.rebuild_error ? ` rebuild_error=${result.rebuild_error}` : '')
      );
    }
    return { ok: true, result };
  } catch (err) {
    // Функции может не быть на старой схеме — молча ждать обновления 02.
    console.error('Broker fee sync error', err.message);
    return { ok: false, error: err.message };
  } finally {
    feeSyncRunning = false;
  }
}

/**
 * Сверка ручных сделок терминала по реальному счёту: PostOrder у маркет-заявки
 * комиссию обычно не отдаёт, а исполняется ЦЕЛОЕ число лотов — дотягиваем
 * комиссию и фактическую цену/количество (лоты × размер лота) с T-Bank.
 * Отключается тем же APP_BROKER_FEE_SYNC=0.
 */
async function maybeSyncTerminalBrokerFees(pool) {
  if (process.env.APP_BROKER_FEE_SYNC === '0') {
    return { skipped: true, reason: 'disabled' };
  }
  if (terminalFeeSyncRunning) return { skipped: true, reason: 'busy' };
  terminalFeeSyncRunning = true;
  try {
    const { rows } = await pool.query(
      'SELECT terminal_sync_real_trade_broker_fees(NULL, NULL) AS result'
    );
    const result = rows[0]?.result ?? {};
    if (Number(result.updated) > 0) {
      console.log(`Terminal broker fee sync: updated=${result.updated}`);
    }
    return { ok: true, result };
  } catch (err) {
    // Функции может не быть на старой схеме — молча ждать обновления 02.
    console.error('Terminal broker fee sync error', err.message);
    return { ok: false, error: err.message };
  } finally {
    terminalFeeSyncRunning = false;
  }
}

async function hasActiveBacktestOrHeavyLoad(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT
         EXISTS (
           SELECT 1 FROM logic_backtest_runs
           WHERE status IN ('pending','loading_prices','loading_indicators','running')
           LIMIT 1
         ) AS active_backtest,
         EXISTS (
           SELECT 1
           FROM pg_stat_activity
           WHERE state = 'active'
             AND pid <> pg_backend_pid()
             AND query_start < CURRENT_TIMESTAMP - INTERVAL '15 seconds'
             AND coalesce(wait_event_type, '') <> 'Client'
           LIMIT 1
         ) AS db_busy`
    );
    const r = rows[0] || {};
    return {
      activeBacktest: Boolean(r.active_backtest),
      dbBusy: Boolean(r.db_busy),
    };
  } catch (_err) {
    // При ошибке проверки лучше уступить.
    return { activeBacktest: false, dbBusy: true };
  }
}

async function maybeLoadIndicatorPrecalcPrices(pool) {
  // Один небольшой шаг догрузки цен. Только при простое, без агрессии.
  const guard = await hasActiveBacktestOrHeavyLoad(pool);
  if (guard.activeBacktest) return { skipped: true, reason: 'active_backtest' };
  if (guard.dbBusy) return { skipped: true, reason: 'db_busy' };

  // Окна хранения/догрузки: M15+ 180д, M5 90д, M1 30д.
  const { rows } = await pool.query(
    `WITH tf AS (
       SELECT id, sec,
              CASE
                WHEN id = 1 THEN 30
                WHEN id = 4 THEN 90
                ELSE 180
              END AS days_window,
              CASE id
                WHEN 21 THEN 10 WHEN 20 THEN 20 WHEN 19 THEN 30 WHEN 18 THEN 40
                WHEN 17 THEN 50 WHEN 16 THEN 60 WHEN 15 THEN 70 WHEN 14 THEN 80
                WHEN 13 THEN 90 WHEN 12 THEN 100 WHEN 11 THEN 110 WHEN 10 THEN 120
                WHEN 9 THEN 130 WHEN 8 THEN 140 WHEN 7 THEN 150 WHEN 6 THEN 160
                WHEN 4 THEN 170 WHEN 1 THEN 180 ELSE 999
              END AS tf_prio
       FROM timeframes
       WHERE COALESCE(is_active, TRUE)
         AND id IN (21,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,4,1)
     ),
     sec AS (
       SELECT s.id,
              CASE st.name
                WHEN 'Stock' THEN 10 WHEN 'PreferredStock' THEN 20 WHEN 'ETF' THEN 30
                WHEN 'Bond' THEN 40 WHEN 'Futures' THEN 90 ELSE 100
              END AS sec_prio
       FROM securities s
       LEFT JOIN security_types st ON st.id = s.security_type_id
       WHERE EXISTS (
         SELECT 1 FROM prices p
         WHERE p.security_id = s.id AND p.close_price > 0
           AND p.dt >= CURRENT_TIMESTAMP - INTERVAL '30 days'
       )
     ),
     cov AS (
       SELECT p.security_id, p.timeframe_id,
              MIN(p.dt) AS min_dt, MAX(p.dt) AS max_dt, COUNT(*)::bigint AS cnt
       FROM prices p
       WHERE p.dt >= CURRENT_TIMESTAMP - INTERVAL '190 days'
       GROUP BY p.security_id, p.timeframe_id
     )
     SELECT sec.id AS security_id, tf.id AS timeframe_id, tf.days_window,
            cov.min_dt, cov.max_dt, cov.cnt,
            COALESCE(NULLIF(btrim(s2.name),''), NULLIF(btrim(s2.code),''), 'security#'||sec.id::text) AS security_name,
            COALESCE(NULLIF(btrim(tf2.code),''), NULLIF(btrim(tf2.name),''), 'tf#'||tf.id::text) AS tf_name
     FROM sec
     JOIN securities s2 ON s2.id = sec.id
     CROSS JOIN tf
     JOIN timeframes tf2 ON tf2.id = tf.id
     LEFT JOIN cov ON cov.security_id = sec.id AND cov.timeframe_id = tf.id
     WHERE sec.sec_prio <= 40
       AND (
         cov.security_id IS NULL
         OR cov.max_dt < CURRENT_TIMESTAMP - INTERVAL '2 days'
         OR cov.min_dt > CURRENT_TIMESTAMP - make_interval(days => tf.days_window - 7)
       )
     ORDER BY tf.tf_prio, sec.sec_prio, sec.id
     LIMIT 1`
  );

  const target = rows[0];
  if (!target) return { skipped: true, reason: 'no_gap' };

  const daysWindow = Number(target.days_window) || 180;
  const dateTo = new Date();
  const dateFrom = new Date(Date.now() - daysWindow * 24 * 3600 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const activity = `Загрузка цен: ${target.security_name} / ${target.tf_name} (${fmt(dateFrom)}..${fmt(dateTo)})`;

  try {
    await pool.query(
      `UPDATE indicator_precalc_state
       SET current_activity = $1, last_status = 'running', last_run_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = TRUE`,
      [activity]
    ).catch(() => {});
    await pool.query(
      'CALL load_prices_http($1::integer, $2::integer, $3::date, $4::date)',
      [target.security_id, target.timeframe_id, fmt(dateFrom), fmt(dateTo)]
    );
    await pool.query(
      `UPDATE indicator_precalc_state
       SET current_activity = NULL, last_status = 'ok', last_ok_at = CURRENT_TIMESTAMP, last_message = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = TRUE`,
      [activity + ' — готово']
    ).catch(() => {});
    return {
      ok: true,
      activity,
      security_id: target.security_id,
      timeframe_id: target.timeframe_id,
      date_from: fmt(dateFrom),
      date_to: fmt(dateTo),
    };
  } catch (err) {
    await pool.query(
      `UPDATE indicator_precalc_state
       SET current_activity = NULL, last_status = 'error', last_message = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = TRUE`,
      [activity + ' — ' + err.message]
    ).catch(() => {});
    return { ok: false, error: err.message, security_id: target.security_id, timeframe_id: target.timeframe_id };
  }
}

/**
 * Фоновый предрасчёт значений индикаторов (default params).
 * Некритичный, прерываемый: маленькие шаги, паузы, останов при нагрузке/бэктесте.
 */
async function maybeRunIndicatorPrecalcStep(pool) {
  if (process.env.INDICATOR_PRECALC_BG_ENABLED === '0') {
    return { skipped: true, reason: 'disabled_env' };
  }
  if (indicatorPrecalcRunning) return { skipped: true, reason: 'busy' };
  indicatorPrecalcRunning = true;
  try {
    const { rows: enabledRows } = await pool.query(
      'SELECT indicator_precalc_bg_enabled() AS enabled'
    );
    if (!enabledRows[0]?.enabled) {
      return { skipped: true, reason: 'disabled' };
    }

    const results = [];
    const maxSteps = Math.max(1, Math.min(10, INDICATOR_PRECALC_MAX_STEPS_PER_TICK));
    for (let step = 0; step < maxSteps; step += 1) {
      const guard = await hasActiveBacktestOrHeavyLoad(pool);
      if (guard.activeBacktest) {
        results.push({ skipped: true, reason: 'active_backtest' });
        break;
      }
      if (guard.dbBusy) {
        results.push({ skipped: true, reason: 'db_busy' });
        break;
      }

      const { rows } = await pool.query(
        'SELECT run_indicator_precalc_bg_step($1::integer, $2::integer, $3::integer, $4::integer) AS result',
        [1, 2, 2, 300]
      );
      const result = rows[0]?.result ?? {};
      results.push(result);

      if (result?.skipped) break;
      // Небольшая уступка между шагами, чтобы не мешать торговле/UI.
      if (step < maxSteps - 1) {
        await new Promise((resolve) => setTimeout(resolve, INDICATOR_PRECALC_STEP_DELAY_MS));
      }
    }

    // Периодическая чистка старых M1/M5 цен (контроль роста БД).
    try {
      const guard = await hasActiveBacktestOrHeavyLoad(pool);
      if (!guard.activeBacktest && !guard.dbBusy) {
        await pool.query('SELECT indicator_precalc_cleanup_old_prices($1::integer) AS result', [5000]);
      }
    } catch (_cleanupErr) {
      // Некритично.
    }

    // Медленная догрузка цен (старшие ТФ к младшим, акции в первую очередь), только при простое.
    try {
      const guard = await hasActiveBacktestOrHeavyLoad(pool);
      if (!guard.activeBacktest && !guard.dbBusy) {
        const priceLoad = await maybeLoadIndicatorPrecalcPrices(pool);
        if (priceLoad && !priceLoad.skipped) results.push({ price_load: priceLoad });
      }
    } catch (_priceErr) {
      // Некритично.
    }

    return { ok: true, steps: results };
  } catch (err) {
    console.error('Indicator precalc bg error', err.message);
    return { ok: false, error: err.message };
  } finally {
    indicatorPrecalcRunning = false;
  }
}

/**
 * Чистка app_error_log: удаляет записи старше retention (по умолчанию 24 ч).
 * Держит журнал «Мониторинг системы» компактным; вызывается каждый час и на старте.
 */
async function purgeErrorLog(pool) {
  if (process.env.ERROR_LOG_PURGE_ENABLED === '0') {
    return { skipped: true, reason: 'disabled' };
  }
  if (errorPurgeRunning) return { skipped: true, reason: 'busy' };
  errorPurgeRunning = true;
  try {
    const res = await pool.query(
      `DELETE FROM app_error_log WHERE created_at < now() - make_interval(hours => $1::int)`,
      [ERROR_LOG_RETENTION_HOURS]
    );
    return { ok: true, deleted: res.rowCount ?? 0 };
  } catch (err) {
    // На старой схеме таблицы может не быть — молча ждём обновления 01.
    if (process.env.ERROR_LOG_DEBUG === '1') {
      console.error('Error log purge error', err.message);
    }
    return { ok: false, error: err.message };
  } finally {
    errorPurgeRunning = false;
  }
}

function startMaintenanceScheduler(pool) {
  if (process.env.CLEANUP_SCHEDULER_ENABLED === '0') {
    console.log('Maintenance cleanup scheduler: disabled (CLEANUP_SCHEDULER_ENABLED=0)');
  } else {
    console.log(
      `Maintenance cleanup scheduler: check every ${CLEANUP_CHECK_MS}ms; min interval ${CLEANUP_MIN_INTERVAL_MS}ms when APP_CLEANUP_DISK on`
    );
    setInterval(() => {
      maybeRunScheduledCleanup(pool).catch((err) => {
        console.error('Maintenance cleanup tick error', err.message);
      });
    }, CLEANUP_CHECK_MS);
    // First check shortly after API start (do not block listen)
    setTimeout(() => {
      maybeRunScheduledCleanup(pool).catch(() => {});
    }, 15000);
  }

  if (process.env.APP_BROKER_FEE_SYNC === '0') {
    console.log('Broker fee sync scheduler: disabled (APP_BROKER_FEE_SYNC=0)');
  } else {
    console.log(`Broker fee sync scheduler: every ${BROKER_FEE_SYNC_CHECK_MS}ms`);
    setInterval(() => {
      maybeSyncBrokerFees(pool).catch((err) => {
        console.error('Broker fee sync tick error', err.message);
      });
      maybeSyncTerminalBrokerFees(pool).catch((err) => {
        console.error('Terminal broker fee sync tick error', err.message);
      });
    }, BROKER_FEE_SYNC_CHECK_MS);
    setTimeout(() => {
      maybeSyncBrokerFees(pool).catch(() => {});
      maybeSyncTerminalBrokerFees(pool).catch(() => {});
    }, 30000);
  }

  if (process.env.ERROR_LOG_PURGE_ENABLED === '0') {
    console.log('Error log purge scheduler: disabled (ERROR_LOG_PURGE_ENABLED=0)');
  } else {
    console.log(
      `Error log purge scheduler: retention ${ERROR_LOG_RETENTION_HOURS}h; check every ${ERROR_LOG_PURGE_CHECK_MS}ms`
    );
    setInterval(() => {
      purgeErrorLog(pool).catch((err) => {
        console.error('Error log purge tick error', err.message);
      });
    }, ERROR_LOG_PURGE_CHECK_MS);
    setTimeout(() => {
      purgeErrorLog(pool).catch(() => {});
    }, 20000);
  }

  if (process.env.INDICATOR_PRECALC_BG_ENABLED === '0') {
    console.log('Indicator precalc bg scheduler: disabled (INDICATOR_PRECALC_BG_ENABLED=0)');
  } else {
    console.log(
      `Indicator precalc bg scheduler: check every ${INDICATOR_PRECALC_CHECK_MS}ms; max ${INDICATOR_PRECALC_MAX_STEPS_PER_TICK} steps/tick`
    );
    setInterval(() => {
      maybeRunIndicatorPrecalcStep(pool).catch((err) => {
        console.error('Indicator precalc bg tick error', err.message);
      });
    }, INDICATOR_PRECALC_CHECK_MS);
    // Первый запуск с задержкой, чтобы не конкурировать со стартом API.
    setTimeout(() => {
      maybeRunIndicatorPrecalcStep(pool).catch(() => {});
    }, 45000);
  }
}

function isIndicatorPrecalcRunning() {
  return indicatorPrecalcRunning;
}

module.exports = {
  maybeRunScheduledCleanup,
  maybeSyncBrokerFees,
  maybeSyncTerminalBrokerFees,
  purgeErrorLog,
  maybeRunIndicatorPrecalcStep,
  isIndicatorPrecalcRunning,
  startMaintenanceScheduler,
};
