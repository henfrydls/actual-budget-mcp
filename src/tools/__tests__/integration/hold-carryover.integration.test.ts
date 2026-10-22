import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../../connection.js', async () => {
  // `getInternal` too, and the real one: `set_category_carryover` asks the
  // engine for the budget's bounds, because the public month list is one
  // month short of what the write reaches (#138, round three).
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
import { registerHoldForNextMonth } from '../../write/hold-for-next-month.js';
import { registerSetCategoryCarryover } from '../../write/set-category-carryover.js';
import type { BudgetMonth, BudgetMonthGroup } from '../../../types.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function handlerFor(register: (s: never) => void): Handler {
  let handler: Handler | undefined;
  register({ tool: (...a: unknown[]) => { handler = a.at(-1) as Handler; } } as never);
  if (!handler) throw new Error('tool did not register');
  return handler;
}

const hold = () => handlerFor(registerHoldForNextMonth as never);
const carryover = () => handlerFor(registerSetCategoryCarryover as never);

const now = new Date();
const pad = (n: number) => String(n + 1).padStart(2, '0');
const thisMonth = `${now.getFullYear()}-${pad(now.getMonth())}`;

const monthAt = (offset: number) => {
  const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  return `${d.getFullYear()}-${pad(d.getMonth())}`;
};

/** The last month Actual has created, which `getBudgetMonths` does not list. */
const lastCreated = async () => {
  const bounds = (await testInternal().send('get-budget-bounds' as never, undefined as never)) as {
    end: string;
  };
  return bounds.end;
};

const month = async () => (await api.getBudgetMonth(thisMonth)) as unknown as BudgetMonth;
const categoryIn = async (id: string) => {
  const m = await month();
  return (m.categoryGroups as BudgetMonthGroup[]).flatMap((g) => g.categories ?? []).find((c) => c.id === id);
};

/**
 * Holding money for next month, and a category's carryover (#138), against
 * the real engine.
 *
 * Everything here is behaviour of the engine's own calls, measured rather
 * than assumed: the hold adds instead of setting, it holds what it can
 * without saying so, and it writes nothing at all when the month has nothing
 * left to assign.
 */
