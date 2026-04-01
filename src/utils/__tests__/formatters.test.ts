import { describe, it, expect } from 'vitest';
import { sectionHeader, formatTable, formatPercent } from '../formatters.js';

describe('sectionHeader', () => {
  it('wraps title in === markers', () => {
    expect(sectionHeader('Test')).toBe('=== Test ===');
  });
});

describe('formatTable', () => {
  it('formats a simple table', () => {
    const result = formatTable(
      ['Name', 'Amount'],
      [['Groceries', '500.00'], ['Gas', '100.00']],
    );
    expect(result).toContain('Name');
    expect(result).toContain('Groceries');
    expect(result).toContain('Gas');
    expect(result.split('\n').length).toBe(4); // header + separator + 2 rows
  });

  it('returns empty string for no rows', () => {
    expect(formatTable(['Name'], [])).toBe('');
  });

  it('right-aligns columns when specified', () => {
    const result = formatTable(
      ['Name', 'Amount'],
      [['Food', '500.00']],
      ['left', 'right'],
    );
    const lines = result.split('\n');
    const dataLine = lines[2];
    // Right-aligned amount should have leading spaces
    expect(dataLine).toMatch(/\s+500\.00/);
  });

  it('pads columns to max width', () => {
    const result = formatTable(
      ['X', 'Y'],
      [['Short', 'LongerValue'], ['A', 'B']],
    );
    const lines = result.split('\n');
    // All lines should have same length
    expect(lines[0].length).toBe(lines[2].length);
    expect(lines[0].length).toBe(lines[3].length);
  });
});

describe('formatPercent', () => {
  it('formats with default 1 decimal', () => {
    expect(formatPercent(45.678)).toBe('45.7%');
  });

  it('formats with custom decimals', () => {
    expect(formatPercent(45.678, 2)).toBe('45.68%');
  });

  it('formats zero', () => {
    expect(formatPercent(0)).toBe('0.0%');
  });

  it('formats 100', () => {
    expect(formatPercent(100)).toBe('100.0%');
  });
});
