import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { ReferencesService } from '../services/references.service';
import { SecuritiesService } from '../services/securities.service';
import { ExchangeRow, IndicatorRow } from '../models/lookup.model';
import {
  ChartIndicatorSeries,
  ChartVisibleRange,
  IndicatorValueRow,
  PriceCandle,
  PriceLoadResult,
  PriceLoadUiState,
  IndicatorRecalcUiState,
  SecurityChartState,
  SecurityIndicatorSeriesRow,
  SecurityRow,
  TimeframeRow,
} from '../models/market.model';
import {
  AppConfigService,
  logicsLoadErrorMessage,
} from '../services/app-config.service';
import { PriceChartComponent } from '../price-chart/price-chart.component';
import { SecurityEditorComponent } from '../security-editor/security-editor.component';
import { TbankTokenDialogComponent } from '../tbank-token-dialog/tbank-token-dialog.component';
import { SettingsService } from '../services/settings.service';
import { TechLogService } from '../services/tech-log.service';

@Component({
  selector: 'app-securities-panel',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    PriceChartComponent,
    SecurityEditorComponent,
    TbankTokenDialogComponent,
  ],
  templateUrl: './securities-panel.component.html',
  styleUrl: './securities-panel.component.css',
})
export class SecuritiesPanelComponent implements OnInit {
  exchanges: ExchangeRow[] = [];
  timeframes: TimeframeRow[] = [];

  exchangeId: number | null = null;
  timeframeId: number | null = null;

  stocks: SecurityRow[] = [];
  futures: SecurityRow[] = [];

  stocksExpanded = false;
  futuresExpanded = false;
  expandedSecurities = new Set<number>();

  charts = new Map<number, SecurityChartState>();
  priceLoads = new Map<number, PriceLoadUiState>();
  securityIndicatorSeries = new Map<number, SecurityIndicatorSeriesRow[]>();
  indicatorSeries = new Map<number, ChartIndicatorSeries[]>();
  indicatorsLoading = new Set<number>();
  /** @deprecated не блокирует UI — оставлено для совместимости шаблона */
  indicatorAssigning = new Set<number>();
  indicatorRecalc = new Map<number, IndicatorRecalcUiState>();
  indicatorCalcError = new Map<number, string | null>();
  dropTargetId: number | null = null;
  private loadAbort = new Map<number, boolean>();
  private emptyChunks = new Map<number, number>();
  private visibleRangeTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private indicatorPollTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** Последнее видимое окно графика (для sync после loadOlder). */
  private lastVisibleRange = new Map<number, ChartVisibleRange>();
  /** Поколение sync: устаревшие poll-ответы отбрасываются. */
  private indicatorSyncGen = new Map<number, number>();
  /** Не рисовать индикаторы на графике, пока не готов расчёт для текущего окна. */
  private suppressIndicatorDraw = new Map<number, boolean>();
  /** Ожидание свечей и списка серий при развороте бумаги. */
  private expandIndicatorGate = new Map<
    number,
    { candlesReady: boolean; seriesReady: boolean }
  >();
  /** Диагностика sync для отладки зависаний. */
  private indicatorSyncDebug = new Map<number, string>();
  private readonly indicatorRangeDebounceMs = 650;
  private readonly indicatorRangeRetryMs = 250;
  private readonly indicatorRangeMaxRetries = 48;
  private readonly indicatorAutoRangeDebounceMs = 400;
  private readonly indicatorCoverageMaxAttempts = 12;
  private autoRangeTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private pendingSyncPointCount = new Map<number, number>();
  /** Последний end_dt успешного sync — для incremental при pan влево. */
  private lastSyncedEndDt = new Map<number, string>();
  /** loadOlder уже запрошен для этого syncGen. */
  private historyLoadForSyncGen = new Map<number, number>();
  /** trace_id для цепочки pan по security+gen. */
  private syncTraceIds = new Map<string, string>();
  /** mergeOnly sync при drag индикатора — блокирует параллельный full sync. */
  private assignMergeSyncGen = new Map<number, number>();
  /** Очередь drag-and-drop assign по бумаге (POST + mergeOnly sync по одному). */
  private assignQueue = new Map<
    number,
    Array<{ row: SecurityRow; indicatorId: number }>
  >();
  /** POST assignIndicatorSeries в полёте. */
  private assignPostInFlight = new Set<number>();
  /** mergeOnly syncGen — не делать flushDeferred сразу после finish. */
  private mergeOnlySyncGens = new Set<string>();
  /** Debounced flush после серии assign. */
  private deferredFlushTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly assignDeferredFlushMs = 1200;
  /** Отложенный full sync, пока идёт assign. */
  private deferredRangeSync = new Map<number, ChartVisibleRange>();
  /** Каталог индикаторов для оптимистичного drop (сразу в таблицу). */
  private indicatorsById = new Map<number, IndicatorRow>();

  private readonly chunkDays = 7;
  private readonly maxDaysBack = 365 * 3;
  private readonly maxEmptyChunks = 5;
  private readonly maxIndicatorCandles = 150;
  private readonly seriesColors = [
    '#2563eb',
    '#9333ea',
    '#ea580c',
    '#0891b2',
    '#ca8a04',
    '#db2777',
    '#059669',
    '#4f46e5',
  ];
  /** Индикаторы с серией VALUE на шкале цены (SMA, PACC, пользовательские …) */
  private readonly priceScaleOverlayCodes = new Set([
    'SMA',
    'EMA',
    'WMA',
    'PACC',
    'SMAT3',
  ]);

  loading = true;
  error: string | null = null;

  editorOpen = false;
  editorKind: 'stock' | 'futures' = 'stock';

  tbankTokenDialogOpen = false;
  private pendingPriceLoadRow: SecurityRow | null = null;

  constructor(
    private readonly refs: ReferencesService,
    private readonly securities: SecuritiesService,
    private readonly settings: SettingsService,
    private readonly techLog: TechLogService,
    private readonly appConfig: AppConfigService
  ) {}

  ngOnInit(): void {
    this.loadMeta();
  }

  get exchangeName(): string {
    return this.exchanges.find((e) => e.id === this.exchangeId)?.name ?? '';
  }

  chartState(id: number): SecurityChartState {
    return (
      this.charts.get(id) ?? {
        candles: [],
        loading: false,
        loadingOlder: false,
        hasMore: true,
        error: null,
      }
    );
  }

  assignedIndicatorSeries(id: number): SecurityIndicatorSeriesRow[] {
    return this.securityIndicatorSeries.get(id) ?? [];
  }

  chartIndicatorSeries(id: number): ChartIndicatorSeries[] {
    return this.indicatorSeries.get(id) ?? [];
  }

  /** Индикаторы для отрисовки: скрыты во время перемотки до завершения sync. */
  private static readonly EMPTY_CHART_SERIES: ChartIndicatorSeries[] = [];

  chartIndicatorsForDisplay(id: number): ChartIndicatorSeries[] {
    if (this.suppressIndicatorDraw.get(id)) {
      return SecuritiesPanelComponent.EMPTY_CHART_SERIES;
    }
    return this.chartIndicatorSeries(id);
  }

  isIndicatorsLoading(id: number): boolean {
    return this.indicatorsLoading.has(id);
  }

  indicatorRecalcState(id: number): IndicatorRecalcUiState {
    return (
      this.indicatorRecalc.get(id) ?? {
        active: false,
        message: null,
        error: null,
      }
    );
  }

  isIndicatorRecalcActive(id: number): boolean {
    return this.indicatorRecalcState(id).active;
  }

  indicatorStatus(id: number): string | null {
    const recalc = this.indicatorRecalcState(id);
    if (recalc.active && recalc.message) {
      return recalc.message;
    }
    if (this.indicatorsLoading.has(id)) {
      return 'Расчёт индикаторов…';
    }
    return null;
  }

