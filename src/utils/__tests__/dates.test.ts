import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveMonth, resolveDate, getMonthRange, daysInMonth } from '../dates.js';

describe('resolveMonth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 15)); // March 15, 2026
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns current month when no input', () => {
    expect(resolveMonth()).toBe('2026-03');
  });

  it('passes through YYYY-MM format', () => {
    expect(resolveMonth('2025-12')).toBe('2025-12');
  });

  it('handles "this month" (EN)', () => {
    expect(resolveMonth('this month')).toBe('2026-03');
  });

  it('handles "este mes" (ES)', () => {
    expect(resolveMonth('este mes')).toBe('2026-03');
  });

  it('handles "last month" (EN)', () => {
    expect(resolveMonth('last month')).toBe('2026-02');
  });

  it('handles "mes pasado" (ES)', () => {
    expect(resolveMonth('mes pasado')).toBe('2026-02');
  });

  it('handles "next month" (EN)', () => {
    expect(resolveMonth('next month')).toBe('2026-04');
  });

  it('handles "próximo mes" (ES)', () => {
    expect(resolveMonth('próximo mes')).toBe('2026-04');
  });

  it('handles "N months ago" (EN)', () => {
    expect(resolveMonth('3 months ago')).toBe('2025-12');
  });

  it('handles "hace N meses" (ES)', () => {
    expect(resolveMonth('hace 3 meses')).toBe('2025-12');
  });

  it('handles "Month Year" (EN)', () => {
    expect(resolveMonth('January 2025')).toBe('2025-01');
  });

  it('handles "Month Year" (ES)', () => {
    expect(resolveMonth('enero 2025')).toBe('2025-01');
  });

  it('handles month name alone (assumes current year)', () => {
    expect(resolveMonth('december')).toBe('2026-12');
  });

  it('handles month abbreviation (ES)', () => {
    expect(resolveMonth('dic')).toBe('2026-12');
  });

  it('is case-insensitive', () => {
    expect(resolveMonth('THIS MONTH')).toBe('2026-03');
  });

  it('throws on invalid input', () => {
    expect(() => resolveMonth('garbage')).toThrow('Could not parse month');
  });
});

describe('resolveDate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 15)); // March 15, 2026
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns today when no input', () => {
    expect(resolveDate()).toBe('2026-03-15');
  });

  it('passes through YYYY-MM-DD format', () => {
    expect(resolveDate('2025-12-25')).toBe('2025-12-25');
  });

  it('handles "today" (EN)', () => {
    expect(resolveDate('today')).toBe('2026-03-15');
  });

  it('handles "hoy" (ES)', () => {
    expect(resolveDate('hoy')).toBe('2026-03-15');
  });

  it('handles "yesterday" (EN)', () => {
    expect(resolveDate('yesterday')).toBe('2026-03-14');
  });

  it('handles "ayer" (ES)', () => {
    expect(resolveDate('ayer')).toBe('2026-03-14');
  });

  it('handles "N days ago" (EN)', () => {
    expect(resolveDate('5 days ago')).toBe('2026-03-10');
  });

  it('handles "hace N días" (ES)', () => {
    expect(resolveDate('hace 5 días')).toBe('2026-03-10');
  });

  it('handles "start of month" (EN)', () => {
    expect(resolveDate('start of month')).toBe('2026-03-01');
  });

  it('handles "inicio del mes" (ES)', () => {
    expect(resolveDate('inicio del mes')).toBe('2026-03-01');
  });

  it('handles "end of month" (EN)', () => {
    expect(resolveDate('end of month')).toBe('2026-03-31');
  });

  it('handles "fin del mes" (ES)', () => {
    expect(resolveDate('fin del mes')).toBe('2026-03-31');
  });

  it('throws on invalid input', () => {
    expect(() => resolveDate('garbage')).toThrow('Could not parse date');
  });
});

describe('getMonthRange', () => {
  it('returns correct range going back', () => {
    expect(getMonthRange('2026-03', 3)).toEqual(['2026-03', '2026-02', '2026-01']);
  });

  it('handles year boundary', () => {
    expect(getMonthRange('2026-02', 4)).toEqual(['2026-02', '2026-01', '2025-12', '2025-11']);
  });

  it('returns single month', () => {
    expect(getMonthRange('2026-03', 1)).toEqual(['2026-03']);
  });
});

describe('daysInMonth', () => {
  it('returns 31 for January', () => {
    expect(daysInMonth('2026-01')).toBe(31);
  });

  it('returns 28 for non-leap February', () => {
    expect(daysInMonth('2026-02')).toBe(28);
  });

  it('returns 29 for leap February', () => {
    expect(daysInMonth('2028-02')).toBe(29);
  });

  it('returns 30 for April', () => {
    expect(daysInMonth('2026-04')).toBe(30);
  });
});
