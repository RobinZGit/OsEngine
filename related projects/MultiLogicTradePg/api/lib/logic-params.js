'use strict';

/** Ключи торговых параметров логики (строки в logic_params). */
const PARAM_KEYS = {
  TIMEFRAME: 'timeframe',
  POSITION_SIZE_PCT: 'position_size_pct',
  MAX_OPEN_POSITIONS: 'max_open_positions',
  INITIAL_BALANCE: 'initial_balance',
  CURRENT_BALANCE: 'current_balance',
  COMMISSION_PCT: 'commission_pct',
  COST_METHOD: 'cost_method',
  STOP_LOSS_TIMEFRAME: 'stop_loss_timeframe',
  BASE_ANNUAL_RATE_PCT: 'base_annual_rate_pct',
  RATING_LOOKBACK_DAYS: 'rating_lookback_days',
  INVERSION: 'inversion',
  WARMUP_PRETEST: 'warmup_pretest',
  CASH_FUND_CODE: 'cash_fund_code',
  CASH_FUND_THRESHOLD: 'cash_fund_threshold',
};

const CASH_FUND_CODES = new Set(['', 'TMON', 'LQDT', 'SBMM']);

const DEFAULTS = {
  [PARAM_KEYS.TIMEFRAME]: { value: 'M15', type: 'text' },
  [PARAM_KEYS.POSITION_SIZE_PCT]: { value: '10', type: 'number' },
  [PARAM_KEYS.MAX_OPEN_POSITIONS]: { value: '5', type: 'integer' },
  [PARAM_KEYS.INITIAL_BALANCE]: { value: '', type: 'money' },
  [PARAM_KEYS.CURRENT_BALANCE]: { value: '', type: 'money' },
  [PARAM_KEYS.COMMISSION_PCT]: { value: '0.03', type: 'number' },
  [PARAM_KEYS.COST_METHOD]: { value: 'FIFO', type: 'text' },
  [PARAM_KEYS.STOP_LOSS_TIMEFRAME]: { value: 'M5', type: 'text' },
  [PARAM_KEYS.BASE_ANNUAL_RATE_PCT]: { value: '20', type: 'number' },
  [PARAM_KEYS.RATING_LOOKBACK_DAYS]: { value: '7', type: 'integer' },
  [PARAM_KEYS.INVERSION]: { value: 'false', type: 'boolean' },
  [PARAM_KEYS.WARMUP_PRETEST]: { value: 'true', type: 'boolean' },
  [PARAM_KEYS.CASH_FUND_CODE]: { value: '', type: 'text' },
  [PARAM_KEYS.CASH_FUND_THRESHOLD]: { value: '100000', type: 'money' },
};

