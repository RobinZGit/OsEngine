import { IndicatorRow } from '../models/lookup.model';

export type SignalKind = 'trend' | 'counter';
export type PositionSide = 'long' | 'short';
export type PositionEvent = 'open' | 'close';

export interface ParsedSignalFormula {
  raw: string;
  indicatorCode: string | null;
  params: string | null;
  condition: string;
  valid: boolean;
  errors: string[];
}

/** Параметры @CODE(...) по умолчанию для строки сигнала в логике. */
export function defaultIndicatorParams(code: string): string {
  switch (code) {
    case 'RSI':
    case 'MFI':
    case 'CCI':
    case 'WILLR':
    case 'CMO':
    case 'ROC':
    case 'TRIX':
    case 'TSI':
    case 'UO':
      return 'period=14,series=VALUE';
    case 'MACD':
      return 'fast=12,slow=26,signal=9,series=MACD';
    case 'STOCH':
      return 'k=14,d=3,smooth=3,series=K';
    case 'BB':
    case 'LINREG':
    case 'SQUARE':
      return 'period=20,std_dev=2,series=MIDDLE';
    case 'ATR':
      return 'period=14,series=VALUE';
    case 'PACC':
      return 'series=VALUE';
    case 'SMAT3':
      return 'period=20,series=VALUE';
    default:
      return 'period=20,series=VALUE';
  }
}

export function defaultSignalCondition(
  indicator: Pick<IndicatorRow, 'sig_trend_def' | 'sig_ct_def'>,
  kind: SignalKind
): string {
  const def =
    kind === 'trend' ? indicator.sig_trend_def : indicator.sig_ct_def;
  return (def ?? '').trim() || (kind === 'trend' ? 'VALUE > 50' : 'VALUE < 50');
}

/** Сборка формулы для logic_indicator_signals из справочника индикатора. */
export function buildLogicSignalFormula(
  indicator: Pick<IndicatorRow, 'code' | 'sig_trend_def' | 'sig_ct_def'>,
  kind: SignalKind
): string {
  const params = defaultIndicatorParams(indicator.code);
  const condition = defaultSignalCondition(indicator, kind);
  return `@${indicator.code}(${params}) ${condition}`;
}

/**
 * Мультитаймфрейм-сигналы (#843): параметр tf=<База>[×k] внутри @CODE(...).
 * База — каталожный ТФ (M1…D1), k — целое ≥1 (M1*7 = семиминутный ТФ).
 * Пустая база = сигнал наследует ТФ логики.
 */
export interface SignalTfParts {
  base: string;
  mult: number | null;
}

export function extractSignalTf(formula: string): SignalTfParts {
  const parsed = parseSignalFormula(formula ?? '');
  if (!parsed.valid || !parsed.params) {
    return { base: '', mult: null };
  }
  const part = parsed.params
    .split(/,(?![^(]*\))/)
    .map((p) => p.trim())
    .find((p) => /^tf\s*=/i.test(p));
  if (!part) {
    return { base: '', mult: null };
  }
  const expr = part.replace(/^tf\s*=/i, '').trim();
  const m = expr.match(/^([A-Za-z]+[0-9]{0,4})\s*(?:[*x×]\s*([0-9]{1,3}))?$/i);
  if (!m) {
    return { base: '', mult: null };
  }
  const mult = m[2] ? Math.max(1, parseInt(m[2], 10)) : null;
  return { base: m[1].toUpperCase(), mult };
}

/** Записать tf= в формулу (замена/вставка/удаление). base='' → удалить tf=. */
export function applySignalTf(
  formula: string,
  base: string,
  mult: number | null
): string {
  const text = (formula ?? '').trim();
  if (!text) return text;
  const head = text.match(/^@([A-Za-z0-9_]+\()/i);
  if (!head) return text;
  const openEnd = (head.index ?? 0) + head[0].length;
  let depth = 1;
  let closeIdx = -1;
  for (let i = openEnd; i < text.length; i++) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx < 0) return text;
  const inner = text.slice(openEnd, closeIdx);
  const parts = inner
    .split(/,(?![^(]*\))/)
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => !/^tf\s*=/i.test(p));
  const tfExpr = !base ? null : mult && mult > 1 ? `${base}*${mult}` : base;
  if (tfExpr) parts.push(`tf=${tfExpr}`);
  return `@${text.slice(1, openEnd - 1)}(${parts.join(', ')})${text.slice(closeIdx + 1)}`;
}

/**
 * Предварительный разбор формулы сигнала логики.
 * Формат: @RSI(period=14,series=VALUE) VALUE > 50
 * Параметры могут содержать вложенные скобки: OPT(std_dev,10).
 */
export function parseSignalFormula(raw: string): ParsedSignalFormula {
  const text = (raw ?? '').trim();
  const errors: string[] = [];
  if (!text) {
    return {
      raw: text,
      indicatorCode: null,
      params: null,
      condition: '',
      valid: false,
      errors: ['Пустая формула'],
    };
  }

  const head = text.match(/^@([A-Za-z0-9_]+)\s*\(/);
  if (!head || head.index !== 0) {
    return {
      raw: text,
      indicatorCode: null,
      params: null,
      condition: text,
      valid: false,
      errors: ['Ожидается @CODE(params) условие'],
    };
  }

  const indicatorCode = head[1].toUpperCase();
  const openIdx = head[0].length - 1; // '('
  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx < 0) {
    return {
      raw: text,
      indicatorCode,
      params: null,
      condition: '',
      valid: false,
      errors: ['Незакрытые скобки в @CODE(...)'],
    };
  }

  const params = text.slice(openIdx + 1, closeIdx).trim();
  const condition = text.slice(closeIdx + 1).trim();

  if (!params) {
    errors.push('Пустые параметры в @CODE(...)');
  }
  if (!condition) {
    errors.push('Нет условия после @CODE(...)');
  }
  if (!/[><=!]/.test(condition) && !/\b(CROSS|AND|OR)\b/i.test(condition)) {
    errors.push('Условие должно содержать сравнение или AND/OR');
  }

  return {
    raw: text,
    indicatorCode,
    params,
    condition,
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Подпись вида сигнала для UI.
 * В БД остаются trend|counter; смысл: follow (по течению) | fade (против / возврат).
 */
export function signalKindLabel(kind: SignalKind): string {
  return kind === 'trend' ? 'По течению' : 'Против';
}

/** Подпись стороны позиции для UI. */
export function positionSideLabel(side: PositionSide): string {
  return side === 'long' ? 'Long' : 'Short';
}

/** Подпись действия сигнала: открытие / закрытие. */
export function positionEventLabel(event: PositionEvent): string {
  return event === 'open' ? 'Открытие' : 'Закрытие';
}
