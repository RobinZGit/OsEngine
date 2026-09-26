import {
  ComponentFixture,
  TestBed,
  fakeAsync,
  tick,
  discardPeriodicTasks,
} from '@angular/core/testing';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { By } from '@angular/platform-browser';
import { of } from 'rxjs';
import { TerminalPanelComponent } from './terminal-panel.component';
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
    ]);
    securities.getPrices.and.returnValue(of([]));
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

  it('слайдер сбрасывает отмеченный чекбокс и подхватывает количество от ползунка', () => {
    component.trades = [
      trade(1, { direction: 'BUY', quantity: 10, status: 'filled' }),
      trade(2, { direction: 'SELL', quantity: 3, status: 'filled' }),
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
    fixture.detectChanges();
    component.tradeAllQtySell = true;
    fixture.detectChanges();
    expect(component.tradeQuantity).toBe(7);
    component.onTradeAmountChange();
    fixture.detectChanges();
    expect(component.tradeAllQtySell).toBeFalse();
    expect(component.tradeQuantity).toBe(0);
  });

  it('чекбоксы направлений: продажа — вся позиция, покупка — на всю сумму', () => {
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
    component.tradeAllQtySell = true;
    component.tradeAllSumBuy = true;
    expect(component.remainingPositionQty).toBe(7);
    expect((component as any).resolveTradeQuantity('sell')).toBe(7);
    expect((component as any).resolveTradeQuantity('buy')).toBe(20);
    expect(Math.round(component.tradeSum * 100) / 100).toBe(1750);
  });

  it('шорт-позиция: сводка показывает разницу и процент, положительные при падении цены', () => {
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
    const pos = fixture.debugElement.query(By.css('.tpanel-pos'));
    expect(pos).not.toBeNull();
    expect(pos.nativeElement.textContent).toContain('Получено');
    expect(pos.nativeElement.textContent).toContain('2,500');
    expect(pos.nativeElement.textContent).toContain('+100');
    expect(pos.query(By.css('.diff-positive'))).not.toBeNull();
  });

  it('шорт-позиция: при росте цены разница отрицательная (красная)', () => {
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
    const pos = fixture.debugElement.query(By.css('.tpanel-pos'));
    expect(pos.query(By.css('.diff-negative'))).not.toBeNull();
  });

  it('шапка: кнопка «Закрыть позицию» и сводка видны всегда, даже без открытой позиции', () => {
    fixture.detectChanges();
    expect(component.remainingPositionQty).toBe(0);
    const pos = fixture.debugElement.query(By.css('.tpanel-pos'));
    expect(pos).not.toBeNull();
    const btn = pos.query(By.css('.tpanel-close-pos'));
    expect(btn).not.toBeNull();
    expect(btn.nativeElement.disabled).toBe(true);
    expect(pos.nativeElement.textContent).toContain('Позиция');
    expect(pos.nativeElement.textContent).toContain('0 ₽');
    const bodySummary = fixture.debugElement.query(By.css('.trade-summary'));
    expect(bodySummary).toBeNull();
  });

  it('тело полосы: сводка по позиции продублирована под кнопками Купить/Продать при лонге', () => {
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
    expect(bodySummary.nativeElement.textContent).toContain('2,500');
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

  it('график при сигнале: только сигнал и сделки после его бара (старые скрыты)', () => {
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
    expect(markers.length).toBe(2);
    expect(markers[0]).toEqual({
      dt: '2026-09-19T10:15:00',
      price: 250,
      kind: 'open',
      side: 'long',
    });
    expect(markers[1].dt).toBe('2026-09-19T10:30:00');
    expect(markers[1].side).toBe('short');
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
});