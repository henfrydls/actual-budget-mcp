export function sectionHeader(title: string): string {
  return `=== ${title} ===`;
}

export function formatTable(
  headers: string[],
  rows: string[][],
  alignments?: ('left' | 'right')[],
): string {
  if (rows.length === 0) return '';

  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] || '').length)),
  );

  const aligns = alignments || headers.map(() => 'left' as const);

  const padCell = (text: string, width: number, align: 'left' | 'right') =>
    align === 'right' ? text.padStart(width) : text.padEnd(width);

  const headerLine = headers
    .map((h, i) => padCell(h, colWidths[i], aligns[i]))
    .join('  ');

  const separator = colWidths.map((w) => '-'.repeat(w)).join('  ');

  const dataLines = rows.map((row) =>
    row.map((cell, i) => padCell(cell || '', colWidths[i], aligns[i])).join('  '),
  );

  return [headerLine, separator, ...dataLines].join('\n');
}

export function formatPercent(value: number, decimals: number = 1): string {
  return `${value.toFixed(decimals)}%`;
}
