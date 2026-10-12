import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { MonitoringComponent } from './monitoring.component';
import { ErrorLogRow, MonitoringService } from '../services/monitoring.service';
import { AppConfigService } from '../services/app-config.service';

function row(id: number, level: 'warning' | 'error' | 'fatal', message: string): ErrorLogRow {
  return {
    id,
    created_at: new Date(2026, 9, 12, 14, 0, id).toISOString(),
    level,
    source: 'api',
    category: 'http',
    code: `HTTP_${level === 'error' ? 500 : 404}`,
    message,
    detail: null,
    endpoint: '/api/terminal/trades',
    http_status: level === 'error' ? 500 : 404,
    method: 'GET',
    trace_id: null,
    logic_id: null,
    security_id: null,
    context: null,
  };
}

describe('MonitoringComponent (#989)', () => {
  let errors: ErrorLogRow[];
  let stats: { minutes: number; total: number; rows: Array<{ ts: string; count: number }> };
  let serviceStub: {
    getErrors: jasmine.Spy;
    getStats: jasmine.Spy;
  };

  beforeEach(() => {
    errors = [];
    stats = { minutes: 60, total: 0, rows: [] };
    serviceStub = {
      getErrors: jasmine.createSpy('getErrors').and.callFake(() => of({ rows: errors })),
      getStats: jasmine.createSpy('getStats').and.callFake(() => of(stats)),
    };

    TestBed.configureTestingModule({
      imports: [MonitoringComponent],
      providers: [
        { provide: MonitoringService, useValue: serviceStub },
        { provide: AppConfigService, useValue: { apiUrl: 'http://localhost:3000/api' } },
      ],
    });
  });

  it('показывает ошибки из API, свежие сверху (порядок как от сервера)', () => {
    errors = [row(5, 'error', 'Свежая ошибка'), row(1, 'warning', 'Старая')];
    const fixture = TestBed.createComponent(MonitoringComponent);
    fixture.detectChanges();

    const c = fixture.componentInstance;
    expect(serviceStub.getErrors).toHaveBeenCalled();
    expect(c.errors.length).toBe(2);
    expect(c.visibleErrors[0].id).toBe(5);
    const text = (fixture.nativeElement as HTMLElement).textContent || '';
    expect(text).toContain('Свежая ошибка');
  });

  it('фильтр по уровню оставляет только выбранный уровень', () => {
    errors = [row(3, 'error', 'ошибка'), row(2, 'warning', 'предупреждение'), row(1, 'fatal', 'критично')];
    const fixture = TestBed.createComponent(MonitoringComponent);
    fixture.detectChanges();

    const c = fixture.componentInstance;
    c.levelFilter = 'error';
    fixture.detectChanges();
    expect(c.visibleErrors.map((e) => e.id)).toEqual([3]);
  });

  it('график получает точки по минутам из stats', () => {
    stats = {
      minutes: 60,
      total: 4,
      rows: [
        { ts: '2026-10-12T13:59:00.000Z', count: 1 },
        { ts: '2026-10-12T14:00:00.000Z', count: 3 },
      ],
    };
    const fixture = TestBed.createComponent(MonitoringComponent);
    fixture.detectChanges();

    const c = fixture.componentInstance;
    expect(c.chartTotal).toBe(4);
    expect(c.chartPoints.length).toBe(2);
    expect(c.chartPoints[1].count).toBe(3);
  });

  it('при сбое API показывает сообщение, но не падает', () => {
    serviceStub.getErrors.and.returnValue(throwError(() => new HttpErrorResponse({ status: 500 })));
    const fixture = TestBed.createComponent(MonitoringComponent);
    fixture.detectChanges();

    const c = fixture.componentInstance;
    expect(c.loadError).toBeTruthy();
    expect(c.errors.length).toBe(0);
  });
});
