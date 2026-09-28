import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { registerSpendingByCategory } from '../../analysis/spending-by-category.js';
import { registerBudgetVsActual } from '../../analysis/budget-vs-actual.js';
import { registerSpendingProjection } from '../../analysis/spending-projection.js';
import { registerCategoryTrends } from '../../analysis/category-trends.js';
import { sumTransactionsByCategory } from '../../../utils/budget-crosscheck.js';
import type { BudgetMonth, BudgetMonthGroup } from '../../../types.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
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

/**
 * #130 and #131, against the engine.
 *
 * `spending_by_category` walked accounts with a loop of its own that neither
 * followed `subtransactions` nor skipped off-budget accounts, so a split was
 * attributed to nothing and an off-budget row was counted as budget spending.
 * On the real budget that was 35,718.22 of error in one month, and a whole
 * category missing from the report.
 */
describe.skipIf(skip)('spending figures agree with the budget module', () => {
  let onBudget = '';
  let offBudget = '';
  let comida = '';
  let transporte = '';
  let reembolsos = '';
  let sinPresupuesto = '';

  beforeAll(async () => {
    await initTestEngine();
    await createFreshBudget(async () => {
      onBudget = await api.createAccount({ name: 'BanReservas', offbudget: false } as never, 0);
      offBudget = await api.createAccount({ name: 'Prestamo', offbudget: true } as never, 0);
      const g = await api.createCategoryGroup({ name: 'Gastos' } as never);
      comida = await api.createCategory({ name: 'Comida', group_id: g } as never);
      transporte = await api.createCategory({ name: 'Transporte', group_id: g } as never);
      reembolsos = await api.createCategory({ name: 'Reembolsos', group_id: g } as never);
      sinPresupuesto = await api.createCategory({ name: 'Sin Presupuesto', group_id: g } as never);

      await api.addTransactions(onBudget, [
        // A split: the parent carries the total and no category.
        {
          date: '2026-08-10',
          amount: -100000,
          subtransactions: [
            { amount: -60000, category: comida },
            { amount: -40000, category: transporte },
          ],
        },
        { date: '2026-08-11', amount: -20000, category: comida },
        { date: '2026-08-12', amount: 2011300, category: reembolsos },
        { date: '2026-08-13', amount: -33000, category: sinPresupuesto },
      ] as never);
      // Categorised, and on an account outside the budget.
      await api.addTransactions(offBudget, [
        { date: '2026-08-14', amount: -500000, category: comida },
      ] as never);

      await api.setBudgetAmount('2026-08', comida, 100000);
      await api.setBudgetAmount('2026-08', transporte, 50000);
    }, 'sources-agree');
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  /** What the budget module says each category spent, in cents. */
  async function moduleSpending(): Promise<Map<string, number>> {
    const budget = (await api.getBudgetMonth('2026-08')) as unknown as BudgetMonth;
    const map = new Map<string, number>();
    for (const group of budget.categoryGroups as BudgetMonthGroup[]) {
      for (const cat of group.categories ?? []) {
        if (typeof cat.spent === 'number' && cat.spent !== 0) map.set(cat.id, cat.spent);
      }
    }
    return map;
  }

  it('counts each half of a split against its own category', async () => {
    const summed = await sumTransactionsByCategory('2026-08');

    // -600 of the split plus the plain -200, and none of the off-budget -5,000.
    expect(summed.get(comida)).toBe(-80000);
    // The other half of the split, which the old loop could not see at all.
    expect(summed.get(transporte)).toBe(-40000);
  }, 60_000);

  it('agrees with the budget module, category by category', async () => {
    // The test the live review would have needed. Two sources, one fixture
    // holding both shapes that used to pull them apart.
    const fromModule = await moduleSpending();
    const fromTransactions = await sumTransactionsByCategory('2026-08');

    for (const [categoryId, moduleSpent] of fromModule) {
      expect(
        fromTransactions.get(categoryId) ?? 0,
        `category ${categoryId} disagrees`,
      ).toBe(moduleSpent);
    }
    expect(fromModule.size).toBeGreaterThan(2);
  }, 60_000);

  it('leaves an off-budget row out of the report', async () => {
    const result = await handlerFor(registerSpendingByCategory)({
      start_date: '2026-08-01',
      end_date: '2026-08-31',
    });
    const text = result.content[0].text;

    // -800, not -5,200: the off-budget -5,000 is not budget spending.
    expect(text).toMatch(/Comida\s+Gastos\s+-800\.00/);
    // And the category that only existed inside a split is in the report.
    expect(text).toMatch(/Transporte\s+Gastos\s+-400\.00/);
  }, 60_000);

  it('does not call money coming in an under-budget category', async () => {
    const result = await handlerFor(registerBudgetVsActual)({ month: '2026-08' });
    const text = result.content[0].text;

    const line = text.split('\n').find((l) => l.includes('Reembolsos')) ?? '';
    expect(line).toContain('money came in');
    expect(line).not.toContain('Under Budget');

    // And it is out of the footer, not only out of the status column: leaving
    // it in the total would look right and still mislead.
    const under = text.split('\n').find((l) => l.startsWith('Under budget:')) ?? '';
    expect(under).not.toContain('20,113.00');
    expect(under).not.toContain('20,613.00');
  }, 60_000);

  it('does not project money coming in as money going out', async () => {
    const result = await handlerFor(registerSpendingProjection)({ month: '2026-08' });
    const text = result.content[0].text;

    const line = text.split('\n').find((l) => l.includes('Reembolsos')) ?? '';
    expect(line).toContain('money came in');
    expect(line).not.toContain('-20,113.00');
    expect(line).not.toContain('OVER');
  }, 60_000);

  it('counts an overspent category with no budget as needing attention', async () => {
    // It used to announce "0 at risk" on a month with categories overspent and
    // nothing budgeted against them, which is the clearest case of needing
    // attention rather than an exception to it.
    const result = await handlerFor(registerSpendingProjection)({ month: '2026-08' });
    const headline =
      result.content[0].text.split('\n').find((l) => l.startsWith('Categories over')) ?? '';

    expect(headline).not.toMatch(/:\s*0/);
    expect(headline).toContain('with nothing budgeted');
  }, 60_000);

  it('reports a month that only received money as received, not spent', async () => {
    const result = await handlerFor(registerCategoryTrends)({
      category: 'Reembolsos',
      months: 1,
      month: '2026-08',
    });
    const text = result.content[0].text;

    expect(text).toContain('20,113.00');
    expect(text).not.toContain('-20,113.00');
  }, 60_000);

  it('reports the average with the same sign as the months it averages', async () => {
    // The column carries the real figure, so the average has to as well. While
    // the values were magnitudes the line negated them, which was right then
    // and became a sign inversion when the sign fix landed: a category that
    // spent money reported a positive average, reading as money received.
    const result = await handlerFor(registerCategoryTrends)({
      category: 'Comida',
      months: 1,
      month: '2026-08',
    });
    const text = result.content[0].text;

    const average = text.split('\n').find((l) => l.startsWith('Average:')) ?? '';
    expect(average).toContain('-800.00');
    expect(average).not.toMatch(/Average:\s+800\.00/);
  }, 60_000);

  it('does not rank a category that received money among the top spenders', async () => {
    const result = await handlerFor(registerCategoryTrends)({ months: 1, month: '2026-08' });
    const text = result.content[0].text;

    expect(text).toContain('Comida');
    expect(text).not.toContain('Reembolsos');
  }, 60_000);
});
