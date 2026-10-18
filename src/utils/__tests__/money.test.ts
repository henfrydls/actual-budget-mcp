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

  /**
   * That it rounds, which nothing pinned (#112).
   *
   * Replacing it with `Math.trunc(amount * 100)` passed the whole suite, in
   * both modes. Binary floating point cannot hold most decimal amounts
   * exactly, so `19.99 * 100` is `1998.9999999999998`: rounding gives 1999
   * and truncating gives 1998, which is a cent lost on an ordinary price,
   * silently, every time. In a budgeting tool that surfaces much later as a
   * reconciliation that is off by a few cents and no way to find out why.
   *
   * The figures are measured against the SDK, not reasoned from it.
   */
  it.each([
    [19.99, 1999],
    [-19.99, -1999],
    [8.115, 812],
    [0.005, 1],
    [2.675, 268],
  ])('rounds %d to %d rather than truncating', (amount, cents) => {
    expect(amountToCents(amount)).toBe(cents);
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
