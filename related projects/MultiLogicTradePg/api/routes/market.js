/**
 * Timeframes, securities, prices.
 */
module.exports = function registerMarketRoutes(app, ctx) {
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

app.get('/api/timeframes', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, tf, full_name, sec, is_active
      FROM timeframes
      WHERE is_active = TRUE
      ORDER BY sec
    `);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/timeframes', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/securities', async (req, res) => {
  const exchangeId = parseId(req.query.exchange_id);
  const kind = req.query.kind === 'futures' ? 'futures' : req.query.kind === 'stock' ? 'stock' : null;
  if (!exchangeId) {
    res.status(400).json({ error: 'Укажите exchange_id' });
    return;
  }
  try {
    let typeFilter = '';
    if (kind === 'stock') {
      typeFilter = `AND st.name IN ('Stock', 'PreferredStock') AND sp.instrument_market = 'stock'`;
    } else if (kind === 'futures') {
      typeFilter = `AND st.name = 'Futures' AND sp.instrument_market = 'futures'`;
    }
    const { rows } = await pool.query(
      `
      SELECT
        s.id,
        s.name,
        s.lot_size,
        st.name AS security_type,
        sp.prefix,
        sp.instrument_market,
        sp.exchange_id,
        e.name AS exchange_name
      FROM securities s
      JOIN security_types st ON st.id = s.security_type_id
      JOIN security_prefixes sp ON sp.security_id = s.id AND sp.exchange_id = $1
      JOIN exchanges e ON e.id = sp.exchange_id
      WHERE 1=1 ${typeFilter}
      ORDER BY s.name
    `,
      [exchangeId]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/securities', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/securities', async (req, res) => {
  const parsed = parseSecurityBody(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const typeName = parsed.kind === 'futures' ? 'Futures' : 'Stock';
    const { rows: typeRows } = await client.query(
      'SELECT id FROM security_types WHERE name = $1',
      [typeName]
    );
    if (typeRows.length === 0) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: `Тип ${typeName} не найден` });
      return;
    }
    const instrumentMarket = parsed.kind === 'futures' ? 'futures' : 'stock';
    const { rows: secRows } = await client.query(
      `INSERT INTO securities (name, security_type_id)
       VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET security_type_id = EXCLUDED.security_type_id
       RETURNING id, name, security_type_id`,
      [parsed.name, typeRows[0].id]
    );
    const securityId = secRows[0].id;
    await client.query(
      `INSERT INTO security_prefixes (security_id, exchange_id, prefix, instrument_market, tbank_figi, note)
       VALUES ($1, $2, $3, $4, NULL, $5)
       ON CONFLICT (security_id, exchange_id) DO UPDATE SET
         prefix = EXCLUDED.prefix,
         instrument_market = EXCLUDED.instrument_market,
         note = EXCLUDED.note`,
      [securityId, parsed.exchange_id, parsed.prefix, instrumentMarket, parsed.note || null]
    );
    await client.query('COMMIT');
    const { rows } = await pool.query(
      `
      SELECT s.id, s.name, st.name AS security_type, sp.prefix, sp.instrument_market,
             sp.exchange_id, e.name AS exchange_name
      FROM securities s
      JOIN security_types st ON st.id = s.security_type_id
      JOIN security_prefixes sp ON sp.security_id = s.id
      JOIN exchanges e ON e.id = sp.exchange_id
      WHERE s.id = $1 AND sp.exchange_id = $2
    `,
      [securityId, parsed.exchange_id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    handleDbError(res, err, 'POST /api/securities');
  } finally {
    client.release();
  }
});

app.get('/api/prices', async (req, res) => {
  const securityId = parseId(req.query.security_id);
  const timeframeId = parseId(req.query.timeframe_id);
  const limitRaw = Number(req.query.limit);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 120;
  const before = req.query.before ? String(req.query.before) : null;
  if (!securityId || !timeframeId) {
    res.status(400).json({ error: 'Укажите security_id и timeframe_id' });
    return;
  }
  try {
    const params = [securityId, timeframeId, limit];
    let beforeClause = '';
    if (before) {
      beforeClause = 'AND dt < $4::timestamp';
      params.push(before);
    }
    const { rows } = await pool.query(
      `
      SELECT
        to_char(p.dt, 'YYYY-MM-DD HH24:MI:SS') AS dt,
        p.open_price, p.high_price, p.low_price, p.close_price, p.volume,
             p.contract_prefix,
             sp.prefix AS group_prefix
      FROM prices p
      LEFT JOIN security_prefixes sp ON sp.security_id = p.security_id
      WHERE p.security_id = $1 AND p.timeframe_id = $2
      ${beforeClause}
      ORDER BY p.dt DESC
      LIMIT $3
    `,
      params
    );
    rows.reverse();
    res.json(rows);
  } catch (err) {
    console.error('GET /api/prices', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/prices/load', async (req, res) => {
  const securityId = parseId(req.body?.security_id);
  const timeframeId = parseId(req.body?.timeframe_id);
  const dateFrom = parseDateString(req.body?.date_from);
  const dateTo = parseDateString(req.body?.date_to);
  if (!securityId || !timeframeId) {
    res.status(400).json({ error: 'Укажите security_id и timeframe_id' });
    return;
  }
  if (!dateFrom || !dateTo) {
    res.status(400).json({ error: 'Укажите date_from и date_to (YYYY-MM-DD)' });
    return;
  }
  if (dateFrom > dateTo) {
    res.status(400).json({ error: 'date_from не может быть позже date_to' });
    return;
  }
  try {
    const { rows: beforeRows } = await pool.query(
      `
      SELECT COUNT(*)::int AS cnt
      FROM prices
      WHERE security_id = $1
        AND timeframe_id = $2
        AND dt >= $3::date
        AND dt < ($4::date + INTERVAL '1 day')
    `,
      [securityId, timeframeId, dateFrom, dateTo]
    );
    const beforeCount = beforeRows[0]?.cnt ?? 0;

    const client = await pool.connect();
    try {
      await client.query(`SET lock_timeout = '15s'`);
      await client.query(`SET statement_timeout = '180s'`);
      await client.query(`CALL load_prices_http($1, $2, $3::date, $4::date)`, [
        securityId,
        timeframeId,
        dateFrom,
        dateTo,
      ]);
    } finally {
      client.release();
    }

    const { rows: logRows } = await pool.query(
      `
      SELECT source, records_loaded, error_message, contract_prefix,
             date_from, date_to
      FROM price_load_log
      WHERE security_id = $1
        AND timeframe_id = $2
        AND date_from >= $3::date
        AND date_to <= $4::date
        AND loaded_at >= (CURRENT_TIMESTAMP - INTERVAL '10 minutes')
      ORDER BY id DESC
      LIMIT 20
    `,
      [securityId, timeframeId, dateFrom, dateTo]
    );

    const tbankLogs = logRows.filter((r) => r.source === 'T-BANK');
    const moexLogs = logRows.filter((r) => r.source === 'MOEX');
    const tbankLog = tbankLogs[0];
    const moexLog = moexLogs[0];
    const contracts = [];
    const seenContracts = new Set();
    for (const row of logRows) {
      if (!row.contract_prefix || seenContracts.has(row.contract_prefix)) continue;
      seenContracts.add(row.contract_prefix);
      contracts.push({
        prefix: row.contract_prefix,
        source: row.source,
        records_loaded: row.records_loaded,
      });
    }
    const tbankTotal = tbankLogs.reduce((s, r) => s + (r.records_loaded ?? 0), 0);
    const moexTotal = moexLogs.reduce((s, r) => s + (r.records_loaded ?? 0), 0);
    const primarySource =
      tbankTotal > 0
        ? 'T-BANK'
        : moexTotal > 0
          ? 'MOEX'
          : tbankLog
            ? 'T-BANK → MOEX'
            : 'T-Bank → MOEX';

    const { rows: afterRows } = await pool.query(
      `
      SELECT COUNT(*)::int AS cnt
      FROM prices
      WHERE security_id = $1
        AND timeframe_id = $2
        AND dt >= $3::date
        AND dt < ($4::date + INTERVAL '1 day')
    `,
      [securityId, timeframeId, dateFrom, dateTo]
    );
    const afterCount = afterRows[0]?.cnt ?? 0;

    res.json({
      ok: true,
      procedure: 'load_prices_http',
      source: primarySource,
      date_from: dateFrom,
      date_to: dateTo,
      candles: Math.max(0, afterCount - beforeCount),
      candles_total: afterCount,
      records_loaded: tbankLogs.reduce((s, r) => s + (r.records_loaded ?? 0), 0)
        + moexLogs.reduce((s, r) => s + (r.records_loaded ?? 0), 0),
      contracts,
      tbank: {
        records: tbankLogs.reduce((s, r) => s + (r.records_loaded ?? 0), 0) || null,
        error: tbankLog?.error_message ?? null,
      },
      moex: {
        records: moexLogs.reduce((s, r) => s + (r.records_loaded ?? 0), 0) || null,
        error: moexLog?.error_message ?? null,
      },
    });
  } catch (err) {
    console.error('POST /api/prices/load', err);
    res.status(500).json({ error: err.message });
  }
});
};
