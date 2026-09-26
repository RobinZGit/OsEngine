import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AppConfigService } from './app-config.service';
import { SecurityRow } from '../models/market.model';

export interface TerminalPanelState {
  security_id: number;
  timeframe_id?: number | null;
  chart_height?: number | null;
  /** Сигнал логики, открывший эту полосу (бейдж + вертикальная линия). */
  signal_event?: TerminalLogicSignalEvent | null;
  /** Индикаторы логики, чьи значения рисуем на графике полосы. */
  logic_indicator_ids?: number[];
  /** Полоса свёрнута (видна только шапка) — сохраняется между сессиями. */
  collapsed?: boolean;
  /** Автозакрытие позиции бумаги по сигналу/закрытию логики (чекбокс на баре,
      включён по умолчанию). Закрывается вся позиция бумаги, маркетом. */
  auto_close_on_logic_signal?: boolean;
}

/** Сигнал логики, показанный в полосе терминала (сохраняемый в состояние). */
export interface TerminalLogicSignalEvent {
  logic_id: number;
  logic_name?: string | null;
  bar_dt?: string | null;
  position_side?: 'long' | 'short' | null;
  label?: string | null;
  /** Цена бара сигнала — для вертикальной линии на графике. */
  price?: number | null;
  /** Таймфрейм логики (id) — полоса подстраивается под неё. */
  timeframe_id?: number | null;
  /** Код таймфрейма (M1, M15, H1…) — для сообщений и бейджа. */
  timeframe?: string | null;
  /** Количество к подстановке в блок сделок (расчёт лота логики). */
  suggested_quantity?: number | null;
  /** Сумма к подстановке (лот × цена сигнала). */
  suggested_amount?: number | null;
}

/** Одна строка GET /api/terminal/logic-signals.
      Сигнал не привязан к счёту логики — счёт берётся из терминала. */
export interface TerminalLogicSignal {
  id: number;
  logic_id: number;
  logic_name: string;
  security_id: number;
  security_prefix: string | null;
  security_name: string;
  timeframe_id: number;
  timeframe: string;
  bar_dt: string | null;
  position_side: 'long' | 'short' | null;
  signal_kind: string | null;
  side_label: string;
  formula: string | null;
  price: number | null;
  suggested_quantity: number;
  suggested_amount: number;
  indicator_ids: number[];
  indicators: { id: number; code: string; name: string }[];
  created_at: string;
}

export interface TerminalLogicSignalsResponse {
  signals: TerminalLogicSignal[];
}

export interface TerminalStatePayload {
  panels: TerminalPanelState[];
  settings: Record<string, unknown>;
}

export interface TerminalStateResponse {
  payload: TerminalStatePayload;
}

/** Выпуск облигации в составе фонда терминала. */
export interface TerminalBondHolding {
  sec: string;
  /** Русское наименование выпуска (MOEX ISS / БД), может отсутствовать. */
  name?: string | null;
  weight: number;
  nominal: number;
  pricePct: number;
  couponAnnualPct: number;
  couponsPerYear: number;
  /** corp — корпоративная, ofz — ОФЗ (государственная). */
  kind: 'corp' | 'ofz';
}

export interface TerminalBondPlan {
  fund: {
    code: string;
    name: string;
    as_of: string | null;
    source_used: string | null;
    holdings_live: boolean;
    holdings_count: number;
  };
  bonds: TerminalBondHolding[];
}

export interface TerminalBondRegisterResult {
  security: SecurityRow | null;
  candles_loaded: number | null;
  /** Цены грузятся в фоне (ответ не ждал долгой загрузки). */
  prices_loading?: boolean;
  price_error?: string | null;
}

/** Параметры ручной сделки терминала. quantity — в штуках (контрактах). */
export interface TerminalTradeParams {
  account_id: number;
  security_id: number;
  direction: 'buy' | 'sell';
  execution: 'market' | 'limit';
  price: number;
  quantity: number;
}

/** Сделка терминала (история в блоке «Сделки»). */
export interface TerminalTradeRow {
  id: number;
  account_id: number;
  security_id: number;
  direction: 'BUY' | 'SELL';
  execution: 'market' | 'limit';
  quantity: number;
  price: number;
  amount: number;
  status: 'pending' | 'submitted' | 'filled' | 'rejected' | 'cancelled';
  broker_order_id: string | null;
  note: string | null;
  executed_at: string;
  security_name: string;
  security_prefix: string | null;
}

