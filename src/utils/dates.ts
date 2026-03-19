const MONTH_NAMES: Record<string, number> = {
  january: 0, jan: 0, enero: 0, ene: 0,
  february: 1, feb: 1, febrero: 1,
  march: 2, mar: 2, marzo: 2,
  april: 3, apr: 3, abril: 3, abr: 3,
  may: 4, mayo: 4,
  june: 5, jun: 5, junio: 5,
  july: 6, jul: 6, julio: 6,
  august: 7, aug: 7, agosto: 7, ago: 7,
  september: 8, sep: 8, sept: 8, septiembre: 8,
  october: 9, oct: 9, octubre: 9,
  november: 10, nov: 10, noviembre: 10,
  december: 11, dec: 11, diciembre: 11, dic: 11,
};

export function resolveMonth(input?: string): string {
  const now = new Date();

  if (!input) {
    return formatMonth(now.getFullYear(), now.getMonth());
  }

  const trimmed = input.trim().toLowerCase();

  // Already in YYYY-MM format
  if (/^\d{4}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  // "this month" / "este mes"
  if (trimmed === 'this month' || trimmed === 'este mes') {
    return formatMonth(now.getFullYear(), now.getMonth());
  }

  // "last month" / "mes pasado"
  if (trimmed === 'last month' || trimmed === 'mes pasado') {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return formatMonth(d.getFullYear(), d.getMonth());
  }

  // "next month" / "próximo mes"
  if (trimmed === 'next month' || trimmed === 'próximo mes' || trimmed === 'proximo mes') {
    const d = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return formatMonth(d.getFullYear(), d.getMonth());
  }

  // "N months ago" / "hace N meses"
  const monthsAgoMatch = trimmed.match(/^(\d+)\s+months?\s+ago$/);
  if (monthsAgoMatch) {
    const n = parseInt(monthsAgoMatch[1], 10);
    const d = new Date(now.getFullYear(), now.getMonth() - n, 1);
    return formatMonth(d.getFullYear(), d.getMonth());
  }

  const haceMesesMatch = trimmed.match(/^hace\s+(\d+)\s+meses?$/);
  if (haceMesesMatch) {
    const n = parseInt(haceMesesMatch[1], 10);
    const d = new Date(now.getFullYear(), now.getMonth() - n, 1);
    return formatMonth(d.getFullYear(), d.getMonth());
  }

  // "Month Year" e.g., "January 2025", "Enero 2025"
  const monthYearMatch = trimmed.match(/^([a-záéíóú]+)\s+(\d{4})$/);
  if (monthYearMatch) {
    const monthIdx = MONTH_NAMES[monthYearMatch[1]];
    if (monthIdx !== undefined) {
      return formatMonth(parseInt(monthYearMatch[2], 10), monthIdx);
    }
  }

  // Just a month name, assume current year
  if (MONTH_NAMES[trimmed] !== undefined) {
    return formatMonth(now.getFullYear(), MONTH_NAMES[trimmed]);
  }

  throw new Error(
    `Could not parse month: "${input}". Use YYYY-MM format, "this month", "last month", "January 2025", etc.`,
  );
}

export function resolveDate(input?: string): string {
  const now = new Date();

  if (!input) {
    return formatDate(now);
  }

  const trimmed = input.trim().toLowerCase();

  // Already in YYYY-MM-DD format
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  if (trimmed === 'today' || trimmed === 'hoy') {
    return formatDate(now);
  }

  if (trimmed === 'yesterday' || trimmed === 'ayer') {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return formatDate(d);
  }

  // "N days ago" / "hace N días"
  const daysAgoMatch = trimmed.match(/^(\d+)\s+days?\s+ago$/);
  if (daysAgoMatch) {
    const d = new Date(now);
    d.setDate(d.getDate() - parseInt(daysAgoMatch[1], 10));
    return formatDate(d);
  }

  const haceDiasMatch = trimmed.match(/^hace\s+(\d+)\s+d[ií]as?$/);
  if (haceDiasMatch) {
    const d = new Date(now);
    d.setDate(d.getDate() - parseInt(haceDiasMatch[1], 10));
    return formatDate(d);
  }

  // "start of month" / "inicio del mes"
  if (trimmed === 'start of month' || trimmed === 'inicio del mes') {
    return `${formatMonth(now.getFullYear(), now.getMonth())}-01`;
  }

  // "end of month" / "fin del mes"
  if (trimmed === 'end of month' || trimmed === 'fin del mes') {
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return formatDate(lastDay);
  }

  throw new Error(
    `Could not parse date: "${input}". Use YYYY-MM-DD format, "today", "yesterday", "start of month", etc.`,
  );
}

export function getMonthRange(fromMonth: string, count: number): string[] {
  const [year, month] = fromMonth.split('-').map(Number);
  const months: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(year, month - 1 - i, 1);
    months.push(formatMonth(d.getFullYear(), d.getMonth()));
  }
  return months;
}

export function daysInMonth(month: string): number {
  const [year, m] = month.split('-').map(Number);
  return new Date(year, m, 0).getDate();
}

export function daysElapsed(month: string): number {
  const now = new Date();
  const currentMonth = formatMonth(now.getFullYear(), now.getMonth());
  if (month === currentMonth) {
    return now.getDate();
  }
  if (month < currentMonth) {
    return daysInMonth(month);
  }
  return 0;
}

function formatMonth(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
