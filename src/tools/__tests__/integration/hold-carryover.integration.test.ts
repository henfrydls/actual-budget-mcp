import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
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

  it('refuses a category that is not there', async () => {
    const result = await carryover()({ category: 'Nope', enabled: true });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No category found');
  }, 60_000);
});
