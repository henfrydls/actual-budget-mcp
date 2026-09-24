import { describe, it, expect, vi, beforeEach } from 'vitest';

const getAccounts = vi.fn();
const getTransactions = vi.fn();

vi.mock('@actual-app/api', () => ({
  default: {},
  getAccounts: (...a: unknown[]) => getAccounts(...a),
  getTransactions: (...a: unknown[]) => getTransactions(...a),
  utils: {
    amountToInteger: (a: number) => Math.round(a * 100),
    integerToAmount: (c: number) => c / 100,
  },
}));

import { findSpendingDivergences, describeDivergences } from '../budget-crosscheck.js';
import type { BudgetMonthGroup } from '../../types.js';

const groups = (spent: number): BudgetMonthGroup[] =>
  [
    {
      id: 'g1',
      name: 'Housing',
      is_income: false,
      categories: [{ id: 'cat-1', name: 'Hipoteca', budgeted: 0, spent, balance: 0 }],
    },
  ] as unknown as BudgetMonthGroup[];

beforeEach(() => {
  getAccounts.mockReset().mockResolvedValue([
    { id: 'acc-1', name: 'BHD', offbudget: false, closed: false },
  ]);
  getTransactions.mockReset();
});

describe('cross-checking a month against its own transactions', () => {
  it('says nothing when the two agree', async () => {
    getTransactions.mockResolvedValue([
      { id: 't1', category: 'cat-1', amount: -5263598 },
    ]);

    expect(await findSpendingDivergences('2026-09', groups(-5263598))).toEqual([]);
  });

  it('catches the case that started this: a real charge reported as zero', async () => {
    // get_budget_month said `Hipoteca: Spent 0.00` while the transaction
    // existed and carried the category (#80).
    getTransactions.mockResolvedValue([
      { id: 't1', category: 'cat-1', amount: -5263598 },
    ]);

    const [divergence] = await findSpendingDivergences('2026-09', groups(0));

    expect(divergence.category).toBe('Hipoteca');
    expect(divergence.reported).toBe(0);
    expect(divergence.observed).toBe(-5263598);
  });

  it('counts a split by its children, not by the parent', async () => {
    // getTransactions returns split parents only, with children nested and the
    // parent carrying no category. Summing rows naively would attribute the
    // split to nothing, and every split would look like a divergence.
    getTransactions.mockResolvedValue([
      {
        id: 'parent',
        category: null,
        amount: -10000,
        subtransactions: [
          { id: 'c1', category: 'cat-1', amount: -6000 },
          { id: 'c2', category: 'cat-1', amount: -4000 },
        ],
      },
    ]);

    expect(await findSpendingDivergences('2026-09', groups(-10000))).toEqual([]);
  });

  it('ignores off-budget accounts, which do not touch a budget category', async () => {
    getAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'BHD', offbudget: false, closed: false },
      { id: 'acc-2', name: 'Inversión', offbudget: true, closed: false },
    ]);
    getTransactions.mockImplementation(async (id: string) =>
      id === 'acc-1' ? [{ id: 't1', category: 'cat-1', amount: -1000 }] : [{ id: 't2', category: 'cat-1', amount: -9999 }],
    );

    expect(await findSpendingDivergences('2026-09', groups(-1000))).toEqual([]);
  });

  it('still counts a closed account, whose history belongs to its month', async () => {
    getAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'Old card', offbudget: false, closed: true },
    ]);
    getTransactions.mockResolvedValue([{ id: 't1', category: 'cat-1', amount: -1000 }]);

    expect(await findSpendingDivergences('2026-09', groups(-1000))).toEqual([]);
  });

  it('leaves income groups alone', async () => {
    getTransactions.mockResolvedValue([]);
    const income = [
      { id: 'g2', name: 'Income', is_income: true, categories: [{ id: 'cat-9', name: 'Salary', spent: -1 }] },
    ] as unknown as BudgetMonthGroup[];

    expect(await findSpendingDivergences('2026-09', income)).toEqual([]);
  });

  it('survives an account whose transactions cannot be read', async () => {
    getTransactions.mockResolvedValue(undefined);

    expect(await findSpendingDivergences('2026-09', groups(0))).toEqual([]);
  });
});

describe('how a divergence is reported', () => {
  it('shows both numbers, because one of them alone proves nothing', () => {
    const text = describeDivergences([
      { category: 'Hipoteca', reported: 0, observed: -5263598 },
    ]).join('\n');

    expect(text).toMatch(/WARNING/);
    expect(text).toMatch(/0\.00/);
    expect(text).toMatch(/52,635\.98/);
  });

  it('names the cure, since the cause is upstream and fixable', () => {
    const text = describeDivergences([
      { category: 'Hipoteca', reported: 0, observed: -1 },
    ]).join('\n');

    expect(text).toMatch(/repair_sync/);
  });

  it('stays silent when everything agrees', () => {
    expect(describeDivergences([])).toEqual([]);
  });
});
