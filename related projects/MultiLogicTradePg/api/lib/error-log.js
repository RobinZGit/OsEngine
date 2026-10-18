'use strict';

/**
 * Запись в app_error_log — журнал для закладки «Мониторинг системы».
 *
 * Единая точка для ошибок API (HTTP >= 400), необработанных исключений процесса
 * и сбоев внешних сервисов/раннера. В отличие от app_tech_log пишем сбои с
 * уровнем severity и кодом, а также «success» — успешные проверки сервисов
 * (кнопка «Пинг»), чтобы пользователь видел, что всё в порядке.
 */

const MAX_MESSAGE = 2000;
const MAX_DETAIL = 8000;
const VALID_LEVELS = new Set(['warning', 'error', 'fatal', 'success']);

function truncate(value, max) {
  if (value == null) return null;
  const s = String(value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** HTTP 4xx → warning, 5xx → error, иначе null (не ошибка). */
function levelForHttpStatus(status) {
  const n = Number(status);
  if (!Number.isFinite(n) || n < 400) return null;
  return n >= 500 ? 'error' : 'warning';
}

/**
 * Вставить запись об ошибке. Fire-and-forget: никогда не бросает и не блокирует
 * вызывающий код (журнал не должен ломать основной поток / трейдинг).
 */
function writeErrorLog(pool, entry) {
  if (!pool || !entry) return Promise.resolve(false);
  const level = VALID_LEVELS.has(entry.level) ? entry.level : 'error';
  const message = truncate(entry.message ?? entry.detail ?? 'Unknown error', MAX_MESSAGE);
  const httpStatus = Number(entry.httpStatus);
  const params = [
    level,
    truncate(entry.source ?? 'api', 32),
    truncate(entry.category ?? 'internal', 32),
    truncate(entry.code ?? null, 64),
    message,
    truncate(entry.detail ?? null, MAX_DETAIL),
    truncate(entry.endpoint ?? null, 512),
    Number.isFinite(httpStatus) ? httpStatus : null,
    truncate(entry.method ?? null, 10),
    entry.traceId ? String(entry.traceId) : null,
    entry.logicId != null ? Number(entry.logicId) : null,
    entry.securityId != null ? Number(entry.securityId) : null,
    entry.context != null ? JSON.stringify(entry.context) : null,
  ];
  return pool
    .query(
      `INSERT INTO app_error_log
         (level, source, category, code, message, detail, endpoint, http_status, method, trace_id, logic_id, security_id, context)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid, $11, $12, $13::jsonb)`,
      params
    )
    .then(() => true)
    .catch((err) => {
      // На старой схеме таблицы может не быть — не засоряем консоль без флага.
      if (process.env.ERROR_LOG_DEBUG === '1') {
        console.error('writeErrorLog failed:', err.message);
      }
      return false;
    });
}

module.exports = {
  writeErrorLog,
  levelForHttpStatus,
};
