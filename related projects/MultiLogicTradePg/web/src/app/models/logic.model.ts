export interface LogicRow {
  id: number;
  name: string;
  account_id: number;
  broker_id: number;
  is_enabled: boolean;
  note?: string | null;
  timeframe?: string;
  position_size_pct: number;
  max_open_positions: number;
  initial_balance: number | null;
  current_balance: number | null;
  commission_pct?: number;
  cost_method?: 'FIFO' | 'AVERAGE';
  stop_loss_timeframe?: string;
  base_annual_rate_pct?: number;
  rating_lookback_days?: number;
  /** Инверсия логики: условия наоборот и Long↔Short. */
  inversion?: boolean;
  account_code: string;
  account_name: string;
  account_type: 'real' | 'fake';
  account_is_active: boolean;
  broker_code: string;
  broker_name: string;
}

export interface LogicTradingParamsPayload {
  timeframe?: string;
  position_size_pct?: number;
  max_open_positions?: number;
  initial_balance?: number | null;
  reset_balance?: boolean;
  commission_pct?: number;
  cost_method?: 'FIFO' | 'AVERAGE';
  stop_loss_timeframe?: string;
  base_annual_rate_pct?: number;
  rating_lookback_days?: number;
  inversion?: boolean;
}

export interface LogicTradingParamsResponse {
  timeframe: string;
  position_size_pct: number;
  max_open_positions: number;
  initial_balance: number | null;
  current_balance: number | null;
  commission_pct: number;
  cost_method: 'FIFO' | 'AVERAGE';
  stop_loss_timeframe: string;
  base_annual_rate_pct: number;
  rating_lookback_days: number;
  inversion: boolean;
}

export interface LogicParamRow {
  id: number;
  logic_id: number;
  param_key: string;
  param_value: string;
  value_type: 'number' | 'integer' | 'money' | 'boolean' | 'text';
  updated_at?: string;
  name_ru?: string;
  description?: string;
}

export interface LogicParamsResponse {
  logic_id: number;
  trading: LogicTradingParamsResponse;
  params: LogicParamRow[];
}

export interface LogicIndicatorSignalRow {
  id: number;
  logic_id: number;
  indicator_id: number;
  position_event: 'open' | 'close';
  position_side: 'long' | 'short';
  signal_kind: 'trend' | 'counter';
  formula: string;
  /** Боевой рейтинг сигнала на логике (не справочник indicators). */
  rating: number;
  /** Тестовый рейтинг (бэктест), не смешивается с rating. */
  rating_test?: number;
  display_order: number;
  is_active: boolean;
  indicator_code: string;
  indicator_name: string;
}

export interface LogicStopRow {
  id: number;
  logic_id: number;
  rule_kind: 'stop_loss' | 'take_profit';
  scope_type: 'security' | 'security_resume' | 'security_inversion' | 'portfolio';
  value: number;
  value_unit: 'percent' | 'atr';
  display_order: number;
  is_active: boolean;
  created_at?: string;
}

export interface LogicSecurityRow {
  id: number;
  logic_id: number;
  security_id: number;
  display_order: number;
  is_active: boolean;
  created_at?: string;
  security_name: string;
  lot_size?: number;
  security_type: string;
  prefix: string | null;
  instrument_market: string | null;
  exchange_id: number | null;
  exchange_name: string | null;
  real_trading_paused?: boolean;
  real_trading_inverted?: boolean;
  stop_resume_equity?: number | null;
  stop_resume_baseline?: number | null;
  stop_resume_triggered_at?: string | null;
}
