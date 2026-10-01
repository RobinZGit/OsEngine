import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { TerminalComponent } from './terminal.component';
import { ReferencesService } from '../services/references.service';
import { SecuritiesService } from '../services/securities.service';
import { TerminalStateService } from '../services/terminal-state.service';
import { AppConfigService } from '../services/app-config.service';

describe('TerminalComponent — удаление полос без позиции по таймауту таймфрейма (#923)', () => {
  function makeComponent(): any {
    const fixture = TestBed.createComponent(TerminalComponent);
    const c: any = fixture.componentInstance;
    // Без активного счёта scheduleSave() — no-op.
    c.activeAccountId = null;
    c.timeframes = [
      { id: 1, tf: 'M1', sec: 60, full_name: '1 минута', is_active: true },
      { id: 15, tf: 'M15', sec: 900, full_name: '15 минут', is_active: true },
      { id: 30, tf: 'M30', sec: 1800, full_name: '30 минут', is_active: true },
    ];
    c.trades = [];
    c.panels = [];
    return c;
  }

  function panel(uid: number, securityId: number, ev: any | null): any {
    return {
      uid,
      security: { id: securityId },
      signal_event: ev ?? null,
      auto_close_on_logic_signal: true,
      collapsed: true,
    };
  }

  function ev(
    barMs: number,
    timeframeId: number | null,
    timeframe?: string | null,
    createdAt?: number | null
  ): any {
    return {
      logic_id: 7,
      logic_name: 'Логика',
      bar_dt: new Date(barMs).toISOString(),
      timeframe_id: timeframeId,
      timeframe: timeframe ?? null,
      created_at: createdAt == null ? null : new Date(createdAt).toISOString(),
    };
  }

  function buy(securityId: number, quantity: string | number): any {
    return { security_id: securityId, status: 'filled', quantity: String(quantity), direction: 'BUY' };
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [TerminalComponent],
      providers: [
        { provide: ReferencesService, useValue: {} },
        { provide: SecuritiesService, useValue: {} },
        { provide: TerminalStateService, useValue: {} },
        { provide: AppConfigService, useValue: {} },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    });
  });

  it('полоса с нулевым остатком, у которой сигнал записан больше таймфрейма назад — удаляется', () => {
    const c = makeComponent();
    // M15 (900 с), сигнал записан 1000 с назад (~17 мин), позиции нет.
    c.panels = [
      panel(1, 101, ev(Date.now() - 1_000_000, 15, 'M15', Date.now() - 1_000_000)),
    ];
    c.removeFlatPanelsAfterSignalTimeout();
    expect(c.panels.length).toBe(0);
  });

  it('M1 (60 с): полосы держатся минимум 5 минут — 6-минутный протух удаляется, свежая остаётся', () => {
    const c = makeComponent();
    c.panels = [
      panel(1, 101, ev(Date.now() - 360_000, 1, 'M1', Date.now() - 360_000)), // 6 мин > 5 мин → удалить
      panel(2, 102, ev(Date.now() - 30_000, 1, 'M1', Date.now() - 30_000)), // 30 с < 5 мин → оставить
    ];
    c.removeFlatPanelsAfterSignalTimeout();
    expect(c.panels.map((p: any) => p.uid)).toEqual([2]);
  });

  it('M1: полоса в возрасте 3 минут ещё держится (минимум 5 минут, а не 1)', () => {
    const c = makeComponent();
    // Сигнал M1 3 минуты назад: по «голому» таймфрейму (60 с) он протух бы,
    // но минимум 5 минут его сохраняет.
    c.panels = [
      panel(1, 101, ev(Date.now() - 180_000, 1, 'M1', Date.now() - 180_000)),
    ];
    c.removeFlatPanelsAfterSignalTimeout();
    expect(c.panels.length).toBe(1);
  });

  it('свежий сигнал не удаляется, даже если bar_dt — открытие уже закрытой свечи (реальный кейс)', () => {
    const c = makeComponent();
    // Торговый цикл пишет сигнал по последней ЗАКРЫТОЙ свече: bar_dt (открытие)
    // уже на ~1 таймфрейм в прошлом, но сам сигнал записан только что. До фикса
    // возраст считался от bar_dt — свежие полосы M15/M1 удалялись мгновенно.
    c.panels = [
      panel(1, 101, ev(Date.now() - 900_000, 15, 'M15', Date.now() - 10_000)), // bar 15 мин назад, записан 10 с назад
      panel(2, 102, ev(Date.now() - 60_000, 1, 'M1', Date.now() - 5_000)), // bar 1 мин назад, записан 5 с назад
    ];
    c.removeFlatPanelsAfterSignalTimeout();
    expect(c.panels.map((p: any) => p.uid).sort()).toEqual([1, 2]);
  });

  it('без created_at (старое сохранённое состояние) возраст считается от закрытия бара сигнала', () => {
    const c = makeComponent();
    // M1: открытие свечи 40 с назад → закрытие через 20 с → сигнал свежий, оставить.
    c.panels = [panel(1, 101, ev(Date.now() - 40_000, 1, 'M1', null))];
    c.removeFlatPanelsAfterSignalTimeout();
    expect(c.panels.length).toBe(1);
    // M15: открытие 61 мин назад → закрытие 46 мин назад (> 15 мин) → удалить.
    c.panels = [panel(2, 102, ev(Date.now() - 61 * 60_000, 15, 'M15', null))];
    c.removeFlatPanelsAfterSignalTimeout();
    expect(c.panels.length).toBe(0);
  });

  it('есть открытая позиция — полоса остаётся, даже если сигнал очень старый', () => {
    const c = makeComponent();
    c.trades = [buy(101, 3)];
    c.panels = [
      panel(1, 101, ev(Date.now() - 7 * 86_400_000, 15, 'M15', Date.now() - 7 * 86_400_000)),
    ];
    c.removeFlatPanelsAfterSignalTimeout();
    expect(c.panels.length).toBe(1);
  });

  it('полоса без сигнала (добавлена вручную) не удаляется, даже при нулевом остатке', () => {
    const c = makeComponent();
    c.panels = [panel(1, 101, null)];
    c.removeFlatPanelsAfterSignalTimeout();
    expect(c.panels.length).toBe(1);
  });

  it('удаляет только «протухшие» полосы среди разных состояний', () => {
    const c = makeComponent();
    c.trades = [buy(101, 5)]; // позиция, остаток 5
    c.panels = [
      panel(1, 101, ev(Date.now() - 7 * 86_400_000, 15, 'M15', Date.now() - 7 * 86_400_000)), // позиция → оставить
      panel(2, 102, ev(Date.now() - 1_000_000, 15, 'M15', Date.now() - 1_000_000)), // протух → удалить
      panel(3, 103, ev(Date.now() - 30_000, 1, 'M1', Date.now() - 30_000)), // свежий M1 → оставить
      panel(4, 104, null), // без сигнала → оставить
    ];
    c.removeFlatPanelsAfterSignalTimeout();
    expect(c.panels.map((p: any) => p.uid).sort()).toEqual([1, 3, 4]);
  });

  it('таймфрейм берётся и по коду, если id не найден в списке', () => {
    const c = makeComponent();
    // timeframe_id 999 — неизвестен, но код TR 'M15' известен (900 с).
    c.panels = [
      panel(1, 101, ev(Date.now() - 1_000_000, 999, 'M15', Date.now() - 1_000_000)),
    ];
    c.removeFlatPanelsAfterSignalTimeout();
    expect(c.panels.length).toBe(0);
  });

  it('сигнал без даты бара, без created_at и без таймфрейма полосу не удаляет', () => {
    const c = makeComponent();
    c.panels = [
      panel(1, 101, {
        logic_id: 7,
        bar_dt: null,
        created_at: null,
        timeframe_id: null,
        timeframe: null,
      }),
    ];
    c.removeFlatPanelsAfterSignalTimeout();
    expect(c.panels.length).toBe(1);
  });
});

