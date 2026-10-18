import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReferencesService } from '../services/references.service';
import {
  AccountRow,
  CreateLogicOptionGroup,
  CreateLogicOptionIndicator,
  CreateLogicOptionsResponse,
  CreatedLogicResult,
} from '../models/lookup.model';
import {
  BuilderSelection,
  BuilderSelectionMap,
  buildCreateLogicsPayload,
  buildLogicNamePreview,
  countSelectedGroups,
  emptySelection,
  selectionKey,
} from './logic-builder.util';

/**
 * #1006: форма «Создать логику из лучших рейтингов». Список ТФ с рассчитанным
 * рейтингом; под каждым — лучшие индикаторы (лучший разрез). У строки две галочки:
 * открытие/закрытие. По сохранению на каждый задействованный ТФ создаётся логика
 * с сигналами открытия (условие разреза) и закрытия (противоположное условие),
 * к которой привязываются все бумаги универсума расчёта.
 */
@Component({
  selector: 'app-indicator-logic-builder',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './indicator-logic-builder.component.html',
  styleUrls: ['../shared/dialog-form.css', './indicator-logic-builder.component.css'],
})
export class IndicatorLogicBuilderComponent implements OnChanges {
  @Input() open = false;

  @Output() closed = new EventEmitter<void>();
  @Output() created = new EventEmitter<CreatedLogicResult[]>();

  loading = false;
  saving = false;
  error: string | null = null;

  options: CreateLogicOptionsResponse | null = null;
  accounts: AccountRow[] = [];
  accountId: number | null = null;
  selection: BuilderSelectionMap = {};
  collapsed = new Set<number>();
  results: CreatedLogicResult[] | null = null;

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

  constructor(private readonly refs: ReferencesService) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['open']) {
      if (this.open) {
        this.load();
      } else {
        this.reset();
      }
    }
  }

  get groups(): CreateLogicOptionGroup[] {
    return this.options?.groups ?? [];
  }

  get hasOptions(): boolean {
    return this.groups.length > 0;
  }

  get selectionSummary(): { groups: number; indicators: number } {
    return countSelectedGroups(this.groups, this.selection);
  }

  get canSave(): boolean {
    return (
      !this.saving &&
      this.accountId != null &&
      this.selectionSummary.indicators > 0
    );
  }

  load(): void {
    this.loading = true;
    this.error = null;
    this.results = null;
    this.collapsed.clear();
    this.selection = {};
    this.options = null;

    this.refs.getCreateLogicOptions().subscribe({
      next: (res) => {
        this.options = res;
        this.selection = emptySelection(res);
        this.loading = false;
      },
      error: (err) => {
        this.loading = false;
        this.error = this.errorMessage(err, 'Не удалось загрузить список индикаторов рейтинга');
      },
    });

    this.refs.getAccounts().subscribe({
      next: (rows) => {
        this.accounts = rows;
        if (this.accountId == null && rows.length > 0) {
          // По умолчанию — фейковый (демо) счёт, если он есть: торговля на реальном
          // счёте сразу после создания логики была бы опасной.
          const preferred = rows.find((a) => a.account_type === 'fake') ?? rows[0];
          this.accountId = preferred.id;
        }
      },
      error: () => {
        /* список счетов необязателен для показа опций */
      },
    });
  }

  reset(): void {
    this.options = null;
    this.selection = {};
    this.collapsed.clear();
    this.results = null;
    this.error = null;
    this.saving = false;
  }

  onAccountChange(event: Event): void {
    const raw = (event.target as HTMLSelectElement).value;
    const value = Number(raw);
    this.accountId = Number.isFinite(value) && value > 0 ? value : null;
  }

  isCollapsed(timeframeId: number): boolean {
    return this.collapsed.has(timeframeId);
  }

  toggleCollapse(timeframeId: number): void {
    if (this.collapsed.has(timeframeId)) {
      this.collapsed.delete(timeframeId);
    } else {
      this.collapsed.add(timeframeId);
    }
  }

  isOpen(ind: CreateLogicOptionIndicator, timeframeId: number): boolean {
    return this.selection[selectionKey(timeframeId, ind.indicator_id)]?.open ?? false;
  }

  isClose(ind: CreateLogicOptionIndicator, timeframeId: number): boolean {
    return this.selection[selectionKey(timeframeId, ind.indicator_id)]?.close ?? false;
  }

  toggle(ind: CreateLogicOptionIndicator, timeframeId: number, field: keyof BuilderSelection): void {
    const key = selectionKey(timeframeId, ind.indicator_id);
    const sel = this.selection[key] ?? { open: false, close: false };
    this.selection = { ...this.selection, [key]: { ...sel, [field]: !sel[field] } };
  }

  groupSelectedCount(timeframeId: number): number {
    const group = this.groups.find((g) => g.timeframe_id === timeframeId);
    if (!group) return 0;
    let count = 0;
    for (const ind of group.indicators) {
      const sel = this.selection[selectionKey(timeframeId, ind.indicator_id)];
      if (sel && (sel.open || sel.close)) count += 1;
    }
    return count;
  }

  namePreview(group: CreateLogicOptionGroup): string {
    const items = group.indicators.map((ind) => ({
      code: ind.code,
      open: this.isOpen(ind, group.timeframe_id),
      close: this.isClose(ind, group.timeframe_id),
    }));
    const preview = buildLogicNamePreview(group.tf ?? group.full_name, items);
    return preview || `Логика ${group.tf ?? ''}`.trim();
  }

  save(): void {
    if (!this.canSave || this.accountId == null) return;
    this.saving = true;
    this.error = null;
    const payload = buildCreateLogicsPayload(this.accountId, this.groups, this.selection);
    this.refs.createLogicsFromRating(payload).subscribe({
      next: (res) => {
        this.saving = false;
        this.results = res.created ?? [];
        this.created.emit(this.results);
      },
      error: (err) => {
        this.saving = false;
        this.error = this.errorMessage(err, 'Не удалось создать логики');
      },
    });
  }

  close(): void {
    this.closed.emit();
  }

  sideLabel(value?: string | null): string {
    return value ? IndicatorLogicBuilderComponent.SIDE_LABEL[value] ?? value : '';
  }

  kindLabel(value?: string | null): string {
    return value ? IndicatorLogicBuilderComponent.KIND_LABEL[value] ?? value : '';
  }

  timeLabel(value?: string | null): string {
    return value ? IndicatorLogicBuilderComponent.TIME_LABEL[value] ?? value : '';
  }

  sliceLabel(ind: CreateLogicOptionIndicator): string {
    const parts = [
      this.sideLabel(ind.position_side),
      this.kindLabel(ind.signal_kind),
      this.timeLabel(ind.time_kind),
    ].filter(Boolean);
    return parts.length ? parts.join(', ') : '—';
  }

  ratingText(ind: CreateLogicOptionIndicator): string {
    if (ind.rating == null) return '—';
    return Number(ind.rating).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
  }

  accountLabel(account: AccountRow): string {
    const base = `${account.name}${account.broker_name ? ' · ' + account.broker_name : ''}`;
    return account.account_type === 'fake' ? `${base} (демо)` : base;
  }

  private errorMessage(err: unknown, fallback: string): string {
    const anyErr = err as { error?: { error?: string }; message?: string };
    return anyErr?.error?.error || anyErr?.message || fallback;
  }
}