function parseParamValue(paramKey, raw, valueType) {
  const text = raw == null ? '' : String(raw).trim();
  if (text === '') {
    if (paramKey === PARAM_KEYS.INITIAL_BALANCE || paramKey === PARAM_KEYS.CURRENT_BALANCE) {
      return null;
    }
    return null;
  }
  const t = valueType || DEFAULTS[paramKey]?.type || 'text';
  if (t === 'integer') {
    const n = Number(text);
    return Number.isInteger(n) ? n : null;
  }
  if (t === 'number' || t === 'money') {
    const n = Number(text.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  if (t === 'boolean') {
    return text === 'true' || text === '1' || text === 'yes';
  }
  return text;
}

function formatParamStorage(value) {
  if (value == null || value === '') return '';
  return String(value);
}

function rowsToTradingParams(rows) {
  const map = {};
  for (const r of rows) {
    map[r.param_key] = parseParamValue(r.param_key, r.param_value, r.value_type);
  }
  return {
    timeframe:
      map[PARAM_KEYS.TIMEFRAME] != null && String(map[PARAM_KEYS.TIMEFRAME]).trim() !== ''
        ? String(map[PARAM_KEYS.TIMEFRAME]).trim().toUpperCase()
        : 'M15',
    position_size_pct:
      map[PARAM_KEYS.POSITION_SIZE_PCT] != null
        ? Number(map[PARAM_KEYS.POSITION_SIZE_PCT])
        : 10,
    max_open_positions:
      map[PARAM_KEYS.MAX_OPEN_POSITIONS] != null
        ? Number(map[PARAM_KEYS.MAX_OPEN_POSITIONS])
        : 5,
    initial_balance: map[PARAM_KEYS.INITIAL_BALANCE],
    current_balance: map[PARAM_KEYS.CURRENT_BALANCE],
    commission_pct:
      map[PARAM_KEYS.COMMISSION_PCT] != null
        ? Number(map[PARAM_KEYS.COMMISSION_PCT])
        : 0.03,
    cost_method:
      map[PARAM_KEYS.COST_METHOD] != null &&
      String(map[PARAM_KEYS.COST_METHOD]).trim() !== ''
        ? String(map[PARAM_KEYS.COST_METHOD]).trim().toUpperCase()
        : 'FIFO',
    stop_loss_timeframe:
      map[PARAM_KEYS.STOP_LOSS_TIMEFRAME] != null &&
      String(map[PARAM_KEYS.STOP_LOSS_TIMEFRAME]).trim() !== ''
        ? String(map[PARAM_KEYS.STOP_LOSS_TIMEFRAME]).trim().toUpperCase()
        : 'M5',
    base_annual_rate_pct:
      map[PARAM_KEYS.BASE_ANNUAL_RATE_PCT] != null
        ? Number(map[PARAM_KEYS.BASE_ANNUAL_RATE_PCT])
        : 20,
    rating_lookback_days:
      map[PARAM_KEYS.RATING_LOOKBACK_DAYS] != null
        ? Number(map[PARAM_KEYS.RATING_LOOKBACK_DAYS])
        : 7,
    inversion: map[PARAM_KEYS.INVERSION] === true,
    warmup_pretest: map[PARAM_KEYS.WARMUP_PRETEST] !== false,
    cash_fund_code: (() => {
      const raw =
        map[PARAM_KEYS.CASH_FUND_CODE] != null
          ? String(map[PARAM_KEYS.CASH_FUND_CODE]).trim().toUpperCase()
          : '';
      return CASH_FUND_CODES.has(raw) ? raw : '';
    })(),
    cash_fund_threshold:
      map[PARAM_KEYS.CASH_FUND_THRESHOLD] != null
        ? Number(map[PARAM_KEYS.CASH_FUND_THRESHOLD])
        : 100000,
  };
}

async function fetchParamRows(pool, logicId) {
  const { rows } = await pool.query(
    `
    SELECT lp.param_key, lp.param_value, lp.value_type
    FROM logic_params lp
    WHERE lp.logic_id = $1
    ORDER BY lp.param_key
    `,
    [logicId]
  );
  return rows;
}

/** Уже засеянные дефолты в этом процессе Node — без лишних INSERT под lock. */
const ensuredDefaultParams = new Set();

async function getTradingParams(pool, logicId) {
  await ensureDefaultParams(pool, logicId);
  const rows = await fetchParamRows(pool, logicId);
  return rowsToTradingParams(rows);
}

async function ensureDefaultParams(pool, logicId) {
  if (ensuredDefaultParams.has(logicId)) {
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Не ждать минутами, пока бой держит строку current_balance
    await client.query(`SET LOCAL lock_timeout = '1500ms'`);
    await client.query(
      `
      INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
      SELECT $1, d.param_key, d.default_value, d.value_type
      FROM logic_param_defs d
      ON CONFLICT (logic_id, param_key) DO NOTHING
      `,
      [logicId]
    );
    await client.query('COMMIT');
    ensuredDefaultParams.add(logicId);
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_e) {
      /* ignore */
    }
    // 55P03 lock_not_available — параметры скорее всего уже есть; poll UI не должен вставать
    const msg = String(err.message || '');
    if (err.code === '55P03' || /lock timeout|canceling statement due to lock/i.test(msg)) {
      ensuredDefaultParams.add(logicId);
      return;
    }
    throw err;
  } finally {
    client.release();
  }
}

async function upsertParam(pool, logicId, paramKey, value, valueType) {
  const def = DEFAULTS[paramKey];
  const vt = valueType || def?.type || 'text';
  await pool.query(
    `
    INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (logic_id, param_key) DO UPDATE SET
      param_value = EXCLUDED.param_value,
      value_type = EXCLUDED.value_type,
      updated_at = CURRENT_TIMESTAMP
    `,
    [logicId, paramKey, formatParamStorage(value), vt]
  );
}

async function saveTradingParams(pool, logicId, payload) {
  await ensureDefaultParams(pool, logicId);

  if (payload.timeframe !== undefined) {
    const tf = String(payload.timeframe).trim().toUpperCase();
    if (!tf) {
      throw new Error('timeframe required');
    }
    await upsertParam(pool, logicId, PARAM_KEYS.TIMEFRAME, tf, 'text');
  }

  if (payload.position_size_pct !== undefined) {
    await upsertParam(
      pool,
      logicId,
      PARAM_KEYS.POSITION_SIZE_PCT,
      payload.position_size_pct,
      'number'
    );
  }
  if (payload.max_open_positions !== undefined) {
    await upsertParam(
      pool,
      logicId,
      PARAM_KEYS.MAX_OPEN_POSITIONS,
      payload.max_open_positions,
      'integer'
    );
  }
  if (payload.initial_balance !== undefined) {
    await upsertParam(
      pool,
      logicId,
      PARAM_KEYS.INITIAL_BALANCE,
      payload.initial_balance,
      'money'
    );
    if (payload.reset_balance) {
      await upsertParam(
        pool,
        logicId,
        PARAM_KEYS.CURRENT_BALANCE,
        payload.initial_balance,
        'money'
      );
    }
  }

  if (payload.commission_pct !== undefined) {
    const v = Number(payload.commission_pct);
    if (!Number.isFinite(v) || v < 0 || v > 100) {
      throw new Error('% комиссии: число от 0 до 100');
    }
    await upsertParam(
      pool,
      logicId,
      PARAM_KEYS.COMMISSION_PCT,
      v,
      'number'
    );
  }

  if (payload.cost_method !== undefined) {
    const m = String(payload.cost_method).trim().toUpperCase();
    if (m !== 'FIFO' && m !== 'AVERAGE') {
      throw new Error('Метод PnL: FIFO или AVERAGE');
    }
    await upsertParam(pool, logicId, PARAM_KEYS.COST_METHOD, m, 'text');
  }

  if (payload.stop_loss_timeframe !== undefined) {
    const tf = String(payload.stop_loss_timeframe).trim().toUpperCase();
    if (!tf) {
      throw new Error('stop_loss_timeframe required');
    }
    await upsertParam(pool, logicId, PARAM_KEYS.STOP_LOSS_TIMEFRAME, tf, 'text');
  }

  if (payload.base_annual_rate_pct !== undefined) {
    const v = Number(payload.base_annual_rate_pct);
    if (!Number.isFinite(v) || v < 0 || v > 1000) {
      throw new Error('Базовая ставка (% годовых): число от 0 до 1000');
    }
    await upsertParam(
      pool,
      logicId,
      PARAM_KEYS.BASE_ANNUAL_RATE_PCT,
      v,
      'number'
    );
  }

  if (payload.rating_lookback_days !== undefined) {
    const v = Math.round(Number(payload.rating_lookback_days));
    if (!Number.isInteger(v) || v < 1 || v > 90) {
      throw new Error('Дней предрасчёта рейтинга: целое от 1 до 90');
    }
    await upsertParam(
      pool,
      logicId,
      PARAM_KEYS.RATING_LOOKBACK_DAYS,
      v,
      'integer'
    );
  }

  if (payload.inversion !== undefined) {
    await upsertParam(
      pool,
      logicId,
      PARAM_KEYS.INVERSION,
      payload.inversion ? 'true' : 'false',
      'boolean'
    );
  }

  if (payload.warmup_pretest !== undefined) {
    await upsertParam(
      pool,
      logicId,
      PARAM_KEYS.WARMUP_PRETEST,
      payload.warmup_pretest ? 'true' : 'false',
      'boolean'
    );
  }

  if (payload.cash_fund_code !== undefined) {
    const code = String(payload.cash_fund_code ?? '')
      .trim()
      .toUpperCase();
    if (!CASH_FUND_CODES.has(code)) {
      throw new Error('Денежный фонд: пусто, TMON, LQDT или SBMM');
    }
    await upsertParam(pool, logicId, PARAM_KEYS.CASH_FUND_CODE, code, 'text');
  }

  if (payload.cash_fund_threshold !== undefined) {
    const v = Number(payload.cash_fund_threshold);
    if (!Number.isFinite(v) || v < 0) {
      throw new Error('Порог свободных денег: число ≥ 0');
    }
    await upsertParam(pool, logicId, PARAM_KEYS.CASH_FUND_THRESHOLD, v, 'money');
  }

  return getTradingParams(pool, logicId);
}

async function updateCurrentBalance(pool, logicId, balance) {
  await upsertParam(pool, logicId, PARAM_KEYS.CURRENT_BALANCE, balance, 'money');
}

async function getLogicParamsDetailed(pool, logicId) {
  await ensureDefaultParams(pool, logicId);
  const { rows } = await pool.query(
    `
    SELECT
      lp.id,
      lp.logic_id,
      lp.param_key,
      lp.param_value,
      lp.value_type,
      lp.updated_at,
      d.name_ru,
      d.description
    FROM logic_params lp
    JOIN logic_param_defs d ON d.param_key = lp.param_key
    WHERE lp.logic_id = $1
    ORDER BY d.display_order, lp.param_key
    `,
    [logicId]
  );
  return rows;
}

module.exports = {
  PARAM_KEYS,
  DEFAULTS,
  parseParamValue,
  rowsToTradingParams,
  getTradingParams,
  ensureDefaultParams,
  saveTradingParams,
  updateCurrentBalance,
  getLogicParamsDetailed,
};
