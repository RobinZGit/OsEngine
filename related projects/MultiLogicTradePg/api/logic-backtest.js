'use strict';

const { writeTechLogEvent } = require('./lib/tech-log');

/**
 * Параллельность load_prices / sync индикаторов.
 * По умолчанию 2 — меньше таймаутов T-Bank, чем при 4.
 * Env: BACKTEST_PRICE_CONCURRENCY (1..8).
 */
// 1 по умолчанию: параллельный HTTP (особенно фьючерсы T-Bank/MOEX) даёт SSL timeout
const BACKTEST_PRICE_CONCURRENCY = Math.max(
  1,
  Math.min(8, Number(process.env.BACKTEST_PRICE_CONCURRENCY) || 1)
);

/**
 * Ограниченный параллельный обход: не больше `concurrency` задач одновременно.
 * Индекс следующего элемента берётся синхронно (безопасно в однопоточном Node).
 */
async function mapPool(items, concurrency, worker) {
  if (!items.length) return;
  let next = 0;
  const n = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= items.length) return;
        await worker(items[i], i);
      }
    })
  );
}

async function backtestLog(pool, runId, logicId, operation, message, payload = null, securityId = null, tfId = null) {
  try {
    await pool.query(
      `SELECT logic_backtest_log($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [
        runId,
        logicId,
        operation,
        message,
        payload != null ? JSON.stringify(payload) : null,
        securityId,
        tfId,
      ]
    );
  } catch (err) {
    console.warn('backtestLog', operation, err.message);
  }
  try {
    await writeTechLogEvent(pool, {
      threadKey: `logic:${logicId}:backtest:${runId}`,
      operation,
      message,
      source: 'backtest',
      logicId,
      securityId,
      timeframeId: tfId,
      payload: { run_id: runId, ...(payload || {}) },
    });
  } catch (_err) {
    /* APP_TECH_LOGGING may be off */
  }
}

async function updateRun(pool, runId, patch) {
  const { rows: curRows } = await pool.query(
    `SELECT status, cancel_requested FROM logic_backtest_runs WHERE id = $1`,
    [runId]
  );
  const cur = curRows[0];
  if (!cur) return;

  // После Стоп не воскрешаем прогон и не затираем «Отменено»
  if (cur.status === 'cancelled' || cur.cancel_requested) {
    if (patch.status && patch.status !== 'cancelled') {
      delete patch.status;
    }
    if (
      (cur.status === 'cancelled' || cur.cancel_requested) &&
      patch.phase_message &&
      !String(patch.phase_message).includes('Отмен')
    ) {
      delete patch.phase_message;
    }
  }

  const fields = [];
  const values = [runId];
  let i = 2;
  for (const [key, val] of Object.entries(patch)) {
    if (val === undefined) continue;
    fields.push(`${key} = $${i}`);
    values.push(val);
    i += 1;
  }
  if (fields.length === 0) return;
  await pool.query(
    `UPDATE logic_backtest_runs SET ${fields.join(', ')} WHERE id = $1`,
    values
  );
}

/**
 * Троттлинг записи progress_pct, чтобы UI не «стоял», но и не долбил БД каждый мс.
 * force — всегда писать (конец фазы / 100%).
 */
function createProgressReporter(pool, runId, minIntervalMs = 200) {
  let lastAt = 0;
  let lastPct = -1;
  let pending = null;
  let timer = null;

  const flush = async (patch) => {
    lastAt = Date.now();
    if (patch.progress_pct != null) lastPct = Number(patch.progress_pct);
    await updateRun(pool, runId, patch);
  };

  return async function report(patch, opts = {}) {
    const force = Boolean(opts.force);
    const now = Date.now();
    const pct = patch.progress_pct != null ? Number(patch.progress_pct) : null;
    const elapsed = now - lastAt;
    const pctJump = pct != null && lastPct >= 0 ? Math.abs(pct - lastPct) : 99;

    if (force || elapsed >= minIntervalMs || pctJump >= 0.4 || lastPct < 0) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        pending = null;
      }
      await flush(patch);
      return;
    }

    pending = patch;
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        const p = pending;
        pending = null;
        if (p) flush(p).catch(() => {});
      }, Math.max(50, minIntervalMs - elapsed));
    }
  };
}

async function isCancelRequested(pool, runId) {
  const { rows } = await pool.query(
    'SELECT cancel_requested, status FROM logic_backtest_runs WHERE id = $1',
    [runId]
  );
  if (rows.length === 0) return true;
  return rows[0].cancel_requested || !['pending', 'loading_prices', 'loading_indicators', 'running'].includes(rows[0].status);
}

async function fetchActiveSecurityIds(pool, logicId) {
  const { rows } = await pool.query(
    `SELECT ls.security_id, s.name
     FROM logic_securities ls
     JOIN securities s ON s.id = ls.security_id
     WHERE ls.logic_id = $1 AND ls.is_active = TRUE
       AND NOT EXISTS (
         SELECT 1
         FROM security_prefixes sp
         WHERE sp.security_id = ls.security_id
           AND upper(sp.prefix) IN ('TMON', 'LQDT', 'SBMM')
       )
     ORDER BY ls.display_order, ls.id`,
    [logicId]
  );
  return rows;
}

async function fetchActiveIndicatorIds(pool, logicId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT indicator_id FROM logic_indicator_signals
     WHERE logic_id = $1 AND is_active = TRUE`,
    [logicId]
  );
  return rows.map((r) => r.indicator_id);
}

async function pricesCached(pool, secId, tfId, warmupFrom, dateFrom, dateTo) {
  const { rows } = await pool.query(
    `SELECT backtest_prices_cached($1, $2, $3, $4, $5, 20) AS cached`,
    [secId, tfId, warmupFrom, dateFrom, dateTo]
  );
  return Boolean(rows[0]?.cached);
}

async function indicatorsCached(pool, secId, tfId, indicatorId, dateFrom, dateTo) {
  const { rows } = await pool.query(
    `SELECT backtest_indicators_cached($1, $2, $3, $4, $5) AS cached`,
    [secId, tfId, indicatorId, dateFrom, dateTo]
  );
  return Boolean(rows[0]?.cached);
}

async function fetchPriceLoadLog(pool, logicId, tfId, dateFrom, dateTo) {
  const { rows } = await pool.query(
    `SELECT pll.source, pll.records_loaded, pll.error_message, pll.date_from, pll.date_to
     FROM price_load_log pll
     JOIN logic_securities ls ON ls.security_id = pll.security_id
     WHERE ls.logic_id = $1 AND ls.is_active = TRUE
       AND pll.timeframe_id = $2
       AND pll.date_from >= $3::date - 30
       AND pll.date_to <= $4::date
     ORDER BY pll.id DESC
     LIMIT 10`,
    [logicId, tfId, dateFrom, dateTo]
  );
  return rows;
}

async function countPricesInPeriod(pool, logicId, tfId, dateFrom, dateTo, securityId = null) {
  const params = [logicId, tfId, dateFrom, dateTo];
  let secFilter = '';
  if (securityId != null) {
    params.push(securityId);
    secFilter = ` AND p.security_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM prices p
     JOIN logic_securities ls ON ls.security_id = p.security_id
     WHERE ls.logic_id = $1 AND ls.is_active = TRUE
       AND p.timeframe_id = $2 AND p.dt::date BETWEEN $3 AND $4${secFilter}`,
    params
  );
  return rows[0]?.cnt ?? 0;
}

async function countIndicatorsInPeriod(pool, logicId, tfId, dateFrom, dateTo) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM indicator_values iv
     JOIN logic_securities ls ON ls.security_id = iv.security_id
     WHERE ls.logic_id = $1 AND ls.is_active = TRUE
       AND iv.timeframe_id = $2 AND iv.dt::date BETWEEN $3 AND $4`,
    [logicId, tfId, dateFrom, dateTo]
  );
  return rows[0]?.cnt ?? 0;
}

async function logicTimeframeSec(pool, logicId) {
  const { rows } = await pool.query(
    `SELECT t.sec FROM timeframes t
     WHERE t.id = logic_resolve_timeframe_id($1)`,
    [logicId]
  );
  return Number(rows[0]?.sec ?? 86400);
}

async function ensureTbankForBacktest(pool, runId, logicId) {
  const tfSec = await logicTimeframeSec(pool, logicId);
  if (tfSec >= 86400) return true;

  const { rows } = await pool.query(`SELECT tbank_verify_token() AS s`);
  const status = rows[0]?.s ?? {};
  if (status.valid) return true;

  await backtestLog(
    pool,
    runId,
    logicId,
    'backtest.tbank.missing',
    status.error_message ||
      'Токен T-Bank не задан или невалиден — загрузка цен через MOEX',
    { tbank_status: status }
  );
  return true;
}

/**
 * Подготовка одной бумаги: кэш цен → load_prices только при необходимости;
 * индикаторы по текущим активным сигналам логики.
 * onPhase(kind, detail) — для плавного progress_pct (начало HTTP, после цен, по индикаторам).
 */
async function ensureSecurityData(
  pool,
  runId,
  logicId,
  secId,
  secName,
  tfId,
  loadDateFrom,
  dateFrom,
  dateTo,
  endDt,
  pointCount,
  stats,
  onPhase = null
) {
  const phase = async (kind, detail, frac) => {
    if (typeof onPhase === 'function') {
      await onPhase({ kind, detail, frac, secId, secName });
    }
  };

  const cached = await pricesCached(pool, secId, tfId, loadDateFrom, dateFrom, dateTo);
  let pricesReloaded = false;

  if (cached) {
    stats.pricesCached += 1;
    await phase('prices_cache', `Кэш цен: ${secName || secId}`, 0.35);
    await backtestLog(
      pool,
      runId,
      logicId,
      'backtest.prices.cached',
      `Кэш цен: ${secName || secId} (${loadDateFrom} — ${dateTo})`,
      { security_id: secId, name: secName },
      secId,
      tfId
    );
  } else {
    await phase('prices_http_start', `HTTP цены: ${secName || secId}`, 0.12);
    await backtestLog(
      pool,
      runId,
      logicId,
      'backtest.prices.load',
      `Загрузка цен: ${secName || secId} (${loadDateFrom} — ${dateTo})`,
      { security_id: secId, name: secName, date_from: loadDateFrom, date_to: dateTo },
      secId,
      tfId
    );
    try {
      await pool.query('CALL load_prices($1, $2, $3, $4)', [secId, tfId, loadDateFrom, dateTo]);
      stats.pricesLoaded += 1;
      pricesReloaded = true;
      await phase('prices_http_done', `Цены загружены: ${secName || secId}`, 0.55);
    } catch (e) {
      stats.pricesErr += 1;
      await backtestLog(
        pool,
        runId,
        logicId,
        'backtest.prices.error',
        e.message,
        { security_id: secId, name: secName },
        secId,
        tfId
      );
      return;
    }
    const okAfterLoad = await pricesCached(pool, secId, tfId, loadDateFrom, dateFrom, dateTo);
    const inPeriod = await countPricesInPeriod(pool, logicId, tfId, dateFrom, dateTo, secId);
    await backtestLog(
      pool,
      runId,
      logicId,
      okAfterLoad
        ? 'backtest.prices.loaded'
        : inPeriod > 0
          ? 'backtest.prices.partial'
          : 'backtest.prices.insufficient',
      okAfterLoad
        ? `Цены загружены: ${secName || secId}, в периоде ${inPeriod} свечей`
        : inPeriod > 0
          ? `Частичные цены: ${secName || secId}, в периоде ${inPeriod} свечей — считаем индикаторы`
          : `Недостаточно свечей после загрузки (${inPeriod} в периоде ${dateFrom} — ${dateTo})`,
      { security_id: secId, prices_in_period: inPeriod, coverage_ok: okAfterLoad },
      secId,
      tfId
    );
    if (!okAfterLoad && inPeriod <= 0) {
      stats.pricesErr += 1;
      return;
    }
    // Частичное покрытие (часто у фьючерсов после SSL) — всё равно считаем индикаторы
    if (!okAfterLoad && inPeriod > 0) {
      pricesReloaded = true;
    }
  }

  const indicatorIds = await fetchActiveIndicatorIds(pool, logicId);
  const indTotal = Math.max(1, indicatorIds.length);
  let indDone = 0;
  await phase('indicators_start', `Индикаторы: ${secName || secId}`, 0.6);

  for (const indicatorId of indicatorIds) {
    if (
      !pricesReloaded &&
      (await indicatorsCached(pool, secId, tfId, indicatorId, dateFrom, dateTo))
    ) {
      stats.indCached += 1;
      indDone += 1;
      await phase(
        'indicator',
        `Индикаторы ${secName || secId}: ${indDone}/${indicatorIds.length}`,
        0.6 + 0.35 * (indDone / indTotal)
      );
      continue;
    }
    try {
      await pool.query('CALL ensure_security_indicator_series($1, $2)', [secId, indicatorId]);
      await pool.query(
        'CALL sync_security_indicator_series_for_indicator($1, $2, $3, $4, $5, $6)',
        [secId, indicatorId, tfId, endDt, pointCount, false]
      );
      stats.indSynced += 1;
    } catch (e) {
      stats.indErr += 1;
      await backtestLog(
        pool,
        runId,
        logicId,
        'backtest.indicator.error',
        e.message,
        { security_id: secId, indicator_id: indicatorId, name: secName },
        secId,
        tfId
      );
    }
    indDone += 1;
    await phase(
      'indicator',
      `Индикаторы ${secName || secId}: ${indDone}/${indicatorIds.length}`,
      0.6 + 0.35 * (indDone / indTotal)
    );
  }

  await phase('paper_done', `Готово: ${secName || secId}`, 1);
}

/**
 * Читает актуальный список бумаг из logic_securities и подготавливает данные.
 * При изменении состава — логирует и подхватывает новые бумаги.
 */
async function syncActiveSecurities(
  pool,
  runId,
  logicId,
  tfId,
  loadDateFrom,
  dateFrom,
  dateTo,
  endDt,
  pointCount,
  knownIds,
  stats,
  phaseLabel,
  reportProgress = null
) {
  const secRows = await fetchActiveSecurityIds(pool, logicId);
  const currentIds = secRows.map((r) => r.security_id);
  const added = currentIds.filter((id) => !knownIds.has(id));
  const removed = [...knownIds].filter((id) => !currentIds.includes(id));

  if (added.length > 0 || removed.length > 0) {
    await backtestLog(pool, runId, logicId, 'backtest.config_changed', phaseLabel, {
      securities_active: currentIds,
      added,
      removed,
    });
  }

  // Начальная загрузка — все бумаги; на барах — только новые (added).
  const isInitialLoad = knownIds.size === 0;
  const rowsToPrepare = isInitialLoad
    ? secRows
    : secRows.filter((r) => added.includes(r.security_id));

  if (rowsToPrepare.length > 0) {
    await backtestLog(
      pool,
      runId,
      logicId,
      'backtest.prices.parallel',
      `Параллельная подготовка: ${rowsToPrepare.length} бумаг, concurrency=${BACKTEST_PRICE_CONCURRENCY}`,
      {
        securities: rowsToPrepare.length,
        concurrency: BACKTEST_PRICE_CONCURRENCY,
        phase: phaseLabel,
      }
    );
  }

  let completed = 0;
  let cancelled = false;
  const inFlight = new Map();
  /** Доля внутри текущей бумаги 0..1 (пока грузится). */
  const paperFrac = new Map();
  const PREP_SPAN = 38; // 0..38% на подготовку цен/индикаторов

  const progressDetail = () => {
    const total = Math.max(1, secRows.length);
    const active = [...inFlight.values()].filter(Boolean).slice(0, 4);
    const activePart = active.length ? ` · сейчас: ${active.join(', ')}` : '';
    return `Подготовка ${completed} / ${total}${activePart}`;
  };

  const bumpPrepProgress = async (force = false) => {
    if (!isInitialLoad || !reportProgress || secRows.length === 0) return;
    let sum = completed;
    for (const f of paperFrac.values()) {
      sum += Math.min(0.99, Number(f) || 0);
    }
    const pct = Math.min(
      PREP_SPAN,
      Math.round((sum / secRows.length) * PREP_SPAN * 100) / 100
    );
    await reportProgress(
      {
        status: 'loading_prices',
        progress_pct: pct,
        phase_message: 'Загрузка цен и индикаторов',
        phase_detail: progressDetail(),
      },
      { force }
    );
  };

  await mapPool(rowsToPrepare, BACKTEST_PRICE_CONCURRENCY, async (row) => {
    if (cancelled) return;
    if (await isCancelRequested(pool, runId)) {
      cancelled = true;
      return;
    }

    const { security_id: secId, name: secName } = row;
    const label = secName || String(secId);
    inFlight.set(secId, label);
    paperFrac.set(secId, 0.05);
    await bumpPrepProgress();

    try {
      await ensureSecurityData(
        pool,
        runId,
        logicId,
        secId,
        secName,
        tfId,
        loadDateFrom,
        dateFrom,
        dateTo,
        endDt,
        pointCount,
        stats,
        async ({ detail, frac }) => {
          paperFrac.set(secId, Math.max(0.05, Math.min(0.99, Number(frac) || 0.05)));
          if (detail) {
            inFlight.set(secId, `${label}`);
          }
          await bumpPrepProgress();
        }
      );
    } catch (e) {
      stats.pricesErr += 1;
      await backtestLog(
        pool,
        runId,
        logicId,
        'backtest.prices.error',
        e.message,
        { security_id: secId, name: secName },
        secId,
        tfId
      );
    } finally {
      inFlight.delete(secId);
      paperFrac.delete(secId);
      completed += 1;
    }

    await bumpPrepProgress(true);
  });

  knownIds.clear();
  for (const id of currentIds) knownIds.add(id);
  return secRows.length;
}

async function runBacktestAsync(pool, logicId, dateFrom, dateTo, runId) {
  const knownSecIds = new Set();
  const stats = {
    pricesLoaded: 0,
    pricesCached: 0,
    pricesErr: 0,
    indSynced: 0,
    indCached: 0,
    indErr: 0,
  };
  const reportProgress = createProgressReporter(pool, runId, 180);

  try {
    if (!(await ensureTbankForBacktest(pool, runId, logicId))) {
      return;
    }

    const { rows: logicRows } = await pool.query(`SELECT id FROM logics WHERE id = $1`, [logicId]);
    if (logicRows.length === 0) {
      await updateRun(pool, runId, {
        status: 'failed',
        error_message: 'Логика не найдена',
        progress_pct: 100,
        finished_at: new Date(),
      });
      return;
    }

    const { rows: tfRows } = await pool.query(
      `SELECT logic_resolve_timeframe_id($1) AS tf_id`,
      [logicId]
    );
    const tfId = tfRows[0]?.tf_id;
    if (!tfId) {
      await backtestLog(pool, runId, logicId, 'backtest.failed', 'Не задан timeframe', null, null, null);
      await updateRun(pool, runId, {
        status: 'failed',
        error_message: 'Не задан timeframe',
        progress_pct: 100,
        finished_at: new Date(),
      });
      return;
    }

    const { rows: balRows } = await pool.query(
      `SELECT COALESCE(get_logic_param_numeric($1, 'initial_balance', 0), 1000000)::float8 AS bal`,
      [logicId]
    );
    let balance = Number(balRows[0]?.bal ?? 1000000);

    await pool.query('DELETE FROM logic_trades WHERE logic_id = $1 AND is_test = TRUE', [logicId]);
    await pool.query('DELETE FROM logic_backtest_security_state WHERE run_id = $1', [runId]);
    await pool.query('SELECT logic_backtest_reset_signal_ratings($1)', [logicId]);

    // Денежный фонд в logic_securities (для UI и парковки); цены фонда не обязательны (fallback ~100).
    const { rows: fundRows } = await pool.query(
      `SELECT upper(btrim(COALESCE(get_logic_param_text($1, 'cash_fund_code'), ''))) AS fund`,
      [logicId]
    );
    const cashFundCode = fundRows[0]?.fund || '';
    if (['TMON', 'LQDT', 'SBMM'].includes(cashFundCode)) {
      await pool.query(`SELECT logic_ensure_cash_fund_security($1, $2)`, [logicId, cashFundCode]);
    }

    const { rows: tfMetaRows } = await pool.query(
      `SELECT t.sec AS tf_sec, t.tf AS tf_name FROM timeframes t WHERE t.id = $1`,
      [tfId]
    );
    const tfSec = Number(tfMetaRows[0]?.tf_sec ?? 900);
    const tfName = tfMetaRows[0]?.tf_name ?? '?';

    // Период прогона как выбрал пользователь; HTTP/кэш — не дальше сегодня.
    const loadDateTo = clampDateToToday(dateTo);
    const loadDateFrom = shiftDate(dateFrom, -30);
    const endDt = `${loadDateTo} 23:59:59`;
    const daysSpan =
      Math.ceil((Date.parse(loadDateTo) - Date.parse(loadDateFrom)) / 86400000) + 1;
    const pointCount = Math.max(500, Math.ceil(daysSpan * (86400 / tfSec)) + 200);

    await backtestLog(pool, runId, logicId, 'backtest.start', `Старт ${dateFrom} — ${dateTo}`, {
      date_from: dateFrom,
      date_to: dateTo,
      load_date_to: loadDateTo,
      load_date_from: loadDateFrom,
      price_concurrency: BACKTEST_PRICE_CONCURRENCY,
    });

    await updateRun(pool, runId, {
      status: 'loading_prices',
      progress_pct: 0,
      phase_message: 'Подготовка данных',
      phase_detail: `Чтение бумаг (×${BACKTEST_PRICE_CONCURRENCY})`,
      test_balance: balance,
    });

    const secTotal = await syncActiveSecurities(
      pool,
      runId,
      logicId,
      tfId,
      loadDateFrom,
      dateFrom,
      loadDateTo,
      endDt,
      pointCount,
      knownSecIds,
      stats,
      'Стартовый состав бумаг',
      reportProgress
    );

    if (await isCancelRequested(pool, runId)) {
      await finishCancelled(pool, runId, logicId, balance, 0, 0);
      return;
    }

    if (secTotal === 0) {
      await updateRun(pool, runId, {
        status: 'failed',
        error_message: 'Нет активных бумаг в логике',
        progress_pct: 100,
        finished_at: new Date(),
      });
      return;
    }

    const indicatorIds = await fetchActiveIndicatorIds(pool, logicId);
    if (indicatorIds.length === 0) {
      await updateRun(pool, runId, {
        status: 'failed',
        error_message: 'Нет активных сигналов в логике',
        progress_pct: 100,
        finished_at: new Date(),
      });
      return;
    }

    await backtestLog(
      pool,
      runId,
      logicId,
      'backtest.config',
      `TF=${tfName} бумаг=${secTotal} сигналов=${indicatorIds.length}`,
      {
        tf_id: tfId,
        tf_name: tfName,
        load_date_from: loadDateFrom,
        point_count: pointCount,
        securities: secTotal,
        indicators: indicatorIds.length,
        initial_balance: balance,
        prices_loaded: stats.pricesLoaded,
        prices_cached: stats.pricesCached,
      },
      null,
      tfId
    );

    const pricesInPeriod = await countPricesInPeriod(pool, logicId, tfId, dateFrom, dateTo);
    await backtestLog(
      pool,
      runId,
      logicId,
      'backtest.prices.done',
      `Цены: load=${stats.pricesLoaded} cache=${stats.pricesCached} err=${stats.pricesErr} в периоде=${pricesInPeriod}`,
      {
        prices_loaded: stats.pricesLoaded,
        prices_cached: stats.pricesCached,
        prices_err: stats.pricesErr,
        prices_in_period: pricesInPeriod,
      },
      null,
      tfId
    );

    if (pricesInPeriod === 0) {
      const priceLog = await fetchPriceLoadLog(pool, logicId, tfId, dateFrom, dateTo);
      await backtestLog(
        pool,
        runId,
        logicId,
        'backtest.failed',
        'Нет свечей в периоде',
        { prices_in_period: 0, price_load_log: priceLog },
        null,
        tfId
      );
      await updateRun(pool, runId, {
        status: 'failed',
        progress_pct: 100,
        phase_message: 'Нет свечей',
        error_message: `Не загружены цены (ошибок: ${stats.pricesErr}). Задайте токен T-Bank для M15.`,
        finished_at: new Date(),
      });
      return;
    }

    const indInPeriod = await countIndicatorsInPeriod(pool, logicId, tfId, dateFrom, dateTo);
    await backtestLog(
      pool,
      runId,
      logicId,
      'backtest.indicators.done',
      `Индикаторы: sync=${stats.indSynced} cache=${stats.indCached} err=${stats.indErr} в периоде=${indInPeriod}`,
      {
        indicator_values_in_period: indInPeriod,
        sync_errors: stats.indErr,
        ind_synced: stats.indSynced,
        ind_cached: stats.indCached,
      },
      null,
      tfId
    );

    if (indInPeriod === 0) {
      await updateRun(pool, runId, {
        status: 'failed',
        progress_pct: 100,
        phase_message: 'Нет индикаторов',
        error_message: 'Индикаторы не рассчитаны. См. backtest.indicator.error.',
        finished_at: new Date(),
      });
      return;
    }

    await reportProgress(
      {
        status: 'loading_indicators',
        progress_pct: 39,
        phase_message: 'Подготовка прогона',
        phase_detail: `Бумаг ${secTotal}, сигналов ${indicatorIds.length}`,
      },
      { force: true }
    );

    if (await isCancelRequested(pool, runId)) {
      await finishCancelled(pool, runId, logicId, balance, 0, 0);
      return;
    }

    // SQL-робот теста: единый прогон баров (rate/risk/EOD/signals/park). Node — только prep.
    await updateRun(pool, runId, {
      status: 'running',
      progress_pct: 40,
      phase_message: 'Прогон по свечам (SQL)',
      phase_detail: `бумаг ${knownSecIds.size}`,
      test_balance: balance,
    });
    await backtestLog(
      pool,
      runId,
      logicId,
      'backtest.sql_bars.start',
      `Старт logic_backtest_run_bars (prep: load=${stats.pricesLoaded} cache=${stats.pricesCached})`,
      {
        prices_loaded: stats.pricesLoaded,
        prices_cached: stats.pricesCached,
        securities: knownSecIds.size,
        engine: 'sql',
      },
      null,
      tfId
    );

    const client = await pool.connect();
    try {
      // Длинный прогон: отключить statement_timeout на сессии.
      await client.query(`SET statement_timeout = 0`);
      await client.query(`SET lock_timeout = '30s'`);
      await client.query(`SELECT logic_backtest_run_bars($1)`, [runId]);
    } finally {
      client.release();
    }

    const { rows: finalRows } = await pool.query(
      `SELECT status, trades_created, total_bars, processed_bars,
              test_balance::float8 AS test_balance,
              financial_result::float8 AS financial_result
       FROM logic_backtest_runs WHERE id = $1`,
      [runId]
    );
    const fin = finalRows[0] || {};
    await backtestLog(
      pool,
      runId,
      logicId,
      'backtest.sql_bars.done',
      `SQL bars: status=${fin.status} trades=${fin.trades_created ?? 0} bars=${fin.total_bars ?? 0}`,
      {
        status: fin.status,
        trades_created: fin.trades_created,
        total_bars: fin.total_bars,
        processed_bars: fin.processed_bars,
        test_balance: fin.test_balance,
        financial_result: fin.financial_result,
        prices_loaded: stats.pricesLoaded,
        prices_cached: stats.pricesCached,
        engine: 'sql',
      },
      null,
      tfId
    );
  } catch (err) {
    await backtestLog(pool, runId, logicId, 'backtest.failed', err.message, { stack: err.stack });
    await updateRun(pool, runId, {
      status: 'failed',
      error_message: err.message,
      progress_pct: 100,
      finished_at: new Date(),
    });
  }
}

async function sumTestPnl(pool, logicId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(financial_result), 0)::float8 AS pnl
     FROM logic_trades WHERE logic_id = $1 AND is_test = TRUE`,
    [logicId]
  );
  return Number(rows[0]?.pnl ?? 0);
}

