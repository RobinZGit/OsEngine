export interface BrokerRow {
  id: number;
  code: string;
  name: string;
  api_url: string | null;
  is_active: boolean;
}

export interface ExchangeRow {
  id: number;
  name: string;
}

export interface AccountRow {
  id: number;
  broker_id: number;
  account_code: string;
  name: string;
  account_type: 'real' | 'fake';
  is_efficient: boolean;
  is_active: boolean;
  has_token: boolean;
  broker_code: string;
  broker_name: string;
  /** Виртуальное поле — не в БД, заполняется API при with_balance=1 */
  balance?: number | null;
  /** Свободный кэш (валюта) с GetPortfolio — для дефолта «Купить облигации» */
  cash_amount?: number | null;
  balance_currency?: string | null;
  balance_display?: string | null;
  balance_error?: string | null;
  /** Демо-кэш фейкового счёта терминала (стартует с 0, может быть отрицательным). */
  terminal_cash?: number | null;
}

export interface BondFundInfo {
  code: string;
  name: string;
  source?: string;
  /** Зеркала состава (porti / MOEX ISS / cbonds / rusetfs). */
  sources?: string[];
  asOf?: string;
  moex_index?: string | null;
  holdings_count?: number;
}

/** Реальный счёт T-Bank с облигациями в портфеле (выбор «Счёт» в buy-bonds). */
export interface AccountBondsInfo {
  id: number;
  account_code: string;
  name: string;
  bonds_count: number;
}

export interface BuyBondsRow {
  sec: string;
  kind?: string;
  yield_pct?: number;
  unit_price?: number;
  lots: number;
  amount_rub?: number;
  figi?: string | null;
  ticker?: string;
  name?: string | null;
}

export interface BuyBondsPlaceRow {
  sec: string;
  ticker?: string;
  figi?: string;
  lots?: number;
  price?: number;
  order?: unknown;
  error?: string;
}

export interface BuyBondsResult {
  ok: boolean;
  fund_code?: string;
  fund_name?: string;
  fund_as_of?: string;
  fund_sources?: string[];
  fund_source_used?: string | null;
  holdings_live?: boolean;
  cash_amount?: number;
  amount_requested?: number;
  amount_planned?: number;
  buy_count?: number;
  buys?: BuyBondsRow[];
  resolve_failed?: { sec: string; error: string }[];
  note?: string;
  executed?: boolean;
  placed_count?: number;
  error_count?: number;
  placed?: BuyBondsPlaceRow[];
  errors?: BuyBondsPlaceRow[];
}

export interface LogicPayload {
  name: string;
  account_id: number;
  is_enabled: boolean;
  note?: string | null;
}

export interface BrokerPayload {
  code: string;
  name: string;
  api_url: string | null;
  is_active: boolean;
}

export interface ExchangePayload {
  name: string;
}

export interface AccountPayload {
  broker_id: number;
  account_code: string;
  name: string;
  account_type: 'real' | 'fake';
  is_efficient: boolean;
  is_active: boolean;
  /** Новый токен; не передавать или пустая строка — не менять (при редактировании). */
  api_token?: string;
  clear_token?: boolean;
}

export interface AccountConnectionPreview {
  ok: boolean;
  accounts?: TbankApiAccount[];
  selected_account_id?: string;
  selected_account_name?: string;
  accounts_found: number;
  balance: number | null;
  balance_currency?: string | null;
  balance_display?: string | null;
  balance_error?: string | null;
}

export interface TbankApiAccount {
  id: string;
  name: string;
  type: string;
  status: string;
}

export interface IndicatorValueTypeRow {
  id: number;
  code: string;
  name: string;
  value_type: string;
  is_threshold: boolean;
  threshold_value: number | null;
  display_order: number;
}

