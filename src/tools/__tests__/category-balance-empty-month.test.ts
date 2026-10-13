import { describe, it, expect, vi, beforeEach } from 'vitest';

const getBudgetMonth = vi.fn();
vi.mock('@actual-app/api', () => ({
  getBudgetMonth: (...a: unknown[]) => getBudgetMonth(...a),
  getCategories: vi.fn().mockResolvedValue([{ id: 'cat-1', name: 'Fun', group_id: 'grp-1' }]),
  getCategoryGroups: vi.fn().mockResolvedValue([{ id: 'grp-1', name: 'Spending' }]),
  utils: {
    amountToInteger: (a: number, places = 2) => Math.round(a * Math.pow(10, places)),
    integerToAmount: (c: number, places = 2) => c / Math.pow(10, places),
  },
}));

const send = vi.fn();
vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
  getInternal: () => ({ send: (...a: unknown[]) => send(...a) }),
}));

import { registerGetCategoryBalance } from '../read/get-category-balance.js';
import { refreshBudgetDecimalPlaces, resetBudgetDecimalPlaces } from '../../utils/currency.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

function handler(): Handler {
  let found: Handler | undefined;
  registerGetCategoryBalance({
    tool: (...a: unknown[]) => {
      found = a.at(-1) as Handler;
    },
  } as never);
  return found as Handler;
}

/**
 * A month the category is not in, written in the budget's own currency (#141).
 *
 * The row for such a month was three hand-typed "0.00" strings, which is a
 * figure with two decimal places in a table where every other figure follows
 * the currency. In a budget in yen the empty months were the only rows with
 * decimals in them.
 *
 * The month exists here and the category is simply not in it, which is what
 * happens to a category created later than the window being asked for.
 */
describe('a month with nothing in it', () => {
  beforeEach(() => {
    resetBudgetDecimalPlaces();
    send.mockReset().mockResolvedValue({ defaultCurrencyCode: 'JPY' });
    getBudgetMonth.mockReset().mockResolvedValue({
      month: '2026-09',
      incomeAvailable: 0,
      lastMonthOverspent: 0,
      forNextMonth: 0,
      totalBudgeted: 0,
      toBudget: 0,
      // A real month, with the category missing from it.
      categoryGroups: [{ id: 'grp-1', name: 'Spending', categories: [] }],
    });
  });

  it('writes its zeroes the way the currency writes them', async () => {
    await refreshBudgetDecimalPlaces();
    const reply = await handler()({ category: 'Fun', months: 1 });
    const text = reply.content[0].text;

    expect(text, 'a yen has no hundredths').not.toContain('0.00');
    expect(text).toMatch(/\b0\b/);
  });

  it('still writes them with decimals in a currency that has them', async () => {
    send.mockResolvedValue({ defaultCurrencyCode: 'USD' });
    await refreshBudgetDecimalPlaces();
    const reply = await handler()({ category: 'Fun', months: 1 });

    expect(reply.content[0].text).toContain('0.00');
  });
});
