import {
  Component,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  SimpleChanges,
  ViewChild,
  ViewChildren,
  QueryList,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { finalize, forkJoin, Observable, Subscription } from 'rxjs';
import { PriceChartComponent } from '../price-chart/price-chart.component';
import { SecuritiesService } from '../services/securities.service';
import { TerminalStateService } from '../services/terminal-state.service';
import {
  PriceCandle,
  PriceRefreshResult,
  SecurityChartState,
  SecurityRow,
  TimeframeRow,
} from '../models/market.model';

const EMPTY_STATE: SecurityChartState = {
  candles: [],
  loading: false,
  loadingOlder: false,
  hasMore: false,
  error: null,
};

/** Фейковый счёт: стартовая «демо-сумма» для максимальной суммы сделки. */
const FAKE_DEFAULT_MAX_SUM = 10000;

@Component({
  selector: 'app-terminal-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, PriceChartComponent],
  templateUrl: './terminal-panel.component.html',
  styleUrl: './terminal-panel.component.css',
})
export class TerminalPanelComponent implements OnInit, OnChanges, OnDestroy {
  @Input() security!: SecurityRow;
  /** Синтетическая бумага контанго (только для подписи) — источник графика не она. */
  @Input() contango: SecurityRow | null = null;
  /** Базовый актив фьючерса: контанго = (фьючерс / базовый актив − 1) × 100%. */
  @Input() underlying: SecurityRow | null = null;
  @Input() timeframes: TimeframeRow[] = [];
  /** Начальный таймфрейм (восстановление из сохранённого состояния). */
  @Input() initialTimeframeId: number | null = null;
  /** Начальная высота блока графиков. */
  @Input() initialHeight = 340;
  /** Счёт, на который идут сделки (для реального исполняется ордер). */
  @Input() accountId: number | null = null;
  /** Фейковый счёт — сделки записываются как демо. */
  @Input() accountIsFake = false;
  /** Максимальная сумма сделки (баланс счёта, для фейка/нуля — 10 000). */
  @Input() tradeMaxSum = FAKE_DEFAULT_MAX_SUM;
  @Output() remove = new EventEmitter<void>();
  /** Изменение состояния полосы: таймфрейм и/или высота графиков. */
  @Output() stateChange = new EventEmitter<{
    timeframe_id: number | null;
    chart_height: number;
  }>();
  /** Сделка размещена (ок или отклонена) — терминал обновляет остаток и историю. */
  @Output() tradeExecuted = new EventEmitter<void>();
  /** На графике появились первые свечи (для снятия надписи «идёт выбор бумаги…»). */
  @Output() dataReady = new EventEmitter<void>();

  @ViewChild('mainChart') mainChart?: PriceChartComponent;
  @ViewChildren(PriceChartComponent) allCharts?: QueryList<PriceChartComponent>;

  timeframeId: number | null = null;
  /** Высота блока с графиками (можно потянуть за ручку внизу панели). */
  chartHeight = 340;
  chartHeightMin = 100;
  chartHeightMax = 1400;
  chartState: SecurityChartState = { ...EMPTY_STATE };
  /** Свечи базового актива (для расчёта контанго). */
  underlyingState: SecurityChartState = { ...EMPTY_STATE };
  contangoChartState: SecurityChartState = { ...EMPTY_STATE };

  /** Блок сделок: выбранная сумма, тип заявки, результат исполнения. */
  tradeAmount = 0;
  /** Редактируемая максимальная сумма сделки (импут над ползунком). */
  tradeMaxInput = FAKE_DEFAULT_MAX_SUM;
  /** Пользователь менял максимум вручную — не затираем при обновлении баланса. */
  private userEditedMax = false;
  tradeType: 'market' | 'limit' = 'market';
  tradingBusy = false;
  tradeMessage: string | null = null;
  tradeError: string | null = null;

  private pollTimer?: ReturnType<typeof setInterval>;
  /** Идёт живая догрузка свечей — не запускаем следующую, пока не закончилась. */
  private liveBusy = false;
  /** Первые свечи уже сообщены родителю (dataReady эмитится один раз). */
  private dataReadySent = false;
  private subs: Subscription[] = [];
  private destroyed = false;

  constructor(
    private readonly securities: SecuritiesService,
    private readonly stateSvc: TerminalStateService
  ) {}

  ngOnInit(): void {
    // Восстановленный таймфрейм, иначе дефолт M15: крупнее бара тика,
    // не так шумно, как H1.
    const m15 = this.timeframes.find((t) => t.tf === 'M15');
    const restored =
      this.initialTimeframeId != null &&
      this.timeframes.some((t) => t.id === this.initialTimeframeId)
        ? this.initialTimeframeId
        : null;
    this.timeframeId = restored ?? m15?.id ?? this.timeframes[0]?.id ?? null;
    this.chartHeight = Math.max(
      this.chartHeightMin,
      Math.min(this.chartHeightMax, this.initialHeight)
    );
    this.loadChart();
    this.startPolling();
    this.emitStateChange();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const s of this.subs) s.unsubscribe();
  }

  /** При смене счёта сбрасываем максимум на баланс; при живом обновлении
      баланса (без смены счёта) — только пока пользователь не менял вручную. */
  ngOnChanges(changes: SimpleChanges): void {
    if (changes['accountId'] != null || changes['accountIsFake'] != null) {
      this.userEditedMax = false;
      this.tradeMaxInput = Math.max(0, Math.floor(this.tradeMaxSum || 0));
    } else if (changes['tradeMaxSum'] != null && !this.userEditedMax) {
      const v = Math.floor(Number(this.tradeMaxSum));
      if (Number.isFinite(v) && v >= 0) {
        this.tradeMaxInput = v;
      }
    }
    const max = this.effectiveMaxSum;
    this.tradeAmount = Math.max(0, Math.min(max, this.tradeAmount));
    this.tradeMessage = null;
    this.tradeError = null;
  }

  /** Действующая максимальная сумма (после правки импута). */
  get effectiveMaxSum(): number {
    const v = Math.floor(Number(this.tradeMaxInput));
    return Number.isFinite(v) && v >= 0 ? v : 0;
  }

  get displayTitle(): string {
    return `${this.security.prefix} — ${this.security.name}`;
  }

  /** Текущая цена (последняя свеча графика) — основа расчёта количества. */
  get currentPrice(): number {
    const rows = this.chartState.candles;
    const last = rows.length ? rows[rows.length - 1] : null;
    const p = last ? Number(last.close_price) : 0;
    return Number.isFinite(p) && p > 0 ? p : 0;
  }

  get tradeQuantity(): number {
    const p = this.currentPrice;
    if (!(p > 0) || !(this.tradeAmount > 0)) return 0;
    return Math.floor(this.tradeAmount / p);
  }

  /** Сумма сделки без комиссии: выбранное количество × текущая цена. */
  get tradeSum(): number {
    return Math.round(this.tradeQuantity * this.currentPrice * 100) / 100;
  }

  get priceMissing(): boolean {
    return !(this.currentPrice > 0);
  }

  get selectedTimeframe(): TimeframeRow | undefined {
    return this.timeframes.find((t) => t.id === this.timeframeId);
  }

  get contangoTitle(): string {
    return this.contango
      ? `Контанго — ${this.contango.prefix} (%, фьючерс / базовый актив)`
      : 'Контанго (%, фьючерс / базовый актив)';
  }

  get hasContango(): boolean {
    return this.underlying != null;
  }

  isFutures(): boolean {
    return this.security.instrument_market === 'futures';
  }

  /** Первые свечи появились — сообщаем терминалу (снимаем «идёт выбор бумаги…»). */
  private maybeDataReady(rows: PriceCandle[]): void {
    if (this.dataReadySent || rows.length === 0) return;
    this.dataReadySent = true;
    this.dataReady.emit();
  }

  onTimeframeChange(): void {
    this.loadChart();
    this.emitStateChange();
  }

  loadChart(): void {
    if (!this.security || !this.timeframeId) return;
    this.chartState = { ...EMPTY_STATE, loading: true };
    this.underlyingState = { ...EMPTY_STATE, loading: this.hasContango };
    this.contangoChartState = { ...EMPTY_STATE, loading: this.hasContango };
    const reqs: Observable<PriceCandle[]>[] = [
      this.securities.getPrices(this.security.id, this.timeframeId, 200),
    ];
    if (this.hasContango) {
      reqs.push(
        this.securities.getPrices(this.underlying!.id, this.timeframeId, 200)
      );
    }
    forkJoin(reqs).subscribe({
      next: ([mainRows, baseRows]) => {
        if (this.destroyed) return;
        this.chartState = {
          ...this.chartState,
          candles: mainRows,
          loading: false,
          hasMore: mainRows.length > 0,
        };
        this.underlyingState = {
          ...this.underlyingState,
          candles: baseRows ?? [],
          loading: false,
          hasMore: (baseRows?.length ?? 0) > 0,
        };
        this.computeContango();
        this.maybeDataReady(mainRows);
      },
      error: () => {
        if (this.destroyed) return;
        this.chartState = {
          ...this.chartState,
          loading: false,
          error: 'Не удалось загрузить цены',
        };
        this.contangoChartState = {
          ...this.contangoChartState,
          loading: false,
          error: 'Не удалось загрузить цены',
        };
      },
    });
  }

  /** Контанго = (фьючерс / базовый актив − 1) × 100% по общим меткам времени. */
  private computeContango(): void {
    const fut = this.chartState.candles;
    const base = this.underlyingState.candles;
    if (!this.hasContango) {
      this.contangoChartState = { ...EMPTY_STATE };
      return;
    }
    const baseByDt = new Map(base.map((c) => [c.dt, c]));
    const out: PriceCandle[] = [];
    for (const f of fut) {
      const b = baseByDt.get(f.dt);
      if (!b) continue;
      const pct = (fv: number, bv: number) =>
        bv === 0 ? 0 : (fv / bv - 1) * 100;
      out.push({
        dt: f.dt,
        open_price: pct(f.open_price, b.open_price),
        high_price: pct(f.high_price, b.high_price),
        low_price: pct(f.low_price, b.low_price),
        close_price: pct(f.close_price, b.close_price),
        volume: null,
      });
    }
    this.contangoChartState = {
      ...this.contangoChartState,
      candles: out,
      loading: false,
      loadingOlder: false,
    };
  }

  /** Лёгкое обновление вживую: каждые 15 с догружаем свежие свечи в конец. */
  private startPolling(): void {
    this.pollTimer = setInterval(() => this.refreshLatest(), 15_000);
  }

  /** Цикл: сперва догружаем в БД последнюю закрытую свечу (T-Bank/MOEX),
      затем перечитываем цены и вливаем новые/обновившиеся бары в графики. */
  private refreshLatest(): void {
    if (this.destroyed || !this.security || !this.timeframeId) return;
    if (this.chartState.loading || this.liveBusy) return;
    this.liveBusy = true;
    const secId = this.security.id;
    const tfId = this.timeframeId;
    const loads: Observable<PriceRefreshResult>[] = [
      this.securities.refreshPrices(secId, tfId),
    ];
    if (this.hasContango) {
      loads.push(this.securities.refreshPrices(this.underlying!.id, tfId));
    }
    forkJoin(loads).subscribe({
      next: () => this.mergeLatest(),
      error: () => this.mergeLatest(),
    });
  }

  /** Перечитать цены после догрузки и влить их в графики (фьючерс + базовый). */
  private mergeLatest(): void {
    if (this.destroyed) {
      this.liveBusy = false;
      return;
    }
    this.appendLatest(
      this.security.id,
      this.chartState,
      (s) => {
        this.chartState = s;
      },
      () => {
        if (this.hasContango) {
          this.appendLatest(
            this.underlying!.id,
            this.underlyingState,
            (s) => {
              this.underlyingState = s;
            },
            () => {
              this.liveBusy = false;
            }
          );
        } else {
          this.liveBusy = false;
        }
      }
    );
  }

  private appendLatest(
    securityId: number,
    state: SecurityChartState,
    apply: (next: SecurityChartState) => void,
    done?: () => void
  ): void {
    const existing = state.candles;
    this.subs.push(
      this.securities
        .getPrices(securityId, this.timeframeId!, 60)
        .pipe(finalize(() => done?.()))
        .subscribe({
          next: (rows) => {
            if (this.destroyed || rows.length === 0) return;
          // Обновляем уже известные свечи на месте (текущий бар часто тот же dt,
          // но новая цена) и добавляем новые бары в конец.
          const rowsByDt = new Map(rows.map((r) => [r.dt, r]));
          const existingDts = new Set(existing.map((c) => c.dt));
          let changed = false;
          const merged: PriceCandle[] = [];
          for (const c of existing) {
            const fresh = rowsByDt.get(c.dt);
            if (
              fresh &&
              (fresh.open_price !== c.open_price ||
                fresh.high_price !== c.high_price ||
                fresh.low_price !== c.low_price ||
                fresh.close_price !== c.close_price ||
                fresh.volume !== c.volume)
            ) {
              merged.push(fresh);
              changed = true;
            } else {
              merged.push(c);
            }
          }
          for (const r of rows) {
            if (!existingDts.has(r.dt)) {
              merged.push(r);
              changed = true;
            }
          }
          if (!changed) return;
          apply({
            ...state,
            candles: merged,
            hasMore: true,
          });
          this.computeContango();
          this.maybeDataReady(merged);
        },
        error: () => undefined,
      })
    );
  }

  /** Дозагрузка истории: сразу для фьючерса и базового актива, контанго пересчитывается. */
  loadOlder(): void {
    if (
      !this.security ||
      !this.timeframeId ||
      this.chartState.loadingOlder ||
      this.chartState.candles.length === 0
    ) {
      return;
    }
    const fut = this.chartState.candles;
    const base = this.underlyingState.candles;
    const reqs: Observable<PriceCandle[]>[] = [
      this.securities.getPrices(
        this.security.id,
        this.timeframeId,
        200,
        fut[0].dt
      ),
    ];
    if (this.hasContango && base.length > 0) {
      reqs.push(
        this.securities.getPrices(
          this.underlying!.id,
          this.timeframeId,
          200,
          base[0].dt
        )
      );
    }
    this.chartState = { ...this.chartState, loadingOlder: true };
    this.subs.push(
      forkJoin(reqs).subscribe({
        next: ([futOlder, baseOlder]) => {
          if (this.destroyed) return;
          const futKnown = new Set(fut.map((c) => c.dt));
          const futFresh = futOlder.filter((c) => !futKnown.has(c.dt));
          this.chartState = {
            ...this.chartState,
            candles: [...futFresh, ...fut],
            loadingOlder: false,
            hasMore: futOlder.length > 0,
          };
          if (this.hasContango) {
            const baseKnown = new Set(base.map((c) => c.dt));
            const baseFresh = (baseOlder ?? []).filter(
              (c) => !baseKnown.has(c.dt)
            );
            this.underlyingState = {
              ...this.underlyingState,
              candles: [...baseFresh, ...base],
              loadingOlder: false,
              hasMore: (baseOlder?.length ?? 0) > 0,
            };
            this.computeContango();
          }
        },
        error: () => {
          this.chartState = { ...this.chartState, loadingOlder: false };
        },
      })
    );
  }

  /* Управление графиками из шапки полосы: масштаб и сдвиг применяются сразу
     к обоим графикам (фьючерс + контанго), чтобы участки совпадали. */
  private charts(): PriceChartComponent[] {
    return this.allCharts?.toArray() ?? [];
  }

  onZoomIn(event: Event): void {
    for (const c of this.charts()) c.zoomIn(event);
  }

  onZoomOut(event: Event): void {
    for (const c of this.charts()) c.zoomOut(event);
  }

  onPanLeft(event: Event): void {
    for (const c of this.charts()) c.panLeft(event);
  }

  onPanRight(event: Event): void {
    for (const c of this.charts()) c.panRight(event);
  }

  onExpand(event: Event): void {
    event.preventDefault();
    this.mainChart?.openFullscreen();
  }

  onExpandContango(event: Event): void {
    event.preventDefault();
    const charts = this.charts();
    charts[charts.length - 1]?.openFullscreen();
  }

  /** Начало перетаскивания ручки внизу панели — меняет высоту блока графиков. */
  onResizeStart(event: PointerEvent): void {
    event.preventDefault();
    const startY = event.clientY;
    const startH = this.chartHeight;
    const move = (ev: PointerEvent) => {
      this.chartHeight = Math.max(
        this.chartHeightMin,
        Math.min(this.chartHeightMax, startH + (ev.clientY - startY))
      );
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      this.emitStateChange();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ns-resize';
  }

  private emitStateChange(): void {
    this.stateChange.emit({
      timeframe_id: this.timeframeId,
      chart_height: this.chartHeight,
    });
  }

  onTradeAmountChange(): void {
    this.tradeMessage = null;
    this.tradeError = null;
  }

  /** Правка максимума вручную: валидируем, удерживаем сумму в пределах. */
  onTradeMaxEdit(): void {
    this.userEditedMax = true;
    let v = Math.floor(Number(this.tradeMaxInput));
    if (!Number.isFinite(v) || v < 0) v = 0;
    this.tradeMaxInput = v;
    this.tradeAmount = Math.min(this.tradeAmount, this.effectiveMaxSum);
    this.tradeMessage = null;
    this.tradeError = null;
  }

  /** Тумблер: в одну сторону — маркет, в другую — лимит. */
  onToggleTradeType(): void {
    this.tradeType = this.tradeType === 'market' ? 'limit' : 'market';
    this.tradeMessage = null;
    this.tradeError = null;
  }

  /** Купить/продать по рассчитанному количеству. Ноль — сообщение об ошибке. */
  placeTrade(direction: 'buy' | 'sell'): void {
    this.tradeMessage = null;
    this.tradeError = null;
    const qty = this.tradeQuantity;
    if (qty < 1) {
      this.tradeError =
        'Количество равно нулю — увеличьте сумму сделки на ползунке';
      return;
    }
    if (this.accountId == null) {
      this.tradeError = 'Не выбран счёт';
      return;
    }
    const price = this.currentPrice;
    if (!(price > 0)) {
      this.tradeError = 'Нет цены для расчёта — дождитесь загрузки графика';
      return;
    }
    this.tradingBusy = true;
    this.stateSvc
      .placeTrade({
        account_id: this.accountId,
        security_id: this.security.id,
        direction,
        execution: this.tradeType,
        price,
        quantity: qty,
      })
      .subscribe({
        next: (r) => {
          this.tradingBusy = false;
          if (r?.ok) {
            this.tradeMessage =
              r.message || `Сделка размещена: ${direction} ${qty} шт`;
          } else {
            this.tradeError = r?.error || 'Не удалось разместить заявку';
          }
          this.tradeExecuted.emit();
        },
        error: (err) => {
          this.tradingBusy = false;
          this.tradeError =
            err?.error?.error || err?.message || 'Не удалось разместить заявку';
          this.tradeExecuted.emit();
        },
      });
  }
}