  indicatorError(id: number): string | null {
    return this.indicatorCalcError.get(id) ?? null;
  }

  /** Техническая расшифровка последнего sync (для отладки). */
  indicatorSyncDebugText(id: number): string | null {
    return this.indicatorSyncDebug.get(id) ?? null;
  }

  private syncTraceKey(securityId: number, syncGen: number): string {
    return `${securityId}:${syncGen}`;
  }

  private traceForSync(securityId: number, syncGen: number): string {
    const key = this.syncTraceKey(securityId, syncGen);
    let trace = this.syncTraceIds.get(key);
    if (!trace) {
      trace = this.techLog.newTraceId(securityId, syncGen);
      this.syncTraceIds.set(key, trace);
    }
    return trace;
  }

  /** Новое поколение sync: отменяет устаревшие poll и логирует superseded. */
  private bumpSyncGen(securityId: number, reason: string): number {
    if (reason === 'assign') {
      this.deferredRangeSync.delete(securityId);
      const flushTimer = this.deferredFlushTimers.get(securityId);
      if (flushTimer) {
        clearTimeout(flushTimer);
        this.deferredFlushTimers.delete(securityId);
      }
    }
    const prev = this.indicatorSyncGen.get(securityId) ?? 0;
    const syncGen = prev + 1;
    this.indicatorSyncGen.set(securityId, syncGen);
    this.syncTraceIds.set(
      this.syncTraceKey(securityId, syncGen),
      this.techLog.newTraceId(securityId, syncGen)
    );
    if (reason !== 'assign' && this.assignMergeSyncGen.has(securityId)) {
      this.logSyncEvent(
        securityId,
        syncGen,
        'indicator.assign.superseded',
        reason,
        { assignGen: this.assignMergeSyncGen.get(securityId) }
      );
      this.assignMergeSyncGen.delete(securityId);
    }
    if (prev > 0) {
      this.logSyncEvent(
        securityId,
        syncGen,
        'indicator.sync.superseded',
        `${prev} → ${syncGen}`,
        { reason, prevGen: prev }
      );
    }
    this.clearIndicatorPoll(securityId);
    return syncGen;
  }

  private isAssignMergeSyncActive(securityId: number): boolean {
    return this.assignMergeSyncGen.has(securityId);
  }

  private isAssignBusy(securityId: number): boolean {
    return (
      this.isAssignMergeSyncActive(securityId) ||
      this.assignPostInFlight.has(securityId) ||
      (this.assignQueue.get(securityId)?.length ?? 0) > 0
    );
  }

  private scheduleDebouncedDeferredFlush(securityId: number): void {
    const prev = this.deferredFlushTimers.get(securityId);
    if (prev) {
      clearTimeout(prev);
    }
    this.deferredFlushTimers.set(
      securityId,
      setTimeout(() => {
        this.deferredFlushTimers.delete(securityId);
        if (this.isAssignBusy(securityId) || this.isIndicatorRecalcActive(securityId)) {
          this.scheduleDebouncedDeferredFlush(securityId);
          return;
        }
        this.flushDeferredRangeSync(securityId);
      }, this.assignDeferredFlushMs)
    );
  }

  private flushDeferredRangeSync(securityId: number): void {
    if (this.isAssignBusy(securityId)) {
      return;
    }
    const range = this.deferredRangeSync.get(securityId);
    if (!range) {
      return;
    }
    this.deferredRangeSync.delete(securityId);
    this.logSyncEvent(
      securityId,
      this.indicatorSyncGen.get(securityId),
      'indicator.sync.deferredFlush',
      `${range.count} bars`,
      { startDt: range.startDt, endDt: range.endDt }
    );
    this.syncIndicatorsForRange(securityId, range, { incremental: true });
  }

  private logSyncEvent(
    securityId: number,
    syncGen: number | null | undefined,
    operation: string,
    message: string,
    payload?: Record<string, unknown>
  ): void {
    const gen = syncGen ?? undefined;
    this.techLog.event(
      this.techLog.threadKey(securityId, gen),
      operation,
      message,
      {
        traceId: gen != null ? this.traceForSync(securityId, gen) : undefined,
        securityId,
        timeframeId: this.timeframeId ?? undefined,
        syncGen: gen,
        payload,
      }
    );
  }

  private setIndicatorSyncDebug(securityId: number, detail: string): void {
    const stamp = new Date().toLocaleTimeString('ru-RU');
    const line = `[${stamp}] ${detail}`;
    this.indicatorSyncDebug.set(securityId, line);
    console.debug(`indicator-sync #${securityId}: ${detail}`);
  }

  isDropTarget(id: number): boolean {
    return this.dropTargetId === id;
  }

  onDragOver(event: DragEvent, securityId: number): void {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
    this.dropTargetId = securityId;
  }

  onDragLeave(event: DragEvent, securityId: number): void {
    const related = event.relatedTarget as Node | null;
    const current = event.currentTarget as Node;
    if (related && current.contains(related)) return;
    if (this.dropTargetId === securityId) {
      this.dropTargetId = null;
    }
  }

  onDrop(event: DragEvent, row: SecurityRow): void {
    event.preventDefault();
    event.stopPropagation();
    this.dropTargetId = null;
    const raw = event.dataTransfer?.getData('application/x-indicator-id');
    const indicatorId = raw ? parseInt(raw, 10) : NaN;
    if (!Number.isInteger(indicatorId) || indicatorId <= 0) return;
    this.assignIndicator(row, indicatorId);
  }

  removeIndicatorSeries(assignment: SecurityIndicatorSeriesRow, event: Event): void {
    event.stopPropagation();
    if (assignment.id < 0) {
      const list = (
        this.securityIndicatorSeries.get(assignment.security_id) ?? []
      ).filter((x) => x.id !== assignment.id);
      this.securityIndicatorSeries.set(assignment.security_id, list);
      return;
    }
    this.securities.removeIndicatorSeries(assignment.id).subscribe({
      next: () => {
        const list = (
          this.securityIndicatorSeries.get(assignment.security_id) ?? []
        ).filter((x) => x.id !== assignment.id);
        this.securityIndicatorSeries.set(assignment.security_id, list);
        if (this.expandedSecurities.has(assignment.security_id)) {
          this.refreshIndicatorChart(assignment.security_id);
        }
      },
      error: (err) => {
        console.error(err);
      },
    });
  }

  seriesLabel(row: SecurityIndicatorSeriesRow): string {
    const code = row.series_code === 'VALUE' ? '' : ` ${row.series_code}`;
    return `${row.indicator_code}${code} — ${row.indicator_name}`;
  }

  private assignIndicator(row: SecurityRow, indicatorId: number): void {
    if (!this.timeframeId) return;

    const ind = this.indicatorsById.get(indicatorId);
    if (!ind) {
      this.indicatorCalcError.set(
        row.id,
        `Индикатор #${indicatorId} не найден в справочнике — обновите страницу`
      );
      return;
    }

    const existing = this.securityIndicatorSeries.get(row.id) ?? [];
    if (existing.some((x) => x.indicator_id === indicatorId && x.is_active)) {
      return;
    }
    if (existing.some((x) => x.indicator_id === indicatorId && x.id < 0)) {
      return;
    }

    const queue = this.assignQueue.get(row.id) ?? [];
    if (queue.some((x) => x.indicatorId === indicatorId)) {
      return;
    }
    queue.push({ row, indicatorId });
    this.assignQueue.set(row.id, queue);
    this.processAssignQueue(row.id);
  }

