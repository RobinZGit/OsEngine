import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  ChartEquityPoint,
  ChartIndicatorSeries,
  ChartShadedRange,
  ChartStopMarker,
  ChartTradeMarker,
  ChartVisibleRange,
  PriceCandle,
} from '../models/market.model';
import { TechLogService } from '../services/tech-log.service';

@Component({
  selector: 'app-price-chart',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './price-chart.component.html',
  styleUrl: './price-chart.component.css',
})
export class PriceChartComponent implements AfterViewInit, OnChanges, OnDestroy {
  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('chartBody') chartBodyRef!: ElementRef<HTMLDivElement>;

  @Input() candles: PriceCandle[] = [];
  @Input() indicatorSeries: ChartIndicatorSeries[] = [];
  /** Маркеры входов/выходов (бэктест). */
  @Input() tradeMarkers: ChartTradeMarker[] = [];
  /** Линии стоп-лосс / тейк-профит с подписью типа. */
  @Input() stopMarkers: ChartStopMarker[] = [];
  /** Периоды отключения бумаги (blur/shade). */
  @Input() shadedRanges: ChartShadedRange[] = [];
  /** Кумулятивный PnL по бумаге (отдельная панель под ценой). */
  @Input() equityPoints: ChartEquityPoint[] = [];
  /**
   * Прокрутить окно так, чтобы эта дата была видна.
   * Нужно для бэктеста: сделки часто не в последних 200 свечах.
   */
  @Input() focusDt: string | null = null;
  /**
   * Положение focusDt в видимом окне:
   * start ≈ 20% слева (начало сделок/теста), end ≈ 65% (как раньше).
   */
  @Input() focusAlign: 'start' | 'end' = 'end';
  @Input() loading = false;
  /** Фоновая подгрузка истории — не блокирует перемотку. */
  @Input() loadingOlder = false;
  @Input() error: string | null = null;
  @Input() title = '';
  /** Кнопка ↻ пересчёта индикаторов (на графиках бумаг теста не нужна). */
  @Input() showRecalcButton = true;
  /** Для app_tech_log (sec:N). */
  @Input() securityId: number | null = null;

  private readonly techLog = inject(TechLogService);

  @Output() loadOlder = new EventEmitter<void>();
  @Output() visibleRangeChange = new EventEmitter<ChartVisibleRange>();
  @Output() recalcIndicators = new EventEmitter<ChartVisibleRange>();

  fullscreen = false;

  private viewStart = 0;
  private readonly baseCandleWidth = 7;
  private zoom = 1;

  private dragging = false;
  private dragStartX = 0;
  private dragStartView = 0;
  private resizeObserver: ResizeObserver | null = null;
  private prevCandlesLen = 0;
  private loadOlderPending = false;
  private emitRangeTimer: ReturnType<typeof setTimeout> | null = null;
  private redrawScheduled = false;
  private redrawRafId: number | null = null;
  private seriesPointIndex = new Map<ChartIndicatorSeries, Map<string, number>>();
  private panStartedAt = 0;

  private pinchActive = false;
  private pinchStartDist = 0;
  private pinchStartZoom = 1;
  /** Последний размер тела графика — чтобы ResizeObserver не крутил бесконечный redraw. */
  private lastBodyW = -1;
  private lastBodyH = -1;
  private ignoreResizeUntil = 0;
  private resizeDebounce: ReturnType<typeof setTimeout> | null = null;

  /** Масштаб подписей осей, легенды и даты в полноэкранном режиме */
  private get labelScale(): number {
    return this.fullscreen ? 1.55 : 1;
  }

  private chartPadding(): { top: number; right: number; bottom: number; left: number } {
    const s = this.labelScale;
    return {
      top: Math.round(28 * s),
      right: 10,
      bottom: Math.round(22 * s),
      left: Math.round(52 * s),
    };
  }

  get hasTradeNav(): boolean {
    return this.tradeMarkers.length > 0;
  }

  /** Нормализация dt для сопоставления свечи и маркера. */
  private static dtKey(dt: string): string {
    return String(dt || '')
      .replace('T', ' ')
      .replace(/Z$/i, '')
      .replace(/\.\d+/, '')
      .slice(0, 19);
  }

  private px(base: number): number {
    return Math.round(base * this.labelScale);
  }

