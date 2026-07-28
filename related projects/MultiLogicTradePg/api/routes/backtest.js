/**
 * Logic backtest start/status/cancel/reports.
 */
module.exports = function registerBacktestRoutes(app, ctx) {
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

app.post('/api/logic-backtest/start', async (req, res) => {
  const logicId = Number(req.body?.logic_id);
  const dateFrom = btrimStr(req.body?.date_from);
  const dateTo = btrimStr(req.body?.date_to);
  if (!Number.isInteger(logicId) || logicId <= 0) {
    res.status(400).json({ error: 'logic_id required' });
    return;
  }
  if (!dateFrom || !dateTo) {
    res.status(400).json({ error: 'date_from and date_to required (YYYY-MM-DD)' });
    return;
  }
  try {
    const { rows: active } = await pool.query(
      `SELECT id FROM logic_backtest_runs
       WHERE logic_id = $1 AND status IN ('pending','loading_prices','loading_indicators','running')
       LIMIT 1`,
      [logicId]
    );
    if (active.length > 0) {
      res.status(409).json({ error: 'Тестирование уже выполняется', run_id: active[0].id });
      return;
    }
    const optGrid =
      req.body?.opt_grid && typeof req.body.opt_grid === 'object'
        ? req.body.opt_grid
        : null;
    const runId = await startBacktest(pool, logicId, dateFrom, dateTo, optGrid);
    res.status(202).json({ ok: true, run_id: runId });
  } catch (err) {
    console.error('POST /api/logic-backtest/start', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logic-backtest/status', async (req, res) => {
  const logicId = Number(req.query.logic_id);
  const runId = req.query.run_id != null ? Number(req.query.run_id) : null;
  if (!Number.isInteger(logicId) || logicId <= 0) {
    res.status(400).json({ error: 'logic_id required' });
    return;
  }
  try {
    const row = await getBacktestStatus(pool, logicId, runId);
    if (!row) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    res.json(row);
  } catch (err) {
    console.error('GET /api/logic-backtest/status', err);
    res.status(500).json({ error: err.message });
  }
});

/** All in-progress backtests (UI recover after leaving /operations tab). */
app.get('/api/logic-backtest/active', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT DISTINCT ON (r.logic_id)
        r.id, r.logic_id,
        r.date_from::text AS date_from,
        r.date_to::text AS date_to,
        r.status,
        r.progress_pct::float8 AS progress_pct,
        r.phase_message, r.phase_detail, r.current_bar_dt,
        r.total_bars, r.processed_bars, r.trades_created,
        r.test_balance::float8 AS test_balance,
        r.financial_result::float8 AS financial_result,
        r.cancel_requested, r.error_message, r.started_at, r.finished_at, r.created_at,
        (r.opt_grid_arms IS NOT NULL AND jsonb_typeof(r.opt_grid_arms) = 'array'
          AND jsonb_array_length(r.opt_grid_arms) > 0) AS opt_grid_enabled,
        r.opt_grid_results
      FROM logic_backtest_runs r
      WHERE r.status IN ('pending', 'loading_prices', 'loading_indicators', 'running')
      ORDER BY r.logic_id, r.id DESC
      `
    );
    res.json({ rows });
  } catch (err) {
    console.error('GET /api/logic-backtest/active', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logic-backtest/cancel', async (req, res) => {
  const runId = Number(req.body?.run_id);
  if (!Number.isInteger(runId) || runId <= 0) {
    res.status(400).json({ error: 'run_id required' });
    return;
  }
  try {
    const ok = await cancelBacktest(pool, runId);
    if (!ok) {
      res.status(404).json({ error: 'Run not found or already finished' });
      return;
    }
    res.json({ ok: true, run_id: runId });
  } catch (err) {
    console.error('POST /api/logic-backtest/cancel', err);
    res.status(500).json({ error: err.message });
  }
});

/** Archived backtest HTML reports (PostgreSQL). */
app.get('/api/logic-backtest/reports', async (req, res) => {
  try {
    const logicId =
      req.query.logic_id != null && req.query.logic_id !== ''
        ? Number(req.query.logic_id)
        : null;
    const rows = await listBacktestReports(pool, {
      limit: req.query.limit,
      offset: req.query.offset,
      logicId,
    });
    res.json({ rows });
  } catch (err) {
    console.error('GET /api/logic-backtest/reports', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logic-backtest/reports/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'id required' });
    return;
  }
  try {
    const includeHtml =
      req.query.html === '1' ||
      req.query.html === 'true' ||
      req.query.html === undefined;
    const neighbors = await getBacktestReportNeighbors(pool, id);
    if (!neighbors?.current) {
      res.status(404).json({ error: 'Report not found' });
      return;
    }
    const row = { ...neighbors.current };
    if (!includeHtml) {
      delete row.html_body;
    }
    res.json({
      row,
      prev_id: neighbors.prev_id,
      next_id: neighbors.next_id,
    });
  } catch (err) {
    console.error('GET /api/logic-backtest/reports/:id', err);
    res.status(500).json({ error: err.message });
  }
});

/** Rebuild archive for an existing run (manual / backfill). */
app.post('/api/logic-backtest/reports/rebuild', async (req, res) => {
  const runId = Number(req.body?.run_id);
  if (!Number.isInteger(runId) || runId <= 0) {
    res.status(400).json({ error: 'run_id required' });
    return;
  }
  try {
    const row = await persistBacktestReport(pool, runId, { isSnapshot: false });
    if (!row) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    res.json({ ok: true, id: row.id, run_id: row.run_id });
  } catch (err) {
    console.error('POST /api/logic-backtest/reports/rebuild', err);
    res.status(500).json({ error: err.message });
  }
});
};
