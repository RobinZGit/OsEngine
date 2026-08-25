'use strict';

/** Ключи торговых параметров логики (строки в logic_params). */
const PARAM_KEYS = {
  TIMEFRAME: 'timeframe',
  POSITION_SIZE_BASE: 'position_size_base',
  POSITION_SIZE_PCT: 'position_size_pct',
  MAX_OPEN_POSITIONS: 'max_open_positions',
  MAX_ORDER_AMOUNT: 'max_order_amount',
  ORDER_GAP_BUFFER_PCT: 'order_gap_buffer_pct',
  MAX_OPEN_GAP_PCT: 'max_open_gap_pct',
  INITIAL_BALANCE: 'initial_balance',
  CURRENT_BALANCE: 'current_balance',
  COMMISSION_PCT: 'commission_pct',
  COST_METHOD: 'cost_method',
  STOP_LOSS_TIMEFRAME: 'stop_loss_timeframe',
  BASE_ANNUAL_RATE_PCT: 'base_annual_rate_pct',
  RATING_LOOKBACK_DAYS: 'rating_lookback_days',
  INVERSION: 'inversion',
  WARMUP_PRETEST: 'warmup_pretest',
  RESUME_SL_NO_REDUCE: 'resume_sl_no_reduce',
  CASH_FUND_CODE: 'cash_fund_code',
  CASH_FUND_THRESHOLD: 'cash_fund_threshold',
  USE_NON_TRADING_PERIODS: 'use_non_trading_periods',
  CLOSE_POSITIONS_EOD: 'close_positions_eod',
  SELL_FUTURES_BEFORE_EXPIRY: 'sell_futures_before_expiry',
  SELL_FUTURES_DAYS_BEFORE_EXPIRY: 'sell_futures_days_before_expiry',
  ORDER_EXECUTION: 'order_execution',
  OPT_EVAL_CANDLES: 'opt_eval_candles',
};

const CASH_FUND_CODES = new Set(['', 'TMON', 'LQDT', 'SBMM']);

const DEFAULTS = {
  [PARAM_KEYS.TIMEFRAME]: { value: 'M15', type: 'text' },
  [PARAM_KEYS.POSITION_SIZE_BASE]: { value: 'free_cash', type: 'text' },
  [PARAM_KEYS.POSITION_SIZE_PCT]: { value: '10', type: 'number' },
  [PARAM_KEYS.MAX_OPEN_POSITIONS]: { value: '5', type: 'integer' },
  [PARAM_KEYS.MAX_ORDER_AMOUNT]: { value: '', type: 'money' },
  [PARAM_KEYS.ORDER_GAP_BUFFER_PCT]: { value: '', type: 'number' },
  [PARAM_KEYS.MAX_OPEN_GAP_PCT]: { value: '', type: 'number' },
  [PARAM_KEYS.INITIAL_BALANCE]: { value: '', type: 'money' },
  [PARAM_KEYS.CURRENT_BALANCE]: { value: '', type: 'money' },
  [PARAM_KEYS.COMMISSION_PCT]: { value: '0.03', type: 'number' },
  [PARAM_KEYS.COST_METHOD]: { value: 'FIFO', type: 'text' },
  [PARAM_KEYS.STOP_LOSS_TIMEFRAME]: { value: 'M5', type: 'text' },
  [PARAM_KEYS.BASE_ANNUAL_RATE_PCT]: { value: '20', type: 'number' },
  [PARAM_KEYS.RATING_LOOKBACK_DAYS]: { value: '7', type: 'integer' },
  [PARAM_KEYS.INVERSION]: { value: 'false', type: 'boolean' },
  [PARAM_KEYS.WARMUP_PRETEST]: { value: 'true', type: 'boolean' },
  [PARAM_KEYS.RESUME_SL_NO_REDUCE]: { value: 'false', type: 'boolean' },
  [PARAM_KEYS.CASH_FUND_CODE]: { value: '', type: 'text' },
  [PARAM_KEYS.CASH_FUND_THRESHOLD]: { value: '1000000', type: 'money' },
  [PARAM_KEYS.USE_NON_TRADING_PERIODS]: { value: 'true', type: 'boolean' },
  [PARAM_KEYS.CLOSE_POSITIONS_EOD]: { value: 'false', type: 'boolean' },
  [PARAM_KEYS.SELL_FUTURES_BEFORE_EXPIRY]: { value: 'false', type: 'boolean' },
  [PARAM_KEYS.SELL_FUTURES_DAYS_BEFORE_EXPIRY]: { value: '3', type: 'integer' },
  [PARAM_KEYS.ORDER_EXECUTION]: { value: 'market', type: 'text' },
  [PARAM_KEYS.OPT_EVAL_CANDLES]: { value: '200', type: 'integer' },
};

