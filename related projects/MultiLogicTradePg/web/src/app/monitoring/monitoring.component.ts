import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import {
  ErrorLevel,
  ErrorLogRow,
  MonitoringService,
  MonitoringSummary,
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
      default:
        return 'ошибка';
    }
  }

  private load(silent = false): void {
    if (!silent) this.loading = true;
    forkJoin({
      errors: this.monitoring.getErrors({ limit: LIST_LIMIT }),
      stats: this.monitoring.getStats(this.chartMinutes),
      summary: this.monitoring.getSummary(),
    }).subscribe({
      next: ({ errors, stats, summary }) => {
        this.errors = errors.rows ?? [];
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
