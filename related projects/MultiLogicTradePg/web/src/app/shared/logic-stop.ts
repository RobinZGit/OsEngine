export type LogicStopRuleKind = 'stop_loss' | 'take_profit';
export type LogicStopScopeType =
  | 'security'
  | 'security_resume'
  | 'security_inversion'
  | 'portfolio'
  | 'portfolio_resume'
  | 'portfolio_ltp_renew'
  /** @deprecated migrated to portfolio_ltp_renew */
  | 'security_ltp_renew';
export type LogicStopValueUnit = 'percent' | 'atr';

export function ruleKindLabel(kind: LogicStopRuleKind): string {
  return kind === 'stop_loss' ? 'Стоп-лосс' : 'Тейк-профит';
}

export function scopeTypeLabel(
  scope: LogicStopScopeType,
  ruleKind?: LogicStopRuleKind
): string {
  if (ruleKind === 'take_profit') {
    switch (scope) {
      case 'security':
        return 'По бумаге';
      case 'portfolio':
        return 'По всему портфелю логики';
      case 'portfolio_ltp_renew':
      case 'security_ltp_renew':
        return 'Линейный тейк-профит по всему портфелю с возобновлением';
      default:
        return scope;
    }
  }
  switch (scope) {
    case 'security':
      return 'По бумаге (обычный)';
    case 'security_resume':
      return 'По бумаге и стороне (возобновление при достижении суммы прерывания)';
    case 'security_inversion':
      return 'По бумаге (инверсия при повторной просадке)';
    case 'portfolio':
      return 'По всему портфелю логики';
    case 'portfolio_resume':
      return 'По портфелю с обновлением (пауза → shadow → возобновление)';
    case 'portfolio_ltp_renew':
    case 'security_ltp_renew':
      return 'Линейный тейк-профит по всему портфелю с возобновлением';
  }
}

export function valueUnitLabel(unit: LogicStopValueUnit): string {
  return unit === 'percent' ? '%' : 'ATR';
}

/** Типы scope для стоп-лосса. */
export const LOGIC_STOP_SCOPES_STOP_LOSS: LogicStopScopeType[] = [
  'security',
  'security_resume',
  'security_inversion',
  'portfolio',
  'portfolio_resume',
];

/** Типы scope для тейк-профита. */
export const LOGIC_STOP_SCOPES_TAKE_PROFIT: LogicStopScopeType[] = [
  'security',
  'portfolio',
  'portfolio_ltp_renew',
];

export function stopScopesForRuleKind(
  ruleKind: LogicStopRuleKind
): LogicStopScopeType[] {
  return ruleKind === 'stop_loss'
    ? LOGIC_STOP_SCOPES_STOP_LOSS
    : LOGIC_STOP_SCOPES_TAKE_PROFIT;
}

/** @deprecated используйте stopScopesForRuleKind */
export const LOGIC_STOP_SCOPES = LOGIC_STOP_SCOPES_STOP_LOSS;

export const LOGIC_STOP_UNITS: LogicStopValueUnit[] = ['percent', 'atr'];
