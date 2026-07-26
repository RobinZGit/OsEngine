'use strict';

/**
 * Живой состав индекса с MOEX ISS (альтернатива porti.ru / страницам УК).
 * analytics: indexid, tradedate, ticker, shortnames, secids, weight, …
 */

const https = require('https');
const { getBondFund } = require('./bond-tbru-data');

const MOEX_TIMEOUT_MS = 8000;

function ofzCoupon(sec) {
  return String(sec || '').startsWith('SU') ? 11 : 16;
}

function enrichHolding(sec, weight) {
  return {
    sec: String(sec).toUpperCase(),
    weight: Number(weight) || 0,
    nominal: 1000,
    pricePct: 98,
    couponAnnualPct: ofzCoupon(sec),
    couponsPerYear: 2,
    kind: String(sec).startsWith('SU') ? 'ofz' : 'corp',
  };
}

function fetchJson(url, timeoutMs = MOEX_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

/**
 * @param {string} indexId e.g. RGBITR, RUCBTRNS
 * @returns {Promise<{ asOf: string|null, holdings: object[] }>}
 */
async function fetchMoexIndexHoldings(indexId) {
  const id = String(indexId || '').trim().toUpperCase();
  if (!id) throw new Error('empty index');
  const url =
    'https://iss.moex.com/iss/statistics/engines/stock/markets/index/analytics/' +
    encodeURIComponent(id) +
    '.json?iss.meta=off&limit=500';
  const json = await fetchJson(url);
  const rows = (json.analytics && json.analytics.data) || [];
  if (!rows.length) throw new Error('empty analytics');
  const asOf = rows[0][1] ? String(rows[0][1]).slice(0, 10) : null;
  const holdings = rows
    .map((r) => enrichHolding(r[2], r[5]))
    .filter((h) => h.sec && h.weight > 0)
    .sort((a, b) => b.weight - a.weight);
  if (!holdings.length) throw new Error('no holdings');
  return { asOf, holdings, source: url };
}

/**
 * Фонд со статическим составом; при moexIndex — попытка обновить с MOEX.
 * @returns {Promise<object>} fund clone with holdings/asOf/source_used
 */
async function resolveBondFund(code) {
  const base = getBondFund(code);
  if (!base) return null;
  const fund = {
    ...base,
    holdings: base.holdings.slice(),
    sources: (base.sources || []).slice(),
    source_used: (base.sources && base.sources[0]) || null,
    holdings_live: false,
  };
  if (!base.moexIndex) return fund;
  try {
    const live = await fetchMoexIndexHoldings(base.moexIndex);
    fund.holdings = live.holdings;
    if (live.asOf) fund.asOf = live.asOf;
    fund.source_used = live.source;
    fund.holdings_live = true;
  } catch (_e) {
    // оставляем статический снимок
    fund.holdings_live = false;
  }
  return fund;
}

module.exports = {
  fetchMoexIndexHoldings,
  resolveBondFund,
};
