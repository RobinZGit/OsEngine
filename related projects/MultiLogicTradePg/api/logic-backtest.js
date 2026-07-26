'use strict';

const { writeTechLogEvent } = require('./lib/tech-log');
const { schedulePersistBacktestReport } = require('./backtest-report-persist');

/**
 * Параллельность подготовки бумаг внутри одного прогона.
 * Env: BACKTEST_PRICE_CONCURRENCY (1..8). По умолчанию 1 — меньше SSL timeout T-Bank/MOEX.
 *
 * Между прогонами: load_prices — single-flight по ключу
 * (security_id, timeframe_id, date_from, date_to). Первый грузит HTTP,
 * остальные ждут тот же Promise и читают `prices` из БД; индикаторы каждый
 * прогон считает сам (ensure/sync) по своим сигналам логики.
 */
const BACKTEST_PRICE_CONCURRENCY = Math.max(
  1,
  Math.min(8, Number(process.env.BACKTEST_PRICE_CONCURRENCY) || 1)
);

/** @type {Map<string, Promise<object>>} */
const priceLoadFlights = new Map();

/** In-process workers — prevents double-start of the same run_id. */
const activeBacktestRuns = new Set();

function priceLoadKey(secId, tfId, dateFrom, dateTo) {
  return `${Number(secId)}|${Number(tfId)}|${String(dateFrom)}|${String(dateTo)}`;
}

/**
 * Single-flight загрузка цен в общую таблицу `prices`.
 * @returns {Promise<{
 *   status: 'cached'|'loaded'|'partial'|'empty'|'error',
 *   waited: boolean,
 *   pricesReloaded: boolean,
 *   inPeriod: number,
 *   error?: Error
 * }>}
 */
async function ensurePricesReady(pool, secId, tfId, loadDateFrom, dateFrom, dateTo) {
  const key = priceLoadKey(secId, tfId, loadDateFrom, dateTo);

  if (await pricesCached(pool, secId, tfId, loadDateFrom, dateFrom, dateTo)) {
    return {
      status: 'cached',
      waited: false,
      pricesReloaded: false,
      inPeriod: await countPricesForSecurity(pool, secId, tfId, dateFrom, dateTo),
    };
  }

  let isLeader = false;
  let flight = priceLoadFlights.get(key);
  if (!flight) {
    isLeader = true;
    flight = (async () => {
      try {
        if (await pricesCached(pool, secId, tfId, loadDateFrom, dateFrom, dateTo)) {
          return {
            status: 'cached',
            pricesReloaded: false,
            inPeriod: await countPricesForSecurity(pool, secId, tfId, dateFrom, dateTo),
          };
        }
        await pool.query('CALL load_prices($1, $2, $3, $4)', [
          secId,
          tfId,
          loadDateFrom,
          dateTo,
        ]);
        const okAfterLoad = await pricesCached(
          pool,
          secId,
          tfId,
          loadDateFrom,
          dateFrom,
          dateTo
        );
        const inPeriod = await countPricesForSecurity(pool, secId, tfId, dateFrom, dateTo);
        if (okAfterLoad) {
          return { status: 'loaded', pricesReloaded: true, inPeriod };
        }
        if (inPeriod > 0) {
          return { status: 'partial', pricesReloaded: true, inPeriod };
        }
        return { status: 'empty', pricesReloaded: false, inPeriod: 0 };
      } catch (error) {
        return { status: 'error', pricesReloaded: false, inPeriod: 0, error };
      } finally {
        priceLoadFlights.delete(key);
      }
    })();
    priceLoadFlights.set(key, flight);
  }

  const result = await flight;
  return {
    status: result.status,
    waited: !isLeader,
    pricesReloaded: Boolean(result.pricesReloaded),
    inPeriod: Number(result.inPeriod) || 0,
    error: result.error,
  };
}

/**
 * Single-flight для денежного фонда (load_prices_http, без проверки backtest_prices_cached).
 */
