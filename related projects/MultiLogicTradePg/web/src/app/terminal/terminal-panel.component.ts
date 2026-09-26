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
import { ReferencesService } from '../services/references.service';
import {
  TerminalStateService,
  TerminalLogicSignalEvent,
  TerminalTradeRow,
} from '../services/terminal-state.service';
import {
  ChartIndicatorSeries,
  ChartTradeMarker,
  IndicatorSeriesParamPatch,
  IndicatorValueRow,
  PriceCandle,
  PriceRefreshResult,
  SecurityChartState,
  SecurityIndicatorSeriesRow,
  SecurityRow,
  TimeframeRow,
} from '../models/market.model';
import { IndicatorRow } from '../models/lookup.model';

/** Чип индикатора в правом блоке: назначенный на бумагу или из сигнала логики. */
interface IndicatorChipItem {
  key: string;
  label: string;
  color: string;
  title: string;
  editable: boolean;
  row: SecurityIndicatorSeriesRow | null;
}

/** Элемент подписи под графиком: образец линии (цвет) + название индикатора. */
interface IndicatorLegendItem {
  key: string;
  label: string;
  color: string;
  title: string;
}

/** Сводка позиции полосы для терминала: остаток и рыночная стоимость. */
export interface PanelPositionSummary {
  qty: number;
  marketValue: number;
}

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
  /** История сделок счёта — для маркеров входов на графике. */
  @Input() trades: TerminalTradeRow[] = [];
  /** Сигнал логики: бейдж в шапке + вертикальная линия на графике. */
  @Input() signalEvent: TerminalLogicSignalEvent | null = null;
  /** Индикаторы логики, значения которых показываем на графике полосы. */
  @Input() logicIndicatorIds: number[] = [];
  /** Начальное состояние «свернута» (видна только шапка полосы). */
  @Input() initiallyCollapsed = false;
  /** Счётчик «Закрыть все позиции» — каждая панель закрывает свою позицию. */
  @Input() closeAllPulse = 0;
  /** Адресный импульс «Закрыть по сигналу логики»: закрывает позицию только
      полосы с этой бумагой (терминал получил сигнал/стоп логики по бумаге). */
  @Input() closeSignalPulse: { security_id: number; pulse: number } | null = null;
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
  /** Пользователь свернул/развернул полосу (сохраняем в состоянии терминала). */
  @Output() collapsedChange = new EventEmitter<boolean>();
  /** Сводка позиции: остаток и рыночная стоимость — для суммы по счёту
      (обновляется с каждой новой свечой — меняется текущая цена). */
  @Output() positionSummary = new EventEmitter<PanelPositionSummary>();

  @ViewChild('mainChart') mainChart?: PriceChartComponent;
  @ViewChildren(PriceChartComponent) allCharts?: QueryList<PriceChartComponent>;

  timeframeId: number | null = null;
  /** Полоса свёрнута: видна только шапка (график/сделки скрыты). */
  collapsed = false;
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
  /** Чекбокс под «Купить»: покупка на всю сумму (весь остаток денег). */
  tradeAllSumBuy = false;
  /** Чекбокс под «Продать»: продажа всей позиции бумаги. */
  tradeAllQtySell = false;
  /** Количество из сигнала логики (расчёт лота) — подставлено в блок сделок. */
  private prefillQty: number | null = null;
  /** Сторона, для которой сигнал дал количество (long → buy, short → sell). */
  private prefillSide: 'buy' | 'sell' | null = null;
  tradingBusy = false;
  tradeMessage: string | null = null;
  tradeError: string | null = null;

  /** Серии индикаторов, назначенные на бумагу (строки security_indicator_series). */
  indicatorRows: SecurityIndicatorSeriesRow[] = [];
  /** Готовые серии для отрисовки на графике цены (назначенные терминалу). */
  indicatorChartSeries: ChartIndicatorSeries[] = [];
  /** Серии индикаторов логики (материализованные indicator_values). */
  signalIndicatorChartSeries: ChartIndicatorSeries[] = [];
  /** Что отдаём графику: индикаторы логики (под кастомными сериями). */
  displayIndicatorSeries: ChartIndicatorSeries[] = [];
  /** Каталог индикаторов (справочник, загружается по открытии пикера). */
  indicatorCatalog: IndicatorRow[] = [];
  pendingIndicatorId: number | null = null;
  indicatorPickerOpen = false;
  indicatorAdding = false;
  indicatorBusyMessage: string | null = null;
  indicatorError: string | null = null;
  indicatorCatalogLoading = false;
  private indicatorSyncing = false;
  private indicatorSyncGen = 0;
  private indicatorPollTimer?: ReturnType<typeof setTimeout>;
  /** Загрузка значений индикаторов логики (защита от повторных стартов). */
  private logicSignalLoading = false;
  private logicSignalGen = 0;

  /** Редактирование параметров выбранного индикатора (модальное окно). */
  indicatorEditRowId: number | null = null;
  indicatorEditParams: Record<string, string> = {};
  indicatorEditSaving = false;
  indicatorSaveError: string | null = null;
  readonly indicatorParamFields: { key: string; label: string; step: string }[] = [
    { key: 'param_period', label: 'Период', step: '1' },
    { key: 'param_fast_period', label: 'Быстрый период', step: '1' },
    { key: 'param_slow_period', label: 'Медленный период', step: '1' },
    { key: 'param_signal_period', label: 'Сигнальный период', step: '1' },
    { key: 'param_std_dev', label: 'Ст. отклонение', step: '0.1' },
    { key: 'param_k_period', label: 'K-период', step: '1' },
    { key: 'param_d_period', label: 'D-период', step: '1' },
    { key: 'param_smooth', label: 'Сглаживание', step: '1' },
  ];

  private readonly indicatorSeriesColors = [
    '#2563eb',
    '#9333ea',
    '#ea580c',
    '#0891b2',
    '#ca8a04',
    '#db2777',
    '#059669',
    '#4f46e5',
  ];
  /** Индикаторы с серией VALUE на шкале цены (SMA, EMA, WMA, PACC, SMAT3). */
  private readonly priceScaleOverlayCodes = new Set([
    'SMA',
    'EMA',
    'WMA',
    'PACC',
    'SMAT3',
  ]);

  private pollTimer?: ReturnType<typeof setInterval>;
  /** Идёт живая догрузка свечей — не запускаем следующую, пока не закончилась. */
  private liveBusy = false;
  /** Первые свечи уже сообщены родителю (dataReady эмитится один раз). */
  private dataReadySent = false;
  private subs: Subscription[] = [];
  private destroyed = false;

  constructor(
    private readonly securities: SecuritiesService,
    private readonly stateSvc: TerminalStateService,
    private readonly refs: ReferencesService
  ) {}

  /** Валидация входного таймфрейма панели: число из списка доступных,
      иначе null (панель берёт дефолт M15). */
  private safeInitialTimeframe(v: unknown): number | null {
    const tf = Number(v);
    return Number.isInteger(tf) && tf > 0 && this.timeframes.some((t) => t.id === tf)
      ? tf
      : null;
  }

  ngOnInit(): void {
    this.collapsed = this.initiallyCollapsed;
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
    this.emitPositionSummary();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.indicatorPollTimer) clearTimeout(this.indicatorPollTimer);
    for (const s of this.subs) s.unsubscribe();
  }

  /** При смене счёта сбрасываем максимум на баланс; при живом обновлении
      баланса (без смены счёта) — только пока пользователь не менял вручную. */
  ngOnChanges(changes: SimpleChanges): void {
    if (changes['closeAllPulse'] != null && this.closeAllPulse > 0) {
      /** Импульс «Закрыть все позиции» от терминала: закрываем только свои. */
      if (this.remainingPositionQty !== 0) this.closePosition();
    }
    if (
      changes['closeSignalPulse'] != null &&
      this.closeSignalPulse != null &&
      this.closeSignalPulse.pulse > 0 &&
      this.closeSignalPulse.security_id === this.security.id
    ) {
      /** Адресный импульс от терминала именно по этой бумаге (сигнал/стоп логики). */
      if (this.remainingPositionQty !== 0) this.closePosition();
    }
    if (changes['trades'] != null) {
      /** Терминал перечитал сделки счёта — позиция полосы могла измениться. */
      this.emitPositionSummary();
    }
    if (changes['signalEvent'] != null) {
      this.applySignalPrefill();
    }
    if (changes['signalEvent'] != null || changes['logicIndicatorIds'] != null) {
      this.loadLogicSignalIndicators();
    }
    if (changes['initialTimeframeId'] != null) {
      const tf = this.timeframeId;
      const next = this.safeInitialTimeframe(changes['initialTimeframeId'].currentValue);
      if (next != null && next !== tf) {
        this.timeframeId = next;
        this.loadChart();
        this.emitStateChange();
        return;
      }
    }
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
    if (!(p > 0)) return 0;
    // Отображение: если включён «весь остаток» и есть позиция — она;
    // если «на всю сумму» — максимум по деньгам (покупка).
    if (this.tradeAllQtySell && this.remainingPositionQty > 0) {
      return this.remainingPositionQty;
    }
    if (this.tradeAllSumBuy) {
      return this.effectiveMaxSum > 0 ? Math.floor(this.effectiveMaxSum / p) : 0;
    }
    // Расчёт лота логики из сигнала (пока пользователь не начал двигать ползунок).
    if (this.prefillQty != null) return this.prefillQty;
    if (!(this.tradeAmount > 0)) return 0;
    return Math.floor(this.tradeAmount / p);
  }

  /** Остаток позиции по текущей бумаге на счёте (filled покупки − продажи).
      Отрицательное значение — «шорт»: продали больше, чем купили. */
  get remainingPositionQty(): number {
    let qty = 0;
    for (const t of this.trades) {
      if (t.security_id !== this.security.id || t.status !== 'filled') continue;
      qty += t.direction === 'BUY' ? Number(t.quantity) : -Number(t.quantity);
    }
    return Number.isFinite(qty) ? qty : 0;
  }

  /** Фактические деньги, вложенные в текущий остаток: сумма покупок
      (цена × количество) минус сумма продаж. «По ценам покупок остаток,
      минус цены продаж» — хранится у нас в сделках, берём оттуда. */
  get remainingPositionCost(): number {
    let cost = 0;
    for (const t of this.trades) {
      if (t.security_id !== this.security.id || t.status !== 'filled') continue;
      const p = Number(t.price);
      const q = Number(t.quantity);
      if (!(Number.isFinite(p) && p >= 0 && Number.isFinite(q) && q > 0)) continue;
      cost += t.direction === 'BUY' ? p * q : -p * q;
    }
    return Number.isFinite(cost) ? cost : 0;
  }

  /** Средняя цена входа в остаток: фактические вложенные деньги / остаток.
      Для шорта — средняя цена продажи (деньги получены, cost отрицательный). */
  get remainingPositionAvgPrice(): number {
    const qty = this.remainingPositionQty;
    if (qty === 0) return 0;
    const cost = this.remainingPositionCost;
    return cost !== 0 ? cost / qty : 0;
  }

  /** Разница в деньгах по всему остатку.
      Лонг: текущая рыночная стоимость остатка − фактические деньги по ценам
      покупок; положительная — в плюсе (зелёная), отрицательная — в минусе (красная).
      Шорт: полученные за продажу деньги − текущая стоимость выкупа остатка;
      положительная — в плюсе (зелёная, цена упала), отрицательная — в минусе (красная). */
  get remainingPositionDiff(): number {
    const qty = this.remainingPositionQty;
    if (qty === 0) return 0;
    const p = this.currentPrice;
    if (!(p > 0)) return 0;
    if (qty > 0) {
      const marketValue = p * qty;
      const cost = this.remainingPositionCost;
      if (!(marketValue > 0) || !(cost > 0)) return 0;
      return Math.round((marketValue - cost) * 100) / 100;
    }
    const proceeds = this.remainingPositionCost;
    if (proceeds >= 0) return 0;
    const repurchaseCost = Math.abs(p * qty);
    return Math.round((-proceeds - repurchaseCost) * 100) / 100;
  }

  /** То же в процентах от фактических денег, вложенных в остаток
      (для шорта — от полученных за продажу денег). */
  get remainingPositionDiffPct(): number {
    const qty = this.remainingPositionQty;
    if (qty === 0) return 0;
    const base = qty > 0 ? this.remainingPositionCost : -this.remainingPositionCost;
    if (!(base > 0)) return 0;
    return Math.round((this.remainingPositionDiff / base) * 10000) / 100;
  }

  /** Деньги по остатку: для лонга — вложенные при покупке, для шорта —
      полученные при продаже (всегда положительное число для показа). */
  get remainingPositionBaseAmount(): number {
    const qty = this.remainingPositionQty;
    if (qty === 0) return 0;
    const cost = this.remainingPositionCost;
    return qty > 0 ? Math.max(cost, 0) : Math.max(-cost, 0);
  }

  /** Рыночная стоимость остатка по текущей цене последней свечи:
      для лонга — сколько стоят бумаги сейчас, для шорта — сколько стоит
      выкуп объёма сейчас (всегда положительное число). */
  get remainingPositionMarketValue(): number {
    const qty = this.remainingPositionQty;
    if (qty === 0) return 0;
    const p = this.currentPrice;
    if (!(p > 0)) return 0;
    return Math.round(Math.abs(qty) * p * 100) / 100;
  }

  /** Сообщить терминалу сводку позиции: остаток и рыночную стоимость.
      Вызывается при изменении сделок, свечей (цена меняется с каждой новой
      свечой) — терминал копит и суммирует по всем полосам для шапки счёта. */
  emitPositionSummary(): void {
    this.positionSummary.emit({
      qty: this.remainingPositionQty,
      marketValue: this.remainingPositionMarketValue,
    });
  }

  /** Фактическое количество для заявки: при чекбоксе «на всю сумму» покупка
      идёт на весь остаток денег, при «весь остаток» продажа — вся позиция. */
  private resolveTradeQuantity(direction: 'buy' | 'sell'): number {
    const p = this.currentPrice;
    if (!(p > 0)) return 0;
    if (direction === 'sell' && this.tradeAllQtySell) {
      return this.remainingPositionQty;
    }
    if (direction === 'buy' && this.tradeAllSumBuy) {
      return this.effectiveMaxSum > 0 ? Math.floor(this.effectiveMaxSum / p) : 0;
    }
    if (this.tradeAllQtySell) return this.remainingPositionQty;
    if (this.tradeAllSumBuy) {
      return this.effectiveMaxSum > 0 ? Math.floor(this.effectiveMaxSum / p) : 0;
    }
    // Количество из сигнала (расчёт лота логики) — для стороны сигнала.
    if (this.prefillQty != null && this.prefillSide === direction) {
      return this.prefillQty;
    }
    return this.tradeAmount > 0 ? Math.floor(this.tradeAmount / p) : 0;
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

  /** Маркеры сигнала логики: вертикальная полоса + треугольник входа.
      Дополняются маркерами сделок терминала (см. tradeMarkers). */
  get signalMarkers(): ChartTradeMarker[] {
    const ev = this.signalEvent;
    if (!ev || !ev.bar_dt) return [];
    const p = Number(ev.price);
    if (!Number.isFinite(p) || p <= 0) return [];
    // Маркер сигнала/сделки ставим НА свечу закрытия бара сигнала (bar_dt) и
    // оставляем на ней же, даже когда справа дорисовываются новые свечи:
    // маркер не должен «уезжать в самый конец» при каждом обновлении цен.
    return [
      {
        dt: ev.bar_dt,
        price: p,
        kind: 'open' as const,
        side: ev.position_side === 'short' ? ('short' as const) : ('long' as const),
      },
    ];
  }

  /** Все маркеры графика: при активном сигнале — сигнальная линия/треугольник
      и сделки ПОСЛЕ бара сигнала (предыдущие сделки на графике не показываем);
      без сигнала — все сделки счёта. */
  get allTradeMarkers(): ChartTradeMarker[] {
    const sig = this.signalEvent;
    if (!sig) return this.tradeMarkers;
    const sinceTs = sig.bar_dt ? new Date(sig.bar_dt).getTime() : NaN;
    const current = this.tradeMarkers.filter((m) => {
      const ts = new Date(m.dt).getTime();
      return Number.isFinite(ts) && Number.isFinite(sinceTs) && ts >= sinceTs;
    });
    return [...this.signalMarkers, ...current];
  }

  /** Текст бейджа сигнала в шапке полосы (покупка/продажа по позиции). */
  get signalLabel(): string {
    const ev = this.signalEvent;
    if (ev?.label) return ev.label;
    return ev?.position_side === 'short' ? 'продажа' : 'покупка';
  }

  /** Кнопка сигнала в шапке: сторона, которую диктует сигнал логики
      (short → продажа, иначе покупка). */
  get signalSide(): 'buy' | 'sell' {
    return this.signalEvent?.position_side === 'short' ? 'sell' : 'buy';
  }

  /** Количество для кнопки сигнала: тот же расчёт, что у кнопок «Купить»/
      «Продать» в блоке «Сделки» (из той же формулы — лот логики или
      сумма ÷ цена). */
  get signalQuantity(): number {
    if (this.signalEvent == null || this.priceMissing) return 0;
    return this.resolveTradeQuantity(this.signalSide);
  }

  /** Подпись в подсказке кнопки сигнала в шапке. */
  get signalBtnTitle(): string {
    const base = this.signalBadgeTitle || 'Сигнал логики';
    const dir = this.signalSide === 'sell' ? 'продажу' : 'покупку';
    const qty = this.signalQuantity;
    const qtyPart = qty > 0 ? ` на ${qty} шт` : '; задайте сумму в шапке';
    return `${base} — выполнить ${dir}${qtyPart} по текущей цене`;
  }

  /** Подпись в подсказке бейджа: логика, бар и таймфрейм сигнала. */
  get signalBadgeTitle(): string {
    const ev = this.signalEvent;
    if (!ev) return '';
    const name = ev.logic_name || `Логика #${ev.logic_id}`;
    const tfPart = ev.timeframe ? `, таймфрейм ${ev.timeframe}` : '';
    if (!ev.bar_dt) return `Сигнал логики «${name}»${tfPart}`;
    const d = new Date(ev.bar_dt);
    const dtLabel = Number.isNaN(d.getTime())
      ? ev.bar_dt
      : d.toLocaleString('ru-RU');
    return `Сигнал логики «${name}» от ${dtLabel}${tfPart}`;
  }

  /** Сколько времени прошло с подачи сигнала (по бару сигнала): только что /
      секунды / минуты / часы / дни назад по-русски. Пусто — времени нет. */
  get signalTimeAgo(): string {
    const ev = this.signalEvent;
    if (!ev?.bar_dt) return '';
    const t = new Date(ev.bar_dt).getTime();
    if (!Number.isFinite(t)) return '';
    const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (sec < 5) return 'только что';
    if (sec < 60) {
      return this.pluralWord(sec, 'секунду назад', 'секунды назад', 'секунд назад');
    }
    const min = Math.floor(sec / 60);
    if (min < 60) return this.pluralWord(min, 'минуту назад', 'минуты назад', 'минут назад');
    const hours = Math.floor(min / 60);
    if (hours < 48) return this.pluralWord(hours, 'час назад', 'часа назад', 'часов назад');
    const days = Math.floor(hours / 24);
    return this.pluralWord(days, 'день назад', 'дня назад', 'дней назад');
  }

  /** Русское склонение количества: 1 минуту, 2 минуты, 5 минут. */
  private pluralWord(n: number, one: string, few: string, many: string): string {
    const n10 = n % 10;
    const n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return `${n} ${one}`;
    if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return `${n} ${few}`;
    return `${n} ${many}`;
  }

  /** Хинт бара полосы при наведении: какой логикой подан сигнал и сколько
      времени прошло (секунды/минуты/часы/дни назад). */
  get signalBarHint(): string {
    const ev = this.signalEvent;
    if (!ev) return '';
    const ago = this.signalTimeAgo;
    const base = this.signalBadgeTitle;
    return ago ? `${base}. Подано ${ago}` : base;
  }

  /** Маркеры входов на графике: покупка — зелёный треугольник (long),
      продажа — красный (short), с вертикальной полосой (см. drawTradeMarkers). */
  get tradeMarkers(): ChartTradeMarker[] {
    return this.trades
      .filter(
        (t) =>
          t.security_id === this.security.id &&
          t.status === 'filled' &&
          Number.isFinite(Number(t.price)) &&
          Number(t.price) > 0
      )
      .map((t) => ({
        dt: t.executed_at,
        price: Number(t.price),
        kind: 'open' as const,
        side: t.direction === 'SELL' ? ('short' as const) : ('long' as const),
      }));
  }

  get indicatorEditRow(): SecurityIndicatorSeriesRow | null {
    return this.indicatorRows.find((r) => r.id === this.indicatorEditRowId) ?? null;
  }

  /** Индикатор уже назначен на бумагу (для блокировки в пикере). */
  isIndicatorAssigned(indicatorId: number): boolean {
    return this.indicatorRows.some((r) => r.indicator_id === indicatorId);
  }

  /** Чипы блока индикаторов: назначенные на бумагу (можно менять параметры,
      удалять) и индикаторы логики из сигнала (информация о линиях). */
  indicatorChips(): IndicatorChipItem[] {
    const chips: IndicatorChipItem[] = [];
    const byInd = new Map<number, SecurityIndicatorSeriesRow[]>();
    for (const r of this.indicatorRows) {
      const list = byInd.get(r.indicator_id) ?? [];
      list.push(r);
      byInd.set(r.indicator_id, list);
    }
    let manualIdx = 0;
    for (const [indicator_id, rows] of byInd.entries()) {
      const code = rows[0].indicator_code;
      chips.push({
        key: `m:${indicator_id}`,
        label: rows.length > 1 ? `${code} ×${rows.length}` : code,
        color:
          this.chipColorForCode(this.indicatorChartSeries, code) ??
          this.indicatorSeriesColors[manualIdx % this.indicatorSeriesColors.length],
        title: rows[0].indicator_name || code,
        editable: true,
        row: rows[0],
      });
      manualIdx += 1;
    }
    const byCode = new Map<string, ChartIndicatorSeries[]>();
    for (const s of this.signalIndicatorChartSeries) {
      const list = byCode.get(s.indicator_code) ?? [];
      list.push(s);
      byCode.set(s.indicator_code, list);
    }
    for (const [code, lines] of byCode.entries()) {
      chips.push({
        key: `s:${code}`,
        label: lines.length > 1 ? `${code} ×${lines.length}` : code,
        color: lines[0].color,
        title: `Индикатор логики — ${code}`,
        editable: false,
        row: null,
      });
    }
    return chips;
  }

  /** Цвет первой линии индикатора (по коду) среди подготовленных серий. */
  private chipColorForCode(
    series: ChartIndicatorSeries[],
    code: string
  ): string | null {
    const s = series.find((x) => x.indicator_code === code);
    return s ? s.color : null;
  }

  /** Подписи под графиком: на каждую линию индикатора — образец (цвет) и название.
      Первая линия индикатора подписана кодом, остальные — код + имя линии. */
  indicatorLegendItems(): IndicatorLegendItem[] {
    const seen = new Set<string>();
    const items: IndicatorLegendItem[] = [];
    for (const s of this.displayIndicatorSeries) {
      const first = !seen.has(s.indicator_code);
      seen.add(s.indicator_code);
      items.push({
        key: `${s.indicator_code}:${s.line_code}`,
        label: first ? s.indicator_code : `${s.indicator_code} ${s.line_code}`,
        color: s.color,
        title: s.line_name || s.indicator_code,
      });
    }
    return items;
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
        this.refreshIndicatorsForChart();
        this.loadLogicSignalIndicators();
        this.emitPositionSummary();
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
        this.refreshIndicatorValues();
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
          this.emitPositionSummary();
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
          this.refreshIndicatorValues();
        },
        error: () => {
          this.chartState = { ...this.chartState, loadingOlder: false };
        },
      })
    );
  }

  /* Индикаторы на графике: добавленные пользователем в терминале серии,
     расчёт по текущему таймфрейму (sync в фоне + опрос значений)
     и отрисовка на графике цены. По умолчанию список пуст — только кнопка
     «+ Добавить индикатор»; назначенные в «Бумагах» серии в терминал
     не подгружаются. */

  /** Свечи поменялись/таймфрейм сменился — пересчитываем значения индикаторов. */
  private refreshIndicatorsForChart(): void {
    if (!this.security || !this.timeframeId) return;
    if (this.indicatorRows.length === 0 || this.chartState.candles.length === 0) {
      return;
    }
    this.syncIndicators(null);
  }

  /** Открыть форму выбора индикатора (отдельная модалка). */
  openIndicatorPicker(): void {
    this.indicatorPickerOpen = true;
    this.indicatorError = null;
    if (this.indicatorCatalog.length === 0) {
      this.loadIndicatorCatalog();
    }
  }

  /** Закрыть форму выбора индикатора. */
  closeIndicatorPicker(): void {
    this.indicatorPickerOpen = false;
    this.pendingIndicatorId = null;
    this.indicatorError = null;
  }

  private loadIndicatorCatalog(): void {
    if (this.indicatorCatalogLoading) return;
    this.indicatorCatalogLoading = true;
    this.subs.push(
      this.refs.getIndicators(true).subscribe({
        next: (list) => {
          this.indicatorCatalog = list;
          this.indicatorCatalogLoading = false;
        },
        error: () => {
          this.indicatorCatalogLoading = false;
          this.indicatorError = 'Не удалось загрузить справочник индикаторов';
        },
      })
    );
  }

  /** Добавить индикатор из пикера: временные строки сразу, серии — по ответу. */
  onAddIndicator(indicatorId: number | null): void {
    if (indicatorId == null || this.indicatorAdding) return;
    const ind = this.indicatorCatalog.find((i) => i.id === indicatorId);
    if (!ind) return;
    if (this.indicatorRows.some((r) => r.indicator_id === indicatorId)) {
      this.indicatorError = `«${ind.code}» уже добавлен на график`;
      return;
    }
    this.indicatorAdding = true;
    this.indicatorPickerOpen = false;
    this.pendingIndicatorId = null;
    this.indicatorError = null;
    const pending = this.buildPendingIndicatorRows(ind);
    this.indicatorRows = [...this.indicatorRows, ...pending];
    this.subs.push(
      this.securities
        .assignIndicatorSeries(this.security.id, indicatorId, this.timeframeId ?? undefined)
        .subscribe({
          next: (created) => {
            this.indicatorAdding = false;
            const pendingIds = new Set(pending.map((p) => p.id));
            const merged = this.indicatorRows.filter((r) => !pendingIds.has(r.id));
            for (const s of created) {
              if (!merged.some((x) => x.id === s.id)) merged.push(s);
            }
            merged.sort((a, b) => a.display_order - b.display_order || a.id - b.id);
            this.indicatorRows = merged;
            this.syncIndicators(indicatorId);
          },
          error: (err) => {
            this.indicatorAdding = false;
            const pendingIds = new Set(pending.map((p) => p.id));
            this.indicatorRows = this.indicatorRows.filter(
              (r) => !pendingIds.has(r.id)
            );
            this.indicatorError =
              err?.error?.error || err?.message || 'Не удалось добавить индикатор';
          },
        })
    );
  }

  /** Временные строки (отрицательный id) — сразу в UI до ответа POST. */
  private buildPendingIndicatorRows(ind: IndicatorRow): SecurityIndicatorSeriesRow[] {
    const types = (ind.value_types ?? []).filter((t) => !t.is_threshold);
    const series =
      types.length > 0
        ? types
        : [{ code: 'VALUE', display_order: 1 }];
    return series.map((vt, idx) => ({
      id: -(ind.id * 100 + idx + 1),
      security_id: this.security.id,
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

  /** Удалить индикатор с бумаги. */
  removeIndicator(rowId: number): void {
    this.subs.push(
      this.securities.removeIndicatorSeries(rowId).subscribe({
        next: () => {
          this.indicatorRows = this.indicatorRows.filter((r) => r.id !== rowId);
          if (this.indicatorEditRowId === rowId) this.indicatorEditRowId = null;
          if (this.indicatorRows.length === 0) {
            this.indicatorChartSeries = [];
            this.recomposeIndicatorSeries();
            return;
          }
          this.refreshIndicatorValues();
        },
        error: (err) => {
          this.indicatorError =
            err?.error?.error || err?.message || 'Не удалось удалить индикатор';
        },
      })
    );
  }

  /** Открыть модалку параметров индикатора (предзаполнены текущие значения). */
  openEditParams(row: SecurityIndicatorSeriesRow): void {
    this.indicatorEditRowId = row.id;
    this.indicatorEditSaving = false;
    this.indicatorSaveError = null;
    this.indicatorEditParams = {};
    const values = row as unknown as Record<string, unknown>;
    for (const f of this.indicatorParamFields) {
      const v = values[f.key];
      this.indicatorEditParams[f.key] =
        v == null || v === '' ? '' : String(v);
    }
  }

  closeEditParams(): void {
    if (this.indicatorEditSaving) return;
    this.indicatorEditRowId = null;
    this.indicatorEditParams = {};
    this.indicatorSaveError = null;
  }

  /** Сохранить параметры: PUT обновляет все серии индикатора на бумаге. */
  saveEditParams(): void {
    const rep = this.indicatorEditRow;
    if (!rep || this.indicatorEditSaving) return;
    const patch: Record<string, number> = {};
    let has = false;
    for (const f of this.indicatorParamFields) {
      const raw = (this.indicatorEditParams[f.key] ?? '').trim();
      if (raw === '') continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        this.indicatorSaveError = `${f.label} — не число`;
        return;
      }
      if (f.key === 'param_std_dev') {
        if (n < 0) {
          this.indicatorSaveError = `${f.label} не может быть отрицательным`;
          return;
        }
      } else if (!Number.isInteger(n) || n < 1) {
        this.indicatorSaveError = `${f.label} — целое число не меньше 1`;
        return;
      }
      patch[f.key] = n;
      has = true;
    }
    if (!has) {
      this.indicatorEditRowId = null;
      this.indicatorEditParams = {};
      return;
    }
    this.indicatorEditSaving = true;
    this.indicatorSaveError = null;
    this.subs.push(
      this.securities
        .updateIndicatorSeriesParams(rep.id, patch as IndicatorSeriesParamPatch)
        .subscribe({
          next: (updated) => {
            this.indicatorEditSaving = false;
            if (updated.length === 0) {
              this.indicatorEditRowId = null;
              this.indicatorEditParams = {};
              this.indicatorError = 'Индикатор больше не доступен на этой бумаге';
              return;
            }
            const updIndicatorId = updated[0].indicator_id;
            this.indicatorRows = this.indicatorRows
              .filter((r) => r.indicator_id !== updIndicatorId)
              .concat(updated)
              .sort((a, b) => a.display_order - b.display_order || a.id - b.id);
            this.indicatorEditRowId = null;
            this.indicatorEditParams = {};
            this.syncIndicators(updIndicatorId);
          },
          error: (err) => {
            this.indicatorEditSaving = false;
            this.indicatorSaveError =
              err?.error?.error || err?.message || 'Не удалось сохранить параметры';
          },
        })
    );
  }

  /** Фоновая синхронизация значений индикаторов за видимым окном свечей. */
  private syncIndicators(indicatorId: number | null): void {
    if (this.indicatorSyncing || !this.security || !this.timeframeId) return;
    const candles = this.chartState.candles;
    if (!candles.length) return;
    this.indicatorSyncing = true;
    this.indicatorBusyMessage = 'Пересчёт индикаторов…';
    const gen = ++this.indicatorSyncGen;
    const body: Parameters<SecuritiesService['syncIndicatorSeries']>[0] = {
      security_id: this.security.id,
      timeframe_id: this.timeframeId,
      end_dt: candles[candles.length - 1].dt,
      point_count: Math.min(Math.max(candles.length, 1), 4000),
      incremental: true,
    };
    if (indicatorId != null) body.indicator_id = indicatorId;
    this.subs.push(
      this.securities.syncIndicatorSeries(body).subscribe({
        next: () => this.pollIndicatorValues(gen, indicatorId, 0),
        error: (err) => {
          if (gen !== this.indicatorSyncGen) return;
          this.indicatorSyncing = false;
          this.indicatorBusyMessage = null;
          this.indicatorError =
            err?.error?.error || err?.message || 'Не удалось запустить пересчёт индикатора';
        },
      })
    );
  }

  /** Ожидание значений: опрашиваем indicator_values до появления точек. */
  private pollIndicatorValues(
    gen: number,
    indicatorId: number | null,
    attempt: number
  ): void {
    if (gen !== this.indicatorSyncGen || this.destroyed || !this.timeframeId) {
      return;
    }
    const candles = this.chartState.candles;
    if (!candles.length) {
      this.indicatorSyncing = false;
      this.indicatorBusyMessage = null;
      return;
    }
    if (this.indicatorPollTimer) clearTimeout(this.indicatorPollTimer);
    const waitMs = attempt === 0 ? 400 : attempt < 5 ? 700 : 1500;
    this.indicatorPollTimer = setTimeout(() => {
      if (this.destroyed || !this.timeframeId) return;
      const allIds = this.indicatorIds();
      this.subs.push(
        this.securities
          .getIndicatorValues(
            this.security.id,
            this.timeframeId,
            allIds,
            candles[0].dt,
            candles[candles.length - 1].dt
          )
          .subscribe({
            next: (values) => {
              if (gen !== this.indicatorSyncGen) return;
              if (values.length === 0) {
                if (attempt < 20) {
                  this.pollIndicatorValues(gen, indicatorId, attempt + 1);
                  return;
                }
                this.indicatorSyncing = false;
                this.indicatorBusyMessage = null;
                this.indicatorError =
                  indicatorId != null
                    ? 'Индикатор не рассчитался за отведённое время'
                    : null;
                return;
              }
              this.indicatorSyncing = false;
              this.indicatorBusyMessage = null;
              this.indicatorError = null;
              this.indicatorChartSeries = this.buildChartSeries(
                values,
                this.indicatorRows
              );
              this.recomposeIndicatorSeries();
            },
            error: () => {
              if (gen !== this.indicatorSyncGen) return;
              if (attempt < 20) {
                this.pollIndicatorValues(gen, indicatorId, attempt + 1);
                return;
              }
              this.indicatorSyncing = false;
              this.indicatorBusyMessage = null;
            },
          })
      );
    }, waitMs);
  }

  /** Все id индикаторов, назначенных на бумагу. */
  private indicatorIds(): number[] {
    return [...new Set(this.indicatorRows.map((r) => r.indicator_id))];
  }

  /** Прямое чтение значений (без пересчёта) для текущего окна свечей. */
  private refreshIndicatorValues(): void {
    if (!this.security || !this.timeframeId || this.indicatorRows.length === 0) {
      return;
    }
    const candles = this.chartState.candles;
    if (!candles.length) return;
    const ids = this.indicatorIds();
    this.subs.push(
      this.securities
        .getIndicatorValues(
          this.security.id,
          this.timeframeId,
          ids,
          candles[0].dt,
          candles[candles.length - 1].dt
        )
        .subscribe({
          next: (values) => {
            if (values.length) {
              this.indicatorChartSeries = this.buildChartSeries(
                values,
                this.indicatorRows
              );
              this.recomposeIndicatorSeries();
            }
          },
          error: () => undefined,
        })
    );
  }

  /** Серии для графика: группировка значений по линиям в порядке назначения. */
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
    const sortedKeys = [...groups.keys()].sort(
      (a, b) => (orderMap.get(a) ?? 0) - (orderMap.get(b) ?? 0)
    );
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
        color: this.indicatorSeriesColors[
          colorIdx % this.indicatorSeriesColors.length
        ],
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

  /** Индикаторы логики, чьи значения уже рассчитаны (материализованы в
      indicator_values под таймфреймом логики): читаем напрямую без пересчёта. */
  private loadLogicSignalIndicators(): void {
    if (
      !this.security ||
      !this.timeframeId ||
      this.logicIndicatorIds.length === 0 ||
      this.chartState.candles.length === 0 ||
      this.logicSignalLoading
    ) {
      this.recomposeIndicatorSeries();
      return;
    }
    this.logicSignalLoading = true;
    const candles = this.chartState.candles;
    const gen = ++this.logicSignalGen;
    this.subs.push(
      this.securities
        .getIndicatorValues(
          this.security.id,
          this.timeframeId,
          this.logicIndicatorIds,
          candles[0].dt,
          candles[candles.length - 1].dt
        )
        .subscribe({
          next: (values) => {
            if (gen !== this.logicSignalGen) return;
            this.logicSignalLoading = false;
            this.signalIndicatorChartSeries = values.length
              ? this.buildChartSeries(values, [])
              : [];
            this.recomposeIndicatorSeries();
          },
          error: () => {
            if (gen !== this.logicSignalGen) return;
            this.logicSignalLoading = false;
            this.signalIndicatorChartSeries = [];
            this.recomposeIndicatorSeries();
          },
        })
    );
  }

  /** Что отдаём графику: индикаторы логики снизу, назначенные терминалу сверху. */
  private recomposeIndicatorSeries(): void {
    this.displayIndicatorSeries = [
      ...this.signalIndicatorChartSeries,
      ...this.indicatorChartSeries,
    ];
  }

  /** Серия на шкале цены: наложенные (SMA, EMA, WMA, PACC, SMAT3) и канальные. */
  private isPriceScaleSeries(indicatorCode: string, lineCode: string): boolean {
    if (this.priceScaleOverlayCodes.has(indicatorCode) && lineCode === 'VALUE') {
      return true;
    }
    return ['UPPER', 'MIDDLE', 'LOWER'].includes(lineCode);
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

  /** Переключение сворачивания полосы (кнопка-треугольник слева в шапке). */
  toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    this.collapsedChange.emit(this.collapsed);
  }

  /** Подстановка количества/суммы из сигнала (расчёт лота логики) в блок сделок,
      чтобы осталось нажать «Купить»/«Продать». Сбрасывается движением ползунка. */
  private applySignalPrefill(): void {
    const ev = this.signalEvent;
    if (!ev) {
      this.prefillQty = null;
      this.prefillSide = null;
      return;
    }
    const qty = ev.suggested_quantity;
    const amount = ev.suggested_amount;
    if (qty == null || qty <= 0 || amount == null || amount <= 0) {
      this.prefillQty = null;
      this.prefillSide = null;
      return;
    }
    this.prefillQty = Math.floor(Number(qty));
    this.prefillSide = ev.position_side === 'short' ? 'sell' : 'buy';
    // Слайдер поднимаем до предложенной суммы, чтобы количество и сумма
    // (лот × цена) были видны целиком, а заявка уходила по расчёту логики.
    this.tradeMaxInput = Math.max(this.effectiveMaxSum, Math.ceil(Number(amount)));
    this.tradeAmount = Math.round(Number(amount));
  }

  /** Слайдер имеет приоритет: как только пользователь двигает ползунок —
      чекбоксы «на всю сумму»/«весь остаток» снимаются, количество из сигнала
      сбрасывается, а количество/сумма подстраиваются под выбранную сумму. */
  onTradeAmountChange(value?: number): void {
    this.tradeAmount =
      value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0;
    this.prefillQty = null;
    this.prefillSide = null;
    this.tradeMessage = null;
    this.tradeError = null;
    if (this.tradeAllSumBuy) this.tradeAllSumBuy = false;
    if (this.tradeAllQtySell) this.tradeAllQtySell = false;
  }

  /** Ввод суммы в шапке (компактный импут у кнопки сигнала): те же принципы,
      что у ползунка блока «Сделки» — сумма в пределах максимума, количество из
      сигнала сбрасывается (счёт идёт от «сумма ÷ цена»). */
  onSignalAmountEdit(value?: number): void {
    let v = Math.floor(Number(value));
    if (!Number.isFinite(v) || v < 0) v = 0;
    const max = this.effectiveMaxSum;
    if (v > max) v = max;
    this.onTradeAmountChange(v);
  }

  /** Чекбокс «на всю сумму»: слайдер перемещается на максимум по деньгам. */
  onTradeAllSumBuyChange(): void {
    if (this.tradeAllSumBuy) {
      this.tradeAllQtySell = false;
      const max = this.effectiveMaxSum;
      this.tradeAmount = max;
      if (max <= 0) this.tradeAllSumBuy = false;
    }
    this.tradeMessage = null;
    this.tradeError = null;
  }

  /** Чекбокс «весь остаток»: слайдер перемещается на сумму всей позиции. */
  onTradeAllQtySellChange(): void {
    if (this.tradeAllQtySell) {
      this.tradeAllSumBuy = false;
      const qty = this.remainingPositionQty;
      const p = this.currentPrice;
      if (qty < 1 || !(p > 0)) {
        this.tradeAllQtySell = false;
      } else {
        this.tradeAmount = Math.round(qty * p * 100) / 100;
      }
    }
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
    const qty = this.resolveTradeQuantity(direction);
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

  /** Кнопка «Закрыть позиции» в шапке: закрыть всю позицию по бумаге
      целиком — продать остаток при покупках или выкупить весь объём при
      продажах (шорт), чтобы количество стало нулевым. Маркет-заявка. */
  closePosition(): void {
    this.tradeMessage = null;
    this.tradeError = null;
    const qty = this.remainingPositionQty;
    if (qty === 0) {
      this.tradeError = 'Нет открытой позиции по этой бумаге';
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
    const direction: 'buy' | 'sell' = qty > 0 ? 'sell' : 'buy';
    const quantity = Math.abs(qty);
    this.tradingBusy = true;
    this.stateSvc
      .placeTrade({
        account_id: this.accountId,
        security_id: this.security.id,
        direction,
        execution: 'market',
        price,
        quantity,
      })
      .subscribe({
        next: (r) => {
          this.tradingBusy = false;
          if (r?.ok) {
            this.tradeMessage =
              r.message || `Позиция закрыта: ${direction} ${quantity} шт`;
          } else {
            this.tradeError = r?.error || 'Не удалось закрыть позицию';
          }
          this.tradeExecuted.emit();
        },
        error: (err) => {
          this.tradingBusy = false;
          this.tradeError =
            err?.error?.error || err?.message || 'Не удалось закрыть позицию';
          this.tradeExecuted.emit();
        },
      });
  }
}