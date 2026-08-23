'use strict';

/**
 * Жадная аллокация TBRU: покупка от более доходных (корп обычно выше ОФЗ) к менее.
 * Порт логики из MultiLogicTradeA bond-tbru-procedure.js (computeTbruGreedyTargets).
 */

function bondUnitPriceRub(holding, priceRub) {
  if (Number.isFinite(priceRub) && priceRub > 0) return priceRub;
  const nom = Math.max(1, +holding?.nominal || 1000);
  const pct = Math.max(1, +holding?.pricePct || 100);
  return (nom * pct) / 100;
}

/** Текущая доходность, % годовых: годовой купон / чистая цена. */
function bondCurrentYieldPct(holding, priceRub) {
  const cpn = Math.max(0, +holding?.couponAnnualPct || 0);
  const clean = bondUnitPriceRub(holding, priceRub);
  const nom = Math.max(1, +holding?.nominal || 1000);
  if (clean <= 0) return cpn;
  return ((nom * cpn) / 100 / clean) * 100;
}

function normalizedWeights(holdings) {
  const list = holdings || [];
  const sum = list.reduce((s, h) => s + Math.max(0, +h.weight || 0), 0);
  // Нет весов (например, режим «Счёт») — равные доли, сортировка только по доходности.
  if (sum <= 0) {
    return list.map((h) => ({ ...h, normWeight: 1 / Math.max(1, list.length) }));
  }
  return list.map((h) => ({
    ...h,
    normWeight: Math.max(0, +h.weight || 0) / sum,
  }));
}

function sortHoldingsByYield(holdings, pricesBySec) {
  return normalizedWeights(holdings).sort((a, b) => {
    const ya = bondCurrentYieldPct(a, pricesBySec?.[a.sec]);
    const yb = bondCurrentYieldPct(b, pricesBySec?.[b.sec]);
    if (Math.abs(yb - ya) > 1e-9) return yb - ya;
    return b.normWeight - a.normWeight;
  });
}

/**
 * Round-robin +1 лот от более доходных, пока хватает cash.
 * @returns {{ rows: object[], spent: number, cashLeft: number, sorted: object[] }}
 */
function computeGreedyBuyLots(holdings, cashRub, pricesBySec, lotBySec, commissionPct = 0) {
  const sorted = sortHoldingsByYield(holdings, pricesBySec);
  const lots = {};
  let cash = Math.max(0, +cashRub || 0);
  const comm = Math.max(0, +commissionPct || 0) / 100;
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const h of sorted) {
      const unit = pricesBySec[h.sec] || bondUnitPriceRub(h);
      const lot = Math.max(1, Math.trunc(+lotBySec?.[h.sec] || 1));
      const cost = unit * lot;
      const fee = cost * comm;
      if (cash < cost + fee - 1e-6) continue;
      lots[h.sec] = (lots[h.sec] || 0) + lot;
      cash -= cost + fee;
      progressed = true;
    }
  }
  const spent = Math.max(0, (+cashRub || 0) - cash);
  const rows = sorted
    .map((h) => {
      const buyLots = lots[h.sec] || 0;
      const unit = pricesBySec[h.sec] || bondUnitPriceRub(h);
      return {
        sec: h.sec,
        kind: h.kind,
        weight: h.weight,
        yield_pct: Math.round(bondCurrentYieldPct(h, unit) * 100) / 100,
        unit_price: unit,
        lots: buyLots,
        amount_rub: Math.round(buyLots * unit * 100) / 100,
        figi: h.figi || null,
        ticker: h.ticker || h.sec,
        name: h.name || null,
      };
    })
    .filter((r) => r.lots > 0);
  return { rows, spent, cashLeft: cash, sorted };
}

module.exports = {
  bondUnitPriceRub,
  bondCurrentYieldPct,
  sortHoldingsByYield,
  computeGreedyBuyLots,
};
