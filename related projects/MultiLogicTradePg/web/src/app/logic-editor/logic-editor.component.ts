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
import { forkJoin } from 'rxjs';
import { LookupService } from '../services/lookup.service';
import { LogicsService } from '../services/logics.service';
import { AppConfigService, apiErrorMessage } from '../services/app-config.service';
import { LogicRow } from '../models/logic.model';
import { AccountRow, BrokerRow } from '../models/lookup.model';

export type LogicEditorMode = 'add' | 'edit';

@Component({
  selector: 'app-logic-editor',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './logic-editor.component.html',
  styleUrl: './logic-editor.component.css',
})
export class LogicEditorComponent implements OnChanges {
  @Input() open = false;
  @Input() mode: LogicEditorMode = 'add';
  @Input() logic: LogicRow | null = null;

  @Output() closed = new EventEmitter<void>();
  @Output() saved = new EventEmitter<void>();

  brokers: BrokerRow[] = [];
  accounts: AccountRow[] = [];
  filteredAccounts: AccountRow[] = [];

  name = '';
  note = '';
  brokerId: number | null = null;
  accountId: number | null = null;
  isEnabled = true;

  loadingLookups = false;
  saving = false;
  error: string | null = null;

  constructor(
    private readonly lookupService: LookupService,
    private readonly logicsService: LogicsService,
    private readonly appConfig: AppConfigService
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['open']?.currentValue === true) {
      this.initForm();
    }
  }

  get title(): string {
    return this.mode === 'add' ? 'Новая логика' : 'Редактирование логики';
  }

  close(): void {
    if (this.saving) {
      return;
    }
    this.closed.emit();
  }

  onBrokerChange(): void {
    this.applyAccountFilter();
    if (
      this.accountId != null &&
      !this.filteredAccounts.some((a) => a.id === this.accountId)
    ) {
      this.accountId = this.filteredAccounts[0]?.id ?? null;
    }
  }

  save(): void {
    this.error = null;
    const trimmed = this.name.trim();
    if (!trimmed) {
      this.error = 'Укажите имя логики';
      return;
    }
    if (this.brokerId == null) {
      this.error = 'Выберите брокера';
      return;
    }
    if (this.accountId == null) {
      this.error = 'Выберите счёт';
      return;
    }

    // Смена счёта → очистка боевой истории/FINRES. Без подтверждения счёт не меняем.
    if (
      this.mode === 'edit' &&
      this.logic != null &&
      Number(this.accountId) !== Number(this.logic.account_id)
    ) {
      const ok = confirm(
        'Вы меняете счёт логики.\n\n' +
          'Будут очищены история боевых сделок и FINRES; остатки пересчитаются для нового счёта ' +
          '(как после выключения и включения логики).\n\n' +
          'Продолжить?'
      );
      if (!ok) {
        // Откат выбора счёта в форме — не сохраняем.
        this.accountId = this.logic.account_id;
        const acc = this.accounts.find((a) => a.id === this.accountId);
        if (acc) {
          this.brokerId = acc.broker_id;
          this.applyAccountFilter();
        }
        return;
      }
    }

    const payload = {
      name: trimmed,
      account_id: this.accountId,
      is_enabled: this.isEnabled,
      note: this.note.trim() || null,
    };

    this.saving = true;
    const req =
      this.mode === 'add'
        ? this.logicsService.createLogic(payload)
        : this.logicsService.updateLogic(this.logic!.id, payload);

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
          this.mode === 'add'
            ? 'Не удалось создать логику'
            : 'Не удалось сохранить изменения'
        );
      },
    });
  }

  accountTypeLabel(type: string): string {
    return type === 'fake' ? 'фейковый' : 'реальный';
  }

  private initForm(): void {
    this.error = null;
    this.saving = false;
    this.loadingLookups = true;

    if (this.mode === 'edit' && this.logic) {
      this.name = this.logic.name;
      this.note = this.logic.note ?? '';
      this.brokerId = this.logic.broker_id;
      this.accountId = this.logic.account_id;
      this.isEnabled = this.logic.is_enabled;
    } else {
      this.name = '';
      this.note = '';
      this.brokerId = null;
      this.accountId = null;
      this.isEnabled = true;
    }

    forkJoin({
      brokers: this.lookupService.getBrokers(),
      accounts: this.lookupService.getAccounts(),
    }).subscribe({
      next: ({ brokers, accounts }) => {
        this.brokers = brokers.filter((b) => b.is_active);
        this.accounts = accounts.filter((a) => a.is_active);
        this.loadingLookups = false;

        if (this.mode === 'add') {
          const fakeAccount = this.accounts.find((a) => a.account_type === 'fake');
          if (fakeAccount) {
            this.brokerId = fakeAccount.broker_id;
            this.accountId = fakeAccount.id;
          } else if (this.brokers.length > 0) {
            this.brokerId = this.brokers[0].id;
            this.applyAccountFilter();
            this.accountId = this.filteredAccounts[0]?.id ?? null;
          }
        }

        this.applyAccountFilter();
      },
      error: () => {
        this.loadingLookups = false;
        this.error =
          'Не удалось загрузить справочники брокеров и счетов. Проверьте API и PostgreSQL.';
      },
    });
  }

  private applyAccountFilter(): void {
    this.filteredAccounts =
      this.brokerId == null
        ? []
        : this.accounts.filter((a) => a.broker_id === this.brokerId);
  }
}
