/**
 * Brokers, exchanges, accounts (sell-all / bonds).
 */
module.exports = function registerReferencesRoutes(app, ctx) {
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
    listRealAccountsWithBonds,
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
    pgResolveTbankAccount,
    pgFetchTbankPortfolioBalance,
    resolveAccountConnection,
    handleDbError,
  } = ctx;

app.get('/api/brokers', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, code, name, api_url, is_active
      FROM brokers
      ORDER BY code
    `);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/brokers', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/brokers', async (req, res) => {
  const parsed = parseBrokerBody(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO brokers (code, name, api_url, is_active)
       VALUES ($1, $2, $3, $4)
       RETURNING id, code, name, api_url, is_active`,
      [parsed.code, parsed.name, parsed.api_url, parsed.is_active]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    handleDbError(res, err, 'POST /api/brokers');
  }
});

app.put('/api/brokers/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'Invalid broker id' });
    return;
  }
  const parsed = parseBrokerBody(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const { rows } = await pool.query(
      `UPDATE brokers SET code = $1, name = $2, api_url = $3, is_active = $4
       WHERE id = $5
       RETURNING id, code, name, api_url, is_active`,
      [parsed.code, parsed.name, parsed.api_url, parsed.is_active, id]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Broker not found' });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    handleDbError(res, err, 'PUT /api/brokers/:id');
  }
});

app.delete('/api/brokers/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'Invalid broker id' });
    return;
  }
  try {
    const { rowCount } = await pool.query('DELETE FROM brokers WHERE id = $1', [id]);
    if (rowCount === 0) {
      res.status(404).json({ error: 'Broker not found' });
      return;
    }
    res.json({ ok: true, id });
  } catch (err) {
    handleDbError(res, err, 'DELETE /api/brokers/:id');
  }
});

app.get('/api/exchanges', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, name FROM exchanges ORDER BY name
    `);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/exchanges', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/exchanges', async (req, res) => {
  const parsed = parseExchangeBody(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO exchanges (name) VALUES ($1) RETURNING id, name`,
      [parsed.name]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    handleDbError(res, err, 'POST /api/exchanges');
  }
});

app.put('/api/exchanges/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'Invalid exchange id' });
    return;
  }
  const parsed = parseExchangeBody(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const { rows } = await pool.query(
      `UPDATE exchanges SET name = $1 WHERE id = $2 RETURNING id, name`,
      [parsed.name, id]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Exchange not found' });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    handleDbError(res, err, 'PUT /api/exchanges/:id');
  }
});

app.delete('/api/exchanges/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'Invalid exchange id' });
    return;
  }
  try {
    const { rowCount } = await pool.query('DELETE FROM exchanges WHERE id = $1', [id]);
    if (rowCount === 0) {
      res.status(404).json({ error: 'Exchange not found' });
      return;
    }
    res.json({ ok: true, id });
  } catch (err) {
    handleDbError(res, err, 'DELETE /api/exchanges/:id');
  }
});

