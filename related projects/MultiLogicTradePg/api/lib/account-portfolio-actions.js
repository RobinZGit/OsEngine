'use strict';

const { listBondFunds } = require('./bond-tbru-data');
const { resolveBondFund } = require('./bond-fund-fetch');
const { computeGreedyBuyLots, bondUnitPriceRub } = require('./bond-tbru-alloc');
const {
  DEFAULT_API,
  tbankHttpPost,
  resolveTbankAccount,
  postOrder,
  figiLotSize,
  fetchPortfolioBalance,
} = require('./tbank-invest-client');

async function getOrderChannel(pool) {
  try {
    const { rows } = await pool.query(`SELECT tbank_order_channel() AS c`);
    return rows[0]?.c === 'postgres' ? 'postgres' : 'node';
  } catch (_e) {
    return 'node';
  }
}

async function loadAccountBrokerCreds(pool, accountId) {
  const { rows } = await pool.query(
    `
    SELECT
      a.id,
      a.name,
      a.account_code,
      btrim(a.token_encrypted) AS token,
      COALESCE(NULLIF(btrim(b.api_url), ''), $2) AS api_url
    FROM accounts a
    JOIN brokers b ON b.id = a.broker_id
    WHERE a.id = $1
    `,
    [accountId, DEFAULT_API]
  );
  const acc = rows[0];
  if (!acc?.token) {
    const err = new Error('На счёте нет API-токена T-Bank');
    err.status = 400;
    throw err;
  }
  return acc;
}

function quotationToNumber(q) {
  if (q == null) return 0;
  if (typeof q === 'number') return q;
  if (typeof q === 'string') {
    const n = Number(q);
    return Number.isFinite(n) ? n : 0;
  }
  const units = Number(q.units ?? 0);
  const nano = Number(q.nano ?? 0);
  return units + nano / 1e9;
}

async function assertRealTbankAccount(pool, accountId) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('Некорректный account_id');
    err.status = 400;
    throw err;
  }
  const { rows } = await pool.query(
    `
    SELECT
      a.id,
      a.account_type,
      a.name,
      a.account_code,
      (a.token_encrypted IS NOT NULL AND btrim(a.token_encrypted) <> '') AS has_token,
      b.code AS broker_code
    FROM accounts a
    JOIN brokers b ON b.id = a.broker_id
    WHERE a.id = $1
    `,
    [id]
  );
  const acc = rows[0];
  if (!acc) {
    const err = new Error('Счёт не найден');
    err.status = 404;
    throw err;
  }
  if (String(acc.account_type).toLowerCase() !== 'real') {
    const err = new Error('Действие доступно только для реального счёта');
    err.status = 400;
    throw err;
  }
  if (acc.broker_code !== 'T-BANK') {
    const err = new Error('Действие доступно только для брокера T-Bank');
    err.status = 400;
    throw err;
  }
  if (!acc.has_token) {
    const err = new Error('На счёте нет API-токена T-Bank');
    err.status = 400;
    throw err;
  }
  return acc;
}

