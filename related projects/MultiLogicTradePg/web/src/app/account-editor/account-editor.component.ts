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
import {
  AccountConnectionPreview,
  AccountPayload,
  AccountRow,
  BrokerRow,
  TbankApiAccount,
} from '../models/lookup.model';
import { SecretTokenFieldComponent } from '../shared/secret-token-field/secret-token-field.component';

export type AccountEditorMode = 'add' | 'edit';

@Component({
  selector: 'app-account-editor',
  standalone: true,
  imports: [CommonModule, FormsModule, SecretTokenFieldComponent],
  templateUrl: './account-editor.component.html',
  styleUrls: ['../shared/dialog-form.css', './account-editor.component.css'],
})
export class AccountEditorComponent implements OnChanges {
  @Input() open = false;
  @Input() mode: AccountEditorMode = 'add';
  @Input() account: AccountRow | null = null;

  @Output() closed = new EventEmitter<void>();
  @Output() saved = new EventEmitter<void>();

  brokers: BrokerRow[] = [];
  brokerId: number | null = null;
  accountCode = '';
  name = '';
  accountType: 'real' | 'fake' = 'fake';
  isEfficient = false;
  isActive = true;
  apiToken = '';
  hasStoredToken = false;
  tbankAccounts: TbankApiAccount[] = [];
  connectionVerified = false;

  loading = false;
  saving = false;
  testing = false;
  error: string | null = null;
  preview: AccountConnectionPreview | null = null;

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
    return this.mode === 'add' ? 'Новый счёт' : 'Редактирование счёта';
  }

  get isRealTbank(): boolean {
    return this.accountType === 'real';
  }

  close(): void {
    if (!this.saving) this.closed.emit();
  }

  onAccountTypeChange(): void {
    this.preview = null;
    this.connectionVerified = false;
    this.tbankAccounts = [];
    if (this.isRealTbank) {
      this.applyTbankBrokerDefault();
    }
  }

  onTbankAccountPick(accountId: string): void {
    this.accountCode = accountId;
    const acc = this.tbankAccounts.find((a) => a.id === accountId);
    if (acc?.name && !this.name.trim()) {
      this.name = acc.name;
    }
  }

  testConnection(): void {
    this.error = null;
    this.preview = null;
    this.connectionVerified = false;
    if (!this.apiToken.trim() && !this.hasStoredToken) {
      this.error = 'Укажите API-токен T-Bank';
      return;
    }
    this.ensureTbankBroker();
    if (this.brokerId == null) {
      this.error = 'Брокер T-Bank не найден в справочнике';
      return;
    }
    this.testing = true;
    this.refs
      .previewAccountConnection({
        broker_id: this.brokerId,
        account_code: this.accountCode.trim() || undefined,
        api_token: this.apiToken.trim() || undefined,
        account_id: this.mode === 'edit' ? this.account?.id : undefined,
      })
      .subscribe({
        next: (result) => {
          this.testing = false;
          this.preview = result;
          this.connectionVerified = true;
          this.tbankAccounts = result.accounts ?? [];
          if (result.selected_account_id) {
            this.accountCode = result.selected_account_id;
          }
          if (result.selected_account_name && !this.name.trim()) {
            this.name = result.selected_account_name;
          }
        },
        error: (err) => {
          this.testing = false;
          this.error = apiErrorMessage(
            this.appConfig.apiUrl,
            err,
            'Не удалось проверить подключение'
          );
        },
      });
  }

  save(): void {
    this.error = null;
    this.ensureTbankBroker();

    if (this.isRealTbank) {
      if (!this.apiToken.trim() && !this.hasStoredToken) {
        this.error = 'Укажите API-токен T-Bank';
        return;
      }
    } else {
      if (this.brokerId == null) {
        this.error = 'Выберите брокера';
        return;
      }
      if (!this.accountCode.trim() || !this.name.trim()) {
        this.error = 'Заполните код и название счёта';
        return;
      }
    }

    if (this.brokerId == null) {
      this.error = 'Брокер T-Bank не найден';
      return;
    }

    const payload: AccountPayload = {
      broker_id: this.brokerId,
      account_code: this.accountCode.trim(),
      name: this.name.trim(),
      account_type: this.accountType,
      is_efficient: this.isEfficient,
      is_active: this.isActive,
    };
    if (this.apiToken.trim()) {
      payload.api_token = this.apiToken.trim();
    }

    this.saving = true;
    const req =
      this.mode === 'add'
        ? this.refs.createAccount(payload)
        : this.refs.updateAccount(this.account!.id, payload);
    req.subscribe({
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
          'Не удалось сохранить счёт'
        );
      },
    });
  }

  private initForm(): void {
    this.error = null;
    this.preview = null;
    this.connectionVerified = false;
    this.tbankAccounts = [];
    this.saving = false;
    this.apiToken = '';
    this.loading = true;

    if (this.mode === 'edit' && this.account) {
      this.brokerId = this.account.broker_id;
      this.accountCode = this.account.account_code;
      this.name = this.account.name;
      this.accountType = this.account.account_type;
      this.isEfficient = this.account.is_efficient;
      this.isActive = this.account.is_active;
      this.hasStoredToken = this.account.has_token;
      this.connectionVerified = this.account.has_token;
    } else {
      this.brokerId = null;
      this.accountCode = '';
      this.name = '';
      this.accountType = 'fake';
      this.isEfficient = false;
      this.isActive = true;
      this.hasStoredToken = false;
    }

    this.refs.getBrokers().subscribe({
      next: (brokers) => {
        this.brokers = brokers;
        this.loading = false;
        if (this.isRealTbank) {
          this.applyTbankBrokerDefault();
        } else if (this.mode === 'add' && this.brokerId == null && brokers.length > 0) {
          this.brokerId = brokers[0].id;
        }
      },
      error: () => {
        this.loading = false;
        this.error = 'Не удалось загрузить список брокеров';
      },
    });
  }

  private applyTbankBrokerDefault(): void {
    const tbank = this.brokers.find((b) => b.code === 'T-BANK');
    if (tbank) {
      this.brokerId = tbank.id;
    }
  }

  private ensureTbankBroker(): void {
    if (this.isRealTbank) {
      this.applyTbankBrokerDefault();
    }
  }
}
