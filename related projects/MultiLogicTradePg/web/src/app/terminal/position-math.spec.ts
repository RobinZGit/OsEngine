import {
  accountPnl,
  openPositionsSpent,
  positionCost,
  positionQty,
  realizedPnl,
  securityPnl,
} from './position-math';
import { TerminalTradeRow } from '../services/terminal-state.service';

let nextId = 1;
const trade = (
  security_id: number,
  direction: 'BUY' | 'SELL',
  quantity: number,
  price: number,
  status: TerminalTradeRow['status'] = 'filled',
  commission = 0
): TerminalTradeRow => ({
  id: nextId++,
  account_id: 1,
  security_id,
  direction,
  execution: 'market',
  quantity,
  price,
  amount: quantity * price,
  commission,
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

  it('комиссия входит в закупку: покупка +комиссия, продажа −комиссия из выручки', () => {
    const trades = [
      trade(1, 'BUY', 10, 100, 'filled', 5),
      trade(1, 'SELL', 4, 120, 'filled', 3),
    ];
    // (1000 + 5) + (−480 + 3) = 528
    expect(positionCost(trades, 1)).toBe(528);
  });

  it('П/У по счёту чистое: комиссия уменьшает прибыль', () => {
    const trades = [trade(1, 'BUY', 10, 100, 'filled', 7)];
    // без комиссии: 110*10 − 1000 = 100; с комиссией 7 → 93
    const r = accountPnl(trades, new Map([[1, 110]]));
    expect(r.pnl_rub).toBe(93);
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

describe('#946 realizedPnl (реализованный П/У по закрытым частям)', () => {
  it('закрытый лонг в плюс: реализованный П/У сохраняется после закрытия', () => {
    const trades = [trade(1, 'BUY', 10, 100), trade(1, 'SELL', 10, 120)];
    expect(realizedPnl(trades, 1)).toBe(200);
  });

  it('закрытый лонг в минус: реализованный П/У отрицательный', () => {
    const trades = [trade(1, 'BUY', 10, 100), trade(1, 'SELL', 10, 90)];
    expect(realizedPnl(trades, 1)).toBe(-100);
  });

  it('закрытый шорт в плюс и в минус: знак от цены обратного выкупа', () => {
    expect(realizedPnl([trade(1, 'SELL', 10, 100), trade(1, 'BUY', 10, 90)], 1)).toBe(100);
    expect(realizedPnl([trade(1, 'SELL', 10, 100), trade(1, 'BUY', 10, 110)], 1)).toBe(-100);
  });

  it('комиссии обеих сторон уменьшают реализованный П/У', () => {
    const trades = [trade(1, 'BUY', 10, 100, 'filled', 7), trade(1, 'SELL', 10, 110, 'filled', 3)];
    // цена: (110 − 100) * 10 = 100; входная комиссия 7 уже в средней цене
    // (1000 + 7) / 10 = 100.7 → 93; минус комиссия выхода 3 → 90
    expect(realizedPnl(trades, 1)).toBe(90);
  });

  it('частичное закрытие: реализуется только закрытая часть, остаток открыт', () => {
    const trades = [trade(1, 'BUY', 10, 100), trade(1, 'SELL', 4, 120)];
    expect(realizedPnl(trades, 1)).toBe(80);
    expect(positionQty(trades, 1)).toBe(6);
  });

  it('сделки вразнобой: порядок берётся по времени исполнения', () => {
    const a = { ...trade(1, 'BUY', 10, 100), executed_at: '2026-10-01T10:00:00Z' };
    const b = { ...trade(1, 'SELL', 10, 120), executed_at: '2026-10-01T12:00:00Z' };
    expect(realizedPnl([b, a], 1)).toBe(200);
  });

  it('сделка в обратную сторону больше позиции: закрытая часть + новая позиция', () => {
    // лонг 10 @100, продажа 14 @120 → закрыто 10 (+200), открыт шорт 4
    const trades = [trade(1, 'BUY', 10, 100), trade(1, 'SELL', 14, 120)];
    expect(realizedPnl(trades, 1)).toBe(200);
    expect(positionQty(trades, 1)).toBe(-4);
  });

  it('итог счёта после закрытия убытка остаётся минусом, а не обнуляется', () => {
    // Ключевая жалоба: закрытие убыточной позиции не должно «улучшать» итог.
    const trades = [trade(1, 'BUY', 10, 100), trade(1, 'SELL', 10, 90)];
    const r = accountPnl(trades, new Map([[1, 95]]));
    expect(r.securities).toBe(0); // позиции больше нет
    expect(r.pnl_rub).toBe(0); // переоценки нет
    expect(r.realized_rub).toBe(-100);
    expect(r.total_rub).toBe(-100);
  });

  it('итог счёта после закрытия прибыли остаётся плюсом', () => {
    const trades = [trade(1, 'BUY', 10, 100), trade(1, 'SELL', 10, 130)];
    const r = accountPnl(trades, new Map([[1, 125]]));
    expect(r.securities).toBe(0);
    expect(r.total_rub).toBe(300);
  });

  it('частичное закрытие: реализуется закрытая часть, остаток переоценивается один раз', () => {
    // BUY 10 @100, SELL 4 @120, остаток 6 шт, текущая цена 110.
    // Денежный поток: −1000 + 480 = −520, рыночная стоимость остатка 660 → итог +140.
    // Из него realized +80 и переоценка остатка +60 — складывать их нельзя.
    const trades = [trade(1, 'BUY', 10, 100), trade(1, 'SELL', 4, 120)];
    const r = accountPnl(trades, new Map([[1, 110]]));
    expect(realizedPnl(trades, 1)).toBe(80);
    expect(r.pnl_rub).toBe(140);
    expect(r.realized_rub).toBe(80);
    expect(r.unrealized_rub).toBe(60);
    expect(r.total_rub).toBe(140);
  });

  describe('openPositionsSpent (израсходованный лимит автоисполнения)', () => {
    it('суммирует базу только открытых позиций по модулю', () => {
      const trades = [
        trade(1, 'BUY', 10, 100), // 1000 — открыта
        trade(2, 'SELL', 5, 200), // 1000 (шорт) — открыта
        trade(3, 'BUY', 7, 50), // 350 — закрыта ниже
        trade(3, 'SELL', 7, 50),
      ];
      expect(openPositionsSpent(trades)).toBe(2000);
    });

    it('частичная продажа уменьшает занятую базу', () => {
      const trades = [trade(1, 'BUY', 10, 100), trade(1, 'SELL', 4, 120)];
      // Остаток 6 шт: 1000 − 480 = 520.
      expect(openPositionsSpent(trades)).toBe(520);
    });

    it('после полного закрытия и удаления сделок расход равен нулю', () => {
      expect(openPositionsSpent([trade(1, 'BUY', 10, 100), trade(1, 'SELL', 10, 100)])).toBe(0);
      expect(openPositionsSpent([])).toBe(0);
      expect(openPositionsSpent(null)).toBe(0);
    });
  });
});
