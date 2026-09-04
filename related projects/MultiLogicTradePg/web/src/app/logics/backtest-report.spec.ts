import {
  annualizedPct,
  annualPctCardHtml,
  backtestStartBalance,
  buildBacktestReportDownloadName,
  buildPaperReportCloseRows,
  collectClosedDeals,
  computeSideStats,
  sanitizeReportFilenamePart,
  type BacktestReportModel,
  type ClosedDeal,
} from './backtest-report';
import type { LogicTradeLotRow, LogicTradeRow } from '../shared/logic-trade';

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

  it('backtestStartBalance uses test_initial_balance when set, else initial_balance, else 1M', () => {
    expect(
      backtestStartBalance({ id: 1, test_initial_balance: 10000, initial_balance: 1000000 } as never)
    ).toBe(10000);
    expect(backtestStartBalance({ id: 1, initial_balance: 500000 } as never)).toBe(
      500000
    );
    expect(backtestStartBalance({ id: 1 } as never)).toBe(1000000);
  });

  it('builds download filename with logic, period, tf, pnl, deals', () => {
    expect(sanitizeReportFilenamePart('A/B:C*')).toBe('ABC');
    const model = {
      logicName: 'My Logic / v2',
      dateFrom: '2020-01-01',
      dateTo: '2025-12-31',
      dealCount: 42,
      params: { timeframe: 'M15' },
      all: { netPnlPct: 12.34 },
    } as BacktestReportModel;
    expect(buildBacktestReportDownloadName(model)).toBe(
      'MLT-report_My_Logic_v2_2020-01-01_2025-12-31_M15_PnL+12.3pct_42deals.html'
    );
  });

  it('annualPctCardHtml annualizes returnPct over calendar days of the period', () => {
    // One non-leap year (2023 = 365 days inclusive) → annual == returnPct exactly.
    const annual = annualPctCardHtml(12.3, '2023-01-01', '2023-12-31');
    expect(annual).toContain('lbl">% годовых</div>');
    expect(annual).toContain('val pos');
    expect(annual).toContain('12,30%'); // ru-RU locale
    // Without a valid window → em dash.
    expect(annualPctCardHtml(12.3, '', '')).toContain('val muted">—</div>');
    // Negative annualized return → neg tone.
    expect(annualPctCardHtml(-5, '2023-01-01', '2023-12-31')).toContain(
      'val neg'
    );
  });

  it('annualizedPct returns null for invalid window and annualizes over inclusive days', () => {
    expect(annualizedPct(12.3, '2023-01-01', '2023-12-31')).toBeCloseTo(12.3, 5);
    expect(annualizedPct(10, '2026-01-01', '2026-01-10')).toBeCloseTo(
      (10 * 365) / 10,
      5
    );
    expect(annualizedPct(5, '2026-02-01', '2026-01-01')).toBeNull();
    expect(annualizedPct(5, '', '2026-01-01')).toBeNull();
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

  it('collectClosedDeals FIFO fallback computes holding from candles', () => {
    const openLong = (id: number, dt: string): LogicTradeRow => ({
      ...closeTrade({ id, financial_result: 0, action_name: 'Long' }),
      side_name: 'Open',
      financial_result: null,
      bar_dt: dt,
      executed_at: dt,
      quantity: 10,
    });
    const trades: LogicTradeRow[] = [
      openLong(101, '2026-01-10 10:00:00'),
      openLong(102, '2026-01-10 10:30:00'),
      {
        ...closeTrade({
          id: 202,
          financial_result: 50,
          action_name: 'Long',
          bar_dt: '2026-01-10 11:30:00',
          executed_at: '2026-01-10 11:30:00',
        }),
        quantity: 15,
      },
    ];
    const deals = collectClosedDeals(trades);
    expect(deals.length).toBe(1);
    // Закрытие 15 = 10 из покупки 101 + 5 из покупки 102.
    // Берём самую раннюю покупку (максимально скорее): 10:00 → 11:30 = 5400000мс.
    expect(deals[0].holdMs).toBe(5400000);
    expect(deals[0].openDt).toBe('2026-01-10 10:00:00');
    expect(deals[0].openPrice).not.toBeNull();
  });

  it('buildPaperReportCloseRows maps a sell to its source buys (FIFO fallback)', () => {
    const openLong = (id: number, dt: string, quantity: number, price: number): LogicTradeRow => ({
      ...closeTrade({ id, financial_result: 0, action_name: 'Long' }),
      side_name: 'Open',
      financial_result: null,
      bar_dt: dt,
      executed_at: dt,
      quantity,
      price,
    });
    const trades: LogicTradeRow[] = [
      openLong(101, '2026-01-10 10:00:00', 10, 100),
      openLong(102, '2026-01-10 10:30:00', 10, 105),
      {
        ...closeTrade({
          id: 202,
          financial_result: 125,
          action_name: 'Long',
          bar_dt: '2026-01-10 11:30:00',
          executed_at: '2026-01-10 11:30:00',
        }),
        quantity: 15,
        price: 110,
      },
    ];
    const rows = buildPaperReportCloseRows(trades);
    expect(rows.length).toBe(1);
    const sell = rows[0];
    expect(sell.side).toBe('Long');
    expect(sell.totalPnl).toBe(125);
    expect(sell.sources.length).toBe(2);
    expect(sell.sources[0].openTradeId).toBe(101);
    expect(sell.sources[0].quantity).toBe(10);
    expect(sell.sources[1].openTradeId).toBe(102);
    expect(sell.sources[1].quantity).toBe(5);
    // FIFO-оценка: П/У 125 распределён пропорционально объёму 15.
    expect(sell.sources[0].pnl).toBeCloseTo(125 * (10 / 15), 2);
    expect(sell.sources[1].pnl).toBeCloseTo(125 * (5 / 15), 2);
    expect(sell.sources[0].estimated).toBe(true);
  });

  it('buildPaperReportCloseRows uses real lots when provided', () => {
    const openLong = (id: number, dt: string, quantity: number, price: number): LogicTradeRow => ({
      ...closeTrade({ id, financial_result: 0, action_name: 'Long' }),
      side_name: 'Open',
      financial_result: null,
      bar_dt: dt,
      executed_at: dt,
      quantity,
      price,
    });
    const close = {
      ...closeTrade({
        id: 202,
        financial_result: 50,
        action_name: 'Long',
        bar_dt: '2026-01-10 11:30:00',
        executed_at: '2026-01-10 11:30:00',
      }),
      quantity: 10,
      price: 110,
    };
    const trades: LogicTradeRow[] = [openLong(101, '2026-01-10 10:00:00', 10, 100), close];
    const lots = new Map<number, LogicTradeLotRow[]>([
      [
        202,
        [
          {
            id: 1,
            logic_id: 1,
            close_trade_id: 202,
            open_trade_id: 101,
            action_id: 1,
            cost_method: 'FIFO',
            quantity: 10,
            close_amount: 1100,
            open_amount: 1000,
            close_commission: 0,
            open_commission: 0,
            financial_result: 50,
            action_name: 'Long',
            open_executed_at: '2026-01-10 10:00:00',
            open_bar_dt: '2026-01-10 10:00:00',
            open_price: 100,
            close_executed_at: '2026-01-10 11:30:00',
            close_price: 110,
          },
        ],
      ],
    ]);
    const rows = buildPaperReportCloseRows(trades, lots);
    expect(rows[0].sources.length).toBe(1);
    expect(rows[0].sources[0].openTradeId).toBe(101);
    expect(rows[0].sources[0].pnl).toBe(50);
    expect(rows[0].sources[0].estimated).toBe(false);
  });
});
