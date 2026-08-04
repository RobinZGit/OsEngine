/**
 * HTTP-клиент вкладки «Торговые операции».
 * Все методы — обёртки над Express `/api/logics*`, `/api/logic-*`, бэктестом и рейтингом.
 * Смысл полей и сценариев — в справке (иконка книги в шапке) и в COMMENT ON SQL-функций.
 */
import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { AppConfigService } from './app-config.service';
import {
  LogicIndicatorSignalRow,
  LogicNonTradingIntervalPayload,
  LogicNonTradingPeriodsResponse,
  LogicRow,
  LogicParamsResponse,
  LogicSecurityRow,
  LogicStopRow,
  LogicTradingParamsPayload,
  LogicTradingParamsResponse,
} from '../models/logic.model';
import { LogicTradeLotRow, LogicTradeRow } from '../shared/logic-trade';
import type {
  LogicStopScopeType,
  LogicStopValueUnit,
} from '../shared/logic-stop';
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

export interface TradeRunnerHealthLogic {
  stale?: boolean;
  last_trade_check_at?: string | null;
  account_type?: string | null;
  name?: string | null;
}

export interface TradeRunnerHealth {
  status: 'ok' | 'stale' | 'idle' | 'ui_required' | string;
  ok: boolean;
  stale: boolean;
  last_ok_at?: string | null;
  age_sec?: number | null;
  stale_sec?: number;
  enabled_count?: number;
  require_ui?: boolean;
  ui_active?: boolean;
  node_running?: boolean;
  logics?: Record<string, TradeRunnerHealthLogic> | Array<TradeRunnerHealthLogic & { id?: number }>;
  at?: string;
}

/** Archived backtest report row (list, no HTML). */
export interface BacktestReportListItem {
  id: number;
  run_id: number;
  logic_id: number;
  logic_name: string;
  date_from: string | null;
  date_to: string | null;
  timeframe: string | null;
  run_status: string | null;
  is_snapshot: boolean;
  deal_count: number;
  net_pnl: number | null;
  net_pnl_pct: number | null;
  profit_factor: number | null;
  max_drawdown_pct: number | null;
  download_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface BacktestReportDetailResponse {
  row: BacktestReportListItem & {
    summary?: unknown;
    html_body?: string;
  };
  prev_id: number | null;
  next_id: number | null;
}

/** Portable export of logics (no backtests / trades). */
export interface LogicExportBundle {
  format: string;
  version: number;
  exported_at?: string;
  overwrite_by_name?: boolean;
  logics: Array<{
    name: string;
    note?: string | null;
    is_enabled?: boolean;
    account?: { account_code?: string; broker_code?: string };
    params?: Array<{ param_key: string; param_value: string; value_type: string }>;
    signals?: Array<Record<string, unknown>>;
    stops?: Array<Record<string, unknown>>;
    securities?: Array<{
      prefix?: string;
      instrument_market?: string;
      security_name?: string;
      display_order?: number;
      is_active?: boolean;
    }>;
    last_opt_grid?: {
      results: unknown[];
      run_id?: number | null;
      at?: string | null;
    } | null;
  }>;
}

export interface LogicImportResult {
  imported: Array<{
    id: number;
    name: string;
    source_name?: string;
    action?: 'created' | 'updated' | string;
    securities_count?: number;
    has_opt_grid?: boolean;
  }>;
  warnings?: string[];
}

/** Full trades + logic context dump for AI/debug (test or live). */
export interface LogicTradesExportBundle {
  format: string;
  version: number;
  exported_at: string;
  is_test: boolean;
  logic: {
    id: number;
    name: string;
    note: string | null;
    is_enabled: boolean;
    account: { account_code?: string; broker_code?: string } | null;
    params: Array<{ param_key: string; param_value: string; value_type: string }>;
    signals: Array<Record<string, unknown>>;
    stops: Array<Record<string, unknown>>;
    securities: Array<Record<string, unknown>>;
  };
  trading_params: Record<string, unknown>;
  non_trading_periods: {
    use_non_trading_periods: boolean;
    intervals: Array<Record<string, unknown>>;
  };
  run_id: number | null;
  run: Record<string, unknown> | null;
  counts: Record<string, unknown>;
  trades: LogicTradeRow[];
  lots: LogicTradeLotRow[];
  note?: string;
}

@Injectable({ providedIn: 'root' })
export class LogicsService {
  constructor(
    private readonly http: HttpClient,
    private readonly appConfig: AppConfigService
  ) {}

