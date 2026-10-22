import { describe, it, expect, vi, beforeEach } from 'vitest';

const getBudgetMonth = vi.fn();
const holdBudgetForNextMonth = vi.fn();
vi.mock('@actual-app/api', () => ({
  default: {},
  getBudgetMonth: (...a: unknown[]) => getBudgetMonth(...a),
  holdBudgetForNextMonth: (...a: unknown[]) => holdBudgetForNextMonth(...a),
  resetBudgetHold: vi.fn().mockResolvedValue(undefined),
  sync: vi.fn().mockResolvedValue(undefined),
  utils: {
    amountToInteger: (a: number) => Math.round(a * 100),
    integerToAmount: (c: number) => c / 100,
  },
}));
vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { registerHoldForNextMonth } from '../write/hold-for-next-month.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function handler(): Handler {
  let found: Handler | undefined;
  registerHoldForNextMonth({
    tool: (...a: unknown[]) => {
      found = a.at(-1) as Handler;
    },
  } as never);
  return found as Handler;
}

const monthWith = (toBudget: number, forNextMonth: number) => ({
  month: '2026-10',
  toBudget,
  forNextMonth,
  categoryGroups: [],
});

/**
 * The hold that does nothing for no reason anyone can see (#138).
 *
 * `holdBudgetForNextMonth` holds what it can and answers nothing, so the
 * figures are read back. When the month has nothing left to assign, holding
 * nothing is correct and the reply says why. When it has money and the
 * engine still holds nothing, something is wrong and the reply says that
 * instead: a sentence the real engine will not produce, which is why it is
 * pinned here.
 */
describe('hold_for_next_month when the engine holds nothing', () => {
  beforeEach(() => {
    getBudgetMonth.mockReset();
    holdBudgetForNextMonth.mockReset().mockResolvedValue(undefined);
  });

  it('says to check Actual when there was money and nothing was held', async () => {
    getBudgetMonth.mockResolvedValue(monthWith(50000, 0));

    const result = await handler()({ amount: 100, month: '2026-10' });

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('Nothing was held in 2026-10');
    expect(text).toContain('worth checking in Actual');
    expect(text).not.toContain('has none');
  });

  it('says the month had nothing to hold when that is the reason', async () => {
    getBudgetMonth.mockResolvedValue(monthWith(0, 0));

    const result = await handler()({ amount: 100, month: '2026-10' });

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('A month can only hold money it has not assigned yet');
    expect(text).not.toContain('worth checking in Actual');
  });
});
