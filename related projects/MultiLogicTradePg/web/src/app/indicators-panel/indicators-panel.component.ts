import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReferencesService } from '../services/references.service';
import { IndicatorRow } from '../models/lookup.model';
import {
  AppConfigService,
  logicsLoadErrorMessage,
} from '../services/app-config.service';
import { IndicatorEditorComponent } from '../indicator-editor/indicator-editor.component';

@Component({
  selector: 'app-indicators-panel',
  standalone: true,
  imports: [CommonModule, IndicatorEditorComponent],
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
  ratingSortDir: 'none' | 'desc' | 'asc' = 'none';

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

  ratingText(row: IndicatorRow): string {
    if (row.rating === null || row.rating === undefined) return '—';
    return Number(row.rating).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
  }

  ratingTooltip(row: IndicatorRow): string {
    if (row.rating === null || row.rating === undefined) {
      return 'Рейтинг не рассчитан (индикатор используется логикой или ещё не тестировался)';
    }
    const parts: string[] = [];
    const side = row.best_position_side ? IndicatorsPanelComponent.SIDE_LABEL[row.best_position_side] : null;
    const kind = row.best_signal_kind ? IndicatorsPanelComponent.KIND_LABEL[row.best_signal_kind] : null;
    const time = row.best_time_kind ? IndicatorsPanelComponent.TIME_LABEL[row.best_time_kind] : null;
    if (side || kind || time) {
      parts.push(`Лучший разрез: ${[side, kind, time].filter(Boolean).join(', ')}`);
    }
    if (row.samples_count != null) parts.push(`сигналов: ${row.samples_count}`);
    if (row.computed_at) parts.push(`рассчитано: ${new Date(row.computed_at).toLocaleString('ru-RU')}`);
    parts.push('Рейтинг: средний % годовых до лучшей точки среди загруженных свечей');
    return parts.join('\n');
  }

  toggleRatingSort(): void {
    this.ratingSortDir =
      this.ratingSortDir === 'none' ? 'desc' : this.ratingSortDir === 'desc' ? 'asc' : 'none';
    const dir = this.ratingSortDir === 'desc' ? -1 : this.ratingSortDir === 'asc' ? 1 : 0;
    this.indicators = [...this.indicators].sort((a, b) => {
      if (dir !== 0) {
        const av = a.rating ?? null;
        const bv = b.rating ?? null;
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
