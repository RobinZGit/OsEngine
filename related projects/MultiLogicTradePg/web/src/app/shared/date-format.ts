/** Calendar date only (YYYY-MM-DD) from API date / ISO / Date string — no time. */
export function asDateOnly(raw: string | Date | null | undefined): string | null {
  if (raw == null) return null;
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    // UTC — DATE из PG/ISO полночь UTC не сдвигает день в MSK/других TZ.
    const y = raw.getUTCFullYear();
    const m = String(raw.getUTCMonth() + 1).padStart(2, '0');
    const d = String(raw.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Human date: day.month.year (no time). */
export function formatHumanDate(raw: string | Date | null | undefined): string {
  const ymd = asDateOnly(raw);
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-');
  return `${d}.${m}.${y}`;
}

/** Readable period: «с 06.07.2026 по 17.07.2026». */
export function formatDateRangeLabel(
  from: string | Date | null | undefined,
  to: string | Date | null | undefined,
): string {
  const a = formatHumanDate(from);
  const b = formatHumanDate(to);
  if (!a && !b) return '';
  if (a && b) return `с ${a} по ${b}`;
  if (a) return `с ${a}`;
  return `по ${b}`;
}
