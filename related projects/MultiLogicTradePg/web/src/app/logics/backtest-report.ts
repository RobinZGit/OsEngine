/**
 * OsEngine-like backtest statistics + HTML report (Journal → Statistics).
 * Metrics mirror PositionStatisticGenerator where possible, adapted to Close trades.
 */
import { LogicRow } from '../models/logic.model';
import { LogicTradeLotRow, LogicTradeRow } from '../shared/logic-trade';
import { asDateOnly, formatDateRangeLabel } from '../shared/date-format';
import {
  ChartEquityPoint,
  ChartShadedRange,
  ChartStopMarker,
  ChartTradeMarker,
  IndicatorValueRow,
  PriceCandle,
} from '../models/market.model';
import { buildEquityPoints } from './backtest-chart-overlays';

/** Minimal run info for the report header (avoids circular import with the panel). */
export interface BacktestReportRunInfo {
  date_from?: string | null;
  date_to?: string | null;
  status?: string | null;
  progress_pct?: number | null;
}

export type ReportSide = 'all' | 'long' | 'short';

export interface ClosedDeal {
  pnl: number;
  commission: number;
  action: 'Long' | 'Short';
  securityName: string;
  securityPrefix: string | null;
  openDt: string | null;
  closeDt: string;
  holdMs: number | null;
  quantity: number;
  openPrice: number | null;
  closePrice: number;
}

export interface SideStats {
  netPnl: number;
  netPnlPct: number;
  dealCount: number;
  avgHoldLabel: string;
  sharpe: number;
  profitFactor: number;
  recovery: number;
  avgPnl: number;
  winCount: number;
  winPct: number;
  avgWin: number;
  maxWinStreak: number;
  lossCount: number;
  lossPct: number;
  avgLoss: number;
  maxLossStreak: number;
  maxDrawdownPct: number | null;
  commission: number;
  breakevenCommissionPct: number | null;
  payOffRatio: number;
}

/** One OPT / formula-param history row for the report. */
export interface ParamHistoryEvent {
  id?: number | null;
  bar_dt?: string | null;
  created_at?: string | null;
  event_kind: 'snapshot' | 'promote' | string;
  lane?: string | null;
  params?: Record<string, number | string> | null;
  params_prev?: Record<string, number | string> | null;
  opt_specs?: Record<string, { base?: number; pct?: number }> | null;
  formulas?: Array<{
    signal_id?: number;
    position_event?: string;
    position_side?: string;
    formula?: string;
  }> | null;
  champion_finres?: number | null;
  winner_finres?: number | null;
}

export interface BacktestReportModel {
  generatedAt: string;
  logicName: string;
  logicId: number;
  periodLabel: string;
  /** YYYY-MM-DD for download filename (may be empty). */
  dateFrom: string;
  /** YYYY-MM-DD for download filename (may be empty). */
  dateTo: string;
  runStatus: string | null;
  progressPct: number | null;
  params: {
    timeframe: string;
    positionSizePct: number;
    maxOpenPositions: number;
    initialBalance: number;
    commissionPct: number;
    costMethod: string;
    baseAnnualRatePct: number;
    inversion: boolean;
    cashFundCode: string;
    accountType: string;
    accountName: string;
  };
  /** Снимок и/или promote баз OPT / параметров формул. */
  paramHistory: ParamHistoryEvent[];
  /** Пер-бумажные блоки: график (свечи/линия), индикаторы, сделки, FIFO-лоты (#848). */
  paperCharts: PaperReportChart[];
  all: SideStats;
  long: SideStats;
  short: SideStats;
  equitySvg: string;
  topWins: ClosedDeal[];
  topLosses: ClosedDeal[];
  dealCount: number;
}

/** Safe single path segment for Windows/macOS download names. */
export function sanitizeReportFilenamePart(s: string, max = 80): string {
  const cleaned = String(s ?? '')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return (cleaned || 'logic').slice(0, max);
}

/**
 * Download name: logic + period + timeframe + PnL% + deal count.
 * Example: MLT-report_MyLogic_2020-01-01_2025-12-31_M15_PnL+12.3pct_42deals.html
 */
