import { TerminalTradeRow } from '../services/terminal-state.service';

/** Позиция по одной бумаге, посчитанная из сделок счёта. */
export interface SecurityPosition {
  security_id: number;
  /** Остаток: > 0 — лонг, < 0 — шорт, 0 — позиции нет. */
  qty: number;
  /** Фактические деньги в позиции: сумма покупок минус сумма продаж
      (для шорта — отрицательные). */
  cost: number;
  /** Средняя цена входа по остатку позиции. */
  avg_price: number;
  /** Рыночная стоимость позиции по текущей цене (всегда >= 0). */
  market_value: number;
  /** Прибыль/убыток по бумаге в рублях (переоценка открытой позиции). */
  pnl_rub: number;
}

/** П/У по всем бумагам счёта. */
export interface AccountPnl {
  /** Суммарная прибыль/убыток по открытым позициям, рубли. */
  pnl_rub: number;
  /** Сколько бумаг с открытой позицией учтено в сумме. */
  securities: number;
  /** У скольких бумаг есть живая цена (остальные — по цене последней свечи). */
  priced: number;
}

const isFilled = (t: TerminalTradeRow): boolean => t.status === 'filled';

/** Остаток позиции по бумаге: исполненные покупки минус исполненные продажи.
    > 0 — лонг, < 0 — шорт. */
export function positionQty(
  trades: readonly TerminalTradeRow[] | null | undefined,
  securityId: number
): number {
  let qty = 0;
  for (const t of trades ?? []) {
    if (t.security_id !== securityId || !isFilled(t)) continue;
    const q = Number(t.quantity);
    if (!Number.isFinite(q)) continue;
    qty += t.direction === 'BUY' ? q : -q;
  }
  return Number.isFinite(qty) ? qty : 0;
}

/** Фактические деньги в позиции: сумма покупок минус сумма продаж (по ценам
    сделок) плюс комиссия. Комиссия увеличивает «вложенные» деньги и для
    покупки, и для продажи (у продажи уменьшает выручку), поэтому П/У —
    чистый, с учётом комиссии. Для шорта — отрицательные. */
export function positionCost(
  trades: readonly TerminalTradeRow[] | null | undefined,
  securityId: number
): number {
  let cost = 0;
  for (const t of trades ?? []) {
    if (t.security_id !== securityId || !isFilled(t)) continue;
    const p = Number(t.price);
    const q = Number(t.quantity);
    if (!(Number.isFinite(p) && p >= 0 && Number.isFinite(q) && q > 0)) continue;
    const c = Number(t.commission);
    const commission = Number.isFinite(c) && c > 0 ? c : 0;
    cost += (t.direction === 'BUY' ? p * q : -p * q) + commission;
  }
  return Number.isFinite(cost) ? cost : 0;
}

/** Позиция по одной бумаге: остаток, закупка, средняя, стоимость и П/У.
    Цена `price` — живая котировка (0, если её нет: тогда П/У не считаем). */
export function securityPosition(
  trades: readonly TerminalTradeRow[] | null | undefined,
  securityId: number,
  price: number
): SecurityPosition {
  const qty = positionQty(trades, securityId);
  const cost = positionCost(trades, securityId);
  const avg = qty !== 0 && cost !== 0 ? cost / qty : 0;
  const marketValue = qty !== 0 && price > 0 ? Math.abs(qty) * price : 0;
  return {
    security_id: securityId,
    qty,
    cost,
    avg_price: avg,
    market_value: marketValue,
    pnl_rub: securityPnl(qty, cost, price),
  };
}

/** Прибыль/убыток по одной позиции в рублях: лонг — рыночная стоимость минус
    закупка, шорт — выручка минус цена обратного выкупа. Без цены — 0. */
export function securityPnl(qty: number, cost: number, price: number): number {
  if (!Number.isFinite(qty) || qty === 0) return 0;
  if (!Number.isFinite(cost) || !Number.isFinite(price) || !(price > 0)) return 0;
  const pnl = qty > 0 ? price * qty - cost : -cost - price * -qty;
  return Number.isFinite(pnl) ? round2(pnl) : 0;
}

/** Суммарный П/У по ВСЕМ бумагам счёта с открытой позицией: бумага без живой
    цены в сумму не входит (иначе она бы «обнуляла» свою же переоценку).
    Цены — из карты live-котировок терминала. */
export function accountPnl(
  trades: readonly TerminalTradeRow[] | null | undefined,
  prices: ReadonlyMap<number, number> | null | undefined
): AccountPnl {
  const ids = new Set<number>();
  for (const t of trades ?? []) {
    if (!isFilled(t)) continue;
    const q = Number(t.quantity);
    if (Number.isFinite(q) && q !== 0) ids.add(t.security_id);
  }
  let pnl = 0;
  let securities = 0;
  let priced = 0;
  for (const id of ids) {
    const pos = securityPosition(trades, id, Number(prices?.get(id) ?? 0));
    if (pos.qty === 0) continue;
    securities += 1;
    const price = Number(prices?.get(id) ?? 0);
    if (!(price > 0)) continue;
    priced += 1;
    pnl += pos.pnl_rub;
  }
  return { pnl_rub: round2(pnl), securities, priced };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
