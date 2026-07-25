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
import { AccountRow, BondFundInfo, BuyBondsResult } from '../models/lookup.model';

@Component({
  selector: 'app-buy-bonds-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './buy-bonds-dialog.component.html',
  styleUrls: ['../shared/dialog-form.css', './buy-bonds-dialog.component.css'],
})
export class BuyBondsDialogComponent implements OnChanges {
  @Input() open = false;
  @Input() account: AccountRow | null = null;

  @Output() closed = new EventEmitter<void>();
  @Output() done = new EventEmitter<void>();

  funds: BondFundInfo[] = [];
  fundCode = 'TBRU';
  amountRub = '';
  loading = false;
  planning = false;
  executing = false;
  error: string | null = null;
  plan: BuyBondsResult | null = null;

  constructor(
    private readonly refs: ReferencesService,
    private readonly appConfig: AppConfigService
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['open']?.currentValue === true && this.account) {
      this.reset();
      this.bootstrap();
    }
  }

  get title(): string {
    const name = this.account?.name || this.account?.account_code || '';
    return name ? `Купить облигации — ${name}` : 'Купить облигации';
  }

  close(): void {
    if (!this.executing) this.closed.emit();
  }

  formatMoney(v: number | null | undefined): string {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    return new Intl.NumberFormat('ru-RU', {
      maximumFractionDigits: 2,
    }).format(Number(v));
  }

  buildPlan(): void {
    if (!this.account) return;
    this.planning = true;
    this.error = null;
    this.plan = null;
    const amount = this.amountRub.trim() === '' ? undefined : Number(this.amountRub.replace(',', '.'));
    this.refs
      .planBuyBonds(this.account.id, {
        fund_code: this.fundCode,
        amount_rub: amount,
      })
      .subscribe({
        next: (plan) => {
          this.plan = plan;
          this.planning = false;
          if (plan.cash_amount != null && this.amountRub.trim() === '') {
            this.amountRub = String(Math.floor(Number(plan.cash_amount)));
          }
        },
        error: (err) => {
          this.planning = false;
          this.error = apiErrorMessage(
            this.appConfig.apiUrl,
            err,
            'Не удалось построить план'
          );
        },
      });
  }

  confirmBuy(): void {
    if (!this.account || !this.plan?.buys?.length) return;
    if (
      !confirm(
        `Купить облигации на ~${this.formatMoney(this.plan.amount_planned)} ₽ ` +
          `(${this.plan.buy_count} выпусков) на счёте «${this.account.name}»?`
      )
    ) {
      return;
    }
    this.executing = true;
    this.error = null;
    const amount = this.amountRub.trim() === '' ? undefined : Number(this.amountRub.replace(',', '.'));
    this.refs
      .executeBuyBonds(this.account.id, {
        fund_code: this.fundCode,
        amount_rub: amount,
      })
      .subscribe({
        next: (result) => {
          this.executing = false;
          this.plan = result;
          if (result.error_count && result.error_count > 0) {
            this.error = `Часть заявок не прошла: ${result.error_count}. Успешно: ${result.placed_count ?? 0}.`;
          } else {
            alert(
              `Заявки выставлены: ${result.placed_count ?? 0} выпусков на ~${this.formatMoney(result.amount_planned)} ₽`
            );
            this.done.emit();
            this.closed.emit();
          }
        },
        error: (err) => {
          this.executing = false;
          this.error = apiErrorMessage(
            this.appConfig.apiUrl,
            err,
            'Не удалось выставить заявки'
          );
        },
      });
  }

  private reset(): void {
    this.fundCode = 'TBRU';
    this.amountRub = '';
    this.error = null;
    this.plan = null;
    this.planning = false;
    this.executing = false;
  }

  private bootstrap(): void {
    if (!this.account) return;
    this.loading = true;
    this.refs.getBondFunds().subscribe({
      next: (funds) => {
        this.funds = funds;
        if (funds.length && !funds.some((f) => f.code === this.fundCode)) {
          this.fundCode = funds[0].code;
        }
        const cash =
          this.account?.cash_amount ??
          (this.account?.balance != null ? this.account.balance : null);
        if (cash != null && Number.isFinite(Number(cash))) {
          this.amountRub = String(Math.floor(Number(cash)));
        }
        this.loading = false;
        this.buildPlan();
      },
      error: (err) => {
        this.loading = false;
        this.error = apiErrorMessage(
          this.appConfig.apiUrl,
          err,
          'Не удалось загрузить фонды'
        );
      },
    });
  }
}
