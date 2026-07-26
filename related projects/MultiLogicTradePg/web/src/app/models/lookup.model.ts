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
  value_types: IndicatorValueTypeRow[];
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
