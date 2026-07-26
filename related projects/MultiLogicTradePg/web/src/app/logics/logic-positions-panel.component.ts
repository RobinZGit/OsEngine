import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  HostBinding,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
  inject,
} from '@angular/core';
import { LogicsService } from '../services/logics.service';
import { ParamHistoryEvent } from './backtest-report';

import { CommonModule } from '@angular/common';

import { FormsModule } from '@angular/forms';

import {

  costMethodLabel,

  LogicTradeLotRow,

  LogicTradeRow,

  tradeOperationHint,

  tradeOperationLabel,

  tradeStatusDisplay,

} from '../shared/logic-trade';

import { LogicRow } from '../models/logic.model';

import {
  BacktestPaperRow,
  LogicBacktestPapersComponent,
} from './logic-backtest-papers.component';
import { EquityCurveChartComponent } from './equity-curve-chart.component';
import { buildEquityPoints, buildPortfolioStopMarkers } from './backtest-chart-overlays';
import { ChartEquityPoint, ChartStopMarker } from '../models/market.model';
import {
  asDateOnly,
  formatDateRangeLabel,
  formatHumanDate,
} from '../shared/date-format';
import {
  buildBacktestReportModel,
  openBacktestReportWindow,
  renderBacktestReportHtml,
} from './backtest-report';



export interface BacktestRunStatus {

  id: number;

  logic_id: number;

  date_from: string;

  date_to: string;

  status: string;

  progress_pct: number;

  phase_message: string | null;

  phase_detail: string | null;

  /** Current candle being processed (ISO / PG timestamp). */
  current_bar_dt?: string | null;

  total_bars: number;

  processed_bars: number;

  test_balance: number | null;

  financial_result: number | null;

  error_message: string | null;

}



@Component({

  selector: 'app-logic-positions-panel',

  standalone: true,

  imports: [
    CommonModule,
    FormsModule,
    LogicBacktestPapersComponent,
    EquityCurveChartComponent,
  ],

  templateUrl: './logic-positions-panel.component.html',

  styleUrl: './logic-positions-panel.component.css',

  changeDetection: ChangeDetectionStrategy.OnPush,

})

export class LogicPositionsPanelComponent implements OnChanges {
  private readonly logicsService = inject(LogicsService);

  @Input({ required: true }) logicRow!: LogicRow;

  @Input({ required: true }) mode: 'live' | 'test' = 'live';

  @Input() trades: LogicTradeRow[] = [];

  /**
   * Финрез/комиссия из той же сводки, что колонка «Финрез теста» (/pnl-summary).
   * Если заданы — шапка панели совпадает с главной таблицей (даже пока сделки ещё грузятся).
   */
  @Input() summaryFinancialResult: number | null = null;
  @Input() summaryCommission: number | null = null;

  /** Денежный фонд — первая бумага в блоке «Бумаги» (бой и тест). */
  @Input() pinnedPaper: BacktestPaperRow | null = null;

  @Input() tradeLots = new Map<number, LogicTradeLotRow[]>();

  @Input() lotsLoading = new Set<number>();

  @Input() loading = false;

  @Input() closeAllLoading = false;

  @Input() disabled = false;
  @Input() dimmed = false;
  @Input() blockExpanded = false;

  @Input() backtestRun: BacktestRunStatus | null = null;
  /** Период последнего теста из pnl-summary (когда backtestRun уже нет после reload). */
  @Input() testPeriodFrom: string | null = null;
  @Input() testPeriodTo: string | null = null;

  @Input() tbankTokenAlert: { message: string } | null = null;

  /** Таймфрейм логики для графиков теста. */
  @Input() timeframeId: number | null = null;

  /** Индикаторы сигналов логики (для overlay на графике). */
  @Input() signalIndicatorIds: number[] = [];



  @Output() closeAll = new EventEmitter<void>();

  @Output() startBacktest = new EventEmitter<{ date_from: string; date_to: string }>();

  @Output() cancelBacktest = new EventEmitter<void>();

  @Output() openTokenDialog = new EventEmitter<void>();

  @Output() toggleBlock = new EventEmitter<void>();

  @Output() requestLots = new EventEmitter<number>();

  /** Родитель ставит паузу тяжёлого poll, пока открыт диалог периода. */
  @Output() periodDialogOpen = new EventEmitter<boolean>();

  /** Полный JSON сделок + параметры логики для анализа. */
  @Output() exportTrades = new EventEmitter<void>();

