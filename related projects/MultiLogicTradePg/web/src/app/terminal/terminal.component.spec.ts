import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { TerminalComponent } from './terminal.component';
import { ReferencesService } from '../services/references.service';
import { SecuritiesService } from '../services/securities.service';
import { TerminalStateService } from '../services/terminal-state.service';
import { AppConfigService } from '../services/app-config.service';
import { NEVER, of, Subject } from 'rxjs';

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

describe('TerminalComponent — очередь сигналов не застревает (#925)', () => {
  function makeComponent(): any {
    const fixture = TestBed.createComponent(TerminalComponent);
    const c: any = fixture.componentInstance;
    c.activeAccountId = null;
    c.commonTimeframeId = 1;
    c.timeframes = [
      { id: 1, tf: 'M1', sec: 60, full_name: '1 минута', is_active: true },
      { id: 15, tf: 'M15', sec: 900, full_name: '15 минут', is_active: true },
    ];
    c.trades = [];
    c.panels = [];
    c.byId = new Map<number, any>();
    c.markSignalsRead = jasmine.createSpy('markSignalsRead');
    c.showSignalsToastList = () => undefined;
    c.scrollToPanel = () => undefined;
    c.buildPanel = jasmine.createSpy('buildPanel').and.callFake(
      (securityId: number, tf: number, _h: number, ev: any) => ({
        uid: 500 + securityId,
        security: { id: securityId },
        timeframe_id: tf,
        signal_event: { ...ev },
        logic_indicator_ids: [],
        auto_close_on_logic_signal: true,
        collapsed: false,
      })
    );
    return c;
  }

  function sig(
    id: number,
    securityId: number,
    createdAtMs: number,
    timeframeId = 1,
    timeframe = 'M1'
  ): any {
    return {
      id,
      logic_id: 7,
      logic_name: 'Логика',
      security_id: securityId,
      security_name: 'Бумага',
      security_prefix: 'TEST',
      side_label: 'покупка',
      position_side: 'long',
      bar_dt: new Date(createdAtMs).toISOString(),
      created_at: new Date(createdAtMs).toISOString(),
      timeframe_id: timeframeId,
      timeframe,
      price: 100,
      suggested_quantity: 1,
      suggested_amount: 100,
      indicator_ids: [],
    };
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

  it('сигнал по бумаге, которой нет в справочнике, всё равно помечается прочитанным', () => {
    const c = makeComponent();
    c.applyLogicSignals([sig(11, 999, Date.now())]);
    expect(c.buildPanel).not.toHaveBeenCalled();
    expect(c.markSignalsRead).toHaveBeenCalledWith([11]);
  });

  it('устаревший сигнал не создаёт полосу, но помечается прочитанным (очередь движется)', () => {
    const c = makeComponent();
    c.byId = new Map([[101, { id: 101 }]]);
    c.applyLogicSignals([sig(21, 101, Date.now() - 10 * 60_000)]);
    expect(c.buildPanel).not.toHaveBeenCalled();
    expect(c.panels.length).toBe(0);
    expect(c.markSignalsRead).toHaveBeenCalledWith([21]);
  });

  it('свежий резолвимый сигнал создаёт полосу и помечается прочитанным', () => {
    const c = makeComponent();
    c.byId = new Map([[101, { id: 101 }]]);
    c.applyLogicSignals([sig(31, 101, Date.now())]);
    expect(c.buildPanel).toHaveBeenCalled();
    expect(c.panels.length).toBe(1);
    expect(c.markSignalsRead).toHaveBeenCalledWith([31]);
  });

  it('пачка: нерезолвимые и протухшие помечаются, свежие применяются', () => {
    const c = makeComponent();
    c.byId = new Map([[101, { id: 101 }]]);
    c.applyLogicSignals([
      sig(41, 999, Date.now()), // нет бумаги → только пометить
      sig(42, 101, Date.now() - 10 * 60_000), // протух → только пометить
      sig(43, 101, Date.now()), // свежий → полоса
    ]);
    expect(c.panels.length).toBe(1);
    expect(c.markSignalsRead).toHaveBeenCalledWith([41, 42, 43]);
  });

  it('signalPastKeepWindow: старый M15 протух, свежий M1 — нет', () => {
    const c = makeComponent();
    expect(
      c.signalPastKeepWindow({
        created_at: new Date(Date.now() - 20 * 60_000).toISOString(),
        bar_dt: null,
        timeframe_id: 15,
        timeframe: 'M15',
      })
    ).toBe(true);
    expect(
      c.signalPastKeepWindow({
        created_at: new Date(Date.now() - 10_000).toISOString(),
        bar_dt: null,
        timeframe_id: 1,
        timeframe: 'M1',
      })
    ).toBe(false);
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

  it('остаток на счёте = свободные средства (демо, минус суммы покупок)', () => {
    const c = makeComponent();
    c.accounts = [{ id: 1, account_type: 'fake', terminal_cash: -69482.23 }];
    c.accountId = 1;
    c.trades = [trade(101, 'BUY', 10, 100)];
    expect(c.accountFreeCash).toBe(-69482.23);
  });

  it('демо без покупок: остаток ноль', () => {
    const c = makeComponent();
    c.accounts = [{ id: 1, account_type: 'fake', terminal_cash: 0 }];
    c.accountId = 1;
    expect(c.accountFreeCash).toBe(0);
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

  it('закрытие убыточной позиции не «улучшает» отклонение: убыток остаётся в итоге', () => {
    const c = makeComponent();
    c.accounts = [{ id: 1, account_type: 'fake', terminal_cash: 0 }];
    c.accountId = 1;
    (c as any).livePriceBySecurity = new Map([[101, 95]]);
    c.trades = [trade(101, 'BUY', 10, 100), trade(101, 'SELL', 10, 90)];
    expect(c.accountPnl.securities).toBe(0); // позиции больше нет
    expect(c.accountPnl.realized_rub).toBe(-100);
    expect(c.accountPnlRub).toBe(-100);
  });

  it('кнопка «Отклонение»: принудительно (force) запрашивает цены по всем бумагам с позицией', () => {
    const c = makeComponent();
    c.accounts = [{ id: 1, account_type: 'fake', terminal_cash: 0 }];
    c.accountId = 1;
    c.trades = [
      trade(101, 'BUY', 10, 100),
      trade(202, 'BUY', 5, 200),
      trade(202, 'SELL', 5, 200),
    ];
    const calls: Array<{ ids: number[]; force: boolean }> = [];
    (c as any).securitiesSvc = {
      getLastPrices: (ids: number[], force: boolean) => {
        calls.push({ ids, force });
        return of({ ok: true, source: 'tbank', prices: [{ security_id: 101, price: 110 }] });
      },
    };
    c.refreshAllPrices();
    // Только бумага с ненулевым остатком; запрос идёт с force=1 (мимо троттлинга).
    expect(calls.length).toBe(1);
    expect(calls[0].force).toBe(true);
    expect(calls[0].ids).toEqual([101]);
    // Отклонение пересчиталось (сумма по бумагам): 10 × (110 − 100) = 100.
    expect(c.accountPnlRub).toBe(100);
    expect(c.pricesRefreshing).toBe(false);
  });

  it('кнопка «Закрыть все позиции»: в подписи суммарный итог закрытия (#933)', () => {
    const c = makeComponent();
    c.panels = [
      { uid: 1, security: { id: 101 }, signal_event: null, collapsed: true },
      { uid: 2, security: { id: 202 }, signal_event: null, collapsed: true },
    ];
    // Бумага 1 в убыток (−60,10), бумага 2 в плюс (+120,00) → сумма +59,90.
    c.onPanelPositionSummary(1, { qty: 10, marketValue: 2500, closingNetDiff: -60.1 });
    c.onPanelPositionSummary(2, { qty: 5, marketValue: 500, closingNetDiff: 120 });
    expect(c.totalClosingNetDiff).toBe(59.9);
    expect(c.closeAllIsProfit).toBe(true);
    expect(c.closeAllButtonLabel).toBe('Закрыть все позиции (приб. 59,90 ₽)');
    expect(c.closeAllButtonTitle).toContain('59,90');
  });

  it('кнопка «Закрыть все позиции»: убыток по сумме — красная, нулевая — без скобок', () => {
    const c = makeComponent();
    c.panels = [
      { uid: 1, security: { id: 101 }, signal_event: null, collapsed: true },
    ];
    c.onPanelPositionSummary(1, { qty: 10, marketValue: 2500, closingNetDiff: -12.5 });
    expect(c.totalClosingNetDiff).toBe(-12.5);
    expect(c.closeAllIsLoss).toBe(true);
    expect(c.closeAllButtonLabel).toBe('Закрыть все позиции (уб. 12,50 ₽)');

    c.onPanelPositionSummary(1, { qty: 10, marketValue: 2500, closingNetDiff: 0 });
    expect(c.totalClosingNetDiff).toBe(0);
    expect(c.closeAllIsLoss).toBe(false);
    expect(c.closeAllIsProfit).toBe(false);
    expect(c.closeAllButtonLabel).toBe('Закрыть все позиции');
  });
});

describe('TerminalComponent — «Исполнять сделки сразу» (#946)', () => {
  const stateSvc: any = {
    markLogicSignalsRead: () => of({ ok: true }),
  };
  // Галочка живёт в шапке — рендерим её настоящим шаблоном, поэтому ngOnInit
  // должен получить справочники (пустые ответы — шапка всё равно рисуется).
  const refs: any = {
    getAccounts: () => of([]),
    getExchanges: () => of([]),
    getBondFunds: () => of([]),
  };
  const securitiesSvc: any = {
    getTimeframes: () =>
      of([
        { id: 1, tf: 'M1', sec: 60, full_name: '1 минута', is_active: true },
        { id: 15, tf: 'M15', sec: 900, full_name: '15 минут', is_active: true },
      ]),
  };
  const stateSvcUi: any = {
    ...stateSvc,
    getUiState: () => of({ ok: true, selected_account_id: null }),
    getBondPlan: () => of({ ok: true, bonds: [] }),
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [TerminalComponent],
      providers: [
        { provide: ReferencesService, useValue: refs },
        { provide: SecuritiesService, useValue: securitiesSvc },
        { provide: TerminalStateService, useValue: stateSvcUi },
        { provide: AppConfigService, useValue: {} },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    });
  });

  function makeComponent(): any {
    const fixture = TestBed.createComponent(TerminalComponent);
    const c: any = fixture.componentInstance;
    c.activeAccountId = null; // без активного счёта scheduleSave() — no-op
    c.trades = [];
    c.panels = [];
    c.accounts = [];
    c.timeframes = [
      { id: 1, tf: 'M1', sec: 60, full_name: '1 минута', is_active: true },
      { id: 15, tf: 'M15', sec: 900, full_name: '15 минут', is_active: true },
    ];
    c.contangoByPrefix = new Map();
    c.byId = new Map([
      [101, { id: 101, name: 'S', prefix: 'P', instrument_market: 'stock' }],
    ]);
    return c;
  }

  const signalRow = (over?: Record<string, unknown>): any => ({
    id: 990,
    logic_id: 7,
    logic_name: 'Логика',
    security_id: 101,
    security_prefix: 'P',
    security_name: 'S',
    timeframe_id: 15,
    timeframe: 'M15',
    bar_dt: new Date().toISOString(),
    position_side: 'long',
    signal_kind: 'open',
    side_label: 'Покупка',
    formula: null,
    price: 250,
    suggested_quantity: 4,
    suggested_amount: 1000,
    indicator_ids: [],
    indicators: [],
    created_at: new Date().toISOString(),
    ...(over ?? {}),
  });

  it('по умолчанию выключена, галочка в шапке есть', () => {
    const fixture = TestBed.createComponent(TerminalComponent);
    const c: any = fixture.componentInstance;
    c.activeAccountId = null;
    c.trades = [];
    c.panels = [];
    c.accounts = [];
    fixture.detectChanges();

    expect(c.executeSignalsNow).toBe(false);
    const box = fixture.nativeElement.querySelector('.term-field-check .term-check');
    expect(box).not.toBeNull();
    expect(box.checked).toBe(false);
    expect(fixture.nativeElement.textContent).toContain('Исполнять сделки сразу');
  });

  it('#949: включённая галочка получает класс оранжевой подсветки, выключенная — нет', () => {
    const fixture = TestBed.createComponent(TerminalComponent);
    const c: any = fixture.componentInstance;
    c.activeAccountId = null;
    c.trades = [];
    c.panels = [];
    c.accounts = [];
    fixture.detectChanges();

    const label = (): any =>
      fixture.nativeElement.querySelector('.term-field-check');
    expect(label().classList.contains('term-field-check-on')).toBe(false);

    c.onExecuteSignalsNowChange(true); // executeSignalsNow — геттер, пишем через обработчик
    fixture.detectChanges();
    expect(label().classList.contains('term-field-check-on')).toBe(true);
  });

  it('включение сохраняется в настройках и включает автозакрытие на всех полосах', () => {
    const c = makeComponent();
    c.panels = [
      { uid: 1, security: { id: 101 }, signal_event: null, collapsed: true, auto_close_on_logic_signal: false },
      { uid: 2, security: { id: 202 }, signal_event: null, collapsed: true, auto_close_on_logic_signal: false },
    ];
    c.onExecuteSignalsNowChange(true);
    expect(c.executeSignalsNow).toBe(true);
    expect(c.settings['execute_signals_now']).toBe(true);
    expect(c.panels.every((p: any) => p.auto_close_on_logic_signal)).toBe(true);

    c.onExecuteSignalsNowChange(false);
    expect(c.executeSignalsNow).toBe(false);
    // Выключение не трогает уже включённые галочки автозакрытия.
    expect(c.panels.every((p: any) => p.auto_close_on_logic_signal)).toBe(true);
  });

  it('новый сигнал при включённой галочке сразу включает автозакрытие полосы', () => {
    const c = makeComponent();
    c.settings = { ...c.settings, execute_signals_now: true };
    c.applyLogicSignals([signalRow()]);

    expect(c.panels.length).toBe(1);
    expect(c.panels[0].auto_close_on_logic_signal).toBe(true);
    // Сигнал сохранён в полосу вместе с id — по нему полоса исполняет его один раз.
    expect(c.panels[0].signal_event.signal_id).toBe(990);
  });

  it('выключенная галочка не включает автозакрытие полосы (по умолчанию)', () => {
    const c = makeComponent();
    c.applyLogicSignals([signalRow()]);
    expect(c.panels.length).toBe(1);
    expect(c.panels[0].auto_close_on_logic_signal).toBe(false);
  });
});

describe('TerminalComponent — порядок полос бумаг (#948)', () => {
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
    c.activeAccountId = null; // без счёта scheduleSave() — no-op
    c.trades = [];
    c.panels = [];
    return c;
  }

  const panel = (uid: number, securityId: number): any => ({
    uid,
    security: { id: securityId },
    signal_event: null,
    auto_close_on_logic_signal: false,
    collapsed: true,
  });

  const trade = (
    securityId: number,
    direction: 'BUY' | 'SELL',
    quantity: number
  ): any => ({
    security_id: securityId,
    direction,
    quantity: String(quantity),
    status: 'filled',
  });

  const order = (c: any): number[] => c.panels.map((p: any) => p.security.id);

  it('сверху позиции, посередине бумаги без позиции (новые сверху), внизу закрытые', () => {
    const c = makeComponent();
    // Порядок до раскладки намеренно смешанный.
    c.panels = [
      panel(1, 301), // закрыта (были сделки, остаток 0)   → вниз
      panel(2, 201), // позиция                            → наверх
      panel(3, 401), // позиции ещё нет, старая            → середина, ниже новых
      panel(4, 302), // закрыта                             → вниз
      panel(5, 202), // позиция                             → наверх
      panel(6, 402), // позиции ещё нет, новая (uid больше)  → верх середины
    ];
    c.trades = [
      trade(201, 'BUY', 10),
      trade(202, 'SELL', 5),
      trade(301, 'BUY', 3),
      trade(301, 'SELL', 3),
      trade(302, 'BUY', 1),
      trade(302, 'SELL', 1),
    ];
    c.applyPanelOrder();
    expect(order(c)).toEqual([201, 202, 402, 401, 301, 302]);
  });

  it('внутри «с позицией» и «закрытой» порядок не меняется', () => {
    const c = makeComponent();
    c.panels = [panel(1, 201), panel(2, 202), panel(3, 301)];
    c.trades = [
      trade(201, 'BUY', 10),
      trade(202, 'BUY', 10),
      trade(301, 'BUY', 1),
      trade(301, 'SELL', 1),
    ];
    c.applyPanelOrder();
    expect(order(c)).toEqual([201, 202, 301]);
  });

  it('покупка поднимает полосу вверх, полная продажа опускает её вниз', () => {
    const c = makeComponent();
    c.panels = [panel(1, 201), panel(2, 202)];
    c.trades = [trade(201, 'BUY', 10)];
    c.applyPanelOrder();
    expect(order(c)).toEqual([201, 202]);

    c.trades = [trade(201, 'BUY', 10), trade(201, 'SELL', 10), trade(202, 'BUY', 5)];
    c.applyPanelOrder();
    expect(order(c)).toEqual([202, 201]);
  });

  it('частичная продажа позицию не закрывает — полоса остаётся сверху', () => {
    const c = makeComponent();
    c.panels = [panel(1, 201), panel(2, 202)];
    c.trades = [trade(201, 'BUY', 10), trade(201, 'SELL', 4), trade(202, 'BUY', 5)];
    c.applyPanelOrder();
    expect(order(c)).toEqual([201, 202]);
  });

  it('не-filled сделки не считаются ни позицией, ни закрытой бумагой', () => {
    const c = makeComponent();
    c.panels = [panel(1, 301), panel(2, 402)];
    c.trades = [
      { security_id: 301, direction: 'BUY', quantity: '5', status: 'rejected' },
      { security_id: 402, direction: 'BUY', quantity: '5', status: 'pending' },
    ];
    c.applyPanelOrder();
    // Обе — «позиции нет»; новая (uid 2) сверху
    expect(order(c)).toEqual([402, 301]);
  });

  it('новая бумага по сигналу встаёт наверх группы «позиции ещё нет»', () => {
    const c = makeComponent();
    // 201 — с позицией, 301 — закрыта, 401 — без позиции (уже висит).
    c.panels = [panel(1, 201), panel(2, 301), panel(3, 401)];
    c.trades = [trade(201, 'BUY', 10), trade(301, 'BUY', 2), trade(301, 'SELL', 2)];
    c.nextUid = 4;
    c.timeframes = [
      { id: 15, tf: 'M15', sec: 900, full_name: '15 минут', is_active: true },
    ];
    c.contangoByPrefix = new Map();
    c.byId = new Map([
      [501, { id: 501, name: 'НОВАЯ', prefix: 'NEW', instrument_market: 'stock' }],
    ]);
    (c as any).stateSvc = { markLogicSignalsRead: () => of({ ok: true }) };
    c.applyLogicSignals([
      {
        id: 777,
        logic_id: 7,
        logic_name: 'Логика',
        security_id: 501,
        security_name: 'НОВАЯ',
        security_prefix: 'NEW',
        direction: 'BUY',
        timeframe_id: 15,
        timeframe: 'M15',
        bar_dt: new Date().toISOString(),
        created_at: new Date().toISOString(),
        indicator_ids: [],
      },
    ]);

    expect(order(c)).toEqual([201, 501, 401, 301]);
  });
});

describe('TerminalComponent — обновление сделок и гонка ответов (#955)', () => {
  const trade = (id: number): any => ({
    id,
    account_id: 1,
    security_id: 101,
    direction: 'BUY',
    execution: 'market',
    quantity: '10',
    price: 100,
    amount: 1000,
    status: 'filled',
    broker_order_id: null,
    note: null,
    executed_at: '2026-10-06T10:00:00Z',
    security_name: 'S',
    security_prefix: 'P',
  });

  function makeComponent(): any {
    const fixture = TestBed.createComponent(TerminalComponent);
    const c: any = fixture.componentInstance;
    c.activeAccountId = null; // без активного счёта scheduleSave() — no-op
    c.trades = [];
    c.panels = [];
    c.accounts = [];
    // В успешном ответе loadTrades живые цены опрашиваются по бумагам позиции.
    (c as any).securitiesSvc = {
      getLastPrices: () => of({ ok: true, prices: [] }),
    };
    return c;
  }

  /** stateSvc.getTrades отдаёт очередной Subject — ответы управляемы по очереди. */
  function queueTrades(c: any): Subject<any>[] {
    const reqs: Subject<any>[] = [];
    (c as any).stateSvc = {
      getTrades: () => {
        const s = new Subject<any>();
        reqs.push(s);
        return s;
      },
    };
    return reqs;
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

  it('запоздавший ответ старого запроса не перетирает сделки нового', () => {
    const c = makeComponent();
    const reqs = queueTrades(c);
    c.accountId = 1;
    c.loadTrades(); // запрос 1 (медленный)
    c.loadTrades(); // запрос 2 (свежий)
    expect(reqs.length).toBe(2);

    // Свежий ответ пришёл первым, старый — запоздал и пришёл вторым.
    reqs[1].next({ trades: [trade(200)] });
    reqs[0].next({ trades: [trade(100)] });

    expect(c.trades.map((t: any) => t.id)).toEqual([200]);
    expect(c.tradesLoading).toBe(false);
  });

  it('повторная загрузка того же счёта не очищает список сделок синхронно', () => {
    const c = makeComponent();
    const reqs = queueTrades(c);
    c.accountId = 1;
    c.loadTrades();
    reqs[0].next({ trades: [trade(1)] });

    c.loadTrades(); // тот же счёт — прежние сделки остаются на месте
    expect(c.trades.map((t: any) => t.id)).toEqual([1]);
    expect(c.tradesLoading).toBe(true);

    reqs[1].next({ trades: [trade(1), trade(2)] });
    expect(c.trades.map((t: any) => t.id)).toEqual([1, 2]);
    expect(c.tradesLoading).toBe(false);
  });

  it('смена счёта сразу убирает чужую историю сделок', () => {
    const c = makeComponent();
    const reqs = queueTrades(c);
    c.accountId = 1;
    c.loadTrades();
    reqs[0].next({ trades: [trade(1)] });
    expect(c.trades.length).toBe(1);

    c.accountId = 2;
    c.loadTrades();
    expect(c.trades).toEqual([]);
    expect(c.tradesLoading).toBe(true);
  });

  it('ошибка загрузки не затирает уже показанные сделки', () => {
    const c = makeComponent();
    const reqs = queueTrades(c);
    c.accountId = 1;
    c.loadTrades();
    reqs[0].next({ trades: [trade(1)] });

    c.loadTrades();
    reqs[1].error({ message: 'сеть упала' });
    expect(c.trades.map((t: any) => t.id)).toEqual([1]);
    expect(c.tradesError).toContain('сеть упала');
    expect(c.tradesLoading).toBe(false);
  });

  it('onTradeExecuted грузит сделки сразу, не дожидаясь getAccounts', () => {
    const c = makeComponent();
    const reqs = queueTrades(c);
    let accountsCalls = 0;
    (c as any).refs = {
      getAccounts: () => {
        accountsCalls++;
        return NEVER; // баланс реального счёта «висит» — ответа нет
      },
    };
    c.accountId = 1;

    c.onTradeExecuted();
    expect(accountsCalls).toBe(1);
    expect(reqs.length).toBe(1); // сделки запрошены параллельно, не в next

    reqs[0].next({ trades: [trade(1)] });
    expect(c.trades.map((t: any) => t.id)).toEqual([1]);
    expect(c.accounts).toEqual([]); // подвисший баланс не мешает
  });
});
