import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { MonitoringComponent } from './monitoring.component';
import {
  ErrorLogRow,
  MonitoringService,
  MonitoringSummary,
  formatErrorShort,
} from '../services/monitoring.service';
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

function summary(latestCritical: ErrorLogRow | null): MonitoringSummary {
  return {
    windowHours: 24,
    counts: { warning: 0, error: latestCritical ? 1 : 0, fatal: 0, total: latestCritical ? 1 : 0 },
    latestCritical,
    latestWarning: null,
  };
}

describe('MonitoringComponent (#989)', () => {
  let errors: ErrorLogRow[];
  let stats: { minutes: number; total: number; rows: Array<{ ts: string; count: number }> };
  let summaryData: MonitoringSummary;
  let serviceStub: {
    getErrors: jasmine.Spy;
    getStats: jasmine.Spy;
    getSummary: jasmine.Spy;
  };

  beforeEach(() => {
    errors = [];
    stats = { minutes: 60, total: 0, rows: [] };
    summaryData = summary(null);
    serviceStub = {
      getErrors: jasmine.createSpy('getErrors').and.callFake(() => of({ rows: errors })),
      getStats: jasmine.createSpy('getStats').and.callFake(() => of(stats)),
      getSummary: jasmine.createSpy('getSummary').and.callFake(() => of(summaryData)),
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

  it('formatErrorShort: код + сообщение без хвоста «→ HTTP xxx»', () => {
    expect(formatErrorShort(row(1, 'error', 'POST /api/prices/refresh → HTTP 502'))).toBe(
      'HTTP 500: POST /api/prices/refresh'
    );
    expect(formatErrorShort(null)).toBe('');
  });

  it('заголовок показывает последнюю критичную ошибку в скобках (сводка)', () => {
    summaryData = summary(row(9, 'error', 'POST /api/prices/refresh → HTTP 502'));
    const fixture = TestBed.createComponent(MonitoringComponent);
    fixture.detectChanges();

    const c = fixture.componentInstance;
    expect(serviceStub.getSummary).toHaveBeenCalled();
    expect(c.criticalText).toBe('HTTP 500: POST /api/prices/refresh');
    const text = (fixture.nativeElement as HTMLElement).textContent || '';
    expect(text).toContain('(HTTP 500: POST /api/prices/refresh)');
  });

  it('без критичных ошибок заголовок без текста в скобках', () => {
    summaryData = summary(null);
    const fixture = TestBed.createComponent(MonitoringComponent);
    fixture.detectChanges();

    const c = fixture.componentInstance;
    expect(c.criticalText).toBe('');
    const text = (fixture.nativeElement as HTMLElement).textContent || '';
    expect(text).not.toContain('(HTTP');
  });
});
