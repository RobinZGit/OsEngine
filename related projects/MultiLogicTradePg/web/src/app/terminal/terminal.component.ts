import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import {
  PanelPositionSummary,
  TerminalPanelComponent,
} from './terminal-panel.component';
import { ReferencesService } from '../services/references.service';
import { SecuritiesService } from '../services/securities.service';
import {
  TerminalBondHolding,
  TerminalLogicSignal,
  TerminalLogicSignalEvent,
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
  /** Сигнал логики (бейдж в шапке + вертикальная линия на графике). */
  signal_event: TerminalLogicSignalEvent | null;
  /** Индикаторы логики, значения которых рисуем на графике полосы. */
  logic_indicator_ids: number[];
  /** Полоса свёрнута (видна только шапка). Новые добавляются свёрнутыми. */
  collapsed: boolean;
  /** Автозакрытие позиции бумаги по сигналу/закрытию логики (чекбокс на баре
      полосы, включён по умолчанию). Закрывается вся позиция бумаги, маркетом. */
  auto_close_on_logic_signal: boolean;
}

const DEFAULT_CHART_HEIGHT = 340;

@Component({
  selector: 'app-terminal',
  standalone: true,
  imports: [CommonModule, FormsModule, TerminalPanelComponent],
  templateUrl: './terminal.component.html',
  styleUrl: './terminal.component.css',
})
export class TerminalComponent implements OnInit, OnDestroy {
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

  /** Прочие настройки терминала в JSON (общий таймфрейм и т.п.). */
  settings: { [k: string]: unknown } = {};

  /** Общий таймфрейм — на форме терминала, по умолчанию для новых
      добавляемых бумаг. Каждая показанная панель использует собственный
      таймфрейм (селект в шапке панели, сохраняется в её состоянии). */
  commonTimeframeId: number | null = null;

  pickerOpen = false;
  pendingSecurityId: number | null = null;

  /** Ошибка добавления бумаги: показываем причину, почему не добавилась. */
  pickerError: string | null = null;
  /** Счётчик изменений полос пользователем — защита от затирания свежих
      полос запоздавшим ответом сохранённого состояния (см. loadSavedState). */
  private panelsStamp = 0;

  /** Идёт добавление бумаги (регистрация/рисование графика): блок выбора бледный,
      страница приглушена с надписью «идёт процесс загрузки — добавление бумаги…»;
      панели остаются кликабельными. */
  addingSecInProgress = false;
  /** Что именно сейчас добавляется — показываем надпись рядом с нужной кнопкой. */
  addingSecKind: 'stock' | 'bond' | null = null;
  /** uid новой полосы, после первых свечей которой снимается блокировка выбора. */
  private addingSecUid: number | null = null;
  private addingSecTimer?: ReturnType<typeof setTimeout>;
  private static readonly ADD_SEC_MAX_WAIT_MS = 45_000;

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

  /** Рыночная стоимость позиций по полосам (суммируем для шапки счёта). */
  private positionSummaryByPanel = new Map<number, PanelPositionSummary>();
  /** Импульс «Закрыть все позиции»: каждая полоса закрывает свою позицию. */
  closeAllPulse = 0;
  /** Адресный импульс «Закрыть по сигналу логики»: закрытие позиции конкретной бумаги. */
  closeSignalPulse: { security_id: number; pulse: number } | null = null;

  /** Счёт, к которому относятся текущие panels (для сохранения при переключении). */
  private activeAccountId: number | null = null;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private pendingSaveAccount: number | null = null;
  private pendingSavePayload: TerminalStatePayload | null = null;

  /** Опрос сигналов логик в терминал (каждые 15 с, только активный счёт). */
  private signalsTimer?: ReturnType<typeof setInterval>;
  /** Последнее уведомление о сигнале — полоса сверху страницы терминала. */
  signalsToast: string | null = null;
  private signalsToastTimer?: ReturnType<typeof setTimeout>;
  /** Собранные за один опрос сообщения о сигналах (сводятся в один тост). */
  private signalToastMessages: string[] = [];

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

  ngOnDestroy(): void {
    if (this.signalsTimer) clearInterval(this.signalsTimer);
    if (this.signalsToastTimer) clearTimeout(this.signalsToastTimer);
  }

