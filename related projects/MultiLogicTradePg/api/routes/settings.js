/**
 * Health, settings, maintenance cleanup.
 */
module.exports = function registerSettingsRoutes(app, ctx) {
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

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, database: process.env.PGDATABASE || 'multilogictrade' });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

app.get('/api/settings/tbank-token', async (req, res) => {
  const validate = req.query.validate === '1' || req.query.validate === 'true';
  try {
    if (validate) {
      const { rows } = await pool.query(
        'SELECT tbank_verify_token() AS status'
      );
      const status = rows[0]?.status ?? {};
      res.json({
        has_token: Boolean(status.has_token),
        valid: Boolean(status.valid),
        error_message: status.error_message ?? null,
      });
      return;
    }
    const { rows } = await pool.query(
      'SELECT tbank_token_is_configured() AS has_token'
    );
    res.json({ has_token: Boolean(rows[0]?.has_token) });
  } catch (err) {
    console.error('GET /api/settings/tbank-token', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings/tbank-token', async (req, res) => {
  const token =
    typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!token) {
    res.status(400).json({ error: 'Укажите токен T-Bank' });
    return;
  }
  try {
    // Сохраняем предыдущий токен: verify идёт после UPSERT — при ошибке откатываем
    const { rows: prevRows } = await pool.query(
      `SELECT btrim(COALESCE(pv.value, '')) AS token
       FROM parameter_values pv
       JOIN parameter_types pt ON pt.id = pv.parameter_type_id
       JOIN parameter_sets ps ON ps.id = pv.parameter_set_id
       WHERE ps.name = 'Default' AND pt.short_name = 'TBANK_API_TOKEN'
       LIMIT 1`
    );
    const previousToken = prevRows[0]?.token || '';

    await pool.query('CALL set_tbank_token($1)', [token]);
    const { rows } = await pool.query('SELECT tbank_verify_token() AS status');
    const status = rows[0]?.status ?? {};
    if (!status.valid) {
      if (previousToken && previousToken !== token) {
        await pool.query('CALL set_tbank_token($1)', [previousToken]);
      }
      res.status(400).json({
        error:
          status.error_message ||
          'T-Bank не принял токен. Предыдущий токен восстановлен.',
        has_token: previousToken !== '',
        valid: false,
        error_message: status.error_message ?? null,
      });
      return;
    }
    res.json({
      ok: true,
      has_token: true,
      valid: true,
      error_message: null,
    });
  } catch (err) {
    console.error('PUT /api/settings/tbank-token', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/settings/tech-logging', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT app_tech_logging_enabled() AS enabled'
    );
    res.json({ enabled: Boolean(rows[0]?.enabled) });
  } catch (err) {
    console.error('GET /api/settings/tech-logging', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings/tech-logging', async (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  try {
    await pool.query('CALL set_app_tech_logging($1)', [enabled]);
    if (enabled) {
      await writeTechLogEvent(pool, {
        threadKey: 'settings',
        operation: 'logging.enabled',
        message: 'Техническое логирование включено (UI)',
        source: 'api',
      });
    }
    res.json({ ok: true, enabled });
  } catch (err) {
    console.error('PUT /api/settings/tech-logging', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/settings/cleanup', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT cleanup_unused_market_data_enabled() AS enabled'
    );
    res.json({ enabled: Boolean(rows[0]?.enabled) });
  } catch (err) {
    console.error('GET /api/settings/cleanup', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings/cleanup', async (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  try {
    await pool.query('CALL set_cleanup_unused_market_data($1)', [enabled]);
    res.json({ ok: true, enabled });
  } catch (err) {
    console.error('PUT /api/settings/cleanup', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/maintenance/cleanup', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT cleanup_trading_disk_space() AS result'
    );
    const result = rows[0]?.result ?? {};
    if (result && result.skipped) {
      return res.status(409).json({
        ok: false,
        skipped: true,
        error: result.message || result.reason || 'cleanup_lock_busy',
        result,
      });
    }
    res.json({ ok: true, result });
  } catch (err) {
    console.error('POST /api/maintenance/cleanup', err);
    const msg = String(err.message || '');
    // Типичные ошибки при пересечении с боем: lock_timeout / statement_timeout
    if (/lock timeout|canceling statement due to|statement timeout/i.test(msg)) {
      return res.status(409).json({
        error:
          'Очистка прервана из‑за блокировок Postgres (бой/загрузка цен). Повторите, когда торговля спокойнее, или выключите галочку.',
        detail: msg,
      });
    }
    res.status(500).json({ error: err.message });
  }
});
};