function parseParamValue(paramKey, raw, valueType) {
  const text = raw == null ? '' : String(raw).trim();
  if (text === '') {
    if (
      paramKey === PARAM_KEYS.INITIAL_BALANCE ||
      paramKey === PARAM_KEYS.CURRENT_BALANCE ||
      paramKey === PARAM_KEYS.MAX_ORDER_AMOUNT
    ) {
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
    position_size_base: (() => {
      const raw =
        map[PARAM_KEYS.POSITION_SIZE_BASE] != null
          ? String(map[PARAM_KEYS.POSITION_SIZE_BASE]).trim().toLowerCase()
          : 'free_cash';
      if (raw === 'portfolio') return 'portfolio';
      if (raw === 'portfolio_incl_fund') return 'portfolio_incl_fund';
      return 'free_cash';
    })(),
    position_size_pct:
      map[PARAM_KEYS.POSITION_SIZE_PCT] != null
        ? Number(map[PARAM_KEYS.POSITION_SIZE_PCT])
        : 10,
    max_open_positions:
      map[PARAM_KEYS.MAX_OPEN_POSITIONS] != null
        ? Number(map[PARAM_KEYS.MAX_OPEN_POSITIONS])
        : 5,
    max_order_amount: map[PARAM_KEYS.MAX_ORDER_AMOUNT],
    order_gap_buffer_pct: map[PARAM_KEYS.ORDER_GAP_BUFFER_PCT],
    max_open_gap_pct: map[PARAM_KEYS.MAX_OPEN_GAP_PCT],
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
    resume_sl_no_reduce: map[PARAM_KEYS.RESUME_SL_NO_REDUCE] === true,
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
        : 1000000,
    use_non_trading_periods: map[PARAM_KEYS.USE_NON_TRADING_PERIODS] !== false,
    close_positions_eod: map[PARAM_KEYS.CLOSE_POSITIONS_EOD] === true,
    sell_futures_before_expiry: map[PARAM_KEYS.SELL_FUTURES_BEFORE_EXPIRY] === true,
    sell_futures_days_before_expiry: (() => {
      const n = map[PARAM_KEYS.SELL_FUTURES_DAYS_BEFORE_EXPIRY];
      const v = n != null ? Number(n) : 3;
      return Number.isInteger(v) && v >= 0 ? v : 3;
    })(),
    order_execution: (() => {
      const raw =
        map[PARAM_KEYS.ORDER_EXECUTION] != null
          ? String(map[PARAM_KEYS.ORDER_EXECUTION]).trim().toLowerCase()
          : 'market';
      return raw === 'limit' || raw === 'l' ? 'limit' : 'market';
    })(),
    opt_eval_candles: (() => {
      const n = map[PARAM_KEYS.OPT_EVAL_CANDLES];
      const v = n != null ? Number(n) : 200;
      return Number.isInteger(v) && v >= 1 ? v : 200;
    })(),
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

/**
 * Параметры сразу для списка логик (один SELECT), без HTTP к брокеру.
 * ensureDefaultParams — только для id, ещё не засеянных в этом процессе.
 */
async function getTradingParamsForLogics(pool, logicIds) {
  const ids = [...new Set((logicIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  const out = new Map();
  if (ids.length === 0) return out;

  for (const id of ids) {
    if (!ensuredDefaultParams.has(id)) {
      await ensureDefaultParams(pool, id);
    }
  }

  const { rows } = await pool.query(
    `
    SELECT logic_id, param_key, param_value, value_type
    FROM logic_params
    WHERE logic_id = ANY($1::int[])
    ORDER BY logic_id, param_key
    `,
    [ids]
  );

  const byLogic = new Map();
  for (const r of rows) {
    const lid = Number(r.logic_id);
    if (!byLogic.has(lid)) byLogic.set(lid, []);
    byLogic.get(lid).push(r);
  }
  for (const id of ids) {
    out.set(id, rowsToTradingParams(byLogic.get(id) || []));
  }
  return out;
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
    try {
      await client.query('SELECT logic_ensure_non_trading_periods($1)', [logicId]);
    } catch (_e) {
      /* функция может ещё не быть в БД до применения 02 */
    }
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

async function isLogicOnRealAccount(pool, logicId) {
  const { rows } = await pool.query(
    `
    SELECT lower(COALESCE(a.account_type, 'fake')) AS account_type
    FROM logics l
    JOIN accounts a ON a.id = l.account_id
    WHERE l.id = $1
    `,
    [logicId]
  );
  return Boolean(rows[0] && rows[0].account_type !== 'fake');
}

async function saveTradingParams(pool, logicId, payload) {
  await ensureDefaultParams(pool, logicId);
  const onReal = await isLogicOnRealAccount(pool, logicId);

  if (payload.timeframe !== undefined) {
    const tf = String(payload.timeframe).trim().toUpperCase();
    if (!tf) {
      throw new Error('timeframe required');
    }
    await upsertParam(pool, logicId, PARAM_KEYS.TIMEFRAME, tf, 'text');
  }

  if (payload.position_size_base !== undefined) {
    const base = String(payload.position_size_base || '')
      .trim()
      .toLowerCase();
    if (
      base !== 'free_cash' &&
      base !== 'portfolio' &&
      base !== 'portfolio_incl_fund'
    ) {
      throw new Error(
        'База расчёта лота: free_cash, portfolio или portfolio_incl_fund'
      );
    }
    await upsertParam(pool, logicId, PARAM_KEYS.POSITION_SIZE_BASE, base, 'text');
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
  if (payload.max_order_amount !== undefined) {
    await upsertParam(
      pool,
      logicId,
      PARAM_KEYS.MAX_ORDER_AMOUNT,
      payload.max_order_amount,
      'money'
    );
  }
  // Защита от займа при резком движении: буфер цены исполнения и гэп-фильтр входа.
  // Пусто/0 = выключено. Допустимый диапазон 0–50%.
  for (const [key, paramKey] of [
    ['order_gap_buffer_pct', PARAM_KEYS.ORDER_GAP_BUFFER_PCT],
    ['max_open_gap_pct', PARAM_KEYS.MAX_OPEN_GAP_PCT],
  ]) {
    if (payload[key] !== undefined) {
      const raw = payload[key];
      if (raw === null || raw === '') {
        await upsertParam(pool, logicId, paramKey, null, 'number');
        continue;
      }
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0 || v > 50) {
        throw new Error(`${key}: число от 0 до 50 или пусто`);
      }
      await upsertParam(pool, logicId, paramKey, v, 'number');
    }
  }
  // Fake/test: начальный/сброс текущего — из параметров формы.
  // Real: остатки только с брокера (ниже sync), форму не принимаем.
  if (!onReal && payload.initial_balance !== undefined) {
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

  if (payload.resume_sl_no_reduce !== undefined) {
    await upsertParam(
      pool,
      logicId,
      PARAM_KEYS.RESUME_SL_NO_REDUCE,
      payload.resume_sl_no_reduce ? 'true' : 'false',
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
    await syncLogicCashFundSecurity(pool, logicId, code);
  }

  if (payload.cash_fund_threshold !== undefined) {
    const v = Number(payload.cash_fund_threshold);
    if (!Number.isFinite(v) || v < 0) {
      throw new Error('Порог свободных денег: число ≥ 0');
    }
    await upsertParam(pool, logicId, PARAM_KEYS.CASH_FUND_THRESHOLD, v, 'money');
  }

  if (payload.use_non_trading_periods !== undefined) {
    await upsertParam(
      pool,
      logicId,
      PARAM_KEYS.USE_NON_TRADING_PERIODS,
      payload.use_non_trading_periods ? 'true' : 'false',
      'boolean'
    );
  }

  if (payload.close_positions_eod !== undefined) {
    await upsertParam(
      pool,
      logicId,
      PARAM_KEYS.CLOSE_POSITIONS_EOD,
      payload.close_positions_eod ? 'true' : 'false',
      'boolean'
    );
  }

  if (payload.sell_futures_before_expiry !== undefined) {
    await upsertParam(
      pool,
      logicId,
      PARAM_KEYS.SELL_FUTURES_BEFORE_EXPIRY,
      payload.sell_futures_before_expiry ? 'true' : 'false',
      'boolean'
    );
  }

  if (payload.sell_futures_days_before_expiry !== undefined) {
    const v = Math.round(Number(payload.sell_futures_days_before_expiry));
    if (!Number.isInteger(v) || v < 0 || v > 365) {
      throw new Error('Дней до экспирации: целое от 0 до 365');
    }
    await upsertParam(
      pool,
      logicId,
      PARAM_KEYS.SELL_FUTURES_DAYS_BEFORE_EXPIRY,
      v,
      'integer'
    );
  }

  if (payload.order_execution !== undefined) {
    const raw = String(payload.order_execution ?? '')
      .trim()
      .toLowerCase();
    const exec = raw === 'limit' || raw === 'l' ? 'limit' : 'market';
    await upsertParam(pool, logicId, PARAM_KEYS.ORDER_EXECUTION, exec, 'text');
  }

  if (payload.opt_eval_candles !== undefined) {
    const v = Math.round(Number(payload.opt_eval_candles));
    if (!Number.isInteger(v) || v < 1 || v > 500) {
      throw new Error('Свечей окна OPT: целое от 1 до 500');
    }
    await upsertParam(pool, logicId, PARAM_KEYS.OPT_EVAL_CANDLES, v, 'integer');
  }

  if (onReal) {
    await syncRealAccountBalancesIfNeeded(pool, logicId, { force: true });
  }

  return getTradingParams(pool, logicId);
}

/** Привязать выбранный денежный фонд к logic_securities (display_order=0, сверху списка). */
async function syncLogicCashFundSecurity(pool, logicId, code) {
  await pool.query(
    `
    DELETE FROM logic_securities ls
    USING security_prefixes sp
    WHERE ls.security_id = sp.security_id
      AND ls.logic_id = $1
      AND upper(sp.prefix) IN ('TMON', 'LQDT', 'SBMM')
      AND ($2::text = '' OR upper(sp.prefix) <> $2)
    `,
    [logicId, code || '']
  );

  if (!code) {
    return;
  }

  const { rows } = await pool.query(
    `
    SELECT s.id AS security_id
    FROM securities s
    JOIN security_prefixes sp ON sp.security_id = s.id
    WHERE upper(sp.prefix) = $1
    ORDER BY sp.exchange_id
    LIMIT 1
    `,
    [code]
  );
  if (!rows[0]) {
    return;
  }
  const securityId = rows[0].security_id;

  await pool.query(
    `
    UPDATE logic_securities
    SET display_order = display_order + 1
    WHERE logic_id = $1
      AND security_id <> $2
      AND display_order >= 0
    `,
    [logicId, securityId]
  );

  await pool.query(
    `
    INSERT INTO logic_securities (logic_id, security_id, display_order, is_active)
    VALUES ($1, $2, 0, TRUE)
    ON CONFLICT (logic_id, security_id) DO UPDATE SET
      is_active = TRUE,
      display_order = 0
    `,
    [logicId, securityId]
  );
}

async function updateCurrentBalance(pool, logicId, balance) {
  await upsertParam(pool, logicId, PARAM_KEYS.CURRENT_BALANCE, balance, 'money');
}

/**
 * После смены счёта логики: очистить боевую историю сделок/FINRES,
 * сбросить pause/resume и остатки (как «выкл → вкл» на новом счёте).
 * Тестовые сделки (is_test) не трогаем.
 */
async function resetLogicTradingStateOnAccountChange(poolOrClient, logicId) {
  const id = Number(logicId);
  if (!Number.isInteger(id) || id <= 0) return { cleared_trades: 0 };

  await poolOrClient.query(
    `
    DELETE FROM logic_trade_lots
    WHERE logic_id = $1
      AND close_trade_id IN (
        SELECT id FROM logic_trades
        WHERE logic_id = $1 AND COALESCE(is_test, FALSE) = FALSE
      )
    `,
    [id]
  );

  const del = await poolOrClient.query(
    `
    DELETE FROM logic_trades
    WHERE logic_id = $1 AND COALESCE(is_test, FALSE) = FALSE
    `,
    [id]
  );

  await poolOrClient.query(
    `
    UPDATE logics
    SET
      portfolio_trading_paused = FALSE,
      portfolio_equity_peak = NULL,
      portfolio_stop_resume_equity = NULL,
      portfolio_stop_resume_baseline = NULL,
      portfolio_stop_resume_at = NULL
    WHERE id = $1
    `,
    [id]
  );

  await poolOrClient.query(
    `
    UPDATE logic_securities
    SET
      real_trading_paused = FALSE,
      real_trading_inverted = FALSE,
      stop_resume_equity = NULL,
      stop_resume_baseline = NULL,
      stop_resume_triggered_at = NULL
    WHERE logic_id = $1
    `,
    [id]
  );

  const { rows: accRows } = await poolOrClient.query(
    `
    SELECT lower(COALESCE(a.account_type, 'fake')) AS account_type
    FROM logics l
    JOIN accounts a ON a.id = l.account_id
    WHERE l.id = $1
    `,
    [id]
  );
  const accountType = accRows[0]?.account_type || 'fake';

  if (accountType === 'fake') {
    // Текущий остаток = начальный (FINRES/история обнулены).
    await poolOrClient.query(
      `
      UPDATE logic_params cur
      SET
        param_value = init.param_value,
        value_type = 'money',
        updated_at = CURRENT_TIMESTAMP
      FROM logic_params init
      WHERE cur.logic_id = $1
        AND cur.param_key = 'current_balance'
        AND init.logic_id = $1
        AND init.param_key = 'initial_balance'
        AND btrim(COALESCE(init.param_value, '')) <> ''
      `,
      [id]
    );
  } else {
    await poolOrClient.query(
      `SELECT logic_apply_real_account_balances($1, TRUE)`,
      [id]
    );
  }

  return { cleared_trades: del.rowCount || 0 };
}

/**
 * Сброс теневого режима логики: удалить live shadow-сделки,
 * снять pause/resume/инверсию, включить все бумаги логики (is_active),
 * как после «чистого» старта (без удаления чемпионских live-сделок).
 */
async function resetLogicShadowTradingState(poolOrClient, logicId) {
  const id = Number(logicId);
  if (!Number.isInteger(id) || id <= 0) {
    return { cleared_shadow_trades: 0, securities_reactivated: 0 };
  }

  await poolOrClient.query(
    `
    DELETE FROM logic_trade_lots
    WHERE logic_id = $1
      AND (
        close_trade_id IN (
          SELECT id FROM logic_trades
          WHERE logic_id = $1
            AND COALESCE(is_shadow, FALSE) = TRUE
            AND COALESCE(is_test, FALSE) = FALSE
        )
        OR open_trade_id IN (
          SELECT id FROM logic_trades
          WHERE logic_id = $1
            AND COALESCE(is_shadow, FALSE) = TRUE
            AND COALESCE(is_test, FALSE) = FALSE
        )
      )
    `,
    [id]
  );

  const del = await poolOrClient.query(
    `
    DELETE FROM logic_trades
    WHERE logic_id = $1
      AND COALESCE(is_shadow, FALSE) = TRUE
      AND COALESCE(is_test, FALSE) = FALSE
    `,
    [id]
  );

  await poolOrClient.query(
    `
    UPDATE logics
    SET
      portfolio_trading_paused = FALSE,
      portfolio_equity_peak = NULL,
      portfolio_stop_resume_equity = NULL,
      portfolio_stop_resume_baseline = NULL,
      portfolio_stop_resume_at = NULL
    WHERE id = $1
    `,
    [id]
  );

  const sec = await poolOrClient.query(
    `
    UPDATE logic_securities
    SET
      is_active = TRUE,
      real_trading_paused = FALSE,
      real_trading_paused_long = FALSE,
      real_trading_paused_short = FALSE,
      real_trading_inverted = FALSE,
      stop_resume_equity = NULL,
      stop_resume_baseline = NULL,
      stop_resume_triggered_at = NULL,
      stop_resume_equity_long = NULL,
      stop_resume_baseline_long = NULL,
      stop_resume_triggered_at_long = NULL,
      stop_resume_equity_short = NULL,
      stop_resume_baseline_short = NULL,
      stop_resume_triggered_at_short = NULL,
      stop_resume_hwm_long = NULL,
      stop_resume_hwm_short = NULL
    WHERE logic_id = $1
    `,
    [id]
  );

  return {
    cleared_shadow_trades: del.rowCount || 0,
    securities_reactivated: sec.rowCount || 0,
  };
}

/** Throttle T-Bank balance sync: min interval per logic (ms). */
const REAL_BALANCE_SYNC_TTL_MS = 60_000;
const realBalanceSyncAt = new Map();

/**
 * Real-счёт: initial/current = кэш брокера или 0 (никогда paper 1M).
 * Fake — no-op. Ошибки брокера глотаем: SQL сам пишет 0.
 * Не чаще раза в минуту на логику (poll списка не должен спамить T-Bank).
 * @param {{ force?: boolean }} [opts]
 */
async function syncRealAccountBalancesIfNeeded(poolOrClient, logicId, opts = {}) {
  const id = Number(logicId);
  if (!Number.isInteger(id) || id <= 0) return;
  const force = Boolean(opts.force);
  const now = Date.now();
  if (!force) {
    const prev = realBalanceSyncAt.get(id) || 0;
    if (now - prev < REAL_BALANCE_SYNC_TTL_MS) return;
  }
  try {
    const { rows } = await poolOrClient.query(
      `
      SELECT lower(COALESCE(a.account_type, 'fake')) AS account_type
      FROM logics l
      JOIN accounts a ON a.id = l.account_id
      WHERE l.id = $1
      `,
      [id]
    );
    if (!rows.length || rows[0].account_type === 'fake') return;
    // Помечаем до HTTP, чтобы параллельные вызовы не дублировали запрос.
    realBalanceSyncAt.set(id, now);
    await poolOrClient.query(
      `SELECT logic_apply_real_account_balances($1, TRUE)`,
      [id]
    );
  } catch (err) {
    realBalanceSyncAt.delete(id);
    console.warn(
      `syncRealAccountBalancesIfNeeded logic=${id}:`,
      err && err.message ? err.message : err
    );
  }
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
  getTradingParamsForLogics,
  ensureDefaultParams,
  saveTradingParams,
  syncLogicCashFundSecurity,
  updateCurrentBalance,
  syncRealAccountBalancesIfNeeded,
  resetLogicTradingStateOnAccountChange,
  resetLogicShadowTradingState,
  getLogicParamsDetailed,
};