app.get('/api/accounts', async (req, res) => {
  try {
    const brokerId = req.query.broker_id ? Number(req.query.broker_id) : null;
    const withBalance = req.query.with_balance === '1' || req.query.with_balance === 'true';
    const params = [];
    let where = '';
    if (brokerId && Number.isInteger(brokerId) && brokerId > 0) {
      where = 'WHERE a.broker_id = $1';
      params.push(brokerId);
    }
    const { rows } = await pool.query(
      `
      SELECT
        a.id,
        a.broker_id,
        a.account_code,
        a.name,
        a.account_type,
        a.is_efficient,
        a.is_active,
        (a.token_encrypted IS NOT NULL AND btrim(a.token_encrypted) <> '') AS has_token,
        b.code AS broker_code,
        b.name AS broker_name,
        b.api_url AS broker_api_url
      FROM accounts a
      JOIN brokers b ON b.id = a.broker_id
      ${where}
      ORDER BY b.code, a.account_code
      `,
      params
    );
    if (!withBalance) {
      res.json(rows.map(stripAccountSecrets));
      return;
    }
    const enriched = await Promise.all(
      rows.map((row) => enrichAccountBalance(row))
    );
    res.json(enriched.map(stripAccountSecrets));
  } catch (err) {
    console.error('GET /api/accounts', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/accounts/preview-connection', async (req, res) => {
  try {
    const preview = await resolveAccountConnection(req.body);
    if (preview.error) {
      res.status(400).json({ error: preview.error });
      return;
    }
    const resolved = await pgResolveTbankAccount(
      preview.broker_api_url,
      preview.token,
      preview.account_code || null
    );
    let balance = null;
    let balance_error = null;
    try {
      balance = await pgFetchTbankPortfolioBalance(
        preview.broker_api_url,
        preview.token,
        resolved.account_id
      );
    } catch (balErr) {
      balance_error = balErr.message;
    }
    res.json({
      ok: true,
      accounts: resolved.accounts,
      selected_account_id: resolved.account_id,
      selected_account_name: resolved.account_name,
      accounts_found: resolved.accounts.length,
      balance: balance?.amount ?? null,
      balance_currency: balance?.currency ?? null,
      balance_display: balance?.display ?? null,
      balance_error,
    });
  } catch (err) {
    console.error('POST /api/accounts/preview-connection', err);
    res.status(502).json({ error: err.message || 'Не удалось проверить подключение' });
  }
});

app.post('/api/accounts', async (req, res) => {
  let parsed = parseAccountBody(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  parsed = await fillRealTbankAccountFromToken(parsed, req.body?.account_id);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  if (parsed.account_type === 'real' && !parsed.api_token && !parsed._has_stored_token) {
    res.status(400).json({ error: 'Для реального счёта укажите API-токен' });
    return;
  }
  try {
    const tokenFields = tokenFieldsFromParsed(parsed);
    const { rows } = await pool.query(
      `INSERT INTO accounts (broker_id, account_code, name, account_type, is_efficient, is_active, token_encrypted, token_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, broker_id, account_code, name, account_type, is_efficient, is_active,
         (token_encrypted IS NOT NULL AND btrim(token_encrypted) <> '') AS has_token`,
      [
        parsed.broker_id,
        parsed.account_code,
        parsed.name,
        parsed.account_type,
        parsed.is_efficient,
        parsed.is_active,
        tokenFields.token_encrypted,
        tokenFields.token_hash,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    handleDbError(res, err, 'POST /api/accounts');
  }
});

app.put('/api/accounts/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'Invalid account id' });
    return;
  }
  const parsed = parseAccountBody(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  let filled = await fillRealTbankAccountFromToken(parsed, id);
  if (filled.error) {
    res.status(400).json({ error: filled.error });
    return;
  }
  try {
    const tokenUpdate = buildTokenUpdateClause(filled, 8);
    const values = [
      filled.broker_id,
      filled.account_code,
      filled.name,
      filled.account_type,
      filled.is_efficient,
      filled.is_active,
      id,
      ...tokenUpdate.extraValues,
    ];
    const { rows } = await pool.query(
      `UPDATE accounts
       SET broker_id = $1, account_code = $2, name = $3, account_type = $4,
           is_efficient = $5, is_active = $6, updated_at = CURRENT_TIMESTAMP
           ${tokenUpdate.sql}
       WHERE id = $7
       RETURNING id, broker_id, account_code, name, account_type, is_efficient, is_active,
         (token_encrypted IS NOT NULL AND btrim(token_encrypted) <> '') AS has_token`,
      values
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    handleDbError(res, err, 'PUT /api/accounts/:id');
  }
});

app.delete('/api/accounts/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'Invalid account id' });
    return;
  }
  try {
    const { rowCount } = await pool.query('DELETE FROM accounts WHERE id = $1', [id]);
    if (rowCount === 0) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }
    res.json({ ok: true, id });
  } catch (err) {
    handleDbError(res, err, 'DELETE /api/accounts/:id');
  }
});

/** Фонды облигаций для покупки: TBRU, SBGB (RGBITR), OBLG/VTBB (RUCBTRNS). */
app.get('/api/accounts/bond-funds', (_req, res) => {
  res.json(listBondFunds());
});

/** Продать всё на реальном счёте T-Bank (акции, облигации, фонды…; валюту пропускаем). */
app.post('/api/accounts/:id/sell-all', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'Invalid account id' });
    return;
  }
  try {
    const result = await sellAllPositions(pool, id);
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('POST /api/accounts/:id/sell-all', err);
    res.status(status).json({ error: err.message || 'sell-all failed' });
  }
});

/** Свободный кэш реального счёта (для дефолта суммы покупки облигаций). */
app.get('/api/accounts/:id/cash', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'Invalid account id' });
    return;
  }
  try {
    await assertRealTbankAccount(pool, id);
    const cash = await getAccountCash(pool, id);
    res.json({ ok: true, account_id: id, ...cash });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('GET /api/accounts/:id/cash', err);
    res.status(status).json({ error: err.message || 'cash failed' });
  }
});

/** Реальные счета T-Bank, у которых в портфеле есть облигации (для выбора «Счёт»). */
app.get('/api/accounts/with-bonds', async (_req, res) => {
  try {
    const rows = await listRealAccountsWithBonds(pool);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/accounts/with-bonds', err);
    res.status(500).json({ error: err.message || 'with-bonds failed' });
  }
});

/**
 * План / покупка облигаций по составу фонда (TBRU / SBGB / OBLG) или по счёту
 * (fund_code='ACCOUNT', опционально target_account_id — купить на другом счёте):
 * body: { fund_code?, amount_rub?, execute?, target_account_id? }
 * Жадно от более доходных (часто корп.) к менее (ОФЗ).
 */
app.post('/api/accounts/:id/buy-bonds', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'Invalid account id' });
    return;
  }
  const execute = req.body?.execute === true || req.body?.execute === 'true';
  const opts = {
    fund_code: req.body?.fund_code || 'TBRU',
    amount_rub: req.body?.amount_rub,
    target_account_id: Number(req.body?.target_account_id) > 0
      ? Number(req.body.target_account_id)
      : undefined,
  };
  try {
    const result = execute
      ? await executeBuyBonds(pool, id, opts)
      : await planBuyBonds(pool, id, opts);
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('POST /api/accounts/:id/buy-bonds', err);
    res.status(status).json({ error: err.message || 'buy-bonds failed' });
  }
});
};