async function finishCancelled(pool, runId, logicId, balance, processed, total) {
  // Ничего не удаляем: сделки/рейтинги теста остаются как есть
  const pnl = await sumTestPnl(pool, logicId);
  const { rows } = await pool.query(
    `SELECT status, processed_bars, total_bars FROM logic_backtest_runs WHERE id = $1`,
    [runId]
  );
  const already = rows[0]?.status === 'cancelled';
  const proc = processed ?? rows[0]?.processed_bars ?? 0;
  const tot = total ?? rows[0]?.total_bars ?? 0;
  if (!already) {
    await backtestLog(pool, runId, logicId, 'backtest.cancelled', `Отменено на ${proc}/${tot}`, {
      processed: proc,
      total: tot,
      financial_result: pnl,
    });
  }
  await pool.query(
    `
    UPDATE logic_backtest_runs
    SET cancel_requested = TRUE,
        status = 'cancelled',
        phase_message = 'Отменено',
        phase_detail = $2,
        test_balance = COALESCE($3::numeric, test_balance),
        financial_result = $4,
        processed_bars = GREATEST(COALESCE(processed_bars, 0), $5::int),
        finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)
    WHERE id = $1
    `,
    [
      runId,
      tot > 0 ? `${proc} / ${tot} баров (сохранено)` : 'Остановлено, результат сохранён',
      balance,
      pnl,
      proc,
    ]
  );
}

