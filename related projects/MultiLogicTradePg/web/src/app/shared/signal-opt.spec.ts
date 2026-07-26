import {
  OPT_MAX_PARAMS_GLOBAL,
  buildOptArms,
  canonicalOptParamKey,
  expandFormulaParams,
  extractOptSpecs,
  extractParamsFromFormula,
  optArmValue,
  optLaneLabel,
  parseNumericParamMap,
  uniqueOptKeysFromFormulas,
} from './signal-opt';
import { parseSignalFormula } from './signal-formula';

describe('signal-opt', () => {
  it('parses nested OPT inside @LINREG params', () => {
    const f =
      '@LINREG(period=20,std_dev=2,series=LOWER,OPT(std_dev,10)) pp <= VALUE';
    const p = parseSignalFormula(f);
    expect(p.valid).toBeTrue();
    expect(p.params).toContain('OPT(std_dev,10)');
    const specs = extractOptSpecs(p.params);
    expect(specs.length).toBe(1);
    expect(specs[0].key).toBe('std_dev');
    expect(specs[0].base).toBe(2);
    expect(specs[0].pct).toBe(10);
  });

  it('OPT(std,10) resolves base from std_dev=', () => {
    const specs = extractOptSpecs('period=20,std_dev=2,OPT(std,10),series=LOWER');
    expect(specs[0].key).toBe('std_dev');
    expect(specs[0].base).toBe(2);
  });

  it('buildOptArms is 2^n corners', () => {
    const arms = buildOptArms([
      { key: 'std_dev', base: 2, pct: 10 },
      { key: 'period', base: 20, pct: 10 },
    ]);
    expect(arms.length).toBe(4);
    expect(new Set(arms.map((a) => a.lane)).size).toBe(4);
    expect(optArmValue(2, 10, 'up')).toBe(2.2);
    expect(optArmValue(2, 10, 'down')).toBe(1.8);
  });

  it('expandFormulaParams strips OPT and applies arm values', () => {
    const params = 'period=20,std_dev=2,series=LOWER,OPT(std_dev,10)';
    const expanded = expandFormulaParams(params, { std_dev: 2.2 });
    expect(expanded).toContain('std_dev=2.2');
    expect(expanded).not.toContain('OPT');
    expect(expandFormulaParams(params, null)).toContain('std_dev=2');
    expect(expandFormulaParams(params, null)).not.toContain('OPT');
  });

  it('uniqueOptKeys and cap constant', () => {
    expect(OPT_MAX_PARAMS_GLOBAL).toBe(3);
    const keys = uniqueOptKeysFromFormulas([
      '@LINREG(period=20,std_dev=2,OPT(std_dev,10),series=L) pp>VALUE',
      '@SMA(period=14,OPT(period,5),series=VALUE) pp>VALUE',
    ]);
    expect(keys).toEqual(['period', 'std_dev']);
  });

  it('optLaneLabel', () => {
    expect(optLaneLabel('std_dev:up')).toContain('↑std_dev');
    expect(canonicalOptParamKey('std')).toBe('std_dev');
    expect(parseNumericParamMap('a=1,OPT(x,2),b=3')['b']).toBe(3);
    expect(extractParamsFromFormula('@X(a=1,OPT(b,2)) c')).toBe('a=1,OPT(b,2)');
  });
});