  ngAfterViewInit(): void {
    const body = this.chartBodyRef?.nativeElement;
    if (!body) return;
    this.resizeObserver = new ResizeObserver(() => {
      if (performance.now() < this.ignoreResizeUntil) return;
      const w = body.clientWidth;
      const h = body.clientHeight;
      if (w === this.lastBodyW && h === this.lastBodyH) return;
      if (this.resizeDebounce) clearTimeout(this.resizeDebounce);
      // Debounce: иначе flex/scrollbar даёт петлю resize→redraw→resize и блокирует UI.
      this.resizeDebounce = setTimeout(() => {
        this.resizeDebounce = null;
        this.scheduleRedraw();
      }, 80);
    });
    this.resizeObserver.observe(body);
    this.scheduleRedraw();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['indicatorSeries']) {
      this.rebuildSeriesPointIndex();
    }
    if (changes['candles']) {
      const added = this.candles.length - this.prevCandlesLen;
      if (added > 0 && this.prevCandlesLen > 0 && this.viewStart > 0) {
        this.viewStart += added;
      }
      this.prevCandlesLen = this.candles.length;
      this.loadOlderPending = false;
      this.clampViewStart();
      // visibleRange emit только по жесту пользователя — иначе лишние HTTP/CD.
    }
    if (
      (changes['focusDt'] || changes['candles']) &&
      this.focusDt &&
      this.candles.length > 0
    ) {
      this.scrollToFocusDt(this.focusDt);
    }
    // Poll родителя часто приносит новые ссылки на overlays — не redraw, если длина та же.
    const overlaysRefOnly =
      !changes['candles'] &&
      !changes['indicatorSeries'] &&
      !changes['loading'] &&
      !changes['loadingOlder'] &&
      !changes['error'] &&
      !changes['focusDt'] &&
      !changes['title'] &&
      this.overlayArraysSameLength(changes);
    if (overlaysRefOnly) {
      return;
    }
    const meaningful =
      changes['candles'] ||
      changes['indicatorSeries'] ||
      changes['loading'] ||
      changes['loadingOlder'] ||
      changes['error'] ||
      changes['tradeMarkers'] ||
      changes['stopMarkers'] ||
      changes['shadedRanges'] ||
      changes['equityPoints'] ||
      changes['focusDt'] ||
      changes['title'];
    if (meaningful) {
      queueMicrotask(() => this.scheduleRedraw());
      if (changes['candles'] && this.candles.length > 0) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => this.scheduleRedraw());
        });
      }
    }
  }

  private overlayArraysSameLength(changes: SimpleChanges): boolean {
    const keys = ['tradeMarkers', 'stopMarkers', 'shadedRanges', 'equityPoints'] as const;
    let saw = false;
    for (const k of keys) {
      const ch = changes[k];
      if (!ch || ch.firstChange) continue;
      saw = true;
      const prev = ch.previousValue as unknown[] | null | undefined;
      const cur = ch.currentValue as unknown[] | null | undefined;
      if ((prev?.length ?? -1) !== (cur?.length ?? -2)) return false;
    }
    return saw;
  }

  /** Сдвинуть окно так, чтобы dt была в нужной части видимой области. */
  private scrollToFocusDt(dt: string): void {
    const key = PriceChartComponent.dtKey(dt);
    let idx = -1;
    for (let i = 0; i < this.candles.length; i++) {
      if (PriceChartComponent.dtKey(this.candles[i].dt) <= key) idx = i;
      else break;
    }
    if (idx < 0) idx = 0;
    const count = this.viewCount();
    const maxStart = Math.max(0, this.candles.length - count);
    const bias = this.focusAlign === 'start' ? 0.2 : 0.65;
    this.viewStart = Math.max(0, Math.min(idx - Math.floor(count * bias), maxStart));
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    if (this.resizeDebounce) {
      clearTimeout(this.resizeDebounce);
      this.resizeDebounce = null;
    }
    if (this.redrawRafId != null) {
      cancelAnimationFrame(this.redrawRafId);
    }
    if (this.emitRangeTimer) clearTimeout(this.emitRangeTimer);
    if (this.fullscreen) {
      document.body.style.overflow = '';
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.fullscreen) this.closeFullscreen();
  }

  get candleWidth(): number {
    return Math.min(24, Math.max(3, this.baseCandleWidth * this.zoom));
  }

  openFullscreen(): void {
    this.fullscreen = true;
    document.body.style.overflow = 'hidden';
    queueMicrotask(() => {
      this.clampViewStart();
      this.scheduleRedraw();
      requestAnimationFrame(() => this.scheduleEmitVisibleRange(false));
    });
  }

  closeFullscreen(): void {
    this.fullscreen = false;
    document.body.style.overflow = '';
    queueMicrotask(() => {
      this.clampViewStart();
      this.scheduleRedraw();
      requestAnimationFrame(() => this.scheduleEmitVisibleRange(false));
    });
  }

  onRecalcClick(event: Event): void {
    event.stopPropagation();
    this.recalcIndicators.emit({
      ...this.currentVisibleRange(),
      userInitiated: true,
    });
  }

  panLeft(event: Event): void {
    event.stopPropagation();
    this.shiftView(-Math.max(5, Math.floor(this.viewCount() / 4)));
  }

  panRight(event: Event): void {
    event.stopPropagation();
    this.shiftView(Math.max(5, Math.floor(this.viewCount() / 4)));
  }

  /** Предыдущая сделка (open/close — одинаково). */
  gotoPrevTrade(event: Event): void {
    event.stopPropagation();
    const target = this.findTradeDt(-1);
    if (!target) return;
    this.scrollToFocusDt(target);
    this.scheduleRedraw();
    this.scheduleEmitVisibleRange(true);
  }

  /** Следующая сделка (open/close — одинаково). */
  gotoNextTrade(event: Event): void {
    event.stopPropagation();
    const target = this.findTradeDt(1);
    if (!target) return;
    this.scrollToFocusDt(target);
    this.scheduleRedraw();
    this.scheduleEmitVisibleRange(true);
  }

  /** Уникальные dt сделок по возрастанию. */
  private tradeNavDts(): string[] {
    const set = new Set<string>();
    for (const m of this.tradeMarkers) {
      const k = PriceChartComponent.dtKey(m.dt);
      if (k) set.add(k);
    }
    return [...set].sort();
  }

  /** direction -1 = назад, +1 = вперёд относительно центра видимого окна. */
  private findTradeDt(direction: -1 | 1): string | null {
    const dts = this.tradeNavDts();
    if (dts.length === 0 || this.candles.length === 0) return null;
    const count = this.viewCount();
    const visible = this.candles.slice(this.viewStart, this.viewStart + count);
    if (visible.length === 0) return null;
    const anchor = PriceChartComponent.dtKey(
      visible[Math.floor(visible.length * 0.65)].dt
    );
    if (direction < 0) {
      let prev: string | null = null;
      for (const d of dts) {
        if (d < anchor) prev = d;
        else break;
      }
      return prev;
    }
    for (const d of dts) {
      if (d > anchor) return d;
    }
    return null;
  }

  zoomIn(event: Event): void {
    event.stopPropagation();
    this.applyZoom(this.zoom * 1.2);
  }

  zoomOut(event: Event): void {
    event.stopPropagation();
    this.applyZoom(this.zoom / 1.2);
  }

  onWheel(event: WheelEvent): void {
    if (!this.canInteract()) return;
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    this.applyZoom(this.zoom * factor);
  }

  onPointerDown(event: PointerEvent): void {
    if (!this.canInteract()) return;
    if (this.pinchActive) return;

    this.dragging = true;
    this.panStartedAt = performance.now();
    this.dragStartX = event.clientX;
    this.dragStartView = this.viewStart;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    this.logChartEvent('chart.pan.start', 'pointer down', {
      viewStart: this.viewStart,
      candles: this.candles.length,
    });
  }

  onPointerMove(event: PointerEvent): void {
    if (this.pinchActive) return;
    if (!this.dragging) return;

    const delta = event.clientX - this.dragStartX;
    const shift = Math.round(-delta / this.candleWidth);
    const maxStart = Math.max(0, this.candles.length - this.viewCount());
    this.viewStart = Math.min(maxStart, Math.max(0, this.dragStartView + shift));

    if (this.viewStart <= 8 && !this.loadOlderPending) {
      this.loadOlderPending = true;
      this.loadOlder.emit();
    }
    this.scheduleRedraw();
  }

  onPointerUp(event: PointerEvent): void {
    const moved = this.dragging && this.viewStart !== this.dragStartView;
    const panMs = this.panStartedAt > 0 ? Math.round(performance.now() - this.panStartedAt) : 0;
    this.dragging = false;
    try {
      (event.target as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    if (moved) {
      this.logChartEvent('chart.pan.end', `shift ${this.viewStart - this.dragStartView} bars`, {
        panMs,
        viewStart: this.viewStart,
        loadingOlder: this.loadingOlder,
      });
      this.scheduleEmitVisibleRange(true);
    } else if (this.panStartedAt > 0) {
      this.logChartEvent('chart.pan.cancel', 'no movement', { panMs });
    }
    this.panStartedAt = 0;
  }

  onPointerLeave(event: PointerEvent): void {
    if (!this.dragging) return;
    this.onPointerUp(event);
  }

  onTouchStart(event: TouchEvent): void {
    if (event.touches.length === 2) {
      this.pinchActive = true;
      this.dragging = false;
      this.pinchStartDist = this.touchDistance(event.touches);
      this.pinchStartZoom = this.zoom;
      event.preventDefault();
    }
  }

  onTouchMove(event: TouchEvent): void {
    if (!this.pinchActive || event.touches.length < 2) return;
    event.preventDefault();
    const dist = this.touchDistance(event.touches);
    if (this.pinchStartDist <= 0) return;
    const ratio = dist / this.pinchStartDist;
    this.applyZoom(this.pinchStartZoom * ratio, false);
  }

  onTouchEnd(event: TouchEvent): void {
    if (event.touches.length < 2) {
      this.pinchActive = false;
      this.scheduleEmitVisibleRange(true);
    }
  }

  private touchDistance(touches: TouchList): number {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  private applyZoom(next: number, emit = true): void {
    const prev = this.zoom;
    this.zoom = Math.min(3.5, Math.max(0.45, next));
    if (Math.abs(this.zoom - prev) < 0.001) return;
    this.clampViewStart();
    this.scheduleRedraw();
    if (emit) this.scheduleEmitVisibleRange(true);
  }

  private shiftView(delta: number): void {
    const maxStart = Math.max(0, this.candles.length - this.viewCount());
    this.viewStart = Math.min(maxStart, Math.max(0, this.viewStart + delta));
    if (this.viewStart <= 8 && !this.loadOlderPending) {
      this.loadOlderPending = true;
      this.loadOlder.emit();
    }
    this.scheduleRedraw();
    this.scheduleEmitVisibleRange(true);
  }

  private canInteract(): boolean {
    return !this.loading && this.candles.length > 0;
  }

  private scheduleRedraw(): void {
    if (this.redrawScheduled) return;
    this.redrawScheduled = true;
    this.redrawRafId = requestAnimationFrame(() => {
      this.redrawScheduled = false;
      this.redrawRafId = null;
      this.redrawNow();
    });
  }

  private rebuildSeriesPointIndex(): void {
    this.seriesPointIndex.clear();
    for (const series of this.indicatorSeries) {
      const byDt = new Map<string, number>();
      for (const point of series.points) {
        byDt.set(point.dt, point.value);
      }
      this.seriesPointIndex.set(series, byDt);
    }
  }

  private logChartEvent(
    operation: string,
    message: string,
    payload?: Record<string, unknown>
  ): void {
    if (!this.techLog.enabled || this.securityId == null) return;
    this.techLog.event(
      this.techLog.threadKey(this.securityId, null, 'chart'),
      operation,
      message,
      { securityId: this.securityId, payload }
    );
  }

  private clampViewStart(): void {
    const maxStart = Math.max(0, this.candles.length - this.viewCount());
    if (this.viewStart + this.viewCount() > this.candles.length) {
      this.viewStart = maxStart;
    }
    if (this.viewStart > maxStart) {
      this.viewStart = maxStart;
    }
  }

  private viewCount(): number {
    const body = this.chartBodyRef?.nativeElement;
    if (!body) return 60;
    const pad = this.chartPadding();
    const w = body.clientWidth || 400;
    return Math.max(10, Math.floor((w - pad.left - pad.right) / this.candleWidth));
  }

  currentVisibleRange(): ChartVisibleRange {
    const count = this.viewCount();
    const visible = this.candles.slice(this.viewStart, this.viewStart + count);
    if (visible.length === 0) {
      return { startDt: '', endDt: '', count: 0, viewStart: this.viewStart };
    }
    return {
      startDt: visible[0].dt,
      endDt: visible[visible.length - 1].dt,
      count: visible.length,
      viewStart: this.viewStart,
    };
  }

  private scheduleEmitVisibleRange(userInitiated = false): void {
    if (this.emitRangeTimer) clearTimeout(this.emitRangeTimer);
    this.emitRangeTimer = setTimeout(() => {
      const range = this.currentVisibleRange();
      if (range.count > 0) {
        this.visibleRangeChange.emit({ ...range, userInitiated });
      }
    }, 300);
  }

  private hasOscillatorPanel(): boolean {
    return this.indicatorSeries.some((s) => !s.on_price_scale);
  }

  /** Индикаторы на шкале цены, для которых нужна явная линия y=0 (вторая разность и т.п.). */
  private priceScaleAnchorsZero(): boolean {
    return this.indicatorSeries.some(
      (s) =>
        s.on_price_scale &&
        !s.is_threshold &&
        ['PACC', 'MOM', 'ROC'].includes(s.indicator_code)
    );
  }

  private drawReferenceLevel(
    ctx: CanvasRenderingContext2D,
    yScale: (v: number) => number,
    value: number,
    minV: number,
    maxV: number,
    left: number,
    right: number,
    label: string
  ): void {
    if (value < minV || value > maxV) return;
    const y = yScale(value);
    const axisSize = this.px(10);
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.fillStyle = '#9ca3af';
    ctx.font = `${axisSize}px system-ui, sans-serif`;
    ctx.fillText(label, 4, y + Math.round(axisSize * 0.35));
  }

  private valueAtDt(series: ChartIndicatorSeries, dt: string): number | null {
    const value = this.seriesPointIndex.get(series)?.get(dt);
    return value != null ? value : null;
  }

  private redrawNow(): void {
    const t0 = performance.now();
    const canvas = this.canvasRef?.nativeElement;
    const body = this.chartBodyRef?.nativeElement;
    if (!canvas || !body) return;

    const cssW = body.clientWidth;
    const cssH = body.clientHeight;
    if (cssW <= 0 || cssH <= 0) return;

    // Пока меняем canvas — игнор ResizeObserver (иначе петля и зависание UI).
    this.ignoreResizeUntil = performance.now() + 120;
    this.lastBodyW = cssW;
    this.lastBodyH = cssH;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const pad = this.chartPadding();
    const msgSize = this.px(13);

    if (this.error) {
      ctx.fillStyle = '#b45309';
      ctx.font = `${msgSize}px system-ui, sans-serif`;
      ctx.fillText(this.error, 12, pad.top + 8);
      return;
    }
    if (this.loading && this.candles.length === 0) {
      ctx.fillStyle = '#6b7280';
      ctx.font = `${msgSize}px system-ui, sans-serif`;
      ctx.fillText('Загрузка свечей…', 12, pad.top + 8);
      return;
    }
    if (this.candles.length === 0) {
      ctx.fillStyle = '#6b7280';
      ctx.font = `${msgSize}px system-ui, sans-serif`;
      ctx.fillText('Нет цен для выбранного таймфрейма', 12, pad.top + 8);
      return;
    }

    const cw = this.candleWidth;
    const count = this.viewCount();
    const visible = this.candles.slice(this.viewStart, this.viewStart + count);
    if (visible.length === 0) return;

    const showOsc = this.hasOscillatorPanel();
    const showPnl = this.equityPoints.length > 0;
    // Отдельная полоса PnL под ценой (и под OSC, если есть) — не конкурирует с ценой.
    const pnlRatio = showPnl ? (showOsc ? 0.2 : 0.26) : 0;
    const oscRatio = showOsc ? (showPnl ? 0.2 : 0.28) : 0;
    const usableBottom = cssH - pad.bottom;
    const priceTop = pad.top;
    const priceBottom = usableBottom - cssH * (oscRatio + pnlRatio);
    const priceH = priceBottom - priceTop;
    const oscTop = priceBottom + 4;
    const oscBottom = showOsc ? usableBottom - cssH * pnlRatio : priceBottom;
    const oscH = Math.max(0, oscBottom - oscTop);
    const pnlTop = showPnl ? (showOsc ? oscBottom : priceBottom) + 4 : usableBottom;
    const pnlBottom = usableBottom;
    const pnlH = Math.max(0, pnlBottom - pnlTop);

    let minP = Infinity;
    let maxP = -Infinity;
    for (const c of visible) {
      minP = Math.min(minP, Number(c.low_price));
      maxP = Math.max(maxP, Number(c.high_price));
    }

    const priceSeries = this.indicatorSeries.filter(
      (s) => s.on_price_scale && !s.is_threshold
    );
    for (const s of priceSeries) {
      for (const c of visible) {
        const v = this.valueAtDt(s, c.dt);
        if (v != null && Number.isFinite(v)) {
          minP = Math.min(minP, v);
          maxP = Math.max(maxP, v);
        }
      }
    }

    if (this.priceScaleAnchorsZero()) {
      minP = Math.min(minP, 0);
      maxP = Math.max(maxP, 0);
    }

    const pricePad = (maxP - minP) * 0.06 || maxP * 0.001 || 1;
    minP -= pricePad;
    maxP += pricePad;
    const yScale = (p: number) => priceTop + priceH - ((p - minP) / (maxP - minP)) * priceH;

    const axisSize = this.px(10);
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const p = minP + ((maxP - minP) * i) / 4;
      const y = yScale(p);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(cssW - pad.right, y);
      ctx.stroke();
      ctx.fillStyle = '#9ca3af';
      ctx.font = `${axisSize}px system-ui, sans-serif`;
      ctx.fillText(p.toFixed(2), 4, y + Math.round(axisSize * 0.35));
    }

    this.drawReferenceLevel(
      ctx,
      yScale,
      0,
      minP,
      maxP,
      pad.left,
      cssW - pad.right,
      '0'
    );

    this.drawShadedRanges(
      ctx,
      visible,
      pad.left,
      cssW - pad.right,
      priceTop,
      priceBottom,
      cw
    );

    visible.forEach((c, i) => {
      const x = pad.left + i * cw + cw / 2;
      const open = Number(c.open_price);
      const close = Number(c.close_price);
      const high = Number(c.high_price);
      const low = Number(c.low_price);
      const up = close >= open;
      ctx.strokeStyle = up ? '#16a34a' : '#dc2626';
      ctx.fillStyle = up ? '#16a34a' : '#dc2626';

      const yHigh = yScale(high);
      const yLow = yScale(low);
      ctx.beginPath();
      ctx.moveTo(x, yHigh);
      ctx.lineTo(x, yLow);
      ctx.stroke();

      const yOpen = yScale(open);
      const yClose = yScale(close);
      const top = Math.min(yOpen, yClose);
      const bodyH = Math.max(1, Math.abs(yClose - yOpen));
      ctx.fillRect(x - cw * 0.35, top, cw * 0.7, bodyH);
    });

    for (const s of priceSeries) {
      this.drawLineSeries(ctx, visible, s, yScale, pad.left, cw);
    }

    this.drawStopMarkers(ctx, visible, yScale, pad.left, cw, priceTop, priceBottom);
    this.drawTradeMarkers(ctx, visible, yScale, pad.left, cw, priceTop, priceBottom);

    if (showOsc && oscH > 20) {
      ctx.strokeStyle = '#d1d5db';
      ctx.beginPath();
      ctx.moveTo(pad.left, oscTop);
      ctx.lineTo(cssW - pad.right, oscTop);
      ctx.stroke();

      const oscSeries = this.indicatorSeries.filter((s) => !s.on_price_scale);
      let oscMin = Infinity;
      let oscMax = -Infinity;
      for (const s of oscSeries) {
        for (const c of visible) {
          const v = this.valueAtDt(s, c.dt);
          if (v != null && Number.isFinite(v)) {
            oscMin = Math.min(oscMin, v);
            oscMax = Math.max(oscMax, v);
          }
        }
      }
      if (!Number.isFinite(oscMin) || !Number.isFinite(oscMax)) {
        oscMin = 0;
        oscMax = 100;
      }
      oscMin = Math.min(oscMin, 0);
      oscMax = Math.max(oscMax, 0);
      const oscPad = (oscMax - oscMin) * 0.08 || 1;
      oscMin -= oscPad;
      oscMax += oscPad;
      const yOsc = (v: number) => oscTop + oscH - ((v - oscMin) / (oscMax - oscMin)) * oscH;

      this.drawReferenceLevel(
        ctx,
        yOsc,
        0,
        oscMin,
        oscMax,
        pad.left,
        cssW - pad.right,
        '0'
      );

      for (const s of oscSeries.filter((x) => x.is_threshold)) {
        this.drawThresholdLine(ctx, s, yOsc, pad.left, cssW - pad.right);
      }
      for (const s of oscSeries.filter((x) => !x.is_threshold)) {
        this.drawLineSeries(ctx, visible, s, yOsc, pad.left, cw);
      }

      ctx.fillStyle = '#9ca3af';
      ctx.font = `${this.px(9)}px system-ui, sans-serif`;
      ctx.fillText('OSC', 4, oscTop + this.px(10));
    }

    if (showPnl && pnlH > 24) {
      this.drawEquityPanel(
        ctx,
        visible,
        pad.left,
        cssW - pad.right,
        pnlTop,
        pnlBottom,
        cw
      );
    }

    this.drawLegend(ctx, cssW, pad);

    const last = visible[visible.length - 1];
    ctx.fillStyle = '#6b7280';
    const footerSize = this.px(10);
    ctx.font = `${footerSize}px system-ui, sans-serif`;
    const dtLabel = new Date(last.dt).toLocaleString('ru-RU', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
    let footer = dtLabel;
    if (last.contract_prefix) {
      footer += ` · ${last.contract_prefix}`;
      if (last.group_prefix && last.group_prefix !== last.contract_prefix) {
        footer += ` (гр. ${last.group_prefix})`;
      }
    }
    ctx.fillText(footer, pad.left, cssH - Math.round(pad.bottom * 0.25));

    if (this.loading && this.candles.length === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillRect(0, 0, cssW, cssH);
      ctx.fillStyle = '#374151';
      ctx.font = `${this.px(12)}px system-ui, sans-serif`;
      ctx.fillText('Загрузка свечей…', cssW / 2 - this.px(48), cssH / 2);
    } else if (this.loadingOlder) {
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillRect(0, 0, Math.min(120, cssW * 0.35), this.px(22));
      ctx.fillStyle = '#374151';
      ctx.font = `${this.px(10)}px system-ui, sans-serif`;
      ctx.fillText('История…', 8, this.px(14));
    }

    const drawMs = performance.now() - t0;
    if (drawMs > 32) {
      this.logChartEvent('chart.redraw.slow', `${Math.round(drawMs)}ms`, {
        drawMs: Math.round(drawMs),
        visible: visible.length,
        series: this.indicatorSeries.length,
        dragging: this.dragging,
      });
    }
  }

  /**
   * Индекс в полном this.candles.
   * Не искать только в visible: иначе сделки «правее» окна прилипают к последней свече кадра.
   */
  private indexInAllCandles(dt: string): number {
    if (this.candles.length === 0) return -1;
    const key = PriceChartComponent.dtKey(dt);
    for (let i = 0; i < this.candles.length; i++) {
      if (PriceChartComponent.dtKey(this.candles[i].dt) === key) return i;
    }
    let best = -1;
    for (let i = 0; i < this.candles.length; i++) {
      if (PriceChartComponent.dtKey(this.candles[i].dt) <= key) best = i;
      else break;
    }
    return best;
  }

  /**
   * Индекс внутри visible[] только если сделка реально в этом окне.
   * Вне окна → -1 (не рисовать на краю).
   */
  private indexInVisible(visible: PriceCandle[], dt: string): number {
    if (visible.length === 0) return -1;
    const fullIdx = this.indexInAllCandles(dt);
    if (fullIdx < 0) return -1;
    const first = this.viewStart;
    const last = this.viewStart + visible.length - 1;
    if (fullIdx < first || fullIdx > last) return -1;
    return fullIdx - this.viewStart;
  }

  /** Для shade: индекс в visible с clamp к краям окна (полоса может начинаться за кадром). */
  private indexForDt(visible: PriceCandle[], dt: string): number {
    if (visible.length === 0) return -1;
    const fullIdx = this.indexInAllCandles(dt);
    if (fullIdx < 0) {
      const key = PriceChartComponent.dtKey(dt);
      if (key < PriceChartComponent.dtKey(visible[0].dt)) return 0;
      return visible.length - 1;
    }
    const first = this.viewStart;
    const last = this.viewStart + visible.length - 1;
    if (fullIdx < first) return 0;
    if (fullIdx > last) return visible.length - 1;
    return fullIdx - this.viewStart;
  }

  private drawShadedRanges(
    ctx: CanvasRenderingContext2D,
    visible: PriceCandle[],
    left: number,
    right: number,
    top: number,
    bottom: number,
    candleWidth: number
  ): void {
    if (!this.shadedRanges.length || visible.length === 0) return;
    const firstKey = PriceChartComponent.dtKey(visible[0].dt);
    const lastKey = PriceChartComponent.dtKey(visible[visible.length - 1].dt);
    for (const range of this.shadedRanges) {
      const startKey = PriceChartComponent.dtKey(range.startDt);
      const endKey = PriceChartComponent.dtKey(range.endDt);
      if (endKey < firstKey || startKey > lastKey) continue;
      let i0 = this.indexForDt(visible, range.startDt);
      let i1 = this.indexForDt(visible, range.endDt);
      if (i0 < 0) i0 = 0;
      if (i1 < 0) i1 = visible.length - 1;
      if (i1 < i0) [i0, i1] = [i1, i0];
      const x0 = left + i0 * candleWidth;
      const x1 = left + (i1 + 1) * candleWidth;
      const kind = range.kind ?? 'paused';
      // Бледные зоны: green = shadow; gray = бумага выкл.; pink = инверсия.
      const fill =
        kind === 'inverted'
          ? 'rgba(251, 207, 232, 0.45)'
          : kind === 'shadow'
            ? 'rgba(187, 247, 208, 0.45)'
            : 'rgba(203, 213, 225, 0.5)';
      const stroke =
        kind === 'inverted'
          ? 'rgba(244, 114, 182, 0.4)'
          : kind === 'shadow'
            ? 'rgba(74, 222, 128, 0.45)'
            : 'rgba(148, 163, 184, 0.55)';
      const labelColor =
        kind === 'inverted'
          ? 'rgba(157, 23, 77, 0.9)'
          : kind === 'shadow'
            ? 'rgba(21, 128, 61, 0.9)'
            : 'rgba(51, 65, 85, 0.95)';
      ctx.fillStyle = fill;
      ctx.fillRect(x0, top, Math.max(3, x1 - x0), bottom - top);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(x0 + 0.5, top + 0.5, Math.max(3, x1 - x0) - 1, bottom - top - 1);
      ctx.setLineDash([]);
      if (range.label) {
        ctx.fillStyle = labelColor;
        ctx.font = `600 ${this.px(10)}px system-ui, sans-serif`;
        ctx.fillText(range.label, x0 + 4, top + this.px(14));
      }
    }
  }

  /**
   * Отдельная панель PnL под ценой: своя шкала, заливка, разрывы в зоне «выкл.».
   * Не конкурирует с ценой (HYDR ~0.35 / PnL в рублях).
   */
  private drawEquityPanel(
    ctx: CanvasRenderingContext2D,
    visible: PriceCandle[],
    left: number,
    right: number,
    top: number,
    bottom: number,
    candleWidth: number
  ): void {
    if (!this.equityPoints.length || visible.length === 0) return;

    ctx.fillStyle = '#f5f3ff';
    ctx.fillRect(left, top, right - left, bottom - top);
    ctx.strokeStyle = '#ddd6fe';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, top);
    ctx.lineTo(right, top);
    ctx.stroke();
    // Бледные зоны «выкл.» под линией PnL
    this.drawShadedRanges(ctx, visible, left, right, top, bottom, candleWidth);

    let minE = Infinity;
    let maxE = -Infinity;
    const samples: { i: number; v: number; gapBefore: boolean }[] = [];
    const sorted = [...this.equityPoints].sort((a, b) =>
      PriceChartComponent.dtKey(a.dt).localeCompare(PriceChartComponent.dtKey(b.dt))
    );

    let last: number | null = null;
    let j = 0;
    const firstVis = PriceChartComponent.dtKey(visible[0].dt);
    const equityStart = PriceChartComponent.dtKey(sorted[0].dt);
    // До якоря нуля (начало теста) линию не рисуем; с якоря — step-функция от 0
    while (j < sorted.length && PriceChartComponent.dtKey(sorted[j].dt) <= firstVis) {
      const v = Number(sorted[j].value);
      if (Number.isFinite(v)) last = v;
      j += 1;
    }
    // Если окно начинается после якоря, но точка якоря ещё не попала в last — 0
    if (last == null && firstVis >= equityStart) {
      last = 0;
    }

    let gapPending = false;
    for (let i = 0; i < visible.length; i++) {
      const key = PriceChartComponent.dtKey(visible[i].dt);
      if (key < equityStart) {
        continue;
      }
      while (j < sorted.length && PriceChartComponent.dtKey(sorted[j].dt) <= key) {
        const v = Number(sorted[j].value);
        if (Number.isFinite(v)) last = v;
        j += 1;
      }
      if (last == null) last = 0;
      if (this.isEquityDtInDisabledInterior(key)) {
        gapPending = true;
        continue;
      }
      if (Number.isFinite(last)) {
        samples.push({ i, v: last, gapBefore: gapPending });
        gapPending = false;
        minE = Math.min(minE, last);
        maxE = Math.max(maxE, last);
      }
    }
    if (samples.length === 0) {
      ctx.fillStyle = '#7c3aed';
      ctx.font = `600 ${this.px(10)}px system-ui, sans-serif`;
      ctx.fillText('PnL', left + 4, top + this.px(14));
      ctx.fillStyle = '#a78bfa';
      ctx.font = `${this.px(9)}px system-ui, sans-serif`;
      ctx.fillText('нет закрытий в окне', left + 36, top + this.px(14));
      return;
    }

    minE = Math.min(minE, 0);
    maxE = Math.max(maxE, 0);
    // Минимальный размах, чтобы линия у нуля не схлопывалась в точку
    const span = maxE - minE;
    const padE = Math.max(span * 0.12, Math.abs(maxE) * 0.05, Math.abs(minE) * 0.05, 1);
    minE -= padE;
    maxE += padE;
    const h = bottom - top;
    const yEq = (v: number) => top + h - ((v - minE) / (maxE - minE)) * h;

    // Нулевая линия
    const y0 = yEq(0);
    ctx.strokeStyle = 'rgba(124, 58, 237, 0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(left, y0);
    ctx.lineTo(right, y0);
    ctx.stroke();
    ctx.setLineDash([]);

    // Заливка под ступенями
    ctx.fillStyle = 'rgba(124, 58, 237, 0.14)';
    let seg: { i: number; v: number }[] = [];
    const flushFill = () => {
      if (seg.length === 0) return;
      ctx.beginPath();
      const x0 = left + seg[0].i * candleWidth + candleWidth / 2;
      ctx.moveTo(x0, y0);
      for (const s of seg) {
        ctx.lineTo(left + s.i * candleWidth + candleWidth / 2, yEq(s.v));
      }
      const x1 = left + seg[seg.length - 1].i * candleWidth + candleWidth / 2;
      ctx.lineTo(x1, y0);
      ctx.closePath();
      ctx.fill();
      seg = [];
    };
    for (const s of samples) {
      if (s.gapBefore) flushFill();
      seg.push(s);
    }
    flushFill();

    // Линия PnL (ступень)
    ctx.strokeStyle = '#7c3aed';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    let started = false;
    let prevY: number | null = null;
    for (const s of samples) {
      const x = left + s.i * candleWidth + candleWidth / 2;
      const y = yEq(s.v);
      if (!started || s.gapBefore) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        // Горизонталь предыдущего значения, затем вертикальный шаг
        if (prevY != null && Math.abs(prevY - y) > 0.5) {
          ctx.lineTo(x, prevY);
        }
        ctx.lineTo(x, y);
      }
      prevY = y;
    }
    ctx.stroke();

    const axisSize = this.px(9);
    ctx.fillStyle = '#7c3aed';
    ctx.font = `600 ${this.px(10)}px system-ui, sans-serif`;
    ctx.fillText('PnL', 4, top + this.px(12));
    ctx.font = `${axisSize}px system-ui, sans-serif`;
    ctx.fillStyle = '#6d28d9';
    ctx.fillText(this.formatPnlAxis(maxE), 4, top + this.px(22));
    ctx.fillText(this.formatPnlAxis(minE), 4, bottom - 2);
    const lastV = samples[samples.length - 1].v;
    ctx.fillText(this.formatPnlAxis(lastV), right - this.px(36), top + this.px(12));
  }

  private formatPnlAxis(v: number): string {
    if (!Number.isFinite(v)) return '—';
    const abs = Math.abs(v);
    if (abs >= 1000) return v.toFixed(0);
    if (abs >= 10) return v.toFixed(1);
    return v.toFixed(2);
  }

  /** Строго внутри shadedRanges — не на границах (там рисуем шаг PnL). */
  private isEquityDtInDisabledInterior(dtKey: string): boolean {
    for (const r of this.shadedRanges) {
      if (r.kind === 'inverted') continue;
      const a = PriceChartComponent.dtKey(r.startDt);
      const b = PriceChartComponent.dtKey(r.endDt);
      if (dtKey > a && dtKey < b) return true;
    }
    return false;
  }

  private drawStopMarkers(
    ctx: CanvasRenderingContext2D,
    visible: PriceCandle[],
    yScale: (v: number) => number,
    left: number,
    candleWidth: number,
    priceTop: number,
    priceBottom: number
  ): void {
    if (!this.stopMarkers.length) return;
    const labelSize = this.px(10);
    for (const m of this.stopMarkers) {
      const i = this.indexInVisible(visible, m.dt);
      if (i < 0) continue;
      const x = left + i * candleWidth + candleWidth / 2;
      const y = yScale(Number(m.price));
      const color = m.ruleKind === 'take_profit' ? '#059669' : '#dc2626';
      // Вертикальная полоса — где сработал стоп/тейк
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = Math.max(2, candleWidth * 0.45);
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x, priceTop);
      ctx.lineTo(x, priceBottom);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(left + visible.length * candleWidth, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.font = `600 ${labelSize}px system-ui, sans-serif`;
      const tag = m.ruleKind === 'take_profit' ? 'TP' : 'SL';
      ctx.fillText(`${tag} ${m.label || ''}`.trim(), x + 4, Math.max(priceTop + labelSize, y - 4));
    }
  }

  private drawTradeMarkers(
    ctx: CanvasRenderingContext2D,
    visible: PriceCandle[],
    yScale: (v: number) => number,
    left: number,
    candleWidth: number,
    priceTop: number,
    priceBottom: number
  ): void {
    if (!this.tradeMarkers.length) return;
    // Несколько сделок на одном баре (open+close) — чуть развести по X, не «одна линия».
    const slotByKey = new Map<string, number>();
    for (const m of this.tradeMarkers) {
      const i = this.indexInVisible(visible, m.dt);
      if (i < 0) continue;
      const key = PriceChartComponent.dtKey(m.dt);
      const slot = slotByKey.get(key) ?? 0;
      slotByKey.set(key, slot + 1);
      const stagger = (slot - 0.5) * Math.max(3, candleWidth * 0.35);
      const x = left + i * candleWidth + candleWidth / 2 + stagger;
      const y = yScale(Number(m.price));
      const isLong = m.side === 'long';
      const isOpen = m.kind === 'open';
      const color = m.isShadow
        ? '#94a3b8'
        : isOpen
          ? isLong
            ? '#16a34a'
            : '#dc2626'
          : isLong
            ? '#15803d'
            : '#b91c1c';
      // Вертикальная полоса входа/выхода
      ctx.strokeStyle = color;
      ctx.globalAlpha = m.isShadow ? 0.22 : 0.4;
      ctx.lineWidth = Math.max(2, candleWidth * 0.45);
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x, priceTop);
      ctx.lineTo(x, priceBottom);
      ctx.stroke();

      ctx.globalAlpha = m.isShadow ? 0.6 : 1;
      ctx.fillStyle = color;
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1;
      const size = Math.max(9, candleWidth * 1.15);
      ctx.beginPath();
      if (isOpen) {
        ctx.moveTo(x, y - size);
        ctx.lineTo(x - size, y + size * 0.65);
        ctx.lineTo(x + size, y + size * 0.65);
      } else {
        ctx.moveTo(x, y + size);
        ctx.lineTo(x - size, y - size * 0.65);
        ctx.lineTo(x + size, y - size * 0.65);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  private drawLineSeries(
    ctx: CanvasRenderingContext2D,
    visible: PriceCandle[],
    series: ChartIndicatorSeries,
    yScale: (v: number) => number,
    left: number,
    candleWidth: number
  ): void {
    ctx.strokeStyle = series.color;
    ctx.lineWidth = series.is_threshold ? 1 : 1.5;
    ctx.setLineDash(series.is_threshold ? [4, 4] : []);
    ctx.beginPath();
    let started = false;
    visible.forEach((c, i) => {
      const v = this.valueAtDt(series, c.dt);
      if (v == null || !Number.isFinite(v)) {
        started = false;
        return;
      }
      const x = left + i * candleWidth + candleWidth / 2;
      const y = yScale(v);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawThresholdLine(
    ctx: CanvasRenderingContext2D,
    series: ChartIndicatorSeries,
    yScale: (v: number) => number,
    left: number,
    right: number
  ): void {
    const v = series.points[0]?.value;
    if (v == null || !Number.isFinite(v)) return;
    ctx.strokeStyle = series.color;
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    const y = yScale(v);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawLegend(
    ctx: CanvasRenderingContext2D,
    cssW: number,
    pad: { left: number }
  ): void {
    const drawn = this.indicatorSeries.filter((s) => !s.is_threshold);
    let x = pad.left;
    const y = this.px(18);
    const legendSize = this.px(9);
    const swatchW = this.px(10);
    const swatchH = Math.max(3, this.px(3));
    ctx.font = `${legendSize}px system-ui, sans-serif`;
    if (this.equityPoints.length > 0) {
      ctx.fillStyle = '#7c3aed';
      ctx.fillRect(x, y - swatchH - 2, swatchW, swatchH);
      ctx.fillStyle = '#374151';
      ctx.fillText('PnL', x + swatchW + 3, y);
      x += ctx.measureText('PnL').width + this.px(22);
    }
    for (const s of drawn.slice(0, 8)) {
      const label = `${s.indicator_code}.${s.line_code}`;
      ctx.fillStyle = s.color;
      ctx.fillRect(x, y - swatchH - 2, swatchW, swatchH);
      ctx.fillStyle = '#374151';
      ctx.fillText(label, x + swatchW + 3, y);
      x += ctx.measureText(label).width + this.px(22);
      if (x > cssW - 80) break;
    }
  }
}
