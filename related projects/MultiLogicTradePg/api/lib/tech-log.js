'use strict';

/**
 * Запись в app_tech_log через SQL (учитывает APP_TECH_LOGGING).
 */
async function writeTechLogEvent(pool, entry) {
  const threadKey = entry.threadKey || entry.thread_key;
  const operation = entry.operation;
  if (!threadKey || !operation) {
    return;
  }
  await pool.query(
    `SELECT app_tech_log_event($1, $2, $3, $4, 'event', $5, $6, $7, $8::jsonb)`,
    [
      String(threadKey),
      String(operation),
      entry.message != null ? String(entry.message) : null,
      entry.source ? String(entry.source) : 'api',
      entry.logicId ?? entry.logic_id ?? null,
      entry.securityId ?? entry.security_id ?? null,
      entry.timeframeId ?? entry.timeframe_id ?? null,
      entry.payload != null ? JSON.stringify(entry.payload) : null,
    ]
  );
}

module.exports = {
  writeTechLogEvent,
};
