import {
  applyStrictnessToFormula,
  formulaParamValues,
  IndicatorParamBound,
} from './signal-strictness';

describe('signal-strictness (#1030)', () => {
  const sma: IndicatorParamBound[] = [
    { indicator_code: 'SMA', param_key: 'period', strict_value: 100, loose_value: 5, is_integer: true },
  ];
  const bb: IndicatorParamBound[] = [
    { indicator_code: 'BB', param_key: 'period', strict_value: 50, loose_value: 10, is_integer: true },
    { indicator_code: 'BB', param_key: 'std_dev', strict_value: 3, loose_value: 1, is_integer: false },
  ];

  it('parses numeric params', () => {
    expect(formulaParamValues('@SMA(period=20,series=VALUE) pp > VALUE')).toEqual({ period: 20 });
    expect(
      formulaParamValues('@BB(period=21,std_dev=2.5,series=UPPER) pp >= VALUE')
    ).toEqual({ period: 21, std_dev: 2.5 });
  });

  it('middle keeps the current values', () => {
    const f = '@SMA(period=20,series=VALUE) pp > VALUE';
    expect(applyStrictnessToFormula(f, sma, formulaParamValues(f), 50, 'SMA')).toBe(f);
  });

  it('strict end uses strict bound, loose end uses loose bound', () => {
    const f = '@SMA(period=20,series=VALUE) pp > VALUE';
    expect(applyStrictnessToFormula(f, sma, formulaParamValues(f), 0, 'SMA')).toContain('period=100');
    expect(applyStrictnessToFormula(f, sma, formulaParamValues(f), 100, 'SMA')).toContain('period=5');
  });

  it('interpolates proportionally and rounds integers', () => {
    const f = '@SMA(period=20,series=VALUE)';
    // 25% → 100 + (20-100)*0.5 = 60
    expect(applyStrictnessToFormula(f, sma, { period: 20 }, 25, 'SMA')).toContain('period=60');
    // 75% → 20 + (5-20)*0.5 = 12.5 → 13
    expect(applyStrictnessToFormula(f, sma, { period: 20 }, 75, 'SMA')).toContain('period=13');
  });

  it('changes all bounded params of the indicator, floats keep 2 digits', () => {
    const f = '@BB(period=21,std_dev=2,series=UPPER) pp >= VALUE';
    const out = applyStrictnessToFormula(f, bb, formulaParamValues(f), 0, 'BB');
    expect(out).toContain('period=50');
    expect(out).toContain('std_dev=3');
    const mid = applyStrictnessToFormula(f, bb, formulaParamValues(f), 75, 'BB');
    expect(mid).toContain('period=16');
    expect(mid).toContain('std_dev=1.5');
  });

  it('does not touch params without bounds or other formula text', () => {
    const f = '@SMA(tf=H2,period=20,series=VALUE) pp > VALUE AND @ROC(period=10) VALUE > 0';
    const out = applyStrictnessToFormula(f, sma, formulaParamValues(f), 0, 'SMA');
    expect(out).toContain('tf=H2');
    expect(out).toContain('@ROC(period=10)');
    expect(out).toContain('period=100,series=VALUE');
  });

  it('clamps position to 0..100', () => {
    const f = '@SMA(period=20,series=VALUE)';
    expect(applyStrictnessToFormula(f, sma, { period: 20 }, -50, 'SMA')).toContain('period=100');
    expect(applyStrictnessToFormula(f, sma, { period: 20 }, 500, 'SMA')).toContain('period=5');
  });
});
