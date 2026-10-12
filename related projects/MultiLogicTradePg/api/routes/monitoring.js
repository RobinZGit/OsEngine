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
    if (['warning', 'error', 'fatal'].includes(level)) {
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
};
