import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
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
import { MonitoringService } from '../services/monitoring.service';
import { renderTrainerStatsHtml } from './trainer-stats-report';
import {
  ChartEquityPoint,
  ChartIndicatorSeries,
  ChartTradeMarker,
  PriceCandle,
  SecurityRow,
  TimeframeRow,
} from '../models/market.model';
import { AccountRow, ExchangeRow } from '../models/lookup.model';
import { TerminalStateService } from '../services/terminal-state.service';
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

interface TrainerBlock {
  id: string;
  securityId: number | null;
  securityName: string;
  allCandles: PriceCandle[];
  visibleCandles: PriceCandle[];
  playIndex: number;
  playing: boolean;
  started: boolean;
  hasPlayed: boolean;
  finished: boolean;
  loading: boolean;
  loadingError: string | null;
  position: PositionSide;
  entryPrice: number | null;
  entryDt: string | null;
  entryVisibleIndex: number | null;
  entryWallMs: number | null;
  battlePositionQty: number;
  positionQty: number;
  entryCommission: number;
  trades: TrainerTrade[];
  totalPnl: number;
  lastPnl: number | null;
  lastPnlPct: number | null;
  lastAnnualPct: number | null;
  tradeMarkers: ChartTradeMarker[];
  signalMarkers: ChartTradeMarker[];
  pendingOrder: { side: 'long' | 'short'; action: 'open' | 'close'; requestedDt: string; executeAtMs: number } | null;
  executionDelaySumSec: number;
  executionDelayCount: number;
  playbackStartDt: string | null;
  indicators: LocalIndicator[];
  indicatorSeries: ChartIndicatorSeries[];
  addIndicatorType: IndicatorCode;
  addIndicatorPeriod: number;
  colorIdx: number;
  detailsOpen: boolean;
  reportLoading: boolean;
  sessionKey: string | null;
  timer: ReturnType<typeof setInterval> | null;
}

