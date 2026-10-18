/**
 * Indicators, series, values, calculate.
 */

// #994-доработка: рейтинг «стареет». Эффективный рейтинг = сырой рейтинг,
// линейно угасающий до нуля за RATING_DECAY_HOURS часов с момента расчёта.
const RATING_DECAY_HOURS = Math.max(0, Number(process.env.INDICATOR_RATING_DECAY_HOURS) || 6);

function ratingDecayFactor(computedAt, hours) {
  if (!computedAt) return 0;
  const t = new Date(computedAt).getTime();
  if (!Number.isFinite(t)) return 0;
  if (!(hours > 0)) return 1;
  const ageHours = (Date.now() - t) / 3600000;
  if (ageHours <= 0) return 1;
  return Math.max(0, 1 - ageHours / hours);
}

function effectiveRating(rawRating, computedAt, hours) {
  if (rawRating == null) return null;
  const value = Number(rawRating);
  if (!Number.isFinite(value)) return null;
  return Number((value * ratingDecayFactor(computedAt, hours)).toFixed(4));
}

// #1006: создание логик из лучших рейтингов. Маркеры в имени: O — открытие, C — закрытие.
function logicNameMarkers(open, close) {
  return `${open ? 'O' : ''}${close ? 'C' : ''}`;
}

// Открытие идёт по kind разреза, закрытие — по противоположному условию того же индикатора.
function oppositeSignalKind(kind) {
  return kind === 'trend' ? 'counter' : 'trend';
}

// Уникальное имя логики (<=100 символов): базовое, при занятости — «база 2», «база 3»…
async function uniqueLogicName(queryable, baseName) {
  const base = String(baseName || '').slice(0, 100).trim() || 'Логика';
  let name = base;
  for (let n = 2; n <= 500; n += 1) {
    const { rows } = await queryable.query('SELECT 1 FROM logics WHERE name = $1', [name]);
    if (rows.length === 0) return name;
    const suffix = ` ${n}`;
    name = `${base.slice(0, 100 - suffix.length)}${suffix}`;
  }
  return name;
}