describe('TerminalComponent — остаток на счёте и отклонение (#925)', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [TerminalComponent],
      providers: [
        { provide: ReferencesService, useValue: {} },
        { provide: SecuritiesService, useValue: {} },
        { provide: TerminalStateService, useValue: {} },
        { provide: AppConfigService, useValue: {} },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    });
  });

  function makeComponent(): any {
    const fixture = TestBed.createComponent(TerminalComponent);
    const c: any = fixture.componentInstance;
    c.activeAccountId = null;
    c.trades = [];
    c.panels = [];
    c.accounts = [];
    return c;
  }

  const trade = (security_id: number, direction: 'BUY' | 'SELL', quantity: number, price: number): any => ({
    id: Math.random(),
    account_id: 1,
    security_id,
    direction,
    execution: 'market',
    quantity,
    price,
    amount: quantity * price,
    status: 'filled',
    broker_order_id: null,
    note: null,
    executed_at: '2026-10-01T10:00:00Z',
    security_name: 'S',
    security_prefix: 'P',
  });

  it('остаток на счёте = свободные + закупка позиций (вложенные деньги не теряются)', () => {
    const c = makeComponent();
    c.accounts = [{ id: 1, account_type: 'fake', terminal_cash: 0 }];
    c.accountId = 1;
    c.trades = [trade(101, 'BUY', 10, 100)];
    expect(c.totalPositionCost).toBe(1000);
    expect(c.accountTotalAtCost).toBe(1000);
  });

  it('остаток на счёте суммируется со свободными средствами', () => {
    const c = makeComponent();
    c.accounts = [{ id: 1, account_type: 'fake', terminal_cash: 500 }];
    c.accountId = 1;
    c.trades = [trade(101, 'BUY', 10, 100)];
    expect(c.accountTotalAtCost).toBe(1500);
  });

  it('у шорта закупка отрицательная — выручка уже на счёте, итог не занижается', () => {
    const c = makeComponent();
    c.accounts = [{ id: 1, account_type: 'fake', terminal_cash: 1000 }];
    c.accountId = 1;
    c.trades = [trade(101, 'SELL', 10, 100)];
    expect(c.totalPositionCost).toBe(-1000);
    expect(c.accountTotalAtCost).toBe(0);
  });

  it('остаток + отклонение = стоимость счёта по рынку', () => {
    const c = makeComponent();
    c.accounts = [{ id: 1, account_type: 'fake', terminal_cash: 0 }];
    c.accountId = 1;
    c.trades = [trade(101, 'BUY', 10, 100)];
    (c as any).livePriceBySecurity = new Map([[101, 110]]);
    expect(c.accountPnl.pnl_rub).toBe(100);
    expect(Math.round((c.accountTotalAtCost + c.accountPnl.pnl_rub) * 100) / 100).toBe(1100);
  });

  it('реальный счёт: свободные деньги берутся из cash_amount, иначе из balance', () => {
    const c = makeComponent();
    c.accounts = [{ id: 1, account_type: 'real', cash_amount: 300, balance: 1300 }];
    c.accountId = 1;
    expect(c.accountFreeCash).toBe(300);
    c.accounts = [{ id: 1, account_type: 'real', cash_amount: null, balance: 1300 }];
    expect(c.accountFreeCash).toBe(1300);
  });

  it('без счёта и без позиций всё в нуле, отклонение ноль', () => {
    const c = makeComponent();
    expect(c.accountFreeCash).toBe(0);
    expect(c.accountTotalAtCost).toBe(0);
    expect(c.accountPnl.pnl_rub).toBe(0);
    expect(c.accountPnl.securities).toBe(0);
    expect(c.accountPnlRub).toBe(0);
  });

  it('позиция есть, но живых цен ещё нет → показываем «—», а не «0,00 ₽» (#925)', () => {
    const c = makeComponent();
    c.accounts = [{ id: 1, account_type: 'fake', terminal_cash: 0 }];
    c.accountId = 1;
    c.trades = [trade(101, 'BUY', 10, 100)];
    expect(c.accountPnl.securities).toBe(1);
    expect(c.accountPnl.priced).toBe(0);
    expect(c.accountPnlRub).toBeNull();
  });

  it('как только живая цена пришла — отклонение снова число', () => {
    const c = makeComponent();
    c.accounts = [{ id: 1, account_type: 'fake', terminal_cash: 0 }];
    c.accountId = 1;
    c.trades = [trade(101, 'BUY', 10, 100)];
    (c as any).livePriceBySecurity = new Map([[101, 110]]);
    expect(c.accountPnlRub).toBe(100);
  });
});
