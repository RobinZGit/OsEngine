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
  logicsLoadErrorMessage,
} from '../services/app-config.service';
import { BrokerEditorComponent } from '../broker-editor/broker-editor.component';
import { ExchangeEditorComponent } from '../exchange-editor/exchange-editor.component';
import { AccountEditorComponent } from '../account-editor/account-editor.component';

type SectionKey = 'brokers' | 'exchanges' | 'accounts';

@Component({
  selector: 'app-references',
  standalone: true,
  imports: [
    CommonModule,
    BrokerEditorComponent,
    ExchangeEditorComponent,
    AccountEditorComponent,
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

  accountTypeLabel(type: string): string {
    return type === 'fake' ? 'фейковый' : 'реальный';
  }

  yesNo(value: boolean): string {
    return value ? 'да' : 'нет';
  }
}
