import {
  annualizedPct,
  annualPctCardHtml,
  backtestStartBalance,
  buildBacktestReportDownloadName,
  buildBacktestReportModel,
  buildPaperReportCloseRows,
  buildReportTradeLedger,
  collectClosedDeals,
  computeSideStats,
  hourlyOpenCloseCounts,
  hourlyOpenCloseSvg,
  liveStartBalance,
  renderBacktestReportHtml,
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

  it('builds hourly open/close/profit/loss stacked charts and skips shadow/opt trades', () => {
    const baseOpen = (id: number, dt: string): LogicTradeRow => ({
      ...closeTrade({ id, financial_result: 0, action_name: 'Long' }),
      side_name: 'Open',
      financial_result: null,
      bar_dt: dt,
      executed_at: dt,
    });
    const baseClose = (id: number, dt: string, pnl: number): LogicTradeRow => ({
      ...closeTrade({ id, financial_result: pnl, action_name: 'Long', bar_dt: dt, executed_at: dt }),
      side_name: 'Close',
    });
    const trades: LogicTradeRow[] = [
      baseOpen(1, '2026-01-10 02:03:00'),
      baseOpen(2, '2026-01-10 02:07:00'),
      baseClose(3, '2026-01-10 02:04:00', 50),
      baseClose(7, '2026-01-10 02:10:00', -20),
      baseClose(8, '2026-01-10 02:15:00', 0),
      { ...baseOpen(4, '2026-01-10 02:09:00'), is_shadow: true },
      { ...baseOpen(5, '2026-01-10 02:09:00'), opt_lane: 'lane1' },
      baseOpen(6, '2026-01-10 14:31:00'),
    ];
    const counts = hourlyOpenCloseCounts(trades);
    expect(counts.matched).toBe(6); // 3 opens + 3 closes (shadow/opt excluded)
    expect(counts.open[2 * 12 + 0]).toBe(1); // 02:03
    expect(counts.open[2 * 12 + 1]).toBe(1); // 02:07
    expect(counts.open[14 * 12 + 6]).toBe(1); // 14:31
    expect(counts.close[2 * 12 + 0]).toBe(1); // 02:04
    expect(counts.close[2 * 12 + 2]).toBe(1); // 02:10
    expect(counts.close[2 * 12 + 3]).toBe(1); // 02:15 (zero pnl)
    expect(counts.closeProfit[2 * 12 + 0]).toBe(1);
    expect(counts.closeLoss[2 * 12 + 2]).toBe(1);
    expect(counts.closeProfit[2 * 12 + 3]).toBe(0);
    expect(counts.closeLoss[2 * 12 + 3]).toBe(0);

    const svg = hourlyOpenCloseSvg(trades);
    expect(svg.match(/<polyline/g)?.length).toBe(4);
    expect(svg).toContain('Открытия');
    expect(svg).toContain('Закрытия (все)');
    expect(svg).toContain('Закрытия в прибыль');
    expect(svg).toContain('Закрытия в убыток');
    expect(svg).toContain('#16a34a');
    expect(svg).toContain('#2563eb');
    expect(svg).toContain('#15803d');
    expect(svg).toContain('#dc2626');
    expect(svg).toContain('>24</text>');
    expect(hourlyOpenCloseSvg([])).toContain('Нет сделок открытия/закрытия');
  });

  it('#1080: ledger keeps all statuses, sorts by time and attaches close lots', () => {
    const open = {
      ...closeTrade({ id: 1, financial_result: null as unknown as number, action_name: 'Long', bar_dt: '2026-01-10 10:00:00', executed_at: '2026-01-10 10:00:00' }),
      side_name: 'Open',
    } as LogicTradeRow;
    const close = {
      ...closeTrade({ id: 2, financial_result: 50, action_name: 'Long', bar_dt: '2026-01-10 11:00:00', executed_at: '2026-01-10 11:00:00' }),
      quantity: 10,
      price: 110,
      commission: 3,
      trade_reason: 'take_profit',
    } as LogicTradeRow;
    const rejected = {
      ...closeTrade({ id: 3, financial_result: null as unknown as number, action_name: 'Short', bar_dt: '2026-01-10 12:00:00', executed_at: '2026-01-10 12:00:00' }),
      side_name: 'Open',
      status: 'rejected' as const,
      note: 'нет денег',
    } as LogicTradeRow;
    const lots = new Map<number, LogicTradeLotRow[]>([
      [
        2,
        [
          {
            id: 91,
            logic_id: 1,
            close_trade_id: 2,
            open_trade_id: 1,
            action_id: 1,
            cost_method: 'FIFO',
            quantity: 10,
            close_amount: 1100,
            open_amount: 1000,
            close_commission: 3,
            open_commission: 2,
            financial_result: 45,
            action_name: 'Long',
            open_executed_at: '2026-01-10 10:00:00',
            open_bar_dt: '2026-01-10 10:00:00',
            open_price: 100,
            close_executed_at: '2026-01-10 11:00:00',
            close_price: 110,
          },
        ],
      ],
    ]);

    const rows = buildReportTradeLedger([close, rejected, open], lots);
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(rows[0].side).toBe('Open');
    expect(rows[1].amount).toBeCloseTo(1100, 5);
    expect(rows[1].commission).toBe(3);
    expect(rows[1].reason).toBe('take_profit');
    expect(rows[1].lots.length).toBe(1);
    expect(rows[2].status).toBe('rejected');
    expect(rows[2].financialResult).toBeNull();
    expect(rows[0].lots.length).toBe(0);
  });

  it('#1080: both report modes include all-trades block with lot commissions', () => {
    const open = {
      ...closeTrade({ id: 1, financial_result: null as unknown as number, action_name: 'Long', bar_dt: '2026-01-10 10:00:00', executed_at: '2026-01-10 10:00:00' }),
      side_name: 'Open',
    } as LogicTradeRow;
    const close = closeTrade({ id: 2, financial_result: 50, action_name: 'Long', bar_dt: '2026-01-10 11:00:00', executed_at: '2026-01-10 11:00:00' });
    const lots = new Map<number, LogicTradeLotRow[]>([
      [
        2,
        [
          {
            id: 91,
            logic_id: 1,
            close_trade_id: 2,
            open_trade_id: 1,
            action_id: 1,
            cost_method: 'FIFO',
            quantity: 1,
            close_amount: 100,
            open_amount: 50,
            close_commission: 3,
            open_commission: 2,
            financial_result: 45,
            action_name: 'Long',
            open_executed_at: '2026-01-10 10:00:00',
            open_bar_dt: '2026-01-10 10:00:00',
            open_price: 50,
            close_executed_at: '2026-01-10 11:00:00',
            close_price: 100,
          },
        ],
      ],
    ]);
    const model = buildBacktestReportModel(
      { id: 7, name: 'Логика' } as never,
      [open, close],
      { tradeLots: lots }
    );
    expect(model.allTrades.length).toBe(2);
    const html = renderBacktestReportHtml(model);
    expect(html).toContain('Все сделки (2)');
    expect(html).toContain('Сигнал / примечание');
    expect(html).toContain('tr-lot');
    expect(html).toContain('комиссия открытия');
    expect(html).toContain('откр. #1');
  });
});

