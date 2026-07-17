import {
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ReferencesService } from '../services/references.service';
import { AppConfigService, apiErrorMessage } from '../services/app-config.service';
import { ExchangePayload, ExchangeRow } from '../models/lookup.model';

export type ExchangeEditorMode = 'add' | 'edit';

@Component({
  selector: 'app-exchange-editor',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './exchange-editor.component.html',
  styleUrls: ['../shared/dialog-form.css'],
})
export class ExchangeEditorComponent implements OnChanges {
  @Input() open = false;
  @Input() mode: ExchangeEditorMode = 'add';
  @Input() exchange: ExchangeRow | null = null;

  @Output() closed = new EventEmitter<void>();
  @Output() saved = new EventEmitter<void>();

  name = '';
  saving = false;
  error: string | null = null;

  constructor(
    private readonly refs: ReferencesService,
    private readonly appConfig: AppConfigService
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['open']?.currentValue === true) {
      this.initForm();
    }
  }

  get title(): string {
    return this.mode === 'add' ? 'Новая площадка' : 'Редактирование площадки';
  }

  close(): void {
    if (!this.saving) this.closed.emit();
  }

  save(): void {
    this.error = null;
    const payload: ExchangePayload = { name: this.name.trim() };
    if (!payload.name) {
      this.error = 'Укажите название площадки';
      return;
    }
    this.saving = true;
    const req =
      this.mode === 'add'
        ? this.refs.createExchange(payload)
        : this.refs.updateExchange(this.exchange!.id, payload);
    req.subscribe({
      next: () => {
        this.saving = false;
        this.saved.emit();
        this.closed.emit();
      },
      error: (err) => {
        this.saving = false;
        this.error = apiErrorMessage(this.appConfig.apiUrl, err, 'Не удалось сохранить площадку');
      },
    });
  }

  private initForm(): void {
    this.error = null;
    this.saving = false;
    this.name = this.mode === 'edit' && this.exchange ? this.exchange.name : '';
  }
}
