import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { registerGetBudgetMonth } from '../../read/get-budget-month.js';
import { registerGetBudgetSummary } from '../../read/get-budget-summary.js';

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

const now = new Date();
const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

/**
 * Money held for next month, where a reader would look for it (#265).
 *
 * Seen in the live test of 0.11.0: `hold_for_next_month` sets money aside and
 * the figure appeared in the reply to that call and nowhere else. A month
 * read afterwards said what was left to assign, which is the figure the hold
 * had just reduced, with nothing to say where the rest had gone.
 */
describe.skipIf(skip)('a month that is holding money for the next one', () => {
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
        { date: `${thisMonth}-01`, amount: 300000, category: salary },
      ] as never);
    }, 'held-in-month');
    await api.setBudgetAmount(thisMonth, groceries, 50000);
  }, 120_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('says nothing about it while nothing is held', async () => {
    const month = (await handlerFor(registerGetBudgetMonth)({})).content[0].text;
    const summary = (await handlerFor(registerGetBudgetSummary)({})).content[0].text;

    expect(month).toContain('To Be Budgeted:');
    expect(month).not.toContain('Held for next month');
    expect(summary).not.toContain('Held for next month');
  }, 60_000);

  it('shows the figure in both readers once there is one', async () => {
    await api.holdBudgetForNextMonth(thisMonth, 75000);

    const month = (await handlerFor(registerGetBudgetMonth)({})).content[0].text;
    const summary = (await handlerFor(registerGetBudgetSummary)({})).content[0].text;

    expect(month).toContain('Held for next month: 750.00');
    expect(summary).toMatch(/Held for next month:\s+750\.00/);
  }, 60_000);

  it('is beside what is left to assign, which is what it came out of', async () => {
    // The hold takes from the same pool, so the two figures are read
    // together: what is left, and what is spoken for already.
    const month = (await handlerFor(registerGetBudgetMonth)({})).content[0].text;
    const lines = month.split('\n');
    const left = lines.findIndex((l) => l.startsWith('To Be Budgeted:'));
    const held = lines.findIndex((l) => l.startsWith('Held for next month:'));

    expect(left).toBeGreaterThanOrEqual(0);
    expect(held).toBe(left + 1);
  }, 60_000);

  it('keeps the figures of the summary in one column', async () => {
    // The label is one character wider than the ones above it, so without
    // the narrower padding the figure sits one place to the right and the
    // column bends around it.
    const summary = (await handlerFor(registerGetBudgetSummary)({})).content[0].text;
    const ends = summary
      .split('\n')
      .filter((line) => /^(Income|Total Budgeted|To Be Budgeted|Held for next month):/.test(line))
      .map((line) => line.length);

    expect(ends.length).toBe(4);
    expect(new Set(ends).size, `lines of different lengths: ${ends.join(', ')}`).toBe(1);
  }, 60_000);

  it('puts it under what is left to assign in the summary too', async () => {
    const summary = (await handlerFor(registerGetBudgetSummary)({})).content[0].text;
    const lines = summary.split('\n');
    const left = lines.findIndex((l) => l.startsWith('To Be Budgeted:'));
    const held = lines.findIndex((l) => l.startsWith('Held for next month:'));

    expect(left).toBeGreaterThanOrEqual(0);
    expect(held).toBe(left + 1);
  }, 60_000);

  it('says nothing about it in a tracking budget, which has no such thing', async () => {
    // There the month comes back with `forNextMonth` null, and a check for
    // "not zero" rather than for a figure would print 0.00 in a budget that
    // cannot hold anything.
    await api.setPreference('budgetType', 'tracking');
    try {
      const month = (await handlerFor(registerGetBudgetMonth)({})).content[0].text;
      const summary = (await handlerFor(registerGetBudgetSummary)({})).content[0].text;

      expect(month).not.toContain('Held for next month');
      expect(summary).not.toContain('Held for next month');
    } finally {
      await api.setPreference('budgetType', 'envelope');
    }
  }, 60_000);

  it('goes away again when the hold is released', async () => {
    await api.resetBudgetHold(thisMonth);

    const month = (await handlerFor(registerGetBudgetMonth)({})).content[0].text;

    expect(month).not.toContain('Held for next month');
  }, 60_000);
});
