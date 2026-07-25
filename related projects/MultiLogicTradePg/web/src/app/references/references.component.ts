import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { forkJoin } from 'rxjs';
import { ReferencesService } from '../services/references.service';
import {
  AccountRow,
  BrokerRow,
  ExchangeRow,
} from '../models/lookup.model';
import {
  AppConfigService,
  apiErrorMessage,
  logicsLoadErrorMessage,
} from '../services/app-config.service';
import { BrokerEditorComponent } from '../broker-editor/broker-editor.component';
import { ExchangeEditorComponent } from '../exchange-editor/exchange-editor.component';
import { AccountEditorComponent } from '../account-editor/account-editor.component';
import { BuyBondsDialogComponent } from '../buy-bonds-dialog/buy-bonds-dialog.component';

type SectionKey = 'brokers' | 'exchanges' | 'accounts';

@Component({
  selector: 'app-references',
  standalone: true,
  imports: [
    CommonModule,
    BrokerEditorComponent,
    ExchangeEditorComponent,
    AccountEditorComponent,
    BuyBondsDialogComponent,
  ],
  templateUrl: './references.component.html',
  styleUrl: './references.component.css',
})
export class ReferencesComponent implements OnInit {
  brokers: BrokerRow[] = [];
  exchanges: ExchangeRow[] = [];
  accounts: AccountRow[] = [];

  expanded = new Set<SectionKey>(['brokers']);
  loading = true;
  error: string | null = null;

  brokerEditorOpen = false;
  brokerEditorMode: 'add' | 'edit' = 'add';
  brokerEditTarget: BrokerRow | null = null;

  exchangeEditorOpen = false;
  exchangeEditorMode: 'add' | 'edit' = 'add';
  exchangeEditTarget: ExchangeRow | null = null;

  accountEditorOpen = false;
  accountEditorMode: 'add' | 'edit' = 'add';
  accountEditTarget: AccountRow | null = null;

  buyBondsOpen = false;
  buyBondsAccount: AccountRow | null = null;
  accountActionBusyId: number | null = null;

  constructor(
    private readonly refs: ReferencesService,
    private readonly appConfig: AppConfigService
  ) {}

  ngOnInit(): void {
    this.loadAll();
  }

  isExpanded(key: SectionKey): boolean {
    return this.expanded.has(key);
  }

  toggle(key: SectionKey): void {
    if (this.expanded.has(key)) {
      this.expanded.delete(key);
    } else {
      this.expanded.add(key);
    }
  }

  loadAll(): void {
    this.loading = true;
    forkJoin({
      brokers: this.refs.getBrokers(),
      exchanges: this.refs.getExchanges(),
      accounts: this.refs.getAccounts(undefined, true),
    }).subscribe({
      next: ({ brokers, exchanges, accounts }) => {
        this.brokers = brokers;
        this.exchanges = exchanges;
        this.accounts = accounts;
        this.loading = false;
        this.error = null;
      },
      error: (err) => {
        this.loading = false;
        this.error = logicsLoadErrorMessage(this.appConfig.apiUrl, err);
      },
    });
  }

  openAddBroker(): void {
    this.brokerEditorMode = 'add';
    this.brokerEditTarget = null;
    this.brokerEditorOpen = true;
  }

  openEditBroker(row: BrokerRow): void {
    this.brokerEditorMode = 'edit';
    this.brokerEditTarget = row;
    this.brokerEditorOpen = true;
  }

  deleteBroker(row: BrokerRow): void {
    if (!confirm(`Удалить брокера «${row.code}»?`)) return;
    this.refs.deleteBroker(row.id).subscribe({
      next: () => this.loadAll(),
      error: (err) => alert(err?.error?.error || 'Не удалось удалить'),
    });
  }

  openAddExchange(): void {
    this.exchangeEditorMode = 'add';
    this.exchangeEditTarget = null;
    this.exchangeEditorOpen = true;
  }

  openEditExchange(row: ExchangeRow): void {
    this.exchangeEditorMode = 'edit';
    this.exchangeEditTarget = row;
    this.exchangeEditorOpen = true;
  }

  deleteExchange(row: ExchangeRow): void {
    if (!confirm(`Удалить площадку «${row.name}»?`)) return;
    this.refs.deleteExchange(row.id).subscribe({
      next: () => this.loadAll(),
      error: (err) => alert(err?.error?.error || 'Не удалось удалить'),
    });
  }

  openAddAccount(): void {
    this.accountEditorMode = 'add';
    this.accountEditTarget = null;
    this.accountEditorOpen = true;
  }

  openEditAccount(row: AccountRow): void {
    this.accountEditorMode = 'edit';
    this.accountEditTarget = row;
    this.accountEditorOpen = true;
  }

  deleteAccount(row: AccountRow): void {
    if (!confirm(`Удалить счёт «${row.account_code}»?`)) return;
    this.refs.deleteAccount(row.id).subscribe({
      next: () => this.loadAll(),
      error: (err) => alert(err?.error?.error || 'Не удалось удалить'),
    });
  }

  /** Только real T-Bank. */
  sellAllOnAccount(row: AccountRow): void {
    if (row.account_type !== 'real' || row.broker_code !== 'T-BANK') return;
    if (
      !confirm(
        `Продать ВСЕ позиции на реальном счёте «${row.name}» (${row.account_code})?\n` +
          'Акции, облигации, фонды и прочие бумаги — лимитными заявками по текущей цене. Валюту не трогаем.'
      )
    ) {
      return;
    }
    this.accountActionBusyId = row.id;
    this.refs.sellAllOnAccount(row.id).subscribe({
      next: (r) => {
        this.accountActionBusyId = null;
        const sold = Number(r['sold_count'] ?? 0);
        const errors = Number(r['error_count'] ?? 0);
        alert(
          errors
            ? `Продажа: успешно ${sold}, ошибок ${errors}. Подробности в ответе API / логах.`
            : `Выставлено заявок на продажу: ${sold}.`
        );
        this.loadAll();
      },
      error: (err) => {
        this.accountActionBusyId = null;
        alert(
          apiErrorMessage(this.appConfig.apiUrl, err, 'Не удалось продать')
        );
      },
    });
  }

  openBuyBonds(row: AccountRow): void {
    if (row.account_type !== 'real' || row.broker_code !== 'T-BANK') return;
    this.buyBondsAccount = row;
    this.buyBondsOpen = true;
  }

  accountTypeLabel(type: string): string {
    return type === 'fake' ? 'фейковый' : 'реальный';
  }

  yesNo(value: boolean): string {
    return value ? 'да' : 'нет';
  }

  /** Короткая подпись ошибки остатка (полный текст — в title). */
  shortBalanceError(err: string | null | undefined): string {
    const s = String(err || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    return s.length > 48 ? `${s.slice(0, 46)}…` : s;
  }
}