export interface IndicatorRow {
  id: number;
  code: string;
  name: string;
  script: string | null;
  formula: string | null;
  is_custom: boolean;
  description: string | null;
  category: string | null;
  is_active: boolean;
  sig_trend_def: string | null;
  sig_ct_def: string | null;
  /** trend_line | oscillator | channel | zero_line | strength | volume */
  sig_profile?: string | null;
  /** #994: рейтинг неиспользуемого индикатора (% годовых), null если не считался */
  rating?: number | null;
  best_position_side?: string | null;
  best_signal_kind?: string | null;
  best_time_kind?: string | null;
  samples_count?: number | null;
  computed_at?: string | null;
  /** #994-доработка: рейтинг с учётом устаревания (линейно угасает за rating_decay_hours) */
  rating_effective?: number | null;
  rating_decay_hours?: number | null;
  rating_avg_annual_pct?: number | null;
  rating_samples_count?: number | null;
  /** #1005: сколько разрезов (side × kind × time) усреднено в рейтинге. */
  rating_slices_count?: number | null;
  rating_computed_at?: string | null;
  /** #994-доработка: разбивка рейтинга по таймфреймам (для разворота строки) */
  rating_timeframes?: IndicatorRatingTimeframeRow[];
  value_types: IndicatorValueTypeRow[];
}

/** #994-доработка: рейтинг индикатора в разрезе одного таймфрейма. */
export interface IndicatorRatingTimeframeRow {
  timeframe_id: number;
  tf: string | null;
  full_name: string | null;
  rating: number | null;
  rating_effective?: number | null;
  best_position_side?: string | null;
  best_signal_kind?: string | null;
  best_time_kind?: string | null;
  slices_count?: number | null;
  samples_count?: number | null;
  avg_annual_pct?: number | null;
  bars_count?: number | null;
  bars_from?: string | null;
  bars_to?: string | null;
  computed_at?: string | null;
}

/** #1005: статус последнего прогона расчёта рейтинга индикаторов. */
export interface IndicatorRatingStatus {
  last_run_at: string | null;
  last_status: number | null;
  last_message: string | null;
  updated_at?: string | null;
  ok: boolean;
}

/** #1011: статус ручного расчёта рейтинга одного индикатора по кнопке. */
export interface IndicatorManualRatingStatus {
  indicator_id: number;
  running: boolean;
  last_run_at: string | null;
  last_status: number | null;
  last_message: string | null;
  rating_computed_at: string | null;
  ok: boolean;
}

/** #1006: индикатор в форме «Создать логику из лучших рейтингов» (лучший разрез на ТФ). */
export interface CreateLogicOptionIndicator {
  indicator_id: number;
  code: string;
  name: string;
  rating: number | null;
  position_side: string | null;
  signal_kind: string | null;
  time_kind: string | null;
  samples_count: number | null;
  securities_count: number;
}

/** #1006: ТФ с рассчитанным рейтингом + его лучшие индикаторы. */
export interface CreateLogicOptionGroup {
  timeframe_id: number;
  tf: string | null;
  full_name: string | null;
  indicators: CreateLogicOptionIndicator[];
}

export interface CreateLogicOptionsResponse {
  groups: CreateLogicOptionGroup[];
}

/** #1006: выбранный индикатор для создания логики (галочки открытия/закрытия). */
export interface CreateLogicSignalItem {
  indicator_id: number;
  code: string;
  position_side: string;
  signal_kind: string;
  open: boolean;
  close: boolean;
}

export interface CreateLogicGroupPayload {
  timeframe_id: number;
  items: CreateLogicSignalItem[];
}

export interface CreateLogicsPayload {
  account_id: number;
  groups: CreateLogicGroupPayload[];
}

export interface CreatedLogicResult {
  logic_id: number;
  name: string;
  timeframe: string;
  signals: number;
  securities: number;
}

export interface CreateLogicsResponse {
  created: CreatedLogicResult[];
}

export interface IndicatorPayload {
  name: string;
  description: string | null;
  category: string | null;
  script: string | null;
  formula?: string | null;
  is_active: boolean;
}

export interface IndicatorCreatePayload {
  code: string;
  name: string;
  description: string | null;
  category: string | null;
  formula: string;
  is_active: boolean;
}
