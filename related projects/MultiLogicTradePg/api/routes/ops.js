/**
 * Tech log, processes strip, schema tree.
 */
module.exports = function registerOpsRoutes(app, ctx) {
  const {
    pool,
    hashToken,
    startBacktest,
    getBacktestStatus,
    cancelBacktest,
    resolveLastOptGridResults,
    listBacktestReports,
    getBacktestReport,
    getBacktestReportNeighbors,
    persistBacktestReport,
    startRatingPrecalc,
    getRatingPrecalcStatus,
    runTradeCycle,
    touchUiHeartbeatDb,
    clearUiHeartbeatDb,
    isUiSessionActive,
    validateOptFormulaSave,
    getTradingParams,
    getTradingParamsForLogics,
    saveTradingParams,
    ensureDefaultParams,
    getLogicParamsDetailed,
    syncRealAccountBalancesIfNeeded,
    resetLogicTradingStateOnAccountChange,
    resetLogicShadowTradingState,
    buildLogicBundle,
    importLogicBundle,
    writeTechLogEvent,
    assertRealTbankAccount,
    sellAllPositions,
    planBuyBonds,
    executeBuyBonds,
    listBondFunds,
    getAccountCash,
    isScopeValidForRuleKind,
    isScopeChoosableForRuleKind,
    localIsoDate,
    shiftLocalDate,
    logicNeedsWarmup,
    watchWarmupBacktest,
    rewriteFormulaBasesNode,
    parseTimeHm,
    fetchNonTradingIntervals,
    btrimStr,
    formatColumn,
    formatConstraint,
    formatRoutine,
    parseLogicTradingParams,
    parseLogicBody,
    parseId,
    parseDateString,
    parseBrokerBody,
    parseExchangeBody,
    parseIndicatorBody,
    parseIndicatorCreateBody,
    runIndicatorSyncBackground,
    fetchIndicatorById,
    parseSecurityBody,
    parseAccountBody,
    fillRealTbankAccountFromToken,
    tokenFieldsFromParsed,
    buildTokenUpdateClause,
    stripAccountSecrets,
    enrichAccountBalance,
    resolveAccountConnection,
    handleDbError,
  } = ctx;

app.post('/api/tech-log', async (req, res) => {
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
  if (entries.length === 0) {
    res.status(400).json({ error: 'Укажите entries[]' });
    return;
  }
  if (entries.length > 200) {
    res.status(400).json({ error: 'Не более 200 записей за раз' });
    return;
  }

  const client = await pool.connect();
  try {
    const { rows: flagRows } = await client.query(
      'SELECT app_tech_logging_enabled() AS enabled'
    );
    if (!flagRows[0]?.enabled) {
      res.json({ ok: true, inserted: 0, skipped: true });
      return;
    }

    let inserted = 0;
    for (const raw of entries) {
      const traceId = btrimStr(raw.trace_id);
      const spanId = btrimStr(raw.span_id);
      const threadKey = btrimStr(raw.thread_key);
      const operation = btrimStr(raw.operation);
      const phase = btrimStr(raw.phase);
      if (!traceId || !spanId || !threadKey || !operation || !phase) {
        continue;
      }
      if (!['start', 'end', 'event'].includes(phase)) {
        continue;
      }
      await client.query(
        `
        INSERT INTO app_tech_log (
          trace_id, span_id, parent_span_id, thread_key, source, operation, phase,
          started_at, finished_at, duration_ms,
          security_id, timeframe_id, logic_id, sync_gen, message, payload
        ) VALUES (
          $1::uuid, $2, $3, $4, COALESCE(NULLIF($5, ''), 'web'), $6, $7,
          COALESCE($8::timestamptz, CURRENT_TIMESTAMP),
          $9::timestamptz, $10,
          $11, $12, $13, $14, $15, $16::jsonb
        )
        `,
        [
          traceId,
          spanId,
          raw.parent_span_id ? btrimStr(raw.parent_span_id) : null,
          threadKey,
          raw.source ? btrimStr(raw.source) : 'web',
          operation,
          phase,
          raw.started_at ? String(raw.started_at) : null,
          raw.finished_at ? String(raw.finished_at) : null,
          raw.duration_ms != null ? Number(raw.duration_ms) : null,
          parseId(raw.security_id) || null,
          parseId(raw.timeframe_id) || null,
          parseId(raw.logic_id) || null,
          parseId(raw.sync_gen) || null,
          raw.message != null ? String(raw.message) : null,
          raw.payload != null ? JSON.stringify(raw.payload) : null,
        ]
      );
      inserted += 1;
    }
    res.json({ ok: true, inserted });
  } catch (err) {
    console.error('POST /api/tech-log', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/tech-log', async (req, res) => {
  const limit = Math.min(parseId(req.query.limit) || 100, 500);
  const securityId = parseId(req.query.security_id);
  const logicId = parseId(req.query.logic_id);
  const traceId = req.query.trace_id ? String(req.query.trace_id).trim() : null;
  const since = req.query.since ? String(req.query.since).trim() : null;

  const where = [];
  const params = [];
  let idx = 1;
  if (securityId) {
    where.push(`security_id = $${idx++}`);
    params.push(securityId);
  }
  if (logicId) {
    where.push(`logic_id = $${idx++}`);
    params.push(logicId);
  }
  if (traceId) {
    where.push(`trace_id::text = $${idx++}`);
    params.push(traceId);
  }
  if (since) {
    where.push(`created_at >= $${idx++}::timestamptz`);
    params.push(since);
  }
  params.push(limit);
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  try {
    const { rows } = await pool.query(
      `
      SELECT
        id, trace_id::text AS trace_id, span_id, parent_span_id, thread_key, source,
        operation, phase, started_at, finished_at, duration_ms,
        security_id, timeframe_id, logic_id, sync_gen, message, payload, created_at
      FROM app_tech_log
      ${whereSql}
      ORDER BY id DESC
      LIMIT $${idx}
      `,
      params
    );
    res.json({ rows });
  } catch (err) {
    console.error('GET /api/tech-log', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/processes', async (_req, res) => {
  const rows = [];
  try {
    const active = await pool.query(`
      SELECT
        pid,
        state,
        wait_event_type,
        wait_event,
        now() - COALESCE(query_start, xact_start, backend_start) AS age,
        left(regexp_replace(COALESCE(query, ''), '\\s+', ' ', 'g'), 180) AS query
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND state <> 'idle'
      ORDER BY COALESCE(query_start, xact_start, backend_start) NULLS LAST
      LIMIT 20
    `);
    for (const r of active.rows) {
      rows.push({
        type: 'postgres',
        label: `PostgreSQL pid ${r.pid}`,
        status: r.state || 'active',
        detail: r.query || '',
        wait: [r.wait_event_type, r.wait_event].filter(Boolean).join(':') || null,
        age: String(r.age || ''),
      });
    }

    const backtests = await pool.query(`
      SELECT
        r.logic_id,
        l.name AS logic_name,
        r.status,
        COALESCE(r.progress_pct, 0) AS progress_pct,
        r.phase_message,
        r.phase_detail,
        r.started_at
      FROM logic_backtest_runs r
      JOIN logics l ON l.id = r.logic_id
      WHERE r.status IN ('pending', 'loading_prices', 'loading_indicators', 'running')
      ORDER BY r.started_at DESC
      LIMIT 20
    `);
    for (const r of backtests.rows) {
      rows.push({
        type: 'backtest',
        label: `Test: ${r.logic_name}`,
        status: r.status,
        detail: [r.phase_message, r.phase_detail].filter(Boolean).join(' — '),
        progress_pct: Number(r.progress_pct) || 0,
        logic_id: r.logic_id,
        started_at: r.started_at,
      });
    }

    const enabled = await pool.query(`
      SELECT COUNT(*)::int AS cnt
      FROM logics
      WHERE is_enabled = TRUE
    `);
    const enabledCount = Number(enabled.rows[0]?.cnt) || 0;
    if (enabledCount > 0) {
      rows.push({
        type: 'trade_runner',
        label: 'Trade runner',
        status: 'scheduled',
        detail: `${enabledCount} enabled logic(s), Node fallback interval ${process.env.TRADE_RUNNER_INTERVAL_MS || 15000} ms`,
      });
    }

    try {
      const cronExists = await pool.query(`SELECT to_regclass('cron.job') AS job_table`);
      if (cronExists.rows[0]?.job_table) {
        const cron = await pool.query(`
          SELECT jobid, schedule, command, active
          FROM cron.job
          WHERE command ILIKE '%run_trade_cycle%'
          ORDER BY jobid
          LIMIT 10
        `);
        for (const r of cron.rows) {
          rows.push({
            type: 'pg_cron',
            label: `pg_cron job ${r.jobid}`,
            status: r.active ? 'active' : 'disabled',
            detail: `${r.schedule}: ${r.command}`,
          });
        }
      }
    } catch (cronErr) {
      rows.push({
        type: 'pg_cron',
        label: 'pg_cron',
        status: 'unavailable',
        detail: cronErr.message,
      });
    }

    res.json({ rows });
  } catch (err) {
    console.error('GET /api/processes', err);
    res.status(500).json({ error: err.message, rows });
  }
});
app.get('/api/schema', async (_req, res) => {
  try {
    const [tablesResult, routinesResult, extensionsResult] = await Promise.all([
      pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `),
      pool.query(`
        SELECT
          p.oid,
          p.proname AS name,
          p.prokind AS kind,
          pg_get_function_identity_arguments(p.oid) AS arguments,
          pg_get_function_result(p.oid) AS result_type,
          obj_description(p.oid, 'pg_proc') AS description
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.prokind IN ('f', 'p')
          -- не тащим функции расширений (pgsql-http и т.п.) — только прикладные из 02
          AND NOT EXISTS (
            SELECT 1
            FROM pg_depend d
            JOIN pg_extension e ON e.oid = d.refobjid
            WHERE d.objid = p.oid
              AND d.deptype = 'e'
          )
        ORDER BY p.prokind, p.proname, p.oid
      `),
      pool.query(`
        SELECT extname AS name, extversion AS version
        FROM pg_extension
        ORDER BY extname
      `),
    ]);

    const tables = [];
    for (const { table_name } of tablesResult.rows) {
      const [columns, indexes, constraints, tableComment] = await Promise.all([
        pool.query(
          `
          SELECT
            c.column_name,
            c.data_type,
            c.udt_name,
            c.is_nullable,
            c.column_default,
            c.character_maximum_length,
            c.numeric_precision,
            c.numeric_scale,
            c.ordinal_position,
            pg_catalog.col_description(cls.oid, c.ordinal_position) AS comment
          FROM information_schema.columns c
          JOIN pg_catalog.pg_class cls ON cls.relname = c.table_name
          JOIN pg_catalog.pg_namespace n ON n.oid = cls.relnamespace AND n.nspname = c.table_schema
          WHERE c.table_schema = 'public' AND c.table_name = $1
          ORDER BY c.ordinal_position
          `,
          [table_name]
        ),
        pool.query(
          `
          SELECT indexname AS name, indexdef AS definition
          FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = $1
          ORDER BY indexname
          `,
          [table_name]
        ),
        pool.query(
          `
          SELECT
            c.conname AS name,
            c.contype AS type,
            pg_get_constraintdef(c.oid) AS definition
          FROM pg_constraint c
          JOIN pg_class rel ON rel.oid = c.conrelid
          JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
          WHERE nsp.nspname = 'public' AND rel.relname = $1
          ORDER BY c.conname
          `,
          [table_name]
        ),
        pool.query(
          `
          SELECT obj_description(c.oid, 'pg_class') AS comment
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = $1
          `,
          [table_name]
        ),
      ]);

      tables.push({
        name: table_name,
        comment: tableComment.rows[0]?.comment || null,
        columns: columns.rows.map(formatColumn),
        indexes: indexes.rows,
        constraints: constraints.rows.map(formatConstraint),
      });
    }

    res.json({
      schema: 'public',
      database: process.env.PGDATABASE || 'multilogictrade',
      sourceMode: 'live',
      sourceNote:
        'Структура из подключённой PostgreSQL (таблицы, колонки, индексы, ограничения; все функции/процедуры public кроме расширений).',
      tables,
      routines: routinesResult.rows.map(formatRoutine),
      extensions: extensionsResult.rows,
    });
  } catch (err) {
    console.error('GET /api/schema', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/schema/routine/:oid/source', async (req, res) => {
  const oid = Number(req.params.oid);
  if (!Number.isInteger(oid) || oid <= 0) {
    res.status(400).json({ error: 'Invalid routine oid' });
    return;
  }
  try {
    const { rows } = await pool.query(
      `
      SELECT
        p.proname AS name,
        p.prokind AS kind,
        pg_get_function_identity_arguments(p.oid) AS arguments,
        pg_get_functiondef(p.oid) AS source
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.oid = $1
      `,
      [oid]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Routine not found' });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /api/schema/routine/:oid/source', err);
    res.status(500).json({ error: err.message });
  }
});
};