  /** Периодический опрос непрочитанных сигналов логик активного счёта. */
  private startSignalsPolling(): void {
    if (this.signalsTimer) clearInterval(this.signalsTimer);
    this.pollLogicSignals();
    this.signalsTimer = setInterval(() => this.pollLogicSignals(), 15_000);
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
        // Полосы перечитываем из сохранённого состояния только если они ещё
        // пустые (на момент первого запроса справочник бумаг мог быть не готов).
        // Иначе запоздавший ответ затрёт только что добавленную пользователем бумагу.
        if (this.panels.length === 0) this.loadSavedState();
        // Сигналы логик периодически опрашиваем только когда byId уже заполнен:
        // иначе первая партия сигналов молча отбрасывается (`byId.has` — false)
        // и «по сигналу появляется не одна бумага, а меньше положенного».
        this.startSignalsPolling();
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
        this.applyPanelOrder();
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

  /** Считать непрочитанные сигналы логик и показать их. Сигнал не привязан
      к счёту логики — бумага добавляется в терминал, а сделки идут по счёту,
      который выбран в терминале. */
  private pollLogicSignals(): void {
    this.stateSvc.getLogicSignals().subscribe({
      next: (r) => this.applyLogicSignals(r?.signals ?? []),
      error: () => undefined,
    });
  }

  /** Применить сигналы к панелям: новая бумага — полоса в конец, уже
      показанная — обновить сигнал и индикаторы. В конце отметить
      прочитанными и показать уведомление сверху страницы. */
  private applyLogicSignals(signals: TerminalLogicSignal[]): void {
    if (!signals.length) return;
    const applied: number[] = [];
    const newPanels: number[] = [];
    for (const s of signals) {
      if (!this.byId.has(s.security_id)) continue;
      const sideLabel = (s.side_label || 'покупка').toLowerCase();
      const logicName = s.logic_name || `логика #${s.logic_id}`;
      const event: TerminalLogicSignalEvent = {
        logic_id: s.logic_id,
        logic_name: logicName,
        bar_dt: s.bar_dt ?? null,
        position_side: s.position_side ?? null,
        label: `${sideLabel} (${logicName}${s.timeframe ? ', ' + s.timeframe : ''})`,
        price: Number.isFinite(Number(s.price)) ? Number(s.price) : null,
        timeframe_id:
          Number.isInteger(s.timeframe_id) && s.timeframe_id > 0
            ? s.timeframe_id
            : null,
        timeframe: s.timeframe ?? null,
        suggested_quantity:
          Number.isFinite(Number(s.suggested_quantity)) &&
          Number(s.suggested_quantity) > 0
            ? Number(s.suggested_quantity)
            : null,
        suggested_amount:
          Number.isFinite(Number(s.suggested_amount)) &&
          Number(s.suggested_amount) > 0
            ? Number(s.suggested_amount)
            : null,
      };
      const tf = this.timeframes.some((t) => t.id === s.timeframe_id)
        ? s.timeframe_id
        : this.commonTimeframeId;
      const ids = (s.indicator_ids ?? []).filter((v) => Number.isInteger(v));
      const existing = this.panels.find((p) => p.security.id === s.security_id);
      let target: PanelModel;
      if (existing) {
        // Таймфрейм подгоняем под логику — её индикаторы рассчитаны на нём.
        existing.timeframe_id = tf;
        existing.signal_event = { ...event };
        if (ids.length) {
          existing.logic_indicator_ids = [
            ...new Set([...existing.logic_indicator_ids, ...ids]),
          ];
        }
        target = existing;
      } else {
        const panel = this.buildPanel(
          s.security_id,
          tf,
          DEFAULT_CHART_HEIGHT,
          event,
          ids
        );
        if (!panel) continue;
        this.panels = [...this.panels, panel];
        this.panelsStamp++;
        newPanels.push(panel.uid);
        target = panel;
      }
      // Чекбокс «Автозакрытие по сигналу» у полосы: у бумаги есть позиция —
      // закрываем её (сигнал/закрытие/стоп-лосс любой логики с сигналами).
      // У полос, только что созданных сигналом, автозакрытие включено по умолчанию.
      if (
        target.auto_close_on_logic_signal &&
        this.securityRemainderQty(s.security_id) !== 0
      ) {
        this.closeSignalPulse = {
          security_id: s.security_id,
          pulse: (this.closeSignalPulse?.pulse ?? 0) + 1,
        };
      }
      applied.push(s.id);
      this.signalToastMessages.push(
        `«${s.security_prefix || s.security_name}» — сигнал ${sideLabel} ` +
          `по логике «${logicName}»` +
          (s.timeframe ? `, таймфрейм ${s.timeframe}` : '')
      );
    }
    if (applied.length) {
      this.scheduleSave();
      this.markSignalsRead(applied);
    }
    this.showSignalsToastList(this.signalToastMessages);
    this.signalToastMessages = [];
    // Пачка сигналов добавила полосы: подводим к последней добавленной,
    // чтобы все новые бумаги были видны (а не только первая сверху).
    if (newPanels.length) {
      this.scrollToPanel(newPanels[newPanels.length - 1]);
    }
  }

  private scrollToPanel(uid: number): void {
    requestAnimationFrame(() => {
      const el = document.getElementById(`panel-${uid}`);
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  /** Полоса появилась/обновилась в результате сигнала — сразу показываем
      свежий таймфрейм и сигнальную линию (без ожидания 15-сек опроса). */
  private markSignalsRead(ids: number[]): void {
    this.stateSvc
      .markLogicSignalsRead(ids)
      .subscribe({ error: () => undefined });
  }

  private showSignalsToast(message: string): void {
    if (!message) return;
    this.signalsToast = message;
    if (this.signalsToastTimer) clearTimeout(this.signalsToastTimer);
    this.signalsToastTimer = setTimeout(() => {
      this.signalsToast = null;
      this.signalsToastTimer = undefined;
    }, 8000);
  }

  /** Пачка сигналов — один тост с первыми тройками и счётчиком, а не N окон. */
  private showSignalsToastList(messages: string[]): void {
    if (!messages.length) return;
    const head = messages.slice(0, 3);
    const shown = head.join('  •  ');
    const rest = messages.length - head.length;
    const body = rest > 0 ? `${shown}  •  ещё ${rest}` : shown;
    this.showSignalsToast(body);
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

  /** Восстановление сохранённых полос и настроек для текущего счёта.
      Полосы применяем только если пользователь за время ответа их не менял —
      иначе запоздавший снимок «съел» бы только что добавленную бумагу. */
  private loadSavedState(): void {
    this.activeAccountId = this.accountId;
    if (this.accountId == null) return;
    const stamp = this.panelsStamp;
    this.stateSvc.getState(this.accountId).subscribe({
      next: (r) => {
        const settings = r.payload.settings ?? {};
        const tf = this.safeTimeframeId(settings['timeframe_id']);
        // Дефолт M15 — тот же, что у панелей без таймфрейма
        // (terminal-panel.component.ts ngOnInit), чтобы общий select
        // не оставался пустым, а новые бумаги грузили цены по видимому
        // таймфрейму по умолчанию. Показанные панели сохраняют свой.
        const defTf =
          this.timeframes.find((t) => t.tf === 'M15')?.id ??
          this.timeframes[0]?.id ??
          null;
        this.commonTimeframeId = tf ?? defTf;
        this.settings = { ...settings };
        if (this.panelsStamp !== stamp) return;
        // Набор полос меняется — uid'ы новые; старые сводки стираем, чтобы
        // сумма по счёту не включала устаревшие позиции до нового emit.
        this.positionSummaryByPanel.clear();
        this.panels = (r.payload.panels ?? [])
          .map((st) =>
            this.buildPanel(
              st.security_id,
              st.timeframe_id,
              st.chart_height,
              st.signal_event ?? null,
              st.logic_indicator_ids ?? [],
              // Восстановленные полосы всегда свёрнуты: при перезаходе в
              // терминал бумаги открываются закрытыми, независимо от того,
              // как пользователь оставил их в прошлый раз.
              true,
              st.auto_close_on_logic_signal
            )
          )
          .filter((p): p is PanelModel => p != null);
        this.applyPanelOrder();
      },
      error: () => undefined,
    });
  }

  private safeQty(v: unknown, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
  }

  /** Остаток позиции бумаги на выбранном счёте (filled BUY − SELL); 0 — без позиции. */
  private securityRemainderQty(securityId: number): number {
    let qty = 0;
    for (const t of this.trades) {
      if (t.security_id !== securityId || t.status !== 'filled') continue;
      const n = Number(t.quantity);
      if (!Number.isFinite(n)) continue;
      qty += t.direction === 'BUY' ? n : -n;
    }
    return qty;
  }

  /** Таймфрейм из настроек, если он входит в доступные; иначе null. */
  private safeTimeframeId(v: unknown): number | null {
    const tf = Number(v);
    return Number.isInteger(tf) && tf > 0 && this.timeframes.some((t) => t.id === tf)
      ? tf
      : null;
  }

  /** Пересборка модели полосы из сохранённого состояния (если бумага ещё есть).
      Новые и восстановленные полосы добавляются свёрнутыми (collapsed=true):
      при перезаходе в терминал все бумаги открываются закрытыми. */
  private buildPanel(
    securityId: number,
    timeframeId?: number | null,
    chartHeight?: number | null,
    signalEvent?: TerminalLogicSignalEvent | null,
    logicIndicatorIds?: number[] | null,
    collapsed = true,
    autoCloseOnLogicSignal = true
  ): PanelModel | null {
    const sec = this.byId.get(securityId);
    if (!sec) return null;
    const tf =
      timeframeId != null &&
      this.timeframes.some((t) => t.id === timeframeId)
        ? timeframeId
        : null;
    const ids = (logicIndicatorIds ?? [])
      .filter((v) => Number.isInteger(v))
      .filter((v, i, a) => a.indexOf(v) === i);
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
      timeframe_id: tf,
      chart_height:
        chartHeight != null &&
        chartHeight >= 100 &&
        chartHeight <= 1400 &&
        Number.isFinite(chartHeight)
          ? chartHeight
          : DEFAULT_CHART_HEIGHT,
      signal_event: signalEvent ?? null,
      logic_indicator_ids: ids,
      collapsed,
      auto_close_on_logic_signal: autoCloseOnLogicSignal,
    };
  }

  /** Переупорядочивание полос по остатку позиции: бумаги с ненулевым
      остатком всегда вверху, полностью распроданные/некупленные — внизу.
      Относительный порядок внутри групп сохраняется (стабильная разбивка):
      покупка/продажа из нулевого остатка поднимает полосу под уже имеющие
      позицию, полная продажа опускает её над бумагами без позиции. */
  private applyPanelOrder(): void {
    if (!this.panels.length) return;
    const remainder = new Map<number, number>();
    for (const t of this.trades) {
      if (t.status !== 'filled') continue;
      const qty = Number(t.quantity);
      if (!(Number.isFinite(qty) && qty > 0)) continue;
      const cur = remainder.get(t.security_id) ?? 0;
      remainder.set(
        t.security_id,
        cur + (t.direction === 'BUY' ? qty : -qty)
      );
    }
    const hasPosition = (p: PanelModel): boolean =>
      (remainder.get(p.security.id) ?? 0) !== 0;
    const ordered = [
      ...this.panels.filter(hasPosition),
      ...this.panels.filter((p) => !hasPosition(p)),
    ];
    this.panels = ordered;
  }

  togglePicker(): void {
    this.pickerOpen = !this.pickerOpen;
    this.pendingSecurityId = null;
  }

  /** Кнопка «+ Добавить» у селекта бумаг: регистрирует выбранную бумагу
      даже если значение в селекте не менялось (повторный выбор той же бумаги).
      Выбранная бумага остаётся в селекте; при ошибке — сообщение и разблокировка. */
  addSecurityByPicker(): void {
    const id = this.pendingSecurityId;
    if (id == null || this.addingSecInProgress) return;
    const sec =
      this.futures.find((s) => s.id === id) ??
      this.stocks.find((s) => s.id === id);
    if (!sec) {
      this.pickerError = `Бумага id=${id} не найдена в списке зарегистрированных — обновите справочник`;
      return;
    }
    const panel = this.buildPanel(
      sec.id,
      this.commonTimeframeId,
      DEFAULT_CHART_HEIGHT
    );
    if (this.panels.some((p) => p.security.id === sec.id)) {
      this.pickerError = `«${sec.name}» (${sec.prefix}) уже добавлена на график`;
      return;
    }
    if (!panel) {
      this.pickerError = `Не удалось создать панель для «${sec.name}» (${sec.prefix}) — проверьте API`;
      return;
    }
    this.pickerError = null;
    this.panels = [panel, ...this.panels];
    this.panelsStamp++;
    // Блокируем выбор, пока новая полоса не покажет первые свечи (см. dataReady).
    this.holdAddingSec(panel.uid, 'stock');
    this.scheduleSave();
  }

  /** Простое изменение выбора — только сбрасываем сообщение об ошибке. */
  onPickerSelection(): void {
    this.pickerError = null;
    this.bondError = null;
  }

  /** Выбранная в селекте бумага уже есть среди полос — добавлять нечего. */
  get stockTargetExists(): boolean {
    return (
      this.pendingSecurityId != null &&
      this.panels.some((p) => p.security.id === this.pendingSecurityId)
    );
  }

  /** Выбранный в селекте выпуск уже добавлен на график
      (для облигаций ISIN хранится в prefix, см. register в terminal.js). */
  get bondTargetExists(): boolean {
    if (this.pendingBondSec == null) return false;
    return this.panels.some((p) => {
      const s = this.byId.get(p.security.id);
      return s?.prefix != null && s.prefix === this.pendingBondSec;
    });
  }

  removePanel(uid: number): void {
    this.panels = this.panels.filter((p) => p.uid !== uid);
    this.forgetPanelSummary(uid);
    this.panelsStamp++;
    if (this.addingSecUid === uid) this.releaseAddingSec();
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

  /** Кнопка «+ Добавить» у селекта выпусков: регистрация как security
      + открытие панели с графиком (срабатывает и на повторном выборе выпуска). */
  addBondByPicker(): void {
    const sec = this.pendingBondSec;
    if (!sec || this.addingSecInProgress) return;
    this.registeringBond = sec;
    this.bondError = null;
    this.pickerError = null;
    // Цены грузятся в фоне — блокируем выбор до появления первых свечей.
    this.holdAddingSec(null, 'bond');
    this.stateSvc.registerBond(sec).subscribe({
      next: (r) => {
        this.registeringBond = null;
        const row = r?.security;
        if (!row || row.id == null) {
          this.bondError =
            r?.price_error || 'Выпуск не зарегистрирован (нет ответа сервера)';
          this.pickerError = this.bondError;
          this.releaseAddingSec();
          return;
        }
        if (!this.bonds.some((b) => b.id === row.id)) {
          this.bonds = [...this.bonds, row].sort((a, b) =>
            a.name.localeCompare(b.name, 'ru')
          );
        }
        this.byId.set(row.id, row);
        if (this.panels.some((p) => p.security.id === row.id)) {
          this.bondError = `${row.name || sec} уже добавлен на график`;
          this.pickerError = this.bondError;
          this.releaseAddingSec();
          return;
        }
        const panel = this.buildPanel(
          row.id,
          this.commonTimeframeId,
          DEFAULT_CHART_HEIGHT
        );
        if (!panel) {
          this.bondError = `Выпуск ${sec} зарегистрирован, но панель не создалась`;
          this.pickerError = this.bondError;
          this.releaseAddingSec();
          return;
        }
        this.panels = [panel, ...this.panels];
        this.panelsStamp++;
        this.holdAddingSec(panel.uid, 'bond');
        this.scheduleSave();
      },
      error: (err) => {
        this.registeringBond = null;
        this.bondError =
          err?.error?.error || err?.message || 'Не удалось зарегистрировать выпуск';
        this.pickerError = this.bondError;
        this.releaseAddingSec();
      },
    });
  }

  /** Держать блокировку выбора, пока идёт добавление (uid — полоса, что «рисуется»). */
  private holdAddingSec(uid: number | null, kind?: 'stock' | 'bond'): void {
    this.addingSecUid = uid;
    this.addingSecKind = kind ?? this.addingSecKind;
    this.addingSecInProgress = uid != null || this.registeringBond != null;
    if (this.addingSecTimer) clearTimeout(this.addingSecTimer);
    this.addingSecTimer = undefined;
    if (!this.addingSecInProgress) return;
    this.addingSecTimer = setTimeout(
      () => this.onAddTimeout(),
      TerminalComponent.ADD_SEC_MAX_WAIT_MS
    );
  }

  /** Страховочный таймаут: панель так и не показала свечи — разблокируем
      и сообщаем, что данные не загрузились. */
  private onAddTimeout(): void {
    this.releaseAddingSec();
    this.pickerError =
      'Данные для добавленной бумаги не загрузились за ' +
      `${TerminalComponent.ADD_SEC_MAX_WAIT_MS / 1000} с — проверьте связь с API. ` +
      'Если свечи появятся позже, график подтянется вручную (стрелки внизу панели).';
  }

  private releaseAddingSec(): void {
    if (this.addingSecTimer) clearTimeout(this.addingSecTimer);
    this.addingSecTimer = undefined;
    this.addingSecUid = null;
    this.addingSecKind = null;
    this.addingSecInProgress = false;
  }

  /** Полоса показала первые свечи — выбранная бумага нарисована. */
  onPanelDataReady(uid: number): void {
    if (this.addingSecUid === uid) this.releaseAddingSec();
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

  /** Пользователь свернул/развернул полосу — запоминаем в состоянии. */
  onPanelCollapsedChange(collapsed: boolean, uid: number): void {
    const panel = this.panels.find((p) => p.uid === uid);
    if (!panel) return;
    panel.collapsed = collapsed;
    this.scheduleSave();
  }

  /** Полоса прислала сводку позиции (остаток и рыночная стоимость по текущей
      цене последней свечи). Копим по uid и обновляем сумму по счёту. */
  onPanelPositionSummary(uid: number, s: PanelPositionSummary): void {
    this.positionSummaryByPanel.set(uid, s);
  }

  /** Сумма рыночной стоимости всех открытых позиций по полосам терминала.
      Обновляется с каждой новой свечой любой полосы (панели шлют сводки). */
  get totalPositionMarketValue(): number {
    let sum = 0;
    for (const s of this.positionSummaryByPanel.values()) sum += s.marketValue;
    return Math.round(sum * 100) / 100;
  }

  /** Есть ли хотя бы одна открытая позиция (остаток != 0) среди полос —
      управляет кнопкой «Закрыть все позиции» (disabled при пустом счёте). */
  get anyOpenPosition(): boolean {
    for (const s of this.positionSummaryByPanel.values()) {
      if (s.qty !== 0) return true;
    }
    // У полос, что ещё не прислали сводку (график/сделки грузятся), остаток
    // неизвестен — считаем потенциальной позицией: кнопку не разблокируем.
    if (this.positionSummaryByPanel.size !== this.panels.length) return true;
    return false;
  }

  /** Кнопка «Закрыть все позиции»: посылаем импульс — каждая полоса с
      открытой позицией закрывает её (продажа/выкуп остатка, маркет). */
  closeAllPositions(): void {
    if (!this.anyOpenPosition) return;
    this.closeAllPulse++;
  }

  /** Полоса убрана — вычищаем её сводку из суммы по счёту. */
  private forgetPanelSummary(uid: number): void {
    this.positionSummaryByPanel.delete(uid);
  }

  /** Изменение объёмов по умолчанию (и прочих настроек) — сохраняем JSON. */
  onSettingsChange(): void {
    this.scheduleSave();
  }

  /** Смена общего таймфрейма на форме терминала: он становится значением
      по умолчанию для новых добавляемых бумаг. Показанные панели не
      перетираются — у каждой бумаги свой таймфрейм (селект в шапке). */
  onCommonTimeframeChange(): void {
    this.settings = { ...this.settings, timeframe_id: this.commonTimeframeId };
    this.scheduleSave();
  }

  /** Чекбокс «Автозакрытие по сигналу» у полосы — запоминаем в состоянии полосы. */
  onPanelAutoCloseChange(autoClose: boolean, uid: number): void {
    const panel = this.panels.find((p) => p.uid === uid);
    if (!panel) return;
    panel.auto_close_on_logic_signal = autoClose;
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
        signal_event: p.signal_event ?? undefined,
        logic_indicator_ids: p.logic_indicator_ids.length
          ? p.logic_indicator_ids
          : undefined,
        collapsed: p.collapsed,
        auto_close_on_logic_signal: p.auto_close_on_logic_signal,
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