export function buildBacktestReportDownloadName(model: BacktestReportModel): string {
  const name = sanitizeReportFilenamePart(model.logicName, 50);
  const from = model.dateFrom || 'nodate';
  const to = model.dateTo || 'nodate';
  const tf = sanitizeReportFilenamePart(model.params.timeframe || 'TF', 12);
  const pnl = model.all?.netPnlPct;
  const pnlBit = Number.isFinite(pnl)
    ? `PnL${pnl! >= 0 ? '+' : ''}${pnl!.toFixed(1)}pct`
    : 'PnL-na';
  const deals = `${Number(model.dealCount) || 0}deals`;
  return `MLT-report_${name}_${from}_${to}_${tf}_${pnlBit}_${deals}.html`;
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtMoney(v: number): string {
  return v.toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtPct(v: number, digits = 2): string {
  return `${v.toLocaleString('ru-RU', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}%`;
}

function fmtNum(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('ru-RU', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtHold(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `H ${h} M ${m} S ${s}`;
  if (m > 0) return `M ${m} S ${s}`;
  return `S ${s}`;
}

function parseDt(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const t = Date.parse(String(raw).replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
}

/** Closed filled deals from test trades (+ optional lots for hold time). */
export function collectClosedDeals(
  trades: LogicTradeRow[],
  tradeLots?: Map<number, LogicTradeLotRow[]>
): ClosedDeal[] {
  const closes = trades
    .filter(
      (t) =>
        !t.is_shadow &&
        !t.opt_lane &&
        t.side_name === 'Close' &&
        (t.status === 'filled' || t.status === 'submitted') &&
        t.financial_result != null &&
        Number.isFinite(Number(t.financial_result))
    )
    .sort((a, b) =>
      String(a.bar_dt || a.executed_at).localeCompare(String(b.bar_dt || b.executed_at))
    );

  // FIFO fallback: когда lots не загружены, сопоставляем продажи с покупками
  // той же бумаги/направления по количеству (очередь открытий). Время удержания
  // берём по свечам: усредняем по объёму, если закрытие из нескольких покупок.
  const queueKey = (t: Pick<LogicTradeRow, 'security_id' | 'action_name'>) =>
    `${t.security_id}:${t.action_name}`;
  const openQueue = new Map<string, Array<{ row: LogicTradeRow; rem: number }>>();
  const openById = new Map<number, { row: LogicTradeRow; rem: number }>();
  const opens = trades
    .filter(
      (t) =>
        !t.is_shadow &&
        !t.opt_lane &&
        t.side_name === 'Open' &&
        (t.status === 'filled' || t.status === 'submitted') &&
        Number(t.quantity) > 0
    )
    .sort((a, b) =>
      String(a.bar_dt || a.executed_at).localeCompare(String(b.bar_dt || b.executed_at))
    );
  for (const o of opens) {
    const k = queueKey(o);
    const q = openQueue.get(k);
    const item = { row: o, rem: Number(o.quantity) };
    if (q) q.push(item);
    else openQueue.set(k, [item]);
    openById.set(Number(o.id), item);
  }

  const out: ClosedDeal[] = [];
  for (const t of closes) {
    const lots = tradeLots?.get(t.id) ?? [];
    let openDt: string | null = null;
    let openBarDt: string | null = null;
    let openPrice: number | null = null;
    if (lots.length > 0) {
      const times = lots
        .map((l) => l.open_executed_at)
        .filter((x): x is string => !!x)
        .sort();
      openDt = times[0] ?? null;
      const barTimes = lots
        .map((l) => l.open_bar_dt)
        .filter((x): x is string => !!x)
        .sort();
      openBarDt = barTimes[0] ?? null;
      const withPrice = lots.find((l) => l.open_price != null);
      openPrice = withPrice?.open_price ?? null;
      // Списываем те же открытия из FIFO-очереди, чтобы не учитывались дважды.
      for (const l of lots) {
        const oid = Number(l.open_trade_id);
        const item = openById.get(oid);
        if (item && item.rem > 1e-9) {
          item.rem = Math.max(0, item.rem - Number(l.quantity));
        }
      }
    } else {
      // FIFO: списываем нужный объём с самой ранней открытой позиции.
      const q = openQueue.get(queueKey(t)) ?? [];
      let need = Number(t.quantity) || 0;
      const matched: Array<{ row: LogicTradeRow; qty: number }> = [];
      for (let i = 0; i < q.length && need > 1e-9; i++) {
        const item = q[i];
        const take = Math.min(item.rem, need);
        if (take > 1e-9) matched.push({ row: item.row, qty: take });
        item.rem -= take;
        need -= take;
      }
      if (matched.length > 0) {
        const barTimes = matched
          .map((m) => m.row.bar_dt || m.row.executed_at)
          .filter((x): x is string => !!x)
          .sort();
        openBarDt = barTimes[0] ?? null;
        openDt = openBarDt;
        const totalQty = matched.reduce((s, m) => s + m.qty, 0);
        if (totalQty > 1e-9) {
          openPrice =
            matched.reduce((s, m) => s + m.qty * (Number(m.row.price) || 0), 0) /
            totalQty;
        }
      }
    }
    const closeDt = t.bar_dt || t.executed_at;
    const closeBarDt = t.bar_dt || null;
    const openMs = parseDt(openDt);
    const closeMs = parseDt(closeDt);
    let holdMs: number | null = null;
    if (openMs != null && closeMs != null && closeMs >= openMs) {
      holdMs = closeMs - openMs;
    } else if (openBarDt && closeBarDt) {
      const openBarMs = parseDt(openBarDt);
      const closeBarMs = parseDt(closeBarDt);
      if (openBarMs != null && closeBarMs != null && closeBarMs >= openBarMs) {
        holdMs = closeBarMs - openBarMs;
      }
    }
    out.push({
      pnl: Number(t.financial_result),
      commission: num(t.commission),
      action: t.action_name === 'Short' ? 'Short' : 'Long',
      securityName: t.security_name || `#${t.security_id}`,
      securityPrefix: t.security_prefix ?? null,
      openDt,
      closeDt,
      holdMs,
      quantity: num(t.quantity),
      openPrice,
      closePrice: num(t.price),
    });
  }
  return out.sort((a, b) => String(a.closeDt).localeCompare(String(b.closeDt)));
}

function filterSide(deals: ClosedDeal[], side: ReportSide): ClosedDeal[] {
  if (side === 'long') return deals.filter((d) => d.action === 'Long');
  if (side === 'short') return deals.filter((d) => d.action === 'Short');
  return deals;
}

function maxStreak(deals: ClosedDeal[], win: boolean): number {
  let best = 0;
  let cur = 0;
  for (const d of deals) {
    const ok = win ? d.pnl > 0 : d.pnl < 0;
    if (ok) {
      cur += 1;
      if (cur > best) best = cur;
    } else {
      cur = 0;
    }
  }
  return best;
}

function maxDrawdownPct(
  deals: ClosedDeal[],
  initialBalance: number
): { pct: number; abs: number } {
  const start = initialBalance > 0 ? initialBalance : 1;
  let equity = start;
  let peak = start;
  let maxDdAbs = 0;
  let maxDdPct = 0;
  for (const d of deals) {
    equity += d.pnl;
    if (equity > peak) peak = equity;
    const ddAbs = peak - equity;
    if (ddAbs > maxDdAbs) {
      maxDdAbs = ddAbs;
      maxDdPct = peak > 0 ? (ddAbs / peak) * 100 : 0;
    }
  }
  return { pct: maxDdPct, abs: maxDdAbs };
}

function sharpeRatio(
  deals: ClosedDeal[],
  initialBalance: number,
  baseAnnualRatePct: number
): number {
  if (deals.length < 2) return 0;
  const start = initialBalance > 0 ? initialBalance : 1;
  const returns = deals.map((d) => (d.pnl / start) * 100);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const sd = Math.sqrt(variance);
  if (sd <= 0) return 0;

  const first = parseDt(deals[0].openDt || deals[0].closeDt);
  const last = parseDt(deals[deals.length - 1].closeDt);
  let rfr = 0;
  if (first != null && last != null && last > first && baseAnnualRatePct) {
    const days = (last - first) / (1000 * 60 * 60 * 24);
    rfr = (days / 365) * baseAnnualRatePct;
  }
  return (mean - rfr) / sd;
}

export function computeSideStats(
  deals: ClosedDeal[],
  initialBalance: number,
  baseAnnualRatePct: number,
  withMaxDrawdown: boolean,
  commissionPct = 0
): SideStats {
  const bal = initialBalance > 0 ? initialBalance : 0;
  const netPnl = deals.reduce((s, d) => s + d.pnl, 0);
  const commission = deals.reduce((s, d) => s + d.commission, 0);
  // Комиссия пропорциональна объёму сделок (только вариативная). Итог при ставке x:
  // gross - commission*(x/commissionPct), где gross = netPnl + commission.
  // Безубыток (итог = 0): x_be = commissionPct * gross / commission.
  const gross = netPnl + commission;
  let breakevenCommissionPct: number | null = null;
  if (commission > 0) {
    breakevenCommissionPct = (commissionPct * gross) / commission;
  } else if (gross > 0) {
    breakevenCommissionPct = commissionPct + 1;
  } else if (gross < 0) {
    breakevenCommissionPct = 0;
  } else {
    breakevenCommissionPct = commissionPct;
  }
  const wins = deals.filter((d) => d.pnl > 0);
  const losses = deals.filter((d) => d.pnl < 0);
  const sumWin = wins.reduce((s, d) => s + d.pnl, 0);
  const sumLoss = losses.reduce((s, d) => s + d.pnl, 0);
  let profitFactor = 0;
  if (sumWin > 0 && sumLoss < 0) {
    profitFactor = Math.abs(sumWin / sumLoss);
  } else if (sumWin > 0 && sumLoss === 0) {
    profitFactor = 0;
  }
  const payOffRatio =
    wins.length > 0 && losses.length > 0
      ? Math.abs(sumWin / wins.length) / Math.abs(sumLoss / losses.length)
      : 0;

  const holds = deals.map((d) => d.holdMs).filter((x): x is number => x != null);
  const avgHold =
    holds.length > 0 ? holds.reduce((a, b) => a + b, 0) / holds.length : null;

  const dd = withMaxDrawdown
    ? maxDrawdownPct(deals, bal > 0 ? bal : 1)
    : { pct: 0, abs: 0 };
  const recovery = withMaxDrawdown && dd.abs > 0 ? netPnl / dd.abs : 0;

  return {
    netPnl,
    netPnlPct: bal > 0 ? (netPnl / bal) * 100 : 0,
    dealCount: deals.length,
    avgHoldLabel: fmtHold(avgHold),
    sharpe: sharpeRatio(deals, bal > 0 ? bal : 1, baseAnnualRatePct),
    profitFactor: Number.isFinite(profitFactor) ? profitFactor : 0,
    recovery,
    avgPnl: deals.length ? netPnl / deals.length : 0,
    winCount: wins.length,
    winPct: deals.length ? (wins.length / deals.length) * 100 : 0,
    avgWin: wins.length ? sumWin / wins.length : 0,
    maxWinStreak: maxStreak(deals, true),
    lossCount: losses.length,
    lossPct: deals.length ? (losses.length / deals.length) * 100 : 0,
    avgLoss: losses.length ? sumLoss / losses.length : 0,
    maxLossStreak: maxStreak(deals, false),
    maxDrawdownPct: withMaxDrawdown ? dd.pct : null,
    commission,
    breakevenCommissionPct,
    payOffRatio,
  };
}

function equitySparklineSvg(
  trades: LogicTradeRow[],
  periodFrom: string | null | undefined
): string {
  const pts = buildEquityPoints(trades, periodFrom ?? null, null);
  if (pts.length < 2) {
    return `<div class="empty-chart">Недостаточно точек для графика эквити</div>`;
  }
  const w = 720;
  const h = 160;
  const pad = 8;
  const values = pts.map((p) => p.value);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const span = max - min || 1;
  const coords = pts.map((p, i) => {
    const x = pad + (i / (pts.length - 1)) * (w - pad * 2);
    const y = pad + (1 - (p.value - min) / span) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const zeroY = pad + (1 - (0 - min) / span) * (h - pad * 2);
  const last = values[values.length - 1];
  const stroke = last >= 0 ? '#16a34a' : '#dc2626';
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="Equity">
  <line x1="${pad}" y1="${zeroY.toFixed(1)}" x2="${w - pad}" y2="${zeroY.toFixed(1)}" stroke="#cbd5e1" stroke-dasharray="4 4"/>
  <polyline fill="none" stroke="${stroke}" stroke-width="2.5" points="${coords.join(' ')}"/>
</svg>`;
}

/* ============= Пер-бумажные блоки отчёта (#848) ============= */

/** Один источник закрытия (покупка/открытие шорта), из которого собралась продажа/cover. */
export interface PaperReportLotLink {
  openTradeId: number | null;
  openDt: string | null;
  openPrice: number | null;
  quantity: number;
  pnl: number;
  /** П/У по лоту распределён пропорционально объёму (FIFO-оценка, без реальных lots). */
  estimated: boolean;
}

/** Закрытие бумаги с раскладкой по исходным позициям (для «из какой покупки сделан финрез»). */
export interface PaperReportCloseRow {
  closeTradeId: number;
  /** Long — продажа ранее купленного; Short — покупка для покрытия шорта. */
  side: 'Long' | 'Short';
  closeDt: string;
  closePrice: number;
  quantity: number;
  totalPnl: number;
  commission: number;
  isShadow: boolean;
  sources: PaperReportLotLink[];
}

/** Линия индикатора для графика бумаги в отчёте. */
export interface PaperReportIndicatorSeries {
  indicator_code: string;
  line_code: string;
  line_name: string;
  color: string;
  on_price_scale: boolean;
  is_threshold: boolean;
  points: { dt: string; value: number }[];
}

/** Полные данные одного блока «бумага» в отчёте теста. */
export interface PaperReportChart {
  securityId: number;
  securityName: string;
  securityPrefix: string | null;
  timeframeLabel: string;
  candles: PriceCandle[];
  indicators: PaperReportIndicatorSeries[];
  trades: LogicTradeRow[];
  markers: ChartTradeMarker[];
  stops: ChartStopMarker[];
  shaded: ChartShadedRange[];
  equity: ChartEquityPoint[];
  equityShadow: ChartEquityPoint[];
  closes: PaperReportCloseRow[];
  pnl: number;
  dealCount: number;
  openQty: number;
  lastPrice: number | null;
  loadError: string | null;
}

/** FIFO-раскладка продаж по покупкам (и cover по шортам) для отчёта.
 *  Если lots для закрытия загружены — берём реальные лоты (финрез каждого).
 *  Иначе FIFO-оценка: продажа списывается с самых ранних открытий той же бумаги/стороны,
 *  П/У закрытия распределяется пропорционально объёму.
 */
export function buildPaperReportCloseRows(
  trades: LogicTradeRow[],
  tradeLots?: Map<number, LogicTradeLotRow[]>
): PaperReportCloseRow[] {
  const reportFilled = (t: LogicTradeRow) =>
    (t.status === 'filled' || t.status === 'submitted') &&
    !t.is_shadow &&
    !t.opt_lane;
  const byTime = (a: LogicTradeRow, b: LogicTradeRow) =>
    String(a.bar_dt || a.executed_at).localeCompare(String(b.bar_dt || b.executed_at));

  const opens = trades
    .filter((t) => reportFilled(t) && t.side_name === 'Open' && Number(t.quantity) > 0)
    .sort(byTime);
  const closes = trades
    .filter(
      (t) =>
        reportFilled(t) &&
        t.side_name === 'Close' &&
        t.financial_result != null &&
        Number.isFinite(Number(t.financial_result))
    )
    .sort(byTime);

  const queueKey = (t: Pick<LogicTradeRow, 'security_id' | 'action_name'>) =>
    `${t.security_id}:${t.action_name}`;
  const openQueue = new Map<string, Array<{ row: LogicTradeRow; rem: number }>>();
  const openById = new Map<number, { row: LogicTradeRow; rem: number }>();
  for (const o of opens) {
    const item = { row: o, rem: Number(o.quantity) };
    openById.set(Number(o.id), item);
    const k = queueKey(o);
    const q = openQueue.get(k);
    if (q) q.push(item);
    else openQueue.set(k, [item]);
  }

  const out: PaperReportCloseRow[] = [];
  for (const t of closes) {
    const lots = tradeLots?.get(t.id) ?? [];
    let sources: PaperReportLotLink[] = [];
    const closeQty = Number(t.quantity) || 1;
    const pnlTotal = Number(t.financial_result);

    if (lots.length > 0) {
      sources = lots.map((l) => {
        const oid = Number(l.open_trade_id);
        const o = openById.get(oid);
        return {
          openTradeId: Number.isInteger(oid) && oid > 0 ? oid : null,
          openDt:
            l.open_bar_dt ||
            l.open_executed_at ||
            (o?.row ? o.row.bar_dt || o.row.executed_at : null) ||
            null,
          openPrice:
            l.open_price != null
              ? Number(l.open_price)
              : o?.row && Number(o.row.price) > 0
                ? Number(o.row.price)
                : null,
          quantity: Number(l.quantity),
          pnl: Number(l.financial_result),
          estimated: false,
        };
      });
      for (const l of lots) {
        const oid = Number(l.open_trade_id);
        const item = openById.get(oid);
        if (item && item.rem > 1e-9) {
          item.rem = Math.max(0, item.rem - Number(l.quantity));
        }
      }
    } else {
      const q = openQueue.get(queueKey(t)) ?? [];
      let need = closeQty;
      const matched: Array<{ row: LogicTradeRow; qty: number }> = [];
      for (let i = 0; i < q.length && need > 1e-9; i++) {
        const item = q[i];
        const take = Math.min(item.rem, need);
        if (take > 1e-9) matched.push({ row: item.row, qty: take });
        item.rem -= take;
        need -= take;
      }
      if (matched.length > 0) {
        const matchedQty = matched.reduce((s, m) => s + m.qty, 0) || closeQty;
        sources = matched.map((m) => ({
          openTradeId: Number(m.row.id) || null,
          openDt: m.row.bar_dt || m.row.executed_at,
          openPrice: Number(m.row.price) > 0 ? Number(m.row.price) : null,
          quantity: m.qty,
          pnl: pnlTotal * (m.qty / matchedQty),
          estimated: true,
        }));
      } else {
        // Закрытие без найденного открытия (остаток с предыдущих периодов).
        sources = [
          {
            openTradeId: null,
            openDt: null,
            openPrice: null,
            quantity: closeQty,
            pnl: pnlTotal,
            estimated: false,
          },
        ];
      }
    }

    out.push({
      closeTradeId: Number(t.id),
      side: t.action_name === 'Short' ? 'Short' : 'Long',
      closeDt: t.bar_dt || t.executed_at,
      closePrice: Number(t.price),
      quantity: closeQty,
      totalPnl: pnlTotal,
      commission: num(t.commission),
      isShadow: !!t.is_shadow,
      sources,
    });
  }
  return out;
}

const PAPER_SERIES_COLORS = [
  '#2563eb',
  '#9333ea',
  '#ea580c',
  '#0891b2',
  '#ca8a04',
  '#db2777',
  '#059669',
  '#4f46e5',
];
const PAPER_PRICE_SCALE_CODES = new Set(['SMA', 'EMA', 'WMA', 'PACC', 'SMAT3']);

/** Серии индикаторов для графика бумаги (то же деление price-scale/osc, что на графике бумаги). */
export function buildPaperIndicatorSeries(
  values: IndicatorValueRow[]
): PaperReportIndicatorSeries[] {
  const groups = new Map<string, IndicatorValueRow[]>();
  for (const v of values) {
    const key = `${v.indicator_id}:${v.line_code}`;
    const list = groups.get(key) ?? [];
    list.push(v);
    groups.set(key, list);
  }
  const series: PaperReportIndicatorSeries[] = [];
  let colorIdx = 0;
  for (const rows of groups.values()) {
    const sample = rows[0];
    if (!sample) continue;
    const onPrice =
      (PAPER_PRICE_SCALE_CODES.has(sample.indicator_code) && sample.line_code === 'VALUE') ||
      ['UPPER', 'MIDDLE', 'LOWER'].includes(sample.line_code);
    series.push({
      indicator_code: sample.indicator_code,
      line_code: sample.line_code,
      line_name: sample.line_name,
      color: PAPER_SERIES_COLORS[colorIdx % PAPER_SERIES_COLORS.length],
      on_price_scale: onPrice,
      is_threshold: !!sample.is_threshold,
      points: rows.map((r) => ({ dt: r.dt, value: Number(r.value) })),
    });
    if (!sample.is_threshold) colorIdx += 1;
  }
  return series;
}

function paperDtMs(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const t = Date.parse(String(raw).replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
}

function fmtAxisNum(v: number): string {
  if (Math.abs(v) >= 1000) return fmtNum(v, 0);
  if (Math.abs(v) >= 100) return fmtNum(v, 1);
  return fmtNum(v, 2);
}

function fmtAxisDt(ms: number): string {
  return new Date(ms).toLocaleString('ru-RU', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface PaperChartGeometry {
  w: number;
  h: number;
  padL: number;
  padR: number;
  priceTop: number;
  priceH: number;
  priceBottom: number;
  oscTop: number;
  oscH: number;
  oscBottom: number;
  pnlTop: number;
  pnlH: number;
  pnlBottom: number;
  hasOsc: boolean;
}

function paperChartGeometry(hasOsc: boolean): PaperChartGeometry {
  const padL = 58;
  const padR = 20;
  const padT = 8;
  const gap = 8;
  const priceH = 300;
  const oscH = hasOsc ? 110 : 0;
  const pnlH = 126;
  const priceTop = padT;
  const priceBottom = priceTop + priceH;
  const oscTop = priceBottom + gap;
  const oscBottom = oscTop + oscH;
  const pnlTop = oscH > 0 ? oscBottom + gap : priceBottom + gap;
  const pnlBottom = pnlTop + pnlH;
  const h = pnlBottom + 16;
  return {
    w: 960,
    h,
    padL,
    padR,
    priceTop,
    priceH,
    priceBottom,
    oscTop,
    oscH,
    oscBottom,
    pnlTop,
    pnlH,
    pnlBottom,
    hasOsc,
  };
}

function paperTimeDomain(chart: PaperReportChart): { t0: number; t1: number } {
  const ms: number[] = [];
  const push = (raw: string | null | undefined) => {
    const t = paperDtMs(raw);
    if (t != null) ms.push(t);
  };
  for (const c of chart.candles) push(c.dt);
  for (const m of chart.markers) push(m.dt);
  for (const s of chart.stops) push(s.dt);
  for (const r of chart.shaded) {
    push(r.startDt);
    push(r.endDt);
  }
  for (const p of chart.equity) push(p.dt);
  for (const t of chart.trades) push(t.bar_dt || t.executed_at);
  if (ms.length === 0) return { t0: 0, t1: 1 };
  let t0 = Math.min(...ms);
  let t1 = Math.max(...ms);
  if (t1 <= t0) t1 = t0 + 24 * 60 * 60 * 1000;
  return { t0, t1 };
}

function paperValueRange(values: number[]): { min: number; max: number } {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return { min: 0, max: 1 };
  let min = Math.min(...finite);
  let max = Math.max(...finite);
  if (max === min) {
    max += 1;
    min -= 1;
  }
  const pad = (max - min) * 0.06;
  return { min: min - pad, max: max + pad };
}

function paperPriceRange(chart: PaperReportChart): { min: number; max: number } {
  const v: number[] = [];
  for (const c of chart.candles) {
    v.push(Number(c.low_price), Number(c.high_price), Number(c.open_price), Number(c.close_price));
  }
  for (const s of chart.indicators) {
    if (!s.on_price_scale) continue;
    for (const p of s.points) v.push(Number(p.value));
  }
  for (const m of chart.markers) v.push(Number(m.price));
  for (const s of chart.stops) v.push(Number(s.price));
  return paperValueRange(v);
}

function paperOscRange(chart: PaperReportChart): { min: number; max: number } {
  const v: number[] = [];
  for (const s of chart.indicators) {
    if (s.on_price_scale) continue;
    for (const p of s.points) v.push(Number(p.value));
  }
  return paperValueRange(v);
}

function paperPnlRange(chart: PaperReportChart): { min: number; max: number } {
  const v: number[] = [0];
  for (const p of chart.equity) v.push(p.value);
  for (const p of chart.equityShadow) v.push(p.value);
  return paperValueRange(v);
}

function shadeColors(
  kind: ChartShadedRange['kind']
): { fill: string; stroke: string; label: string } {
  switch (kind) {
    case 'inverted':
      return { fill: 'rgba(251, 207, 232, 0.45)', stroke: 'rgba(244, 114, 182, 0.4)', label: '#9d1b4d' };
    case 'long':
      return { fill: 'rgba(134, 239, 172, 0.28)', stroke: 'rgba(74, 222, 128, 0.3)', label: '#15803d' };
    case 'short':
      return { fill: 'rgba(252, 165, 165, 0.28)', stroke: 'rgba(248, 113, 113, 0.3)', label: '#b91c1c' };
    case 'shadow':
    case 'paused':
      return { fill: 'rgba(203, 213, 225, 0.55)', stroke: 'rgba(148, 163, 184, 0.55)', label: '#334155' };
    default:
      return { fill: 'rgba(187, 247, 208, 0.4)', stroke: 'rgba(74, 222, 128, 0.4)', label: '#15803d' };
  }
}

/** Полосы режима бумаги в вертикальной полосе (цена / эквити). */
function paperShadeRects(
  chart: PaperReportChart,
  xOf: (t: number) => number,
  top: number,
  height: number,
  t0: number,
  t1: number,
  padL: number,
  padR: number,
  w: number
): string {
  const out: string[] = [];
  for (const r of chart.shaded) {
    const a = paperDtMs(r.startDt);
    const b = paperDtMs(r.endDt);
    if (a == null || b == null) continue;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (hi < t0 || lo > t1) continue;
    const x0 = xOf(Math.max(lo, t0));
    const x1 = xOf(Math.min(hi, t1));
    const c = shadeColors(r.kind);
    const width = Math.max(2, x1 - x0);
    out.push(`<rect x="${x0.toFixed(1)}" y="${top}" width="${width.toFixed(1)}" height="${height}" fill="${c.fill}"/>`);
    out.push(`<rect x="${x0.toFixed(1)}" y="${top}" width="${width.toFixed(1)}" height="${height}" fill="none" stroke="${c.stroke}" stroke-dasharray="3 3"/>`);
    if (r.label) {
      const lx = Math.min(x0 + 4, w - padR - 120);
      out.push(`<text x="${lx.toFixed(1)}" y="${(top + 13).toFixed(1)}" font-size="10" font-weight="600" fill="${c.label}">${esc(r.label)}</text>`);
    }
  }
  return out.join('');
}

/** Горизонтальная сетка с подписями значений. */
function paperGrid(
  range: { min: number; max: number },
  yOf: (v: number) => number,
  top: number,
  bottom: number,
  padL: number,
  padR: number,
  w: number,
  formatter: (v: number) => string
): string {
  const out: string[] = [];
  const n = 5;
  for (let i = 0; i < n; i++) {
    const v = range.min + ((range.max - range.min) * i) / (n - 1);
    const y = yOf(v);
    if (y < top || y > bottom) continue;
    out.push(`<line x1="${padL}" y1="${y.toFixed(1)}" x2="${w - padR}" y2="${y.toFixed(1)}" stroke="#e2e8f0"/>`);
    out.push(`<text x="${(padL - 6).toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="#64748b">${formatter(v)}</text>`);
  }
  return out.join('');
}

function paperXAxis(
  t0: number,
  t1: number,
  xOf: (t: number) => number,
  y: number,
  padL: number,
  padR: number,
  w: number
): string {
  const out: string[] = [];
  const n = 5;
  for (let i = 0; i < n; i++) {
    const t = t0 + ((t1 - t0) * i) / (n - 1);
    const x = xOf(t);
    out.push(`<text x="${x.toFixed(1)}" y="${y}" text-anchor="middle" font-size="10" fill="#64748b">${esc(fmtAxisDt(t))}</text>`);
  }
  return out.join('');
}

function paperCandleBody(
  chart: PaperReportChart,
  xOf: (t: number) => number,
  yOf: (v: number) => number,
  padL: number,
  padR: number,
  w: number,
  priceTop: number,
  priceBottom: number
): string {
  const candles = chart.candles;
  if (candles.length === 0) {
    return `<text x="${(padL + (w - padL - padR) / 2).toFixed(1)}" y="${((priceTop + priceBottom) / 2).toFixed(1)}" text-anchor="middle" font-size="12" fill="#94a3b8">Нет цен для графика</text>`;
  }
  const stepX = (w - padL - padR) / Math.max(1, candles.length - 1);
  const bw = Math.max(1.6, stepX * 0.62);
  const out: string[] = [];
  for (const c of candles) {
    const x = xOf(paperDtMs(c.dt) ?? 0);
    const hi = yOf(Number(c.high_price));
    const lo = yOf(Number(c.low_price));
    const o = yOf(Number(c.open_price));
    const cl = yOf(Number(c.close_price));
    const up = Number(c.close_price) >= Number(c.open_price);
    const color = up ? '#16a34a' : '#dc2626';
    const bodyTop = Math.min(o, cl);
    const bodyH = Math.max(Math.abs(o - cl), 1);
    out.push(`<line x1="${x.toFixed(1)}" y1="${hi.toFixed(1)}" x2="${x.toFixed(1)}" y2="${lo.toFixed(1)}" stroke="${color}"/>`);
    out.push(`<rect x="${(x - bw / 2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${bw.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${color}"/>`);
  }
  return out.join('');
}

function paperLineBody(
  chart: PaperReportChart,
  xOf: (t: number) => number,
  yOf: (v: number) => number,
  padL: number,
  padR: number,
  w: number,
  priceTop: number,
  priceBottom: number
): string {
  const candles = chart.candles;
  if (candles.length === 0) {
    return `<text x="${(padL + (w - padL - padR) / 2).toFixed(1)}" y="${((priceTop + priceBottom) / 2).toFixed(1)}" text-anchor="middle" font-size="12" fill="#94a3b8">Нет цен для графика</text>`;
  }
  const pts = candles
    .map((c) => {
      const t = paperDtMs(c.dt);
      const v = Number(c.close_price);
      if (t == null || !Number.isFinite(v)) return null;
      return `${xOf(t).toFixed(1)},${yOf(v).toFixed(1)}`;
    })
    .filter((p): p is string => p != null);
  if (pts.length < 2) return '';
  return `<polyline fill="none" stroke="#0f172a" stroke-width="1.6" points="${pts.join(' ')}"/>`;
}

function paperIndicatorLines(
  chart: PaperReportChart,
  xOf: (t: number) => number,
  yOf: (v: number) => number,
  onPrice: boolean
): string {
  const out: string[] = [];
  for (const s of chart.indicators) {
    if (s.on_price_scale !== onPrice) continue;
    const pts = s.points
      .map((p) => {
        const t = paperDtMs(p.dt);
        if (t == null || !Number.isFinite(p.value)) return null;
        return `${xOf(t).toFixed(1)},${yOf(Number(p.value)).toFixed(1)}`;
      })
      .filter((p): p is string => p != null);
    if (pts.length < 2) continue;
    const dash = s.is_threshold ? ' stroke-dasharray="4 4"' : '';
    out.push(`<polyline fill="none" stroke="${s.color}" stroke-width="${s.is_threshold ? 1 : 1.5}"${dash} points="${pts.join(' ')}"/>`);
  }
  return out.join('');
}

function paperTradeMarkers(
  chart: PaperReportChart,
  xOf: (t: number) => number,
  yOf: (v: number) => number,
  priceTop: number,
  priceBottom: number
): string {
  const out: string[] = [];
  for (const m of chart.markers) {
    const t = paperDtMs(m.dt);
    if (t == null || !Number.isFinite(m.price)) continue;
    const x = xOf(t);
    const y = yOf(Number(m.price));
    const isOpen = m.kind === 'open';
    const isLong = m.side === 'long';
    const color = m.isShadow
      ? '#94a3b8'
      : isOpen
        ? isLong
          ? '#16a34a'
          : '#dc2626'
        : isLong
          ? '#15803d'
          : '#b91c1c';
    out.push(`<line x1="${x.toFixed(1)}" y1="${priceTop}" x2="${x.toFixed(1)}" y2="${priceBottom}" stroke="${color}" stroke-opacity="${m.isShadow ? 0.16 : 0.28}" stroke-width="2"/>`);
    const size = 9;
    const flap = Math.round(size * 0.78);
    const base = Math.round(size * 0.66);
    const points = isOpen
      ? `${x},${y - size} ${x - flap},${y + base} ${x + flap},${y + base}`
      : `${x},${y + size} ${x - flap},${y - base} ${x + flap},${y - base}`;
    out.push(`<polygon points="${points}" fill="${color}" stroke="#0f172a" stroke-width="0.8" stroke-opacity="${m.isShadow ? 0.6 : 1}"/>`);
  }
  return out.join('');
}

function paperStopMarkers(
  chart: PaperReportChart,
  xOf: (t: number) => number,
  yOf: (v: number) => number,
  padL: number,
  padR: number,
  w: number,
  priceTop: number,
  priceBottom: number
): string {
  const out: string[] = [];
  for (const m of chart.stops) {
    const t = paperDtMs(m.dt);
    if (t == null || !Number.isFinite(m.price)) continue;
    const x = xOf(t);
    const y = yOf(Number(m.price));
    const color = m.ruleKind === 'take_profit' ? '#059669' : '#dc2626';
    const tag = m.ruleKind === 'take_profit' ? 'TP' : 'SL';
    out.push(`<line x1="${x.toFixed(1)}" y1="${priceTop}" x2="${x.toFixed(1)}" y2="${priceBottom}" stroke="${color}" stroke-opacity="0.35" stroke-width="2"/>`);
    out.push(`<line x1="${padL}" y1="${y.toFixed(1)}" x2="${w - padR}" y2="${y.toFixed(1)}" stroke="${color}" stroke-width="1.5" stroke-dasharray="5 3"/>`);
    const label = `${tag} ${m.label || ''}`.trim();
    const ly = Math.max(priceTop + 10, y - 4).toFixed(1);
    out.push(`<text x="${(x + 4).toFixed(1)}" y="${ly}" font-size="10" font-weight="600" fill="${color}">${esc(label)}</text>`);
  }
  return out.join('');
}

function paperOscPanel(
  chart: PaperReportChart,
  xOf: (t: number) => number,
  yOf: (v: number) => number,
  w: number,
  g: PaperChartGeometry
): string {
  if (!g.hasOsc) return '';
  const out: string[] = [];
  out.push(`<rect x="${g.padL}" y="${g.oscTop}" width="${w - g.padL - g.padR}" height="${g.oscH}" fill="#fbfbfe"/>`);
  const oscRange = paperOscRange(chart);
  out.push(
    paperGrid(
      oscRange,
      yOf,
      g.oscTop,
      g.oscBottom,
      g.padL,
      g.padR,
      w,
      paperOscLabel
    )
  );
  const zeroY = yOf(0);
  if (zeroY >= g.oscTop && zeroY <= g.oscBottom) {
    out.push(`<line x1="${g.padL}" y1="${zeroY.toFixed(1)}" x2="${w - g.padR}" y2="${zeroY.toFixed(1)}" stroke="#cbd5e1" stroke-dasharray="4 4"/>`);
  }
  out.push(paperIndicatorLines(chart, xOf, yOf, false));
  out.push(`<text x="${(g.padL + 4).toFixed(1)}" y="${(g.oscTop + 14).toFixed(1)}" font-size="10" font-weight="700" fill="#6b7280">OSC</text>`);
  return out.join('');
}

function paperOscLabel(v: number): string {
  return fmtAxisNum(v);
}

function paperPnlPanel(
  chart: PaperReportChart,
  xOf: (t: number) => number,
  yOf: (v: number) => number,
  w: number,
  g: PaperChartGeometry,
  t0: number,
  t1: number
): string {
  const out: string[] = [];
  out.push(`<rect x="${g.padL}" y="${g.pnlTop}" width="${w - g.padL - g.padR}" height="${g.pnlH}" fill="#f5f3ff"/>`);
  out.push(`<line x1="${g.padL}" y1="${g.pnlTop + 0.5}" x2="${w - g.padR}" y2="${g.pnlTop + 0.5}" stroke="#ddd6fe"/>`);
  out.push(paperShadeRects(chart, xOf, g.pnlTop, g.pnlH, t0, t1, g.padL, g.padR, w));
  const zeroY = yOf(0);
  if (zeroY >= g.pnlTop && zeroY <= g.pnlBottom) {
    out.push(`<line x1="${g.padL}" y1="${zeroY.toFixed(1)}" x2="${w - g.padR}" y2="${zeroY.toFixed(1)}" stroke="#c4b5fd" stroke-dasharray="4 4"/>`);
  }
  const line = (pts: ChartEquityPoint[], stroke: string, width: number, dash: string): string => {
    if (pts.length < 2) return '';
    const coords = pts
      .map((p) => {
        const t = paperDtMs(p.dt);
        if (t == null || !Number.isFinite(p.value)) return null;
        return `${xOf(t).toFixed(1)},${yOf(p.value).toFixed(1)}`;
      })
      .filter((p): p is string => p != null);
    if (coords.length < 2) return '';
    return `<polyline fill="none" stroke="${stroke}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''} points="${coords.join(' ')}"/>`;
  };
  // Теневая эквити — под основной (пунктир).
  out.push(line(chart.equityShadow, '#a78bfa', 2, '5 3'));
  // Эквити бумаги — жирная линия (требование #848).
  out.push(line(chart.equity, '#7c3aed', 3, ''));
  out.push(`<text x="${(g.padL + 4).toFixed(1)}" y="${(g.pnlTop + 13).toFixed(1)}" font-size="10" font-weight="700" fill="#7c3aed">PnL</text>`);
  const last = chart.equity[chart.equity.length - 1];
  if (last && Number.isFinite(last.value)) {
    out.push(`<text x="${(w - g.padR - 2).toFixed(1)}" y="${(g.pnlTop + 13).toFixed(1)}" text-anchor="end" font-size="10" font-weight="600" fill="#6d28d9">${fmtMoney(last.value)}</text>`);
  }
  // Подписи шкалы PnL (мин/макс слева).
  const pnl = paperPnlRange(chart);
  out.push(`<text x="${(g.padL - 6).toFixed(1)}" y="${(g.pnlTop + 10).toFixed(1)}" text-anchor="end" font-size="9" fill="#6d28d9">${fmtMoney(pnl.max)}</text>`);
  out.push(`<text x="${(g.padL - 6).toFixed(1)}" y="${(g.pnlBottom - 4).toFixed(1)}" text-anchor="end" font-size="9" fill="#6d28d9">${fmtMoney(pnl.min)}</text>`);
  return out.join('');
}

/** SVG-варианты ценового графика бумаги: свечи и линия (общая цена и ось времени). */
function paperChartSvgPair(chart: PaperReportChart): { candle: string; line: string } {
  const hasOsc = chart.indicators.some((s) => !s.on_price_scale);
  const g = paperChartGeometry(hasOsc);
  const { t0, t1 } = paperTimeDomain(chart);
  const price = paperPriceRange(chart);
  const pnl = paperPnlRange(chart);
  const plotW = g.w - g.padL - g.padR;
  const xOf = (t: number) => (t1 > t0 ? g.padL + ((t - t0) / (t1 - t0)) * plotW : g.padL + plotW / 2);
  const priceYOf = (v: number) =>
    g.priceTop + ((price.max - v) / (price.max - price.min)) * g.priceH;
  const oscYOf = (v: number) => {
    const r = paperOscRange(chart);
    return g.oscTop + ((r.max - v) / (r.max - r.min || 1)) * g.oscH;
  };
  const pnlYOf = (v: number) =>
    g.pnlTop + ((pnl.max - v) / (pnl.max - pnl.min || 1)) * g.pnlH;

  // Общие слои как строки; тело цены вставляется через sentinel <!--BODY-->.
  const shared = (): string => {
    const out: string[] = [];
    out.push(`<rect x="${g.padL}" y="${g.priceTop}" width="${plotW}" height="${g.priceH}" fill="#f8fafc"/>`);
    out.push(paperGrid(price, priceYOf, g.priceTop, g.priceBottom, g.padL, g.padR, g.w, fmtAxisNum));
    out.push(paperShadeRects(chart, xOf, g.priceTop, g.priceH, t0, t1, g.padL, g.padR, g.w));
    out.push(`<!--BODY-->`);
    out.push(paperOscPanel(chart, xOf, oscYOf, g.w, g));
    out.push(paperPnlPanel(chart, xOf, pnlYOf, g.w, g, t0, t1));
    out.push(paperXAxis(t0, t1, xOf, g.h - 6, g.padL, g.padR, g.w));
    return out.join('');
  };
  const overlays = (): string => {
    const out: string[] = [];
    out.push(paperIndicatorLines(chart, xOf, priceYOf, true));
    out.push(paperTradeMarkers(chart, xOf, priceYOf, g.priceTop, g.priceBottom));
    out.push(paperStopMarkers(chart, xOf, priceYOf, g.padL, g.padR, g.w, g.priceTop, g.priceBottom));
    return out.join('');
  };

  const candle = paperCandleBody(chart, xOf, priceYOf, g.padL, g.padR, g.w, g.priceTop, g.priceBottom);
  const line = paperLineBody(chart, xOf, priceYOf, g.padL, g.padR, g.w, g.priceTop, g.priceBottom);
  const parts = shared().split('<!--BODY-->');
  const render = (body: string): string => `<svg viewBox="0 0 ${g.w} ${g.h}" width="100%" height="auto" role="img" class="paper-svg">
${parts[0]}${body}${parts[1]}
${overlays()}
</svg>`;

  return { candle: render(candle), line: render(line) };
}

/** Легенда графика бумаги (цвета индикаторов + эквити). */
function paperChartLegend(chart: PaperReportChart): string {
  const items: string[] = [];
  for (const s of chart.indicators) {
    const name = `${s.indicator_code}${
      s.line_code && s.line_code !== 'VALUE' ? '/' + s.line_code : ''
    } ${s.line_name || ''}`.trim();
    const swatch = s.is_threshold
      ? `<span class="pl-swatch thr" style="background-image:repeating-linear-gradient(90deg,${s.color} 0 4px,transparent 4px 8px)"></span>`
      : `<span class="pl-swatch" style="background:${s.color}"></span>`;
    items.push(`${swatch}<span>${esc(name)}</span>`);
  }
  if (chart.equity.length >= 2) {
    items.push(`<span class="pl-swatch" style="background:#7c3aed"></span><span>Эквити бумаги</span>`);
  }
  if (chart.equityShadow.length >= 2) {
    items.push(`<span class="pl-swatch thr" style="background-image:repeating-linear-gradient(90deg,#a78bfa 0 4px,transparent 4px 8px)"></span><span>Эквити shadow</span>`);
  }
  if (items.length === 0) return '';
  return `<div class="pchart-legend">${items.join('<span class="pl-sep"></span>')}</div>`;
}

function paperFifoRows(closes: PaperReportCloseRow[]): string {
  if (closes.length === 0) {
    return `<tr><td colspan="5" class="muted">Нет закрытых сделок</td></tr>`;
  }
  const out: string[] = [];
  for (const c of closes) {
    const op = c.side === 'Long' ? 'Продажа' : 'Закрытие шорта';
    const pnlCls = c.totalPnl >= 0 ? 'pos' : 'neg';
    out.push(`<tr class="pf-close">
      <td>${esc(c.closeDt.slice(0, 19).replace('T', ' '))}</td>
      <td>${esc(op)}</td>
      <td class="num">${esc(fmtAxisNum(c.closePrice))}</td>
      <td class="num">${esc(fmtNum(c.quantity, 0))}</td>
      <td class="num ${pnlCls}">${esc(fmtMoney(c.totalPnl))}</td>
    </tr>`);
    if (c.sources.length === 0) {
      out.push(`<tr class="pf-src"><td colspan="5">—</td></tr>`);
    }
    for (const s of c.sources) {
      const src = s.estimated ? '~ из' : 'из';
      const when = s.openDt ? ` · ${String(s.openDt).slice(0, 19).replace('T', ' ')}` : '';
      const px = s.openPrice != null ? ` · цена ${fmtAxisNum(s.openPrice)}` : '';
      const idBit = s.openTradeId != null ? `№${s.openTradeId}` : 'внешний остаток';
      const spnl = s.estimated ? `~${fmtMoney(s.pnl)}` : fmtMoney(s.pnl);
      const spnlCls = s.pnl >= 0 ? 'pos' : 'neg';
      out.push(`<tr class="pf-src">
        <td colspan="2"><span class="pf-arrow">↳ </span>${src} ${esc(idBit)}${esc(when)}${esc(px)}</td>
        <td class="num">—</td>
        <td class="num">${esc(fmtNum(s.quantity, 0))}</td>
        <td class="num ${spnlCls}">${esc(spnl)}</td>
      </tr>`);
    }
  }
  return out.join('');
}

/** HTML-блок одной бумаги: header со сводкой, график (свечи/линия), FIFO-таблица. */
function paperChartBlockHtml(chart: PaperReportChart, index: number): string {
  const pair = paperChartSvgPair(chart);
  const prefix = chart.securityPrefix && chart.securityPrefix.trim()
    ? chart.securityPrefix.trim()
    : chart.securityName;
  const nameId = `${prefix}${chart.securityName !== prefix ? ' ' + chart.securityName : ''} (${chart.securityId})`;
  const pnlCls = chart.pnl >= 0 ? 'pos' : 'neg';
  const hasData =
    chart.candles.length > 0 ||
    chart.markers.length > 0 ||
    chart.equity.length >= 2 ||
    chart.trades.length > 0;
  const tintf = chart.timeframeLabel ? ` · ${esc(chart.timeframeLabel)}` : '';
  const metaBits = [
    `сделок: ${chart.dealCount}`,
    `открыто: ${chart.openQty > 0 ? '+' : ''}${chart.openQty}`,
    `П/У: <span class="${pnlCls}">${fmtMoney(chart.pnl)}</span>`,
  ];
  if (chart.lastPrice != null) metaBits.push(`цена: ${fmtAxisNum(chart.lastPrice)}`);
  const body = hasData
    ? `<div class="pchart-toolbar no-print">
        <label class="pchart-toggle" title="Свечной график или линия закрытий">
          <input type="checkbox" id="ppt-${index}" checked onchange="swapReportChart('ppc-${index}','ppl-${index}','ppt-${index}')"/>
          Свечной график
        </label>
      </div>
      <div class="chart paper-chart">
        ${pair.candle.replace('<svg ', `<svg id="ppc-${index}" `)}
        ${pair.line.replace('<svg ', `<svg id="ppl-${index}" style="display:none" `)}
        ${paperChartLegend(chart)}
      </div>`
    : `<p class="muted">Нет данных для графика.</p>`;

  const priceErr = chart.loadError
    ? `<p class="muted paper-hint">⚠ ${esc(chart.loadError)}</p>`
    : '';

  const fifoNote = chart.closes.some((c) => c.sources.some((s) => s.estimated))
    ? `<p class="muted paper-hint">П/У по строкам «~» распределён пропорционально объёму (FIFO-оценка, если лоты не загружены).</p>`
    : '';

  return `<details class="paper-report" open>
  <summary class="paper-head">
    <span class="paper-head-name">${esc(nameId)}<span class="paper-tf">${tintf}</span></span>
    <span class="paper-meta">${metaBits.join(' · ')}</span>
  </summary>
  <div class="paper-body">
    ${body}
    ${priceErr}
    <h3>Сделки бумаги · из какой позиции закрыта (FIFO)</h3>
    <table class="deals paper-fifo">
      <thead><tr><th>Закрытие</th><th>Операция</th><th>Цена</th><th>Кол-во</th><th>П/У</th></tr></thead>
      <tbody>${paperFifoRows(chart.closes)}</tbody>
    </table>
    ${fifoNote}
  </div>
</details>`;
}

function paperChartsSectionHtml(charts: PaperReportChart[]): string {
  if (!charts.length) return '';
  const blocks = charts.map((c, i) => paperChartBlockHtml(c, i)).join('\n');
  return `<section class="papers-report">
  <h2>Бумаги — графики и сделки</h2>
  ${blocks}
</section>`;
}

function formatParamMap(
  params: Record<string, number | string> | null | undefined
): string {
  if (!params || typeof params !== 'object') return '—';
  const keys = Object.keys(params).sort();
  if (keys.length === 0) return '—';
  return keys.map((k) => `${k}=${params[k]}`).join(', ');
}

function formatOptSpecs(
  specs: Record<string, { base?: number; pct?: number }> | null | undefined
): string {
  if (!specs || typeof specs !== 'object') return '';
  const keys = Object.keys(specs).sort();
  if (keys.length === 0) return '';
  return keys
    .map((k) => {
      const s = specs[k] || {};
      const pct = s.pct != null ? `±${s.pct}%` : '';
      const base = s.base != null ? String(s.base) : '?';
      return `${k}=${base}${pct ? ` (${pct})` : ''}`;
    })
    .join(', ');
}

function formatParamChange(ev: ParamHistoryEvent): string {
  if (ev.event_kind === 'promote' && ev.params_prev && ev.params) {
    const keys = new Set([
      ...Object.keys(ev.params_prev),
      ...Object.keys(ev.params),
    ]);
    const parts: string[] = [];
    for (const k of [...keys].sort()) {
      const a = ev.params_prev[k];
      const b = ev.params[k];
      if (a != null && b != null && String(a) !== String(b)) {
        parts.push(`${k}: ${a} → ${b}`);
      } else if (b != null) {
        parts.push(`${k}=${b}`);
      }
    }
    return parts.length ? parts.join(', ') : formatParamMap(ev.params);
  }
  const optLine = formatOptSpecs(ev.opt_specs);
  const baseLine = formatParamMap(ev.params);
  if (optLine && baseLine && optLine !== baseLine) {
    return `${baseLine}; OPT: ${optLine}`;
  }
  return optLine || baseLine;
}

function paramHistorySectionHtml(history: ParamHistoryEvent[]): string {
  const rows = (history || []).map((ev) => {
    const when = ev.bar_dt || ev.created_at || '—';
    const kind =
      ev.event_kind === 'promote'
        ? 'Promote'
        : ev.event_kind === 'snapshot'
          ? 'Снимок'
          : String(ev.event_kind || '—');
    const fin =
      ev.event_kind === 'promote' &&
      (ev.winner_finres != null || ev.champion_finres != null)
        ? `${fmtNum(num(ev.winner_finres), 2)} > ${fmtNum(num(ev.champion_finres), 2)}`
        : '—';
    const formulas = Array.isArray(ev.formulas)
      ? ev.formulas
          .map((f) => (f?.formula ? esc(String(f.formula)) : ''))
          .filter(Boolean)
          .slice(0, 4)
          .join('<br/>')
      : '';
    return `<tr>
      <td class="num">${esc(String(when).slice(0, 19).replace('T', ' '))}</td>
      <td>${esc(kind)}</td>
      <td>${esc(ev.lane || '—')}</td>
      <td>${esc(formatParamChange(ev))}</td>
      <td class="num">${esc(fin)}</td>
    </tr>${
      formulas
        ? `<tr class="formula-row"><td colspan="5" class="muted formulas">${formulas}</td></tr>`
        : ''
    }`;
  });

  if (!rows.length) {
    return `<section>
      <h2>Параметры сигналов / OPT</h2>
      <p class="muted">Нет данных по параметрам формул.</p>
    </section>`;
  }

  const note = history.some((h) => h.event_kind === 'promote')
    ? 'История смен баз OPT (promote) и снимки.'
    : 'Оптимизации не было — показан снимок текущих параметров формул.';

  return `<section>
      <h2>Параметры сигналов / OPT</h2>
      <p class="muted" style="margin:0 0 0.6rem">${esc(note)}</p>
      <table class="deals param-hist">
        <thead>
          <tr>
            <th>Время</th><th>Событие</th><th>Ветка</th><th>Параметры</th><th>FinRes</th>
          </tr>
        </thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </section>`;
}

export function buildBacktestReportModel(
  logic: LogicRow,
  trades: LogicTradeRow[],
  opts: {
    backtestRun?: BacktestReportRunInfo | null;
    tradeLots?: Map<number, LogicTradeLotRow[]>;
    paramHistory?: ParamHistoryEvent[] | null;
    /** Пер-бумажные графики (#848). */
    paperCharts?: PaperReportChart[];
  } = {}
): BacktestReportModel {
  const initial = num(logic.initial_balance, 1_000_000);
  const rate = num(logic.base_annual_rate_pct, 7);
  const deals = collectClosedDeals(trades, opts.tradeLots);
  const allDeals = filterSide(deals, 'all');
  const longDeals = filterSide(deals, 'long');
  const shortDeals = filterSide(deals, 'short');

  const sortedByPnl = [...allDeals].sort((a, b) => b.pnl - a.pnl);
  const dateFrom = asDateOnly(opts.backtestRun?.date_from) || '';
  const dateTo = asDateOnly(opts.backtestRun?.date_to) || '';
  const periodLabel =
    formatDateRangeLabel(
      opts.backtestRun?.date_from,
      opts.backtestRun?.date_to
    ) || '—';

  return {
    generatedAt: new Date().toLocaleString('ru-RU'),
    logicName: logic.name || `Логика #${logic.id}`,
    logicId: logic.id,
    periodLabel,
    dateFrom,
    dateTo,
    runStatus: opts.backtestRun?.status ?? null,
    progressPct:
      opts.backtestRun?.progress_pct != null
        ? num(opts.backtestRun.progress_pct)
        : null,
    params: {
      timeframe: logic.timeframe || 'M15',
      positionSizePct: num(logic.position_size_pct),
      maxOpenPositions: num(logic.max_open_positions),
      initialBalance: initial,
      commissionPct: num(logic.commission_pct),
      costMethod: logic.cost_method || 'FIFO',
      baseAnnualRatePct: rate,
      inversion: !!logic.inversion,
      cashFundCode: String(logic.cash_fund_code || '').trim() || '—',
      accountType: logic.account_type,
      accountName: logic.account_name || logic.account_code || '—',
    },
    paramHistory: Array.isArray(opts.paramHistory) ? opts.paramHistory : [],
    paperCharts: Array.isArray(opts.paperCharts) ? opts.paperCharts : [],
    all: computeSideStats(allDeals, initial, rate, true, num(logic.commission_pct)),
    long: computeSideStats(longDeals, initial, rate, false, num(logic.commission_pct)),
    short: computeSideStats(shortDeals, initial, rate, false, num(logic.commission_pct)),
    equitySvg: equitySparklineSvg(trades, opts.backtestRun?.date_from),
    topWins: sortedByPnl.filter((d) => d.pnl > 0).slice(0, 8),
    topLosses: sortedByPnl.filter((d) => d.pnl < 0).slice(-8).reverse(),
    dealCount: allDeals.length,
  };
}

function cellMoney(v: number): string {
  const cls = v > 0 ? 'pos' : v < 0 ? 'neg' : '';
  return `<td class="num ${cls}">${esc(fmtMoney(v))}</td>`;
}

function cellPct(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return `<td class="num muted">—</td>`;
  const cls = v > 0 ? 'pos' : v < 0 ? 'neg' : '';
  return `<td class="num ${cls}">${esc(fmtPct(v))}</td>`;
}

function cellNum(v: number, digits = 2): string {
  return `<td class="num">${esc(fmtNum(v, digits))}</td>`;
}

function cellText(v: string): string {
  return `<td class="num">${esc(v)}</td>`;
}

function cellBreakeven(v: number | null | undefined, commissionPct: number): string {
  if (v == null || !Number.isFinite(v)) return `<td class="num muted">—</td>`;
  const cls = v > commissionPct ? 'pos' : v < commissionPct ? 'neg' : '';
  return `<td class="num ${cls}" title="Комиссия, при которой финансовый результат = 0%">${esc(
    fmtNum(v, 4)
  )}%</td>`;
}

function breakevenCardHtml(a: SideStats, commissionPct: number): string {
  const v = a.breakevenCommissionPct;
  let val: string;
  let cls = '';
  if (v == null || !Number.isFinite(v)) {
    val = '—';
  } else if (v !== 0 && (v < -0.0001 || commissionPct <= 0)) {
    val = 'убыточна даже при 0%';
    cls = 'neg';
  } else {
    val = `${fmtNum(v, 4)}%`;
    cls = v > commissionPct ? 'pos' : v < commissionPct ? 'neg' : '';
  }
  return `<div class="card" title="Минимальная комиссия, при которой финансовый результат = 0. При комиссии выше — тест уходит в минус."><div class="lbl">Комиссия − безубыток</div><div class="val ${cls}">${esc(
    val
  )}</div></div>`;
}

/** % годовых: простая аннуализация общего П\\У % на календарные дни периода. */
export function annualPctCardHtml(
  returnPct: number,
  dateFrom: string,
  dateTo: string
): string {
  if (!Number.isFinite(returnPct) || !dateFrom || !dateTo) {
    return `<div class="card" title="% годовых (простая аннуализация за период теста)"><div class="lbl">% годовых</div><div class="val muted">—</div></div>`;
  }
  const fromMs = Date.parse(`${dateFrom}T00:00:00Z`);
  const toMs = Date.parse(`${dateTo}T00:00:00Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
    return `<div class="card" title="% годовых (простая аннуализация за период теста)"><div class="lbl">% годовых</div><div class="val muted">—</div></div>`;
  }
  const days = Math.max(1, Math.round((toMs - fromMs) / 86400000) + 1);
  const annual = returnPct * (365 / days);
  const cls = annual >= 0 ? 'pos' : 'neg';
  return `<div class="card" title="П\\У за весь период, приведённый к % годовых (простая аннуализация: return% × 365/дни периода)"><div class="lbl">% годовых</div><div class="val ${cls}">${esc(
    fmtPct(annual)
  )}</div></div>`;
}

function metricRow(
  label: string,
  all: string,
  long: string,
  short: string
): string {
  return `<tr><th scope="row">${esc(label)}</th>${all}${long}${short}</tr>`;
}

function dealRows(deals: ClosedDeal[]): string {
  if (deals.length === 0) {
    return `<tr><td colspan="6" class="muted">Нет сделок</td></tr>`;
  }
  return deals
    .map(
      (d) => `<tr>
      <td>${esc(d.securityPrefix || d.securityName)}</td>
      <td>${esc(d.action)}</td>
      <td class="num">${esc(d.closeDt.slice(0, 19).replace('T', ' '))}</td>
      <td class="num">${esc(fmtNum(d.quantity, 0))}</td>
      <td class="num ${d.pnl >= 0 ? 'pos' : 'neg'}">${esc(fmtMoney(d.pnl))}</td>
      <td class="num">${esc(fmtHold(d.holdMs))}</td>
    </tr>`
    )
    .join('');
}

/** Full HTML document for window.open / blob download. */
export function renderBacktestReportHtml(model: BacktestReportModel): string {
  const a = model.all;
  const l = model.long;
  const s = model.short;
  const pf = (x: SideStats) =>
    x.profitFactor > 0 ? fmtNum(x.profitFactor, 3) : '—';

  const rows = [
    metricRow(
      'Чистый П\\У',
      cellMoney(a.netPnl),
      cellMoney(l.netPnl),
      cellMoney(s.netPnl)
    ),
    metricRow(
      'Чистый П\\У %',
      cellPct(a.netPnlPct),
      cellPct(l.netPnlPct),
      cellPct(s.netPnlPct)
    ),
    metricRow(
      'Количество сделок',
      cellNum(a.dealCount, 0),
      cellNum(l.dealCount, 0),
      cellNum(s.dealCount, 0)
    ),
    metricRow(
      'Среднее время удержания',
      cellText(a.avgHoldLabel),
      cellText(l.avgHoldLabel),
      cellText(s.avgHoldLabel)
    ),
    metricRow(
      'Sharpe ratio',
      cellNum(a.sharpe, 3),
      cellNum(l.sharpe, 3),
      cellNum(s.sharpe, 3)
    ),
    metricRow(
      'Profit Factor',
      cellText(pf(a)),
      cellText(pf(l)),
      cellText(pf(s))
    ),
    metricRow(
      'Recovery',
      cellNum(a.recovery, 3),
      cellText('—'),
      cellText('—')
    ),
    metricRow(
      'Pay Off Ratio',
      cellNum(a.payOffRatio, 3),
      cellNum(l.payOffRatio, 3),
      cellNum(s.payOffRatio, 3)
    ),
    `<tr class="sep"><td colspan="4"></td></tr>`,
    metricRow(
      'Сред. П\\У на сделку',
      cellMoney(a.avgPnl),
      cellMoney(l.avgPnl),
      cellMoney(s.avgPnl)
    ),
    `<tr class="sep"><td colspan="4"></td></tr>`,
    metricRow(
      'Прибыльных сделок',
      cellNum(a.winCount, 0),
      cellNum(l.winCount, 0),
      cellNum(s.winCount, 0)
    ),
    metricRow(
      'Прибыльных %',
      cellPct(a.winPct),
      cellPct(l.winPct),
      cellPct(s.winPct)
    ),
    metricRow(
      'Сред. прибыль',
      cellMoney(a.avgWin),
      cellMoney(l.avgWin),
      cellMoney(s.avgWin)
    ),
    metricRow(
      'Максимум подряд (прибыль)',
      cellNum(a.maxWinStreak, 0),
      cellNum(l.maxWinStreak, 0),
      cellNum(s.maxWinStreak, 0)
    ),
    `<tr class="sep"><td colspan="4"></td></tr>`,
    metricRow(
      'Убыточных сделок',
      cellNum(a.lossCount, 0),
      cellNum(l.lossCount, 0),
      cellNum(s.lossCount, 0)
    ),
    metricRow(
      'Убыточных %',
      cellPct(a.lossPct),
      cellPct(l.lossPct),
      cellPct(s.lossPct)
    ),
    metricRow(
      'Сред. убыток',
      cellMoney(a.avgLoss),
      cellMoney(l.avgLoss),
      cellMoney(s.avgLoss)
    ),
    metricRow(
      'Максимум подряд (убыток)',
      cellNum(a.maxLossStreak, 0),
      cellNum(l.maxLossStreak, 0),
      cellNum(s.maxLossStreak, 0)
    ),
    `<tr class="sep"><td colspan="4"></td></tr>`,
    metricRow(
      'Макс просадка % капитал',
      cellPct(a.maxDrawdownPct),
      cellText('—'),
      cellText('—')
    ),
    metricRow(
      'Объём комиссии',
      cellMoney(a.commission),
      cellMoney(l.commission),
      cellMoney(s.commission)
    ),
    metricRow(
      'Комиссия − безубыток',
      cellBreakeven(a.breakevenCommissionPct, model.params.commissionPct),
      cellBreakeven(l.breakevenCommissionPct, model.params.commissionPct),
      cellBreakeven(s.breakevenCommissionPct, model.params.commissionPct)
    ),
  ].join('\n');

  const statusBit = model.runStatus
    ? `<span class="pill">${esc(model.runStatus)}${
        model.progressPct != null ? ` · ${Math.round(model.progressPct)}%` : ''
      }</span>`
    : '';
  const downloadName = buildBacktestReportDownloadName(model);
  const periodTitle =
    model.periodLabel && model.periodLabel !== '—'
      ? ` — ${model.periodLabel}`
      : '';

  return `<!DOCTYPE html>
<html lang="ru" data-download-name="${esc(downloadName)}">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Отчёт теста — ${esc(model.logicName)}${esc(periodTitle)}</title>
  <style>
    :root {
      --ink: #0f172a;
      --muted: #64748b;
      --line: #e2e8f0;
      --panel: #ffffff;
      --bg: #f1f5f9;
      --accent: #0f766e;
      --pos: #15803d;
      --neg: #b91c1c;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", "IBM Plex Sans", system-ui, sans-serif;
      color: var(--ink);
      background: var(--bg);
      line-height: 1.45;
    }
    .hero {
      background: linear-gradient(135deg, #0f172a 0%, #134e4a 55%, #0f766e 100%);
      color: #f8fafc;
      padding: 1.75rem 2rem 1.5rem;
    }
    .hero-top {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      justify-content: space-between;
      gap: 0.75rem 1rem;
    }
    .hero h1 {
      margin: 0 0 0.35rem;
      font-size: 1.55rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .hero .sub { color: #cbd5e1; font-size: 0.92rem; }
    .btn-download {
      flex: 0 0 auto;
      border: 1px solid rgba(248,250,252,0.35);
      background: rgba(255,255,255,0.12);
      color: #f8fafc;
      font: inherit;
      font-size: 0.88rem;
      font-weight: 600;
      padding: 0.45rem 0.85rem;
      border-radius: 8px;
      cursor: pointer;
    }
    .btn-download:hover { background: rgba(255,255,255,0.22); }
    .pill {
      display: inline-block;
      margin-left: 0.5rem;
      padding: 0.15rem 0.55rem;
      border-radius: 999px;
      background: rgba(255,255,255,0.12);
      font-size: 0.78rem;
      vertical-align: middle;
    }
    .wrap { max-width: 980px; margin: 0 auto; padding: 1.25rem 1.25rem 2.5rem; }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 0.75rem;
      margin: -2rem 0 1.25rem;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 0.85rem 1rem;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06);
    }
    .card .lbl { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
    .card .val { font-size: 1.25rem; font-weight: 700; margin-top: 0.25rem; font-variant-numeric: tabular-nums; }
    .card .val.pos { color: var(--pos); }
    .card .val.neg { color: var(--neg); }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 1rem 1.15rem 1.15rem;
      margin-bottom: 1rem;
    }
    section h2 {
      margin: 0 0 0.75rem;
      font-size: 1rem;
      font-weight: 700;
    }
    .params {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 0.55rem 1rem;
      font-size: 0.88rem;
    }
    .params dt { color: var(--muted); font-size: 0.75rem; }
    .params dd { margin: 0.1rem 0 0; font-weight: 600; }
    table.stats {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.88rem;
    }
    table.stats th, table.stats td {
      padding: 0.4rem 0.55rem;
      border-bottom: 1px solid var(--line);
      text-align: left;
    }
    table.stats thead th {
      background: #f8fafc;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      color: var(--muted);
      position: sticky;
      top: 0;
    }
    table.stats th[scope="row"] { font-weight: 500; color: #334155; width: 40%; }
    table.stats td.num { text-align: right; font-variant-numeric: tabular-nums; }
    table.stats .pos { color: var(--pos); font-weight: 600; }
    table.stats .neg { color: var(--neg); font-weight: 600; }
    table.stats .muted { color: var(--muted); }
    table.stats tr.sep td { border: 0; height: 0.55rem; background: transparent; }
    .chart { background: #f8fafc; border-radius: 8px; padding: 0.5rem; border: 1px solid var(--line); }
    .empty-chart { color: var(--muted); padding: 2rem; text-align: center; }
    .papers-report .paper-report {
      border: 1px solid var(--line);
      border-radius: 10px;
      overflow: hidden;
      margin: 0 0 0.85rem;
    }
    .papers-report summary.paper-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.2rem 0.75rem;
      padding: 0.55rem 0.75rem;
      background: #f8fafc;
      cursor: pointer;
    }
    .papers-report summary.paper-head::-webkit-details-marker { color: var(--muted); }
    .paper-head-name { font-weight: 700; font-size: 0.95rem; }
    .paper-tf { color: var(--muted); font-weight: 500; font-size: 0.78rem; }
    .paper-meta { margin-left: auto; color: var(--muted); font-weight: 500; font-size: 0.8rem; white-space: nowrap; }
    .paper-body { padding: 0.65rem 0.8rem 0.9rem; }
    .pchart-toolbar { display: flex; justify-content: flex-end; margin-bottom: 0.4rem; }
    .pchart-toggle {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      font-size: 0.8rem;
      color: #334155;
      cursor: pointer;
      user-select: none;
    }
    .paper-chart { overflow-x: auto; }
    .paper-svg { display: block; width: 100%; min-width: 640px; height: auto; }
    .pchart-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 0.35rem 0.9rem;
      font-size: 0.72rem;
      color: #475569;
      margin-top: 0.45rem;
    }
    .pchart-legend .pl-swatch {
      display: inline-block;
      width: 1.1rem;
      height: 0.5rem;
      border-radius: 2px;
      vertical-align: middle;
      margin-right: 0.3rem;
    }
    .pchart-legend .pl-swatch.thr { background-size: 8px 100%; background-repeat: repeat; }
    .pchart-legend .pl-sep { display: inline-block; }
    table.paper-fifo td { font-variant-numeric: tabular-nums; }
    .paper-fifo tr.pf-close td {
      border-top: 1px solid var(--line);
      font-weight: 600;
    }
    .paper-fifo tr.pf-src td {
      color: var(--muted);
      font-size: 0.78rem;
      background: #fafafa;
    }
    .paper-fifo .pf-arrow { font-family: ui-monospace, Consolas, monospace; font-weight: 700; }
    .paper-hint { margin: 0.4rem 0 0; font-size: 0.75rem; }
    table.deals { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
    table.deals th, table.deals td { padding: 0.35rem 0.45rem; border-bottom: 1px solid var(--line); }
    table.deals th { text-align: left; color: var(--muted); font-size: 0.72rem; text-transform: uppercase; }
    table.param-hist td.formulas { font-family: ui-monospace, Consolas, monospace; font-size: 0.72rem; word-break: break-all; }
    .muted { color: var(--muted); }
    .foot {
      margin-top: 1.25rem;
      font-size: 0.78rem;
      color: var(--muted);
      text-align: center;
    }
    @media print {
      body { background: #fff; }
      .hero { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
      .cards { margin-top: 0.5rem; }
      .no-print { display: none !important; }
    }
  </style>
  <script>
    function downloadBacktestReport() {
      try {
        var name = document.documentElement.getAttribute('data-download-name') || 'MLT-report.html';
        var html = '<!DOCTYPE html>\\n' + document.documentElement.outerHTML;
        var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (e) {
        alert('Не удалось скачать отчёт');
      }
    }
    function swapReportChart(candleId, lineId, chkId) {
      var on = false;
      try { on = document.getElementById(chkId).checked; } catch (e) { return; }
      var c = document.getElementById(candleId);
      var l = document.getElementById(lineId);
      if (c) c.style.display = on ? '' : 'none';
      if (l) l.style.display = on ? 'none' : '';
    }
  </script>
</head>
<body>
  <header class="hero">
    <div class="hero-top">
      <div>
        <h1>Отчёт тестирования ${statusBit}</h1>
        <div class="sub">${esc(model.logicName)} · #${model.logicId} · период ${esc(model.periodLabel)}</div>
        <div class="sub">Сформирован ${esc(model.generatedAt)} · метрики как в OsEngine Journal → Статистика</div>
      </div>
      <button type="button" class="btn-download no-print" onclick="downloadBacktestReport()" title="${esc(downloadName)}">
        Скачать
      </button>
    </div>
  </header>
  <div class="wrap">
    <div class="cards">
      <div class="card"><div class="lbl">Чистый П\\У</div><div class="val ${a.netPnl >= 0 ? 'pos' : 'neg'}">${esc(fmtMoney(a.netPnl))}</div></div>
      <div class="card"><div class="lbl">П\\У %</div><div class="val ${a.netPnlPct >= 0 ? 'pos' : 'neg'}">${esc(fmtPct(a.netPnlPct))}</div></div>
      ${annualPctCardHtml(a.netPnlPct, model.dateFrom, model.dateTo)}
      <div class="card"><div class="lbl">Profit Factor</div><div class="val">${esc(pf(a))}</div></div>
      <div class="card"><div class="lbl">Макс. просадка</div><div class="val neg">${esc(a.maxDrawdownPct != null ? fmtPct(a.maxDrawdownPct) : '—')}</div></div>
      <div class="card"><div class="lbl">Прибыльных %</div><div class="val">${esc(fmtPct(a.winPct))}</div></div>
      <div class="card"><div class="lbl">Sharpe</div><div class="val">${esc(fmtNum(a.sharpe, 3))}</div></div>
      <div class="card"><div class="lbl">Recovery</div><div class="val">${esc(fmtNum(a.recovery, 3))}</div></div>
      <div class="card"><div class="lbl">Сделок</div><div class="val">${esc(fmtNum(a.dealCount, 0))}</div></div>
      ${breakevenCardHtml(a, model.params.commissionPct)}
    </div>

    <section>
      <h2>Параметры логики</h2>
      <dl class="params">
        <div><dt>Таймфрейм</dt><dd>${esc(model.params.timeframe)}</dd></div>
        <div><dt>% позиции</dt><dd>${esc(fmtNum(model.params.positionSizePct, 2))}</dd></div>
        <div><dt>Макс. позиций</dt><dd>${esc(fmtNum(model.params.maxOpenPositions, 0))}</dd></div>
        <div><dt>Нач. баланс</dt><dd>${esc(fmtMoney(model.params.initialBalance))}</dd></div>
        <div><dt>Комиссия %</dt><dd>${esc(fmtNum(model.params.commissionPct, 4))}</dd></div>
        <div><dt>Учёт</dt><dd>${esc(model.params.costMethod)}</dd></div>
        <div><dt>Баз. ставка %</dt><dd>${esc(fmtNum(model.params.baseAnnualRatePct, 2))}</dd></div>
        <div><dt>Инверсия</dt><dd>${model.params.inversion ? 'да' : 'нет'}</dd></div>
        <div><dt>Ден. фонд</dt><dd>${esc(model.params.cashFundCode)}</dd></div>
        <div><dt>Счёт</dt><dd>${esc(model.params.accountName)} (${esc(model.params.accountType)})</dd></div>
      </dl>
    </section>

    ${paramHistorySectionHtml(model.paramHistory)}

    <section>
      <h2>Эквити (кумулятивный П\\У)</h2>
      <div class="chart">${model.equitySvg}</div>
    </section>

    ${paperChartsSectionHtml(model.paperCharts)}

    <section>
      <h2>Статистика (Все / Лонг / Шорт)</h2>
      <table class="stats">
        <thead>
          <tr><th>Показатель</th><th>Все</th><th>Лонг</th><th>Шорт</th></tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </section>

    <section>
      <h2>Лучшие сделки</h2>
      <table class="deals">
        <thead><tr><th>Бумага</th><th>Сторона</th><th>Закрытие</th><th>Кол-во</th><th>П\\У</th><th>Удержание</th></tr></thead>
        <tbody>${dealRows(model.topWins)}</tbody>
      </table>
    </section>

    <section>
      <h2>Худшие сделки</h2>
      <table class="deals">
        <thead><tr><th>Бумага</th><th>Сторона</th><th>Закрытие</th><th>Кол-во</th><th>П\\У</th><th>Удержание</th></tr></thead>
        <tbody>${dealRows(model.topLosses)}</tbody>
      </table>
    </section>

    <p class="foot">MultiLogic Trade · отчёт по закрытым сделкам теста (без shadow) · аналог OsEngine Journal Statistics</p>
  </div>
</body>
</html>`;
}

/** Open HTML report in a new browser window. */
export function openBacktestReportWindow(html: string, title: string): boolean {
  const win = window.open('', '_blank');
  if (!win) {
    return false;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  try {
    win.document.title = title;
  } catch {
    /* ignore */
  }
  return true;
}
