import { describe, it, expect, vi, beforeEach } from 'vitest';

const getBudgetMonth = vi.fn();
const getAccounts = vi.fn();
const getTransactions = vi.fn();

vi.mock('@actual-app/api', () => ({
  default: {},
  getBudgetMonth: (...a: unknown[]) => getBudgetMonth(...a),
  getAccounts: (...a: unknown[]) => getAccounts(...a),
  getTransactions: (...a: unknown[]) => getTransactions(...a),
  utils: {
    amountToInteger: (a: number) => Math.round(a * 100),
    integerToAmount: (c: number) => c / 100,
  },
}));

vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { registerGetBudgetMonth } from '../read/get-budget-month.js';

/**
 * Through the registered handler, not the module underneath it.
 *
 * The cross-check module was thoroughly tested and the file that wires it into
 * the tool had no test at all: it could be reverted wholesale and the suite
 * stayed green. The promise a user reads lives in the wiring.
 */
function handler() {
  let captured: any;
  registerGetBudgetMonth({ tool: (...a: unknown[]) => { captured = a.at(-1); } } as never);
  return captured as (input: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

const budget = (spent: number) => ({
  toBudget: 0,
  totalIncome: 0,
  totalBudgeted: 0,
  totalSpent: spent,
  totalBalance: 0,
  categoryGroups: [
    {
      id: 'g1',
      name: 'Housing',
      is_income: false,
      categories: [{ id: 'cat-1', name: 'Hipoteca', budgeted: 0, spent, balance: 0 }],
    },
  ],
});

beforeEach(() => {
  getBudgetMonth.mockReset().mockResolvedValue(budget(0));
  getAccounts.mockReset().mockResolvedValue([
    { id: 'acc-1', name: 'BHD', offbudget: false, closed: false },
  ]);
  getTransactions.mockReset().mockResolvedValue([]);
});

describe('get_budget_month', () => {
  it('warns in the answer when the figures disagree with the transactions', async () => {
    // The case that started #80: Spent 0.00 for a category holding a real
    // charge of 52,635.98.
    getTransactions.mockResolvedValue([{ id: 't1', category: 'cat-1', amount: -5263598 }]);

    const text = (await handler()({ month: '2026-09' })).content[0].text;

    expect(text).toMatch(/WARNING/);
    expect(text).toMatch(/0\.00/);
    expect(text).toMatch(/52,635\.98/);
  });

  it('says nothing extra when they agree', async () => {
    getBudgetMonth.mockResolvedValue(budget(-1000));
    getTransactions.mockResolvedValue([{ id: 't1', category: 'cat-1', amount: -1000 }]);

    const text = (await handler()({ month: '2026-09' })).content[0].text;

    expect(text).not.toMatch(/WARNING/);
    expect(text).not.toMatch(/could not cross-check/);
  });

  it('still answers when the cross-check itself fails', async () => {
    // The check is an extra, not a precondition: a caller must never lose the
    // figures they asked for because the extra could not run.
    getBudgetMonth.mockResolvedValue(budget(-1000));
    getTransactions.mockRejectedValue(new Error('could not read transactions'));

    const result = await handler()({ month: '2026-09' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/Total Spent/);
    expect(result.content[0].text).toMatch(/could not cross-check/i);
  });

  it('asks for the month it was given, from the first day to the last', async () => {
    await handler()({ month: '2026-09' });

    expect(getTransactions).toHaveBeenCalledWith('acc-1', '2026-09-01', '2026-09-31');
  });

  it('reads every on-budget account, not just the first', async () => {
    getAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'BHD', offbudget: false, closed: false },
      { id: 'acc-2', name: 'APAP', offbudget: false, closed: false },
    ]);
    getBudgetMonth.mockResolvedValue(budget(-3000));
    getTransactions.mockImplementation(async (id: string) =>
      id === 'acc-1'
        ? [{ id: 't1', category: 'cat-1', amount: -1000 }]
        : [{ id: 't2', category: 'cat-1', amount: -2000 }],
    );

    const text = (await handler()({ month: '2026-09' })).content[0].text;

    // Both accounts sum into the same category and match the budget, so
    // looking at only one of them would invent a divergence.
    expect(text).not.toMatch(/WARNING/);
  });

  it('reports a genuine failure as an error, not as a silent answer', async () => {
    getBudgetMonth.mockRejectedValue(new Error('No budget file is open'));

    const result = await handler()({ month: '2026-09' });

    expect(result.isError).toBe(true);
  });
});
