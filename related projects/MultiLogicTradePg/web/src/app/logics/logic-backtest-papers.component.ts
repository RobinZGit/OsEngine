import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  Input,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  inject,
} from '@angular/core';
import { Subscription, of } from 'rxjs';
import { catchError, finalize } from 'rxjs/operators';
import { PriceChartComponent } from '../price-chart/price-chart.component';
import { EquityCurveChartComponent } from './equity-curve-chart.component';
import { LogicBacktestRatingsComponent } from './logic-backtest-ratings.component';
import {
  ChartEquityPoint,
  ChartIndicatorSeries,
  ChartShadedRange,
  ChartStopMarker,
  ChartTradeMarker,
  ChartVisibleRange,
  IndicatorValueRow,
  PriceCandle,
} from '../models/market.model';
import { SecuritiesService } from '../services/securities.service';
import { TechLogService } from '../services/tech-log.service';
import { LogicTradeRow } from '../shared/logic-trade';
import {
  applyPaperMarkValue,
  buildEquityPoints,
  buildShadowEquityPoints,
  buildShadedDisabledRanges,
  buildStopMarkers,
  buildTradeMarkers,
  clipCandlesForBacktest,
  dtKey,
  PaperListRow,
  papersWithTrades,
  tradeDtWindow,
  tradesForSecurity,
} from './backtest-chart-overlays';

export type BacktestPaperRow = PaperListRow;

function humanizeChartLoadError(err: unknown): string {
  const e = err as { name?: string; message?: string; error?: { error?: string } };
  if (
    e?.name === 'TimeoutError' ||
    /timeout/i.test(e?.message || '') ||
    /timeout/i.test(e?.error?.error || '')
  ) {
    return 'Сервер не ответил вовремя — раскройте бумагу ещё раз';
  }
  return e?.error?.error || e?.message || 'Не удалось загрузить цены';
}

/** Дешёвый отпечаток списка сделок бумаги — early-return без build markers. */
function paperTradesFingerprint(trades: LogicTradeRow[]): string {
  if (trades.length === 0) return '0';
  const first = trades[0];
  const last = trades[trades.length - 1];
  const remHint = trades
    .filter((t) => t.side_name === 'Open')
    .reduce((s, t) => s + Number(t.remaining_qty ?? t.quantity ?? 0), 0);
  return `${trades.length}:${first.id}:${last.id}:${last.bar_dt}:${last.financial_result ?? ''}:${remHint}`;
}

interface PaperOverlays {
  markers: ChartTradeMarker[];
  stops: ChartStopMarker[];
  shaded: ChartShadedRange[];
  equity: ChartEquityPoint[];
  equityLong: ChartEquityPoint[];
  equityShort: ChartEquityPoint[];
  equityShadow: ChartEquityPoint[];
}

interface PaperChartState {
  candles: PriceCandle[];
  loading: boolean;
  loadingOlder: boolean;
  hasMore: boolean;
  error: string | null;
  status: string | null;
  focusDt: string | null;
  indicatorSeries: ChartIndicatorSeries[];
  suppressIndicators: boolean;
  syncGen: number;
  lastRangeKey: string;
  /** Индикаторы уже подгружали после первой порции свечей. */
  indicatorsBootstrapped: boolean;
}

const EMPTY_SERIES: ChartIndicatorSeries[] = [];
const SERIES_COLORS = [
  '#2563eb',
  '#9333ea',
  '#ea580c',
  '#0891b2',
  '#ca8a04',
  '#db2777',
  '#059669',
  '#4f46e5',
];
const PRICE_SCALE_CODES = new Set(['SMA', 'EMA', 'WMA', 'PACC', 'SMAT3']);
/** Первая порция на развороте — без длинной догрузки истории. */
const INITIAL_CANDLES = 120;
const MAX_CANDLES = 400;

