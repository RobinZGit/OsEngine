'use strict';

/**
 * Каталог фондов облигаций для «Купить облигации».
 * Покупка отдельных выпусков (ISIN) по составу БПИФ / индекса — не паёв ETF.
 *
 * Источники срезов:
 * - TBRU: porti.ru / rusetfs (статический снимок)
 * - SBGB: индекс RGBITR (MOEX ISS) + зеркала porti/cbonds/rusetfs
 * - OBLG (ex VTBB): индекс RUCBTRNS (MOEX ISS) + зеркала
 *
 * При plan/buy: если у фонда задан moexIndex — пробуем обновить состав с MOEX ISS,
 * при недоступности — статический снимок ниже.
 */

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

function holdingsFromRaw(raw) {
  return raw.map(([sec, weight]) => enrichHolding(sec, weight));
}

const TBRU_RAW = [
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

const SBGB_RAW = [
  ['SU26246RMFS7', 6.5], ['SU26245RMFS9', 6.26], ['SU26247RMFS5', 5.88], ['SU26248RMFS3', 5.85],
  ['SU26244RMFS2', 5.49], ['SU26249RMFS1', 4.77], ['SU26241RMFS8', 4.09], ['SU26254RMFS1', 4.09],
  ['SU26252RMFS5', 3.79], ['SU26243RMFS4', 3.7], ['SU26250RMFS9', 3.6], ['SU26242RMFS6', 3.23],
  ['SU26238RMFS4', 3.13], ['SU26235RMFS0', 3], ['SU26236RMFS8', 2.9], ['SU26239RMFS2', 2.84],
  ['SU26228RMFS5', 2.83], ['SU26232RMFS7', 2.77], ['SU26218RMFS6', 2.73], ['SU26224RMFS4', 2.52],
  ['SU26251RMFS7', 2.52], ['SU26253RMFS3', 2.5], ['SU26233RMFS5', 2.4], ['SU26237RMFS6', 2.4],
  ['SU26240RMFS0', 2.22], ['SU26212RMFS9', 2.11], ['SU26225RMFS1', 2.09], ['SU26221RMFS0', 1.94],
  ['SU26230RMFS1', 1.84],
];

const OBLG_RAW = [
  ['RU000A10DS74', 3.86], ['RU000A10C6L5', 2.98], ['RU000A10BK17', 2.89], ['RU000A10C618', 2.89],
  ['RU000A10EF52', 2.72], ['RU000A10ER66', 2.65], ['RU000A10CKZ0', 2.24], ['RU000A10EJQ7', 1.92],
  ['RU000A10CC24', 1.89], ['RU000A104Z48', 1.82], ['RU000A10BFG2', 1.63], ['RU000A106AT1', 1.62],
  ['RU000A10C8T4', 1.52], ['RU000A10ETQ6', 1.52], ['RU000A104B46', 1.18], ['RU000A0ZYLG5', 1.17],
  ['RU000A104XR2', 1.17], ['RU000A10D3C0', 1.17], ['RU000A10CT33', 1.16], ['RU000A10DYC8', 1.16],
  ['RU000A10EMU3', 1.13], ['RU000A109KC0', 0.99], ['RU000A10DPS2', 0.97], ['RU000A10DYG9', 0.97],
  ['RU000A10CMT9', 0.95], ['RU000A10CP78', 0.95], ['RU000A10DSL1', 0.89], ['RU000A105GW4', 0.82],
  ['RU000A105TY3', 0.8], ['RU000A10AHA3', 0.79], ['RU000A10B115', 0.79], ['RU000A102DB2', 0.78],
  ['RU000A10C6F7', 0.76], ['RU000A10CMD3', 0.76], ['RU000A10DYP0', 0.76], ['RU000A10EBE0', 0.76],
  ['RU000A105VC5', 0.75], ['RU000A10BTA6', 0.75], ['RU000A0ZYVU5', 0.74], ['RU000A1055Y4', 0.72],
  ['RU000A10C8C0', 0.72], ['RU000A10EA40', 0.65], ['RU000A10EN11', 0.63], ['RU000A1017J5', 0.61],
  ['RU000A10BQB0', 0.61], ['RU000A10ASC6', 0.6], ['RU000A10AZ60', 0.6], ['RU000A0ZZZ17', 0.59],
  ['RU000A100881', 0.59], ['RU000A10BNF8', 0.59], ['RU000A10BSL5', 0.59], ['RU000A10BUK3', 0.58],
  ['RU000A10E6V2', 0.58], ['RU000A10E739', 0.58], ['RU000A10ES32', 0.58], ['RU000A0ZYWU3', 0.57],
  ['RU000A102GJ8', 0.57], ['RU000A10B495', 0.57], ['RU000A10BGF2', 0.57], ['RU000A10BW96', 0.57],
  ['RU000A10EAS2', 0.57], ['RU000A10EN60', 0.57], ['RU000A10ESM7', 0.57], ['RU000A10ETL7', 0.57],
  ['RU000A106P06', 0.56], ['RU000A10AZ45', 0.56], ['RU000A105KR6', 0.55], ['RU000A101QN1', 0.54],
  ['RU000A101TB0', 0.54], ['RU000A10C8S6', 0.53], ['RU000A10CDZ5', 0.53], ['RU000A10CL07', 0.53],
  ['RU000A105XE7', 0.5], ['RU000A10C5L7', 0.49], ['RU000A105WP5', 0.48], ['RU000A10CWF7', 0.46],
  ['RU000A10AS85', 0.45], ['RU000A10DZW3', 0.45], ['RU000A10B0E4', 0.44], ['RU000A0ZYWB3', 0.43],
  ['RU000A10BL99', 0.43], ['RU000A101ZH4', 0.42], ['RU000A10A3Z4', 0.42], ['RU000A10BBE6', 0.42],
  ['RU000A10BZH8', 0.42], ['RU000A10C5Y0', 0.42], ['RU000A101Z74', 0.41], ['RU000A0JTU85', 0.4],
  ['RU000A1013U1', 0.4], ['RU000A104WF9', 0.4], ['RU000A105M91', 0.4], ['RU000A10AUE8', 0.4],
  ['RU000A10BWC6', 0.4], ['RU000A105VU7', 0.39], ['RU000A10B933', 0.39], ['RU000A10C6P6', 0.39],
  ['RU000A0JXPG2', 0.38], ['RU000A103DS4', 0.38], ['RU000A1082Y8', 0.38], ['RU000A109X37', 0.38],
  ['RU000A0ZYR91', 0.37], ['RU000A10CC32', 0.37], ['RU000A10DA74', 0.37], ['RU000A104V75', 0.36],
  ['RU000A100N12', 0.35], ['RU000A1031U3', 0.35], ['RU000A10EJZ8', 0.35], ['RU000A102QP4', 0.34],
  ['RU000A104W33', 0.34], ['RU000A10EA16', 0.34], ['RU000A1007Z2', 0.33], ['RU000A10DCF7', 0.33],
  ['RU000A10ERE6', 0.32], ['RU000A105X80', 0.31], ['RU000A10DJH8', 0.3], ['RU000A0JXN05', 0.29],
  ['RU000A0JXR84', 0.29], ['RU000A0JXZB2', 0.29], ['RU000A0ZZ4P9', 0.29], ['RU000A109LG9', 0.29],
  ['RU000A10C8F3', 0.29], ['RU000A0JUAH8', 0.28], ['RU000A0JXQ44', 0.28], ['RU000A103C53', 0.27],
  ['RU000A10CSQ2', 0.27], ['RU000A10EEZ9', 0.27], ['RU000A10EMG2', 0.27], ['RU000A10EQ34', 0.27],
  ['RU000A10EA08', 0.26], ['RU000A10CBA2', 0.25], ['RU000A10EAC6', 0.25], ['RU000A0JWHU2', 0.23],
  ['RU000A101CL5', 0.23], ['RU000A10CU89', 0.23], ['RU000A10D9K0', 0.23], ['RU000A10DHT7', 0.21],
  ['RU000A10DTF1', 0.21], ['RU000A10EE87', 0.21], ['RU000A10EK06', 0.21], ['RU000A0ZZ9R4', 0.19],
  ['RU000A10BZJ4', 0.19], ['RU000A10CKY3', 0.19], ['RU000A10DTS4', 0.19], ['RU000A10E7G1', 0.19],
  ['RU000A101SC0', 0.18], ['RU000A102FS1', 0.18], ['RU000A10E6U4', 0.18], ['RU000A1008D7', 0.17],
  ['RU000A1009Z8', 0.17], ['RU000A10EML2', 0.17], ['RU000A101SD8', 0.16], ['RU000A102BK7', 0.16],
  ['RU000A10EH76', 0.13],
];

const BOND_FUNDS = [
  {
    code: 'TBRU',
    name: 'Т-Капитал Облигации (TBRU)',
    asOf: '2026-06-18',
    moexIndex: null,
    sources: [
      'https://porti.ru/etf/holders/MOEX:TBRU',
      'https://rusetfs.com/etf/RU000A1039N1',
      'https://www.moex.com/ru/issue.aspx?board=TQTF&code=TBRU',
    ],
    holdings: holdingsFromRaw(TBRU_RAW),
  },
  {
    code: 'SBGB',
    name: 'Первая — Гос. облигации (SBGB)',
    asOf: '2026-07-24',
    moexIndex: 'RGBITR',
    sources: [
      'https://iss.moex.com/iss/statistics/engines/stock/markets/index/analytics/RGBITR.json',
      'https://porti.ru/etf/holders/MOEX:SBGB',
      'https://cbonds.ru/etf/208991/',
      'https://rusetfs.com/etf/RU000A1000F9',
    ],
    holdings: holdingsFromRaw(SBGB_RAW),
  },
  {
    code: 'OBLG',
    name: 'ВИМ — Российские облигации (OBLG, ex VTBB)',
    asOf: '2026-07-24',
    moexIndex: 'RUCBTRNS',
    aliases: ['VTBB'],
    sources: [
      'https://iss.moex.com/iss/statistics/engines/stock/markets/index/analytics/RUCBTRNS.json',
      'https://porti.ru/etf/holders/MOEX:OBLG',
      'https://porti.ru/etf/ticker/MOEX:VTBB',
      'https://cbonds.ru/etf/208999/',
      'https://rusetfs.com/etf/RU000A1002S8',
    ],
    holdings: holdingsFromRaw(OBLG_RAW),
  },
];

function listBondFunds() {
  return BOND_FUNDS.map(({ code, name, sources, asOf, holdings, moexIndex }) => ({
    code,
    name,
    source: sources && sources[0] ? sources[0] : null,
    sources: sources || [],
    asOf,
    moex_index: moexIndex || null,
    holdings_count: holdings.length,
  }));
}

function getBondFund(code) {
  const u = String(code || 'TBRU').trim().toUpperCase();
  return (
    BOND_FUNDS.find((f) => f.code === u) ||
    BOND_FUNDS.find((f) => (f.aliases || []).includes(u)) ||
    null
  );
}

module.exports = {
  listBondFunds,
  getBondFund,
  BOND_FUNDS,
  /** @deprecated use getBondFund('TBRU').holdings */
  HOLDINGS: holdingsFromRaw(TBRU_RAW),
};