async function startBacktest(pool, logicId, dateFrom, dateTo) {
  const { rows } = await pool.query(
    `
    INSERT INTO logic_backtest_runs (logic_id, date_from, date_to, status, progress_pct, phase_message, started_at)
    VALUES ($1, $2, $3, 'pending', 0, 'Старт', CURRENT_TIMESTAMP)
    RETURNING id
    `,
    [logicId, dateFrom, dateTo]
  );
  const runId = rows[0].id;
  setImmediate(() => {
    runBacktestAsync(pool, logicId, dateFrom, dateTo, runId).catch((err) => {
      console.error('backtest run failed', err);
    });
  });
  return runId;
}

async function getBacktestStatus(pool, logicId, runId) {
  const params = [logicId];
  let sql = `
    SELECT id, logic_id,
      date_from::text AS date_from,
      date_to::text AS date_to,
      status,
      progress_pct::float8 AS progress_pct,
      phase_message, phase_detail, current_bar_dt,
      total_bars, processed_bars, trades_created,
      test_balance::float8 AS test_balance,
      financial_result::float8 AS financial_result,
      cancel_requested, error_message, started_at, finished_at, created_at
    FROM logic_backtest_runs
    WHERE logic_id = $1
  `;
  if (runId) {
    sql += ' AND id = $2';
    params.push(runId);
  }
  sql += ' ORDER BY id DESC LIMIT 1';
  const { rows } = await pool.query(sql, params);
  return rows[0] ?? null;
}

