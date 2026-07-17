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
import { SecuritiesService } from '../services/securities.service';
import { AppConfigService, apiErrorMessage } from '../services/app-config.service';
import { SecurityPayload } from '../models/market.model';

@Component({
  selector: 'app-security-editor',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './security-editor.component.html',
  styleUrls: ['../shared/dialog-form.css', './security-editor.component.css'],
})
export class SecurityEditorComponent implements OnChanges {
  @Input() open = false;
  @Input() kind: 'stock' | 'futures' = 'stock';
  @Input() exchangeId = 0;
  @Input() exchangeName = '';

  @Output() closed = new EventEmitter<void>();
  @Output() saved = new EventEmitter<void>();

  name = '';
  prefix = '';
  saving = false;
  error: string | null = null;

  constructor(
    private readonly securities: SecuritiesService,
    private readonly appConfig: AppConfigService
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['open']?.currentValue === true) {
      this.initForm();
    }
  }

  get title(): string {
    return this.kind === 'futures' ? 'Новый фьючерс' : 'Новая акция';
  }

  get kindLabel(): string {
    return this.kind === 'futures' ? 'Фьючерс' : 'Акция';
  }

  close(): void {
    if (!this.saving) this.closed.emit();
  }

  save(): void {
    this.error = null;
    const payload: SecurityPayload = {
      name: this.name.trim(),
      prefix: this.prefix.trim(),
      exchange_id: this.exchangeId,
      kind: this.kind,
    };
    if (!payload.name || !payload.prefix) {
      this.error = 'Заполните название и тикер';
      return;
    }
    if (!payload.exchange_id) {
      this.error = 'Не выбрана торговая площадка';
      return;
    }
    this.saving = true;
    this.securities.createSecurity(payload).subscribe({
      next: () => {
        this.saving = false;
        this.saved.emit();
        this.closed.emit();
      },
      error: (err) => {
        this.saving = false;
        this.error = apiErrorMessage(
          this.appConfig.apiUrl,
          err,
          'Не удалось сохранить бумагу'
        );
      },
    });
  }

  private initForm(): void {
    this.error = null;
    this.saving = false;
    this.name = '';
    this.prefix = '';
  }
}
