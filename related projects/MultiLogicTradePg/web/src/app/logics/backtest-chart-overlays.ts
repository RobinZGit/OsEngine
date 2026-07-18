import {
  ChartEquityPoint,
  ChartShadedRange,
  ChartStopMarker,
  ChartTradeMarker,
  PriceCandle,
} from '../models/market.model';
import { LogicTradeRow } from '../shared/logic-trade';

export function dtKey(dt: string): string {
  return String(dt || '')
    .replace('T', ' ')
    .replace(/Z$/i, '')
    .replace(/\.\d+/, '')
    .slice(0, 19);
}

/** Минимальная / максимальная дата сделок бумаги (для окна графика). */
export function tradeDtWindow(trades: LogicTradeRow[]): { from: string; to: string } | null {
  const keys = trades
    .map((t) => dtKey(t.bar_dt || t.executed_at))
    .filter((k) => k.length >= 10)
    .sort();
  if (keys.length === 0) return null;
  return { from: keys[0], to: keys[keys.length - 1] };
}

export function tradesForSecurity(
  trades: LogicTradeRow[],
  securityId: number,
  dateFrom?: string | null,
  dateTo?: string | null
): LogicTradeRow[] {
  const fromKey = dateFrom ? `${dateFrom} 00:00:00` : null;
  const toKey = dateTo ? `${dateTo} 23:59:59` : null;
  return trades
    .filter((t) => {
      if (t.security_id !== securityId) return false;
      const key = dtKey(t.bar_dt || t.executed_at);
      if (fromKey && key < fromKey) return false;
      if (toKey && key > toKey) return false;
      return t.status === 'filled' || t.status === 'submitted';
    })
    .sort((a, b) => dtKey(a.bar_dt).localeCompare(dtKey(b.bar_dt)));
}

/** Бумаги, по которым были сделки в тесте. */
export function papersWithTrades(
  trades: LogicTradeRow[],
  dateFrom?: string | null,
  dateTo?: string | null
): {
  security_id: number;
  security_name: string;
  security_prefix: string | null;
  pnl: number;
  commission: number;
  trade_count: number;
}[] {
  const map = new Map<
    number,
    {
      security_id: number;
      security_name: string;
      security_prefix: string | null;
      pnl: number;
      commission: number;
      trade_count: number;
    }
  >();
  for (const t of trades) {
    if (t.status !== 'filled' && t.status !== 'submitted') continue;
    const key = dtKey(t.bar_dt || t.executed_at);
    if (dateFrom && key < `${dateFrom} 00:00:00`) continue;
    if (dateTo && key > `${dateTo} 23:59:59`) continue;
    const row = map.get(t.security_id) ?? {
      security_id: t.security_id,
      security_name: t.security_name,
      security_prefix: t.security_prefix,
      pnl: 0,
      commission: 0,
      trade_count: 0,
    };
    row.trade_count += 1;
    if (
      !t.is_shadow &&
      t.financial_result != null &&
      Number.isFinite(Number(t.financial_result))
    ) {
      row.pnl += Number(t.financial_result);
    }
    if (
      !t.is_shadow &&
      t.commission != null &&
      Number.isFinite(Number(t.commission))
    ) {
      row.commission += Number(t.commission);
    }
    map.set(t.security_id, row);
  }
  return [...map.values()].sort((a, b) =>
    (a.security_prefix || a.security_name).localeCompare(
      b.security_prefix || b.security_name,
      'ru'
    )
  );
}

export function buildTradeMarkers(trades: LogicTradeRow[]): ChartTradeMarker[] {
  return trades.map((t) => ({
    dt: t.bar_dt || t.executed_at,
    price: Number(t.price),
    kind: t.side_name === 'Close' ? 'close' : 'open',
    side: t.action_name === 'Short' ? 'short' : 'long',
    isShadow: Boolean(t.is_shadow),
    label: t.trade_reason || undefined,
  }));
}