  /** Один assign из очереди: POST → mergeOnly sync. */
  private processAssignQueue(securityId: number): void {
    if (this.assignPostInFlight.has(securityId)) {
      return;
    }
    if (this.isAssignMergeSyncActive(securityId)) {
      return;
    }
    const queue = this.assignQueue.get(securityId);
    if (!queue?.length) {
      return;
    }
    const item = queue.shift()!;
    if (queue.length === 0) {
      this.assignQueue.delete(securityId);
    } else {
      this.assignQueue.set(securityId, queue);
    }
    this.executeAssignIndicator(item.row, item.indicatorId);
  }

  private executeAssignIndicator(row: SecurityRow, indicatorId: number): void {
    const ind = this.indicatorsById.get(indicatorId);
    if (!ind || !this.timeframeId) {
      this.processAssignQueue(row.id);
      return;
    }

    const pending = this.buildPendingSeriesRows(row.id, ind);
    const existing = this.securityIndicatorSeries.get(row.id) ?? [];
    this.securityIndicatorSeries.set(row.id, [...existing, ...pending]);

    if (!this.expandedSecurities.has(row.id)) {
      this.expandedSecurities.add(row.id);
      this.charts.set(row.id, {
        candles: [],
        loading: true,
        loadingOlder: false,
        hasMore: true,
        error: null,
      });
      this.loadChart(row.id, false, { skipIndicatorSync: true });
    }

    const indicatorCode = ind.code;
    this.indicatorRecalc.set(row.id, {
      active: true,
      message: `Добавление ${indicatorCode}…`,
      error: null,
    });
    this.indicatorCalcError.set(row.id, null);
    this.assignPostInFlight.add(row.id);

    this.securities
      .assignIndicatorSeries(row.id, indicatorId, this.timeframeId)
      .subscribe({
        next: (created) => {
          this.assignPostInFlight.delete(row.id);
          const pendingIds = new Set(pending.map((p) => p.id));
          const merged = (this.securityIndicatorSeries.get(row.id) ?? []).filter(
            (x) => !pendingIds.has(x.id)
          );
          for (const s of created) {
            if (!merged.some((x) => x.id === s.id)) {
              merged.push(s);
            }
          }
          this.securityIndicatorSeries.set(row.id, merged);
          this.startBackgroundIndicatorSync(
            row.id,
            indicatorId,
            indicatorCode,
            created
          );
        },
        error: (err) => {
          this.assignPostInFlight.delete(row.id);
          const pendingIds = new Set(pending.map((p) => p.id));
          const kept = (this.securityIndicatorSeries.get(row.id) ?? []).filter(
            (x) => !pendingIds.has(x.id)
          );
          this.securityIndicatorSeries.set(row.id, kept);
          const msg =
            err?.name === 'TimeoutError'
              ? 'Таймаут при регистрации серии индикатора'
              : err?.error?.error || err?.message || 'Ошибка добавления индикатора';
          const hasQueued = (this.assignQueue.get(row.id)?.length ?? 0) > 0;
          if (!hasQueued) {
            this.indicatorRecalc.set(row.id, {
              active: false,
              message: null,
              error: msg,
            });
          }
          this.indicatorCalcError.set(row.id, msg);
          console.error(err);
          this.processAssignQueue(row.id);
        },
      });
  }

  /** Временные строки (отрицательный id) — сразу в UI до ответа POST. */
  private buildPendingSeriesRows(
    securityId: number,
    ind: IndicatorRow
  ): SecurityIndicatorSeriesRow[] {
    const types = (ind.value_types ?? []).filter((t) => !t.is_threshold);
    const series =
      types.length > 0
        ? types
        : [{ code: 'VALUE', display_order: 1, name: 'VALUE', is_threshold: false }];
    return series.map((vt, idx) => ({
      id: -(ind.id * 100 + idx + 1),
      security_id: securityId,
      indicator_id: ind.id,
      series_code: vt.code,
      invoke_formula: ind.formula?.trim() || ind.script?.trim() || '',
      indicator_code: ind.code,
      indicator_name: ind.name,
      point_count: 100,
      display_order: vt.display_order ?? idx + 1,
      is_active: true,
    }));
  }

  private startBackgroundIndicatorSync(
    securityId: number,
    indicatorId: number,
    indicatorCode: string,
    seriesRows: SecurityIndicatorSeriesRow[]
  ): void {
    if (!this.timeframeId) return;

    const range = this.candleRange(this.chartState(securityId).candles);
    const seriesLabel = this.formatIndicatorRecalcLabel(indicatorCode, seriesRows);

    this.runAsyncIndicatorSync(securityId, {
      message: `Пересчёт ${seriesLabel}…`,
      indicatorId,
      seriesRows,
      range,
      mergeOnly: true,
    });
  }

  /** Неблокирующий sync: POST async: true → опрос indicator_values. */
  private runAsyncIndicatorSync(
    securityId: number,
    opts: {
      message: string;
      indicatorId?: number;
      seriesRows: SecurityIndicatorSeriesRow[];
      range: ChartVisibleRange | null;
      incremental?: boolean;
      mergeOnly?: boolean;
      syncGen?: number;
    }
  ): void {
    if (!this.timeframeId) return;

    const syncGen =
      opts.syncGen ?? this.bumpSyncGen(securityId, opts.mergeOnly ? 'assign' : 'fullSync');
    if (opts.mergeOnly) {
      this.assignMergeSyncGen.set(securityId, syncGen);
      this.mergeOnlySyncGens.add(`${securityId}:${syncGen}`);
    }

    this.clearIndicatorPoll(securityId);
    this.indicatorRecalc.set(securityId, {
      active: true,
      message: opts.message,
      error: null,
    });

    const body: Parameters<SecuritiesService['syncIndicatorSeries']>[0] = {
      security_id: securityId,
      timeframe_id: this.timeframeId,
      end_dt: opts.range?.endDt,
      point_count: opts.range?.count,
      incremental: opts.incremental !== false,
      async: true,
    };
    if (opts.indicatorId) {
      body.indicator_id = opts.indicatorId;
    }

    const spanId = this.techLog.start(
      this.traceForSync(securityId, syncGen),
      this.techLog.threadKey(
        securityId,
        syncGen,
        opts.mergeOnly ? 'assignSync' : 'asyncSync'
      ),
      'indicator.asyncSync',
      {
        securityId,
        timeframeId: this.timeframeId ?? undefined,
        syncGen,
        message: opts.message,
        payload: {
          end_dt: body.end_dt,
          point_count: body.point_count,
          incremental: body.incremental,
          indicator_id: body.indicator_id ?? null,
          merge_only: opts.mergeOnly === true,
        },
      }
    );

    this.logSyncEvent(
      securityId,
      syncGen,
      'indicator.asyncSync.start',
      opts.message,
      {
        end_dt: body.end_dt,
        point_count: body.point_count,
        indicator_id: body.indicator_id ?? null,
        merge_only: opts.mergeOnly === true,
      }
    );

    this.securities.syncIndicatorSeries(body).subscribe({
      next: () => {
        this.logSyncEvent(securityId, syncGen, 'indicator.asyncSync.accepted', 'POST 202', {
          end_dt: body.end_dt,
          point_count: body.point_count,
          indicator_id: body.indicator_id ?? null,
        });
        this.pollIndicatorValuesAfterSync(
          securityId,
          opts.indicatorId ? [opts.indicatorId] : null,
          opts.seriesRows,
          opts.range,
          opts.mergeOnly === true,
          syncGen,
          0,
          spanId
        );
      },
      error: (err) => {
        this.techLog.end(spanId, {
          message: 'asyncSync POST error',
          payload: { error: err?.message ?? String(err) },
        });
        const msg =
          err?.name === 'TimeoutError'
            ? 'Не удалось запустить пересчёт индикаторов'
            : err?.error?.error || err?.message || 'Ошибка запуска пересчёта';
        this.finishIndicatorRecalc(securityId, msg, syncGen);
      },
    });
  }

