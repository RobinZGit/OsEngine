'use strict';

const { writeTechLogEvent } = require('./lib/tech-log');
const { waitWhileBacktestActive, sleep } = require('./lib/work-isolation');

/** In-memory jobs: logicId → status (фон, не блокирует бой). */
const jobs = new Map();

function idleJob(logicId) {
  return {
    logic_id: logicId,
    status: 'idle',
    progress_pct: 0,
    phase_message: '',
    bars_total: 0,
    bars_done: 0,
    lookback_days: 7,
    error: null,
    started_at: null,
    finished_at: null,
  };
}

function getRatingPrecalcStatus(logicId) {
  return jobs.get(logicId) || idleJob(logicId);
}

function patchJob(logicId, patch) {
  const cur = jobs.get(logicId) || idleJob(logicId);
  const next = { ...cur, ...patch, logic_id: logicId };
  jobs.set(logicId, next);
  return next;
}

async function readLookbackDays(pool, logicId) {
  const { rows } = await pool.query(
    `
    SELECT param_value
    FROM logic_params
    WHERE logic_id = $1 AND param_key = 'rating_lookback_days'
    LIMIT 1
    `,
    [logicId]
  );
  let lookback = Number(rows[0]?.param_value);
  if (!Number.isFinite(lookback)) lookback = 7;
  return Math.max(1, Math.min(90, Math.round(lookback)));
}

async function startRatingPrecalc(pool, logicId) {
  const cur = jobs.get(logicId);
  if (cur && (cur.status === 'pending' || cur.status === 'running')) {
    return cur;
  }

  const job = patchJob(logicId, {
    status: 'pending',
    progress_pct: 0,
    phase_message: 'Ожидание предрасчёта',
    bars_total: 0,
    bars_done: 0,
    lookback_days: 7,
    error: null,
    started_at: new Date().toISOString(),
    finished_at: null,
  });

  setImmediate(() => {
    runRatingPrecalc(pool, logicId).catch((err) => {
      console.error('rating precalc', logicId, err);
      patchJob(logicId, {
        status: 'failed',
        progress_pct: 100,
        phase_message: 'Ошибка предрасчёта',
        error: err.message || String(err),
        finished_at: new Date().toISOString(),
      });
    });
  });

  return job;
}

async function queryWithRetry(pool, sql, params, opts = {}) {
  const attempts = Number(opts.attempts) || 5;
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await pool.query(sql, params);
    } catch (err) {
      lastErr = err;
      // 40001 serialization_failure, 40P01 deadlock_detected, 55P03 lock_not_available
      if (!['40001', '40P01', '55P03'].includes(err.code) && i === attempts - 1) {
        throw err;
      }
      if (!['40001', '40P01', '55P03'].includes(err.code)) {
        throw err;
      }
      await sleep(200 + i * 300);
    }
  }
  throw lastErr;
}

async function loadBarsForPrecalc(pool, logicId, tfId, lookback) {
  const { rows: barRows } = await pool.query(
    `
    SELECT DISTINCT p.dt AS bar_dt
    FROM prices p
    JOIN logic_securities ls
      ON ls.security_id = p.security_id
     AND ls.logic_id = $1
     AND ls.is_active = TRUE
    WHERE p.timeframe_id = $2
      AND p.dt >= (CURRENT_TIMESTAMP - ($3::text || ' days')::interval)
      AND p.dt < CURRENT_TIMESTAMP
    ORDER BY p.dt
    `,
    [logicId, tfId, lookback]
  );
  return barRows.map((r) => r.bar_dt);
}

