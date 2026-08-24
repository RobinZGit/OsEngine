export interface TimeframeRow {
  id: number;
  tf: string;
  full_name: string;
  sec: number;
  is_active: boolean;
}

export interface SecurityRow {
  id: number;
  name: string;
  lot_size?: number;
  security_type: string;
  prefix: string;
  instrument_market: string;
  exchange_id: number;
  exchange_name: string;
}

export interface SecurityPayload {
  name: string;
  prefix: string;
  exchange_id: number;
  kind: 'stock' | 'futures';
  note?: string | null;
}

export interface PriceCandle {
  dt: string;
  open_price: number;
  high_price: number;
  low_price: number;
  close_price: number;
  volume: number | null;
  /** Тикер конкретного контракта (Si-6.26) для фьючерсов */
  contract_prefix?: string | null;
  /** Групповой префикс с вкладки фьючерса (Si) */
  group_prefix?: string | null;
}

export interface SecurityChartState {
  candles: PriceCandle[];
  loading: boolean;
  loadingOlder: boolean;
  hasMore: boolean;
  error: string | null;
}

export interface PriceLoadRequest {
  security_id: number;
  timeframe_id: number;
  date_from: string;
  date_to: string;
}

export interface PriceLoadContract {
  prefix: string;
  source: string;
  records_loaded: number | null;
}

export interface PriceLoadResult {
  ok: boolean;
  procedure: string;
  source: string;
  date_from: string;
  date_to: string;
  candles: number;
  candles_total: number;
  records_loaded?: number | null;
  contracts?: PriceLoadContract[];
  tbank?: { records: number | null; error: string | null };
  moex?: { records: number | null; error: string | null };
}

export interface PriceLoadUiState {
  active: boolean;
  message: string | null;
  error: string | null;
}

/** Фоновый пересчёт индикатора после drag-and-drop */
export interface IndicatorRecalcUiState {
  active: boolean;
  message: string | null;
  error: string | null;
}

export interface SecurityIndicatorSeriesRow {
  id: number;
  security_id: number;
  indicator_id: number;
  series_code: string;
  invoke_formula: string;
  indicator_code: string;
  indicator_name: string;
  param_period?: number | null;
  param_fast_period?: number | null;
  param_slow_period?: number | null;
  param_signal_period?: number | null;
  param_std_dev?: number | null;
  param_k_period?: number | null;
  param_d_period?: number | null;
  param_smooth?: number | null;
  point_count: number;
  display_order: number;
  is_active: boolean;
}

export interface IndicatorValueRow {
  indicator_id: number;
  indicator_code: string;
  line_code: string;
  line_name: string;
  is_threshold: boolean;
  display_order: number;
  dt: string;
  value: number;
}

export interface ChartIndicatorSeries {
  indicator_code: string;
  line_code: string;
  line_name: string;
  color: string;
  on_price_scale: boolean;
  is_threshold: boolean;
  points: { dt: string; value: number }[];
}

/** Видимое окно графика (для sync индикаторов) */
export interface ChartVisibleRange {
  startDt: string;
  endDt: string;
  count: number;
  viewStart: number;
  /** true — пользователь перемотал/масштабировал; false — автоматически при загрузке свечей */
  userInitiated?: boolean;
}

/** Маркер сделки на графике бэктеста (вход / выход). */
export interface ChartTradeMarker {
  dt: string;
  price: number;
  kind: 'open' | 'close';
  side: 'long' | 'short';
  /** Теневая / отключённая бумага */
  isShadow?: boolean;
  label?: string;
}

/** Горизонтальная линия стопа / тейка с подписью типа. */
export interface ChartStopMarker {
  dt: string;
  price: number;
  ruleKind: 'stop_loss' | 'take_profit' | 'other';
  label: string;
}

/** Цветной интервал режима бумаги на графике цены / эквити. */
export interface ChartShadedRange {
  startDt: string;
  endDt: string;
  label?: string;
  /**
   * normal = обычная логика (зелёный);
   * shadow = теневой режим (серый);
   * inverted = инверсия (розовый);
   * paused — устарело, рисуется как shadow;
   * long = открыта long-позиция (бледно-зелёный, #835);
   * short = открыта short-позиция (бледно-красный, #835).
   */
  kind?: 'normal' | 'shadow' | 'inverted' | 'paused' | 'long' | 'short';
}

/** Точка кумулятивного PnL по бумаге (с нуля). */
export interface ChartEquityPoint {
  dt: string;
  value: number;
}
