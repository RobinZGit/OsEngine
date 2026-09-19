import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { TerminalPanelComponent } from './terminal-panel.component';
import { SecuritiesService } from '../services/securities.service';
import { TerminalStateService } from '../services/terminal-state.service';
import { TechLogService } from '../services/tech-log.service';
import { PriceCandle, SecurityRow } from '../models/market.model';

describe('TerminalPanelComponent', () => {
  let fixture: ComponentFixture<TerminalPanelComponent>;
  let component: TerminalPanelComponent;

  const security: SecurityRow = {
    id: 8620,
    name: 'Si-6.26',
    prefix: 'Si',
    security_type: 'Futures',
    instrument_market: 'futures',
    exchange_id: 1,
    exchange_name: 'MOEX',
  };

  const candle = (dt: string, close: number): PriceCandle => ({
    dt,
    open_price: close,
    high_price: close,
    low_price: close,
    close_price: close,
    volume: 1,
  });

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TerminalPanelComponent, HttpClientTestingModule],
      providers: [
        {
          provide: SecuritiesService,
          useValue: {
            getPrices: jasmine.createSpy('getPrices').and.returnValue(of([])),
          },
        },
        {
          provide: TerminalStateService,
          useValue: {
            placeTrade: jasmine.createSpy('placeTrade').and.returnValue(of({ ok: true })),
          },
        },
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

    fixture = TestBed.createComponent(TerminalPanelComponent);
    component = fixture.componentInstance;
    component.security = security;
    component.timeframeId = 6;
    fixture.detectChanges();
  });

  afterEach(() => {
    component.ngOnDestroy();
  });

  it('computes quantity and sum without commission from the slider amount', () => {
    component.chartState = {
      candles: [candle('2026-09-19 10:00:00', 100)],
      loading: false,
      loadingOlder: false,
      hasMore: true,
      error: null,
    };
    component.tradeAmount = 1000;
    expect(component.tradeQuantity).toBe(10);
    expect(component.tradeSum).toBe(1000);
  });

  it('shows zero quantity and sum when price is missing', () => {
    component.chartState = {
      candles: [],
      loading: false,
      loadingOlder: false,
      hasMore: false,
      error: null,
    };
    component.tradeAmount = 1000;
    expect(component.tradeQuantity).toBe(0);
    expect(component.tradeSum).toBe(0);
  });

  it('updates the forming candle in place and appends new candles on poll', () => {
    const base = {
      candles: [candle('2026-09-19 10:00:00', 100)],
      loading: false,
      loadingOlder: false,
      hasMore: true,
      error: null,
    };
    let result: typeof base | null = null;
    const apply = (next: typeof base) => {
      result = next;
    };
    const getPrices = TestBed.inject(SecuritiesService).getPrices as jasmine.Spy;
    getPrices.and.returnValue(
      of([
        candle('2026-09-19 10:00:00', 101),
        candle('2026-09-19 10:15:00', 102),
      ])
    );
    (component as unknown as {
      appendLatest(
        securityId: number,
        state: typeof base,
        apply: (next: typeof base) => void
      ): void;
    }).appendLatest(8620, base, apply);

    expect(result).not.toBeNull();
    expect(result!.candles.length).toBe(2);
    expect(result!.candles[0].close_price).toBe(101);
    expect(result!.candles[1].close_price).toBe(102);
  });

  it('does not touch state when poll returns nothing new', () => {
    const base = {
      candles: [candle('2026-09-19 10:00:00', 100)],
      loading: false,
      loadingOlder: false,
      hasMore: true,
      error: null,
    };
    let called = false;
    const apply = (next: typeof base) => {
      called = true;
    };
    const getPrices = TestBed.inject(SecuritiesService).getPrices as jasmine.Spy;
    getPrices.and.returnValue(of([candle('2026-09-19 10:00:00', 100)]));
    (component as unknown as {
      appendLatest(
        securityId: number,
        state: typeof base,
        apply: (next: typeof base) => void
      ): void;
    }).appendLatest(8620, base, apply);

    expect(called).toBeFalse();
  });
});