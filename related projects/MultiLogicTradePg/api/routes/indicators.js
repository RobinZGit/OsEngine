/**
 * Indicators, series, values, calculate.
 */
module.exports = function registerIndicatorsRoutes(app, ctx) {
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

app.get('/api/indicators', async (req, res) => {
  const withCalc = req.query.with_calc === '1';
  try {
    const { rows } = await pool.query(
      `
      SELECT
        i.id,
        i.code,
        i.name,
        i.script,
        i.formula,
        i.is_custom,
        i.description,
        i.category,
        i.is_active,
        i.sig_trend_def,
        i.sig_ct_def,
        i.sig_profile,
        COALESCE(
          json_agg(
            json_build_object(
              'id', vt.id,
              'code', vt.code,
              'name', vt.name,
              'value_type', vt.value_type,
              'is_threshold', vt.is_threshold,
              'threshold_value', vt.threshold_value,
              'display_order', vt.display_order
            )
            ORDER BY vt.display_order, vt.id
          ) FILTER (WHERE vt.id IS NOT NULL),
          '[]'::json
        ) AS value_types
      FROM indicators i
      LEFT JOIN indicator_value_types vt ON vt.indicator_id = i.id
      WHERE ($1::boolean = FALSE OR (BTRIM(COALESCE(i.script, '')) <> '' OR BTRIM(COALESCE(i.formula, '')) <> ''))
      GROUP BY i.id
      ORDER BY i.code
    `,
      [withCalc]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/indicators', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/indicators', async (req, res) => {
  const parsed = parseIndicatorCreateBody(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const client = await pool.connect();
  try {
    const { rows: formulaOk } = await client.query(
      'SELECT poly_is_formula($1) AS ok',
      [parsed.formula]
    );
    if (!formulaOk[0]?.ok) {
      res.status(400).json({
        error: 'Формула должна быть многочленной (pp, sma, @RSI, …), не calc_*',
      });
      return;
    }
    await client.query('BEGIN');
    const { rows: inserted } = await client.query(
      `INSERT INTO indicators (code, name, description, category, formula, is_custom, is_active)
       VALUES ($1, $2, $3, $4, $5, TRUE, $6)
       RETURNING id`,
      [
        parsed.code,
        parsed.name,
        parsed.description,
        parsed.category,
        parsed.formula,
        parsed.is_active,
      ]
    );
    const indicatorId = inserted[0].id;
    await client.query(
      `INSERT INTO indicator_value_types
         (indicator_id, code, name, value_type, is_threshold, threshold_value, description, display_order)
       VALUES ($1, 'VALUE', $2, 'float', FALSE, NULL, $3, 1)`,
      [indicatorId, parsed.name, parsed.formula]
    );
    await client.query('COMMIT');
    const full = await fetchIndicatorById(client, indicatorId);
    res.status(201).json(full);
  } catch (err) {
    await client.query('ROLLBACK');
    handleDbError(res, err, 'POST /api/indicators');
  } finally {
    client.release();
  }
});

app.put('/api/indicators/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'Invalid indicator id' });
    return;
  }
  const parsed = parseIndicatorBody(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const { rows: existing } = await pool.query(
      'SELECT id, is_custom FROM indicators WHERE id = $1',
      [id]
    );
    if (existing.length === 0) {
      res.status(404).json({ error: 'Indicator not found' });
      return;
    }
    const isCustom = Boolean(existing[0].is_custom);
    if (parsed.formula !== undefined && isCustom) {
      const { rows: formulaOk } = await pool.query(
        'SELECT poly_is_formula($1) AS ok',
        [parsed.formula]
      );
      if (!parsed.formula || !formulaOk[0]?.ok) {
        res.status(400).json({
          error: 'Формула должна быть многочленной (pp, sma, @RSI, …), не calc_*',
        });
        return;
      }
    }
    if (isCustom) {
      await pool.query(
        `UPDATE indicators
         SET name = $1, description = $2, category = $3, formula = $4, is_active = $5
         WHERE id = $6`,
        [
          parsed.name,
          parsed.description,
          parsed.category,
          parsed.formula ?? null,
          parsed.is_active,
          id,
        ]
      );
    } else {
      await pool.query(
        `UPDATE indicators
         SET name = $1, description = $2, category = $3, script = $4, is_active = $5
         WHERE id = $6`,
        [
          parsed.name,
          parsed.description,
          parsed.category,
          parsed.script,
          parsed.is_active,
          id,
        ]
      );
    }
    const full = await fetchIndicatorById(pool, id);
    res.json(full);
  } catch (err) {
    handleDbError(res, err, 'PUT /api/indicators/:id');
  }
});

app.get('/api/security-indicator-series', async (req, res) => {
  const securityId = parseId(req.query.security_id);
  if (!securityId) {
    res.status(400).json({ error: 'Укажите security_id' });
    return;
  }
  try {
    const { rows } = await pool.query(
      `
      SELECT
        sis.id,
        sis.security_id,
        sis.indicator_id,
        sis.series_code,
        sis.invoke_formula,
        sis.param_period,
        sis.param_fast_period,
        sis.param_slow_period,
        sis.param_signal_period,
        sis.param_std_dev,
        sis.param_k_period,
        sis.param_d_period,
        sis.param_smooth,
        sis.point_count,
        sis.display_order,
        sis.is_active,
        i.code AS indicator_code,
        i.name AS indicator_name
      FROM security_indicator_series sis
      JOIN indicators i ON i.id = sis.indicator_id
      WHERE sis.security_id = $1 AND sis.is_active = TRUE
      ORDER BY sis.display_order, sis.id
    `,
      [securityId]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/security-indicator-series', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/security-indicator-series', async (req, res) => {
  const securityId = parseId(req.body?.security_id);
  const indicatorId = parseId(req.body?.indicator_id);
  const timeframeId = parseId(req.body?.timeframe_id);
  if (!securityId || !indicatorId) {
    res.status(400).json({ error: 'Укажите security_id и indicator_id' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = '15000'`);
    await client.query('CALL ensure_security_indicator_series($1, $2)', [
      securityId,
      indicatorId,
    ]);
    // Расчёт — отдельно через POST /sync (не блокируем добавление серии).
    const { rows } = await client.query(
      `
      SELECT
        sis.id,
        sis.security_id,
        sis.indicator_id,
        sis.series_code,
        sis.invoke_formula,
        sis.point_count,
        sis.display_order,
        sis.is_active,
        i.code AS indicator_code,
        i.name AS indicator_name
      FROM security_indicator_series sis
      JOIN indicators i ON i.id = sis.indicator_id
      WHERE sis.security_id = $1 AND sis.indicator_id = $2 AND sis.is_active = TRUE
      ORDER BY sis.display_order, sis.id
    `,
      [securityId, indicatorId]
    );
    res.status(201).json(rows);
  } catch (err) {
    console.error('POST /api/security-indicator-series', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete('/api/security-indicator-series/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM security_indicator_series WHERE id = $1',
      [id]
    );
    if (rowCount === 0) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    handleDbError(res, err, 'DELETE /api/security-indicator-series/:id');
  }
});

app.post('/api/security-indicator-series/sync', async (req, res) => {
  const securityId = parseId(req.body?.security_id);
  const timeframeId = parseId(req.body?.timeframe_id);
  const indicatorId = parseId(req.body?.indicator_id);
  const endDt = req.body?.end_dt ? String(req.body.end_dt) : null;
  const pointCount = parseId(req.body?.point_count);
  const incremental = req.body?.incremental !== false;
  const runAsync = req.body?.async === true;
  if (!securityId || !timeframeId) {
    res.status(400).json({ error: 'Укажите security_id и timeframe_id' });
    return;
  }

  if (runAsync) {
    res.status(202).json({ ok: true, status: 'started' });
    runIndicatorSyncBackground({
      securityId,
      timeframeId,
      indicatorId,
      endDt,
      pointCount,
      incremental,
    }).catch((err) => {
      console.error('POST /api/security-indicator-series/sync async', err);
    });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = '120000'`);
    if (indicatorId) {
      await client.query(
        'CALL sync_security_indicator_series_for_indicator($1, $2, $3, $4::timestamp, $5, $6)',
        [securityId, indicatorId, timeframeId, endDt, pointCount, incremental]
      );
    } else {
      await client.query(
        'CALL sync_security_indicator_series_all($1, $2, $3::timestamp, $4, $5)',
        [securityId, timeframeId, endDt, pointCount, incremental]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/security-indicator-series/sync', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/indicators/calculate', async (req, res) => {
  const securityId = parseId(req.body?.security_id);
  const timeframeId = parseId(req.body?.timeframe_id);
  const indicatorId = parseId(req.body?.indicator_id);
  const dateFrom = req.body?.date_from ? String(req.body.date_from) : null;
  const dateTo = req.body?.date_to ? String(req.body.date_to) : null;
  const overwrite = req.body?.overwrite === true;
  if (!securityId || !timeframeId || !indicatorId || !dateFrom || !dateTo) {
    res.status(400).json({
      error: 'Укажите security_id, timeframe_id, indicator_id, date_from, date_to',
    });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = '120000'`);
    await client.query(`SET lock_timeout = '15000'`);
    await client.query(
      `CALL calculate_indicator($1, $2, $3, $4::date, $5::date, $6)`,
      [securityId, timeframeId, indicatorId, dateFrom, dateTo, overwrite]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/indicators/calculate', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/indicator-values', async (req, res) => {
  const securityId = parseId(req.query.security_id);
  const timeframeId = parseId(req.query.timeframe_id);
  const indicatorIdsRaw = req.query.indicator_ids
    ? String(req.query.indicator_ids)
    : '';
  const indicatorIds = indicatorIdsRaw
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  const before = req.query.before ? String(req.query.before) : null;
  const after = req.query.after ? String(req.query.after) : null;
  const limitRaw = Number(req.query.limit);
  // Без лимита UI разворота бумаги забивался 7+ МБ JSON и «висел».
  const limit =
    Number.isInteger(limitRaw) && limitRaw > 0
      ? Math.min(limitRaw, 4000)
      : 1500;
  if (!securityId || !timeframeId || indicatorIds.length === 0) {
    res.status(400).json({
      error: 'Укажите security_id, timeframe_id и indicator_ids (через запятую)',
    });
    return;
  }
  try {
    const params = [securityId, timeframeId, indicatorIds];
    let rangeClause = '';
    if (before) {
      params.push(before);
      rangeClause += ` AND iv.dt <= $${params.length}::timestamp`;
    }
    if (after) {
      params.push(after);
      rangeClause += ` AND iv.dt >= $${params.length}::timestamp`;
    }
    // Если окно не задано — только хвост истории (не вся таблица).
    if (!before && !after) {
      params.push(limit);
      const { rows } = await pool.query(
        `
        SELECT * FROM (
          SELECT
            iv.indicator_id,
            i.code AS indicator_code,
            ivt.code AS line_code,
            ivt.name AS line_name,
            ivt.is_threshold,
            ivt.display_order,
            iv.dt,
            iv.value
          FROM indicator_values iv
          JOIN indicators i ON i.id = iv.indicator_id
          JOIN indicator_value_types ivt ON ivt.id = iv.indicator_value_type_id
          WHERE iv.security_id = $1
            AND iv.timeframe_id = $2
            AND iv.indicator_id = ANY($3::int[])
          ORDER BY iv.dt DESC, iv.indicator_id, ivt.display_order, ivt.id
          LIMIT $4
        ) t
        ORDER BY t.dt, t.indicator_id, t.display_order
        `,
        params
      );
      res.json(rows);
      return;
    }
    params.push(limit);
    const { rows } = await pool.query(
      `
      SELECT * FROM (
        SELECT
          iv.indicator_id,
          i.code AS indicator_code,
          ivt.code AS line_code,
          ivt.name AS line_name,
          ivt.is_threshold,
          ivt.display_order,
          iv.dt,
          iv.value
        FROM indicator_values iv
        JOIN indicators i ON i.id = iv.indicator_id
        JOIN indicator_value_types ivt ON ivt.id = iv.indicator_value_type_id
        WHERE iv.security_id = $1
          AND iv.timeframe_id = $2
          AND iv.indicator_id = ANY($3::int[])
          ${rangeClause}
        ORDER BY iv.dt DESC, iv.indicator_id, ivt.display_order, ivt.id
        LIMIT $${params.length}
      ) t
      ORDER BY t.dt, t.indicator_id, t.display_order
      `,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/indicator-values', err);
    res.status(500).json({ error: err.message });
  }
});
};
