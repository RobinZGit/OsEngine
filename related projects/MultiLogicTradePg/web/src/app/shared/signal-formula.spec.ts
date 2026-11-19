import {
  applySignalTf,
  buildLogicSignalFormula,
  extractSignalTf,
  parseSignalFormula,
  signalKindLabel,
} from './signal-formula';

describe('signal-formula', () => {
  it('extractSignalTf reads tf= base and multiplier', () => {
    expect(extractSignalTf('@SMA(tf=M1*7,period=50) VALUE > 0')).toEqual({
      base: 'M1',
      mult: 7,
    });
    expect(extractSignalTf('@SMA(tf=H1,period=50) VALUE > 0')).toEqual({
      base: 'H1',
      mult: null,
    });
    expect(extractSignalTf('@SMA(period=20) pp > VALUE')).toEqual({
      base: '',
      mult: null,
    });
  });

  it('applySignalTf inserts/replaces/removes tf=', () => {
    expect(applySignalTf('@SMA(period=20) pp > VALUE', 'M1', 7)).toBe(
      '@SMA(period=20, tf=M1*7) pp > VALUE'
    );
    expect(applySignalTf('@SMA(tf=M5,period=20,OPT(std_dev,10)) pp > VALUE', 'H1', null)).toBe(
      '@SMA(period=20, OPT(std_dev,10), tf=H1) pp > VALUE'
    );
    expect(applySignalTf('@SMA(tf=M15,period=20) pp > VALUE', '', null)).toBe(
      '@SMA(period=20) pp > VALUE'
    );
  });

  it('buildLogicSignalFormula uses indicator defaults', () => {
    const f = buildLogicSignalFormula(
      {
        code: 'RSI',
        sig_trend_def: 'VALUE > 50',
        sig_ct_def: 'VALUE < 30',
      },
      'trend'
    );
    expect(f).toContain('@RSI(');
    expect(f).toContain('VALUE > 50');
  });

  it('channel signal puts the band into series= and compares price with VALUE', () => {
    const valueTypes = [
      { id: 1, code: 'UPPER', name: 'Upper', value_type: 'float', is_threshold: false, threshold_value: null, display_order: 1 },
      { id: 2, code: 'MIDDLE', name: 'Middle', value_type: 'float', is_threshold: false, threshold_value: null, display_order: 2 },
      { id: 3, code: 'LOWER', name: 'Lower', value_type: 'float', is_threshold: false, threshold_value: null, display_order: 3 },
    ];
    for (const code of ['DONCHIAN', 'BB', 'KELTNER']) {
      const ind = {
        code,
        sig_trend_def: 'pp > UPPER',
        sig_ct_def: 'pp < LOWER',
        value_types: valueTypes,
      };
      expect(buildLogicSignalFormula(ind, 'trend')).toContain('series=UPPER) pp > VALUE');
      expect(buildLogicSignalFormula(ind, 'counter')).toContain('series=LOWER) pp < VALUE');
    }
  });

  it('normalizes multi-series definitions like STOCH K > D', () => {
    const ind = {
      code: 'STOCH',
      sig_trend_def: 'K > D',
      sig_ct_def: 'K < 20',
      value_types: [
        { id: 1, code: 'K', name: 'K', value_type: 'float', is_threshold: false, threshold_value: null, display_order: 1 },
        { id: 2, code: 'D', name: 'D', value_type: 'float', is_threshold: false, threshold_value: null, display_order: 2 },
      ],
    };
    expect(buildLogicSignalFormula(ind, 'trend')).toBe(
      '@STOCH(k=14,d=3,smooth=3,series=K) VALUE > 50'
    );
    expect(buildLogicSignalFormula(ind, 'counter')).toBe(
      '@STOCH(k=14,d=3,smooth=3,series=K) VALUE < 20'
    );
  });

  it('keeps explicit series for LINREG and falls back for unknown tokens', () => {
    const linreg = {
      code: 'LINREG',
      sig_trend_def: 'pp > VALUE',
      sig_ct_def: 'pp < VALUE',
      value_types: [],
    };
    expect(buildLogicSignalFormula(linreg, 'trend')).toBe(
      '@LINREG(period=20,std_dev=2,series=MIDDLE) pp > VALUE'
    );
    const aroon = {
      code: 'AROON',
      sig_trend_def: 'UP > DOWN',
      sig_ct_def: 'DOWN > UP',
      value_types: [],
    };
    expect(buildLogicSignalFormula(aroon, 'trend')).toContain('VALUE > 50');
    expect(buildLogicSignalFormula(aroon, 'counter')).toContain('VALUE < 50');
  });

  it('parseSignalFormula splits ref and condition', () => {
    const p = parseSignalFormula(
      '@SMA(period=20,series=VALUE) pp > VALUE'
    );
    expect(p.valid).toBeTrue();
    expect(p.indicatorCode).toBe('SMA');
    expect(p.params).toContain('period=20');
    expect(p.condition).toBe('pp > VALUE');
  });

  it('parseSignalFormula rejects invalid format', () => {
    const p = parseSignalFormula('VALUE > 50');
    expect(p.valid).toBeFalse();
    expect(p.errors.length).toBeGreaterThan(0);
  });

  it('signalKindLabel', () => {
    expect(signalKindLabel('trend')).toBe('По течению');
    expect(signalKindLabel('counter')).toBe('Против');
  });
});