describe('backtest-report live balance and full logic config (#1081)', () => {
  function liveLogic(): Record<string, unknown> {
    return {
      id: 10134,
      name: 'DONCHIAN-OC M5 REAL',
      account_type: 'real',
      account_name: 'Токен 1 10326 19.06',
      // Реальный счёт: живой остаток и пользовательский старт боя.
      current_balance: 98765.43,
      initial_balance: 90000,
      // Тестовый миллион не должен попадать в live-отчёт.
      test_initial_balance: 1000000,
      timeframe: 'M5',
      position_size_pct: 30,
      max_open_positions: 10,
      commission_pct: 0.03,
      base_annual_rate_pct: 20,
    };
  }

  it('liveStartBalance prefers the real account balance and ignores test_initial_balance', () => {
    const logic = liveLogic();
    expect(liveStartBalance(logic as never, 12345.67)).toBe(12345.67);
    expect(liveStartBalance(logic as never)).toBe(98765.43);
    expect(liveStartBalance(logic as never, null)).toBe(98765.43);
    // Нет живого остатка — берём пользовательский старт, но не тестовый миллион.
    expect(
      liveStartBalance({ ...logic, current_balance: null } as never, null)
    ).toBe(90000);
    expect(
      liveStartBalance(
        {
          ...logic,
          current_balance: null,
          initial_balance: null,
        } as never,
        null
      )
    ).toBe(0);
    // Для демо 1 000 000 — это старт счёта, а не тест.
    expect(
      liveStartBalance(
        {
          ...logic,
          account_type: 'fake',
          current_balance: null,
          initial_balance: null,
        } as never,
        null
      )
    ).toBe(1000000);
  });

  it('live report uses account balance and renders all signals, stops and params', () => {
    const model = buildBacktestReportModel(liveLogic() as never, [], {
      reportMode: 'live',
      liveAccountBalance: 12345.67,
      signals: [
        {
          indicator_code: 'Donchian',
          position_event: 'open',
          position_side: 'short',
          signal_kind: 'counter',
          signal_acts_on: 'contango',
          formula: 'Price > DonchianHi(20)',
          display_order: 1,
          is_active: true,
        },
        {
          indicator_code: 'ATR',
          position_event: 'close',
          position_side: 'long',
          signal_kind: 'trend',
          signal_acts_on: 'base_asset',
          formula: 'ATR(14) > 2',
          display_order: 2,
          is_active: true,
        },
      ],
      stops: [
        {
          rule_kind: 'stop_loss',
          scope_type: 'portfolio',
          value: 3.5,
          value_unit: 'percent',
          display_order: 1,
          is_active: true,
        },
      ],
      paramsMap: {
        current_balance: '12345.67',
        warmup_pretest: 'true',
        close_positions_eod: 'false',
        custom_logic_flag: '42',
      },
      configProvided: true,
    });

    expect(model.params.initialBalance).toBe(12345.67);
    expect(model.params.balanceSource).toBe('Остаток счёта (current_balance)');
    expect(model.reportMode).toBe('live');

    const html = renderBacktestReportHtml(model);
    expect(html).toContain('<h1>Отчёт по реальной торговле');
    expect(html).not.toContain('<h1>Отчёт тестирования');
    expect(html).toContain('Остаток счёта');
    expect(html).toContain('Остаток счёта (current_balance)');
    expect(html).not.toContain('Нач. баланс');
    // Полный блок сигналов: индикатор, Long/Short, тренд/контртренд, действие, формула.
    expect(html).toContain('<th>Индикатор</th>');
    expect(html).toContain('Donchian');
    expect(html).toContain('ATR');
    expect(html).toContain('Long');
    expect(html).toContain('Short');
    expect(html).toContain('Против');
    expect(html).toContain('По течению');
    expect(html).toContain('Ряд (фьючерс − база)');
    expect(html).toContain('Price &gt; DonchianHi(20)');
    expect(html).toContain('Сигналы (2)');
    expect(html).toContain('Стопы и тейк-профиты (1)');
    // Все параметры, включая нестандартные галочки.
    expect(html).toContain('Все параметры и галочки (4)');
    expect(html).toContain('custom_logic_flag');
    expect(html).toContain('Предварительный тест');
    expect(html).toContain('вкл');
    expect(html).not.toContain('Нет данных по параметрам формул.');
  });

  it('test report keeps test_initial_balance as start balance', () => {
    const model = buildBacktestReportModel(
      { ...liveLogic(), test_initial_balance: 250000 } as never,
      []
    );
    expect(model.params.initialBalance).toBe(250000);
    expect(model.params.balanceSource).toBe(
      'Старт теста (test_initial_balance)'
    );
    expect(renderBacktestReportHtml(model)).toContain(
      '<h1>Отчёт тестирования'
    );
  });
});
