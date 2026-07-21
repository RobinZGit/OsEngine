/**
 * Survives Angular route changes (/operations → other tabs).
 * Keeps backtest yellow/progress/pnl maps alive and polls active runs in the background.
 */
import { Injectable, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable } from 'rxjs';
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
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
  }

  private readonly onVisibility = (): void => {
    if (typeof document !== 'undefined' && !document.hidden) {
      this.recoverActive();
      this.refreshAllWatched();
    }
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
    this.pollIds.delete(Number(logicId));
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
    this.runs.set(id, row);
    const st = String(row.status ?? '');
    if (ACTIVE_STATUSES.has(st)) {
      this.pollIds.add(id);
      this.expandTestBlocks.add(id);
      this.ensureTimer();
    } else {
      this.pollIds.delete(id);
    }
    this.bump();
  }

  isRunning(logicId: number): boolean {
    const s = this.runs.get(Number(logicId))?.status;
    return !!s && ACTIVE_STATUSES.has(String(s));
  }

  recoverActive(): void {
    if (this.recovering) return;
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
            this.runs.set(logicId, row);
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
    this.timer = setInterval(() => this.refreshAllWatched(), POLL_MS);
  }

  private stopTimer(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private refreshAllWatched(): void {
    if (this.pollIds.size === 0) {
      this.stopTimer();
      return;
    }
    for (const logicId of [...this.pollIds]) {
      this.refreshOne(logicId);
    }
  }

  private refreshOne(logicId: number): void {
    this.http
      .get<BacktestRunStatus>(`${this.appConfig.apiUrl}/logic-backtest/status`, {
        params: { logic_id: String(logicId) },
      })
      .subscribe({
        next: (row) => {
          if (!row) {
            this.runs.delete(logicId);
            this.pollIds.delete(logicId);
            this.bump();
            return;
          }
          this.setRun(logicId, row);
        },
        error: () => {
          /* keep last known; next tick retries */
        },
      });
  }

  private bump(): void {
    this.bump$.next(this.bump$.value + 1);
  }
}
