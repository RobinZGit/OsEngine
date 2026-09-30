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

  function ev(barMs: number, timeframeId: number | null, timeframe?: string | null): any {
    return {
      logic_id: 7,
      logic_name: 'Логика',
      bar_dt: new Date(barMs).toISOString(),
      timeframe_id: timeframeId,
      timeframe: timeframe ?? null,
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

  it('полоса с нулевым остатком, у которой с сигнала прошло больше таймфрейма — удаляется', () => {
    const c = makeComponent();
    // M15 (900 с), сигнал 1000 с назад (~17 мин), позиции нет.
    c.panels = [panel(1, 101, ev(Date.now() - 1_000_000, 15, 'M15'))];
    c.removeFlatPanelsAfterSignalTimeout();
    expect(c.panels.length).toBe(0);
  });

  it('M1 (60 с): сигнал старше 1 минуты и нулевой остаток — удаляется; свежий — остаётся', () => {
    const c = makeComponent();
    c.panels = [
      panel(1, 101, ev(Date.now() - 90_000, 1, 'M1')), // 90 с > 60 с → удалить
      panel(2, 102, ev(Date.now() - 30_000, 1, 'M1')), // 30 с < 60 с → оставить
    ];
    c.removeFlatPanelsAfterSignalTimeout();
    expect(c.panels.map((p: any) => p.uid)).toEqual([2]);
  });

  it('есть открытая позиция — полоса остаётся, даже если сигнал очень старый', () => {
    const c = makeComponent();
    c.trades = [buy(101, 3)];
    c.panels = [panel(1, 101, ev(Date.now() - 7 * 86_400_000, 15, 'M15'))];
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
      panel(1, 101, ev(Date.now() - 7 * 86_400_000, 15, 'M15')), // позиция → оставить
      panel(2, 102, ev(Date.now() - 1_000_000, 15, 'M15')), // протух → удалить
      panel(3, 103, ev(Date.now() - 30_000, 1, 'M1')), // свежий M1 → оставить
      panel(4, 104, null), // без сигнала → оставить
    ];
    c.removeFlatPanelsAfterSignalTimeout();
    expect(c.panels.map((p: any) => p.uid).sort()).toEqual([1, 3, 4]);
  });

  it('таймфрейм берётся и по коду, если id не найден в списке', () => {
    const c = makeComponent();
    // timeframe_id 999 — неизвестен, но код TR 'M15' известен (900 с).
    c.panels = [panel(1, 101, ev(Date.now() - 1_000_000, 999, 'M15'))];
    c.removeFlatPanelsAfterSignalTimeout();
    expect(c.panels.length).toBe(0);
  });

  it('сигнал без даты бара и без таймфрейма полосу не удаляет', () => {
    const c = makeComponent();
    c.panels = [panel(1, 101, { logic_id: 7, bar_dt: null, timeframe_id: null, timeframe: null })];
    c.removeFlatPanelsAfterSignalTimeout();
    expect(c.panels.length).toBe(1);
  });
});