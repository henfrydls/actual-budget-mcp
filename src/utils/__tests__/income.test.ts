import { describe, it, expect } from 'vitest';
import { isIncome, totalsWithMisfiledIncome } from '../income.js';

/**
 * The one place the income question is answered, so the nine call sites cannot
 * drift apart again (#116).
 */
describe('isIncome', () => {
  it('believes the category over its group', () => {
    // The shape `category-move` produces: the flag travels with the category.
    expect(isIncome({ is_income: false }, { is_income: true })).toBe(true);
  });

  it('still treats everything in an income group as income', () => {
    // Measured: an expense category inside an income group gets no budget
    // figures from the engine at all — budgeted, balance and spent all come
    // back undefined, and setBudgetAmount on it changes nothing. Skipping the
    // group whole loses nothing, and keeping that behaviour is deliberate.
    expect(isIncome({ is_income: true }, { is_income: false })).toBe(true);
  });

  it('says no for an ordinary spending category', () => {
    expect(isIncome({ is_income: false }, { is_income: false })).toBe(false);
  });

  it('does not guess when neither says anything', () => {
    expect(isIncome(undefined, undefined)).toBe(false);
    expect(isIncome({}, {})).toBe(false);
  });
});

describe('totalsWithMisfiledIncome', () => {
  /** The measured shape: a salary of 5,000.00 flagged income inside a spending group. */
  const misfiled = {
    totalIncome: 0,
    totalSpent: 480000,
    categoryGroups: [
      {
        is_income: false,
        categories: [
          { is_income: true, spent: 500000 },
          { is_income: false, spent: -20000 },
        ],
      },
    ],
  };

  it('moves a misfiled salary out of spending and into income', () => {
    const { income, spent, correction } = totalsWithMisfiledIncome(misfiled);

    expect(correction).toBe(500000);
    expect(income).toBe(500000);
    // Real spending for the period was 200.00, which the engine reported as
    // 4,800.00 because the salary was counted against it.
    expect(spent).toBe(-20000);
  });

  it('changes nothing when nothing is misfiled', () => {
    const ordinary = {
      totalIncome: 500000,
      totalSpent: -20000,
      categoryGroups: [
        { is_income: false, categories: [{ is_income: false, spent: -20000 }] },
        { is_income: true, categories: [{ is_income: true, spent: 500000 }] },
      ],
    };

    const { income, spent, correction } = totalsWithMisfiledIncome(ordinary);

    expect(correction).toBe(0);
    expect(income).toBe(500000);
    expect(spent).toBe(-20000);
  });

  it('ignores categories the engine gave no figures for', () => {
    // An income group's categories come back with spent undefined. Adding
    // undefined to a total makes it NaN, which would print as a blank figure
    // rather than failing.
    const withUndefined = {
      totalIncome: 0,
      totalSpent: 0,
      categoryGroups: [
        { is_income: false, categories: [{ is_income: true, spent: undefined }] },
      ],
    };

    const { income, spent } = totalsWithMisfiledIncome(withUndefined);

    expect(Number.isNaN(income)).toBe(false);
    expect(Number.isNaN(spent)).toBe(false);
  });
});
