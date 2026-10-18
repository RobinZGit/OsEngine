import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReferencesService } from '../services/references.service';
import {
  CreatedLogicResult,
  IndicatorRatingStatus,
  IndicatorRatingTimeframeRow,
  IndicatorRow,
} from '../models/lookup.model';
import {
  AppConfigService,
  logicsLoadErrorMessage,
} from '../services/app-config.service';
import { IndicatorEditorComponent } from '../indicator-editor/indicator-editor.component';
import { IndicatorInfoComponent } from '../indicator-info/indicator-info.component';
import { IndicatorLogicBuilderComponent } from '../indicator-logic-builder/indicator-logic-builder.component';

@Component({
  selector: 'app-indicators-panel',
  standalone: true,
  imports: [
    CommonModule,
    IndicatorEditorComponent,
    IndicatorInfoComponent,
    IndicatorLogicBuilderComponent,
  ],
  templateUrl: './indicators-panel.component.html',
  styleUrl: './indicators-panel.component.css',
})
export class IndicatorsPanelComponent implements OnInit {
  indicators: IndicatorRow[] = [];
  loading = true;
  error: string | null = null;

  editorOpen = false;
  editTarget: IndicatorRow | null = null;
  createMode = false;
  /** #1005: подробная справка по индикатору. */
  infoOpen = false;
  infoTarget: IndicatorRow | null = null;
  /** #1006: форма создания логик из лучших рейтинговых индикаторов. */
  logicBuilderOpen = false;
  /** #1006: последнее сообщение о создании логик (для ненавязчивой подсказки). */
  logicBuilderNote: string | null = null;
  ratingSortDir: 'none' | 'desc' | 'asc' = 'none';
  expandedId: number | null = null;
  /** #1005: статус последнего прогона расчёта рейтинга (ошибка на развороте). */
  ratingStatus: IndicatorRatingStatus | null = null;

  private static readonly SIDE_LABEL: Record<string, string> = {
    long: 'лонг',
    short: 'шорт',
  };
  private static readonly KIND_LABEL: Record<string, string> = {
    trend: 'тренд',
    counter: 'контр-тренд',
  };
  private static readonly TIME_LABEL: Record<string, string> = {
    workday_trade: 'будни, торги',
    workday_nontrade: 'будни, вне торгов',
    weekend_trade: 'выходные, торги',
    weekend_nontrade: 'выходные, вне торгов',
  };

