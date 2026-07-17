'use strict';

/** Статусы прогона теста, при которых логика «занята» бэктестом. */
const ACTIVE_BACKTEST_STATUSES = [
  'pending',
  'loading_prices',
  'loading_indicators',
  'running',
];

/**
 * Есть ли активный бэктест (по логике или любой).
 * @param {import('pg').Pool|import('pg').PoolClient} db
 * @param {number|null} [logicId]
 */
async function hasActiveBacktest(db, logicId = null) {
  if (logicId == null) {
    const { rows } = await db.query(
      `
      SELECT 1
      FROM logic_backtest_runs
      WHERE status = ANY($1::text[])
      LIMIT 1
      `,
      [ACTIVE_BACKTEST_STATUSES]
    );
    return rows.length > 0;
  }
  const { rows } = await db.query(
    `
    SELECT 1
    FROM logic_backtest_runs
    WHERE logic_id = $1
      AND status = ANY($2::text[])
    LIMIT 1
    `,
    [logicId, ACTIVE_BACKTEST_STATUSES]
  );
  return rows.length > 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ждать окончания бэктеста по логике (чтобы прекалк/бой не дрались с тестом).
 * @returns {boolean} true если дождались; false по таймауту
 */
async function waitWhileBacktestActive(db, logicId, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) || 30 * 60 * 1000;
  const pollMs = Number(opts.pollMs) || 1500;
  const started = Date.now();
  while (await hasActiveBacktest(db, logicId)) {
    if (Date.now() - started > timeoutMs) return false;
    await sleep(pollMs);
  }
  return true;
}

module.exports = {
  ACTIVE_BACKTEST_STATUSES,
  hasActiveBacktest,
  waitWhileBacktestActive,
  sleep,
};