  /** Кэш списков — не filter/sort на каждый CD. */
  cachedOpenTrades: LogicTradeRow[] = [];
  cachedCloseTrades: LogicTradeRow[] = [];
  cachedTotalPnl = 0;
  cachedTotalCommission = 0;
  cachedPortfolioEquity: ChartEquityPoint[] = [];
  cachedPortfolioEquityLong: ChartEquityPoint[] = [];
  cachedPortfolioEquityShort: ChartEquityPoint[] = [];
  cachedPortfolioStopMarkers: ChartStopMarker[] = [];



  /** В Тестировании и Позициях подблоки свёрнуты по умолчанию. */
  expandedOpen = false;

  expandedClosed = false;

  /** Default open so upgrade users see the block without hunting. */
  expandedPortfolioEquity = true;

  expandedTradeIds = new Set<number>();



  showPeriodDialog = false;

  periodFrom = '';

  periodTo = '';



  tradeOperationLabel = tradeOperationLabel;

  tradeOperationHint = tradeOperationHint;

  tradeStatusDisplay = tradeStatusDisplay;

  costMethodLabel = costMethodLabel;



  @HostBinding('class.positions-panel-dimmed')
  get hostDimmed(): boolean {
    return this.dimmed && !this.isTest;
  }

  get title(): string {

    return this.mode === 'live' ? 'Позиции' : 'Тестирование';

  }



