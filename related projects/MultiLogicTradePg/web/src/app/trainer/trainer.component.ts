import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription, firstValueFrom, forkJoin } from 'rxjs';
import { PriceChartComponent } from '../price-chart/price-chart.component';
import { SecuritiesService } from '../services/securities.service';
import { ReferencesService } from '../services/references.service';
import { TrainerService, TrainerSessionSavePayload, TrainerTradeSavePayload } from '../services/trainer.service';
import { renderTrainerStatsHtml } from './trainer-stats-report';
import {
  ChartEquityPoint,
  ChartIndicatorSeries,
  ChartTradeMarker,
  PriceCandle,
  SecurityRow,
  TimeframeRow,
} from '../models/market.model';
import { ExchangeRow, IndicatorRow } from '../models/lookup.model';
import { LogicRow } from '../models/logic.model';
import { LogicTradeRow } from '../shared/logic-trade';
import {
  BacktestReportRunInfo,
  PaperReportChart,
  buildBacktestReportModel,
  buildPaperReportCloseRows,
  openBacktestReportWindow,
  renderBacktestReportHtml,
} from '../logics/backtest-report';

interface TrainerTrade {
  id: number;
  side: 'long' | 'short';
  openDt: string;
  openPrice: number;
  closeDt: string;
  closePrice: number;
  commission: number;
  pnl: number;
  pnlPct: number;
  annualPct: number | null;
  holdingMs: number;
}

type IndicatorCode =
  | 'SMA' | 'EMA' | 'WMA' | 'HMA'
  | 'BB' | 'DONCHIAN'
  | 'RSI' | 'MACD' | 'STOCH' | 'ATR' | 'CCI' | 'ADX' | 'ROC' | 'OBV' | 'MFI' | 'VWAP';

interface IndicatorDef {
  code: IndicatorCode;
  name: string;
  period: number;
  onPrice: boolean;
  hasPeriod: boolean;
}

const INDICATOR_DEFS: IndicatorDef[] = [
  { code: 'SMA', name: 'SMA — Простое скользящее среднее', period: 20, onPrice: true, hasPeriod: true },
  { code: 'EMA', name: 'EMA — Экспоненциальное среднее', period: 20, onPrice: true, hasPeriod: true },
  { code: 'WMA', name: 'WMA — Взвешенное среднее', period: 20, onPrice: true, hasPeriod: true },
  { code: 'HMA', name: 'HMA — Среднее Халла', period: 20, onPrice: true, hasPeriod: true },
  { code: 'BB', name: 'BB — Полосы Боллинджера', period: 20, onPrice: true, hasPeriod: true },
  { code: 'DONCHIAN', name: 'Donchian — Канал Дончиана', period: 20, onPrice: true, hasPeriod: true },
  { code: 'VWAP', name: 'VWAP — Средневзвешенная по объёму', period: 1, onPrice: true, hasPeriod: false },
  { code: 'RSI', name: 'RSI — Индекс относительной силы', period: 14, onPrice: false, hasPeriod: true },
  { code: 'MACD', name: 'MACD — Схождение/расхождение средних', period: 12, onPrice: false, hasPeriod: true },
  { code: 'STOCH', name: 'Stoch — Стохастик', period: 14, onPrice: false, hasPeriod: true },
  { code: 'ATR', name: 'ATR — Средний истинный диапазон', period: 14, onPrice: false, hasPeriod: true },
  { code: 'CCI', name: 'CCI — Индекс товарного канала', period: 20, onPrice: false, hasPeriod: true },
  { code: 'ADX', name: 'ADX — Индекс направленного движения', period: 14, onPrice: false, hasPeriod: true },
  { code: 'ROC', name: 'ROC — Скорость изменения', period: 12, onPrice: false, hasPeriod: true },
  { code: 'OBV', name: 'OBV — Балансовый объём', period: 1, onPrice: false, hasPeriod: false },
  { code: 'MFI', name: 'MFI — Индекс денежного потока', period: 14, onPrice: false, hasPeriod: true },
];

interface LocalIndicator {
  uid: string;
  type: IndicatorCode;
  period: number;
  color: string;
}

type PositionSide = 'flat' | 'long' | 'short';

