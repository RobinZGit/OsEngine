import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, Subject } from 'rxjs';
import { AppConfigService } from './app-config.service';

export type ErrorLevel = 'warning' | 'error' | 'fatal' | 'success';

/** Запись журнала ошибок (таблица app_error_log). */
export interface ErrorLogRow {
  id: number;
  created_at: string;
  level: ErrorLevel;
  source: string;
  category: string;
  code: string | null;
  message: string;
  detail: string | null;
  endpoint: string | null;
  http_status: number | null;
  method: string | null;
  trace_id: string | null;
  logic_id: number | null;
  security_id: number | null;
  context: Record<string, unknown> | null;
}

/** Точка графика отказов (одна минута). */
export interface ErrorStatPoint {
  ts: string;
  count: number;
}

export interface ErrorStats {
  minutes: number;
  total: number;
  rows: ErrorStatPoint[];
}

/** Счётчики журнала по уровням (за окно хранения, 24 ч). */
export interface ErrorCounts {
  warning: number;
  error: number;
  fatal: number;
  total: number;
}

/** Сводка для «света» вкладки и заголовка «Мониторинг системы». */
export interface MonitoringSummary {
  windowHours: number;
  counts: ErrorCounts;
  latestCritical: ErrorLogRow | null;
  latestWarning: ErrorLogRow | null;
  /** Последний «пинг» сервисов (кнопка «Пинг») — по нему сбрасывается «свет» вкладки. */
  latestPing: ErrorLogRow | null;
}

export interface DbHangRow {
  pid: number;
  duration_sec: number;
  wait_event_type: string | null;
  wait_event: string | null;
  state: string;
  application_name: string | null;
  client_addr: string | null;
  query: string;
  query_start: string;
  kind: string;
}

export interface MonitoringHangs {
  thresholdSec: number;
  dbActive: DbHangRow[];
  recent: ErrorLogRow[];
}

export interface ClientMonitorEvent {
  kind: 'web_hang' | 'report_build' | 'hang' | 'stall' | 'long_task';
  phase: 'start' | 'progress' | 'done' | 'error' | 'stall' | 'event' | 'resolved';
  message: string;
  detail?: string | null;
  endpoint?: string | null;
  method?: string | null;
  logicId?: number | null;
  securityId?: number | null;
  context?: Record<string, unknown>;
  level?: ErrorLevel;
}

/** Один результат проверки сервиса при «пинге». */
export interface PingCheck {
  key: string;
  label: string;
  severity: 'error' | 'warning';
  ok: boolean;
  latencyMs: number;
  detail: string;
}

/** Итог проверки всех сервисов (POST /api/monitoring/ping). */
export interface PingResult {
  ok: boolean;
  checkedAt: string;
  checks: PingCheck[];
}

/**
 * Короткий текст последней ошибки для заголовка/вкладки: «HTTP 502: POST /api/prices/refresh».
 * Код (HTTP-статус или технический код) + обрезанное сообщение без хвоста «→ HTTP xxx».
 */
export function formatErrorShort(row: ErrorLogRow | null | undefined): string {
  if (!row) return '';
  const code = row.http_status ? `HTTP ${row.http_status}` : row.code || row.level;
  let msg = (row.message || '').trim();
  const arrow = msg.indexOf(' → ');
  if (arrow >= 0) msg = msg.slice(0, arrow).trim();
  if (!msg) msg = (row.endpoint || '').trim();
  const clipped = msg.length > 64 ? `${msg.slice(0, 63)}…` : msg;
  return clipped && clipped !== code ? `${code}: ${clipped}` : code;
}

@Injectable({ providedIn: 'root' })
export class MonitoringService {
  /** Сигнал «перечитать сводку мониторинга» — после успешного «Пинга» сразу
      обновляем «свет» вкладки в app.component.ts, не дожидаясь 15-секундного опроса. */
  private readonly refreshSubject = new Subject<void>();
  readonly refresh$ = this.refreshSubject.asObservable();

  private webHangTimer: ReturnType<typeof setInterval> | null = null;
  private lastWebHangAt = 0;
  private lastTickAt = Date.now();

  constructor(
    private readonly http: HttpClient,
    private readonly appConfig: AppConfigService
  ) {
    this.startWebHangWatchdog();
  }

  /** �������� �⮪ ���������� ᢮��� (�ࢨ��, ����� ���). */
  notifyRefresh(): void {
    this.refreshSubject.next();
  }

  private startWebHangWatchdog(): void {
    if (this.webHangTimer || typeof window === 'undefined') return;
    this.lastTickAt = Date.now();
    this.webHangTimer = setInterval(() => {
      const now = Date.now();
      const delta = now - this.lastTickAt;
      this.lastTickAt = now;
      if (delta > 15000 && !document.hidden) {
        if (now - this.lastWebHangAt < 60000) return;
        this.lastWebHangAt = now;
        this.reportClientEvent({
          kind: 'web_hang',
          phase: 'stall',
          level: 'warning',
          message: `Web UI stall detected: main thread blocked ~${Math.round(delta / 1000)}s`,
          detail: `Interval drift ${delta}ms (threshold 15000ms).`,
          context: { deltaMs: delta, url: window.location.href },
        }).subscribe({ error: () => {} });
      }
    }, 5000);
  }

  getErrors(opts?: { limit?: number; level?: ErrorLevel }): Observable<{ rows: ErrorLogRow[] }> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.level) params.set('level', opts.level);
    const q = params.toString();
    return this.http.get<{ rows: ErrorLogRow[] }>(
      `${this.appConfig.apiUrl}/monitoring/errors${q ? `?${q}` : ''}`
    );
  }

  getStats(minutes = 60): Observable<ErrorStats> {
    return this.http.get<ErrorStats>(
      `${this.appConfig.apiUrl}/monitoring/stats?minutes=${minutes}`
    );
  }

  getSummary(): Observable<MonitoringSummary> {
    return this.http.get<MonitoringSummary>(`${this.appConfig.apiUrl}/monitoring/summary`);
  }

  /**
   * Проверить все сервисы (PostgreSQL, T-Bank, MOEX) без сделок — по кнопке «Пинг».
   * Результаты (включая успешные) пишутся сервером в журнал мониторинга.
   */
  ping(): Observable<PingResult> {
    return this.http.post<PingResult>(`${this.appConfig.apiUrl}/monitoring/ping`, {});
  }

  /** #1083: логики с большой задержкой исполнения (порог 30 сек). */
  getDelayAlerts(): Observable<DelayAlertsResponse> {
    return this.http.get<DelayAlertsResponse>(
      `${this.appConfig.apiUrl}/logic-trades/delay-alerts`
    );
  }

  getHangs(thresholdSec = 30, limit = 50): Observable<MonitoringHangs> {
    const params = new URLSearchParams();
    params.set('thresholdSec', String(thresholdSec));
    params.set('limit', String(limit));
    return this.http.get<MonitoringHangs>(
      `${this.appConfig.apiUrl}/monitoring/hangs?${params.toString()}`
    );
  }

  reportClientEvent(event: ClientMonitorEvent): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(
      `${this.appConfig.apiUrl}/monitoring/client-event`,
      event
    );
  }

}

export interface DelayAlertRow {
  logic_id: number;
  logic_name: string;
  trade_count: number;
  slow_count: number;
  avg_delay_sec: number;
  max_delay_sec: number;
  last_at: string | null;
}

export interface DelayAlertsResponse {
  threshold_sec: number;
  window_hours: number;
  rows: DelayAlertRow[];
}
