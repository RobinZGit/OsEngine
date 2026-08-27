/**
 * OsEngine-like backtest statistics + HTML report (Journal → Statistics).
 * Metrics mirror PositionStatisticGenerator where possible, adapted to Close trades.
 */
import { LogicRow } from '../models/logic.model';
import { LogicTradeLotRow, LogicTradeRow } from '../shared/logic-trade';
import { asDateOnly, formatDateRangeLabel } from '../shared/date-format';
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
  withMaxDrawdown: boolean
): SideStats {
  const bal = initialBalance > 0 ? initialBalance : 0;
  const netPnl = deals.reduce((s, d) => s + d.pnl, 0);
  const commission = deals.reduce((s, d) => s + d.commission, 0);
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
    all: computeSideStats(allDeals, initial, rate, true),
    long: computeSideStats(longDeals, initial, rate, false),
    short: computeSideStats(shortDeals, initial, rate, false),
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
      <div class="card"><div class="lbl">Profit Factor</div><div class="val">${esc(pf(a))}</div></div>
      <div class="card"><div class="lbl">Макс. просадка</div><div class="val neg">${esc(a.maxDrawdownPct != null ? fmtPct(a.maxDrawdownPct) : '—')}</div></div>
      <div class="card"><div class="lbl">Прибыльных %</div><div class="val">${esc(fmtPct(a.winPct))}</div></div>
      <div class="card"><div class="lbl">Sharpe</div><div class="val">${esc(fmtNum(a.sharpe, 3))}</div></div>
      <div class="card"><div class="lbl">Recovery</div><div class="val">${esc(fmtNum(a.recovery, 3))}</div></div>
      <div class="card"><div class="lbl">Сделок</div><div class="val">${esc(fmtNum(a.dealCount, 0))}</div></div>
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
