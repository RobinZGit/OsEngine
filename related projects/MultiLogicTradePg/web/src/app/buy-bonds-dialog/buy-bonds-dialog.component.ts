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

/** Локальный fallback — форма доступна сразу, без ожидания API. */
const DEFAULT_FUNDS: BondFundInfo[] = [
  {
    code: 'TBRU',
    name: 'Т-Капитал Облигации (TBRU)',
    sources: [
      'https://porti.ru/etf/holders/MOEX:TBRU',
      'https://rusetfs.com/etf/RU000A1039N1',
    ],
  },
  {
    code: 'SBGB',
    name: 'Первая — Гос. облигации (SBGB)',
    sources: [
      'https://iss.moex.com/iss/statistics/engines/stock/markets/index/analytics/RGBITR.json',
      'https://porti.ru/etf/holders/MOEX:SBGB',
      'https://cbonds.ru/etf/208991/',
    ],
  },
  {
    code: 'OBLG',
    name: 'ВИМ — Российские облигации (OBLG, ex VTBB)',
    sources: [
      'https://iss.moex.com/iss/statistics/engines/stock/markets/index/analytics/RUCBTRNS.json',
      'https://porti.ru/etf/holders/MOEX:OBLG',
      'https://rusetfs.com/etf/RU000A1002S8',
    ],
  },
];

@Component({
  selector: 'app-buy-bonds-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './buy-bonds-dialog.component.html',
  styleUrls: ['./buy-bonds-dialog.component.css'],
})
export class BuyBondsDialogComponent implements OnChanges {
  @Input() open = false;
  @Input() account: AccountRow | null = null;

  @Output() closed = new EventEmitter<void>();
  @Output() done = new EventEmitter<void>();

  funds: BondFundInfo[] = [...DEFAULT_FUNDS];
  fundCode = 'TBRU';
  amountRub = '';
  fundsLoading = false;
  planning = false;
  executing = false;
  error: string | null = null;
  plan: BuyBondsResult | null = null;
  /** После успешного «Рассчитать» — «Купить» становится яркой. */
  planReady = false;

  constructor(
    private readonly refs: ReferencesService,
    private readonly appConfig: AppConfigService
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    const opened = changes['open']?.currentValue === true;
    const accountArrived =
      !!changes['account']?.currentValue && this.open === true;
    if ((opened || accountArrived) && this.account) {
      this.reset();
      this.bootstrap();
    }
  }

  get title(): string {
    const name = this.account?.name || this.account?.account_code || '';
    return name ? `Купить облигации — ${name}` : 'Купить облигации';
  }

  get selectedFund(): BondFundInfo | null {
    return this.funds.find((f) => f.code === this.fundCode) ?? null;
  }

  /** Подсказка по выбранному фонду и зеркалам состава. */
  fundHint(): string {
    const f = this.selectedFund;
    if (!f) {
      return 'Покупка отдельных выпусков по составу БПИФ, не паёв ETF. Порядок — от более доходных к менее.';
    }
    const mirrors = (f.sources?.length ? f.sources : f.source ? [f.source] : [])
      .slice(0, 3)
      .join(' · ');
    const live =
      this.plan?.fund_code === f.code && this.plan.holdings_live
        ? ' Состав обновлён с MOEX ISS.'
        : f.moex_index
          ? ' При расчёте состав пробуем взять с MOEX ISS (индекс), иначе — снимок в приложении.'
          : ' Состав — снимок в приложении (несколько зеркал ниже).';
    return (
      `${f.name}: покупка отдельных выпусков, не паёв ETF.` +
      live +
      (mirrors ? ` Источники: ${mirrors}` : '')
    );
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

  onAmountOrFundChange(): void {
    this.planReady = false;
  }

  buildPlan(): void {
    if (!this.account || this.planning || this.executing) return;
    this.planning = true;
    this.error = null;
    this.planReady = false;
    const amount =
      this.amountRub.trim() === ''
        ? undefined
        : Number(this.amountRub.replace(',', '.'));
    this.refs
      .planBuyBonds(this.account.id, {
        fund_code: this.fundCode,
        amount_rub: amount,
      })
      .subscribe({
        next: (plan) => {
          this.plan = plan;
          this.planning = false;
          this.planReady = true;
          if (plan.cash_amount != null && this.amountRub.trim() === '') {
            this.amountRub = String(Math.floor(Number(plan.cash_amount)));
          }
        },
        error: (err) => {
          this.planning = false;
          this.planReady = false;
          this.error = apiErrorMessage(
            this.appConfig.apiUrl,
            err,
            'Не удалось рассчитать план'
          );
        },
      });
  }

  confirmBuy(): void {
    if (!this.account || this.executing || !this.planReady) return;
    const planned = this.plan?.amount_planned ?? 0;
    const count = this.plan?.buy_count ?? 0;
    if (
      !confirm(
        count > 0
          ? `Купить облигации на ~${this.formatMoney(planned)} ₽ ` +
              `(${count} выпусков) на счёте «${this.account.name}»?`
          : `План пуст или без лотов. Всё равно попытаться выставить заявки на счёте «${this.account.name}»?`
      )
    ) {
      return;
    }
    this.executing = true;
    this.error = null;
    const amount =
      this.amountRub.trim() === ''
        ? undefined
        : Number(this.amountRub.replace(',', '.'));
    this.refs
      .executeBuyBonds(this.account.id, {
        fund_code: this.fundCode,
        amount_rub: amount,
      })
      .subscribe({
        next: (result) => {
          this.executing = false;
          this.plan = result;
          this.planReady = true;
          const placed = result.placed_count ?? 0;
          const failed = result.error_count ?? 0;
          if (failed > 0 || (result.errors?.length ?? 0) > 0) {
            this.error =
              `Готово с ошибками: успешно ${placed}, не удалось ${failed}. ` +
              `Подробности — в отчёте ниже.`;
          } else if (placed > 0) {
            alert(
              `Заявки выставлены: ${placed} выпусков на ~${this.formatMoney(result.amount_planned)} ₽`
            );
            this.done.emit();
            this.closed.emit();
          } else {
            this.error =
              'Заявок не выставлено (нечего купить или брокер отклонил). См. отчёт ниже.';
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
    this.planReady = false;
    this.planning = false;
    this.executing = false;
    this.fundsLoading = false;
    this.funds = [...DEFAULT_FUNDS];
  }

  private bootstrap(): void {
    if (!this.account) return;

    const cash =
      this.account.cash_amount ??
      (this.account.balance != null ? this.account.balance : null);
    if (cash != null && Number.isFinite(Number(cash)) && Number(cash) > 0) {
      this.amountRub = String(Math.floor(Number(cash)));
    }

    // Форма уже интерактивна; фонды подтягиваем в фоне.
    this.fundsLoading = true;
    this.refs.getBondFunds().subscribe({
      next: (funds) => {
        if (funds?.length) {
          this.funds = funds;
          if (!funds.some((f) => f.code === this.fundCode)) {
            this.fundCode = funds[0].code;
          }
        }
        this.fundsLoading = false;
      },
      error: (err) => {
        this.fundsLoading = false;
        // Локальные TBRU / SBGB / OBLG уже в списке — не блокируем UI.
        this.error = apiErrorMessage(
          this.appConfig.apiUrl,
          err,
          'Список фондов с API не загрузился — используем локальный каталог (TBRU, SBGB, OBLG)'
        );
      },
    });
  }
}
