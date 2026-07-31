/**
 * Logics CRUD, params, export/import, OPT, shadow, signals, stops, securities, NTP.
 */
module.exports = function registerLogicsRoutes(app, ctx) {
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

app.get('/api/logics', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        l.id,
        l.name,
        l.account_id,
        l.is_enabled,
        l.note,
        COALESCE(l.portfolio_trading_paused, FALSE) AS portfolio_trading_paused,
        l.portfolio_stop_resume_equity::float8 AS portfolio_stop_resume_equity,
        l.portfolio_stop_resume_baseline::float8 AS portfolio_stop_resume_baseline,
        l.portfolio_stop_resume_at AS portfolio_stop_resume_at,
        EXISTS (
          SELECT 1
          FROM logic_stops ls
          WHERE ls.logic_id = l.id
            AND ls.is_active = TRUE
            AND ls.rule_kind = 'take_profit'
            AND ls.scope_type IN ('portfolio_ltp_renew', 'security_ltp_renew')
        ) AS has_portfolio_ltp_renew,
        EXISTS (
          SELECT 1
          FROM logic_stops ls
          WHERE ls.logic_id = l.id
            AND ls.is_active = TRUE
            AND ls.rule_kind = 'stop_loss'
            AND ls.scope_type = 'portfolio_resume'
        ) AS has_portfolio_resume_sl,
        a.account_code,
        a.name AS account_name,
        a.account_type,
        a.broker_id,
        a.is_active AS account_is_active,
        b.code AS broker_code,
        b.name AS broker_name
      FROM logics l
      JOIN accounts a ON a.id = l.account_id
      JOIN brokers b ON b.id = a.broker_id
      ORDER BY l.id
    `);
    // Без T-Bank на каждый poll: остатки из logic_params (бой/enable/смена счёта обновляют сами).
    const paramsByLogic = await getTradingParamsForLogics(
      pool,
      rows.map((r) => r.id)
    );
    const result = rows.map((r) => ({
      ...r,
      ...(paramsByLogic.get(r.id) || {}),
    }));
    res.json(result);
  } catch (err) {
    console.error('GET /api/logics', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logic-params', async (req, res) => {
  const logicId = Number(req.query.logic_id);
  if (!Number.isInteger(logicId) || logicId <= 0) {
    res.status(400).json({ error: 'logic_id required' });
    return;
  }
  try {
    const rows = await getLogicParamsDetailed(pool, logicId);
    const trading = await getTradingParams(pool, logicId);
    res.json({ logic_id: logicId, trading, params: rows });
  } catch (err) {
    console.error('GET /api/logic-params', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/logic-params', async (req, res) => {
  const logicId = Number(req.body?.logic_id);
  if (!Number.isInteger(logicId) || logicId <= 0) {
    res.status(400).json({ error: 'logic_id required' });
    return;
  }
  const parsed = parseLogicTradingParams(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const { rows: exists } = await pool.query(
      'SELECT id FROM logics WHERE id = $1',
      [logicId]
    );
    if (exists.length === 0) {
      res.status(404).json({ error: 'Logic not found' });
      return;
    }
    const trading = await saveTradingParams(pool, logicId, parsed);
    const params = await getLogicParamsDetailed(pool, logicId);
    await writeTechLogEvent(pool, {
      threadKey: `logic:${logicId}:params`,
      operation: 'logic.params.updated',
      message: 'Параметры логики сохранены',
      source: 'api',
      logicId,
      payload: { trading, params },
    });
    res.json({ logic_id: logicId, trading, params });
  } catch (err) {
    console.error('PUT /api/logic-params', err);
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/logics', async (req, res) => {
  const parsed = parseLogicBody(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const { rows } = await pool.query(
      `
      INSERT INTO logics (name, account_id, is_enabled, note)
      VALUES ($1, $2, $3, $4)
      RETURNING id, name, account_id, is_enabled, note
      `,
      [parsed.name, parsed.account_id, parsed.is_enabled, parsed.note]
    );
    const row = rows[0];
    await ensureDefaultParams(pool, row.id);
    await syncRealAccountBalancesIfNeeded(pool, row.id, { force: true });
    const params = await getTradingParams(pool, row.id);
    res.status(201).json({ ...row, ...params });
  } catch (err) {
    console.error('POST /api/logics', err);
    if (err.code === '23505') {
      res.status(409).json({ error: 'Логика с таким именем уже существует' });
      return;
    }
    if (err.code === '23503') {
      res.status(400).json({ error: 'Указан несуществующий счёт' });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

/** Экспорт выбранных логик: params/signals/stops/securities; без тестов и сделок. */
app.post('/api/logics/export', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  try {
    const bundle = await buildLogicBundle(pool, ids);
    res.json(bundle);
  } catch (err) {
    console.error('POST /api/logics/export', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * Импорт bundle: по имени — перезапись; иначе новая логика.
 * Тесты/сделки не импортируются; last_opt_grid из файла восстанавливается.
 * Body: bundle JSON; optional overwrite_by_name (default true).
 */
app.post('/api/logics/import', async (req, res) => {
  try {
    const overwriteByName = req.body?.overwrite_by_name !== false;
    const bundle = { ...req.body };
    delete bundle.overwrite_by_name;
    const result = await importLogicBundle(pool, bundle, { overwriteByName });
    res.status(201).json(result);
  } catch (err) {
    console.error('POST /api/logics/import', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/logics/:id/copy', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid logic id' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: sourceRows } = await client.query(
      'SELECT id, name, account_id, note FROM logics WHERE id = $1',
      [id]
    );
    if (sourceRows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Logic not found' });
      return;
    }
    const source = sourceRows[0];
    const baseName = `${source.name} copy`;
    let copyName = baseName;
    for (let i = 2; i <= 100; i += 1) {
      const { rows: existing } = await client.query(
        'SELECT 1 FROM logics WHERE name = $1 LIMIT 1',
        [copyName]
      );
      if (existing.length === 0) break;
      copyName = `${baseName} ${i}`;
    }

    const { rows: inserted } = await client.query(
      `
      INSERT INTO logics (name, account_id, is_enabled, note)
      VALUES ($1, $2, FALSE, $3)
      RETURNING id, name, account_id, is_enabled, note
      `,
      [copyName, source.account_id, source.note]
    );
    const copy = inserted[0];

    await client.query(
      `
      INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
      SELECT $1, param_key, param_value, value_type
      FROM logic_params
      WHERE logic_id = $2
      ON CONFLICT (logic_id, param_key) DO UPDATE SET
        param_value = EXCLUDED.param_value,
        value_type = EXCLUDED.value_type,
        updated_at = CURRENT_TIMESTAMP
      `,
      [copy.id, id]
    );

    await client.query(
      `
      INSERT INTO logic_indicator_signals (
        logic_id, indicator_id, position_event, position_side, signal_kind,
        formula, rating, rating_test, display_order, is_active
      )
      SELECT
        $1, indicator_id, position_event, position_side, signal_kind,
        formula, 0, 0, display_order, is_active
      FROM logic_indicator_signals
      WHERE logic_id = $2
      ORDER BY display_order, id
      `,
      [copy.id, id]
    );

    await client.query(
      `
      INSERT INTO logic_stops (
        logic_id, rule_kind, scope_type, value, value_unit, display_order, is_active
      )
      SELECT $1, rule_kind, scope_type, value, value_unit, display_order, is_active
      FROM logic_stops
      WHERE logic_id = $2
      ORDER BY display_order, id
      `,
      [copy.id, id]
    );

    await client.query(
      `
      INSERT INTO logic_securities (logic_id, security_id, display_order, is_active)
      SELECT $1, security_id, display_order, is_active
      FROM logic_securities
      WHERE logic_id = $2
      ORDER BY display_order, id
      ON CONFLICT (logic_id, security_id) DO NOTHING
      `,
      [copy.id, id]
    );

    await client.query(
      `
      INSERT INTO logic_non_trading_intervals (
        logic_id, day_of_week, time_from, time_to, note, display_order, is_active
      )
      SELECT $1, day_of_week, time_from, time_to, note, display_order, is_active
      FROM logic_non_trading_intervals
      WHERE logic_id = $2
      ORDER BY display_order, id
      `,
      [copy.id, id]
    );

    await client.query('COMMIT');
    // Копия с real-счёта не должна унаследовать paper 1M — остаток с брокера или 0
    await syncRealAccountBalancesIfNeeded(pool, copy.id, { force: true });
    const { rows: fullRows } = await pool.query(
      `
      SELECT
        l.id,
        l.name,
        l.account_id,
        l.is_enabled,
        l.note,
        a.account_code,
        a.name AS account_name,
        a.account_type,
        a.broker_id,
        a.is_active AS account_is_active,
        b.code AS broker_code,
        b.name AS broker_name
      FROM logics l
      JOIN accounts a ON a.id = l.account_id
      JOIN brokers b ON b.id = a.broker_id
      WHERE l.id = $1
      `,
      [copy.id]
    );
    const params = await getTradingParams(pool, copy.id);
    res.status(201).json({ ...(fullRows[0] ?? copy), ...params });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/logics/:id/copy', err);
    if (err.code === '23505') {
      res.status(409).json({ error: 'Could not create a unique copy name' });
      return;
    }
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put('/api/logics/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid logic id' });
    return;
  }
  const parsed = parseLogicBody(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT id, name, account_id, is_enabled FROM logics WHERE id = $1',
      [id]
    );
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Logic not found' });
      return;
    }
    const prevAccountId = Number(existing.rows[0].account_id);
    const accountChanged = prevAccountId !== Number(parsed.account_id);
    const { rows } = await client.query(
      `
      UPDATE logics
      SET name = $1, account_id = $2, is_enabled = $3, note = $4
      WHERE id = $5
      RETURNING id, name, account_id, is_enabled, note
      `,
      [parsed.name, parsed.account_id, parsed.is_enabled, parsed.note, id]
    );

    let account_change = null;
    if (accountChanged) {
      // Боевая история/FINRES + pause state; остатки под новый счёт.
      const cleared = await resetLogicTradingStateOnAccountChange(client, id);
      account_change = {
        from_account_id: prevAccountId,
        to_account_id: Number(parsed.account_id),
        cleared_trades: cleared.cleared_trades,
      };
      await writeTechLogEvent(client, {
        threadKey: `logic:${id}:control`,
        operation: 'logic.account_changed',
        message: 'Счёт логики изменён: история сделок и FINRES очищены',
        source: 'api',
        logicId: id,
        payload: account_change,
      });
    }

    await client.query('COMMIT');
    if (!accountChanged) {
      // Смена на real / уже real — initial/current только с брокера (или 0)
      await syncRealAccountBalancesIfNeeded(pool, id, { force: true });
    }

    let rating_precalc = null;
    // Как «выкл → вкл»: при активной логике после смены счёта — предрасчёт рейтинга.
    if (accountChanged && rows[0].is_enabled) {
      rating_precalc = await startRatingPrecalc(pool, id);
    }

    res.json({
      ...rows[0],
      account_changed: accountChanged,
      account_change,
      rating_precalc,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /api/logics/:id', err);
    if (err.code === '23505') {
      res.status(409).json({ error: 'Логика с таким именем уже существует' });
      return;
    }
    if (err.code === '23503') {
      res.status(400).json({ error: 'Указан несуществующий счёт' });
      return;
    }
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete('/api/logics/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid logic id' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT id, name FROM logics WHERE id = $1',
      [id]
    );
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Logic not found' });
      return;
    }
    // logic_trades.logic_id historically RESTRICT — remove trades/lots before logic.
    await client.query('DELETE FROM logic_trade_lots WHERE logic_id = $1', [id]);
    await client.query('DELETE FROM logic_trades WHERE logic_id = $1', [id]);
    await client.query('DELETE FROM logics WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.json({ ok: true, id });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('DELETE /api/logics/:id', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.patch('/api/logics/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { is_enabled } = req.body;
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid logic id' });
    return;
  }
  if (typeof is_enabled !== 'boolean') {
    res.status(400).json({ error: 'is_enabled must be boolean' });
    return;
  }
  try {
    const { rows: existsRows } = await pool.query(
      `SELECT id FROM logics WHERE id = $1`,
      [id]
    );
    if (existsRows.length === 0) {
      res.status(404).json({ error: 'Logic not found' });
      return;
    }
    if (is_enabled) {
      const warmup = await logicNeedsWarmup(pool, id);
      if (warmup.enabled) {
        const { rows: activeWarmup } = await pool.query(
          `
          SELECT id, date_from, date_to
          FROM logic_backtest_runs
          WHERE logic_id = $1
            AND status IN ('pending', 'loading_prices', 'loading_indicators', 'running')
          ORDER BY id DESC
          LIMIT 1
          `,
          [id]
        );
        if (activeWarmup.length > 0) {
          const run = activeWarmup[0];
          await pool.query(`UPDATE logics SET is_enabled = FALSE WHERE id = $1`, [id]);
          watchWarmupBacktest(pool, id, run.id);
          res.json({
            id,
            is_enabled: false,
            warmup_pretest: {
              started: true,
              run_id: run.id,
              date_from: run.date_from,
              date_to: run.date_to,
            },
          });
          return;
        }
        const dateTo = localIsoDate();
        const dateFrom = shiftLocalDate(dateTo, -(warmup.lookbackDays - 1));
        const runId = await startBacktest(pool, id, dateFrom, dateTo);
        await pool.query(`UPDATE logics SET is_enabled = FALSE WHERE id = $1`, [id]);
        watchWarmupBacktest(pool, id, runId);
        await writeTechLogEvent(pool, {
          threadKey: `logic:${id}:warmup`,
          operation: 'logic.warmup.started',
          message: `Warm-up backtest started before enabling logic`,
          source: 'api',
          logicId: id,
          payload: { run_id: runId, date_from: dateFrom, date_to: dateTo },
        });
        res.json({
          id,
          is_enabled: false,
          warmup_pretest: {
            started: true,
            run_id: runId,
            date_from: dateFrom,
            date_to: dateTo,
          },
        });
        return;
      }
    }
    const { rows } = await pool.query(
      `UPDATE logics SET is_enabled = $1 WHERE id = $2 RETURNING id, is_enabled`,
      [is_enabled, id]
    );
    await writeTechLogEvent(pool, {
      threadKey: `logic:${id}:control`,
      operation: is_enabled ? 'logic.enabled' : 'logic.disabled',
      message: is_enabled ? 'Логика включена' : 'Логика выключена',
      source: 'api',
      logicId: id,
      payload: { is_enabled },
    });
    let rating_precalc = null;
    if (is_enabled) {
      // Остатки с брокера — в фоне, не блокируем ответ UI (раньше блокировал poll списка).
      syncRealAccountBalancesIfNeeded(pool, id, { force: true }).catch(() => {});
      // Фон: не ждём; бой уже включён
      rating_precalc = await startRatingPrecalc(pool, id);
    }
    res.json({ ...rows[0], rating_precalc });
  } catch (err) {
    console.error('PATCH /api/logics/:id', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logics/:id/signal-rating-precalc', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid logic id' });
    return;
  }
  try {
    const { rows } = await pool.query('SELECT id FROM logics WHERE id = $1', [id]);
    if (rows.length === 0) {
      res.status(404).json({ error: 'Logic not found' });
      return;
    }
    const job = await startRatingPrecalc(pool, id);
    res.json(job);
  } catch (err) {
    console.error('POST /api/logics/:id/signal-rating-precalc', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logics/:id/signal-rating-precalc', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid logic id' });
    return;
  }
  res.json(getRatingPrecalcStatus(id));
});

/** История баз OPT / параметров формул для отчёта теста. */
app.get('/api/logics/:id/opt-param-history', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid logic id' });
    return;
  }
  const runRaw = req.query.run_id;
  const runId =
    runRaw != null && String(runRaw).trim() !== ''
      ? Number(runRaw)
      : null;
  try {
    const { rows } = await pool.query(
      `SELECT logic_opt_param_history_for_report($1, $2) AS h`,
      [id, Number.isInteger(runId) && runId > 0 ? runId : null]
    );
    const raw = rows[0]?.h;
    const history = Array.isArray(raw) ? raw : raw ? [raw] : [];
    res.json({ rows: history });
  } catch (err) {
    console.error('GET /api/logics/:id/opt-param-history', err);
    res.status(500).json({ error: err.message });
  }
});

/** Apply best offline-grid params from last OPT (logic cache or recovered run). */
app.post('/api/logics/:id/opt-grid-apply-best', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid logic id' });
    return;
  }
  try {
    const found = await resolveLastOptGridResults(pool, id);
    if (!found.results || !Array.isArray(found.results) || found.results.length === 0) {
      res.status(400).json({
        error:
          'Нет сохранённых результатов оптимизации. Запустите тест с «Оптимизировать» ещё раз — после этого они останутся до «Параметры по умолчанию» / «Сброс OPT».',
        source: found.source,
      });
      return;
    }
    const results = found.results;
    const runId = found.run_id;
    const best = [...results].sort(
      (a, b) => Number(b.finres || 0) - Number(a.finres || 0)
    )[0];
    if (!best || best.is_champion || !best.values || Object.keys(best.values).length === 0) {
      // Champion won — still allow "apply" as no-op message, or apply champion values (none).
      if (best?.is_champion) {
        res.json({
          ok: true,
          message: 'Лучший результат — параметры по умолчанию (чемпион). Формулы не менялись.',
          run_id: runId,
          best,
          updated: 0,
          source: found.source,
        });
        return;
      }
      res.status(400).json({ error: 'Не удалось выбрать лучшие параметры' });
      return;
    }

    // Snapshot before rewrite so «Сброс» / reset can restore.
    try {
      if (runId) {
        await pool.query(`SELECT logic_opt_snapshot_params($1, $2, NULL)`, [
          id,
          runId,
        ]);
      }
    } catch (err) {
      console.warn('opt-grid-apply snapshot', err?.message || err);
    }

    const { rows: signals } = await pool.query(
      `SELECT id, formula FROM logic_indicator_signals WHERE logic_id = $1 AND is_active = TRUE`,
      [id]
    );

    const values = best.values;
    let updated = 0;
    for (const sig of signals) {
      const next = rewriteFormulaBasesNode(sig.formula, values);
      if (next !== sig.formula) {
        await pool.query(
          `UPDATE logic_indicator_signals SET formula = $1 WHERE id = $2`,
          [next, sig.id]
        );
        updated++;
      }
    }

    const { rows: outSignals } = await pool.query(
      `
      SELECT
        lis.id, lis.logic_id, lis.indicator_id, lis.position_event, lis.position_side,
        lis.signal_kind, COALESCE(lis.signal_acts_on, 'security') AS signal_acts_on,
        lis.formula, lis.rating, lis.rating_test, lis.display_order, lis.is_active,
        i.code AS indicator_code, i.name AS indicator_name
      FROM logic_indicator_signals lis
      JOIN indicators i ON i.id = lis.indicator_id
      WHERE lis.logic_id = $1
      ORDER BY lis.display_order, lis.id
      `,
      [id]
    );

    res.json({
      ok: true,
      run_id: runId,
      best,
      updated,
      signals: outSignals,
      source: found.source,
    });
  } catch (err) {
    console.error('POST /api/logics/:id/opt-grid-apply-best', err);
    res.status(500).json({ error: err.message });
  }
});


app.get('/api/logics/:id/opt-grid-results', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid logic id' });
    return;
  }
  try {
    const found = await resolveLastOptGridResults(pool, id);
    if (!found.results) {
      res.json({ run_id: null, results: null, source: found.source });
      return;
    }
    res.json({
      run_id: found.run_id,
      results: found.results,
      source: found.source,
    });
  } catch (err) {
    console.error('GET /api/logics/:id/opt-grid-results', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Очистка теневой истории: live is_shadow сделки, снятие pause/инверсии,
 * все бумаги логики → is_active; при включённой логике — предрасчёт рейтинга.
 */
app.post('/api/logics/:id/shadow-reset', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid logic id' });
    return;
  }
  try {
    const { rows: exists } = await pool.query(
      `SELECT id, is_enabled FROM logics WHERE id = $1`,
      [id]
    );
    if (exists.length === 0) {
      res.status(404).json({ error: 'Logic not found' });
      return;
    }

    const cleared = await resetLogicShadowTradingState(pool, id);

    let rating_precalc = null;
    if (exists[0].is_enabled) {
      rating_precalc = await startRatingPrecalc(pool, id);
    }

    res.json({
      ok: true,
      ...cleared,
      rating_precalc,
      message:
        'Теневые сделки очищены, бумаги снова включены в логику' +
        (rating_precalc ? '; запущен предрасчёт рейтинга' : ''),
    });
  } catch (err) {
    console.error('POST /api/logics/:id/shadow-reset', err);
    res.status(500).json({ error: err.message });
  }
});

/** Сброс OPT: начальные базы формул + очистка live opt_lane книги. */
app.post('/api/logics/:id/opt-reset', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid logic id' });
    return;
  }
  try {
    const { rows: exists } = await pool.query(
      'SELECT id FROM logics WHERE id = $1',
      [id]
    );
    if (exists.length === 0) {
      res.status(404).json({ error: 'Logic not found' });
      return;
    }
    const { rows } = await pool.query(
      `SELECT logic_opt_reset_to_initial($1) AS r`,
      [id]
    );
    const result = rows[0]?.r ?? {};
    if (result && result.ok === false) {
      res.status(400).json({ error: result.error || 'opt reset failed', ...result });
      return;
    }
    const { rows: signals } = await pool.query(
      `
      SELECT
        lis.id,
        lis.logic_id,
        lis.indicator_id,
        lis.position_event,
        lis.position_side,
        lis.signal_kind,
        lis.formula,
        lis.rating,
        lis.rating_test,
        lis.display_order,
        lis.is_active,
        i.code AS indicator_code,
        i.name AS indicator_name
      FROM logic_indicator_signals lis
      JOIN indicators i ON i.id = lis.indicator_id
      WHERE lis.logic_id = $1
      ORDER BY lis.display_order, lis.id
      `,
      [id]
    );
    res.json({ ...result, signals });
  } catch (err) {
    console.error('POST /api/logics/:id/opt-reset', err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/logics/:id/trading-params', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid logic id' });
    return;
  }

  const parsed = parseLogicTradingParams(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    const { rows: exists } = await pool.query(
      'SELECT id FROM logics WHERE id = $1',
      [id]
    );
    if (exists.length === 0) {
      res.status(404).json({ error: 'Logic not found' });
      return;
    }
    const trading = await saveTradingParams(pool, id, parsed);
    res.json({ id, ...trading });
  } catch (err) {
    console.error('PATCH /api/logics/:id/trading-params', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logic-indicator-signals', async (req, res) => {
  const logicId = Number(req.query.logic_id);
  if (!Number.isInteger(logicId) || logicId <= 0) {
    res.status(400).json({ error: 'logic_id required' });
    return;
  }
  try {
    const { rows } = await pool.query(
      `
      SELECT
        lis.id,
        lis.logic_id,
        lis.indicator_id,
        lis.position_event,
        lis.position_side,
        lis.signal_kind,
        COALESCE(lis.signal_acts_on, 'security') AS signal_acts_on,
        lis.formula,
        lis.rating,
        lis.rating_test,
        lis.display_order,
        lis.is_active,
        i.code AS indicator_code,
        i.name AS indicator_name
      FROM logic_indicator_signals lis
      JOIN indicators i ON i.id = lis.indicator_id
      WHERE lis.logic_id = $1
      ORDER BY lis.display_order, lis.id
    `,
      [logicId]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/logic-indicator-signals', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logic-signal-ratings/history', async (req, res) => {
  const logicId = Number(req.query.logic_id);
  const isTest = req.query.is_test === '1' || req.query.is_test === 'true';
  const runId = req.query.run_id != null && req.query.run_id !== ''
    ? Number(req.query.run_id)
    : null;
  const signalId = req.query.signal_id != null && req.query.signal_id !== ''
    ? Number(req.query.signal_id)
    : null;
  const securityId = req.query.security_id != null && req.query.security_id !== ''
    ? Number(req.query.security_id)
    : null;
  if (!Number.isInteger(logicId) || logicId <= 0) {
    res.status(400).json({ error: 'logic_id required' });
    return;
  }
  try {
    const { rows: signals } = await pool.query(
      `
      SELECT
        lis.id AS signal_id,
        lis.logic_id,
        lis.position_event,
        lis.position_side,
        lis.signal_kind,
        lis.formula,
        lis.rating,
        lis.rating_test,
        lis.is_active,
        i.code AS indicator_code,
        i.name AS indicator_name
      FROM logic_indicator_signals lis
      JOIN indicators i ON i.id = lis.indicator_id
      WHERE lis.logic_id = $1
        AND ($2::int IS NULL OR lis.id = $2)
      ORDER BY lis.display_order, lis.id
      `,
      [logicId, signalId]
    );

    const histParams = [logicId, isTest];
    let histSql = `
      SELECT h.signal_id, h.bar_dt, h.rating, h.delta, h.security_id, h.run_id
      FROM logic_signal_rating_history h
      WHERE h.logic_id = $1 AND h.is_test = $2
    `;
    if (runId != null && Number.isInteger(runId)) {
      histParams.push(runId);
      histSql += ` AND h.run_id = $${histParams.length}`;
    }
    if (signalId != null && Number.isInteger(signalId)) {
      histParams.push(signalId);
      histSql += ` AND h.signal_id = $${histParams.length}`;
    }
    if (securityId != null && Number.isInteger(securityId)) {
      histParams.push(securityId);
      histSql += ` AND h.security_id = $${histParams.length}`;
    }
    histSql += ' ORDER BY h.signal_id, h.bar_dt, h.id';

    const { rows: hist } = await pool.query(histSql, histParams);
    const bySignal = new Map();
    for (const s of signals) {
      bySignal.set(s.signal_id, {
        ...s,
        // При фильтре по бумаге rating_test в ответе = рейтинг на этой бумаге
        paper_rating: 0,
        points: [],
      });
    }
    for (const h of hist) {
      const row = bySignal.get(h.signal_id);
      if (!row) continue;
      const dt = h.bar_dt;
      const value = Number(h.rating);
      const point = {
        dt,
        value,
        delta: Number(h.delta),
      };
      const pts = row.points;
      const last = pts[pts.length - 1];
      if (last && String(last.dt) === String(dt)) {
        pts[pts.length - 1] = point;
      } else {
        pts.push(point);
      }
      row.paper_rating = value;
    }
    if (securityId != null && Number.isInteger(securityId)) {
      for (const row of bySignal.values()) {
        row.rating_test = row.paper_rating;
      }
    }
    res.json({
      logic_id: logicId,
      is_test: isTest,
      run_id: runId,
      security_id: securityId,
      signals: [...bySignal.values()],
    });
  } catch (err) {
    console.error('GET /api/logic-signal-ratings/history', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logic-indicator-signals', async (req, res) => {
  const logicId = Number(req.body?.logic_id);
  const indicatorId = Number(req.body?.indicator_id);
  const positionEvent = req.body?.position_event;
  const positionSide = req.body?.position_side;
  const signalKind = req.body?.signal_kind;
  const signalActsOn =
    req.body?.signal_acts_on === 'base_asset' ? 'base_asset' : 'security';
  const formula = btrimStr(req.body?.formula);
  if (!Number.isInteger(logicId) || logicId <= 0) {
    res.status(400).json({ error: 'logic_id required' });
    return;
  }
  if (!Number.isInteger(indicatorId) || indicatorId <= 0) {
    res.status(400).json({ error: 'indicator_id required' });
    return;
  }
  if (positionEvent !== 'open' && positionEvent !== 'close') {
    res.status(400).json({ error: 'position_event must be open or close' });
    return;
  }
  if (positionSide !== 'long' && positionSide !== 'short') {
    res.status(400).json({ error: 'position_side must be long or short' });
    return;
  }
  if (signalKind !== 'trend' && signalKind !== 'counter') {
    res.status(400).json({ error: 'signal_kind must be trend or counter' });
    return;
  }
  if (!formula) {
    res.status(400).json({ error: 'formula required' });
    return;
  }
  try {
    const optCheck = await validateOptFormulaSave(pool, logicId, formula, null);
    if (!optCheck.ok) {
      res.status(400).json({
        error: optCheck.error,
        opt_existing: optCheck.existing || [],
      });
      return;
    }
    const { rows: orderRows } = await pool.query(
      `SELECT COALESCE(MAX(display_order), 0) + 1 AS next_order
       FROM logic_indicator_signals WHERE logic_id = $1`,
      [logicId]
    );
    const displayOrder = orderRows[0]?.next_order ?? 1;
    const { rows } = await pool.query(
      `
      INSERT INTO logic_indicator_signals
        (logic_id, indicator_id, position_event, position_side, signal_kind, signal_acts_on, formula, display_order)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (logic_id, indicator_id, position_event, position_side, signal_kind, signal_acts_on) DO UPDATE SET
        formula = EXCLUDED.formula,
        is_active = TRUE
      RETURNING id, logic_id, indicator_id, position_event, position_side, signal_kind, signal_acts_on, formula, rating, rating_test, display_order, is_active
    `,
      [logicId, indicatorId, positionEvent, positionSide, signalKind, signalActsOn, formula, displayOrder]
    );
    const row = rows[0];
    const { rows: meta } = await pool.query(
      `SELECT code AS indicator_code, name AS indicator_name FROM indicators WHERE id = $1`,
      [indicatorId]
    );
    res.status(201).json({ ...row, ...meta[0] });
  } catch (err) {
    console.error('POST /api/logic-indicator-signals', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/logic-indicator-signals/:id', async (req, res) => {
  const id = Number(req.params.id);
  const formula = btrimStr(req.body?.formula);
  const isActive = req.body?.is_active;
  const hasActsOn = Object.prototype.hasOwnProperty.call(req.body || {}, 'signal_acts_on');
  const signalActsOn = hasActsOn
    ? req.body?.signal_acts_on === 'base_asset'
      ? 'base_asset'
      : 'security'
    : null;
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  if (!formula) {
    res.status(400).json({ error: 'formula required' });
    return;
  }
  try {
    const { rows: curRows } = await pool.query(
      `SELECT logic_id FROM logic_indicator_signals WHERE id = $1`,
      [id]
    );
    if (curRows.length === 0) {
      res.status(404).json({ error: 'Signal not found' });
      return;
    }
    const optCheck = await validateOptFormulaSave(
      pool,
      curRows[0].logic_id,
      formula,
      id
    );
    if (!optCheck.ok) {
      res.status(400).json({
        error: optCheck.error,
        opt_existing: optCheck.existing || [],
      });
      return;
    }
    const { rows } = await pool.query(
      `
      UPDATE logic_indicator_signals
      SET formula = $2,
          is_active = COALESCE($3::boolean, is_active),
          signal_acts_on = COALESCE($4::varchar, signal_acts_on)
      WHERE id = $1
      RETURNING id, logic_id, indicator_id, position_event, position_side, signal_kind, signal_acts_on, formula, rating, rating_test, display_order, is_active
    `,
      [id, formula, isActive === undefined ? null : isActive, signalActsOn]
    );
    const row = rows[0];
    const { rows: meta } = await pool.query(
      `SELECT code AS indicator_code, name AS indicator_name FROM indicators WHERE id = $1`,
      [row.indicator_id]
    );
    res.json({ ...row, ...meta[0] });
  } catch (err) {
    console.error('PUT /api/logic-indicator-signals/:id', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/logic-indicator-signals/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM logic_indicator_signals WHERE id = $1',
      [id]
    );
    if (rowCount === 0) {
      res.status(404).json({ error: 'Signal not found' });
      return;
    }
    res.json({ ok: true, id });
  } catch (err) {
    console.error('DELETE /api/logic-indicator-signals/:id', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logic-stops', async (req, res) => {
  const logicId = Number(req.query.logic_id);
  if (!Number.isInteger(logicId) || logicId <= 0) {
    res.status(400).json({ error: 'logic_id required' });
    return;
  }
  try {
    const { rows } = await pool.query(
      `
      SELECT
        id, logic_id, rule_kind, scope_type,
        value::float8 AS value,
        inversion_value::float8 AS inversion_value,
        value_unit,
        display_order, is_active, created_at
      FROM logic_stops
      WHERE logic_id = $1
      ORDER BY rule_kind, display_order, id
      `,
      [logicId]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/logic-stops', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logic-stops', async (req, res) => {
  const logicId = Number(req.body?.logic_id);
  const ruleKind = btrimStr(req.body?.rule_kind);
  const scopeType = btrimStr(req.body?.scope_type);
  const valueUnit = btrimStr(req.body?.value_unit);
  const value = Number(req.body?.value);
  if (!Number.isInteger(logicId) || logicId <= 0) {
    res.status(400).json({ error: 'logic_id required' });
    return;
  }
  if (ruleKind !== 'stop_loss' && ruleKind !== 'take_profit') {
    res.status(400).json({ error: 'rule_kind must be stop_loss or take_profit' });
    return;
  }
  if (!isScopeValidForRuleKind(ruleKind, scopeType)) {
    res.status(400).json({
      error:
        ruleKind === 'take_profit'
          ? 'scope_type for take_profit must be security, portfolio or portfolio_ltp_renew'
          : 'scope_type must be security, security_resume, security_inversion, portfolio or portfolio_resume',
    });
    return;
  }
  if (!isScopeChoosableForRuleKind(ruleKind, scopeType)) {
    res.status(400).json({
      error:
        ruleKind === 'take_profit'
          ? 'take_profit by portfolio is not choosable (only security)'
          : 'this stop-loss scope is not choosable (portfolio_resume)',
    });
    return;
  }
  if (valueUnit !== 'percent' && valueUnit !== 'atr') {
    res.status(400).json({ error: 'value_unit must be percent or atr' });
    return;
  }
  if (!Number.isFinite(value) || value <= 0) {
    res.status(400).json({ error: 'value must be a positive number' });
    return;
  }
  try {
    const { rows: orderRows } = await pool.query(
      `SELECT COALESCE(MAX(display_order), 0) + 1 AS next_order
       FROM logic_stops WHERE logic_id = $1 AND rule_kind = $2`,
      [logicId, ruleKind]
    );
    const displayOrder = orderRows[0]?.next_order ?? 1;
    const { rows } = await pool.query(
      `
      INSERT INTO logic_stops
        (logic_id, rule_kind, scope_type, value, inversion_value, value_unit, display_order)
      VALUES ($1, $2, $3, $4, NULL, $5, $6)
      RETURNING id, logic_id, rule_kind, scope_type,
        value::float8 AS value,
        inversion_value::float8 AS inversion_value,
        value_unit, display_order, is_active, created_at
      `,
      [logicId, ruleKind, scopeType, value, valueUnit, displayOrder]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /api/logic-stops', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/logic-stops/:id', async (req, res) => {
  const id = Number(req.params.id);
  const scopeType = req.body?.scope_type != null ? btrimStr(req.body.scope_type) : null;
  const valueUnit = req.body?.value_unit != null ? btrimStr(req.body.value_unit) : null;
  const value = req.body?.value != null ? Number(req.body.value) : null;
  const isActive = req.body?.is_active;
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  if (valueUnit && valueUnit !== 'percent' && valueUnit !== 'atr') {
    res.status(400).json({ error: 'value_unit must be percent or atr' });
    return;
  }
  if (value != null && (!Number.isFinite(value) || value <= 0)) {
    res.status(400).json({ error: 'value must be a positive number' });
    return;
  }
  try {
    const { rows: existingRows } = await pool.query(
      'SELECT rule_kind, scope_type FROM logic_stops WHERE id = $1',
      [id]
    );
    if (existingRows.length === 0) {
      res.status(404).json({ error: 'Stop rule not found' });
      return;
    }
    const ruleKind = existingRows[0].rule_kind;
    if (scopeType) {
      if (!isScopeValidForRuleKind(ruleKind, scopeType)) {
        res.status(400).json({
          error:
            ruleKind === 'take_profit'
              ? 'scope_type for take_profit must be security, portfolio or portfolio_ltp_renew'
              : 'scope_type must be security, security_resume, security_inversion, portfolio or portfolio_resume',
        });
        return;
      }
      if (!isScopeChoosableForRuleKind(ruleKind, scopeType)) {
        res.status(400).json({
          error:
            ruleKind === 'take_profit'
              ? 'take_profit by portfolio is not choosable (only security)'
              : 'this stop-loss scope is not choosable (portfolio_resume)',
        });
        return;
      }
    }

    const { rows } = await pool.query(
      `
      UPDATE logic_stops
      SET scope_type = COALESCE($2, scope_type),
          value = COALESCE($3, value),
          value_unit = COALESCE($4, value_unit),
          is_active = COALESCE($5::boolean, is_active),
          inversion_value = NULL
      WHERE id = $1
      RETURNING id, logic_id, rule_kind, scope_type,
        value::float8 AS value,
        inversion_value::float8 AS inversion_value,
        value_unit, display_order, is_active, created_at
      `,
      [
        id,
        scopeType || null,
        value != null ? value : null,
        valueUnit || null,
        isActive === undefined ? null : isActive,
      ]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Stop rule not found' });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('PUT /api/logic-stops/:id', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/logic-stops/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  try {
    const { rowCount } = await pool.query('DELETE FROM logic_stops WHERE id = $1', [id]);
    if (rowCount === 0) {
      res.status(404).json({ error: 'Stop rule not found' });
      return;
    }
    res.json({ ok: true, id });
  } catch (err) {
    console.error('DELETE /api/logic-stops/:id', err);
    res.status(500).json({ error: err.message });
  }
});

const LOGIC_SECURITY_SELECT = `
  SELECT
    ls.id,
    ls.logic_id,
    ls.security_id,
    ls.display_order,
    ls.is_active,
    ls.created_at,
    ls.real_trading_paused,
    ls.real_trading_paused_long,
    ls.real_trading_paused_short,
    ls.real_trading_inverted,
    ls.stop_resume_equity::float8 AS stop_resume_equity,
    ls.stop_resume_baseline::float8 AS stop_resume_baseline,
    ls.stop_resume_triggered_at,
    ls.stop_resume_equity_long::float8 AS stop_resume_equity_long,
    ls.stop_resume_baseline_long::float8 AS stop_resume_baseline_long,
    ls.stop_resume_triggered_at_long,
    ls.stop_resume_equity_short::float8 AS stop_resume_equity_short,
    ls.stop_resume_baseline_short::float8 AS stop_resume_baseline_short,
    ls.stop_resume_triggered_at_short,
    s.name AS security_name,
    s.lot_size,
    st.name AS security_type,
    sp.prefix,
    sp.instrument_market,
    sp.underlying_security_id,
    und.name AS underlying_security_name,
    und_sp.prefix AS underlying_prefix,
    sp.exchange_id,
    e.name AS exchange_name
  FROM logic_securities ls
  JOIN securities s ON s.id = ls.security_id
  JOIN security_types st ON st.id = s.security_type_id
  LEFT JOIN LATERAL (
    SELECT prefix, instrument_market, exchange_id, underlying_security_id
    FROM security_prefixes
    WHERE security_id = s.id
    ORDER BY exchange_id
    LIMIT 1
  ) sp ON TRUE
  LEFT JOIN securities und ON und.id = sp.underlying_security_id
  LEFT JOIN LATERAL (
    SELECT prefix
    FROM security_prefixes
    WHERE security_id = und.id
    ORDER BY exchange_id
    LIMIT 1
  ) und_sp ON TRUE
  LEFT JOIN exchanges e ON e.id = sp.exchange_id
`;

app.get('/api/logic-securities', async (req, res) => {
  const logicId = Number(req.query.logic_id);
  if (!Number.isInteger(logicId) || logicId <= 0) {
    res.status(400).json({ error: 'logic_id required' });
    return;
  }
  try {
    const { rows } = await pool.query(
      `${LOGIC_SECURITY_SELECT}
       WHERE ls.logic_id = $1
       ORDER BY ls.display_order, ls.id`,
      [logicId]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/logic-securities', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logic-securities/bulk', async (req, res) => {
  const logicId = Number(req.body?.logic_id);
  const rawIds = req.body?.security_ids;
  if (!Number.isInteger(logicId) || logicId <= 0) {
    res.status(400).json({ error: 'logic_id required' });
    return;
  }
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    res.status(400).json({ error: 'security_ids array required' });
    return;
  }
  const securityIds = [
    ...new Set(
      rawIds
        .map((x) => Number(x))
        .filter((id) => Number.isInteger(id) && id > 0)
    ),
  ];
  if (securityIds.length === 0) {
    res.status(400).json({ error: 'No valid security_ids' });
    return;
  }
  try {
    const { rows: logicRows } = await pool.query(
      'SELECT id FROM logics WHERE id = $1',
      [logicId]
    );
    if (logicRows.length === 0) {
      res.status(404).json({ error: 'Logic not found' });
      return;
    }
    const { rows: inserted } = await pool.query(
      `
      INSERT INTO logic_securities (logic_id, security_id, display_order)
      SELECT
        $1,
        sid,
        COALESCE(
          (SELECT MAX(display_order) FROM logic_securities WHERE logic_id = $1),
          0
        ) + row_number() OVER ()
      FROM unnest($2::int[]) AS sid
      ON CONFLICT (logic_id, security_id) DO UPDATE SET is_active = TRUE
      RETURNING id
      `,
      [logicId, securityIds]
    );
    const ids = inserted.map((r) => r.id);
    if (ids.length === 0) {
      res.json([]);
      return;
    }
    const { rows } = await pool.query(
      `${LOGIC_SECURITY_SELECT} WHERE ls.id = ANY($1::int[]) ORDER BY ls.display_order, ls.id`,
      [ids]
    );
    res.status(201).json(rows);
  } catch (err) {
    console.error('POST /api/logic-securities/bulk', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/logic-securities/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM logic_securities WHERE id = $1',
      [id]
    );
    if (rowCount === 0) {
      res.status(404).json({ error: 'Logic security not found' });
      return;
    }
    res.json({ ok: true, id });
  } catch (err) {
    console.error('DELETE /api/logic-securities/:id', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logics/:id/non-trading-periods', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid logic id' });
    return;
  }
  try {
    await pool.query('SELECT logic_ensure_non_trading_periods($1)', [id]);
    const { rows } = await pool.query(
      `
      SELECT
        id,
        logic_id,
        day_of_week,
        to_char(time_from, 'HH24:MI') AS time_from,
        to_char(time_to, 'HH24:MI') AS time_to,
        note,
        display_order,
        is_active
      FROM logic_non_trading_intervals
      WHERE logic_id = $1
      ORDER BY day_of_week, time_from, id
      `,
      [id]
    );
    const trading = await getTradingParams(pool, id);
    res.json({
      logic_id: id,
      use_non_trading_periods: trading.use_non_trading_periods !== false,
      intervals: rows,
    });
  } catch (err) {
    console.error('GET /api/logics/:id/non-trading-periods', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logics/:id/non-trading-periods/moex-defaults', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid logic id' });
    return;
  }
  try {
    const { rows: exists } = await pool.query('SELECT id FROM logics WHERE id = $1', [id]);
    if (exists.length === 0) {
      res.status(404).json({ error: 'Logic not found' });
      return;
    }
    const { rows } = await pool.query(
      'SELECT logic_apply_moex_non_trading_periods($1::INTEGER) AS n',
      [id]
    );
    const { rows: intervals } = await pool.query(
      `
      SELECT
        id,
        logic_id,
        day_of_week,
        to_char(time_from, 'HH24:MI') AS time_from,
        to_char(time_to, 'HH24:MI') AS time_to,
        note,
        display_order,
        is_active
      FROM logic_non_trading_intervals
      WHERE logic_id = $1
      ORDER BY day_of_week, time_from, id
      `,
      [id]
    );
    const trading = await getTradingParams(pool, id);
    await writeTechLogEvent(pool, {
      threadKey: `logic:${id}:sessions`,
      operation: 'logic.non_trading.moex_defaults',
      message: 'Неторговые периоды установлены как на MOEX',
      source: 'api',
      logicId: id,
      payload: { count: rows[0]?.n ?? intervals.length },
    });
    res.json({
      logic_id: id,
      applied: Number(rows[0]?.n ?? 0),
      use_non_trading_periods: trading.use_non_trading_periods !== false,
      intervals,
    });
  } catch (err) {
    console.error('POST /api/logics/:id/non-trading-periods/moex-defaults', err);
    res.status(500).json({ error: err.message });
  }
});


app.post('/api/logics/:id/non-trading-periods', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid logic id' });
    return;
  }
  const day = Math.round(Number(req.body?.day_of_week));
  const timeFrom = parseTimeHm(req.body?.time_from);
  const timeTo = parseTimeHm(req.body?.time_to);
  const note =
    req.body?.note == null || req.body?.note === ''
      ? null
      : String(req.body.note).trim().slice(0, 200);
  if (!Number.isInteger(day) || day < 1 || day > 7) {
    res.status(400).json({ error: 'day_of_week: целое 1…7 (Пн…Вс)' });
    return;
  }
  if (!timeFrom || !timeTo) {
    res.status(400).json({ error: 'time_from / time_to: формат ЧЧ:ММ' });
    return;
  }
  if (timeFrom > timeTo) {
    res.status(400).json({ error: 'time_from не позже time_to' });
    return;
  }
  try {
    const { rows: exists } = await pool.query('SELECT id FROM logics WHERE id = $1', [id]);
    if (exists.length === 0) {
      res.status(404).json({ error: 'Logic not found' });
      return;
    }
    const { rows: ord } = await pool.query(
      `
      SELECT COALESCE(MAX(display_order), 0) + 1 AS n
      FROM logic_non_trading_intervals
      WHERE logic_id = $1
      `,
      [id]
    );
    await pool.query(
      `
      INSERT INTO logic_non_trading_intervals (
        logic_id, day_of_week, time_from, time_to, note, display_order, is_active
      )
      VALUES ($1, $2, $3::time, $4::time, $5, $6, TRUE)
      `,
      [id, day, timeFrom, timeTo, note, Number(ord[0]?.n ?? 1)]
    );
    const trading = await getTradingParams(pool, id);
    res.status(201).json({
      logic_id: id,
      use_non_trading_periods: trading.use_non_trading_periods !== false,
      intervals: await fetchNonTradingIntervals(pool, id),
    });
  } catch (err) {
    console.error('POST /api/logics/:id/non-trading-periods', err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/logic-non-trading-intervals/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid interval id' });
    return;
  }
  const patches = [];
  const vals = [];
  let n = 1;
  if (req.body?.day_of_week !== undefined) {
    const day = Math.round(Number(req.body.day_of_week));
    if (!Number.isInteger(day) || day < 1 || day > 7) {
      res.status(400).json({ error: 'day_of_week: целое 1…7' });
      return;
    }
    patches.push(`day_of_week = $${n++}`);
    vals.push(day);
  }
  if (req.body?.time_from !== undefined) {
    const t = parseTimeHm(req.body.time_from);
    if (!t) {
      res.status(400).json({ error: 'time_from: ЧЧ:ММ' });
      return;
    }
    patches.push(`time_from = $${n++}::time`);
    vals.push(t);
  }
  if (req.body?.time_to !== undefined) {
    const t = parseTimeHm(req.body.time_to);
    if (!t) {
      res.status(400).json({ error: 'time_to: ЧЧ:ММ' });
      return;
    }
    patches.push(`time_to = $${n++}::time`);
    vals.push(t);
  }
  if (req.body?.note !== undefined) {
    const note =
      req.body.note == null || req.body.note === ''
        ? null
        : String(req.body.note).trim().slice(0, 200);
    patches.push(`note = $${n++}`);
    vals.push(note);
  }
  if (req.body?.is_active !== undefined) {
    patches.push(`is_active = $${n++}`);
    vals.push(Boolean(req.body.is_active));
  }
  if (patches.length === 0) {
    res.status(400).json({ error: 'Нечего обновлять' });
    return;
  }
  vals.push(id);
  try {
    const { rows } = await pool.query(
      `
      UPDATE logic_non_trading_intervals
      SET ${patches.join(', ')}
      WHERE id = $${n}
      RETURNING logic_id
      `,
      vals
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Interval not found' });
      return;
    }
    const logicId = rows[0].logic_id;
    const trading = await getTradingParams(pool, logicId);
    res.json({
      logic_id: logicId,
      use_non_trading_periods: trading.use_non_trading_periods !== false,
      intervals: await fetchNonTradingIntervals(pool, logicId),
    });
  } catch (err) {
    console.error('PATCH /api/logic-non-trading-intervals/:id', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/logic-non-trading-intervals/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid interval id' });
    return;
  }
  try {
    const { rows } = await pool.query(
      `
      DELETE FROM logic_non_trading_intervals
      WHERE id = $1
      RETURNING logic_id
      `,
      [id]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Interval not found' });
      return;
    }
    const logicId = rows[0].logic_id;
    const trading = await getTradingParams(pool, logicId);
    res.json({
      ok: true,
      logic_id: logicId,
      use_non_trading_periods: trading.use_non_trading_periods !== false,
      intervals: await fetchNonTradingIntervals(pool, logicId),
    });
  } catch (err) {
    console.error('DELETE /api/logic-non-trading-intervals/:id', err);
    res.status(500).json({ error: err.message });
  }
});
};
