import {
  ChartEquityPoint,
  ChartShadedRange,
  ChartStopMarker,
  ChartTradeMarker,
  PriceCandle,
} from '../models/market.model';
import { LogicTradeRow } from '../shared/logic-trade';
import { asDateOnly } from '../shared/date-format';

export function dtKey(dt: string): string {
  return String(dt || '')
    .replace('T', ' ')
    .replace(/Z$/i, '')
    .replace(/\.\d+/, '')
    .slice(0, 19);
}

/** YYYY-MM-DD for period filters (ISO date_from from API must not break papers list). */
function periodDay(raw: string | null | undefined): string | null {
  return asDateOnly(raw);
}

/** Единый числовой id бумаги — иначе pin «327» vs сделки 327 → ост. 0 и дубль строки. */
function paperSecurityId(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
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
  const fromDay = periodDay(dateFrom);
  const toDay = periodDay(dateTo);
  const fromKey = fromDay ? `${fromDay} 00:00:00` : null;
  const toKey = toDay ? `${toDay} 23:59:59` : null;
  const secId = paperSecurityId(securityId);
  return trades
    .filter((t) => {
      if (paperSecurityId(t.security_id) !== secId) return false;
      const key = dtKey(t.bar_dt || t.executed_at);
      if (fromKey && key < fromKey) return false;
      if (toKey && key > toKey) return false;
      return t.status === 'filled' || t.status === 'submitted';
    })
    .sort((a, b) => dtKey(a.bar_dt).localeCompare(dtKey(b.bar_dt)));
}

export type PaperListRow = {
  security_id: number;
  security_name: string;
  security_prefix: string | null;
  /** Реализованный финрез (закрытия). У непродаваемого фонда обычно 0. */
  pnl: number;
  commission: number;
  trade_count: number;
  /** Нетто открытый остаток: Long +qty, Short −qty (по remaining_qty открытий). */
  open_qty: number;
  /** Последняя известная цена (сделка / свеча) для оценки остатка. */
  last_price: number | null;
  /** Оценка остатка в деньгах: |open_qty| × last_price. */
  position_value: number;
};

function emptyPaperRow(
  securityId: number,
  securityName: string,
  securityPrefix: string | null
): PaperListRow {
  return {
    security_id: securityId,
    security_name: securityName,
    security_prefix: securityPrefix,
    pnl: 0,
    commission: 0,
    trade_count: 0,
    open_qty: 0,
    last_price: null,
    position_value: 0,
  };
}

/** Бумаги, по которым были сделки; optional pin (денежный фонд) — всегда сверху. */
export function papersWithTrades(
  trades: LogicTradeRow[],
  dateFrom?: string | null,
  dateTo?: string | null,
  pinned?: PaperListRow | null
): PaperListRow[] {
  const fromDay = periodDay(dateFrom);
  const toDay = periodDay(dateTo);
  const fromKey = fromDay ? `${fromDay} 00:00:00` : null;
  const toKey = toDay ? `${toDay} 23:59:59` : null;
  const map = new Map<number, PaperListRow>();
  /** Последняя цена Open по бумаге (до подгрузки свечи периода). */
  const lastOpenPx = new Map<number, { dt: string; px: number }>();
  for (const t of trades) {
    if (t.status !== 'filled' && t.status !== 'submitted') continue;
    const key = dtKey(t.bar_dt || t.executed_at);
    if (fromKey && key < fromKey) continue;
    if (toKey && key > toKey) continue;
    const secId = paperSecurityId(t.security_id);
    if (secId <= 0) continue;
    const row =
      map.get(secId) ??
      emptyPaperRow(secId, t.security_name, t.security_prefix);
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
    // Остаток позиции: сумма remaining по Open (фонд не закрывается → иначе всегда «0» в списке).
    if (!t.is_shadow && t.side_name === 'Open') {
      const remRaw = t.remaining_qty;
      const rem =
        remRaw == null || !Number.isFinite(Number(remRaw))
          ? Number(t.quantity)
          : Number(remRaw);
      if (rem > 0) {
        row.open_qty += t.action_name === 'Short' ? -rem : rem;
        const px = Number(t.price);
        if (Number.isFinite(px) && px > 0) {
          const prev = lastOpenPx.get(secId);
          if (!prev || key >= prev.dt) {
            lastOpenPx.set(secId, { dt: key, px });
          }
        }
      }
    }
    map.set(secId, row);
  }
  for (const [secId, row] of map) {
    applyPaperMarkValue(row, lastOpenPx.get(secId)?.px ?? null);
  }
  const sorted = [...map.values()].sort((a, b) =>
    (a.security_prefix || a.security_name).localeCompare(
      b.security_prefix || b.security_name,
      'ru'
    )
  );
  const pinId = paperSecurityId(pinned?.security_id);
  if (!pinned || pinId <= 0) {
    return sorted;
  }
  const pinPrefix = String(pinned.security_prefix ?? '')
    .trim()
    .toUpperCase();
  let fromTrades = map.get(pinId);
  if (!fromTrades && pinPrefix) {
    fromTrades = sorted.find(
      (r) =>
        String(r.security_prefix ?? '')
          .trim()
          .toUpperCase() === pinPrefix
    );
  }
  const headId = fromTrades?.security_id ?? pinId;
  const head: PaperListRow = {
    security_id: headId,
    security_name: pinned.security_name || fromTrades?.security_name || '',
    security_prefix: pinned.security_prefix ?? fromTrades?.security_prefix ?? null,
    pnl: fromTrades?.pnl ?? 0,
    commission: fromTrades?.commission ?? 0,
    trade_count: fromTrades?.trade_count ?? 0,
    open_qty: fromTrades?.open_qty ?? 0,
    last_price: fromTrades?.last_price ?? null,
    position_value: fromTrades?.position_value ?? 0,
  };
  return [
    head,
    ...sorted.filter((r) => paperSecurityId(r.security_id) !== paperSecurityId(headId)),
  ];
}

