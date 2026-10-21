import {
  applyStrictnessToFormula,
  formulaParamValues,
  IndicatorParamBound,
  strictnessPositionFromFormula,
  strictnessRowBackground,
} from './signal-strictness';

describe('signal-strictness (#1030/#1033)', () => {
  const sma: IndicatorParamBound[] = [
    {
      indicator_code: 'SMA',
      param_key: 'period',
      strict_value: 100,
      loose_value: 5,
      default_value: 20,
      is_integer: true,
    },
  ];
  const bb: IndicatorParamBound[] = [
    {
      indicator_code: 'BB',
      param_key: 'period',
      strict_value: 50,
      loose_value: 10,
      default_value: 20,
      is_integer: true,
    },
    {
      indicator_code: 'BB',
      param_key: 'std_dev',
      strict_value: 3,
      loose_value: 1,
      default_value: 2,
      is_integer: false,
    },
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

  it('middle restores the default value (not the range midpoint)', () => {
    // 20 — дефолт, середина диапазона была бы 53.
    expect(applyStrictnessToFormula('@SMA(period=53)', sma, 50, 'SMA')).toContain('period=20');
  });

  it('interpolates proportionally around the default and rounds integers', () => {
    // 75%: 20 + (5-20)*0.5 = 12.5 → 13
    expect(applyStrictnessToFormula('@SMA(period=20)', sma, 75, 'SMA')).toContain('period=13');
    // 25%: 100 + (20-100)*0.5 = 60
    expect(applyStrictnessToFormula('@SMA(period=20)', sma, 25, 'SMA')).toContain('period=60');
  });

  it('changes all bounded params of the indicator, floats keep 2 digits', () => {
    const f = '@BB(period=20,std_dev=2,series=UPPER) pp >= VALUE';
    const strict = applyStrictnessToFormula(f, bb, 0, 'BB');
    expect(strict).toContain('period=50');
    expect(strict).toContain('std_dev=3');
    const p75 = applyStrictnessToFormula(f, bb, 75, 'BB');
    expect(p75).toContain('period=15');
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

  it('derives the slider position from current params (default → middle)', () => {
    expect(
      strictnessPositionFromFormula('@SMA(period=20,series=VALUE)', sma, 'SMA')
    ).toBe(50);
    const applied = applyStrictnessToFormula('@SMA(period=20)', sma, 75, 'SMA');
    const pos = strictnessPositionFromFormula(applied, sma, 'SMA');
    // округление периода (13 вместо 12.5) даёт сдвиг позиции ~2 п.п.
    expect(Math.abs(pos - 75)).toBeLessThanOrEqual(3);
  });

  it('returns 50 when there are no bounded params', () => {
    expect(strictnessPositionFromFormula('@SMA(series=VALUE)', sma, 'SMA')).toBe(50);
    expect(strictnessPositionFromFormula('@ROC(period=10)', [])).toBe(50);
  });

  it('row background: light red on strict, white in the middle, light blue on loose', () => {
    expect(strictnessRowBackground(0)).toBe('rgb(252, 205, 211)');
    expect(strictnessRowBackground(50)).toBe('rgb(255, 255, 255)');
    expect(strictnessRowBackground(100)).toBe('rgb(205, 227, 255)');
  });
});
