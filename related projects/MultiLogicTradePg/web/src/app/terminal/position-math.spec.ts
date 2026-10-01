import { accountPnl, positionCost, positionQty, securityPnl } from './position-math';
import { TerminalTradeRow } from '../services/terminal-state.service';

let nextId = 1;
const trade = (
  security_id: number,
  direction: 'BUY' | 'SELL',
  quantity: number,
  price: number,
  status: TerminalTradeRow['status'] = 'filled'
): TerminalTradeRow => ({
  id: nextId++,
  account_id: 1,
  security_id,
  direction,
  execution: 'market',
  quantity,
  price,
  amount: quantity * price,
  status,
  broker_order_id: null,
  note: null,
  executed_at: '2026-10-01T10:00:00Z',
  security_name: `SEC-${security_id}`,
  security_prefix: 'TEST',
});

describe('#925 position-math (П/У по счёту)', () => {
  it('остаток позиции: filled покупки минус продажи, не-filled игнорируются', () => {
    const trades = [
      trade(1, 'BUY', 10, 100),
      trade(1, 'SELL', 4, 120),
      trade(1, 'BUY', 3, 130, 'pending'),
      trade(1, 'SELL', 2, 90, 'rejected'),
      trade(2, 'BUY', 5, 50),
    ];
    expect(positionQty(trades, 1)).toBe(6);
    expect(positionQty(trades, 2)).toBe(5);
    expect(positionQty(trades, 99)).toBe(0);
  });

  it('шорт: остаток отрицательный', () => {
    expect(positionQty([trade(1, 'SELL', 7, 100)], 1)).toBe(-7);
    expect(positionCost([trade(1, 'SELL', 7, 100)], 1)).toBe(-700);
  });

  it('закупка позиции: сумма покупок минус сумма продаж', () => {
    const trades = [trade(1, 'BUY', 10, 100), trade(1, 'SELL', 4, 120)];
    expect(positionCost(trades, 1)).toBe(1000 - 480);
  });

  it('прибыль лонга: цена выросла — плюс, упала — минус', () => {
    expect(securityPnl(10, 1000, 110)).toBe(100);
    expect(securityPnl(10, 1000, 90)).toBe(-100);
    expect(securityPnl(10, 1000, 100)).toBe(0);
  });

  it('прибыль шорта: цена упала — плюс, выросла — минус', () => {
    // продали 10 по 100 = выручка 1000, обратный выкуп по 90 = 900 → +100
    expect(securityPnl(-10, -1000, 90)).toBe(100);
    expect(securityPnl(-10, -1000, 110)).toBe(-100);
  });

  it('без цены П/У не считается (0), чтобы не обнулять свою же переоценку', () => {
    expect(securityPnl(10, 1000, 0)).toBe(0);
    expect(securityPnl(0, 0, 100)).toBe(0);
  });

  it('сумма по счёту складывает П/У всех бумаг с позицией', () => {
    const trades = [
      trade(1, 'BUY', 10, 100), // лонг: +100 при цене 110
      trade(2, 'BUY', 5, 200), // лонг: -250 при цене 150
      trade(3, 'SELL', 4, 50), // шорт: +40 при цене 40 (выручка 200, выкуп 160)
    ];
    const r = accountPnl(trades, new Map([[1, 110], [2, 150], [3, 40]]));
    expect(r.securities).toBe(3);
    expect(r.priced).toBe(3);
    expect(r.pnl_rub).toBe(100 - 250 + 40);
  });

  it('бумага без живой цены не входит в сумму, но считается в счётчике', () => {
    const trades = [trade(1, 'BUY', 10, 100), trade(2, 'BUY', 5, 200)];
    const r = accountPnl(trades, new Map([[1, 110]]));
    expect(r.securities).toBe(2);
    expect(r.priced).toBe(1);
    expect(r.pnl_rub).toBe(100);
  });

  it('бумага без открытой позиции (свели в ноль) в сумму не входит', () => {
    const trades = [trade(1, 'BUY', 10, 100), trade(1, 'SELL', 10, 120)];
    const r = accountPnl(trades, new Map([[1, 130]]));
    expect(r.securities).toBe(0);
    expect(r.pnl_rub).toBe(0);
  });

  it('пустые входы не падают: нет сделок или нет цен → 0', () => {
    expect(accountPnl([], new Map()).pnl_rub).toBe(0);
    expect(accountPnl(null, null).securities).toBe(0);
    expect(accountPnl([trade(1, 'BUY', 1, 10)], null).pnl_rub).toBe(0);
  });
});
