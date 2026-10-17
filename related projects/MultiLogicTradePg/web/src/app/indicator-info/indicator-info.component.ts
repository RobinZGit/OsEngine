import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IndicatorRow } from '../models/lookup.model';
import { getIndicatorReference, IndicatorReference } from './indicator-reference';

/**
 * #1005: подробная справка по индикатору (иконка ℹ в строке списка).
 * Показывает описание, формулу расчёта, серии/параметры и применение в сигналах.
 */
@Component({
  selector: 'app-indicator-info',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './indicator-info.component.html',
  styleUrls: ['../shared/dialog-form.css', './indicator-info.component.css'],
})
export class IndicatorInfoComponent {
  @Input() open = false;
  @Input() indicator: IndicatorRow | null = null;

  @Output() closed = new EventEmitter<void>();

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
  private static readonly PROFILE_LABEL: Record<string, string> = {
    trend_line: 'линия тренда',
    oscillator: 'осциллятор',
    channel: 'канал',
    zero_line: 'около нуля',
    strength: 'сила тренда',
    volume: 'объём',
  };
  private static readonly SYSTEM_PARAMS = new Set([
    'security_id',
    'timeframe_id',
    'dt',
    'indicator_id',
  ]);

  get title(): string {
    const ind = this.indicator;
    if (!ind) return 'Индикатор';
    return `${ind.code} — ${ind.name}`;
  }

  get reference(): IndicatorReference | undefined {
    return getIndicatorReference(this.indicator?.code);
  }

  get valueTypes() {
    return (this.indicator?.value_types ?? []).filter((t) => !t.is_threshold);
  }

  get thresholds() {
    return (this.indicator?.value_types ?? []).filter((t) => t.is_threshold);
  }

  /** Пользовательские параметры, извлечённые из SQL-скрипта расчёта (`:param`). */
  get scriptParams(): string[] {
    const script = this.indicator?.script ?? '';
    const seen = new Set<string>();
    const re = /:([a-z_][a-z0-9_]*)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(script)) !== null) {
      const name = m[1].toLowerCase();
      if (!IndicatorInfoComponent.SYSTEM_PARAMS.has(name)) seen.add(name);
    }
    return [...seen];
  }

  get hasRating(): boolean {
    const ind = this.indicator;
    if (!ind) return false;
    return ind.rating != null || ind.rating_effective != null;
  }

  get ratingValue(): number | null {
    const ind = this.indicator;
    if (!ind) return null;
    const v = ind.rating_effective ?? ind.rating;
    return v == null ? null : Number(v);
  }

  get rawRating(): number | null {
    const ind = this.indicator;
    if (!ind || ind.rating == null) return null;
    return Number(ind.rating);
  }

  get hasSignals(): boolean {
    const ind = this.indicator;
    return Boolean(ind?.sig_trend_def || ind?.sig_ct_def);
  }

  get seriesRef(): string {
    const ind = this.indicator;
    if (!ind) return '';
    const refs = this.valueTypes.map((t) =>
      t.code === 'VALUE' || t.code === ind.code ? `@${ind.code}` : `@${ind.code}:${t.code}`
    );
    return refs.length ? refs.join(', ') : `@${ind.code}`;
  }

  close(): void {
    this.closed.emit();
  }

  sideLabel(value?: string | null): string {
    return value ? IndicatorInfoComponent.SIDE_LABEL[value] ?? value : '';
  }

  kindLabel(value?: string | null): string {
    return value ? IndicatorInfoComponent.KIND_LABEL[value] ?? value : '';
  }

  timeLabel(value?: string | null): string {
    return value ? IndicatorInfoComponent.TIME_LABEL[value] ?? value : '';
  }

  profileLabel(value?: string | null): string {
    return value ? IndicatorInfoComponent.PROFILE_LABEL[value] ?? value : '';
  }

  bestSliceLabel(side?: string | null, kind?: string | null, time?: string | null): string {
    const parts = [this.sideLabel(side), this.kindLabel(kind), this.timeLabel(time)].filter(
      Boolean
    );
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
    if (Number.isNaN(d.getTime())) return value;
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${dd}.${mm}.${d.getFullYear()}`;
  }
}
