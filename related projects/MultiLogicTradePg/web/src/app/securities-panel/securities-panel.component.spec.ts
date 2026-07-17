import { ComponentFixture, TestBed, fakeAsync, tick, discardPeriodicTasks } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { of, delay } from 'rxjs';
import { SecuritiesPanelComponent } from './securities-panel.component';
import { SecuritiesService } from '../services/securities.service';
import { ReferencesService } from '../services/references.service';
import { AppConfigService } from '../services/app-config.service';
import { SettingsService } from '../services/settings.service';
import { TechLogService } from '../services/tech-log.service';
import {
  SecurityIndicatorSeriesRow,
  SecurityRow,
} from '../models/market.model';

describe('SecuritiesPanelComponent', () => {
  let component: SecuritiesPanelComponent;
  let fixture: ComponentFixture<SecuritiesPanelComponent>;
  let securities: jasmine.SpyObj<SecuritiesService>;

  const sberRow: SecurityRow = {
    id: 29,
    name: 'SBER',
    security_type: 'Stock',
    prefix: 'SBER',
    instrument_market: 'stock',
    exchange_id: 1,
    exchange_name: 'MOEX',
  };

  const stochSeries: SecurityIndicatorSeriesRow[] = [
    {
      id: 1,
      security_id: 29,
      indicator_id: 7,
      series_code: 'K',
      invoke_formula: 'calc_ind_stoch_array(...)',
      indicator_code: 'STOCH',
      indicator_name: 'Stochastic',
      point_count: 100,
      display_order: 1,
      is_active: true,
    },
    {
      id: 2,
      security_id: 29,
      indicator_id: 7,
      series_code: 'D',
      invoke_formula: 'calc_ind_stoch_array(...)',
      indicator_code: 'STOCH',
      indicator_name: 'Stochastic',
      point_count: 100,
      display_order: 2,
      is_active: true,
    },
  ];

  beforeEach(async () => {
    securities = jasmine.createSpyObj('SecuritiesService', [
      'getTimeframes',
      'getSecurities',
      'getPrices',
      'getSecurityIndicatorSeries',
      'syncIndicatorSeries',
      'assignIndicatorSeries',
      'removeIndicatorSeries',
      'loadPrices',
      'getIndicatorValues',
    ]);
    securities.getTimeframes.and.returnValue(
      of([{ id: 6, tf: 'M15', full_name: '15 min', sec: 900, is_active: true }])
    );
    securities.getSecurities.and.returnValue(of([]));
    securities.getPrices.and.returnValue(of([]));
    securities.getSecurityIndicatorSeries.and.returnValue(of([]));
    securities.syncIndicatorSeries.and.returnValue(of({ ok: true }));
    securities.getIndicatorValues.and.returnValue(of([]));

    const refs = jasmine.createSpyObj('ReferencesService', [
      'getExchanges',
      'getIndicators',
    ]);
    refs.getExchanges.and.returnValue(
      of([{ id: 1, name: 'MOEX', is_active: true }])
    );
    refs.getIndicators.and.returnValue(of([]));

    const settings = jasmine.createSpyObj('SettingsService', [
      'getTbankTokenStatus',
      'saveTbankToken',
    ]);
    settings.getTbankTokenStatus.and.returnValue(of({ has_token: true }));

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
      imports: [SecuritiesPanelComponent],
      providers: [
        { provide: SecuritiesService, useValue: securities },
        { provide: ReferencesService, useValue: refs },
        { provide: SettingsService, useValue: settings },
        { provide: TechLogService, useValue: techLog },
        { provide: AppConfigService, useValue: { apiUrl: 'http://localhost:3000/api' } },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();

    fixture = TestBed.createComponent(SecuritiesPanelComponent);
    component = fixture.componentInstance;
    component.timeframeId = 6;
    component.stocksExpanded = true;
    component.stocks = [sberRow];
  });

  it('shows empty-chart hint after expand when there are no prices', fakeAsync(() => {
    securities.getPrices.and.returnValue(of([]).pipe(delay(10)));
    securities.getSecurityIndicatorSeries.and.returnValue(
      of(stochSeries).pipe(delay(50))
    );

    component.toggleSecurity(sberRow);
    expect(component.isSecurityExpanded(29)).toBeTrue();
    expect(component.chartState(29).loading).toBeTrue();

    tick(10);
    fixture.detectChanges();

    expect(component.chartState(29).loading).toBeFalse();
    expect(component.chartState(29).candles.length).toBe(0);
    expect(component.chartState(29).error).toContain('Загрузить цены');

    tick(50);
    expect(securities.syncIndicatorSeries).not.toHaveBeenCalled();
    expect(component.isIndicatorsLoading(29)).toBeFalse();
  }));

  it('loads chart immediately without waiting for indicator series fetch', fakeAsync(() => {
    let pricesRequested = false;
    securities.getPrices.and.callFake(() => {
      pricesRequested = true;
      return of([]);
    });
    securities.getSecurityIndicatorSeries.and.returnValue(
      of(stochSeries).pipe(delay(200))
    );

    component.toggleSecurity(sberRow);
    tick(1);

    expect(pricesRequested).toBeTrue();
    expect(component.chartState(29).loading).toBeFalse();

    tick(200);
    expect(component.assignedIndicatorSeries(29).length).toBe(2);
    expect(securities.syncIndicatorSeries).not.toHaveBeenCalled();
  }));

  it('shows assigning status while indicator is being attached', () => {
    component.indicatorRecalc.set(29, {
      active: true,
      message: 'Добавление PACC…',
      error: null,
    });
    expect(component.indicatorStatus(29)).toBe('Добавление PACC…');
    expect(component.isIndicatorsLoading(29)).toBeFalse();
  });

  it('shows background recalc message in actions area', () => {
    component.indicatorRecalc.set(29, {
      active: true,
      message: 'Пересчёт PACC…',
      error: null,
    });
    expect(component.isIndicatorRecalcActive(29)).toBeTrue();
    expect(component.indicatorStatus(29)).toBe('Пересчёт PACC…');
  });

  it('does not block chart loading overlay on indicator sync', () => {
    component.charts.set(29, {
      candles: [{ dt: '2026-01-02T10:00:00', open_price: 1, high_price: 1, low_price: 1, close_price: 1, volume: 1 }],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    });
    component.indicatorsLoading.add(29);

    expect(component.chartState(29).loading).toBeFalse();
    expect(component.isIndicatorsLoading(29)).toBeTrue();
  });

  it('formats series label with series code', () => {
    expect(component.seriesLabel(stochSeries[0])).toBe('STOCH K — Stochastic');
    expect(
      component.seriesLabel({
        ...stochSeries[0],
        series_code: 'VALUE',
        indicator_code: 'RSI',
        indicator_name: 'RSI',
      })
    ).toBe('RSI — RSI');
  });

  it('collapses security on second toggle', () => {
    component.toggleSecurity(sberRow);
    expect(component.isSecurityExpanded(29)).toBeTrue();
    component.toggleSecurity(sberRow);
    expect(component.isSecurityExpanded(29)).toBeFalse();
  });

  it('assignIndicator shows row immediately and uses async sync', fakeAsync(() => {
    const paccInd = {
      id: 33,
      code: 'PACC',
      name: 'PACC',
      script: null,
      formula: 'pp * (1; -2; 1)',
      is_custom: true,
      description: null,
      category: null,
      is_active: true,
      sig_trend_def: 'VALUE > 0',
      sig_ct_def: 'VALUE < 0',
      value_types: [
        {
          id: 1,
          code: 'VALUE',
          name: 'VALUE',
          value_type: 'float',
          is_threshold: false,
          threshold_value: null,
          display_order: 1,
        },
      ],
    };
    component['indicatorsById'].set(33, paccInd);

    const paccSeries: SecurityIndicatorSeriesRow[] = [
      {
        id: 10,
        security_id: 29,
        indicator_id: 33,
        series_code: 'VALUE',
        invoke_formula: 'pp * (1; -2; 1)',
        indicator_code: 'PACC',
        indicator_name: 'PACC',
        point_count: 100,
        display_order: 1,
        is_active: true,
      },
    ];
    securities.assignIndicatorSeries.and.returnValue(of(paccSeries).pipe(delay(500)));
    securities.syncIndicatorSeries.and.returnValue(
      of({ ok: true, status: 'started' })
    );
    securities.getIndicatorValues.and.returnValue(
      of([
        {
          indicator_id: 33,
          line_code: 'VALUE',
          line_name: 'VALUE',
          indicator_code: 'PACC',
          display_order: 1,
          dt: '2026-01-02T10:00:00',
          value: 0,
          is_threshold: false,
        },
      ])
    );

    component.expandedSecurities.add(29);
    component.charts.set(29, {
      candles: [
        {
          dt: '2026-01-02T10:00:00',
          open_price: 1,
          high_price: 1,
          low_price: 1,
          close_price: 1,
          volume: 1,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    });

    component['assignIndicator'](sberRow, 33);
    expect(component.assignedIndicatorSeries(29).length).toBe(1);
    expect(component.assignedIndicatorSeries(29)[0].id).toBeLessThan(0);
    expect(securities.syncIndicatorSeries).not.toHaveBeenCalled();

    tick(500);
    expect(securities.assignIndicatorSeries).toHaveBeenCalled();
    expect(securities.syncIndicatorSeries).toHaveBeenCalledWith(
      jasmine.objectContaining({ async: true, indicator_id: 33 })
    );

    tick(500);
    tick(1200);
    discardPeriodicTasks();
  }));

  it('syncIndicatorsForRange uses async sync (non-blocking HTTP)', fakeAsync(() => {
    securities.syncIndicatorSeries.and.returnValue(
      of({ ok: true, status: 'started' })
    );
    securities.getIndicatorValues.and.returnValue(
      of([
        {
          indicator_id: 7,
          line_code: 'K',
          line_name: 'K',
          indicator_code: 'STOCH',
          display_order: 1,
          dt: '2026-01-02T10:00:00',
          value: 50,
          is_threshold: false,
        },
      ])
    );

    component.securityIndicatorSeries.set(29, stochSeries);
    component.charts.set(29, {
      candles: [
        {
          dt: '2026-01-02T10:00:00',
          open_price: 1,
          high_price: 1,
          low_price: 1,
          close_price: 1,
          volume: 1,
        },
        {
          dt: '2026-01-02T10:15:00',
          open_price: 2,
          high_price: 2,
          low_price: 2,
          close_price: 2,
          volume: 2,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    });

    component['syncIndicatorsForRange'](
      29,
      {
        startDt: '2026-01-02T10:00:00',
        endDt: '2026-01-02T10:15:00',
        count: 2,
        viewStart: 0,
      },
      { incremental: true }
    );

    expect(securities.syncIndicatorSeries).toHaveBeenCalledWith(
      jasmine.objectContaining({ async: true })
    );
    expect(component.isIndicatorsLoading(29)).toBeFalse();
    expect(component.isIndicatorRecalcActive(29)).toBeTrue();

    tick(500);
    discardPeriodicTasks();
  }));

  it('onChartVisibleRange hides indicators until sync completes', fakeAsync(() => {
    securities.syncIndicatorSeries.and.returnValue(of({ ok: true }));
    securities.getIndicatorValues.and.returnValue(
      of([
        {
          indicator_id: 7,
          line_code: 'K',
          line_name: 'K',
          indicator_code: 'STOCH',
          display_order: 1,
          dt: '2026-01-02T10:00:00',
          value: 50,
          is_threshold: false,
        },
        {
          indicator_id: 7,
          line_code: 'K',
          line_name: 'K',
          indicator_code: 'STOCH',
          display_order: 1,
          dt: '2026-01-02T10:15:00',
          value: 55,
          is_threshold: false,
        },
      ])
    );

    component.securityIndicatorSeries.set(29, stochSeries);
    component.indicatorSeries.set(29, [
      {
        indicator_code: 'STOCH',
        line_code: 'K',
        line_name: 'K',
        color: '#2563eb',
        on_price_scale: false,
        is_threshold: false,
        points: [
          { dt: '2026-01-02T10:00:00', value: 99 },
          { dt: '2026-01-02T10:15:00', value: 99 },
        ],
      },
    ]);
    component.charts.set(29, {
      candles: [
        {
          dt: '2026-01-02T10:00:00',
          open_price: 1,
          high_price: 1,
          low_price: 1,
          close_price: 1,
          volume: 1,
        },
        {
          dt: '2026-01-02T10:15:00',
          open_price: 2,
          high_price: 2,
          low_price: 2,
          close_price: 2,
          volume: 2,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    });

    const range = {
      startDt: '2026-01-02T10:00:00',
      endDt: '2026-01-02T10:15:00',
      count: 2,
      viewStart: 0,
      userInitiated: true,
    };
    component.onChartVisibleRange(29, range);
    expect(component.chartIndicatorsForDisplay(29).length).toBe(0);

    tick(650);
    expect(securities.syncIndicatorSeries).toHaveBeenCalled();
    tick(500);
    expect(component.chartIndicatorsForDisplay(29).length).toBeGreaterThan(0);
    discardPeriodicTasks();
  }));

  it('onChartVisibleRange debounces rapid scroll to one sync', fakeAsync(() => {
    securities.syncIndicatorSeries.and.returnValue(of({ ok: true }));
    securities.getIndicatorValues.and.returnValue(
      of([
        {
          indicator_id: 7,
          line_code: 'K',
          line_name: 'K',
          indicator_code: 'STOCH',
          display_order: 1,
          dt: '2026-01-02T10:00:00',
          value: 75,
          is_threshold: false,
        },
        {
          indicator_id: 7,
          line_code: 'K',
          line_name: 'K',
          indicator_code: 'STOCH',
          display_order: 1,
          dt: '2026-01-02T10:15:00',
          value: 80,
          is_threshold: false,
        },
      ])
    );

    component.securityIndicatorSeries.set(29, stochSeries);
    component.charts.set(29, {
      candles: [
        {
          dt: '2026-01-02T10:00:00',
          open_price: 1,
          high_price: 1,
          low_price: 1,
          close_price: 1,
          volume: 1,
        },
        {
          dt: '2026-01-02T10:15:00',
          open_price: 2,
          high_price: 2,
          low_price: 2,
          close_price: 2,
          volume: 2,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    });

    component.onChartVisibleRange(29, {
      startDt: '2026-01-01T10:00:00',
      endDt: '2026-01-01T10:00:00',
      count: 1,
      viewStart: 0,
      userInitiated: true,
    });
    tick(100);
    component.onChartVisibleRange(29, {
      startDt: '2026-01-02T10:00:00',
      endDt: '2026-01-02T10:15:00',
      count: 2,
      viewStart: 0,
      userInitiated: true,
    });
    tick(650);
    expect(securities.syncIndicatorSeries).toHaveBeenCalledTimes(1);
    tick(500);
    expect(
      component
        .chartIndicatorSeries(29)[0]
        ?.points.some((p) => p.value === 80)
    ).toBeTrue();
    discardPeriodicTasks();
  }));

  it('toggleSecurity syncs indicators after candles and series both load', fakeAsync(() => {
    const smatSeries: SecurityIndicatorSeriesRow[] = [
      {
        id: 10,
        security_id: 29,
        indicator_id: 33,
        series_code: 'VALUE',
        invoke_formula: 'sma*3',
        indicator_code: 'SMAT3',
        indicator_name: 'SMAT3',
        point_count: 100,
        display_order: 1,
        is_active: true,
      },
    ];
    securities.getPrices.and.returnValue(
      of([
        {
          dt: '2026-01-02T10:00:00',
          open_price: 1,
          high_price: 1,
          low_price: 1,
          close_price: 1,
          volume: 1,
        },
        {
          dt: '2026-01-02T10:15:00',
          open_price: 2,
          high_price: 2,
          low_price: 2,
          close_price: 2,
          volume: 2,
        },
      ])
    );
    securities.getSecurityIndicatorSeries.and.returnValue(of(smatSeries));
    securities.syncIndicatorSeries.and.returnValue(of({ ok: true }));
    securities.getIndicatorValues.and.returnValue(
      of([
        {
          indicator_id: 33,
          line_code: 'VALUE',
          line_name: 'VALUE',
          indicator_code: 'SMAT3',
          display_order: 1,
          dt: '2026-01-02T10:00:00',
          value: 50,
          is_threshold: false,
        },
        {
          indicator_id: 33,
          line_code: 'VALUE',
          line_name: 'VALUE',
          indicator_code: 'SMAT3',
          display_order: 1,
          dt: '2026-01-02T10:15:00',
          value: 55,
          is_threshold: false,
        },
      ])
    );

    component.toggleSecurity(sberRow);
    expect(securities.syncIndicatorSeries).toHaveBeenCalled();
    tick(500);
    expect(component.chartIndicatorsForDisplay(29).length).toBeGreaterThan(0);
    discardPeriodicTasks();
  }));

  it('onChartVisibleRange auto emit does not suppress indicators', () => {
    component.indicatorSeries.set(29, [
      {
        indicator_code: 'SMA',
        line_code: 'VALUE',
        line_name: 'VALUE',
        color: '#2563eb',
        on_price_scale: true,
        is_threshold: false,
        points: [{ dt: '2026-01-02T10:00:00', value: 100 }],
      },
    ]);
    component.onChartVisibleRange(29, {
      startDt: '2026-01-02T10:00:00',
      endDt: '2026-01-02T10:00:00',
      count: 1,
      viewStart: 0,
      userInitiated: false,
    });
    expect(component.chartIndicatorsForDisplay(29).length).toBe(1);
  });

  it('onChartVisibleRange auto schedules soft sync without suppress', fakeAsync(() => {
    securities.syncIndicatorSeries.calls.reset();
    securities.syncIndicatorSeries.and.returnValue(of({ ok: true }));
    securities.getIndicatorValues.and.returnValue(
      of([
        {
          indicator_id: 7,
          line_code: 'K',
          line_name: 'K',
          indicator_code: 'STOCH',
          display_order: 1,
          dt: '2026-01-02T10:00:00',
          value: 50,
          is_threshold: false,
        },
      ])
    );
    component.securityIndicatorSeries.set(29, stochSeries);
    component.charts.set(29, {
      candles: [
        {
          dt: '2026-01-02T10:00:00',
          open_price: 1,
          high_price: 1,
          low_price: 1,
          close_price: 1,
          volume: 1,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    });
    component.onChartVisibleRange(29, {
      startDt: '2026-01-02T10:00:00',
      endDt: '2026-01-02T10:00:00',
      count: 1,
      viewStart: 0,
      userInitiated: false,
    });
    expect(securities.syncIndicatorSeries).not.toHaveBeenCalled();
    expect(component.isIndicatorRecalcActive(29)).toBeFalse();
    tick(400);
    expect(securities.syncIndicatorSeries).toHaveBeenCalledTimes(1);
    tick(500);
    discardPeriodicTasks();
  }));

  it('defers full sync while assign mergeOnly sync is active', fakeAsync(() => {
    component['assignMergeSyncGen'].set(29, 2);
    component.securityIndicatorSeries.set(29, stochSeries);
    component.charts.set(29, {
      candles: [
        {
          dt: '2026-01-02T10:00:00',
          open_price: 1,
          high_price: 1,
          low_price: 1,
          close_price: 1,
          volume: 1,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    });
    component['syncIndicatorsForRange'](
      29,
      {
        startDt: '2026-01-02T10:00:00',
        endDt: '2026-01-02T10:00:00',
        count: 1,
        viewStart: 0,
      },
      { incremental: true }
    );
    expect(securities.syncIndicatorSeries).not.toHaveBeenCalled();
    expect(component['deferredRangeSync'].has(29)).toBeTrue();
  }));

  it('queues rapid assign drops and runs POST one at a time', fakeAsync(() => {
    const paccInd = {
      id: 33,
      code: 'PACC',
      name: 'PACC',
      script: null,
      formula: 'pp * (1; -2; 1)',
      is_custom: true,
      description: null,
      category: null,
      is_active: true,
      sig_trend_def: 'VALUE > 0',
      sig_ct_def: 'VALUE < 0',
      value_types: [
        {
          id: 1,
          code: 'VALUE',
          name: 'VALUE',
          value_type: 'float',
          is_threshold: false,
          threshold_value: null,
          display_order: 1,
        },
      ],
    };
    const rsiInd = {
      id: 4,
      code: 'RSI',
      name: 'RSI',
      script: null,
      formula: 'rsi',
      is_custom: false,
      description: null,
      category: null,
      is_active: true,
      sig_trend_def: '',
      sig_ct_def: '',
      value_types: [
        {
          id: 2,
          code: 'RSI',
          name: 'RSI',
          value_type: 'float',
          is_threshold: false,
          threshold_value: null,
          display_order: 1,
        },
      ],
    };
    component['indicatorsById'].set(33, paccInd);
    component['indicatorsById'].set(4, rsiInd);
    component.expandedSecurities.add(29);
    component.charts.set(29, {
      candles: [
        {
          dt: '2026-01-02T10:00:00',
          open_price: 1,
          high_price: 1,
          low_price: 1,
          close_price: 1,
          volume: 1,
        },
      ],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    });
    securities.assignIndicatorSeries.and.returnValues(
      of([
        {
          id: 100,
          security_id: 29,
          indicator_id: 33,
          series_code: 'VALUE',
          invoke_formula: 'sma*3',
          indicator_code: 'PACC',
          indicator_name: 'PACC',
          point_count: 100,
          display_order: 1,
          is_active: true,
        },
      ]),
      of([
        {
          id: 101,
          security_id: 29,
          indicator_id: 4,
          series_code: 'RSI',
          invoke_formula: 'rsi',
          indicator_code: 'RSI',
          indicator_name: 'RSI',
          point_count: 100,
          display_order: 1,
          is_active: true,
        },
      ])
    );
    securities.syncIndicatorSeries.and.returnValue(of({ ok: true }));
    securities.getIndicatorValues.and.returnValue(
      of([
        {
          indicator_id: 33,
          line_code: 'VALUE',
          line_name: 'VALUE',
          indicator_code: 'PACC',
          display_order: 1,
          dt: '2026-01-02T10:00:00',
          value: 1,
          is_threshold: false,
        },
      ])
    );

    component['assignIndicator'](sberRow, 33);
    component['assignIndicator'](sberRow, 4);
    expect(securities.assignIndicatorSeries).toHaveBeenCalledTimes(1);

    tick(500);
    expect(securities.assignIndicatorSeries).toHaveBeenCalledTimes(2);
    expect(securities.syncIndicatorSeries).toHaveBeenCalled();

    tick(500);
    tick(1200);
    discardPeriodicTasks();
  }));

  it('does not flush deferred range sync immediately after mergeOnly assign', fakeAsync(() => {
    const flushSpy = spyOn(
      component as unknown as { flushDeferredRangeSync: (id: number) => void },
      'flushDeferredRangeSync'
    ).and.callThrough();
    component['mergeOnlySyncGens'].add('29:5');
    component['deferredRangeSync'].set(29, {
      startDt: '2026-01-02T10:00:00',
      endDt: '2026-01-02T10:00:00',
      count: 1,
      viewStart: 0,
    });
    component['indicatorSyncGen'].set(29, 5);

    component['finishIndicatorRecalc'](29, null, 5);
    expect(flushSpy).not.toHaveBeenCalled();

    tick(1200);
    expect(flushSpy).toHaveBeenCalledTimes(1);
    discardPeriodicTasks();
  }));
});
