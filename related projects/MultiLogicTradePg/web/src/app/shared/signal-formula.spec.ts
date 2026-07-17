import {
  buildLogicSignalFormula,
  parseSignalFormula,
  signalKindLabel,
} from './signal-formula';

describe('signal-formula', () => {
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
