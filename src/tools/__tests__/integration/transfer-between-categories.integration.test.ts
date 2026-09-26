import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../../../connection.js', async () => {
  // The internal context lives on the real module and is only populated by
  // `api.init()`. Spreading the mock above copies properties as they are at
  // mock time, which is before init, so this has to read through to the real
  // module and read it per call rather than capture it once.
  const real = await vi.importActual<typeof import('@actual-app/api')>('@actual-app/api');
  return {
    ensureConnection: vi.fn().mockResolvedValue(undefined),
    getInternal: () => (real as unknown as { internal: unknown }).internal,
  };
});

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { registerTransferBetweenCategories } from '../../write/transfer-between-categories.js';
import type { BudgetMonth, BudgetMonthGroup } from '../../../types.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function handlerFor(): Handler {
  let handler: Handler | undefined;
  registerTransferBetweenCategories({
    tool: (...a: unknown[]) => {
      handler = a.at(-1) as Handler;
    },
  } as never);
  if (!handler) throw new Error('tool did not register');
  return handler;
}

/** The month strings this test needs, derived the way `resolveMonth` derives them. */
const now = new Date();
const pad = (n: number) => String(n + 1).padStart(2, '0');
const thisMonth = `${now.getFullYear()}-${pad(now.getMonth())}`;
const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const lastMonth = `${prevDate.getFullYear()}-${pad(prevDate.getMonth())}`;

async function figures(month: string, ids: string[]) {
  const budget = (await api.getBudgetMonth(month)) as unknown as BudgetMonth;
  const all = (budget.categoryGroups as BudgetMonthGroup[]).flatMap((g) => g.categories ?? []);
  return {
    total: budget.totalBudgeted,
    cats: ids.map((id) => {
      const c = all.find((x) => x.id === id);
      return { budgeted: c?.budgeted ?? 0, balance: c?.balance ?? 0 };
    }),
  };
}

/**
 * `transfer_between_categories` (#86) against the real engine.
 *
 * The unit tests mock the engine, so they can only assert that the tool calls
 * what it means to call. Everything this file pins is behaviour of
 * `budget/transfer-category` itself, measured rather than assumed, and the
 * reason the tool refuses what it refuses: that handler validates nothing and
 * reports success whatever it is handed.
 */