/** Оценка открытого остатка в деньгах. */
export function applyPaperMarkValue(
  row: PaperListRow,
  markPrice: number | null | undefined
): void {
  const px = Number(markPrice);
  if (!Number.isFinite(px) || px <= 0 || row.open_qty === 0) {
    if (row.open_qty === 0) {
      row.last_price = null;
      row.position_value = 0;
    }
    return;
  }
  row.last_price = px;
  row.position_value = Math.abs(row.open_qty) * px;
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

/**
 * Портфельные SL/TP для вертикалей на эквити: одно событие на бар
 * (закрытие всех бумаг с reason stop_loss:portfolio / take_profit:portfolio).
 */
export function buildPortfolioStopMarkers(trades: LogicTradeRow[]): ChartStopMarker[] {
  const portfolioCloses = trades.filter((t) => {
    const reason = String(t.trade_reason || '').toLowerCase();
    return (
      t.side_name === 'Close' &&
      (reason.includes('portfolio') || reason.includes('портфел'))
    );
  });
  const byKey = new Map<string, ChartStopMarker>();
  for (const m of buildStopMarkers(portfolioCloses)) {
    if (m.ruleKind !== 'stop_loss' && m.ruleKind !== 'take_profit') continue;
    const key = `${dtKey(m.dt)}|${m.ruleKind}`;
    if (!byKey.has(key)) {
      byKey.set(key, m);
    }
  }
  return [...byKey.values()].sort((a, b) => dtKey(a.dt).localeCompare(dtKey(b.dt)));
}

function shortenStopLabel(reason: string): string {
  const s = reason.trim();
  if (s.length <= 42) return s;
  return `${s.slice(0, 40)}…`;
}

type PaperModeKind = 'normal' | 'shadow' | 'inverted';

function paperModeLabel(kind: PaperModeKind): string {
  if (kind === 'shadow') return 'shadow';
  if (kind === 'inverted') return 'инверсия';
  return 'обычная';
}

/**
 * Зоны режима бумаги на весь период теста:
 * - normal (зелёный) — обычная боевая логика;
 * - shadow (серый) — теневой режим после SL;
 * - inverted (розовый) — локальная инверсия после возврата shadow к нулю.
 *
 * security_inversion: SL → shadow; реальный Open после shadow → toggle inverted.
 * Close в shadow зону не снимает; снимает обычный (не теневой) Open.
 */
export function buildShadedDisabledRanges(
  trades: LogicTradeRow[],
  periodStartDt?: string | null,
  periodEndDt?: string | null
): ChartShadedRange[] {
  const sorted = [...trades].sort((a, b) => {
    const ka = dtKey(a.bar_dt || a.executed_at);
    const kb = dtKey(b.bar_dt || b.executed_at);
    if (ka !== kb) return ka.localeCompare(kb);
    const rank = (t: LogicTradeRow) =>
      t.side_name === 'Close' ? 0 : t.side_name === 'Open' ? 1 : 2;
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return (a.id ?? 0) - (b.id ?? 0);
  });

  const firstTradeDt = sorted.length
    ? sorted[0].bar_dt || sorted[0].executed_at
    : null;
  const lastTradeDt = sorted.length
    ? sorted[sorted.length - 1].bar_dt || sorted[sorted.length - 1].executed_at
    : null;
  const startDt = (periodStartDt && String(periodStartDt).trim()) || firstTradeDt;
  // date-only periodEnd («2026-07-30») = полночь → белый хвост, пока сделки идут днём.
  // Берём max(periodEnd, lastTrade), чтобы заливка доходила до последней точки эквити.
  let endDt = (periodEndDt && String(periodEndDt).trim()) || lastTradeDt;
  if (lastTradeDt && endDt && dtKey(lastTradeDt) > dtKey(endDt)) {
    endDt = lastTradeDt;
  }
  if (!startDt || !endDt) {
    return [];
  }

  const ranges: ChartShadedRange[] = [];
  const state = {
    mode: 'normal' as PaperModeKind,
    rangeStart: startDt,
    inverted: false,
    /** После SL security_inversion следующий реальный Open переключает inverted. */
    pendingInversionToggle: false,
  };

  const flush = (untilDt: string) => {
    if (!state.rangeStart) return;
    if (dtKey(untilDt) < dtKey(state.rangeStart)) return;
    ranges.push({
      startDt: state.rangeStart,
      endDt: untilDt,
      label: paperModeLabel(state.mode),
      kind: state.mode,
    });
  };

  const switchMode = (next: PaperModeKind, atDt: string) => {
    if (next === state.mode) return;
    flush(atDt);
    state.mode = next;
    state.rangeStart = atDt;
  };

  for (const t of sorted) {
    const dt = t.bar_dt || t.executed_at;
    if (!dt) continue;
    const reason = (t.trade_reason || '').toLowerCase();
    const isInversionStop =
      t.side_name === 'Close' && reason.includes('security_inversion');
    const isPortfolioPause =
      t.side_name === 'Close' &&
      (reason.includes('portfolio_resume') ||
        reason.includes('portfolio_ltp_renew') ||
        ((reason.includes('portfolio') || reason.includes('портфел')) &&
          (reason.includes('stop_loss') || reason.includes('take_profit'))));
    const isStopPause =
      t.side_name === 'Close' &&
      (reason.includes('stop_loss') || reason.includes('security_resume'));

    // SL / portfolio pause → shadow (обычный / resume / inversion / portfolio LTP).
    if (isStopPause || isInversionStop || isPortfolioPause) {
      if (isInversionStop) {
        state.pendingInversionToggle = true;
      }
      switchMode('shadow', dt);
      continue;
    }

    if (t.is_shadow) {
      switchMode('shadow', dt);
      continue;
    }

    // Реальный Open после shadow → обычная или инверсия (toggle для security_inversion).
    if (state.mode === 'shadow' && t.side_name === 'Open') {
      if (state.pendingInversionToggle) {
        state.inverted = !state.inverted;
        state.pendingInversionToggle = false;
      }
      switchMode(state.inverted ? 'inverted' : 'normal', dt);
      continue;
    }
  }

  flush(endDt);
  return ranges;
}

/**
 * Кумулятивный PnL по закрытиям.
 * @param opts.shadowOnly — только is_shadow (для пунктирной теневой эквити)
 * @param opts.includeShadow — включить shadow в основную серию (редко)
 * Ноль — с начала периода (`periodStartDt`), даже без закрытий (горизонт «0»).
 */
export function buildEquityPoints(
  trades: LogicTradeRow[],
  periodStartDt?: string | null,
  sideFilter?: 'long' | 'short' | null,
  opts?: { shadowOnly?: boolean; includeShadow?: boolean }
): ChartEquityPoint[] {
  const shadowOnly = Boolean(opts?.shadowOnly);
  const includeShadow = Boolean(opts?.includeShadow);
  const sorted = [...trades].sort((a, b) =>
    dtKey(a.bar_dt || a.executed_at).localeCompare(dtKey(b.bar_dt || b.executed_at))
  );
  const closes = sorted.filter((t) => {
    if (t.side_name !== 'Close') return false;
    if (shadowOnly) {
      if (!t.is_shadow) return false;
    } else if (!includeShadow && t.is_shadow) {
      return false;
    }
    // Champion book only — OPT paper lanes (opt_lane≠'') must not pull equity vs FinRes.
    if ((t.opt_lane ?? '') !== '') return false;
    // Same status filter as /logic-trades/pnl-summary.
    if (t.status != null && t.status !== 'filled' && t.status !== 'submitted') return false;
    if (t.financial_result == null || !Number.isFinite(Number(t.financial_result))) return false;
    if (sideFilter === 'long' && t.action_name !== 'Long') return false;
    if (sideFilter === 'short' && t.action_name !== 'Short') return false;
    return true;
  });

  const periodKey = periodStartDt ? dtKey(periodStartDt) : '';
  const firstAnyDt = sorted[0]?.bar_dt || sorted[0]?.executed_at || null;
  const firstCloseDt = closes[0]?.bar_dt || closes[0]?.executed_at || null;
  const anchorDt = firstAnyDt || firstCloseDt;
  // Shadow-серия: не тянуть пунктир с начала периода (иначе «фантом» в зелёной зоне).
  // Старт — с первого shadow Close.
  // Основная эквити: ноль с periodStart или с первой сделки (Open/Close).
  const zeroDt = shadowOnly
    ? firstCloseDt
    : periodKey && (!anchorDt || periodKey <= dtKey(anchorDt))
      ? periodStartDt!
      : anchorDt;

  // Без закрытий: основная эквити — ноль с начала периода; shadow — пусто.
  if (closes.length === 0) {
    if (shadowOnly || !zeroDt) return [];
    return [{ dt: zeroDt, value: 0 }];
  }

  let cum = 0;
  const points: ChartEquityPoint[] = [{ dt: zeroDt!, value: 0 }];
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

/** Теневая эквити (только shadow Close) — для пунктира на графике. */
export function buildShadowEquityPoints(
  trades: LogicTradeRow[],
  periodStartDt?: string | null,
  sideFilter?: 'long' | 'short' | null
): ChartEquityPoint[] {
  return buildEquityPoints(trades, periodStartDt, sideFilter, { shadowOnly: true });
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