  private finishIndicatorRecalc(
    securityId: number,
    error: string | null,
    syncGen: number
  ): void {
    if (!this.isSyncGenerationCurrent(securityId, syncGen)) {
      this.logSyncEvent(
        securityId,
        syncGen,
        'indicator.recalc.stale',
        'finish ignored',
        {}
      );
      return;
    }

    this.indicatorRecalc.set(securityId, {
      active: false,
      message: null,
      error,
    });
    if (error) {
      this.indicatorCalcError.set(securityId, error);
      this.suppressIndicatorDraw.set(securityId, false);
      this.logSyncEvent(securityId, syncGen, 'indicator.recalc.error', error, {});
    } else {
      this.indicatorCalcError.set(securityId, null);
      this.logSyncEvent(securityId, syncGen, 'indicator.recalc.done', 'OK', {});
    }
    if (this.assignMergeSyncGen.get(securityId) === syncGen) {
      this.assignMergeSyncGen.delete(securityId);
    }
    this.indicatorPollTimers.delete(securityId);
    const wasMergeOnly = this.mergeOnlySyncGens.delete(`${securityId}:${syncGen}`);
    if (!error) {
      if (wasMergeOnly) {
        this.scheduleDebouncedDeferredFlush(securityId);
        this.processAssignQueue(securityId);
      } else {
        this.flushDeferredRangeSync(securityId);
      }
    } else if (wasMergeOnly) {
      this.processAssignQueue(securityId);
    }
  }

  private isSyncGenerationCurrent(
    securityId: number,
    syncGen: number | null
  ): boolean {
    if (syncGen === null) {
      return false;
    }
    return this.indicatorSyncGen.get(securityId) === syncGen;
  }

  private candlesCoverRange(
    candles: PriceCandle[],
    range: ChartVisibleRange
  ): boolean {
    if (candles.length === 0) {
      return false;
    }
    const first = candles[0].dt;
    const last = candles[candles.length - 1].dt;
    return first <= range.startDt && last >= range.endDt;
  }

  private indicatorValuesCoverRange(
    values: IndicatorValueRow[],
    range: ChartVisibleRange,
    pointCount?: number
  ): boolean {
    if (values.length === 0) {
      return false;
    }
    const target = Math.min(
      range.count,
      pointCount ?? range.count,
      this.maxIndicatorCandles
    );
    const inRange = values.filter(
      (v) => v.dt >= range.startDt && v.dt <= range.endDt
    );
    const need = Math.max(1, Math.floor(target * 0.85));
    return inRange.length >= need;
  }

  private scheduleAutoIndicatorRangeSync(
    securityId: number,
    range: ChartVisibleRange
  ): void {
    if (this.suppressIndicatorDraw.get(securityId)) {
      return;
    }
    if (this.isAssignBusy(securityId)) {
      this.deferredRangeSync.set(securityId, range);
      return;
    }
    const assigned = this.securityIndicatorSeries.get(securityId) ?? [];
    if (assigned.length === 0) {
      return;
    }
    const prev = this.autoRangeTimers.get(securityId);
    if (prev) clearTimeout(prev);
    this.autoRangeTimers.set(
      securityId,
      setTimeout(() => {
        this.autoRangeTimers.delete(securityId);
        if (
          this.suppressIndicatorDraw.get(securityId) ||
          this.isIndicatorRecalcActive(securityId) ||
          this.isAssignBusy(securityId)
        ) {
          return;
        }
        this.setIndicatorSyncDebug(
          securityId,
          `range auto sync: ${range.count} bars (без suppress)`
        );
        this.syncIndicatorsForRange(securityId, range, { incremental: true });
      }, this.indicatorAutoRangeDebounceMs)
    );
  }

  private scheduleIndicatorRangeSync(
    securityId: number,
    range: ChartVisibleRange,
    syncGen: number,
    retry = 0
  ): void {
    const liveRange = this.lastVisibleRange.get(securityId) ?? range;

    if (!this.isSyncGenerationCurrent(securityId, syncGen)) {
      this.setIndicatorSyncDebug(
        securityId,
        `sync skip: устаревшее поколение gen=${syncGen}`
      );
      this.logSyncEvent(
        securityId,
        syncGen,
        'indicator.rangeSync.stale',
        `skip gen=${syncGen}`,
        { retry }
      );
      return;
    }

    const state = this.chartState(securityId);
    if (state.loading || state.loadingOlder) {
      this.indicatorRecalc.set(securityId, {
        active: true,
        message: 'Ожидание свечей…',
        error: null,
      });
      this.setIndicatorSyncDebug(
        securityId,
        `wait candles: loading=${state.loading}, older=${state.loadingOlder}, retry=${retry}`
      );
      this.logSyncEvent(
        securityId,
        syncGen,
        'indicator.rangeSync.waitCandles',
        `loading=${state.loading}, older=${state.loadingOlder}`,
        { retry }
      );
      if (state.loadingOlder && !state.loading) {
        return;
      }
      if (retry < this.indicatorRangeMaxRetries) {
        if (retry > 0 && retry % 12 === 0) {
          this.logSyncEvent(
            securityId,
            syncGen,
            'indicator.rangeSync.retryStorm',
            `waitCandles retry=${retry}/${this.indicatorRangeMaxRetries}`,
            { retry, loading: state.loading, loadingOlder: state.loadingOlder }
          );
        }
        setTimeout(
          () =>
            this.scheduleIndicatorRangeSync(
              securityId,
              liveRange,
              syncGen,
              retry + 1
            ),
          this.indicatorRangeRetryMs
        );
      } else {
        this.logSyncEvent(
          securityId,
          syncGen,
          'ui.sync.blocked',
          'Таймаут ожидания свечей',
          { retry }
        );
        this.finishIndicatorRecalc(securityId, 'Таймаут ожидания свечей', syncGen);
      }
      return;
    }

    if (!this.candlesCoverRange(state.candles, liveRange)) {
      this.indicatorRecalc.set(securityId, {
        active: true,
        message: 'Загрузка истории…',
        error: null,
      });
      const first = state.candles[0]?.dt;
      const needOlder =
        state.candles.length > 0 &&
        first != null &&
        liveRange.startDt < first &&
        state.hasMore &&
        !state.loadingOlder;
      if (
        needOlder &&
        this.historyLoadForSyncGen.get(securityId) !== syncGen
      ) {
        this.historyLoadForSyncGen.set(securityId, syncGen);
        this.logSyncEvent(
          securityId,
          syncGen,
          'chart.loadOlder.request',
          `need ${liveRange.startDt}, have from ${first}`,
          { retry }
        );
        this.loadChart(securityId, true, { skipIndicatorSync: true });
      }
      this.setIndicatorSyncDebug(
        securityId,
        `wait history: need ${liveRange.startDt}…${liveRange.endDt}, have ${state.candles[0]?.dt ?? '—'}…${state.candles[state.candles.length - 1]?.dt ?? '—'}, retry=${retry}`
      );
      this.logSyncEvent(
        securityId,
        syncGen,
        'indicator.rangeSync.waitHistory',
        `retry=${retry}`,
        {
          needStart: liveRange.startDt,
          needEnd: liveRange.endDt,
          haveStart: state.candles[0]?.dt ?? null,
          haveEnd: state.candles[state.candles.length - 1]?.dt ?? null,
          needOlder,
        }
      );
      if (state.loadingOlder) {
        return;
      }
      if (retry < this.indicatorRangeMaxRetries) {
        if (retry > 0 && retry % 12 === 0) {
          this.logSyncEvent(
            securityId,
            syncGen,
            'indicator.rangeSync.retryStorm',
            `waitHistory retry=${retry}/${this.indicatorRangeMaxRetries}`,
            {
              retry,
              needStart: liveRange.startDt,
              needEnd: liveRange.endDt,
              haveStart: state.candles[0]?.dt ?? null,
            }
          );
        }
        setTimeout(
          () =>
            this.scheduleIndicatorRangeSync(
              securityId,
              liveRange,
              syncGen,
              retry + 1
            ),
          this.indicatorRangeRetryMs
        );
      } else {
        this.logSyncEvent(
          securityId,
          syncGen,
          'ui.sync.blocked',
          'Недостаточно свечей для расчёта индикаторов',
          { retry, needStart: liveRange.startDt, needEnd: liveRange.endDt }
        );
        this.finishIndicatorRecalc(
          securityId,
          'Недостаточно свечей для расчёта индикаторов',
          syncGen
        );
      }
      return;
    }

    this.historyLoadForSyncGen.delete(securityId);
    this.setIndicatorSyncDebug(
      securityId,
      `sync start: gen=${syncGen}, bars=${liveRange.count}, ${liveRange.startDt}…${liveRange.endDt}`
    );
    this.logSyncEvent(
      securityId,
      syncGen,
      'indicator.rangeSync.start',
      `${liveRange.count} bars`,
      {
        startDt: liveRange.startDt,
        endDt: liveRange.endDt,
        retry,
      }
    );
    this.syncIndicatorsForRange(securityId, liveRange, {
      incremental: true,
      syncGen,
    });
  }