  /** Список логик с полями счёта/брокера для главной таблицы. */
  getLogics(): Observable<LogicRow[]> {
    return this.http.get<LogicRow[]>(`${this.appConfig.apiUrl}/logics`);
  }

  /** Жив ли торговый цикл (watchdog): ok / stale / idle / ui_required. */
  getTradeRunnerHealth(): Observable<TradeRunnerHealth> {
    return this.http.get<TradeRunnerHealth>(
      `${this.appConfig.apiUrl}/trade-runner/health`
    );
  }

  /** Принудительно поднять заснувший цикл (kick + run). */
  raiseTradeRunnerWatchdog(): Observable<unknown> {
    return this.http.post(`${this.appConfig.apiUrl}/trade-runner/watchdog`, {});
  }

  /** Активные процессы (бэктесты, runner, pg_stat_activity) для полоски наверху. */
  getProcesses(): Observable<{ rows: ProcessStatusItem[] }> {
    return this.http.get<{ rows: ProcessStatusItem[] }>(
      `${this.appConfig.apiUrl}/processes`
    );
  }

  /** Создать логику (редактор «+»). */
  createLogic(payload: LogicPayload): Observable<LogicRow> {
    return this.http.post<LogicRow>(`${this.appConfig.apiUrl}/logics`, payload);
  }

  /** Сохранить карточку логики (имя, счёт, примечание…). */
  updateLogic(id: number, payload: LogicPayload): Observable<LogicRow> {
    return this.http.put<LogicRow>(
      `${this.appConfig.apiUrl}/logics/${id}`,
      payload
    );
  }

  /**
   * Копия логики: params/signals/stops/securities, без сделок.
   * Имя «… copy», is_enabled=false.
   */
  copyLogic(id: number): Observable<LogicRow> {
    return this.http.post<LogicRow>(
      `${this.appConfig.apiUrl}/logics/${id}/copy`,
      {}
    );
  }

  /**
   * Экспорт выбранных логик (JSON): карточка, params, signals, stops, papers, last OPT.
   * Без тестов/сделок/свечей.
   */
  exportLogics(ids: number[]): Observable<LogicExportBundle> {
    return this.http.post<LogicExportBundle>(
      `${this.appConfig.apiUrl}/logics/export`,
      { ids }
    );
  }

  /**
   * Импорт JSON-bundle. По умолчанию перезапись по имени; иначе новая логика.
   * last_opt_grid из файла восстанавливается (кнопка «Применить лучшие OPT»).
   */
  importLogics(
    bundle: LogicExportBundle,
    opts?: { overwriteByName?: boolean }
  ): Observable<LogicImportResult> {
    return this.http.post<LogicImportResult>(
      `${this.appConfig.apiUrl}/logics/import`,
      {
        ...bundle,
        overwrite_by_name: opts?.overwriteByName !== false,
      }
    );
  }