@Component({
  selector: 'app-logic-backtest-papers',
  standalone: true,
  imports: [CommonModule, PriceChartComponent, EquityCurveChartComponent, LogicBacktestRatingsComponent],
  templateUrl: './logic-backtest-papers.component.html',
  styleUrl: './logic-backtest-papers.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogicBacktestPapersComponent implements OnChanges, OnDestroy {
  private readonly securitiesApi = inject(SecuritiesService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly techLog = inject(TechLogService);

  /** test — бэктест; live — боевые сделки (те же lazy/OnPush ограничения). */
  @Input() mode: 'test' | 'live' = 'test';
  @Input() logicId: number | null = null;
  @Input() runId: number | null = null;
  @Input() reloadToken: string | number | null = null;
  @Input() trades: LogicTradeRow[] = [];
  @Input() dateFrom: string | null = null;
  @Input() dateTo: string | null = null;
  @Input() timeframeId: number | null = null;
  @Input() signalIndicatorIds: number[] = [];
  /** Начальный депозит логики — для % у PnL бумаги. */
  @Input() initialBalance: number | null = null;
  /** Денежный фонд (TMON/LQDT/SBMM) — всегда первой строкой в списке бумаг. */
  @Input() pinnedPaper: BacktestPaperRow | null = null;

  get isLive(): boolean {
    return this.mode === 'live';
  }

  expandedPapers = false;
  /** Режим разворота: свечной график или эквити. */
  chartMode: 'price' | 'equity' = 'price';
  expandedSecurityIds = new Set<number>();
  /** Инкремент при готовности графика — чтобы OnPush/@if точно перерисовались. */
  chartTick = 0;

  paperRows: BacktestPaperRow[] = [];
  private overlaysBySec = new Map<number, PaperOverlays>();
  private overlayFingerprintBySec = new Map<number, string>();
  private charts = new Map<number, PaperChartState>();
  private rangeTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private chartLoadSubs = new Map<number, Subscription>();
  private subs = new Subscription();
  private markPriceSubs = new Subscription();
  private uniqueIndicatorIds: number[] = [];

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['signalIndicatorIds']) {
      this.uniqueIndicatorIds = [
        ...new Set(this.signalIndicatorIds.filter((id) => id != null).map(Number)),
      ];
    }
    const periodChanged =
      !!changes['dateFrom'] || !!changes['dateTo'] || !!changes['runId'];
    if (changes['trades'] || periodChanged || changes['pinnedPaper']) {
      this.rebuildPaperCache({ reloadCharts: periodChanged });
    } else if (changes['reloadToken'] && this.expandedPapers) {
      // Бой: poll обновляет token — подтянуть текущие цены для «сум.» / «цена».
      this.refreshOpenMarkValues();
    }
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.markPriceSubs.unsubscribe();
    for (const t of this.rangeTimers.values()) clearTimeout(t);
  }

  togglePapersBlock(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.expandedPapers = !this.expandedPapers;
    if (this.expandedPapers && this.paperRows.length === 0) {
      this.rebuildPaperCache({ reloadCharts: false });
    } else if (this.expandedPapers) {
      this.refreshOpenMarkValues();
    }
  }

  isPaperExpanded(securityId: number): boolean {
    return this.expandedSecurityIds.has(securityId);
  }

  togglePaper(event: Event, securityId: number): void {
    event.preventDefault();
    event.stopPropagation();
    if (this.expandedSecurityIds.has(securityId)) {
      this.expandedSecurityIds.delete(securityId);
      this.cancelChartLoad(securityId);
      const st = this.charts.get(securityId);
      if (st) {
        st.loading = false;
        st.loadingOlder = false;
      }
      this.techLog.event(
        this.techLog.logicThreadKey(this.logicId ?? 0, 'paper'),
        'paper.collapse',
        `Свернули бумагу sec=${securityId}`,
        { logicId: this.logicId ?? undefined, securityId }
      );
      this.cdr.markForCheck();
      return;
    }
    this.expandedSecurityIds.add(securityId);
    // Сбросить залипший loading от прошлого разворота — иначе ensureChartLoaded сразу return.
    this.cancelChartLoad(securityId);
    {
      const st = this.chartState(securityId);
      st.loading = false;
      st.loadingOlder = false;
      st.error = null;
      st.status = 'Загрузка графика…';
      if (st.candles.length === 0) {
        st.indicatorsBootstrapped = false;
        st.lastRangeKey = '';
      }
    }
    this.techLog.event(
      this.techLog.logicThreadKey(this.logicId ?? 0, 'paper'),
      'paper.expand',
      `Раскрыли бумагу sec=${securityId}`,
      {
        logicId: this.logicId ?? undefined,
        securityId,
        force: true,
        payload: {
          run_id: this.runId,
          candles: this.charts.get(securityId)?.candles.length ?? 0,
        },
      }
    );
    this.chartTick++;
    this.cdr.detectChanges();
    setTimeout(() => this.ensureChartLoaded(securityId), 0);
  }

  /** Есть свечи — для @if (OnPush стабильнее, чем читать Map в шаблоне много раз). */
  hasChartCandles(securityId: number): boolean {
    return (this.charts.get(securityId)?.candles.length ?? 0) > 0;
  }

  isChartLoading(securityId: number): boolean {
    const st = this.charts.get(securityId);
    return !!st && st.loading && st.candles.length === 0;
  }

  private cancelChartLoad(securityId: number): void {
    const prev = this.chartLoadSubs.get(securityId);
    if (prev) {
      prev.unsubscribe();
      this.chartLoadSubs.delete(securityId);
    }
  }

  private bumpChartView(): void {
    this.chartTick++;
    this.cdr.markForCheck();
    this.cdr.detectChanges();
  }

  chartState(securityId: number): PaperChartState {
    let st = this.charts.get(securityId);
    if (!st) {
      st = {
        candles: [],
        loading: false,
        loadingOlder: false,
        hasMore: true,
        error: null,
        status: null,
        focusDt: null,
        indicatorSeries: [],
        suppressIndicators: false,
        syncGen: 0,
        lastRangeKey: '',
        indicatorsBootstrapped: false,
      };
      this.charts.set(securityId, st);
    }
    return st;
  }

  chartIndicatorsForDisplay(securityId: number): ChartIndicatorSeries[] {
    const st = this.chartState(securityId);
    if (st.suppressIndicators) return EMPTY_SERIES;
    return st.indicatorSeries;
  }

  overlays(securityId: number): PaperOverlays {
    let o = this.overlaysBySec.get(securityId);
    if (!o) {
      o = {
        markers: [],
        stops: [],
        shaded: [],
        equity: [],
        equityLong: [],
        equityShort: [],
        equityShadow: [],
      };
      this.overlaysBySec.set(securityId, o);
    }
    return o;
  }

  setChartMode(mode: 'price' | 'equity', event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    this.chartMode = mode;
    this.cdr.markForCheck();
  }

  paperPnlPct(pnl: number): number | null {
    const initial = Number(this.initialBalance);
    if (!Number.isFinite(initial) || initial <= 0) return null;
    return (pnl / initial) * 100;
  }

  formatPnlPct(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    const n = Number(value);
    const sign = n > 0 ? '+' : n < 0 ? '−' : '';
    return `${sign}${Math.abs(n).toFixed(2)}%`;
  }

  formatPnl(value: number): string {
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(2)}`;
  }

  formatMoney(value: number | null | undefined): string {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0.00';
    return n.toFixed(2);
  }

  formatOpenQty(value: number | null | undefined): string {
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return '0';
    const sign = n > 0 ? '+' : '−';
    const abs = Math.abs(n);
    const text = Number.isInteger(abs) ? String(abs) : abs.toFixed(4).replace(/\.?0+$/, '');
    return `${sign}${text}`;
  }

  onLoadOlder(securityId: number): void {
    const tfId = this.resolveTimeframeId(securityId);
    const st = this.chartState(securityId);
    if (!tfId || st.loadingOlder || !st.hasMore || st.candles.length === 0) return;
    const before = st.candles[0].dt;
    st.loadingOlder = true;
    // Timeout/сеть — тихо; не пишем на график и не режем hasMore.
    let softFail = false;
    const sub = this.securitiesApi
      .getPrices(securityId, tfId, INITIAL_CANDLES, before)
      .pipe(
        catchError(() => {
          softFail = true;
          return of([] as PriceCandle[]);
        }),
        finalize(() => {
          st.loadingOlder = false;
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: (rows) => {
          if (rows.length === 0) {
            if (!softFail) st.hasMore = false;
            return;
          }
          const merged = [...rows, ...st.candles];
          st.candles = merged.length > MAX_CANDLES ? merged.slice(-MAX_CANDLES) : merged;
          // Маркеры / PnL / стопы — из кэша overlays, перерисуются со свечами.
          this.cdr.detectChanges();
        },
      });
    this.subs.add(sub);
  }

  onVisibleRange(securityId: number, range: ChartVisibleRange): void {
    // Только жест пользователя (pan); auto-emit при mount отключён.
    if (!range.userInitiated) {
      return;
    }
    const st = this.chartState(securityId);
    st.suppressIndicators = true;
    this.cdr.detectChanges();
    const prev = this.rangeTimers.get(securityId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => this.loadIndicatorValues(securityId, range), 650);
    this.rangeTimers.set(securityId, timer);
  }

  private resolveTimeframeId(securityId: number): number | null {
    if (this.timeframeId != null && Number.isFinite(Number(this.timeframeId))) {
      return Number(this.timeframeId);
    }
    const fromTrade = this.trades.find((t) => t.security_id === securityId)?.timeframe_id;
    if (fromTrade != null && Number.isFinite(Number(fromTrade))) {
      return Number(fromTrade);
    }
    const any = this.trades.find((t) => t.timeframe_id != null)?.timeframe_id;
    return any != null ? Number(any) : null;
  }

  private rebuildPaperCache(opts: { reloadCharts: boolean } = { reloadCharts: false }): void {
    this.paperRows = papersWithTrades(
      this.trades,
      this.dateFrom,
      this.dateTo,
      this.pinnedPaper
    );
    if (this.expandedPapers) {
      this.refreshOpenMarkValues();
    }
    for (const paper of this.paperRows) {
      const secTrades = tradesForSecurity(
        this.trades,
        paper.security_id,
        this.dateFrom,
        this.dateTo
      );
      const fingerprint = paperTradesFingerprint(secTrades);
      const prevFp = this.overlayFingerprintBySec.get(paper.security_id);
      const prev = this.overlaysBySec.get(paper.security_id);
      if (prev && prevFp === fingerprint && !opts.reloadCharts) {
        continue;
      }
      const next = {
        markers: buildTradeMarkers(secTrades),
        stops: buildStopMarkers(secTrades),
        shaded: buildShadedDisabledRanges(secTrades, this.dateFrom, this.dateTo),
        equity: buildEquityPoints(secTrades, this.dateFrom),
        equityLong: buildEquityPoints(secTrades, this.dateFrom, 'long'),
        equityShort: buildEquityPoints(secTrades, this.dateFrom, 'short'),
        equityShadow: buildShadowEquityPoints(secTrades, this.dateFrom),
      };
      this.overlayFingerprintBySec.set(paper.security_id, fingerprint);
      // Poll ~2с не должен подменять ссылки overlays → лишний redraw / ResizeObserver.
      if (
        prev &&
        prev.markers.length === next.markers.length &&
        prev.stops.length === next.stops.length &&
        prev.shaded.length === next.shaded.length &&
        prev.equity.length === next.equity.length &&
        prev.equityLong.length === next.equityLong.length &&
        prev.equityShort.length === next.equityShort.length &&
        prev.equityShadow.length === next.equityShadow.length &&
        prevFp === fingerprint
      ) {
        continue;
      }
      this.overlaysBySec.set(paper.security_id, next);
    }
    // Во время прогона poll обновляет trades каждые ~2с — график не сбрасываем,
    // иначе UI «зависает», а тест выглядит остановленным.
    for (const securityId of this.expandedSecurityIds) {
      const st = this.charts.get(securityId);
      if (!st) continue;
      if (opts.reloadCharts) {
        st.candles = [];
        st.indicatorSeries = EMPTY_SERIES;
        st.lastRangeKey = '';
        st.focusDt = null;
        st.error = null;
        st.loading = false;
        st.indicatorsBootstrapped = false;
        this.ensureChartLoaded(securityId);
        continue;
      }
      // Обновить статус-строку по новым маркерам без повторного HTTP
      if (st.candles.length > 0 && !st.loading) {
        const ov = this.overlays(securityId);
        st.status = `${st.candles.length} свечей · сделок: ${ov.markers.length} · стопов: ${ov.stops.length}`;
      }
    }
  }

  /** Подтянуть close свечи периода/рынка → «в портф.» = |ост.| × цена. */
  private refreshOpenMarkValues(): void {
    this.markPriceSubs.unsubscribe();
    this.markPriceSubs = new Subscription();
    const before = this.markPriceBeforeExclusive();
    for (const paper of this.paperRows) {
      if (paper.open_qty === 0) continue;
      const secId = paper.security_id;
      const tfId = this.resolveTimeframeId(secId);
      if (tfId == null) continue;
      const sub = this.securitiesApi
        .getPrices(secId, tfId, 1, before ?? undefined)
        .pipe(catchError(() => of([] as PriceCandle[])))
        .subscribe((candles) => {
          const px = Number(candles[candles.length - 1]?.close_price);
          if (!Number.isFinite(px) || px <= 0) return;
          const row = this.paperRows.find((r) => r.security_id === secId);
          if (!row || row.open_qty === 0) return;
          applyPaperMarkValue(row, px);
          this.cdr.markForCheck();
        });
      this.markPriceSubs.add(sub);
    }
  }

  /** Upper bound for GET /prices (dt < before): конец периода теста или null (live/latest). */
  private markPriceBeforeExclusive(): string | null {
    if (!this.isLive && this.dateTo) {
      const day = String(this.dateTo).trim().slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        const d = new Date(`${day}T00:00:00.000Z`);
        if (!Number.isNaN(d.getTime())) {
          d.setUTCDate(d.getUTCDate() + 1);
          return `${d.toISOString().slice(0, 10)} 00:00:00`;
        }
      }
    }
    return null;
  }

  private ensureChartLoaded(securityId: number): void {
    const st = this.chartState(securityId);
    const tfId = this.resolveTimeframeId(securityId);
    const t0 = performance.now();
    this.techLog.event(
      this.techLog.logicThreadKey(this.logicId ?? 0, 'paper'),
      'chart.load.start',
      `Старт загрузки графика sec=${securityId} tf=${tfId ?? 'null'}`,
      {
        logicId: this.logicId ?? undefined,
        securityId,
        force: true,
        payload: { tfId, run_id: this.runId },
      }
    );
    if (!tfId) {
      st.error = 'Не задан таймфрейм логики (и нет timeframe_id в сделках)';
      st.status = null;
      st.loading = false;
      this.bumpChartView();
      return;
    }
    // Уже показали свечи — не перезапрашиваем.
    if (st.candles.length > 0) {
      st.loading = false;
      this.bumpChartView();
      return;
    }

    const secTrades = tradesForSecurity(
      this.trades,
      securityId,
      this.dateFrom,
      this.dateTo
    );
    const win = tradeDtWindow(secTrades);
    // Якорь before — конец сделок, не date_to теста (иначе пустой ответ / лишний retry).
    const coverTo = win?.to ?? this.periodCoverTo(null);
    const before = coverTo ? coverTo.replace(' ', 'T') : undefined;
    st.focusDt = win?.from ?? this.dateFrom ?? null;
    const coverFrom = this.periodCoverFrom(win?.from ?? null);

    this.cancelChartLoad(securityId);
    st.loading = true;
    st.error = null;
    st.status = win
      ? `Загрузка свечей ${win.from.slice(0, 10)}…${win.to.slice(0, 10)}`
      : `Загрузка свечей (tf=${tfId})…`;
    this.bumpChartView();

    const sub = this.securitiesApi
      .getPrices(securityId, tfId, INITIAL_CANDLES, before)
      .pipe(
        catchError((err) => {
          st.error = humanizeChartLoadError(err);
          st.loading = false;
          this.techLog.event(
            this.techLog.logicThreadKey(this.logicId ?? 0, 'paper'),
            'chart.load.error',
            st.error || 'error',
            {
              logicId: this.logicId ?? undefined,
              securityId,
              force: true,
              payload: { ms: Math.round(performance.now() - t0) },
            }
          );
          this.bumpChartView();
          return of([] as PriceCandle[]);
        })
      )
      .subscribe({
        next: (rows) => {
          this.techLog.event(
            this.techLog.logicThreadKey(this.logicId ?? 0, 'paper'),
            'chart.load.prices',
            `Получено ${rows.length} свечей`,
            {
              logicId: this.logicId ?? undefined,
              securityId,
              force: true,
              payload: {
                n: rows.length,
                ms: Math.round(performance.now() - t0),
                before: before ?? null,
              },
            }
          );
          if (rows.length === 0 && before) {
            st.status = 'Повторная загрузка свечей без фильтра даты…';
            this.bumpChartView();
            const retry = this.securitiesApi
              .getPrices(securityId, tfId, INITIAL_CANDLES)
              .subscribe({
                next: (retryRows) =>
                  this.finishCandleLoad(
                    securityId,
                    st,
                    retryRows,
                    coverFrom,
                    coverTo,
                    win,
                    t0
                  ),
                error: (err) => {
                  st.loading = false;
                  st.error = humanizeChartLoadError(err);
                  st.status = null;
                  this.bumpChartView();
                },
              });
            this.chartLoadSubs.set(securityId, retry);
            this.subs.add(retry);
            return;
          }
          this.finishCandleLoad(securityId, st, rows, coverFrom, coverTo, win, t0);
        },
        error: () => {
          st.loading = false;
          this.bumpChartView();
        },
      });
    this.chartLoadSubs.set(securityId, sub);
    this.subs.add(sub);
  }

  /** Начало покрытия свечей: первая сделка (не весь date_from теста — иначе десятки HTTP). */
  private periodCoverFrom(firstTradeDt: string | null): string | null {
    return firstTradeDt;
  }

  /** Конец покрытия: date_to или последняя сделка. */
  private periodCoverTo(lastTradeDt: string | null): string | null {
    if (this.dateTo) {
      const d = String(this.dateTo).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return `${d} 23:59:59`;
      return d;
    }
    return lastTradeDt;
  }

  /** Показать первую порцию свечей; длинную догрузку не запускаем (она подвешивала UI). */
  private finishCandleLoad(
    securityId: number,
    st: PaperChartState,
    rows: PriceCandle[],
    coverFrom: string | null,
    coverTo: string | null,
    win: { from: string; to: string } | null,
    t0: number
  ): void {
    if (rows.length === 0) {
      st.loading = false;
      st.error = st.error || 'В БД нет свечей для этой бумаги / таймфрейма';
      st.status = null;
      this.bumpChartView();
      return;
    }

    this.applyCandles(securityId, st, rows, coverFrom, coverTo, win, {
      loadIndicators: false,
    });
    this.techLog.event(
      this.techLog.logicThreadKey(this.logicId ?? 0, 'paper'),
      'chart.load.done',
      `График готов: ${st.candles.length} свечей`,
      {
        logicId: this.logicId ?? undefined,
        securityId,
        force: true,
        payload: {
          candles: st.candles.length,
          ms: Math.round(performance.now() - t0),
          chartTick: this.chartTick,
        },
      }
    );
    // Индикаторы не грузим автоматически при развороте — только по жесту pan (userInitiated).
    // Авто-GET + redraw + ResizeObserver подвешивали UI (нельзя свернуть бумагу).
  }

  private applyCandles(
    securityId: number,
    st: PaperChartState,
    rows: PriceCandle[],
    coverFrom: string | null,
    coverTo: string | null,
    win: { from: string; to: string } | null,
    opts: { loadIndicators: boolean } = { loadIndicators: false }
  ): void {
    const clipped = clipCandlesForBacktest(rows, {
      coverFrom,
      coverTo,
      tradeFrom: win?.from ?? null,
      tradeTo: win?.to ?? null,
      maxCandles: MAX_CANDLES,
    });
    st.candles = clipped;
    st.hasMore = rows.length >= INITIAL_CANDLES - 5;
    st.loading = false;
    st.loadingOlder = false;
    const ov = this.overlays(securityId);
    st.error = clipped.length === 0 ? 'В БД нет свечей для этой бумаги / таймфрейма' : null;
    st.status =
      clipped.length > 0
        ? `${clipped.length} свечей · сделок: ${ov.markers.length} · стопов: ${ov.stops.length}`
        : null;
    if (!st.focusDt && ov.markers.length > 0) {
      st.focusDt = ov.markers[0].dt;
    }
    this.charts.set(securityId, st);
    this.bumpChartView();
    if (opts.loadIndicators && clipped.length > 0 && !st.indicatorsBootstrapped) {
      st.indicatorsBootstrapped = true;
      const n = Math.min(clipped.length, 80);
      const startIdx = Math.max(
        0,
        clipped.findIndex((c) => dtKey(c.dt) >= dtKey(st.focusDt || clipped[0].dt)) - 10
      );
      const endIdx = Math.min(clipped.length - 1, startIdx + n - 1);
      this.loadIndicatorValues(securityId, {
        startDt: clipped[Math.max(0, startIdx)].dt,
        endDt: clipped[endIdx].dt,
        count: endIdx - Math.max(0, startIdx) + 1,
        viewStart: Math.max(0, startIdx),
        userInitiated: false,
      });
    }
  }

  /** Только GET indicator-values — без sync POST (не блокируем UI). */
  private loadIndicatorValues(securityId: number, range: ChartVisibleRange): void {
    const tfId = this.resolveTimeframeId(securityId);
    if (!tfId || this.uniqueIndicatorIds.length === 0) {
      const st = this.chartState(securityId);
      st.suppressIndicators = false;
      st.indicatorSeries = EMPTY_SERIES;
      return;
    }
    if (!range.startDt || !range.endDt) return;
    const st = this.chartState(securityId);
    if (st.candles.length === 0) return;

    const rangeKey = `${range.startDt}|${range.endDt}|${this.uniqueIndicatorIds.join(',')}`;
    if (rangeKey === st.lastRangeKey && st.indicatorSeries.length > 0 && !range.userInitiated) {
      st.suppressIndicators = false;
      return;
    }

    const syncGen = ++st.syncGen;
    const approxLines = Math.max(2, this.uniqueIndicatorIds.length * 3);
    const rowBudget = Math.min(4000, Math.max(400, (range.count || 120) * approxLines));
    const sub = this.securitiesApi
      .getIndicatorValues(
        securityId,
        tfId,
        this.uniqueIndicatorIds,
        range.startDt,
        range.endDt,
        rowBudget
      )
      .pipe(
        // Timeout при перемотке — тихо, без баннера на графике
        catchError(() => of([] as IndicatorValueRow[]))
      )
      .subscribe({
        next: (values) => {
          if (syncGen !== st.syncGen) return;
          if (values.length > 0) {
            st.indicatorSeries = this.buildChartSeries(values);
            st.lastRangeKey = rangeKey;
          }
          st.suppressIndicators = false;
          this.bumpChartView();
        },
      });
    this.subs.add(sub);
  }

  private buildChartSeries(values: IndicatorValueRow[]): ChartIndicatorSeries[] {
    const groups = new Map<string, IndicatorValueRow[]>();
    for (const v of values) {
      if (!this.uniqueIndicatorIds.includes(v.indicator_id)) continue;
      const key = `${v.indicator_id}:${v.line_code}`;
      const list = groups.get(key) ?? [];
      list.push(v);
      groups.set(key, list);
    }
    const series: ChartIndicatorSeries[] = [];
    let colorIdx = 0;
    for (const key of groups.keys()) {
      const rows = groups.get(key)!;
      const sample = rows[0];
      const onPrice =
        (PRICE_SCALE_CODES.has(sample.indicator_code) && sample.line_code === 'VALUE') ||
        (sample.indicator_code === 'BB' &&
          ['UPPER', 'MIDDLE', 'LOWER'].includes(sample.line_code));
      series.push({
        indicator_code: sample.indicator_code,
        line_code: sample.line_code,
        line_name: sample.line_name,
        color: SERIES_COLORS[colorIdx % SERIES_COLORS.length],
        on_price_scale: onPrice,
        is_threshold: sample.is_threshold,
        points: rows.map((r) => ({ dt: r.dt, value: Number(r.value) })),
      });
      if (!sample.is_threshold) colorIdx += 1;
    }
    return series;
  }
}
