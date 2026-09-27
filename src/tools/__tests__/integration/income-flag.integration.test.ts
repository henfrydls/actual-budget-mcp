import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { registerGetCategories } from '../../read/get-categories.js';
import { registerGetBudgetMonth } from '../../read/get-budget-month.js';
import { registerGetBudgetSummary } from '../../read/get-budget-summary.js';
import { registerSpendingByCategory } from '../../analysis/spending-by-category.js';
import { registerBudgetVsActual } from '../../analysis/budget-vs-actual.js';
import { registerCategoryTrends } from '../../analysis/category-trends.js';
import { registerSpendingProjection } from '../../analysis/spending-projection.js';
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

/**
 * The previous whole month, because `category_trends` takes its reference
 * month from `getMonthRange(current, n)[1]`, which is the month before this
 * one: "the last full month". A fixture in the current month never reaches
 * that code, so the trends test passed whatever the tool did. Derived rather
 * than written down so it does not go stale either.
 */
const previous = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1);
const MONTH = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, '0')}`;
const dayIn = (d: number) => `${MONTH}-${String(d).padStart(2, '0')}`;

/**
 * #116, against the real engine.
 *
 * Eight tools decided whether a category was income by reading its **group's**
 * flag. Actual records it per category, and `category-move` writes only
 * `cat_group` and `sort_order`, so dragging an income category into a spending
 * group in the desktop app leaves the two disagreeing.
 *
 * One budget, checked once for that shape, then each tool asked separately,
 * because each one reads it from a different place and one assertion covering
 * all of them would hide which is which.
 */
describe.skipIf(skip)('an income category inside a spending group (#116)', () => {
  let spendingGroup = '';
  let salary = '';
  let food = '';

  beforeAll(async () => {
    await initTestEngine();
    await createFreshBudget(async () => {
      const acct = await api.createAccount({ name: 'Checking', type: 'checking' } as never, 0);
      spendingGroup = await api.createCategoryGroup({ name: 'Gastos Prueba' } as never);
      food = await api.createCategory({ name: 'Comida', group_id: spendingGroup } as never);
      salary = await api.createCategory({
        name: 'Sueldo Movido',
        group_id: spendingGroup,
        is_income: true,
      } as never);
      await api.addTransactions(acct, [
        { date: dayIn(5), amount: 500000, category: salary, cleared: true },
        { date: dayIn(10), amount: -20000, category: food, cleared: true },
      ] as never);
      await api.setBudgetAmount(MONTH, food, 30000);
    }, 'income-flag');
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('is the shape this file is about', async () => {
    // Asserted before anything else, so none of the tests below can pass
    // against a budget where Actual had normalised the category away.
    const budget = (await api.getBudgetMonth(MONTH)) as unknown as BudgetMonth;
    const group = (budget.categoryGroups as BudgetMonthGroup[]).find(
      (g) => g.id === spendingGroup,
    );
    expect(group?.is_income).toBe(false);
    const row = group?.categories.find((c) => c.id === salary);
    expect(row?.is_income).toBe(true);
    // And the engine files it as spending, which is the whole problem.
    expect(row?.spent).toBe(500000);
    // This one is the notification, not a redundant restatement. The totals
    // correction adds this salary back into income on the grounds that the
    // engine leaves it out. If Actual ever starts counting it, this line fails
    // first and someone looks, rather than the correction quietly double
    // counting it. Do not delete it for looking obvious.
    expect(budget.totalIncome).toBe(0);
  }, 60_000);

  it('spending_by_category leaves it out at the default', async () => {
    const result = await handlerFor(registerSpendingByCategory)({
      start_date: dayIn(1),
      end_date: dayIn(28),
    });
    const text = result.content[0].text;

    expect(text).not.toContain('Sueldo Movido');
    expect(text).toContain('Comida');
    // The acceptance criterion, read literally: no share above 100%. The
    // column reported 104.2% before this. A flat 100.0% is legitimate and a
    // first version of this assertion rejected it, so the percentages are
    // parsed and compared rather than matched as text.
    const shares = [...text.matchAll(/(\d+(?:\.\d+)?)%/g)].map((m) => Number(m[1]));
    expect(shares.length).toBeGreaterThan(0);
    expect(Math.max(...shares)).toBeLessThanOrEqual(100);
  }, 60_000);

  it('spending_by_category still includes it when asked', async () => {
    const result = await handlerFor(registerSpendingByCategory)({
      start_date: dayIn(1),
      end_date: dayIn(28),
      include_income: true,
    });
    expect(result.content[0].text).toContain('Sueldo Movido');
  }, 60_000);

  it('get_budget_summary counts it as income, not as spending', async () => {
    const result = await handlerFor(registerGetBudgetSummary)({ month: MONTH });
    const text = result.content[0].text;

    // The engine reports totalIncome 0 and totalSpent 4,800.00 for this budget.
    expect(text).toMatch(/Income:\s+5,000\.00/);
    expect(text).toMatch(/Total Spent:\s+-200\.00/);
    expect(text).not.toMatch(/Total Spent:\s+4,800\.00/);
    // The group breakdown is built by its own loop, not by the totals above,
    // so it needs its own assertion: with the salary still counted inside the
    // group this line reads 4,800.00 spent while the totals read correctly.
    expect(text).toMatch(/Gastos Prueba\s+300\.00 budgeted \|\s+-200\.00 spent/);
  }, 60_000);

  it('get_budget_month leaves it out of the spending group', async () => {
    const result = await handlerFor(registerGetBudgetMonth)({ month: MONTH });
    const text = result.content[0].text;

    expect(text).toContain('Comida');
    expect(text).not.toContain('Sueldo Movido');
  }, 60_000);

  it('get_categories does not list it as spending', async () => {
    const result = await handlerFor(registerGetCategories)({});
    const text = result.content[0].text;

    // Not under the spending group, and not simply dropped either: it is
    // listed as income, saying where it actually sits.
    const spendingSection = text.slice(text.indexOf('Gastos Prueba'));
    const untilBlank = spendingSection.slice(0, spendingSection.indexOf('\n\n'));
    expect(untilBlank).toContain('Comida');
    expect(untilBlank).not.toContain('Sueldo Movido');
    expect(text).toContain('Sueldo Movido');
    expect(text).toContain('[in Gastos Prueba]');
  }, 60_000);

  it('budget_vs_actual leaves it out', async () => {
    const result = await handlerFor(registerBudgetVsActual)({ month: MONTH });
    expect(result.content[0].text).not.toContain('Sueldo Movido');
  }, 60_000);

  it('spending_projection leaves it out', async () => {
    const result = await handlerFor(registerSpendingProjection)({ month: MONTH });
    expect(result.content[0].text).not.toContain('Sueldo Movido');
  }, 60_000);

  it('category_trends does not rank it among the top spenders', async () => {
    // Without the fix a salary is the largest "spending" category there is.
    const result = await handlerFor(registerCategoryTrends)({ months: 2 });
    const text = result.content[0].text;

    // The tool has to have found something, or this asserts nothing: an
    // earlier version of this test ran against an empty report and passed
    // whatever the code did.
    expect(text).toContain('Comida');
    expect(text).not.toContain('Sueldo Movido');
  }, 60_000);
});
