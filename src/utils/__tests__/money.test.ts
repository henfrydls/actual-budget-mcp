import { describe, it, expect } from 'vitest';
import { centsToAmount, amountToCents, formatMoney } from '../money.js';

describe('centsToAmount', () => {
  it('converts positive cents to amount', () => {
    expect(centsToAmount(50000)).toBe(500);
  });

  it('converts negative cents to amount', () => {
    expect(centsToAmount(-15050)).toBe(-150.5);
  });

  it('converts zero', () => {
    expect(centsToAmount(0)).toBe(0);
  });
});

describe('amountToCents', () => {
  it('converts positive amount to cents', () => {
    expect(amountToCents(500)).toBe(50000);
  });

  it('converts negative amount to cents', () => {
    expect(amountToCents(-150.5)).toBe(-15050);
  });

  it('converts zero', () => {
    expect(amountToCents(0)).toBe(0);
  });
});

describe('formatMoney', () => {
  it('formats positive amount', () => {
    expect(formatMoney(50000)).toBe('500.00');
  });

  it('formats negative amount', () => {
    expect(formatMoney(-15050)).toBe('-150.50');
  });

  it('formats zero', () => {
    expect(formatMoney(0)).toBe('0.00');
  });

  it('formats large amounts with commas', () => {
    expect(formatMoney(10000000)).toBe('100,000.00');
  });

  it('formats small cents', () => {
    expect(formatMoney(1)).toBe('0.01');
  });
});
