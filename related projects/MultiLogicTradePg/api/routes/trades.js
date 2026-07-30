/**
 * Logic trades, lots, heartbeat, close-all.
 */
const {
  LOGIC_TRADE_SELECT,
  LOGIC_TRADE_SELECT_TEST_PANEL,
} = require('../lib/logic-trade-sql');

module.exports = function registerTradesRoutes(app, ctx) {
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
    getTradeRunnerHealth,
    runWatchdogTick,
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

app.get('/api/logic-trades', async (req, res) => {
  const logicId = Number(req.query.logic_id);
  if (!Number.isInteger(logicId) || logicId <= 0) {
    res.status(400).json({ error: 'logic_id required' });
    return;
  }
  const isTestRaw = req.query.is_test;
  const isTest =
    isTestRaw === '1' || isTestRaw === 'true'
      ? true
      : isTestRaw === '0' || isTestRaw === 'false'
        ? false
        : null;
  const runIdRaw = req.query.run_id;
  const runId =
    runIdRaw != null && runIdRaw !== '' && Number.isFinite(Number(runIdRaw))
      ? Number(runIdRaw)
      : null;
  const limitRaw = Number(req.query.limit);
  // Test runs can exceed 5k closes; panel must load the full latest run or finres != table column.
  const defaultLimit = isTest === true ? 20000 : 100;
  const limitCap = isTest === true ? 50000 : 500;
  const limit = Math.min(
    Math.max(Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : defaultLimit, 1),
    limitCap
  );
  try {
    const params = [logicId];
    let where = 'WHERE lt.logic_id = $1';
    if (isTest === true) {
      where += ' AND lt.is_test = TRUE';
    } else if (isTest === false) {
      where += ' AND lt.is_test = FALSE';
    }
    if (runId != null && runId > 0) {
      params.push(runId);
      where += ` AND lt.run_id = $${params.length}`;
    }
    params.push(limit);
    const { rows } = await pool.query(
      `${LOGIC_TRADE_SELECT}
       ${where}
       ORDER BY lt.executed_at DESC, lt.id DESC
       LIMIT $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/logic-trades', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Full trade dump for analysis (open/close/shadow/rejected/etc. + lots).
 * Query: logic_id, is_test=0|1, optional run_id (test: omit = latest run if any).
 */
app.get('/api/logic-trades/export', async (req, res) => {
  const logicId = Number(req.query.logic_id);
  if (!Number.isInteger(logicId) || logicId <= 0) {
    res.status(400).json({ error: 'logic_id required' });
    return;
  }
  const isTestRaw = req.query.is_test;
  const isTest =
    isTestRaw === '1' || isTestRaw === 'true'
      ? true
      : isTestRaw === '0' || isTestRaw === 'false'
        ? false
        : null;
  if (isTest == null) {
    res.status(400).json({ error: 'is_test required (0 or 1)' });
    return;
  }
  let runId =
    req.query.run_id != null &&
    req.query.run_id !== '' &&
    Number.isFinite(Number(req.query.run_id))
      ? Number(req.query.run_id)
      : null;
  try {
    const { rows: logicRows } = await pool.query(
      `SELECT id, name, is_enabled, note FROM logics WHERE id = $1`,
      [logicId]
    );
    if (logicRows.length === 0) {
      res.status(404).json({ error: 'Logic not found' });
      return;
    }
    const logic = logicRows[0];

    // Same portable definition as logics/export: params, signals, stops, papers, account.
    const logicBundle = await buildLogicBundle(pool, [logicId]);
    const logicDef = logicBundle.logics?.[0] || {
      name: logic.name,
      note: logic.note,
      params: [],
      signals: [],
      stops: [],
      securities: [],
      account: null,
    };
    const tradingParams = await getTradingParams(pool, logicId);
    let nonTradingIntervals = [];
    try {
      await pool.query('SELECT logic_ensure_non_trading_periods($1)', [logicId]);
      nonTradingIntervals = await fetchNonTradingIntervals(pool, logicId);
    } catch (_ntpErr) {
      nonTradingIntervals = [];
    }

    let runMeta = null;
    if (isTest) {
      if (runId == null || runId <= 0) {
        const { rows: runRows } = await pool.query(
          `SELECT id, date_from, date_to, status, financial_result, test_balance,
                  to_char(started_at, 'YYYY-MM-DD HH24:MI:SS') AS started_at,
                  to_char(finished_at, 'YYYY-MM-DD HH24:MI:SS') AS finished_at
           FROM logic_backtest_runs
           WHERE logic_id = $1
           ORDER BY id DESC
           LIMIT 1`,
          [logicId]
        );
        if (runRows.length > 0) {
          runId = Number(runRows[0].id);
          runMeta = runRows[0];
        }
      } else {
        const { rows: runRows } = await pool.query(
          `SELECT id, date_from, date_to, status, financial_result, test_balance,
                  to_char(started_at, 'YYYY-MM-DD HH24:MI:SS') AS started_at,
                  to_char(finished_at, 'YYYY-MM-DD HH24:MI:SS') AS finished_at
           FROM logic_backtest_runs
           WHERE logic_id = $1 AND id = $2`,
          [logicId, runId]
        );
        runMeta = runRows[0] || null;
      }
    }

    const params = [logicId];
    let where = 'WHERE lt.logic_id = $1 AND lt.is_test = $2';
    params.push(isTest);
    if (isTest && runId != null && runId > 0) {
      params.push(runId);
      where += ` AND lt.run_id = $${params.length}`;
    }
    // No status/shadow filter — full dump for analysis.
    const limit = 100000;
    params.push(limit);
    const { rows: trades } = await pool.query(
      `${LOGIC_TRADE_SELECT}
       ${where}
       ORDER BY lt.bar_dt ASC NULLS LAST, lt.executed_at ASC, lt.id ASC
       LIMIT $${params.length}`,
      params
    );

    const tradeIds = trades.map((t) => Number(t.id)).filter((id) => id > 0);
    let lots = [];
    if (tradeIds.length > 0) {
      const { rows: lotRows } = await pool.query(
        `
        SELECT
          l.id,
          l.logic_id,
          l.close_trade_id,
          l.open_trade_id,
          l.action_id,
          l.cost_method,
          l.quantity,
          l.close_amount,
          l.open_amount,
          l.close_commission,
          l.open_commission,
          l.financial_result,
          to_char(l.created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at,
          ac.name AS action_name,
          to_char(ot.executed_at, 'YYYY-MM-DD HH24:MI:SS') AS open_executed_at,
          ot.price AS open_price,
          to_char(ct.executed_at, 'YYYY-MM-DD HH24:MI:SS') AS close_executed_at,
          ct.price AS close_price
        FROM logic_trade_lots l
        JOIN actions ac ON ac.id = l.action_id
        JOIN logic_trades ct ON ct.id = l.close_trade_id
        LEFT JOIN logic_trades ot ON ot.id = l.open_trade_id
        WHERE l.logic_id = $1
          AND (l.close_trade_id = ANY($2::bigint[]) OR l.open_trade_id = ANY($2::bigint[]))
        ORDER BY l.id ASC
        `,
        [logicId, tradeIds]
      );
      lots = lotRows;
    }

    const counts = {
      total: trades.length,
      open: 0,
      close: 0,
      shadow: 0,
      non_shadow: 0,
      simulated: 0,
      fictitious: 0,
      by_status: {},
      by_signal_kind: {},
      with_remaining: 0,
      lots: lots.length,
    };
    for (const t of trades) {
      if (t.side_name === 'Open') counts.open += 1;
      if (t.side_name === 'Close') counts.close += 1;
      if (t.is_shadow) counts.shadow += 1;
      else counts.non_shadow += 1;
      if (t.is_simulated) counts.simulated += 1;
      if (t.is_fictitious) counts.fictitious += 1;
      const st = String(t.status || 'unknown');
      counts.by_status[st] = (counts.by_status[st] || 0) + 1;
      const sk = String(t.signal_kind || 'unknown');
      counts.by_signal_kind[sk] = (counts.by_signal_kind[sk] || 0) + 1;
      if (t.remaining_qty != null && Number(t.remaining_qty) > 0) {
        counts.with_remaining += 1;
      }
    }

    res.json({
      format: 'multilogic-trades-export',
      version: 2,
      exported_at: new Date().toISOString(),
      is_test: isTest,
      // Full logic card for analysis (params, signals, stops, papers, account).
      logic: {
        id: Number(logicDef.id ?? logicId),
        name: logicDef.name,
        note: logicDef.note ?? null,
        is_enabled: Boolean(logic.is_enabled),
        account: logicDef.account ?? null,
        params: logicDef.params ?? [],
        signals: logicDef.signals ?? [],
        stops: logicDef.stops ?? [],
        securities: logicDef.securities ?? [],
      },
      trading_params: tradingParams,
      non_trading_periods: {
        use_non_trading_periods: tradingParams.use_non_trading_periods !== false,
        intervals: nonTradingIntervals,
      },
      run_id: runId,
      run: runMeta,
      counts,
      trades,
      lots,
      note:
        'Complete dump for AI/debug: logic params/signals/stops/papers, trading params, non-trading periods, all trades (open/close/shadow/simulated/fictitious/all statuses) + lots.',
    });
  } catch (err) {
    console.error('GET /api/logic-trades/export', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Lightweight champion equity curve for the Testing panel while a run is active.
 * Same filters as /pnl-summary + Close-only (matches UI buildEquityPoints).
 * Avoids shipping full 50k trade JSON mid-run.
 */
app.get('/api/logic-trades/equity-curve', async (req, res) => {
  const logicId = Number(req.query.logic_id);
  if (!Number.isInteger(logicId) || logicId <= 0) {
    res.status(400).json({ error: 'logic_id required' });
    return;
  }
  const isTestRaw = req.query.is_test;
  const isTest =
    isTestRaw === '0' || isTestRaw === 'false' ? false : true;
  const runIdQ = Number(req.query.run_id);
  const runIdFilter =
    Number.isInteger(runIdQ) && runIdQ > 0 ? runIdQ : null;
  try {
    const { rows } = await pool.query(
      isTest
        ? `
        WITH latest_run AS (
          SELECT
            r.id AS run_id,
            r.date_from::text AS date_from,
            r.date_to::text AS date_to
          FROM logic_backtest_runs r
          WHERE r.logic_id = $1
            AND ($2::bigint IS NULL OR r.id = $2::bigint)
          ORDER BY r.id DESC
          LIMIT 1
        ),
        closes AS (
          SELECT
            lt.id,
            COALESCE(lt.bar_dt, lt.executed_at)::text AS dt,
            lt.financial_result::float8 AS financial_result,
            a.name AS action_name,
            COALESCE(lt.is_shadow, FALSE) AS is_shadow
          FROM logic_trades lt
          JOIN latest_run lr ON TRUE
          JOIN actions a ON a.id = lt.action_id
          JOIN sides s ON s.id = lt.side_id
          WHERE lt.logic_id = $1
            AND lt.is_test = TRUE
            AND s.name = 'Close'
            AND COALESCE(lt.opt_lane, '') = ''
            AND lt.status IN ('filled', 'submitted')
            AND lt.financial_result IS NOT NULL
            AND (
              (lt.run_id IS NOT NULL AND lt.run_id = lr.run_id)
              OR (
                lt.run_id IS NULL
                AND NOT EXISTS (
                  SELECT 1
                  FROM logic_trades x
                  WHERE x.logic_id = lt.logic_id
                    AND x.is_test = TRUE
                    AND x.run_id IS NOT NULL
                )
              )
            )
        )
        SELECT
          (SELECT run_id FROM latest_run) AS run_id,
          (SELECT date_from FROM latest_run) AS date_from,
          (SELECT date_to FROM latest_run) AS date_to,
          c.dt,
          c.financial_result,
          c.action_name,
          c.is_shadow,
          c.id
        FROM closes c
        ORDER BY c.dt NULLS LAST, c.id NULLS LAST
        `
        : `
        SELECT
          NULL::bigint AS run_id,
          NULL::text AS date_from,
          NULL::text AS date_to,
          COALESCE(lt.bar_dt, lt.executed_at)::text AS dt,
          lt.financial_result::float8 AS financial_result,
          a.name AS action_name,
          COALESCE(lt.is_shadow, FALSE) AS is_shadow,
          lt.id
        FROM logic_trades lt
        JOIN actions a ON a.id = lt.action_id
        JOIN sides s ON s.id = lt.side_id
        WHERE lt.logic_id = $1
          AND lt.is_test = FALSE
          AND s.name = 'Close'
          AND COALESCE(lt.opt_lane, '') = ''
          AND lt.status IN ('filled', 'submitted')
          AND lt.financial_result IS NOT NULL
        ORDER BY COALESCE(lt.bar_dt, lt.executed_at), lt.id
        `,
      isTest ? [logicId, runIdFilter] : [logicId]
    );

    const closes = rows
      .filter((r) => r.dt != null && r.financial_result != null)
      .map((r) => ({
        dt: String(r.dt),
        financial_result: Number(r.financial_result),
        action_name: r.action_name != null ? String(r.action_name) : null,
        is_shadow: Boolean(r.is_shadow),
      }));

    let dateFromFinal =
      rows.find((r) => r.date_from != null)?.date_from != null
        ? String(rows.find((r) => r.date_from != null).date_from)
        : null;
    let dateToFinal =
      rows.find((r) => r.date_to != null)?.date_to != null
        ? String(rows.find((r) => r.date_to != null).date_to)
        : null;
    let runIdOut =
      rows.find((r) => r.run_id != null)?.run_id != null
        ? Number(rows.find((r) => r.run_id != null).run_id)
        : runIdFilter;

    if (isTest && (dateFromFinal == null || runIdOut == null)) {
      const meta = await pool.query(
        `
        SELECT id AS run_id, date_from::text AS date_from, date_to::text AS date_to
        FROM logic_backtest_runs
        WHERE logic_id = $1
          AND ($2::bigint IS NULL OR id = $2::bigint)
        ORDER BY id DESC
        LIMIT 1
        `,
        [logicId, runIdFilter]
      );
      if (meta.rows[0]) {
        dateFromFinal = dateFromFinal ?? (meta.rows[0].date_from != null ? String(meta.rows[0].date_from) : null);
        dateToFinal = dateToFinal ?? (meta.rows[0].date_to != null ? String(meta.rows[0].date_to) : null);
        runIdOut = runIdOut ?? Number(meta.rows[0].run_id);
      }
    }

    const buildSeries = (sideFilter, shadowOnly = false) => {
      const filtered =
        sideFilter == null
          ? closes
          : closes.filter((c) => {
              const a = (c.action_name || '').toLowerCase();
              if (sideFilter === 'long') return a === 'long';
              if (sideFilter === 'short') return a === 'short';
              return true;
            });
      const scoped = shadowOnly
        ? filtered.filter((c) => c.is_shadow)
        : filtered.filter((c) => !c.is_shadow);
      const zeroDt =
        dateFromFinal ||
        (scoped[0]?.dt ? String(scoped[0].dt) : null) ||
        (closes[0]?.dt ? String(closes[0].dt) : null);
      if (scoped.length === 0) {
        return zeroDt ? [{ dt: zeroDt, value: 0 }] : [];
      }
      const startDt =
        dateFromFinal && (!scoped[0].dt || String(dateFromFinal) <= scoped[0].dt)
          ? dateFromFinal
          : scoped[0].dt;
      let cum = 0;
      const points = [{ dt: startDt, value: 0 }];
      for (const c of scoped) {
        cum += c.financial_result;
        if (
          points.length === 1 &&
          points[0].dt === c.dt &&
          points[0].value === 0
        ) {
          points[0] = { dt: c.dt, value: cum };
        } else {
          points.push({ dt: c.dt, value: cum });
        }
      }
      return points;
    };

    res.json({
      logic_id: logicId,
      is_test: isTest,
      run_id: runIdOut ?? null,
      date_from: dateFromFinal,
      date_to: dateToFinal,
      total: buildSeries(null, false),
      long: buildSeries('long', false),
      short: buildSeries('short', false),
      shadow_total: buildSeries(null, true),
      close_count: closes.filter((c) => !c.is_shadow).length,
      shadow_close_count: closes.filter((c) => c.is_shadow).length,
      financial_result:
        closes.filter((c) => !c.is_shadow).length > 0
          ? closes.filter((c) => !c.is_shadow).reduce((s, c) => s + c.financial_result, 0)
          : 0,
    });
  } catch (err) {
    console.error('GET /api/logic-trades/equity-curve', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Mid-run Testing panel: all champion opens + recent champion closes.
 * Avoids shipping OPT paper / full 50k dump (UI freeze) while still filling
 * «Сделки» / «Бумаги» during a running backtest.
 */
app.get('/api/logic-trades/test-panel', async (req, res) => {
  const logicId = Number(req.query.logic_id);
  if (!Number.isInteger(logicId) || logicId <= 0) {
    res.status(400).json({ error: 'logic_id required' });
    return;
  }
  const runIdRaw = req.query.run_id;
  const runId =
    runIdRaw != null && runIdRaw !== '' && Number.isFinite(Number(runIdRaw))
      ? Number(runIdRaw)
      : null;
  const closeLimitRaw = Number(req.query.close_limit);
  const closeLimit = Math.min(
    Math.max(
      Number.isFinite(closeLimitRaw) && closeLimitRaw > 0 ? closeLimitRaw : 2500,
      1
    ),
    8000
  );
  try {
    const params = [logicId];
    let runFilter = '';
    if (runId != null && runId > 0) {
      params.push(runId);
      runFilter = ` AND lt.run_id = $${params.length}`;
    } else {
      runFilter = `
        AND (
          lt.run_id = (
            SELECT r.id FROM logic_backtest_runs r
            WHERE r.logic_id = $1
            ORDER BY r.id DESC
            LIMIT 1
          )
          OR (
            lt.run_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM logic_trades x
              WHERE x.logic_id = $1 AND x.is_test = TRUE AND x.run_id IS NOT NULL
            )
          )
        )`;
    }
    params.push(closeLimit);
    const closeLimitParam = `$${params.length}`;

    const { rows } = await pool.query(
      `
      WITH base AS (
        ${LOGIC_TRADE_SELECT_TEST_PANEL}
        WHERE lt.logic_id = $1
          AND lt.is_test = TRUE
          AND COALESCE(lt.is_shadow, FALSE) = FALSE
          AND COALESCE(lt.opt_lane, '') = ''
          AND lt.status IN ('filled', 'submitted')
          ${runFilter}
      ),
      opens AS (
        -- Only still-open positions (matches UI «Сделки открытия» filter).
        SELECT * FROM base
        WHERE side_name = 'Open'
          AND COALESCE(remaining_qty, 0) > 0
      ),
      closes AS (
        SELECT * FROM base
        WHERE side_name = 'Close'
        ORDER BY bar_dt DESC, id DESC
        LIMIT ${closeLimitParam}
      )
      SELECT * FROM opens
      UNION ALL
      SELECT * FROM closes
      ORDER BY executed_at DESC, id DESC
      `,
      params
    );
    res.json({
      logic_id: logicId,
      run_id: runId,
      close_limit: closeLimit,
      rows,
    });
  } catch (err) {
    console.error('GET /api/logic-trades/test-panel', err);
    res.status(500).json({ error: err.message });
  }
});

/** Онлайн-сводка PnL/комиссий по логикам (не хранится отдельным полем). */
app.get('/api/logic-trades/pnl-summary', async (req, res) => {
  const isTestRaw = req.query.is_test;
  const isTest =
    isTestRaw === '0' || isTestRaw === 'false'
      ? false
      : true; // по умолчанию тест — для колонки на главной
  try {
    if (isTest) {
      // Только живые is_test-сделки этой логики (не fallback на runs —
      // иначе после DELETE при новом тесте в таблице «висит» старый financial_result прогона).
      // При наличии run_id берём сделки последнего прогона логики.
      const { rows } = await pool.query(
        `
        -- latest_run: тот же критерий, что getBacktestStatus (ORDER BY id DESC),
        -- иначе колонка «Тест» и блок «Тестирование» суммируют разные прогоны.
        WITH latest_run AS (
          SELECT DISTINCT ON (r.logic_id)
            r.logic_id,
            r.id AS run_id,
            r.date_from::text AS date_from,
            r.date_to::text AS date_to
          FROM logic_backtest_runs r
          ORDER BY r.logic_id, r.id DESC
        )
        SELECT
          lt.logic_id,
          COALESCE(SUM(lt.financial_result), 0)::float8 AS financial_result,
          COALESCE(SUM(COALESCE(lt.commission, 0)), 0)::float8 AS commission,
          COUNT(*)::int AS trade_count,
          MAX(lr.date_from) AS date_from,
          MAX(lr.date_to) AS date_to
        FROM logic_trades lt
        LEFT JOIN latest_run lr ON lr.logic_id = lt.logic_id
        WHERE lt.is_test = TRUE
          AND COALESCE(lt.is_shadow, FALSE) = FALSE
          AND COALESCE(lt.opt_lane, '') = ''
          AND lt.status IN ('filled', 'submitted')
          AND (
            (lt.run_id IS NOT NULL AND lr.run_id IS NOT NULL AND lt.run_id = lr.run_id)
            OR (
              lt.run_id IS NULL
              AND NOT EXISTS (
                SELECT 1
                FROM logic_trades x
                WHERE x.logic_id = lt.logic_id
                  AND x.is_test = TRUE
                  AND x.run_id IS NOT NULL
              )
            )
          )
        GROUP BY lt.logic_id
        HAVING COUNT(*) > 0
        ORDER BY lt.logic_id
        `
      );
      res.json({
        is_test: true,
        rows: rows.map((r) => ({
          logic_id: Number(r.logic_id),
          financial_result: Number(r.financial_result),
          commission: Number(r.commission),
          trade_count: Number(r.trade_count),
          date_from: r.date_from != null ? String(r.date_from) : null,
          date_to: r.date_to != null ? String(r.date_to) : null,
        })),
      });
      return;
    }

    const { rows } = await pool.query(
      `
      SELECT
        lt.logic_id,
        COALESCE(SUM(lt.financial_result), 0)::float8 AS financial_result,
        COALESCE(SUM(COALESCE(lt.commission, 0)), 0)::float8 AS commission,
        COUNT(*)::int AS trade_count
      FROM logic_trades lt
      WHERE lt.is_test = FALSE
        AND COALESCE(lt.is_shadow, FALSE) = FALSE
        AND COALESCE(lt.opt_lane, '') = ''
        AND lt.status IN ('filled', 'submitted')
      GROUP BY lt.logic_id
      HAVING COUNT(*) > 0
      ORDER BY lt.logic_id
      `
    );
    res.json({
      is_test: false,
      rows: rows.map((r) => ({
        logic_id: Number(r.logic_id),
        financial_result: Number(r.financial_result),
        commission: Number(r.commission),
        trade_count: Number(r.trade_count),
      })),
    });
  } catch (err) {
    console.error('GET /api/logic-trades/pnl-summary', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logic-trade-lots', async (req, res) => {
  const tradeId = Number(req.query.trade_id);
  if (!Number.isInteger(tradeId) || tradeId <= 0) {
    res.status(400).json({ error: 'trade_id required' });
    return;
  }
  try {
    const { rows } = await pool.query(
      `
      SELECT
        l.id,
        l.logic_id,
        l.close_trade_id,
        l.open_trade_id,
        l.action_id,
        l.cost_method,
        l.quantity,
        l.close_amount,
        l.open_amount,
        l.close_commission,
        l.open_commission,
        l.financial_result,
        l.created_at,
        ac.name AS action_name,
        ot.executed_at AS open_executed_at,
        ot.price AS open_price,
        ct.executed_at AS close_executed_at,
        ct.price AS close_price
      FROM logic_trade_lots l
      JOIN actions ac ON ac.id = l.action_id
      JOIN logic_trades ct ON ct.id = l.close_trade_id
      LEFT JOIN logic_trades ot ON ot.id = l.open_trade_id
      WHERE l.close_trade_id = $1 OR l.open_trade_id = $1
      ORDER BY l.id ASC
      `,
      [tradeId]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/logic-trade-lots', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logic-trades/run', async (_req, res) => {
  try {
    const result = await runTradeCycle(pool, { manual: true });
    await writeTechLogEvent(pool, {
      threadKey: 'trade-runner',
      operation: 'cycle.manual',
      message: `Ручной запуск: processed=${result.processed ?? 0} created=${result.created ?? 0}`,
      source: 'api',
      payload: result,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('POST /api/logic-trades/run', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/trade-runner/health', async (_req, res) => {
  try {
    const health = await getTradeRunnerHealth(pool);
    res.json(health);
  } catch (err) {
    console.error('GET /api/trade-runner/health', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/trade-runner/watchdog', async (_req, res) => {
  try {
    const result = await runWatchdogTick(pool, { force: true });
    res.json(result);
  } catch (err) {
    console.error('POST /api/trade-runner/watchdog', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logic-trades/heartbeat', async (_req, res) => {
  try {
    await touchUiHeartbeatDb(pool);
    res.json({ ok: true, active: isUiSessionActive() });
  } catch (err) {
    console.error('POST /api/logic-trades/heartbeat', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logic-trades/heartbeat/end', async (_req, res) => {
  try {
    await clearUiHeartbeatDb(pool);
    res.json({ ok: true, active: false });
  } catch (err) {
    console.error('POST /api/logic-trades/heartbeat/end', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logic-trades/close-all', async (req, res) => {
  const logicId = parseInt(String(req.body?.logic_id ?? req.query?.logic_id ?? ''), 10);
  if (!Number.isFinite(logicId) || logicId <= 0) {
    res.status(400).json({ error: 'Укажите logic_id' });
    return;
  }
  try {
    const { rows } = await pool.query(
      'SELECT logic_close_all_positions_at_market($1::INTEGER) AS result',
      [logicId]
    );
    const result = rows[0]?.result ?? {};
    await writeTechLogEvent(pool, {
      threadKey: 'trade-runner',
      operation: 'trade.close_all',
      message: `Закрыть всё: logic=${logicId} closed=${result.closed ?? 0}`,
      source: 'api',
      logicId,
      payload: result,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('POST /api/logic-trades/close-all', err);
    res.status(500).json({ error: err.message });
  }
});
};