describe.skipIf(skip)('transfer_between_categories against the real engine', () => {
  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('moves both budgeted figures and creates no transaction', async () => {
    let groceries = '';
    let dining = '';
    let acctId = '';
    await createFreshBudget(async () => {
      acctId = await api.createAccount({ name: 'Checking', type: 'checking' } as never, 0);
      const g = await api.createCategoryGroup({ name: 'Spending' } as never);
      groceries = await api.createCategory({ name: 'Groceries', group_id: g } as never);
      dining = await api.createCategory({ name: 'Dining', group_id: g } as never);
      // A real row on the account, so the count below compares 1 against 1
      // rather than 0 against 0 and could notice a row being removed as well
      // as one being added.
      await api.addTransactions(acctId, [
        { date: '2026-09-02', amount: -2500, category: groceries },
      ] as never);
    }, 'xfer-basic');

    await api.setBudgetAmount(thisMonth, groceries, 20000);
    await api.setBudgetAmount(thisMonth, dining, 5000);
    const before = await figures(thisMonth, [groceries, dining]);
    const txnsBefore = await api.getTransactions(acctId, '1900-01-01', '2999-12-31');

    const result = await handlerFor()({ from: 'Groceries', to: 'Dining', amount: 114.06 });

    expect(result.isError).toBeFalsy();
    const after = await figures(thisMonth, [groceries, dining]);

    // Both figures move by exactly the amount asked for.
    expect(after.cats[0].budgeted).toBe(before.cats[0].budgeted - 11406);
    expect(after.cats[1].budgeted).toBe(before.cats[1].budgeted + 11406);

    // The month's total is untouched: this moves money, it does not add any.
    expect(after.total).toBe(before.total);

    // The whole point of the issue: no false entries on any card.
    const txnsAfter = await api.getTransactions(acctId, '1900-01-01', '2999-12-31');
    expect(txnsBefore.length).toBe(1);
    expect(txnsAfter.length).toBe(txnsBefore.length);

    const text = result.content[0].text;
    expect(text).toContain('114.06');
    expect(text).toContain('No transaction was created');
  }, 60_000);

  it('moves money that was carried in from a past month', async () => {
    // The carried balance is spendable, and moving it leaves `budgeted`
    // negative for the month. That is the engine's normal representation, not a
    // fault, which is why nothing here refuses a negative budgeted figure.
    let rent = '';
    let dining = '';
    await createFreshBudget(async () => {
      const g = await api.createCategoryGroup({ name: 'Spending' } as never);
      rent = await api.createCategory({ name: 'Rent', group_id: g } as never);
      dining = await api.createCategory({ name: 'Dining', group_id: g } as never);
    }, 'xfer-carry');

    await api.setBudgetAmount(lastMonth, rent, 40000);
    await api.setBudgetCarryover(lastMonth, rent, true);

    const before = await figures(thisMonth, [rent, dining]);
    expect(before.cats[0].budgeted).toBe(0);
    expect(before.cats[0].balance).toBe(40000);

    const result = await handlerFor()({ from: 'Rent', to: 'Dining', amount: 100 });
    expect(result.isError).toBeFalsy();

    const after = await figures(thisMonth, [rent, dining]);
    expect(after.cats[0].budgeted).toBe(-10000);
    expect(after.cats[0].balance).toBe(30000);
    expect(after.cats[1].balance).toBe(before.cats[1].balance + 10000);
  }, 60_000);

  it('says so when a move in a past month shifts the months after it', async () => {
    let groceries = '';
    let dining = '';
    await createFreshBudget(async () => {
      const g = await api.createCategoryGroup({ name: 'Spending' } as never);
      groceries = await api.createCategory({ name: 'Groceries', group_id: g } as never);
      dining = await api.createCategory({ name: 'Dining', group_id: g } as never);
    }, 'xfer-past');

    await api.setBudgetAmount(lastMonth, groceries, 30000);
    const beforeThis = await figures(thisMonth, [groceries, dining]);

    const result = await handlerFor()({
      from: 'Groceries',
      to: 'Dining',
      amount: 50,
      month: lastMonth,
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('is a past month');

    // The claim in that sentence, checked: this month's carried balances moved
    // too, even though the move was booked in the previous month.
    const afterThis = await figures(thisMonth, [groceries, dining]);
    expect(afterThis.cats[0].balance).toBe(beforeThis.cats[0].balance - 5000);
    expect(afterThis.cats[1].balance).toBe(beforeThis.cats[1].balance + 5000);
  }, 60_000);

  it('refuses an income category instead of making the money disappear', async () => {
    // Measured without the refusal: the source category lost the money, the
    // income category's budgeted figure rose, its balance stayed null, and the
    // month's total budgeted did not change. The money is simply gone, and the
    // engine reported success.
    let groceries = '';
    let salary = '';
    await createFreshBudget(async () => {
      const g = await api.createCategoryGroup({ name: 'Spending' } as never);
      groceries = await api.createCategory({ name: 'Groceries', group_id: g } as never);
      // A fresh budget already ships an income group, so this uses that one
      // rather than adding a second with the same name.
      const groups = await api.getCategoryGroups();
      const income = groups.find((x) => (x as { is_income?: boolean }).is_income);
      if (!income) throw new Error('a fresh budget should have an income group');
      salary = await api.createCategory({
        name: 'Bonus',
        group_id: income.id,
        is_income: true,
      } as never);
    }, 'xfer-income');

    await api.setBudgetAmount(thisMonth, groceries, 20000);
    const before = await figures(thisMonth, [groceries, salary]);

    const result = await handlerFor()({ from: 'Groceries', to: 'Bonus', amount: 50 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('income category');
    // The refusal is only worth anything if nothing moved.
    const after = await figures(thisMonth, [groceries, salary]);
    expect(after.cats[0].budgeted).toBe(before.cats[0].budgeted);
  }, 60_000);

  it('refuses a month with a day on it instead of destroying the month', async () => {
    // The worst of the malformed months, and the easiest to send by accident:
    // `resolveDate('today')` returns YYYY-MM-DD and it is one field name away.
    // Measured without the refusal, asking to move 10.00 with month
    // "2026-09-15" took Groceries from 200.00 to -10.00 and Dining from 50.00
    // to 10.00, and returned success.
    let groceries = '';
    let dining = '';
    await createFreshBudget(async () => {
      const g = await api.createCategoryGroup({ name: 'Spending' } as never);
      groceries = await api.createCategory({ name: 'Groceries', group_id: g } as never);
      dining = await api.createCategory({ name: 'Dining', group_id: g } as never);
    }, 'xfer-badmonth');

    await api.setBudgetAmount(thisMonth, groceries, 20000);
    await api.setBudgetAmount(thisMonth, dining, 5000);
    const before = await figures(thisMonth, [groceries, dining]);

    const result = await handlerFor()({
      from: 'Groceries',
      to: 'Dining',
      amount: 10,
      month: `${thisMonth}-15`,
    });

    expect(result.isError).toBe(true);
    const after = await figures(thisMonth, [groceries, dining]);
    expect(after.cats[0].budgeted).toBe(before.cats[0].budgeted);
    expect(after.cats[1].budgeted).toBe(before.cats[1].budgeted);
  }, 60_000);

  it('allows covering an overspent category and reports what it left behind', async () => {
    // Leaving the source short is a real decision, not a mistake, so it goes
    // through. What it must not do is go through quietly.
    let groceries = '';
    let dining = '';
    await createFreshBudget(async () => {
      const g = await api.createCategoryGroup({ name: 'Spending' } as never);
      groceries = await api.createCategory({ name: 'Groceries', group_id: g } as never);
      dining = await api.createCategory({ name: 'Dining', group_id: g } as never);
    }, 'xfer-overspend');

    await api.setBudgetAmount(thisMonth, groceries, 10000);
    const result = await handlerFor()({ from: 'Groceries', to: 'Dining', amount: 150 });

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('Groceries is now overspent by 50.00');

    const after = await figures(thisMonth, [groceries, dining]);
    expect(after.cats[0].balance).toBe(-5000);
    expect(after.cats[1].balance).toBe(15000);
  }, 60_000);
});
