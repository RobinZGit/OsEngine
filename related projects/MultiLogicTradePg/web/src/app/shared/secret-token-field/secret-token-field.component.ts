import {
  Component,
  forwardRef,
  Input,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  ControlValueAccessor,
  FormsModule,
  NG_VALUE_ACCESSOR,
} from '@angular/forms';

/**
 * Универсальное поле ввода секрета (API-токен и т.п.):
 * маскировка, показ/скрытие, подсказка если значение уже сохранено в БД.
 */
@Component({
  selector: 'app-secret-token-field',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './secret-token-field.component.html',
  styleUrl: './secret-token-field.component.css',
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => SecretTokenFieldComponent),
      multi: true,
    },
  ],
})
export class SecretTokenFieldComponent implements ControlValueAccessor {
  @Input() label = 'API-токен';
  @Input() placeholder = 'Вставьте токен брокера';
  @Input() hint = '';
  /** В БД уже есть сохранённый токен (не показываем его, только подсказку). */
  @Input() hasStoredToken = false;
  @Input() disabled = false;
  @Input() maxLength = 2048;

  value = '';
  visible = false;

  private onChange: (v: string) => void = () => {};
  private onTouched: () => void = () => {};

  writeValue(value: string | null): void {
    this.value = value ?? '';
  }

  registerOnChange(fn: (v: string) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled = isDisabled;
  }

  onInput(raw: string): void {
    this.value = raw;
    this.onChange(raw);
  }

  onBlur(): void {
    this.onTouched();
  }

  toggleVisible(): void {
    this.visible = !this.visible;
  }
}
