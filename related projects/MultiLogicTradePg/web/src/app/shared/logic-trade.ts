export type LogicTradeStatus =
  | 'pending'
  | 'submitted'
  | 'filled'
  | 'rejected'
  | 'cancelled';

export interface LogicTradeRow {
  id: number;
  logic_id: number;
  account_id: number;
  security_id: number;
  timeframe_id: number;
  side_id: number;
  action_id: number;
  signal_kind: 'trend' | 'counter' | 'cash_fund' | 'opt';
  signal_formula: string;
  quantity: number;
  price: number;
  bar_dt: string;
  executed_at: string;
  is_simulated: boolean;
  is_fictitious?: boolean;
  is_shadow: boolean;
  is_test: boolean;
  /** Прогон бэктеста (только is_test); NULL у боевых / legacy. */
  run_id?: number | null;
  trade_reason: string | null;
  broker_order_id: string | null;
  status: LogicTradeStatus;
  commission: number;
  financial_result: number | null;
  remaining_qty?: number | null;
  note: string | null;
  /** OPT challenger lane; empty = champion. */
  opt_lane?: string | null;
  created_at?: string;
  security_name: string;
  security_prefix: string | null;
  side_name: string;
  action_name: string;
  timeframe_tf: string;
}

export interface LogicTradeLotRow {
  id: number;
  logic_id: number;
  close_trade_id: number;
  open_trade_id: number | null;
  action_id: number;
  cost_method: 'FIFO' | 'AVERAGE';
  quantity: number;
  close_amount: number;
  open_amount: number;
  close_commission: number;
  open_commission: number;
  financial_result: number;
  created_at?: string;
  action_name: string;
  open_executed_at: string | null;
  open_bar_dt: string | null;
  open_price: number | null;
  close_executed_at: string;
  close_price: number;
}

export function tradeOperationLabel(
  trade: Pick<LogicTradeRow, 'side_name' | 'action_name'>
): string {
  const opening = trade.side_name === 'Open';
  if (trade.action_name === 'Long') {
    return opening ? 'Покупка' : 'Продажа';
  }
  return opening ? 'Продажа (шорт)' : 'Покупка (закрытие шорта)';
}

export function tradeOperationHint(
  trade: Pick<LogicTradeRow, 'side_name' | 'action_name'>
): string {
  const opening = trade.side_name === 'Open';
  if (trade.action_name === 'Long') {
    return opening
      ? 'Сделка открытия long-позиции'
      : 'Сделка закрытия long — продажа ранее купленного';
  }
  return opening
    ? 'Сделка открытия short-позиции'
    : 'Сделка закрытия short — покупка для покрытия шорта';
}

export function costMethodLabel(method: string): string {
  switch (method?.toUpperCase()) {
    case 'FIFO':
      return 'FIFO';
    case 'AVERAGE':
      return 'Средняя';
    default:
      return method;
  }
}

export function tradeStatusLabel(status: LogicTradeStatus): string {
  switch (status) {
    case 'pending':
      return 'Ожидание';
    case 'submitted':
      return 'Отправлена';
    case 'filled':
      return 'Исполнена';
    case 'rejected':
      return 'Отклонена';
    case 'cancelled':
      return 'Отменена';
    default:
      return status;
  }
}

/** Human-readable broker/API reject reason from logic_trades.note. */
export function tradeRejectReason(note: string | null | undefined): string | null {
  if (note == null) return null;
  const raw = String(note).trim();
  if (!raw) return null;

  const jsonMatch = raw.match(/\{[\s\S]*\}$/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]) as { message?: unknown; description?: unknown };
      const msg = obj.message != null ? String(obj.message).trim() : '';
      if (msg) return localizeBrokerRejectMessage(msg);
    } catch {
      /* keep falling through */
    }
  }

  const httpMatch = raw.match(/HTTP\s+(\d+)/i);
  if (httpMatch) {
    const code = httpMatch[1];
    if (code === '429') return 'слишком много запросов к брокеру (HTTP 429)';
    if (code === '401' || code === '403') return `нет доступа к API брокера (HTTP ${code})`;
    if (code === '500' || code === '502' || code === '503') {
      return `временная ошибка брокера (HTTP ${code})`;
    }
    if (/:\s*<NULL>\s*$/i.test(raw) || /:\s*$/.test(raw)) {
      return `ошибка брокера (HTTP ${code})`;
    }
  }

  return raw.length > 180 ? `${raw.slice(0, 177)}…` : raw;
}

function localizeBrokerRejectMessage(message: string): string {
  const key = message.trim().toLowerCase();
  const map: Record<string, string> = {
    'not enough assets for a margin trade':
      'недостаточно активов для маржинальной сделки',
    'not enough balance': 'недостаточно средств',
    'instrument is not available for trading': 'инструмент недоступен для торговли',
    'order rejected by exchange': 'биржа отклонила заявку',
  };
  return map[key] ?? message.trim();
}

/** Status label; for rejected/cancelled appends (reason) from note when present. */
export function tradeStatusDisplay(
  status: LogicTradeStatus,
  note?: string | null
): string {
  const label = tradeStatusLabel(status);
  if (status !== 'rejected' && status !== 'cancelled') return label;
  const reason = tradeRejectReason(note);
  return reason ? `${label} (${reason})` : label;
}

export function yesNoLabel(value: boolean): string {
  return value ? 'да' : 'нет';
}
