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

import {
  initTestEngine,
  shutdownTestEngine,
  createFreshBudget,
  api,
  testInternal,
} from './actual-engine.js';
import { registerTransferBetweenCategories } from '../../write/transfer-between-categories.js';
import { getInternal } from '../../../connection.js';
import { formatMoney } from '../../../utils/money.js';
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
    // income category's budgeted figure rose, and its balance stayed null. The
    // money is simply gone, and the engine reported success.
    //
    // This comment also claimed the month's total budgeted did not change.
    // Two runs here said it did not and an audit measured that it did, which
    // means the answer depends on something neither of us pinned down, so the
    // claim is withdrawn rather than decided. What both agree on is the part
    // that matters: a null balance is money nobody can spend.
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

  it('refuses a month with a day on it, and leaves the budget alone', async () => {
    // Named for what it measures. It used to say "instead of destroying the
    // month", which it never demonstrated: loosening `resolveMonth` AND
    // disabling the tool's own shape check, both at once, leaves this green,
    // because `api.getBudgetMonth` refuses the month on its own and the tool
    // reads the figures before it writes. The guards give the person a clear
    // answer early; the read is what keeps the bad month away from the
    // handler. The test below is the one that exercises the handler.
    //
    // It is still the easiest malformed month to send by accident:
    // `resolveDate('today')` returns YYYY-MM-DD and it is one field name away.
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
    // Named, because asserting only `isError` passes just as well when the
    // refusal was about something else entirely: the same test went green with
    // a category name that did not exist.
    expect(result.content[0].text).toContain('month');
    const after = await figures(thisMonth, [groceries, dining]);
    expect(after.cats[0].budgeted).toBe(before.cats[0].budgeted);
    expect(after.cats[1].budgeted).toBe(before.cats[1].budgeted);
  }, 60_000);

  it('refuses an income category that lives in a spending group', async () => {
    // Actual records income per category, and dragging one into a spending
    // group in the desktop UI keeps the flag: `category-move` writes only
    // `cat_group` and `sort_order`. A guard that read the group's flag let this
    // through, and measured, money moved into such a category came back with
    // `balance: null` — in, where nobody can spend it, and out, inventing money
    // that was never there.
    let groceries = '';
    let sneaky = '';
    let spendingGroup = '';
    await createFreshBudget(async () => {
      spendingGroup = await api.createCategoryGroup({ name: 'Spending' } as never);
      groceries = await api.createCategory({ name: 'Groceries', group_id: spendingGroup } as never);
      sneaky = await api.createCategory({
        name: 'Refunds',
        group_id: spendingGroup,
        is_income: true,
      } as never);
    }, 'xfer-income-in-spending');

    // The shape this test exists for, confirmed before anything is asserted
    // about the guard. Without this the test could pass against a budget where
    // Actual had normalised the category into an income group, which is not the
    // case being covered.
    const budget = (await api.getBudgetMonth(thisMonth)) as unknown as BudgetMonth;
    const group = (budget.categoryGroups as BudgetMonthGroup[]).find(
      (g) => g.id === spendingGroup,
    );
    expect(group?.is_income).toBe(false);
    const row = group?.categories.find((c) => c.id === sneaky) as
      | { is_income?: boolean }
      | undefined;
    expect(row?.is_income).toBe(true);

    await api.setBudgetAmount(thisMonth, groceries, 20000);
    const before = await figures(thisMonth, [groceries, sneaky]);

    const result = await handlerFor()({ from: 'Groceries', to: 'Refunds', amount: 50 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('income category');
    const after = await figures(thisMonth, [groceries, sneaky]);
    expect(after.cats[0].budgeted).toBe(before.cats[0].budgeted);

    // And the other direction, which is the one that invents money.
    const back = await handlerFor()({ from: 'Refunds', to: 'Groceries', amount: 50 });
    expect(back.isError).toBe(true);
    expect(back.content[0].text).toContain('income category');
    const afterBack = await figures(thisMonth, [groceries, sneaky]);
    expect(afterBack.cats[0].budgeted).toBe(before.cats[0].budgeted);
  }, 60_000);

  it('the engine handler really does destroy a month given a day', async () => {
    // The claim the whole design rests on, exercised rather than remembered.
    // Nothing else here reaches the handler with a bad month, because the tool
    // refuses first, so without this the justification for every guard above is
    // a sentence in a commit message.
    //
    // If Actual ever fixes this, this test fails, and that is the point: it is
    // the notification. The same reasoning as the #44 guard, which pins an
    // undocumented default of the same dependency.
    let groceries = '';
    let dining = '';
    await createFreshBudget(async () => {
      const g = await api.createCategoryGroup({ name: 'Spending' } as never);
      groceries = await api.createCategory({ name: 'Groceries', group_id: g } as never);
      dining = await api.createCategory({ name: 'Dining', group_id: g } as never);
    }, 'xfer-handler-damage');

    await api.setBudgetAmount(thisMonth, groceries, 20000);
    await api.setBudgetAmount(thisMonth, dining, 5000);

    // 10.00, from a category holding 200.00 to one holding 50.00.
    await (getInternal() as unknown as {
      send: (m: string, a: unknown) => Promise<unknown>;
    }).send('budget/transfer-category', {
      month: `${thisMonth}-15`,
      amount: 1000,
      from: groceries,
      to: dining,
    });

    const after = await figures(thisMonth, [groceries, dining]);
    // Not 190.00 and 60.00. The source is left owing, and the destination
    // holds the amount of the move instead of its own budget plus the move:
    // `sheetForMonth` replaces only the first dash, so both figures are read
    // from a sheet that does not exist, while `dbMonth`'s parseInt stops at the
    // dash and writes to the real month. It is an overwrite, not a move.
    expect(after.cats[0].budgeted).toBe(-1000);
    expect(after.cats[1].budgeted).toBe(1000);
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

  /**
   * Money to and from the pool that is not budgeted yet (#114).
   *
   * The engine takes the literal `to-budget` at either end of the same
   * handler. The other way out of the pool, `budget/transfer-available`, is
   * not used here: measured, it clamps silently, so asking for more than
   * there is moves what there is and says nothing, and a negative amount
   * does nothing and says nothing.
   */
  describe('the pool', () => {
    let groceries = '';
    let collision = '';

    beforeAll(async () => {
      await createFreshBudget(async () => {
        const g = await api.createCategoryGroup({ name: 'Spending' } as never);
        groceries = await api.createCategory({ name: 'Groceries', group_id: g } as never);
        const acct = await api.createAccount({ name: 'Checking', type: 'checking' } as never, 0);
        await api.addTransactions(acct, [{ date: `${thisMonth}-01`, amount: 100000 }] as never);
      }, 'xfer-pool');
      await api.setBudgetAmount(thisMonth, groceries, 12500);
    }, 60_000);

    const pool = async (month: string) =>
      ((await api.getBudgetMonth(month)) as unknown as BudgetMonth).toBudget;

    it('returns money to the pool', async () => {
      const before = await figures(thisMonth, [groceries]);
      const poolBefore = await pool(thisMonth);

      const result = await handlerFor()({ from: 'Groceries', to: 'To Budget', amount: 25 });

      expect(result.isError, result.content[0]?.text).toBeFalsy();
      const after = await figures(thisMonth, [groceries]);
      expect(after.cats[0].budgeted).toBe(before.cats[0].budgeted - 2500);
      expect(await pool(thisMonth), 'the pool rises by the same amount').toBe(poolBefore + 2500);
      expect(result.content[0].text).toContain('To Budget');
    }, 60_000);

    it('takes money out of the pool, the exact amount asked for', async () => {
      const before = await figures(thisMonth, [groceries]);
      const poolBefore = await pool(thisMonth);

      const result = await handlerFor()({ from: 'To Budget', to: 'Groceries', amount: 30 });

      expect(result.isError, result.content[0]?.text).toBeFalsy();
      const after = await figures(thisMonth, [groceries]);
      expect(after.cats[0].budgeted).toBe(before.cats[0].budgeted + 3000);
      expect(await pool(thisMonth)).toBe(poolBefore - 3000);
    }, 60_000);

    it('moves more than the pool holds, and says the month is over', async () => {
      // The engine allows a month to assign more than it has, and so does
      // this: refusing would be inventing a rule Actual does not have. What
      // it must not do is move a different figure quietly, which is what
      // `transfer-available` would have done.
      const poolBefore = await pool(thisMonth);
      const asking = poolBefore / 100 + 500;

      const result = await handlerFor()({ from: 'To Budget', to: 'Groceries', amount: asking });

      expect(result.isError, result.content[0]?.text).toBeFalsy();
      expect(await pool(thisMonth)).toBe(poolBefore - Math.round(asking * 100));
      expect(result.content[0].text).toContain('assigns more than it has');
    }, 60_000);

    it.each(['to budget', 'TO BUDGET', 'to-budget'])('answers to %s', async (spelling) => {
      const poolBefore = await pool(thisMonth);

      const result = await handlerFor()({ from: 'Groceries', to: spelling, amount: 1 });

      expect(result.isError, result.content[0]?.text).toBeFalsy();
      expect(await pool(thisMonth)).toBe(poolBefore + 100);
    }, 60_000);

    it('refuses both ends being the pool', async () => {
      const result = await handlerFor()({ from: 'To Budget', to: 'To Budget', amount: 5 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('nothing to move');
    }, 60_000);

    it('refuses the name when a real category is called that, and says which id', async () => {
      // A budget with a category called "To Budget" is not far-fetched, and
      // guessing which one was meant is the one thing this must not do.
      await createFreshBudget(async () => {
        const g = await api.createCategoryGroup({ name: 'Spending' } as never);
        collision = await api.createCategory({ name: 'To Budget', group_id: g } as never);
        await api.createCategory({ name: 'Groceries', group_id: g } as never);
      }, 'xfer-pool-clash');

      const result = await handlerFor()({ from: 'Groceries', to: 'To Budget', amount: 5 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('you also have a category called that');
      expect(result.content[0].text).toContain(collision);
    }, 60_000);

    it('still moves to that category when its id is given', async () => {
      const result = await handlerFor()({ from: 'Groceries', to: collision, amount: 5 });

      expect(result.isError, result.content[0]?.text).toBeFalsy();
    }, 60_000);
  });

  /**
   * What the pool costs when it is the **source** (#114, round two).
   *
   * `transferCategory` guards the destination and not the source, so asking
   * the handler for money out of the pool writes a budget row for a category
   * called `to-budget`, which nobody has. These tests pin both halves: the
   * engine still does it, and this tool no longer asks it to.
   */
  describe('money out of the pool', () => {
    let groceries = '';

    /** The junk rows, read straight from the table they land in. */
    const poolRows = async () =>
      testInternal().db.all<{ id: string; amount: number }>(
        "select id, amount from zero_budgets where category = 'to-budget'",
      );

    const pool = async (month: string) =>
      ((await api.getBudgetMonth(month)) as unknown as BudgetMonth).toBudget;

    beforeAll(async () => {
      await createFreshBudget(async () => {
        const spending = await api.createCategoryGroup({ name: 'Spending' } as never);
        groceries = await api.createCategory({ name: 'Groceries', group_id: spending } as never);
        // The budget's own income group, not one made here: measured,
        // `createCategoryGroup` ignores `is_income` and the group comes back
        // as a spending one, so a deposit against it never reaches the pool.
        const earnings = (await api.getCategoryGroups()).find((g) => g.is_income);
        if (!earnings) throw new Error('a fresh budget has no income group');
        const salary = await api.createCategory({
          name: 'Salary',
          group_id: earnings.id,
          is_income: true,
        } as never);
        const acct = await api.createAccount({ name: 'Checking', type: 'checking' } as never, 0);
        // Income on an income category, which is what gives the month a pool
        // to take from. An uncategorised deposit does not: measured, it leaves
        // `toBudget` at zero.
        await api.addTransactions(acct, [
          { date: `${lastMonth}-01`, amount: 200000, category: salary },
          { date: `${thisMonth}-01`, amount: 300000, category: salary },
        ] as never);
      }, 'xfer-pool-rows');
      await api.setBudgetAmount(thisMonth, groceries, 12500);
    }, 60_000);

    it('leaves no budget row for a category nobody has', async () => {
      const before = await figures(thisMonth, [groceries]);

      const result = await handlerFor()({ from: 'To Budget', to: 'Groceries', amount: 30 });

      expect(result.isError, result.content[0]?.text).toBeFalsy();
      const after = await figures(thisMonth, [groceries]);
      expect(after.cats[0].budgeted).toBe(before.cats[0].budgeted + 3000);
      expect(await poolRows(), 'nothing addressed to "to-budget" in zero_budgets').toEqual([]);
    }, 60_000);

    it('reports the pool with the month figure, and only where it belongs', async () => {
      const month = (await api.getBudgetMonth(thisMonth)) as unknown as BudgetMonth;
      // The two figures have to differ for this to be able to fail: the pool
      // is what is left to assign, the total is what is assigned already.
      expect(month.toBudget).not.toBe(month.totalBudgeted);
      const poolBefore = month.toBudget;

      const result = await handlerFor()({ from: 'To Budget', to: 'Groceries', amount: 30 });

      expect(result.isError, result.content[0]?.text).toBeFalsy();
      const text = result.content[0].text;
      expect(text).toContain(
        `To Budget   ${formatMoney(poolBefore)} -> ${formatMoney(poolBefore - 3000)}`,
      );
      // Budgeted and available are the same number for the pool, so it is
      // listed once. The second section is the category's alone.
      const availableRows = text
        .split('Available:')[1]
        .split('\n\n')[0]
        .split('\n')
        .filter((line) => line.trim() !== '');
      expect(availableRows).toHaveLength(1);
      expect(availableRows[0]).toContain('Groceries');
      expect(text).toContain(
        'What changed is how much of this month is assigned, not how much money there is.',
      );
      expect(text).not.toContain('the month total is unchanged');
      // There is money left, so nothing is said about the month being over.
      expect(poolBefore - 3000).toBeGreaterThan(0);
      expect(text).not.toContain('assigns more than it has');
    }, 60_000);

    it('reads the name with the spaces a person leaves around it', async () => {
      const poolBefore = await pool(thisMonth);

      const result = await handlerFor()({ from: '  To Budget  ', to: 'Groceries', amount: 1 });

      expect(result.isError, result.content[0]?.text).toBeFalsy();
      expect(await pool(thisMonth)).toBe(poolBefore - 100);
    }, 60_000);

    it('says what a past month moves, and names one category because there is one', async () => {
      const before = {
        past: await pool(lastMonth),
        now: await pool(thisMonth),
      };

      const result = await handlerFor()({
        from: 'To Budget',
        to: 'Groceries',
        amount: 30,
        month: lastMonth,
      });

      expect(result.isError, result.content[0]?.text).toBeFalsy();
      // Measured: the pool falls by the same amount in the month asked for
      // and in the ones after it, which is what the reply now says.
      expect(await pool(lastMonth)).toBe(before.past - 3000);
      expect(await pool(thisMonth)).toBe(before.now - 3000);
      const text = result.content[0].text;
      expect(text).toContain('what Groceries carries into');
      expect(text).toContain('and To Budget in those months');
      expect(text).not.toContain('both categories');
    }, 60_000);

    it('is what the engine would have written, which is why this does not ask it to', async () => {
      // The canary for the guard above. If Actual ever validates the source
      // the way it validates the destination, this fails, and the handler can
      // be used in both directions again.
      expect(await poolRows()).toEqual([]);

      await getInternal().send('budget/transfer-category', {
        month: thisMonth,
        amount: 1000,
        from: 'to-budget',
        to: groceries,
      } as never);

      expect(await poolRows()).toEqual([
        { id: `${thisMonth.replace('-', '')}-to-budget`, amount: -1000 },
      ]);
    }, 60_000);
  });

  /**
   * A category whose name only contains the reserved word (#114, round two).
   *
   * Before this, "To Budget" with no such category to match reached
   * "To Budget Extra" through the resolver's substring step. It now reaches
   * the pool, and that is the intended answer rather than an ambiguity: the
   * reserved word is an exact match and a substring match is the weaker one,
   * which is the rule the resolver already applies between two categories.
   * The category keeps its own name, which is what this pins.
   */
  describe('a category called "To Budget Extra"', () => {
    let extra = '';
    let groceries = '';

    beforeAll(async () => {
      await createFreshBudget(async () => {
        const g = await api.createCategoryGroup({ name: 'Spending' } as never);
        extra = await api.createCategory({ name: 'To Budget Extra', group_id: g } as never);
        groceries = await api.createCategory({ name: 'Groceries', group_id: g } as never);
      }, 'xfer-pool-substring');
      await api.setBudgetAmount(thisMonth, groceries, 10000);
      await api.setBudgetAmount(thisMonth, extra, 4000);
    }, 60_000);

    it('does not take the reserved word from the pool', async () => {
      const before = await figures(thisMonth, [groceries, extra]);

      const result = await handlerFor()({ from: 'Groceries', to: 'To Budget', amount: 25 });

      expect(result.isError, result.content[0]?.text).toBeFalsy();
      const after = await figures(thisMonth, [groceries, extra]);
      expect(after.cats[0].budgeted).toBe(before.cats[0].budgeted - 2500);
      expect(after.cats[1].budgeted, 'the category is left alone').toBe(before.cats[1].budgeted);
      expect(result.content[0].text).not.toContain('To Budget Extra');
    }, 60_000);

    it('is still reached by its own name', async () => {
      const before = await figures(thisMonth, [groceries, extra]);

      const result = await handlerFor()({ from: 'Groceries', to: 'To Budget Extra', amount: 25 });

      expect(result.isError, result.content[0]?.text).toBeFalsy();
      const after = await figures(thisMonth, [groceries, extra]);
      expect(after.cats[1].budgeted).toBe(before.cats[1].budgeted + 2500);
    }, 60_000);
  });

  /**
   * The clash is in the category's name, not in how the request spelled it
   * (#114, round two). Comparing the category against the typed text let
   * every crossed spelling through.
   */
  describe.each([
    ['to-budget', 'To Budget'],
    ['to-budget', 'to budget'],
    ['To Budget', 'to-budget'],
    ['TO BUDGET', 'to budget'],
  ])('a category called %s, asked for as %s', (name, typed) => {
    it('is refused, whichever way round the two are spelled', async () => {
      let clash = '';
      await createFreshBudget(async () => {
        const g = await api.createCategoryGroup({ name: 'Spending' } as never);
        clash = await api.createCategory({ name, group_id: g } as never);
        await api.createCategory({ name: 'Groceries', group_id: g } as never);
      }, 'xfer-pool-spelling');

      const result = await handlerFor()({ from: 'Groceries', to: typed, amount: 5 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('you also have a category called that');
      expect(result.content[0].text).toContain(clash);
    }, 60_000);
  });
});