async function ensureFundPricesReady(pool, fundSecId, tfId, loadDateFrom, loadDateTo) {
  const key = `fund|${priceLoadKey(fundSecId, tfId, loadDateFrom, loadDateTo)}`;
  let isLeader = false;
  let flight = priceLoadFlights.get(key);
  if (!flight) {
    isLeader = true;
    flight = (async () => {
      try {
        await pool.query(`CALL load_prices_http($1, $2, $3::date, $4::date)`, [
          fundSecId,
          tfId,
          loadDateFrom,
          loadDateTo,
        ]);
        return { status: 'loaded', error: null };
      } catch (error) {
        return { status: 'error', error };
      } finally {
        priceLoadFlights.delete(key);
      }
    })();
    priceLoadFlights.set(key, flight);
  }
  const result = await flight;
  return { status: result.status, waited: !isLeader, error: result.error };
}

async function countPricesForSecurity(pool, secId, tfId, dateFrom, dateTo) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM prices p
     WHERE p.security_id = $1 AND p.timeframe_id = $2
       AND p.dt::date BETWEEN $3 AND $4`,
    [secId, tfId, dateFrom, dateTo]
  );
  return rows[0]?.cnt ?? 0;
}

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

  // Archive report outside the hot path whenever a run reaches a terminal status.
  const terminal = patch.status;
  if (
    terminal === 'completed' ||
    terminal === 'cancelled' ||
    terminal === 'failed'
  ) {
    schedulePersistBacktestReport(pool, runId, { isSnapshot: false });
  }
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

/** Snapshot series param_* so we can detect formula-driven changes after apply. */
async function snapshotIndicatorSeriesParams(pool, secId, indicatorId) {
  const { rows } = await pool.query(
    `
    SELECT
      param_period,
      param_std_dev::text AS param_std_dev,
      param_fast_period,
      param_slow_period,
      param_signal_period,
      param_k_period,
      param_d_period,
      param_smooth
    FROM security_indicator_series
    WHERE security_id = $1
      AND indicator_id = $2
      AND is_active = TRUE
    ORDER BY id
    `,
    [secId, indicatorId]
  );
  return JSON.stringify(rows);
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

/** Fast presence check — full COUNT on indicator_values is multi-second on large DBs. */
async function hasIndicatorsInPeriod(pool, logicId, tfId, dateFrom, dateTo) {
  const { rows } = await pool.query(
    `
    SELECT EXISTS (
      SELECT 1
      FROM indicator_values iv
      JOIN logic_securities ls ON ls.security_id = iv.security_id
      WHERE ls.logic_id = $1 AND ls.is_active = TRUE
        AND iv.timeframe_id = $2 AND iv.dt::date BETWEEN $3 AND $4
      LIMIT 1
    ) AS ok
    `,
    [logicId, tfId, dateFrom, dateTo]
  );
  return Boolean(rows[0]?.ok);
}

async function hasPricesInPeriod(pool, logicId, tfId, dateFrom, dateTo) {
  const { rows } = await pool.query(
    `
    SELECT EXISTS (
      SELECT 1
      FROM prices p
      JOIN logic_securities ls ON ls.security_id = p.security_id
      WHERE ls.logic_id = $1 AND ls.is_active = TRUE
        AND p.timeframe_id = $2 AND p.dt::date BETWEEN $3 AND $4
      LIMIT 1
    ) AS ok
    `,
    [logicId, tfId, dateFrom, dateTo]
  );
  return Boolean(rows[0]?.ok);
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
 * Подготовка одной бумаги:
 * (1) цены — shared single-flight по ключу → таблица `prices`;
 * (2) индикаторы — каждый прогон считает сам по активным сигналам логики.
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

  await phase('prices_http_start', `Цены: ${secName || secId}`, 0.12);
  const priceResult = await ensurePricesReady(
    pool,
    secId,
    tfId,
    loadDateFrom,
    dateFrom,
    dateTo
  );
  const pricesReloaded = Boolean(priceResult.pricesReloaded);

  if (priceResult.status === 'error') {
    stats.pricesErr += 1;
    await backtestLog(
      pool,
      runId,
      logicId,
      'backtest.prices.error',
      priceResult.error?.message || 'load_prices failed',
      {
        security_id: secId,
        name: secName,
        waited: priceResult.waited,
        price_key: priceLoadKey(secId, tfId, loadDateFrom, dateTo),
      },
      secId,
      tfId
    );
    return;
  }

  if (priceResult.status === 'cached') {
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
  } else if (priceResult.waited) {
    stats.pricesShared += 1;
    await phase('prices_http_done', `Общие цены: ${secName || secId}`, 0.55);
    await backtestLog(
      pool,
      runId,
      logicId,
      'backtest.prices.shared',
      `Цены из shared load: ${secName || secId} (${priceResult.status}, ${priceResult.inPeriod} свечей)`,
      {
        security_id: secId,
        name: secName,
        status: priceResult.status,
        prices_in_period: priceResult.inPeriod,
        price_key: priceLoadKey(secId, tfId, loadDateFrom, dateTo),
      },
      secId,
      tfId
    );
  } else {
    stats.pricesLoaded += 1;
    await phase('prices_http_done', `Цены загружены: ${secName || secId}`, 0.55);
    await backtestLog(
      pool,
      runId,
      logicId,
      priceResult.status === 'loaded'
        ? 'backtest.prices.loaded'
        : priceResult.status === 'partial'
          ? 'backtest.prices.partial'
          : 'backtest.prices.insufficient',
      priceResult.status === 'loaded'
        ? `Цены загружены: ${secName || secId}, в периоде ${priceResult.inPeriod} свечей`
        : priceResult.status === 'partial'
          ? `Частичные цены: ${secName || secId}, в периоде ${priceResult.inPeriod} свечей — считаем индикаторы`
          : `Недостаточно свечей после загрузки (${priceResult.inPeriod} в периоде ${dateFrom} — ${dateTo})`,
      {
        security_id: secId,
        prices_in_period: priceResult.inPeriod,
        coverage_ok: priceResult.status === 'loaded',
        price_key: priceLoadKey(secId, tfId, loadDateFrom, dateTo),
      },
      secId,
      tfId
    );
  }

  if (priceResult.status === 'empty') {
    stats.pricesErr += 1;
    return;
  }

  // (2) Indicators: apply @CODE(...period/std_dev...) from logic signals onto
  // security_indicator_series, then sync. Skip cache only if params unchanged.
  const indicatorIds = await fetchActiveIndicatorIds(pool, logicId);
  const indTotal = Math.max(1, indicatorIds.length);
  let indDone = 0;
  await phase('indicators_start', `Индикаторы: ${secName || secId}`, 0.6);

  /** @type {Map<number, string>} */
  const paramsBefore = new Map();
  for (const indicatorId of indicatorIds) {
    try {
      await pool.query('CALL ensure_security_indicator_series($1, $2)', [secId, indicatorId]);
      paramsBefore.set(
        indicatorId,
        await snapshotIndicatorSeriesParams(pool, secId, indicatorId)
      );
    } catch (e) {
      stats.indErr += 1;
      await backtestLog(
        pool,
        runId,
        logicId,
        'backtest.indicator.error',
        e.message,
        { security_id: secId, indicator_id: indicatorId, name: secName, phase: 'ensure' },
        secId,
        tfId
      );
    }
  }

  try {
    await pool.query('CALL logic_apply_indicator_params_from_signals($1, $2)', [
      logicId,
      secId,
    ]);
  } catch (e) {
    stats.indErr += 1;
    await backtestLog(
      pool,
      runId,
      logicId,
      'backtest.indicator.error',
      e.message,
      { security_id: secId, name: secName, phase: 'apply_params' },
      secId,
      tfId
    );
  }

  for (const indicatorId of indicatorIds) {
    let paramsChanged = true;
    try {
      const after = await snapshotIndicatorSeriesParams(pool, secId, indicatorId);
      paramsChanged = (paramsBefore.get(indicatorId) ?? '') !== after;
    } catch (_e) {
      paramsChanged = true;
    }

    if (
      !pricesReloaded &&
      !paramsChanged &&
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
      `Подготовка: ${rowsToPrepare.length} бумаг, concurrency=${BACKTEST_PRICE_CONCURRENCY} (prices single-flight)`,
      {
        securities: rowsToPrepare.length,
        concurrency: BACKTEST_PRICE_CONCURRENCY,
        price_single_flight: true,
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

/**
 * @param {object} [options]
 * @param {boolean} [options.resume] — continue same run_id after API restart (no wipe)
 */
async function runBacktestAsync(pool, logicId, dateFrom, dateTo, runId, options = {}) {
  const resume = Boolean(options.resume);
  const runKey = Number(runId);
  if (!Number.isFinite(runKey) || runKey <= 0) return;
  if (activeBacktestRuns.has(runKey)) {
    console.warn(`backtest run ${runKey} already active in this process — skip`);
    return;
  }
  activeBacktestRuns.add(runKey);

  const knownSecIds = new Set();
  const stats = {
    pricesLoaded: 0,
    pricesCached: 0,
    pricesShared: 0,
    pricesErr: 0,
    indSynced: 0,
    indCached: 0,
    indErr: 0,
  };
  const reportProgress = createProgressReporter(pool, runId, 180);
  /** Bar index to start from (0-based); resume uses persisted processed_bars. */
  let startBarIndex = 0;

  try {
    if (!(await ensureTbankForBacktest(pool, runId, logicId))) {
      return;
    }

    const { rows: logicRows } = await pool.query(
      `SELECT l.id, l.account_id FROM logics l WHERE l.id = $1`,
      [logicId]
    );
    if (logicRows.length === 0) {
      await updateRun(pool, runId, {
        status: 'failed',
        error_message: 'Логика не найдена',
        progress_pct: 100,
        finished_at: new Date(),
      });
      return;
    }
    const logic = logicRows[0];

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

    if (resume) {
      const { rows: runState } = await pool.query(
        `
        SELECT test_balance::float8 AS test_balance,
               COALESCE(processed_bars, 0)::int AS processed_bars,
               status, cancel_requested
        FROM logic_backtest_runs
        WHERE id = $1
        `,
        [runId]
      );
      if (runState.length === 0) {
        return;
      }
      if (runState[0].cancel_requested) {
        return;
      }
      if (
        !['pending', 'loading_prices', 'loading_indicators', 'running'].includes(
          runState[0].status
        )
      ) {
        return;
      }
      if (runState[0].test_balance != null && Number.isFinite(Number(runState[0].test_balance))) {
        balance = Number(runState[0].test_balance);
      }
      startBarIndex = Math.max(0, Number(runState[0].processed_bars) || 0);
      const seeded = await fetchActiveSecurityIds(pool, logicId);
      for (const row of seeded) knownSecIds.add(Number(row.security_id));
    } else {
      await pool.query('DELETE FROM logic_trades WHERE logic_id = $1 AND is_test = TRUE', [logicId]);
      await pool.query('DELETE FROM logic_backtest_security_state WHERE run_id = $1', [runId]);
      await pool.query('SELECT logic_backtest_reset_signal_ratings($1)', [logicId]);
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

    if (resume) {
      await backtestLog(
        pool,
        runId,
        logicId,
        'backtest.resume',
        `Возобновление после перезапуска API с бара ${startBarIndex} (${dateFrom} — ${dateTo})`,
        {
          date_from: dateFrom,
          date_to: dateTo,
          resume_from_bar: startBarIndex,
          test_balance: balance,
          price_concurrency: BACKTEST_PRICE_CONCURRENCY,
        }
      );
      await updateRun(pool, runId, {
        status: startBarIndex > 0 ? 'running' : 'loading_prices',
        phase_message:
          startBarIndex > 0
            ? 'Возобновление прогона'
            : 'Возобновление: подготовка данных',
        phase_detail:
          startBarIndex > 0
            ? `С бара ${startBarIndex}, баланс ${balance}`
            : `Чтение бумаг (×${BACKTEST_PRICE_CONCURRENCY})`,
        test_balance: balance,
        finished_at: null,
        error_message: null,
      });
    } else {
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
    }

    /** Mid-run resume: data already loaded — skip HTTP prep and multi-second COUNTs. */
    const fastResume = resume && startBarIndex > 0;
    let secTotal = knownSecIds.size;

    if (fastResume) {
      const seeded = await fetchActiveSecurityIds(pool, logicId);
      knownSecIds.clear();
      for (const row of seeded) knownSecIds.add(Number(row.security_id));
      secTotal = knownSecIds.size;
      if (secTotal === 0) {
        await updateRun(pool, runId, {
          status: 'failed',
          error_message: 'Нет активных бумаг в логике',
          progress_pct: 100,
          finished_at: new Date(),
        });
        return;
      }
      if (!(await hasPricesInPeriod(pool, logicId, tfId, dateFrom, dateTo))) {
        await updateRun(pool, runId, {
          status: 'failed',
          progress_pct: 100,
          phase_message: 'Нет свечей',
          error_message: 'При возобновлении нет цен в периоде',
          finished_at: new Date(),
        });
        return;
      }
      if (!(await hasIndicatorsInPeriod(pool, logicId, tfId, dateFrom, dateTo))) {
        await updateRun(pool, runId, {
          status: 'failed',
          progress_pct: 100,
          phase_message: 'Нет индикаторов',
          error_message: 'При возобновлении нет индикаторов в периоде',
          finished_at: new Date(),
        });
        return;
      }
      await backtestLog(
        pool,
        runId,
        logicId,
        'backtest.resume.fast',
        `Быстрое возобновление: бумаг=${secTotal}, с бара ${startBarIndex}`,
        { securities: secTotal, resume_from_bar: startBarIndex },
        null,
        tfId
      );
    } else {
      secTotal = await syncActiveSecurities(
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

      // Цены денежного фонда (TMON/…) — отдельно: фонд исключён из syncActiveSecurities сигналов.
      try {
        const { rows: fundCodeRows } = await pool.query(
          `SELECT upper(btrim(COALESCE(get_logic_param_text($1, 'cash_fund_code'), ''))) AS code`,
          [logicId]
        );
        const fundCode = String(fundCodeRows[0]?.code ?? '');
        if (fundCode && ['TMON', 'LQDT', 'SBMM'].includes(fundCode)) {
          await pool.query(`SELECT logic_ensure_cash_fund_security($1, $2)`, [logicId, fundCode]);
          const { rows: fundSecRows } = await pool.query(
            `
          SELECT s.id AS security_id
          FROM securities s
          JOIN security_prefixes sp ON sp.security_id = s.id
          WHERE upper(sp.prefix) = $1
          ORDER BY sp.exchange_id
          LIMIT 1
          `,
            [fundCode]
          );
          const fundSecId = fundSecRows[0]?.security_id;
          if (fundSecId) {
            knownSecIds.add(Number(fundSecId));
            // 4 аргумента — 5-й pointCount ломал load_prices_http на части сборок.
            const fundPrice = await ensureFundPricesReady(
              pool,
              fundSecId,
              tfId,
              loadDateFrom,
              loadDateTo
            );
            if (fundPrice.status === 'error') {
              throw fundPrice.error || new Error('cash fund load_prices_http failed');
            }
            await backtestLog(
              pool,
              runId,
              logicId,
              fundPrice.waited ? 'backtest.cash_fund.prices_shared' : 'backtest.cash_fund.prices',
              fundPrice.waited
                ? `Цены фонда ${fundCode} из shared load`
                : `Цены фонда ${fundCode} загружены`,
              { fund: fundCode, security_id: fundSecId, waited: fundPrice.waited },
              fundSecId,
              tfId
            );
          }
        }
      } catch (fundErr) {
        console.warn('backtest cash fund price prep', fundErr?.message || fundErr);
        await backtestLog(
          pool,
          runId,
          logicId,
          'backtest.cash_fund.prices_fail',
          String(fundErr?.message || fundErr).slice(0, 400),
          null,
          null,
          tfId
        );
      }

      const indicatorIdsFresh = await fetchActiveIndicatorIds(pool, logicId);
      if (indicatorIdsFresh.length === 0) {
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
        `TF=${tfName} бумаг=${secTotal} сигналов=${indicatorIdsFresh.length}`,
        {
          tf_id: tfId,
          tf_name: tfName,
          load_date_from: loadDateFrom,
          point_count: pointCount,
          securities: secTotal,
          indicators: indicatorIdsFresh.length,
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
        `Цены: load=${stats.pricesLoaded} cache=${stats.pricesCached} shared=${stats.pricesShared} err=${stats.pricesErr} в периоде=${pricesInPeriod}`,
        {
          prices_loaded: stats.pricesLoaded,
          prices_cached: stats.pricesCached,
          prices_shared: stats.pricesShared,
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
          phase_detail: `Бумаг ${secTotal}, сигналов ${indicatorIdsFresh.length}`,
        },
        { force: true }
      );
    }

    const { rows: barRows } = await pool.query(
      `
      SELECT DISTINCT p.dt AS bar_dt
      FROM prices p
      JOIN logic_securities ls ON ls.security_id = p.security_id
      WHERE ls.logic_id = $1 AND ls.is_active = TRUE
        AND p.timeframe_id = $2
        AND p.dt::date BETWEEN $3 AND $4
      ORDER BY p.dt
      `,
      [logicId, tfId, dateFrom, dateTo]
    );
    const bars = barRows.map((r) => r.bar_dt);
    const totalBars = bars.length;
    const resumeBi = resume
      ? Math.min(Math.max(0, startBarIndex), totalBars)
      : 0;

    if (totalBars === 0) {
      await updateRun(pool, runId, {
        status: 'failed',
        progress_pct: 100,
        phase_message: 'Нет свечей',
        error_message: 'Нет цен в выбранном периоде',
        finished_at: new Date(),
      });
      return;
    }

    if (resume && resumeBi >= totalBars) {
      const pnl = await sumTestPnl(pool, logicId, runId);
      const { rows: tcFinal } = await pool.query(
        `SELECT trades_created FROM logic_backtest_runs WHERE id = $1`,
        [runId]
      );
      const tradesCreated = tcFinal[0]?.trades_created ?? 0;
      await backtestLog(
        pool,
        runId,
        logicId,
        'backtest.complete',
        `Возобновление: уже завершён (${totalBars} баров)`,
        { resumed: true, trades_created: tradesCreated, financial_result: pnl },
        null,
        tfId
      );
      await updateRun(pool, runId, {
        status: 'completed',
        progress_pct: 100,
        phase_message: tradesCreated > 0 ? 'Тестирование завершено' : 'Тест завершён — сделок нет',
        phase_detail: `${totalBars} баров, ${knownSecIds.size} бумаг, сделок: ${tradesCreated}`,
        processed_bars: totalBars,
        test_balance: balance,
        financial_result: pnl,
        finished_at: new Date(),
      });
      return;
    }

    const startPct =
      resume && resumeBi > 0
        ? Math.round((40 + (resumeBi / totalBars) * 59.5) * 100) / 100
        : 40;
    await updateRun(pool, runId, {
      total_bars: totalBars,
      ...(resume && resumeBi > 0 ? {} : { processed_bars: 0 }),
      status: 'running',
      progress_pct: Math.min(99.5, startPct),
      phase_message: resume && resumeBi > 0 ? 'Прогон по свечам (продолжение)' : 'Прогон по свечам',
      phase_detail:
        resume && resumeBi > 0
          ? `${resumeBi} / ${totalBars} баров (продолжение)`
          : `0 / ${totalBars} баров`,
      finished_at: null,
    });

    for (let bi = resumeBi; bi < bars.length; bi += 1) {
      // Cancel: once per bar (was 3–4 SELECT/bar).
      if (await isCancelRequested(pool, runId)) {
        await finishCancelled(pool, runId, logicId, balance, bi, totalBars);
        return;
      }

      // Rare re-sync of paper list (was every 20 bars).
      if (bi > 0 && bi % 100 === 0) {
        await syncActiveSecurities(
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
          `Обновление на баре ${bi + 1}/${totalBars}`,
          null
        );
        if (await isCancelRequested(pool, runId)) {
          await finishCancelled(pool, runId, logicId, balance, bi, totalBars);
          return;
        }
      }

      const barDt = bars[bi];
      const prevBar = bi > 0 ? bars[bi - 1] : null;
      const nextBar = bi + 1 < bars.length ? bars[bi + 1] : null;

      // Независимый рейтинг каждого сигнала (не зависит от AND/сделок)
      await pool.query(
        `SELECT logic_backtest_rate_signals($1, $2, $3, $4)`,
        [runId, logicId, tfId, barDt]
      );

      const { rows: riskRows } = await pool.query(
        `SELECT logic_backtest_process_risk($1, $2, $3, $4, $5, $6::numeric) AS balance`,
        [runId, logicId, logic.account_id, tfId, barDt, balance]
      );
      balance = Number(riskRows[0]?.balance ?? balance);

      // EOD / NTP / парковка TMON — в Node (не SQL-робот), иначе фонд не покупается из UI.
      const { rows: gateRows } = await pool.query(
        `
        SELECT logic_is_eod_close_bar($1, $2::timestamp, $3::timestamp, $4::timestamp) AS eod,
               logic_is_non_trading_dt($1, $2::timestamp) AS ntp
        `,
        [logicId, barDt, prevBar, nextBar]
      );
      if (gateRows[0]?.eod) {
        const { rows: eodBal } = await pool.query(
          `SELECT logic_backtest_close_all_except_funds($1, $2, $3, $4, $5, $6::numeric) AS balance`,
          [runId, logicId, logic.account_id, tfId, barDt, balance]
        );
        balance = Number(eodBal[0]?.balance ?? balance);
      }

      if (!gateRows[0]?.ntp) {
        const { rows: sigRows } = await pool.query(
          `SELECT logic_backtest_process_signals($1, $2, $3, $4, $5, $6::numeric) AS balance`,
          [runId, logicId, logic.account_id, tfId, barDt, balance]
        );
        balance = Number(sigRows[0]?.balance ?? balance);
      }

      const { rows: parkRows } = await pool.query(
        `SELECT logic_backtest_park_excess_cash($1, $2, $3, $4, $5, $6::numeric) AS balance`,
        [runId, logicId, logic.account_id, tfId, barDt, balance]
      );
      balance = Number(parkRows[0]?.balance ?? balance);

      const isLast = bi === bars.length - 1;
      const pct =
        Math.round((40 + ((bi + 1) / totalBars) * 59.5) * 100) / 100;
      const patch = {
        progress_pct: Math.min(99.5, pct),
        phase_message: 'Прогон по свечам',
        phase_detail: `${bi + 1} / ${totalBars} баров, бумаг ${knownSecIds.size}`,
        current_bar_dt: barDt,
        processed_bars: bi + 1,
        test_balance: balance,
      };
      // Full trade SUM is expensive as trades grow — every 25 bars is enough for UI.
      if (isLast || bi % 25 === 0) {
        patch.financial_result = await sumTestPnl(pool, logicId, runId);
      }
      await reportProgress(patch, { force: isLast });

      if (bi > 0 && bi % 200 === 0) {
        const { rows: tcRows } = await pool.query(
          `SELECT trades_created FROM logic_backtest_runs WHERE id = $1`,
          [runId]
        );
        await backtestLog(
          pool,
          runId,
          logicId,
          'backtest.progress',
          `Бар ${bi + 1}/${totalBars}, сделок=${tcRows[0]?.trades_created ?? 0}`,
          { processed_bars: bi + 1, total_bars: totalBars, securities: knownSecIds.size },
          null,
          tfId
        );
      }

      // Rare archive snapshot — never awaited; skipped if previous persist still running.
      if (bi > 0 && bi % 500 === 0) {
        schedulePersistBacktestReport(pool, runId, { isSnapshot: true });
      }
    }

    const pnl = await sumTestPnl(pool, logicId, runId);
    const { rows: diagRows } = await pool.query(
      `SELECT logic_backtest_diagnose($1, $2, $3, $4, $5) AS d`,
      [runId, logicId, tfId, dateFrom, dateTo]
    );
    const { rows: tcFinal } = await pool.query(
      `SELECT trades_created FROM logic_backtest_runs WHERE id = $1`,
      [runId]
    );
    const tradesCreated = tcFinal[0]?.trades_created ?? 0;
    const diag = diagRows[0]?.d ?? {};

    await backtestLog(
      pool,
      runId,
      logicId,
      'backtest.complete',
      tradesCreated > 0
        ? `Завершено: ${tradesCreated} сделок, PnL=${pnl.toFixed(2)}`
        : `Завершено без сделок (баров=${totalBars}, бумаг=${knownSecIds.size})`,
      {
        ...diag,
        trades_created: tradesCreated,
        financial_result: pnl,
        total_bars: totalBars,
        prices_loaded: stats.pricesLoaded,
        prices_cached: stats.pricesCached,
      },
      null,
      tfId
    );

    await updateRun(pool, runId, {
      status: 'completed',
      progress_pct: 100,
      phase_message: tradesCreated > 0 ? 'Тестирование завершено' : 'Тест завершён — сделок нет',
      phase_detail: `${totalBars} баров, ${knownSecIds.size} бумаг, сделок: ${tradesCreated}`,
      processed_bars: totalBars,
      test_balance: balance,
      financial_result: pnl,
      finished_at: new Date(),
    });
  } catch (err) {
    const msg = err?.message || String(err);
    await backtestLog(pool, runId, logicId, 'backtest.failed', msg, {
      stack: err?.stack,
      resumed: resume,
    });
    await updateRun(pool, runId, {
      status: 'failed',
      error_message: resume ? `Возобновление: ${msg}` : msg,
      progress_pct: 100,
      finished_at: new Date(),
    });
  } finally {
    activeBacktestRuns.delete(runKey);
  }
}

/**
 * After API/process restart: pick up DB rows still marked in-progress and continue
 * the same run_id from processed_bars (no trade wipe).
 */
async function resumeOrphanBacktests(pool) {
  const { rows } = await pool.query(
    `
    SELECT id, logic_id,
      date_from::text AS date_from,
      date_to::text AS date_to,
      status,
      COALESCE(processed_bars, 0)::int AS processed_bars
    FROM logic_backtest_runs
    WHERE status IN ('pending', 'loading_prices', 'loading_indicators', 'running')
      AND cancel_requested = FALSE
    ORDER BY id
    `
  );
  let scheduled = 0;
  for (const row of rows) {
    const runId = Number(row.id);
    const logicId = Number(row.logic_id);
    if (!Number.isFinite(runId) || !Number.isFinite(logicId)) continue;
    if (activeBacktestRuns.has(runId)) continue;
    scheduled += 1;
    console.log(
      `backtest resume orphan run=${runId} logic=${logicId} status=${row.status} bars=${row.processed_bars}`
    );
    setImmediate(() => {
      runBacktestAsync(pool, logicId, row.date_from, row.date_to, runId, {
        resume: true,
      }).catch((err) => {
        console.error(`backtest resume run ${runId} failed`, err);
      });
    });
  }
  return { found: rows.length, scheduled };
}

/** Сумма финреза теста — как /logic-trades/pnl-summary (без shadow, только run). */
async function sumTestPnl(pool, logicId, runId = null) {
  const params = [logicId];
  let runFilter = '';
  if (runId != null && Number(runId) > 0) {
    params.push(Number(runId));
    runFilter = ` AND lt.run_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `
    SELECT COALESCE(SUM(lt.financial_result), 0)::float8 AS pnl
    FROM logic_trades lt
    WHERE lt.logic_id = $1
      AND lt.is_test = TRUE
      AND COALESCE(lt.is_shadow, FALSE) = FALSE
      AND lt.status IN ('filled', 'submitted')
      ${runFilter}
    `,
    params
  );
  return Number(rows[0]?.pnl ?? 0);
}

async function finishCancelled(pool, runId, logicId, balance, processed, total) {
  // Ничего не удаляем: сделки/рейтинги теста остаются как есть
  const pnl = await sumTestPnl(pool, logicId, runId);
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
  schedulePersistBacktestReport(pool, runId, { isSnapshot: false });
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
  const pnl = await sumTestPnl(pool, run.logic_id, runId);
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

  if (rowCount > 0) {
    schedulePersistBacktestReport(pool, runId, { isSnapshot: false });
  }

  return rowCount > 0;
}

module.exports = {
  startBacktest,
  getBacktestStatus,
  cancelBacktest,
  resumeOrphanBacktests,
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
