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
  IndicatorCreatePayload,
  IndicatorPayload,
  IndicatorRow,
} from '../models/lookup.model';
import {
  buildFullFormulaHelp,
  INDICATOR_FORMULA_HINT,
} from '../shared/indicator-formula-help';

type EditorCalcMode = 'formula' | 'js';

export const JS_INDICATOR_TEMPLATE = `function calc(ctx, params) {
  // ctx.bars({ count, timeframe?, ... }) -> объект цен p:
  //   p.n                 - число баров
  //   p.dt                - массив дат/времени баров
  //   p.open, p.high, p.low, p.close, p.volume - массивы OHLCV
  //   p.o, p.h, p.l, p.c, p.v, p.t            - алиасы массивов
  //   p.last / p.prev     - последний и предыдущий бар (объекты)
  //
  // params - произвольные параметры из @CODE(...) в формуле сигнала,
  //   например: params.period / params.bars (число свечей), params.tf (таймфрейм) и др.
  //   Пример вызова в сигнале: @MY_IND(period=20, tf='H1') > 0

  const count = Number(params.period ?? params.bars ?? params.count ?? 14);
  const p = ctx.bars({ count, timeframe: params.tf });

  if (!p || p.n < 2) return 0;

  // Пример: простая средняя цены закрытия (SMA)
  let sum = 0;
  for (let i = 0; i < p.n; i++) {
    sum += Number(p.close[i]);
  }
  const avg = sum / p.n;
  // return avg; // пример результата

  // здесь пишите код

  return 0; // по умолчанию 0 (верните число или null)
}
`;

@Component({
  selector: 'app-indicator-editor',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './indicator-editor.component.html',
  styleUrls: ['../shared/dialog-form.css', './indicator-editor.component.css'],
})
export class IndicatorEditorComponent implements OnChanges {
  @Input() open = false;
  @Input() indicator: IndicatorRow | null = null;
  /** true — создание нового пользовательского индикатора */
  @Input() createMode = false;

  @Output() closed = new EventEmitter<void>();
  @Output() saved = new EventEmitter<void>();

  readonly formulaHint = INDICATOR_FORMULA_HINT;
  readonly jsTemplate = JS_INDICATOR_TEMPLATE;
  formulaHelpDetail = '';

  code = '';
  name = '';
  description = '';
  category = '';
  script = '';
  formula = '';
  jsCode = '';
  calcMode: EditorCalcMode = 'formula';
  isActive = true;
  seriesSummary = '';
  formulaHelpOpen = false;
  saving = false;
  error: string | null = null;

