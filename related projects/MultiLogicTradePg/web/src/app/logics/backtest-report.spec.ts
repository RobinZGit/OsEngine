import {
  collectClosedDeals,
  computeSideStats,
  type ClosedDeal,
} from './backtest-report';
import type { LogicTradeRow } from '../shared/logic-trade';

function closeTrade(
  partial: Partial<LogicTradeRow> & { financial_result: number; action_name: string }
): LogicTradeRow {
  return {
    id: partial.id ?? 1,
    logic_id: 1,
    account_id: 1,
    security_id: 10,
    timeframe_id: 1,
    side_id: 2,
    action_id: 1,
    signal_kind: 'trend',
    signal_formula: '',
    quantity: 1,
    price: 100,
    bar_dt: partial.bar_dt ?? '2026-01-10 12:00:00',
    executed_at: partial.executed_at ?? '2026-01-10 12:00:00',
    is_simulated: true,
    is_shadow: false,
    is_test: true,
    trade_reason: null,
    broker_order_id: null,
    status: 'filled',
    commission: partial.commission ?? 1,
    financial_result: partial.financial_result,
    note: null,
    security_name: 'TEST',
    security_prefix: 'TEST',
    side_name: 'Close',
    action_name: partial.action_name,
    timeframe_tf: 'M15',
  };
}

describe('backtest-report metrics', () => {
  it('computes profit factor and win rate like OsEngine', () => {
    const deals: ClosedDeal[] = [
      {
        pnl: 100,
        commission: 1,
        action: 'Long',
        securityName: 'A',
        securityPrefix: 'A',
        openDt: null,
        closeDt: '2026-01-01',
        holdMs: null,
        quantity: 1,
        openPrice: null,
        closePrice: 10,
      },
      {
        pnl: 50,
        commission: 1,
        action: 'Long',
        securityName: 'B',
        securityPrefix: 'B',
        openDt: null,
        closeDt: '2026-01-02',
        holdMs: null,
        quantity: 1,
        openPrice: null,
        closePrice: 10,
      },
      {
        pnl: -50,
        commission: 1,
        action: 'Short',
        securityName: 'C',
        securityPrefix: 'C',
        openDt: null,
        closeDt: '2026-01-03',
        holdMs: null,
        quantity: 1,
        openPrice: null,
        closePrice: 10,
      },
    ];
    const stats = computeSideStats(deals, 1_000_000, 7, true);
    expect(stats.dealCount).toBe(3);
    expect(stats.winCount).toBe(2);
    expect(stats.lossCount).toBe(1);
    expect(stats.profitFactor).toBeCloseTo(3, 5); // 150 / 50
    expect(stats.netPnl).toBe(100);
    expect(stats.winPct).toBeCloseTo(66.666, 2);
  });

  it('collectClosedDeals skips shadow and open sides', () => {
    const trades: LogicTradeRow[] = [
      closeTrade({ id: 1, financial_result: 10, action_name: 'Long' }),
      {
        ...closeTrade({ id: 2, financial_result: 99, action_name: 'Long' }),
        is_shadow: true,
      },
      {
        ...closeTrade({ id: 3, financial_result: 5, action_name: 'Short' }),
        side_name: 'Open',
        financial_result: null,
      },
    ];
    const deals = collectClosedDeals(trades);
    expect(deals.length).toBe(1);
    expect(deals[0].pnl).toBe(10);
  });
});