  private tryExpandIndicatorSync(securityId: number): void {
    const gate = this.expandIndicatorGate.get(securityId);
    if (!gate?.candlesReady || !gate?.seriesReady) {
      return;
    }
    this.expandIndicatorGate.delete(securityId);

    const assigned = this.securityIndicatorSeries.get(securityId) ?? [];
    const candles = this.chartState(securityId).candles;
    this.setIndicatorSyncDebug(
      securityId,
      `expand ready: series=${assigned.length}, candles=${candles.length}`
    );
    if (assigned.length === 0 || candles.length === 0) {
      return;
    }

    if (this.isAssignBusy(securityId)) {
      this.setIndicatorSyncDebug(
        securityId,
        `expand skip refresh: assign busy`
      );
      this.suppressIndicatorDraw.set(securityId, false);
      return;
    }

    this.suppressIndicatorDraw.set(securityId, false);
    this.refreshIndicatorChart(securityId);
  }

  private pollIndicatorValuesAfterSync(
    securityId: number,
    indicatorIds: number[] | null,
    seriesRows: SecurityIndicatorSeriesRow[],
    range: ChartVisibleRange | null,
    mergeOnly: boolean,
    syncGen: number,
    attempt: number,
    asyncSpanId = ''
  ): void {
    if (!this.isSyncGenerationCurrent(securityId, syncGen)) {
      this.logSyncEvent(
        securityId,
        syncGen,
        'indicator.poll.stale',
        `attempt=${attempt}`,
        { phase: 'enter' }
      );
      this.techLog.end(asyncSpanId, { message: 'poll aborted: stale gen' });
      return;
    }
    const maxAttempts = 45;
    const label =
      indicatorIds?.length === 1
        ? seriesRows[0]?.indicator_code ?? 'индикатора'
        : 'индикаторов';
    if (attempt >= maxAttempts) {
      this.techLog.end(asyncSpanId, {
        message: 'poll timeout',
        payload: { attempt, maxAttempts },
      });
      this.finishIndicatorRecalc(
        securityId,
        `Таймаут пересчёта ${label}`,
        syncGen
      );
      return;
    }

    const ids =
      indicatorIds ??
      [...new Set(seriesRows.map((s) => s.indicator_id))].filter(Boolean);
    if (ids.length === 0) {
      this.techLog.end(asyncSpanId, { message: 'poll: no indicator ids' });
      this.finishIndicatorRecalc(securityId, null, syncGen);
      return;
    }

    if (attempt === 0) {
      this.logSyncEvent(
        securityId,
        syncGen,
        'indicator.poll.start',
        mergeOnly ? 'mergeOnly' : 'full',
        { indicator_ids: ids, mergeOnly }
      );
    }

    const waitMs = attempt === 0 ? 500 : attempt < 5 ? 800 : 2000;
    const timer = setTimeout(() => {
      if (!this.timeframeId || !this.isSyncGenerationCurrent(securityId, syncGen)) {
        this.logSyncEvent(
          securityId,
          syncGen,
          'indicator.poll.stale',
          `timer attempt=${attempt + 1}`,
          {}
        );
        this.techLog.end(asyncSpanId, { message: 'poll timer: stale gen' });
        return;
      }
      this.securities
        .getIndicatorValues(
          securityId,
          this.timeframeId,
          ids,
          range?.startDt,
          range?.endDt
        )
        .subscribe({
          next: (values) => {
            if (!this.isSyncGenerationCurrent(securityId, syncGen)) {
              this.logSyncEvent(
                securityId,
                syncGen,
                'indicator.poll.stale',
                `response attempt=${attempt + 1}`,
                { points: values.length }
              );
              this.techLog.end(asyncSpanId, { message: 'poll response: stale gen' });
              return;
            }
            if (values.length === 0) {
              if (attempt === 0 || attempt % 5 === 0) {
                this.logSyncEvent(
                  securityId,
                  syncGen,
                  'indicator.poll.empty',
                  `attempt=${attempt + 1}`,
                  { waitMs }
                );
              }
              if (!this.isSyncGenerationCurrent(securityId, syncGen)) {
                return;
              }
              this.pollIndicatorValuesAfterSync(
                securityId,
                indicatorIds,
                seriesRows,
                range,
                mergeOnly,
                syncGen,
                attempt + 1,
                asyncSpanId
              );
              return;
            }
            if (
              range &&
              !mergeOnly &&
              !this.indicatorValuesCoverRange(
                values,
                range,
                this.pendingSyncPointCount.get(securityId)
              ) &&
              attempt < this.indicatorCoverageMaxAttempts
            ) {
              this.setIndicatorSyncDebug(
                securityId,
                `poll wait coverage: got=${values.length}, attempt=${attempt + 1}`
              );
              if (!this.isSyncGenerationCurrent(securityId, syncGen)) {
                return;
              }
              this.pollIndicatorValuesAfterSync(
                securityId,
                indicatorIds,
                seriesRows,
                range,
                mergeOnly,
                syncGen,
                attempt + 1,
                asyncSpanId
              );
              return;
            }
            if (
              range &&
              values.length > 0 &&
              attempt >= this.indicatorCoverageMaxAttempts
            ) {
              this.setIndicatorSyncDebug(
                securityId,
                `poll partial: ${values.length} points after ${attempt + 1} attempts`
              );
            }
            if (mergeOnly && indicatorIds?.length === 1) {
              this.mergeIndicatorChartSeries(securityId, values, seriesRows);
            } else {
              this.indicatorSeries.set(
                securityId,
                this.buildChartSeries(values, seriesRows)
              );
            }
            if (this.isSyncGenerationCurrent(securityId, syncGen)) {
              this.suppressIndicatorDraw.set(securityId, false);
            }
            this.setIndicatorSyncDebug(
              securityId,
              `poll ok: points=${values.length}, gen=${syncGen}, merge=${mergeOnly}`
            );
            this.logSyncEvent(
              securityId,
              syncGen,
              'indicator.poll.ok',
              `points=${values.length}`,
              { attempt: attempt + 1, mergeOnly }
            );
            this.techLog.end(asyncSpanId, {
              message: 'poll ok',
              payload: { points: values.length, attempt: attempt + 1 },
            });
            this.finishIndicatorRecalc(securityId, null, syncGen);
          },
          error: () => {
            if (!this.isSyncGenerationCurrent(securityId, syncGen)) {
              this.techLog.end(asyncSpanId, { message: 'poll error: stale gen' });
              return;
            }
            this.logSyncEvent(
              securityId,
              syncGen,
              'indicator.poll.error',
              `attempt=${attempt + 1}`,
              {}
            );
            if (!this.isSyncGenerationCurrent(securityId, syncGen)) {
              return;
            }
            this.pollIndicatorValuesAfterSync(
              securityId,
              indicatorIds,
              seriesRows,
              range,
              mergeOnly,
              syncGen,
              attempt + 1,
              asyncSpanId
            );
          },
        });
    }, waitMs);
    this.indicatorPollTimers.set(securityId, timer);
  }