async function sellAllPositionsViaNode(pool, accountId) {
  const creds = await loadAccountBrokerCreds(pool, accountId);
  const resolved = await resolveTbankAccount(
    creds.api_url,
    creds.token,
    creds.account_code || null
  );
  const portfolio = await tbankHttpPost(
    creds.api_url,
    'tinkoff.public.invest.api.contract.v1.OperationsService/GetPortfolio',
    creds.token,
    { accountId: resolved.account_id }
  );
  const positions = Array.isArray(portfolio?.positions) ? portfolio.positions : [];
  const cashBefore = quotationToNumber(portfolio?.totalAmountCurrencies);
  const sold = [];
  const errors = [];
  const skipped = [];

  for (const pos of positions) {
    const type = String(pos.instrumentType || pos.instrument_type || '').toUpperCase();
    if (type.includes('CURRENCY')) {
      skipped.push({ figi: pos.figi, reason: 'currency' });
      continue;
    }
    const figi = String(pos.figi || '').trim();
    const ticker = pos.ticker || figi || '?';
    if (!figi) {
      errors.push({ ticker, error: 'no_figi' });
      continue;
    }
    const shares = quotationToNumber(pos.quantity);
    const blockedLots = quotationToNumber(pos.blockedLots || pos.blocked_lots);
    const lot = await figiLotSize(creds.api_url, creds.token, figi, pool);
    let sellShares = shares - blockedLots * lot;
    if (Math.abs(sellShares) < lot) {
      let lots =
        quotationToNumber(pos.quantityLots || pos.quantity_lots) - blockedLots;
      if (Math.abs(lots) >= 1) sellShares = lots * lot;
    }
    if (Math.abs(sellShares) < lot) {
      skipped.push({
        figi,
        ticker,
        reason: 'zero_lots',
        shares,
        blocked_lots: blockedLots,
        lot,
      });
      continue;
    }
    let dir = 'SELL';
    if (sellShares < 0) {
      dir = 'BUY';
      sellShares = Math.abs(sellShares);
    }
    const lots = Math.floor(sellShares / lot);
    if (lots < 1) {
      skipped.push({
        figi,
        ticker,
        reason: 'below_one_lot',
        sell_shares: sellShares,
        lot,
      });
      continue;
    }
    const price =
      quotationToNumber(pos.currentPrice) ||
      quotationToNumber(pos.averagePositionPriceFifo) ||
      quotationToNumber(pos.averagePositionPrice) ||
      1;
    try {
      const order = await postOrder(pool, {
        api_url: creds.api_url,
        token: creds.token,
        account_code: creds.account_code,
        figi,
        quantity: lots,
        price,
        direction: dir,
        order_execution: 'market',
        quantity_is_lots: true,
      });
      sold.push({
        figi,
        ticker,
        lots,
        shares: lots * lot,
        lot_size: lot,
        price,
        direction: dir,
        instrument_type: type,
        order,
        channel: 'node',
      });
    } catch (e) {
      errors.push({
        figi,
        ticker,
        lots,
        shares: lots * lot,
        direction: dir,
        error: e.message || String(e),
      });
    }
  }

  const { rows } = await pool.query(
    `SELECT account_sell_all_at_market_with_books($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb) AS r`,
    [
      accountId,
      JSON.stringify(sold),
      JSON.stringify(errors),
      JSON.stringify(skipped),
      JSON.stringify(cashBefore),
    ]
  );
  const result = rows[0]?.r ?? {};
  return { ...result, channel: 'node' };
}

async function sellAllPositions(pool, accountId) {
  await assertRealTbankAccount(pool, accountId);
  const channel = await getOrderChannel(pool);
  if (channel === 'node') {
    return sellAllPositionsViaNode(pool, accountId);
  }
  const { rows } = await pool.query(
    `SELECT account_sell_all_at_market($1) AS r`,
    [accountId]
  );
  return { ...(rows[0]?.r ?? { ok: false, error: 'empty_result' }), channel: 'postgres' };
}

/**
 * Close all open positions of one logic at market.
 * Node channel: PostOrder in-process (same as sell-all) — no SQL→HTTP→heartbeat gate.
 * Postgres channel: SQL logic_close_all_positions_at_market (pgsql-http).
 */
