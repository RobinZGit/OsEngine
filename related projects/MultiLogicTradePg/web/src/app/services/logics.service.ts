import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { AppConfigService } from './app-config.service';
import { LogicIndicatorSignalRow, LogicRow, LogicParamsResponse, LogicSecurityRow, LogicStopRow, LogicTradingParamsPayload, LogicTradingParamsResponse } from '../models/logic.model';
import { LogicTradeLotRow, LogicTradeRow } from '../shared/logic-trade';
import type { BacktestRunStatus } from '../logics/logic-positions-panel.component';
import { LogicPayload } from '../models/lookup.model';

export interface SignalRatingPrecalcStatus {
  logic_id: number;
  status: 'idle' | 'pending' | 'running' | 'done' | 'failed';
  progress_pct: number;
  phase_message: string;
  bars_total: number;
  bars_done: number;
  lookback_days: number;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface ProcessStatusItem {
  type: string;
  label: string;
  status: string;
  detail?: string | null;
  wait?: string | null;
  age?: string | null;
  progress_pct?: number | null;
  logic_id?: number | null;
  started_at?: string | null;
}

@Injectable({ providedIn: 'root' })
export class LogicsService {
  constructor(
    private readonly http: HttpClient,
    private readonly appConfig: AppConfigService
  ) {}

  getLogics(): Observable<LogicRow[]> {
    return this.http.get<LogicRow[]>(`${this.appConfig.apiUrl}/logics`);
  }

  getProcesses(): Observable<{ rows: ProcessStatusItem[] }> {
    return this.http.get<{ rows: ProcessStatusItem[] }>(
      `${this.appConfig.apiUrl}/processes`
    );
  }

  createLogic(payload: LogicPayload): Observable<LogicRow> {
    return this.http.post<LogicRow>(`${this.appConfig.apiUrl}/logics`, payload);
  }

  updateLogic(id: number, payload: LogicPayload): Observable<LogicRow> {
    return this.http.put<LogicRow>(
      `${this.appConfig.apiUrl}/logics/${id}`,
      payload
    );
  }

  copyLogic(id: number): Observable<LogicRow> {
    return this.http.post<LogicRow>(
      `${this.appConfig.apiUrl}/logics/${id}/copy`,
      {}
    );
  }

  updateLogicEnabled(
    id: number,
    is_enabled: boolean
  ): Observable<{
    id: number;
    is_enabled: boolean;
    rating_precalc?: SignalRatingPrecalcStatus;
  }> {
    return this.http.patch<{
      id: number;
      is_enabled: boolean;
      rating_precalc?: SignalRatingPrecalcStatus;
    }>(`${this.appConfig.apiUrl}/logics/${id}`, { is_enabled });
  }

  getLogicParams(logicId: number): Observable<LogicParamsResponse> {
    return this.http.get<LogicParamsResponse>(
      `${this.appConfig.apiUrl}/logic-params`,
      { params: { logic_id: String(logicId) } }
    );
  }

  saveLogicParams(
    logicId: number,
    payload: LogicTradingParamsPayload
  ): Observable<LogicParamsResponse> {
    return this.http.put<LogicParamsResponse>(
      `${this.appConfig.apiUrl}/logic-params`,
      { logic_id: logicId, ...payload }
    );
  }

  updateLogicTradingParams(
    id: number,
    payload: LogicTradingParamsPayload
  ): Observable<LogicTradingParamsResponse> {
    return this.saveLogicParams(id, payload).pipe(
      map((r) => ({ id, ...r.trading }))
    );
  }

  deleteLogic(id: number): Observable<{ ok: boolean; id: number }> {
    return this.http.delete<{ ok: boolean; id: number }>(
      `${this.appConfig.apiUrl}/logics/${id}`
    );
  }

  getLogicIndicatorSignals(
    logicId: number
  ): Observable<LogicIndicatorSignalRow[]> {
    return this.http.get<LogicIndicatorSignalRow[]>(
      `${this.appConfig.apiUrl}/logic-indicator-signals`,
      { params: { logic_id: String(logicId) } }
    );
  }

  createLogicIndicatorSignal(body: {
    logic_id: number;
    indicator_id: number;
    position_event: 'open' | 'close';
    position_side: 'long' | 'short';
    signal_kind: 'trend' | 'counter';
    formula: string;
  }): Observable<LogicIndicatorSignalRow> {
    return this.http.post<LogicIndicatorSignalRow>(
      `${this.appConfig.apiUrl}/logic-indicator-signals`,
      body
    );
  }

  updateLogicIndicatorSignal(
    id: number,
    body: { formula: string; is_active?: boolean }
  ): Observable<LogicIndicatorSignalRow> {
    return this.http.put<LogicIndicatorSignalRow>(
      `${this.appConfig.apiUrl}/logic-indicator-signals/${id}`,
      body
    );
  }

  deleteLogicIndicatorSignal(
    id: number
  ): Observable<{ ok: boolean; id: number }> {
    return this.http.delete<{ ok: boolean; id: number }>(
      `${this.appConfig.apiUrl}/logic-indicator-signals/${id}`
    );
  }

  getLogicStops(logicId: number): Observable<LogicStopRow[]> {
    return this.http.get<LogicStopRow[]>(
      `${this.appConfig.apiUrl}/logic-stops`,
      { params: { logic_id: String(logicId) } }
    );
  }

