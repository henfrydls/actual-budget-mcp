import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { registerUpdateBudgetAmount } from '../../write/update-budget-amount.js';
import type { BudgetMonth, BudgetMonthGroup } from '../../../types.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function handlerFor(): Handler {
  let handler: Handler | undefined;
  registerUpdateBudgetAmount({
    tool: (...a: unknown[]) => {
      handler = a.at(-1) as Handler;
    },
  } as never);
  return handler as Handler;
}

const MONTH = '2026-09';
const PREV = '2026-08';

/**
 * `update_budget_amount` with a delta (#84), against the real engine.
 *
 * The case the issue is built on is the one that matters: a category carrying
 * a balance forward with real spending against it, where the absolute figure
 * that reaches a given balance is a number produced to reach a number.
 */
describe.skipIf(skip)('update_budget_amount delta mode', () => {
  let salud = '';
  let bonus = '';

  async function budget(name: string) {
    await createFreshBudget(async () => {
      const acct = await api.createAccount({ name: 'Checking', type: 'checking' } as never, 0);
      const g = await api.createCategoryGroup({ name: 'Gastos' } as never);
      salud = await api.createCategory({ name: 'Salud', group_id: g } as never);
      const groups = await api.getCategoryGroups();
      const income = groups.find((x) => (x as { is_income?: boolean }).is_income);
      bonus = await api.createCategory({
        name: 'Bono',
        group_id: (income as { id: string }).id,
        is_income: true,
      } as never);

      // 5,500.00 carried forward from August, 19,161.07 spent in September.
      await api.setBudgetAmount(PREV, salud, 550000);
      await api.setBudgetCarryover(PREV, salud, true);
      await api.addTransactions(acct, [
        { date: '2026-09-10', amount: -1916107, category: salud, cleared: true },
      ] as never);
    }, name);
  }

  async function figures(id: string) {
    const b = (await api.getBudgetMonth(MONTH)) as unknown as BudgetMonth;
    const cat = (b.categoryGroups as BudgetMonthGroup[])
      .flatMap((g) => g.categories ?? [])
      .find((c) => c.id === id);
    return { budgeted: cat?.budgeted, balance: cat?.balance, spent: cat?.spent };
  }

  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('is the situation the issue describes', async () => {
    await budget('delta-shape');
    const before = await figures(salud);

    // Nothing budgeted this month, 5,500.00 carried in, 19,161.07 spent.
    expect(before.budgeted).toBe(0);
    expect(before.spent).toBe(-1916107);
    expect(before.balance).toBe(-1366107);
  }, 60_000);

  it('adds to what is there, rollover and spending included', async () => {
    await budget('delta-add');
    const before = await figures(salud);

    const result = await handlerFor()({
      category: 'Salud',
      amount: 10000,
      month: MONTH,
      mode: 'delta',
    });

    expect(result.isError).toBeFalsy();
    const after = await figures(salud);

    expect(after.budgeted).toBe(before.budgeted! + 1000000);
    // The point of the mode: the envelope has 10,000.00 more in it than it did.
    expect(after.balance).toBe(before.balance! + 1000000);
    expect(result.content[0].text).toContain('Added 10,000.00 to what was there');
  }, 60_000);

  it('takes money back out with a negative delta', async () => {
    await budget('delta-negative');
    await handlerFor()({ category: 'Salud', amount: 10000, month: MONTH, mode: 'delta' });
    const before = await figures(salud);

    await handlerFor()({ category: 'Salud', amount: -3000, month: MONTH, mode: 'delta' });
    const after = await figures(salud);

    expect(after.budgeted).toBe(before.budgeted! - 300000);
    expect(after.balance).toBe(before.balance! - 300000);
  }, 60_000);

  it('reaches the same place as the absolute figure the caller would have computed', async () => {
    // Both routes to the same place, from a category that **already has a
    // figure budgeted**. Starting from zero, as this test first did, adding and
    // replacing are the same operation, so it passed with the delta ignoring
    // what was there: 23,661.07 + 0 and 23,661.07 are the same number. The
    // mutation that drops the addition survived it, which is what an audit
    // showed and what the mutation counts in my own sweep had already said,
    // if I had read which test caught it rather than how many.
    await budget('delta-equivalence');
    await handlerFor()({ category: 'Salud', amount: 4000, month: MONTH });

    await handlerFor()({ category: 'Salud', amount: 23661.07, month: MONTH });
    const viaAbsolute = await figures(salud);
    expect(viaAbsolute.balance).toBe(1000000);

    await budget('delta-equivalence-2');
    await handlerFor()({ category: 'Salud', amount: 4000, month: MONTH });
    const start = await figures(salud);
    expect(start.budgeted).toBe(400000);

    // 10,000.00 wanted, and the gap from where it already sits.
    await handlerFor()({
      category: 'Salud',
      amount: (1000000 - start.balance!) / 100,
      month: MONTH,
      mode: 'delta',
    });
    const viaDelta = await figures(salud);

    expect(viaDelta.budgeted).toBe(viaAbsolute.budgeted);
    expect(viaDelta.balance).toBe(1000000);
  }, 60_000);

  it('does not lose one of two deltas running at once', async () => {
    // Measured before the queue: two of +1,000.00 against an empty category
    // left 1,000.00, because each read before either wrote. Both replies said
    // `Old: 0.00 | New: 1,000.00` and each was right about itself, so nothing
    // in the replies showed the loss either.
    await budget('delta-race');
    const handler = handlerFor();

    const [first, second] = await Promise.all([
      handler({ category: 'Salud', amount: 1000, month: MONTH, mode: 'delta' }),
      handler({ category: 'Salud', amount: 1000, month: MONTH, mode: 'delta' }),
    ]);

    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    expect((await figures(salud)).budgeted).toBe(200000);

    // And the two replies describe a sequence rather than both claiming the
    // same starting point.
    const texts = [first.content[0].text, second.content[0].text];
    expect(texts.some((t) => t.includes('Old: 0.00'))).toBe(true);
    expect(texts.some((t) => t.includes('Old: 1,000.00'))).toBe(true);
  }, 60_000);

  it('leaves absolute mode exactly as it was', async () => {
    await budget('delta-absolute');

    const result = await handlerFor()({ category: 'Salud', amount: 2500, month: MONTH });

    expect(result.isError).toBeFalsy();
    expect((await figures(salud)).budgeted).toBe(250000);
    const text = result.content[0].text;
    expect(text).toContain('Old: 0.00');
    expect(text).toContain('New: 2,500.00');
    // The delta sentence belongs only to the delta.
    expect(text).not.toContain('Added');
  }, 60_000);

  it('refuses a delta on a category with no figure to add to', async () => {
    // An income category comes back with `budgeted` undefined. Adding to it
    // gives NaN, and the engine would either throw something opaque or write
    // nothing at all.
    await budget('delta-income');
    const before = (await api.getBudgetMonth(MONTH)) as unknown as BudgetMonth;

    const result = await handlerFor()({
      category: 'Bono',
      amount: 5000,
      month: MONTH,
      mode: 'delta',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('nothing to start from');
    const after = (await api.getBudgetMonth(MONTH)) as unknown as BudgetMonth;
    expect(after.totalBudgeted).toBe(before.totalBudgeted);
  }, 60_000);

  it('starts from zero on a category nobody has budgeted yet', async () => {
    await budget('delta-fresh');
    const fresh = await api.createCategory({
      name: 'Nueva',
      group_id: (await api.getCategoryGroups()).find((g) => g.name === 'Gastos')!.id,
    } as never);

    await handlerFor()({ category: 'Nueva', amount: 750, month: MONTH, mode: 'delta' });

    expect((await figures(fresh)).budgeted).toBe(75000);
  }, 60_000);
});