@Component({
  selector: 'app-trainer',
  standalone: true,
  imports: [CommonModule, FormsModule, PriceChartComponent],
  templateUrl: './trainer.component.html',
  styleUrl: './trainer.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrainerComponent implements OnInit, OnDestroy {
  private readonly securitiesApi = inject(SecuritiesService);
  private readonly refsApi = inject(ReferencesService);
  private readonly trainerApi = inject(TrainerService);
  private readonly cdr = inject(ChangeDetectorRef);

  exchanges: ExchangeRow[] = [];
  securities: SecurityRow[] = [];
  timeframes: TimeframeRow[] = [];

  exchangeId: number | null = null;
  securityKind: 'stock' | 'futures' | 'other' = 'stock';
  securityId: number | null = null;
  timeframeId: number | null = null;

  readonly securityKindOptions: Array<{ value: 'stock' | 'futures' | 'other'; label: string }> = [
    { value: 'stock', label: 'Акции' },
    { value: 'futures', label: 'Фьючерсы' },
    { value: 'other', label: 'Валюта / Золото / Другое' },
  ];

  speedMs = 1000;
  readonly speedOptions = [
    { label: 'Макс (0.02 сек)', value: 20 },
    { label: '0.05 сек', value: 50 },
    { label: '0.1 сек', value: 100 },
    { label: '0.25 сек', value: 250 },
    { label: '0.5 сек', value: 500 },
    { label: '1 сек', value: 1000 },
    { label: '2 сек', value: 2000 },
    { label: '3 сек', value: 3000 },
  ];

  commissionPct = 0.03;
  executionDelaySec = 30;
  private playbackStartDt: string | null = null;
  pendingOrder: { side: 'long' | 'short'; action: 'open' | 'close'; requestedDt: string; executeAtMs: number } | null = null;
  executionDelaySumSec = 0;
  executionDelayCount = 0;

  loading = false;
  loadingError: string | null = null;
  dataLoading = false;
  dataLoadingMessage = '';
  reportLoading = false;
  statsLoading = false;
  totalDetailsOpen = false;
  private sessionKey: string | null = null;

  private allCandles: PriceCandle[] = [];
  visibleCandles: PriceCandle[] = [];
  private playIndex = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  playing = false;
  started = false;
  finished = false;

  position: PositionSide = 'flat';
  entryPrice: number | null = null;
  entryDt: string | null = null;
  entryVisibleIndex: number | null = null;

  trades: TrainerTrade[] = [];
  totalPnl = 0;
  lastPnl: number | null = null;
  lastAnnualPct: number | null = null;
  lastPnlAt = 0;
  private tradeSeq = 1;

  tradeMarkers: ChartTradeMarker[] = [];
  signalMarkers: ChartTradeMarker[] = [];

  get chartMarkers(): ChartTradeMarker[] {
    return this.signalMarkers.length ? [...this.tradeMarkers, ...this.signalMarkers] : this.tradeMarkers;
  }

  readonly indicatorDefs = INDICATOR_DEFS;
  // По умолчанию две скользящие средние: краткосрочная SMA 9 и долгосрочная SMA 21,
  // разными цветами (синяя / янтарная).
  indicators: LocalIndicator[] = [
    { uid: 'sma-short-default', type: 'SMA', period: 9, color: '#2563eb' },
    { uid: 'sma-long-default', type: 'SMA', period: 21, color: '#f59e0b' },
  ];
  indicatorSeries: ChartIndicatorSeries[] = [];
  addIndicatorType: IndicatorCode = 'SMA';
  addIndicatorPeriod = 20;

  private readonly palette = ['#f59e0b', '#8b5cf6', '#06b6d4', '#22c55e', '#ef4444', '#3b82f6', '#ec4899', '#14b8a6', '#84cc16'];
  private colorIdx = 0;
  private subs: Subscription[] = [];

  ngOnInit(): void {
    this.loadLookups();
  }

  ngOnDestroy(): void {
    if (this.started) this.saveSession();
    this.stopPlayback();
    this.subs.forEach((s) => s.unsubscribe());
  }

  private loadLookups(): void {
    this.loading = true;
    this.loadingError = null;
    const sub = forkJoin({
      exchanges: this.refsApi.getExchanges(),
      timeframes: this.securitiesApi.getTimeframes(),
    }).subscribe({
      next: ({ exchanges, timeframes }) => {
        this.exchanges = exchanges ?? [];
        this.timeframes = (timeframes ?? []).slice().sort((a, b) => a.sec - b.sec);
        const moex = this.exchanges.find((e) => /moex/i.test(e.name));
        this.exchangeId = moex?.id ?? this.exchanges[0]?.id ?? null;
        const tf5 = this.timeframes.find((t) => t.sec === 300);
        this.timeframeId = tf5?.id ?? this.timeframes.find((t) => t.is_active)?.id ?? this.timeframes[0]?.id ?? null;
        this.ensureDefaultIndicators();
        if (this.exchangeId) {
          this.loadSecurities(this.exchangeId);
        } else {
          this.loading = false;
          this.cdr.markForCheck();
        }
      },
      error: (err) => {
        this.loading = false;
        this.loadingError = err?.message || 'Ошибка загрузки справочников';
        this.cdr.markForCheck();
      },
    });
    this.subs.push(sub);
  }

  private loadSecurities(exchangeId: number): void {
    this.loading = true;
    this.loadingError = null;
    const sub = this.securitiesApi.getSecurities(exchangeId, this.securityKind).subscribe({
      next: (rows) => {
        this.securities = rows ?? [];
        const prev = this.securityId;
        const byId = prev != null ? this.securities.find((s) => s.id === prev) : null;
        const sber = this.securities.find((s) => /сбер/i.test(s.name)) ||
          this.securities.find((s) => /^SBER$/i.test(s.name));
        const preferred = this.securityKind === 'stock'
          ? (sber ?? this.securities[0])
          : (this.securities[0]);
        this.securityId = byId?.id ?? preferred?.id ?? null;
        this.loading = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.loading = false;
        this.loadingError = err?.message || 'Ошибка загрузки инструментов';
        this.cdr.markForCheck();
      },
    });
    this.subs.push(sub);
  }

  onExchangeChange(): void {
    this.securityId = null;
    this.securities = [];
    if (this.exchangeId) this.loadSecurities(this.exchangeId);
  }

  onSecurityKindChange(): void {
    this.securityId = null;
    this.securities = [];
    this.onSetupChange();
    if (this.exchangeId) this.loadSecurities(this.exchangeId);
  }

  onSetupChange(): void {
    if (this.started) this.resetTrainer();
  }

  private ensureDefaultIndicators(): void {
    if (this.indicators.length === 0) {
      this.indicators.push({ uid: 'sma-short-default', type: 'SMA', period: 9, color: '#2563eb' });
      this.indicators.push({ uid: 'sma-long-default', type: 'SMA', period: 21, color: '#f59e0b' });
      this.colorIdx = 1;
    }
  }

  async start(): Promise<void> {
    if (!this.securityId || !this.timeframeId) return;
    this.resetTrainer();
    this.sessionKey = this.newSessionKey();
    this.loading = true;
    this.loadingError = null;
    this.cdr.markForCheck();
    try {
      let candles = await this.loadHistory(this.securityId, this.timeframeId, 3500);
      if (candles.length < 30) {
        candles = await this.autoLoadPrices(this.securityId, this.timeframeId);
      }
      if (candles.length < 30) {
        if (!this.loadingError) {
          this.loadingError = 'Не удалось загрузить достаточное количество исторических свечей для тренажёра.';
        }
        this.loading = false;
        this.dataLoading = false;
        this.cdr.markForCheck();
        return;
      }
      this.allCandles = candles;
      const reserve = Math.min(1500, Math.max(120, Math.floor(candles.length * 0.45)));
      this.playIndex = Math.max(20, candles.length - reserve);
      this.visibleCandles = candles.slice(0, this.playIndex);
      this.playbackStartDt = this.visibleCandles[this.visibleCandles.length - 1]?.dt ?? null;
      this.started = true;
      this.finished = false;
      this.playing = true;
      this.loading = false;
      this.rebuildIndicators();
      this.startTimer();
      this.cdr.markForCheck();
    } catch (err: any) {
      this.loading = false;
      this.dataLoading = false;
      this.dataLoadingMessage = '';
      this.loadingError = err?.message || 'Ошибка загрузки истории';
      this.cdr.markForCheck();
    }
  }

  private async autoLoadPrices(securityId: number, timeframeId: number): Promise<PriceCandle[]> {
    this.dataLoading = true;
    this.loadingError = null;
    this.dataLoadingMessage = 'Идёт загрузка данных…';
    this.cdr.markForCheck();
    try {
      const dateTo = new Date();
      const dateFrom = new Date();
      dateFrom.setDate(dateTo.getDate() - 120);
      await firstValueFrom(
        this.securitiesApi.loadPrices({
          security_id: securityId,
          timeframe_id: timeframeId,
          date_from: this.toDateStr(dateFrom),
          date_to: this.toDateStr(dateTo),
        })
      );
      this.dataLoadingMessage = 'Данные загружены, готовим график…';
      this.cdr.markForCheck();
      const candles = await this.loadHistory(securityId, timeframeId, 3500);
      this.dataLoading = false;
      this.dataLoadingMessage = '';
      this.cdr.markForCheck();
      return candles;
    } catch (err: any) {
      this.dataLoading = false;
      this.dataLoadingMessage = '';
      this.loadingError = err?.error?.error || err?.message || 'Ошибка загрузки данных';
      this.cdr.markForCheck();
      return [];
    }
  }

  private toDateStr(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private async loadHistory(securityId: number, timeframeId: number, target: number): Promise<PriceCandle[]> {
    const all: PriceCandle[] = [];
    let before: string | undefined;
    for (let i = 0; i < 8 && all.length < target; i++) {
      const batch = await firstValueFrom(this.securitiesApi.getPrices(securityId, timeframeId, 500, before));
      if (!batch || batch.length === 0) break;
      // getPrices returns asc
      const asc = batch.slice().sort((a, b) => a.dt.localeCompare(b.dt));
      if (all.length > 0 && asc[asc.length - 1].dt >= all[0].dt) {
        // overlap protection
        const filtered = asc.filter((c) => c.dt < all[0].dt);
        if (filtered.length === 0) break;
        all.unshift(...filtered);
        before = filtered[0].dt;
      } else {
        all.unshift(...asc);
        before = asc[0].dt;
      }
      if (batch.length < 2) break;
    }
    // dedupe by dt and normalize numeric fields (API may return strings)
    const seen = new Set<string>();
    const out: PriceCandle[] = [];
    for (const c of all) {
      if (seen.has(c.dt)) continue;
      seen.add(c.dt);
      out.push(normalizeCandle(c));
    }
    return out;
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = setInterval(() => this.tick(), this.speedMs);
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private stopPlayback(): void {
    this.playing = false;
    this.stopTimer();
  }

  togglePlay(): void {
    if (!this.started || this.finished) return;
    this.playing = !this.playing;
    if (this.playing) this.startTimer();
    else this.stopTimer();
    this.cdr.markForCheck();
  }

  onStartPauseClick(): void {
    if (!this.started || this.finished) {
      void this.start();
      return;
    }
    this.togglePlay();
  }

  get startPauseLabel(): string {
    if (!this.started || this.finished) return 'НАЧАТЬ';
    return this.playing ? 'ПАУЗА' : 'ПРОДОЛЖИТЬ';
  }

  onSpeedChange(): void {
    if (this.playing) this.startTimer();
  }

  speedUp(): void {
    const idx = this.speedOptions.findIndex(o => o.value === this.speedMs);
    if (idx > 0) {
      this.speedMs = this.speedOptions[idx - 1].value;
      this.onSpeedChange();
    }
  }

  speedDown(): void {
    const idx = this.speedOptions.findIndex(o => o.value === this.speedMs);
    if (idx >= 0 && idx < this.speedOptions.length - 1) {
      this.speedMs = this.speedOptions[idx + 1].value;
      this.onSpeedChange();
    }
  }

  private tick(): void {
    if (!this.playing) return;
    if (this.playIndex >= this.allCandles.length) {
      this.finished = true;
      this.stopPlayback();
      this.flushPendingOrder();
      this.saveSession();
      this.cdr.markForCheck();
      return;
    }
    const c = this.allCandles[this.playIndex++];
    this.visibleCandles = [...this.visibleCandles, c];
    this.rebuildIndicators();
    this.tryExecutePendingOrder();
    if (this.playIndex >= this.allCandles.length) {
      this.finished = true;
      this.stopPlayback();
      this.flushPendingOrder();
      this.saveSession();
    }
    this.cdr.markForCheck();
  }

  resetTrainer(): void {
    if (this.started) this.saveSession();
    this.stopPlayback();
    this.allCandles = [];
    this.visibleCandles = [];
    this.playIndex = 0;
    this.playbackStartDt = null;
    this.started = false;
    this.finished = false;
    this.position = 'flat';
    this.entryPrice = null;
    this.entryDt = null;
    this.entryVisibleIndex = null;
    this.pendingOrder = null;
    this.executionDelaySumSec = 0;
    this.executionDelayCount = 0;
    this.trades = [];
    this.totalPnl = 0;
    this.lastPnl = null;
    this.lastAnnualPct = null;
    this.tradeMarkers = [];
    this.signalMarkers = [];
    this.rebuildIndicators();
    this.cdr.markForCheck();
  }

  get currentPrice(): number | null {
    const c = this.visibleCandles[this.visibleCandles.length - 1];
    if (!c) return null;
    const n = Number(c.close_price);
    return Number.isFinite(n) ? n : null;
  }

  get currentDt(): string | null {
    const c = this.visibleCandles[this.visibleCandles.length - 1];
    return c ? c.dt : null;
  }

  get simulatedElapsed(): string {
    if (!this.playbackStartDt || !this.currentDt) return '—';
    const ms = dtToMs(this.currentDt) - dtToMs(this.playbackStartDt);
    if (!Number.isFinite(ms) || ms < 0) return '—';
    return formatDuration(ms);
  }

  get unrealizedPnl(): number | null {
    if (this.position === 'flat' || this.entryPrice == null || this.currentPrice == null) return null;
    const dir = this.position === 'long' ? 1 : -1;
    return (this.currentPrice - this.entryPrice) * dir;
  }

  get unrealizedPnlPct(): number | null {
    if (this.position === 'flat' || this.entryPrice == null || this.unrealizedPnl == null) return null;
    return (this.unrealizedPnl / this.entryPrice) * 100;
  }

  get unrealizedAnnualPct(): number | null {
    if (this.position === 'flat' || this.entryDt == null || this.currentDt == null) return null;
    const pnlPct = this.unrealizedPnlPct;
    if (pnlPct == null) return null;
    const holdMs = dtToMs(this.currentDt) - dtToMs(this.entryDt);
    if (!Number.isFinite(holdMs) || holdMs <= 0) return null;
    const holdDays = holdMs / 86400000;
    return (pnlPct / holdDays) * 365;
  }

  get currentHoldingMs(): number | null {
    if (this.position === 'flat' || this.entryDt == null || this.currentDt == null) return null;
    const ms = dtToMs(this.currentDt) - dtToMs(this.entryDt);
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
  }

  get positionHoldingText(): string {
    if (this.position !== 'flat') {
      const ms = this.currentHoldingMs;
      return ms == null ? '—' : formatDuration(ms);
    }
    const last = this.trades[0];
    if (!last) return '—';
    return formatDuration(Math.max(0, last.holdingMs ?? 0));
  }

  get lastTradeHoldingText(): string {
    const last = this.trades[0];
    if (!last) return '—';
    return formatDuration(Math.max(0, last.holdingMs ?? 0));
  }

  formatHoldingMs(ms: number | null | undefined): string {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
    return formatDuration(ms);
  }

  get totalPnlWithUnrealized(): number {
    return this.totalPnl + (this.unrealizedPnl ?? 0);
  }

  get totalAnnualPct(): number | null {
    const basePrice = this.trades.length > 0
      ? this.trades.reduce((s, t) => s + t.openPrice, 0) / this.trades.length
      : this.entryPrice;
    if (basePrice == null || !Number.isFinite(basePrice) || basePrice <= 0) return null;
    const pnl = this.totalPnlWithUnrealized;
    const pnlPct = (pnl / basePrice) * 100;
    const startDt = this.playbackStartDt ?? this.trades[this.trades.length - 1]?.openDt ?? this.entryDt;
    const endDt = this.currentDt ?? this.trades[0]?.closeDt ?? this.entryDt;
    if (!startDt || !endDt) return null;
    const holdMs = dtToMs(endDt) - dtToMs(startDt);
    if (!Number.isFinite(holdMs) || holdMs <= 0) return null;
    return (pnlPct / (holdMs / 86400000)) * 365;
  }

  get avgExecutionDelaySec(): number | null {
    if (this.executionDelayCount <= 0) return null;
    return this.executionDelaySumSec / this.executionDelayCount;
  }

  get totalTradingTimeText(): string {
    return this.simulatedElapsed;
  }

  get avgHoldingTimeText(): string {
    if (this.trades.length === 0) return '—';
    const sum = this.trades.reduce((acc, t) => acc + (Number.isFinite(t.holdingMs) ? Math.max(0, t.holdingMs) : 0), 0);
    return formatDuration(sum / this.trades.length);
  }

  get canBuy(): boolean {
    return this.started && !this.loading && !this.dataLoading && this.currentPrice != null && this.position !== 'long' && !this.pendingOrder;
  }

  get canSell(): boolean {
    return this.started && !this.loading && !this.dataLoading && this.currentPrice != null && this.position !== 'short' && !this.pendingOrder;
  }

  get pendingOrderText(): string | null {
    if (!this.pendingOrder) return null;
    const actionText = this.pendingOrder.action === 'close'
      ? (this.pendingOrder.side === 'long' ? 'Закрытие шорта' : 'Закрытие лонга')
      : (this.pendingOrder.side === 'long' ? 'Покупка' : 'Продажа');
    if (!this.currentDt) return `${actionText}: ожидание исполнения…`;
    const leftMs = this.pendingOrder.executeAtMs - dtToMs(this.currentDt);
    const leftSec = Math.max(0, Math.ceil(leftMs / 1000));
    return `${actionText}: исполнение через ~${leftSec} сек`;
  }

  buy(): void {
    if (!this.canBuy || this.currentPrice == null || this.currentDt == null) return;
    const action = this.position === 'short' ? 'close' : 'open';
    const side: 'long' | 'short' = 'long';
    this.queueOrExecute(side, action, this.currentDt);
  }

  sell(): void {
    if (!this.canSell || this.currentPrice == null || this.currentDt == null) return;
    const action = this.position === 'long' ? 'close' : 'open';
    const side: 'short' | 'long' = 'short';
    this.queueOrExecute(side, action, this.currentDt);
  }

  private queueOrExecute(side: 'long' | 'short', action: 'open' | 'close', dt: string): void {
    const delaySec = Math.max(0, Number(this.executionDelaySec) || 0);
    if (delaySec <= 0) {
      this.executeOrder(side, action, this.currentPrice!, this.currentDt!, dt);
      return;
    }
    const nowMs = dtToMs(dt);
    if (!Number.isFinite(nowMs) || nowMs <= 0) {
      this.executeOrder(side, action, this.currentPrice!, this.currentDt!, dt);
      return;
    }
    this.pendingOrder = {
      side,
      action,
      requestedDt: dt,
      executeAtMs: nowMs + delaySec * 1000,
    };
    this.cdr.markForCheck();
  }

  private tryExecutePendingOrder(): void {
    if (!this.pendingOrder || this.currentPrice == null || this.currentDt == null) return;
    const nowMs = dtToMs(this.currentDt);
    if (!Number.isFinite(nowMs)) return;
    if (nowMs >= this.pendingOrder.executeAtMs) {
      const { side, action, requestedDt } = this.pendingOrder;
      this.pendingOrder = null;
      this.executeOrder(side, action, this.currentPrice, this.currentDt, requestedDt);
    }
  }

  private flushPendingOrder(): void {
    if (!this.pendingOrder || this.currentPrice == null || this.currentDt == null) return;
    const { side, action, requestedDt } = this.pendingOrder;
    this.pendingOrder = null;
    this.executeOrder(side, action, this.currentPrice, this.currentDt, requestedDt);
  }

  private executeOrder(side: 'long' | 'short', action: 'open' | 'close', price: number, dt: string, requestedDt: string): void {
    const reqMs = dtToMs(requestedDt);
    const execMs = dtToMs(dt);
    if (Number.isFinite(reqMs) && Number.isFinite(execMs) && execMs >= reqMs) {
      this.executionDelaySumSec += (execMs - reqMs) / 1000;
      this.executionDelayCount += 1;
    }
    if (action === 'close') {
      // Only close if position matches the opposite of requested side (buy closes short, sell closes long)
      if (this.position === 'flat') return;
      if (side === 'long' && this.position !== 'short') return;
      if (side === 'short' && this.position !== 'long') return;
      this.closePosition(price, dt);
    } else {
      if (this.position !== 'flat') return;
      this.openPosition(side, price, dt);
    }
  }

  private openPosition(side: 'long' | 'short', price: number, dt: string): void {
    this.position = side;
    this.entryPrice = price;
    this.entryDt = dt;
    this.entryVisibleIndex = this.visibleCandles.length - 1;
    this.tradeMarkers = [
      ...this.tradeMarkers,
      { dt, price, kind: 'open', side, label: side === 'long' ? 'BUY' : 'SELL' },
    ];
    this.cdr.markForCheck();
  }

  private closePosition(price: number, dt: string): void {
    if (this.position === 'flat' || this.entryPrice == null || this.entryDt == null) return;
    const dir = this.position === 'long' ? 1 : -1;
    const grossPnl = (price - this.entryPrice) * dir;
    const commission = (this.entryPrice + price) * (Math.max(0, Number(this.commissionPct) || 0) / 100);
    const pnl = grossPnl - commission;
    const pnlPct = (pnl / this.entryPrice) * 100;
    const holdMs = dtToMs(dt) - dtToMs(this.entryDt);
    const holdDays = holdMs > 0 ? holdMs / 86400000 : null;
    const annualPct = holdDays != null ? (pnlPct / holdDays) * 365 : null;
    const trade: TrainerTrade = {
      id: this.tradeSeq++,
      side: this.position,
      openDt: this.entryDt,
      openPrice: this.entryPrice,
      closeDt: dt,
      closePrice: price,
      commission,
      pnl,
      pnlPct,
      annualPct,
      holdingMs: Math.max(0, holdMs),
    };
    this.trades = [trade, ...this.trades];
    this.totalPnl += pnl;
    this.lastPnl = pnl;
    this.lastAnnualPct = annualPct;
    this.lastPnlAt = Date.now();
    this.tradeMarkers = [
      ...this.tradeMarkers,
      { dt, price, kind: 'close', side: this.position, label: `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}` },
    ];
    this.position = 'flat';
    this.entryPrice = null;
    this.entryDt = null;
    this.entryVisibleIndex = null;
    this.cdr.markForCheck();
    setTimeout(() => {
      // keep lastPnl visible; just trigger refresh for animation class if needed
      this.cdr.markForCheck();
    }, 2500);
  }

  get selectedIndicatorDef(): IndicatorDef {
    return this.indicatorDefs.find((d) => d.code === this.addIndicatorType) ?? this.indicatorDefs[0];
  }

  onIndicatorTypeChange(): void {
    this.addIndicatorPeriod = this.selectedIndicatorDef.period;
  }

  indicatorLabel(code: IndicatorCode): string {
    return this.indicatorDefs.find((d) => d.code === code)?.name ?? code;
  }

  indicatorHasPeriod(code: IndicatorCode): boolean {
    return this.indicatorDefs.find((d) => d.code === code)?.hasPeriod ?? true;
  }

  addIndicator(): void {
    const def = this.selectedIndicatorDef;
    const period = def.hasPeriod ? Math.max(2, Math.min(500, Math.floor(Number(this.addIndicatorPeriod) || def.period))) : def.period;
    const color = this.palette[this.colorIdx % this.palette.length];
    this.colorIdx++;
    this.indicators = [
      ...this.indicators,
      { uid: `${this.addIndicatorType}-${Date.now()}-${Math.random()}`, type: this.addIndicatorType, period, color },
    ];
    this.rebuildIndicators();
    this.cdr.markForCheck();
  }

  removeIndicator(uid: string): void {
    this.indicators = this.indicators.filter((i) => i.uid !== uid);
    this.rebuildIndicators();
    this.cdr.markForCheck();
  }

  updateIndicatorPeriod(ind: LocalIndicator, value: any): void {
    if (!this.indicatorHasPeriod(ind.type)) return;
    const period = Math.max(2, Math.min(500, Math.floor(Number(value) || ind.period)));
    ind.period = period;
    this.rebuildIndicators();
    this.cdr.markForCheck();
  }

  private rebuildIndicators(): void {
    const candles = this.visibleCandles;
    const out: ChartIndicatorSeries[] = [];
    for (const ind of this.indicators) {
      const def = this.indicatorDefs.find((d) => d.code === ind.type);
      const onPrice = def?.onPrice ?? true;
      const period = Math.max(2, Math.floor(Number(ind.period) || 20));
      const label = def?.hasPeriod ? `${ind.type}(${period})` : ind.type;
      const mk = (line_code: string, line_name: string, color: string, points: Pt[], on_price_scale = onPrice): ChartIndicatorSeries => ({
        indicator_code: ind.type, line_code, line_name, color, on_price_scale, is_threshold: false, points,
      });
      switch (ind.type) {
        case 'SMA':
          out.push(mk('VALUE', label, ind.color, calcSma(candles, period))); break;
        case 'EMA':
          out.push(mk('VALUE', label, ind.color, calcEma(candles, period))); break;
        case 'WMA':
          out.push(mk('VALUE', label, ind.color, calcWma(candles, period))); break;
        case 'HMA':
          out.push(mk('VALUE', label, ind.color, calcHma(candles, period))); break;
        case 'VWAP':
          out.push(mk('VALUE', label, ind.color, calcVwap(candles))); break;
        case 'BB': {
          const bb = calcBb(candles, period, 2);
          out.push(mk('MIDDLE', `${label} Mid`, ind.color, bb.middle));
          out.push(mk('UPPER', `${label} Upper`, shiftColor(ind.color, 40), bb.upper));
          out.push(mk('LOWER', `${label} Lower`, shiftColor(ind.color, -40), bb.lower));
          break;
        }
        case 'DONCHIAN': {
          const d = calcDonchian(candles, period);
          out.push(mk('MIDDLE', `${label} Mid`, ind.color, d.middle));
          out.push(mk('UPPER', `${label} Upper`, shiftColor(ind.color, 40), d.upper));
          out.push(mk('LOWER', `${label} Lower`, shiftColor(ind.color, -40), d.lower));
          break;
        }
        case 'RSI':
          out.push(mk('VALUE', label, ind.color, calcRsi(candles, period), false)); break;
        case 'MACD': {
          const m = calcMacd(candles, period, 26, 9);
          out.push(mk('MACD', `${label} MACD`, ind.color, m.macd, false));
          out.push(mk('SIGNAL', `${label} Signal`, shiftColor(ind.color, 60), m.signal, false));
          out.push(mk('HIST', `${label} Hist`, shiftColor(ind.color, -60), m.hist, false));
          break;
        }
        case 'STOCH': {
          const s = calcStoch(candles, period, 3, 3);
          out.push(mk('K', `${label} %K`, ind.color, s.k, false));
          out.push(mk('D', `${label} %D`, shiftColor(ind.color, 60), s.d, false));
          break;
        }
        case 'ATR':
          out.push(mk('VALUE', label, ind.color, calcAtr(candles, period), false)); break;
        case 'CCI':
          out.push(mk('VALUE', label, ind.color, calcCci(candles, period), false)); break;
        case 'ADX': {
          const a = calcAdx(candles, period);
          out.push(mk('ADX', `${label} ADX`, ind.color, a.adx, false));
          out.push(mk('PDI', `${label} +DI`, shiftColor(ind.color, 60), a.pdi, false));
          out.push(mk('MDI', `${label} -DI`, shiftColor(ind.color, -60), a.mdi, false));
          break;
        }
        case 'ROC':
          out.push(mk('VALUE', label, ind.color, calcRoc(candles, period), false)); break;
        case 'OBV':
          out.push(mk('VALUE', label, ind.color, calcObv(candles), false)); break;
        case 'MFI':
          out.push(mk('VALUE', label, ind.color, calcMfi(candles, period), false)); break;
      }
    }
    this.indicatorSeries = out;
    this.signalMarkers = this.buildSignalMarkers(candles);
  }

  private buildSignalMarkers(candles: PriceCandle[]): ChartTradeMarker[] {
    if (candles.length < 5) return [];
    const out: ChartTradeMarker[] = [];
    const lastDt = candles[candles.length - 1]?.dt;
    for (const ind of this.indicators) {
      const period = Math.max(2, Math.floor(Number(ind.period) || 20));
      const sigs = this.signalsForIndicator(ind.type, period, candles);
      for (const s of sigs) {
        // keep only recent/relevant signals to avoid clutter; show all on visible range but limit density
        out.push({
          dt: s.dt,
          price: s.price,
          kind: 'signal',
          side: s.side,
          color: s.color ?? ind.color,
          topLabel: s.text,
        });
      }
    }
    // limit total signals to avoid heavy draw
    const max = 120;
    return out.length > max ? out.slice(out.length - max) : out;
  }

  private signalsForIndicator(type: IndicatorCode, period: number, candles: PriceCandle[]): Array<{ dt: string; price: number; side: 'long' | 'short'; text: string; color?: string }> {
    const c = candles;
    const close = (i: number) => c[i].close_price;
    const dt = (i: number) => c[i].dt;
    const price = (i: number) => c[i].close_price;
    const res: Array<{ dt: string; price: number; side: 'long' | 'short'; text: string; color?: string }> = [];
    const push = (i: number, side: 'long' | 'short', text: string, color?: string) => {
      if (i < 0 || i >= c.length) return;
      res.push({ dt: dt(i), price: price(i), side, text, color });
    };

    const crossUp = (prevA: number, prevB: number, curA: number, curB: number) => prevA <= prevB && curA > curB;
    const crossDown = (prevA: number, prevB: number, curA: number, curB: number) => prevA >= prevB && curA < curB;

    if (type === 'SMA' || type === 'EMA' || type === 'WMA' || type === 'HMA') {
      const pts = type === 'SMA' ? calcSma(c, period) : type === 'EMA' ? calcEma(c, period) : type === 'WMA' ? calcWma(c, period) : calcHma(c, period);
      const map = new Map(pts.map(p => [p.dt, p.value]));
      for (let i = 1; i < c.length; i++) {
        const v0 = map.get(dt(i - 1)); const v1 = map.get(dt(i));
        if (v0 == null || v1 == null) continue;
        if (crossUp(close(i - 1), v0, close(i), v1)) push(i, 'long', 'покупка тренд', '#16a34a');
        if (crossDown(close(i - 1), v0, close(i), v1)) push(i, 'short', 'продажа тренд', '#dc2626');
      }
      return res;
    }

    if (type === 'VWAP') {
      const pts = calcVwap(c);
      const map = new Map(pts.map(p => [p.dt, p.value]));
      for (let i = 1; i < c.length; i++) {
        const v0 = map.get(dt(i - 1)); const v1 = map.get(dt(i));
        if (v0 == null || v1 == null) continue;
        if (crossUp(close(i - 1), v0, close(i), v1)) push(i, 'long', 'покупка тренд', '#16a34a');
        if (crossDown(close(i - 1), v0, close(i), v1)) push(i, 'short', 'продажа тренд', '#dc2626');
      }
      return res;
    }

    if (type === 'BB') {
      const bb = calcBb(c, period, 2);
      const u = new Map(bb.upper.map(p => [p.dt, p.value]));
      const l = new Map(bb.lower.map(p => [p.dt, p.value]));
      for (let i = 1; i < c.length; i++) {
        const u0 = u.get(dt(i - 1)), u1 = u.get(dt(i)); const l0 = l.get(dt(i - 1)), l1 = l.get(dt(i));
        if (l0 != null && l1 != null && crossDown(close(i - 1), l0, close(i), l1)) push(i, 'long', 'покупка контртренд', '#22c55e');
        if (u0 != null && u1 != null && crossUp(close(i - 1), u0, close(i), u1)) push(i, 'short', 'продажа контртренд', '#f97316');
      }
      return res;
    }

    if (type === 'DONCHIAN') {
      const d = calcDonchian(c, period);
      const u = new Map(d.upper.map(p => [p.dt, p.value]));
      const l = new Map(d.lower.map(p => [p.dt, p.value]));
      for (let i = 1; i < c.length; i++) {
        const u0 = u.get(dt(i - 1)), u1 = u.get(dt(i)); const l0 = l.get(dt(i - 1)), l1 = l.get(dt(i));
        if (u0 != null && u1 != null && crossUp(close(i - 1), u0, close(i), u1)) push(i, 'long', 'пробой вверх', '#16a34a');
        if (l0 != null && l1 != null && crossDown(close(i - 1), l0, close(i), l1)) push(i, 'short', 'пробой вниз', '#dc2626');
      }
      return res;
    }

    if (type === 'RSI') {
      const pts = calcRsi(c, period);
      const map = new Map(pts.map(p => [p.dt, p.value]));
      for (let i = 1; i < c.length; i++) {
        const v0 = map.get(dt(i - 1)); const v1 = map.get(dt(i));
        if (v0 == null || v1 == null) continue;
        if (crossUp(v0, 30, v1, 30)) push(i, 'long', 'покупка контртренд', '#22c55e');
        if (crossDown(v0, 70, v1, 70)) push(i, 'short', 'продажа контртренд', '#f97316');
      }
      return res;
    }

    if (type === 'MACD') {
      const m = calcMacd(c, Math.max(2, period), 26, 9);
      const mm = new Map(m.macd.map(p => [p.dt, p.value]));
      const ms = new Map(m.signal.map(p => [p.dt, p.value]));
      for (let i = 1; i < c.length; i++) {
        const a0 = mm.get(dt(i - 1)), a1 = mm.get(dt(i)); const b0 = ms.get(dt(i - 1)), b1 = ms.get(dt(i));
        if (a0 == null || a1 == null || b0 == null || b1 == null) continue;
        if (crossUp(a0, b0, a1, b1)) push(i, 'long', 'покупка тренд', '#16a34a');
        if (crossDown(a0, b0, a1, b1)) push(i, 'short', 'продажа тренд', '#dc2626');
      }
      return res;
    }

    if (type === 'STOCH') {
      const s = calcStoch(c, period, 3, 3);
      const k = new Map(s.k.map(p => [p.dt, p.value]));
      const dmap = new Map(s.d.map(p => [p.dt, p.value]));
      for (let i = 1; i < c.length; i++) {
        const k0 = k.get(dt(i - 1)), k1 = k.get(dt(i)); const d0 = dmap.get(dt(i - 1)), d1 = dmap.get(dt(i));
        if (k0 == null || k1 == null || d0 == null || d1 == null) continue;
        if (crossUp(k0, d0, k1, d1) && k1 <= 25) push(i, 'long', 'покупка контртренд', '#22c55e');
        if (crossDown(k0, d0, k1, d1) && k1 >= 75) push(i, 'short', 'продажа контртренд', '#f97316');
      }
      return res;
    }

    if (type === 'ATR') {
      const pts = calcAtr(c, period);
      const map = new Map(pts.map(p => [p.dt, p.value]));
      for (let i = 1; i < c.length; i++) {
        const v0 = map.get(dt(i - 1)); const v1 = map.get(dt(i));
        if (v0 == null || v1 == null) continue;
        if (v1 > v0 * 1.15) push(i, 'long', 'волат. рост', '#f59e0b');
        if (v1 < v0 * 0.87) push(i, 'short', 'волат. спад', '#64748b');
      }
      return res;
    }

    if (type === 'CCI') {
      const pts = calcCci(c, period);
      const map = new Map(pts.map(p => [p.dt, p.value]));
      for (let i = 1; i < c.length; i++) {
        const v0 = map.get(dt(i - 1)); const v1 = map.get(dt(i));
        if (v0 == null || v1 == null) continue;
        if (crossUp(v0, -100, v1, -100)) push(i, 'long', 'покупка контртренд', '#22c55e');
        if (crossDown(v0, 100, v1, 100)) push(i, 'short', 'продажа контртренд', '#f97316');
      }
      return res;
    }

    if (type === 'ADX') {
      const a = calcAdx(c, period);
      const pdi = new Map(a.pdi.map(p => [p.dt, p.value]));
      const mdi = new Map(a.mdi.map(p => [p.dt, p.value]));
      const adx = new Map(a.adx.map(p => [p.dt, p.value]));
      for (let i = 1; i < c.length; i++) {
        const p0 = pdi.get(dt(i - 1)), p1 = pdi.get(dt(i)); const m0 = mdi.get(dt(i - 1)), m1 = mdi.get(dt(i));
        const ax1 = adx.get(dt(i));
        if (p0 == null || p1 == null || m0 == null || m1 == null || ax1 == null || ax1 < 20) continue;
        if (crossUp(p0, m0, p1, m1)) push(i, 'long', 'покупка тренд', '#16a34a');
        if (crossDown(p0, m0, p1, m1)) push(i, 'short', 'продажа тренд', '#dc2626');
      }
      return res;
    }

    if (type === 'ROC') {
      const pts = calcRoc(c, period);
      const map = new Map(pts.map(p => [p.dt, p.value]));
      for (let i = 1; i < c.length; i++) {
        const v0 = map.get(dt(i - 1)); const v1 = map.get(dt(i));
        if (v0 == null || v1 == null) continue;
        if (crossUp(v0, 0, v1, 0)) push(i, 'long', 'покупка тренд', '#16a34a');
        if (crossDown(v0, 0, v1, 0)) push(i, 'short', 'продажа тренд', '#dc2626');
      }
      return res;
    }

    if (type === 'OBV') {
      const pts = calcObv(c);
      const map = new Map(pts.map(p => [p.dt, p.value]));
      const sma = smaFromValues(pts, Math.max(5, Math.min(period, 20)));
      const smaMap = new Map(sma.map(p => [p.dt, p.value]));
      for (let i = 1; i < c.length; i++) {
        const v0 = map.get(dt(i - 1)); const v1 = map.get(dt(i));
        const s0 = smaMap.get(dt(i - 1)); const s1 = smaMap.get(dt(i));
        if (v0 == null || v1 == null || s0 == null || s1 == null) continue;
        if (crossUp(v0, s0, v1, s1)) push(i, 'long', 'покупка тренд', '#16a34a');
        if (crossDown(v0, s0, v1, s1)) push(i, 'short', 'продажа тренд', '#dc2626');
      }
      return res;
    }

    if (type === 'MFI') {
      const pts = calcMfi(c, period);
      const map = new Map(pts.map(p => [p.dt, p.value]));
      for (let i = 1; i < c.length; i++) {
        const v0 = map.get(dt(i - 1)); const v1 = map.get(dt(i));
        if (v0 == null || v1 == null) continue;
        if (crossUp(v0, 20, v1, 20)) push(i, 'long', 'покупка контртренд', '#22c55e');
        if (crossDown(v0, 80, v1, 80)) push(i, 'short', 'продажа контртренд', '#f97316');
      }
      return res;
    }

    return res;
  }

  openReport(): void {
    if (this.reportLoading) return;
    this.reportLoading = true;
    this.cdr.markForCheck();
    try {
      const security = this.securities.find(s => s.id === this.securityId);
      const tf = this.timeframes.find(t => t.id === this.timeframeId);
      const securityName = security?.name || 'Инструмент';
      const securityPrefix = security?.prefix || null;
      const tfLabel = tf?.full_name || tf?.tf || 'TF';
      const candles = this.allCandles.length ? this.allCandles : this.visibleCandles;
      const reportStartDt = this.playbackStartDt ?? candles[0]?.dt ?? this.trades[this.trades.length - 1]?.openDt ?? this.currentDt ?? '';
      const reportEndDt = this.currentDt ?? candles[candles.length - 1]?.dt ?? this.trades[0]?.closeDt ?? '';
      const avgTradeOpen = this.trades.length > 0
        ? this.trades.reduce((s, t) => s + t.openPrice, 0) / this.trades.length
        : (this.entryPrice ?? this.toNumber(candles[0]?.close_price) ?? 100000);
      const basePrice = Number.isFinite(avgTradeOpen) && avgTradeOpen > 0 ? avgTradeOpen : 100000;
      const initialBalance = Math.max(1, basePrice);

      const synthLogic: LogicRow = {
        id: 0,
        name: `Тренажёр: ${securityName}`,
        account_id: 0,
        broker_id: 0,
        is_enabled: true,
        timeframe: tf?.tf || 'M5',
        position_size_pct: 100,
        max_open_positions: 1,
        initial_balance: initialBalance,
        commission_pct: Number(this.commissionPct) || 0,
        cost_method: 'FIFO',
        base_annual_rate_pct: 0,
        inversion: false,
        cash_fund_code: null,
        account_type: 'fake',
        account_name: 'Тренажёр',
        account_code: 'TRAINER',
        current_balance: initialBalance + this.totalPnlWithUnrealized,
        test_initial_balance: initialBalance,
      } as unknown as LogicRow;

      const tradesChrono = [...this.trades].slice().reverse();
      const synthTrades: LogicTradeRow[] = [];
      let tradeId = 1;
      const avgDelay = this.avgExecutionDelaySec;
      for (const t of tradesChrono) {
        const dir = t.side === 'long' ? 'Long' : 'Short';
        const openRow: LogicTradeRow = {
          id: tradeId++,
          logic_id: 0,
          account_id: 0,
          security_id: this.securityId ?? 0,
          timeframe_id: this.timeframeId ?? 0,
          side_id: 1,
          action_id: t.side === 'long' ? 1 : 2,
          signal_kind: 'trend',
          signal_formula: 'TRAINER',
          quantity: 1,
          price: t.openPrice,
          bar_dt: t.openDt,
          executed_at: t.openDt,
          exec_delay_sec: avgDelay,
          is_simulated: true,
          is_fictitious: false,
          is_shadow: false,
          is_test: true,
          run_id: null,
          trade_reason: 'Тренажёр: открытие',
          broker_order_id: null,
          status: 'filled',
          commission: 0,
          financial_result: null,
          remaining_qty: 0,
          note: 'Тренажёр',
          opt_lane: null,
          security_name: securityName,
          security_prefix: securityPrefix,
          side_name: 'Open',
          action_name: dir,
          timeframe_tf: tf?.tf || 'M5',
        } as LogicTradeRow;
        const closeRow: LogicTradeRow = {
          id: tradeId++,
          logic_id: 0,
          account_id: 0,
          security_id: this.securityId ?? 0,
          timeframe_id: this.timeframeId ?? 0,
          side_id: 2,
          action_id: t.side === 'long' ? 1 : 2,
          signal_kind: 'trend',
          signal_formula: 'TRAINER',
          quantity: 1,
          price: t.closePrice,
          bar_dt: t.closeDt,
          executed_at: t.closeDt,
          exec_delay_sec: avgDelay,
          is_simulated: true,
          is_fictitious: false,
          is_shadow: false,
          is_test: true,
          run_id: null,
          trade_reason: 'Тренажёр: закрытие',
          broker_order_id: null,
          status: 'filled',
          commission: t.commission,
          financial_result: t.pnl,
          remaining_qty: null,
          note: 'Тренажёр',
          opt_lane: null,
          security_name: securityName,
          security_prefix: securityPrefix,
          side_name: 'Close',
          action_name: dir,
          timeframe_tf: tf?.tf || 'M5',
        } as LogicTradeRow;
        synthTrades.push(openRow, closeRow);
      }

      // If position is currently open, include a mark-to-market close so report stats
      // (net PnL, annual %, drawdown, equity) match the trainer's "Итог" with unrealized PnL.
      if (this.position !== 'flat' && this.entryDt != null && this.entryPrice != null) {
        const dir = this.position === 'long' ? 'Long' : 'Short';
        const mtmPrice = this.currentPrice ?? this.entryPrice;
        const mtmDt = this.currentDt ?? this.entryDt;
        const mtmPnl = this.unrealizedPnl ?? 0;
        synthTrades.push({
          id: tradeId++,
          logic_id: 0,
          account_id: 0,
          security_id: this.securityId ?? 0,
          timeframe_id: this.timeframeId ?? 0,
          side_id: 1,
          action_id: this.position === 'long' ? 1 : 2,
          signal_kind: 'trend',
          signal_formula: 'TRAINER',
          quantity: 1,
          price: this.entryPrice,
          bar_dt: this.entryDt,
          executed_at: this.entryDt,
          exec_delay_sec: avgDelay,
          is_simulated: true,
          is_fictitious: false,
          is_shadow: false,
          is_test: true,
          run_id: null,
          trade_reason: 'Тренажёр: открытие (текущая позиция)',
          broker_order_id: null,
          status: 'filled',
          commission: 0,
          financial_result: null,
          remaining_qty: 0,
          note: 'Тренажёр: текущая позиция',
          opt_lane: null,
          security_name: securityName,
          security_prefix: securityPrefix,
          side_name: 'Open',
          action_name: dir,
          timeframe_tf: tf?.tf || 'M5',
        } as LogicTradeRow);
        synthTrades.push({
          id: tradeId++,
          logic_id: 0,
          account_id: 0,
          security_id: this.securityId ?? 0,
          timeframe_id: this.timeframeId ?? 0,
          side_id: 2,
          action_id: this.position === 'long' ? 1 : 2,
          signal_kind: 'trend',
          signal_formula: 'TRAINER',
          quantity: 1,
          price: mtmPrice,
          bar_dt: mtmDt,
          executed_at: mtmDt,
          exec_delay_sec: avgDelay,
          is_simulated: true,
          is_fictitious: false,
          is_shadow: false,
          is_test: true,
          run_id: null,
          trade_reason: 'Тренажёр: текущая позиция (нереализ.)',
          broker_order_id: null,
          status: 'filled',
          commission: 0,
          financial_result: mtmPnl,
          remaining_qty: null,
          note: 'Mark-to-market: позиция ещё открыта',
          opt_lane: null,
          security_name: securityName,
          security_prefix: securityPrefix,
          side_name: 'Close',
          action_name: dir,
          timeframe_tf: tf?.tf || 'M5',
        } as LogicTradeRow);
      }

      const run: BacktestReportRunInfo = {
        status: this.finished ? 'completed' : (this.started ? 'running' : 'idle'),
        date_from: reportStartDt ? String(reportStartDt).slice(0, 10) : null,
        date_to: reportEndDt ? String(reportEndDt).slice(0, 10) : null,
        progress_pct: this.finished ? 100 : (this.allCandles.length > 0 ? Math.round((this.playIndex / this.allCandles.length) * 100) : null),
      };

      const equity: ChartEquityPoint[] = [];
      let cum = 0;
      for (const t of tradesChrono) {
        cum += t.pnl;
        equity.push({ dt: t.closeDt, value: cum });
      }
      if (this.position !== 'flat' && this.unrealizedPnl != null && this.currentDt) {
        equity.push({ dt: this.currentDt, value: cum + this.unrealizedPnl });
      }

      const paperChart: PaperReportChart = {
        securityId: this.securityId ?? 0,
        securityName,
        securityPrefix,
        timeframeLabel: tfLabel,
        candles: candles,
        indicators: this.indicatorSeries.map(s => ({
          indicator_code: s.indicator_code,
          line_code: s.line_code,
          line_name: s.line_name,
          color: s.color,
          on_price_scale: s.on_price_scale,
          is_threshold: s.is_threshold,
          points: s.points.map(p => ({ dt: p.dt, value: p.value })),
        })),
        trades: synthTrades.filter(t => t.security_id === (this.securityId ?? 0)),
        markers: this.tradeMarkers.filter(m => m.kind === 'open' || m.kind === 'close'),
        stops: [],
        shaded: [],
        equity,
        equityShadow: [],
        closes: buildPaperReportCloseRows(synthTrades),
        pnl: this.totalPnlWithUnrealized,
        dealCount: this.trades.length,
        openQty: this.position !== 'flat' ? 1 : 0,
        lastPrice: this.currentPrice,
        loadError: null,
      };

      const model = buildBacktestReportModel(synthLogic, synthTrades, {
        backtestRun: run,
        paperCharts: [paperChart],
        reportMode: 'test',
        configProvided: false,
      });

      const html = renderBacktestReportHtml(model);
      const title = `Отчёт тренажёра — ${securityName}`;
      const ok = openBacktestReportWindow(html, title);
      if (!ok) {
        this.loadingError = 'Браузер заблокировал окно отчёта. Разрешите всплывающие окна и попробуйте снова.';
      }
    } catch (err: any) {
      console.error('Trainer report error', err);
      this.loadingError = err?.message || 'Ошибка формирования отчёта тренажёра';
    } finally {
      this.reportLoading = false;
      this.cdr.markForCheck();
    }
  }

  /** Статистический отчёт по всем сохранённым сессиям (из БД). */
  async openStats(): Promise<void> {
    if (this.statsLoading) return;
    this.statsLoading = true;
    this.cdr.markForCheck();
    try {
      const stats = await firstValueFrom(this.trainerApi.getStats());
      const html = renderTrainerStatsHtml(stats);
      const ok = openBacktestReportWindow(html, 'Статистика тренировок — Тренажёр');
      if (!ok) {
        this.loadingError = 'Браузер заблокировал окно отчёта. Разрешите всплывающие окна и попробуйте снова.';
      }
    } catch (err: any) {
      console.error('Trainer stats error', err);
      this.loadingError = err?.error?.error || err?.message || 'Ошибка загрузки статистики тренажёра';
    } finally {
      this.statsLoading = false;
      this.cdr.markForCheck();
    }
  }

  private newSessionKey(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
      const r = (Math.random() * 16) | 0;
      const v = ch === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * Сохранение результатов сессии в БД (upsert по session_key).
   * Вызывается при завершении истории, «Начать заново»/смене настроек и уходе со вкладки.
   */
  private saveSession(): void {
    if (!this.sessionKey || !this.started) return;
    const security = this.securities.find(s => s.id === this.securityId);
    const tf = this.timeframes.find(t => t.id === this.timeframeId);
    const startMs = this.playbackStartDt ? dtToMs(this.playbackStartDt) : NaN;
    const endMs = this.currentDt ? dtToMs(this.currentDt) : NaN;
    const tradingMs = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
      ? endMs - startMs
      : null;

    const tradesChrono = [...this.trades].slice().reverse();
    const tradePayloads: TrainerTradeSavePayload[] = tradesChrono.map((t) => ({
      side: t.side,
      open_dt: t.openDt,
      open_price: t.openPrice,
      close_dt: t.closeDt,
      close_price: t.closePrice,
      commission: t.commission,
      pnl: t.pnl,
      pnl_pct: t.pnlPct,
      annual_pct: t.annualPct,
      holding_ms: Number.isFinite(t.holdingMs) ? t.holdingMs : null,
      is_open: false,
    }));
    // Открытая позиция сохраняется как mark-to-market строка (как в отчёте сессии).
    if (this.position !== 'flat' && this.entryDt != null && this.entryPrice != null) {
      const holdMs = this.currentDt ? dtToMs(this.currentDt) - dtToMs(this.entryDt) : null;
      tradePayloads.push({
        side: this.position,
        open_dt: this.entryDt,
        open_price: this.entryPrice,
        close_dt: this.currentDt,
        close_price: this.currentPrice,
        commission: 0,
        pnl: this.unrealizedPnl,
        pnl_pct: this.unrealizedPnlPct,
        annual_pct: this.unrealizedAnnualPct,
        holding_ms: holdMs != null && Number.isFinite(holdMs) ? Math.max(0, holdMs) : null,
        is_open: true,
      });
    }

    const payload: TrainerSessionSavePayload = {
      session_key: this.sessionKey,
      security_id: this.securityId,
      timeframe_id: this.timeframeId,
      security_name: security?.name || 'Инструмент',
      timeframe_tf: tf?.tf || 'M5',
      started_at: this.playbackStartDt,
      ended_at: this.currentDt,
      trading_ms: tradingMs,
      commission_pct: Number(this.commissionPct) || 0,
      exec_delay_sec: Number(this.executionDelaySec) || 0,
      finished: this.finished,
      total_pnl: this.totalPnl,
      unrealized_pnl: this.unrealizedPnl ?? 0,
      annual_pct: this.totalAnnualPct,
      avg_exec_delay_sec: this.avgExecutionDelaySec,
      trades: tradePayloads,
    };
    this.trainerApi.saveSession(payload).subscribe({
      error: (err) => console.error('Trainer session save error', err),
    });
  }

  formatPrice(v: number | string | null | undefined): string {
    const n = this.toNumber(v);
    if (n == null) return '—';
    return n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  }

  formatPnl(v: number | string | null | undefined): string {
    const n = this.toNumber(v);
    if (n == null) return '—';
    const sign = n > 0 ? '+' : '';
    return `${sign}${n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  formatPct(v: number | string | null | undefined): string {
    const n = this.toNumber(v);
    if (n == null) return '';
    const sign = n > 0 ? '+' : '';
    return `${sign}${n.toFixed(2)}%`;
  }

  pnlClass(v: number | string | null | undefined): string {
    const n = this.toNumber(v);
    if (n == null || n === 0) return 'pnl-flat';
    return n > 0 ? 'pnl-pos' : 'pnl-neg';
  }

  private toNumber(v: number | string | null | undefined): number | null {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  }

  trackByTrade(_: number, t: TrainerTrade): number { return t.id; }
  trackByInd(_: number, i: LocalIndicator): string { return i.uid; }
}

type Pt = { dt: string; value: number };

function calcSma(candles: PriceCandle[], period: number): Pt[] {
  const out: Pt[] = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    const v = candles[i].close_price;
    sum += v;
    if (i >= period) sum -= candles[i - period].close_price;
    if (i >= period - 1) out.push({ dt: candles[i].dt, value: sum / period });
  }
  return out;
}

function calcEma(candles: PriceCandle[], period: number): Pt[] {
  const out: Pt[] = [];
  if (candles.length < period) return out;
  const k = 2 / (period + 1);
  let ema = 0;
  for (let i = 0; i < period; i++) ema += candles[i].close_price;
  ema /= period;
  out.push({ dt: candles[period - 1].dt, value: ema });
  for (let i = period; i < candles.length; i++) {
    ema = candles[i].close_price * k + ema * (1 - k);
    out.push({ dt: candles[i].dt, value: ema });
  }
  return out;
}

function calcWma(candles: PriceCandle[], period: number): Pt[] {
  const out: Pt[] = [];
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += candles[i - period + 1 + j].close_price * (j + 1);
    out.push({ dt: candles[i].dt, value: sum / denom });
  }
  return out;
}

function calcHma(candles: PriceCandle[], period: number): Pt[] {
  const n2 = Math.max(2, Math.floor(period / 2));
  const sqrtN = Math.max(2, Math.round(Math.sqrt(period)));
  const wmaN = calcWma(candles, period);
  const wmaN2 = calcWma(candles, n2);
  const mapN = new Map(wmaN.map((p) => [p.dt, p.value]));
  const diff: Pt[] = [];
  for (const p of wmaN2) {
    const vN = mapN.get(p.dt);
    if (vN != null) diff.push({ dt: p.dt, value: 2 * p.value - vN });
  }
  if (diff.length < sqrtN) return [];
  const denom = (sqrtN * (sqrtN + 1)) / 2;
  const out: Pt[] = [];
  for (let i = sqrtN - 1; i < diff.length; i++) {
    let sum = 0;
    for (let j = 0; j < sqrtN; j++) sum += diff[i - sqrtN + 1 + j].value * (j + 1);
    out.push({ dt: diff[i].dt, value: sum / denom });
  }
  return out;
}

function calcVwap(candles: PriceCandle[]): Pt[] {
  let cumPV = 0;
  let cumV = 0;
  const out: Pt[] = [];
  for (const c of candles) {
    const typical = (c.high_price + c.low_price + c.close_price) / 3;
    const vol = Math.max(0, Number(c.volume) || 0);
    cumPV += typical * vol;
    cumV += vol;
    if (cumV > 0) out.push({ dt: c.dt, value: cumPV / cumV });
  }
  return out;
}

function calcBb(candles: PriceCandle[], period: number, mult: number): { middle: Pt[]; upper: Pt[]; lower: Pt[] } {
  const middle = calcSma(candles, period);
  const upper: Pt[] = [];
  const lower: Pt[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    let sumSq = 0;
    const mean = middle[i - period + 1]?.value;
    if (mean == null) continue;
    for (let j = i - period + 1; j <= i; j++) {
      const d = candles[j].close_price - mean;
      sumSq += d * d;
    }
    const std = Math.sqrt(sumSq / period);
    upper.push({ dt: candles[i].dt, value: mean + mult * std });
    lower.push({ dt: candles[i].dt, value: mean - mult * std });
  }
  return { middle, upper, lower };
}

function calcDonchian(candles: PriceCandle[], period: number): { middle: Pt[]; upper: Pt[]; lower: Pt[] } {
  const upper: Pt[] = [];
  const lower: Pt[] = [];
  const middle: Pt[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      hi = Math.max(hi, candles[j].high_price);
      lo = Math.min(lo, candles[j].low_price);
    }
    upper.push({ dt: candles[i].dt, value: hi });
    lower.push({ dt: candles[i].dt, value: lo });
    middle.push({ dt: candles[i].dt, value: (hi + lo) / 2 });
  }
  return { middle, upper, lower };
}

function calcRsi(candles: PriceCandle[], period: number): Pt[] {
  if (candles.length < period + 1) return [];
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close_price - candles[i - 1].close_price;
    if (diff >= 0) gain += diff; else loss -= diff;
  }
  gain /= period;
  loss /= period;
  const out: Pt[] = [];
  const rsi = (g: number, l: number) => (l === 0 ? 100 : 100 - 100 / (1 + g / l));
  out.push({ dt: candles[period].dt, value: rsi(gain, loss) });
  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close_price - candles[i - 1].close_price;
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    out.push({ dt: candles[i].dt, value: rsi(gain, loss) });
  }
  return out;
}

function emaFromValues(values: { dt: string; value: number }[], period: number): Pt[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  let ema = 0;
  for (let i = 0; i < period; i++) ema += values[i].value;
  ema /= period;
  const out: Pt[] = [{ dt: values[period - 1].dt, value: ema }];
  for (let i = period; i < values.length; i++) {
    ema = values[i].value * k + ema * (1 - k);
    out.push({ dt: values[i].dt, value: ema });
  }
  return out;
}

function calcMacd(candles: PriceCandle[], fast: number, slow: number, signal: number): { macd: Pt[]; signal: Pt[]; hist: Pt[] } {
  const emaFast = calcEma(candles, Math.max(2, fast));
  const emaSlow = calcEma(candles, Math.max(3, slow));
  const slowMap = new Map(emaSlow.map((p) => [p.dt, p.value]));
  const macd: Pt[] = [];
  for (const p of emaFast) {
    const s = slowMap.get(p.dt);
    if (s != null) macd.push({ dt: p.dt, value: p.value - s });
  }
  const sig = emaFromValues(macd, Math.max(2, signal));
  const sigMap = new Map(sig.map((p) => [p.dt, p.value]));
  const hist: Pt[] = [];
  for (const p of macd) {
    const sv = sigMap.get(p.dt);
    if (sv != null) hist.push({ dt: p.dt, value: p.value - sv });
  }
  return { macd, signal: sig, hist };
}

function calcStoch(candles: PriceCandle[], kPeriod: number, dPeriod: number, smooth: number): { k: Pt[]; d: Pt[] } {
  const rawK: Pt[] = [];
  for (let i = kPeriod - 1; i < candles.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      hi = Math.max(hi, candles[j].high_price);
      lo = Math.min(lo, candles[j].low_price);
    }
    const denom = hi - lo;
    const k = denom === 0 ? 50 : ((candles[i].close_price - lo) / denom) * 100;
    rawK.push({ dt: candles[i].dt, value: k });
  }
  const k = smooth > 1 ? smaFromValues(rawK, smooth) : rawK;
  const d = smaFromValues(k, Math.max(2, dPeriod));
  return { k, d };
}

function smaFromValues(values: Pt[], period: number): Pt[] {
  const out: Pt[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i].value;
    if (i >= period) sum -= values[i - period].value;
    if (i >= period - 1) out.push({ dt: values[i].dt, value: sum / period });
  }
  return out;
}

function calcAtr(candles: PriceCandle[], period: number): Pt[] {
  if (candles.length < 2) return [];
  const trs: Pt[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1].close_price;
    const tr = Math.max(c.high_price - c.low_price, Math.abs(c.high_price - prev), Math.abs(c.low_price - prev));
    trs.push({ dt: c.dt, value: tr });
  }
  if (trs.length < period) return [];
  let atr = 0;
  for (let i = 0; i < period; i++) atr += trs[i].value;
  atr /= period;
  const out: Pt[] = [{ dt: trs[period - 1].dt, value: atr }];
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i].value) / period;
    out.push({ dt: trs[i].dt, value: atr });
  }
  return out;
}

function calcCci(candles: PriceCandle[], period: number): Pt[] {
  const out: Pt[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    const tps: number[] = [];
    for (let j = i - period + 1; j <= i; j++) {
      const c = candles[j];
      tps.push((c.high_price + c.low_price + c.close_price) / 3);
    }
    const mean = tps.reduce((a, b) => a + b, 0) / period;
    const md = tps.reduce((a, b) => a + Math.abs(b - mean), 0) / period;
    const tp = tps[tps.length - 1];
    out.push({ dt: candles[i].dt, value: md === 0 ? 0 : (tp - mean) / (0.015 * md) });
  }
  return out;
}

function calcAdx(candles: PriceCandle[], period: number): { adx: Pt[]; pdi: Pt[]; mdi: Pt[] } {
  if (candles.length < period + 2) return { adx: [], pdi: [], mdi: [] };
  const trs: number[] = [];
  const plusDm: number[] = [];
  const minusDm: number[] = [];
  const dts: string[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const up = c.high_price - p.high_price;
    const dn = p.low_price - c.low_price;
    plusDm.push(up > dn && up > 0 ? up : 0);
    minusDm.push(dn > up && dn > 0 ? dn : 0);
    trs.push(Math.max(c.high_price - c.low_price, Math.abs(c.high_price - p.close_price), Math.abs(c.low_price - p.close_price)));
    dts.push(c.dt);
  }
  const rma = (arr: number[], per: number): number[] => {
    const res: number[] = [];
    let sum = 0;
    for (let i = 0; i < arr.length; i++) {
      if (i < per) { sum += arr[i]; if (i === per - 1) { sum /= per; res.push(sum); } continue; }
      sum = (sum * (per - 1) + arr[i]) / per;
      res.push(sum);
    }
    return res;
  };
  const atr = rma(trs, period);
  const pDm = rma(plusDm, period);
  const mDm = rma(minusDm, period);
  const offset = period - 1;
  const dx: number[] = [];
  const pdi: Pt[] = [];
  const mdi: Pt[] = [];
  for (let i = 0; i < atr.length; i++) {
    const a = atr[i];
    const pdiV = a === 0 ? 0 : (100 * pDm[i]) / a;
    const mdiV = a === 0 ? 0 : (100 * mDm[i]) / a;
    const sum = pdiV + mdiV;
    const dxV = sum === 0 ? 0 : (100 * Math.abs(pdiV - mdiV)) / sum;
    const dt = dts[i + offset];
    pdi.push({ dt, value: pdiV });
    mdi.push({ dt, value: mdiV });
    dx.push(dxV);
  }
  const adxVals = rma(dx, period);
  const adx: Pt[] = [];
  const adxOffset = period - 1;
  for (let i = 0; i < adxVals.length; i++) {
    adx.push({ dt: pdi[i + adxOffset].dt, value: adxVals[i] });
  }
  return { adx, pdi, mdi };
}

function calcRoc(candles: PriceCandle[], period: number): Pt[] {
  const out: Pt[] = [];
  for (let i = period; i < candles.length; i++) {
    const prev = candles[i - period].close_price;
    if (prev !== 0) out.push({ dt: candles[i].dt, value: ((candles[i].close_price - prev) / prev) * 100 });
  }
  return out;
}

function calcObv(candles: PriceCandle[]): Pt[] {
  if (candles.length === 0) return [];
  let obv = 0;
  const out: Pt[] = [{ dt: candles[0].dt, value: obv }];
  for (let i = 1; i < candles.length; i++) {
    const vol = Math.max(0, Number(candles[i].volume) || 0);
    if (candles[i].close_price > candles[i - 1].close_price) obv += vol;
    else if (candles[i].close_price < candles[i - 1].close_price) obv -= vol;
    out.push({ dt: candles[i].dt, value: obv });
  }
  return out;
}

function calcMfi(candles: PriceCandle[], period: number): Pt[] {
  if (candles.length < period + 1) return [];
  const typical = (c: PriceCandle) => (c.high_price + c.low_price + c.close_price) / 3;
  const out: Pt[] = [];
  for (let i = period; i < candles.length; i++) {
    let pos = 0;
    let neg = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const tp = typical(candles[j]);
      const prevTp = typical(candles[j - 1]);
      const flow = tp * Math.max(0, Number(candles[j].volume) || 0);
      if (tp > prevTp) pos += flow;
      else if (tp < prevTp) neg += flow;
    }
    const mfi = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
    out.push({ dt: candles[i].dt, value: mfi });
  }
  return out;
}

function shiftColor(hex: string, amount: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return hex;
  const clamp = (n: number) => Math.max(0, Math.min(255, n));
  const r = clamp(parseInt(m[1], 16) + amount);
  const g = clamp(parseInt(m[2], 16) + amount);
  const b = clamp(parseInt(m[3], 16) + amount);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeCandle(c: PriceCandle): PriceCandle {
  return {
    ...c,
    open_price: toNum(c.open_price),
    high_price: toNum(c.high_price),
    low_price: toNum(c.low_price),
    close_price: toNum(c.close_price),
    volume: toNum(c.volume),
  };
}

function dtToMs(dt: string): number {
  const t = Date.parse(String(dt).replace(' ', 'T'));
  return Number.isFinite(t) ? t : 0;
}

function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} д`);
  if (hours > 0 || days > 0) parts.push(`${hours} ч`);
  parts.push(`${mins} мин`);
  return parts.join(' ');
}