describe.skipIf(skip)('hold_for_next_month and set_category_carryover', () => {
  let groceries = '';

  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  async function budgetWith(available: number, label: string) {
    await createFreshBudget(async () => {
      const g = await api.createCategoryGroup({ name: 'Everyday' } as never);
      groceries = await api.createCategory({ name: 'Groceries', group_id: g } as never);
      await api.createAccount({ name: 'Checking', offbudget: false } as never, available);
    }, label);
  }

  it('holds what was asked, and says the total held', async () => {
    await budgetWith(100000, 'hold-basic');

    const first = await hold()({ amount: 200 });

    expect(first.isError, first.content[0]?.text).toBeFalsy();
    expect((await month()).forNextMonth).toBe(20000);
    expect((await month()).toBudget).toBe(80000);
    expect(first.content[0].text).toContain('Held 200.00');
  }, 60_000);

  it('adds to what is already held, and says so', async () => {
    // The engine adds rather than sets: two calls of 200 and 100 leave 300.
    const second = await hold()({ amount: 100 });

    expect(second.isError, second.content[0]?.text).toBeFalsy();
    expect((await month()).forNextMonth).toBe(30000);
    expect(second.content[0].text).toContain('added to what was already held');
  }, 60_000);

  it('holds what there is when asked for more, and says both figures', async () => {
    // Measured: the engine holds what it can and reports nothing.
    const before = await month();
    const asking = before.toBudget / 100 + 500;

    const result = await hold()({ amount: asking });

    expect(result.isError, result.content[0]?.text).toBeFalsy();
    expect((await month()).toBudget).toBe(0);
    expect((await month()).forNextMonth).toBe(before.forNextMonth + before.toBudget);
    expect(result.content[0].text).toContain('Asked to hold');
    expect(result.content[0].text).toContain('all');
  }, 60_000);

  it('releases the whole hold with zero', async () => {
    const before = await month();
    expect(before.forNextMonth, 'the arrangement').toBeGreaterThan(0);

    const result = await hold()({ amount: 0 });

    expect(result.isError, result.content[0]?.text).toBeFalsy();
    expect((await month()).forNextMonth).toBe(0);
    expect((await month()).toBudget).toBe(before.toBudget + before.forNextMonth);
    expect(result.content[0].text).toContain('Released');
  }, 60_000);

  it('says nothing changed when there was no hold to release', async () => {
    const result = await hold()({ amount: 0 });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('nothing changed');
  }, 60_000);

  it('says it held nothing when the month has nothing to assign', async () => {
    // Measured: the engine writes nothing and answers false.
    await budgetWith(100000, 'hold-empty');
    await api.setBudgetAmount(thisMonth, groceries, 100000);
    expect((await month()).toBudget, 'the arrangement').toBe(0);

    const result = await hold()({ amount: 50 });

    expect(result.isError).toBeFalsy();
    expect((await month()).forNextMonth).toBe(0);
    expect(result.content[0].text).toContain('Nothing was held');
    expect(result.content[0].text).toContain('has none');
  }, 60_000);

  it('refuses a negative amount rather than moving money the other way', async () => {
    const result = await hold()({ amount: -50 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('zero or a positive number');
  }, 60_000);

  it('refuses a month it cannot act on', async () => {
    // `resolveMonth` turns most of these away first, which is why its own
    // guard is pinned in #117. The one here catches what gets past it: a
    // natural-language month can resolve to something like `-474-09`, and
    // the engine writes against a malformed month rather than refusing.
    const refused = await hold()({ amount: 10, month: '2026-13' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('2026-13');

    const past = await hold()({ amount: 10, month: 'hace 30000 meses' });
    expect(past.isError, past.content[0]?.text).toBe(true);
    expect(past.content[0].text).toContain('not a month this can act on');
  }, 60_000);


  it('refuses an amount that rounds to nothing instead of releasing the hold', async () => {
    // The release is asked for with zero and with nothing else. Reading the
    // rounded figure let 0.004 clear a hold of 200.00: someone adding a
    // little got everything taken away.
    await budgetWith(100000, 'hold-rounding');
    await hold()({ amount: 200 });

    const result = await hold()({ amount: 0.004 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('rounds to zero');
    expect(result.content[0].text).toContain('Pass 0');
    expect((await month()).forNextMonth, 'the hold is untouched').toBe(20000);
  }, 60_000);

  it('names the figure it released, which is the one that was held', async () => {
    const result = await hold()({ amount: 0 });

    expect(result.isError, result.content[0]?.text).toBeFalsy();
    expect(result.content[0].text).toContain('Released the 200.00 held for next month');
    expect((await month()).forNextMonth).toBe(0);
  }, 60_000);

  it('says nothing about adding when there was nothing held before', async () => {
    await budgetWith(100000, 'hold-first');

    const first = await hold()({ amount: 50 });
    const second = await hold()({ amount: 25 });

    expect(first.content[0].text).not.toContain('added to what was already held');
    expect(second.content[0].text).toContain('added to what was already held');
    expect(second.content[0].text).toContain('release all 75.00');
  }, 60_000);

  it('says a tracking budget has nothing to hold', async () => {
    // Measured: in a tracking budget the month comes back with `toBudget`
    // and `forNextMonth` null, and the engine's hold writes nothing and
    // says nothing. The reply used to describe an envelope month.
    await budgetWith(100000, 'hold-tracking');
    await api.setPreference('budgetType', 'tracking');
    try {
      const result = await hold()({ amount: 50 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('tracking budget');
      expect(result.content[0].text).toContain('Nothing was changed');
    } finally {
      await api.setPreference('budgetType', 'envelope');
    }
  }, 60_000);

  it('turns carryover on and reads it back', async () => {
    await budgetWith(100000, 'carryover');

    const result = await carryover()({ category: 'Groceries', enabled: true });

    expect(result.isError, result.content[0]?.text).toBeFalsy();
    expect((await categoryIn(groceries))?.carryover).toBe(true);
    expect(result.content[0].text).toContain('is on from');
  }, 60_000);

  it('turns it off again', async () => {
    const result = await carryover()({ category: 'Groceries', enabled: false });

    expect(result.isError, result.content[0]?.text).toBeFalsy();
    expect((await categoryIn(groceries))?.carryover).toBe(false);
  }, 60_000);

  it('says when it was already that way, instead of claiming a change', async () => {
    const result = await carryover()({ category: 'Groceries', enabled: false });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('already had carryover off');
  }, 60_000);


  it('says which later months it changed, not only the one asked for', async () => {
    // Measured: the engine writes the flag into every month from the one
    // given to the last the budget has, which is as true of a call made by
    // hand as of this tool's own. Turning it on here, off from a later
    // month, and on again here used to answer "already had carryover on"
    // while turning every one of those months back on.
    await budgetWith(100000, 'carryover-reach');
    await carryover()({ category: 'Groceries', enabled: true });
    const reach = (await api.getBudgetMonths()).filter((m) => m >= thisMonth);
    const from = reach[reach.length - 2];
    await api.setBudgetCarryover(from, groceries, false);

    const result = await carryover()({ category: 'Groceries', enabled: true });

    expect(result.isError, result.content[0]?.text).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('is on from');
    // Two months, so they are named rather than counted.
    expect(text).toContain(`Changed in ${from} and ${reach[reach.length - 1]}.`);
    expect(text).toContain(`Already on in ${reach.length - 2} of the other months.`);
    expect(text).not.toContain('already had carryover');
    // The reach is the last month Actual has created, not the last one its
    // API will list: measured, those differ by one, and the reply used to
    // name the wrong month and then say the next would start without the
    // flag, which had just been given it.
    const written = await lastCreated();
    expect(written > reach[reach.length - 1]).toBe(true);
    expect(text).toContain(`from ${thisMonth} to ${written}`);
    expect(text).toContain('Months created after that start without it');
    expect(text).toContain(
      `The figures above stop at ${reach[reach.length - 1]}: Actual's API refuses to read its ` +
        `last month, so ${written} is written and not checked here.`,
    );
  }, 120_000);

  it('counts them instead of naming them when there are many', async () => {
    const reach = (await api.getBudgetMonths()).filter((m) => m >= thisMonth);
    const from = reach[2];
    await api.setBudgetCarryover(from, groceries, false);

    const result = await carryover()({ category: 'Groceries', enabled: true });

    expect(result.isError, result.content[0]?.text).toBeFalsy();
    const changed = reach.filter((m) => m >= from);
    expect(result.content[0].text).toContain(
      `Changed in ${changed.length} months, ${from} to ${reach[reach.length - 1]}.`,
    );
  }, 120_000);

  it('says nothing changed only when nothing did, in any month', async () => {
    const result = await carryover()({ category: 'Groceries', enabled: true });

    expect(result.isError, result.content[0]?.text).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('already had carryover on');
    expect(text).toContain('in every month to');
    expect(text).not.toContain('Changed in');
  }, 120_000);

  it('refuses a tracking budget, where there is nothing to carry', async () => {
    // Measured: there the month comes back with `toBudget` and
    // `forNextMonth` null, and the flag goes into rows nothing reads. The
    // reply described twelve months of a mechanism that budget does not
    // have.
    await api.setPreference('budgetType', 'tracking');
    try {
      const result = await carryover()({ category: 'Groceries', enabled: true });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('tracking budget');
      expect(result.content[0].text).toContain('Nothing was changed');
    } finally {
      await api.setPreference('budgetType', 'envelope');
    }
  }, 60_000);

  it('refuses an income category by name, not by id', async () => {
    const income = (await api.getCategoryGroups()).find((g) => g.is_income);
    const salary = await api.createCategory({
      name: 'Salary',
      group_id: income?.id,
      is_income: true,
    } as never);

    const result = await carryover()({ category: 'Salary', enabled: true });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"Salary" is an income category');
    expect(result.content[0].text).not.toContain(salary);
  }, 60_000);

  it('explains which way the money goes, each way round', async () => {
    const on = await carryover()({ category: 'Groceries', enabled: true });
    const off = await carryover()({ category: 'Groceries', enabled: false });

    expect(on.content[0].text).toContain(
      'Overspending in this category now rolls into the category next month',
    );
    expect(off.content[0].text).toContain(
      'Overspending in this category now comes off the money there is to assign next',
    );
  }, 120_000);

  it('refuses a category that is not there', async () => {
    const result = await carryover()({ category: 'Nope', enabled: true });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No category found');
  }, 60_000);
});
