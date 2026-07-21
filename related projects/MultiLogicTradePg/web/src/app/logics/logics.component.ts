import { Component, ElementRef, OnDestroy, OnInit, ViewChild, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject, switchMap, takeUntil, timer, forkJoin, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { LogicsService } from '../services/logics.service';
import { ReferencesService } from '../services/references.service';
import { SecuritiesService } from '../services/securities.service';
import { SettingsService } from '../services/settings.service';
import { TechLogService } from '../services/tech-log.service';
import { BacktestUiStateService } from '../services/backtest-ui-state.service';
import { LogicIndicatorSignalRow, LogicRow, LogicSecurityRow, LogicStopRow, LogicParamsResponse } from '../models/logic.model';
import { IndicatorRow } from '../models/lookup.model';
import { SecurityRow } from '../models/market.model';
import {
  AppConfigService,
  logicsLoadErrorMessage,
} from '../services/app-config.service';
import {
  LogicEditorComponent,
  LogicEditorMode,
} from '../logic-editor/logic-editor.component';
import { TbankTokenDialogComponent } from '../tbank-token-dialog/tbank-token-dialog.component';
import {
  buildLogicSignalFormula,
  parseSignalFormula,
  positionEventLabel,
  PositionEvent,
  positionSideLabel,
  PositionSide,
  signalKindLabel,
  SignalKind,
} from '../shared/signal-formula';
import {
  LOGIC_STOP_UNITS,
  LogicStopRuleKind,
  LogicStopScopeType,
  LogicStopValueUnit,
  ruleKindLabel,
  scopeTypeLabel,
  stopScopesForRuleKind,
  valueUnitLabel,
} from '../shared/logic-stop';
import {
  costMethodLabel,
  tradeOperationHint,
  tradeOperationLabel,
  tradeStatusLabel,
  yesNoLabel,
  LogicTradeLotRow,
  LogicTradeRow,
} from '../shared/logic-trade';
import { formatDateRangeLabel } from '../shared/date-format';
import {
  BacktestRunStatus,
  LogicPositionsPanelComponent,
} from './logic-positions-panel.component';
import { LogicCombatSignalDetailComponent } from './logic-combat-signal-detail.component';
import type { ProcessStatusItem, SignalRatingPrecalcStatus } from '../services/logics.service';

const POLL_INTERVAL_MS = 2000;

type SignalPickerState = {
  logicId: number;
  positionEvent: PositionEvent;
  positionSide: PositionSide;
  signalKind: SignalKind;
} | null;

type StopFormState = {
  logicId: number;
  ruleKind: LogicStopRuleKind;
} | null;

type StopFormDraft = {
  scope_type: LogicStopScopeType;
  value: string;
  value_unit: LogicStopValueUnit;
};

@Component({
  selector: 'app-logics',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    LogicEditorComponent,
    TbankTokenDialogComponent,
    LogicPositionsPanelComponent,
    LogicCombatSignalDetailComponent,
  ],
  templateUrl: './logics.component.html',
  styleUrl: './logics.component.css',
})
export class LogicsComponent implements OnInit, OnDestroy {
  @ViewChild('logicImportFile') logicImportFile?: ElementRef<HTMLInputElement>;

  logics: LogicRow[] = [];
  loading = true;
  error: string | null = null;
  pollIntervalMs = POLL_INTERVAL_MS;

  /** Checkbox selection for export (right column). */
  selectedExportIds = new Set<number>();
  exportImportBusy = false;
  /** Busy keys: `${logicId}:test` | `${logicId}:live` for trades JSON export. */
  private tradesExportBusy = new Set<string>();

  editorOpen = false;
  editorMode: LogicEditorMode = 'add';
  editorLogic: LogicRow | null = null;

  expandedLogics = new Set<number>();
  expandedParamsBlocks = new Set<number>();
  expandedSignalsBlocks = new Set<number>();
  /** key = `${logicId}:${signalId}` — раскрытие сигнала → бумаги → график боя */
  expandedCombatSignals = new Set<string>();
  ratingPrecalcByLogic = new Map<number, SignalRatingPrecalcStatus>();
  combatRatingReloadToken = new Map<number, number>();
  private ratingPrecalcPollIds = new Set<number>();
  expandedStopsBlocks = new Set<number>();
  expandedPeriodsBlocks = new Set<number>();
  expandedSecuritiesBlocks = new Set<number>();
  expandedTradesBlocks = new Set<number>();
  expandedTestTradesBlocks = new Set<number>();
  expandedOpenPositionsBlocks = new Set<number>();
  expandedClosedPositionsBlocks = new Set<number>();
  expandedTradeRows = new Set<number>();
  logicSignals = new Map<number, LogicIndicatorSignalRow[]>();
  logicStops = new Map<number, LogicStopRow[]>();
  logicSecurities = new Map<number, LogicSecurityRow[]>();
  logicTrades = new Map<number, LogicTradeRow[]>();
  logicTradesTest = new Map<number, LogicTradeRow[]>();
  /** Стабильные ссылки для шаблона (без filter на каждый CD). */
  private testTradesViewByLogic = new Map<number, LogicTradeRow[]>();
  private signalIndicatorIdsByLogic = new Map<number, number[]>();
  /** Shared with BacktestUiStateService — survives leaving /operations. */
  backtestRuns: Map<number, BacktestRunStatus>;
  private backtestPollIds: Set<number>;
  /** Пока открыт диалог периода — не дёргать тяжёлый poll (дата на input лагает). */
  uiInteractionPause = false;
  private pollTick = 0;
  processRows: ProcessStatusItem[] = [];
  processError: string | null = null;
  /** Онлайн-сводка тестового финреза по логикам (не колонка в БД). */
  testPnlByLogic: Map<
    number,
    {
      financial_result: number;
      commission: number;
      trade_count: number;
      date_from?: string | null;
      date_to?: string | null;
    }
  >;
  /** Онлайн-сводка боевого финреза (is_test=0). */
  combatPnlByLogic = new Map<
    number,
    { financial_result: number; commission: number; trade_count: number }
  >();
  logicTradeLots = new Map<number, LogicTradeLotRow[]>();
  signalsLoading = new Set<number>();
  stopsLoading = new Set<number>();
  securitiesLoading = new Set<number>();
  periodsLoading = new Set<number>();
  periodsApplying = new Set<number>();
  nonTradingByLogic = new Map<
    number,
    {
      use_non_trading_periods: boolean;
      intervals: {
        id: number;
        day_of_week: number;
        time_from: string;
        time_to: string;
        note?: string | null;
      }[];
    }
  >();
  periodsSaving = new Set<number>();
  readonly weekDayLabels = [
    { dow: 1, label: 'Пн' },
    { dow: 2, label: 'Вт' },
    { dow: 3, label: 'Ср' },
    { dow: 4, label: 'Чт' },
    { dow: 5, label: 'Пт' },
    { dow: 6, label: 'Сб' },
    { dow: 7, label: 'Вс' },
  ];
  tradesLoading = new Set<number>();
  private testTradesInFlight = new Set<number>();
  private liveTradesInFlight = new Set<number>();
  tradeLotsLoading = new Set<number>();
  closeAllLoading = new Set<number>();

  readonly costMethodOptions: Array<{ value: 'FIFO' | 'AVERAGE'; label: string }> = [
    { value: 'FIFO', label: 'FIFO (первая покупка — первая продажа)' },
    { value: 'AVERAGE', label: 'Средняя цена остатка' },
  ];

  indicatorsCatalog: IndicatorRow[] = [];
  indicatorsLoaded = false;

  signalPicker: SignalPickerState = null;
  pickerSelectedIds = new Set<number>();

  securityPickerLogicId: number | null = null;
  pickerSelectedSecurityIds = new Set<number>();
  stocksCatalog: SecurityRow[] = [];
  futuresCatalog: SecurityRow[] = [];
  securitiesCatalogLoaded = false;
  securitiesCatalogLoading = false;
  moexExchangeId: number | null = null;

  stopForm: StopFormState = null;
  stopFormDraft: StopFormDraft = {
    scope_type: 'security_resume',
    value: '',
    value_unit: 'percent',
  };

  readonly stopUnits = LOGIC_STOP_UNITS;
  stopScopesFor = stopScopesForRuleKind;

  tbankTokenDialogOpen = false;
  tbankTokenDialogContext: 'prices' | 'logic' | 'trades' = 'logic';
  tbankTokenDialogReason: 'missing' | 'invalid' = 'missing';
  /** Постоянное предупреждение у блока «Сделки», пока токен невалиден и логика включена. */
  tbankTokenAlert: { reason: 'missing' | 'invalid'; message: string } | null = null;
  private pendingEnableLogic: LogicRow | null = null;
  private pendingBacktest: { logicId: number; period: { date_from: string; date_to: string } } | null =
    null;
  private lastTbankTokenCheckAt = 0;
  private readonly tbankTokenCheckMs = 30000;

  private readonly destroy$ = new Subject<void>();
  private savingIds = new Set<number>();
  private formulaDrafts = new Map<number, string>();
  private savingFormulaIds = new Set<number>();
  private savingStopIds = new Set<number>();
  private savingParamsIds = new Set<number>();
  private copyingLogicIds = new Set<number>();
  paramsDrafts = new Map<
    number,
    {
      name: string;
      timeframe: string;
      position_size_pct: string;
      max_open_positions: string;
      initial_balance: string;
      commission_pct: string;
      cost_method: 'FIFO' | 'AVERAGE';
      stop_loss_timeframe: string;
      base_annual_rate_pct: string;
      rating_lookback_days: string;
      inversion: boolean;
      warmup_pretest: boolean;
      cash_fund_code: string;
      cash_fund_threshold: string;
      use_non_trading_periods: boolean;
      close_positions_eod: boolean;
      reset_balance: boolean;
    }
  >();
  paramsSaveErrors = new Map<number, string>();
  paramsLoading = new Set<number>();
  timeframesCatalog: { id: number; tf: string; full_name: string }[] = [];
  readonly cashFundOptions: { value: string; label: string }[] = [
    { value: '', label: 'Не покупать' },
    { value: 'TMON', label: 'TMON — Т-Капитал денежный рынок' },
    { value: 'LQDT', label: 'LQDT — ВИМ Ликвидность' },
    { value: 'SBMM', label: 'SBMM — Сбер Первый' },
  ];
  /** Пользователь менял черновик — poll не перезаписывает поля ввода. */
  private paramsDirtyIds = new Set<number>();

  constructor(
    private readonly logicsService: LogicsService,
    private readonly refs: ReferencesService,
    private readonly securitiesService: SecuritiesService,
    private readonly settings: SettingsService,
    private readonly techLog: TechLogService,
    private readonly appConfig: AppConfigService,
    private readonly backtestUi: BacktestUiStateService,
    private readonly cdr: ChangeDetectorRef
  ) {
    this.backtestRuns = this.backtestUi.runs;
    this.backtestPollIds = this.backtestUi.pollIds;
    this.testPnlByLogic = this.backtestUi.testPnlByLogic;
  }

