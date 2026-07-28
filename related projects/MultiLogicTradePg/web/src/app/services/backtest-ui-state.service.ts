/**
 * Survives Angular route changes (/operations → other tabs).
 * Keeps backtest yellow/progress/pnl maps alive and polls active runs in the background.
 * Single owner of GET /logic-backtest/status (LogicsComponent must not duplicate).
 */
import { Injectable, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, Subscription } from 'rxjs';
import { AppConfigService } from './app-config.service';
import type { BacktestRunStatus } from '../logics/logic-positions-panel.component';

const POLL_MS = 2000;
const ACTIVE_STATUSES = new Set([
  'pending',
  'loading_prices',
  'loading_indicators',
  'running',
]);

@Injectable({ providedIn: 'root' })
export class BacktestUiStateService implements OnDestroy {
  /** Shared with LogicsComponent — same Map instance across remounts. */
  readonly runs = new Map<number, BacktestRunStatus>();
  readonly pollIds = new Set<number>();
  /** Prefer expanding «Тестирование» when returning to the tab mid-run. */
  readonly expandTestBlocks = new Set<number>();
  /** Last known test PnL column values (survive remount until next HTTP refresh). */
  readonly testPnlByLogic = new Map<
    number,
    {
      financial_result: number;
      commission: number;
      trade_count: number;
      date_from?: string | null;
      date_to?: string | null;
    }
  >();

  private timer: ReturnType<typeof setInterval> | null = null;
  private recovering = false;
  private readonly bump$ = new BehaviorSubject<number>(0);
  /** Cancel previous in-flight status per logicId (re-launch / slow API). */
  private readonly statusSubs = new Map<number, Subscription>();

  /** UI can subscribe to re-check yellow/progress after background poll. */
  readonly changes$: Observable<number> = this.bump$.asObservable();

  constructor(
    private readonly http: HttpClient,
    private readonly appConfig: AppConfigService
  ) {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibility);
    }
  }

  ngOnDestroy(): void {
    this.stopTimer();
    this.cancelAllStatus();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
  }

  private readonly onVisibility = (): void => {
    if (typeof document === 'undefined') return;
    if (document.hidden) {
      // Free HTTP while tab hidden; resume on show.
      this.stopTimer();
      this.cancelAllStatus();
      return;
    }
    this.recoverActive();
    this.ensureTimer();
    this.refreshAllWatched();
  };

  /** Call from LogicsComponent.ngOnInit — idempotent. */
  attach(): void {
    this.recoverActive();
    this.ensureTimer();
  }

  watch(logicId: number): void {
    const id = Number(logicId);
    if (!Number.isFinite(id) || id <= 0) return;
    this.pollIds.add(id);
    this.expandTestBlocks.add(id);
    this.ensureTimer();
    this.refreshOne(id);
  }

  unwatch(logicId: number): void {
    const id = Number(logicId);
    this.pollIds.delete(id);
    this.statusSubs.get(id)?.unsubscribe();
    this.statusSubs.delete(id);
    if (this.pollIds.size === 0) this.stopTimer();
  }

  setRun(logicId: number, row: BacktestRunStatus | null): void {
    const id = Number(logicId);
    if (!row) {
      this.runs.delete(id);
      this.pollIds.delete(id);
      this.bump();
      return;
    }
    this.runs.set(id, this.mergeStickyOptFlag(id, row));
    const st = String(row.status ?? '').trim().toLowerCase();
    if (ACTIVE_STATUSES.has(st)) {
      this.pollIds.add(id);
      this.expandTestBlocks.add(id);
      this.ensureTimer();
    } else {
      this.pollIds.delete(id);
      // Finished/cancelled — stop forcing «Тестирование» open on remount.
      this.expandTestBlocks.delete(id);
      this.statusSubs.get(id)?.unsubscribe();
      this.statusSubs.delete(id);
    }
    this.bump();
  }

  /**
   * Keep lilac OPT color stable: /active used to omit opt_grid_enabled and
   * briefly overwrite a true flag → yellow flicker. Same run id sticky.
   */
  private mergeStickyOptFlag(
    logicId: number,
    row: BacktestRunStatus
  ): BacktestRunStatus {
    const prev = this.runs.get(logicId);
    const next: BacktestRunStatus = {
      ...row,
      opt_grid_enabled: !!row.opt_grid_enabled,
    };
    if (
      prev &&
      Number(prev.id) === Number(row.id) &&
      !!prev.opt_grid_enabled &&
      !next.opt_grid_enabled
    ) {
      next.opt_grid_enabled = true;
      if (prev.opt_grid_results != null && next.opt_grid_results == null) {
        next.opt_grid_results = prev.opt_grid_results;
      }
    }
    return next;
  }

  isRunning(logicId: number): boolean {
    const s = String(this.runs.get(Number(logicId))?.status ?? '')
      .trim()
      .toLowerCase();
    return ACTIVE_STATUSES.has(s);
  }

  /** Tick for templates — changes when any run map updates. */
  get uiTick(): number {
    return this.bump$.value;
  }

  recoverActive(): void {
    if (this.recovering) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    this.recovering = true;
    this.http
      .get<{ rows: BacktestRunStatus[] }>(
        `${this.appConfig.apiUrl}/logic-backtest/active`
      )
      .subscribe({
        next: (resp) => {
          this.recovering = false;
          for (const row of resp?.rows ?? []) {
            const logicId = Number(row.logic_id);
            if (!Number.isFinite(logicId) || logicId <= 0) continue;
            this.runs.set(logicId, this.mergeStickyOptFlag(logicId, row));
            this.pollIds.add(logicId);
            this.expandTestBlocks.add(logicId);
          }
          this.ensureTimer();
          this.bump();
        },
        error: () => {
          this.recovering = false;
        },
      });
  }

  private ensureTimer(): void {
    if (this.timer != null) return;
    if (this.pollIds.size === 0) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    this.timer = setInterval(() => this.refreshAllWatched(), POLL_MS);
  }

  private stopTimer(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private cancelAllStatus(): void {
    for (const sub of this.statusSubs.values()) {
      sub.unsubscribe();
    }
    this.statusSubs.clear();
  }

  private refreshAllWatched(): void {
    if (typeof document !== 'undefined' && document.hidden) {
      this.stopTimer();
      return;
    }
    if (this.pollIds.size === 0) {
      this.stopTimer();
      return;
    }
    for (const logicId of [...this.pollIds]) {
      this.refreshOne(logicId);
    }
  }

  private refreshOne(logicId: number): void {
    this.statusSubs.get(logicId)?.unsubscribe();
    const sub = this.http
      .get<BacktestRunStatus>(`${this.appConfig.apiUrl}/logic-backtest/status`, {
        params: { logic_id: String(logicId) },
      })
      .subscribe({
        next: (row) => {
          this.statusSubs.delete(logicId);
          if (!row) {
            this.runs.delete(logicId);
            this.pollIds.delete(logicId);
            this.bump();
            return;
          }
          this.setRun(logicId, row);
        },
        error: () => {
          this.statusSubs.delete(logicId);
          /* keep last known; next tick retries */
        },
      });
    this.statusSubs.set(logicId, sub);
  }

  private bump(): void {
    this.bump$.next(this.bump$.value + 1);
  }
}
