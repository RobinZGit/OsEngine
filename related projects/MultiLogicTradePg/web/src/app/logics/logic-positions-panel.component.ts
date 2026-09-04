import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
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

  tradeRejectReason,

  tradeStatusDisplay,

  tradeStatusLabel,

} from '../shared/logic-trade';

import { LogicRow, LogicSecurityRow } from '../models/logic.model';

import {
  BacktestPaperRow,
  LogicBacktestPapersComponent,
} from './logic-backtest-papers.component';
import { EquityCurveChartComponent } from './equity-curve-chart.component';
import {
  buildActiveSecuritiesPoints,
  buildEquityPoints,
  buildPortfolioStopMarkers,
  buildShadowEquityPoints,
  buildShadedDisabledRanges,
  buildSideOpenShadedRanges,
  buildStopMarkers,
  buildTradeMarkers,
  dtKey,
  forceLivePortfolioShadowShading,
  papersWithTrades,
  tradeDtWindow,
  tradesForSecurity,
} from './backtest-chart-overlays';
import { ChartEquityPoint, ChartShadedRange, ChartStopMarker, PriceCandle } from '../models/market.model';
import {
  asDateOnly,
  formatDateRangeLabel,
  formatHumanDate,
} from '../shared/date-format';
import {
  buildBacktestReportModel,
  buildPaperIndicatorSeries,
  buildPaperReportCloseRows,
  openBacktestReportWindow,
  PaperReportChart,
  renderBacktestReportHtml,
} from './backtest-report';
import {
  OPT_GRID_MAX_COMBOS,
  OptGridParamRow,
  OptGridResultRow,
  buildOptGridArms,
  collectOptGridParamsFromFormulas,
  countOptGridCombos,
} from './opt-grid';
import { renderOptGridReportHtml } from './opt-grid-report';
import { SecuritiesService } from '../services/securities.service';
import { lastValueFrom } from 'rxjs';



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

  /** Same test run hosted offline grid (paper opt_lanes). */
  opt_grid_enabled?: boolean;

  opt_grid_results?: OptGridResultRow[] | null;
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
  private readonly securitiesApi = inject(SecuritiesService);
  private readonly cdr = inject(ChangeDetectorRef);

  /** Флаг построения отчёта (догрузка цен и индикаторов по бумагам, #848). */
  reportLoading = false;

  @Input({ required: true }) logicRow!: LogicRow;

  @Input({ required: true }) mode: 'live' | 'test' = 'live';

  @Input() trades: LogicTradeRow[] = [];

  /**
   * Финрез/комиссия из той же сводки, что колонка «Финрез теста» (/pnl-summary).
   * Если заданы — шапка панели совпадает с главной таблицей (даже пока сделки ещё грузятся).
   */
  @Input() summaryFinancialResult: number | null = null;
  @Input() summaryCommission: number | null = null;

  /**
   * Live equity from /logic-trades/equity-curve (champion closes only).
   * Used while a backtest is running (full trade dump is skipped to keep the tab responsive).
   */
  @Input() summaryEquityTotal: ChartEquityPoint[] | null = null;
  @Input() summaryEquityLong: ChartEquityPoint[] | null = null;
  @Input() summaryEquityShort: ChartEquityPoint[] | null = null;

  /** Денежный фонд — первая бумага в блоке «Бумаги» (бой и тест). */
  @Input() pinnedPaper: BacktestPaperRow | null = null;

  /** Бумаги логики (underlying для графика базового актива фьючерса). */
  @Input() logicSecurities: LogicSecurityRow[] = [];

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

  @Input() tbankTokenAlert: {
    reason?: 'missing' | 'invalid';
    message: string;
  } | null = null;

  /** Массовые rejected за окно (бой); 1–2 отказа без баннера. */
  @Input() rejectAlert: {
    warn: boolean;
    rejected_count: number;
    message: string | null;
  } | null = null;

  /** Бой: отдельно загруженные status=rejected (не в open/close). */
  @Input() rejectedTrades: LogicTradeRow[] = [];

  /** Fingerprint dismissed reject banner; cleared when alert goes away. */
  private dismissedRejectKey: string | null = null;

  /** Fingerprint dismissed token banner; cleared when alert goes away. */
  private dismissedTokenKey: string | null = null;

  /** Таймфрейм логики для графиков теста. */
  @Input() timeframeId: number | null = null;

  /** Индикаторы сигналов логики (для overlay на графике). */
  @Input() signalIndicatorIds: number[] = [];



  /** Signal formulas of this logic (for optimize-param list). */
  @Input() signalFormulas: string[] = [];

  @Output() closeAll = new EventEmitter<void>();

  @Output() startBacktest = new EventEmitter<{
    date_from: string;
    date_to: string;
    opt_grid?: { config: { params: OptGridParamRow[] }; arms: ReturnType<typeof buildOptGridArms> } | null;
  }>();

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
  cachedPortfolioEquityShadow: ChartEquityPoint[] = [];
  cachedPortfolioShadedRanges: ChartShadedRange[] = [];
  cachedPortfolioStopMarkers: ChartStopMarker[] = [];
  /** Горизонталь цели возобновления (shadow PnL), пока портфель в тени. */
  cachedPortfolioResumeTarget: number | null = null;
  /** Количество активных бумаг по времени. */
  cachedActiveSecurities: ChartEquityPoint[] = [];



  /** В Тестировании и Позициях подблоки свёрнуты по умолчанию. */
  expandedOpen = false;

  expandedClosed = false;

  /** Live-only rejected orders block (collapsed by default). */
  expandedRejected = false;

  /** Default open so upgrade users see the block without hunting. */
  expandedPortfolioEquity = true;

  expandedTradeIds = new Set<number>();



  showPeriodDialog = false;

  periodFrom = '';

  periodTo = '';

  /** Same test run: also trade paper grid lanes. */
  optimizeEnabled = false;

  /** Modal with grid params (outside <details> so it always shows). */
  showOptGridDialog = false;

  optGridParams: OptGridParamRow[] = [];

  optGridError: string | null = null;



  /** Expose limit for template. */
  readonly OPT_GRID_MAX_COMBOS = OPT_GRID_MAX_COMBOS;

  tradeOperationLabel = tradeOperationLabel;

  tradeOperationHint = tradeOperationHint;

  tradeStatusDisplay = tradeStatusDisplay;

  tradeStatusLabel = tradeStatusLabel;

  tradeRejectReason = tradeRejectReason;

  costMethodLabel = costMethodLabel;



  @HostBinding('class.positions-panel-dimmed')
  get hostDimmed(): boolean {
    return this.dimmed && !this.isTest;
  }

  get title(): string {
    if (this.mode === 'live') return 'Позиции';
    if (this.isBacktestRunning && this.backtestRun?.opt_grid_enabled) {
      return 'Тестирование с оптимизацией';
    }
    return 'Тестирование';
  }



  get isTest(): boolean {

    return this.mode === 'test';

  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['backtestRun'] && !this.isBacktestRunning) {
      this.cancelling = false;
    }
    if (changes['rejectAlert'] && !this.rejectAlert?.warn) {
      this.dismissedRejectKey = null;
    }
    if (changes['tbankTokenAlert'] && !this.tbankTokenAlert) {
      this.dismissedTokenKey = null;
    }
    if (
      changes['trades'] ||
      changes['logicRow'] ||
      changes['backtestRun'] ||
      changes['testPeriodFrom'] ||
      changes['testPeriodTo'] ||
      changes['summaryFinancialResult'] ||
      changes['summaryCommission'] ||
      changes['summaryEquityTotal'] ||
      changes['summaryEquityLong'] ||
      changes['summaryEquityShort']
    ) {
      this.rebuildTradeCaches();
    }
    if (changes['signalFormulas'] && this.optimizeEnabled) {
      this.refreshOptGridParams();
      this.cdr.markForCheck();
    }
    if (this.isTest) {
      const running = this.isBacktestRunning;
      if (this.prevBacktestRunning && !running) {
        this.scheduleAutoOpenReports();
      }
      this.prevBacktestRunning = running;
    }
  }

  /** Full reject banner + summary chip (hidden after × until new data / alert returns). */
  showRejectWarning(): boolean {
    const a = this.rejectAlert;
    if (!a?.warn || !a.message) return false;
    return this.rejectFingerprint(a) !== this.dismissedRejectKey;
  }

  /** Full token banner + summary chip. */
  showTokenWarning(): boolean {
    const a = this.tbankTokenAlert;
    if (!a?.message) return false;
    return this.tokenFingerprint(a) !== this.dismissedTokenKey;
  }

  dismissRejectBanner(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    const a = this.rejectAlert;
    if (!a?.warn) return;
    this.dismissedRejectKey = this.rejectFingerprint(a);
    this.cdr.markForCheck();
  }

  dismissTokenBanner(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    const a = this.tbankTokenAlert;
    if (!a) return;
    this.dismissedTokenKey = this.tokenFingerprint(a);
    this.cdr.markForCheck();
  }

  private rejectFingerprint(a: {
    rejected_count: number;
    message: string | null;
  }): string {
    return `${Number(a.rejected_count) || 0}|${a.message ?? ''}`;
  }

  private tokenFingerprint(a: {
    reason?: string;
    message: string;
  }): string {
    return `${a.reason ?? ''}|${a.message}`;
  }

  /** После теста (+ OPT) сформировать всплывающие OPT-окна; сам отчёт открывает родитель (#856). */
  private scheduleAutoOpenReports(): void {
    const runId = this.backtestRun?.id ?? null;
    if (runId == null || this.autoReportOpenedForRunId === runId) return;
    const st = String(this.backtestRun?.status ?? '')
      .trim()
      .toLowerCase();
    if (st !== 'completed' && st !== 'cancelled') return;
    this.autoReportOpenedForRunId = runId;
    // Parent LogicsComponent открывает серверный архив отчёта этого run_id в модале
    // (onBacktestJustFinished → openReportsAutoForRun), не завися от локальных сделок/popup.
    this.autoOpenFinishedReports();
  }

  private autoOpenFinishedReports(): void {
    if (!this.isTest) return;
    if (this.hasOptGridResults()) {
      this.openOptGridReportWindow(true);
      return;
    }
    if (this.backtestRun?.opt_grid_enabled) {
      window.setTimeout(() => {
        if (this.hasOptGridResults()) {
          this.openOptGridReportWindow(true);
        }
      }, 1500);
    }
  }

  get optGridComboCount(): number {
    return countOptGridCombos(this.optGridParams);
  }

  get optGridOverLimit(): boolean {
    return this.optGridComboCount > OPT_GRID_MAX_COMBOS;
  }

  onOptimizeToggle(checked: boolean, event?: Event): void {
    event?.stopPropagation();
    this.optimizeEnabled = !!checked;
    this.optGridError = null;
    if (this.optimizeEnabled) {
      if (!this.blockExpanded) {
        this.toggleBlock.emit();
      }
      this.refreshOptGridParams();
      this.showOptGridDialog = true;
      this.periodDialogOpen.emit(true);
    } else {
      this.showOptGridDialog = false;
      this.periodDialogOpen.emit(false);
    }
    this.cdr.detectChanges();
  }

  /** Re-open params modal while optimize stays on. */
  openOptGridDialog(event?: Event): void {
    event?.stopPropagation();
    if (!this.optimizeEnabled || this.isBacktestRunning) return;
    this.refreshOptGridParams();
    this.showOptGridDialog = true;
    this.periodDialogOpen.emit(true);
    this.cdr.detectChanges();
  }

  closeOptGridDialog(event?: Event): void {
    event?.stopPropagation();
    this.showOptGridDialog = false;
    this.periodDialogOpen.emit(false);
    this.cdr.detectChanges();
  }

  cancelOptGridDialog(event?: Event): void {
    event?.stopPropagation();
    this.optimizeEnabled = false;
    this.showOptGridDialog = false;
    this.optGridError = null;
    this.periodDialogOpen.emit(false);
    this.cdr.detectChanges();
  }

  refreshOptGridParams(): void {
    const prev = new Map(this.optGridParams.map((p) => [p.id, p]));
    const next = collectOptGridParamsFromFormulas(this.signalFormulas || []);
    for (const row of next) {
      const old = prev.get(row.id);
      if (old) {
        row.enabled = old.enabled;
        row.step = old.step;
        row.iterations = old.iterations;
        row.base = old.base;
      }
    }
    this.optGridParams = next;
    this.validateOptGrid();
  }

  onOptParamEnabled(id: string, enabled: boolean): void {
    const row = this.optGridParams.find((p) => p.id === id);
    if (!row) return;
    row.enabled = enabled;
    this.validateOptGrid();
    this.cdr.markForCheck();
  }

  onOptParamStep(id: string, raw: string): void {
    const row = this.optGridParams.find((p) => p.id === id);
    if (!row) return;
    const n = Number(String(raw).replace(',', '.'));
    if (Number.isFinite(n) && n > 0) row.step = n;
    this.validateOptGrid();
    this.cdr.markForCheck();
  }

  onOptParamIterations(id: string, raw: string): void {
    const row = this.optGridParams.find((p) => p.id === id);
    if (!row) return;
    const n = Math.round(Number(raw));
    if (Number.isInteger(n) && n >= 0 && n <= 20) row.iterations = n;
    this.validateOptGrid();
    this.cdr.markForCheck();
  }

  validateOptGrid(): void {
    const n = this.optGridComboCount;
    if (n > OPT_GRID_MAX_COMBOS) {
      this.optGridError = `Лимит комбинаций превышен: ${n} > ${OPT_GRID_MAX_COMBOS}. Снимите галочки или уменьшите «Итераций (±)».`;
    } else if (this.optimizeEnabled && n === 0) {
      this.optGridError = 'Отметьте хотя бы один параметр для оптимизации.';
    } else {
      this.optGridError = null;
    }
  }

  hasOptGridResults(): boolean {
    const r = this.backtestRun?.opt_grid_results;
    return Array.isArray(r) && r.length > 0;
  }

  onOpenOptGridReport(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.openOptGridReportWindow(false);
  }

  private openOptGridReportWindow(silent: boolean): void {
    const rows = this.backtestRun?.opt_grid_results;
    if (!Array.isArray(rows) || rows.length === 0) {
      if (!silent) {
        alert('Нет результатов оптимизации для этого прогона.');
      }
      return;
    }
    const html = renderOptGridReportHtml({
      logicName: this.logicRow?.name || `logic-${this.logicRow?.id}`,
      dateFrom: this.backtestRun?.date_from ?? '',
      dateTo: this.backtestRun?.date_to ?? '',
      runId: this.backtestRun?.id ?? null,
      rows: rows as OptGridResultRow[],
    });
    if (!openBacktestReportWindow(html, `Оптимизация — ${this.logicRow?.name}`)) {
      if (!silent) {
        alert('Не удалось открыть окно отчёта. Разрешите всплывающие окна.');
      }
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
      ? (this.backtestRun?.date_from ?? this.testPeriodFrom ?? null)
      : this.papersDateFrom();
    const liveTotal = this.summaryEquityTotal;
    const liveLong = this.summaryEquityLong;
    const liveShort = this.summaryEquityShort;
    // Prefer live /equity-curve. Mid-run `trades` are test-panel only (last ~2500
    // closes) — building equity from them makes the chart end ≠ FinRes (full sum).
    if (liveTotal != null && liveTotal.length > 0) {
      this.cachedPortfolioEquity = liveTotal;
      this.cachedPortfolioEquityLong = liveLong?.length ? liveLong : [];
      this.cachedPortfolioEquityShort = liveShort?.length ? liveShort : [];
      this.alignEquityEndToFinRes();
    } else if (this.isTest && this.isBacktestRunning) {
      this.cachedPortfolioEquity = [];
      this.cachedPortfolioEquityLong = [];
      this.cachedPortfolioEquityShort = [];
    } else {
      this.cachedPortfolioEquity = buildEquityPoints(this.trades, periodStart);
      this.cachedPortfolioEquityLong = buildEquityPoints(this.trades, periodStart, 'long');
      this.cachedPortfolioEquityShort = buildEquityPoints(this.trades, periodStart, 'short');
      this.alignEquityEndToFinRes();
    }
    // Shadow-серия и серые зоны — всегда из полного списка сделок панели.
    // В тени портфеля — shadow PnL только с момента паузы (как в SQL).
    const shadowSince =
      !this.isTest && this.logicRow?.portfolio_trading_paused
        ? this.logicRow.portfolio_stop_resume_at || null
        : null;
    this.cachedPortfolioEquityShadow = buildShadowEquityPoints(
      this.trades,
      periodStart,
      null,
      shadowSince
    );
    // Бой: не передавать date-only papersDateTo() — иначе серая заливка обрывается в полночь.
    const periodEnd = this.isTest
      ? (this.backtestRun?.date_to ?? this.testPeriodTo ?? null)
      : null;
    let shaded = buildShadedDisabledRanges(this.trades, periodStart, periodEnd);
    const nowIso = new Date().toISOString();
    // Портфель ещё в тени — серая зона до «сейчас»; срезаем зелёный хвост после паузы.
    if (!this.isTest && this.logicRow?.portfolio_trading_paused) {
      shaded = forceLivePortfolioShadowShading(shaded, {
        pauseAt: this.logicRow.portfolio_stop_resume_at || null,
        periodStart,
        nowIso,
      });
    }
    // #835: в бою подсветить зоны открытых лонгов (бледно-зелёный) и шортов
    // (бледно-красный) на графике портфеля; стопы — вертикали SL/TP.
    if (!this.isTest) {
      shaded = [...shaded, ...buildSideOpenShadedRanges(this.trades)];
    }
    this.cachedPortfolioShadedRanges = shaded;
    this.cachedPortfolioStopMarkers = buildPortfolioStopMarkers(this.trades);
    this.cachedPortfolioResumeTarget = this.portfolioShadowResumeTarget();
    this.cachedActiveSecurities = buildActiveSecuritiesPoints(this.trades, periodStart);
  }

  /**
   * Уровень на графике shadow-эквити: baseline + shadow_pnl ≥ target → реал.
   * На оси PnL это (target − baseline).
   */
  private portfolioShadowResumeTarget(): number | null {
    if (this.isTest) return null;
    if (!this.logicRow?.portfolio_trading_paused) return null;
    const rawT = this.logicRow.portfolio_stop_resume_equity;
    const rawB = this.logicRow.portfolio_stop_resume_baseline;
    // Number(null) === 0 — иначе «цель» = абсолютный resume_equity без baseline.
    if (rawT == null || rawB == null) return null;
    const target = Number(rawT);
    const baseline = Number(rawB);
    if (!Number.isFinite(target) || !Number.isFinite(baseline)) return null;
    return target - baseline;
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

  /** Avoid re-opening the same run's reports on every poll. */
  private autoReportOpenedForRunId: number | null = null;
  private prevBacktestRunning = false;

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



  /**
   * If live equity lags pnl-summary (slow/stale poll under two tests), nudge the
   * last total point so the chart end matches the header FinRes.
   */
  private alignEquityEndToFinRes(): void {
    if (!this.isTest || this.summaryFinancialResult == null) return;
    const fr = Number(this.summaryFinancialResult);
    if (!Number.isFinite(fr) || this.cachedPortfolioEquity.length === 0) return;
    const last = this.cachedPortfolioEquity[this.cachedPortfolioEquity.length - 1];
    if (Math.abs(last.value - fr) <= 0.05) return;
    const dt =
      this.backtestRun?.current_bar_dt ||
      last.dt ||
      this.backtestRun?.date_to ||
      this.testPeriodTo ||
      last.dt;
    this.cachedPortfolioEquity = [...this.cachedPortfolioEquity, { dt: String(dt), value: fr }];
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

  /** Стартовый баланс: для теста test_initial_balance (если >0) иначе initial_balance; для live — initial_balance. Пусто/0 → 1_000_000. */
  startBalance(): number {
    const raw = this.isTest
      ? Number(this.logicRow.test_initial_balance) > 0
        ? Number(this.logicRow.test_initial_balance)
        : Number(this.logicRow.initial_balance)
      : Number(this.logicRow.initial_balance);
    return Number.isFinite(raw) && raw > 0 ? raw : 1_000_000;
  }

  /** Фин. результат в % от начального остатка (Позиции и Тестирование). */
  returnPct(): number | null {
    const initial = this.startBalance();
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

  rejectedPositionTrades(): LogicTradeRow[] {
    if (this.isTest) return [];
    return this.rejectedTrades ?? [];
  }

  openTradeCount(): number {
    return this.cachedOpenTrades.length;
  }

  closeTradeCount(): number {
    return this.cachedCloseTrades.length;
  }

  rejectedTradeCount(): number {
    return this.rejectedPositionTrades().length;
  }

  totalTradeCount(): number {
    return this.openTradeCount() + this.closeTradeCount() + this.rejectedTradeCount();
  }

  rejectReasonText(tr: LogicTradeRow): string {
    return tradeRejectReason(tr.note) || tr.note?.trim() || '—';
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
      this.cachedPortfolioEquityShort.length > 0 ||
      this.cachedPortfolioEquityShadow.length > 0
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

  toggleRejectedBlock(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.expandedRejected = !this.expandedRejected;
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
    this.openTestReportWindow(false);
  }

  private async openTestReportWindow(silent: boolean): Promise<void> {
    if (!this.isTest) return;
    if (!this.hasReportableTrades()) {
      if (!silent) {
        alert('Нет закрытых тестовых сделок для отчёта. Сначала завершите прогон.');
      }
      return;
    }
    if (this.reportLoading) return;
    const runId = this.backtestRun?.id ?? null;
    this.reportLoading = true;
    this.cdr.markForCheck();
    try {
      let paramHistory: ParamHistoryEvent[] = [];
      try {
        const res = await lastValueFrom(
          this.logicsService.getOptParamHistory(this.logicRow.id, runId)
        );
        paramHistory = (res.rows || []) as ParamHistoryEvent[];
      } catch {
        /* опциональный параметр — без него не блокируем отчёт */
      }
      let paperCharts: PaperReportChart[] = [];
      try {
        paperCharts = await this.loadReportPaperCharts();
      } catch (err) {
        // Блоки по бумагам опциональны — отчёт обязателен к открытию (#855).
        console.warn('Пер-бумажные блоки отчёта не загружены: %O', err);
      }
      const model = buildBacktestReportModel(this.logicRow, this.trades, {
        backtestRun: this.backtestRun,
        tradeLots: this.tradeLots,
        paramHistory,
        paperCharts,
      });
      const html = renderBacktestReportHtml(model);
      const title = `Отчёт теста — ${model.logicName}`;
      if (!openBacktestReportWindow(html, title)) {
        if (!silent) {
          alert(
            'Не удалось открыть окно отчёта. Разрешите всплывающие окна для этого сайта.'
          );
        }
      }
    } catch (err) {
      console.error('Ошибка формирования отчёта теста: %O', err);
      if (!silent) {
        const msg =
          err instanceof Error ? err.message : String(err);
        alert(`Не удалось сформировать отчёт: ${msg}`);
      }
    } finally {
      this.reportLoading = false;
      this.cdr.markForCheck();
    }
  }

  /** Пер-бумажные блоки отчёта: цены, индикаторы, сделки, FIFO-лоты (#848). */
  private async loadReportPaperCharts(): Promise<PaperReportChart[]> {
    const from = this.backtestRun?.date_from ?? this.testPeriodFrom ?? null;
    const to = this.backtestRun?.date_to ?? this.testPeriodTo ?? null;
    const tf = this.reportChartTimeframe();
    if (tf == null) return [];
    const papers = papersWithTrades(this.trades, from, to, this.pinnedPaper);
    const charts: PaperReportChart[] = [];
    for (const p of papers.slice(0, REPORT_MAX_PAPERS)) {
      charts.push(await this.loadReportPaperChart(Number(p.security_id), p, tf, from, to));
    }
    return charts;
  }

  private reportChartTimeframe(): number | null {
    if (this.timeframeId != null && Number.isFinite(Number(this.timeframeId))) {
      return Number(this.timeframeId);
    }
    const t = this.trades.find((tr) => tr.timeframe_id != null);
    return t ? Number(t.timeframe_id) : null;
  }

  private async loadReportPaperChart(
    secId: number,
    paper: ReturnType<typeof papersWithTrades>[number],
    tf: number,
    from: string | null,
    to: string | null
  ): Promise<PaperReportChart> {
    const secTrades = tradesForSecurity(this.trades, secId, from, to);
    const win = tradeDtWindow(secTrades);
    let candles: PriceCandle[] = [];
    let loadError: string | null = null;
    try {
      candles = await this.loadReportCandles(secId, tf, win, from, to);
    } catch {
      loadError = 'Не удалось загрузить котировки (API цен).';
    }

    let indicators: ReturnType<typeof buildPaperIndicatorSeries> = [];
    if (loadError === null && this.signalIndicatorIds.length > 0 && win) {
      try {
        const values = await lastValueFrom(
          this.securitiesApi.getIndicatorValues(
            secId,
            tf,
            this.signalIndicatorIds,
            win.from,
            win.to,
            4000
          )
        );
        indicators = buildPaperIndicatorSeries(values);
      } catch {
        /* индикаторы опциональны */
      }
    }

    const paperTrades = this.trades.filter((t) => Number(t.security_id) === secId);
    const equity = buildEquityPoints(secTrades, from);
    const equityShadow = buildShadowEquityPoints(secTrades, from);
    const shaded = [
      ...buildShadedDisabledRanges(secTrades, from, to),
      ...buildSideOpenShadedRanges(secTrades),
    ].sort((a, b) => dtKey(a.startDt).localeCompare(dtKey(b.startDt)));

    return {
      securityId: secId,
      securityName: paper.security_name,
      securityPrefix: paper.security_prefix,
      timeframeLabel: secTrades[0]?.timeframe_tf || String(tf),
      candles,
      indicators,
      trades: secTrades,
      markers: buildTradeMarkers(secTrades),
      stops: buildStopMarkers(secTrades),
      shaded,
      equity,
      equityShadow,
      closes: buildPaperReportCloseRows(paperTrades, this.tradeLots),
      pnl: paper.pnl,
      dealCount: paper.trade_count,
      openQty: paper.open_qty,
      lastPrice: paper.last_price,
      loadError,
    };
  }

  /** Свечи по окну сделок бумаги (пагинация назад из конца периода, cap на объём). */
  private async loadReportCandles(
    secId: number,
    tf: number,
    win: { from: string; to: string } | null,
    from: string | null,
    _to: string | null
  ): Promise<PriceCandle[]> {
    const targetFirst = win?.from ?? (from ? `${from} 00:00:00` : null);
    const firstKey = targetFirst ? dtKey(targetFirst) : null;
    const batches: PriceCandle[][] = [];
    let before: string | undefined;
    for (let i = 0; i < REPORT_PRICE_PAGES; i++) {
      const rows = await lastValueFrom(this.securitiesApi.getPrices(secId, tf, 500, before));
      if (!rows || rows.length === 0) break;
      batches.push(rows);
      if (firstKey && dtKey(rows[0].dt) <= firstKey) break;
      if (rows.length < 500) break;
      const total = batches.reduce((s, b) => s + b.length, 0);
      if (total >= REPORT_MAX_CANDLES) break;
      before = rows[0].dt;
    }
    const out = batches.reverse().flat();
    return out.length > REPORT_MAX_CANDLES ? out.slice(-REPORT_MAX_CANDLES) : out;
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

    let opt_grid: {
      config: { params: OptGridParamRow[] };
      arms: ReturnType<typeof buildOptGridArms>;
    } | null = null;

    if (this.optimizeEnabled) {
      this.validateOptGrid();
      if (this.optGridError) {
        alert(this.optGridError);
        return;
      }
      const arms = buildOptGridArms(this.optGridParams);
      if (arms.length === 0) {
        alert('Отметьте хотя бы один параметр для оптимизации.');
        return;
      }
      const ok = confirm(
        `Будет выполнен тест и одновременно оптимизация (${arms.length} бумажных веток рядом с параметрами по умолчанию).\n` +
          `Это может заметно замедлить прогон.\n\nПродолжить?`
      );
      if (!ok) return;
      opt_grid = {
        config: { params: this.optGridParams.map((p) => ({ ...p })) },
        arms,
      };
    }

    this.startBacktest.emit({
      date_from: this.periodFrom,
      date_to: this.periodTo,
      opt_grid,
    });
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



/** Лимиты пер-бумажных блоков отчёта (#848). */
const REPORT_MAX_PAPERS = 12;
const REPORT_MAX_CANDLES = 2000;
const REPORT_PRICE_PAGES = 40;

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

