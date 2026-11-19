import { IndicatorRow } from '../models/lookup.model';

export type SignalKind = 'trend' | 'counter';
export type PositionSide = 'long' | 'short';
export type PositionEvent = 'open' | 'close';

/** Индикатор, достаточно полный для сборки формулы сигнала. */
export type SignalIndicator = Pick<
  IndicatorRow,
  'code' | 'sig_trend_def' | 'sig_ct_def'
> &
  Partial<Pick<IndicatorRow, 'value_types'>>;

/** Серии, которые могут встречаться в sig_*_def даже без справочника value_types. */
const CONDITION_SERIES_FALLBACK = ['VALUE', 'MIDDLE', 'UPPER', 'LOWER'];

export interface ParsedSignalFormula {
  raw: string;
  indicatorCode: string | null;
  params: string | null;
  condition: string;
  valid: boolean;
  errors: string[];
}

/** Параметры @CODE(...) по умолчанию для строки сигнала в логике. */
export function defaultIndicatorParams(code: string, series?: string | null): string {
  let params: string;
  switch (code) {
    case 'RSI':
    case 'MFI':
    case 'CCI':
    case 'WILLR':
    case 'CMO':
    case 'TRIX':
    case 'TSI':
    case 'UO':
      params = 'period=14,series=VALUE';
      break;
    case 'ROC':
      params = 'period=10,series=VALUE';
      break;
    case 'MACD':
      params = 'fast=12,slow=26,signal=9,series=MACD';
      break;
    case 'STOCH':
      params = 'k=14,d=3,smooth=3,series=K';
      break;
    case 'BB':
    case 'LINREG':
    case 'SQUARE':
      params = 'period=20,std_dev=2,series=MIDDLE';
      break;
    case 'ATR':
      params = 'period=14,series=VALUE';
      break;
    case 'PACC':
      params = 'series=VALUE';
      break;
    case 'SMAT3':
      params = 'period=20,series=VALUE';
      break;
    default:
      params = 'period=20,series=VALUE';
  }
  if (!series) return params;
  return /series\s*=/i.test(params)
    ? params.replace(/series\s*=\s*[^,)]+/i, `series=${series}`)
    : `${params},series=${series}`;
}

export function defaultSignalCondition(
  indicator: Pick<IndicatorRow, 'sig_trend_def' | 'sig_ct_def'>,
  kind: SignalKind
): string {
  const def =
    kind === 'trend' ? indicator.sig_trend_def : indicator.sig_ct_def;
  return (def ?? '').trim() || (kind === 'trend' ? 'VALUE > 50' : 'VALUE < 50');
}

function escapeSeriesToken(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function seriesWordPattern(token: string, flags: string): RegExp {
  return new RegExp(`\\b${escapeSeriesToken(token)}\\b`, flags);
}

/**
 * sig_*_def хранит «официальное» условие канала вида `pp < LOWER` / `K > D`.
 * Движок формул понимает только pp и VALUE, поэтому серию нужно вынести в
 * `series=`, а в условии оставить VALUE — так же, как делает SQL-хелпер
 * `indicator_signal_series_and_condition` (#994, #1055).
 * Возвращает серию для @CODE(...) и нормализованное условие.
 */
export function normalizeSignalCondition(
  indicator: SignalIndicator,
  condition: string,
  kind: SignalKind
): { series: string | null; condition: string } {
  const src = (condition ?? '').trim();
  if (!src) return { series: null, condition: src };

  const types = [...(indicator.value_types ?? [])].sort(
    (a, b) => a.display_order - b.display_order
  );
  const tokens = [...new Set([
    ...types
      .filter((t) => !t.is_threshold)
      .map((t) => String(t.code ?? '').toUpperCase())
      .filter(Boolean),
    ...CONDITION_SERIES_FALLBACK,
  ])];
  const hits = tokens.filter((t) => seriesWordPattern(t, 'i').test(src));

  const unknownLetters = (text: string): boolean => {
    const rest = text
      .toUpperCase()
      .replace(/\b(PP|VALUE|AND|OR)\b/g, '')
      .replace(/[0-9.,()+\-*/<>=!#\s]/g, '');
    return rest.length > 0;
  };

  if (hits.length === 1) {
    const token = hits[0];
    const normalized = src.replace(seriesWordPattern(token, 'gi'), 'VALUE');
    if (!unknownLetters(normalized)) {
      // VALUE — уже базовая серия, defaults не трогаем (LINREG/SQUARE=MIDDLE и т.п.).
      return { series: token === 'VALUE' ? null : token, condition: normalized };
    }
  }

  const fallback = kind === 'counter' ? 'VALUE < 50' : 'VALUE > 50';
  if (hits.length > 1 || unknownLetters(src)) {
    return { series: hits[0] ?? null, condition: fallback };
  }
  return { series: null, condition: src };
}

/** Сборка формулы для logic_indicator_signals из справочника индикатора. */
export function buildLogicSignalFormula(
  indicator: SignalIndicator,
  kind: SignalKind
): string {
  const normalized = normalizeSignalCondition(
    indicator,
    defaultSignalCondition(indicator, kind),
    kind
  );
  const params = defaultIndicatorParams(indicator.code, normalized.series);
  return `@${indicator.code}(${params}) ${normalized.condition}`;
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
