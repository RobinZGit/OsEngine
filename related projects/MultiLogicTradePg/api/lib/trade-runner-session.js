'use strict';

/** Сессия UI (опционально): heartbeat Angular. По умолчанию runner headless — UI не обязателен. */
const UI_TTL_MS = Number(process.env.TRADE_RUNNER_UI_TTL_MS) || 90000;

let lastUiHeartbeatAt = 0;

function touchUiHeartbeat() {
  lastUiHeartbeatAt = Date.now();
}

function clearUiHeartbeat() {
  lastUiHeartbeatAt = 0;
}

function isUiSessionActive() {
  return lastUiHeartbeatAt > 0 && Date.now() - lastUiHeartbeatAt < UI_TTL_MS;
}

async function touchUiHeartbeatDb(pool) {
  await pool.query('CALL touch_trade_runner_ui_heartbeat()');
  touchUiHeartbeat();
}

async function clearUiHeartbeatDb(pool) {
  await pool.query('CALL clear_trade_runner_ui_heartbeat()');
  clearUiHeartbeat();
}

module.exports = {
  UI_TTL_MS,
  touchUiHeartbeat,
  clearUiHeartbeat,
  isUiSessionActive,
  touchUiHeartbeatDb,
  clearUiHeartbeatDb,
};