  constructor(
    private readonly refs: ReferencesService,
    private readonly appConfig: AppConfigService
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['open']?.currentValue === true) {
      this.initForm();
      this.loadFormulaHelp();
    }
    if (this.open && (changes['indicator'] || changes['createMode'])) {
      this.initForm();
    }
  }

  get isCreate(): boolean {
    return this.createMode || this.indicator === null;
  }

  get isCustom(): boolean {
    return this.isCreate || Boolean(this.indicator?.is_custom);
  }

  get isJsMode(): boolean {
    if (this.isCreate) return this.calcMode === 'js';
    if (this.isCustom) {
      return (
        this.calcMode === 'js' ||
        this.indicator?.calc_kind === 'js' ||
        Boolean(this.indicator?.js_code)
      );
    }
    return false;
  }

  get title(): string {
    if (this.isCreate) return 'Новый индикатор';
    return `Редактирование: ${this.indicator?.code ?? ''}`;
  }

  close(): void {
    if (!this.saving) this.closed.emit();
  }

  toggleFormulaHelp(): void {
    this.formulaHelpOpen = !this.formulaHelpOpen;
  }

  setCalcMode(mode: EditorCalcMode): void {
    this.calcMode = mode;
    this.error = null;
    if (mode === 'js' && !this.jsCode.trim()) {
      this.jsCode = this.jsTemplate;
    }
  }

  save(): void {
    this.error = null;
    if (this.isCreate) {
      this.saveCreate();
      return;
    }
    this.saveEdit();
  }

  private loadFormulaHelp(): void {
    this.refs.getIndicators(false).subscribe({
      next: (rows) => {
        this.formulaHelpDetail = buildFullFormulaHelp(rows);
      },
      error: () => {
        this.formulaHelpDetail = buildFullFormulaHelp([]);
      },
    });
  }

  private saveCreate(): void {
    const isJs = this.calcMode === 'js';
    const payload: IndicatorCreatePayload = {
      code: this.code.trim().toUpperCase(),
      name: this.name.trim(),
      description: this.description.trim() || null,
      category: this.category.trim() || null,
      formula: isJs ? null : this.formula.trim(),
      js_code: isJs ? this.jsCode.trim() : null,
      calc_kind: isJs ? 'js' : 'poly_formula',
      is_active: this.isActive,
    };
    if (!payload.code) {
      this.error = 'Укажите код индикатора';
      return;
    }
    if (!/^[A-Z][A-Z0-9_]{0,19}$/.test(payload.code)) {
      this.error = 'Код: латиница A-Z, цифры и _, до 20 символов, начинается с буквы';
      return;
    }
    if (!payload.name) {
      this.error = 'Укажите название';
      return;
    }
    if (isJs) {
      if (!payload.js_code) {
        this.error = 'Укажите JS-код индикатора';
        return;
      }
    } else {
      if (!payload.formula) {
        this.error = 'Укажите формулу';
        return;
      }
    }
    this.saving = true;
    this.refs.createIndicator(payload).subscribe({
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
          'Не удалось создать индикатор'
        );
      },
    });
  }

  private saveEdit(): void {
    if (!this.indicator) {
      this.error = 'Индикатор не выбран';
      return;
    }
    const payload: IndicatorPayload = {
      name: this.name.trim(),
      description: this.description.trim() || null,
      category: this.category.trim() || null,
      script: this.script.trim() || null,
      is_active: this.isActive,
    };

    if (this.isCustom) {
      const editingJs =
        this.calcMode === 'js' ||
        this.indicator.calc_kind === 'js' ||
        Boolean(this.indicator.js_code);
      if (editingJs) {
        payload.calc_kind = 'js';
        payload.js_code = this.jsCode.trim() || null;
        payload.formula = null;
        if (!payload.js_code) {
          this.error = 'Укажите JS-код индикатора';
          return;
        }
      } else {
        payload.calc_kind = 'poly_formula';
        payload.formula = this.formula.trim() || null;
        payload.js_code = null;
        if (!payload.formula) {
          this.error = 'Укажите формулу';
          return;
        }
      }
    }

    if (!payload.name) {
      this.error = 'Укажите название';
      return;
    }
    this.saving = true;
    this.refs.updateIndicator(this.indicator.id, payload).subscribe({
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
          'Не удалось сохранить индикатор'
        );
      },
    });
  }

  private initForm(): void {
    this.error = null;
    this.saving = false;
    this.formulaHelpOpen = false;
    if (this.isCreate) {
      this.code = '';
      this.name = '';
      this.description = '';
      this.category = '';
      this.script = '';
      this.formula = '';
      this.jsCode = this.jsTemplate;
      this.calcMode = 'formula';
      this.isActive = true;
      this.seriesSummary = '';
      return;
    }
    if (this.indicator) {
      this.code = this.indicator.code;
      this.name = this.indicator.name;
      this.description = this.indicator.description || '';
      this.category = this.indicator.category || '';
      this.script = this.indicator.script || '';
      this.formula = this.indicator.formula || '';
      this.jsCode = this.indicator.js_code || '';
      this.isActive = this.indicator.is_active;
      const isJs =
        this.indicator.calc_kind === 'js' || Boolean(this.indicator.js_code);
      this.calcMode = isJs ? 'js' : 'formula';
      if (isJs && !this.jsCode.trim()) {
        this.jsCode = this.jsTemplate;
      }
      const types = this.indicator.value_types ?? [];
      this.seriesSummary = types.map((t) => t.code).join(', ');
    }
  }
}