export function buildStopMarkers(trades: LogicTradeRow[]): ChartStopMarker[] {
  const out: ChartStopMarker[] = [];
  for (const t of trades) {
    if (t.side_name !== 'Close' || !t.trade_reason) continue;
    const reason = t.trade_reason.toLowerCase();
    let ruleKind: ChartStopMarker['ruleKind'] = 'other';
    if (reason.includes('stop_loss') || reason.startsWith('stop')) {
      ruleKind = 'stop_loss';
    } else if (reason.includes('take_profit') || reason.includes('take')) {
      ruleKind = 'take_profit';
    } else {
      continue;
    }
    out.push({
      dt: t.bar_dt || t.executed_at,
      price: Number(t.price),
      ruleKind,
      label: shortenStopLabel(t.trade_reason),
    });
  }
  return out;
}

function shortenStopLabel(reason: string): string {
  const s = reason.trim();
  if (s.length <= 42) return s;
  return `${s.slice(0, 40)}…`;
}

/**
 * Периоды отключения бумаги: is_shadow и пауза после stop_loss
 * до следующего обычного (не теневого) Open — бумага снова «вкл.».
 * Close во время паузы (в т.ч. хвост позиции) зону выкл. не снимает.
 */
export function buildShadedDisabledRanges(trades: LogicTradeRow[]): ChartShadedRange[] {
  const sorted = [...trades].sort((a, b) =>
    dtKey(a.bar_dt || a.executed_at).localeCompare(dtKey(b.bar_dt || b.executed_at))
  );
  const ranges: ChartShadedRange[] = [];
  let start: string | null = null;
  let lastOffDt: string | null = null;
  let invStart: string | null = null;
  let invLastDt: string | null = null;

  const flush = (endDt: string) => {
    if (!start) return;
    const end = endDt || lastOffDt || start;
    if (dtKey(end) < dtKey(start)) return;
    ranges.push({
      startDt: start,
      endDt: end,
      label: 'выкл.',
      kind: 'paused',
    });
    start = null;
    lastOffDt = null;
  };

  const flushInversion = (endDt: string) => {
    if (!invStart) return;
    const end = endDt || invLastDt || invStart;
    if (dtKey(end) < dtKey(invStart)) return;
    ranges.push({
      startDt: invStart,
      endDt: end,
      label: 'инверсия',
      kind: 'inverted',
    });
    invStart = null;
    invLastDt = null;
  };

  for (const t of sorted) {
    const dt = t.bar_dt || t.executed_at;
    const reason = (t.trade_reason || '').toLowerCase();
    if (reason.includes('security_inversion')) {
      if (invStart) {
        flushInversion(dt);
      } else {
        invStart = dt;
        invLastDt = dt;
      }
      continue;
    }
    if (invStart) {
      invLastDt = dt;
    }
    const stopPause =
      t.side_name === 'Close' &&
      (reason.includes('stop_loss') || reason.includes('security_resume'));

    if (t.is_shadow || stopPause) {
      if (!start) start = dt;
      lastOffDt = dt;
      continue;
    }
    if (start) {
      if (t.side_name === 'Open') {
        flush(dt);
      } else {
        // Реальный Close в паузе — зона выкл. продолжается
        lastOffDt = dt;
      }
    }
  }
  if (start && lastOffDt) {
    flush(lastOffDt);
  }
  if (invStart && invLastDt) {
    flushInversion(invLastDt);
  }
  return ranges;
}

/**
 * Кумулятивный PnL по закрытиям (!shadow).
 * Ноль — с начала истории теста (`periodStartDt`), не с первой сделки.
 * @param sideFilter — 'long' | 'short' | null (все)
 */