  ngOnInit(): void {
    this.backtestUi.attach();
    for (const logicId of this.backtestUi.expandTestBlocks) {
      this.expandedTestTradesBlocks.add(logicId);
      this.expandedLogics.add(logicId);
    }
    this.backtestUi.changes$.pipe(takeUntil(this.destroy$)).subscribe(() => {
      // Do not force-reopen «Тестирование» on every poll — only refresh UI.
      for (const logicId of [...this.backtestPollIds]) {
        if (!this.isBacktestRunning(logicId)) {
          this.loadTestTradesForLogic(logicId, true);
        }
        this.rebuildTestTradesView(logicId);
      }
      this.refreshTestPnlSummary();
      this.cdr.markForCheck();
    });
    this.loadIndicatorsCatalog();
    this.loadMoexExchangeId();
    this.securitiesService.getTimeframes().subscribe({
      next: (rows) => {
        this.timeframesCatalog = rows.filter((r) => r.is_active !== false);
      },
    });
    timer(0, POLL_INTERVAL_MS)
      .pipe(
        takeUntil(this.destroy$),
        switchMap(() => this.logicsService.getLogics())
      )
      .subscribe({
        next: (rows) => {
          // Диалог «период теста»: не гонять CD/trades — иначе date input «дубовый».
          if (this.uiInteractionPause) {
            for (const logicId of this.backtestPollIds) {
              this.refreshBacktestStatus(logicId);
            }
            return;
          }
          this.logics = rows.map((row) => {
            if (this.savingIds.has(row.id)) {
              const local = this.logics.find((x) => x.id === row.id);
              return local ? { ...row, is_enabled: local.is_enabled } : row;
            }
            if (this.savingParamsIds.has(row.id) || this.paramsDirtyIds.has(row.id)) {
              const local = this.logics.find((x) => x.id === row.id);
              return local
                ? {
                    ...row,
                    position_size_pct: local.position_size_pct,
                    max_open_positions: local.max_open_positions,
                    initial_balance: local.initial_balance,
                    base_annual_rate_pct: local.base_annual_rate_pct,
                    // current_balance — только для отображения, берём с сервера
                  }
                : row;
            }
            return row;
          });
          this.loading = false;
          this.error = null;
          // Re-sync yellow/progress from DB (covers remount / F5 / lost local map).
          if (this.pollTick % 5 === 0) {
            this.backtestUi.recoverActive();
          }
          // Сделки — read-only, обновляем; редактируемые блоки (параметры, формулы) — нет
          this.refreshAllTradesSummaries();
          this.refreshPnlSummaries();
          this.refreshProcesses();
          this.maybeCheckTbankTokenForTrades();
          this.cdr.markForCheck();
        },
        error: (err) => {
          if (this.loading || this.logics.length === 0) {
            this.error = logicsLoadErrorMessage(this.appConfig.apiUrl, err);
          }
          this.loading = false;
        },
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  signalKindLabel = signalKindLabel;
  positionSideLabel = positionSideLabel;
  positionEventLabel = positionEventLabel;
  ruleKindLabel = ruleKindLabel;
  scopeTypeLabel = scopeTypeLabel;
  valueUnitLabel = valueUnitLabel;
  tradeStatusLabel = tradeStatusLabel;
  yesNoLabel = yesNoLabel;

  isLogicExpanded(id: number): boolean {
    return this.expandedLogics.has(id);
  }

  isParamsBlockExpanded(id: number): boolean {
    return this.expandedParamsBlocks.has(id);
  }

  isSignalsBlockExpanded(id: number): boolean {
    return this.expandedSignalsBlocks.has(id);
  }

  isStopsBlockExpanded(id: number): boolean {
    return this.expandedStopsBlocks.has(id);
  }

  isSecuritiesBlockExpanded(id: number): boolean {
    return this.expandedSecuritiesBlocks.has(id);
  }

  isPeriodsBlockExpanded(id: number): boolean {
    return this.expandedPeriodsBlocks.has(id);
  }

  isTradesBlockExpanded(id: number): boolean {
    return this.expandedTradesBlocks.has(id);
  }

  activeProcesses(): ProcessStatusItem[] {
    const local: ProcessStatusItem[] = [];
    for (const s of this.ratingPrecalcByLogic.values()) {
      if (s.status === 'pending' || s.status === 'running') {
        local.push({
          type: 'angular',
          label: `Rating precalc logic #${s.logic_id}`,
          status: s.status,
          detail: s.phase_message,
          progress_pct: s.progress_pct,
          logic_id: s.logic_id,
        });
      }
    }
    return [...this.processRows, ...local].slice(0, 12);
  }

  hasActiveProcesses(): boolean {
    return this.activeProcesses().length > 0 || !!this.processError;
  }

  processTitle(p: ProcessStatusItem): string {
    return [p.label, p.status, p.detail, p.wait, p.age]
      .filter(Boolean)
      .join(' · ');
  }

  toggleLogicExpand(row: LogicRow, event: Event): void {
    const target = event.target as HTMLElement;
    if (
      target.closest('button, input, a, .col-actions, .logic-signals-panel')
    ) {
      return;
    }
    if (this.expandedLogics.has(row.id)) {
      this.collapseLogic(row.id);
      return;
    }
    this.expandedLogics.add(row.id);
    this.ensureParamsDraft(row.id);
  }

  /** Collapse expanded logic (same as clicking the row when open). */
  collapseLogic(logicId: number, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    this.expandedLogics.delete(logicId);
    this.expandedParamsBlocks.delete(logicId);
    this.paramsDirtyIds.delete(logicId);
    this.expandedSignalsBlocks.delete(logicId);
    this.expandedStopsBlocks.delete(logicId);
    this.expandedSecuritiesBlocks.delete(logicId);
    this.expandedTradesBlocks.delete(logicId);
    this.expandedTestTradesBlocks.delete(logicId);
    this.closeSignalPicker();
    this.closeStopForm();
    this.closeSecurityPicker();
  }

  /** Name shown in expanded header / table while editing draft. */
  displayLogicName(row: LogicRow): string {
    const draft = this.paramsDrafts.get(row.id);
    const fromDraft = draft?.name?.trim();
    return fromDraft || row.name || `Логика #${row.id}`;
  }

  onParamsNameChange(logicId: number, value: string): void {
    this.getParamsDraft(logicId).name = value;
    this.paramsDirtyIds.add(logicId);
    this.paramsSaveErrors.delete(logicId);
  }

  /** Черновик параметров — всегда объект из Map (не временный литерал). */
  getParamsDraft(logicId: number) {
    this.ensureParamsDraft(logicId);
    return this.paramsDrafts.get(logicId)!;
  }

  paramsSaveError(logicId: number): string | null {
    return this.paramsSaveErrors.get(logicId) ?? null;
  }

  onParamsTimeframeChange(logicId: number, value: string): void {
    this.getParamsDraft(logicId).timeframe = value;
    this.paramsDirtyIds.add(logicId);
    this.paramsSaveErrors.delete(logicId);
  }

  onParamsStopLossTimeframeChange(logicId: number, value: string): void {
    this.getParamsDraft(logicId).stop_loss_timeframe = value;
    this.paramsDirtyIds.add(logicId);
    this.paramsSaveErrors.delete(logicId);
  }

  onParamsPctChange(logicId: number, value: string): void {
    this.getParamsDraft(logicId).position_size_pct = value;
    this.paramsDirtyIds.add(logicId);
    this.paramsSaveErrors.delete(logicId);
  }

  onParamsBaseAnnualRateChange(logicId: number, value: string): void {
    this.getParamsDraft(logicId).base_annual_rate_pct = value;
    this.paramsDirtyIds.add(logicId);
    this.paramsSaveErrors.delete(logicId);
  }

  onParamsRatingLookbackChange(logicId: number, value: string): void {
    this.getParamsDraft(logicId).rating_lookback_days = value;
    this.paramsDirtyIds.add(logicId);
    this.paramsSaveErrors.delete(logicId);
  }

  onParamsMaxPositionsChange(logicId: number, value: string): void {
    this.getParamsDraft(logicId).max_open_positions = value;
    this.paramsDirtyIds.add(logicId);
    this.paramsSaveErrors.delete(logicId);
  }

  onParamsInitialBalanceChange(logicId: number, value: string): void {
    this.getParamsDraft(logicId).initial_balance = value;
    this.paramsDirtyIds.add(logicId);
    this.paramsSaveErrors.delete(logicId);
  }

  onParamsCommissionPctChange(logicId: number, value: string): void {
    this.getParamsDraft(logicId).commission_pct = value;
    this.paramsDirtyIds.add(logicId);
    this.paramsSaveErrors.delete(logicId);
  }

  onParamsCostMethodChange(logicId: number, value: 'FIFO' | 'AVERAGE'): void {
    this.getParamsDraft(logicId).cost_method = value;
    this.paramsDirtyIds.add(logicId);
    this.paramsSaveErrors.delete(logicId);
  }

  onParamsResetBalanceChange(logicId: number, value: boolean): void {
    this.getParamsDraft(logicId).reset_balance = value;
    this.paramsDirtyIds.add(logicId);
    this.paramsSaveErrors.delete(logicId);
  }

  onParamsInversionChange(logicId: number, value: boolean): void {
    this.getParamsDraft(logicId).inversion = value;
    this.paramsDirtyIds.add(logicId);
    this.paramsSaveErrors.delete(logicId);
  }

  onParamsWarmupPretestChange(logicId: number, value: boolean): void {
    this.getParamsDraft(logicId).warmup_pretest = value;
    this.paramsDirtyIds.add(logicId);
    this.paramsSaveErrors.delete(logicId);
  }

  onParamsCashFundCodeChange(logicId: number, value: string): void {
    this.getParamsDraft(logicId).cash_fund_code = String(value ?? '')
      .trim()
      .toUpperCase();
    this.paramsDirtyIds.add(logicId);
    this.paramsSaveErrors.delete(logicId);
  }

  onParamsCashFundThresholdChange(logicId: number, value: string): void {
    this.getParamsDraft(logicId).cash_fund_threshold = value;
    this.paramsDirtyIds.add(logicId);
    this.paramsSaveErrors.delete(logicId);
  }

  onParamsClosePositionsEodChange(logicId: number, value: boolean): void {
    this.getParamsDraft(logicId).close_positions_eod = value;
    this.paramsDirtyIds.add(logicId);
    this.paramsSaveErrors.delete(logicId);
  }

  private formatPctParam(value: number | string | null | undefined): string {
    if (value == null || value === '') return '10';
    const n =
      typeof value === 'number'
        ? value
        : Number(String(value).trim().replace(/\s/g, '').replace(',', '.'));
    if (!Number.isFinite(n)) return '10';
    const rounded = Math.round(n * 10000) / 10000;
    if (Math.abs(rounded - Math.round(rounded)) < 1e-9) {
      return String(Math.round(rounded));
    }
    return String(rounded);
  }

  private formatIntParam(value: number | string | null | undefined, fallback: number): string {
    if (value == null || value === '') return String(fallback);
    const n = Number(String(value).trim().replace(/\s/g, ''));
    if (!Number.isFinite(n)) return String(fallback);
    return String(Math.round(n));
  }

  private formatBalanceDraft(value: number | string | null | undefined): string {
    if (value == null || value === '') return '';
    const n =
      typeof value === 'number'
        ? value
        : Number(String(value).trim().replace(/\s/g, '').replace(',', '.'));
    if (!Number.isFinite(n)) return '';
    return String(n);
  }

  private parseDecimalInput(raw: string): number {
    return Number(raw.trim().replace(/\s/g, '').replace(',', '.'));
  }

  isParamsLoading(logicId: number): boolean {
    return this.paramsLoading.has(logicId);
  }

  loadParamsForLogic(logicId: number, silent = false): void {
    if (silent && this.paramsDirtyIds.has(logicId)) {
      return;
    }
    if (!silent) {
      this.paramsLoading.add(logicId);
    }
    this.logicsService.getLogicParams(logicId).subscribe({
      next: (resp) => {
        this.applyTradingParamsToLogic(logicId, resp.trading);
        if (!this.paramsDirtyIds.has(logicId)) {
          const row = this.logics.find((l) => l.id === logicId);
          const draft = this.draftFromTrading(resp.trading);
          draft.name = row?.name ?? draft.name;
          this.paramsDrafts.set(logicId, draft);
        }
        this.paramsLoading.delete(logicId);
      },
      error: () => {
        this.paramsLoading.delete(logicId);
        if (!silent) {
          this.paramsSaveErrors.set(logicId, 'Не удалось загрузить параметры');
        }
      },
    });
  }

  private applyTradingParamsToLogic(
    logicId: number,
    trading: {
      timeframe?: string;
      position_size_pct: number;
      max_open_positions: number;
      initial_balance: number | null;
      current_balance: number | null;
      commission_pct?: number;
      cost_method?: 'FIFO' | 'AVERAGE';
      stop_loss_timeframe?: string;
      base_annual_rate_pct?: number;
      rating_lookback_days?: number;
      inversion?: boolean;
      warmup_pretest?: boolean;
      cash_fund_code?: string;
      cash_fund_threshold?: number;
      use_non_trading_periods?: boolean;
      close_positions_eod?: boolean;
    }
  ): void {
    const idx = this.logics.findIndex((l) => l.id === logicId);
    if (idx >= 0) {
      this.logics[idx] = { ...this.logics[idx], ...trading };
    }
  }

  private draftFromTrading(trading: {
    timeframe?: string;
    position_size_pct: number;
    max_open_positions: number;
    initial_balance: number | null;
    current_balance: number | null;
    commission_pct?: number;
    cost_method?: 'FIFO' | 'AVERAGE';
    stop_loss_timeframe?: string;
    base_annual_rate_pct?: number;
    rating_lookback_days?: number;
    inversion?: boolean;
    warmup_pretest?: boolean;
    cash_fund_code?: string;
    cash_fund_threshold?: number;
    use_non_trading_periods?: boolean;
    close_positions_eod?: boolean;
  }): {
    name: string;
    timeframe: string;
    position_size_pct: string;
    max_open_positions: string;
    initial_balance: string;
    commission_pct: string;
    cost_method: 'FIFO' | 'AVERAGE';
    stop_loss_timeframe: string;
    base_annual_rate_pct: string;
    rating_lookback_days: string;
    inversion: boolean;
    warmup_pretest: boolean;
    cash_fund_code: string;
    cash_fund_threshold: string;
    use_non_trading_periods: boolean;
    close_positions_eod: boolean;
    reset_balance: boolean;
  } {
    const method: 'FIFO' | 'AVERAGE' =
      trading.cost_method === 'AVERAGE' ? 'AVERAGE' : 'FIFO';
    const fundRaw = String(trading.cash_fund_code ?? '')
      .trim()
      .toUpperCase();
    const cash_fund_code = ['', 'TMON', 'LQDT', 'SBMM'].includes(fundRaw)
      ? fundRaw
      : '';
    return {
      name: '',
      timeframe: (trading.timeframe ?? 'M15').toUpperCase(),
      position_size_pct: this.formatPctParam(trading.position_size_pct),
      max_open_positions: this.formatIntParam(trading.max_open_positions, 5),
      initial_balance: this.formatBalanceDraft(trading.initial_balance),
      commission_pct: this.formatPctParam(trading.commission_pct ?? 0.03),
      cost_method: method,
      stop_loss_timeframe: (trading.stop_loss_timeframe ?? 'M5').toUpperCase(),
      base_annual_rate_pct: this.formatPctParam(trading.base_annual_rate_pct ?? 20),
      rating_lookback_days: this.formatIntParam(trading.rating_lookback_days ?? 7, 7),
      inversion: !!trading.inversion,
      warmup_pretest: trading.warmup_pretest !== false,
      cash_fund_code,
      cash_fund_threshold: this.formatBalanceDraft(
        trading.cash_fund_threshold != null ? trading.cash_fund_threshold : 1000000
      ),
      use_non_trading_periods: trading.use_non_trading_periods !== false,
      close_positions_eod: trading.close_positions_eod === true,
      reset_balance: false,
    };
  }

  toggleParamsBlock(logicId: number, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    if (this.expandedParamsBlocks.has(logicId)) {
      this.expandedParamsBlocks.delete(logicId);
      this.paramsDirtyIds.delete(logicId);
    } else {
      this.expandedParamsBlocks.add(logicId);
      this.paramsDirtyIds.delete(logicId);
      this.loadParamsForLogic(logicId);
    }
  }

  ensureParamsDraft(logicId: number, force = false): void {
    if (!force && this.paramsDrafts.has(logicId)) return;
    const row = this.logics.find((l) => l.id === logicId);
    if (!row) return;
    this.paramsDrafts.set(logicId, this.draftFromLogicRow(row));
  }

  private draftFromLogicRow(row: LogicRow) {
    const draft = this.draftFromTrading({
      timeframe: row.timeframe ?? 'M15',
      position_size_pct: row.position_size_pct,
      max_open_positions: row.max_open_positions,
      initial_balance: row.initial_balance,
      current_balance: row.current_balance,
      commission_pct: row.commission_pct,
      cost_method: row.cost_method,
      stop_loss_timeframe: row.stop_loss_timeframe,
      base_annual_rate_pct: row.base_annual_rate_pct,
      rating_lookback_days: row.rating_lookback_days,
      inversion: row.inversion,
      warmup_pretest: row.warmup_pretest,
      cash_fund_code: row.cash_fund_code,
      cash_fund_threshold: row.cash_fund_threshold,
      use_non_trading_periods: row.use_non_trading_periods,
      close_positions_eod: row.close_positions_eod,
    });
    draft.name = row.name ?? '';
    return draft;
  }

  isParamsSaving(logicId: number): boolean {
    return this.savingParamsIds.has(logicId);
  }

  saveTradingParams(row: LogicRow, event: Event): void {
    event.stopPropagation();
    const draft = this.getParamsDraft(row.id);
    const position_size_pct = this.parseDecimalInput(draft.position_size_pct);
    const max_open_positions = Math.round(this.parseDecimalInput(draft.max_open_positions));
    const initialRaw = draft.initial_balance.trim();
    const initial_balance =
      initialRaw === '' ? null : this.parseDecimalInput(initialRaw.replace(',', '.'));
    const commission_pct = this.parseDecimalInput(draft.commission_pct);
    const base_annual_rate_pct = this.parseDecimalInput(draft.base_annual_rate_pct);
    const rating_lookback_days = Math.round(
      this.parseDecimalInput(draft.rating_lookback_days)
    );

    if (!Number.isFinite(position_size_pct) || position_size_pct <= 0 || position_size_pct > 100) {
      this.paramsSaveErrors.set(
        row.id,
        '% депозита: число от 0.01 до 100 (без пробелов, например 10)'
      );
      return;
    }
    if (!Number.isInteger(max_open_positions) || max_open_positions <= 0) {
      this.paramsSaveErrors.set(row.id, 'Макс. позиций: целое число больше 0');
      return;
    }
    if (initial_balance != null && (!Number.isFinite(initial_balance) || initial_balance < 0)) {
      this.paramsSaveErrors.set(row.id, 'Начальный остаток: число ≥ 0 или пусто');
      return;
    }
    if (!Number.isFinite(commission_pct) || commission_pct < 0 || commission_pct > 100) {
      this.paramsSaveErrors.set(row.id, '% комиссии: число от 0 до 100');
      return;
    }
    if (
      !Number.isFinite(base_annual_rate_pct) ||
      base_annual_rate_pct < 0 ||
      base_annual_rate_pct > 1000
    ) {
      this.paramsSaveErrors.set(row.id, 'Базовая ставка (% годовых): число от 0 до 1000');
      return;
    }
    if (
      !Number.isInteger(rating_lookback_days) ||
      rating_lookback_days < 1 ||
      rating_lookback_days > 90
    ) {
      this.paramsSaveErrors.set(row.id, 'Дней предрасчёта рейтинга: целое от 1 до 90');
      return;
    }

    const cash_fund_threshold = this.parseDecimalInput(draft.cash_fund_threshold);
    if (!Number.isFinite(cash_fund_threshold) || cash_fund_threshold < 0) {
      this.paramsSaveErrors.set(row.id, 'Порог свободных денег: число ≥ 0');
      return;
    }
    const cash_fund_code = String(draft.cash_fund_code ?? '')
      .trim()
      .toUpperCase();
    if (!['', 'TMON', 'LQDT', 'SBMM'].includes(cash_fund_code)) {
      this.paramsSaveErrors.set(row.id, 'Денежный фонд: пусто, TMON, LQDT или SBMM');
      return;
    }

    this.paramsSaveErrors.delete(row.id);
    this.savingParamsIds.add(row.id);

    const name = String(draft.name ?? '').trim();
    if (!name) {
      this.savingParamsIds.delete(row.id);
      this.paramsSaveErrors.set(row.id, 'Имя логики не может быть пустым');
      return;
    }
    if (name.length > 100) {
      this.savingParamsIds.delete(row.id);
      this.paramsSaveErrors.set(row.id, 'Имя логики: не более 100 символов');
      return;
    }

    const saveParams = () =>
      this.logicsService.saveLogicParams(row.id, {
        timeframe: draft.timeframe,
        position_size_pct,
        max_open_positions,
        initial_balance,
        commission_pct,
        cost_method: draft.cost_method,
        stop_loss_timeframe: draft.stop_loss_timeframe,
        base_annual_rate_pct,
        rating_lookback_days,
        inversion: draft.inversion,
        warmup_pretest: draft.warmup_pretest,
        cash_fund_code,
        cash_fund_threshold,
        use_non_trading_periods: draft.use_non_trading_periods,
        close_positions_eod: draft.close_positions_eod,
        reset_balance: draft.reset_balance,
      });

    const afterParamsSaved = (resp: LogicParamsResponse) => {
      this.applyTradingParamsToLogic(row.id, resp.trading);
      const nextDraft = this.draftFromTrading(resp.trading);
      nextDraft.name = row.name;
      this.paramsDrafts.set(row.id, nextDraft);
      this.paramsDirtyIds.delete(row.id);
      this.savingParamsIds.delete(row.id);
      this.paramsSaveErrors.delete(row.id);
      const nt = this.nonTradingByLogic.get(row.id);
      if (nt) {
        this.nonTradingByLogic.set(row.id, {
          ...nt,
          use_non_trading_periods: resp.trading.use_non_trading_periods !== false,
        });
      }
      this.loadSecuritiesForLogic(row.id, true);
      this.techLog.event(
        this.techLog.logicThreadKey(row.id, 'params'),
        'logic.params.saved',
        'Параметры логики сохранены (UI)',
        {
          logicId: row.id,
          payload: { trading: resp.trading, params: resp.params },
        }
      );
    };

    const onSaveError = (err: { error?: { error?: string } }) => {
      this.savingParamsIds.delete(row.id);
      this.paramsSaveErrors.set(
        row.id,
        err?.error?.error ?? 'Не удалось сохранить параметры'
      );
    };

    if (name !== row.name) {
      this.logicsService
        .updateLogic(row.id, {
          name,
          account_id: row.account_id,
          is_enabled: row.is_enabled,
          note: row.note ?? null,
        })
        .subscribe({
          next: (updated) => {
            row.name = updated.name;
            const local = this.logics.find((l) => l.id === row.id);
            if (local) local.name = updated.name;
            saveParams().subscribe({
              next: afterParamsSaved,
              error: onSaveError,
            });
          },
          error: onSaveError,
        });
      return;
    }

    saveParams().subscribe({
      next: afterParamsSaved,
      error: onSaveError,
    });
  }

  formatMoney(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    return Number(value).toLocaleString('ru-RU', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  toggleSignalsBlock(logicId: number, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    if (this.expandedSignalsBlocks.has(logicId)) {
      this.expandedSignalsBlocks.delete(logicId);
      this.closeSignalPicker();
    } else {
      this.expandedSignalsBlocks.add(logicId);
      this.loadSignalsForLogic(logicId);
    }
  }

  toggleStopsBlock(logicId: number, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    if (this.expandedStopsBlocks.has(logicId)) {
      this.expandedStopsBlocks.delete(logicId);
      this.closeStopForm();
    } else {
      this.expandedStopsBlocks.add(logicId);
      this.loadStopsForLogic(logicId);
    }
  }

  toggleSecuritiesBlock(logicId: number, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    if (this.expandedSecuritiesBlocks.has(logicId)) {
      this.expandedSecuritiesBlocks.delete(logicId);
      this.closeSecurityPicker();
    } else {
      this.expandedSecuritiesBlocks.add(logicId);
      this.loadSecuritiesForLogic(logicId);
    }
  }

  togglePeriodsBlock(logicId: number, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    if (this.expandedPeriodsBlocks.has(logicId)) {
      this.expandedPeriodsBlocks.delete(logicId);
    } else {
      this.expandedPeriodsBlocks.add(logicId);
      this.loadNonTradingPeriods(logicId);
    }
  }

  isPeriodsLoading(logicId: number): boolean {
    return this.periodsLoading.has(logicId);
  }

  isPeriodsApplying(logicId: number): boolean {
    return this.periodsApplying.has(logicId);
  }

  intervalsForDay(
    logicId: number,
    dayOfWeek: number
  ): {
    id: number;
    day_of_week: number;
    time_from: string;
    time_to: string;
    note?: string | null;
  }[] {
    const row = this.nonTradingByLogic.get(logicId);
    if (!row) return [];
    return row.intervals.filter((i) => i.day_of_week === dayOfWeek);
  }

  private applyNonTradingResponse(
    logicId: number,
    resp: {
      use_non_trading_periods?: boolean;
      intervals?: {
        id: number;
        day_of_week: number;
        time_from: string;
        time_to: string;
        note?: string | null;
      }[];
    }
  ): void {
    this.nonTradingByLogic.set(logicId, {
      use_non_trading_periods: resp.use_non_trading_periods !== false,
      intervals: resp.intervals ?? [],
    });
  }

  addNonTradingInterval(logicId: number, dayOfWeek: number, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    if (this.periodsSaving.has(logicId)) return;
    this.periodsSaving.add(logicId);
    const defaults =
      dayOfWeek >= 6
        ? { time_from: '00:00', time_to: '23:59' }
        : { time_from: '18:40', time_to: '23:59' };
    this.logicsService
      .addNonTradingPeriod(logicId, {
        day_of_week: dayOfWeek,
        time_from: defaults.time_from,
        time_to: defaults.time_to,
      })
      .subscribe({
        next: (resp) => {
          this.applyNonTradingResponse(logicId, resp);
          this.periodsSaving.delete(logicId);
        },
        error: (err) => {
          console.error('addNonTradingPeriod', err);
          this.periodsSaving.delete(logicId);
        },
      });
  }

  onNonTradingIntervalTimeChange(
    logicId: number,
    intervalId: number,
    field: 'time_from' | 'time_to',
    value: string
  ): void {
    const raw = String(value ?? '').trim();
    if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(raw)) return;
    const hm = raw.slice(0, 5);
    if (this.periodsSaving.has(intervalId)) return;
    this.periodsSaving.add(intervalId);
    this.logicsService
      .updateNonTradingPeriod(intervalId, { [field]: hm })
      .subscribe({
        next: (resp) => {
          this.applyNonTradingResponse(logicId, resp);
          this.periodsSaving.delete(intervalId);
        },
        error: (err) => {
          console.error('updateNonTradingPeriod', err);
          this.periodsSaving.delete(intervalId);
          this.loadNonTradingPeriods(logicId, true);
        },
      });
  }

  deleteNonTradingInterval(logicId: number, intervalId: number, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    if (this.periodsSaving.has(intervalId)) return;
    this.periodsSaving.add(intervalId);
    this.logicsService.deleteNonTradingPeriod(intervalId).subscribe({
      next: (resp) => {
        this.applyNonTradingResponse(logicId, resp);
        this.periodsSaving.delete(intervalId);
      },
      error: (err) => {
        console.error('deleteNonTradingPeriod', err);
        this.periodsSaving.delete(intervalId);
      },
    });
  }

  useNonTradingPeriods(logicId: number): boolean {
    const cached = this.nonTradingByLogic.get(logicId);
    if (cached) return cached.use_non_trading_periods;
    return this.getParamsDraft(logicId).use_non_trading_periods !== false;
  }

  onUseNonTradingPeriodsChange(logicId: number, value: boolean, event?: Event): void {
    event?.stopPropagation();
    this.getParamsDraft(logicId).use_non_trading_periods = value;
    const cached = this.nonTradingByLogic.get(logicId);
    if (cached) {
      this.nonTradingByLogic.set(logicId, { ...cached, use_non_trading_periods: value });
    }
    this.logicsService
      .saveLogicParams(logicId, { use_non_trading_periods: value })
      .subscribe({
        next: (resp) => {
          this.applyTradingParamsToLogic(logicId, resp.trading);
          this.getParamsDraft(logicId).use_non_trading_periods =
            resp.trading.use_non_trading_periods !== false;
        },
        error: (err) => {
          console.error('use_non_trading_periods save', err);
        },
      });
  }

  applyMoexNonTradingPeriods(logicId: number, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.periodsApplying.add(logicId);
    this.logicsService.applyMoexNonTradingPeriods(logicId).subscribe({
      next: (resp) => {
        this.nonTradingByLogic.set(logicId, {
          use_non_trading_periods: resp.use_non_trading_periods !== false,
          intervals: resp.intervals ?? [],
        });
        this.periodsApplying.delete(logicId);
        this.expandedPeriodsBlocks.add(logicId);
      },
      error: (err) => {
        console.error('applyMoexNonTradingPeriods', err);
        this.periodsApplying.delete(logicId);
      },
    });
  }

  private loadNonTradingPeriods(logicId: number, force = false): void {
    if (!force && this.nonTradingByLogic.has(logicId) && !this.periodsLoading.has(logicId)) {
      return;
    }
    this.periodsLoading.add(logicId);
    this.logicsService.getNonTradingPeriods(logicId).subscribe({
      next: (resp) => {
        this.nonTradingByLogic.set(logicId, {
          use_non_trading_periods: resp.use_non_trading_periods !== false,
          intervals: resp.intervals ?? [],
        });
        this.getParamsDraft(logicId).use_non_trading_periods =
          resp.use_non_trading_periods !== false;
        this.periodsLoading.delete(logicId);
      },
      error: (err) => {
        console.error('getNonTradingPeriods', err);
        this.periodsLoading.delete(logicId);
      },
    });
  }

  isTestTradesBlockExpanded(id: number): boolean {
    return this.expandedTestTradesBlocks.has(id);
  }

  toggleTestTradesBlock(logicId: number, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (this.expandedTestTradesBlocks.has(logicId)) {
      this.expandedTestTradesBlocks.delete(logicId);
    } else {
      this.expandedTestTradesBlocks.add(logicId);
      this.loadSignalsForLogic(logicId);
      this.loadTestTradesForLogic(logicId);
      this.refreshBacktestStatus(logicId);
    }
  }

  toggleTradesBlock(logicId: number, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (this.expandedTradesBlocks.has(logicId)) {
      this.expandedTradesBlocks.delete(logicId);
      this.expandedOpenPositionsBlocks.delete(logicId);
      this.expandedClosedPositionsBlocks.delete(logicId);
      for (const tr of this.tradesFor(logicId)) {
        this.expandedTradeRows.delete(tr.id);
      }
    } else {
      this.expandedTradesBlocks.add(logicId);
      this.expandedOpenPositionsBlocks.add(logicId);
      this.loadTradesForLogic(logicId);
    }
  }

  toggleOpenPositionsBlock(logicId: number, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    if (this.expandedOpenPositionsBlocks.has(logicId)) {
      this.expandedOpenPositionsBlocks.delete(logicId);
    } else {
      this.expandedOpenPositionsBlocks.add(logicId);
      this.loadLotsForOpenPositions(logicId);
    }
  }

  toggleClosedPositionsBlock(logicId: number, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    if (this.expandedClosedPositionsBlocks.has(logicId)) {
      this.expandedClosedPositionsBlocks.delete(logicId);
    } else {
      this.expandedClosedPositionsBlocks.add(logicId);
      this.loadLotsForClosedPositions(logicId);
    }
  }

  isOpenPositionsExpanded(logicId: number): boolean {
    return this.expandedOpenPositionsBlocks.has(logicId);
  }

  isClosedPositionsExpanded(logicId: number): boolean {
    return this.expandedClosedPositionsBlocks.has(logicId);
  }

  openPositionTrades(logicId: number, isTest = false): LogicTradeRow[] {
    return this.tradesFor(logicId, isTest)
      .filter((t) => this.isOpenPositionTrade(t))
      .sort(
        (a, b) =>
          new Date(b.executed_at).getTime() - new Date(a.executed_at).getTime()
      );
  }

  closePositionTrades(logicId: number): LogicTradeRow[] {
    return this.tradesFor(logicId)
      .filter(
        (t) =>
          t.side_name === 'Close' &&
          (t.status === 'filled' || t.status === 'submitted')
      )
      .sort(
        (a, b) =>
          new Date(b.executed_at).getTime() - new Date(a.executed_at).getTime()
      );
  }

  closedPartialLotsForOpen(openTradeId: number): LogicTradeLotRow[] {
    return this.tradeLotsFor(openTradeId).filter(
      (l) => l.open_trade_id === openTradeId
    );
  }

  closedLotsForClose(closeTradeId: number): LogicTradeLotRow[] {
    return this.tradeLotsFor(closeTradeId).filter(
      (l) => l.close_trade_id === closeTradeId
    );
  }

  totalFinancialResult(logicId: number, isTest = false): number {
    return this.tradesFor(logicId, isTest)
      .filter((t) => !t.is_shadow)
      .reduce(
        (sum, t) =>
          t.financial_result != null && Number.isFinite(Number(t.financial_result))
            ? sum + Number(t.financial_result)
            : sum,
        0
      );
  }

  hasTestFinancialResult(logicId: number): boolean {
    return this.testPnlByLogic.has(logicId);
  }

  testFinancialResult(logicId: number): number | null {
    const row = this.testPnlByLogic.get(logicId);
    if (!row) return null;
    return Number(row.financial_result);
  }

  testFinancialResultTitle(logicId: number): string {
    const row = this.testPnlByLogic.get(logicId);
    if (!row) return '';
    const pnl = this.formatPnl(row.financial_result);
    const com = this.formatMoney(row.commission);
    const period = this.testPeriodLabel(logicId);
    const periodPart = period ? `, период ${period}` : '';
    return `Тест: финрез ${pnl}, комиссия ${com}, сделок ${row.trade_count}${periodPart}`;
  }

  /** Период последнего теста: день.месяц.год — без времени. */
  testPeriodLabel(logicId: number): string {
    const row = this.testPnlByLogic.get(logicId);
    const fromRun = this.backtestRuns.get(logicId);
    return formatDateRangeLabel(
      row?.date_from ?? fromRun?.date_from,
      row?.date_to ?? fromRun?.date_to,
    );
  }

  hasCombatFinancialResult(logicId: number): boolean {
    return this.combatPnlByLogic.has(logicId);
  }

  combatFinancialResult(logicId: number): number | null {
    const row = this.combatPnlByLogic.get(logicId);
    if (!row) return null;
    return Number(row.financial_result);
  }

  combatFinancialResultTitle(logicId: number): string {
    const row = this.combatPnlByLogic.get(logicId);
    if (!row) return '';
    const pnl = this.formatPnl(row.financial_result);
    const com = this.formatMoney(row.commission);
    return `Бой: финрез ${pnl}, комиссия ${com}, сделок ${row.trade_count}`;
  }

  hasOpenPositions(logicId: number): boolean {
    return this.openPositionTrades(logicId).length > 0;
  }

  isCloseAllLoading(logicId: number): boolean {
    return this.closeAllLoading.has(logicId);
  }

  closeAllPositionsAtMarket(logicId: number, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (this.closeAllLoading.has(logicId) || !this.hasOpenPositions(logicId)) {
      return;
    }
    if (
      !confirm(
        'Закрыть все открытые позиции по текущим рыночным ценам? Фин. результат будет пересчитан.'
      )
    ) {
      return;
    }
    this.closeAllLoading.add(logicId);
    this.logicsService.closeAllPositionsAtMarket(logicId).subscribe({
      next: (result) => {
        this.closeAllLoading.delete(logicId);
        if (!result.ok) {
          alert(result.error ?? 'Не удалось закрыть позиции');
          return;
        }
        this.logicTradeLots.clear();
        this.expandedTradeRows.clear();
        this.loadTradesForLogic(logicId);
        if (this.isClosedPositionsExpanded(logicId)) {
          this.loadLotsForClosedPositions(logicId);
        }
        if ((result.closed ?? 0) === 0 && (result.skipped ?? 0) > 0) {
          alert('Не удалось закрыть позиции: нет цен или ошибка брокера');
        }
      },
      error: (err) => {
        this.closeAllLoading.delete(logicId);
        alert(err?.error?.error ?? err?.message ?? 'Ошибка закрытия позиций');
      },
    });
  }

  isOpenPositionTrade(trade: LogicTradeRow): boolean {
    if (trade.side_name !== 'Open') {
      return false;
    }
    const rem = trade.remaining_qty;
    if (rem == null) {
      return true;
    }
    return Number(rem) > 0;
  }

  private loadLotsForClosedPositions(logicId: number): void {
    for (const close of this.closePositionTrades(logicId)) {
      this.loadTradeLots(close.id);
    }
  }

  private loadLotsForOpenPositions(logicId: number): void {
    for (const open of this.openPositionTrades(logicId)) {
      const rem = open.remaining_qty ?? open.quantity;
      if (Number(open.quantity) > Number(rem)) {
        this.loadTradeLots(open.id);
      }
    }
  }

  toggleTradeRow(trade: LogicTradeRow, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    if (this.expandedTradeRows.has(trade.id)) {
      this.expandedTradeRows.delete(trade.id);
    } else {
      this.expandedTradeRows.add(trade.id);
      this.loadTradeLots(trade.id);
    }
  }

  isTradeRowExpanded(tradeId: number): boolean {
    return this.expandedTradeRows.has(tradeId);
  }

  isTradeLotsLoading(tradeId: number): boolean {
    return this.tradeLotsLoading.has(tradeId);
  }

  tradeLotsFor(tradeId: number): LogicTradeLotRow[] {
    return this.logicTradeLots.get(tradeId) ?? [];
  }

  tradeHasPackages(trade: LogicTradeRow): boolean {
    return trade.side_name === 'Close' || trade.side_name === 'Open';
  }

  tradeOperationLabel = tradeOperationLabel;
  tradeOperationHint = tradeOperationHint;
  costMethodLabel = costMethodLabel;

  formatPnl(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    const n = Number(value);
    const formatted = this.formatMoney(Math.abs(n));
    if (n > 0) return `+${formatted}`;
    if (n < 0) return `−${formatted}`;
    return formatted;
  }

  /** % финреза от начального депозита (для колонок и скобок). */
  pnlDepositPct(
    pnl: number | null | undefined,
    initialBalance: number | null | undefined
  ): number | null {
    if (pnl == null || !Number.isFinite(Number(pnl))) return null;
    const initial = Number(initialBalance);
    if (!Number.isFinite(initial) || initial <= 0) return null;
    return (Number(pnl) / initial) * 100;
  }

  formatPnlPct(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    const n = Number(value);
    const sign = n > 0 ? '+' : n < 0 ? '−' : '';
    return `${sign}${Math.abs(n).toFixed(2)}%`;
  }

  combatFinancialResultPct(logicId: number, initialBalance: number | null | undefined): number | null {
    return this.pnlDepositPct(this.combatFinancialResult(logicId), initialBalance);
  }

  testFinancialResultPct(logicId: number, initialBalance: number | null | undefined): number | null {
    return this.pnlDepositPct(this.testFinancialResult(logicId), initialBalance);
  }

  requestTradeLots(tradeId: number): void {
    this.loadTradeLots(tradeId);
  }

  private loadTradeLots(tradeId: number): void {
    if (this.tradeLotsLoading.has(tradeId)) return;
    this.tradeLotsLoading.add(tradeId);
    this.logicsService.getLogicTradeLots(tradeId).subscribe({
      next: (rows) => {
        this.logicTradeLots.set(tradeId, rows);
        this.tradeLotsLoading.delete(tradeId);
      },
      error: () => {
        this.tradeLotsLoading.delete(tradeId);
      },
    });
  }

  tradesFor(logicId: number, isTest = false): LogicTradeRow[] {
    if (!isTest) {
      return this.logicTrades.get(Number(logicId)) ?? [];
    }
    const cached = this.testTradesViewByLogic.get(Number(logicId));
    if (cached) return cached;
    return this.logicTradesTest.get(Number(logicId)) ?? [];
  }

  onPeriodDialogOpen(open: boolean): void {
    this.uiInteractionPause = open;
  }

  /** Фильтр по run_id — один раз после HTTP, не в шаблоне на каждый CD. */
  private rebuildTestTradesView(logicId: number): void {
    const id = Number(logicId);
    const rows = this.logicTradesTest.get(id) ?? [];
    const runId = this.backtestRuns.get(id)?.id;
    let next = rows;
    if (runId != null) {
      const hasTagged = rows.some((t) => t.run_id != null);
      if (hasTagged) {
        next = rows.filter((t) => Number(t.run_id) === Number(runId));
      }
    }
    const prev = this.testTradesViewByLogic.get(id);
    if (prev && this.sameTradeListFingerprint(prev, next)) return;
    this.testTradesViewByLogic.set(id, next);
  }

  private sameTradeListFingerprint(a: LogicTradeRow[], b: LogicTradeRow[]): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    if (a.length === 0) return true;
    const lastA = a[a.length - 1];
    const lastB = b[b.length - 1];
    const remA = Number(lastA.remaining_qty ?? lastA.quantity);
    const remB = Number(lastB.remaining_qty ?? lastB.quantity);
    return (
      a[0].id === b[0].id &&
      lastA.id === lastB.id &&
      Number(lastA.financial_result) === Number(lastB.financial_result) &&
      String(lastA.bar_dt) === String(lastB.bar_dt) &&
      remA === remB
    );
  }

  backtestFor(logicId: number): BacktestRunStatus | null {
    return this.backtestRuns.get(logicId) ?? null;
  }

  timeframeIdForLogic(row: LogicRow): number | null {
    const draft = this.paramsDrafts.get(row.id);
    const tfName = (draft?.timeframe || row.timeframe || 'M15').trim();
    const byName = this.timeframesCatalog.find((t) => t.tf === tfName)?.id;
    if (byName != null) return byName;
    // fallback: M15 / первый из каталога
    return (
      this.timeframesCatalog.find((t) => t.tf === 'M15')?.id ??
      this.timeframesCatalog[0]?.id ??
      null
    );
  }

  signalIndicatorIdsFor(logicId: number): number[] {
    return this.signalIndicatorIdsByLogic.get(Number(logicId)) ?? [];
  }

  private rebuildSignalIndicatorIds(logicId: number): void {
    const ids = new Set<number>();
    for (const s of this.signalsFor(logicId)) {
      if (s.is_active && s.indicator_id != null) ids.add(Number(s.indicator_id));
    }
    const next = [...ids].sort((a, b) => a - b);
    const prev = this.signalIndicatorIdsByLogic.get(Number(logicId));
    if (prev && prev.length === next.length && prev.every((v, i) => v === next[i])) {
      return;
    }
    this.signalIndicatorIdsByLogic.set(Number(logicId), next);
  }

  isBacktestRunning(logicId: number): boolean {
    return this.backtestUi.isRunning(logicId);
  }

  /** Bound in template so CD sees Map updates from the shared service. */
  backtestUiTick(): number {
    return this.backtestUi.uiTick;
  }

  backtestProgressPct(logicId: number): number {
    const pct = Number(this.backtestRuns.get(logicId)?.progress_pct);
    if (!Number.isFinite(pct)) return 0;
    return Math.max(0, Math.min(100, Math.round(pct)));
  }

  backtestProgressTitle(logicId: number): string {
    const run = this.backtestRuns.get(logicId);
    if (!run) return 'Идёт тестирование';
    const pct = this.backtestProgressPct(logicId);
    const phase = run.phase_message || run.status || '';
    const detail = run.phase_detail ? ` — ${run.phase_detail}` : '';
    const period = formatDateRangeLabel(run.date_from, run.date_to);
    const periodPart = period ? ` (${period})` : '';
    return `Тест ${pct}%: ${phase}${detail}${periodPart}`;
  }

  isTradesLoading(logicId: number): boolean {
    return this.tradesLoading.has(logicId);
  }

  tradeActionLabel(trade: LogicTradeRow): string {
    return tradeOperationLabel(trade);
  }

  openTradeHasPartialCloses(trade: LogicTradeRow): boolean {
    const rem = trade.remaining_qty ?? trade.quantity;
    return Number(trade.quantity) > Number(rem);
  }

  formatTradeDt(iso: string): string {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString('ru-RU');
    } catch {
      return iso;
    }
  }

  securitiesFor(logicId: number): LogicSecurityRow[] {
    return this.logicSecurities.get(logicId) ?? [];
  }

  isSecuritiesLoading(logicId: number): boolean {
    return this.securitiesLoading.has(logicId);
  }

  securityKindLabel(row: LogicSecurityRow): string {
    return row.instrument_market === 'futures' ? 'Фьючерс' : 'Акция';
  }

  openSecurityPicker(logicId: number, event: Event): void {
    event.stopPropagation();
    this.securityPickerLogicId = logicId;
    this.pickerSelectedSecurityIds.clear();
    if (!this.expandedLogics.has(logicId)) {
      this.expandedLogics.add(logicId);
    }
    this.expandedSecuritiesBlocks.add(logicId);
    this.loadSecuritiesForLogic(logicId);
    this.ensureSecuritiesCatalogLoaded();
  }

  closeSecurityPicker(): void {
    this.securityPickerLogicId = null;
    this.pickerSelectedSecurityIds.clear();
  }

  isSecurityPickerOpen(logicId: number): boolean {
    return this.securityPickerLogicId === logicId;
  }

  toggleSecurityPickerSelection(securityId: number): void {
    if (this.pickerSelectedSecurityIds.has(securityId)) {
      this.pickerSelectedSecurityIds.delete(securityId);
    } else {
      this.pickerSelectedSecurityIds.add(securityId);
    }
  }

  isSecurityPickerSelected(securityId: number): boolean {
    return this.pickerSelectedSecurityIds.has(securityId);
  }

  pickerStocksAvailable(logicId: number): SecurityRow[] {
    const assigned = new Set(
      this.securitiesFor(logicId).map((s) => s.security_id)
    );
    return this.stocksCatalog.filter((s) => !assigned.has(s.id));
  }

  pickerFuturesAvailable(logicId: number): SecurityRow[] {
    const assigned = new Set(
      this.securitiesFor(logicId).map((s) => s.security_id)
    );
    return this.futuresCatalog.filter((s) => !assigned.has(s.id));
  }

  allStocksPickerSelected(logicId: number): boolean {
    const list = this.pickerStocksAvailable(logicId);
    return list.length > 0 && list.every((s) => this.pickerSelectedSecurityIds.has(s.id));
  }

  someStocksPickerSelected(logicId: number): boolean {
    const list = this.pickerStocksAvailable(logicId);
    const n = list.filter((s) => this.pickerSelectedSecurityIds.has(s.id)).length;
    return n > 0 && n < list.length;
  }

  allFuturesPickerSelected(logicId: number): boolean {
    const list = this.pickerFuturesAvailable(logicId);
    return list.length > 0 && list.every((s) => this.pickerSelectedSecurityIds.has(s.id));
  }

  someFuturesPickerSelected(logicId: number): boolean {
    const list = this.pickerFuturesAvailable(logicId);
    const n = list.filter((s) => this.pickerSelectedSecurityIds.has(s.id)).length;
    return n > 0 && n < list.length;
  }

  toggleAllStocksPicker(logicId: number, checked: boolean): void {
    for (const s of this.pickerStocksAvailable(logicId)) {
      if (checked) {
        this.pickerSelectedSecurityIds.add(s.id);
      } else {
        this.pickerSelectedSecurityIds.delete(s.id);
      }
    }
  }

  toggleAllFuturesPicker(logicId: number, checked: boolean): void {
    for (const s of this.pickerFuturesAvailable(logicId)) {
      if (checked) {
        this.pickerSelectedSecurityIds.add(s.id);
      } else {
        this.pickerSelectedSecurityIds.delete(s.id);
      }
    }
  }

  addSelectedSecurities(): void {
    if (this.securityPickerLogicId == null || this.pickerSelectedSecurityIds.size === 0) {
      return;
    }
    const logicId = this.securityPickerLogicId;
    const ids = [...this.pickerSelectedSecurityIds];
    this.logicsService.addLogicSecuritiesBulk(logicId, ids).subscribe({
      next: (created) => {
        const list = [...this.securitiesFor(logicId)];
        for (const row of created) {
          const idx = list.findIndex((x) => x.id === row.id);
          if (idx >= 0) {
            list[idx] = row;
          } else {
            list.push(row);
          }
        }
        this.logicSecurities.set(logicId, list);
        this.closeSecurityPicker();
      },
      error: (err) => {
        alert(err?.error?.error || 'Не удалось добавить бумаги');
      },
    });
  }

  deleteLogicSecurity(row: LogicSecurityRow, event: Event): void {
    event.stopPropagation();
    this.logicsService.deleteLogicSecurity(row.id).subscribe({
      next: () => {
        const list = (this.logicSecurities.get(row.logic_id) ?? []).filter(
          (s) => s.id !== row.id
        );
        this.logicSecurities.set(row.logic_id, list);
      },
    });
  }

  stopsFor(logicId: number): LogicStopRow[] {
    return this.logicStops.get(logicId) ?? [];
  }

  isStopsLoading(logicId: number): boolean {
    return this.stopsLoading.has(logicId);
  }

  openStopForm(logicId: number, ruleKind: LogicStopRuleKind, event: Event): void {
    event.stopPropagation();
    this.stopForm = { logicId, ruleKind };
    this.stopFormDraft = {
      // Стоп-лосс по умолчанию — по бумаге с возобновлением; тейк — по бумаге
      scope_type: ruleKind === 'stop_loss' ? 'security_resume' : 'security',
      value: '',
      value_unit: 'percent',
    };
    if (!this.expandedLogics.has(logicId)) {
      this.expandedLogics.add(logicId);
    }
    this.expandedStopsBlocks.add(logicId);
    this.loadStopsForLogic(logicId);
  }

  closeStopForm(): void {
    this.stopForm = null;
  }

  isStopFormOpen(logicId: number, ruleKind: LogicStopRuleKind): boolean {
    return (
      this.stopForm?.logicId === logicId && this.stopForm.ruleKind === ruleKind
    );
  }

  submitStopForm(): void {
    if (!this.stopForm) return;
    const value = Number(this.stopFormDraft.value.replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) {
      alert('Укажите положительное число в поле «Значение»');
      return;
    }
    const { logicId, ruleKind } = this.stopForm;
    this.logicsService
      .createLogicStop({
        logic_id: logicId,
        rule_kind: ruleKind,
        scope_type: this.stopFormDraft.scope_type,
        value,
        value_unit: this.stopFormDraft.value_unit,
      })
      .subscribe({
        next: (created) => {
          const list = [...(this.logicStops.get(logicId) ?? []), created];
          this.logicStops.set(logicId, list);
          this.closeStopForm();
        },
        error: (err) => {
          alert(err?.error?.error || 'Не удалось добавить правило');
        },
      });
  }

  saveStopRow(
    stop: LogicStopRow,
    patch: {
      scope_type?: LogicStopScopeType;
      value?: number;
      value_unit?: LogicStopValueUnit;
    }
  ): void {
    if (this.savingStopIds.has(stop.id)) return;
    this.savingStopIds.add(stop.id);
    this.logicsService.updateLogicStop(stop.id, patch).subscribe({
      next: (updated) => {
        const list = this.logicStops.get(stop.logic_id) ?? [];
        this.logicStops.set(
          stop.logic_id,
          list.map((s) => (s.id === updated.id ? updated : s))
        );
        this.savingStopIds.delete(stop.id);
      },
      error: () => this.savingStopIds.delete(stop.id),
    });
  }

  onStopValueBlur(stop: LogicStopRow, raw: string): void {
    const value = Number(raw.replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0 || value === stop.value) {
      return;
    }
    this.saveStopRow(stop, { value });
  }

  deleteStop(stop: LogicStopRow, event: Event): void {
    event.stopPropagation();
    this.logicsService.deleteLogicStop(stop.id).subscribe({
      next: () => {
        const list = (this.logicStops.get(stop.logic_id) ?? []).filter(
          (s) => s.id !== stop.id
        );
        this.logicStops.set(stop.logic_id, list);
      },
    });
  }

  isStopSaving(id: number): boolean {
    return this.savingStopIds.has(id);
  }

  signalsFor(logicId: number): LogicIndicatorSignalRow[] {
    return this.logicSignals.get(logicId) ?? [];
  }

  isSignalsLoading(logicId: number): boolean {
    return this.signalsLoading.has(logicId);
  }

  openSignalPicker(logicId: number, positionEvent: PositionEvent, event: Event): void {
    event.stopPropagation();
    this.signalPicker = {
      logicId,
      positionEvent,
      positionSide: 'long',
      signalKind: positionEvent === 'open' ? 'trend' : 'counter',
    };
    this.pickerSelectedIds.clear();
    if (!this.expandedLogics.has(logicId)) {
      this.expandedLogics.add(logicId);
    }
    this.expandedSignalsBlocks.add(logicId);
    this.loadSignalsForLogic(logicId);
  }

  onPickerSignalKindChange(kind: SignalKind): void {
    if (this.signalPicker) {
      this.signalPicker = { ...this.signalPicker, signalKind: kind };
    }
  }

  onPickerPositionSideChange(side: PositionSide): void {
    if (this.signalPicker) {
      this.signalPicker = { ...this.signalPicker, positionSide: side };
    }
  }

  pickerPreviewFormula(indicator: IndicatorRow): string {
    if (!this.signalPicker) return '';
    return buildLogicSignalFormula(indicator, this.signalPicker.signalKind);
  }

  closeSignalPicker(): void {
    this.signalPicker = null;
    this.pickerSelectedIds.clear();
  }

  isPickerOpen(logicId: number): boolean {
    return this.signalPicker?.logicId === logicId;
  }

  togglePickerSelection(indicatorId: number): void {
    if (this.pickerSelectedIds.has(indicatorId)) {
      this.pickerSelectedIds.delete(indicatorId);
    } else {
      this.pickerSelectedIds.add(indicatorId);
    }
  }

  isPickerSelected(indicatorId: number): boolean {
    return this.pickerSelectedIds.has(indicatorId);
  }

  onPickerRowDblClick(indicator: IndicatorRow): void {
    if (!this.signalPicker) return;
    this.pickerSelectedIds.clear();
    this.pickerSelectedIds.add(indicator.id);
    this.addSelectedSignals();
  }

  addSelectedSignals(): void {
    if (!this.signalPicker || this.pickerSelectedIds.size === 0) return;
    const { logicId, positionEvent, positionSide, signalKind } = this.signalPicker;
    const existing = new Set(
      this.signalsFor(logicId)
        .filter(
          (s) =>
            s.position_event === positionEvent &&
            s.position_side === positionSide &&
            s.signal_kind === signalKind
        )
        .map((s) => s.indicator_id)
    );
    const toAdd = [...this.pickerSelectedIds].filter((id) => !existing.has(id));
    if (toAdd.length === 0) {
      this.closeSignalPicker();
      return;
    }
    let pending = toAdd.length;
    for (const indicatorId of toAdd) {
      const ind = this.indicatorsCatalog.find((i) => i.id === indicatorId);
      if (!ind) {
        pending -= 1;
        continue;
      }
      const formula = buildLogicSignalFormula(ind, signalKind);
      this.logicsService
        .createLogicIndicatorSignal({
          logic_id: logicId,
          indicator_id: indicatorId,
          position_event: positionEvent,
          position_side: positionSide,
          signal_kind: signalKind,
          formula,
        })
        .subscribe({
          next: (created) => {
            const list = [...(this.logicSignals.get(logicId) ?? [])];
            const idx = list.findIndex((x) => x.id === created.id);
            if (idx >= 0) {
              list[idx] = created;
            } else {
              list.push(created);
            }
            this.logicSignals.set(logicId, list);
            this.formulaDrafts.set(created.id, created.formula);
            pending -= 1;
            if (pending === 0) {
              this.closeSignalPicker();
            }
          },
          error: () => {
            pending -= 1;
            if (pending === 0) {
              this.closeSignalPicker();
            }
          },
        });
    }
  }

  formulaDraft(signal: LogicIndicatorSignalRow): string {
    return this.formulaDrafts.get(signal.id) ?? signal.formula;
  }

  onFormulaInput(signal: LogicIndicatorSignalRow, value: string): void {
    this.formulaDrafts.set(signal.id, value);
  }

  formulaParseHint(signal: LogicIndicatorSignalRow): string | null {
    const parsed = parseSignalFormula(this.formulaDraft(signal));
    if (parsed.valid) return null;
    return parsed.errors[0] ?? 'Неверный формат';
  }

  saveSignalFormula(signal: LogicIndicatorSignalRow): void {
    const draft = this.formulaDraft(signal).trim();
    if (!draft || draft === signal.formula || this.savingFormulaIds.has(signal.id)) {
      return;
    }
    this.savingFormulaIds.add(signal.id);
    this.logicsService.updateLogicIndicatorSignal(signal.id, { formula: draft }).subscribe({
      next: (updated) => {
        const list = this.logicSignals.get(signal.logic_id) ?? [];
        this.logicSignals.set(
          signal.logic_id,
          list.map((s) => (s.id === updated.id ? updated : s))
        );
        this.formulaDrafts.set(updated.id, updated.formula);
        this.savingFormulaIds.delete(signal.id);
      },
      error: () => {
        this.formulaDrafts.set(signal.id, signal.formula);
        this.savingFormulaIds.delete(signal.id);
      },
    });
  }

  deleteSignal(signal: LogicIndicatorSignalRow, event: Event): void {
    event.stopPropagation();
    this.logicsService.deleteLogicIndicatorSignal(signal.id).subscribe({
      next: () => {
        const list = (this.logicSignals.get(signal.logic_id) ?? []).filter(
          (s) => s.id !== signal.id
        );
        this.logicSignals.set(signal.logic_id, list);
        this.formulaDrafts.delete(signal.id);
      },
    });
  }

  openAdd(): void {
    this.editorMode = 'add';
    this.editorLogic = null;
    this.editorOpen = true;
  }

  openEdit(row: LogicRow, event: Event): void {
    event.stopPropagation();
    this.editorMode = 'edit';
    this.editorLogic = row;
    this.editorOpen = true;
  }

  closeEditor(): void {
    this.editorOpen = false;
    this.editorLogic = null;
  }

  onEditorSaved(): void {
    this.loadLogicsOnce();
  }

  deleteLogic(row: LogicRow, event: Event): void {
    event.stopPropagation();
    const ok = confirm(`Удалить логику «${row.name}»?`);
    if (!ok) return;
    this.logicsService.deleteLogic(row.id).subscribe({
      next: () => {
        this.logicSignals.delete(row.id);
        this.logicStops.delete(row.id);
        this.logicSecurities.delete(row.id);
        this.logicTrades.delete(row.id);
        this.expandedLogics.delete(row.id);
        this.expandedSecuritiesBlocks.delete(row.id);
        this.expandedTradesBlocks.delete(row.id);
        this.selectedExportIds.delete(row.id);
        this.loadLogicsOnce();
      },
      error: (err) => {
        alert(err?.error?.error || 'Не удалось удалить логику');
      },
    });
  }

  copyLogic(row: LogicRow, event: Event): void {
    event.stopPropagation();
    if (this.copyingLogicIds.has(row.id)) return;
    this.copyingLogicIds.add(row.id);
    this.logicsService.copyLogic(row.id).subscribe({
      next: (created) => {
        this.copyingLogicIds.delete(row.id);
        this.logics = [...this.logics, created].sort((a, b) => a.id - b.id);
        this.expandedLogics.add(created.id);
        this.ensureParamsDraft(created.id, true);
        this.loadSignalsForLogic(created.id, true);
        this.loadStopsForLogic(created.id);
        this.loadSecuritiesForLogic(created.id);
        alert(`Логика скопирована: ${created.name}`);
        // After OK: list is already updated/expanded — scroll so the new row is on screen.
        setTimeout(() => this.scrollLogicIntoView(created.id), 0);
      },
      error: (err) => {
        this.copyingLogicIds.delete(row.id);
        alert(err?.error?.error || 'Не удалось скопировать логику');
      },
    });
  }

  isExportSelected(logicId: number): boolean {
    return this.selectedExportIds.has(logicId);
  }

  toggleExportSelection(logicId: number, checked: boolean): void {
    if (checked) {
      this.selectedExportIds.add(logicId);
    } else {
      this.selectedExportIds.delete(logicId);
    }
  }

  allExportSelected(): boolean {
    return (
      this.logics.length > 0 &&
      this.logics.every((r) => this.selectedExportIds.has(r.id))
    );
  }

  toggleAllExport(checked: boolean): void {
    if (checked) {
      for (const r of this.logics) {
        this.selectedExportIds.add(r.id);
      }
    } else {
      this.selectedExportIds.clear();
    }
  }

  exportSelectedLogics(): void {
    const ids = this.logics
      .filter((r) => this.selectedExportIds.has(r.id))
      .map((r) => r.id);
    if (ids.length === 0) {
      alert('Отметьте логики для экспорта (чекбокс справа)');
      return;
    }
    if (this.exportImportBusy) return;
    this.exportImportBusy = true;
    this.logicsService.exportLogics(ids).subscribe({
      next: (bundle) => {
        this.exportImportBusy = false;
        const names = (bundle.logics || []).map((l) => l.name);
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const blob = new Blob([JSON.stringify(bundle, null, 2)], {
          type: 'application/json;charset=utf-8',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `multilogic-logics-${stamp}.json`;
        a.click();
        URL.revokeObjectURL(url);
        alert(
          names.length === 1
            ? `Экспортирована логика: ${names[0]}`
            : `Экспортированы логики (${names.length}):\n${names.join('\n')}`
        );
      },
      error: (err) => {
        this.exportImportBusy = false;
        alert(err?.error?.error || 'Не удалось экспортировать логики');
      },
    });
  }

  /** Download complete trades JSON (params/signals/stops + all trade flags) for AI analysis. */
  exportLogicTrades(logicId: number, isTest: boolean): void {
    const key = `${logicId}:${isTest ? 'test' : 'live'}`;
    if (this.tradesExportBusy.has(key)) return;
    this.tradesExportBusy.add(key);
    const runId = isTest ? (this.backtestRuns.get(Number(logicId))?.id ?? null) : null;
    this.logicsService.exportLogicTrades(logicId, isTest, runId).pipe(takeUntil(this.destroy$)).subscribe({
      next: (bundle) => {
        this.tradesExportBusy.delete(key);
        const logicName = String(bundle?.logic?.name || `logic-${logicId}`)
          .replace(/[^\w\-а-яА-ЯёЁ]+/g, '_')
          .slice(0, 60);
        const mode = isTest ? 'test' : 'live';
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const blob = new Blob([JSON.stringify(bundle, null, 2)], {
          type: 'application/json;charset=utf-8',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `multilogic-trades-${mode}-${logicName}-${stamp}.json`;
        a.click();
        URL.revokeObjectURL(url);
        const n = Number(bundle?.counts?.['total'] ?? bundle?.trades?.length ?? 0);
        const shadow = Number(bundle?.counts?.['shadow'] ?? 0);
        alert(
          `Экспорт ${mode === 'test' ? 'теста' : 'боя'}: ${n} сделок` +
            (shadow ? ` (из них shadow: ${shadow})` : '') +
            `\nФайл: ${a.download}`
        );
      },
      error: (err) => {
        this.tradesExportBusy.delete(key);
        alert(err?.error?.error || 'Не удалось экспортировать сделки');
      },
    });
  }

  triggerImportLogics(): void {
    if (this.exportImportBusy) return;
    const input = this.logicImportFile?.nativeElement;
    if (!input) return;
    input.value = '';
    input.click();
  }

  onImportFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (this.exportImportBusy) return;
    this.exportImportBusy = true;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result || '');
        const bundle = JSON.parse(text);
        this.logicsService.importLogics(bundle).subscribe({
          next: (result) => {
            this.exportImportBusy = false;
            this.loadLogicsOnce();
            const names = (result.imported || []).map((r) => r.name);
            let msg =
              names.length === 1
                ? `Импортирована логика: ${names[0]}`
                : `Импортированы логики (${names.length}):\n${names.join('\n')}`;
            if (result.warnings?.length) {
              msg += `\n\nПредупреждения:\n${result.warnings.slice(0, 12).join('\n')}`;
              if (result.warnings.length > 12) {
                msg += `\n… ещё ${result.warnings.length - 12}`;
              }
            }
            alert(msg);
          },
          error: (err) => {
            this.exportImportBusy = false;
            alert(err?.error?.error || 'Не удалось импортировать логики');
          },
        });
      } catch {
        this.exportImportBusy = false;
        alert('Файл не является корректным JSON');
      }
    };
    reader.onerror = () => {
      this.exportImportBusy = false;
      alert('Не удалось прочитать файл');
    };
    reader.readAsText(file, 'utf-8');
  }

  private scrollLogicIntoView(logicId: number): void {
    const el = document.querySelector(
      `.logic-main-row[data-logic-id="${logicId}"]`,
    ) as HTMLElement | null;
    el?.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
  }

  isCopying(row: LogicRow): boolean {
    return this.copyingLogicIds.has(row.id);
  }

  onEnabledChange(row: LogicRow, checked: boolean, event: Event): void {
    event.stopPropagation();
    if (this.savingIds.has(row.id)) return;

    // Фейк-счёт: котировки с глобального TBANK_API_TOKEN (один на все логики/копии).
    if (checked && row.account_type === 'fake') {
      this.settings.getTbankTokenConfigured().subscribe({
        next: (status) => {
          if (!status.has_token) {
            this.pendingEnableLogic = row;
            this.tbankTokenDialogContext = 'logic';
            this.tbankTokenDialogReason = 'missing';
            this.tbankTokenDialogOpen = true;
            return;
          }
          this.applyEnabledChange(row, checked);
        },
        error: () => this.applyEnabledChange(row, checked),
      });
      return;
    }

    this.applyEnabledChange(row, checked);
  }

  onTbankTokenSavedForLogic(): void {
    this.tbankTokenDialogOpen = false;
    this.lastTbankTokenCheckAt = Date.now();
    const row = this.pendingEnableLogic;
    const pendingBt = this.pendingBacktest;
    this.pendingEnableLogic = null;
    this.pendingBacktest = null;
    this.settings.getTbankTokenStatus(true).subscribe({
      next: (status) => {
        this.applyTbankTokenStatus(status);
        if (row && status.has_token) {
          this.applyEnabledChange(row, true);
        }
        if (pendingBt && status.has_token) {
          this.doStartBacktestRun(pendingBt.logicId, pendingBt.period);
        }
      },
      error: () => {},
    });
  }

  onTbankTokenCancelledForLogic(): void {
    this.tbankTokenDialogOpen = false;
    this.pendingEnableLogic = null;
    this.pendingBacktest = null;
  }

  openTbankTokenDialogFromAlert(event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (this.tbankTokenDialogOpen) return;
    const alert = this.tbankTokenAlert;
    this.tbankTokenDialogContext = 'trades';
    this.tbankTokenDialogReason = alert?.reason ?? 'missing';
    this.tbankTokenDialogOpen = true;
  }

  tbankTokenAlertShortLabel(): string {
    if (!this.tbankTokenAlert) return '';
    return this.tbankTokenAlert.reason === 'invalid'
      ? 'Токен T-Bank неактивен'
      : 'Токен T-Bank не задан';
  }

  private hasEnabledLogic(): boolean {
    return this.logics.some((l) => l.is_enabled);
  }

  private applyTbankTokenStatus(status: {
    has_token: boolean;
    valid?: boolean;
    error_message?: string | null;
  }): void {
    if (!this.hasEnabledLogic() || status.valid) {
      this.tbankTokenAlert = null;
      return;
    }
    const reason: 'missing' | 'invalid' = status.has_token ? 'invalid' : 'missing';
    this.tbankTokenAlert = {
      reason,
      message:
        status.error_message?.trim() ||
        (reason === 'invalid'
          ? 'Токен T-Bank неактивен или просрочен. Нажмите, чтобы ввести новый API-токен.'
          : 'Токен T-Bank не задан. Нажмите, чтобы ввести API-токен для котировок и сделок.'),
    };
  }

  /** Проверка токена для runner: баннер + диалог только по клику. */
  private maybeCheckTbankTokenForTrades(): void {
    if (!this.hasEnabledLogic()) {
      this.tbankTokenAlert = null;
      return;
    }

    const now = Date.now();
    if (now - this.lastTbankTokenCheckAt < this.tbankTokenCheckMs) return;
    this.lastTbankTokenCheckAt = now;

    this.settings.getTbankTokenStatus(true).subscribe({
      next: (status) => this.applyTbankTokenStatus(status),
      error: () => {},
    });
  }

  private applyEnabledChange(row: LogicRow, checked: boolean): void {
    const previous = row.is_enabled;
    row.is_enabled = checked;
    this.savingIds.add(row.id);
    this.logicsService.updateLogicEnabled(row.id, checked).subscribe({
      next: (resp) => {
        this.savingIds.delete(row.id);
        row.is_enabled = resp.is_enabled;
        this.techLog.event(
          this.techLog.logicThreadKey(row.id, 'control'),
          checked ? 'logic.enabled' : 'logic.disabled',
          checked ? 'Логика включена (UI)' : 'Логика выключена (UI)',
          { logicId: row.id, payload: resp }
        );
        if (resp.warmup_pretest?.started) {
          this.backtestUi.watch(row.id);
          this.expandedLogics.add(row.id);
          this.expandedTestTradesBlocks.add(row.id);
          this.refreshBacktestStatus(row.id);
          return;
        }
        if (checked) {
          this.lastTbankTokenCheckAt = 0;
          this.maybeCheckTbankTokenForTrades();
          const precalc = resp?.rating_precalc;
          if (precalc) {
            this.ratingPrecalcByLogic.set(row.id, precalc);
          }
          this.watchRatingPrecalc(row.id);
        } else if (!this.hasEnabledLogic()) {
          this.tbankTokenAlert = null;
        }
      },
      error: () => {
        row.is_enabled = previous;
        this.savingIds.delete(row.id);
      },
    });
  }

  combatSignalKey(logicId: number, signalId: number): string {
    return `${logicId}:${signalId}`;
  }

  isCombatSignalExpanded(logicId: number, signalId: number): boolean {
    return this.expandedCombatSignals.has(this.combatSignalKey(logicId, signalId));
  }

  toggleCombatSignal(logicId: number, signalId: number, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    const key = this.combatSignalKey(logicId, signalId);
    if (this.expandedCombatSignals.has(key)) {
      this.expandedCombatSignals.delete(key);
      return;
    }
    this.expandedCombatSignals.add(key);
    this.loadSecuritiesForLogic(logicId);
  }

  isRatingPrecalcActive(logicId: number): boolean {
    const s = this.ratingPrecalcByLogic.get(logicId);
    return !!s && (s.status === 'pending' || s.status === 'running');
  }

  ratingPrecalcTitle(logicId: number): string {
    const s = this.ratingPrecalcByLogic.get(logicId);
    if (!s) return '';
    const pct = Math.round(Number(s.progress_pct) || 0);
    return `Предрасчёт рейтинга: ${s.phase_message || s.status} (${pct}%)`;
  }

  combatReloadToken(logicId: number): number {
    return this.combatRatingReloadToken.get(logicId) ?? 0;
  }

  private watchRatingPrecalc(logicId: number): void {
    if (this.ratingPrecalcPollIds.has(logicId)) return;
    this.ratingPrecalcPollIds.add(logicId);
    const pollOnce = () => {
      this.logicsService.getSignalRatingPrecalc(logicId).subscribe({
        next: (status) => {
          this.ratingPrecalcByLogic.set(logicId, status);
          if (status.status === 'pending' || status.status === 'running') {
            window.setTimeout(pollOnce, 1500);
            return;
          }
          this.ratingPrecalcPollIds.delete(logicId);
          if (status.status === 'done') {
            this.combatRatingReloadToken.set(
              logicId,
              (this.combatRatingReloadToken.get(logicId) ?? 0) + 1
            );
            this.loadSignalsForLogic(logicId, true);
          }
        },
        error: () => {
          this.ratingPrecalcPollIds.delete(logicId);
        },
      });
    };
    pollOnce();
  }

  isSaving(row: LogicRow): boolean {
    return this.savingIds.has(row.id);
  }

  isFormulaSaving(signalId: number): boolean {
    return this.savingFormulaIds.has(signalId);
  }

  accountTypeLabel(type: string): string {
    return type === 'fake' ? 'фейковый' : 'реальный';
  }

  private loadIndicatorsCatalog(): void {
    this.refs.getIndicators(false).subscribe({
      next: (rows) => {
        this.indicatorsCatalog = rows.filter((r) => r.is_active);
        this.indicatorsLoaded = true;
      },
      error: () => {
        this.indicatorsLoaded = true;
      },
    });
  }

  private loadStopsForLogic(logicId: number): void {
    if (this.stopsLoading.has(logicId)) return;
    this.stopsLoading.add(logicId);
    this.logicsService.getLogicStops(logicId).subscribe({
      next: (rows) => {
        this.logicStops.set(logicId, rows);
        this.stopsLoading.delete(logicId);
      },
      error: () => {
        this.stopsLoading.delete(logicId);
      },
    });
  }

  private loadSignalsForLogic(logicId: number, force = false): void {
    if (!force && this.signalsLoading.has(logicId)) return;
    this.signalsLoading.add(logicId);
    this.logicsService.getLogicIndicatorSignals(logicId).subscribe({
      next: (rows) => {
        this.logicSignals.set(logicId, rows);
        for (const r of rows) {
          if (!this.isFormulaDraftDirty(r.id, r.formula)) {
            this.formulaDrafts.set(r.id, r.formula);
          }
        }
        this.rebuildSignalIndicatorIds(logicId);
        this.signalsLoading.delete(logicId);
      },
      error: () => {
        this.signalsLoading.delete(logicId);
      },
    });
  }

  /** Денежный фонд — первая бумага в Позиции/Тестирование → «Бумаги». */
  cashFundPinnedPaper(row: LogicRow): {
    security_id: number;
    security_name: string;
    security_prefix: string | null;
    pnl: number;
    commission: number;
    trade_count: number;
    open_qty: number;
    last_price: number | null;
    position_value: number;
  } | null {
    const code = String(row.cash_fund_code ?? '')
      .trim()
      .toUpperCase();
    if (!code || !['TMON', 'LQDT', 'SBMM'].includes(code)) {
      return null;
    }
    if (!this.logicSecurities.has(row.id) && !this.securitiesLoading.has(row.id)) {
      this.loadSecuritiesForLogic(row.id);
    }
    const sec = this.securitiesFor(row.id).find(
      (s) =>
        String(s.prefix ?? '')
          .trim()
          .toUpperCase() === code && s.is_active !== false
    );
    if (!sec) {
      return null;
    }
    return {
      security_id: Number(sec.security_id),
      security_name: sec.security_name,
      security_prefix: sec.prefix,
      pnl: 0,
      commission: 0,
      trade_count: 0,
      open_qty: 0,
      last_price: null,
      position_value: 0,
    };
  }

  private loadSecuritiesForLogic(logicId: number, force = false): void {
    if (!force && this.securitiesLoading.has(logicId)) return;
    this.securitiesLoading.add(logicId);
    this.logicsService.getLogicSecurities(logicId).subscribe({
      next: (rows) => {
        this.logicSecurities.set(logicId, rows);
        this.securitiesLoading.delete(logicId);
      },
      error: () => {
        this.securitiesLoading.delete(logicId);
      },
    });
  }

  startBacktestRun(logicId: number, period: { date_from: string; date_to: string }): void {
    // Тест: тот же глобальный токен, что у seed-логик — без повторного HTTP-verify на каждую копию.
    this.settings.getTbankTokenConfigured().subscribe({
      next: (status) => {
        if (!status.has_token) {
          this.pendingBacktest = { logicId, period };
          this.tbankTokenDialogContext = 'logic';
          this.tbankTokenDialogReason = 'missing';
          this.tbankTokenDialogOpen = true;
          return;
        }
        this.doStartBacktestRun(logicId, period);
      },
      error: () => this.doStartBacktestRun(logicId, period),
    });
  }

  private doStartBacktestRun(logicId: number, period: { date_from: string; date_to: string }): void {
    this.logicsService
      .startBacktest({ logic_id: logicId, date_from: period.date_from, date_to: period.date_to })
      .subscribe({
        next: () => {
          this.backtestUi.watch(logicId);
          this.expandedTestTradesBlocks.add(logicId);
          this.loadSignalsForLogic(logicId);
          this.refreshBacktestStatus(logicId);
        },
        error: (err) => alert(err?.error?.error || 'Не удалось запустить тест'),
      });
  }

  cancelBacktestRun(logicId: number): void {
    const run = this.backtestRuns.get(logicId);
    if (!run?.id) return;
    this.backtestRuns.set(logicId, {
      ...run,
      phase_message: 'Остановка…',
      phase_detail: run.phase_detail || 'Запрос на остановку принят',
    });
    this.logicsService.cancelBacktest(run.id).subscribe({
      next: () => this.refreshBacktestStatus(logicId),
      error: (err) => alert(err?.error?.error || 'Не удалось остановить тест'),
    });
  }

  private refreshBacktestStatus(logicId: number): void {
    this.logicsService.getBacktestStatus(logicId).pipe(takeUntil(this.destroy$)).subscribe({
      next: (row) => {
        if (row) {
          this.backtestUi.setRun(logicId, row);
          const st = String(row.status ?? '');
          if (['pending', 'loading_prices', 'loading_indicators', 'running'].includes(st)) {
            this.expandedTestTradesBlocks.add(logicId);
          } else {
            this.loadTestTradesForLogic(logicId, true);
          }
          this.rebuildTestTradesView(logicId);
        } else {
          this.backtestUi.setRun(logicId, null);
          this.rebuildTestTradesView(logicId);
        }
      },
    });
  }

  private loadTradesForLogic(logicId: number, silent = false): void {
    if (!silent && this.tradesLoading.has(logicId)) return;
    if (this.liveTradesInFlight.has(logicId)) return;
    if (!silent) {
      this.tradesLoading.add(logicId);
    }
    this.liveTradesInFlight.add(logicId);
    this.logicsService.getLogicTrades(logicId, 200, false).pipe(takeUntil(this.destroy$)).subscribe({
      next: (rows) => {
        this.liveTradesInFlight.delete(logicId);
        const prev = this.logicTrades.get(Number(logicId));
        if (!prev || !this.sameTradeListFingerprint(prev, rows)) {
          this.logicTrades.set(Number(logicId), rows);
        }
        this.tradesLoading.delete(logicId);
      },
      error: () => {
        this.liveTradesInFlight.delete(logicId);
        this.tradesLoading.delete(logicId);
      },
    });
  }

  private loadTestTradesForLogic(logicId: number, _silent = false): void {
    if (this.testTradesInFlight.has(logicId)) return;
    this.testTradesInFlight.add(logicId);
    // Полный последний прогон: иначе LIMIT 5000 даёт другой финрез, чем колонка «Тест» (pnl-summary).
    const runId = this.backtestRuns.get(Number(logicId))?.id ?? null;
    this.logicsService.getLogicTrades(logicId, 50000, true, runId).pipe(takeUntil(this.destroy$)).subscribe({
      next: (rows) => {
        this.testTradesInFlight.delete(logicId);
        const prev = this.logicTradesTest.get(Number(logicId));
        if (prev && this.sameTradeListFingerprint(prev, rows)) {
          this.rebuildTestTradesView(logicId);
          return;
        }
        this.logicTradesTest.set(Number(logicId), rows);
        this.rebuildTestTradesView(logicId);
      },
      error: () => {
        this.testTradesInFlight.delete(logicId);
      },
    });
  }

  private refreshAllTradesSummaries(): void {
    this.pollTick++;
    // Тяжёлые списки сделок (особенно test≤5000) — не каждые 2 с по всем логикам.
    const heavyTick = this.pollTick % 3 === 0;

    for (const logicId of this.backtestPollIds) {
      this.refreshBacktestStatus(logicId);
    }

    for (const row of this.logics) {
      const id = row.id;
      const liveOpen = this.expandedTradesBlocks.has(id);
      const testOpen = this.expandedTestTradesBlocks.has(id);
      const testing = this.backtestPollIds.has(id);

      if (liveOpen || (this.expandedLogics.has(id) && heavyTick)) {
        this.loadTradesForLogic(id, true);
      }
      // Тест-сделки: running / открытая панель — чаще; иначе только на heavyTick при развёрнутой логике.
      if (testOpen || testing) {
        if (testOpen || heavyTick) {
          this.loadTestTradesForLogic(id, true);
        }
      } else if (this.expandedLogics.has(id) && heavyTick) {
        this.loadTestTradesForLogic(id, true);
      }
    }
  }

  private refreshPnlSummaries(): void {
    this.refreshTestPnlSummary();
    this.refreshCombatPnlSummary();
  }

  private refreshProcesses(): void {
    this.logicsService.getProcesses().pipe(takeUntil(this.destroy$)).subscribe({
      next: (resp) => {
        this.processRows = resp.rows ?? [];
        this.processError = null;
        // Processes strip also lists active backtests — keep yellow/watch in sync.
        for (const p of this.processRows) {
          if (p.type === 'backtest' && p.logic_id != null) {
            const id = Number(p.logic_id);
            if (Number.isFinite(id) && id > 0 && !this.backtestUi.isRunning(id)) {
              this.backtestUi.watch(id);
            }
          }
        }
      },
      error: (err) => {
        this.processRows = [];
        this.processError = err?.error?.error ?? err?.message ?? 'Не удалось загрузить процессы';
      },
    });
  }

  private refreshTestPnlSummary(): void {
    this.logicsService.getLogicTradesPnlSummary(true).subscribe({
      next: (resp) => {
        this.testPnlByLogic.clear();
        for (const r of resp.rows ?? []) {
          const logicId = Number(r.logic_id);
          if (!Number.isFinite(logicId) || logicId <= 0) continue;
          const pnl = Number(r.financial_result);
          this.testPnlByLogic.set(logicId, {
            financial_result: Number.isFinite(pnl) ? pnl : 0,
            commission: Number(r.commission) || 0,
            trade_count: Number(r.trade_count) || 0,
            date_from: r.date_from ?? null,
            date_to: r.date_to ?? null,
          });
        }
      },
      error: () => {
        // Старый API без /pnl-summary — только если нет нового endpoint
        this.refreshTestPnlFromBacktestRuns();
      },
    });
  }

  private refreshCombatPnlSummary(): void {
    this.logicsService.getLogicTradesPnlSummary(false).subscribe({
      next: (resp) => {
        const next = new Map<
          number,
          { financial_result: number; commission: number; trade_count: number }
        >();
        for (const r of resp.rows ?? []) {
          const logicId = Number(r.logic_id);
          if (!Number.isFinite(logicId) || logicId <= 0) continue;
          const pnl = Number(r.financial_result);
          next.set(logicId, {
            financial_result: Number.isFinite(pnl) ? pnl : 0,
            commission: Number(r.commission) || 0,
            trade_count: Number(r.trade_count) || 0,
          });
        }
        this.combatPnlByLogic = next;
      },
      error: () => {
        /* опционально */
      },
    });
  }

  /** Fallback без /pnl-summary: сумма уже загруженных test-сделок (не runs.financial_result). */
  private refreshTestPnlFromBacktestRuns(): void {
    this.testPnlByLogic.clear();
    for (const row of this.logics) {
      const trades = this.logicTradesTest.get(Number(row.id)) ?? [];
      const live = trades.filter((t) => !t.is_shadow);
      if (live.length === 0) continue;
      const financial_result = live.reduce(
        (sum, t) =>
          t.financial_result != null && Number.isFinite(Number(t.financial_result))
            ? sum + Number(t.financial_result)
            : sum,
        0
      );
      const commission = live.reduce(
        (sum, t) => sum + (Number(t.commission) || 0),
        0
      );
      const run = this.backtestRuns.get(Number(row.id));
      this.testPnlByLogic.set(Number(row.id), {
        financial_result,
        commission,
        trade_count: live.length,
        date_from: run?.date_from ?? null,
        date_to: run?.date_to ?? null,
      });
    }
  }

  private loadMoexExchangeId(): void {
    this.refs.getExchanges().subscribe({
      next: (rows) => {
        const moex =
          rows.find((e) => e.name === 'MOEX') ?? rows[0];
        this.moexExchangeId = moex?.id ?? null;
      },
    });
  }

  private ensureSecuritiesCatalogLoaded(): void {
    if (this.securitiesCatalogLoaded || this.securitiesCatalogLoading) {
      return;
    }
    if (!this.moexExchangeId) {
      this.refs.getExchanges().subscribe({
        next: (rows) => {
          const moex =
            rows.find((e) => e.name === 'MOEX') ?? rows[0];
          this.moexExchangeId = moex?.id ?? null;
          if (this.moexExchangeId) {
            this.fetchSecuritiesCatalog(this.moexExchangeId);
          } else {
            this.securitiesCatalogLoaded = true;
          }
        },
        error: () => {
          this.securitiesCatalogLoaded = true;
        },
      });
      return;
    }
    this.fetchSecuritiesCatalog(this.moexExchangeId);
  }

  private fetchSecuritiesCatalog(exchangeId: number): void {
    this.securitiesCatalogLoading = true;
    forkJoin({
      stocks: this.securitiesService.getSecurities(exchangeId, 'stock'),
      futures: this.securitiesService.getSecurities(exchangeId, 'futures'),
    }).subscribe({
      next: ({ stocks, futures }) => {
        this.stocksCatalog = stocks;
        this.futuresCatalog = futures;
        this.securitiesCatalogLoaded = true;
        this.securitiesCatalogLoading = false;
      },
      error: () => {
        this.securitiesCatalogLoaded = true;
        this.securitiesCatalogLoading = false;
      },
    });
  }

  private isFormulaDraftDirty(signalId: number, savedFormula: string): boolean {
    const draft = this.formulaDrafts.get(signalId);
    return draft !== undefined && draft !== savedFormula;
  }

  private loadLogicsOnce(): void {
    this.logicsService.getLogics().subscribe({
      next: (rows) => {
        this.logics = rows;
        this.error = null;
        const alive = new Set(rows.map((r) => r.id));
        for (const id of [...this.selectedExportIds]) {
          if (!alive.has(id)) this.selectedExportIds.delete(id);
        }
      },
    });
  }
}
