/**
 * Тренажёр: сохранение результатов сессий и статистический отчёт.
 *
 * POST /api/trainer/sessions — идемпотентный upsert сессии по session_key
 *   (клиент сохраняет при завершении/перезапуске/уходе со вкладки).
 * GET  /api/trainer/sessions — последние сессии (журнал).
 * GET  /api/trainer/stats    — агрегаты по бумаге / таймфрейму / бумаге+ТФ / действиям.
 *
 * Таблицы: trainer_sessions / trainer_trades
 * (01_multilogictrade_tables_and_data.sql + sql/upgrade_trainer_results.sql).
 */
module.exports = function registerTrainerRoutes(app, ctx) {
  const { pool, parseId } = ctx;

  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  // Сохранение сессии: upsert по session_key + полная замена сделок.
  app.post('/api/trainer/sessions', async (req, res) => {
    const b = req.body || {};
    const sessionKey = String(b.session_key || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionKey)) {
      return res.status(400).json({ error: 'session_key must be a UUID' });
    }
    const trades = Array.isArray(b.trades) ? b.trades : [];
    const closed = trades.filter((t) => !t.is_open && num(t.pnl) != null);
    const wins = closed.filter((t) => num(t.pnl) > 0).length;
    const losses = closed.length - wins;
    const totalPnl = num(b.total_pnl) ?? 0;
    const unrealized = num(b.unrealized_pnl) ?? 0;
    const holdingSum = closed.reduce((s, t) => s + Math.max(0, num(t.holding_ms) ?? 0), 0);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `
        INSERT INTO trainer_sessions (
          session_key, security_id, timeframe_id, security_name, timeframe_tf,
          started_at, ended_at, trading_ms, commission_pct, exec_delay_sec, finished,
          trades_count, wins_count, losses_count,
          total_pnl, unrealized_pnl, total_pnl_with_unrealized,
          annual_pct, avg_holding_ms, avg_exec_delay_sec, updated_at
        ) VALUES (
          $1::uuid, $2, $3, $4, $5,
          $6::timestamp, $7::timestamp, $8, $9, $10, $11,
          $12, $13, $14,
          $15, $16, $17,
          $18, $19, $20, now()
        )
        ON CONFLICT (session_key) DO UPDATE SET
          security_id = EXCLUDED.security_id,
          timeframe_id = EXCLUDED.timeframe_id,
          security_name = EXCLUDED.security_name,
          timeframe_tf = EXCLUDED.timeframe_tf,
          started_at = EXCLUDED.started_at,
          ended_at = EXCLUDED.ended_at,
          trading_ms = EXCLUDED.trading_ms,
          commission_pct = EXCLUDED.commission_pct,
          exec_delay_sec = EXCLUDED.exec_delay_sec,
          finished = EXCLUDED.finished,
          trades_count = EXCLUDED.trades_count,
          wins_count = EXCLUDED.wins_count,
          losses_count = EXCLUDED.losses_count,
          total_pnl = EXCLUDED.total_pnl,
          unrealized_pnl = EXCLUDED.unrealized_pnl,
          total_pnl_with_unrealized = EXCLUDED.total_pnl_with_unrealized,
          annual_pct = EXCLUDED.annual_pct,
          avg_holding_ms = EXCLUDED.avg_holding_ms,
          avg_exec_delay_sec = EXCLUDED.avg_exec_delay_sec,
          updated_at = now()
        RETURNING id
        `,
        [
          sessionKey,
          parseId(b.security_id) || null,
          parseId(b.timeframe_id) || null,
          b.security_name ? String(b.security_name) : null,
          b.timeframe_tf ? String(b.timeframe_tf).slice(0, 16) : null,
          b.started_at || null,
          b.ended_at || null,
          num(b.trading_ms),
          num(b.commission_pct) ?? 0,
          parseId(b.exec_delay_sec) ?? 0,
          Boolean(b.finished),
          closed.length,
          wins,
          losses,
          totalPnl,
          unrealized,
          totalPnl + unrealized,
          num(b.annual_pct),
          closed.length > 0 ? Math.round(holdingSum / closed.length) : null,
          num(b.avg_exec_delay_sec),
        ]
      );
      const sessionId = rows[0].id;
      await client.query('DELETE FROM trainer_trades WHERE session_id = $1', [sessionId]);
      for (let i = 0; i < trades.length; i++) {
        const t = trades[i];
        const side = t.side === 'short' ? 'short' : 'long';
        await client.query(
          `
          INSERT INTO trainer_trades (
            session_id, seq, side, open_dt, open_price, close_dt, close_price,
            commission, pnl, pnl_pct, annual_pct, holding_ms, is_open
          ) VALUES ($1, $2, $3, $4::timestamp, $5, $6::timestamp, $7, $8, $9, $10, $11, $12, $13)
          `,
          [
            sessionId,
            i + 1,
            side,
            t.open_dt || null,
            num(t.open_price) ?? 0,
            t.close_dt || null,
            num(t.close_price),
            num(t.commission) ?? 0,
            num(t.pnl),
            num(t.pnl_pct),
            num(t.annual_pct),
            num(t.holding_ms),
            Boolean(t.is_open),
          ]
        );
      }
      await client.query('COMMIT');
      res.json({ id: sessionId, session_key: sessionKey });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('POST /api/trainer/sessions', err);
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  // Журнал последних сессий.
  app.get('/api/trainer/sessions', async (req, res) => {
    const limit = Math.min(parseId(req.query.limit) || 100, 500);
    try {
      const { rows } = await pool.query(
        `
        SELECT
          s.id, s.session_key::text AS session_key, s.created_at, s.updated_at,
          s.security_id, s.timeframe_id, s.security_name, s.timeframe_tf,
          s.started_at, s.ended_at, s.trading_ms, s.finished,
          s.trades_count, s.wins_count, s.losses_count,
          s.total_pnl, s.unrealized_pnl, s.total_pnl_with_unrealized,
          s.annual_pct, s.avg_holding_ms, s.avg_exec_delay_sec,
          sec.name AS security_name_ref, tf.tf AS timeframe_tf_ref
        FROM trainer_sessions s
        LEFT JOIN securities sec ON sec.id = s.security_id
        LEFT JOIN timeframes tf ON tf.id = s.timeframe_id
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT $1
        `,
        [limit]
      );
      res.json({ rows });
    } catch (err) {
      console.error('GET /api/trainer/sessions', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Статистика по всем сессиям: бумага / таймфрейм / бумага+ТФ / действия (long/short).
  app.get('/api/trainer/stats', async (_req, res) => {
    // Агрегат сделок в разрезе; сессии считаются отдельно (DISTINCT session_id).
    const groupSql = (groupCols, selectCols, joins = '') => `
      SELECT
        ${selectCols},
        COUNT(DISTINCT t.session_id)::int AS sessions,
        COUNT(*) FILTER (WHERE NOT t.is_open)::int AS trades,
        COUNT(*) FILTER (WHERE NOT t.is_open AND t.pnl > 0)::int AS wins,
        COUNT(*) FILTER (WHERE NOT t.is_open AND t.pnl <= 0)::int AS losses,
        COALESCE(SUM(t.pnl), 0)::float AS net_pnl,
        COALESCE(SUM(t.commission), 0)::float AS commission,
        AVG(t.holding_ms) FILTER (WHERE NOT t.is_open)::float AS avg_holding_ms,
        COALESCE(SUM(t.pnl) FILTER (WHERE t.side = 'long'), 0)::float AS long_pnl,
        COALESCE(SUM(t.pnl) FILTER (WHERE t.side = 'short'), 0)::float AS short_pnl,
        COUNT(*) FILTER (WHERE NOT t.is_open AND t.side = 'long' AND t.pnl > 0)::int AS long_wins,
        COUNT(*) FILTER (WHERE NOT t.is_open AND t.side = 'long' AND t.pnl <= 0)::int AS long_losses,
        COUNT(*) FILTER (WHERE NOT t.is_open AND t.side = 'short' AND t.pnl > 0)::int AS short_wins,
        COUNT(*) FILTER (WHERE NOT t.is_open AND t.side = 'short' AND t.pnl <= 0)::int AS short_losses
      FROM trainer_trades t
      JOIN trainer_sessions s ON s.id = t.session_id
      ${joins}
      GROUP BY ${groupCols}
    `;
    const secJoin = 'LEFT JOIN securities sec ON sec.id = s.security_id';
    const tfJoin = 'LEFT JOIN timeframes tf ON tf.id = s.timeframe_id';
    try {
      const [bySecurity, byTimeframe, bySecurityTf, bySide, totals] = await Promise.all([
        pool.query(
          groupSql('s.security_id', `
            s.security_id,
            COALESCE(MAX(sec.name), MAX(s.security_name), '—') AS security_name`, secJoin) +
          ' ORDER BY net_pnl DESC'
        ),
        pool.query(
          groupSql('s.timeframe_id', `
            s.timeframe_id,
            COALESCE(MAX(tf.tf), MAX(s.timeframe_tf), '—') AS timeframe_tf`, tfJoin) +
          ' ORDER BY net_pnl DESC'
        ),
        pool.query(
          groupSql('s.security_id, s.timeframe_id', `
            s.security_id, s.timeframe_id,
            COALESCE(MAX(sec.name), MAX(s.security_name), '—') AS security_name,
            COALESCE(MAX(tf.tf), MAX(s.timeframe_tf), '—') AS timeframe_tf`, `${secJoin} ${tfJoin}`) +
          ' ORDER BY net_pnl DESC'
        ),
        pool.query(`
          SELECT
            t.side,
            COUNT(*) FILTER (WHERE NOT t.is_open)::int AS trades,
            COUNT(*) FILTER (WHERE NOT t.is_open AND t.pnl > 0)::int AS wins,
            COUNT(*) FILTER (WHERE NOT t.is_open AND t.pnl <= 0)::int AS losses,
            COALESCE(SUM(t.pnl), 0)::float AS net_pnl,
            AVG(t.holding_ms) FILTER (WHERE NOT t.is_open)::float AS avg_holding_ms
          FROM trainer_trades t
          GROUP BY t.side
          ORDER BY t.side
        `),
        pool.query(`
          SELECT
            COUNT(*)::int AS sessions,
            COUNT(*) FILTER (WHERE finished)::int AS finished_sessions,
            COALESCE(SUM(total_pnl_with_unrealized), 0)::float AS net_pnl,
            COALESCE(SUM(trades_count), 0)::int AS trades,
            COALESCE(SUM(wins_count), 0)::int AS wins,
            COALESCE(SUM(losses_count), 0)::int AS losses,
            AVG(avg_holding_ms)::float AS avg_holding_ms,
            COALESCE(SUM(trading_ms), 0)::float AS trading_ms,
            MIN(started_at) AS first_started_at,
            MAX(ended_at) AS last_ended_at
          FROM trainer_sessions
        `),
      ]);
      res.json({
        totals: totals.rows[0] || {},
        bySecurity: bySecurity.rows,
        byTimeframe: byTimeframe.rows,
        bySecurityTimeframe: bySecurityTf.rows,
        bySide: bySide.rows,
      });
    } catch (err) {
      console.error('GET /api/trainer/stats', err);
      res.status(500).json({ error: err.message });
    }
  });
};
