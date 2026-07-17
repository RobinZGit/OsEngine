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
import { BrokerPayload, BrokerRow } from '../models/lookup.model';

export type BrokerEditorMode = 'add' | 'edit';

@Component({
  selector: 'app-broker-editor',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './broker-editor.component.html',
  styleUrls: ['../shared/dialog-form.css'],
})
export class BrokerEditorComponent implements OnChanges {
  @Input() open = false;
  @Input() mode: BrokerEditorMode = 'add';
  @Input() broker: BrokerRow | null = null;

  @Output() closed = new EventEmitter<void>();
  @Output() saved = new EventEmitter<void>();

  code = '';
  name = '';
  apiUrl = '';
  isActive = true;
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
    return this.mode === 'add' ? 'Новый брокер' : 'Редактирование брокера';
  }

  close(): void {
    if (!this.saving) this.closed.emit();
  }

  save(): void {
    this.error = null;
    const payload: BrokerPayload = {
      code: this.code.trim(),
      name: this.name.trim(),
      api_url: this.apiUrl.trim() || null,
      is_active: this.isActive,
    };
    if (!payload.code || !payload.name) {
      this.error = 'Заполните код и название';
      return;
    }
    this.saving = true;
    const req =
      this.mode === 'add'
        ? this.refs.createBroker(payload)
        : this.refs.updateBroker(this.broker!.id, payload);
    req.subscribe({
      next: () => {
        this.saving = false;
        this.saved.emit();
        this.closed.emit();
      },
      error: (err) => {
        this.saving = false;
        this.error = apiErrorMessage(this.appConfig.apiUrl, err, 'Не удалось сохранить брокера');
      },
    });
  }

  private initForm(): void {
    this.error = null;
    this.saving = false;
    if (this.mode === 'edit' && this.broker) {
      this.code = this.broker.code;
      this.name = this.broker.name;
      this.apiUrl = this.broker.api_url || '';
      this.isActive = this.broker.is_active;
    } else {
      this.code = '';
      this.name = '';
      this.apiUrl = '';
      this.isActive = true;
    }
  }
}