function createBlock(securityId: number | null, securityName: string): TrainerBlock {
  return {
    id: `blk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    securityId,
    securityName,
    allCandles: [],
    visibleCandles: [],
    playIndex: 0,
    playing: false,
    started: false,
    hasPlayed: false,
    finished: false,
    loading: false,
    loadingError: null,
    position: 'flat',
    entryPrice: null,
    entryDt: null,
    entryVisibleIndex: null,
    entryWallMs: null,
    battlePositionQty: 0,
    positionQty: 1,
    entryCommission: 0,
    trades: [],
    totalPnl: 0,
    lastPnl: null,
    lastPnlPct: null,
    lastAnnualPct: null,
    tradeMarkers: [],
    signalMarkers: [],
    pendingOrder: null,
    executionDelaySumSec: 0,
    executionDelayCount: 0,
    playbackStartDt: null,
    indicators: [
      { uid: 'sma-short-default', type: 'SMA', period: 9, color: '#2563eb' },
      { uid: 'sma-long-default', type: 'SMA', period: 21, color: '#f59e0b' },
    ],
    indicatorSeries: [],
    addIndicatorType: 'SMA',
    addIndicatorPeriod: 20,
    colorIdx: 0,
    detailsOpen: false,
    reportLoading: false,
    sessionKey: null,
    timer: null,
  };
}

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
  private readonly monitorApi = inject(MonitoringService);
  private readonly terminalApi = inject(TerminalStateService);
  readonly cdr = inject(ChangeDetectorRef);
  private readonly el = inject(ElementRef<HTMLElement>);

  exchanges: ExchangeRow[] = [];
  securities: SecurityRow[] = [];
  timeframes: TimeframeRow[] = [];
  securityPickerOpen = false;
  securityUsageById: Record<number, number> = {};
  private securityMaxUsage = 0;

  exchangeId: number | null = null;
  securityKind: 'stock' | 'futures' | 'other' = 'stock';
  addSecurityId: number | null = null;
  timeframeId: number | null = null;

  readonly securityKindOptions: Array<{ value: 'stock' | 'futures' | 'other'; label: string }> = [
    { value: 'stock', label: 'Акции' },
    { value: 'futures', label: 'Фьючерсы' },
    { value: 'other', label: 'Валюта / Товары / Другое' },
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

  loading = false;
  loadingError: string | null = null;
  dataLoading = false;
  dataLoadingMessage = '';
  dataLoadingPercent: number | null = null;
  dataLoadingStage = '';
  statsLoading = false;
  globalReportLoading = false;
  totalDetailsOpen = false;
  private dataLoadSlowTimer: ReturnType<typeof setTimeout> | null = null;
  private dataLoadStartedAt = 0;

  // Боевой режим
  battleMode = false;
  battleAccounts: AccountRow[] = [];
  battleAccountId: number | null = null;
  battleDepositPct = 10;
  battleLoading = false;
  battlePlacing = false;
  battlePickerOpen = false;
  private liveTimer: ReturnType<typeof setInterval> | null = null;
  private battleLiveBusy = false;
  private battleTickTimer: ReturnType<typeof setInterval> | null = null;

  blocks: TrainerBlock[] = [];
  fullscreen = false;

  async enterFullscreen(): Promise<void> {
    this.fullscreen = true;
    this.cdr.markForCheck();
    try {
      const root = this.el.nativeElement.querySelector('.trainer-page') as HTMLElement | null;
      const target = root ?? this.el.nativeElement;
      if (target && !document.fullscreenElement && (target as any).requestFullscreen) {
        await (target as any).requestFullscreen();
      }
    } catch { /* ignore */ }
  }

  async exitFullscreenMode(): Promise<void> {
    this.fullscreen = false;
    this.cdr.markForCheck();
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
    } catch { /* ignore */ }
  }

  @HostListener('document:fullscreenchange')
  onFullscreenChange(): void {
    const root = this.el.nativeElement.querySelector('.trainer-page');
    const active = !!document.fullscreenElement && (document.fullscreenElement === root || root?.contains(document.fullscreenElement) || document.fullscreenElement === this.el.nativeElement);
    if (!active && this.fullscreen) {
      this.fullscreen = false;
      this.cdr.markForCheck();
    }
  }

  readonly indicatorDefs = INDICATOR_DEFS;
  private readonly palette = ['#f59e0b', '#8b5cf6', '#06b6d4', '#22c55e', '#ef4444', '#3b82f6', '#ec4899', '#14b8a6', '#84cc16'];
  private subs: Subscription[] = [];

  ngOnInit(): void {
    this.loadLookups();
    this.loadSecurityUsage();
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target as Node | null;
    if (!target) return;
    if (this.securityPickerOpen) {
      const picker = this.el.nativeElement.querySelector('.instrument-picker');
      const trigger = this.el.nativeElement.querySelector('.instrument-trigger');
      if (picker?.contains(target) || trigger?.contains(target)) return;
      this.securityPickerOpen = false;
    }
    if (this.battlePickerOpen) {
      const bp = this.el.nativeElement.querySelector('.battle-picker');
      const bt = this.el.nativeElement.querySelector('.btn-battle');
      if (bp?.contains(target) || bt?.contains(target)) return;
      this.battlePickerOpen = false;
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.fullscreen) this.fullscreen = false;
  }

  ngOnDestroy(): void {
    this.stopLiveTimer();
    for (const b of this.blocks) {
      this.stopBlockTimer(b);
      if (b.started && !this.battleMode) this.saveSession(b);
    }
    this.subs.forEach((s) => s.unsubscribe());
    this.clearDataLoadSlowTimer();
  }

  private loadLookups(): void {
    forkJoin({
      exchanges: this.refsApi.getExchanges(),
      timeframes: this.securitiesApi.getTimeframes(),
    }).subscribe({
      next: ({ exchanges, timeframes }) => {
        this.exchanges = exchanges ?? [];
        this.timeframes = (timeframes ?? []).slice().sort((a, b) => a.sec - b.sec);
        this.exchangeId = this.exchanges.find((e: any) => e.is_active)?.id ?? this.exchanges[0]?.id ?? null;
        const tf5 = this.timeframes.find((t) => t.sec === 300);
        this.timeframeId = tf5?.id ?? this.timeframes.find((t) => t.is_active)?.id ?? this.timeframes[0]?.id ?? null;
        if (this.exchangeId != null) this.loadSecurities(this.exchangeId);
        this.cdr.markForCheck();
      },
      error: (err) => {
        console.error('Trainer lookups load error', err);
        this.cdr.markForCheck();
      },
    });
  }

  private loadSecurityUsage(): void {
    this.trainerApi.getStats().subscribe({
      next: (stats) => {
        const map: Record<number, number> = {};
        for (const row of stats?.bySecurity ?? []) {
          const id = Number(row.security_id);
          const n = Number(row.trades) || 0;
          if (id > 0) map[id] = (map[id] ?? 0) + n;
        }
        this.securityUsageById = map;
        this.updateSecurityUsageMax();
        this.cdr.markForCheck();
      },
      error: () => { /* не блокируем UI тренажёра */ },
    });
  }

  private updateSecurityUsageMax(): void {
    let max = 0;
    for (const s of this.securities) {
      const n = this.securityUsageById[s.id] ?? 0;
      if (n > max) max = n;
    }
    this.securityMaxUsage = max;
  }

  securityUsageScore(secId: number | null): number {
    if (secId == null) return 0;
    return this.securityUsageById[secId] ?? 0;
  }

  securityUsageFillPct(secId: number | null): number {
    const n = this.securityUsageScore(secId);
    if (n <= 0 || this.securityMaxUsage <= 0) return 0;
    return Math.max(8, Math.round((n / this.securityMaxUsage) * 100));
  }

  securityUsageBg(secId: number | null): string {
    const pct = this.securityUsageFillPct(secId);
    if (pct <= 0) return '#ffffff';
    return `linear-gradient(90deg, rgba(187, 247, 208, 0.75) 0%, rgba(187, 247, 208, 0.75) ${pct}%, #ffffff ${pct}%, #ffffff 100%)`;
  }

  get selectedAddSecurityName(): string {
    const s = this.securities.find((x) => x.id === this.addSecurityId);
    return s?.name || 'Выберите инструмент';
  }

  toggleSecurityPicker(): void {
    this.securityPickerOpen = !this.securityPickerOpen;
  }

  closeSecurityPicker(): void {
    this.securityPickerOpen = false;
  }

  selectAddSecurity(id: number): void {
    this.addSecurityId = id;
    this.securityPickerOpen = false;
  }

  private loadSecurities(exchangeId: number): void {
    const kind = this.securityKind;
    this.securitiesApi.getSecurities(exchangeId, kind).subscribe({
      next: (list) => {
        this.securities = (list ?? []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'));
        if (this.addSecurityId != null && !this.securities.some((s) => s.id === this.addSecurityId)) this.addSecurityId = null;
        if (this.addSecurityId == null && this.securities.length > 0) {
          const gld = this.securities.find((s) => /gld|золот/i.test(s.name));
          this.addSecurityId = gld?.id ?? this.securities[0].id;
        }
        this.updateSecurityUsageMax();
        this.cdr.markForCheck();
      },
      error: (err) => {
        console.error('Trainer securities load error', err);
        this.cdr.markForCheck();
      },
    });
  }

  onExchangeChange(): void {
    this.addSecurityId = null;
    this.securities = [];
    if (this.exchangeId != null) this.loadSecurities(this.exchangeId);
  }

  onSecurityKindChange(): void {
    this.addSecurityId = null;
    if (this.exchangeId != null) this.loadSecurities(this.exchangeId);
  }


  addBlock(): void {
    if (this.addSecurityId == null) return;
    const sec = this.securities.find((s) => s.id === this.addSecurityId);
    const block = createBlock(this.addSecurityId, sec?.name || `Инструмент ${this.addSecurityId}`);
    this.blocks = [...this.blocks, block];
    this.cdr.markForCheck();
    void this.startBlock(block);
  }

  removeBlock(block: TrainerBlock): void {
    if (block.started && !this.battleMode) this.saveSession(block);
    this.stopBlockTimer(block);
    this.blocks = this.blocks.filter((b) => b.id !== block.id);
    this.cdr.markForCheck();
  }

  // ---- loading helpers (global overlay) ----
  private beginDataLoading(stage: string, percent: number | null = 0): void {
    this.dataLoading = true;
    this.loading = true;
    this.loadingError = null;
    this.dataLoadingStage = stage;
    this.dataLoadingMessage = stage;
    this.dataLoadingPercent = percent;
    this.dataLoadStartedAt = Date.now();
    this.clearDataLoadSlowTimer();
    this.armDataLoadSlowTimer(stage);
    this.cdr.markForCheck();
  }

  private setDataLoading(stage: string, percent: number | null): void {
    if (!this.dataLoading) return;
    this.dataLoadingStage = stage;
    this.dataLoadingMessage = stage;
    this.dataLoadingPercent = percent;
    this.clearDataLoadSlowTimer();
    this.armDataLoadSlowTimer(stage);
    this.cdr.markForCheck();
  }

  private endDataLoading(): void {
    this.clearDataLoadSlowTimer();
    this.dataLoading = false;
    this.loading = false;
    this.dataLoadingMessage = '';
    this.dataLoadingPercent = null;
    this.dataLoadingStage = '';
    this.cdr.markForCheck();
  }

  private clearDataLoadSlowTimer(): void {
    if (this.dataLoadSlowTimer) {
      clearTimeout(this.dataLoadSlowTimer);
      this.dataLoadSlowTimer = null;
    }
  }

  private armDataLoadSlowTimer(stage: string): void {
    this.dataLoadSlowTimer = setTimeout(() => {
      this.dataLoadSlowTimer = null;
      if (!this.dataLoading) return;
      const sec = Math.max(1, Math.round((Date.now() - this.dataLoadStartedAt) / 1000));
      this.reportDataLoadIssue(
        'warning',
        'Тренажёр: долгая загрузка',
        `Этап: ${stage}. Инструмент ${sec}с.`,
        { stage, elapsedSec: sec }
      );
      this.dataLoadSlowTimer = setTimeout(() => {
        this.dataLoadSlowTimer = null;
        if (!this.dataLoading) return;
        const sec2 = Math.max(1, Math.round((Date.now() - this.dataLoadStartedAt) / 1000));
        this.reportDataLoadIssue(
          'error',
          'Тренажёр: нет ответа при загрузке',
          `Этап: ${stage}. Инструмент ${sec2}с.`,
          { stage, elapsedSec: sec2 }
        );
      }, 15000);
    }, 10000);
  }

  private reportDataLoadIssue(
    level: 'warning' | 'error',
    message: string,
    detail: string,
    context: Record<string, unknown> = {}
  ): void {
    console[level === 'error' ? 'error' : 'warn']('[trainer]', message, detail, context);
    this.monitorApi.reportClientEvent({
      kind: 'web_hang',
      phase: level === 'error' ? 'error' : 'stall',
      message,
      detail,
      endpoint: 'trainer',
      context: { ...context, source: 'client.trainer', category: 'ui.data-load', level, url: typeof location !== 'undefined' ? location.href : '' },
    } as any).subscribe({ error: () => { /* ignore */ } });
  }

  // ---- block start / load ----
  async startBlock(b: TrainerBlock): Promise<void> {
    if (b.securityId == null || this.timeframeId == null) return;
    if (b.started && !this.battleMode) this.saveSession(b);
    this.stopBlockTimer(b);
    b.sessionKey = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `trainer-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    b.playIndex = 0;
    b.visibleCandles = [];
    b.allCandles = [];
    b.playbackStartDt = null;
    b.trades = [];
    b.totalPnl = 0;
    b.lastPnl = null;
    b.lastAnnualPct = null;
    b.position = 'flat';
    b.entryPrice = null;
    b.entryDt = null;
    b.entryVisibleIndex = null;
    b.entryWallMs = null;
    b.battlePositionQty = 0;
    b.positionQty = 1;
    b.entryCommission = 0;
    b.pendingOrder = null;
    b.executionDelaySumSec = 0;
    b.executionDelayCount = 0;
    b.tradeMarkers = [];
    b.signalMarkers = [];
    b.loadingError = null;
    b.started = true;
    b.finished = false;
    b.playing = false;
    b.loading = true;
    this.beginDataLoading(`Загрузка истории: ${b.securityName}`, 0);
    this.cdr.markForCheck();

    try {
      this.setDataLoading(`Загрузка свечей: ${b.securityName}`, 15);
      let candles = await this.loadHistory(b.securityId, this.timeframeId, b);
      if (candles.length === 0) {
        this.setDataLoading(`Автозагрузка цен: ${b.securityName}`, 45);
        candles = await this.autoLoadPrices(b.securityId, this.timeframeId, b);
      }
      if (candles.length === 0) {
        throw new Error('Нет исторических свечей по выбранному инструменту и таймфрейму. Проверьте, что данные загружены на вкладке «Данные».');
      }
      this.setDataLoading(`Подготовка графика: ${b.securityName}`, 85);
      b.allCandles = candles;
      const reserve = Math.min(1500, Math.max(120, Math.floor(candles.length * 0.45)));
      b.playIndex = Math.max(20, candles.length - reserve);
      b.visibleCandles = candles.slice(0, b.playIndex);
      b.playbackStartDt = b.visibleCandles[b.visibleCandles.length - 1]?.dt ?? candles[0]?.dt ?? null;
      b.playing = false;
      b.hasPlayed = false;
      this.rebuildIndicators(b);
      this.setDataLoading(`Готово: ${b.securityName}`, 100);
    } catch (e: any) {
      console.error('Trainer start error', e);
      b.loadingError = e?.error?.error || e?.error?.message || e?.message || 'Ошибка загрузки данных';
      b.started = false;
      this.reportDataLoadIssue('error', 'Тренажёр: ошибка загрузки', String(b.loadingError), { block: b.securityName });
    } finally {
      b.loading = false;
      this.endDataLoading();
      this.cdr.markForCheck();
    }
  }

  private async autoLoadPrices(securityId: number, timeframeId: number, b: TrainerBlock): Promise<PriceCandle[]> {
    const to = new Date();
    const from = new Date(to.getTime() - 365 * 24 * 3600 * 1000);
    const dateFrom = this.toDateStr(from);
    const dateTo = this.toDateStr(to);
    const res: any = await firstValueFrom(this.securitiesApi.loadPrices({ security_id: securityId, timeframe_id: timeframeId, date_from: dateFrom, date_to: dateTo }));
    if (res && res.ok === false) throw new Error(res?.error || 'Не удалось автоматически загрузить цены');
    // простое ожидание и перечитывание истории
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      if (!b.started) return [];
      this.setDataLoading(`Автозагрузка: ${b.securityName}`, Math.min(84, 45 + i * 1.3));
      const candles = await this.loadHistory(securityId, timeframeId, b);
      if (candles.length > 0) return candles;
    }
    return await this.loadHistory(securityId, timeframeId, b);
  }

  private toDateStr(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private async loadHistory(securityId: number, timeframeId: number, b: TrainerBlock): Promise<PriceCandle[]> {
    const batch = await firstValueFrom(this.securitiesApi.getPrices(securityId, timeframeId, 1200, undefined));
    let all = (batch ?? []).slice().sort((a, c) => a.dt.localeCompare(c.dt));
    // load older pages
    let before = all.length > 0 ? all[0].dt : undefined;
    for (let i = 0; i < 6 && before; i++) {
      const older = await firstValueFrom(this.securitiesApi.getPrices(securityId, timeframeId, 1200, before));
      const chunk = (older ?? []).slice().sort((a, c) => a.dt.localeCompare(c.dt));
      if (chunk.length === 0) break;
      const firstDt = all[0]?.dt;
      const prepend = firstDt ? chunk.filter((cnd) => cnd.dt < firstDt) : chunk;
      if (prepend.length === 0) break;
      all = [...prepend, ...all];
      before = all[0].dt;
      this.setDataLoading(`Загрузка истории: ${b.securityName} (${all.length} свечей)`, Math.min(80, 15 + i * 10));
      if (all.length >= 6000) break;
    }
    return all.map(normalizeCandle);
  }

  // ---- playback ----
  private startBlockTimer(b: TrainerBlock): void {
    this.stopBlockTimer(b);
    b.timer = setInterval(() => this.tick(b), this.speedMs);
  }

  private stopBlockTimer(b: TrainerBlock): void {
    if (b.timer) { clearInterval(b.timer); b.timer = null; }
  }

  private stopPlayback(b: TrainerBlock): void {
    b.playing = false;
    this.stopBlockTimer(b);
  }

  togglePlay(b: TrainerBlock): void {
    if (!b.started || b.finished) return;
    b.playing = !b.playing;
    if (b.playing) { b.hasPlayed = true; this.startBlockTimer(b); }
    else this.stopBlockTimer(b);
  }

  onReplaySeek(b: TrainerBlock, idx: number): void {
    b.playIndex = Math.max(0, Math.min(Number(idx) || 0, b.allCandles.length));
    b.visibleCandles = b.allCandles.slice(0, b.playIndex);
    this.rebuildIndicators(b);
    this.cdr.markForCheck();
  }

  async onStartPauseClick(b: TrainerBlock): Promise<void> {
    if (!b.started || b.finished) {
      await this.startBlock(b);
      if (b.started && !b.finished && !this.battleMode && !b.playing) {
        b.playing = true;
        b.hasPlayed = true;
        this.startBlockTimer(b);
        this.cdr.markForCheck();
      }
      return;
    }
    if (this.battleMode) return;
    this.togglePlay(b);
  }

  startPauseLabel(b: TrainerBlock): string {
    if (!b.started || b.finished) return 'Начать';
    if (b.playing) return 'Пауза';
    return b.hasPlayed ? 'Продолжить' : 'Начать';
  }

  onSpeedChange(): void {
    if (this.battleMode) return;
    for (const b of this.blocks) {
      if (b.playing) this.startBlockTimer(b);
    }
  }

  speedUp(): void {
    const idx = this.speedOptions.findIndex((o) => o.value === this.speedMs);
    if (idx > 0) { this.speedMs = this.speedOptions[idx - 1].value; this.onSpeedChange(); }
  }

  speedDown(): void {
    const idx = this.speedOptions.findIndex((o) => o.value === this.speedMs);
    if (idx >= 0 && idx < this.speedOptions.length - 1) { this.speedMs = this.speedOptions[idx + 1].value; this.onSpeedChange(); }
  }

  private tick(b: TrainerBlock): void {
    if (!b.playing) return;
    if (b.playIndex < b.allCandles.length) {
      b.playIndex++;
      b.visibleCandles = b.allCandles.slice(0, b.playIndex);
      this.rebuildIndicators(b);
    }
    this.tryExecutePendingOrder(b);
    if (b.playIndex >= b.allCandles.length) {
      b.finished = true;
      this.stopPlayback(b);
      this.flushPendingOrder(b);
      this.saveSession(b);
    }
    this.cdr.markForCheck();
  }

  resetBlock(b: TrainerBlock): void {
    if (b.started && !this.battleMode) this.saveSession(b);
    this.stopBlockTimer(b);
    b.allCandles = [];
    b.visibleCandles = [];
    b.playIndex = 0;
    b.playbackStartDt = null;
    b.started = false;
    b.finished = false;
    b.hasPlayed = false;
    b.position = 'flat';
    b.entryPrice = null;
    b.entryDt = null;
    b.entryVisibleIndex = null;
    b.entryWallMs = null;
    b.battlePositionQty = 0;
    b.pendingOrder = null;
    b.executionDelaySumSec = 0;
    b.executionDelayCount = 0;
    b.trades = [];
    b.totalPnl = 0;
    b.lastPnl = null;
    b.lastAnnualPct = null;
    b.tradeMarkers = [];
    b.signalMarkers = [];
    this.rebuildIndicators(b);
    this.cdr.markForCheck();
  }

  // ---- battle ----
  toggleBattlePicker(): void {
    this.battlePickerOpen = !this.battlePickerOpen;
    if (this.battlePickerOpen) this.loadBattleAccounts();
  }

  closeBattlePicker(): void { this.battlePickerOpen = false; }

  private loadBattleAccounts(): void {
    this.battleLoading = true;
    this.cdr.markForCheck();
    this.refsApi.getAccounts(undefined, true).subscribe({
      next: (accs) => {
        this.battleAccounts = (accs ?? []).filter((a) => a.is_active);
        if (this.battleAccountId == null || !this.battleAccounts.some((a) => a.id === this.battleAccountId)) {
          const fake = this.battleAccounts.find((a) => a.account_type === 'fake');
          this.battleAccountId = fake?.id ?? this.battleAccounts[0]?.id ?? null;
        }
        this.battleLoading = false;
        this.cdr.markForCheck();
      },
      error: () => { this.battleLoading = false; this.cdr.markForCheck(); },
    });
  }

  get selectedBattleAccount(): AccountRow | null {
    return this.battleAccounts.find((a) => a.id === this.battleAccountId) ?? null;
  }
  get isBattleReal(): boolean { return this.battleMode && this.selectedBattleAccount?.account_type === 'real'; }
  get isBattleFake(): boolean { return this.battleMode && this.selectedBattleAccount?.account_type === 'fake'; }
  get battleFrameClass(): string { return this.isBattleReal ? 'battle-real' : this.isBattleFake ? 'battle-fake' : ''; }

  get battleAccountBalance(): number | null {
    const acc = this.selectedBattleAccount;
    if (!acc) return null;
    const n = acc.account_type === 'real' ? Number((acc as any).current_balance ?? (acc as any).cash_amount ?? (acc as any).balance) : Number((acc as any).terminal_cash ?? (acc as any).cash_amount ?? (acc as any).balance);
    return Number.isFinite(n) ? n : null;
  }

  battleQty(b: TrainerBlock): number {
    const price = this.currentPrice(b);
    const bal = this.battleAccountBalance;
    const pct = Math.max(0.01, Math.min(100, Number(this.battleDepositPct) || 10));
    if (price == null || price <= 0 || bal == null || bal <= 0) return 0;
    return Math.max(0, Math.floor((bal * pct / 100) / price));
  }

  async enterBattle(): Promise<void> {
    if (this.battleAccountId == null) return;
    this.battleMode = true;
    this.battlePickerOpen = false;
    for (const b of this.blocks) {
      this.stopPlayback(b);
      b.pendingOrder = null;
    }
    this.startLiveTimer();
    // ensure blocks have data
    for (const b of this.blocks) {
      if (!b.started) await this.startBlock(b);
    }
    this.cdr.markForCheck();
  }

  exitBattle(): void {
    this.battleMode = false;
    this.stopLiveTimer();
    for (const b of this.blocks) {
      if (b.started && !b.finished) { b.playing = true; b.hasPlayed = true; this.startBlockTimer(b); }
    }
    this.cdr.markForCheck();
  }

  private startLiveTimer(): void {
    this.stopLiveTimer();
    const tfSec = this.timeframes.find((t) => t.id === this.timeframeId)?.sec ?? 300;
    const pollMs = tfSec <= 60 ? 15000 : 30000;
    this.liveTimer = setInterval(() => { void this.pollLiveCandles(); }, pollMs);
    this.battleTickTimer = setInterval(() => this.cdr.markForCheck(), 1000);
    void this.pollLiveCandles();
  }

  private stopLiveTimer(): void {
    if (this.liveTimer) { clearInterval(this.liveTimer); this.liveTimer = null; }
    if (this.battleTickTimer) { clearInterval(this.battleTickTimer); this.battleTickTimer = null; }
    this.battleLiveBusy = false;
  }

  async refreshBattlePrice(b: TrainerBlock): Promise<void> {
    if (this.battleMode) {
      const tasks: Promise<unknown>[] = [this.pollLiveCandles()];
      if (b.securityId != null) {
        tasks.push(
          firstValueFrom(this.securitiesApi.getLastPrices([b.securityId], true))
            .then((res) => {
              const p = res?.prices?.find((x) => x.security_id === b.securityId);
              const price = Number(p?.price);
              if (!Number.isFinite(price) || price <= 0) return;
              this.applyLivePrice(b, price);
              this.cdr.markForCheck();
            }).catch(() => { /* ignore */ })
        );
      }
      await Promise.allSettled(tasks);
      return;
    }
    this.cdr.markForCheck();
  }

  private applyLivePrice(b: TrainerBlock, price: number): void {
    const lastAll = b.allCandles[b.allCandles.length - 1];
    const lastVis = b.visibleCandles[b.visibleCandles.length - 1];
    if (lastAll) lastAll.close_price = price;
    if (lastVis) lastVis.close_price = price;
  }

  private async pollLiveCandles(): Promise<void> {
    if (this.battleLiveBusy || !this.battleMode || !this.timeframeId) return;
    this.battleLiveBusy = true;
    try {
      for (const b of this.blocks) {
        if (!b.started || b.securityId == null) continue;
        try { await firstValueFrom(this.securitiesApi.refreshPrices(b.securityId, this.timeframeId)); } catch { /* ignore */ }
        const batch = await firstValueFrom(this.securitiesApi.getPrices(b.securityId, this.timeframeId, 100, undefined));
        const asc = (batch ?? []).slice().sort((a, c) => a.dt.localeCompare(c.dt)).map(normalizeCandle);
        if (asc.length === 0) continue;
        const last = b.allCandles[b.allCandles.length - 1];
        let changed = false;
        if (!last) {
          b.allCandles = asc;
          b.visibleCandles = [...asc];
          b.playIndex = b.allCandles.length;
          changed = true;
        } else {
          for (const c of asc) {
            if (c.dt > last.dt) { b.allCandles.push(c); changed = true; }
            else if (c.dt === last.dt) { b.allCandles[b.allCandles.length - 1] = c; changed = true; }
          }
          b.visibleCandles = b.allCandles.slice(0, b.allCandles.length);
          b.playIndex = b.allCandles.length;
        }
        try {
          const lastRes = await firstValueFrom(this.securitiesApi.getLastPrices([b.securityId], false));
          const lp = lastRes?.prices?.find((x) => x.security_id === b.securityId);
          const livePrice = Number(lp?.price);
          if (Number.isFinite(livePrice) && livePrice > 0) { this.applyLivePrice(b, livePrice); changed = true; }
        } catch { /* ignore */ }
        if (changed) { this.rebuildIndicators(b); }
      }
      this.cdr.markForCheck();
    } finally {
      this.battleLiveBusy = false;
    }
  }

  // ---- block getters/helpers ----
  currentPrice(b: TrainerBlock): number | null {
    const c = b.visibleCandles[b.visibleCandles.length - 1];
    if (!c) return null;
    const n = Number(c.close_price);
    return Number.isFinite(n) ? n : null;
  }
  currentDt(b: TrainerBlock): string | null {
    const c = b.visibleCandles[b.visibleCandles.length - 1];
    return c ? c.dt : null;
  }
  simulatedElapsed(b: TrainerBlock): string {
    const cur = this.currentDt(b);
    if (!b.playbackStartDt || !cur) return '—';
    const ms = dtToMs(cur) - dtToMs(b.playbackStartDt);
    if (!Number.isFinite(ms) || ms < 0) return '—';
    return formatDuration(ms);
  }
  unrealizedPnl(b: TrainerBlock): number | null {
    const price = this.currentPrice(b);
    if (b.position === 'flat' || b.entryPrice == null || price == null) return null;
    const dir = b.position === 'long' ? 1 : -1;
    const qty = Math.max(1, Number(b.positionQty) || 1);
    const gross = (price - b.entryPrice) * dir * qty;
    const commission = this.battleMode
      ? Math.max(0, Number(b.entryCommission) || 0)
        + (b.entryPrice + price) * qty * (Math.max(0, Number(this.commissionPct) || 0) / 100) / 2
      : (b.entryPrice + price) * qty * (Math.max(0, Number(this.commissionPct) || 0) / 100);
    return gross - commission;
  }
  unrealizedPnlPct(b: TrainerBlock): number | null {
    const price = this.currentPrice(b);
    if (b.position === 'flat' || b.entryPrice == null || price == null) return null;
    const qty = Math.max(1, Number(b.positionQty) || 1);
    const base = b.entryPrice * qty;
    if (!Number.isFinite(base) || base <= 0) return null;
    const pnl = this.unrealizedPnl(b);
    return pnl == null ? null : (pnl / base) * 100;
  }
  currentHoldingMs(b: TrainerBlock): number | null {
    if (b.position === 'flat' || b.entryDt == null) return null;
    if (this.battleMode && b.entryWallMs != null) return Math.max(0, Date.now() - b.entryWallMs);
    const cur = this.currentDt(b);
    if (!cur) return null;
    const ms = dtToMs(cur) - dtToMs(b.entryDt);
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
  }
  positionHoldingText(b: TrainerBlock): string {
    if (b.position !== 'flat') {
      const ms = this.currentHoldingMs(b);
      return ms == null ? '—' : formatDuration(ms);
    }
    const last = b.trades[0];
    if (!last) return '—';
    return formatDuration(Math.max(0, last.holdingMs ?? 0));
  }
  lastTradeHoldingText(b: TrainerBlock): string {
    const last = b.trades[0];
    if (!last) return '—';
    return formatDuration(Math.max(0, last.holdingMs ?? 0));
  }
  avgHoldingMs(b: TrainerBlock): number | null {
    const trades = b.trades.filter(t => (t.holdingMs ?? 0) > 0);
    if (trades.length === 0) return null;
    return trades.reduce((s, t) => s + Math.max(0, t.holdingMs ?? 0), 0) / trades.length;
  }
  avgHoldingText(b: TrainerBlock): string {
    const ms = this.avgHoldingMs(b);
    return ms == null ? '—' : formatDuration(ms);
  }
  get globalAvgHoldingText(): string {
    const all = this.blocks.flatMap(b => b.trades).filter(t => (t.holdingMs ?? 0) > 0);
    if (all.length === 0) return '—';
    const ms = all.reduce((s, t) => s + Math.max(0, t.holdingMs ?? 0), 0) / all.length;
    return formatDuration(ms);
  }
  totalPnlWithUnrealized(b: TrainerBlock): number { return b.totalPnl + (this.unrealizedPnl(b) ?? 0); }
  totalPnlPct(b: TrainerBlock): number | null {
    const basePrice = b.trades.length > 0
      ? b.trades.reduce((s, t) => s + t.openPrice, 0) / b.trades.length
      : (b.entryPrice ?? (b.visibleCandles.length > 0 ? Number(b.visibleCandles[0].close_price) : null));
    if (basePrice == null || !Number.isFinite(basePrice) || basePrice <= 0) return null;
    return (this.totalPnlWithUnrealized(b) / basePrice) * 100;
  }
  totalAnnualPct(b: TrainerBlock): number | null {
    const pnlPct = this.totalPnlPct(b);
    if (pnlPct == null) return null;
    const startDt = b.playbackStartDt ?? b.trades[b.trades.length - 1]?.openDt ?? b.entryDt;
    const endDt = this.currentDt(b) ?? b.trades[0]?.closeDt ?? b.entryDt;
    if (!startDt || !endDt) return null;
    const holdMs = dtToMs(endDt) - dtToMs(startDt);
    if (!Number.isFinite(holdMs) || holdMs <= 0) return null;
    return (pnlPct / (holdMs / 86400000)) * 365;
  }
  avgExecutionDelaySec(b: TrainerBlock): number | null {
    if (b.executionDelayCount <= 0) return null;
    return b.executionDelaySumSec / b.executionDelayCount;
  }

  get globalTotalPnl(): number {
    return this.blocks.reduce((s, b) => s + this.totalPnlWithUnrealized(b), 0);
  }

  // ---- trading ----
  canBuy(b: TrainerBlock): boolean {
    if (this.battleMode) {
      return b.started && !b.loading && !this.battlePlacing
        && this.currentPrice(b) != null && !!this.battleAccountId
        && b.position !== 'short'
        && (b.position === 'long' || this.battleQty(b) > 0);
    }
    return b.started && !b.loading && !this.dataLoading && this.currentPrice(b) != null && b.position !== 'short' && !b.pendingOrder;
  }
  canSell(b: TrainerBlock): boolean {
    if (this.battleMode) {
      return b.started && !b.loading && !this.battlePlacing
        && this.currentPrice(b) != null && !!this.battleAccountId
        && b.position !== 'long'
        && (b.position === 'short' || this.battleQty(b) > 0);
    }
    return b.started && !b.loading && !this.dataLoading && this.currentPrice(b) != null && b.position !== 'long' && !b.pendingOrder;
  }

  pendingOrderText(b: TrainerBlock): string | null {
    const p = b.pendingOrder;
    if (!p) return null;
    const actionText = p.action === 'close'
      ? (p.side === 'long' ? 'Закрытие шорта' : 'Закрытие лонга')
      : (p.side === 'long' ? 'Покупка' : 'Продажа');
    const cur = this.currentDt(b);
    if (!cur) return `${actionText}: ожидание исполнения…`;
    const leftMs = p.executeAtMs - dtToMs(cur);
    const leftSec = Math.max(0, Math.ceil(leftMs / 1000));
    return `${actionText}: исполнение через ~${leftSec} сек`;
  }

  buy(b: TrainerBlock): void {
    const price = this.currentPrice(b); const dt = this.currentDt(b);
    if (!this.canBuy(b) || price == null || dt == null) return;
    if (this.battleMode) { void this.placeBattleTrade(b, b.position === 'long' ? 'sell' : 'buy'); return; }
    if (b.position === 'long') { this.queueOrExecute(b, 'short', 'close', dt); return; }
    const action = b.position === 'short' ? 'close' : 'open';
    this.queueOrExecute(b, 'long', action, dt);
  }

  sell(b: TrainerBlock): void {
    const price = this.currentPrice(b); const dt = this.currentDt(b);
    if (!this.canSell(b) || price == null || dt == null) return;
    if (this.battleMode) { void this.placeBattleTrade(b, b.position === 'short' ? 'buy' : 'sell'); return; }
    if (b.position === 'short') { this.queueOrExecute(b, 'long', 'close', dt); return; }
    const action = b.position === 'long' ? 'close' : 'open';
    this.queueOrExecute(b, 'short', action, dt);
  }

  private async placeBattleTrade(b: TrainerBlock, direction: 'buy' | 'sell'): Promise<void> {
    const acc = this.selectedBattleAccount;
    const priceNow = this.currentPrice(b);
    if (!acc || !b.securityId || priceNow == null) return;
    const isClose = (direction === 'buy' && b.position === 'short') || (direction === 'sell' && b.position === 'long');
    const qty = isClose && b.battlePositionQty > 0 ? b.battlePositionQty : this.battleQty(b);
    if (qty <= 0) {
      b.loadingError = 'Недостаточно средств или объёма для сделки при заданном проценте депозита.';
      this.cdr.markForCheck();
      return;
    }
    this.battlePlacing = true;
    b.loadingError = null;
    this.cdr.markForCheck();
    try {
      const res = await firstValueFrom(this.terminalApi.placeTrade({
        account_id: acc.id,
        security_id: b.securityId,
        direction,
        execution: 'market',
        price: priceNow,
        quantity: qty,
        commission_pct: Number(this.commissionPct) || 0,
        note: 'Тренажёр: Бой',
      }));
      if (res?.ok) {
        const dt = this.currentDt(b) ?? new Date().toISOString();
        const price = Number(res.price) || priceNow;
        const execQty = Number(res.quantity) > 0 ? Number(res.quantity) : qty;
        const tradeCommission = Math.max(0, Number(res.commission ?? res.trade?.commission) || 0);
        if (direction === 'buy') {
          if (b.position === 'short') { this.closePosition(b, price, dt, tradeCommission); b.battlePositionQty = 0; }
          else if (b.position === 'flat') { this.openPosition(b, 'long', price, dt, execQty, tradeCommission); b.battlePositionQty = execQty; }
        } else {
          if (b.position === 'long') { this.closePosition(b, price, dt, tradeCommission); b.battlePositionQty = 0; }
          else if (b.position === 'flat') { this.openPosition(b, 'short', price, dt, execQty, tradeCommission); b.battlePositionQty = execQty; }
        }
        if (res.cash != null && acc.account_type === 'fake') acc.terminal_cash = Number(res.cash);
      } else {
        b.loadingError = res?.error || res?.message || 'Сделка не исполнена';
        this.reportDataLoadIssue('error', 'Тренажёр (бой): сделка не исполнена', String(b.loadingError), { accountId: acc.id, securityId: b.securityId, direction, qty });
      }
    } catch (err: any) {
      const msg = err?.error?.error || err?.message || 'Ошибка отправки сделки';
      b.loadingError = String(msg);
      this.reportDataLoadIssue('error', 'Тренажёр (бой): ошибка сделки', String(msg), { accountId: acc.id, securityId: b.securityId, direction, qty });
    } finally {
      this.battlePlacing = false;
      this.cdr.markForCheck();
    }
  }

  private queueOrExecute(b: TrainerBlock, side: 'long' | 'short', action: 'open' | 'close', dt: string): void {
    const delaySec = Math.max(0, Number(this.executionDelaySec) || 0);
    if (delaySec <= 0) { this.executeOrder(b, side, action, this.currentPrice(b)!, this.currentDt(b)!, dt); return; }
    const nowMs = dtToMs(dt);
    if (!Number.isFinite(nowMs) || nowMs <= 0) { this.executeOrder(b, side, action, this.currentPrice(b)!, this.currentDt(b)!, dt); return; }
    b.pendingOrder = { side, action, requestedDt: dt, executeAtMs: nowMs + delaySec * 1000 };
    this.cdr.markForCheck();
  }
  private tryExecutePendingOrder(b: TrainerBlock): void {
    const p = b.pendingOrder; const price = this.currentPrice(b); const dt = this.currentDt(b);
    if (!p || price == null || dt == null) return;
    const nowMs = dtToMs(dt);
    if (!Number.isFinite(nowMs)) return;
    if (nowMs >= p.executeAtMs) { b.pendingOrder = null; this.executeOrder(b, p.side, p.action, price, dt, p.requestedDt); }
  }
  private flushPendingOrder(b: TrainerBlock): void {
    const p = b.pendingOrder; const price = this.currentPrice(b); const dt = this.currentDt(b);
    if (!p || price == null || dt == null) return;
    b.pendingOrder = null; this.executeOrder(b, p.side, p.action, price, dt, p.requestedDt);
  }
  private executeOrder(b: TrainerBlock, side: 'long' | 'short', action: 'open' | 'close', price: number, dt: string, requestedDt: string): void {
    const reqMs = dtToMs(requestedDt); const execMs = dtToMs(dt);
    if (Number.isFinite(reqMs) && Number.isFinite(execMs) && execMs >= reqMs) {
      b.executionDelaySumSec += (execMs - reqMs) / 1000;
      b.executionDelayCount += 1;
    }
    if (action === 'close') {
      if (b.position === 'flat') return;
      if (side === 'long' && b.position !== 'short') return;
      if (side === 'short' && b.position !== 'long') return;
      this.closePosition(b, price, dt);
    } else {
      if (b.position !== 'flat') return;
      this.openPosition(b, side, price, dt);
    }
  }
  private openPosition(b: TrainerBlock, side: 'long' | 'short', price: number, dt: string, qty = 1, entryCommission = 0): void {
    b.position = side; b.entryPrice = price; b.entryDt = dt; b.entryVisibleIndex = b.visibleCandles.length - 1; b.entryWallMs = Date.now();
    b.positionQty = Math.max(1, Math.floor(Number(qty) || 1));
    b.entryCommission = Math.max(0, Number(entryCommission) || 0);
    b.tradeMarkers = [...b.tradeMarkers, { dt, price, kind: 'open', side, label: side === 'long' ? 'BUY' : 'SELL' }];
    this.cdr.markForCheck();
  }
  private closePosition(b: TrainerBlock, price: number, dt: string, closeCommission?: number): void {
    if (b.position === 'flat' || b.entryPrice == null || b.entryDt == null) return;
    const dir = b.position === 'long' ? 1 : -1;
    const qty = Math.max(1, Number(b.positionQty) || 1);
    const grossPnl = (price - b.entryPrice) * dir * qty;
    const commission = (closeCommission != null || this.battleMode)
      ? (Math.max(0, Number(b.entryCommission) || 0) + Math.max(0, Number(closeCommission) || 0))
      : (b.entryPrice + price) * qty * (Math.max(0, Number(this.commissionPct) || 0) / 100);
    const pnl = grossPnl - commission;
    const pnlPct = ((price - b.entryPrice) * dir / b.entryPrice) * 100;
    const holdMs = (this.battleMode && b.entryWallMs != null) ? Math.max(0, Date.now() - b.entryWallMs) : dtToMs(dt) - dtToMs(b.entryDt);
    const holdDays = holdMs > 0 ? holdMs / 86400000 : null;
    const annualPct = holdDays != null ? (pnlPct / holdDays) * 365 : null;
    const trade: TrainerTrade = {
      id: (b.trades[0]?.id ?? 0) + 1,
      side: b.position, openDt: b.entryDt, openPrice: b.entryPrice, closeDt: dt, closePrice: price,
      commission, pnl, pnlPct, annualPct, holdingMs: Math.max(0, holdMs),
    };
    b.trades = [trade, ...b.trades];
    b.totalPnl += pnl; b.lastPnl = pnl; b.lastPnlPct = pnlPct; b.lastAnnualPct = annualPct;
    b.tradeMarkers = [...b.tradeMarkers, { dt, price, kind: 'close', side: b.position, label: `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}` }];
    b.position = 'flat'; b.entryPrice = null; b.entryDt = null; b.entryVisibleIndex = null; b.entryWallMs = null; b.positionQty = 1; b.entryCommission = 0;
    this.cdr.markForCheck();
  }

  // ---- indicators ----
  get selectedIndicatorDef(): IndicatorDef {
    return this.indicatorDefs[0];
  }
  indicatorLabel(code: IndicatorCode): string {
    return this.indicatorDefs.find((d) => d.code === code)?.name ?? code;
  }
  indicatorHasPeriod(code: IndicatorCode): boolean {
    return this.indicatorDefs.find((d) => d.code === code)?.hasPeriod ?? true;
  }
  addIndicator(b: TrainerBlock): void {
    const def = this.indicatorDefs.find((d) => d.code === b.addIndicatorType) ?? this.indicatorDefs[0];
    const period = def.hasPeriod ? Math.max(2, Math.min(500, Math.floor(Number(b.addIndicatorPeriod) || def.period))) : def.period;
    const color = this.palette[b.colorIdx % this.palette.length];
    b.colorIdx++;
    b.indicators = [...b.indicators, { uid: `${b.addIndicatorType}-${Date.now()}-${Math.random()}`, type: b.addIndicatorType, period, color }];
    this.rebuildIndicators(b);
    this.cdr.markForCheck();
  }
  removeIndicator(b: TrainerBlock, uid: string): void {
    b.indicators = b.indicators.filter((i) => i.uid !== uid);
    this.rebuildIndicators(b);
    this.cdr.markForCheck();
  }
  updateIndicatorPeriod(b: TrainerBlock, ind: LocalIndicator, value: any): void {
    if (!this.indicatorHasPeriod(ind.type)) return;
    ind.period = Math.max(2, Math.min(500, Math.floor(Number(value) || ind.period)));
    this.rebuildIndicators(b);
    this.cdr.markForCheck();
  }
  onIndicatorTypeChange(b: TrainerBlock): void {
    const def = this.indicatorDefs.find((d) => d.code === b.addIndicatorType) ?? this.indicatorDefs[0];
    b.addIndicatorPeriod = def.period;
  }

  rebuildIndicators(b: TrainerBlock): void {
    const candles = b.visibleCandles;
    const out: ChartIndicatorSeries[] = [];
    for (const ind of b.indicators) {
      const def = this.indicatorDefs.find((d) => d.code === ind.type);
      const onPrice = def?.onPrice ?? true;
      const period = Math.max(2, Math.floor(Number(ind.period) || 20));
      const label = def?.hasPeriod ? `${ind.type}(${period})` : ind.type;
      const mk = (line_code: string, line_name: string, color: string, points: Pt[], on_price_scale = onPrice): ChartIndicatorSeries => ({
        indicator_code: ind.type, line_code, line_name, color, on_price_scale, is_threshold: false, points,
      });
      switch (ind.type) {
        case 'SMA': out.push(mk('VALUE', label, ind.color, calcSma(candles, period))); break;
        case 'EMA': out.push(mk('VALUE', label, ind.color, calcEma(candles, period))); break;
        case 'WMA': out.push(mk('VALUE', label, ind.color, calcWma(candles, period))); break;
        case 'HMA': out.push(mk('VALUE', label, ind.color, calcHma(candles, period))); break;
        case 'VWAP': out.push(mk('VALUE', label, ind.color, calcVwap(candles))); break;
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
        case 'RSI': out.push(mk('VALUE', label, ind.color, calcRsi(candles, period), false)); break;
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
        case 'ATR': out.push(mk('VALUE', label, ind.color, calcAtr(candles, period), false)); break;
        case 'CCI': out.push(mk('VALUE', label, ind.color, calcCci(candles, period), false)); break;
        case 'ADX': {
          const a = calcAdx(candles, period);
          out.push(mk('ADX', `${label} ADX`, ind.color, a.adx, false));
          out.push(mk('PDI', `${label} +DI`, shiftColor(ind.color, 60), a.pdi, false));
          out.push(mk('MDI', `${label} -DI`, shiftColor(ind.color, -60), a.mdi, false));
          break;
        }
        case 'ROC': out.push(mk('VALUE', label, ind.color, calcRoc(candles, period), false)); break;
        case 'OBV': out.push(mk('VALUE', label, ind.color, calcObv(candles), false)); break;
        case 'MFI': out.push(mk('VALUE', label, ind.color, calcMfi(candles, period), false)); break;
      }
    }
    b.indicatorSeries = out;
    b.signalMarkers = this.buildSignalMarkers(b, candles);
  }

  private buildSignalMarkers(b: TrainerBlock, candles: PriceCandle[]): ChartTradeMarker[] {
    if (candles.length < 5) return [];
    const out: ChartTradeMarker[] = [];
    for (const ind of b.indicators) {
      const period = Math.max(2, Math.floor(Number(ind.period) || 20));
      const sigs = this.signalsForIndicator(ind.type, period, candles);
      for (const s of sigs) {
        out.push({ dt: s.dt, price: s.price, kind: 'signal', side: s.side, color: s.color ?? ind.color, topLabel: s.text });
      }
    }
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


  unrealizedAnnualPct(b: TrainerBlock): number | null {
    if (b.position === 'flat' || b.entryDt == null) return null;
    const pnlPct = this.unrealizedPnlPct(b);
    if (pnlPct == null) return null;
    const holdMs = (this.battleMode && b.entryWallMs != null)
      ? Math.max(0, Date.now() - b.entryWallMs)
      : (this.currentDt(b) == null ? NaN : dtToMs(this.currentDt(b)!) - dtToMs(b.entryDt));
    if (!Number.isFinite(holdMs) || holdMs <= 0) return null;
    return (pnlPct / (holdMs / 86400000)) * 365;
  }


  openGlobalReport(): void {
    if (this.globalReportLoading) return;
    const blocks = this.blocks.filter(b => b.started || b.trades.length > 0 || b.allCandles.length > 0);
    if (blocks.length === 0) { this.loadingError = 'Нет данных для отчёта. Добавьте бумаги и запустите тренировку.'; return; }
    this.globalReportLoading = true;
    this.cdr.markForCheck();
    try {
      const nowIso = new Date().toISOString();
      const allSynthTrades: LogicTradeRow[] = [];
      const paperCharts: PaperReportChart[] = [];
      let totalPnl = 0;
      let totalDeals = 0;
      let minDt: string | null = null;
      let maxDt: string | null = null;

      for (const b of blocks) {
        const security = this.securities.find(s => s.id === b.securityId);
        const tf = this.timeframes.find(t => t.id === this.timeframeId);
        const securityName = security?.name || b.securityName || 'Инструмент';
        const securityPrefix = security?.prefix || null;
        const tfLabel = tf?.full_name || tf?.tf || 'M5';
        const candles = b.allCandles.length ? b.allCandles : b.visibleCandles;
        const startDt = b.playbackStartDt ?? candles[0]?.dt ?? b.trades[b.trades.length - 1]?.openDt ?? this.currentDt(b) ?? '';
        const endDt = this.currentDt(b) ?? candles[candles.length - 1]?.dt ?? b.trades[0]?.closeDt ?? '';
        if (startDt && (!minDt || startDt < minDt)) minDt = startDt;
        if (endDt && (!maxDt || endDt > maxDt)) maxDt = endDt;
        totalPnl += this.totalPnlWithUnrealized(b);
        totalDeals += b.trades.length;

        const synthCloses = [...b.trades].slice().reverse();
        const synthTrades: LogicTradeRow[] = [];
        for (const t of synthCloses) {
          const entryTs = dtToMs(t.openDt);
          const exitTs = dtToMs(t.closeDt);
          synthTrades.push({
            id: (allSynthTrades.length + synthTrades.length + 1) * 10 + 1,
            logic_id: -1, logic_name: 'Тренажёр', source: 'web', mode: 'paper', account_id: null as any,
            security_id: b.securityId ?? 0, security_name: securityName, timeframe_id: this.timeframeId ?? 0, timeframe_tf: tf?.tf ?? 'M5',
            side: t.side, entry_dt: t.openDt, entry_ts: Number.isFinite(entryTs) ? entryTs : null, entry_price: t.openPrice, entry_qty: 1,
            entry_commission: t.commission / 2, exit_dt: t.closeDt, exit_ts: Number.isFinite(exitTs) ? exitTs : null,
            exit_price: t.closePrice, exit_qty: 1, exit_commission: t.commission / 2, exit_reason: 'manual',
            pnl: t.pnl, pnl_pct: t.pnlPct, status: 'filled', close_not_before_ts: null, mtm_pnl: 0,
          } as unknown as LogicTradeRow);
        }
        allSynthTrades.push(...synthTrades);

        const equity: ChartEquityPoint[] = [];
        let cum = 0;
        if (startDt) equity.push({ dt: startDt, value: 0 });
        for (const t of synthCloses) { cum += t.pnl; equity.push({ dt: t.closeDt, value: cum }); }
        if (b.position !== 'flat' && this.unrealizedPnl(b) != null && this.currentDt(b)) {
          equity.push({ dt: this.currentDt(b)!, value: cum + (this.unrealizedPnl(b) ?? 0) });
        }

        paperCharts.push({
          securityId: b.securityId ?? 0, securityName, securityPrefix, timeframeLabel: tfLabel,
          candles,
          indicators: b.indicatorSeries.map(s => ({
            indicator_code: s.indicator_code, line_code: s.line_code, line_name: s.line_name, color: s.color,
            on_price_scale: s.on_price_scale, is_threshold: s.is_threshold, points: s.points.map(p => ({ dt: p.dt, value: p.value })),
          })),
          trades: synthTrades.filter(t => t.security_id === (b.securityId ?? 0)),
          markers: b.tradeMarkers.filter(m => m.kind === 'open' || m.kind === 'close'),
          stops: [], shaded: [], equity, equityShadow: [], closes: buildPaperReportCloseRows(synthTrades),
          pnl: this.totalPnlWithUnrealized(b), dealCount: b.trades.length,
          openQty: b.position !== 'flat' ? 1 : 0, lastPrice: this.currentPrice(b), loadError: null,
        });
      }

      const synthLogic = {
        id: -1, name: `Тренажёр — все бумаги (${blocks.length})`,
        description: `Комиссия: ${this.formatPct(this.commissionPct)}. Задержка: ${Number(this.executionDelaySec) || 0} сек. Режим: ${this.battleMode ? 'БОЙ' : 'обычный'}.`,
        created_at: nowIso, updated_at: nowIso, author: null, status: 'active',
        type: 'paper', indicator_codes: [], signal_mode: 'any', entry_signal_mode: 'any', exit_signal_mode: 'any',
        entry_invert: false, exit_invert: false, exit_opposite: true, exit_target_pct: null, exit_stop_pct: null, exit_trail_pct: null, position_timeout_sec: null,
        lookback_bars: 1, stop_loss_pct: 0, take_profit_pct: 0, max_position_pct: 100, commission_pct: Number(this.commissionPct) || 0,
        initial_capital: 0, allow_short: true, mode: 'paper', close_on_opposite: true, close_positions_eod: false, leverage: 1,
        status_calc: 'stopped', last_error: null, last_trained_at: null, trained_tf_sec: null, train_from: minDt ?? '', train_to: maxDt ?? '',
        train_exchange_id: null, train_security_ids: blocks.map(b => b.securityId).filter((x): x is number => x != null),
        train_timeframe_ids: this.timeframeId ? [this.timeframeId] : [], test_from: minDt ?? '', test_to: maxDt ?? '',
        test_exchange_id: null, test_security_ids: blocks.map(b => b.securityId).filter((x): x is number => x != null),
        test_timeframe_ids: this.timeframeId ? [this.timeframeId] : [],
        change_pct: null, total_pnl: totalPnl, annual_pnl: null, annual_pnl_pct: null, deal_count: totalDeals, max_drawdown_pct: null,
        execution_delay_sec: Math.max(0, Number(this.executionDelaySec) || 0), avg_execution_delay_sec: null,
        last_trade_dt: null, last_trade_pnl: null, last_signal: null, last_signal_dt: null,
        version: 1, last_trade_source: 'web', trading_mode: 'both', max_open_positions: null as any, position_lifetime_sec: null,
        close_existing_on_signal: true, allow_pyramiding: false, max_pyramid_levels: 1, min_entry_interval_sec: 0,
        min_signal_interval_sec: 0, min_profit_pct: 0, trade_on_close: true, sizing_mode: 'percent', fixed_lot: 0,
        risk_per_trade_pct: 0, is_locked: false, tags: ['trainer'], notes: null, is_active: true, snapshot_enabled: false,
        snapshot_timeframe_id: null, snapshot_timeframe_tf: null, snapshot_retention_days: 0, snapshot_write_interval_sec: 0,
        snapshot_last_dt: null, snapshot_captured_at: null, snapshot_capture_source: null, snapshot_count: 0,
        snapshot_last_error: null, auto_start: false, runtime_mode: 'intrabar', parameter_space: null,
        weight_aggregation: 'majority', long_allow: true, long_threshold: 1, long_exit_mode: 'opposite',
        short_allow: true, short_threshold: 1, short_exit_mode: 'opposite', cross_exit_policy: 'allow',
        security_binding_mode: 'per_security', security_logic_bindings: [],
      } as unknown as LogicRow;

      const run: BacktestReportRunInfo = {
        date_from: minDt ? String(minDt).slice(0, 10) : null,
        date_to: maxDt ? String(maxDt).slice(0, 10) : null,
        status: blocks.every(b => b.finished) ? 'completed' : 'running',
        progress_pct: null,
      };
      const model = buildBacktestReportModel(synthLogic, allSynthTrades, { backtestRun: run, paperCharts, reportMode: 'test', configProvided: false });
      const html = renderBacktestReportHtml(model);
      const ok = openBacktestReportWindow(html, `Тренажёр — все бумаги`);
      if (!ok) this.loadingError = 'Не удалось открыть отчёт. Разрешите всплывающие окна.';
    } catch (err: any) {
      console.error('Trainer global report error', err);
      this.loadingError = err?.message || 'Ошибка формирования общего отчёта';
    } finally {
      this.globalReportLoading = false;
      this.cdr.markForCheck();
    }
  }

  async openStats(): Promise<void> {
    if (this.statsLoading) return;
    this.statsLoading = true;
    this.cdr.markForCheck();
    try {
      const stats = await firstValueFrom(this.trainerApi.getStats());
      const html = renderTrainerStatsHtml(stats);
      openBacktestReportWindow(html, `trainer-stats-${Date.now()}.html`);
    } catch (e) {
      console.error('Trainer stats error', e);
      this.loadingError = 'Не удалось загрузить статистику тренировок.';
    } finally {
      this.statsLoading = false;
      this.cdr.markForCheck();
    }
  }

  private saveSession(b: TrainerBlock): void {
    if (!b.sessionKey || !b.started) return;
    const security = this.securities.find(s => s.id === b.securityId);
    const tf = this.timeframes.find(t => t.id === this.timeframeId);
    const startMs = b.playbackStartDt ? dtToMs(b.playbackStartDt) : NaN;
    const cur = this.currentDt(b);
    const endMs = cur ? dtToMs(cur) : NaN;
    const tradingMs = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs ? endMs - startMs : null;
    const tradesChrono = [...b.trades].slice().reverse();
    const tradePayloads: TrainerTradeSavePayload[] = tradesChrono.map((t) => ({
      side: t.side, open_dt: t.openDt, open_price: t.openPrice, close_dt: t.closeDt, close_price: t.closePrice,
      commission: t.commission, pnl: t.pnl, pnl_pct: t.pnlPct, annual_pct: t.annualPct,
      holding_ms: Number.isFinite(t.holdingMs) ? t.holdingMs : null, is_open: false,
    }));
    if (b.position !== 'flat' && b.entryDt != null && b.entryPrice != null) {
      const holdMs = cur ? dtToMs(cur) - dtToMs(b.entryDt) : null;
      tradePayloads.push({
        side: b.position, open_dt: b.entryDt, open_price: b.entryPrice, close_dt: cur, close_price: this.currentPrice(b),
        commission: this.battleMode ? Math.max(0, Number(b.entryCommission) || 0) : 0,
        pnl: this.unrealizedPnl(b), pnl_pct: this.unrealizedPnlPct(b), annual_pct: this.unrealizedAnnualPct(b),
        holding_ms: holdMs != null && Number.isFinite(holdMs) ? Math.max(0, holdMs) : null, is_open: true,
      });
    }
    const payload: TrainerSessionSavePayload = {
      session_key: b.sessionKey, security_id: b.securityId, timeframe_id: this.timeframeId,
      security_name: security?.name || b.securityName, timeframe_tf: tf?.tf || 'M5',
      started_at: b.playbackStartDt, ended_at: cur, trading_ms: tradingMs,
      commission_pct: Number(this.commissionPct) || 0, exec_delay_sec: Number(this.executionDelaySec) || 0,
      finished: b.finished, total_pnl: b.totalPnl, unrealized_pnl: this.unrealizedPnl(b) ?? 0,
      annual_pct: this.totalAnnualPct(b), avg_exec_delay_sec: this.avgExecutionDelaySec(b), trades: tradePayloads,
    };
    this.trainerApi.saveSession(payload).subscribe({ error: (err) => console.error('Trainer session save error', err) });
  }

  chartMarkers(b: TrainerBlock): ChartTradeMarker[] {
    return b.signalMarkers.length ? [...b.tradeMarkers, ...b.signalMarkers] : b.tradeMarkers;
  }
  trackByTrade(_: number, t: TrainerTrade): number { return t.id; }
  trackByInd(_: number, i: LocalIndicator): string { return i.uid; }
  trackByBlock(_: number, b: TrainerBlock): string { return b.id; }

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
  toNumber(v: number | string | null | undefined): number | null {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  }
  formatHoldingMs(ms: number | null | undefined): string {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
    return formatDuration(ms);
  }

  openReport(b: TrainerBlock): void {
    if (b.reportLoading) return;
    b.reportLoading = true;
    this.cdr.markForCheck();
    try {
      const security = this.securities.find(s => s.id === b.securityId);
      const tf = this.timeframes.find(t => t.id === this.timeframeId);
      const securityName = security?.name || b.securityName || 'Инструмент';
      const securityPrefix = security?.prefix || null;
      const tfLabel = tf?.full_name || tf?.tf || 'TF';
      const candles = b.allCandles.length ? b.allCandles : b.visibleCandles;
      const reportStartDt = b.playbackStartDt ?? candles[0]?.dt ?? b.trades[b.trades.length - 1]?.openDt ?? this.currentDt(b) ?? '';
      const reportEndDt = this.currentDt(b) ?? candles[candles.length - 1]?.dt ?? b.trades[0]?.closeDt ?? '';
      const avgTradeOpen = b.trades.length > 0
        ? b.trades.reduce((s, t) => s + t.openPrice, 0) / b.trades.length
        : (b.entryPrice ?? this.toNumber(candles[candles.length - 1]?.close_price) ?? 0);
      const basePrice = Number.isFinite(avgTradeOpen) && avgTradeOpen > 0
        ? avgTradeOpen
        : (this.toNumber(candles[candles.length - 1]?.close_price) ?? 0);
      const nowIso = new Date().toISOString();

      const synthLogic = {
        id: -1,
        name: `Тренажёр — ${securityName} ${tfLabel}`,
        description: `Комиссия: ${this.formatPct(this.commissionPct)}. Задержка исполнения: ${Number(this.executionDelaySec) || 0} сек. ${this.battleMode ? 'Режим: БОЙ.' : 'Режим: обычный.'}`,
        created_at: nowIso, updated_at: nowIso, author: null, status: 'active',
        type: 'paper', indicator_codes: b.indicators.map(i => i.type), signal_mode: 'any',
        entry_signal_mode: 'any', exit_signal_mode: 'any', entry_invert: false, exit_invert: false,
        exit_opposite: true, exit_target_pct: null, exit_stop_pct: null, exit_trail_pct: null, position_timeout_sec: null,
        lookback_bars: 1, stop_loss_pct: 0, take_profit_pct: 0, max_position_pct: 100, commission_pct: Number(this.commissionPct) || 0,
        initial_capital: 0, allow_short: true, mode: 'paper', close_on_opposite: true, close_positions_eod: false, leverage: 1,
        status_calc: 'stopped', last_error: null, last_trained_at: null, trained_tf_sec: null, train_from: reportStartDt,
        train_to: reportEndDt, train_exchange_id: null, train_security_ids: b.securityId ? [b.securityId] : [],
        train_timeframe_ids: this.timeframeId ? [this.timeframeId] : [], test_from: reportStartDt, test_to: reportEndDt,
        test_exchange_id: null, test_security_ids: b.securityId ? [b.securityId] : [], test_timeframe_ids: this.timeframeId ? [this.timeframeId] : [],
        change_pct: null, total_pnl: this.totalPnlWithUnrealized(b), annual_pnl: this.totalAnnualPct(b), annual_pnl_pct: null,
        deal_count: b.trades.length, max_drawdown_pct: null, execution_delay_sec: Math.max(0, Number(this.executionDelaySec) || 0),
        avg_execution_delay_sec: this.avgExecutionDelaySec(b),
        last_trade_dt: b.trades[0]?.closeDt ?? null, last_trade_pnl: b.lastPnl, last_signal: null, last_signal_dt: null,
        version: 1, last_trade_source: 'web', trading_mode: 'both', max_open_positions: null as any, position_lifetime_sec: null,
        close_existing_on_signal: true, allow_pyramiding: false, max_pyramid_levels: 1, min_entry_interval_sec: 0,
        min_signal_interval_sec: 0, min_profit_pct: 0, trade_on_close: true, sizing_mode: 'percent', fixed_lot: 0,
        risk_per_trade_pct: 0, is_locked: false, tags: ['trainer'], notes: null, is_active: true, snapshot_enabled: false,
        snapshot_timeframe_id: null, snapshot_timeframe_tf: null, snapshot_retention_days: 0, snapshot_write_interval_sec: 0,
        snapshot_last_dt: null, snapshot_captured_at: null, snapshot_capture_source: null, snapshot_count: 0,
        snapshot_last_error: null, auto_start: false, runtime_mode: 'intrabar', parameter_space: null,
        weight_aggregation: 'majority', long_allow: true, long_threshold: 1, long_exit_mode: 'opposite',
        short_allow: true, short_threshold: 1, short_exit_mode: 'opposite', cross_exit_policy: 'allow',
        security_binding_mode: 'per_security', security_logic_bindings: [],
      } as unknown as LogicRow;

      const synthTrades: LogicTradeRow[] = [];
      const synthCloses = [...b.trades].slice().reverse();
      for (const t of synthCloses) {
        const entryTs = dtToMs(t.openDt);
        const exitTs = dtToMs(t.closeDt);
        const qty = basePrice > 0 ? 1 : 1;
        synthTrades.push({
          id: t.id * 10 + 1, logic_id: -1, logic_name: (synthLogic as any).name, source: 'web', mode: 'paper', account_id: null as any,
          security_id: b.securityId ?? 0, security_name: securityName, timeframe_id: this.timeframeId ?? 0, timeframe_tf: tf?.tf ?? 'M5',
          side: t.side, entry_dt: t.openDt, entry_ts: Number.isFinite(entryTs) ? entryTs : null, entry_price: t.openPrice, entry_qty: qty,
          entry_commission: t.commission / 2, exit_dt: t.closeDt, exit_ts: Number.isFinite(exitTs) ? exitTs : null,
          exit_price: t.closePrice, exit_qty: qty, exit_commission: t.commission / 2, exit_reason: 'manual',
          pnl: t.pnl, pnl_pct: t.pnlPct, status: 'filled', close_not_before_ts: null, mtm_pnl: 0,
        } as unknown as LogicTradeRow);
      }

      const cum = { value: 0 };
      const equity: ChartEquityPoint[] = [];
      if (reportStartDt) equity.push({ dt: reportStartDt, value: 0 });
      for (const t of synthCloses) {
        cum.value += t.pnl;
        equity.push({ dt: t.closeDt, value: cum.value });
      }
      if (b.position !== 'flat' && this.unrealizedPnl(b) != null && this.currentDt(b)) {
        equity.push({ dt: this.currentDt(b)!, value: cum.value + (this.unrealizedPnl(b) ?? 0) });
      }

      const paperChart: PaperReportChart = {
        securityId: b.securityId ?? 0, securityName, securityPrefix, timeframeLabel: tfLabel,
        candles: candles,
        indicators: b.indicatorSeries.map(s => ({
          indicator_code: s.indicator_code, line_code: s.line_code, line_name: s.line_name, color: s.color,
          on_price_scale: s.on_price_scale, is_threshold: s.is_threshold, points: s.points.map(p => ({ dt: p.dt, value: p.value })),
        })),
        trades: synthTrades.filter(t => t.security_id === (b.securityId ?? 0)),
        markers: b.tradeMarkers.filter(m => m.kind === 'open' || m.kind === 'close'),
        stops: [], shaded: [], equity, equityShadow: [], closes: buildPaperReportCloseRows(synthTrades),
        pnl: this.totalPnlWithUnrealized(b), dealCount: b.trades.length,
        openQty: b.position !== 'flat' ? 1 : 0, lastPrice: this.currentPrice(b), loadError: null,
      };

      const run: BacktestReportRunInfo = {
        date_from: reportStartDt ? String(reportStartDt).slice(0, 10) : null,
        date_to: reportEndDt ? String(reportEndDt).slice(0, 10) : null,
        status: b.finished ? 'completed' : (b.started ? 'running' : 'idle'),
        progress_pct: b.finished ? 100 : (b.allCandles.length > 0 ? Math.round((b.playIndex / b.allCandles.length) * 100) : null),
      };
      const model = buildBacktestReportModel(synthLogic, synthTrades, { backtestRun: run, paperCharts: [paperChart], reportMode: 'test', configProvided: false });
      const html = renderBacktestReportHtml(model);
      const ok = openBacktestReportWindow(html, `Тренажёр — ${securityName}`);
      if (!ok) this.loadingError = 'Не удалось открыть отчёт. Разрешите всплывающие окна.';
    } catch (err: any) {
      console.error('Trainer report error', err);
      this.loadingError = err?.message || 'Ошибка формирования отчёта тренажёра';
    } finally {
      b.reportLoading = false;
      this.cdr.markForCheck();
    }
  }

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