  private mergeIndicatorChartSeries(
    securityId: number,
    values: IndicatorValueRow[],
    assigned: SecurityIndicatorSeriesRow[]
  ): void {
    const fresh = this.buildChartSeries(values, assigned);
    const freshKeys = new Set(
      fresh.map((s) => `${s.indicator_code}:${s.line_code}`)
    );
    const kept = this.chartIndicatorSeries(securityId).filter(
      (s) => !freshKeys.has(`${s.indicator_code}:${s.line_code}`)
    );
    this.indicatorSeries.set(securityId, [...kept, ...fresh]);
  }

  private candleRange(candles: PriceCandle[]): ChartVisibleRange | null {
    if (candles.length === 0) return null;
    const end = candles.length - 1;
    const start = Math.max(0, end - this.maxIndicatorCandles + 1);
    return {
      startDt: candles[start].dt,
      endDt: candles[end].dt,
      count: end - start + 1,
      viewStart: start,
    };
  }

  private formatIndicatorRecalcLabel(
    indicatorCode: string,
    seriesRows: SecurityIndicatorSeriesRow[]
  ): string {
    const codes = [
      ...new Set(
        seriesRows.map((s) =>
          s.series_code === 'VALUE' ? indicatorCode : `${indicatorCode} ${s.series_code}`
        )
      ),
    ];
    return codes.join(', ');
  }

  private clearIndicatorPoll(securityId: number): void {
    const timer = this.indicatorPollTimers.get(securityId);
    if (timer) {
      clearTimeout(timer);
      this.indicatorPollTimers.delete(securityId);
    }
  }

  private refreshIndicatorChart(securityId: number): void {
    const candles = this.chartState(securityId).candles;
    if (candles.length === 0) {
      this.indicatorSeries.set(securityId, []);
      return;
    }
    const end = candles.length - 1;
    const start = Math.max(0, end - this.maxIndicatorCandles + 1);
    this.syncIndicatorsForRange(
      securityId,
      {
        startDt: candles[start].dt,
        endDt: candles[end].dt,
        count: end - start + 1,
        viewStart: start,
      },
      { incremental: true }
    );
  }

  isSecurityExpanded(id: number): boolean {
    return this.expandedSecurities.has(id);
  }

  toggleGroup(kind: 'stock' | 'futures'): void {
    if (kind === 'stock') {
      this.stocksExpanded = !this.stocksExpanded;
    } else {
      this.futuresExpanded = !this.futuresExpanded;
    }
  }

  toggleSecurity(row: SecurityRow): void {
    if (this.expandedSecurities.has(row.id)) {
      this.expandedSecurities.delete(row.id);
      this.expandIndicatorGate.delete(row.id);
      return;
    }
    this.expandedSecurities.add(row.id);
    this.charts.set(row.id, {
      candles: [],
      loading: true,
      loadingOlder: false,
      hasMore: true,
      error: null,
    });
    this.indicatorSeries.set(row.id, []);
    this.indicatorCalcError.set(row.id, null);
    this.indicatorsLoading.delete(row.id);
    this.suppressIndicatorDraw.set(row.id, false);
    this.expandIndicatorGate.set(row.id, {
      candlesReady: false,
      seriesReady: false,
    });
    this.setIndicatorSyncDebug(row.id, 'expand: загрузка свечей и списка индикаторов');

    this.loadChart(row.id, false, { skipIndicatorSync: true });
    this.securities.getSecurityIndicatorSeries(row.id).subscribe({
      next: (rows) => {
        this.securityIndicatorSeries.set(row.id, rows);
        const gate = this.expandIndicatorGate.get(row.id);
        if (gate) {
          gate.seriesReady = true;
          this.expandIndicatorGate.set(row.id, gate);
        }
        this.tryExpandIndicatorSync(row.id);
      },
      error: () => {
        this.securityIndicatorSeries.set(row.id, []);
        const gate = this.expandIndicatorGate.get(row.id);
        if (gate) {
          gate.seriesReady = true;
          this.expandIndicatorGate.set(row.id, gate);
        }
        this.tryExpandIndicatorSync(row.id);
      },
    });
  }

  onExchangeChange(): void {
    this.expandedSecurities.clear();
    this.charts.clear();
    this.securityIndicatorSeries.clear();
    this.indicatorSeries.clear();
    this.loadSecurities();
  }

  onTimeframeChange(): void {
    for (const id of [...this.expandedSecurities]) {
      this.charts.set(id, {
        candles: [],
        loading: true,
        loadingOlder: false,
        hasMore: true,
        error: null,
      });
      this.loadChart(id, false, { fullIndicatorRefresh: true });
    }
  }

  openAdd(kind: 'stock' | 'futures'): void {
    this.editorKind = kind;
    this.editorOpen = true;
  }

  onSecuritySaved(): void {
    this.loadSecurities();
  }

  onLoadOlder(securityId: number): void {
    const state = this.chartState(securityId);
    if (state.loadingOlder || !state.hasMore || state.candles.length === 0) {
      return;
    }
    this.logSyncEvent(securityId, null, 'chart.loadOlder', 'viewStart edge', {
      candles: state.candles.length,
    });
    this.loadChart(securityId, true);
  }

  onChartVisibleRange(securityId: number, range: ChartVisibleRange): void {
    if (!range.startDt || !range.endDt || range.count <= 0) return;

    this.lastVisibleRange.set(securityId, range);
    if (!range.userInitiated) {
      this.setIndicatorSyncDebug(
        securityId,
        `range auto: ${range.count} bars (без suppress)`
      );
      this.scheduleAutoIndicatorRangeSync(securityId, range);
      return;
    }

    const syncGen = this.bumpSyncGen(securityId, 'userPan');

    const prev = this.visibleRangeTimers.get(securityId);
    if (prev) clearTimeout(prev);
    const autoPrev = this.autoRangeTimers.get(securityId);
    if (autoPrev) clearTimeout(autoPrev);

    this.suppressIndicatorDraw.set(securityId, true);
    this.indicatorRecalc.set(securityId, {
      active: true,
      message: 'Подготовка индикаторов…',
      error: null,
    });
    this.indicatorCalcError.set(securityId, null);
    this.setIndicatorSyncDebug(
      securityId,
      `range user: gen=${syncGen}, debounce ${this.indicatorRangeDebounceMs}ms`
    );
    this.logSyncEvent(
      securityId,
      syncGen,
      'chart.visibleRange.user',
      `${range.count} bars ${range.startDt}…${range.endDt}`,
      { viewStart: range.viewStart }
    );

    this.visibleRangeTimers.set(
      securityId,
      setTimeout(() => {
        const live = this.lastVisibleRange.get(securityId) ?? range;
        this.scheduleIndicatorRangeSync(securityId, live, syncGen);
      }, this.indicatorRangeDebounceMs)
    );
  }

  onRecalcIndicators(securityId: number, range: ChartVisibleRange): void {
    if (!range.startDt || !range.endDt || range.count <= 0) return;

    this.lastVisibleRange.set(securityId, range);
    const syncGen = this.bumpSyncGen(securityId, 'manualRecalc');
    this.suppressIndicatorDraw.set(securityId, true);
    this.scheduleIndicatorRangeSync(securityId, range, syncGen);
  }