async function closeAllLogicPositionsViaNode(pool, logicId) {
  const { rows: logicRows } = await pool.query(
    `
    SELECT
      l.id,
      l.account_id,
      a.account_type,
      a.account_code,
      btrim(a.token_encrypted) AS token,
      COALESCE(NULLIF(btrim(b.api_url), ''), $2) AS api_url
    FROM logics l
    JOIN accounts a ON a.id = l.account_id
    JOIN brokers b ON b.id = a.broker_id
    WHERE l.id = $1
      AND a.is_active = TRUE
    `,
    [logicId, DEFAULT_API]
  );
  const logic = logicRows[0];
  if (!logic) {
    return {
      ok: false,
      error: 'Логика не найдена или счёт неактивен',
      closed: 0,
      channel: 'node',
    };
  }

  if (String(logic.account_type).toLowerCase() === 'fake') {
    const { rows } = await pool.query(
      `SELECT logic_close_all_positions_at_market($1::INTEGER) AS result`,
      [logicId]
    );
    return { ...(rows[0]?.result ?? { ok: false, closed: 0 }), channel: 'node' };
  }

  if (!logic.token) {
    return {
      ok: false,
      error: 'На счёте нет API-токена T-Bank',
      closed: 0,
      channel: 'node',
    };
  }

  const { rows: plan } = await pool.query(
    `
    WITH secs AS (
      SELECT DISTINCT lt.security_id
      FROM logic_trades lt
      WHERE lt.logic_id = $1
        AND NOT lt.is_shadow
        AND NOT lt.is_test
        AND lt.status IN ('filled', 'submitted')
    )
    SELECT
      s.security_id,
      (
        SELECT sp.tbank_figi
        FROM security_prefixes sp
        WHERE sp.security_id = s.security_id
          AND sp.tbank_figi IS NOT NULL
        ORDER BY sp.exchange_id
        LIMIT 1
      ) AS figi,
      (
        SELECT sp.prefix
        FROM security_prefixes sp
        WHERE sp.security_id = s.security_id
        ORDER BY sp.exchange_id
        LIMIT 1
      ) AS ticker,
      logic_long_position_qty($1, s.security_id, FALSE) AS long_qty,
      logic_short_position_qty($1, s.security_id, FALSE) AS short_qty,
      logic_ensure_security_market_price(
        $1,
        s.security_id,
        logic_resolve_timeframe_id($1)
      ) AS price
    FROM secs s
    `,
    [logicId]
  );

  const sold = [];
  const errors = [];

  for (const row of plan) {
    const longQty = Math.floor(Number(row.long_qty) || 0);
    const shortQty = Math.floor(Number(row.short_qty) || 0);
    if (longQty < 1 && shortQty < 1) continue;

    const figi = String(row.figi || '').trim();
    const ticker = row.ticker || figi || String(row.security_id);
    if (!figi) {
      errors.push({
        security_id: row.security_id,
        ticker,
        error: 'Нет tbank_figi для бумаги',
      });
      continue;
    }

    const price = Number(row.price) > 0 ? Number(row.price) : 1;

    if (longQty >= 1) {
      try {
        const order = await postOrder(pool, {
          api_url: logic.api_url,
          token: logic.token,
          account_code: logic.account_code,
          figi,
          quantity: longQty,
          price,
          direction: 'SELL',
          order_execution: 'market',
          quantity_is_lots: false,
        });
        sold.push({
          figi,
          ticker,
          security_id: row.security_id,
          direction: 'SELL',
          shares: longQty,
          price,
          order,
          channel: 'node',
        });
      } catch (e) {
        errors.push({
          figi,
          ticker,
          security_id: row.security_id,
          direction: 'SELL',
          shares: longQty,
          error: e.message || String(e),
        });
      }
    }

    if (shortQty >= 1) {
      try {
        const order = await postOrder(pool, {
          api_url: logic.api_url,
          token: logic.token,
          account_code: logic.account_code,
          figi,
          quantity: shortQty,
          price,
          direction: 'BUY',
          order_execution: 'market',
          quantity_is_lots: false,
        });
        sold.push({
          figi,
          ticker,
          security_id: row.security_id,
          direction: 'BUY',
          shares: shortQty,
          price,
          order,
          channel: 'node',
        });
      } catch (e) {
        errors.push({
          figi,
          ticker,
          security_id: row.security_id,
          direction: 'BUY',
          shares: shortQty,
          error: e.message || String(e),
        });
      }
    }
  }

  const { rows } = await pool.query(
    `SELECT logic_close_all_positions_at_market(
       $1::INTEGER, FALSE, FALSE, 'market:close_all_node', $2::jsonb
     ) AS result`,
    [logicId, JSON.stringify(sold)]
  );
  const result = rows[0]?.result ?? { ok: true, closed: 0 };
  const closed = Number(result.closed) || 0;
  return {
    ...result,
    channel: 'node',
    broker_sold_count: sold.length,
    broker_error_count: errors.length,
    broker_errors: errors,
    sold,
    ok: errors.length === 0,
    error:
      errors.length > 0
        ? errors[0].error || 'Не удалось закрыть позиции через Node'
        : result.error || null,
    closed,
  };
}

async function closeAllLogicPositions(pool, logicId) {
  const channel = await getOrderChannel(pool);
  if (channel === 'node') {
    return closeAllLogicPositionsViaNode(pool, logicId);
  }
  const { rows } = await pool.query(
    `SELECT logic_close_all_positions_at_market($1::INTEGER) AS result`,
    [logicId]
  );
  return {
    ...(rows[0]?.result ?? { ok: false, error: 'empty_result', closed: 0 }),
    channel: 'postgres',
  };
}