export function buildEquityPoints(
  trades: LogicTradeRow[],
  periodStartDt?: string | null,
  sideFilter?: 'long' | 'short' | null
): ChartEquityPoint[] {
  const sorted = [...trades].sort((a, b) =>
    dtKey(a.bar_dt || a.executed_at).localeCompare(dtKey(b.bar_dt || b.executed_at))
  );
  const closes = sorted.filter((t) => {
    if (t.side_name !== 'Close' || t.is_shadow) return false;
    if (t.financial_result == null || !Number.isFinite(Number(t.financial_result))) return false;
    if (sideFilter === 'long' && t.action_name !== 'Long') return false;
    if (sideFilter === 'short' && t.action_name !== 'Short') return false;
    return true;
  });
  if (closes.length === 0) return [];

  const periodKey = periodStartDt ? dtKey(periodStartDt) : '';
  const firstTradeDt = sorted[0]?.bar_dt || sorted[0]?.executed_at || closes[0].bar_dt;
  const zeroDt =
    periodKey && (!firstTradeDt || periodKey <= dtKey(firstTradeDt))
      ? periodStartDt!
      : firstTradeDt;

  let cum = 0;
  const points: ChartEquityPoint[] = [{ dt: zeroDt, value: 0 }];
  for (const t of closes) {
    cum += Number(t.financial_result);
    const dt = t.bar_dt || t.executed_at;
    if (points.length === 1 && dtKey(points[0].dt) === dtKey(dt) && points[0].value === 0) {
      points[0] = { dt, value: cum };
    } else {
      points.push({ dt, value: cum });
    }
  }
  return points;
}

/** Обрезать свечи под окно теста/сделок, при лимите — приоритет окну сделок. */
export function clipCandlesForBacktest(
  candles: PriceCandle[],
  opts: {
    coverFrom?: string | null;
    coverTo?: string | null;
    tradeFrom?: string | null;
    tradeTo?: string | null;
    maxCandles: number;
  }
): PriceCandle[] {
  if (candles.length === 0) return candles;
  const fromKey = opts.coverFrom ? dtKey(opts.coverFrom) : null;
  const toKey = opts.coverTo ? dtKey(opts.coverTo) : null;
  let clipped = candles;
  if (fromKey || toKey) {
    clipped = candles.filter((c) => {
      const k = dtKey(c.dt);
      if (fromKey && k < fromKey) return false;
      if (toKey && k > toKey) return false;
      return true;
    });
    if (clipped.length === 0) clipped = candles;
  }
  if (clipped.length <= opts.maxCandles) return clipped;

  const tradeFrom = opts.tradeFrom ? dtKey(opts.tradeFrom) : fromKey;
  const tradeTo = opts.tradeTo ? dtKey(opts.tradeTo) : toKey;
  if (tradeFrom && tradeTo) {
    // Окно вокруг сделок ± запас слева
    let i0 = clipped.findIndex((c) => dtKey(c.dt) >= tradeFrom);
    let i1 = clipped.length - 1;
    for (let i = clipped.length - 1; i >= 0; i--) {
      if (dtKey(clipped[i].dt) <= tradeTo) {
        i1 = i;
        break;
      }
    }
    if (i0 < 0) i0 = 0;
    const pad = Math.min(40, Math.floor(opts.maxCandles / 10));
    i0 = Math.max(0, i0 - pad);
    i1 = Math.min(clipped.length - 1, i1 + Math.floor(pad / 2));
    let span = i1 - i0 + 1;
    if (span <= opts.maxCandles) {
      return clipped.slice(i0, i1 + 1);
    }
    // Слишком длинный период сделок — берём с первой сделки вперёд
    return clipped.slice(i0, i0 + opts.maxCandles);
  }
  // Без сделок — начало периода
  return clipped.slice(0, opts.maxCandles);
}

/** Свеча строго внутри зоны «выкл.» (границы оставляем для шага PnL). */
export function isDtInsideDisabledShade(
  dt: string,
  ranges: ChartShadedRange[]
): boolean {
  const key = dtKey(dt);
  for (const r of ranges) {
    const a = dtKey(r.startDt);
    const b = dtKey(r.endDt);
    if (key > a && key < b) return true;
  }
  return false;
}