  constructor(
    private readonly refs: ReferencesService,
    private readonly appConfig: AppConfigService
  ) {}

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading = true;
    this.refs.getIndicators(true).subscribe({
      next: (rows) => {
        this.indicators = rows;
        this.loading = false;
        this.error = null;
      },
      error: (err) => {
        this.loading = false;
        this.error = logicsLoadErrorMessage(this.appConfig.apiUrl, err);
      },
    });
    this.refs.getIndicatorRatingStatus().subscribe({
      next: (status) => {
        this.ratingStatus = status;
      },
      error: () => {
        this.ratingStatus = null;
      },
    });
  }

  openEdit(row: IndicatorRow): void {
    this.createMode = false;
    this.editTarget = row;
    this.editorOpen = true;
  }

  openCreate(): void {
    this.createMode = true;
    this.editTarget = null;
    this.editorOpen = true;
  }

  onEditorClosed(): void {
    this.editorOpen = false;
    this.createMode = false;
    this.editTarget = null;
  }

  /** #1005: открыть подробную справку по индикатору. */
  openInfo(row: IndicatorRow): void {
    this.infoTarget = row;
    this.infoOpen = true;
  }

  onInfoClosed(): void {
    this.infoOpen = false;
    this.infoTarget = null;
  }

  /** #1006: открыть форму создания логик из лучших рейтинговых индикаторов. */
  openLogicBuilder(): void {
    this.logicBuilderNote = null;
    this.logicBuilderOpen = true;
  }

  onLogicBuilderClosed(): void {
    this.logicBuilderOpen = false;
  }

  /** #1006: логики созданы — показать подсказку и обновить список логик на странице. */
  onLogicsCreated(created: CreatedLogicResult[]): void {
    this.logicBuilderNote = created.length
      ? `Создано логик: ${created.length} (${created.map((c) => c.name).join('; ')})`
      : 'Логики не созданы';
  }

  ratingText(row: IndicatorRow): string {
    const value = this.ratingValue(row);
    if (value === null) return '—';
    return value.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
  }

  /** #994-доработка: эффективный рейтинг (с учётом устаревания). */
  ratingValue(row: IndicatorRow): number | null {
    const value = row.rating_effective ?? row.rating;
    return value === null || value === undefined ? null : Number(value);
  }

  /** #994-доработка: максимум эффективного рейтинга среди видимых — база градиента. */
  get maxRating(): number {
    let max = 0;
    for (const row of this.indicators) {
      const value = this.ratingValue(row);
      if (value !== null && value > max) max = value;
    }
    return max;
  }

  /**
   * #994-доработка: цвет ячейки рейтинга пропорционален величине: самый
   * рейтинговый — насыщенный красно-коричневый, слабый — почти незаметный.
   */
  ratingStyle(row: IndicatorRow): Record<string, string> {
    return this.gradientStyle(this.ratingValue(row), this.maxRating);
  }

  tfRatingStyle(tf: IndicatorRatingTimeframeRow): Record<string, string> {
    const value = tf.rating_effective ?? tf.rating;
    return this.gradientStyle(value == null ? null : Number(value), this.maxRating);
  }

  private gradientStyle(value: number | null, max: number): Record<string, string> {
    if (value === null || !(max > 0)) return {};
    const t = Math.max(0, Math.min(1, value / max));
    const hue = 40 - 25 * t;
    const sat = Math.round(85 - 8 * t);
    const light = Math.round(94 - 50 * t);
    return {
      background: `hsl(${hue.toFixed(1)}, ${sat}%, ${light}%)`,
      color: light < 60 ? '#fff' : '#7c2d12',
      fontWeight: t >= 0.66 ? '600' : '500',
    };
  }

  toggleExpand(row: IndicatorRow): void {
    this.expandedId = this.expandedId === row.id ? null : row.id;
  }

  isExpanded(row: IndicatorRow): boolean {
    return this.expandedId === row.id;
  }

  sideLabel(value?: string | null): string {
    return value ? IndicatorsPanelComponent.SIDE_LABEL[value] ?? value : '';
  }

  kindLabel(value?: string | null): string {
    return value ? IndicatorsPanelComponent.KIND_LABEL[value] ?? value : '';
  }

  timeLabel(value?: string | null): string {
    return value ? IndicatorsPanelComponent.TIME_LABEL[value] ?? value : '';
  }

  bestSliceLabel(side?: string | null, kind?: string | null, time?: string | null): string {
    const parts = [this.sideLabel(side), this.kindLabel(kind), this.timeLabel(time)].filter(Boolean);
    return parts.length ? parts.join(', ') : '—';
  }

  formatPct(value?: number | null): string {
    if (value === null || value === undefined) return '—';
    return Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
  }

  formatInt(value?: number | null): string {
    if (value === null || value === undefined) return '—';
    return Number(value).toLocaleString('ru-RU');
  }

  formatDate(value?: string | null): string {
    if (!value) return '—';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('ru-RU');
  }

  decayNote(row: IndicatorRow): string {
    const hours = row.rating_decay_hours;
    if (!hours) return '';
    return `Рейтинг показан с учётом устаревания (гаснет за ${hours} ч с момента расчёта).`;
  }

  /** #1005: текст ошибки последнего прогона расчёта рейтинга (пусто, если ошибки нет). */
  ratingStatusError(): string {
    const status = this.ratingStatus;
    if (!status || status.ok) return '';
    return status.last_message?.trim() || 'неизвестная ошибка';
  }

  /** #1005: когда был последний прогон расчёта рейтинга. */
  ratingStatusWhen(): string {
    return this.formatDate(this.ratingStatus?.last_run_at ?? this.ratingStatus?.updated_at ?? null);
  }

  /** #1005: рассчитан ли для строки рейтинг (есть цифра, которую можно объяснить). */
  hasRating(row: IndicatorRow): boolean {
    return this.ratingValue(row) !== null;
  }

  ratingTooltip(row: IndicatorRow): string {
    const value = this.ratingValue(row);
    if (value === null) {
      return 'Рейтинг ещё не рассчитан (индикатор без движения на свежих данных или расчёт в очереди)';
    }
    const parts: string[] = [];
    const raw = row.rating;
    if (raw != null && Math.abs(Number(raw) - value) >= 0.05) {
      parts.push(`Сырой рейтинг: ${this.formatPct(Number(raw))} (${this.decayNote(row)})`);
    }
    if (row.best_position_side || row.best_signal_kind || row.best_time_kind) {
      parts.push(`Лучший разрез: ${this.bestSliceLabel(row.best_position_side, row.best_signal_kind, row.best_time_kind)}`);
    }
    if (row.rating_samples_count != null || row.samples_count != null) {
      parts.push(`сигналов: ${this.formatInt(row.rating_samples_count ?? row.samples_count)}`);
    }
    if (row.rating_computed_at ?? row.computed_at) {
      parts.push(`рассчитано: ${new Date((row.rating_computed_at ?? row.computed_at) as string).toLocaleString('ru-RU')}`);
    }
    parts.push('Нажмите на индикатор, чтобы раскрыть разбивку по таймфреймам');
    return parts.join('\n');
  }

  toggleRatingSort(): void {
    this.ratingSortDir =
      this.ratingSortDir === 'none' ? 'desc' : this.ratingSortDir === 'desc' ? 'asc' : 'none';
    const dir = this.ratingSortDir === 'desc' ? -1 : this.ratingSortDir === 'asc' ? 1 : 0;
    this.indicators = [...this.indicators].sort((a, b) => {
      if (dir !== 0) {
        const av = this.ratingValue(a);
        const bv = this.ratingValue(b);
        if (av !== bv) {
          if (av === null) return 1;
          if (bv === null) return -1;
          return av > bv ? dir : -dir;
        }
      }
      return a.code.localeCompare(b.code);
    });
  }

  descriptionPreview(description: string | null): string {
    if (!description) return '—';
    const oneLine = description.replace(/\s+/g, ' ').trim();
    return oneLine.length > 100 ? oneLine.slice(0, 97) + '…' : oneLine;
  }

  onDragStart(event: DragEvent, row: IndicatorRow): void {
    if (!event.dataTransfer) return;
    event.dataTransfer.setData('application/x-indicator-id', String(row.id));
    event.dataTransfer.setData('text/plain', row.code);
    event.dataTransfer.effectAllowed = 'copy';
    (event.target as HTMLElement)?.closest('tr')?.classList.add('dragging');
  }

  onDragEnd(): void {
    document.querySelectorAll('.indicator-draggable.dragging').forEach((el) => {
      el.classList.remove('dragging');
    });
  }
}
