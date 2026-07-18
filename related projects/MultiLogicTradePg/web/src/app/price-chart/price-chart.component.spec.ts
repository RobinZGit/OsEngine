import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PriceChartComponent } from './price-chart.component';
import { TechLogService } from '../services/tech-log.service';

describe('PriceChartComponent', () => {
  let fixture: ComponentFixture<PriceChartComponent>;
  let component: PriceChartComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PriceChartComponent],
      providers: [
        {
          provide: TechLogService,
          useValue: {
            enabled: false,
            event: jasmine.createSpy('event'),
            threadKey: () => 'sec:0:chart',
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(PriceChartComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('shows error text when error is set', () => {
    component.loading = false;
    component.candles = [];
    component.error = 'Нет свечей — нажмите «Загрузить цены»';
    component.ngOnChanges({
      error: {
        currentValue: component.error,
        previousValue: null,
        firstChange: true,
        isFirstChange: () => true,
      },
    });
    fixture.detectChanges();
    expect(component.error).toContain('Загрузить цены');
  });

  it('does not emit loadOlder when there are no candles', () => {
    const spy = jasmine.createSpy('loadOlder');
    component.loadOlder.subscribe(spy);
    component.candles = [];
    component.loading = false;

    const event = new PointerEvent('pointerdown', { clientX: 100 });
    component.onPointerDown(event);

    expect(spy).not.toHaveBeenCalled();
  });

  it('emits recalcIndicators with visible range', () => {
    const spy = jasmine.createSpy('recalc');
    component.recalcIndicators.subscribe(spy);
    component.candles = [
      { dt: '2026-01-01T10:00:00', open_price: 1, high_price: 1, low_price: 1, close_price: 1, volume: 1 },
      { dt: '2026-01-01T10:15:00', open_price: 2, high_price: 2, low_price: 2, close_price: 2, volume: 1 },
    ];
    component.ngOnChanges({
      candles: {
        currentValue: component.candles,
        previousValue: [],
        firstChange: true,
        isFirstChange: () => true,
      },
    });
    component.onRecalcClick(new Event('click'));
    expect(spy).toHaveBeenCalled();
    expect(spy.calls.mostRecent().args[0].count).toBeGreaterThan(0);
  });

  it('opens and closes fullscreen', () => {
    component.openFullscreen();
    expect(component.fullscreen).toBeTrue();
    component.closeFullscreen();
    expect(component.fullscreen).toBeFalse();
  });

  it('pointerleave without drag does not emit visibleRangeChange', () => {
    const spy = jasmine.createSpy('visibleRangeChange');
    component.visibleRangeChange.subscribe(spy);
    component.candles = [
      { dt: '2026-01-01T10:00:00', open_price: 1, high_price: 1, low_price: 1, close_price: 1, volume: 1 },
    ];
    component.onPointerLeave(new PointerEvent('pointerleave'));
    expect(spy).not.toHaveBeenCalled();
  });

  it('allows pan while loadingOlder (initial load still blocks)', () => {
    component.candles = [
      { dt: '2026-01-01T10:00:00', open_price: 1, high_price: 1, low_price: 1, close_price: 1, volume: 1 },
    ];
    component.loading = false;
    component.loadingOlder = true;

    const down = new PointerEvent('pointerdown', { clientX: 50, pointerId: 1 });
    Object.defineProperty(down, 'target', {
      value: { setPointerCapture: () => {}, releasePointerCapture: () => {} },
    });
    component.onPointerDown(down);
    expect((component as unknown as { dragging: boolean }).dragging).toBeTrue();

    (component as unknown as { dragging: boolean }).dragging = false;
    component.loading = true;
    component.loadingOlder = false;
    component.onPointerDown(down);
    expect((component as unknown as { dragging: boolean }).dragging).toBeFalse();
  });

  it('backtest overlays do not block pan', () => {
    component.candles = [
      { dt: '2026-01-01T10:00:00', open_price: 1, high_price: 1, low_price: 1, close_price: 1, volume: 1 },
      { dt: '2026-01-01T10:15:00', open_price: 2, high_price: 2, low_price: 2, close_price: 2, volume: 1 },
    ];
    component.loading = false;
    component.tradeMarkers = [
      { dt: '2026-01-01T10:00:00', price: 1, kind: 'open', side: 'long' },
    ];
    component.shadedRanges = [
      { startDt: '2026-01-01T10:00:00', endDt: '2026-01-01T10:15:00', kind: 'inverted' },
    ];

    const down = new PointerEvent('pointerdown', { clientX: 40, pointerId: 1 });
    Object.defineProperty(down, 'target', {
      value: { setPointerCapture: () => {}, releasePointerCapture: () => {} },
    });
    component.onPointerDown(down);
    expect((component as unknown as { dragging: boolean }).dragging).toBeTrue();
  });

  it('anchors zero on price scale for PACC', () => {
    component.indicatorSeries = [
      {
        indicator_code: 'PACC',
        line_code: 'VALUE',
        line_name: 'Ускорение цены',
        color: '#2563eb',
        on_price_scale: true,
        is_threshold: false,
        points: [{ dt: '2026-01-01T10:00:00', value: 0.1 }],
      },
    ];
    expect((component as unknown as { priceScaleAnchorsZero(): boolean }).priceScaleAnchorsZero()).toBeTrue();
  });

  it('gotoPrevTrade / gotoNextTrade jump by tradeMarkers', () => {
    const mk = (dt: string, price: number) => ({
      dt,
      open_price: price,
      high_price: price,
      low_price: price,
      close_price: price,
      volume: 1,
    });
    component.candles = [
      mk('2026-01-01T10:00:00', 1),
      mk('2026-01-01T10:15:00', 1),
      mk('2026-01-01T10:30:00', 1),
      mk('2026-01-01T10:45:00', 1),
      mk('2026-01-01T11:00:00', 1),
      mk('2026-01-01T11:15:00', 1),
    ];
    component.tradeMarkers = [
      { dt: '2026-01-01T10:00:00', price: 1, kind: 'open', side: 'long' },
      { dt: '2026-01-01T10:45:00', price: 1, kind: 'close', side: 'long' },
      { dt: '2026-01-01T11:15:00', price: 1, kind: 'open', side: 'short' },
    ];
    (component as unknown as { viewStart: number }).viewStart = 3;
    component.gotoNextTrade(new Event('click'));
    const vs1 = (component as unknown as { viewStart: number }).viewStart;
    expect(vs1).toBeGreaterThanOrEqual(0);
    component.gotoPrevTrade(new Event('click'));
    const vs2 = (component as unknown as { viewStart: number }).viewStart;
    expect(vs2).toBeGreaterThanOrEqual(0);
  });

  it('trade marker outside visible window is not pinned to last candle', () => {
    component.candles = [
      { dt: '2026-01-01T10:00:00', open_price: 1, high_price: 1, low_price: 1, close_price: 1, volume: 1 },
      { dt: '2026-01-01T10:15:00', open_price: 2, high_price: 2, low_price: 2, close_price: 2, volume: 1 },
      { dt: '2026-01-01T10:30:00', open_price: 3, high_price: 3, low_price: 3, close_price: 3, volume: 1 },
      { dt: '2026-01-01T10:45:00', open_price: 4, high_price: 4, low_price: 4, close_price: 4, volume: 1 },
    ];
    // Окно только на первых двух свечах
    (component as unknown as { viewStart: number }).viewStart = 0;
    spyOn(component as unknown as { viewCount: () => number }, 'viewCount').and.returnValue(2);
    const visible = component.candles.slice(0, 2);
    const idx = (
      component as unknown as {
        indexInVisible: (v: typeof visible, dt: string) => number;
      }
    ).indexInVisible(visible, '2026-01-01T10:45:00');
    // Сделка на 10:45 вне окна → не рисовать (раньше прилипало к последней visible)
    expect(idx).toBe(-1);
    const idxIn = (
      component as unknown as {
        indexInVisible: (v: typeof visible, dt: string) => number;
      }
    ).indexInVisible(visible, '2026-01-01T10:15:00');
    expect(idxIn).toBe(1);
  });
});