// #1006: бумаги логики из рейтинга. Основной источник — таблица-универсум
// (indicator_rating_universe), но она заполняется только для текущего прогона расчёта,
// поэтому если по ТФ в ней строк нет — берём бумаги из сырого состава расчёта
// (indicator_rating_sample), который живёт дольше. Сначала по выбранным индикаторам,
// при пустом результате — по всему ТФ; иначе логика останется без бумаг и не сможет
// работать (бэктест падает «Нет активных бумаг в логике»).
async function collectLogicSecurities(queryable, timeframeId, indicatorIds) {
  const sources = [
    [
      `SELECT DISTINCT security_id FROM indicator_rating_universe
       WHERE timeframe_id = $1 AND indicator_id = ANY($2::int[])`,
      [timeframeId, indicatorIds],
    ],
    [
      `SELECT DISTINCT security_id FROM indicator_rating_universe WHERE timeframe_id = $1`,
      [timeframeId],
    ],
    [
      `SELECT DISTINCT security_id FROM indicator_rating_sample
       WHERE timeframe_id = $1 AND indicator_id = ANY($2::int[])`,
      [timeframeId, indicatorIds],
    ],
    [
      `SELECT DISTINCT security_id FROM indicator_rating_sample WHERE timeframe_id = $1`,
      [timeframeId],
    ],
  ];
  for (const [text, values] of sources) {
    const { rows } = await queryable.query(text, values);
    if (rows.length) return rows.map((r) => Number(r.security_id));
  }
  return [];
}

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
        r.rating,
        r.best_position_side,
        r.best_signal_kind,
        r.best_time_kind,
        r.slices_count AS rating_slices_count,
        r.samples_count AS rating_samples_count,
        r.avg_annual_pct AS rating_avg_annual_pct,
        r.computed_at AS rating_computed_at,
        (
          SELECT COALESCE(
            json_agg(
              json_build_object(
                'timeframe_id', t.timeframe_id,
                'tf', tf.tf,
                'full_name', tf.full_name,
                'rating', t.rating,
                'best_position_side', t.best_position_side,
                'best_signal_kind', t.best_signal_kind,
                'best_time_kind', t.best_time_kind,
                'slices_count', t.slices_count,
                'samples_count', t.samples_count,
                'avg_annual_pct', t.avg_annual_pct,
                'bars_count', t.bars_count,
                'bars_from', t.bars_from,
                'bars_to', t.bars_to,
                'computed_at', t.computed_at
              )
              ORDER BY t.rating DESC NULLS LAST, tf.tf
            ),
            '[]'::json
          )
          FROM indicator_rating_timeframe t
          JOIN timeframes tf ON tf.id = t.timeframe_id
          WHERE t.indicator_id = i.id
        ) AS rating_timeframes,
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
      LEFT JOIN indicator_rating r ON r.indicator_id = i.id
      WHERE ($1::boolean = FALSE OR (BTRIM(COALESCE(i.script, '')) <> '' OR BTRIM(COALESCE(i.formula, '')) <> ''))
      GROUP BY i.id, r.indicator_id
      ORDER BY i.code
    `,
      [withCalc]
    );
    const rowsWithRating = rows.map((row) => {
      const timeframes = Array.isArray(row.rating_timeframes) ? row.rating_timeframes : [];
      return {
        ...row,
        rating: row.rating == null ? null : Number(row.rating),
        rating_decay_hours: RATING_DECAY_HOURS,
        rating_effective: effectiveRating(row.rating, row.rating_computed_at, RATING_DECAY_HOURS),
        rating_timeframes: timeframes.map((t) => ({
          ...t,
          rating: t.rating == null ? null : Number(t.rating),
          rating_effective: effectiveRating(t.rating, t.computed_at, RATING_DECAY_HOURS),
        })),
      };
    });
    res.json(rowsWithRating);
  } catch (err) {
    console.error('GET /api/indicators', err);
    res.status(500).json({ error: err.message });
  }
});

// #1005: статус последнего прогона расчёта рейтинга — UI показывает ошибку
// при разворачивании строки, если прогон завершился неудачно (last_status < 0).
app.get('/api/indicators/rating-status', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, last_run_at, last_status, last_message, updated_at
       FROM indicator_rating_run
       ORDER BY updated_at DESC NULLS LAST
       LIMIT 1`
    );
    const row = rows[0] ?? null;
    res.json(
      row
        ? {
            last_run_at: row.last_run_at,
            last_status: row.last_status,
            last_message: row.last_message,
            updated_at: row.updated_at,
            ok: row.last_status != null && row.last_status >= 0,
          }
        : { last_run_at: null, last_status: null, last_message: null, ok: false }
    );
  } catch (err) {
    console.error('GET /api/indicators/rating-status', err);
    res.status(500).json({ error: err.message });
  }
});

