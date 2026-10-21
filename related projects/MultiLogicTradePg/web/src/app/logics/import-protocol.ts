import { LogicImportResult } from '../services/logics.service';

/** Model for the import-result dialog (summary + errors + full protocol). */
export interface ImportDialogModel {
  ok: boolean;
  title: string;
  summary: string[];
  errors: string[];
  warnings: string[];
  protocol: string;
}

const MAX_WARNINGS_IN_DIALOG = 12;

function clipWarnings(warnings: string[]): string[] {
  if (warnings.length <= MAX_WARNINGS_IN_DIALOG) return warnings;
  return [
    ...warnings.slice(0, MAX_WARNINGS_IN_DIALOG),
    `… ещё ${warnings.length - MAX_WARNINGS_IN_DIALOG} (полный список — в протоколе)`,
  ];
}

function formatDetail(detail: unknown): string {
  if (detail == null || detail === '') return '';
  if (typeof detail === 'string') return detail;
  if (typeof detail === 'object') {
    return Object.entries(detail as Record<string, unknown>)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join('\n');
  }
  return String(detail);
}

export function buildImportSuccessModel(result: LogicImportResult): ImportDialogModel {
  const imported = result?.imported || [];
  const errors = result?.errors || [];
  const warnings = result?.warnings || [];
  const created = imported.filter((r) => r.action === 'created').length;
  const updated = imported.filter((r) => r.action === 'updated').length;

  const summary: string[] = [
    `Импортировано логик: ${imported.length}` +
      (created ? ` · создано: ${created}` : '') +
      (updated ? ` · обновлено: ${updated}` : ''),
  ];
  if (errors.length) summary.push(`Ошибок: ${errors.length}`);
  if (warnings.length) summary.push(`Предупреждений: ${warnings.length}`);

  const ok = errors.length === 0;
  let title = 'Импорт завершён';
  if (!ok) title = 'Импорт завершён с ошибками';
  else if (warnings.length) title = 'Импорт завершён с предупреждениями';

  return {
    ok,
    title,
    summary,
    errors: [...errors],
    warnings: clipWarnings([...warnings]),
    protocol: result?.protocol || '',
  };
}

export function buildImportFailureModel(
  message: string,
  protocol = '',
  detail?: unknown
): ImportDialogModel {
  return {
    ok: false,
    title: 'Импорт не выполнен',
    summary: ['Изменения не применены — импорт отменён.'],
    errors: [message || 'Ошибка импорта'],
    warnings: [],
    protocol: protocol || formatDetail(detail),
  };
}

export function buildImportLocalErrorModel(message: string): ImportDialogModel {
  return {
    ok: false,
    title: 'Импорт не выполнен',
    summary: ['Файл не отправлен на сервер.'],
    errors: [message],
    warnings: [],
    protocol: '',
  };
}
