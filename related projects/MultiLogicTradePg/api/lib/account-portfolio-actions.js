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

async function planBuyBonds(pool, accountId, opts = {}) {
  const acc = await assertRealTbankAccount(pool, accountId);
  const channel = await getOrderChannel(pool);
  const fundCode = String(opts.fund_code || 'TBRU').toUpperCase();
  const fund = await resolveBondFund(fundCode);
  if (!fund) {
    const err = new Error(`Неизвестный фонд облигаций: ${fundCode}`);
    err.status = 400;
    throw err;
  }

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

  const resolved = await resolveHoldings(pool, accountId, fund.holdings, 3, channel);
  const okHoldings = resolved.filter((h) => h.figi && !h.error);
  const failed = resolved.filter((h) => h.error || !h.figi).map((h) => ({
    sec: h.sec,
    error: h.error || 'no_figi',
  }));

  const pricesBySec = {};
  const lotBySec = {};
  for (const h of okHoldings) {
    pricesBySec[h.sec] = h.price;
    lotBySec[h.sec] = h.lot;
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
    fund_code: fund.code,
    fund_name: fund.name,
    fund_as_of: fund.asOf,
    fund_sources: fund.sources || [],
    fund_source_used: fund.source_used || null,
    holdings_live: !!fund.holdings_live,
    cash_amount: cashInfo.cash_amount,
    amount_requested: amount,
    amount_planned: spent,
    cash_left_after_plan: cashLeft,
    buy_count: rows.length,
    buys: rows,
    resolve_failed: failed,
    channel,
    note:
      'Покупка лимитными заявками по текущей цене: сначала более доходные (часто корп.), затем ОФЗ.',
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
  planBuyBonds,
  executeBuyBonds,
  listBondFunds,
  getAccountCash,
  getOrderChannel,
};
