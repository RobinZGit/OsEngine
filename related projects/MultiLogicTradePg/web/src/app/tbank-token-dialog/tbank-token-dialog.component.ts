import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SettingsService } from '../services/settings.service';
import { AppConfigService, apiErrorMessage } from '../services/app-config.service';

@Component({
  selector: 'app-tbank-token-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './tbank-token-dialog.component.html',
  styleUrls: ['../shared/dialog-form.css', './tbank-token-dialog.component.css'],
})
export class TbankTokenDialogComponent {
  @Input() open = false;
  /** prices — загрузка цен; logic — включение торговли; trades — runner / сделки */
  @Input() context: 'prices' | 'logic' | 'trades' = 'prices';
  @Input() reason: 'missing' | 'invalid' = 'missing';
  @Output() saved = new EventEmitter<void>();
  @Output() cancelled = new EventEmitter<void>();

  token = '';
  saving = false;
  error: string | null = null;

  constructor(
    private readonly settings: SettingsService,
    private readonly appConfig: AppConfigService
  ) {}

  closeCancel(): void {
    if (!this.saving) {
      this.token = '';
      this.error = null;
      this.cancelled.emit();
    }
  }

  save(): void {
    this.error = null;
    const value = this.token.trim();
    if (!value) {
      this.error = 'Введите токен T-Bank';
      return;
    }
    this.saving = true;
    this.settings.saveTbankToken(value).subscribe({
      next: () => {
        this.saving = false;
        this.token = '';
        this.saved.emit();
      },
      error: (err) => {
        this.saving = false;
        this.error = apiErrorMessage(
          this.appConfig.apiUrl,
          err,
          'Не удалось сохранить токен'
        );
      },
    });
  }
}