  priceLoadState(id: number): PriceLoadUiState {
    return (
      this.priceLoads.get(id) ?? {
        active: false,
        message: null,
        error: null,
      }
    );
  }

  isPriceLoadActive(id: number): boolean {
    return this.priceLoadState(id).active;
  }

  startLoadPrices(row: SecurityRow, event: Event): void {
    event.stopPropagation();
    if (!this.timeframeId || this.isPriceLoadActive(row.id)) return;

    this.settings.getTbankTokenStatus().subscribe({
      next: ({ has_token }) => {
        if (!has_token) {
          this.pendingPriceLoadRow = row;
          this.tbankTokenDialogOpen = true;
          return;
        }
        this.beginPriceLoad(row);
      },
      error: () => this.beginPriceLoad(row),
    });
  }

  onTbankTokenSaved(): void {
    this.tbankTokenDialogOpen = false;
    const row = this.pendingPriceLoadRow;
    this.pendingPriceLoadRow = null;
    if (row) this.beginPriceLoad(row);
  }

  onTbankTokenCancelled(): void {
    this.tbankTokenDialogOpen = false;
    const row = this.pendingPriceLoadRow;
    this.pendingPriceLoadRow = null;
    if (row) this.beginPriceLoad(row);
  }

  private beginPriceLoad(row: SecurityRow): void {
    if (!this.timeframeId || this.isPriceLoadActive(row.id)) return;

    this.loadAbort.set(row.id, true);
    this.emptyChunks.set(row.id, 0);
    this.priceLoads.set(row.id, {
      active: true,
      message: 'Загрузка с сегодня назад…',
      error: null,
    });

    const today = this.todayDate();
    this.loadNextChunk(row.id, today, 0);
  }

  stopLoadPrices(row: SecurityRow, event: Event): void {
    event.stopPropagation();
    this.loadAbort.set(row.id, false);
    const prev = this.priceLoadState(row.id);
    this.priceLoads.set(row.id, {
      active: false,
      message: 'Остановлено пользователем',
      error: prev.error,
    });
  }

  private loadNextChunk(
    securityId: number,
    cursorTo: Date,
    daysBack: number
  ): void {
    if (!this.loadAbort.get(securityId) || !this.timeframeId) {
      this.finishPriceLoad(securityId, 'Остановлено');
      return;
    }
    if (daysBack >= this.maxDaysBack) {
      this.finishPriceLoad(securityId, 'Достигнут предел истории (3 года)');
      return;
    }

    const dateTo = this.formatDate(cursorTo);
    const dateFromDate = new Date(cursorTo);
    dateFromDate.setDate(dateFromDate.getDate() - this.chunkDays);
    const dateFrom = this.formatDate(dateFromDate);

    this.securities
      .loadPrices({
        security_id: securityId,
        timeframe_id: this.timeframeId!,
        date_from: dateFrom,
        date_to: dateTo,
      })
      .subscribe({
        next: (res) => {
          if (!this.loadAbort.get(securityId)) {
            this.finishPriceLoad(securityId, 'Остановлено');
            return;
          }

          this.priceLoads.set(securityId, {
            active: true,
            message: this.formatLoadMessage(res, dateFrom, dateTo),
            error: null,
          });

          if ((res.records_loaded ?? 0) === 0 && res.candles === 0) {
            const streak = (this.emptyChunks.get(securityId) ?? 0) + 1;
            this.emptyChunks.set(securityId, streak);
            if (streak >= this.maxEmptyChunks) {
              const hint =
                res.tbank?.error || res.moex?.error
                  ? ` ${res.tbank?.error || res.moex?.error}`
                  : '';
              this.finishPriceLoad(
                securityId,
                `Нет данных за ${streak} периодов подряд — остановлено${hint}`
              );
              return;
            }
          } else {
            this.emptyChunks.set(securityId, 0);
          }

          if (this.expandedSecurities.has(securityId)) {
            this.loadChart(securityId, false);
          }

          const nextCursor = new Date(dateFromDate);
          nextCursor.setDate(nextCursor.getDate() - 1);
          this.loadNextChunk(securityId, nextCursor, daysBack + this.chunkDays);
        },
        error: (err) => {
          this.loadAbort.set(securityId, false);
          const msg =
            err?.name === 'TimeoutError'
              ? 'Таймаут загрузки (PostgreSQL/API). Перезапустите Start.bat или проверьте блокировки в БД.'
              : err?.error?.error ||
                err?.message ||
                'Ошибка загрузки цен (T-Bank / MOEX)';
          this.priceLoads.set(securityId, {
            active: false,
            message: null,
            error: msg,
          });
        },
      });
  }

  private finishPriceLoad(securityId: number, message: string): void {
    this.loadAbort.set(securityId, false);
    const prev = this.priceLoadState(securityId);
    this.priceLoads.set(securityId, {
      active: false,
      message,
      error: prev.error,
    });
  }

