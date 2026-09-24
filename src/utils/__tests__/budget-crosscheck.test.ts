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
      { id: 't1', account: 'acc-1', category: 'cat-1', amount: -5263598 },
    ]);

    expect(await findSpendingDivergences('2026-09', groups(-5263598))).toEqual([]);
  });

  it('catches the case that started this: a real charge reported as zero', async () => {
    // get_budget_month said `Hipoteca: Spent 0.00` while the transaction
    // existed and carried the category (#80).
    getTransactions.mockResolvedValue([
      { id: 't1', account: 'acc-1', category: 'cat-1', amount: -5263598 },
    ]);

    const [divergence] = await findSpendingDivergences('2026-09', groups(0));

    expect(divergence.category).toBe('Hipoteca');
    // Actual allows the same name in two groups, so the group identifies it.
    expect(divergence.group).toBe('Housing');
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
        account: 'acc-1',
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
    // One query returns every account's rows, so the filtering happens here.
    getTransactions.mockResolvedValue([
      { id: 't1', account: 'acc-1', category: 'cat-1', amount: -1000 },
      { id: 't2', account: 'acc-2', category: 'cat-1', amount: -9999 },
    ]);

    expect(await findSpendingDivergences('2026-09', groups(-1000))).toEqual([]);
  });

  it('asks once for the whole month rather than once per account', async () => {
    // Each query costs about 28 ms whatever it returns, so asking per account
    // made the check scale with the number of accounts: 312 ms against 34 ms
    // on a real budget with 14 of them.
    getAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'BHD', offbudget: false, closed: false },
      { id: 'acc-2', name: 'APAP', offbudget: false, closed: false },
      { id: 'acc-3', name: 'BanReservas', offbudget: false, closed: false },
    ]);
    getTransactions.mockResolvedValue([]);

    await findSpendingDivergences('2026-09', groups(0));

    expect(getTransactions).toHaveBeenCalledOnce();
  });

  it('still counts a closed account, whose history belongs to its month', async () => {
    getAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'Old card', offbudget: false, closed: true },
    ]);
    getTransactions.mockResolvedValue([
      { id: 't1', account: 'acc-1', category: 'cat-1', amount: -1000 },
    ]);

    expect(await findSpendingDivergences('2026-09', groups(-1000))).toEqual([]);
  });

  it('ignores rows whose account no longer exists', async () => {
    // A half-synced delete: the message removing the account arrived, the ones
    // removing its transactions did not. An exclusion set built from the live
    // accounts would count these and invent divergences, then tell the reader
    // to trust the side that is wrong.
    getAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'BHD', offbudget: false, closed: false },
    ]);
    getTransactions.mockResolvedValue([
      { id: 't1', account: 'acc-1', category: 'cat-1', amount: -1000 },
      { id: 't2', account: 'gone', category: 'cat-1', amount: -77700 },
    ]);

    expect(await findSpendingDivergences('2026-09', groups(-1000))).toEqual([]);
  });

  it('leaves income groups alone', async () => {
    getTransactions.mockResolvedValue([]);
    const income = [
      { id: 'g2', name: 'Income', is_income: true, categories: [{ id: 'cat-9', name: 'Salary', spent: -1 }] },
    ] as unknown as BudgetMonthGroup[];

    expect(await findSpendingDivergences('2026-09', income)).toEqual([]);
  });

  it('lets a failed read surface, rather than reporting a false divergence', async () => {
    // `api/transactions-get` returns an array or throws; it never resolves
    // undefined, so testing that case proved nothing. A read that fails must
    // not be counted as "no transactions", which would report every category
    // as diverging. The caller turns this into "could not cross-check".
    getTransactions.mockRejectedValue(new Error('could not read transactions'));

    await expect(findSpendingDivergences('2026-09', groups(0))).rejects.toThrow();
  });
});

describe('how a divergence is reported', () => {
  it('shows both numbers, because one of them alone proves nothing', () => {
    const text = describeDivergences([
      { category: 'Hipoteca', group: 'Housing', reported: 0, observed: -5263598 },
    ]).join('\n');

    expect(text).toMatch(/WARNING/);
    expect(text).toMatch(/0\.00/);
    expect(text).toMatch(/52,635\.98/);
  });

  it('names the cure, since the cause is upstream and fixable', () => {
    const text = describeDivergences([
      { category: 'Hipoteca', group: 'Housing', reported: 0, observed: -1 },
    ]).join('\n');

    // repair_sync rebuilds the sync state, which is not what is stale. An
    // accurate warning that prescribes a useless action teaches people to
    // distrust the warning.
    // Verified against the real engine: deleting the derived cache clears it,
    // and restarting the server does not, because a persistent data dir
    // reloads the same local copy and the same stale calculation.
    expect(text).toMatch(/cache\.sqlite/);
    expect(text).toMatch(/repair_sync/);
    expect(text).toMatch(/does not.*restarting this server/is);
  });

  it('names the group on the line itself, not only in the data', () => {
    // Two groups may hold a category of the same name, so a line without the
    // group cannot be acted on. The field being right is not the promise; the
    // printed line is.
    const text = describeDivergences([
      { category: 'Otros', group: 'Provisiones', reported: 0, observed: -1000 },
    ]).join('\n');

    expect(text).toMatch(/Provisiones \/ Otros/);
  });

  it('shows the difference, so nobody has to subtract by hand', () => {
    const text = describeDivergences([
      { category: 'Hipoteca', group: 'Housing', reported: 0, observed: -5263598 },
    ]).join('\n');

    expect(text).toMatch(/difference:\s+-?52,635\.98/);
  });

  it('says how many categories disagree', () => {
    const text = describeDivergences([
      { category: 'A', group: 'G', reported: 0, observed: -1 },
      { category: 'B', group: 'G', reported: 0, observed: -2 },
    ]).join('\n');

    expect(text).toMatch(/2 categories disagree/);
  });

  it('stays silent when everything agrees', () => {
    expect(describeDivergences([])).toEqual([]);
  });
});
