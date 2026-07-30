export interface LogicRow {
  id: number;
  name: string;
  account_id: number;
  broker_id: number;
  is_enabled: boolean;
  note?: string | null;
  timeframe?: string;
  /** free_cash | portfolio | portfolio_incl_fund — база % для расчёта лота */
  position_size_base?: 'free_cash' | 'portfolio' | 'portfolio_incl_fund';
  position_size_pct: number;
  max_open_positions: number;
  /** Потолок номинала одной покупки, ₽; null/undefined = без лимита */
  max_order_amount?: number | null;
  initial_balance: number | null;
  current_balance: number | null;
  commission_pct?: number;
  cost_method?: 'FIFO' | 'AVERAGE';
  stop_loss_timeframe?: string;
  base_annual_rate_pct?: number;
  rating_lookback_days?: number;
  /** Инверсия логики: условия наоборот и Long↔Short. */
  inversion?: boolean;
  /** portfolio_resume / portfolio_ltp_renew: весь портфель в shadow до восстановления. */
  portfolio_trading_paused?: boolean;
  /** Активен линейный TP по портфелю с возобновлением (для подписи бейджа). */
  has_portfolio_ltp_renew?: boolean;
  /** Активен стоп-лосс portfolio_resume (для подписи бейджа). */
  has_portfolio_resume_sl?: boolean;
  /** Перед включением боя: предварительный тест для stop resume / inversion states. */
  warmup_pretest?: boolean;
  /**
   * security_resume: при повторном стопе цель возобновления не ниже прежнего максимума (HWM).
   * По умолчанию выкл.
   */
  resume_sl_no_reduce?: boolean;
  /** Денежный фонд для парковки кэша: '' | TMON | LQDT | SBMM (runner later). */
  cash_fund_code?: string;
  /** Порог equity портфеля (₽): парковать min(кэш, equity−порог−уже_в_фонде). */
  cash_fund_threshold?: number;
  /** Учитывать неторговые периоды при открытии сделок. */
  use_non_trading_periods?: boolean;
  /** Закрывать позиции в конце дня (кроме денежных фондов). */
  close_positions_eod?: boolean;
  /** Тип исполнения боевых заявок: market (по умолчанию) | limit. */
  order_execution?: 'market' | 'limit';
  /** Окно promote OPT: число закрытых свечей TF (по умолчанию 200). */
  opt_eval_candles?: number;
  account_code: string;
  account_name: string;
  account_type: 'real' | 'fake';
  account_is_active: boolean;
  broker_code: string;
  broker_name: string;
}

export interface LogicTradingParamsPayload {
  timeframe?: string;
  position_size_base?: 'free_cash' | 'portfolio' | 'portfolio_incl_fund';
  position_size_pct?: number;
  max_open_positions?: number;
  max_order_amount?: number | null;
  initial_balance?: number | null;
  reset_balance?: boolean;
  commission_pct?: number;
  cost_method?: 'FIFO' | 'AVERAGE';
  stop_loss_timeframe?: string;
  base_annual_rate_pct?: number;
  rating_lookback_days?: number;
  inversion?: boolean;
  warmup_pretest?: boolean;
  resume_sl_no_reduce?: boolean;
  cash_fund_code?: string;
  cash_fund_threshold?: number;
  use_non_trading_periods?: boolean;
  close_positions_eod?: boolean;
  order_execution?: 'market' | 'limit';
  opt_eval_candles?: number;
}

export interface LogicTradingParamsResponse {
  timeframe: string;
  position_size_base: 'free_cash' | 'portfolio' | 'portfolio_incl_fund';
  position_size_pct: number;
  max_open_positions: number;
  max_order_amount: number | null;
  initial_balance: number | null;
  current_balance: number | null;
  commission_pct: number;
  cost_method: 'FIFO' | 'AVERAGE';
  stop_loss_timeframe: string;
  base_annual_rate_pct: number;
  rating_lookback_days: number;
  inversion: boolean;
  warmup_pretest: boolean;
  resume_sl_no_reduce: boolean;
  cash_fund_code: string;
  cash_fund_threshold: number;
  use_non_trading_periods: boolean;
  close_positions_eod: boolean;
  order_execution: 'market' | 'limit';
  opt_eval_candles: number;
}

export interface LogicNonTradingIntervalRow {
  id: number;
  logic_id: number;
  day_of_week: number;
  time_from: string;
  time_to: string;
  note?: string | null;
  display_order: number;
  is_active: boolean;
}

export interface LogicNonTradingIntervalPayload {
  day_of_week?: number;
  time_from?: string;
  time_to?: string;
  note?: string | null;
  is_active?: boolean;
}

export interface LogicNonTradingPeriodsResponse {
  logic_id: number;
  use_non_trading_periods: boolean;
  intervals: LogicNonTradingIntervalRow[];
  applied?: number;
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
  scope_type:
    | 'security'
    | 'security_resume'
    | 'security_inversion'
    | 'portfolio'
    | 'portfolio_resume'
    | 'portfolio_ltp_renew'
    | 'security_ltp_renew';
  value: number;
  /** @deprecated unused; security_inversion uses value only */
  inversion_value?: number | null;
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
  real_trading_paused_long?: boolean;
  real_trading_paused_short?: boolean;
  real_trading_inverted?: boolean;
  stop_resume_equity?: number | null;
  stop_resume_baseline?: number | null;
  stop_resume_triggered_at?: string | null;
  stop_resume_equity_long?: number | null;
  stop_resume_baseline_long?: number | null;
  stop_resume_triggered_at_long?: string | null;
  stop_resume_equity_short?: number | null;
  stop_resume_baseline_short?: number | null;
  stop_resume_triggered_at_short?: string | null;
}
