import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { of } from 'rxjs';
import { LogicBacktestPapersComponent } from './logic-backtest-papers.component';
import { SecuritiesService } from '../services/securities.service';
import { TechLogService } from '../services/tech-log.service';
import { LogicsService } from '../services/logics.service';
import { LogicTradeRow } from '../shared/logic-trade';

describe('LogicBacktestPapersComponent', () => {
  let fixture: ComponentFixture<LogicBacktestPapersComponent>;
  let component: LogicBacktestPapersComponent;
  let api: jasmine.SpyObj<SecuritiesService>;

  const sampleTrade: LogicTradeRow = {
    id: 1,
    logic_id: 1,
    account_id: 1,
    security_id: 7,
    timeframe_id: 6,
    side_id: 1,
    action_id: 1,
    signal_kind: 'trend',
    signal_formula: '',
    quantity: 1,
    price: 100,
    bar_dt: '2026-04-10 10:00:00',
    executed_at: '2026-04-10 10:00:00',
    is_simulated: true,
    is_shadow: false,
    is_test: true,
    trade_reason: null,
    broker_order_id: null,
    status: 'filled',
    commission: 0,
    financial_result: 25,
    note: null,
    security_name: 'SBER',
    security_prefix: 'SBER',
    side_name: 'Close',
    action_name: 'Long',
    timeframe_tf: 'M15',
  };

  beforeEach(async () => {
    api = jasmine.createSpyObj('SecuritiesService', [
      'getPrices',
      'getSecurityIndicatorSeries',
      'getIndicatorValues',
      'syncIndicatorSeries',
    ]);
    api.getPrices.and.returnValue(
      of([
        {
          dt: '2026-04-10 10:00:00',
          open_price: 100,
          high_price: 101,
          low_price: 99,
          close_price: 100.5,
          volume: 1,
        },
      ])
    );
    api.getIndicatorValues.and.returnValue(of([]));
    api.syncIndicatorSeries.and.returnValue(of({ ok: true, status: 'accepted' }));

    await TestBed.configureTestingModule({
      imports: [LogicBacktestPapersComponent],
      providers: [
        provideHttpClient(),
        { provide: SecuritiesService, useValue: api },
        {
          provide: TechLogService,
          useValue: jasmine.createSpyObj('TechLogService', [
            'event',
            'logicThreadKey',
            'loadEnabled',
            'setEnabled',
            'start',
            'end',
            'flushNow',
          ]),
        },
      ],
    }).compileComponents();

    const techLog = TestBed.inject(TechLogService) as jasmine.SpyObj<TechLogService>;
    techLog.enabled = true;
    techLog.logicThreadKey.and.returnValue('logic:1:paper');
    techLog.flushNow.and.stub();

    fixture = TestBed.createComponent(LogicBacktestPapersComponent);
    component = fixture.componentInstance;
    component.trades = [sampleTrade];
    component.dateFrom = '2026-04-01';
    component.dateTo = '2026-07-01';
    component.timeframeId = 6;
    component.signalIndicatorIds = [1];
    component.ngOnChanges({
      trades: {
        currentValue: component.trades,
        previousValue: null,
        firstChange: true,
        isFirstChange: () => true,
      },
      signalIndicatorIds: {
        currentValue: component.signalIndicatorIds,
        previousValue: null,
        firstChange: true,
        isFirstChange: () => true,
      },
    });
    fixture.detectChanges();
  });

  it('lists only papers with trades', () => {
    expect(component.paperRows.length).toBe(1);
    expect(component.paperRows[0].security_id).toBe(7);
  });

  it('loads prices only after paper expand (lazy, no UI block on list)', fakeAsync(() => {
    expect(api.getPrices).not.toHaveBeenCalled();
    component.togglePaper(new Event('click'), 7);
    expect(api.getPrices).not.toHaveBeenCalled();
    expect(component.isPaperExpanded(7)).toBeTrue();
    tick(0);
    expect(api.getPrices).toHaveBeenCalled();
    expect(api.syncIndicatorSeries).not.toHaveBeenCalled();
    tick(500); // deferred indicator bootstrap
  }));

  it('does not reload chart HTTP when trades poll updates during expand', fakeAsync(() => {
    component.togglePaper(new Event('click'), 7);
    tick(0);
    const callsAfterExpand = api.getPrices.calls.count();
    expect(callsAfterExpand).toBeGreaterThan(0);
    component.trades = [
      sampleTrade,
      {
        ...sampleTrade,
        id: 2,
        bar_dt: '2026-04-10 11:00:00',
        financial_result: 10,
      },
    ];
    component.ngOnChanges({
      trades: {
        currentValue: component.trades,
        previousValue: [sampleTrade],
        firstChange: false,
        isFirstChange: () => false,
      },
    });
    expect(api.getPrices.calls.count()).toBe(callsAfterExpand);
    expect(component.overlays(7).markers.length).toBeGreaterThan(0);
    tick(500);
  }));

  it('falls back to trade timeframe_id when input timeframeId is null', fakeAsync(() => {
    component.timeframeId = null;
    component.togglePaper(new Event('click'), 7);
    tick(0);
    expect(api.getPrices).toHaveBeenCalledWith(7, 6, 120, jasmine.any(String));
    tick(500);
  }));

  it('chartIndicatorsForDisplay returns EMPTY while suppressIndicators', () => {
    const st = component.chartState(7);
    st.suppressIndicators = true;
    st.indicatorSeries = [
      {
        indicator_code: 'SMA',
        line_code: 'VALUE',
        line_name: 'SMA',
        color: '#000',
        on_price_scale: true,
        is_threshold: false,
        points: [],
      },
    ];
    expect(component.chartIndicatorsForDisplay(7)).toEqual([]);
  });

  it('onVisibleRange auto emit does not suppress', () => {
    const st = component.chartState(7);
    st.candles = [
      {
        dt: '2026-04-10 10:00:00',
        open_price: 1,
        high_price: 1,
        low_price: 1,
        close_price: 1,
        volume: 1,
      },
    ];
    component.onVisibleRange(7, {
      startDt: '2026-04-10 10:00:00',
      endDt: '2026-04-10 10:00:00',
      count: 1,
      viewStart: 0,
      userInitiated: false,
    });
    expect(api.getIndicatorValues).not.toHaveBeenCalled();
    expect(api.syncIndicatorSeries).not.toHaveBeenCalled();
  });

  it('caches overlays so expand does not rebuild markers each read', () => {
    const a = component.overlays(7);
    const b = component.overlays(7);
    expect(a).toBe(b);
    expect(a.markers.length).toBeGreaterThan(0);
  });

  it('sorts candles ascending even when server returns DESC (applies sortCandlesAsc)', () => {
    const st = component.chartState(7);
    st.hasMore = false;
    // Сервер отдаёт новые → старые; график должен получить ASC.
    const desc: Array<{ dt: string; open_price: number; high_price: number; low_price: number; close_price: number; volume: number }> = [
      { dt: '2026-04-10 12:00:00', open_price: 3, high_price: 3, low_price: 3, close_price: 3, volume: 1 },
      { dt: '2026-04-10 11:00:00', open_price: 2, high_price: 2, low_price: 2, close_price: 2, volume: 1 },
      { dt: '2026-04-10 10:00:00', open_price: 1, high_price: 1, low_price: 1, close_price: 1, volume: 1 },
    ];
    component['applyCandles'](7, st, desc, null, null, null, { loadIndicators: false });
    const dts = st.candles.map((c) => c.dt);
    expect(dts).toEqual(['2026-04-10 10:00:00', '2026-04-10 11:00:00', '2026-04-10 12:00:00']);
  });
});
