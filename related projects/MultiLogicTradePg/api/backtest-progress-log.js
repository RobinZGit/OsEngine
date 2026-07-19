/**
 * Диагностический лог прогресса бэктеста.
 * Асинхронная очередь — sync appendFileSync блокировал event loop API
 * (UI «Нет ответа от API», зависания на старте).
 * Файл: api/logs/backtest-progress.log
 */
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'backtest-progress.log');

let queue = [];
let flushing = false;
let ensured = false;
/** Не спамить одинаковый status. */
const lastStatusKey = new Map();

function ensureDir() {
  if (ensured) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    ensured = true;
  } catch (_e) {
    /* ignore */
  }
}

function flush() {
  if (flushing || queue.length === 0) return;
  flushing = true;
  const chunk = queue.join('');
  queue = [];
  ensureDir();
  fs.appendFile(LOG_FILE, chunk, 'utf8', () => {
    flushing = false;
    if (queue.length) flush();
  });
}

/**
 * @param {string} source
 * @param {object} payload
 * @param {{ force?: boolean }} [opts]
 */
function appendBacktestProgressLog(source, payload, opts = {}) {
  try {
    const src = String(source || 'api');
    // api-status: только смена %/status или force (иначе диск + event loop).
    if (src === 'api-status' && !opts.force) {
      const logicId = payload?.logic_id;
      const key = `${payload?.run_id ?? ''}|${payload?.status ?? ''}|${Math.floor(Number(payload?.progress_pct) || 0)}`;
      if (lastStatusKey.get(logicId) === key) return;
      lastStatusKey.set(logicId, key);
    }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      source: src,
      ...payload,
    });
    queue.push(`${line}\n`);
    if (queue.length > 200) queue = queue.slice(-100);
    flush();
  } catch (err) {
    console.warn('backtest-progress.log write failed:', err.message);
  }
}

module.exports = {
  appendBacktestProgressLog,
  BACKTEST_PROGRESS_LOG_FILE: LOG_FILE,
};
