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
    const toBroker = payees.find((p: any) => p.transfer_acct === broker);

    await api.addTransactions(
      checking,
      [
        { date: '2026-06-05', amount: -100, category: cat, notes: 'sorted' },
        { date: '2026-06-05', amount: -200, notes: 'PLAIN-UNSORTED' },
        {
          date: '2026-06-05',
          amount: -300,
          notes: 'a split',
          subtransactions: [
            { amount: -200, category: cat },
            { amount: -100, notes: 'SPLIT-PART-UNSORTED' },
          ],
        },
        { date: '2026-06-05', amount: -400, payee: toSavings?.id, notes: 'moving my own money' },
        // On-budget to off-budget: Actual keeps the category on this side, so
        // an empty one is a real gap. This is the monthly-contribution shape.
        { date: '2026-06-05', amount: -600, payee: toBroker?.id, notes: 'contribution needing a category' },
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

    expect(report).toMatch(/PLAIN-UNSORTED/);
    expect(report).toMatch(/SPLIT-PART-UNSORTED/);
    // A transfer to an off-budget account keeps its category slot, so an empty
    // one is work. Excluding every transfer hid exactly this.
    expect(report).toMatch(/contribution needing a category/);

    expect(report).not.toMatch(/sorted\b/);
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

    expect(june).toMatch(/PLAIN-UNSORTED/);
    expect(june).not.toMatch(/july/);
    // Without this the test passed with the filter switched off entirely.
    expect(june).not.toMatch(/sorted\b/);
  });

  it('composes with an account, filtering inside it', async () => {
    // On-budget, so the filter has something to do: an earlier version of this
    // test used the off-budget account, where every row lacks a category
    // anyway, so turning the filter off entirely changed nothing and the test
    // still passed.
    await budgetWithEverything();

    const report = await getTransactionsReport({
      account: 'Checking',
      start_date: '2026-06-01',
      end_date: '2026-06-30',
      uncategorized: true,
    });

    expect(report).toMatch(/PLAIN-UNSORTED/);
    expect(report).not.toMatch(/sorted\b/);
    expect(report).not.toMatch(/moving my own money/);
  });

  it('says an off-budget account has nothing to categorise, rather than listing it all', async () => {
    // The engine forces `category = null` on every off-budget transaction, so
    // all of them look unsorted and none can be sorted: recategorising one
    // succeeds and changes nothing.
    await budgetWithEverything();

    const report = await getTransactionsReport({
      account: 'Broker',
      uncategorized: true,
    });

    expect(report).toMatch(/off-budget/i);
    expect(report).toMatch(/nothing here to categorise/i);
    expect(report).not.toMatch(/off budget, needs nothing/);
  });

  it('looks at every date when none is given, since the question carries no date', async () => {
    const { checking } = await budgetWithEverything();
    await api.addTransactions(checking, [
      { date: '2019-03-02', amount: -900, notes: 'old and still unsorted' },
    ] as any);

    const report = await getTransactionsReport({ uncategorized: true });

    // A month-wide default answered "nothing pending" while this sat there.
    expect(report).toMatch(/old and still unsorted/);
  });

  it('gives a split part an id that can actually be recategorised', async () => {
    // The id used to be `parent → child`, which recategorize_transaction
    // accepts, silently does nothing with, and reports as done.
    const { checking } = await budgetWithEverything();

    const report = await getTransactionsReport({
      account: 'Checking',
      uncategorized: true,
    });

    const rows = await api.getTransactions(checking, '2026-06-01', '2026-06-30');
    const parent = (rows as any[]).find((r) => r.is_parent);
    const child = parent.subtransactions.find((s: any) => !s.category);

    expect(report).toContain(child.id);
    expect(report).not.toContain(`${parent.id} →`);
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

  /**
   * The window has two ends. Moving only the start claimed "searches all
   * dates" in the schema, the README and the commit message while still
   * stopping at today, so a future-dated transaction stayed invisible behind a
   * header reading `1900-01-01 to ...` that looked exhaustive. Future dates are
   * ordinary in Actual: a scheduled transaction that has landed, a card charge
   * past the statement date.
   */
  it('reaches transactions dated in the future as well as the past', async () => {
    let checking = '';
    await createFreshBudget(async () => {
      checking = await api.createAccount({ name: 'Checking', type: 'checking' } as any, 0);
    });
    await api.addTransactions(checking, [
      { date: '2019-03-02', amount: -100, notes: 'LONG-AGO' },
      { date: '2027-11-30', amount: -200, notes: 'STILL-TO-COME' },
    ] as any);

    const report = await getTransactionsReport({ uncategorized: true });

    expect(report).toMatch(/LONG-AGO/);
    expect(report).toMatch(/STILL-TO-COME/);
  });

  it('still stops at today when the flag is off', async () => {
    let checking = '';
    await createFreshBudget(async () => {
      checking = await api.createAccount({ name: 'Checking', type: 'checking' } as any, 0);
    });
    await api.addTransactions(checking, [
      { date: '2027-11-30', amount: -200, notes: 'STILL-TO-COME' },
    ] as any);

    const report = await getTransactionsReport({});

    expect(report).not.toMatch(/STILL-TO-COME/);
  });

  it('puts the oldest first, since those are the ones that get forgotten', async () => {
    let checking = '';
    await createFreshBudget(async () => {
      checking = await api.createAccount({ name: 'Checking', type: 'checking' } as any, 0);
    });
    await api.addTransactions(checking, [
      { date: '2026-08-01', amount: -100, notes: 'RECENT' },
      { date: '2019-03-02', amount: -200, notes: 'FORGOTTEN' },
    ] as any);

    const report = await getTransactionsReport({ uncategorized: true });

    // With a backlog and a limit of 50, newest-first would push the oldest past
    // the end of the answer — the rows this flag exists to surface.
    expect(report.indexOf('FORGOTTEN')).toBeLessThan(report.indexOf('RECENT'));
  });
});
