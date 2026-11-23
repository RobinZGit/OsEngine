/**
 * Тренажёр: сохранение результатов сессий в БД и статистика по всем сессиям.
 * HTTP → `/api/trainer/sessions`, `/api/trainer/stats`.
 */
import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AppConfigService } from './app-config.service';

export interface TrainerTradeSavePayload {
  side: 'long' | 'short';
  open_dt: string;
  open_price: number;
  close_dt: string | null;
  close_price: number | null;
  commission: number;
  pnl: number | null;
  pnl_pct: number | null;
  annual_pct: number | null;
  holding_ms: number | null;
  is_open: boolean;
}

export interface TrainerSessionSavePayload {
  session_key: string;
  security_id: number | null;
  timeframe_id: number | null;
  security_name: string;
  timeframe_tf: string;
  started_at: string | null;
  ended_at: string | null;
  trading_ms: number | null;
  commission_pct: number;
  exec_delay_sec: number;
  finished: boolean;
  total_pnl: number;
  unrealized_pnl: number;
  annual_pct: number | null;
  avg_exec_delay_sec: number | null;
  trades: TrainerTradeSavePayload[];
}

export interface TrainerStatsGroupRow {
  security_id?: number | null;
  timeframe_id?: number | null;
  security_name?: string;
  timeframe_tf?: string;
  sessions: number;
  trades: number;
  wins: number;
  losses: number;
  net_pnl: number;
  commission: number;
  avg_holding_ms: number | null;
  long_pnl: number;
  short_pnl: number;
  long_wins: number;
  long_losses: number;
  short_wins: number;
  short_losses: number;
}

export interface TrainerStatsSideRow {
  side: 'long' | 'short';
  trades: number;
  wins: number;
  losses: number;
  net_pnl: number;
  avg_holding_ms: number | null;
}

export interface TrainerStatsTotals {
  sessions: number;
  finished_sessions: number;
  net_pnl: number;
  trades: number;
  wins: number;
  losses: number;
  avg_holding_ms: number | null;
  trading_ms: number;
  first_started_at: string | null;
  last_ended_at: string | null;
}

export interface TrainerStatsResponse {
  totals: TrainerStatsTotals;
  bySecurity: TrainerStatsGroupRow[];
  byTimeframe: TrainerStatsGroupRow[];
  bySecurityTimeframe: TrainerStatsGroupRow[];
  bySide: TrainerStatsSideRow[];
}

@Injectable({ providedIn: 'root' })
export class TrainerService {
  constructor(
    private readonly http: HttpClient,
    private readonly appConfig: AppConfigService
  ) {}

  saveSession(payload: TrainerSessionSavePayload): Observable<{ id: number; session_key: string }> {
    return this.http.post<{ id: number; session_key: string }>(
      `${this.appConfig.apiUrl}/trainer/sessions`,
      payload
    );
  }

  getStats(): Observable<TrainerStatsResponse> {
    return this.http.get<TrainerStatsResponse>(`${this.appConfig.apiUrl}/trainer/stats`);
  }

  getSessions(limit = 100): Observable<{ rows: unknown[] }> {
    const params = new HttpParams().set('limit', String(limit));
    return this.http.get<{ rows: unknown[] }>(`${this.appConfig.apiUrl}/trainer/sessions`, { params });
  }
}
