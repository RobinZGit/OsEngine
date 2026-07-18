'use strict';

const CLEANUP_CHECK_MS = Number(process.env.CLEANUP_CHECK_MS) || 60 * 60 * 1000; // hourly check
const CLEANUP_MIN_INTERVAL_MS = Number(process.env.CLEANUP_MIN_INTERVAL_MS) || 24 * 60 * 60 * 1000;

let running = false;

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

function startMaintenanceScheduler(pool) {
  if (process.env.CLEANUP_SCHEDULER_ENABLED === '0') {
    console.log('Maintenance cleanup scheduler: disabled (CLEANUP_SCHEDULER_ENABLED=0)');
    return;
  }
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

module.exports = {
  maybeRunScheduledCleanup,
  startMaintenanceScheduler,
};
