import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { updatePreservingChildAmount } from '../../../utils/transactions.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

/**
 * The #44 guard, against the real engine.
 *
 * The unit tests for this mock `runQuery`, so they assert our logic but say
 * nothing about the behaviour it rests on: that a query filtered by a child's
 * id, with no `splits` option, returns that child row with `is_child` set. That
 * default is undocumented. If Actual ever changes it, `is_child` would come back
 * undefined, the guard would stop firing, and every mocked test would still
 * pass while split transactions silently lost their amounts again — which is
 * exactly how #44 reached production.
 *
 * Since 0.8.1 the server tracks `@actual-app/api` with a caret range, so a
 * behaviour change can arrive without anyone editing this repository. This test
 * is the thing that would notice.
 */
describe.skipIf(skip)('recategorize integration: the #44 guard against the real engine', () => {
  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('preserves a split child amount when only the category changes', async () => {
    let childId = '';
    let parentId = '';
    let groceries = '';
    let household = '';

    const budgetId = await createFreshBudget(async () => {
      const acctId = await api.createAccount({ name: 'Checking', type: 'checking' } as never, 0);
      const groupId = await api.createCategoryGroup({ name: 'Spending' } as never);
      groceries = await api.createCategory({ name: 'Groceries', group_id: groupId } as never);
      household = await api.createCategory({ name: 'Household', group_id: groupId } as never);

      await api.addTransactions(acctId, [
        {
          date: '2026-09-12',
          amount: -10000,
          subtransactions: [
            { amount: -6000, category: groceries },
            { amount: -4000, category: household },
          ],
        },
      ] as never);

      const all = await api.getTransactions(acctId, '2026-09-01', '2026-09-30');
      const parent = all.find((t) => (t as { is_parent?: boolean }).is_parent);
      parentId = parent!.id;
      const subs = (parent as unknown as { subtransactions?: Array<{ id: string; amount: number }> })
        .subtransactions!;
      childId = subs.find((s) => s.amount === -6000)!.id;
    });
    expect(budgetId).toBeTruthy();

    // The precondition the guard depends on: the default query must return the
    // child itself, flagged as a child. If this assertion ever fails, the guard
    // is silently dead even though its unit tests still pass.
    const probe = await api.runQuery(
      api.q('transactions').filter({ id: childId }).select(['id', 'amount', 'is_child']),
    );
    const seen = (probe as { data?: Array<{ amount: number; is_child?: boolean }> }).data?.[0];
    expect(seen, 'the default query no longer returns the split child').toBeTruthy();
    expect(seen!.is_child, 'is_child is no longer set on a split child').toBe(true);
    expect(seen!.amount).toBe(-6000);

    // What recategorize_transaction does: change only the category.
    await updatePreservingChildAmount(childId, { category: household });

    // Reload before asserting. Without a server there is no sync to refresh the
    // in-memory state, so reading straight back returns the pre-write values —
    // the same stale-read trap that let #44 look fixed when it was not.
    await api.loadBudget(budgetId);

    const after = await api.runQuery(
      api
        .q('transactions')
        .filter({ $or: [{ id: parentId }, { parent_id: parentId }] })
        .select(['id', 'amount', 'is_child', 'is_parent', 'category'])
        .options({ splits: 'all' }),
    );
    const rows = (after as {
      data: Array<{ id: string; amount: number; is_child?: boolean; is_parent?: boolean; category?: string }>;
    }).data;

    const child = rows.find((r) => r.id === childId)!;
    expect(child.amount, 'the split child was zeroed — #44 is back').toBe(-6000);
    expect(child.category).toBe(household);

    const parent = rows.find((r) => r.is_parent)!;
    const sum = rows.filter((r) => r.is_child).reduce((acc, r) => acc + r.amount, 0);
    expect(sum, 'the split no longer adds up to its parent').toBe(parent.amount);
  }, 60_000);
});
