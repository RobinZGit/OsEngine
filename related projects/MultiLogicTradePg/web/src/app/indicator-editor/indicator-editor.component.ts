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
  formulaHelpDetail = '';

  code = '';
  name = '';
  description = '';
  category = '';
  script = '';
  formula = '';
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
    if (
      this.open &&
      (changes['indicator'] || changes['createMode'])
    ) {
      this.initForm();
    }
  }

  get isCreate(): boolean {
    return this.createMode || this.indicator === null;
  }

  get isCustom(): boolean {
    return this.isCreate || Boolean(this.indicator?.is_custom);
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
    const payload: IndicatorCreatePayload = {
      code: this.code.trim().toUpperCase(),
      name: this.name.trim(),
      description: this.description.trim() || null,
      category: this.category.trim() || null,
      formula: this.formula.trim(),
      is_active: this.isActive,
    };
    if (!payload.code) {
      this.error = 'Заполните код индикатора';
      return;
    }
    if (!/^[A-Z][A-Z0-9_]{0,19}$/.test(payload.code)) {
      this.error = 'Код: латиница A–Z, цифры и _, до 20 символов, начинается с буквы';
      return;
    }
    if (!payload.name) {
      this.error = 'Заполните название';
      return;
    }
    if (!payload.formula) {
      this.error = 'Заполните формулу';
      return;
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
      payload.formula = this.formula.trim() || null;
      if (!payload.formula) {
        this.error = 'Заполните формулу';
        return;
      }
    }
    if (!payload.name) {
      this.error = 'Заполните название';
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
      this.isActive = this.indicator.is_active;
      const types = this.indicator.value_types ?? [];
      this.seriesSummary = types.map((t) => t.code).join(', ');
    }
  }
}
