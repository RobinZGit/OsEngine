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
import { AccountPnl, accountPnl } from './position-math';

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
  /** #925: фонды/ETF и прочие торгуемые бумаги (instrument_market 'other'),
      кроме синтетики контанго. Нужны и в byId, и в выборе бумаг. */
  etfs: SecurityRow[] = [];
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

  /** #925: лента сигналов логик недоступна (API не отвечает). Показываем
      статичное сообщение и держим его, пока следующий опрос не пройдёт —
      чтобы «нет бумаг» не выглядело так, будто сигналов нет вовсе. */
  logicFeedDown = false;
  /** #925: не удаётся получить живые цены (T-Bank/API). Сообщение держим,
      пока цены снова не придут. */
  pricesFeedDown = false;

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
  /** #922: опрос живых цен по бумагам с открытыми позициями (раз в 30 с). */
  private lastPricesTimer?: ReturnType<typeof setInterval>;
  private lastPricesBusy = false;
  /** Идёт ручной пересчёт цен кнопкой «Отклонение» в шапке. */
  pricesRefreshing = false;
  private destroyed = false;
  /** Живые цены бумаг с позициями: security_id → цена последней сделки. */
  private livePriceBySecurity = new Map<number, number>();
  /** Время последнего успешного опроса живых цен (для подписи в шапке). */
  livePricesUpdatedAt: Date | null = null;
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
    this.destroyed = true;
    if (this.signalsTimer) clearInterval(this.signalsTimer);
    if (this.lastPricesTimer) clearInterval(this.lastPricesTimer);
    if (this.signalsToastTimer) clearTimeout(this.signalsToastTimer);
  }

  /** Периодический опрос непрочитанных сигналов логик активного счёта. */
  private startSignalsPolling(): void {
    if (this.signalsTimer) clearInterval(this.signalsTimer);
    this.pollLogicSignals();
    this.signalsTimer = setInterval(() => this.pollLogicSignals(), 15_000);
  }

  /** #922: бумаги, по которым на выбранном счёте есть открытая позиция
      (filled-покупки минус filled-продажи ≠ 0). Именно их цены нужно
      сканировать чаще — по ним считается разница и принимается решение
      о закрытии. */
  get positionSecurityIds(): number[] {
    const bySec = new Map<number, number>();
    for (const t of this.trades ?? []) {
      const id = Number(t.security_id);
      const q = Number(t.quantity);
      if (!Number.isInteger(id) || id <= 0 || t.status !== 'filled') continue;
      if (!Number.isFinite(q) || q <= 0) continue;
      bySec.set(id, (bySec.get(id) ?? 0) + (t.direction === 'BUY' ? q : -q));
    }
    return [...bySec.entries()].filter(([, qty]) => qty !== 0).map(([id]) => id);
  }

  /** #925: остаток на счёте — свободные средства, не вложенные в позиции:
      реальный счёт — свободные деньги T-Bank (`cash_amount`, fallback `balance`),
      демо-счёт — `terminal_cash` (торгует в маржу со старта 0, поэтому после
      покупок число отрицательное — минус суммы покупок). */
  get accountFreeCash(): number {
    const acc = this.selectedAccount;
    if (!acc) return 0;
    if (acc.account_type !== 'real') {
      const c = Number(acc.terminal_cash);
      return Number.isFinite(c) ? c : 0;
    }
    const free = Number(acc.cash_amount);
    if (acc.cash_amount != null && Number.isFinite(free)) return free;
    const total = Number(acc.balance);
    return Number.isFinite(total) ? total : 0;
  }

  /** #925: суммарный П/У по счёту — реализованный (уже закрытые части
      позиций, с комиссиями) ПЛЮС переоценка всех бумаг с открытой позицией
      по живым ценам (плюс/минус, рубли). Считается ОДИН раз здесь и
      передаётся в каждую панель, поэтому цифра везде одинаковая и не
      зависит от того, какие панели открыты. Закрытие позиции не «съедает»
      её результат: убыток остаётся в итоге отрицательным. */
  get accountPnl(): AccountPnl {
    return accountPnl(this.trades, this.livePriceBySecurity);
  }

  /** #925: П/У для показа (итог: реализованный + переоценка открытого).
      null («—»), когда позиции есть, но живые цены ещё не пришли (иначе
      показывали бы «0,00 ₽» — как будто всё в ноль); при отсутствии
      позиций честный итог. */
  get accountPnlRub(): number | null {
    const r = this.accountPnl;
    if (r.priced > 0) return r.total_rub;
    return r.securities === 0 ? r.total_rub : null;
  }

  /** Живая цена бумаги для полосы (null — терминал её не получил). */
  livePriceFor(securityId: number): number | null {
    const v = this.livePriceBySecurity.get(Number(securityId));
    return typeof v === 'number' && v > 0 ? v : null;
  }

  /** Цикл живых цен: раз в 30 с и только по бумагам с открытыми позициями.
      Без позиций запросов нет вовсе — пустой терминал не дёргает брокера. */
  private startLastPricesPolling(): void {
    if (this.lastPricesTimer) clearInterval(this.lastPricesTimer);
    this.pollLastPrices();
    this.lastPricesTimer = setInterval(() => this.pollLastPrices(), 30_000);
  }

  /** Кнопка «Отклонение» в шапке: принудительно тянем живые цены по всем
      бумагам с открытой позицией (вне 30-секундного цикла) и пересчитываем
      отклонение. Общая сумма по счёту = сумма отклонений по всем этим бумагам. */
  refreshAllPrices(): void {
    if (this.destroyed || this.lastPricesBusy) return;
    this.pricesRefreshing = true;
    this.pollLastPrices(true, () => {
      this.pricesRefreshing = false;
    });
  }

  private pollLastPrices(force = false, done?: () => void): void {
    const finish = (): void => {
      if (done) done();
    };
    if (this.destroyed || this.lastPricesBusy) {
      finish();
      return;
    }
    const ids = this.positionSecurityIds;
    if (ids.length === 0) {
      // Позиций нет — живые цены больше не нужны, карту чистим.
      if (this.livePriceBySecurity.size > 0) {
        this.livePriceBySecurity = new Map();
        this.livePricesUpdatedAt = null;
      }
      this.pricesFeedDown = false;
      finish();
      return;
    }
    this.lastPricesBusy = true;
    this.securitiesSvc.getLastPrices(ids, force).subscribe({
      next: (r) => {
        this.lastPricesBusy = false;
        finish();
        if (this.destroyed) return;
        // Ответ сервиса получен — лента цен доступна, снимаем предупреждение.
        this.pricesFeedDown = false;
        const quotes = r?.prices ?? [];
        if (r?.throttled || quotes.length === 0) return;
        const next = new Map<number, number>();
        for (const q of quotes) {
          const id = Number(q?.security_id);
          const p = Number(q?.price);
          if (Number.isInteger(id) && id > 0 && Number.isFinite(p) && p > 0) {
            next.set(id, p);
          }
        }
        if (next.size === 0) return;
        this.livePriceBySecurity = next;
        this.livePricesUpdatedAt = new Date();
      },
      error: () => {
        this.lastPricesBusy = false;
        // #925: сервис цен молчит — держим статичное предупреждение, пока он
        // снова не ответит (сообщение снимается в ветке next выше).
        if (!this.destroyed) this.pricesFeedDown = true;
        finish();
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
      this.etfs = [];
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
        const others: SecurityRow[] = [];
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
            } else {
              // #925: прочие торгуемые бумаги (ETF/фонды, instrument_market
              // 'other'), кроме синтетики контанго. Раньше они молча выпадали
              // из byId, и сигналы логик по ним не попадали в терминал.
              others.push(s);
            }
          }
        }
        futures.sort((a, b) => a.prefix.localeCompare(b.prefix, 'ru'));
        stocks.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
        bonds.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
        others.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
        this.futures = futures;
        this.stocks = stocks;
        this.bonds = bonds;
        this.etfs = others;
        this.contangoByPrefix = contango;
        // byId — для разрешения ЛЮБОЙ бумаги по id (сигналы, сделки, полосы),
        // поэтому включает и ETF/прочие, а не только акции/фьючерсы/облигации.
        this.byId = new Map(
          [...futures, ...stocks, ...bonds, ...others].map((s) => [s.id, s])
        );
        // Полосы перечитываем из сохранённого состояния только если они ещё
        // пустые (на момент первого запроса справочник бумаг мог быть не готов).
        // Иначе запоздавший ответ затрёт только что добавленную пользователем бумагу.
        if (this.panels.length === 0) this.loadSavedState();
        // Сигналы логик периодически опрашиваем только когда byId уже заполнен:
        // иначе первая партия сигналов молча отбрасывается (`byId.has` — false)
        // и «по сигналу появляется не одна бумага, а меньше положенного».
        this.startSignalsPolling();
        // #922: живые цены по бумагам с позициями (цикл 30 с).
        this.startLastPricesPolling();
      },
      error: () => {
        this.futures = [];
        this.stocks = [];
        this.bonds = [];
        this.etfs = [];
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
        // #923: после обновления сделок сразу чистим полосы без позиции,
        // у которых истёк срок таймфрейма последнего сигнала.
        this.removeFlatPanelsAfterSignalTimeout();
        // #922: сменился счёт/позиции — сразу освежаем живые цены по ним.
        this.pollLastPrices();
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
      next: (r) => {
        // #925: связь есть — снимаем предупреждение о недоступной ленте.
        this.logicFeedDown = false;
        this.applyLogicSignals(r?.signals ?? []);
        // #923: каждый опрос проверяем полосы без позиции — убрать те,
        // у которых с последнего сигнала прошло больше, чем её таймфрейм.
        this.removeFlatPanelsAfterSignalTimeout();
      },
      error: () => {
        // #925: API сигналов не ответил — держим статичное предупреждение,
        // пока следующий опрос не пройдёт успешно.
        if (!this.destroyed) this.logicFeedDown = true;
      },
    });
  }

  /** Применить сигналы к панелям: новая бумага — полоса в конец, уже
      показанная — обновить сигнал и индикаторы. В конце отметить
      прочитанными и показать уведомление сверху страницы. */
  private applyLogicSignals(signals: TerminalLogicSignal[]): void {
    if (!signals.length) return;
    // Все полученные сигналы отмечаем прочитанными, даже если полосу по ним
    // не показали. Иначе непрочитанный хвост (нет бумаги в справочнике или
    // сигнал уже просрочен) застревает в голове очереди и свежие сигналы
    // никогда не доходят до терминала.
    const processed: number[] = [];
    const applied: number[] = [];
    const newPanels: number[] = [];
    for (const s of signals) {
      processed.push(s.id);
      if (!this.byId.has(s.security_id)) continue;
      const sideLabel = (s.side_label || 'покупка').toLowerCase();
      const logicName = s.logic_name || `логика #${s.logic_id}`;
      const event: TerminalLogicSignalEvent = {
        logic_id: s.logic_id,
        signal_id: s.id,
        logic_name: logicName,
        bar_dt: s.bar_dt ?? null,
        created_at: s.created_at ?? null,
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
      // #923/#925: если сигнал уже старше своего окна удержания, полосу по нему
      // терминал тут же удалил бы. Не создаём её (иначе «мигание») и не трогаем
      // существующую — просто считаем сигнал обработанным, чтобы он не застревал
      // в очереди непрочитанных и не блокировал свежие бумаги.
      if (this.signalPastKeepWindow(event)) continue;
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
      // #946: галочка «Исполнять сделки сразу» включает и «закроется тоже по
      // сигналу логики» на всех полосах — иначе вход исполнялся бы сразу,
      // а выход по сигналу пришлось бы закрывать вручную.
      if (this.executeSignalsNow) target.auto_close_on_logic_signal = true;
      // Чекбокс «закроется тоже по сигналу» у полосы: у бумаги есть позиция —
      // закрываем её (сигнал/закрытие/стоп-лосс любой логики с сигналами).
      // По умолчанию выключен (#937), включается вручную на полосе или галочкой
      // «Исполнять сделки сразу».
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
    if (applied.length) this.scheduleSave();
    // #948: новая бумага по сигналу — наверх группы «позиции ещё нет»
    // (между бумагами с позицией и уже закрытыми), а не в самый конец.
    if (newPanels.length) this.applyPanelOrder();
    this.markSignalsRead(processed);
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

  /** Комиссия демо-счёта, % от суммы сделки (настройка терминала, по умолчанию 0.03).
      У реального счёта комиссия берётся из ответа T-Bank, поле не используется. */
  get commissionPct(): number {
    const v = Number(this.settings['commission_pct']);
    return Number.isFinite(v) && v >= 0 ? Math.min(v, 100) : 0.03;
  }

  /** Сохранить «Комиссия, %» в настройках терминала выбранного счёта. */
  onCommissionPctChange(v: number): void {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return;
    const pct = Math.min(n, 100);
    if (this.commissionPct === pct) return;
    this.settings = { ...this.settings, commission_pct: pct };
    this.scheduleSave();
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
        // #946: сохранённая галочка «Исполнять сделки сразу» возвращает и
        // включённое «закроется тоже по сигналу логики» на всех полосах.
        if (this.executeSignalsNow) {
          for (const p of this.panels) p.auto_close_on_logic_signal = true;
        }
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
    autoCloseOnLogicSignal = false
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

  /** Порядок полос бумаг (#948): 1) с открытой позицией — всегда сверху,
      2) позиции ещё нет (свежая бумага по сигналу, ещё не торговали) —
      посередине, новые сверху, 3) позиция закрыта (были сделки, остаток ноль)
      — всегда внизу. Внутри групп 1 и 3 порядок не трогаем (стабильная
      разбивка), в группе 2 новые бумаги идут сверху: `uid` растёт с каждой
      созданной полосой. Отсюда: вход по сделке поднимает полосу в группу 1,
      полная продажа опускает её в группу 3, сигнал по новой бумаге ставит
      её на верх группы 2. */
  private applyPanelOrder(): void {
    if (!this.panels.length) return;
    const remainder = new Map<number, number>();
    const traded = new Set<number>();
    for (const t of this.trades) {
      if (t.status !== 'filled') continue;
      const qty = Number(t.quantity);
      if (!(Number.isFinite(qty) && qty > 0)) continue;
      traded.add(t.security_id);
      remainder.set(
        t.security_id,
        (remainder.get(t.security_id) ?? 0) + (t.direction === 'BUY' ? qty : -qty)
      );
    }
    const withPosition: PanelModel[] = [];
    const noPositionYet: PanelModel[] = [];
    const positionClosed: PanelModel[] = [];
    for (const p of this.panels) {
      if ((remainder.get(p.security.id) ?? 0) !== 0) withPosition.push(p);
      else if (traded.has(p.security.id)) positionClosed.push(p);
      else noPositionYet.push(p);
    }
    // Новая бумага (сигнал/добавление вручную) — наверх группы «позиции нет».
    noPositionYet.sort((a, b) => b.uid - a.uid);
    this.panels = [...withPosition, ...noPositionYet, ...positionClosed];
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
    // #948: бумага с позицией не должна перепрыгивать выше полос с позицией.
    this.applyPanelOrder();
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

  /** Длительность таймфрейма сигнала в секундах: по id (TimeframeRow.sec),
      иначе по коду (M1, M15, H1, D1, W1, MN). Неизвестный — null. */
  private signalFrameSeconds(ev: TerminalLogicSignalEvent): number | null {
    if (ev.timeframe_id != null) {
      const tf = this.timeframes.find((t) => t.id === ev.timeframe_id);
      if (tf && Number.isFinite(tf.sec) && tf.sec > 0) return tf.sec;
    }
    const code = String(ev.timeframe ?? '').toUpperCase();
    const CODE_SEC_MS: Record<string, number> = {
      M1: 60,
      M3: 180,
      M5: 300,
      M10: 600,
      M15: 900,
      M30: 1800,
      H1: 3600,
      H2: 7200,
      H4: 14400,
      D1: 86400,
      W1: 604800,
      MN: 2592000,
    };
    return CODE_SEC_MS[code] ?? null;
  }

  /** Момент появления/актуальности сигнала: created_at (время записи цикла),
      иначе bar_dt + таймфрейм (≈ время закрытия бара сигнала). NaN — неизвестен. */
  private signalFireMs(ev: TerminalLogicSignalEvent): number {
    const created = ev.created_at ? new Date(ev.created_at).getTime() : Number.NaN;
    if (Number.isFinite(created)) return created;
    const barMs = ev.bar_dt ? new Date(ev.bar_dt).getTime() : Number.NaN;
    const frameSec = this.signalFrameSeconds(ev);
    if (Number.isFinite(barMs) && frameSec != null && frameSec > 0) {
      return barMs + frameSec * 1000;
    }
    return Number.NaN;
  }

  /** #923/#925: сигнал уже старше окна удержания полосы (для M1/M5/M10 минимум
      5 минут, для M15+ — сам таймфрейм). По такому сигналу полосу не создаём и
      не трогаем: терминал удалил бы её следующим же опросом. Таймфрейм или время
      сигнала неизвестны — считаем сигнал свежим (не выбрасываем вслепую). */
  private signalPastKeepWindow(ev: TerminalLogicSignalEvent): boolean {
    const frameSec = this.signalFrameSeconds(ev);
    if (frameSec == null || frameSec <= 0) return false;
    const fireMs = this.signalFireMs(ev);
    if (!Number.isFinite(fireMs)) return false;
    return Date.now() - fireMs >= Math.max(frameSec * 1000, 5 * 60 * 1000);
  }

  /** #923: полоса без позиции (нулевой остаток) живёт в списке не дольше
      таймфрейма последнего сигнала по этой бумаге, но НЕ меньше 5 минут:
      M1/M5/M10 — минимум 5 минут (мелкие сигналы должны быть видны, а не
      мелькнуть и исчезнуть), M15 и выше — сам таймфрейм (он и так ≥ 5 мин).
      «Возраст» сигнала считаем от created_at — времени, когда торговый цикл
      записал сигнал в logic_terminal_signals. bar_dt для замеров НЕ используем:
      это время ОТКРЫТИЯ последней закрытой свечи, которое к моменту записи
      сигнала уже на ~1 таймфрейм в прошлом — свежий сигнал M1/M15 удалялся бы
      мгновенно, ещё до показа полосы. Для старых сохранённых полос без
      created_at сроком служит bar_dt + таймфрейм (≈ закрытие свечи ≈ время
      записи). Полосы, добавленные без сигнала (выбором вручную), не трогаем;
      с открытой позицией — тоже. */
  private removeFlatPanelsAfterSignalTimeout(): void {
    if (!this.panels.length) return;
    const stale: number[] = [];
    for (const p of this.panels) {
      const ev = p.signal_event;
      if (!ev) continue; // полоса добавлена без сигнала — не трогаем
      if (this.securityRemainderQty(p.security.id) !== 0) continue;
      if (!this.signalPastKeepWindow(ev)) continue;
      stale.push(p.uid);
    }
    if (!stale.length) return;
    for (const uid of stale) this.removePanel(uid);
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
        // #948: та же раскладка, что и для акций/фьючерсов (#addSecurityByPicker).
        this.applyPanelOrder();
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

  /** Суммарный итог закрытия всех открытых позиций (с учётом комиссий входа
      и выхода) — сумма по каждой бумаге из сводок полос. */
  get totalClosingNetDiff(): number {
    let sum = 0;
    for (const s of this.positionSummaryByPanel.values()) {
      const v = Number(s.closingNetDiff);
      if (Number.isFinite(v)) sum += v;
    }
    return Math.round(sum * 100) / 100;
  }

  /** Закрытие всех позиций сейчас уводит в минус — кнопка красная. */
  get closeAllIsLoss(): boolean {
    return this.totalClosingNetDiff < 0;
  }

  /** Закрытие всех позиций сейчас в плюсе — кнопка тёмно-зелёная. */
  get closeAllIsProfit(): boolean {
    return this.totalClosingNetDiff > 0;
  }

  /** Деньги по-русски с двумя знаками (подпись кнопки закрытия всех позиций). */
  private formatMoney(v: number): string {
    return v.toLocaleString('ru-RU', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  /** Подпись кнопки «Закрыть все позиции»: суммарный итог закрытия —
      «Закрыть все позиции (приб. X ₽)» / «(уб. X ₽)». Ноль — без скобок. */
  get closeAllButtonLabel(): string {
    const net = this.totalClosingNetDiff;
    if (net === 0) return 'Закрыть все позиции';
    const sign = net > 0 ? 'приб. ' : 'уб. ';
    return `Закрыть все позиции (${sign}${this.formatMoney(Math.abs(net))} ₽)`;
  }

  /** Подсказка кнопки «Закрыть все позиции». */
  get closeAllButtonTitle(): string {
    const base = 'Закрыть все открытые позиции (по каждой бумаге, маркет)';
    const net = this.totalClosingNetDiff;
    return net === 0
      ? base
      : `${base}. Итог закрытия всех позиций по текущим ценам: ${
          net > 0 ? 'прибыль' : 'убыток'
        } ${this.formatMoney(Math.abs(net))} ₽ (с учётом комиссий входа и выхода)`;
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

  /** #946: галочка «Исполнять сделки сразу» на планке выбора счёта. По
      умолчанию выключена; включённая — сигнал логики исполняется сразу и на
      всех полосах включается «закроется тоже по сигналу логики». */
  get executeSignalsNow(): boolean {
    return this.settings['execute_signals_now'] === true;
  }

  onExecuteSignalsNowChange(checked: boolean): void {
    if (this.executeSignalsNow === checked) return;
    this.settings = { ...this.settings, execute_signals_now: checked };
    if (checked) {
      for (const p of this.panels) p.auto_close_on_logic_signal = true;
    }
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