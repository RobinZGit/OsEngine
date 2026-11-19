import { ComponentFixture, TestBed } from '@angular/core/testing';
import { EquityCurveChartComponent, equityHoverDays, equityHoverValues, nearestEquityPointIndex } from './equity-curve-chart.component';

describe('equity hover (#1077)', () => {
  it('nearestEquityPointIndex picks the closest X (first on tie)', () => {
    const pts = [{ x: 10 }, { x: 30 }, { x: 60 }];
    expect(nearestEquityPointIndex(pts, 32)).toBe(1);
    expect(nearestEquityPointIndex(pts, 20)).toBe(0);
    expect(nearestEquityPointIndex(pts, 0)).toBe(0);
    expect(nearestEquityPointIndex(pts, 999)).toBe(2);
  });

  it('equityHoverDays counts calendar days inclusively', () => {
    expect(equityHoverDays('2026-04-01', '2026-04-01')).toBe(1);
    expect(equityHoverDays('2026-04-01 00:00:00', '2026-04-10 13:45:00')).toBe(10);
    expect(equityHoverDays('', '2026-04-10')).toBeNull();
    expect(equityHoverDays('2026-04-10', '2026-04-01')).toBeNull();
  });

  it('equityHoverValues computes return% and annualized% from the point PnL', () => {
    // 10_000 на 1_000_000 = 1%; за 10 дней → 36.5% годовых.
    const v = equityHoverValues(10_000, 1_000_000, '2026-04-01', '2026-04-10');
    expect(v.days).toBe(10);
    expect(v.returnPct).toBeCloseTo(1, 6);
    expect(v.annualPct).toBeCloseTo(36.5, 6);
  });

  it('equityHoverValues handles zero/negative balance and single-day period', () => {
    expect(equityHoverValues(100, 0, '2026-04-01', '2026-04-01').returnPct).toBeNull();
    expect(equityHoverValues(-100, 1_000, '2026-04-01', '2026-04-01').annualPct).toBeCloseTo(
      -3650,
      6
    );
  });

  it('shows tooltip with PnL, commission, return% and annualized% on mousemove', () => {
    TestBed.configureTestingModule({ imports: [EquityCurveChartComponent] });
    const fixture: ComponentFixture<EquityCurveChartComponent> = TestBed.createComponent(
      EquityCurveChartComponent
    );
    const c = fixture.componentInstance;
    c.total = [
      { dt: '2026-04-01 00:00:00', value: 0 },
      { dt: '2026-04-10 00:00:00', value: 10_000 },
    ];
    c.commission = [
      { dt: '2026-04-01 00:00:00', value: 0 },
      { dt: '2026-04-10 00:00:00', value: 250 },
    ];
    c.initialBalance = 1_000_000;
    fixture.detectChanges();

    const canvas: HTMLCanvasElement = fixture.nativeElement.querySelector(
      'canvas.equity-curve-canvas'
    );
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(
      new MouseEvent('mousemove', {
        bubbles: true,
        clientX: rect.left + rect.width * 0.8,
        clientY: rect.top + rect.height * 0.5,
      })
    );
    fixture.detectChanges();

    const tip: HTMLElement | null = fixture.nativeElement.querySelector('.equity-tooltip');
    expect(tip).not.toBeNull();
    expect(tip!.textContent).toContain('10.04.2026');
    expect(tip!.textContent).toContain('+10000');
    expect(tip!.textContent).toContain('250.00');
    expect(tip!.textContent).toContain('+1.00%');
    expect(tip!.textContent).toContain('+36.50%');
    expect(fixture.nativeElement.querySelector('.equity-crosshair')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.equity-hover-dot')).not.toBeNull();

    canvas.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.equity-tooltip')).toBeNull();
  });
});
