import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  HostBinding,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
} from '@angular/core';

import { CommonModule } from '@angular/common';

import { FormsModule } from '@angular/forms';

import {

  costMethodLabel,

  LogicTradeLotRow,

  LogicTradeRow,

  tradeOperationHint,

  tradeOperationLabel,

  tradeStatusLabel,

} from '../shared/logic-trade';

import { LogicRow } from '../models/logic.model';

import { LogicBacktestPapersComponent } from './logic-backtest-papers.component';



export interface BacktestRunStatus {

  id: number;

  logic_id: number;

  date_from: string;

  date_to: string;

  status: string;

  progress_pct: number;

  phase_message: string | null;

  phase_detail: string | null;

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
  ],

  templateUrl: './logic-positions-panel.component.html',

  styleUrl: './logic-positions-panel.component.css',

  changeDetection: ChangeDetectionStrategy.OnPush,

})

export class LogicPositionsPanelComponent implements OnChanges {

  @Input({ required: true }) logicRow!: LogicRow;

  @Input({ required: true }) mode: 'live' | 'test' = 'live';

  @Input() trades: LogicTradeRow[] = [];

  @Input() tradeLots = new Map<number, LogicTradeLotRow[]>();

  @Input() lotsLoading = new Set<number>();

  @Input() loading = false;

  @Input() closeAllLoading = false;

  @Input() disabled = false;
  @Input() dimmed = false;
  @Input() blockExpanded = false;

  @Input() backtestRun: BacktestRunStatus | null = null;

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

  /** Кэш списков — не filter/sort на каждый CD. */
  cachedOpenTrades: LogicTradeRow[] = [];
  cachedCloseTrades: LogicTradeRow[] = [];
  cachedTotalPnl = 0;
  cachedTotalCommission = 0;



  /** В Тестировании и Позициях подблоки свёрнуты по умолчанию. */
  expandedOpen = false;

  expandedClosed = false;

  expandedTradeIds = new Set<number>();



  showPeriodDialog = false;

  periodFrom = '';

  periodTo = '';



  tradeOperationLabel = tradeOperationLabel;

  tradeOperationHint = tradeOperationHint;

  tradeStatusLabel = tradeStatusLabel;

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
    if (changes['trades'] || changes['logicRow']) {
      this.rebuildTradeCaches();
    }
  }

  private rebuildTradeCaches(): void {
    const open = this.trades
      .filter((t) => this.isOpenPositionTrade(t))
      .sort((a, b) => new Date(b.executed_at).getTime() - new Date(a.executed_at).getTime());
    const close = this.trades
      .filter((t) => t.side_name === 'Close' && (t.status === 'filled' || t.status === 'submitted'))
      .sort((a, b) => new Date(b.executed_at).getTime() - new Date(a.executed_at).getTime());
    let pnl = 0;
    let commission = 0;
    for (const t of this.trades) {
      if (t.is_shadow) continue;
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
  }



  /** Локальный флаг сразу после нажатия «Стоп», пока статус ещё running. */
  cancelling = false;

  get isBacktestRunning(): boolean {

    const s = this.backtestRun?.status;

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

    return `${this.backtestRun.date_from} — ${this.backtestRun.date_to}`;

  }



  onToggleBlock(event: Event): void {

    event.preventDefault();

    event.stopPropagation();

    this.toggleBlock.emit();

  }



  displayFinancialResult(): number {
    // Всегда сумма сделок панели — не financial_result прогона
    // (иначе «в таблице есть», в развороте «пусто» / другой итог).
    return this.totalFinancialResult();
  }



  /** Число календарных дней для аннуализации (включительно). */
  periodDaysForReturn(): number | null {
    if (this.isTest) {
      const from = this.backtestRun?.date_from;
      const to = this.backtestRun?.date_to;
      if (!from || !to) return null;
      const ms = Date.parse(to) - Date.parse(from);
      if (!Number.isFinite(ms) || ms < 0) return null;
      return Math.max(1, Math.round(ms / 86400000) + 1);
    }
    // Live: от первой сделки до сегодня
    const keys = this.trades
      .map((t) => String(t.bar_dt || t.executed_at || '').slice(0, 10))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
    if (keys.length === 0) return null;
    const fromMs = Date.parse(keys[0]);
    const today = new Date();
    const toKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const toMs = Date.parse(toKey);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return null;
    return Math.max(1, Math.round((toMs - fromMs) / 86400000) + 1);
  }

  /** Фин. результат в % от начального остатка (Позиции и Тестирование). */
  returnPct(): number | null {
    const initial = Number(this.logicRow.initial_balance);
    if (!Number.isFinite(initial) || initial <= 0) return null;
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



  isOpenPositionTrade(trade: LogicTradeRow): boolean {

    if (trade.side_name !== 'Open') return false;

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



  onOpenTokenDialog(event: Event): void {

    event.stopPropagation();

    this.openTokenDialog.emit();

  }



  openRunDialog(event: Event): void {

    event.stopPropagation();

    const { from, to } = defaultBacktestWeek();

    this.periodFrom = from;

    this.periodTo = to;

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



/** Локальный YYYY-MM-DD (не UTC — иначе сдвиг дня в MSK). */

function fmtDate(d: Date): string {

  const y = d.getFullYear();

  const m = String(d.getMonth() + 1).padStart(2, '0');

  const day = String(d.getDate()).padStart(2, '0');

  return `${y}-${m}-${day}`;

}

