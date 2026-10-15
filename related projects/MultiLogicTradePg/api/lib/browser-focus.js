/** #998: подъём окна браузера с приложением при появлении нового сигнала логики.
 *
 * Браузер НЕ может выйти на передний план из фоновой вкладки штатными средствами
 * (window.focus() лишь мигает на панели задач), а у свёрнутого/фонового окна Chrome
 * душит таймеры вкладки — поэтому детект «нового сигнала» и подъём окна делает сам
 * локальный API (он на том же ПК, что и браузер), независимо от JS вкладки.
 *
 * Здесь: raiseBrowserWindow() — запуск Windows-хелпера scripts/show-browser.ps1;
 * startBrowserSignalWatch() — опрос MAX(id) сигналов терминала и подъём при росте.
 */
'use strict';

const path = require('path');
const { execFile } = require('child_process');

const SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'show-browser.ps1');
const RAISE_MIN_INTERVAL_MS = Number(process.env.BROWSER_RAISE_MIN_INTERVAL_MS) || 3000;

let lastRaisedAt = 0;

/**
 * Поднимает окно браузера поверх остальных. Лучшее усилие: при неудаче/не-Windows
 * возвращает { ok:false, reason }. Троттл защищает от лавины запусков (force=true
 * обходит троттл — для ручного вызова из UI).
 */
function raiseBrowserWindow({ force = false } = {}) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ ok: false, reason: 'unsupported-platform' });
      return;
    }
    const now = Date.now();
    if (!force && now - lastRaisedAt < RAISE_MIN_INTERVAL_MS) {
      resolve({ ok: false, reason: 'throttled' });
      return;
    }
    lastRaisedAt = now;
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        SCRIPT_PATH,
      ],
      { timeout: 10000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve({ ok: false, reason: 'helper-failed' });
          return;
        }
        try {
          const parsed = JSON.parse(String(stdout || '{}'));
          resolve({
            ok: Boolean(parsed.ok),
            reason: parsed.ok ? 'raised' : 'window-not-found',
            title: parsed.title || '',
          });
        } catch (_e) {
          resolve({ ok: false, reason: 'bad-output' });
        }
      }
    );
  });
}

let browserWatchTimer = null;
/** @type {number|null} */
let lastSignalId = null;

/** Один опрос: если появился новый сигнал терминала — поднимаем окно. */
async function pollNewTerminalSignals(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(MAX(lts.id), 0) AS m
         FROM logic_terminal_signals lts
         JOIN logics l ON l.id = lts.logic_id
        WHERE COALESCE(l.use_as_terminal_signal, FALSE)`
    );
    const maxId = Number(rows[0]?.m ?? 0);
    if (lastSignalId === null) {
      // Первый опрос — только запоминаем текущую голову очереди (не поднимаем окно).
      lastSignalId = maxId;
      return;
    }
    if (maxId > lastSignalId) {
      lastSignalId = maxId;
      const r = await raiseBrowserWindow();
      console.log(`Browser signal watch: new signal → raise ${JSON.stringify(r)}`);
    }
  } catch (err) {
    // Тихо: сигналы — не критичный путь, ошибку не раздуваем.
    console.error('Browser signal watch poll failed:', err.message || err);
  }
}

/** #998: событийный сторож сигналов на стороне API (не зависит от таймеров вкладки). */
function startBrowserSignalWatch(pool) {
  if (browserWatchTimer) return;
  const intervalMs = Number(process.env.BROWSER_SIGNAL_WATCH_MS) || 8000;
  browserWatchTimer = setInterval(() => {
    pollNewTerminalSignals(pool).catch(() => {});
  }, intervalMs);
  // Первый опрос чуть позже старта — запомнить текущую голову очереди.
  setTimeout(() => {
    pollNewTerminalSignals(pool).catch(() => {});
  }, 4000);
  console.log(`Browser signal watch: every ${intervalMs}ms (raise window on new terminal signal)`);
}

module.exports = {
  raiseBrowserWindow,
  startBrowserSignalWatch,
  pollNewTerminalSignals,
};
