/**
 * Мониторинг системы: журнал ошибок (app_error_log) + агрегат отказов по минутам.
 *
 * Закладка «Мониторинг системы» опрашивает эти маршруты и рисует график + список.
 * Заполняется автоматически (см. api/lib/error-log.js): HTTP >= 400, исключения
 * процесса, сбои внешних сервисов и раннера. Очистка — фоновым планировщиком (24 ч).
 */
module.exports = function registerMonitoringRoutes(app, ctx) {
  const { pool, parseId } = ctx;

  // Список ошибок, свежие сверху.
  app.get('/api/monitoring/errors', async (req, res) => {
    const limit = Math.min(parseId(req.query.limit) || 200, 500);
    const where = [];
    const params = [];

    const level = req.query.level ? String(req.query.level).trim() : '';
    if (['warning', 'error', 'fatal', 'success'].includes(level)) {
      params.push(level);
      where.push(`level = $${params.length}`);
    }
    const since = req.query.since ? String(req.query.since).trim() : '';
    if (since) {
      params.push(since);
      where.push(`created_at >= $${params.length}::timestamptz`);
    }
    params.push(limit);
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    try {
      const { rows } = await pool.query(
        `
        SELECT
          id, created_at, level, source, category, code, message, detail,
          endpoint, http_status, method, trace_id::text AS trace_id,
          logic_id, security_id, context
        FROM app_error_log
        ${whereSql}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length}
        `,
        params
      );
      res.json({ rows });
    } catch (err) {
      console.error('GET /api/monitoring/errors', err);
      res.status(500).json({ error: err.message });
    }
  });

  // График: количество ошибок по минутам за окно (по умолчанию последний час).
  app.get('/api/monitoring/stats', async (req, res) => {
    const minutes = Math.max(5, Math.min(parseId(req.query.minutes) || 60, 1440));
    try {
      const { rows } = await pool.query(
        `
        WITH bounds AS (
          SELECT date_trunc('minute', now()) - make_interval(mins => $1::int - 1) AS start_min
        ),
        buckets AS (
          SELECT generate_series(start_min, date_trunc('minute', now()), interval '1 minute') AS ts
          FROM bounds
        )
        SELECT
          b.ts,
          COALESCE(count(e.id), 0)::int AS count
        FROM buckets b
        LEFT JOIN app_error_log e
          ON e.created_at >= b.ts AND e.created_at < b.ts + interval '1 minute'
        GROUP BY b.ts
        ORDER BY b.ts
        `,
        [minutes]
      );
      const total = rows.reduce((acc, r) => acc + Number(r.count || 0), 0);
      res.json({ minutes, total, rows });
    } catch (err) {
      console.error('GET /api/monitoring/stats', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Сводка для «света» вкладки и заголовка: счётчики по уровням + последняя
  // критичная (error/fatal) и последняя предупреждающая (warning) записи.
  // Лёгкий запрос — вызывается из шапки каждые несколько секунд.
  app.get('/api/monitoring/summary', async (_req, res) => {
    try {
      const { rows: countRows } = await pool.query(
        `
        SELECT
          count(*) FILTER (WHERE level = 'warning')::int AS warning,
          count(*) FILTER (WHERE level = 'error')::int AS error,
          count(*) FILTER (WHERE level = 'fatal')::int AS fatal,
          count(*)::int AS total
        FROM app_error_log
        `
      );
      const { rows: criticalRows } = await pool.query(
        `
        SELECT
          id, created_at, level, source, category, code, message, detail,
          endpoint, http_status, method, logic_id, security_id
        FROM app_error_log
        WHERE level IN ('error', 'fatal')
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        `
      );
      const { rows: warningRows } = await pool.query(
        `
        SELECT
          id, created_at, level, source, category, code, message, detail,
          endpoint, http_status, method, logic_id, security_id
        FROM app_error_log
        WHERE level = 'warning'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        `
      );
      // Последний «пинг» сервисов (кнопка «Пинг») — по нему «свет» вкладки сбрасывается
      // в нормальный после успешной проверки (см. app.component.ts).
      const { rows: pingRows } = await pool.query(
        `
        SELECT
          id, created_at, level, source, category, code, message, detail,
          endpoint, http_status, method, logic_id, security_id
        FROM app_error_log
        WHERE category = 'ping' AND code = 'PING'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        `
      );
      res.json({
        windowHours: 24,
        counts: countRows[0] ?? { warning: 0, error: 0, fatal: 0, total: 0 },
        latestCritical: criticalRows[0] ?? null,
        latestWarning: warningRows[0] ?? null,
        latestPing: pingRows[0] ?? null,
      });
    } catch (err) {
      console.error('GET /api/monitoring/summary', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Проверка всех сервисов по кнопке «Пинг». Только безопасные read-only запросы:
  // никаких сделок (ни реальных, ни тестовых). Результаты (и успешные тоже) пишутся
  // в журнал app_error_log с уровнем success/error/warning и category='ping'.
  app.post('/api/monitoring/ping', async (_req, res) => {
    try {
      const { writeErrorLog } = require('../lib/error-log');
      const { tbankHttpPost, DEFAULT_API } = require('../lib/tbank-invest-client');

      const rpcGetAccounts = 'tinkoff.public.invest.api.contract.v1.UsersService/GetAccounts';

      // api_url брокера T-BANK (fallback — прод).
      let apiUrl = DEFAULT_API;
      try {
        const { rows } = await pool.query(
          `SELECT COALESCE(NULLIF(btrim(api_url), ''), $1) AS api_url
           FROM brokers WHERE code = 'T-BANK' LIMIT 1`,
          [DEFAULT_API]
        );
        if (rows[0]?.api_url) apiUrl = rows[0].api_url;
      } catch (_e) {
        /* default */
      }

      const checks = [];

      async function runCheck(key, label, severity, fn) {
        const started = Date.now();
        let ok = false;
        let detail = '';
        try {
          detail = (await fn()) || 'OK';
          ok = true;
        } catch (err) {
          detail = err?.message || String(err);
        }
        checks.push({ key, label, severity, ok, latencyMs: Date.now() - started, detail });
      }

      // 1) PostgreSQL — соединение и простой запрос.
      await runCheck('postgresql', 'PostgreSQL', 'error', async () => {
        const { rows } = await pool.query('SELECT 1 AS ok');
        return rows[0]?.ok === 1 ? 'соединение и запрос OK' : 'нет ответа';
      });

      // 2) T-Bank API по токену из настроек (read-only GetAccounts).
      await runCheck('tbank', 'T-Bank API (токен настроек)', 'error', async () => {
        const { rows } = await pool.query(
          `SELECT btrim(COALESCE(pv.value, '')) AS token
           FROM parameter_values pv
           JOIN parameter_types pt ON pt.id = pv.parameter_type_id
           JOIN parameter_sets ps ON ps.id = pv.parameter_set_id
           WHERE ps.name = 'Default' AND pt.short_name = 'TBANK_API_TOKEN'
           LIMIT 1`
        );
        const token = rows[0]?.token || '';
        if (!token) return 'токен не задан';
        const data = await tbankHttpPost(apiUrl, rpcGetAccounts, token, {});
        const n = Array.isArray(data?.accounts) ? data.accounts.length : 0;
        return `получено счетов: ${n}`;
      });

      // 3) T-Bank по токену каждого активного счёта (тот, что используется в торговле).
      let accountsWithToken = [];
      try {
        const { rows } = await pool.query(
          `SELECT id, name, btrim(token_encrypted) AS token
           FROM accounts
           WHERE is_active
             AND token_encrypted IS NOT NULL AND btrim(token_encrypted) <> ''
           ORDER BY id`
        );
        accountsWithToken = rows;
      } catch (_e) {
        /* нет колонки/таблицы — пропускаем */
      }
      for (const acc of accountsWithToken) {
        await runCheck(
          `tbank_account_${acc.id}`,
          `T-Bank счёт: ${acc.name}`,
          'error',
          async () => {
            const data = await tbankHttpPost(apiUrl, rpcGetAccounts, acc.token, {});
            const n = Array.isArray(data?.accounts) ? data.accounts.length : 0;
            return `доступ есть, счетов по токену: ${n}`;
          }
        );
      }

      // 4) MOEX ISS — рыночные данные (read-only).
      await runCheck('moex', 'MOEX ISS (рыночные данные)', 'warning', async () => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        try {
          const resp = await fetch(
            'https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities.json?iss.meta=off&iss.only=marketdata&marketdata.columns=SECID',
            { signal: ctrl.signal }
          );
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const text = await resp.text();
          if (!text.includes('marketdata')) throw new Error('ответ без marketdata');
          return 'котировки доступны';
        } finally {
          clearTimeout(timer);
        }
      });

      const anyError = checks.some((c) => !c.ok && c.severity === 'error');
      const allOk = checks.every((c) => c.ok);

      // Пишем каждый результат в журнал (в т.ч. успешные — чтобы пользователь видел «всё хорошо»).
      for (const c of checks) {
        const level = c.ok ? 'success' : c.severity === 'error' ? 'error' : 'warning';
        await writeErrorLog(pool, {
          level,
          source: 'ping',
          category: 'ping',
          code: `PING_${c.key.toUpperCase().slice(0, 48)}`,
          message: `${c.label}: ${c.ok ? 'OK' : 'СБОЙ'} — ${c.detail}`,
          context: { ok: c.ok, latencyMs: c.latencyMs, key: c.key },
        });
      }
      await writeErrorLog(pool, {
        level: allOk ? 'success' : anyError ? 'error' : 'warning',
        source: 'ping',
        category: 'ping',
        code: 'PING',
        message: allOk
          ? `Пинг сервисов: всё в порядке (${checks.length}/${checks.length})`
          : `Пинг сервисов: сбоев ${checks.filter((c) => !c.ok).length} из ${checks.length}`,
        context: { ok: allOk, checks: checks.map((c) => ({ key: c.key, ok: c.ok })) },
      });

      res.json({ ok: allOk, checkedAt: new Date().toISOString(), checks });
    } catch (err) {
      console.error('POST /api/monitoring/ping', err);
      res.status(500).json({ error: err.message });
    }
  });
};
