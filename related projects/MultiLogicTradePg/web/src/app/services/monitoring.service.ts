import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AppConfigService } from './app-config.service';

export type ErrorLevel = 'warning' | 'error' | 'fatal';

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

@Injectable({ providedIn: 'root' })
export class MonitoringService {
  constructor(
    private readonly http: HttpClient,
    private readonly appConfig: AppConfigService
  ) {}

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
}