async function cancelBacktest(pool, runId) {
  const { rows } = await pool.query(
    `
    SELECT id, logic_id, status, processed_bars, total_bars, test_balance
    FROM logic_backtest_runs
    WHERE id = $1
    `,
    [runId]
  );
  if (rows.length === 0) return false;
  const run = rows[0];
  if (!['pending', 'loading_prices', 'loading_indicators', 'running'].includes(run.status)) {
    return run.status === 'cancelled';
  }

  // Сразу status=cancelled — UI не висит на «Останавливаю…».
  // Фоновый воркер добьёт текущий SQL и выйдет; данные теста не трогаем.
  const pnl = await sumTestPnl(pool, run.logic_id);
  const proc = Number(run.processed_bars ?? 0);
  const tot = Number(run.total_bars ?? 0);
  const { rowCount } = await pool.query(
    `
    UPDATE logic_backtest_runs
    SET cancel_requested = TRUE,
        status = 'cancelled',
        phase_message = 'Отменено',
        phase_detail = CASE
          WHEN $3::int > 0 THEN $2::text || ' / ' || $3::text || ' баров (сохранено)'
          ELSE COALESCE(phase_detail, 'Остановлено, результат сохранён')
        END,
        financial_result = $4,
        finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)
    WHERE id = $1
      AND status IN ('pending', 'loading_prices', 'loading_indicators', 'running')
    `,
    [runId, proc, tot, pnl]
  );

  try {
    await backtestLog(
      pool,
      runId,
      run.logic_id,
      'backtest.cancel_requested',
      `Стоп пользователем на ${proc}/${tot}`,
      { processed: proc, total: tot, financial_result: pnl }
    );
  } catch (_e) {
    /* ignore */
  }

  return rowCount > 0;
}

module.exports = {
  startBacktest,
  getBacktestStatus,
  cancelBacktest,
};

function shiftDate(isoDate, days) {
  const d = new Date(`${isoDate}T12:00:00`);
  d.setDate(d.getDate() + days);
  return localIsoDate(d);
}

/** YYYY-MM-DD по локальному календарю (без UTC-сдвига). */
function localIsoDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** load_prices / кэш: не запрашивать будущие дни у T-Bank. */
function clampDateToToday(isoDate) {
  const today = localIsoDate();
  return isoDate > today ? today : isoDate;
}
