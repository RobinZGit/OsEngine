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
  /** Реализованный П/У по уже закрытым частям позиций (с комиссиями), рубли.
      Не исчезает при закрытии позиции — в отличие от переоценки. */
  realized_rub: number;
  /** Переоценка открытого остатка (без уже реализованного), рубли. */
  unrealized_rub: number;
  /** Итог счёта: реализованный + переоценка открытого, рубли. */
  total_rub: number;
}

const isFilled = (t: TerminalTradeRow): boolean => t.status === 'filled';

/** Заполненные сделки по бумаге в хронологическом порядке (по времени
    исполнения, при равенстве — по id). */
function filledRowsInOrder(
  trades: readonly TerminalTradeRow[] | null | undefined,
  securityId: number
): TerminalTradeRow[] {
  const rows = (trades ?? []).filter((t) => t.security_id === securityId && isFilled(t));
  return rows
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const ta = Date.parse(String(a.t.executed_at ?? ''));
      const tb = Date.parse(String(b.t.executed_at ?? ''));
      const na = Number.isFinite(ta) ? ta : 0;
      const nb = Number.isFinite(tb) ? tb : 0;
      if (na !== nb) return na - nb;
      // Порядок БД (целочисленный id) важнее порядка в массиве; при равном
      // времени и без нормального id сохраняем исходную очерёдность.
      const ia = Number(a.t.id);
      const ib = Number(b.t.id);
      if (Number.isInteger(ia) && Number.isInteger(ib) && ia !== ib) return ia - ib;
      return a.i - b.i;
    })
    .map((x) => x.t);
}

/** Реализованный П/У по одной бумаге: результат уже закрытых частей позиции,
    рубли, с учётом комиссий обеих сторон. Считается методом средней цены:
    пока позиция открыта, её средняя закупочная цена (вместе с комиссией)
    находится в `cost/qty`; комиссия выходящей части сделки списывается
    пропорционально закрытому количеству. Так же, как `positionCost`,
    знак денег совпадает со знаком позиции: лонг — положительный, шорт —
    отрицательный, поэтому средняя всегда положительная. */
export function realizedPnl(
  trades: readonly TerminalTradeRow[] | null | undefined,
  securityId: number
): number {
  let qty = 0;
  let cost = 0;
  let realized = 0;
  for (const t of filledRowsInOrder(trades, securityId)) {
    const p = Number(t.price);
    const q = Number(t.quantity);
    if (!(Number.isFinite(p) && p >= 0 && Number.isFinite(q) && q > 0)) continue;
    const c = Number(t.commission);
    const commission = Number.isFinite(c) && c > 0 ? c : 0;
    const isBuy = t.direction === 'BUY';
    let closing = 0;
    if (qty > 0 && !isBuy) closing = Math.min(qty, q);
    else if (qty < 0 && isBuy) closing = Math.min(-qty, q);
    if (closing > 0 && qty !== 0) {
      const avg = cost / qty; // > 0: лонг и шорт дают положительную среднюю
      const exitCommission = commission * (closing / q);
      const gross = (p - avg) * closing * (qty > 0 ? 1 : -1);
      realized += gross - exitCommission;
    }
    qty += isBuy ? q : -q;
    cost += isBuy ? p * q + commission : -(p * q + commission);
  }
  return Number.isFinite(realized) ? round2(realized) : 0;
}

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
    Цены — из карты live-котировок терминала.

    Тонкость: `securityPnl` считается от `positionCost`, который уже зачитывает
    выручку частичных продаж, поэтому по бумаге с открытым остатком realized
    входит в `pnl_rub` и повторно его складывать нельзя. Итог `total_rub`
    добавляет только realized по бумагам, где позиции уже нет — иначе закрытие
    убытка обнуляло бы результат и итог «улучшался» бы. */
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
  let realized = 0;
  let realizedClosed = 0;
  let securities = 0;
  let priced = 0;
  for (const id of ids) {
    const pos = securityPosition(trades, id, Number(prices?.get(id) ?? 0));
    const secRealized = realizedPnl(trades, id);
    realized += secRealized;
    if (pos.qty === 0) {
      // Позиция закрыта полностью: realized нигде больше не учтён — в итог он идёт.
      realizedClosed += secRealized;
      continue;
    }
    securities += 1;
    const price = Number(prices?.get(id) ?? 0);
    if (!(price > 0)) continue;
    priced += 1;
    pnl += pos.pnl_rub;
  }
  const pnlRub = round2(pnl);
  const realizedRub = round2(realized);
  return {
    pnl_rub: pnlRub,
    securities,
    priced,
    realized_rub: realizedRub,
    /** Переоценка именно открытого остатка: минус realized, уже сидящий в pnl_rub. */
    unrealized_rub: round2(pnlRub - (realizedRub - round2(realizedClosed))),
    total_rub: round2(pnlRub + realizedClosed),
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
