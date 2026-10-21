import {
  buildImportFailureModel,
  buildImportLocalErrorModel,
  buildImportSuccessModel,
} from './import-protocol';
import type { LogicImportResult } from '../services/logics.service';

describe('import-protocol', () => {
  it('success model counts created/updated and keeps protocol', () => {
    const result: LogicImportResult = {
      imported: [
        { id: 1, name: 'A', action: 'created' },
        { id: 2, name: 'B', action: 'updated' },
      ],
      warnings: [],
      errors: [],
      protocol: 'protocol text',
    };
    const model = buildImportSuccessModel(result);
    expect(model.ok).toBeTrue();
    expect(model.title).toBe('Импорт завершён');
    expect(model.summary[0]).toContain('Импортировано логик: 2');
    expect(model.summary[0]).toContain('создано: 1');
    expect(model.summary[0]).toContain('обновлено: 1');
    expect(model.protocol).toBe('protocol text');
  });

  it('success model reports errors and is not ok', () => {
    const model = buildImportSuccessModel({
      imported: [{ id: 1, name: 'A', action: 'created' }],
      errors: ['A: insert or update on table "logic_params"'],
      warnings: ['A: параметр foo пропущен'],
      protocol: 'p',
    });
    expect(model.ok).toBeFalse();
    expect(model.title).toBe('Импорт завершён с ошибками');
    expect(model.summary).toContain('Ошибок: 1');
    expect(model.errors.length).toBe(1);
    expect(model.warnings.length).toBe(1);
  });

  it('success model clips long warning lists', () => {
    const warnings = Array.from({ length: 20 }, (_, i) => `w${i}`);
    const model = buildImportSuccessModel({
      imported: [],
      warnings,
      errors: [],
      protocol: '',
    });
    expect(model.ok).toBeTrue();
    expect(model.warnings.length).toBe(13);
    expect(model.warnings[12]).toContain('ещё 8');
  });

  it('failure model keeps server protocol', () => {
    const model = buildImportFailureModel('bad import', 'proto');
    expect(model.ok).toBeFalse();
    expect(model.title).toBe('Импорт не выполнен');
    expect(model.errors).toEqual(['bad import']);
    expect(model.protocol).toBe('proto');
  });

  it('failure model falls back to detail lines', () => {
    const model = buildImportFailureModel('e', '', { code: '23503', constraint: 'fk' });
    expect(model.protocol).toContain('code: 23503');
    expect(model.protocol).toContain('constraint: fk');
  });

  it('local error model has no protocol', () => {
    const model = buildImportLocalErrorModel('Файл не является корректным JSON');
    expect(model.ok).toBeFalse();
    expect(model.protocol).toBe('');
    expect(model.errors).toEqual(['Файл не является корректным JSON']);
  });
});