  /**
   * Вкл/выкл боя. Может запустить warmup_pretest или предрасчёт рейтинга.
   */
  updateLogicEnabled(
    id: number,
    is_enabled: boolean
  ): Observable<{
    id: number;
    is_enabled: boolean;
    rating_precalc?: SignalRatingPrecalcStatus;
    warmup_pretest?: {
      started: boolean;
      run_id: number;
      date_from: string;
      date_to: string;
    };
  }> {
    return this.http.patch<{
      id: number;
      is_enabled: boolean;
      rating_precalc?: SignalRatingPrecalcStatus;
      warmup_pretest?: {
        started: boolean;
        run_id: number;
        date_from: string;
        date_to: string;
      };
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

  getNonTradingPeriods(logicId: number): Observable<LogicNonTradingPeriodsResponse> {
    return this.http.get<LogicNonTradingPeriodsResponse>(
      `${this.appConfig.apiUrl}/logics/${logicId}/non-trading-periods`
    );
  }

  applyMoexNonTradingPeriods(
    logicId: number
  ): Observable<LogicNonTradingPeriodsResponse> {
    return this.http.post<LogicNonTradingPeriodsResponse>(
      `${this.appConfig.apiUrl}/logics/${logicId}/non-trading-periods/moex-defaults`,
      {}
    );
  }

  addNonTradingPeriod(
    logicId: number,
    payload: LogicNonTradingIntervalPayload
  ): Observable<LogicNonTradingPeriodsResponse> {
    return this.http.post<LogicNonTradingPeriodsResponse>(
      `${this.appConfig.apiUrl}/logics/${logicId}/non-trading-periods`,
      payload
    );
  }

  updateNonTradingPeriod(
    intervalId: number,
    payload: LogicNonTradingIntervalPayload
  ): Observable<LogicNonTradingPeriodsResponse> {
    return this.http.patch<LogicNonTradingPeriodsResponse>(
      `${this.appConfig.apiUrl}/logic-non-trading-intervals/${intervalId}`,
      payload
    );
  }

  deleteNonTradingPeriod(
    intervalId: number
  ): Observable<LogicNonTradingPeriodsResponse & { ok?: boolean }> {
    return this.http.delete<LogicNonTradingPeriodsResponse & { ok?: boolean }>(
      `${this.appConfig.apiUrl}/logic-non-trading-intervals/${intervalId}`
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
    signal_acts_on?: 'security' | 'base_asset' | 'contango';
    formula: string;
  }): Observable<LogicIndicatorSignalRow> {
    return this.http.post<LogicIndicatorSignalRow>(
      `${this.appConfig.apiUrl}/logic-indicator-signals`,
      body
    );
  }

  updateLogicIndicatorSignal(
    id: number,
    body: {
      formula: string;
      is_active?: boolean;
      signal_acts_on?: 'security' | 'base_asset' | 'contango';
    }
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
    scope_type: LogicStopScopeType;
    value: number;
    value_unit: LogicStopValueUnit;
  }): Observable<LogicStopRow> {
    return this.http.post<LogicStopRow>(
      `${this.appConfig.apiUrl}/logic-stops`,
      body
    );
  }

  updateLogicStop(
    id: number,
    body: {
      scope_type?: LogicStopScopeType;
      value?: number;
      value_unit?: LogicStopValueUnit;
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

  getLogicTrades(
    logicId: number,
    limit = 100,
    isTest?: boolean,
    runId?: number | null
  ): Observable<LogicTradeRow[]> {
    const params: Record<string, string> = {
      logic_id: String(logicId),
      limit: String(limit),
    };
    if (isTest === true) params['is_test'] = '1';
    if (isTest === false) params['is_test'] = '0';
    if (runId != null && Number.isFinite(Number(runId)) && Number(runId) > 0) {
      params['run_id'] = String(runId);
    }
    return this.http.get<LogicTradeRow[]>(`${this.appConfig.apiUrl}/logic-trades`, {
      params,
    });
  }

  /** Rejected orders only (live panel block); not mixed into open/close LIMIT. */
  getLogicTradesRejected(
    logicId: number,
    limit = 200,
    isTest = false
  ): Observable<LogicTradeRow[]> {
    return this.http.get<LogicTradeRow[]>(`${this.appConfig.apiUrl}/logic-trades/rejected`, {
      params: {
        logic_id: String(logicId),
        limit: String(limit),
        is_test: isTest ? '1' : '0',
      },
    });
  }

  /** Live banner: burst/period of rejected broker orders (not 1–2 strays). */
  getLogicTradesRejectAlert(
    logicId: number,
    isTest = false
  ): Observable<{
    logic_id: number;
    is_test: boolean;
    warn: boolean;
    rejected_count: number;
    filled_count: number;
    window_hours: number;
    first_rejected_at: string | null;
    last_rejected_at: string | null;
    span_minutes: number | null;
    sample_note: string | null;
    message: string | null;
  }> {
    return this.http.get<{
      logic_id: number;
      is_test: boolean;
      warn: boolean;
      rejected_count: number;
      filled_count: number;
      window_hours: number;
      first_rejected_at: string | null;
      last_rejected_at: string | null;
      span_minutes: number | null;
      sample_note: string | null;
      message: string | null;
    }>(`${this.appConfig.apiUrl}/logic-trades/reject-alert`, {
      params: {
        logic_id: String(logicId),
        is_test: isTest ? '1' : '0',
      },
    });
  }

  /** Full dump for analysis: open/close/shadow/all statuses + lots. */
  exportLogicTrades(
    logicId: number,
    isTest: boolean,
    runId?: number | null
  ): Observable<LogicTradesExportBundle> {
    const params: Record<string, string> = {
      logic_id: String(logicId),
      is_test: isTest ? '1' : '0',
    };
    if (runId != null && Number.isFinite(Number(runId)) && Number(runId) > 0) {
      params['run_id'] = String(runId);
    }
    return this.http.get<LogicTradesExportBundle>(
      `${this.appConfig.apiUrl}/logic-trades/export`,
      { params }
    );
  }

  getLogicTradesPnlSummary(isTest = true): Observable<{
    is_test: boolean;
    rows: Array<{
      logic_id: number;
      financial_result: number;
      commission: number;
      trade_count: number;
      date_from?: string | null;
      date_to?: string | null;
    }>;
  }> {
    return this.http.get<{
      is_test: boolean;
      rows: Array<{
        logic_id: number;
        financial_result: number;
        commission: number;
        trade_count: number;
        date_from?: string | null;
        date_to?: string | null;
      }>;
    }>(`${this.appConfig.apiUrl}/logic-trades/pnl-summary`, {
      params: { is_test: isTest ? '1' : '0' },
    });
  }

  /**
   * Mid-run Testing panel: champion opens + recent closes (no OPT paper dump).
   */
  getLogicTradesTestPanel(
    logicId: number,
    runId?: number | null,
    closeLimit = 2500
  ): Observable<{
    logic_id: number;
    run_id: number | null;
    close_limit: number;
    rows: LogicTradeRow[];
  }> {
    const params: Record<string, string> = {
      logic_id: String(logicId),
      close_limit: String(closeLimit),
    };
    if (runId != null && Number.isFinite(Number(runId)) && Number(runId) > 0) {
      params['run_id'] = String(runId);
    }
    return this.http.get<{
      logic_id: number;
      run_id: number | null;
      close_limit: number;
      rows: LogicTradeRow[];
    }>(`${this.appConfig.apiUrl}/logic-trades/test-panel`, { params });
  }

  /** Lightweight champion equity (Close PnL only) — safe to poll mid-backtest. */
  getLogicTradesEquityCurve(
    logicId: number,
    isTest = true,
    runId?: number | null
  ): Observable<{
    logic_id: number;
    is_test: boolean;
    date_from: string | null;
    date_to: string | null;
    total: Array<{ dt: string; value: number }>;
    long: Array<{ dt: string; value: number }>;
    short: Array<{ dt: string; value: number }>;
    close_count: number;
    financial_result: number;
    run_id?: number | null;
  }> {
    const params: Record<string, string> = {
      logic_id: String(logicId),
      is_test: isTest ? '1' : '0',
    };
    if (runId != null && Number.isFinite(runId) && runId > 0) {
      params['run_id'] = String(runId);
    }
    return this.http.get<{
      logic_id: number;
      is_test: boolean;
      date_from: string | null;
      date_to: string | null;
      total: Array<{ dt: string; value: number }>;
      long: Array<{ dt: string; value: number }>;
      short: Array<{ dt: string; value: number }>;
      close_count: number;
      financial_result: number;
      run_id?: number | null;
    }>(`${this.appConfig.apiUrl}/logic-trades/equity-curve`, { params });
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
    channel?: string;
    broker_errors?: Array<{ error?: string; ticker?: string }>;
    broker_error_count?: number;
  }> {
    return this.http.post<{
      ok: boolean;
      closed?: number;
      skipped?: number;
      errors?: unknown[];
      error?: string;
      channel?: string;
      broker_errors?: Array<{ error?: string; ticker?: string }>;
      broker_error_count?: number;
    }>(`${this.appConfig.apiUrl}/logic-trades/close-all`, { logic_id: logicId });
  }

  startBacktest(body: {
    logic_id: number;
    date_from: string;
    date_to: string;
    opt_grid?: {
      config?: unknown;
      arms?: { lane: string; values: Record<string, number> }[];
    } | null;
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

  /** In-progress backtests (recover UI after leaving the operations tab). */
  getActiveBacktests(): Observable<{ rows: BacktestRunStatus[] }> {
    return this.http.get<{ rows: BacktestRunStatus[] }>(
      `${this.appConfig.apiUrl}/logic-backtest/active`
    );
  }

  cancelBacktest(runId: number): Observable<{ ok: boolean; run_id: number }> {
    return this.http.post<{ ok: boolean; run_id: number }>(
      `${this.appConfig.apiUrl}/logic-backtest/cancel`,
      { run_id: runId }
    );
  }

  listBacktestReports(opts?: {
    limit?: number;
    offset?: number;
    logic_id?: number;
  }): Observable<{ rows: BacktestReportListItem[] }> {
    const params: Record<string, string> = {};
    if (opts?.limit != null) params['limit'] = String(opts.limit);
    if (opts?.offset != null) params['offset'] = String(opts.offset);
    if (opts?.logic_id != null) params['logic_id'] = String(opts.logic_id);
    return this.http.get<{ rows: BacktestReportListItem[] }>(
      `${this.appConfig.apiUrl}/logic-backtest/reports`,
      { params }
    );
  }

  getBacktestReport(
    id: number,
    includeHtml = true
  ): Observable<BacktestReportDetailResponse> {
    const params: Record<string, string> = {
      html: includeHtml ? '1' : '0',
    };
    return this.http.get<BacktestReportDetailResponse>(
      `${this.appConfig.apiUrl}/logic-backtest/reports/${id}`,
      { params }
    );
  }

  /** Сброс OPT к начальным базам + очистка live opt_lane книги. */
  resetOptToInitial(logicId: number): Observable<{
    ok?: boolean;
    formulas_restored?: number;
    opt_trades_deleted?: number;
    source?: string;
    message?: string;
    error?: string;
    signals?: LogicIndicatorSignalRow[];
  }> {
    return this.http.post(
      `${this.appConfig.apiUrl}/logics/${logicId}/opt-reset`,
      {}
    );
  }

  /** Очистка теневых live-сделок + снятие pause/инверсии + is_active по бумагам. */
  resetShadowTrading(logicId: number): Observable<{
    ok?: boolean;
    cleared_shadow_trades?: number;
    securities_reactivated?: number;
    rating_precalc?: unknown;
    message?: string;
    error?: string;
  }> {
    return this.http.post(
      `${this.appConfig.apiUrl}/logics/${logicId}/shadow-reset`,
      {}
    );
  }

  /** Apply best offline-grid params from last completed test into formulas. */
  applyOptGridBest(logicId: number): Observable<{
    ok?: boolean;
    message?: string;
    updated?: number;
    best?: unknown;
    run_id?: number;
    signals?: LogicIndicatorSignalRow[];
    error?: string;
  }> {
    return this.http.post(
      `${this.appConfig.apiUrl}/logics/${logicId}/opt-grid-apply-best`,
      {}
    );
  }

  /** Latest completed run with opt_grid_results (for Apply button). */
  getLatestOptGridResults(logicId: number): Observable<{
    run_id: number | null;
    results: unknown[] | null;
  }> {
    return this.http.get<{ run_id: number | null; results: unknown[] | null }>(
      `${this.appConfig.apiUrl}/logics/${logicId}/opt-grid-results`
    );
  }

  /** Снимок / promote параметров формул и OPT для отчёта. */
  getOptParamHistory(
    logicId: number,
    runId?: number | null
  ): Observable<{ rows: unknown[] }> {
    const params: Record<string, string> = {};
    if (runId != null && Number.isFinite(runId) && runId > 0) {
      params['run_id'] = String(runId);
    }
    return this.http.get<{ rows: unknown[] }>(
      `${this.appConfig.apiUrl}/logics/${logicId}/opt-param-history`,
      { params }
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