async function getAccountCashViaNode(pool, accountId) {
  const creds = await loadAccountBrokerCreds(pool, accountId);
  const resolved = await resolveTbankAccount(
    creds.api_url,
    creds.token,
    creds.account_code || null
  );
  const bal = await fetchPortfolioBalance(
    creds.api_url,
    creds.token,
    resolved.account_id
  );
  return {
    cash_amount: bal.cash_amount != null ? Number(bal.cash_amount) : 0,
    portfolio_amount: bal.amount != null ? Number(bal.amount) : null,
  };
}

async function getAccountCash(pool, accountId) {
  const channel = await getOrderChannel(pool);
  if (channel === 'node') {
    return getAccountCashViaNode(pool, accountId);
  }
  const { rows } = await pool.query(
    `SELECT fetch_tbank_portfolio_positions($1) AS r`,
    [accountId]
  );
  const r = rows[0]?.r ?? {};
  return {
    cash_amount: r.cash_amount != null ? Number(r.cash_amount) : 0,
    portfolio_amount: r.portfolio_amount != null ? Number(r.portfolio_amount) : null,
  };
}

async function resolveBondByIsinViaNode(pool, accountId, isin) {
  const creds = await loadAccountBrokerCreds(pool, accountId);
  const vIsin = String(isin || '')
    .trim()
    .toUpperCase();
  if (!vIsin) return { error: 'empty_isin' };
  let instrument = null;
  try {
    const data = await tbankHttpPost(
      creds.api_url,
      'tinkoff.public.invest.api.contract.v1.InstrumentsService/BondBy',
      creds.token,
      { idType: 'INSTRUMENT_ID_TYPE_ISIN', id: vIsin }
    );
    instrument = data?.instrument || null;
  } catch (_e) {
    instrument = null;
  }
  if (!instrument) {
    try {
      const data = await tbankHttpPost(
        creds.api_url,
        'tinkoff.public.invest.api.contract.v1.InstrumentsService/FindInstrument',
        creds.token,
        { query: vIsin }
      );
      const list = Array.isArray(data?.instruments) ? data.instruments : [];
      instrument =
        list.find(
          (e) =>
            String(e.isin || '').toUpperCase() === vIsin ||
            String(e.ticker || '').toUpperCase() === vIsin
        ) || null;
    } catch (_e) {
      instrument = null;
    }
  }
  if (!instrument) return { error: 'instrument_not_found', isin: vIsin };
  const figi = instrument.figi || instrument.uid;
  const lot = Math.max(1, Number(instrument.lot) || 1);
  if (!figi) return { error: 'no_figi', isin: vIsin };
  let price = 0;
  try {
    const data = await tbankHttpPost(
      creds.api_url,
      'tinkoff.public.invest.api.contract.v1.MarketDataService/GetLastPrices',
      creds.token,
      { figi: [figi] }
    );
    price = quotationToNumber(data?.lastPrices?.[0]?.price);
  } catch (_e) {
    price = 0;
  }
  if (price > 0 && price < 200) price = (price / 100.0) * 1000.0;
  if (!(price > 0)) price = 980;
  return {
    isin: vIsin,
    figi,
    lot,
    price,
    ticker: instrument.ticker || vIsin,
    name: instrument.name || null,
  };
}

async function resolveHolding(pool, accountId, holding, channel) {
  let r;
  if (channel === 'node') {
    r = await resolveBondByIsinViaNode(pool, accountId, holding.sec);
  } else {
    const { rows } = await pool.query(
      `SELECT tbank_resolve_bond_by_isin($1, $2) AS r`,
      [accountId, holding.sec]
    );
    r = rows[0]?.r ?? {};
  }
  if (r.error) {
    return {
      ...holding,
      error: r.error,
      figi: null,
      price: bondUnitPriceRub(holding),
      lot: 1,
    };
  }
  return {
    ...holding,
    figi: r.figi,
    ticker: r.ticker || holding.sec,
    name: r.name || null,
    price: Number(r.price) > 0 ? Number(r.price) : bondUnitPriceRub(holding),
    lot: Math.max(1, Number(r.lot) || 1),
    error: null,
  };
}

/**
 * Resolve prices with limited concurrency (T-Bank rate limits).
 */
