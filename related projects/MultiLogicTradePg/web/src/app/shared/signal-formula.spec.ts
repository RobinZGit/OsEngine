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
