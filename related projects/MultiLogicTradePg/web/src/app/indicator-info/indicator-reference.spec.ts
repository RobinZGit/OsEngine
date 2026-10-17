import { getIndicatorReference, INDICATOR_REFERENCES } from './indicator-reference';

const INDICATOR_CODES = [
  'ADX', 'AROON', 'ATR', 'BB', 'CCI', 'CMO', 'DMI', 'DONCHIAN', 'EMA', 'HMA',
  'ICHIMOKU', 'KDJ', 'KELTNER', 'LINREG', 'MACD', 'MFI', 'OBV', 'PACC', 'PSAR',
  'ROC', 'RSI', 'RVI', 'SAR', 'SMA', 'SMAT3', 'SQUARE', 'STOCH', 'TRIX', 'TSI',
  'UO', 'VWAP', 'WILLR', 'WMA', 'ZLEMA',
];

describe('indicator-reference', () => {
  it('has a reference for every known indicator code', () => {
    for (const code of INDICATOR_CODES) {
      expect(getIndicatorReference(code))
        .withContext(`missing reference for ${code}`)
        .toBeDefined();
    }
  });

  it('lookup is case-insensitive and null-safe', () => {
    expect(getIndicatorReference('rsi')).toBe(INDICATOR_REFERENCES['RSI']);
    expect(getIndicatorReference(null)).toBeUndefined();
    expect(getIndicatorReference(undefined)).toBeUndefined();
    expect(getIndicatorReference('NOPE')).toBeUndefined();
  });

  it('every entry has non-empty core fields', () => {
    for (const code of INDICATOR_CODES) {
      const ref = INDICATOR_REFERENCES[code];
      expect(ref.summary.trim().length).withContext(`${code}.summary`).toBeGreaterThan(0);
      expect(ref.formula.trim().length).withContext(`${code}.formula`).toBeGreaterThan(0);
      expect(ref.calculation.trim().length).withContext(`${code}.calculation`).toBeGreaterThan(0);
      expect(ref.interpretation.trim().length).withContext(`${code}.interpretation`).toBeGreaterThan(0);
    }
  });
});
