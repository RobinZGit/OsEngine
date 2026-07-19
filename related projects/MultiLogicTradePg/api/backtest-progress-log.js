/**
 * Диагностический лог прогресса бэктеста (UI stuck at 1%, гонки /status и т.п.).
 * Файл: api/logs/backtest-progress.log
 */
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'backtest-progress.log');

function ensureDir() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (_e) {
    /* ignore */
  }
}

function appendBacktestProgressLog(source, payload) {
  try {
    ensureDir();
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      source: String(source || 'api'),
      ...payload,
    });
    fs.appendFileSync(LOG_FILE, `${line}\n`, 'utf8');
  } catch (err) {
    console.warn('backtest-progress.log write failed:', err.message);
  }
}

module.exports = {
  appendBacktestProgressLog,
  BACKTEST_PROGRESS_LOG_FILE: LOG_FILE,
};
