import {
  buildEquityPoints,
  buildPortfolioStopMarkers,
  buildShadedDisabledRanges,
  buildStopMarkers,
  buildTradeMarkers,
  clipCandlesForBacktest,
  isDtInsideDisabledShade,
  papersWithTrades,
  tradeDtWindow,
} from './backtest-chart-overlays';
import { LogicTradeRow } from '../shared/logic-trade';
import { PriceCandle } from '../models/market.model';

function trade(partial: Partial<LogicTradeRow>): LogicTradeRow {
  return {
    id: 1,
    logic_id: 1,
    account_id: 1,
    security_id: 10,
    timeframe_id: 6,
    side_id: 1,
    action_id: 1,
    signal_kind: 'trend',
    signal_formula: '',
    quantity: 1,
    price: 100,
    bar_dt: '2026-04-10 10:00:00',
    executed_at: '2026-04-10 10:00:00',
    is_simulated: true,
    is_shadow: false,
    is_test: true,
    trade_reason: null,
    broker_order_id: null,
    status: 'filled',
    commission: 0,
    financial_result: null,
    note: null,
    security_name: 'SBER',
    security_prefix: 'SBER',
    side_name: 'Open',
    action_name: 'Long',
    timeframe_tf: 'M15',
    ...partial,
  };
}