export interface TerminalTradeResult {
  ok: boolean;
  /** fake — демо на фейковом счёте; real — реальный ордер T-Bank. */
  mode: 'fake' | 'real';
  direction?: string;
  execution?: string;
  quantity?: number;
  price?: number;
  amount?: number;
  message?: string;
  order?: unknown;
  error?: string;
  /** Записанная сделка (id, статус и т.д.). */
  trade?: TerminalTradeRow | null;
  /** Остаток по счёту после сделки (у фейка — демо-кэш, может быть отрицательным). */
  cash?: number | null;
}

export interface TerminalUiState {
  selected_account_id: number | null;
}

export interface TerminalTradesResponse {
  trades: TerminalTradeRow[];
}

export interface TerminalTradesDeleteResult {
  ok: boolean;
  deleted: number;
  /** Новый остаток после пересчёта (у фейкового счёта; у реального — null). */
  cash?: number | null;
}

@Injectable({ providedIn: 'root' })
export class TerminalStateService {
  constructor(
    private readonly http: HttpClient,
    private readonly appConfig: AppConfigService
  ) {}

  getState(accountId?: number | null): Observable<TerminalStateResponse> {
    let url = `${this.appConfig.apiUrl}/terminal/state`;
    if (accountId != null) {
      url += `?account_id=${accountId}`;
    }
    return this.http.get<TerminalStateResponse>(url);
  }

  saveState(
    accountId: number,
    payload: TerminalStatePayload
  ): Observable<TerminalStateResponse> {
    return this.http.put<TerminalStateResponse>(
      `${this.appConfig.apiUrl}/terminal/state`,
      { account_id: accountId, payload }
    );
  }

  getBondPlan(fundCode: string): Observable<TerminalBondPlan> {
    const params = new HttpParams().set('fund_code', fundCode);
    return this.http.get<TerminalBondPlan>(
      `${this.appConfig.apiUrl}/terminal/bonds/plan`,
      { params }
    );
  }

  registerBond(
    sec: string,
    days?: number
  ): Observable<TerminalBondRegisterResult> {
    const body: Record<string, unknown> = { sec };
    if (days != null && Number.isFinite(days) && days > 0) {
      body['days'] = Math.min(Math.max(1, Math.floor(days)), 120);
    }
    return this.http.post<TerminalBondRegisterResult>(
      `${this.appConfig.apiUrl}/terminal/bonds/register`,
      body
    );
  }

  placeTrade(params: TerminalTradeParams): Observable<TerminalTradeResult> {
    return this.http.post<TerminalTradeResult>(
      `${this.appConfig.apiUrl}/terminal/trade`,
      params
    );
  }

  getTrades(
    accountId: number,
    limit?: number
  ): Observable<TerminalTradesResponse> {
    const params = new HttpParams()
      .set('account_id', String(accountId))
      .set('limit', String(limit ?? 100));
    return this.http.get<TerminalTradesResponse>(
      `${this.appConfig.apiUrl}/terminal/trades`,
      { params }
    );
  }

  /** Удалить все сделки терминала по счёту и пересчитать остаток (демо-кэш). */
  deleteTrades(accountId: number): Observable<TerminalTradesDeleteResult> {
    const params = new HttpParams().set('account_id', String(accountId));
    return this.http.delete<TerminalTradesDeleteResult>(
      `${this.appConfig.apiUrl}/terminal/trades`,
      { params }
    );
  }

  getUiState(): Observable<TerminalUiState> {
    return this.http.get<TerminalUiState>(
      `${this.appConfig.apiUrl}/terminal/ui-state`
    );
  }

  saveUiState(selectedAccountId: number): Observable<TerminalUiState> {
    return this.http.put<TerminalUiState>(
      `${this.appConfig.apiUrl}/terminal/ui-state`,
      { selected_account_id: selectedAccountId }
    );
  }

  /** Непрочитанные сигналы логик в терминал (всех логик, новые по id).
      Сигнал не привязан к счёту: бумага появляется в терминале, а сделки
      идут по счёту, выбранному в терминале. */
  getLogicSignals(
    limit = 200
  ): Observable<TerminalLogicSignalsResponse> {
    const params = new HttpParams().set('limit', String(limit));
    return this.http.get<TerminalLogicSignalsResponse>(
      `${this.appConfig.apiUrl}/terminal/logic-signals`,
      { params }
    );
  }

  /** Отметить показанные сигналы логик прочитанными. */
  markLogicSignalsRead(ids: number[]): Observable<{ ok: boolean; read: number }> {
    return this.http.post<{ ok: boolean; read: number }>(
      `${this.appConfig.apiUrl}/terminal/logic-signals/read`,
      { ids }
    );
  }
}