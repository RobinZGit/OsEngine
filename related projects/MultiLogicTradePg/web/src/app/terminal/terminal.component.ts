import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { TerminalPanelComponent } from './terminal-panel.component';
import { ReferencesService } from '../services/references.service';
import { SecuritiesService } from '../services/securities.service';
import {
  TerminalBondHolding,
  TerminalStatePayload,
  TerminalStateService,
  TerminalTradeRow,
} from '../services/terminal-state.service';
import {
  AppConfigService,
  logicsLoadErrorMessage,
} from '../services/app-config.service';
import { AccountRow, BondFundInfo, ExchangeRow } from '../models/lookup.model';
import { SecurityRow, TimeframeRow } from '../models/market.model';
import { tradeStatusLabel } from '../shared/logic-trade';

interface PanelModel {
  uid: number;
  security: SecurityRow;
  contango: SecurityRow | null;
  underlying: SecurityRow | null;
  timeframe_id: number | null;
  chart_height: number;
}

const DEFAULT_CHART_HEIGHT = 340;

@Component({
  selector: 'app-terminal',
  standalone: true,
  imports: [CommonModule, FormsModule, TerminalPanelComponent],
  templateUrl: './terminal.component.html',
  styleUrl: './terminal.component.css',
})
export class TerminalComponent implements OnInit {
  accounts: AccountRow[] = [];
  accountId: number | null = null;
  exchanges: ExchangeRow[] = [];
  futures: SecurityRow[] = [];
  stocks: SecurityRow[] = [];
  /** Облигации (security_type Bond), зарегистрированные для терминала. */
  bonds: SecurityRow[] = [];
  timeframes: TimeframeRow[] = [];
  /** Синтетики контанго (префикс CTG:*) по префиксу фьючерса. */
  contangoByPrefix = new Map<string, SecurityRow>();
  /** Доступ по id для быстрого поиска базового актива. */
  private byId = new Map<number, SecurityRow>();

  /** Фонды облигаций (TBRU / SBGB / OBLG) — список и состав выбранного. */
  bondFunds: BondFundInfo[] = [];
  bondFundCode = 'TBRU';
  bondHoldings: TerminalBondHolding[] = [];
  bondLoading = false;
  bondError: string | null = null;
  pendingBondSec: string | null = null;
  registeringBond: string | null = null;

  /** Прочие настройки терминала в JSON (объёмы по умолчанию и т.п.). */
  settings: { buyQty: number; sellQty: number; [k: string]: unknown } = {
    buyQty: 1,
    sellQty: 1,
  };

  pickerOpen = false;
  pendingSecurityId: number | null = null;

  private nextUid = 1;
  panels: PanelModel[] = [];

  loading = true;
  error: string | null = null;

  /** История сделок терминала выбранного счёта (новые сверху). */
  trades: TerminalTradeRow[] = [];
  tradesLoading = false;
  tradesError: string | null = null;
  /** Идёт удаление всех сделок (блокирует повторные клики). */
  tradesDeleting = false;

  /** Счёт, к которому относятся текущие panels (для сохранения при переключении). */
  private activeAccountId: number | null = null;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private pendingSaveAccount: number | null = null;
  private pendingSavePayload: TerminalStatePayload | null = null;

  constructor(
    private readonly refs: ReferencesService,
    private readonly securitiesSvc: SecuritiesService,
    private readonly stateSvc: TerminalStateService,
    private readonly appConfig: AppConfigService
  ) {}

  ngOnInit(): void {
    forkJoin({
      accounts: this.refs.getAccounts(undefined, true),
      exchanges: this.refs.getExchanges(),
      timeframes: this.securitiesSvc.getTimeframes(),
      bondFunds: this.refs.getBondFunds(),
    }).subscribe({
      next: ({ accounts, exchanges, timeframes, bondFunds }) => {
        this.accounts = accounts;
        this.exchanges = exchanges;
        this.timeframes = timeframes;
        this.bondFunds = bondFunds;
        if (bondFunds.length && !bondFunds.some((f) => f.code === this.bondFundCode)) {
          this.bondFundCode = bondFunds[0].code;
        }
        this.loading = false;
        this.selectDefaultAccount(accounts);
        this.loadSecurities();
        this.loadBondPlan();
      },
      error: (err) => {
        this.loading = false;
        this.error = logicsLoadErrorMessage(this.appConfig.apiUrl, err);
      },
    });
  }