async function runRatingPrecalc(pool, logicId) {
  patchJob(logicId, {
    status: 'running',
    progress_pct: 1,
    phase_message: 'Ожидание свободного окна (без бэктеста этой логики)',
  });

  const cleared = await waitWhileBacktestActive(pool, logicId, {
    timeoutMs: 45 * 60 * 1000,
    pollMs: 2000,
  });
  if (!cleared) {
    patchJob(logicId, {
      status: 'failed',
      progress_pct: 100,
      phase_message: 'Таймаут ожидания бэктеста',
      error: 'backtest still active',
      finished_at: new Date().toISOString(),
    });
    return;
  }

  const lookback = await readLookbackDays(pool, logicId);

  const { rows: tfRows } = await pool.query(
    `SELECT logic_resolve_timeframe_id($1) AS tf_id`,
    [logicId]
  );
  const tfId = tfRows[0]?.tf_id;
  if (!tfId) {
    patchJob(logicId, {
      status: 'failed',
      progress_pct: 100,
      phase_message: 'Нет таймфрейма логики',
      error: 'logic_resolve_timeframe_id returned null',
      lookback_days: lookback,
      finished_at: new Date().toISOString(),
    });
    return;
  }

  patchJob(logicId, {
    lookback_days: lookback,
    phase_message: `Загрузка цен/индикаторов за ${lookback} дн.`,
    progress_pct: 3,
  });

  // Сначала данные, потом сброс: иначе после 00 enable обнуляет rating при пустых ценах
  await queryWithRetry(
    pool,
    `CALL logic_rating_precalc_ensure_data($1, $2, $3)`,
    [logicId, tfId, lookback],
    { attempts: 3 }
  );

  let bars = await loadBarsForPrecalc(pool, logicId, tfId, lookback);

  // Повтор после гонки с другим loader'ом / медленным HTTP
  if (bars.length === 0) {
    patchJob(logicId, {
      phase_message: 'Нет свечей — повторная загрузка…',
      progress_pct: 4,
    });
    await sleep(2500);
    await queryWithRetry(
      pool,
      `CALL logic_rating_precalc_ensure_data($1, $2, $3)`,
      [logicId, tfId, lookback],
      { attempts: 3 }
    );
    bars = await loadBarsForPrecalc(pool, logicId, tfId, lookback);
  }

  const total = bars.length;
  patchJob(logicId, {
    bars_total: total,
    bars_done: 0,
    progress_pct: total === 0 ? 100 : 5,
    phase_message:
      total === 0
        ? 'Нет свечей в окне предрасчёта (после загрузки)'
        : `Свечи: 0 / ${total}`,
  });

  if (total === 0) {
    // Не вызываем reset — иначе UI остаётся с нулями после wipe
    patchJob(logicId, {
      status: 'failed',
      error: 'no_bars_after_load',
      finished_at: new Date().toISOString(),
    });
    try {
      await writeTechLogEvent(pool, {
        threadKey: `logic:${logicId}:rating-precalc`,
        operation: 'logic.rating_precalc.empty',
        message: 'Предрасчёт боевых рейтингов: нет свечей после загрузки',
        source: 'api',
        logicId,
        payload: { lookback_days: lookback },
      });
    } catch (_e) {
      /* optional */
    }
    return;
  }

  patchJob(logicId, {
    phase_message: 'Сброс боевого рейтинга',
    progress_pct: 6,
  });
  await queryWithRetry(pool, `SELECT logic_signal_rating_reset_live($1)`, [logicId]);

  for (let i = 0; i < bars.length; i += 1) {
    // Пауза, если на эту логику снова запустили тест
    if (i > 0 && i % 25 === 0) {
      const ok = await waitWhileBacktestActive(pool, logicId, {
        timeoutMs: 45 * 60 * 1000,
        pollMs: 2000,
      });
      if (!ok) {
        patchJob(logicId, {
          status: 'failed',
          progress_pct: Math.min(99, 6 + Math.round(((i + 1) / total) * 93)),
          phase_message: 'Прервано: длинный бэктест',
          bars_done: i,
          error: 'backtest resumed during precalc',
          finished_at: new Date().toISOString(),
        });
        return;
      }
    }

    await queryWithRetry(
      pool,
      `SELECT logic_signal_rate_bar($1, $2, $3, FALSE, NULL)`,
      [logicId, tfId, bars[i]]
    );

    if (i === bars.length - 1 || i % 15 === 0) {
      const done = i + 1;
      const pct = Math.min(99, 6 + Math.round((done / total) * 93));
      patchJob(logicId, {
        bars_done: done,
        progress_pct: pct,
        phase_message: `Свечи: ${done} / ${total}`,
      });
    }
  }

  await queryWithRetry(
    pool,
    `SELECT logic_signal_rating_resolve_pending($1, $2, NULL, FALSE, NULL)`,
    [logicId, tfId]
  );

  patchJob(logicId, {
    status: 'done',
    bars_done: total,
    progress_pct: 100,
    phase_message: `Готово: ${total} свечей`,
    finished_at: new Date().toISOString(),
    error: null,
  });

  try {
    await writeTechLogEvent(pool, {
      threadKey: `logic:${logicId}:rating-precalc`,
      operation: 'logic.rating_precalc.done',
      message: 'Предрасчёт боевых рейтингов завершён',
      source: 'api',
      logicId,
      payload: { lookback_days: lookback, bars: total },
    });
  } catch (_e) {
    /* optional */
  }
}

module.exports = {
  startRatingPrecalc,
  getRatingPrecalcStatus,
};