async function resolveHoldings(pool, accountId, holdings, concurrency = 3, channel = 'node') {
  const out = new Array(holdings.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, holdings.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= holdings.length) return;
      out[i] = await resolveHolding(pool, accountId, holdings[i], channel);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Облигации, уже лежащие на счёте (GetPortfolio), с купоном/номиналом из BondBy.
 * Сортировка «прибыльные первыми» дальше делает computeGreedyBuyLots
 * (купон к цене через bondCurrentYieldPct).
 */
async function loadAccountBondHoldingsViaNode(pool, accountId) {
  const creds = await loadAccountBrokerCreds(pool, accountId);
  const resolved = await resolveTbankAccount(
    creds.api_url,
    creds.token,
    creds.account_code || null
  );
  const portfolio = await tbankHttpPost(
    creds.api_url,
    'tinkoff.public.invest.api.contract.v1.OperationsService/GetPortfolio',
    creds.token,
    { accountId: resolved.account_id }
  );
  const positions = Array.isArray(portfolio?.positions) ? portfolio.positions : [];
  const cashBefore = quotationToNumber(portfolio?.totalAmountCurrencies);

  const bondPos = positions.filter((p) =>
    String(p.instrumentType || p.instrument_type || '')
      .toUpperCase()
      .includes('BOND')
  );

  const holdings = [];
  const skipped = [];
  let next = 0;
  const workers = Array.from(
    { length: Math.min(3, bondPos.length) },
    async () => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= bondPos.length) return;
        const p = bondPos[i];
        const figi = String(p.figi || '').trim();
        try {
          if (!figi) throw new Error('no_figi');

          let inst = null;
          try {
            const d = await tbankHttpPost(
              creds.api_url,
              'tinkoff.public.invest.api.contract.v1.InstrumentsService/BondBy',
              creds.token,
              { idType: 'INSTRUMENT_ID_TYPE_FIGI', id: figi }
            );
            inst = d?.instrument || null;
          } catch (_e) {
            inst = null;
          }

          const lots =
            quotationToNumber(p.quantityLots || p.quantity_lots) ||
            quotationToNumber(p.quantity);
          if (!(lots >= 1)) {
            skipped.push({ sec: p.ticker || figi, error: 'zero_lots' });
            continue;
          }

          // T-Bank отдаёт цену облигаций в % номинала (<200 ⇒ нормализуем к ₽ за штуку).
          const nominal = Math.max(1, Number(quotationToNumber(inst?.nominal)) || 1000);
          let price = quotationToNumber(p.currentPrice);
          if (price > 0 && price < 200) price = (price / 100.0) * nominal;

          const couponAnnualPct = Math.max(0, Number(inst?.couponRate ?? 0));
          const ticker = String(inst?.ticker || p.ticker || figi).toUpperCase();
          const isin = String(inst?.isin || '').toUpperCase();

          holdings.push({
            sec: isin || ticker,
            kind: /^SU/.test(ticker) ? 'ofz' : 'corp',
            weight: 0,
            couponAnnualPct,
            nominal,
            figi,
            ticker,
            name: inst?.name || null,
            lot: Math.max(1, Number(inst?.lot) || 1),
            priceRub: price > 0 ? price : undefined,
          });
        } catch (e) {
          skipped.push({ sec: p.ticker || figi || '?', error: e.message || String(e) });
        }
      }
    }
  );
  await Promise.all(workers);

  return { holdings, skipped, cash_amount: cashBefore };
}