  /** Выбор счёта при старте: по умолчанию — фейковый (демо), если такой есть.
      Сохранённый ранее реальный счёт игнорируется — иначе терминал «залипает»
      на старом реальном и не переходит на новый фейковый. Сохранённый
      фейковый счёт восстанавливается (выбор фейка запоминается). */
  private selectDefaultAccount(accounts: AccountRow[]): void {
    const fakeIds = accounts
      .filter((a) => String(a.account_type).toLowerCase() !== 'real')
      .map((a) => a.id);
    const fallbackId = fakeIds[0] ?? accounts[0]?.id ?? null;
    this.applyAccount(fallbackId);
    this.stateSvc.getUiState().subscribe({
      next: (r) => {
        if (!this.accounts.length) return;
        const saved = r?.selected_account_id ?? null;
        if (saved == null || saved === this.accountId) return;
        const savedAccount = this.accounts.find((a) => a.id === saved);
        if (!savedAccount) return;
        const savedIsFake =
          String(savedAccount.account_type).toLowerCase() !== 'real';
        // Реальный сохранённый счёт не перебивает дефолтный фейковый.
        if (!fakeIds.length || savedIsFake) this.applyAccount(saved);
      },
      error: () => undefined,
    });
  }

  /** Применить счёт: активный id, сделки, панели и запоминание выбора. */
  private applyAccount(id: number | null): void {
    const changed = this.accountId !== id;
    this.accountId = id;
    this.activeAccountId = id;
    this.loadTrades();
    if (changed) this.loadSavedState();
    if (id == null) return;
    this.stateSvc.saveUiState(id).subscribe({ error: () => undefined });
  }

  /** Список настоящих бумаг для выбора: фьючерсы, акции и облигации.
      Синтетики контанго в выбор не попадают — автоматически к своему фьючерсу. */
  loadSecurities(): void {
    const combos: { exchangeId: number; kind: 'stock' | 'futures' | 'other' | 'bond' }[] =
      [];
    for (const ex of this.exchanges) {
      combos.push(
        { exchangeId: ex.id, kind: 'stock' },
        { exchangeId: ex.id, kind: 'futures' },
        { exchangeId: ex.id, kind: 'other' },
        { exchangeId: ex.id, kind: 'bond' }
      );
    }
    if (combos.length === 0) {
      this.futures = [];
      this.stocks = [];
      this.bonds = [];
      this.contangoByPrefix.clear();
      return;
    }
    forkJoin(
      combos.map((c) => this.securitiesSvc.getSecurities(c.exchangeId, c.kind))
    ).subscribe({
      next: (lists) => {
        const futures: SecurityRow[] = [];
        const stocks: SecurityRow[] = [];
        const bonds: SecurityRow[] = [];
        const contango = new Map<string, SecurityRow>();
        const seenIds = new Set<number>();
        for (const list of lists) {
          for (const s of list) {
            if (seenIds.has(s.id)) continue;
            seenIds.add(s.id);
            if (s.instrument_market === 'futures') {
              futures.push(s);
            } else if (s.instrument_market === 'stock') {
              stocks.push(s);
            } else if (s.instrument_market === 'bonds') {
              bonds.push(s);
            } else if (s.prefix && s.prefix.startsWith('CTG:')) {
              contango.set('CTG:' + s.prefix.slice(4), s);
            }
          }
        }
        futures.sort((a, b) => a.prefix.localeCompare(b.prefix, 'ru'));
        stocks.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
        bonds.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
        this.futures = futures;
        this.stocks = stocks;
        this.bonds = bonds;
        this.contangoByPrefix = contango;
        this.byId = new Map(
          [...futures, ...stocks, ...bonds].map((s) => [s.id, s])
        );
        this.loadSavedState();
      },
      error: () => {
        this.futures = [];
        this.stocks = [];
        this.bonds = [];
        this.contangoByPrefix.clear();
      },
    });
  }

  /** Смена счёта: сохраняем текущий набор полос, восстанавливаем новый,
      запоминаем выбор и перезагружаем историю сделок. */
  onAccountChange(): void {
    const nextId = this.accountId;
    if (this.activeAccountId != null && this.activeAccountId !== nextId) {
      this.scheduleSave();
    }
    this.activeAccountId = nextId;
    this.loadSavedState();
    this.loadTrades();
    if (nextId != null) {
      this.stateSvc.saveUiState(nextId).subscribe({ error: () => undefined });
    }
  }

  /** История сделок выбранного счёта (последние 100). */
  loadTrades(): void {
    const id = this.accountId;
    this.trades = [];
    this.tradesError = null;
    if (id == null) {
      this.tradesLoading = false;
      return;
    }
    this.tradesLoading = true;
    this.stateSvc.getTrades(id, 100).subscribe({
      next: (r) => {
        this.tradesLoading = false;
        this.trades = r?.trades ?? [];
      },
      error: (err) => {
        this.tradesLoading = false;
        this.tradesError =
          err?.error?.error || err?.message || 'Не удалось загрузить сделки';
      },
    });
  }

