import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, forkJoin, of } from 'rxjs';
import {
  DelayAlertRow,
  DbHangRow,
  ErrorLevel,
  ErrorLogRow,
  MonitoringHangs,
  MonitoringService,
  MonitoringSummary,
  PingResult,
  formatErrorShort,
} from '../services/monitoring.service';
import { ErrorTrendChartComponent, ErrorTrendPoint } from './error-trend-chart.component';
import { AppConfigService, apiErrorMessage } from '../services/app-config.service';

/** Период автообновления закладки (мс). */
const POLL_MS = 5000;
/** Окно графика отказов (минут). */
const CHART_MINUTES = 60;
/** Сколько последних ошибок запрашивать (свежие сверху). */
const LIST_LIMIT = 200;

@Component({
  selector: 'app-monitoring',
  standalone: true,
  imports: [CommonModule, FormsModule, ErrorTrendChartComponent],
  templateUrl: './monitoring.component.html',
  styleUrl: './monitoring.component.css',
})
export class MonitoringComponent implements OnInit, OnDestroy {
  errors: ErrorLogRow[] = [];
  chartPoints: ErrorTrendPoint[] = [];
  chartTotal = 0;
  summary: MonitoringSummary | null = null;
  readonly chartMinutes = CHART_MINUTES;
  readonly pollSeconds = POLL_MS / 1000;
  levelFilter: ErrorLevel | '' = '';
  lastUpdated: string | null = null;
  loadError: string | null = null;
  loading = false;
  /** Кнопка «Пинг»: идёт проверка / итог / ошибка запроса. */
  pingRunning = false;
  pingResult: PingResult | null = null;
  pingError: string | null = null;
  /** #1083: логики с большой задержкой исполнения. */
  delayAlerts: DelayAlertRow[] = [];
  readonly delayThresholdSec = 30;
  readonly delayWindowHours = 24;

  hangs: MonitoringHangs | null = null;
  readonly hangThresholdSec = 30;

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly monitoring: MonitoringService,
    private readonly appConfig: AppConfigService
  ) {}

  ngOnInit(): void {
    this.load();
    this.pollTimer = setInterval(() => this.load(true), POLL_MS);
  }

  ngOnDestroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  get visibleErrors(): ErrorLogRow[] {
    if (!this.levelFilter) return this.errors;
    return this.errors.filter((e) => e.level === this.levelFilter);
  }

  get emptyText(): string {
    if (this.loadError) return 'Нет связи с API';
    if (this.levelFilter) return 'Ошибок этого уровня нет';
    return 'Ошибок за последние сутки нет';
  }

  /** Последняя критичная (error/fatal) ошибка — для заголовка страницы. */
  get criticalText(): string {
    return formatErrorShort(this.summary?.latestCritical);
  }

  get criticalTitle(): string {
    const row = this.summary?.latestCritical;
    if (!row) return '';
    const when = new Date(row.created_at).toLocaleTimeString('ru-RU');
    return `${row.message} · ${when}`;
  }

  levelLabel(level: ErrorLevel): string {
    switch (level) {
      case 'warning':
        return 'предупреждение';
      case 'fatal':
        return 'критично';
      case 'success':
        return 'успех';
      default:
        return 'ошибка';
    }
  }

  /** Проверить все сервисы без торговли (кнопка «Пинг»). */
  runPing(): void {
    if (this.pingRunning) return;
    this.pingRunning = true;
    this.pingError = null;
    this.monitoring.ping().subscribe({
      next: (result) => {
        this.pingResult = result;
        this.pingRunning = false;
        // Обновляем журнал и сводку, чтобы результат и «свет» вкладки обновились сразу.
        this.load(true);
        this.monitoring.notifyRefresh();
      },
      error: (err) => {
        this.pingError = apiErrorMessage(this.appConfig.apiUrl, err);
        this.pingRunning = false;
      },
    });
  }

  pingCheckClass(ok: boolean): string {
    return ok ? 'ping-ok' : 'ping-fail';
  }

  hangKindLabel(kind: string): string {
    switch (kind) {
      case 'rating_test': return 'Тест рейтинга';
      case 'backtest': return 'Бэктест';
      case 'report': return 'Отчёт';
      case 'data_load': return 'Загрузка данных';
      case 'web_hang': return 'Web UI';
      case 'report_build': return 'Построение отчёта';
      default: return kind || 'Другое';
    }
  }

  hangDurationLabel(sec: number): string {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    if (s < 60) return `${s} с`;
    const m = Math.floor(s / 60);
    const rs = s % 60;
    if (m < 60) return `${m} мин ${rs} с`;
    const h = Math.floor(m / 60);
    return `${h} ч ${m % 60} мин`;
  }

  private load(silent = false): void {
    if (!silent) this.loading = true;
    forkJoin({
      errors: this.monitoring.getErrors({ limit: LIST_LIMIT }),
      stats: this.monitoring.getStats(this.chartMinutes),
      summary: this.monitoring.getSummary(),
      delay: this.monitoring.getDelayAlerts().pipe(catchError(() => of(null))),
      hangs: this.monitoring.getHangs(this.hangThresholdSec, 50).pipe(catchError(() => of(null))),
    }).subscribe({
      next: ({ errors, stats, summary, delay, hangs }) => {
        this.errors = errors.rows ?? [];
        this.delayAlerts = delay?.rows ?? [];
        this.hangs = hangs;
        this.chartPoints = (stats.rows ?? []).map((r) => ({
          t: Date.parse(r.ts),
          count: Number(r.count) || 0,
        }));
        this.chartTotal = stats.total ?? 0;
        this.summary = summary;
        this.lastUpdated = new Date().toLocaleTimeString('ru-RU');
        this.loadError = null;
        this.loading = false;
      },
      error: (err) => {
        this.loadError = apiErrorMessage(this.appConfig.apiUrl, err);
        this.loading = false;
      },
    });
  }
}