async function planBuyBonds(pool, accountId, opts = {}) {
  const acc = await assertRealTbankAccount(pool, accountId);
  const channel = await getOrderChannel(pool);
  const mode = String(opts.fund_code || 'TBRU').toUpperCase();

  const cashInfo = await getAccountCash(pool, accountId);
  let amount =
    opts.amount_rub != null && opts.amount_rub !== ''
      ? Number(opts.amount_rub)
      : cashInfo.cash_amount;
  if (!Number.isFinite(amount) || amount <= 0) {
    const err = new Error('Укажите сумму покупки > 0 (или пополните свободный кэш)');
    err.status = 400;
    throw err;
  }

  let fundMeta;
  let okHoldings;
  let failed;

  if (mode === 'ACCOUNT') {
    // Режим «Счёт»: докупка облигаций, уже имеющихся на счёте.
    const src = await loadAccountBondHoldingsViaNode(pool, accountId);
    okHoldings = src.holdings;
    failed = src.skipped;
    fundMeta = {
      code: 'ACCOUNT',
      name: 'Счёт брокера',
      asOf: null,
      sources: [],
      source_used: null,
      holdings_live: true,
    };
  } else {
    const fund = await resolveBondFund(mode);
    if (!fund) {
      const err = new Error(`Неизвестный фонд облигаций: ${mode}`);
      err.status = 400;
      throw err;
    }
    fundMeta = {
      code: fund.code,
      name: fund.name,
      asOf: fund.asOf,
      sources: fund.sources || [],
      source_used: fund.source_used || null,
      holdings_live: !!fund.holdings_live,
    };
    const resolved = await resolveHoldings(pool, accountId, fund.holdings, 3, channel);
    okHoldings = resolved.filter((h) => h.figi && !h.error);
    failed = resolved.filter((h) => h.error || !h.figi).map((h) => ({
      sec: h.sec,
      error: h.error || 'no_figi',
    }));
  }

  const pricesBySec = {};
  const lotBySec = {};
  for (const h of okHoldings) {
    pricesBySec[h.sec] =
      Number(h.priceRub) > 0 ? Number(h.priceRub) : h.price;
    lotBySec[h.sec] = Math.max(1, Number(h.lot) || 1);
  }

  const { rows, spent, cashLeft } = computeGreedyBuyLots(
    okHoldings,
    amount,
    pricesBySec,
    lotBySec,
    0
  );

  const bySec = new Map(okHoldings.map((h) => [h.sec, h]));
  for (const row of rows) {
    const h = bySec.get(row.sec);
    if (h) {
      row.figi = h.figi;
      row.ticker = h.ticker;
      row.name = h.name;
      row.lot_size = h.lot;
    }
  }

  return {
    ok: true,
    account_id: acc.id,
    account_name: acc.name,
    fund_code: fundMeta.code,
    fund_name: fundMeta.name,
    fund_as_of: fundMeta.asOf,
    fund_sources: fundMeta.sources,
    fund_source_used: fundMeta.source_used,
    holdings_live: fundMeta.holdings_live,
    cash_amount: cashInfo.cash_amount,
    amount_requested: amount,
    amount_planned: spent,
    cash_left_after_plan: cashLeft,
    buy_count: rows.length,
    buys: rows,
    resolve_failed: failed,
    channel,
    note:
      mode === 'ACCOUNT'
        ? 'Докупка уже имеющихся на счёте облигаций: первыми — с наибольшим «купоном к цене», затем остальные.'
        : 'Покупка лимитными заявками по текущей цене: сначала более доходные (часто корп.), затем ОФЗ.',
  };
}

async function executeBuyBonds(pool, accountId, opts = {}) {
  const plan = await planBuyBonds(pool, accountId, opts);
  const placed = [];
  const errors = [];
  const channel = plan.channel || (await getOrderChannel(pool));
  const creds =
    channel === 'node' ? await loadAccountBrokerCreds(pool, accountId) : null;

  for (const row of plan.buys) {
    if (!row.figi || !row.lots) continue;
    try {
      let order;
      if (channel === 'node') {
        order = await postOrder(pool, {
          api_url: creds.api_url,
          token: creds.token,
          account_code: creds.account_code,
          figi: row.figi,
          quantity: row.lots,
          price: row.unit_price,
          direction: 'BUY',
          order_execution: 'market',
          quantity_is_lots: true,
        });
      } else {
        const { rows } = await pool.query(
          `SELECT tbank_post_order($1, $2, $3, $4, 'BUY', 'market', TRUE) AS r`,
          [accountId, row.figi, row.lots, row.unit_price]
        );
        order = rows[0]?.r ?? null;
      }
      placed.push({
        sec: row.sec,
        ticker: row.ticker,
        figi: row.figi,
        lots: row.lots,
        price: row.unit_price,
        order,
        channel,
      });
    } catch (e) {
      errors.push({
        sec: row.sec,
        ticker: row.ticker,
        figi: row.figi,
        lots: row.lots,
        error: e.message || String(e),
        channel,
      });
    }
  }

  return {
    ...plan,
    executed: true,
    placed_count: placed.length,
    error_count: errors.length,
    placed,
    errors,
    ok: errors.length === 0,
    channel,
  };
}

module.exports = {
  assertRealTbankAccount,
  sellAllPositions,
  closeAllLogicPositions,
  planBuyBonds,
  executeBuyBonds,
  listBondFunds,
  getAccountCash,
  getOrderChannel,
};
