import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Real @actual-app/api, only api.sync() neutralized (server-less mode).
vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { getTransactionsReport } from '../../read/get-transactions.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

/**
 * Against the real engine, because what "has no category" means is a property
 * of Actual's data model, not of our types.
 *
 * Measured here rather than assumed: four different kinds of row come back with
 * a null category, and only two of them are work waiting to be done.
 */
describe.skipIf(skip)('listing transactions that have no category (#81)', () => {
  beforeAll(async () => { await initTestEngine(); }, 60_000);
  afterAll(async () => { await shutdownTestEngine(); });

  async function budgetWithEverything() {
    let checking = '', savings = '', broker = '', cat = '';
    await createFreshBudget(async () => {
      checking = await api.createAccount({ name: 'Checking', type: 'checking' } as any, 0);
      savings = await api.createAccount({ name: 'Savings', type: 'savings' } as any, 0);
      broker = await api.createAccount({ name: 'Broker', type: 'other', offbudget: true } as any, 0);
      const g = await api.createCategoryGroup({ name: 'G' } as any);
      cat = await api.createCategory({ name: 'Groceries', group_id: g } as any);
    });

    const payees = await api.getPayees();
    const toSavings = payees.find((p: any) => p.transfer_acct === savings);

    await api.addTransactions(
      checking,
      [
        { date: '2026-06-05', amount: -100, category: cat, notes: 'sorted' },
        { date: '2026-06-05', amount: -200, notes: 'needs a category' },
        {
          date: '2026-06-05',
          amount: -300,
          notes: 'a split',
          subtransactions: [
            { amount: -200, category: cat },
            { amount: -100, notes: 'part needs a category' },
          ],
        },
        { date: '2026-06-05', amount: -400, payee: toSavings?.id, notes: 'moving my own money' },
      ] as any,
      { runTransfers: true },
    );
    await api.addTransactions(broker, [
      { date: '2026-06-05', amount: -500, notes: 'off budget, needs nothing' },
    ] as any);

    return { checking, broker };
  }

  it('returns what needs a category and nothing else', async () => {
    await budgetWithEverything();

    const report = await getTransactionsReport({
      start_date: '2026-06-01',
      end_date: '2026-06-30',
      uncategorized: true,
    });

    expect(report).toMatch(/needs a category/);
    expect(report).toMatch(/part needs a category/);

    expect(report).not.toMatch(/sorted/);
    // A transfer between your own accounts is not spending and never takes a
    // category, so listing it as work to do is noise.
    expect(report).not.toMatch(/moving my own money/);
    // The parent of a split has no category by design: its categories live on
    // its parts, which are listed separately.
    expect(report).not.toMatch(/a split\b/);
    expect(report).not.toMatch(/off budget/);
  });

  it('lists everything when the flag is off, including what is already sorted', async () => {
    await budgetWithEverything();

    const report = await getTransactionsReport({
      start_date: '2026-06-01',
      end_date: '2026-06-30',
    });

    expect(report).toMatch(/sorted/);
    expect(report).toMatch(/moving my own money/);
    expect(report).toMatch(/off budget/);
  });

  it('composes with a date range', async () => {
    const { checking } = await budgetWithEverything();
    await api.addTransactions(checking, [
      { date: '2026-07-10', amount: -700, notes: 'july, no category' },
    ] as any);

    const june = await getTransactionsReport({
      start_date: '2026-06-01',
      end_date: '2026-06-30',
      uncategorized: true,
    });

    expect(june).toMatch(/needs a category/);
    expect(june).not.toMatch(/july/);
  });

  it('composes with an account, and honours one named explicitly', async () => {
    const { broker } = await budgetWithEverything();

    const onlyBroker = await getTransactionsReport({
      account: 'Broker',
      start_date: '2026-06-01',
      end_date: '2026-06-30',
      uncategorized: true,
    });

    // Off-budget accounts are skipped when scanning everything, but asking for
    // one by name is a deliberate choice and is answered.
    expect(broker).toBeTruthy();
    expect(onlyBroker).toMatch(/off budget/);
  });

  it('says so plainly when there is nothing to sort', async () => {
    let checking = '';
    let cat = '';
    await createFreshBudget(async () => {
      checking = await api.createAccount({ name: 'Checking', type: 'checking' } as any, 0);
      const g = await api.createCategoryGroup({ name: 'G' } as any);
      cat = await api.createCategory({ name: 'Groceries', group_id: g } as any);
    });
    await api.addTransactions(checking, [
      { date: '2026-06-05', amount: -100, category: cat },
    ] as any);

    const report = await getTransactionsReport({
      start_date: '2026-06-01',
      end_date: '2026-06-30',
      uncategorized: true,
    });

    expect(report).toMatch(/No transactions found/i);
  });
});
