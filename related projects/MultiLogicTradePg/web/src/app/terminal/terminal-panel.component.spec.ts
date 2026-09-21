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
});