  /** После сделки терминала обновляем баланс/остаток счёта и список сделок. */
  onTradeExecuted(): void {
    this.refs.getAccounts(undefined, true).subscribe({
      next: (updated) => {
        this.accounts = updated;
        this.loadTrades();
      },
      error: () => this.loadTrades(),
    });
  }

  /** Требуется подтверждение; после удаления всех сделок счёта — пересчёт остатка. */
  clearTrades(): void {
    const id = this.accountId;
    if (id == null || this.tradesDeleting) return;
    const acc = this.selectedAccount;
    const who = acc ? `${acc.name} (${acc.account_code})` : 'счёта';
    if (!confirm(`Действительно удалить все сделки ${who}? Остаток будет пересчитан.`)) {
      return;
    }
    this.tradesDeleting = true;
    this.stateSvc.deleteTrades(id).subscribe({
      next: () => {
        this.tradesDeleting = false;
        this.refs.getAccounts(undefined, true).subscribe({
          next: (updated) => {
            this.accounts = updated;
            this.loadTrades();
          },
          error: () => this.loadTrades(),
        });
      },
      error: (err) => {
        this.tradesDeleting = false;
        this.tradesError =
          err?.error?.error || err?.message || 'Не удалось удалить сделки';
      },
    });
  }

  get selectedAccount(): AccountRow | null {
    return this.accounts.find((a) => a.id === this.accountId) ?? null;
  }

  /** Остаток для торгового блока: у фейка — демо-кэш (может быть в минусе),
      у реального — живой баланс брокера. */
  get selectedAccountCash(): number | null {
    const acc = this.selectedAccount;
    if (!acc) return null;
    if (acc.account_type !== 'real') {
      const c = Number(acc.terminal_cash);
      return Number.isFinite(c) ? c : 0;
    }
    const b = Number(acc.balance);
    return Number.isFinite(b) ? b : null;
  }

  /** Фейковый счёт — сделки идут в демо-режиме. */
  get selectedAccountIsFake(): boolean {
    return this.selectedAccount?.account_type !== 'real';
  }

  /** Максимальная сумма сделки: баланс выбранного счёта; для фейкового счёта
      (или нулевого баланса) — 10 000 ₽. */
  get tradeMaxSum(): number {
    const acc = this.selectedAccount;
    if (!acc || acc.account_type !== 'real') return 10000;
    const b = Number(acc.balance);
    return Number.isFinite(b) && b > 0 ? Math.floor(b) : 10000;
  }

  /** Восстановление сохранённых полос и настроек для текущего счёта. */
  private loadSavedState(): void {
    this.activeAccountId = this.accountId;
    this.panels = [];
    if (this.accountId == null) return;
    this.stateSvc.getState(this.accountId).subscribe({
      next: (r) => {
        const settings = r.payload.settings ?? {};
        this.settings = {
          ...settings,
          buyQty: this.safeQty(settings['buyQty'], 1),
          sellQty: this.safeQty(settings['sellQty'], 1),
        };
        this.panels = (r.payload.panels ?? [])
          .map((st) =>
            this.buildPanel(st.security_id, st.timeframe_id, st.chart_height)
          )
          .filter((p): p is PanelModel => p != null);
      },
      error: () => undefined,
    });
  }

  private safeQty(v: unknown, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
  }

  /** Пересборка модели полосы из сохранённого состояния (если бумага ещё есть). */
  private buildPanel(
    securityId: number,
    timeframeId?: number | null,
    chartHeight?: number | null
  ): PanelModel | null {
    const sec = this.byId.get(securityId);
    if (!sec) return null;
    return {
      uid: this.nextUid++,
      security: sec,
      contango:
        sec.instrument_market === 'futures'
          ? this.contangoByPrefix.get('CTG:' + sec.prefix) ?? null
          : null,
      underlying:
        sec.instrument_market === 'futures' && sec.underlying_security_id
          ? this.byId.get(sec.underlying_security_id) ?? null
          : null,
      timeframe_id:
        timeframeId != null && this.timeframes.some((t) => t.id === timeframeId)
          ? timeframeId
          : null,
      chart_height:
        chartHeight != null &&
        chartHeight >= 100 &&
        chartHeight <= 1400 &&
        Number.isFinite(chartHeight)
          ? chartHeight
          : DEFAULT_CHART_HEIGHT,
    };
  }

  togglePicker(): void {
    this.pickerOpen = !this.pickerOpen;
    this.pendingSecurityId = null;
  }

