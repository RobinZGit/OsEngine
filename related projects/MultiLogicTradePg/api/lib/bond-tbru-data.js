'use strict';

/**
 * Состав БПИФ «Т-Капитал Облигации» (TBRU), срез porti.ru / MOEX:TBRU.
 * Порт из MultiLogicTradeA (bond-tbru-data.js).
 * sec — ISIN; weight — доля в фонде, %.
 */

const RAW = [
  ['SU26254RMFS1', 7.63], ['SU26252RMFS5', 5.76], ['SU26245RMFS9', 4.31], ['SU26253RMFS3', 3.95],
  ['RU000A10ERE6', 3.88], ['RU000A10DSC0', 3.76], ['RU000A10EYV6', 3.64], ['RU000A10EK06', 3.09],
  ['SU26249RMFS1', 2.98], ['RU000A10EMU3', 2.9], ['RU000A10ES32', 2.67], ['SU26250RMFS9', 2.65],
  ['RU000A10EYH5', 2.52], ['RU000A10ASC6', 2.24], ['RU000A103QN7', 2.21], ['RU000A10EW51', 2.19],
  ['RU000A10EYJ1', 2.07], ['RU000A10B1Q6', 2.07], ['RU000A1034P7', 2.01], ['RU000A10CCN3', 1.91],
  ['RU000A10EYY0', 1.81], ['RU000A10CU48', 1.76], ['RU000A10EA40', 1.73], ['RU000A10C5L7', 1.51],
  ['RU000A10B3S8', 1.44], ['RU000A10EJQ7', 1.39], ['SU26246RMFS7', 1.32], ['RU000A10DZU7', 1.29],
  ['RU000A10C8S6', 1.2], ['RU000A10DHT7', 1.1], ['RU000A108GN7', 1.08], ['RU000A10EEZ9', 0.96],
  ['RU000A10DWQ2', 0.95], ['RU000A10B0J3', 0.93], ['RU000A10ENP1', 0.87], ['RU000A10DXE6', 0.84],
  ['RU000A10EST2', 0.79], ['RU000A10EC22', 0.7], ['RU000A10DNX7', 0.67], ['RU000A10E4Y1', 0.66],
  ['RU000A10C3F4', 0.66], ['SU26218RMFS6', 0.64], ['RU000A10CMQ5', 0.61], ['RU000A10DSD8', 0.61],
  ['RU000A10CKY3', 0.56], ['RU000A106EZ0', 0.55], ['RU000A109PP1', 0.54], ['RU000A109VK0', 0.51],
  ['RU000A10EG44', 0.47], ['RU000A10E655', 0.45], ['RU000A108KU4', 0.38], ['RU000A106P63', 0.35],
  ['RU000A109SP5', 0.33], ['RU000A10DTG9', 0.3], ['RU000A10B8M0', 0.3], ['RU000A10B3Y6', 0.28],
  ['RU000A10E291', 0.23], ['RU000A106Z38', 0.23], ['RU000A10B4A4', 0.22], ['RU000A109981', 0.22],
  ['RU000A1098F3', 0.2], ['RU000A106SF2', 0.18], ['RU000A10A6J1', 0.15], ['RU000A10C5T0', 0.15],
  ['RU000A10C6F7', 0.15], ['RU000A10EML2', 0.15], ['RU000A10DSL1', 0.14],
];

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

const HOLDINGS = RAW.map(([sec, weight]) => enrichHolding(sec, weight));

const BOND_FUNDS = [
  {
    code: 'TBRU',
    name: 'Т-Капитал Облигации (TBRU)',
    source: 'https://porti.ru/etf/holders/MOEX:TBRU',
    asOf: '2026-06-18',
    holdings: HOLDINGS,
  },
];

function listBondFunds() {
  return BOND_FUNDS.map(({ code, name, source, asOf, holdings }) => ({
    code,
    name,
    source,
    asOf,
    holdings_count: holdings.length,
  }));
}

function getBondFund(code) {
  const u = String(code || 'TBRU').trim().toUpperCase();
  return BOND_FUNDS.find((f) => f.code === u) || null;
}

module.exports = {
  listBondFunds,
  getBondFund,
  HOLDINGS,
};
