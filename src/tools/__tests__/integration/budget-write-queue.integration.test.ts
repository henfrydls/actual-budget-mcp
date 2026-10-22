import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../../../connection.js', async () => {
  const real = await vi.importActual<typeof import('@actual-app/api')>('@actual-app/api');
  return {
    ensureConnection: vi.fn().mockResolvedValue(undefined),
    getInternal: () => (real as unknown as { internal: unknown }).internal,
  };
});

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { registerTransferBetweenCategories } from '../../write/transfer-between-categories.js';
import { registerUpdateBudgetAmount } from '../../write/update-budget-amount.js';
import type { BudgetMonth, BudgetMonthGroup } from '../../../types.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function handlerFor(register: (s: never) => void): Handler {
  let handler: Handler | undefined;
  register({
    tool: (...a: unknown[]) => {
      handler = a.at(-1) as Handler;
    },
  } as never);
  return handler as Handler;
}

const now = new Date();
const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

/**
 * Two different tools writing the same budget figure (#114, round four).
 *
 * `update_budget_amount` and `transfer_between_categories` both read a
 * category's budgeted figure and write what depends on it, so they share one
 * queue. A queue each would pass every test either of them has: each one
 * would still be safe against itself, and the lost update would only appear
 * when the two are used together, which is the ordinary case of an agent
 * adjusting a budget.
 *
 * What these two cannot show is the order. Measured: with a queue each, these
 * same calls still add up, because on this engine the two paths do not reach
 * their reads at the same moment, and a test that cannot fail is not a test.
 * The order is pinned in `budget-queue-shared.test.ts`, which holds one
 * tool's write open and asks whether the other reads anyway. What is here is
 * the arithmetic: that both writes land, against the real engine, in a real
 * budget, through the handlers a client would call.
 */
describe.skipIf(skip)('the budget queue is one queue', () => {
  let groceries = '';

  beforeAll(async () => {
    await initTestEngine();
    await createFreshBudget(async () => {
      const group = await api.createCategoryGroup({ name: 'Spending' } as never);
      groceries = await api.createCategory({ name: 'Groceries', group_id: group } as never);
      const income = (await api.getCategoryGroups()).find((g) => g.is_income);
      const salary = await api.createCategory({
        name: 'Salary',
        group_id: income?.id,
        is_income: true,
      } as never);
      const acct = await api.createAccount({ name: 'Checking', type: 'checking' } as never, 0);
      await api.addTransactions(acct, [
        { date: `${thisMonth}-01`, amount: 500000, category: salary },
      ] as never);
    }, 'budget-queue');
    await api.setBudgetAmount(thisMonth, groceries, 10000);
  }, 120_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  async function budgeted(): Promise<number> {
    const budget = (await api.getBudgetMonth(thisMonth)) as unknown as BudgetMonth;
    for (const group of budget.categoryGroups as BudgetMonthGroup[]) {
      const found = (group.categories ?? []).find((c) => c.id === groceries);
      if (found) return found.budgeted ?? 0;
    }
    return 0;
  }

  it('keeps a delta and a transfer from overwriting each other', async () => {
    const before = await budgeted();

    const [delta, moved] = await Promise.all([
      handlerFor(registerUpdateBudgetAmount)({
        category: 'Groceries',
        amount: 100,
        mode: 'delta',
        month: thisMonth,
      }),
      handlerFor(registerTransferBetweenCategories)({
        from: 'To Budget',
        to: 'Groceries',
        amount: 50,
        month: thisMonth,
      }),
    ]);

    expect(delta.isError, delta.content[0]?.text).toBeFalsy();
    expect(moved.isError, moved.content[0]?.text).toBeFalsy();
    // Both landed. With a queue each, one of the two figures is the one that
    // was read before the other wrote, and the total is 100.00 or 50.00 short.
    expect(await budgeted()).toBe(before + 15000);
  }, 60_000);

  it('keeps an absolute set from landing inside a transfer', async () => {
    await api.setBudgetAmount(thisMonth, groceries, 10000);

    const [set, moved] = await Promise.all([
      handlerFor(registerUpdateBudgetAmount)({
        category: 'Groceries',
        amount: 400,
        month: thisMonth,
      }),
      handlerFor(registerTransferBetweenCategories)({
        from: 'To Budget',
        to: 'Groceries',
        amount: 50,
        month: thisMonth,
      }),
    ]);

    expect(set.isError, set.content[0]?.text).toBeFalsy();
    expect(moved.isError, moved.content[0]?.text).toBeFalsy();
    // Whichever arrived first, both are accounted for: the absolute set
    // either starts the pair or replaces what the transfer left, and the
    // only figure that cannot appear is one where a write was dropped.
    expect([45000, 40000]).toContain(await budgeted());
  }, 60_000);
});
