import { describe, it, expect, vi, beforeEach } from 'vitest';

const getBudgetMonth = vi.fn();
const setBudgetCarryover = vi.fn();
// One month in the budget, so these stay about the read-back and not about
// the reach of the write, which the engine tests cover.
const getBudgetMonths = vi.fn().mockResolvedValue(['2026-10']);
vi.mock('@actual-app/api', () => ({
  default: {},
  getBudgetMonth: (...a: unknown[]) => getBudgetMonth(...a),
  getBudgetMonths: (...a: unknown[]) => getBudgetMonths(...a),
  setBudgetCarryover: (...a: unknown[]) => setBudgetCarryover(...a),
  getCategories: vi.fn().mockResolvedValue([
    { id: 'c-1', name: 'Groceries', group_id: 'g-1', hidden: false },
  ]),
  sync: vi.fn().mockResolvedValue(undefined),
  utils: {
    amountToInteger: (a: number) => Math.round(a * 100),
    integerToAmount: (c: number) => c / 100,
  },
}));
vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { registerSetCategoryCarryover } from '../write/set-category-carryover.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function handler(): Handler {
  let found: Handler | undefined;
  registerSetCategoryCarryover({
    tool: (...a: unknown[]) => { found = a.at(-1) as Handler; },
  } as never);
  return found!;
}

const monthWith = (carryover: boolean) => ({
  month: '2026-10',
  categoryGroups: [
    { id: 'g-1', name: 'Everyday', is_income: false, categories: [{ id: 'c-1', name: 'Groceries', carryover }] },
  ],
});

/**
 * The half of `set_category_carryover` the engine will not produce (#138).
 *
 * The tool reads the flag back and refuses to report a change that did not
 * happen. Against the real engine that branch never fires, because the
 * engine does what it is told, so it is pinned here instead: an unreachable
 * check with no test is the shape every audit of this repository has found.
 */
describe('when Actual accepts the change and the flag does not move', () => {
  beforeEach(() => {
    getBudgetMonth.mockReset();
    setBudgetCarryover.mockReset().mockResolvedValue(undefined);
  });

  it('says so instead of claiming it worked', async () => {
    getBudgetMonth.mockResolvedValue(monthWith(false));

    const result = await handler()({ category: 'Groceries', enabled: true, month: '2026-10' });

    expect(setBudgetCarryover).toHaveBeenCalledWith('2026-10', 'c-1', true);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('still reports carryover off');
    expect(result.content[0].text).toContain('check the category in Actual');
  });

  it('reports the change when the flag does move', async () => {
    getBudgetMonth
      .mockResolvedValueOnce(monthWith(false))
      .mockResolvedValueOnce(monthWith(true));

    const result = await handler()({ category: 'Groceries', enabled: true, month: '2026-10' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('is on from 2026-10');
  });
});
