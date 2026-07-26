'use strict';

const { listBondFunds, getBondFund } = require('./bond-tbru-data');
const { computeGreedyBuyLots, bondUnitPriceRub } = require('./bond-tbru-alloc');

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

async function sellAllPositions(pool, accountId) {
  await assertRealTbankAccount(pool, accountId);
  const { rows } = await pool.query(
    `SELECT account_sell_all_at_market($1) AS r`,
    [accountId]
  );
  return rows[0]?.r ?? { ok: false, error: 'empty_result' };
}

async function getAccountCash(pool, accountId) {
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

async function resolveHolding(pool, accountId, holding) {
  const { rows } = await pool.query(
    `SELECT tbank_resolve_bond_by_isin($1, $2) AS r`,
    [accountId, holding.sec]
  );
  const r = rows[0]?.r ?? {};
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
async function resolveHoldings(pool, accountId, holdings, concurrency = 3) {
  const out = new Array(holdings.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, holdings.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= holdings.length) return;
      out[i] = await resolveHolding(pool, accountId, holdings[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

async function planBuyBonds(pool, accountId, opts = {}) {
  const acc = await assertRealTbankAccount(pool, accountId);
  const fundCode = String(opts.fund_code || 'TBRU').toUpperCase();
  const fund = getBondFund(fundCode);
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
  // Не режем сумму до кэша: пользователь может править поле; брокер отклонит лишнее — в отчёт.

  const resolved = await resolveHoldings(pool, accountId, fund.holdings, 3);
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

  // attach figi/name from resolved
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
    cash_amount: cashInfo.cash_amount,
    amount_requested: amount,
    amount_planned: spent,
    cash_left_after_plan: cashLeft,
    buy_count: rows.length,
    buys: rows,
    resolve_failed: failed,
    note:
      'Покупка лимитными заявками по текущей цене: сначала более доходные (часто корп.), затем ОФЗ.',
  };
}

async function executeBuyBonds(pool, accountId, opts = {}) {
  const plan = await planBuyBonds(pool, accountId, opts);
  const placed = [];
  const errors = [];

  for (const row of plan.buys) {
    if (!row.figi || !row.lots) continue;
    try {
      const { rows } = await pool.query(
        `SELECT tbank_post_order($1, $2, $3, $4, 'BUY') AS r`,
        [accountId, row.figi, row.lots, row.unit_price]
      );
      placed.push({
        sec: row.sec,
        ticker: row.ticker,
        figi: row.figi,
        lots: row.lots,
        price: row.unit_price,
        order: rows[0]?.r ?? null,
      });
    } catch (e) {
      errors.push({
        sec: row.sec,
        ticker: row.ticker,
        figi: row.figi,
        lots: row.lots,
        error: e.message || String(e),
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
  };
}

module.exports = {
  assertRealTbankAccount,
  sellAllPositions,
  planBuyBonds,
  executeBuyBonds,
  listBondFunds,
  getAccountCash,
};

