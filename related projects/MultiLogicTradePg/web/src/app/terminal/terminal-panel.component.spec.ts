import {
  ComponentFixture,
  TestBed,
  fakeAsync,
  tick,
  discardPeriodicTasks,
} from '@angular/core/testing';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { By } from '@angular/platform-browser';
import { registerLocaleData } from '@angular/common';
import localeRu from '@angular/common/locales/ru';
import { of, throwError } from 'rxjs';
import { TerminalPanelComponent } from './terminal-panel.component';

// Шаблон полосы форматирует суммы пайпом `| number : '…' : 'ru'` — данные
// локали для юнит-тестов (в приложении это делает app.config.ts).
registerLocaleData(localeRu, 'ru');
import { SecuritiesService } from '../services/securities.service';
import { ReferencesService } from '../services/references.service';
import { TechLogService } from '../services/tech-log.service';
import {
  TerminalStateService,
  TerminalTradeRow,
} from '../services/terminal-state.service';
import {
  SecurityIndicatorSeriesRow,
  SecurityRow,
  TimeframeRow,
} from '../models/market.model';

describe('TerminalPanelComponent', () => {
  let component: TerminalPanelComponent;
  let fixture: ComponentFixture<TerminalPanelComponent>;
  let securities: jasmine.SpyObj<SecuritiesService>;
  let stateSvc: jasmine.SpyObj<TerminalStateService>;
  let refs: jasmine.SpyObj<ReferencesService>;

  const sberRow: SecurityRow = {
    id: 29,
    name: 'SBER',
    security_type: 'Stock',
    prefix: 'SBER',
    instrument_market: 'stock',
    exchange_id: 1,
    exchange_name: 'MOEX',
  };

  const timeframes: TimeframeRow[] = [
    { id: 6, tf: 'M15', full_name: '15 min', sec: 900, is_active: true },
    { id: 5, tf: 'H1', full_name: '60 min', sec: 3600, is_active: true },
  ];

  const smaSeries: SecurityIndicatorSeriesRow = {
    id: 1,
    security_id: 29,
    indicator_id: 7,
    series_code: 'VALUE',
    invoke_formula: 'sma(20)',
    indicator_code: 'SMA',
    indicator_name: 'SMA',
    param_period: 20,
    point_count: 100,
    display_order: 1,
    is_active: true,
  };

  const trade = (
    id: number,
    over: Partial<TerminalTradeRow>
  ): TerminalTradeRow => ({
    id,
    account_id: 1,
    security_id: 29,
    direction: 'BUY',
    execution: 'market',
    quantity: 10,
    price: 250,
    amount: 2500,
    commission: 0,
    status: 'filled',
    broker_order_id: null,
    note: null,
    executed_at: '2026-09-19T10:15:00',
    security_name: 'SBER',
    security_prefix: 'SBER',
    ...over,
  });

  beforeEach(async () => {
    securities = jasmine.createSpyObj('SecuritiesService', [
      'getPrices',
      'getSecurityIndicatorSeries',
      'syncIndicatorSeries',
      'assignIndicatorSeries',
      'removeIndicatorSeries',
      'updateIndicatorSeriesParams',
      'getIndicatorValues',
      'refreshPrices',
    ]);
    securities.getPrices.and.returnValue(of([]));
    securities.refreshPrices.and.returnValue(of({ ok: true }));
    securities.getSecurityIndicatorSeries.and.returnValue(of([]));
    securities.syncIndicatorSeries.and.returnValue(of({ ok: true }));
    securities.assignIndicatorSeries.and.returnValue(of([]));
    securities.removeIndicatorSeries.and.returnValue(of({ ok: true }));
    securities.updateIndicatorSeriesParams.and.returnValue(
      of([{ ...smaSeries, param_period: 30 }])
    );
    securities.getIndicatorValues.and.returnValue(of([]));

    stateSvc = jasmine.createSpyObj('TerminalStateService', ['placeTrade']);
    stateSvc.placeTrade.and.returnValue(of({ ok: true, mode: 'fake' }));
    refs = jasmine.createSpyObj('ReferencesService', ['getIndicators']);
    refs.getIndicators.and.returnValue(of([]));

    const techLog = jasmine.createSpyObj('TechLogService', [
      'setEnabled',
      'newTraceId',
      'threadKey',
      'start',
      'end',
      'event',
      'fetchRecent',
    ]);
    techLog.enabled = false;
    techLog.newTraceId.and.returnValue('trace-test');
    techLog.threadKey.and.callFake((_s: number, g?: number, suffix?: string) =>
      suffix ? `sec:main:${suffix}` : `sec:main:gen:${g ?? 0}`
    );
    techLog.start.and.returnValue('span-test');

    await TestBed.configureTestingModule({
      imports: [TerminalPanelComponent],
      providers: [
        { provide: SecuritiesService, useValue: securities },
        { provide: TerminalStateService, useValue: stateSvc },
        { provide: ReferencesService, useValue: refs },
        { provide: TechLogService, useValue: techLog },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();

    fixture = TestBed.createComponent(TerminalPanelComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('security', sberRow);
    fixture.componentRef.setInput('timeframes', timeframes);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('создаёт панель', () => {
    expect(component).toBeTruthy();
  });

  it('кнопка-треугольник слева в шапке сворачивает/разворачивает полосу', () => {
    const btn = fixture.debugElement.query(By.css('.tpanel-collapse'));
    expect(btn).not.toBeNull();
    expect(btn.nativeElement.getAttribute('aria-expanded')).toBe('true');

    const root = () => fixture.debugElement.query(By.css('.tpanel')).nativeElement;
    expect(root().classList.contains('collapsed')).toBe(false);

    const seen: { value: boolean | null } = { value: null };
    component.collapsedChange.subscribe((v) => (seen.value = v));

    btn.triggerEventHandler('click', null);
    fixture.detectChanges();
    expect(component.collapsed).toBe(true);
    expect(seen.value).toBe(true);
    expect(root().classList.contains('collapsed')).toBe(true);
    expect(btn.nativeElement.getAttribute('aria-expanded')).toBe('false');

    btn.triggerEventHandler('click', null);
    fixture.detectChanges();
    expect(component.collapsed).toBe(false);
    expect(seen.value).toBe(false);
    expect(root().classList.contains('collapsed')).toBe(false);
    expect(btn.nativeElement.getAttribute('aria-expanded')).toBe('true');
  });

  it('свёрнутая при создании полоса (initiallyCollapsed=true) скрывает тело до разворота', () => {
    const f = TestBed.createComponent(TerminalPanelComponent);
    f.componentRef.setInput('security', sberRow);
    f.componentRef.setInput('timeframes', timeframes);
    f.componentRef.setInput('initiallyCollapsed', true);
    f.detectChanges();
    const comp = f.componentInstance;
    const root = f.debugElement.query(By.css('.tpanel')).nativeElement;
    expect(comp.collapsed).toBe(true);
    expect(root.classList.contains('collapsed')).toBe(true);

    const btn = f.debugElement.query(By.css('.tpanel-collapse'));
    btn.triggerEventHandler('click', null);
    f.detectChanges();
    expect(comp.collapsed).toBe(false);
    expect(root.classList.contains('collapsed')).toBe(false);
    f.destroy();
  });

  it('по умолчанию индикаторов на панели нет — только блок с кнопкой «+ Добавить индикатор»', () => {
    expect(component.indicatorRows.length).toBe(0);
    const block = fixture.debugElement.query(By.css('.tp-ind-block'));
    expect(block).not.toBeNull();
    const chips = fixture.debugElement.queryAll(By.css('.tp-ind-chip'));
    expect(chips.length).toBe(0);
    const addBtn = fixture.debugElement.query(By.css('.tp-add-ind'));
    expect(addBtn).not.toBeNull();
  });

  it('выбор индикатора открывается отдельной модальной формой и закрывается по «Отмена»', fakeAsync(() => {
    refs.getIndicators.and.returnValue(
      of([
        {
          id: 8,
          code: 'RSI',
          name: 'RSI',
          script: null,
          formula: '@RSI',
          is_custom: false,
          description: null,
          category: null,
          is_active: true,
          sig_trend_def: null,
          sig_ct_def: null,
          value_types: [],
        },
      ])
    );
    fixture.detectChanges();
    component.openIndicatorPicker();
    tick();
    fixture.detectChanges();
    const card = fixture.debugElement.query(By.css('.tp-modal-card'));
    expect(card).not.toBeNull();
    expect(card.query(By.css('select'))).not.toBeNull();
    component.closeIndicatorPicker();
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.css('.tp-modal-card'))).toBeNull();
    discardPeriodicTasks();
  }));

  it('превращает заполненные сделки счёта в маркеры входов', () => {
    component.trades = [
      trade(1, { direction: 'BUY' }),
      trade(2, { direction: 'SELL', price: 260 }),
      trade(3, { security_id: 99 }),
      trade(4, { status: 'rejected' }),
      trade(5, { price: 0 }),
    ];
    const markers = component.tradeMarkers;
    expect(markers.length).toBe(2);
    expect(markers[0]).toEqual({
      dt: '2026-09-19T10:15:00',
      price: 250,
      kind: 'open',
      side: 'long',
    });
    expect(markers[1].side).toBe('short');
    expect(markers[1].price).toBe(260);
  });

  it('слайдер: движение ползунка обновляет количество и сумму', () => {
    component.chartState = {
      candles: [
        {
          dt: '2026-09-19T10:15:00',
          open_price: 250,
          high_price: 251,
          low_price: 249,
          close_price: 250,
          volume: 100,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    };
    component.tradeMaxInput = 5000;
    fixture.detectChanges();
    component.tradeAmount = 1000;
    fixture.detectChanges();
    expect(component.tradeQuantity).toBe(4);
    expect(Math.round(component.tradeSum * 100) / 100).toBe(1000);
    const slider = fixture.debugElement.query(By.css('.trade-slider'));
    expect(slider).not.toBeNull();
    slider.nativeElement.value = '2000';
    slider.nativeElement.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(component.tradeAmount as unknown).toBe(2000 as unknown);
    expect(component.tradeQuantity).toBe(8);
  });

  it('слайдер сбрасывает количество из сигнала и считает от ползунка', () => {
    component.chartState = {
      candles: [
        {
          dt: '2026-09-19T10:15:00',
          open_price: 250,
          high_price: 251,
          low_price: 249,
          close_price: 250,
          volume: 100,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    };
    fixture.componentRef.setInput('signalEvent', {
      logic_id: 5,
      logic_name: 'Логика',
      bar_dt: '2026-09-19T10:15:00',
      position_side: 'long',
      price: 250,
      timeframe_id: 6,
      timeframe: 'M15',
      suggested_quantity: 7,
      suggested_amount: 1750,
    } as any);
    component.tradeMaxInput = 5000;
    fixture.detectChanges();
    // Количество из сигнала (лот логики) — 7 шт.
    expect(component.tradeQuantity).toBe(7);
    expect(component.signalQuantity).toBe(7);
    // Ползунок имеет приоритет: лот логики сброшен, количество — от суммы.
    component.onTradeAmountChange(1000);
    fixture.detectChanges();
    expect(component.tradeQuantity).toBe(4);
    expect(component.signalQuantity).toBe(4);
  });

  it('чекбокс направлений: продажа — вся позиция по бумаге', () => {
    component.trades = [
      trade(1, { direction: 'BUY', quantity: 10, status: 'filled' }),
      trade(2, { direction: 'SELL', quantity: 3, status: 'filled' }),
      trade(3, { direction: 'BUY', quantity: 50, status: 'rejected' }),
    ];
    component.chartState = {
      candles: [
        {
          dt: '2026-09-19T10:15:00',
          open_price: 250,
          high_price: 251,
          low_price: 249,
          close_price: 250,
          volume: 100,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    };
    component.tradeMaxInput = 5000;
    component.tradeAmount = 1750;
    component.onTradeAmountChange(1750);
    expect(component.remainingPositionQty).toBe(7);
    expect((component as any).resolveTradeQuantity('sell')).toBe(7);
    expect(component.tradeQuantity).toBe(7);
    expect(Math.round(component.tradeSum * 100) / 100).toBe(1750);
  });

  it('«инверсия» выключена: кнопки покупки и продажи на своих местах (#934)', () => {
    component.chartState = {
      candles: [
        {
          dt: '2026-09-19T10:15:00',
          open_price: 250,
          high_price: 251,
          low_price: 249,
          close_price: 250,
          volume: 100,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    };
    fixture.componentRef.setInput('signalEvent', {
      logic_id: 5,
      logic_name: 'Логика',
      bar_dt: '2026-09-19T10:15:00',
      position_side: 'long',
      price: 250,
      timeframe_id: 6,
      timeframe: 'M15',
      suggested_quantity: 4,
    } as any);
    component.tradeInverted = false;
    fixture.detectChanges();
    expect(component.signalLogicSide).toBe('buy');
    expect(component.signalSide).toBe('buy');
    expect(component.buyButtonSide).toBe('buy');
    expect(component.sellButtonSide).toBe('sell');
    expect(component.buyButtonLabel).toBe('Купить');
    expect(component.sellButtonLabel).toBe('Продать');
    const btns = fixture.debugElement
      .query(By.css('.trade-buttons'))
      .queryAll(By.css('button'));
    expect(btns.map((b) => b.nativeElement.className.trim())).toEqual([
      'trade-buy',
      'trade-sell',
    ]);
    expect(btns.map((b) => b.nativeElement.textContent.trim().split(' ')[0])).toEqual([
      'Купить',
      'Продать',
    ]);
    // Чекбоксов «на всю сумму» и «весь остаток» в форме больше нет (#934).
    expect(fixture.debugElement.query(By.css('input[aria-label="На всю сумму"]'))).toBeNull();
    expect(fixture.debugElement.query(By.css('input[aria-label="Весь остаток"]'))).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('на всю сумму');
    expect(fixture.nativeElement.textContent).not.toContain('весь остаток');
  });

  it('«инверсия» включена: кнопки меняются местами и сторонами (#934)', () => {
    component.chartState = {
      candles: [
        {
          dt: '2026-09-19T10:15:00',
          open_price: 250,
          high_price: 251,
          low_price: 249,
          close_price: 250,
          volume: 100,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    };
    fixture.componentRef.setInput('signalEvent', {
      logic_id: 5,
      logic_name: 'Логика',
      bar_dt: '2026-09-19T10:15:00',
      position_side: 'long',
      price: 250,
      timeframe_id: 6,
      timeframe: 'M15',
      suggested_quantity: 4,
    } as any);
    component.accountId = 1;
    component.tradeInverted = true;
    component.tradeAmount = 1000;
    component.onTradeAmountChange(1000);
    stateSvc.placeTrade.and.returnValue(of({ ok: true, message: 'ok', mode: 'fake' }));
    fixture.detectChanges();

    // Логика говорит «покупка», инверсия делает сторону продажи.
    expect(component.signalLogicSide).toBe('buy');
    expect(component.signalSide).toBe('sell');
    expect(component.buyButtonSide).toBe('sell');
    expect(component.sellButtonSide).toBe('buy');
    expect(component.buyButtonLabel).toBe('Продать');
    expect(component.sellButtonLabel).toBe('Купить');

    const btns = fixture.debugElement
      .query(By.css('.trade-buttons'))
      .queryAll(By.css('button'));
    expect(btns[0].nativeElement.textContent).toContain('Продать');
    expect(btns[1].nativeElement.textContent).toContain('Купить');
    // Вид кнопок тоже меняется: первая красная, вторая зелёная.
    expect(btns[0].nativeElement.className).toContain('trade-sell-look');
    expect(btns[1].nativeElement.className).toContain('trade-buy-look');
    // «Весь остаток» не появляется даже когда инверсия сделала сторону продающей.
    expect(fixture.debugElement.query(By.css('input[aria-label="Весь остаток"]'))).toBeNull();

    // Кнопка покупки реально продаёт (стороны — по своей подписи).
    btns[0].nativeElement.click();
    expect((stateSvc.placeTrade as jasmine.Spy).calls.mostRecent().args[0].direction).toBe(
      'sell'
    );
    btns[1].nativeElement.click();
    expect((stateSvc.placeTrade as jasmine.Spy).calls.mostRecent().args[0].direction).toBe(
      'buy'
    );
  });

  it('шорт-позиция: сводка показывает прибыль по бумаге при падении цены', () => {
    component.trades = [
      { ...trade(1, { direction: 'SELL', quantity: 10, price: 250, amount: 2500 }), status: 'filled' },
    ];
    component.chartState = {
      candles: [
        {
          dt: '2026-09-19T10:15:00',
          open_price: 240,
          high_price: 241,
          low_price: 239,
          close_price: 240,
          volume: 100,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    };
    fixture.detectChanges();
    expect(component.remainingPositionQty).toBe(-10);
    expect(component.remainingPositionBaseAmount).toBe(2500);
    expect(component.remainingPositionDiff).toBe(100);
    expect(component.remainingPositionDiffPct).toBe(4);
    // #925: в шапке закупка этой бумаги. П/У по счёту — только в шапке
    // терминала, в полосе его нет.
    fixture.detectChanges();
    const pos = fixture.debugElement.query(By.css('.tpanel-pos'));
    expect(pos).not.toBeNull();
    expect(pos.nativeElement.textContent).not.toContain('П/У по счёту');
    expect(pos.nativeElement.textContent).toContain('Получено');
    // Русский формат: разделитель разрядов нормализуем в обычный пробел.
    expect(pos.nativeElement.textContent.replace(/\s+/g, ' ')).toContain('2 500,00 ₽');
  });

  it('шорт-позиция: при росте цены отклонение по бумаге отрицательное', () => {
    component.trades = [
      { ...trade(1, { direction: 'SELL', quantity: 10, price: 250, amount: 2500 }), status: 'filled' },
    ];
    component.chartState = {
      candles: [
        {
          dt: '2026-09-19T10:15:00',
          open_price: 260,
          high_price: 261,
          low_price: 259,
          close_price: 260,
          volume: 100,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    };
    fixture.detectChanges();
    expect(component.remainingPositionDiff).toBe(-100);
    expect(component.remainingPositionDiffPct).toBe(-4);
    // #925: П/У по счёту показывается только в шапке терминала.
    fixture.detectChanges();
    const pos = fixture.debugElement.query(By.css('.tpanel-pos'));
    expect(pos.nativeElement.textContent).not.toContain('П/У по счёту');
  });

  it('шапка: без открытой позиции кнопка «Закрыть позицию» скрыта', () => {
    fixture.detectChanges();
    expect(component.remainingPositionQty).toBe(0);
    expect(component.canClosePosition).toBe(false);
    const pos = fixture.debugElement.query(By.css('.tpanel-pos'));
    expect(pos).not.toBeNull();
    expect(pos.query(By.css('.tpanel-close-pos'))).toBeNull();
    // П/У по счёту в полосе больше не дублируется — только в шапке терминала.
    expect(pos.nativeElement.textContent).not.toContain('П/У по счёту');
    expect(pos.nativeElement.textContent).not.toContain('Позиция');
    const bodySummary = fixture.debugElement.query(By.css('.trade-summary'));
    expect(bodySummary).toBeNull();
  });

  it('шапка: кнопка «Закрыть позицию» скрыта, если по позиции нулевые деньги', () => {
    component.trades = [
      { ...trade(1, { direction: 'BUY', quantity: 10, price: 0, amount: 0 }), status: 'filled' },
    ];
    fixture.detectChanges();
    expect(component.remainingPositionQty).toBe(10);
    expect(component.remainingPositionBaseAmount).toBe(0);
    expect(component.canClosePosition).toBe(false);
    expect(
      fixture.debugElement.query(By.css('.tpanel-close-pos'))
    ).toBeNull();
  });

  it('шапка: при открытой позиции кнопка «Закрыть позицию» видна', () => {
    component.trades = [
      trade(1, { direction: 'BUY', quantity: 10, price: 250, status: 'filled' }),
    ];
    component.chartState = {
      candles: [
        {
          dt: '2026-09-19T10:15:00',
          open_price: 250,
          high_price: 251,
          low_price: 249,
          close_price: 250,
          volume: 100,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    };
    fixture.detectChanges();
    expect(component.canClosePosition).toBe(true);
    const btn = fixture.debugElement.query(By.css('.tpanel-close-pos'));
    expect(btn).not.toBeNull();
    expect(btn.nativeElement.disabled).toBe(false);
  });

  it('кнопка «Закрыть позицию» показывает убыток закрытия в подписи', () => {
    component.trades = [
      trade(1, { direction: 'BUY', quantity: 10, price: 250, status: 'filled' }),
    ];
    component.chartState = {
      candles: [
        {
          dt: '2026-09-19T10:15:00',
          open_price: 250,
          high_price: 251,
          low_price: 249,
          close_price: 250,
          volume: 100,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    };
    fixture.componentRef.setInput('accountIsFake', true);
    fixture.componentRef.setInput('commissionPct', 0.5);
    fixture.detectChanges();
    // Цена = цене покупки: разница 0, комиссия выхода 10 × 250 × 0,5% = 12,50 ₽.
    expect(component.closingCommission).toBe(12.5);
    expect(component.closingNetDiff).toBe(-12.5);
    expect(component.closingIsLoss).toBe(true);
    // #942: в кнопке только название, итог убытка — отдельным блоком за ней.
    const btn = fixture.debugElement.query(By.css('.tpanel-close-pos'));
    expect(btn.nativeElement.textContent.trim()).toBe('Закрыть позицию');
    const diff = fixture.debugElement.query(By.css('.tpanel-close-diff'));
    expect(diff.nativeElement.textContent).toContain('уб. 12,50');
    expect(diff.nativeElement.classList).toContain('tpanel-close-diff-loss');
    // #943: процент от затраченной суммы (2500 ₽) в скобках: -12,5 / 2500 = -0,5%.
    expect(component.closingNetDiffPct).toBe(-0.5);
    expect(
      fixture.debugElement.query(By.css('.tpanel-close-diff-pct')).nativeElement.textContent
    ).toContain('(-0,5%)');
  });

  it('кнопка «Закрыть позицию»: прибыль/убыток пересчитывается от живой цены', () => {
    component.trades = [
      trade(1, { direction: 'BUY', quantity: 10, price: 250, status: 'filled' }),
    ];
    component.chartState = {
      candles: [
        {
          dt: '2026-09-19T10:15:00',
          open_price: 250,
          high_price: 251,
          low_price: 249,
          close_price: 250,
          volume: 100,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    };
    fixture.componentRef.setInput('accountIsFake', true);
    fixture.componentRef.setInput('commissionPct', 0.5);
    fixture.componentRef.setInput('livePrice', 260);
    fixture.detectChanges();
    // Живая цена 260: разница 100 ₽, комиссия выхода 13 ₽ → прибыль 87 ₽.
    expect(component.closingCommission).toBe(13);
    expect(component.closingNetDiff).toBe(87);
    expect(component.closingIsProfit).toBe(true);
    // #942: в кнопке только название, прибыль — отдельным блоком за ней.
    const btn = fixture.debugElement.query(By.css('.tpanel-close-pos'));
    expect(btn.nativeElement.textContent.trim()).toBe('Закрыть позицию');
    const diff = fixture.debugElement.query(By.css('.tpanel-close-diff'));
    expect(diff.nativeElement.textContent).toContain('приб. 87,00');
    expect(diff.nativeElement.classList).toContain('tpanel-close-diff-profit');
    // #943: 87 / 2500 = +3,48%.
    expect(component.closingNetDiffPct).toBe(3.48);
    expect(
      fixture.debugElement.query(By.css('.tpanel-close-diff-pct')).nativeElement.textContent
    ).toContain('(+3,48%)');
  });

  it('#945: высота кнопки и строки полосы растёт пропорционально проценту (1×…2×)', () => {
    component.trades = [
      trade(1, { direction: 'BUY', quantity: 10, price: 250, status: 'filled' }),
    ];
    fixture.componentRef.setInput('accountIsFake', true);
    // Итог закрытия 0% → обычная высота.
    fixture.componentRef.setInput('commissionPct', 0);
    fixture.componentRef.setInput('livePrice', 250);
    fixture.detectChanges();
    expect(component.closingNetDiffPct).toBe(0);
    expect(component.positionPnlScale).toBe(1);
    const root = fixture.debugElement.query(By.css('.tpanel')).nativeElement;
    expect(root.style.getPropertyValue('--pnl-scale')).toBe('1');

    // Убыток 12,50 ₽ от базы 2500 ₽ = −0,5% → высота 1,5×.
    fixture.componentRef.setInput('commissionPct', 0.5);
    fixture.detectChanges();
    expect(component.closingNetDiffPct).toBe(-0.5);
    expect(component.positionPnlScale).toBe(1.5);
    expect(root.style.getPropertyValue('--pnl-scale')).toBe('1.5');

    // Прибыль 100 ₽ = +4% → максимум 2×, дальше не растёт.
    fixture.componentRef.setInput('commissionPct', 0);
    fixture.componentRef.setInput('livePrice', 260);
    fixture.detectChanges();
    expect(component.closingNetDiffPct).toBe(4);
    expect(component.positionPnlScale).toBe(2);

    fixture.componentRef.setInput('livePrice', 300);
    fixture.detectChanges();
    expect(component.positionPnlScale).toBe(2);
  });

  it('#942: при нулевом итоге закрытия блок прибыли/убытка не показывается', () => {
    component.trades = [
      trade(1, { direction: 'BUY', quantity: 10, price: 250, status: 'filled' }),
    ];
    fixture.componentRef.setInput('accountIsFake', true);
    fixture.componentRef.setInput('commissionPct', 0);
    fixture.componentRef.setInput('livePrice', 250);
    fixture.detectChanges();
    expect(component.closingNetDiff).toBe(0);
    expect(component.closingDiffLabel).toBe('');
    expect(fixture.debugElement.query(By.css('.tpanel-close-diff'))).toBeNull();
  });

  it('кнопка «Закрыть позицию»: убыток — красная, прибыль — тёмно-зелёная', () => {
    component.trades = [
      trade(1, { direction: 'BUY', quantity: 10, price: 250, status: 'filled' }),
    ];
    fixture.componentRef.setInput('accountIsFake', true);
    fixture.componentRef.setInput('commissionPct', 0.5);
    // Прибыль мизерная (1 ₽), комиссия выхода ~12,51 ₽ — итог убыточный.
    fixture.componentRef.setInput('livePrice', 250.1);
    fixture.detectChanges();
    expect(component.closingIsLoss).toBe(true);
    expect(
      fixture.debugElement.query(By.css('.tpanel-close-pos')).nativeElement.className
    ).toContain('tpanel-close-pos-loss');

    // Прибыль 500 ₽, комиссия 15 ₽ → закрытие в плюсе.
    fixture.componentRef.setInput('livePrice', 300);
    fixture.detectChanges();
    expect(component.closingIsProfit).toBe(true);
    const cls = fixture.debugElement.query(By.css('.tpanel-close-pos')).nativeElement
      .className;
    expect(cls).toContain('tpanel-close-pos-profit');
    expect(cls).not.toContain('tpanel-close-pos-loss');
  });

  describe('#954 мелькание кнопки «Закрыть позицию» при заметном изменении итога', () => {
    const candle = {
      dt: '2026-09-19T10:15:00',
      open_price: 250,
      high_price: 251,
      low_price: 249,
      close_price: 250,
      volume: 100,
    };

    // Позиция: BUY 10 × 250 = 2500 ₽ вложено, комиссия 0 — итог в % считается
    // только от живой цены, 1 ₽ движения = 0,04 п.п.
    function setPosition(): void {
      component.trades = [
        trade(1, { direction: 'BUY', quantity: 10, price: 250, status: 'filled' }),
      ];
      component.chartState = {
        candles: [candle],
        loading: false,
        loadingOlder: false,
        hasMore: false,
        error: null,
      };
    }

    function blinkClass(): boolean {
      const btn = fixture.debugElement.query(By.css('.tpanel-close-pos'));
      return btn != null && btn.nativeElement.classList.contains('tpanel-close-pos-blink');
    }

    it('изменение ≥0,03 п.п. даёт одно мелькание, через 700 мс оно гаснет', fakeAsync(() => {
      fixture.componentRef.setInput('accountIsFake', true);
      fixture.componentRef.setInput('commissionPct', 0);
      setPosition();
      // Первый замер — база, мелькания нет.
      fixture.componentRef.setInput('livePrice', 250);
      fixture.detectChanges();
      expect(component.closingNetDiffPct).toBe(0);
      expect(component.closeBlink).toBe(false);
      expect(blinkClass()).toBe(false);

      // +1 ₽ = +0,04 п.п. ≥ 0,03 — мелькаем.
      fixture.componentRef.setInput('livePrice', 250.1);
      fixture.detectChanges();
      expect(component.closingNetDiffPct).toBe(0.04);
      expect(component.closeBlink).toBe(true);
      expect(blinkClass()).toBe(true);

      tick(700);
      fixture.detectChanges();
      expect(component.closeBlink).toBe(false);
      expect(blinkClass()).toBe(false);
      discardPeriodicTasks();
    }));

    it('изменение меньше 0,03 п.п. кнопку не мигает', fakeAsync(() => {
      fixture.componentRef.setInput('accountIsFake', true);
      fixture.componentRef.setInput('commissionPct', 0);
      setPosition();
      fixture.componentRef.setInput('livePrice', 250);
      fixture.detectChanges();
      // +0,2 ₽ = +0,01 п.п. — ниже порога.
      fixture.componentRef.setInput('livePrice', 250.02);
      fixture.detectChanges();
      expect(component.closingNetDiffPct).toBe(0.01);
      expect(component.closeBlink).toBe(false);
      expect(blinkClass()).toBe(false);
      tick(700);
      discardPeriodicTasks();
    }));

    it('мелькание не чаще раза в секунду: второй скачок в лимите не мигает, третий — мигает', fakeAsync(() => {
      fixture.componentRef.setInput('accountIsFake', true);
      fixture.componentRef.setInput('commissionPct', 0);
      setPosition();
      fixture.componentRef.setInput('livePrice', 250);
      fixture.detectChanges();

      // Первое мелькание в t=0.
      fixture.componentRef.setInput('livePrice', 250.1);
      fixture.detectChanges();
      expect(component.closeBlink).toBe(true);
      tick(700); // погасло, до секунды ещё 300 мс
      expect(component.closeBlink).toBe(false);

      // Скачок в t=700 мс (в пределах 1 с) — подавлен.
      fixture.componentRef.setInput('livePrice', 250.2);
      fixture.detectChanges();
      expect(component.closingNetDiffPct).toBe(0.08);
      expect(component.closeBlink).toBe(false);
      expect(blinkClass()).toBe(false);

      // t=1100 мс — лимит прошёл, третий скачок мигает.
      tick(400);
      fixture.componentRef.setInput('livePrice', 250.3);
      fixture.detectChanges();
      expect(component.closingNetDiffPct).toBe(0.12);
      expect(component.closeBlink).toBe(true);
      expect(blinkClass()).toBe(true);
      tick(700);
      expect(component.closeBlink).toBe(false);
      discardPeriodicTasks();
    }));

    it('без позиции база сбрасывается: вернувшаяся позиция стартует без мелькания', fakeAsync(() => {
      fixture.componentRef.setInput('accountIsFake', true);
      fixture.componentRef.setInput('commissionPct', 0);
      setPosition();
      // Первый замер с живой позицией — только база (0%).
      fixture.componentRef.setInput('livePrice', 250);
      fixture.detectChanges();
      expect(component.closeBlink).toBe(false);

      // +4 п.п. — мелькаем.
      fixture.componentRef.setInput('livePrice', 260);
      fixture.detectChanges();
      expect(component.closingNetDiffPct).toBe(4);
      expect(component.closeBlink).toBe(true);
      tick(700);
      fixture.detectChanges();
      expect(component.closeBlink).toBe(false);
      expect(blinkClass()).toBe(false);

      // Позиции нет — активное мелькание гаснет, база обнуляется.
      component.trades = [];
      component.emitPositionSummary();
      expect(component.canClosePosition).toBe(false);
      expect(component.closeBlink).toBe(false);

      // Позиция вернулась с итогом 4% — первый замер только база, без вспышки
      // от «чужого» предыдущего значения.
      setPosition();
      component.emitPositionSummary();
      expect(component.closingNetDiffPct).toBe(4);
      expect(component.closeBlink).toBe(false);
      expect(blinkClass()).toBe(false);
      tick(700);
      discardPeriodicTasks();
    }));
  });

  describe('#939 градиентная заливка кнопки закрытия', () => {
    const candle = {
      dt: '2026-09-19T10:15:00',
      open_price: 250,
      high_price: 251,
      low_price: 249,
      close_price: 250,
      volume: 100,
    };

    function setPosition(): void {
      component.trades = [
        trade(1, { direction: 'BUY', quantity: 10, price: 250, status: 'filled' }),
      ];
      component.chartState = {
        candles: [candle],
        loading: false,
        loadingOlder: false,
        hasMore: false,
        error: null,
      };
      fixture.detectChanges();
    }

    it('без сигнала заливки нет: только рамка, длительность 0', () => {
      setPosition();
      expect(component.closeFillDurationMs).toBe(0);
      expect(component.closeFillDelayMs).toBe(0);
      const btn = fixture.debugElement.query(By.css('.tpanel-close-pos'))
        .nativeElement as HTMLButtonElement;
      expect(btn.classList.contains('tpanel-close-pos-fill')).toBe(false);
    });

    it('M15: полная заливка через 10 свечей = 150 минут, задержка = прошедшее время', () => {
      jasmine.clock().install();
      const start = new Date('2026-09-19T10:00:00Z').getTime();
      jasmine.clock().mockDate(new Date(start));
      try {
        fixture.componentRef.setInput('signalEvent', {
          logic_id: 5,
          logic_name: 'Логика',
          bar_dt: '2026-09-19T09:45:00',
          created_at: '2026-09-19T10:00:00Z',
          position_side: 'long',
          price: 250,
          timeframe_id: 6,
          timeframe: 'M15',
          suggested_quantity: 4,
          suggested_amount: 1000,
        } as any);
        fixture.componentRef.setInput('timeframes', [
          { id: 6, tf: 'M15', full_name: '15 минут', sec: 900, is_active: true },
        ] as any);
        setPosition();

        // 10 свечей M15 = 9000 с = 9 000 000 мс.
        expect(component.closeFillDurationMs).toBe(9_000_000);
        // Сигнал только что появился — заливки ещё нет.
        expect(component.closeFillDelayMs).toBe(0);
        const btn = fixture.debugElement.query(By.css('.tpanel-close-pos'))
          .nativeElement as HTMLButtonElement;
        expect(btn.classList.contains('tpanel-close-pos-fill')).toBe(true);
        // Chrome сериализует большие времена в экспоненциальной форме — сравниваем числа.
        expect(parseFloat(btn.style.animationDuration)).toBe(9_000_000);
        expect(parseFloat(btn.style.animationDelay)).toBe(0);

        // Прошло 45 минут (половина) — задержка в половину срока.
        jasmine.clock().mockDate(new Date(start + 45 * 60_000));
        fixture.detectChanges();
        expect(component.closeFillDelayMs).toBe(2_700_000);
        expect(parseFloat(btn.style.animationDelay)).toBe(-2_700_000);

        // Прошло 150 минут — заливка полная, дальше задержка не растёт.
        jasmine.clock().mockDate(new Date(start + 150 * 60_000));
        fixture.detectChanges();
        expect(component.closeFillDelayMs).toBe(9_000_000);
        jasmine.clock().mockDate(new Date(start + 600 * 60_000));
        fixture.detectChanges();
        expect(component.closeFillDelayMs).toBe(9_000_000);
      } finally {
        jasmine.clock().uninstall();
      }
    });

    it('без таймфрейма в сигнале длительность берётся из кода (M1 → 10 минут)', () => {
      fixture.componentRef.setInput('signalEvent', {
        logic_id: 5,
        logic_name: 'Логика',
        bar_dt: '2026-09-19T10:00:00',
        created_at: '2026-09-19T10:01:00Z',
        position_side: 'long',
        price: 250,
        timeframe: 'M1',
        suggested_quantity: 4,
        suggested_amount: 1000,
      } as any);
      setPosition();
      expect(component.closeFillDurationMs).toBe(600_000);
    });
  });

  it('шапка: блок покупок/продаж стоит сразу после кнопки «Закрыть позицию»', () => {
    component.trades = [
      trade(1, { direction: 'BUY', quantity: 10, price: 250, status: 'filled' }),
    ];
    component.chartState = {
      candles: [
        {
          dt: '2026-09-19T10:15:00',
          open_price: 250,
          high_price: 251,
          low_price: 249,
          close_price: 250,
          volume: 100,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    };
    fixture.detectChanges();

    const head = fixture.debugElement.query(By.css('.tpanel-head'));
    // #924: блок «свернуть + закрыть позицию» вынесен из сдвигаемой строки и
    // закреплён слева, поэтому ищем его в обёртке шапки, а не в `.tpanel-head`.
    const tools = fixture.debugElement.query(By.css('.tpanel-head-tools'));
    const pos = tools.query(By.css('.tpanel-pos'));
    const block = head.query(By.css('.tpanel-head-trade'));
    expect(block).not.toBeNull();
    expect(block.query(By.css('.trade-sum'))).not.toBeNull();
    // поле «Количество» из шапки убрано — количество видно в кнопке сигнала
    expect(block.queryAll(By.css('.trade-qty')).length).toBe(1);
    expect(block.nativeElement.textContent).not.toContain('Количество');
    expect(block.query(By.css('.trade-slider'))).not.toBeNull();
    expect(block.queryAll(By.css('button')).length).toBe(1);

    // #924: блок идёт в шапке сразу за блоком инструментов («свернуть +
    // закрыть позицию») и слотом челнока — то есть первым элементом
    // сдвигаемой строки `.tpanel-head`.
    const outerKids = Array.from(
      fixture.debugElement.query(By.css('.tpanel-head-outer')).nativeElement.children
    ) as HTMLElement[];
    expect(outerKids.indexOf(block.nativeElement) === -1).toBe(true);
    expect(outerKids[outerKids.length - 1].className).toContain('tpanel-head');
    const headKids = Array.from(head.nativeElement.children) as HTMLElement[];
    expect(headKids[0].className).toContain('tpanel-head-trade');
    const posKids = Array.from(pos.nativeElement.children) as HTMLElement[];
    expect(posKids.indexOf(pos.query(By.css('.tpanel-close-pos')).nativeElement))
      .toBeLessThan(
        posKids.indexOf(pos.query(By.css('.tpanel-pos-summary')).nativeElement),
      );

    // в теле полосы (блок «Сделки»): поле количества и ползунок убраны из
    // тела (они в шапке), сигнальной кнопки в теле нет
    const bodyTrade = fixture.debugElement.query(By.css('.tpanel-trade'));
    expect(bodyTrade.query(By.css('.trade-qty'))).toBeNull();
    expect(bodyTrade.query(By.css('.trade-slider'))).toBeNull();
    expect(bodyTrade.query(By.css('.tpanel-signal-btn'))).toBeNull();
    // #929: в теле остались тумблер типа заявки и кнопки «Купить»/«Продать»
    // на то же количество, что у кнопки сигнала в шапке
    expect(
      bodyTrade
        .queryAll(By.css('button'))
        .map((b) => b.nativeElement.className.trim()),
    ).toEqual(['trade-switch-track', 'trade-buy', 'trade-sell']);
  });

  it('тело полосы: сводка по позиции осталась в блоке «Сделки» при лонге', () => {
    component.trades = [
      trade(1, { direction: 'BUY', quantity: 10, price: 250, status: 'filled' }),
    ];
    component.chartState = {
      candles: [
        {
          dt: '2026-09-19T10:15:00',
          open_price: 250,
          high_price: 251,
          low_price: 249,
          close_price: 250,
          volume: 100,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    };
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.css('.tpanel-pos'))).not.toBeNull();
    const bodySummary = fixture.debugElement.query(By.css('.trade-summary'));
    expect(bodySummary).not.toBeNull();
    expect(bodySummary.nativeElement.textContent).toContain(
      'Остаток по ценам покупок'
    );
    expect(bodySummary.nativeElement.textContent).toContain('2\u00a0500');
  });

  it('кнопка «Закрыть позицию» продаёт весь остаток при лонге (маркет)', () => {
    component.trades = [
      trade(1, { direction: 'BUY', quantity: 10, price: 250, status: 'filled' }),
    ];
    component.chartState = {
      candles: [
        {
          dt: '2026-09-19T10:15:00',
          open_price: 250,
          high_price: 251,
          low_price: 249,
          close_price: 250,
          volume: 100,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    };
    component.accountId = 1;
    stateSvc.placeTrade.and.returnValue(
      of({ ok: true, message: 'ok', mode: 'fake' })
    );
    fixture.detectChanges();
    const btn = fixture.debugElement.query(By.css('.tpanel-close-pos'));
    expect(btn).not.toBeNull();
    btn.nativeElement.click();
    expect(stateSvc.placeTrade).toHaveBeenCalledWith({
      account_id: 1,
      security_id: 29,
      direction: 'sell',
      execution: 'market',
      price: 250,
      quantity: 10,
    });
  });

  it('кнопка «Закрыть позицию» выкупает весь объём при шорте (маркет)', () => {
    component.trades = [
      { ...trade(1, { direction: 'SELL', quantity: 10, price: 250, amount: 2500 }), status: 'filled' },
    ];
    component.chartState = {
      candles: [
        {
          dt: '2026-09-19T10:15:00',
          open_price: 240,
          high_price: 241,
          low_price: 239,
          close_price: 240,
          volume: 100,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    };
    component.accountId = 1;
    stateSvc.placeTrade.and.returnValue(
      of({ ok: true, message: 'ok', mode: 'fake' })
    );
    fixture.detectChanges();
    const btn = fixture.debugElement.query(By.css('.tpanel-close-pos'));
    expect(btn).not.toBeNull();
    btn.nativeElement.click();
    expect(stateSvc.placeTrade).toHaveBeenCalledWith({
      account_id: 1,
      security_id: 29,
      direction: 'buy',
      execution: 'market',
      price: 240,
      quantity: 10,
    });
  });

  it('маркет-заявка уходит по живой цене, а не по последней свече', () => {
    component.chartState = {
      candles: [
        {
          dt: '2026-09-19T10:15:00',
          open_price: 250,
          high_price: 251,
          low_price: 249,
          close_price: 250,
          volume: 100,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    };
    component.accountId = 1;
    component.tradeAmount = 1000;
    component.tradeMaxInput = 1000;
    fixture.componentRef.setInput('livePrice', 260);
    fixture.detectChanges();
    component.placeTrade('buy');
    expect(stateSvc.placeTrade).toHaveBeenCalledWith({
      account_id: 1,
      security_id: 29,
      direction: 'buy',
      execution: 'market',
      price: 260,
      quantity: 4,
    });
  });

  it('лимит-заявка уходит по цене графика, а не по живой', () => {
    component.chartState = {
      candles: [
        {
          dt: '2026-09-19T10:15:00',
          open_price: 250,
          high_price: 251,
          low_price: 249,
          close_price: 250,
          volume: 100,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    };
    component.accountId = 1;
    component.tradeAmount = 1000;
    component.tradeMaxInput = 1000;
    component.tradeType = 'limit';
    fixture.componentRef.setInput('livePrice', 260);
    fixture.detectChanges();
    component.placeTrade('buy');
    expect(stateSvc.placeTrade).toHaveBeenCalledWith({
      account_id: 1,
      security_id: 29,
      direction: 'buy',
      execution: 'limit',
      price: 250,
      quantity: 4,
    });
  });

  it('открывает параметры индикатора с текущими значениями', () => {
    component.indicatorRows = [smaSeries];
    component.openEditParams(smaSeries);
    expect(component.indicatorEditRow?.indicator_name).toBe('SMA');
    expect(component.indicatorEditParams['param_period']).toBe('20');
    component.closeEditParams();
    expect(component.indicatorEditRowId).toBeNull();
  });

  it('отклоняет нечисловой параметр без запроса PUT', () => {
    component.indicatorRows = [smaSeries];
    component.openEditParams(smaSeries);
    component.indicatorEditParams['param_period'] = 'abc';
    component.saveEditParams();
    expect(securities.updateIndicatorSeriesParams).not.toHaveBeenCalled();
    expect(component.indicatorSaveError).toContain('не число');
    expect(component.indicatorEditRowId).toBe(1);
  });

  it('отклоняет период меньше единицы', () => {
    component.indicatorRows = [smaSeries];
    component.openEditParams(smaSeries);
    component.indicatorEditParams['param_period'] = '0';
    component.saveEditParams();
    expect(securities.updateIndicatorSeriesParams).not.toHaveBeenCalled();
    expect(component.indicatorSaveError).toContain('не меньше 1');
  });

  it('сохраняет изменённый период и перезапускает расчёт', fakeAsync(() => {
    component.indicatorRows = [smaSeries];
    component.openEditParams(smaSeries);
    component.indicatorEditParams['param_period'] = '30';
    component.saveEditParams();
    expect(securities.updateIndicatorSeriesParams).toHaveBeenCalledWith(1, {
      param_period: 30,
    });
    expect(component.indicatorEditRow).toBeNull();
    expect(component.indicatorRows.some((r) => r.param_period === 30)).toBeTrue();
    tick(500);
    discardPeriodicTasks();
  }));

  it('добавляет индикатор из каталога', fakeAsync(() => {
    refs.getIndicators.and.returnValue(
      of([
        {
          id: 8,
          code: 'RSI',
          name: 'RSI',
          script: null,
          formula: '@RSI',
          is_custom: false,
          description: null,
          category: null,
          is_active: true,
          sig_trend_def: null,
          sig_ct_def: null,
          value_types: [
            {
              id: 11,
              code: 'VALUE',
              name: 'VALUE',
              value_type: 'float',
              is_threshold: false,
              threshold_value: null,
              display_order: 1,
            },
          ],
        },
      ])
    );
    securities.assignIndicatorSeries.and.returnValue(
      of([
        {
          id: 20,
          security_id: 29,
          indicator_id: 8,
          series_code: 'VALUE',
          invoke_formula: '@RSI',
          indicator_code: 'RSI',
          indicator_name: 'RSI',
          point_count: 100,
          display_order: 2,
          is_active: true,
        },
      ])
    );
    component.openIndicatorPicker();
    component.pendingIndicatorId = 8;
    component.onAddIndicator(8);
    expect(securities.assignIndicatorSeries).toHaveBeenCalledWith(29, 8, 6);
    expect(component.indicatorRows.some((r) => r.id === 20)).toBeTrue();
    expect(component.indicatorPickerOpen).toBeFalse();
    discardPeriodicTasks();
  }));

  it('не добавляет уже назначенный индикатор', fakeAsync(() => {
    component.indicatorRows = [smaSeries];
    refs.getIndicators.and.returnValue(
      of([
        {
          id: 7,
          code: 'SMA',
          name: 'SMA',
          script: null,
          formula: 'sma(20)',
          is_custom: false,
          description: null,
          category: null,
          is_active: true,
          sig_trend_def: null,
          sig_ct_def: null,
          value_types: [],
        },
      ])
    );
    component.openIndicatorPicker();
    component.pendingIndicatorId = 7;
    component.onAddIndicator(7);
    expect(securities.assignIndicatorSeries).not.toHaveBeenCalled();
    expect(component.indicatorError).toContain('уже добавлен');
    discardPeriodicTasks();
  }));

  it('удаляет индикатор с бумаги', () => {
    component.indicatorRows = [smaSeries];
    component.removeIndicator(smaSeries.id);
    expect(securities.removeIndicatorSeries).toHaveBeenCalledWith(1);
    expect(component.indicatorRows.some((r) => r.id === smaSeries.id)).toBeFalse();
  });

  it('правый блок индикаторов: назначенный — с кнопками, из сигнала — только цвет и код', () => {
    component.indicatorRows = [
      smaSeries,
      {
        ...smaSeries,
        id: 2,
        indicator_id: 8,
        indicator_code: 'RSI',
        indicator_name: 'RSI',
        display_order: 2,
      },
    ];
    component.signalIndicatorChartSeries = [
      {
        indicator_code: 'BB',
        line_code: 'UPPER',
        line_name: 'Верхняя полоса Боллинджера',
        color: '#0891b2',
        on_price_scale: true,
        is_threshold: false,
        points: [],
      },
      {
        indicator_code: 'BB',
        line_code: 'LOWER',
        line_name: 'Нижняя полоса Боллинджера',
        color: '#ca8a04',
        on_price_scale: true,
        is_threshold: false,
        points: [],
      },
    ];
    const chips = component.indicatorChips();
    expect(chips.length).toBe(3);
    const manual = chips.find((c) => c.editable)!;
    expect(manual.key).toBe('m:7');
    expect(manual.label).toBe('SMA');
    expect(manual.color).toBe('#2563eb');
    expect(manual.row).toEqual(smaSeries);
    const signal = chips.find((c) => c.key === 's:BB')!;
    expect(signal.editable).toBeFalse();
    expect(signal.row).toBeNull();
    expect(signal.label).toBe('BB ×2');
    expect(signal.color).toBe('#0891b2');
    expect(signal.title).toContain('Индикатор логики');
  });

  it('подписи под графиком: каждая линия индикатора — образец цвета и название', () => {
    component.displayIndicatorSeries = [
      {
        indicator_code: 'STOCH',
        line_code: 'K',
        line_name: '%K линия',
        color: '#2563eb',
        on_price_scale: false,
        is_threshold: false,
        points: [],
      },
      {
        indicator_code: 'STOCH',
        line_code: 'D',
        line_name: '%D линия',
        color: '#9333ea',
        on_price_scale: false,
        is_threshold: false,
        points: [],
      },
      {
        indicator_code: 'SMA',
        line_code: 'VALUE',
        line_name: 'Скользящая средняя MA',
        color: '#ea580c',
        on_price_scale: true,
        is_threshold: false,
        points: [],
      },
    ];
    const items = component.indicatorLegendItems();
    expect(items.length).toBe(3);
    expect(items[0].label).toBe('STOCH');
    expect(items[0].color).toBe('#2563eb');
    expect(items[1].label).toBe('STOCH D');
    expect(items[2].label).toBe('SMA');
    expect(items[2].title).toContain('MA');
  });

  it('DOM: легенда под графиком и сигнальный индикатор в правом блоке', () => {
    component.signalIndicatorChartSeries = [
      {
        indicator_code: 'ADX',
        line_code: 'ADX',
        line_name: 'Сглаженная линия ADX',
        color: '#0891b2',
        on_price_scale: false,
        is_threshold: false,
        points: [],
      },
    ];
    component.indicatorChartSeries = [
      {
        indicator_code: 'SMA',
        line_code: 'VALUE',
        line_name: 'Скользящая средняя MA',
        color: '#2563eb',
        on_price_scale: true,
        is_threshold: false,
        points: [],
      },
    ];
    (component as any).recomposeIndicatorSeries();
    fixture.detectChanges();
    const legend = fixture.debugElement.queryAll(By.css('.tp-ind-legend-item'));
    expect(legend.length).toBe(2);
    const legendLabels = legend.map((el) =>
      el.nativeElement.textContent?.trim()
    );
    expect(legendLabels).toEqual(['ADX', 'SMA']);
    const chips = fixture.debugElement.queryAll(By.css('.tp-ind-chip'));
    expect(chips.length).toBe(1);
    expect(chips[0].nativeElement.textContent).toContain('ADX');
    expect(chips[0].query(By.css('.tp-ind-chip-swatch'))).not.toBeNull();
  });

  it('панель имеет собственный селект таймфрейма и пересчитывает цены по нему', () => {
    const select = fixture.debugElement.query(By.css('.tpanel-field select'));
    expect(select).not.toBeNull();
    const h1 = timeframes.find((t) => t.tf === 'H1')!;
    securities.getPrices.calls.reset();
    component.timeframeId = h1.id;
    component.onTimeframeChange();
    expect(securities.getPrices).toHaveBeenCalledWith(29, h1.id, 200);
  });

  it('смена таймфрейма на панели эмитит состояние с новым таймфреймом', () => {
    const emitSpy = spyOn(component.stateChange, 'emit');
    const h1 = timeframes.find((t) => t.tf === 'H1')!;
    component.timeframeId = h1.id;
    component.onTimeframeChange();
    expect(emitSpy).toHaveBeenCalledWith({
      timeframe_id: h1.id,
      chart_height: component.chartHeight,
    });
  });

  it('сигнал: подставляет количество/сумму из расчёта логики; ползунок сбрасывает', () => {
    component.chartState = {
      candles: [
        {
          dt: '2026-09-19T10:15:00',
          open_price: 250,
          high_price: 251,
          low_price: 249,
          close_price: 250,
          volume: 100,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    };
    fixture.componentRef.setInput('signalEvent', {
      logic_id: 5,
      logic_name: 'Логика X',
      bar_dt: '2026-09-19T10:15:00',
      position_side: 'long',
      price: 250,
      timeframe_id: 6,
      timeframe: 'M15',
      suggested_quantity: 4,
      suggested_amount: 1000,
    });
    fixture.detectChanges();
    expect(component.tradeQuantity).toBe(4);
    expect((component as any).resolveTradeQuantity('buy')).toBe(4);
    expect(component.tradeMaxInput).toBeGreaterThanOrEqual(1000);
    component.onTradeAmountChange(2000);
    expect(component.tradeQuantity).toBe(8);
  });

  it('график при сигнале: только сделки после его бара (старые скрыты)', () => {
    component.trades = [
      trade(1, { executed_at: '2026-09-19T08:00:00', price: 200 }),
      trade(2, { executed_at: '2026-09-19T10:30:00', price: 260, direction: 'SELL' }),
    ];
    // Маркер сигнала якорится на свечу закрытия бара сигнала (bar_dt) и не
    // «уезжает» на последнюю свечу при обновлении цен справа.
    component.chartState = {
      candles: [
        {
          dt: '2026-09-19T10:45:00',
          open_price: 261,
          high_price: 262,
          low_price: 259,
          close_price: 261,
          volume: 100,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    };
    fixture.componentRef.setInput('signalEvent', {
      logic_id: 5,
      bar_dt: '2026-09-19T10:15:00',
      position_side: 'long',
      price: 250,
      suggested_quantity: 0,
      suggested_amount: 0,
    });
    fixture.detectChanges();
    const markers = component.allTradeMarkers;
    // #951: сделка по сигналу уже есть — отдельная сигнальная полоса не рисуется,
    // иначе на одном баре выходило две вертикальные полосы на одну сделку.
    expect(markers.length).toBe(1);
    expect(markers[0].dt).toBe('2026-09-19T10:30:00');
    expect(markers[0].side).toBe('short');
  });

  it('#951: сигнальная линия остаётся, пока по сигналу ещё нет сделки', () => {
    component.trades = [
      trade(1, { executed_at: '2026-09-19T08:00:00', price: 200 }), // до бара сигнала
    ];
    fixture.componentRef.setInput('signalEvent', {
      logic_id: 5,
      bar_dt: '2026-09-19T10:15:00',
      position_side: 'long',
      price: 250,
      suggested_quantity: 4,
      suggested_amount: 1000,
    });
    fixture.detectChanges();

    const markers = component.allTradeMarkers;
    expect(markers.length).toBe(1);
    expect(markers[0]).toEqual({
      dt: '2026-09-19T10:15:00',
      price: 250,
      kind: 'open',
      side: 'long',
    });
  });

  it('бейдж сигнала подсказывает логику, бар и таймфрейм', () => {
    fixture.componentRef.setInput('signalEvent', {
      logic_id: 7,
      logic_name: 'Стратегия',
      bar_dt: '2026-09-19T10:15:00',
      position_side: 'short',
      timeframe: 'M15',
      suggested_quantity: 0,
      suggested_amount: 0,
    });
    fixture.detectChanges();
    const title = component.signalBadgeTitle;
    expect(title).toContain('«Стратегия»');
    expect(title).toContain('таймфрейм M15');
    expect(component.signalLabel).toBe('продажа');
  });

  it('новый сигнал с другим таймфреймом переключает панель на него', () => {
    securities.getPrices.calls.reset();
    const h1 = timeframes.find((t) => t.tf === 'H1')!;
    fixture.componentRef.setInput('initialTimeframeId', h1.id);
    fixture.detectChanges();
    expect(component.timeframeId).toBe(h1.id);
    expect(securities.getPrices).toHaveBeenCalledWith(29, h1.id, 200);
  });

  it('сводка позиции: при изменении сделок/цены шлёт терминалу остаток и рыночную стоимость', () => {
    const sent: { qty: number; marketValue: number }[] = [];
    component.positionSummary.subscribe((s) => sent.push(s));
    component.trades = [
      trade(1, { direction: 'BUY', quantity: 4, price: 250, status: 'filled' }),
    ];
    component.chartState = {
      candles: [
        {
          dt: '2026-09-19T10:15:00',
          open_price: 260,
          high_price: 261,
          low_price: 259,
          close_price: 260,
          volume: 100,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    };
    component.emitPositionSummary();
    expect(sent.length).toBe(1);
    expect(sent[0].qty).toBe(4);
    expect(sent[0].marketValue).toBe(1040);
    // Новая свеча меняет цену — рыночная стоимость обновляется за ней.
    component.chartState = {
      ...component.chartState,
      candles: [
        {
          dt: '2026-09-19T10:30:00',
          open_price: 270,
          high_price: 271,
          low_price: 269,
          close_price: 270,
          volume: 100,
        },
      ],
    };
    component.emitPositionSummary();
    expect(sent[sent.length - 1].marketValue).toBe(1080);
  });

  it('импульс «Закрыть все позиции»: панель с позицией закрывает её маркет-заявкой', () => {
    component.trades = [
      trade(1, { direction: 'BUY', quantity: 5, price: 250, status: 'filled' }),
    ];
    component.chartState = {
      candles: [
        {
          dt: '2026-09-19T10:15:00',
          open_price: 250,
          high_price: 251,
          low_price: 249,
          close_price: 250,
          volume: 100,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    };
    component.accountId = 1;
    fixture.componentRef.setInput('closeAllPulse', 1);
    fixture.detectChanges();
    expect(stateSvc.placeTrade).toHaveBeenCalledWith({
      account_id: 1,
      security_id: 29,
      direction: 'sell',
      execution: 'market',
      price: 250,
      quantity: 5,
    });
  });

  it('импульс «Закрыть все позиции»: без позиции заявку не ставит', () => {
    component.accountId = 1;
    const before = stateSvc.placeTrade.calls.count();
    fixture.componentRef.setInput('closeAllPulse', 1);
    fixture.detectChanges();
    expect(stateSvc.placeTrade.calls.count()).toBe(before);
  });

  it('импульс «Закрыть по сигналу логики»: панель с позицией этой бумаги закрывает её', () => {
    component.trades = [
      trade(1, { direction: 'BUY', quantity: 5, price: 250, status: 'filled' }),
    ];
    component.chartState = {
      candles: [
        {
          dt: '2026-09-19T10:15:00',
          open_price: 250,
          high_price: 251,
          low_price: 249,
          close_price: 250,
          volume: 100,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    };
    component.accountId = 1;
    fixture.componentRef.setInput('closeSignalPulse', {
      security_id: 29,
      pulse: 1,
    });
    fixture.detectChanges();
    expect(stateSvc.placeTrade).toHaveBeenCalledWith({
      account_id: 1,
      security_id: 29,
      direction: 'sell',
      execution: 'market',
      price: 250,
      quantity: 5,
    });
  });

  it('импульс «Закрыть по сигналу логики»: по другой бумаге заявку не ставит', () => {
    component.trades = [
      trade(1, { direction: 'BUY', quantity: 5, price: 250, status: 'filled' }),
    ];
    component.accountId = 1;
    const before = stateSvc.placeTrade.calls.count();
    fixture.componentRef.setInput('closeSignalPulse', {
      security_id: 30,
      pulse: 1,
    });
    fixture.detectChanges();
    expect(stateSvc.placeTrade.calls.count()).toBe(before);
  });

  it('импульс «Закрыть по сигналу логики»: без позиции заявку не ставит', () => {
    component.accountId = 1;
    const before = stateSvc.placeTrade.calls.count();
    fixture.componentRef.setInput('closeSignalPulse', {
      security_id: 29,
      pulse: 1,
    });
    fixture.detectChanges();
    expect(stateSvc.placeTrade.calls.count()).toBe(before);
  });

  it('сигнал long: кнопка «Купить» в шапке ставит покупку по количеству логики', () => {
    component.chartState = {
      candles: [
        {
          dt: '2026-09-19T10:15:00',
          open_price: 250,
          high_price: 251,
          low_price: 249,
          close_price: 250,
          volume: 100,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    };
    component.accountId = 1;
    fixture.componentRef.setInput('signalEvent', {
      logic_id: 5,
      logic_name: 'Логика X',
      bar_dt: '2026-09-19T10:15:00',
      position_side: 'long',
      price: 250,
      timeframe_id: 6,
      timeframe: 'M15',
      suggested_quantity: 4,
      suggested_amount: 1000,
    });
    fixture.detectChanges();
    const group = fixture.debugElement.query(By.css('.tpanel-head-trade'));
    expect(group).not.toBeNull();
    const btn = group.query(By.css('.tpanel-signal-btn'));
    expect(btn.nativeElement.textContent).toContain('Купить');
    expect(btn.nativeElement.textContent).toContain('4');
    expect(btn.classes['short']).toBeUndefined();
    btn.nativeElement.click();
    expect(stateSvc.placeTrade).toHaveBeenCalledWith({
      account_id: 1,
      security_id: 29,
      direction: 'buy',
      execution: 'market',
      price: 250,
      quantity: 4,
    });
  });

  it('сигнал short: кнопка «Продать» в шапке ставит продажу по количеству логики', () => {
    component.chartState = {
      candles: [
        {
          dt: '2026-09-19T10:15:00',
          open_price: 250,
          high_price: 251,
          low_price: 249,
          close_price: 250,
          volume: 100,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    };
    component.accountId = 1;
    fixture.componentRef.setInput('signalEvent', {
      logic_id: 6,
      logic_name: 'Логика Y',
      bar_dt: '2026-09-19T10:15:00',
      position_side: 'short',
      price: 250,
      timeframe_id: 6,
      timeframe: 'M15',
      suggested_quantity: 3,
      suggested_amount: 750,
    });
    fixture.detectChanges();
    const group = fixture.debugElement.query(By.css('.tpanel-head-trade'));
    const btn = group.query(By.css('.tpanel-signal-btn'));
    expect(btn.nativeElement.textContent).toContain('Продать');
    expect(btn.nativeElement.textContent).toContain('3');
    expect(btn.classes['short']).toBeTrue();
    expect(group.query(By.css('.trade-buy'))).toBeNull();
    expect(group.query(By.css('.trade-sell'))).toBeNull();
    btn.nativeElement.click();
    expect(stateSvc.placeTrade).toHaveBeenCalledWith({
      account_id: 1,
      security_id: 29,
      direction: 'sell',
      execution: 'market',
      price: 250,
      quantity: 3,
    });
  });

  it('блок «Сделки»: кнопки «Купить»/«Продать» ставят сделку на то же количество, что кнопка сигнала, разными сторонами', () => {
    component.chartState = {
      candles: [
        {
          dt: '2026-09-19T10:15:00',
          open_price: 250,
          high_price: 251,
          low_price: 249,
          close_price: 250,
          volume: 100,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    };
    component.accountId = 1;
    fixture.componentRef.setInput('signalEvent', {
      logic_id: 5,
      logic_name: 'Логика X',
      bar_dt: '2026-09-19T10:15:00',
      position_side: 'long',
      price: 250,
      timeframe_id: 6,
      timeframe: 'M15',
      suggested_quantity: 4,
      suggested_amount: 1000,
    });
    fixture.detectChanges();
    const body = fixture.debugElement.query(By.css('.tpanel-trade'));
    const buy = body.query(By.css('.trade-buy'));
    const sell = body.query(By.css('.trade-sell'));
    expect(buy).not.toBeNull();
    expect(sell).not.toBeNull();
    expect(buy.nativeElement.textContent).toContain('Купить');
    expect(buy.nativeElement.textContent).toContain('4');
    expect(sell.nativeElement.textContent).toContain('Продать');
    expect(sell.nativeElement.textContent).toContain('4');
    buy.nativeElement.click();
    expect(stateSvc.placeTrade).toHaveBeenCalledWith({
      account_id: 1,
      security_id: 29,
      direction: 'buy',
      execution: 'market',
      price: 250,
      quantity: 4,
    });
    stateSvc.placeTrade.calls.reset();
    sell.nativeElement.click();
    expect(stateSvc.placeTrade).toHaveBeenCalledWith({
      account_id: 1,
      security_id: 29,
      direction: 'sell',
      execution: 'market',
      price: 250,
      quantity: 4,
    });
  });

  it('блок «Сделки» без сигнала: кнопки работают на количество по выбранной сумме', () => {
    component.chartState = {
      candles: [
        {
          dt: '2026-09-19T10:15:00',
          open_price: 250,
          high_price: 251,
          low_price: 249,
          close_price: 250,
          volume: 100,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    };
    component.accountId = 1;
    component.tradeMaxInput = 1000;
    component.tradeAmount = 1000;
    fixture.detectChanges();
    const body = fixture.debugElement.query(By.css('.tpanel-trade'));
    const buy = body.query(By.css('.trade-buy'));
    expect(buy.nativeElement.textContent).toContain('4');
    buy.nativeElement.click();
    expect(stateSvc.placeTrade).toHaveBeenCalledWith({
      account_id: 1,
      security_id: 29,
      direction: 'buy',
      execution: 'market',
      price: 250,
      quantity: 4,
    });
  });

  it('фейковый счёт: поле «Комиссия, %» есть, в заявку уходит commission_pct', () => {
    component.chartState = {
      candles: [
        {
          dt: '2026-09-19T10:15:00',
          open_price: 250,
          high_price: 251,
          low_price: 249,
          close_price: 250,
          volume: 100,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    };
    component.accountId = 1;
    component.tradeMaxInput = 1000;
    component.tradeAmount = 1000;
    fixture.componentRef.setInput('accountIsFake', true);
    fixture.componentRef.setInput('commissionPct', 0.05);
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.css('.trade-commission'))).not.toBeNull();
    const body = fixture.debugElement.query(By.css('.tpanel-trade'));
    body.query(By.css('.trade-buy')).nativeElement.click();
    expect(stateSvc.placeTrade).toHaveBeenCalledWith({
      account_id: 1,
      security_id: 29,
      direction: 'buy',
      execution: 'market',
      price: 250,
      quantity: 4,
      commission_pct: 0.05,
    });
  });

  it('реальный счёт: поле «Комиссия, %» скрыто, commission_pct не уходит', () => {
    component.accountId = 1;
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.css('.trade-commission'))).toBeNull();
  });

  it('«Комиссия, %»: нечисловое и отрицательное игнорируются, значение ограничено 100', () => {
    const spy = jasmine.createSpy('commissionPct');
    component.commissionPctChange.subscribe(spy);
    component.onCommissionPctChange(-1);
    component.onCommissionPctChange('abc' as unknown as number);
    expect(spy).not.toHaveBeenCalled();
    component.onCommissionPctChange(150);
    expect(spy).toHaveBeenCalledWith(100);
  });

  it('сигнал: ввод суммы в поле «Сумма» шапки меняет количество (сброс лота логики)', () => {
    component.chartState = {
      candles: [
        {
          dt: '2026-09-19T10:15:00',
          open_price: 250,
          high_price: 251,
          low_price: 249,
          close_price: 250,
          volume: 100,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    };
    component.tradeMaxInput = 5000;
    fixture.componentRef.setInput('signalEvent', {
      logic_id: 5,
      position_side: 'long',
      suggested_quantity: 4,
      suggested_amount: 1000,
    });
    fixture.detectChanges();
    const input = fixture.debugElement.query(
      By.css('.tpanel-head-trade .trade-sum'),
    );
    expect(input).not.toBeNull();
    expect(input.nativeElement.disabled).toBe(false);
    expect(component.tradeAmount).toBe(1000);
    component.onAmountEdit(2000);
    fixture.detectChanges();
    expect(component.tradeAmount).toBe(2000);
    expect(component.tradeQuantity).toBe(8);
    component.onAmountEdit(99999);
    expect(component.tradeAmount).toBe(5000);
    component.onAmountEdit(-5);
    expect(component.tradeAmount).toBe(0);
  });

  it('сигнал: ползунок шапки двигает сумму тем же обработчиком, что в «Сделках»', () => {
    component.chartState = {
      candles: [
        {
          dt: '2026-09-19T10:15:00',
          open_price: 250,
          high_price: 251,
          low_price: 249,
          close_price: 250,
          volume: 100,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    };
    component.tradeMaxInput = 5000;
    fixture.componentRef.setInput('signalEvent', {
      logic_id: 5,
      position_side: 'short',
      suggested_quantity: 3,
      suggested_amount: 750,
    });
    fixture.detectChanges();
    const slider = fixture.debugElement.query(
      By.css('.tpanel-head-trade .trade-slider'),
    );
    expect(slider).not.toBeNull();
    expect(Number(slider.nativeElement.max)).toBe(5000);
    slider.nativeElement.value = '2000';
    slider.nativeElement.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(component.tradeAmount).toBe(2000);
    expect(component.signalQuantity).toBe(8);
  });

  it('в шапке ровно одна кнопка сделки — по стороне сигнала', () => {
    fixture.detectChanges();
    const buttons = fixture.debugElement.query(
      By.css('.tpanel-head-trade button'),
    );
    expect(buttons).not.toBeNull();
    expect(buttons.nativeElement.textContent).toContain('Купить');
    expect(
      fixture.debugElement.queryAll(By.css('.tpanel-head-trade button')).length,
    ).toBe(1);

    fixture.componentRef.setInput('signalEvent', {
      logic_id: 5,
      position_side: 'short',
      suggested_quantity: 3,
      suggested_amount: 750,
    });
    fixture.detectChanges();
    expect(
      fixture.debugElement.query(By.css('.tpanel-head-trade button'))
        .nativeElement.textContent,
    ).toContain('Продать');
  });

  it('дубль блока «по сигналу» в шапке больше не рендерится', () => {
    fixture.componentRef.setInput('signalEvent', {
      logic_id: 5,
      position_side: 'long',
      suggested_quantity: 4,
      suggested_amount: 1000,
    });
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.css('.tpanel-signal-trade'))).toBeNull();
    expect(fixture.debugElement.query(By.css('.tpanel-signal-input'))).toBeNull();
    expect(
      fixture.debugElement.query(By.css('.tpanel-signal-slider')),
    ).toBeNull();
  });

  it('сигнал: сколько времени прошло — только что / минуты / часы назад', () => {
    fixture.componentRef.setInput('signalEvent', {
      logic_id: 5,
      logic_name: 'Логика X',
      bar_dt: new Date(Date.now() - 3000).toISOString(),
      position_side: 'long',
    });
    fixture.detectChanges();
    expect(component.signalTimeAgo).toBe('только что');

    fixture.componentRef.setInput('signalEvent', {
      logic_id: 5,
      logic_name: 'Логика X',
      bar_dt: new Date(Date.now() - 90_000).toISOString(),
      position_side: 'long',
    });
    fixture.detectChanges();
    expect(component.signalTimeAgo).toBe('1 минуту назад');

    fixture.componentRef.setInput('signalEvent', {
      logic_id: 5,
      logic_name: 'Логика X',
      bar_dt: new Date(Date.now() - 7_300_000).toISOString(),
      position_side: 'long',
    });
    fixture.detectChanges();
    expect(component.signalTimeAgo).toBe('2 часа назад');
  });

  it('сигнал: возраст от created_at (момента записи), а не от bar_dt — открытия бар', () => {
    // Свежий M15-сигнал: бар открылся 18 минут назад, но сигнал записан 3 с назад
    // (реальный кейс: bar_dt — открытие последней закрытой свечи). Показываем
    // «только что», а не «18 минут назад».
    fixture.componentRef.setInput('signalEvent', {
      logic_id: 5,
      logic_name: 'Логика X',
      bar_dt: new Date(Date.now() - 1_080_000).toISOString(),
      created_at: new Date(Date.now() - 3000).toISOString(),
      position_side: 'long',
    });
    fixture.detectChanges();
    expect(component.signalTimeAgo).toBe('только что');

    // Старый сигнал без created_at — возраст от bar_dt (фолбэк).
    fixture.componentRef.setInput('signalEvent', {
      logic_id: 5,
      logic_name: 'Логика X',
      bar_dt: new Date(Date.now() - 90_000).toISOString(),
      position_side: 'long',
    });
    fixture.detectChanges();
    expect(component.signalTimeAgo).toBe('1 минуту назад');
  });

  it('сигнал: хинт бара — логика, «подано» и время назад', () => {
    fixture.componentRef.setInput('signalEvent', {
      logic_id: 7,
      logic_name: 'Стратегия',
      bar_dt: new Date(Date.now() - 300_000).toISOString(),
      position_side: 'short',
      timeframe: 'M15',
    });
    fixture.detectChanges();
    const hint = component.signalBarHint;
    expect(hint).toContain('«Стратегия»');
    expect(hint).toContain('Подано');
    expect(hint).toContain('назад');
  });

  it('сигнал: при наведении на бар полосы подсказка о логике и времени подачи; без сигнала — нет', () => {
    fixture.componentRef.setInput('signalEvent', {
      logic_id: 7,
      logic_name: 'Стратегия',
      bar_dt: new Date(Date.now() - 60_000).toISOString(),
      position_side: 'long',
      timeframe: 'H1',
    });
    fixture.detectChanges();
    // #924: хинт висит на полосе шапки (`.tpanel-head-outer`) — она же
    // владеет челноками по краям.
    const head = fixture.debugElement.query(By.css('.tpanel-head-outer'));
    expect(head.nativeElement.getAttribute('title')).toContain('Сигнал логики');
    expect(head.nativeElement.getAttribute('title')).toContain('назад');

    fixture.componentRef.setInput('signalEvent', null);
    fixture.detectChanges();
    expect(head.nativeElement.getAttribute('title')).toBe('');
  });

  it('чекбокс «автозакрытие по сигналу» на баре полосы: по умолчанию выключен (#937) и виден и без сигнала', () => {
    const box = fixture.debugElement.query(By.css('.tpanel-auto-close-check'));
    expect(box).not.toBeNull();
    expect(box.nativeElement.checked).toBe(false);
    expect(component.autoCloseOnLogicSignal).toBe(false);
  });

  it('включённый чекбокс «автозакрытие по сигналу» рисуется отмеченным', () => {
    fixture.componentRef.setInput('autoCloseOnLogicSignal', true);
    fixture.detectChanges();
    const box = fixture.debugElement.query(By.css('.tpanel-auto-close-check'));
    expect(box).not.toBeNull();
    expect(box.nativeElement.checked).toBe(true);
  });

  it('переключение чекбокса «автозакрытие по сигналу» сообщает терминалу новое значение', () => {
    const seen: { value: boolean | undefined } = { value: undefined };
    component.autoCloseChange.subscribe((v) => (seen.value = v));
    const box = fixture.debugElement.query(By.css('.tpanel-auto-close-check'));
    box.nativeElement.checked = false;
    box.triggerEventHandler('change', { target: box.nativeElement });
    expect(seen.value).toBe(false);
    expect(component.autoCloseOnLogicSignal).toBe(false);

    box.nativeElement.checked = true;
    box.triggerEventHandler('change', { target: box.nativeElement });
    expect(seen.value).toBe(true);
    expect(component.autoCloseOnLogicSignal).toBe(true);
  });

  // #922 — живые цены по бумагам с открытыми позициями (цикл 30 с в терминале).
  describe('#922 живая цена позиции', () => {
    function withPosition(close: number): void {
      component.trades = [
        trade(1, { direction: 'BUY', quantity: 10, price: 250, status: 'filled' }),
      ];
      component.chartState = {
        candles: [
          {
            dt: '2026-09-19T10:15:00',
            open_price: close,
            high_price: close + 1,
            low_price: close - 1,
            close_price: close,
            volume: 100,
          },
        ],
        loading: false,
        loadingOlder: false,
        hasMore: false,
        error: null,
      };
    }

    it('без живой цены позиция считается по закрытой свече (как раньше)', () => {
      withPosition(260);
      fixture.detectChanges();
      expect(component.hasLivePrice).toBe(false);
      expect(component.positionPrice).toBe(260);
      expect(component.remainingPositionMarketValue).toBe(2600);
      expect(component.remainingPositionDiff).toBe(100);
    });

    it('живая цена перебивает закрытую свечу: рыночная стоимость и разница пересчитаны', () => {
      withPosition(260);
      fixture.detectChanges();
      fixture.componentRef.setInput('livePrice', 255.5);
      fixture.detectChanges();
      expect(component.hasLivePrice).toBe(true);
      expect(component.positionPrice).toBe(255.5);
      expect(component.remainingPositionMarketValue).toBe(2555);
      // 2555 − 2500 (10 × 250 по ценам покупок) = +55
      expect(component.remainingPositionDiff).toBe(55);
      expect(component.remainingPositionAvgPrice).toBe(250);
    });

    it('#944: чип «Цена + разница в %» из строки позиции убран', () => {
      withPosition(260);
      fixture.componentRef.setInput('livePrice', 261.2);
      fixture.detectChanges();
      expect(fixture.debugElement.query(By.css('.tpanel-pos-price'))).toBeNull();
    });

    it('живая цена в сводке помечена как live', () => {
      withPosition(260);
      fixture.componentRef.setInput('livePrice', 261.2);
      fixture.detectChanges();
      const summary = fixture.debugElement.query(By.css('.trade-summary'));
      expect(summary).not.toBeNull();
      expect(summary.nativeElement.textContent).toContain('Цена');
      expect(summary.nativeElement.textContent).toContain('261,2');
      expect(summary.nativeElement.textContent).toContain('Средняя цена входа');
      expect(summary.nativeElement.textContent).toContain('250');
      expect(fixture.debugElement.query(By.css('.trade-summary-live-mark'))).not.toBeNull();
    });

    it('смена живой цены отправляет терминалу новую сводку позиции', () => {
      const sent: { qty: number; marketValue: number }[] = [];
      component.positionSummary.subscribe((s) => sent.push(s));
      withPosition(260);
      fixture.detectChanges();
      sent.length = 0;
      fixture.componentRef.setInput('livePrice', 250);
      fixture.detectChanges();
      expect(sent.length).toBe(1);
      expect(sent[0].qty).toBe(10);
      expect(sent[0].marketValue).toBe(2500);
    });

    it('нулевая/мусорная живая цена игнорируется — считаем по свече', () => {
      withPosition(260);
      fixture.detectChanges();
      fixture.componentRef.setInput('livePrice', 0);
      fixture.detectChanges();
      expect(component.hasLivePrice).toBe(false);
      expect(component.positionPrice).toBe(260);
    });
  });

  describe('#924 стрелки-челноки строки шапки', () => {
    it('«Сдвинуть к концу» сдвигает строку на всю скрытую ширину (transform)', fakeAsync(() => {
      // #924: сдвиг — transform-ом, кнопка-челнок в полосе, а не прокрутка.
      const el = component.headScroll?.nativeElement as HTMLElement;
      Object.defineProperty(el, 'clientWidth', { value: 100, configurable: true });
      Object.defineProperty(el, 'scrollWidth', { value: 400, configurable: true });
      component.headShuttleEnd();
      tick(); // отработал отложенный пересчёт границ сдвига
      expect(component.headShift).toBe(300);
      expect(component.headShiftTransform).toBe('translateX(-300px)');
      expect(component.headCanScrollLeft).toBe(true);
      expect(component.headShowRight).toBe(false); // в слоте теперь ««»
      discardPeriodicTasks();
    }));

    it('«Вернуть к началу» возвращает строку к началу (shift = 0)', fakeAsync(() => {
      const el = component.headScroll?.nativeElement as HTMLElement;
      Object.defineProperty(el, 'clientWidth', { value: 100, configurable: true });
      Object.defineProperty(el, 'scrollWidth', { value: 400, configurable: true });
      component.headShuttleEnd();
      tick();
      component.headShuttleStart();
      tick();
      expect(component.headShift).toBe(0);
      expect(component.headShiftTransform).toBe('');
      expect(component.headCanScrollLeft).toBe(false);
      discardPeriodicTasks();
    }));

    it('после сдвига в конец кнопка ««» видна даже при устаревшем флаге', fakeAsync(() => {
      // #924: если строка сдвинута, вернуться к началу можно всегда —
      // застрять в конце строки без кнопки возврата нельзя.
      const el = component.headScroll?.nativeElement as HTMLElement;
      Object.defineProperty(el, 'clientWidth', { value: 100, configurable: true });
      Object.defineProperty(el, 'scrollWidth', { value: 400, configurable: true });
      component.headShuttleEnd();
      tick();
      component.headCanScrollLeft = false; // флаг «устарел»
      expect(component.headShowLeft).toBe(true);
      discardPeriodicTasks();
    }));

    it('в слоте челнока всегда ровно одна кнопка: сначала «»», после сдвига ««»', fakeAsync(() => {
      // #924: слоты жёстко закреплены слева и справа от блока «свернуть +
      // закрыть позицию», видно ровно одно из двух — сменой состояния, не
      // замерами ширины.
      const el = component.headScroll?.nativeElement as HTMLElement;
      Object.defineProperty(el, 'clientWidth', { value: 100, configurable: true });
      Object.defineProperty(el, 'scrollWidth', { value: 400, configurable: true });

      const inSlot = (cls: string) =>
        fixture.debugElement.queryAll(By.css(`.tpanel-head-shuttle-slot ${cls}`)).length;
      const slots = () =>
        fixture.debugElement.queryAll(By.css('.tpanel-head-shuttle-slot')).length;

      fixture.detectChanges();
      expect(slots()).toBe(1);
      expect(inSlot('.tpanel-head-shuttle-right')).toBe(1);
      expect(inSlot('.tpanel-head-shuttle-left')).toBe(0);

      component.headShuttleEnd();
      tick();
      fixture.detectChanges();
      expect(slots()).toBe(1);
      expect(inSlot('.tpanel-head-shuttle-right')).toBe(0);
      expect(inSlot('.tpanel-head-shuttle-left')).toBe(1);

      component.headShuttleStart();
      tick();
      fixture.detectChanges();
      expect(slots()).toBe(1);
      expect(inSlot('.tpanel-head-shuttle-right')).toBe(1);
      discardPeriodicTasks();
    }));

    it('слот челнока — самый первый элемент полосы, у самого левого края', () => {
      // #924: жёсткое крепление — [челнок] блок инструментов [строка].
      // Порядок детей не меняется при сдвиге: только стрелка внутри слота.
      const cls = () => Array.from(
        fixture.debugElement.query(By.css('.tpanel-head-outer')).nativeElement.children
      ).map((c) => (c as HTMLElement).className);
      expect(cls()).toEqual([
        'tpanel-head-shuttle-slot',
        'tpanel-head-tools',
        'tpanel-head',
      ]);
      const tools = fixture.debugElement.query(By.css('.tpanel-head-tools'));
      expect(tools.nativeElement.querySelector('.tpanel-collapse')).not.toBeNull();
      expect(tools.nativeElement.querySelector('.tpanel-pos')).not.toBeNull();

      // После сдвига порядок детей тот же — слот остаётся первым.
      const el = component.headScroll?.nativeElement as HTMLElement;
      Object.defineProperty(el, 'clientWidth', { value: 100, configurable: true });
      Object.defineProperty(el, 'scrollWidth', { value: 400, configurable: true });
      component.headShuttleEnd();
      fixture.detectChanges();
      expect(cls()).toEqual([
        'tpanel-head-shuttle-slot',
        'tpanel-head-tools',
        'tpanel-head',
      ]);
      component.headShuttleStart();
      fixture.detectChanges();
    });


    it('слот челнока заметен: ширина от 30px, кнопка не скрыта и крупная', () => {
      // #924: регрессия «элементов не видно вообще» — в реальном браузере с
      // реальными стилями проверяем размер, видимость и контраст кнопки.
      const slot = fixture.debugElement.query(By.css('.tpanel-head-shuttle-slot'))
        .nativeElement as HTMLElement;
      const btn = slot.querySelector('button') as HTMLElement;
      expect(slot.getBoundingClientRect().width).toBeGreaterThanOrEqual(30);
      expect(btn.getBoundingClientRect().width).toBeGreaterThanOrEqual(30);
      expect(btn.getBoundingClientRect().height).toBeGreaterThan(0);
      const cs = getComputedStyle(btn);
      expect(cs.display).not.toBe('none');
      expect(cs.visibility).not.toBe('hidden');
      expect(Number.parseFloat(cs.fontSize)).toBeGreaterThanOrEqual(14);
      expect(btn.textContent?.trim()).toBe('»');
    });

    it('«Сдвинуть к концу» ничего не делает, когда строка целиком помещается', fakeAsync(() => {
      const el = component.headScroll?.nativeElement as HTMLElement;
      Object.defineProperty(el, 'clientWidth', { value: 400, configurable: true });
      Object.defineProperty(el, 'scrollWidth', { value: 400, configurable: true });
      component.headShuttleEnd();
      tick();
      expect(component.headShift).toBe(0);
      expect(component.headShowLeft).toBe(false);
      discardPeriodicTasks();
    }));
  });

  describe('#946 «Исполнять сделки сразу»', () => {
    const signal = (over?: Record<string, unknown>) => ({
      logic_id: 5,
      signal_id: 777,
      logic_name: 'Логика',
      bar_dt: '2026-09-19T10:15:00',
      position_side: 'long',
      price: 250,
      timeframe_id: 6,
      timeframe: 'M15',
      suggested_quantity: 4,
      suggested_amount: 1000,
      ...(over ?? {}),
    });

    const candles = () => ({
      candles: [
        {
          dt: '2026-09-19T10:15:00',
          open_price: 250,
          high_price: 251,
          low_price: 249,
          close_price: 250,
          volume: 100,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    });

    it('выключена по умолчанию: сигнал только заполняет форму, заявки нет', () => {
      component.chartState = candles();
      component.accountId = 1;
      fixture.componentRef.setInput('signalEvent', signal());
      fixture.detectChanges();

      expect(component.executeSignalsNow).toBe(false);
      expect(stateSvc.placeTrade).not.toHaveBeenCalled();
      expect(component.signalQuantity).toBe(4);
    });

    it('включена: сигнал исполняется сразу — маркет по живой цене, количество логики', () => {
      component.chartState = candles();
      component.accountId = 1;
      const done: number[] = [];
      component.tradeExecuted.subscribe(() => done.push(1));
      fixture.componentRef.setInput('livePrice', 260);
      fixture.componentRef.setInput('executeSignalsNow', true);
      fixture.componentRef.setInput('signalEvent', signal());
      fixture.detectChanges();

      expect(stateSvc.placeTrade).toHaveBeenCalledTimes(1);
      expect(stateSvc.placeTrade).toHaveBeenCalledWith({
        account_id: 1,
        security_id: 29,
        direction: 'buy',
        execution: 'market',
        price: 260,
        quantity: 4,
      });
      // Сделка отображается как обычно: терминал перезапрашивает сделки.
      expect(done.length).toBe(1);
      expect(component.tradeMessage).toContain('Сделка размещена');
    });

    it('один и тот же сигнал исполняется один раз (повторный тик polling не дублирует)', () => {
      component.chartState = candles();
      component.accountId = 1;
      fixture.componentRef.setInput('executeSignalsNow', true);
      fixture.componentRef.setInput('signalEvent', signal());
      fixture.detectChanges();
      expect(stateSvc.placeTrade).toHaveBeenCalledTimes(1);

      // Тот же сигнал пришёл снова (новый объект, тот же signal_id).
      fixture.componentRef.setInput('signalEvent', signal({ label: 'Покупка' }));
      fixture.detectChanges();
      expect(stateSvc.placeTrade).toHaveBeenCalledTimes(1);

      // Новый сигнал (новый id) — исполняется.
      fixture.componentRef.setInput('signalEvent', signal({ signal_id: 778 }));
      fixture.detectChanges();
      expect(stateSvc.placeTrade).toHaveBeenCalledTimes(2);
    });

    it('включение галочки не исполняет старый сигнал (ждём следующего сигнала)', () => {
      component.chartState = candles();
      component.accountId = 1;
      fixture.componentRef.setInput('signalEvent', signal());
      fixture.detectChanges();
      expect(stateSvc.placeTrade).not.toHaveBeenCalled();

      fixture.componentRef.setInput('executeSignalsNow', true);
      fixture.detectChanges();
      expect(stateSvc.placeTrade).not.toHaveBeenCalled();
    });

    it('инверсия: исполняется сторона, обратная сигналу, количество логии', () => {
      component.chartState = candles();
      component.accountId = 1;
      component.tradeInverted = true;
      fixture.componentRef.setInput('executeSignalsNow', true);
      fixture.componentRef.setInput('signalEvent', signal());
      fixture.detectChanges();

      expect(stateSvc.placeTrade).toHaveBeenCalledTimes(1);
      const arg = (stateSvc.placeTrade as jasmine.Spy).calls.mostRecent()
        .args[0];
      expect(arg.direction).toBe('sell');
      expect(arg.quantity).toBe(4);
    });

    it('без счёта заявка не уходит; со счётом тот же сигнал доходит при обновлении', () => {
      component.chartState = candles();
      fixture.componentRef.setInput('executeSignalsNow', true);
      fixture.componentRef.setInput('signalEvent', signal({ signal_id: 778 }));
      fixture.detectChanges();
      expect(stateSvc.placeTrade).not.toHaveBeenCalled();

      // Счёт выбрали — тот же сигнал исполняется (он ещё не исполнялся).
      fixture.componentRef.setInput('accountId', 1);
      fixture.detectChanges();
      expect(stateSvc.placeTrade).toHaveBeenCalledTimes(1);

      // Новый сигнал логики — ещё одна сделка.
      fixture.componentRef.setInput('signalEvent', signal({ signal_id: 779 }));
      fixture.detectChanges();
      expect(stateSvc.placeTrade).toHaveBeenCalledTimes(2);
    });

    // #953: раньше этот тест ждал живую цену (свечей и цены сигнала не было в
    // сценарии). Теперь цена сигнала — рабочий источник: заявка уходит сразу,
    // а живая цена, когда появится, перебивает её.
    it('#953: без графика заявка уходит по цене сигнала, живая цена её перебивает', () => {
      component.chartState = { ...candles(), candles: [] };
      component.accountId = 1;
      fixture.componentRef.setInput('executeSignalsNow', true);
      fixture.componentRef.setInput('signalEvent', signal({ signal_id: 780 }));
      fixture.detectChanges();
      expect(stateSvc.placeTrade).toHaveBeenCalledTimes(1);
      expect(
        (stateSvc.placeTrade as jasmine.Spy).calls.mostRecent().args[0].price
      ).toBe(250);

      // Новый сигнал, когда уже пришла живая цена — маркет по ней.
      fixture.componentRef.setInput('livePrice', 260);
      fixture.componentRef.setInput('signalEvent', signal({ signal_id: 7800 }));
      fixture.detectChanges();
      expect(stateSvc.placeTrade).toHaveBeenCalledTimes(2);
      const arg = (stateSvc.placeTrade as jasmine.Spy).calls.mostRecent().args[0];
      expect(arg.price).toBe(260);
    });

    // #950 + #953: боевой порядок — полоса создана по сигналу, графика на ней
    // ещё нет (currentPrice = 0), свечи приходят отдельным запросом. С #953
    // заявка уходит уже по цене сигнала, но путь через свечи тоже обязан
    // сработать: цена в нём совпадает с ценой сигнала.
    it('#950: сигнал на новой полосе исполняется, когда пришли свечи графика', () => {
      component.chartState = { ...candles(), candles: [], loading: true };
      component.accountId = 1;
      fixture.componentRef.setInput('executeSignalsNow', true);
      // Цена в сигнале пустая — единственный источник цены тут свечи графика.
      // Количество по логике остаётся, иначе проверять тут нечего.
      fixture.componentRef.setInput(
        'signalEvent',
        signal({ signal_id: 781, price: null })
      );
      fixture.detectChanges();
      expect(stateSvc.placeTrade).not.toHaveBeenCalled();

      securities.getPrices.and.returnValue(of(candles().candles as any));
      component.loadChart();
      fixture.detectChanges();

      expect(stateSvc.placeTrade).toHaveBeenCalledTimes(1);
      const arg = (stateSvc.placeTrade as jasmine.Spy).calls.mostRecent().args[0];
      expect(arg.direction).toBe('buy');
      expect(arg.quantity).toBe(4);
      // Маркет без живой цены уходит по цене последней свечи.
      expect(arg.price).toBe(250);
    });

    // #952: логика сигналит одну бумагу на каждом баре — позиция не растёт.
    it('#952: при открытой позиции сигнал не исполняется и показывается причина', () => {
      component.chartState = candles();
      component.accountId = 1;
      // Остаток по бумаге уже есть (покупка 10).
      component.trades = [trade(1, { security_id: 29, quantity: 10, price: 250 })];
      fixture.componentRef.setInput('executeSignalsNow', true);
      fixture.componentRef.setInput('signalEvent', signal({ signal_id: 790 }));
      fixture.detectChanges();

      expect(stateSvc.placeTrade).not.toHaveBeenCalled();
      expect(component.tradeMessage).toContain('наращивание отключено');
    });

    it('#952: после закрытия позиции тот же сигнал уже не проходит — нужен новый сигнал', () => {
      component.chartState = candles();
      component.accountId = 1;
      fixture.componentRef.setInput('executeSignalsNow', true);
      fixture.componentRef.setInput('signalEvent', signal({ signal_id: 791 }));
      fixture.detectChanges();
      expect(stateSvc.placeTrade).toHaveBeenCalledTimes(1);

      // Позиция открылась (терминал перечитал сделки) — повторов не будет.
      component.trades = [trade(1, { security_id: 29, quantity: 10, price: 250 })];
      fixture.componentRef.setInput('trades', component.trades);
      fixture.detectChanges();
      expect(stateSvc.placeTrade).toHaveBeenCalledTimes(1);

      // Позиция закрылась, пришёл новый сигнал — вход снова исполняется.
      component.trades = [];
      fixture.componentRef.setInput('trades', component.trades);
      fixture.componentRef.setInput('signalEvent', signal({ signal_id: 792 }));
      fixture.detectChanges();
      expect(stateSvc.placeTrade).toHaveBeenCalledTimes(2);
    });

    it('#952: шорт-позиция тоже не наращивается', () => {
      component.chartState = candles();
      component.accountId = 1;
      component.trades = [trade(1, { security_id: 29, direction: 'SELL', quantity: 5 })];
      fixture.componentRef.setInput('executeSignalsNow', true);
      fixture.componentRef.setInput('signalEvent', signal({ signal_id: 793 }));
      fixture.detectChanges();

      expect(stateSvc.placeTrade).not.toHaveBeenCalled();
    });

    // #953: разбор «галочка включена, а сделки не исполнились» на живой БД.
    // Позиций нет → терминал не опрашивает живую цену (pollLastPrices только
    // по позициям), график новой полосы ещё пуст, и цена из сигнала была
    // отброшена: maybeExecuteSignal() молча возвращался, сигнал терялся.
    // Сигнал без цены: лот логики есть, а цену взять пока неоткуда —
    // именно этот случай раньше молча терял сигнал.
    const noPriceSignal = (over?: Record<string, unknown>) =>
      signal({ price: null, ...(over ?? {}) });

    it('#953: без позиции и без графика вход исполняется по цене самого сигнала', () => {
      component.chartState = { ...candles(), candles: [], loading: true };
      component.accountId = 1;
      fixture.componentRef.setInput('executeSignalsNow', true);
      fixture.componentRef.setInput('signalEvent', signal({ signal_id: 794 }));
      fixture.detectChanges();

      // Живой цены нет (позиции нет), графика нет — цену берём из сигнала.
      expect(stateSvc.placeTrade).toHaveBeenCalledTimes(1);
      const arg = (stateSvc.placeTrade as jasmine.Spy).calls.mostRecent().args[0];
      expect(arg.direction).toBe('buy');
      expect(arg.price).toBe(250);
      expect(arg.quantity).toBe(4);
    });

    it('#953: лимит-заявка без графика уходит по цене сигнала', () => {
      component.chartState = { ...candles(), candles: [], loading: true };
      component.accountId = 1;
      component.tradeType = 'limit';
      fixture.componentRef.setInput('executeSignalsNow', true);
      fixture.componentRef.setInput('signalEvent', signal({ signal_id: 795 }));
      fixture.detectChanges();

      expect(stateSvc.placeTrade).toHaveBeenCalledTimes(1);
      const arg = (stateSvc.placeTrade as jasmine.Spy).calls.mostRecent().args[0];
      expect(arg.execution).toBe('limit');
      expect(arg.price).toBe(250);
    });

    // #953: повторы в ngOnChanges (signalEvent/livePrice/trades/accountId) при
    // позициях не срабатывают — все эти входы молчат. Спасёт только свой
    // 15-секундный цикл полосы, поэтому он тоже зовёт maybeExecuteSignal().
    it('#953: свой цикл полосы повторяет попытку, когда раньше не было цены', () => {
      component.chartState = { ...candles(), candles: [], loading: false };
      component.accountId = 1;
      fixture.componentRef.setInput('executeSignalsNow', true);
      fixture.componentRef.setInput('signalEvent', noPriceSignal({ signal_id: 796 }));
      fixture.detectChanges();
      expect(stateSvc.placeTrade).not.toHaveBeenCalled();
      // Причина видна пользователю, а не молча пропадает.
      expect(component.tradeMessage).toContain('Сигнал ждёт цену');

      // Через 15 секунд догрузилась свеча — тот же сигнал ещё не потерян.
      // Тот же путь, что у боевого таймера (startPolling -> refreshLatest):
      // сначала попытка без цены, потом догрузка свечей и повтор.
      securities.getPrices.and.returnValue(of(candles().candles as any));
      (component as any).refreshLatest();
      fixture.detectChanges();

      expect(stateSvc.placeTrade).toHaveBeenCalledTimes(1);
      expect(
        (stateSvc.placeTrade as jasmine.Spy).calls.mostRecent().args[0].price
      ).toBe(250);
    });

    it('#953: причина пропуска не затирается следующим обновлением', () => {
      component.chartState = { ...candles(), candles: [], loading: false };
      component.accountId = 1;
      fixture.componentRef.setInput('executeSignalsNow', true);
      fixture.componentRef.setInput('signalEvent', noPriceSignal({ signal_id: 797 }));
      fixture.detectChanges();
      expect(component.tradeMessage).toContain('Сигнал ждёт цену');

      // Терминал перечитал сделки — сообщение обязано остаться.
      // Позиция по бумаге закрыта (покупка и продажа), иначе #952 перебил бы
      // сообщение своей формулировкой.
      fixture.componentRef.setInput('trades', [
        trade(1, {}),
        trade(2, { direction: 'SELL' }),
      ]);
      fixture.detectChanges();

      expect(component.tradeMessage).toContain('Сигнал ждёт цену');
    });

    // #953: сетевой сбой не должен съедать сигнал — раньше ключ
    // executedSignalKey ставился ДО отправки заявки.
    it('#953: при сетевом сбое сигнал не считается исполненным и повторяется', () => {
      component.chartState = candles();
      component.accountId = 1;
      stateSvc.placeTrade.and.returnValue(throwError(() => new Error('offline')));
      fixture.componentRef.setInput('executeSignalsNow', true);
      fixture.componentRef.setInput('signalEvent', signal({ signal_id: 798 }));
      fixture.detectChanges();
      expect(stateSvc.placeTrade).toHaveBeenCalledTimes(1);

      stateSvc.placeTrade.and.returnValue(
        of({ ok: true, message: 'ок', mode: 'fake' })
      );
      // Перечитали сделки: позиция закрыта (покупка + продажа), иначе #952
      // заблокировал бы повтор по другой причине.
      fixture.componentRef.setInput('trades', [
        trade(1, {}),
        trade(2, { direction: 'SELL' }),
      ]);
      fixture.detectChanges();

      expect(stateSvc.placeTrade).toHaveBeenCalledTimes(2);
    });
  });
});