  createLogicStop(body: {
    logic_id: number;
    rule_kind: 'stop_loss' | 'take_profit';
    scope_type: 'security' | 'security_resume' | 'portfolio';
    value: number;
    value_unit: 'percent' | 'atr';
  }): Observable<LogicStopRow> {
    return this.http.post<LogicStopRow>(
      `${this.appConfig.apiUrl}/logic-stops`,
      body
    );
  }

  updateLogicStop(
    id: number,
    body: {
      scope_type?: 'security' | 'security_resume' | 'portfolio';
      value?: number;
      value_unit?: 'percent' | 'atr';
      is_active?: boolean;
    }
  ): Observable<LogicStopRow> {
    return this.http.put<LogicStopRow>(
      `${this.appConfig.apiUrl}/logic-stops/${id}`,
      body
    );
  }

  deleteLogicStop(id: number): Observable<{ ok: boolean; id: number }> {
    return this.http.delete<{ ok: boolean; id: number }>(
      `${this.appConfig.apiUrl}/logic-stops/${id}`
    );
  }

  getLogicSecurities(logicId: number): Observable<LogicSecurityRow[]> {
    return this.http.get<LogicSecurityRow[]>(
      `${this.appConfig.apiUrl}/logic-securities`,
      { params: { logic_id: String(logicId) } }
    );
  }

  addLogicSecuritiesBulk(
    logicId: number,
    securityIds: number[]
  ): Observable<LogicSecurityRow[]> {
    return this.http.post<LogicSecurityRow[]>(
      `${this.appConfig.apiUrl}/logic-securities/bulk`,
      { logic_id: logicId, security_ids: securityIds }
    );
  }

  deleteLogicSecurity(id: number): Observable<{ ok: boolean; id: number }> {
    return this.http.delete<{ ok: boolean; id: number }>(
      `${this.appConfig.apiUrl}/logic-securities/${id}`
    );
  }

  getLogicTrades(logicId: number, limit = 100, isTest?: boolean): Observable<LogicTradeRow[]> {
    const params: Record<string, string> = {
      logic_id: String(logicId),
      limit: String(limit),
    };
    if (isTest === true) params['is_test'] = '1';
    if (isTest === false) params['is_test'] = '0';
    return this.http.get<LogicTradeRow[]>(`${this.appConfig.apiUrl}/logic-trades`, {
      params,
    });
  }

  getLogicTradesPnlSummary(isTest = true): Observable<{
    is_test: boolean;
    rows: Array<{
      logic_id: number;
      financial_result: number;
      commission: number;
      trade_count: number;
    }>;
  }> {
    return this.http.get<{
      is_test: boolean;
      rows: Array<{
        logic_id: number;
        financial_result: number;
        commission: number;
        trade_count: number;
      }>;
    }>(`${this.appConfig.apiUrl}/logic-trades/pnl-summary`, {
      params: { is_test: isTest ? '1' : '0' },
    });
  }

  getLogicTradeLots(tradeId: number): Observable<LogicTradeLotRow[]> {
    return this.http.get<LogicTradeLotRow[]>(
      `${this.appConfig.apiUrl}/logic-trade-lots`,
      { params: { trade_id: String(tradeId) } }
    );
  }

  closeAllPositionsAtMarket(logicId: number): Observable<{
    ok: boolean;
    closed?: number;
    skipped?: number;
    errors?: unknown[];
    error?: string;
  }> {
    return this.http.post<{
      ok: boolean;
      closed?: number;
      skipped?: number;
      errors?: unknown[];
      error?: string;
    }>(`${this.appConfig.apiUrl}/logic-trades/close-all`, { logic_id: logicId });
  }

  startBacktest(body: {
    logic_id: number;
    date_from: string;
    date_to: string;
  }): Observable<{ ok: boolean; run_id: number }> {
    return this.http.post<{ ok: boolean; run_id: number }>(
      `${this.appConfig.apiUrl}/logic-backtest/start`,
      body
    );
  }

  getBacktestStatus(logicId: number, runId?: number): Observable<BacktestRunStatus | null> {
    const params: Record<string, string> = { logic_id: String(logicId) };
    if (runId != null) params['run_id'] = String(runId);
    return this.http.get<BacktestRunStatus | null>(
      `${this.appConfig.apiUrl}/logic-backtest/status`,
      { params }
    );
  }

  cancelBacktest(runId: number): Observable<{ ok: boolean; run_id: number }> {
    return this.http.post<{ ok: boolean; run_id: number }>(
      `${this.appConfig.apiUrl}/logic-backtest/cancel`,
      { run_id: runId }
    );
  }

  startSignalRatingPrecalc(logicId: number): Observable<SignalRatingPrecalcStatus> {
    return this.http.post<SignalRatingPrecalcStatus>(
      `${this.appConfig.apiUrl}/logics/${logicId}/signal-rating-precalc`,
      {}
    );
  }

  getSignalRatingPrecalc(logicId: number): Observable<SignalRatingPrecalcStatus> {
    return this.http.get<SignalRatingPrecalcStatus>(
      `${this.appConfig.apiUrl}/logics/${logicId}/signal-rating-precalc`
    );
  }
}
