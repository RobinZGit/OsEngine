import { asDateOnly, formatDateRangeLabel, formatHumanDate } from './date-format';

describe('date-format', () => {
  it('asDateOnly strips time from ISO', () => {
    expect(asDateOnly('2026-07-06T00:00:00.000Z')).toBe('2026-07-06');
    expect(asDateOnly('2026-07-06')).toBe('2026-07-06');
  });

  it('formatHumanDate is day.month.year', () => {
    expect(formatHumanDate('2026-07-06T12:34:56.000Z')).toBe('06.07.2026');
  });

  it('formatDateRangeLabel is readable from/to', () => {
    expect(formatDateRangeLabel('2026-07-06', '2026-07-17')).toBe(
      'с 06.07.2026 по 17.07.2026',
    );
  });
});