  get isTest(): boolean {

    return this.mode === 'test';

  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['backtestRun'] && !this.isBacktestRunning) {
      this.cancelling = false;
    }
    if (
      changes['trades'] ||
      changes['logicRow'] ||
      changes['backtestRun'] ||
      changes['testPeriodFrom'] ||
      changes['testPeriodTo'] ||
      changes['summaryFinancialResult'] ||
      changes['summaryCommission']
    ) {
      this.rebuildTradeCaches();
    }
  }

  private rebuildTradeCaches(): void {
    const sortKey = (t: LogicTradeRow) =>
      new Date(this.isTest ? t.bar_dt || t.executed_at : t.executed_at || t.bar_dt).getTime();
    const open = this.trades
      .filter((t) => this.isOpenPositionTrade(t))
      .sort((a, b) => sortKey(b) - sortKey(a));
    const close = this.trades
      .filter((t) => t.side_name === 'Close' && (t.status === 'filled' || t.status === 'submitted'))
      .sort((a, b) => sortKey(b) - sortKey(a));
    let pnl = 0;
    let commission = 0;
    for (const t of this.trades) {
      // Как /logic-trades/pnl-summary: без shadow, без OPT paper, только filled/submitted.
      if (t.is_shadow) continue;
      if ((t.opt_lane ?? '') !== '') continue;
      if (t.status !== 'filled' && t.status !== 'submitted') continue;
      if (t.financial_result != null && Number.isFinite(Number(t.financial_result))) {
        pnl += Number(t.financial_result);
      }
      if (t.commission != null && Number.isFinite(Number(t.commission))) {
        commission += Number(t.commission);
      }
    }
    this.cachedOpenTrades = open;
    this.cachedCloseTrades = close;
    this.cachedTotalPnl = pnl;
    this.cachedTotalCommission = commission;
    const periodStart = this.isTest
      ? (this.backtestRun?.date_from ?? null)
      : this.papersDateFrom();
    this.cachedPortfolioEquity = buildEquityPoints(this.trades, periodStart);
    this.cachedPortfolioEquityLong = buildEquityPoints(this.trades, periodStart, 'long');
    this.cachedPortfolioEquityShort = buildEquityPoints(this.trades, periodStart, 'short');
    this.cachedPortfolioStopMarkers = buildPortfolioStopMarkers(this.trades);
  }

  /** Окно дат для блока Бумаги / эквити (тест — период прогона, бой — по сделкам). */
  papersDateFrom(): string | null {
    if (this.isTest) return asDateOnly(this.backtestRun?.date_from) ?? null;
    return this.tradesDateBound('from');
  }

  papersDateTo(): string | null {
    if (this.isTest) return asDateOnly(this.backtestRun?.date_to) ?? null;
    return this.tradesDateBound('to');
  }

  /** Токен для пересборки overlays при poll боевых сделок (без сброса графика). */
  livePapersReloadToken(): string {
    if (this.trades.length === 0) return '0';
    const last = this.trades[0];
    // trades в панели уже отфильтрованы; fingerprint по длине + крайним id
    const a = this.trades[this.trades.length - 1];
    return `${this.trades.length}:${a?.id ?? ''}:${last?.id ?? ''}:${last?.bar_dt ?? ''}`;
  }

  private tradesDateBound(which: 'from' | 'to'): string | null {
    const keys = this.trades
      .map((t) => String(t.bar_dt || t.executed_at || '').slice(0, 10))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
    if (keys.length === 0) return null;
    return which === 'from' ? keys[0] : keys[keys.length - 1];
  }



  /** Локальный флаг сразу после нажатия «Стоп», пока статус ещё running. */
  cancelling = false;

  get isBacktestRunning(): boolean {

    const s = String(this.backtestRun?.status ?? '')
      .trim()
      .toLowerCase();

    return s === 'pending' || s === 'loading_prices' || s === 'loading_indicators' || s === 'running';

  }

  get isCancelling(): boolean {
    if (!this.isBacktestRunning) {
      return false;
    }
    return (
      this.cancelling ||
      String(this.backtestRun?.phase_message ?? '').includes('Остановка')
    );
  }



  get periodLabel(): string {
    if (!this.backtestRun) return '';
    return formatDateRangeLabel(this.backtestRun.date_from, this.backtestRun.date_to);
  }

  /** Date of the candle currently being processed (shown next to %). */
  get currentBarLabel(): string {
    const raw = this.backtestRun?.current_bar_dt;
    if (!raw) return '';
    return formatHumanDate(raw) || String(raw).slice(0, 10);
  }



  onToggleBlock(event: Event): void {

    event.preventDefault();

    event.stopPropagation();

    this.toggleBlock.emit();

  }



  displayFinancialResult(): number {
    // Тест: та же цифра, что колонка «Финрез теста» (pnl-summary по run_id).
    // Fallback — сумма загруженных сделок панели.
    if (this.isTest && this.summaryFinancialResult != null && Number.isFinite(this.summaryFinancialResult)) {
      return Number(this.summaryFinancialResult);
    }
    return this.totalFinancialResult();
  }

  displayCommission(): number {
    if (this.isTest && this.summaryCommission != null && Number.isFinite(this.summaryCommission)) {
      return Number(this.summaryCommission);
    }
    return this.totalCommission();
  }



  /** Число календарных дней для аннуализации (включительно). */
  periodDaysForReturn(): number | null {
    if (this.isTest) {
      // 1) текущий/последний прогон в UI  2) даты из pnl-summary  3) по тестовым сделкам
      const from =
        asDateOnly(this.backtestRun?.date_from) ??
        asDateOnly(this.testPeriodFrom) ??
        this.tradesDateBound('from');
      const to =
        asDateOnly(this.backtestRun?.date_to) ??
        asDateOnly(this.testPeriodTo) ??
        this.tradesDateBound('to');
      return this.inclusiveCalendarDays(from, to);
    }
    // Live: от первой сделки до сегодня
    const from = this.tradesDateBound('from');
    if (!from) return null;
    const today = new Date();
    const to = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`;
    return this.inclusiveCalendarDays(from, to);
  }

  private inclusiveCalendarDays(
    from: string | null,
    to: string | null
  ): number | null {
    if (!from || !to) return null;
    const fromMs = Date.parse(`${from}T00:00:00Z`);
    const toMs = Date.parse(`${to}T00:00:00Z`);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
      return null;
    }
    return Math.max(1, Math.round((toMs - fromMs) / 86400000) + 1);
  }

  /** Фин. результат в % от начального остатка (Позиции и Тестирование). */
  returnPct(): number | null {
    const raw = Number(this.logicRow.initial_balance);
    // Как в бэктесте: пустой/0 initial → 1_000_000, иначе «год.» = «—»
    const initial =
      Number.isFinite(raw) && raw > 0 ? raw : 1_000_000;
    return (this.displayFinancialResult() / initial) * 100;
  }

  /** Простая аннуализация: return% × (365 / дни периода). */
  annualPct(): number | null {
    const ret = this.returnPct();
    const days = this.periodDaysForReturn();
    if (ret == null || days == null || days <= 0) return null;
    return ret * (365 / days);
  }

  formatPct(value: number | null | undefined): string {

    if (value == null || !Number.isFinite(Number(value))) return '—';

    const n = Number(value);

    const sign = n > 0 ? '+' : '';

    return `${sign}${n.toFixed(2)}%`;

  }



  openPositionTrades(): LogicTradeRow[] {
    return this.cachedOpenTrades;
  }

  closePositionTrades(): LogicTradeRow[] {
    return this.cachedCloseTrades;
  }

  openTradeCount(): number {
    return this.cachedOpenTrades.length;
  }

  closeTradeCount(): number {
    return this.cachedCloseTrades.length;
  }

  totalTradeCount(): number {
    return this.openTradeCount() + this.closeTradeCount();
  }

  totalFinancialResult(): number {
    return this.cachedTotalPnl;
  }

  /** Сумма комиссий по сделкам панели (бой или тест — те же trades). */
  totalCommission(): number {
    return this.cachedTotalCommission;
  }

  hasOpenPositions(): boolean {
    return this.cachedOpenTrades.length > 0;
  }

  hasPortfolioEquity(): boolean {
    return (
      this.cachedPortfolioEquity.length > 0 ||
      this.cachedPortfolioEquityLong.length > 0 ||
      this.cachedPortfolioEquityShort.length > 0
    );
  }



  isOpenPositionTrade(trade: LogicTradeRow): boolean {
    if (trade.side_name !== 'Open') return false;
    if (trade.status !== 'filled' && trade.status !== 'submitted') return false;
    const rem = trade.remaining_qty;
    if (rem == null) return true;
    return Number(rem) > 0;
  }



  openTradeHasPartialCloses(trade: LogicTradeRow): boolean {

    const rem = trade.remaining_qty ?? trade.quantity;

    return Number(trade.quantity) > Number(rem);

  }



  closedPartialLotsForOpen(openTradeId: number): LogicTradeLotRow[] {

    return (this.tradeLots.get(openTradeId) ?? []).filter((l) => l.open_trade_id === openTradeId);

  }



  closedLotsForClose(closeTradeId: number): LogicTradeLotRow[] {

    return (this.tradeLots.get(closeTradeId) ?? []).filter((l) => l.close_trade_id === closeTradeId);

  }



  isLotsLoading(tradeId: number): boolean {

    return this.lotsLoading.has(tradeId);

  }



  formatPnl(value: number | null | undefined): string {

    if (value == null || !Number.isFinite(Number(value))) return '—';

    const n = Number(value);

    const sign = n > 0 ? '+' : '';

    return `${sign}${n.toFixed(2)}`;

  }



  formatTradeDt(iso: string): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('ru-RU');
  }

  /** В тесте показываем время бара (логика), не wall-clock executed_at прогона. */
  tradeDisplayDt(tr: { bar_dt?: string | null; executed_at?: string | null }): string {
    if (this.isTest) {
      return this.formatTradeDt(tr.bar_dt || tr.executed_at || '');
    }
    return this.formatTradeDt(tr.executed_at || tr.bar_dt || '');
  }



  formatMoney(v: number | null | undefined): string {

    if (v == null || !Number.isFinite(Number(v))) return '—';

    return Number(v).toFixed(2);

  }



  toggleOpenBlock(event: Event): void {

    event.preventDefault();

    event.stopPropagation();

    this.expandedOpen = !this.expandedOpen;

  }



  toggleClosedBlock(event: Event): void {

    event.preventDefault();

    event.stopPropagation();

    this.expandedClosed = !this.expandedClosed;

    if (this.expandedClosed) {

      for (const tr of this.closePositionTrades()) {

        this.ensureLotsLoaded(tr.id);

      }

    }

  }

  togglePortfolioEquityBlock(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.expandedPortfolioEquity = !this.expandedPortfolioEquity;
  }



  toggleTradeRow(trade: LogicTradeRow, event: Event): void {

    event.stopPropagation();

    if (this.expandedTradeIds.has(trade.id)) {

      this.expandedTradeIds.delete(trade.id);

    } else {

      this.expandedTradeIds.add(trade.id);

      this.ensureLotsLoaded(trade.id);

    }

  }



  isTradeRowExpanded(id: number): boolean {

    return this.expandedTradeIds.has(id);

  }



  private ensureLotsLoaded(tradeId: number): void {

    if (this.tradeLots.has(tradeId) || this.lotsLoading.has(tradeId)) return;

    this.requestLots.emit(tradeId);

  }



  onCloseAll(event: Event): void {

    event.stopPropagation();

    this.closeAll.emit();

  }

  onExportTrades(event: Event): void {
    event.stopPropagation();
    this.exportTrades.emit();
  }

  hasReportableTrades(): boolean {
    return this.trades.some(
      (t) =>
        !t.is_shadow &&
        t.side_name === 'Close' &&
        (t.status === 'filled' || t.status === 'submitted') &&
        t.financial_result != null &&
        Number.isFinite(Number(t.financial_result))
    );
  }

  onOpenReport(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    if (!this.isTest) return;
    if (!this.hasReportableTrades()) {
      alert('Нет закрытых тестовых сделок для отчёта. Сначала завершите прогон.');
      return;
    }
    const runId = this.backtestRun?.id ?? null;
    const openWith = (paramHistory: ParamHistoryEvent[]) => {
      const model = buildBacktestReportModel(this.logicRow, this.trades, {
        backtestRun: this.backtestRun,
        tradeLots: this.tradeLots,
        paramHistory,
      });
      const html = renderBacktestReportHtml(model);
      const title = `Отчёт теста — ${model.logicName}`;
      if (!openBacktestReportWindow(html, title)) {
        alert(
          'Не удалось открыть окно отчёта. Разрешите всплывающие окна для этого сайта.'
        );
      }
    };
    this.logicsService.getOptParamHistory(this.logicRow.id, runId).subscribe({
      next: (res) => openWith((res.rows || []) as ParamHistoryEvent[]),
      error: () => openWith([]),
    });
  }

  onOpenTokenDialog(event: Event): void {

    event.stopPropagation();

    this.openTokenDialog.emit();

  }



  openRunDialog(event: Event): void {
    event.stopPropagation();
    const remembered = resolveBacktestPeriod(
      this.backtestRun?.date_from,
      this.backtestRun?.date_to,
      this.logicRow?.id,
    );
    this.periodFrom = remembered.from;
    this.periodTo = remembered.to;
    this.showPeriodDialog = true;
    this.periodDialogOpen.emit(true);
  }

  closeRunDialog(): void {
    this.showPeriodDialog = false;
    this.periodDialogOpen.emit(false);
  }

  confirmRunDialog(): void {
    this.showPeriodDialog = false;
    this.periodDialogOpen.emit(false);
    saveRememberedBacktestPeriod(
      this.logicRow?.id,
      this.periodFrom,
      this.periodTo,
    );
    this.startBacktest.emit({ date_from: this.periodFrom, date_to: this.periodTo });
  }



  onCancelBacktest(event: Event): void {

    event.stopPropagation();

    this.cancelBacktest.emit();

  }



  onPlayOrStop(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    if (this.isBacktestRunning) {
      if (this.isCancelling) return;
      this.cancelling = true;
      this.cancelBacktest.emit();
    } else {
      this.cancelling = false;
      this.openRunDialog(event);
    }
  }

}



function defaultBacktestWeek(): { from: string; to: string } {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  // Не ставить date_to в будущее — иначе бэктест гоняет T-Bank впустую.
  const to = sunday.getTime() > now.getTime() ? now : sunday;
  return { from: fmtDate(monday), to: fmtDate(to) };
}

const BACKTEST_PERIOD_LS_PREFIX = 'mlt.backtestPeriod.';

/** YYYY-MM-DD for <input type="date">. */
function asDateInputValue(raw: string | null | undefined): string | null {
  return asDateOnly(raw);
}

function loadRememberedBacktestPeriod(
  logicId: number | null | undefined,
): { from: string; to: string } | null {
  if (logicId == null || !Number.isFinite(Number(logicId))) return null;
  try {
    const raw = localStorage.getItem(BACKTEST_PERIOD_LS_PREFIX + logicId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { from?: string; to?: string };
    const from = asDateInputValue(parsed?.from);
    const to = asDateInputValue(parsed?.to);
    if (!from || !to) return null;
    return { from, to };
  } catch {
    return null;
  }
}

function saveRememberedBacktestPeriod(
  logicId: number | null | undefined,
  from: string,
  to: string,
): void {
  if (logicId == null || !Number.isFinite(Number(logicId))) return;
  const f = asDateInputValue(from);
  const t = asDateInputValue(to);
  if (!f || !t) return;
  try {
    localStorage.setItem(
      BACKTEST_PERIOD_LS_PREFIX + logicId,
      JSON.stringify({ from: f, to: t }),
    );
  } catch {
    /* ignore quota / private mode */
  }
}

/** Last run → localStorage → current week. */
function resolveBacktestPeriod(
  runFrom: string | null | undefined,
  runTo: string | null | undefined,
  logicId: number | null | undefined,
): { from: string; to: string } {
  const from = asDateInputValue(runFrom);
  const to = asDateInputValue(runTo);
  if (from && to) return { from, to };
  const remembered = loadRememberedBacktestPeriod(logicId);
  if (remembered) return remembered;
  return defaultBacktestWeek();
}

/** Локальный YYYY-MM-DD (не UTC — иначе сдвиг дня в MSK). */
function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');

  return `${y}-${m}-${day}`;

}