describe('backtest-chart-overlays', () => {
  it('papersWithTrades pins cash fund at top even without trades', () => {
    const rows = papersWithTrades(
      [
        {
          id: 1,
          logic_id: 1,
          security_id: 10,
          security_name: 'Sber',
          security_prefix: 'SBER',
          status: 'filled',
          bar_dt: '2026-01-02T10:00:00',
          executed_at: '2026-01-02T10:00:00',
          financial_result: 1,
          commission: 0,
          is_shadow: false,
          is_test: true,
        } as never,
      ],
      '2026-01-01',
      '2026-01-31',
      {
        security_id: 99,
        security_name: 'TMON fund',
        security_prefix: 'TMON',
        pnl: 0,
        commission: 0,
        trade_count: 0,
        open_qty: 0,
        last_price: null,
        position_value: 0,
      }
    );
    expect(rows[0].security_prefix).toBe('TMON');
    expect(rows[0].open_qty).toBe(0);
    expect(rows[0].position_value).toBe(0);
    expect(rows.some((r) => r.security_prefix === 'SBER')).toBeTrue();
  });

  it('papersWithTrades sums open remaining qty for cash fund parks', () => {
    const rows = papersWithTrades(
      [
        trade({
          security_id: 327,
          security_name: 'TMON',
          security_prefix: 'TMON',
          side_name: 'Open',
          action_name: 'Long',
          quantity: 16,
          remaining_qty: 16,
          financial_result: null,
          bar_dt: '2026-06-28 10:00:00',
          executed_at: '2026-06-28 10:00:00',
        }),
        trade({
          id: 2,
          security_id: 327,
          security_name: 'TMON',
          security_prefix: 'TMON',
          side_name: 'Open',
          action_name: 'Long',
          quantity: 5,
          remaining_qty: 5,
          financial_result: null,
          bar_dt: '2026-06-28 11:00:00',
          executed_at: '2026-06-28 11:00:00',
        }),
      ],
      '2026-06-28',
      '2026-06-28'
    );
    expect(rows.length).toBe(1);
    expect(rows[0].open_qty).toBe(21);
    expect(rows[0].pnl).toBe(0);
    expect(rows[0].trade_count).toBe(2);
    expect(rows[0].last_price).toBe(100);
    expect(rows[0].position_value).toBe(2100);
  });

  it('papersWithTrades merges pin when security_id types differ (string vs number)', () => {
    const rows = papersWithTrades(
      [
        trade({
          security_id: 327 as never,
          security_name: 'TMON',
          security_prefix: 'TMON',
          side_name: 'Open',
          action_name: 'Long',
          quantity: 70,
          remaining_qty: 70,
          price: 101.5,
          financial_result: null,
          bar_dt: '2026-06-28 10:00:00',
          executed_at: '2026-06-28 10:00:00',
        }),
      ],
      '2026-06-28',
      '2026-06-28',
      {
        security_id: '327' as never,
        security_name: 'Т-Капитал денежный рынок (TMON)',
        security_prefix: 'TMON',
        pnl: 0,
        commission: 0,
        trade_count: 0,
        open_qty: 0,
        last_price: null,
        position_value: 0,
      }
    );
    expect(rows.length).toBe(1);
    expect(rows[0].open_qty).toBe(70);
    expect(rows[0].security_prefix).toBe('TMON');
    expect(rows[0].position_value).toBe(70 * 101.5);
  });

  it('papersWithTrades accepts ISO date_from/date_to without dropping trades', () => {
    const rows = papersWithTrades(
      [
        trade({
          security_id: 1,
          security_name: 'A',
          security_prefix: 'A',
          bar_dt: '2026-06-28 02:00:00',
          financial_result: 10,
        }),
      ],
      '2026-06-28T00:00:00.000Z',
      '2026-06-28T00:00:00.000Z'
    );
    expect(rows.length).toBe(1);
    expect(rows[0].security_prefix).toBe('A');
  });

  it('papersWithTrades returns only securities with trades in period', () => {
    const rows = papersWithTrades(
      [
        trade({ security_id: 1, security_name: 'A', security_prefix: 'A', financial_result: 10 }),
        trade({
          id: 2,
          security_id: 2,
          security_name: 'B',
          security_prefix: 'B',
          bar_dt: '2025-01-01 10:00:00',
          financial_result: 5,
        }),
      ],
      '2026-04-01',
      '2026-07-01'
    );
    expect(rows.length).toBe(1);
    expect(rows[0].security_id).toBe(1);
    expect(rows[0].pnl).toBe(10);
    expect(rows[0].commission).toBe(0);
  });

  it('buildTradeMarkers marks open/close and shadow', () => {
    const markers = buildTradeMarkers([
      trade({ side_name: 'Open', action_name: 'Long', price: 10 }),
      trade({
        id: 2,
        side_name: 'Close',
        action_name: 'Long',
        price: 12,
        is_shadow: true,
      }),
    ]);
    expect(markers[0].kind).toBe('open');
    expect(markers[0].side).toBe('long');
    expect(markers[1].kind).toBe('close');
    expect(markers[1].isShadow).toBeTrue();
  });

  it('buildStopMarkers extracts stop_loss and take_profit labels', () => {
    const markers = buildStopMarkers([
      trade({
        side_name: 'Close',
        trade_reason: 'stop_loss:security (2%)',
        price: 95,
      }),
      trade({
        id: 2,
        side_name: 'Close',
        trade_reason: 'take_profit:portfolio (5%)',
        price: 110,
      }),
      trade({ id: 3, side_name: 'Close', trade_reason: 'signal:trend' }),
    ]);
    expect(markers.length).toBe(2);
    expect(markers[0].ruleKind).toBe('stop_loss');
    expect(markers[1].ruleKind).toBe('take_profit');
  });

  it('buildPortfolioStopMarkers keeps only portfolio SL/TP and dedupes by bar', () => {
    const markers = buildPortfolioStopMarkers([
      trade({
        side_name: 'Close',
        trade_reason: 'stop_loss:security (2%)',
        price: 95,
      }),
      trade({
        id: 2,
        security_id: 11,
        bar_dt: '2026-04-11 12:00:00',
        side_name: 'Close',
        trade_reason: 'stop_loss:portfolio (3%)',
        price: 100,
      }),
      trade({
        id: 3,
        security_id: 12,
        bar_dt: '2026-04-11 12:00:00',
        side_name: 'Close',
        trade_reason: 'stop_loss:portfolio (3%)',
        price: 101,
      }),
      trade({
        id: 4,
        bar_dt: '2026-04-12 15:00:00',
        side_name: 'Close',
        trade_reason: 'take_profit:portfolio (5%)',
        price: 120,
      }),
    ]);
    expect(markers.length).toBe(2);
    expect(markers[0].ruleKind).toBe('stop_loss');
    expect(markers[0].label).toContain('portfolio');
    expect(markers[1].ruleKind).toBe('take_profit');
  });

  it('buildShadedDisabledRanges: green normal → gray shadow → green again', () => {
    const ranges = buildShadedDisabledRanges(
      [
        trade({ bar_dt: '2026-04-10 10:00:00', is_shadow: false, side_name: 'Open' }),
        trade({
          id: 2,
          bar_dt: '2026-04-10 11:00:00',
          side_name: 'Close',
          trade_reason: 'stop_loss:security',
        }),
        trade({
          id: 3,
          bar_dt: '2026-04-10 12:00:00',
          is_shadow: true,
          side_name: 'Open',
        }),
        trade({
          id: 4,
          bar_dt: '2026-04-10 13:00:00',
          is_shadow: false,
          side_name: 'Open',
        }),
      ],
      '2026-04-10 09:00:00',
      '2026-04-10 15:00:00'
    );
    expect(ranges.map((r) => r.kind)).toEqual(['normal', 'shadow', 'normal']);
    expect(ranges[0].startDt).toBe('2026-04-10 09:00:00');
    expect(ranges[1].startDt).toBe('2026-04-10 11:00:00');
    expect(ranges[1].endDt).toBe('2026-04-10 13:00:00');
    expect(ranges[2].kind).toBe('normal');
  });

  it('buildShadedDisabledRanges keeps shadow through take_profit until real Open', () => {
    const ranges = buildShadedDisabledRanges([
      trade({ bar_dt: '2026-06-23 11:00:00', side_name: 'Open' }),
      trade({
        id: 2,
        bar_dt: '2026-06-23 19:15:00',
        side_name: 'Close',
        trade_reason: 'stop_loss:security_resume (1.00%)',
        financial_result: 97,
      }),
      trade({
        id: 3,
        bar_dt: '2026-06-23 19:15:00',
        side_name: 'Open',
        is_shadow: true,
      }),
      trade({
        id: 4,
        bar_dt: '2026-06-24 17:15:00',
        side_name: 'Close',
        trade_reason: 'take_profit:security (2.05%)',
        financial_result: 358,
      }),
    ]);
    expect(ranges.map((r) => r.kind)).toEqual(['normal', 'shadow']);
    expect(ranges[1].startDt).toBe('2026-06-23 19:15:00');
    expect(ranges[1].endDt).toBe('2026-06-24 17:15:00');
  });

  it('buildShadedDisabledRanges: security_inversion toggles pink after shadow→zero', () => {
    const ranges = buildShadedDisabledRanges([
      trade({ bar_dt: '2026-04-10 10:00:00', side_name: 'Open' }),
      trade({
        id: 2,
        bar_dt: '2026-04-10 11:00:00',
        side_name: 'Close',
        trade_reason: 'stop_loss:security_inversion',
      }),
      trade({
        id: 3,
        bar_dt: '2026-04-10 12:00:00',
        is_shadow: true,
        side_name: 'Open',
      }),
      trade({
        id: 4,
        bar_dt: '2026-04-10 13:00:00',
        is_shadow: false,
        side_name: 'Open',
      }),
      trade({
        id: 5,
        bar_dt: '2026-04-10 14:00:00',
        side_name: 'Close',
        trade_reason: 'stop_loss:security_inversion:inverted',
      }),
      trade({
        id: 6,
        bar_dt: '2026-04-10 15:00:00',
        is_shadow: true,
        side_name: 'Open',
      }),
      trade({
        id: 7,
        bar_dt: '2026-04-10 16:00:00',
        is_shadow: false,
        side_name: 'Open',
      }),
    ]);
    expect(ranges.map((r) => r.kind)).toEqual([
      'normal',
      'shadow',
      'inverted',
      'shadow',
      'normal',
    ]);
  });

  it('tradeDtWindow returns first and last trade bar_dt', () => {
    const win = tradeDtWindow([
      trade({ bar_dt: '2026-06-09 13:30:00' }),
      trade({ id: 2, bar_dt: '2026-06-02 10:00:00' }),
      trade({ id: 3, bar_dt: '2026-06-09 11:00:00' }),
    ]);
    expect(win?.from).toBe('2026-06-02 10:00:00');
    expect(win?.to).toBe('2026-06-09 13:30:00');
  });

  it('clipCandlesForBacktest keeps trade window instead of only the tail', () => {
    const seq: PriceCandle[] = Array.from({ length: 100 }, (_, i) => ({
      dt: `2026-04-10 ${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`,
      open_price: 1,
      high_price: 1,
      low_price: 1,
      close_price: 1,
      volume: 0,
    }));
    const clipped = clipCandlesForBacktest(seq, {
      coverFrom: '2026-04-10 00:00:00',
      coverTo: '2026-04-10 23:59:59',
      tradeFrom: '2026-04-10 00:10:00',
      tradeTo: '2026-04-10 00:20:00',
      maxCandles: 40,
    });
    expect(clipped.length).toBeLessThanOrEqual(40);
    expect(clipped.some((c) => c.dt.startsWith('2026-04-10 00:10'))).toBeTrue();
    expect(clipped.some((c) => c.dt.startsWith('2026-04-10 00:20'))).toBeTrue();
  });

  it('buildEquityPoints accumulates close PnL from zero', () => {
    const pts = buildEquityPoints([
      trade({ side_name: 'Open', financial_result: null }),
      trade({
        id: 2,
        side_name: 'Close',
        bar_dt: '2026-04-10 11:00:00',
        financial_result: -50,
      }),
      trade({
        id: 3,
        side_name: 'Close',
        bar_dt: '2026-04-10 12:00:00',
        financial_result: 80,
      }),
    ]);
    expect(pts[0].value).toBe(0);
    expect(pts[0].dt).toBe('2026-04-10 10:00:00');
    expect(pts[pts.length - 1].value).toBe(30);
  });

  it('buildEquityPoints anchors zero at period start (test history)', () => {
    const pts = buildEquityPoints(
      [
        trade({
          side_name: 'Open',
          bar_dt: '2026-04-10 10:00:00',
          financial_result: null,
        }),
        trade({
          id: 2,
          side_name: 'Close',
          bar_dt: '2026-04-10 11:00:00',
          financial_result: -50,
        }),
      ],
      '2026-01-01'
    );
    expect(pts[0]).toEqual({ dt: '2026-01-01', value: 0 });
    expect(pts[1].value).toBe(-50);
    expect(pts[1].dt).toBe('2026-04-10 11:00:00');
  });

  it('isDtInsideDisabledShade is strict between bounds', () => {
    const ranges = [
      { startDt: '2026-06-23 19:15:00', endDt: '2026-06-24 17:15:00', label: 'выкл.' },
    ];
    expect(isDtInsideDisabledShade('2026-06-23 19:15:00', ranges)).toBeFalse();
    expect(isDtInsideDisabledShade('2026-06-24 09:00:00', ranges)).toBeTrue();
    expect(isDtInsideDisabledShade('2026-06-24 17:15:00', ranges)).toBeFalse();
  });

  it('buildEquityPoints skips shadow closes', () => {
    const pts = buildEquityPoints([
      trade({ side_name: 'Open' }),
      trade({
        id: 2,
        side_name: 'Close',
        bar_dt: '2026-04-10 11:00:00',
        financial_result: 10,
        is_shadow: true,
      }),
      trade({
        id: 3,
        side_name: 'Close',
        bar_dt: '2026-04-10 12:00:00',
        financial_result: 20,
      }),
    ]);
    expect(pts[pts.length - 1].value).toBe(20);
  });

  it('buildEquityPoints skips OPT paper lanes (matches FinRes champion)', () => {
    const pts = buildEquityPoints([
      trade({
        side_name: 'Close',
        bar_dt: '2026-04-10 11:00:00',
        financial_result: 100,
        opt_lane: '',
      }),
      trade({
        id: 2,
        side_name: 'Close',
        bar_dt: '2026-04-10 12:00:00',
        financial_result: -500,
        opt_lane: 'std_dev:down',
      }),
    ]);
    expect(pts[pts.length - 1].value).toBe(100);
  });

  it('buildEquityPoints skips cancelled closes (matches pnl-summary status filter)', () => {
    const pts = buildEquityPoints([
      trade({
        side_name: 'Close',
        bar_dt: '2026-04-10 11:00:00',
        financial_result: 100,
      }),
      trade({
        id: 2,
        side_name: 'Close',
        bar_dt: '2026-04-10 12:00:00',
        financial_result: 999,
        status: 'cancelled',
      }),
    ]);
    expect(pts[pts.length - 1].value).toBe(100);
  });
});