// #1006: опции для формы «Создать логику из лучших рейтингов». По каждому ТФ — список
// индикаторов с рейтингом (лучший разрез + число бумаг в универсуме расчёта). ТФ без
// рассчитанного рейтинга в список не попадают.
app.get('/api/indicators/create-logic-options', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        t.timeframe_id,
        tf.tf,
        tf.full_name,
        tf.sec,
        t.indicator_id,
        i.code,
        i.name,
        t.rating,
        t.best_position_side,
        t.best_signal_kind,
        t.best_time_kind,
        t.samples_count,
        (
          SELECT COALESCE(
            NULLIF((
              SELECT count(DISTINCT u.security_id)::int
              FROM indicator_rating_universe u
              WHERE u.indicator_id = t.indicator_id AND u.timeframe_id = t.timeframe_id
            ), 0),
            (
              SELECT count(DISTINCT s.security_id)::int
              FROM indicator_rating_sample s
              WHERE s.indicator_id = t.indicator_id AND s.timeframe_id = t.timeframe_id
            ),
            0
          )
        ) AS securities_count
      FROM indicator_rating_timeframe t
      JOIN timeframes tf ON tf.id = t.timeframe_id
      JOIN indicators i ON i.id = t.indicator_id
      ORDER BY tf.sec, t.rating DESC NULLS LAST, i.code
      `
    );
    const byTf = new Map();
    for (const row of rows) {
      const key = Number(row.timeframe_id);
      let group = byTf.get(key);
      if (!group) {
        group = {
          timeframe_id: key,
          tf: row.tf,
          full_name: row.full_name,
          indicators: [],
        };
        byTf.set(key, group);
      }
      group.indicators.push({
        indicator_id: Number(row.indicator_id),
        code: row.code,
        name: row.name,
        rating: row.rating == null ? null : Number(row.rating),
        position_side: row.best_position_side,
        signal_kind: row.best_signal_kind,
        time_kind: row.best_time_kind,
        samples_count: row.samples_count == null ? null : Number(row.samples_count),
        securities_count: Number(row.securities_count) || 0,
      });
    }
    res.json({ groups: [...byTf.values()] });
  } catch (err) {
    console.error('GET /api/indicators/create-logic-options', err);
    res.status(500).json({ error: err.message });
  }
});

// #1006: создать логики из выбранных в форме индикаторов. На каждый ТФ с хотя бы одной
// галочкой — одна логика: сигналы открытия (условие разреза) и закрытия (условие
// противоположного разреза того же индикатора) + привязка всех бумаг универсума.
// Логика всегда создаётся ВЫКЛЮЧЕННОЙ (is_enabled = FALSE), чтобы случайно не начать
// торговлю на реальном счёте: пользователь включает её вручную.
app.post('/api/indicators/create-logics', async (req, res) => {
  const accountId = parseId(req.body && req.body.account_id);
  if (!accountId) {
    res.status(400).json({ error: 'Укажите счёт (account_id)' });
    return;
  }
  const rawGroups = Array.isArray(req.body && req.body.groups) ? req.body.groups : [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const created = [];
    for (const rawGroup of rawGroups) {
      const timeframeId = parseId(rawGroup && rawGroup.timeframe_id);
      if (!timeframeId) continue;
      const items = (Array.isArray(rawGroup && rawGroup.items) ? rawGroup.items : [])
        .map((it) => ({
          indicator_id: parseId(it && it.indicator_id),
          code: String((it && it.code) || '').trim().toUpperCase(),
          position_side: it && it.position_side === 'short' ? 'short' : 'long',
          signal_kind: it && it.signal_kind === 'counter' ? 'counter' : 'trend',
          open: Boolean(it && it.open === true),
          close: Boolean(it && it.close === true),
        }))
        .filter((it) => it.indicator_id && (it.open || it.close));
      if (items.length === 0) continue;

      const { rows: tfRows } = await client.query('SELECT tf FROM timeframes WHERE id = $1', [timeframeId]);
      if (tfRows.length === 0) continue;
      const tf = tfRows[0].tf;

      const parts = items.map((it) => {
        const markers = logicNameMarkers(it.open, it.close);
        const code = it.code || `IND${it.indicator_id}`;
        return markers ? `${code}-${markers}` : code;
      });
      const name = await uniqueLogicName(client, `${tf} ${parts.join(' ')}`);

      const note =
        `Создано из лучших рейтингов: ${tf}; ` +
        items.map((it) => `${it.code || it.indicator_id} (${it.position_side}, ${it.signal_kind})`).join(', ') +
        '; логика создана выключенной — включите вручную';

      const { rows: insLogic } = await client.query(
        `INSERT INTO logics (name, account_id, is_enabled, use_as_terminal_signal, note)
         VALUES ($1, $2, FALSE, FALSE, $3)
         RETURNING id`,
        [name, accountId, note]
      );
      const logicId = insLogic[0].id;

      // Дефолтные параметры логики (как ensureDefaultParams, но в этой же транзакции).
      await client.query(
        `INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
         SELECT $1, d.param_key, d.default_value, d.value_type
         FROM logic_param_defs d
         ON CONFLICT (logic_id, param_key) DO NOTHING`,
        [logicId]
      );
      try {
        await client.query('SELECT logic_ensure_non_trading_periods($1)', [logicId]);
      } catch (_e) {
        /* необязательный шаг */
      }
      await client.query(`SELECT logic_upsert_param($1, 'timeframe', $2, 'text')`, [logicId, tf]);

      let displayOrder = 0;
      let signalsCount = 0;
      for (const it of items) {
        const events = [];
        if (it.open) events.push({ event: 'open', kind: it.signal_kind });
        if (it.close) events.push({ event: 'close', kind: oppositeSignalKind(it.signal_kind) });
        for (const ev of events) {
          const { rows: formulaRows } = await client.query(
            'SELECT indicator_signal_formula($1, $2) AS formula',
            [it.indicator_id, ev.kind]
          );
          const formula = formulaRows[0] && formulaRows[0].formula;
          if (!formula) continue;
          displayOrder += 1;
          await client.query(
            `INSERT INTO logic_indicator_signals
               (logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [logicId, it.indicator_id, ev.event, it.position_side, ev.kind, formula, displayOrder]
          );
          signalsCount += 1;
        }
      }

      // Бумаги: все из универсума расчёта выбранных индикаторов на этом ТФ; если универсум
      // по ТФ ещё пуст (расчёт не дошёл до него) — из сырого состава расчёта (sample).
      const indicatorIds = items.map((it) => it.indicator_id);
      const securityIds = await collectLogicSecurities(client, timeframeId, indicatorIds);
      let securitiesCount = 0;
      if (securityIds.length) {
        const { rowCount } = await client.query(
          `INSERT INTO logic_securities (logic_id, security_id, display_order)
           SELECT $1, s.security_id, (s.ord - 1)
           FROM unnest($2::int[]) WITH ORDINALITY AS s(security_id, ord)`,
          [logicId, securityIds]
        );
        securitiesCount = rowCount;
      }

      created.push({
        logic_id: logicId,
        name,
        timeframe: tf,
        signals: signalsCount,
        securities: securitiesCount,
      });
    }
    await client.query('COMMIT');
    res.status(201).json({ created });
  } catch (err) {
    await client.query('ROLLBACK');
    handleDbError(res, err, 'POST /api/indicators/create-logics');
  } finally {
    client.release();
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

app.put('/api/security-indicator-series/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  const p = req.body ?? {};
  const toNum = (v, isStdDev) => {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) return NaN;
    if (!isStdDev && (!Number.isInteger(n) || n < 1)) return NaN;
    if (isStdDev && n < 0) return NaN;
    return n;
  };
  const paramMap = {
    param_period: toNum(p.param_period, false),
    param_fast_period: toNum(p.param_fast_period, false),
    param_slow_period: toNum(p.param_slow_period, false),
    param_signal_period: toNum(p.param_signal_period, false),
    param_std_dev: toNum(p.param_std_dev, true),
    param_k_period: toNum(p.param_k_period, false),
    param_d_period: toNum(p.param_d_period, false),
    param_smooth: toNum(p.param_smooth, false),
  };
  const cols = Object.entries(paramMap).filter(
    ([, v]) => v !== undefined && Number.isFinite(v)
  );
  if (cols.length === 0) {
    res.status(400).json({ error: 'Укажите хотя бы один параметр' });
    return;
  }
  try {
    const { rows: target } = await pool.query(
      `SELECT security_id, indicator_id
       FROM security_indicator_series
       WHERE id = $1`,
      [id]
    );
    if (target.length === 0) {
      res.status(404).json({ error: 'Серия индикатора не найдена' });
      return;
    }
    const { security_id, indicator_id } = target[0];
    const sets = cols.map(([col], i) => `${col} = $${i + 1}`);
    const values = cols.map(([, v]) => v);
    // Параметры меняются для всех активных серий индикатора на бумаге —
    // иначе линии одного индикатора считались бы с разными настройками.
    const { rows: updatedIds } = await pool.query(
      `UPDATE security_indicator_series
       SET ${sets.join(', ')}
       WHERE security_id = $${values.length + 1}
         AND indicator_id = $${values.length + 2}
         AND is_active = TRUE
       RETURNING id`,
      [...values, security_id, indicator_id]
    );
    if (updatedIds.length === 0) {
      res.status(404).json({ error: 'Активная серия индикатора не найдена' });
      return;
    }
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
      WHERE sis.security_id = $1 AND sis.indicator_id = $2 AND sis.is_active = TRUE
      ORDER BY sis.display_order, sis.id
    `,
      [security_id, indicator_id]
    );
    res.json(rows);
  } catch (err) {
    handleDbError(res, err, 'PUT /api/security-indicator-series/:id');
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
