import {
  applyStrictnessToFormula,
  formulaParamValues,
  IndicatorParamBound,
  strictnessPositionFromFormula,
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

  it('strict end uses strict bound, loose end uses loose bound', () => {
    const f = '@SMA(period=20,series=VALUE) pp > VALUE';
    expect(applyStrictnessToFormula(f, sma, 0, 'SMA')).toContain('period=100');
    expect(applyStrictnessToFormula(f, sma, 100, 'SMA')).toContain('period=5');
  });

  it('middle is the middle of the range and rounds integers', () => {
    const f = '@SMA(period=20,series=VALUE)';
    // 100 + (5-100)*0.5 = 52.5 → 53
    expect(applyStrictnessToFormula(f, sma, 50, 'SMA')).toContain('period=53');
  });

  it('changes all bounded params of the indicator, floats keep 2 digits', () => {
    const f = '@BB(period=21,std_dev=2,series=UPPER) pp >= VALUE';
    const strict = applyStrictnessToFormula(f, bb, 0, 'BB');
    expect(strict).toContain('period=50');
    expect(strict).toContain('std_dev=3');
    const p75 = applyStrictnessToFormula(f, bb, 75, 'BB');
    expect(p75).toContain('period=20');
    expect(p75).toContain('std_dev=1.5');
  });

  it('does not touch params of other indicators in the same formula', () => {
    const f = '@SMA(tf=H2,period=20,series=VALUE) pp > VALUE AND @ROC(period=10) VALUE > 0';
    const out = applyStrictnessToFormula(f, sma, 0, 'SMA');
    expect(out).toContain('tf=H2');
    expect(out).toContain('@ROC(period=10)');
    expect(out).toContain('period=100,series=VALUE');
  });

  it('clamps position to 0..100', () => {
    const f = '@SMA(period=20,series=VALUE)';
    expect(applyStrictnessToFormula(f, sma, -50, 'SMA')).toContain('period=100');
    expect(applyStrictnessToFormula(f, sma, 500, 'SMA')).toContain('period=5');
  });

  it('derives the slider position from current params (persists after save)', () => {
    // period=20 при границах 100 (строго) / 5 (мягко) → ближе к мягкому краю:
    // (20-100)/(5-100) ≈ 0.842 → 84
    expect(
      strictnessPositionFromFormula('@SMA(period=20,series=VALUE)', sma, 'SMA')
    ).toBe(84);
    const applied = applyStrictnessToFormula('@SMA(period=20)', sma, 75, 'SMA');
    const pos = strictnessPositionFromFormula(applied, sma, 'SMA');
    expect(Math.abs(pos - 75)).toBeLessThanOrEqual(1);
  });

  it('returns 50 when there are no bounded params', () => {
    expect(strictnessPositionFromFormula('@SMA(series=VALUE)', sma, 'SMA')).toBe(50);
    expect(strictnessPositionFromFormula('@ROC(period=10)', [])).toBe(50);
  });
});