  private todayDate(): Date {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  private formatDate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private loadMeta(): void {
    this.loading = true;
    forkJoin({
      exchanges: this.refs.getExchanges(),
      timeframes: this.securities.getTimeframes(),
      indicators: this.refs.getIndicators(true),
    }).subscribe({
      next: ({ exchanges, timeframes, indicators }) => {
        this.exchanges = exchanges;
        this.timeframes = timeframes;
        this.indicatorsById = new Map(indicators.map((i) => [i.id, i]));
        for (const ind of indicators) {
          if (ind.is_custom && ind.formula) {
            this.priceScaleOverlayCodes.add(ind.code);
          }
        }
        this.exchangeId =
          exchanges.find((e) => e.name === 'MOEX')?.id ?? exchanges[0]?.id ?? null;
        const m15 = timeframes.find((t) => t.tf === 'M15');
        this.timeframeId = m15?.id ?? timeframes[0]?.id ?? null;
        this.loadSecurities();
      },
      error: (err) => {
        this.loading = false;
        this.error = logicsLoadErrorMessage(this.appConfig.apiUrl, err);
      },
    });
  }

  private loadSecurities(): void {
    if (!this.exchangeId) {
      this.loading = false;
      return;
    }
    this.loading = true;
    forkJoin({
      stocks: this.securities.getSecurities(this.exchangeId, 'stock'),
      futures: this.securities.getSecurities(this.exchangeId, 'futures'),
    }).subscribe({
      next: ({ stocks, futures }) => {
        this.stocks = stocks;
        this.futures = futures;
        this.loading = false;
        this.error = null;
      },
      error: (err) => {
        this.loading = false;
        this.error = logicsLoadErrorMessage(this.appConfig.apiUrl, err);
      },
    });
  }

  private loadChart(
    securityId: number,
    older: boolean,
    opts?: { fullIndicatorRefresh?: boolean; skipIndicatorSync?: boolean }
  ): void {
    if (!this.timeframeId) return;
    const prev = this.chartState(securityId);
    const before =
      older && prev.candles.length > 0 ? prev.candles[0].dt : undefined;

    if (!older) {
      this.lastSyncedEndDt.delete(securityId);
    }

    this.charts.set(securityId, {
      ...prev,
      loading: !older,
      loadingOlder: older,
      error: null,
    });

    const loadSpan = this.techLog.start(
      this.techLog.newTraceId(securityId),
      this.techLog.threadKey(
        securityId,
        this.indicatorSyncGen.get(securityId) ?? undefined,
        older ? 'loadOlder' : 'loadChart'
      ),
      older ? 'chart.loadOlder' : 'chart.load',
      {
        securityId,
        timeframeId: this.timeframeId,
        syncGen: this.indicatorSyncGen.get(securityId),
        message: older ? before ?? 'older' : 'expand/initial',
        payload: { before: before ?? null, older },
      }
    );

    this.securities
      .getPrices(securityId, this.timeframeId, 120, before)
      .subscribe({
        next: (rows: PriceCandle[]) => {
          const merged = older ? [...rows, ...prev.candles] : rows;
          const dedup = this.dedupeCandles(merged);
          this.charts.set(securityId, {
            candles: dedup,
            loading: false,
            loadingOlder: false,
            hasMore: rows.length >= 120,
            error:
              dedup.length === 0
                ? 'Нет свечей — нажмите «Загрузить цены»'
                : null,
          });
          this.techLog.end(loadSpan, {
            message: older ? 'loadOlder done' : 'loadChart done',
            payload: { added: rows.length, total: dedup.length },
          });
          const expandGate = this.expandIndicatorGate.get(securityId);
          if (expandGate) {
            expandGate.candlesReady = true;
            this.expandIndicatorGate.set(securityId, expandGate);
            this.tryExpandIndicatorSync(securityId);
          } else if (dedup.length > 0 && !opts?.skipIndicatorSync) {
            const range =
              this.lastVisibleRange.get(securityId) ??
              this.candleRange(dedup);
            if (range) {
              const pendingGen = this.indicatorSyncGen.get(securityId);
              if (
                pendingGen !== undefined &&
                this.suppressIndicatorDraw.get(securityId)
              ) {
                this.scheduleIndicatorRangeSync(securityId, range, pendingGen);
              } else {
                this.syncIndicatorsForRange(securityId, range, {
                  incremental: !opts?.fullIndicatorRefresh,
                });
              }
            }
          } else if (dedup.length === 0) {
            this.indicatorSeries.set(securityId, []);
          }
        },
        error: (err) => {
          this.techLog.end(loadSpan, {
            message: 'loadOlder error',
            payload: { error: err?.message ?? String(err) },
          });
          this.charts.set(securityId, {
            ...prev,
            loading: false,
            loadingOlder: false,
            error: err?.error?.error || err?.message || 'Ошибка загрузки цен',
          });
        },
      });
  }

  private formatLoadMessage(
    res: PriceLoadResult,
    dateFrom: string,
    dateTo: string
  ): string {
    const parts: string[] = [];
    if (res.tbank) {
      const tb = `T-Bank: ${res.tbank.records ?? 0}`;
      parts.push(res.tbank.error ? `${tb} (${res.tbank.error})` : tb);
    }
    if (res.moex) {
      const mx = `MOEX: ${res.moex.records ?? 0}`;
      parts.push(res.moex.error ? `${mx} (${res.moex.error})` : mx);
    }
    const detail = parts.length > 0 ? parts.join(' · ') : res.source;
    const contracts =
      res.contracts?.length
        ? ` · контр.: ${res.contracts.map((c) => c.prefix).join(', ')}`
        : '';
    return `${dateFrom} — ${dateTo}: +${res.candles} свечей [${detail}]${contracts}`;
  }

  private dedupeCandles(candles: PriceCandle[]): PriceCandle[] {
    const map = new Map<string, PriceCandle>();
    for (const c of candles) {
      map.set(c.dt, c);
    }
    return [...map.values()].sort(
      (a, b) => new Date(a.dt).getTime() - new Date(b.dt).getTime()
    );
  }

  private syncIndicatorsForRange(
    securityId: number,
    range: ChartVisibleRange,
    opts?: { incremental?: boolean; syncGen?: number }
  ): void {
    const candles = this.chartState(securityId).candles;
    if (!this.timeframeId || candles.length === 0) {
      this.indicatorsLoading.delete(securityId);
      this.indicatorSeries.set(securityId, []);
      this.indicatorCalcError.set(securityId, null);
      return;
    }
    const assigned = this.securityIndicatorSeries.get(securityId) ?? [];
    if (assigned.length === 0) {
      this.indicatorsLoading.delete(securityId);
      this.indicatorSeries.set(securityId, []);
      this.indicatorCalcError.set(securityId, null);
      return;
    }

    if (this.isAssignBusy(securityId) && opts?.syncGen == null) {
      this.deferredRangeSync.set(securityId, range);
      this.logSyncEvent(
        securityId,
        this.assignMergeSyncGen.get(securityId),
        'indicator.sync.deferred',
        'full sync during assign queue',
        { startDt: range.startDt, endDt: range.endDt, count: range.count }
      );
      return;
    }

    const pointCount = Math.min(
      Math.max(range.count, 1),
      this.maxIndicatorCandles
    );
    const prevEnd = this.lastSyncedEndDt.get(securityId);
    const movedLeft = prevEnd != null && range.endDt < prevEnd;
    const incremental = opts?.incremental !== false && !movedLeft;
    const syncGen = opts?.syncGen ?? this.bumpSyncGen(securityId, 'rangeSync');
    this.logSyncEvent(
      securityId,
      syncGen,
      'indicator.sync.params',
      movedLeft ? 'incremental=false (pan left)' : `incremental=${incremental}`,
      { prevEnd: prevEnd ?? null, endDt: range.endDt, movedLeft }
    );

    this.pendingSyncPointCount.set(securityId, pointCount);
    this.indicatorsLoading.delete(securityId);
    this.runAsyncIndicatorSync(securityId, {
      message: 'Расчёт индикаторов…',
      seriesRows: assigned,
      range: {
        ...range,
        count: pointCount,
      },
      incremental,
      mergeOnly: false,
      syncGen,
    });
    this.lastSyncedEndDt.set(securityId, range.endDt);
    this.setIndicatorSyncDebug(
      securityId,
      `POST async sync: indicators=${assigned.length}, point_count=${pointCount}, gen=${syncGen}`
    );
  }

  private buildChartSeries(
    values: IndicatorValueRow[],
    assigned: SecurityIndicatorSeriesRow[]
  ): ChartIndicatorSeries[] {
    const orderMap = new Map<string, number>();
    assigned.forEach((a, idx) =>
      orderMap.set(`${a.indicator_id}:${a.series_code}`, idx)
    );
    const groups = new Map<string, IndicatorValueRow[]>();
    for (const v of values) {
      const key = `${v.indicator_id}:${v.line_code}`;
      const list = groups.get(key) ?? [];
      list.push(v);
      groups.set(key, list);
    }

    const series: ChartIndicatorSeries[] = [];
    let colorIdx = 0;
    const sortedKeys = [...groups.keys()].sort((a, b) => {
      return (orderMap.get(a) ?? 0) - (orderMap.get(b) ?? 0);
    });

    for (const key of sortedKeys) {
      const rows = groups.get(key)!;
      const sample = rows[0];
      const onPrice = this.isPriceScaleSeries(
        sample.indicator_code,
        sample.line_code
      );
      series.push({
        indicator_code: sample.indicator_code,
        line_code: sample.line_code,
        line_name: sample.line_name,
        color: this.seriesColors[colorIdx % this.seriesColors.length],
        on_price_scale: onPrice,
        is_threshold: sample.is_threshold,
        points: rows.map((r) => ({ dt: r.dt, value: Number(r.value) })),
      });
      if (!sample.is_threshold) {
        colorIdx += 1;
      }
    }
    return series;
  }

  private isPriceScaleSeries(indicatorCode: string, lineCode: string): boolean {
    if (this.priceScaleOverlayCodes.has(indicatorCode) && lineCode === 'VALUE') {
      return true;
    }
    // Канальные индикаторы (BB, LINREG, SQUARE) — линии вокруг цены (#836).
    if (['UPPER', 'MIDDLE', 'LOWER'].includes(lineCode)) {
      return true;
    }
    return false;
  }
}
