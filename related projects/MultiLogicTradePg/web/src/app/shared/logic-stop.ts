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
        return 'Линейный TP по портфелю с возобновлением (продажа при откате от пика ≥ %)';
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
      return 'Линейный TP по портфелю с возобновлением (продажа при откате от пика ≥ %)';
  }
}

export function valueUnitLabel(unit: LogicStopValueUnit): string {
  return unit === 'percent' ? '%' : 'ATR';
}

/** Типы scope для стоп-лосса (все видимы в списке; часть недоступна для выбора). */
export const LOGIC_STOP_SCOPES_STOP_LOSS: LogicStopScopeType[] = [
  'security',
  'security_resume',
  'security_inversion',
  'portfolio',
  'portfolio_resume',
];

/** Типы scope для тейк-профита (все видимы; портфельные — недоступны для выбора). */
export const LOGIC_STOP_SCOPES_TAKE_PROFIT: LogicStopScopeType[] = [
  'security',
  'portfolio',
  'portfolio_ltp_renew',
];

/**
 * Scope, которые показываем в UI, но нельзя выбрать при создании/смене типа.
 * Уже сохранённые правила с этими типами остаются в таблице.
 *
 * SL: портфель с обновлением (пока недоступен).
 * TP: любые типы по всему портфелю логики.
 * security_inversion — доступен; нужен inversion_value (% инверсии).
 */
export function isStopScopeChoosable(
  scope: LogicStopScopeType,
  ruleKind: LogicStopRuleKind
): boolean {
  if (ruleKind === 'stop_loss') {
    return scope !== 'portfolio_resume';
  }
  if (ruleKind === 'take_profit') {
    return scope === 'security';
  }
  return false;
}

/** Колонка «% инверсии» активна только для security_inversion. */
export function stopNeedsInversionValue(
  scope: LogicStopScopeType,
  ruleKind: LogicStopRuleKind
): boolean {
  return ruleKind === 'stop_loss' && scope === 'security_inversion';
}

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