  onSecurityPicked(): void {
    const id = this.pendingSecurityId;
    if (id == null) return;
    const sec =
      this.futures.find((s) => s.id === id) ??
      this.stocks.find((s) => s.id === id);
    if (!sec) return;
    const panel = this.buildPanel(sec.id, null, DEFAULT_CHART_HEIGHT);
    if (!panel) return;
    this.panels.push(panel);
    // Сброс, чтобы можно было выбрать следующую бумагу подряд.
    this.pendingSecurityId = null;
    this.scheduleSave();
  }

  removePanel(uid: number): void {
    this.panels = this.panels.filter((p) => p.uid !== uid);
    this.scheduleSave();
  }

  /** Состав выбранного фонда облигаций (для селекта выпусков). */
  loadBondPlan(code?: string): void {
    const fundCode = String(code || this.bondFundCode || 'TBRU').trim().toUpperCase();
    this.bondFundCode = fundCode;
    this.bondHoldings = [];
    this.bondError = null;
    this.pendingBondSec = null;
    this.bondLoading = true;
    this.stateSvc.getBondPlan(fundCode).subscribe({
      next: (r) => {
        this.bondLoading = false;
        this.bondHoldings = r?.bonds ?? [];
      },
      error: (err) => {
        this.bondLoading = false;
        this.bondError =
          err?.error?.error || err?.message || 'Не удалось загрузить состав фонда';
      },
    });
  }

  /** Выбор выпуска: регистрация как security + открытие панели с графиком. */
  onBondPicked(): void {
    const sec = this.pendingBondSec;
    if (!sec) return;
    this.registeringBond = sec;
    this.bondError = null;
    this.stateSvc.registerBond(sec).subscribe({
      next: (r) => {
        this.registeringBond = null;
        this.pendingBondSec = null;
        const row = r?.security;
        if (!row || row.id == null) {
          this.bondError = r?.price_error || 'Выпуск не зарегистрирован';
          return;
        }
        if (!this.bonds.some((b) => b.id === row.id)) {
          this.bonds = [...this.bonds, row].sort((a, b) =>
            a.name.localeCompare(b.name, 'ru')
          );
        }
        this.byId.set(row.id, row);
        const panel = this.buildPanel(row.id, null, DEFAULT_CHART_HEIGHT);
        if (!panel) return;
        this.panels.push(panel);
        this.scheduleSave();
      },
      error: (err) => {
        this.registeringBond = null;
        this.bondError =
          err?.error?.error || err?.message || 'Не удалось зарегистрировать выпуск';
      },
    });
  }

  /** Изменение настроек в полосе: таймфрейм и/или высота графиков. */
  onPanelStateChange(
    s: { timeframe_id: number | null; chart_height: number },
    uid: number
  ): void {
    const panel = this.panels.find((p) => p.uid === uid);
    if (!panel) return;
    panel.timeframe_id = s.timeframe_id;
    panel.chart_height = s.chart_height;
    this.scheduleSave();
  }

  /** Изменение объёмов по умолчанию (и прочих настроек) — сохраняем JSON. */
  onSettingsChange(): void {
    this.scheduleSave();
  }

  /** Отложенное сохранение состояния активного счёта (антидребезг).
      Снимок payload делается сразу — при смене счёта старый набор не затрётся. */
  scheduleSave(): void {
    const accountId = this.activeAccountId;
    if (accountId == null) return;
    this.pendingSaveAccount = accountId;
    this.pendingSavePayload = this.buildPayload();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      const acc = this.pendingSaveAccount;
      const payload = this.pendingSavePayload;
      this.pendingSaveAccount = null;
      this.pendingSavePayload = null;
      if (acc != null && payload != null) this.saveState(acc, payload);
    }, 700);
  }

  private buildPayload(): TerminalStatePayload {
    return {
      panels: this.panels.map((p) => ({
        security_id: p.security.id,
        timeframe_id: p.timeframe_id,
        chart_height: p.chart_height,
      })),
      settings: this.settings,
    };
  }

  private saveState(accountId: number, payload: TerminalStatePayload): void {
    this.stateSvc.saveState(accountId, payload).subscribe({
      error: () => undefined,
    });
  }

  /** Дата/время сделки терминала — как в панели сделок логик. */
  formatTradeTime(dt: string): string {
    if (!dt) return '—';
    const d = new Date(dt);
    return Number.isNaN(d.getTime()) ? String(dt) : d.toLocaleString('ru-RU');
  }

  tradeOpLabel(d: string): string {
    return String(d).toUpperCase() === 'SELL' ? 'Продажа' : 'Покупка';
  }

  tradeStatusText(tr: TerminalTradeRow): string {
    return tradeStatusLabel(tr.status);
  }

  /** Причина из заметки сделки (у отклонённых/отменённых). */
  tradeNote(tr: TerminalTradeRow): string {
    return (tr.note || '').trim() || '—';
  }
}