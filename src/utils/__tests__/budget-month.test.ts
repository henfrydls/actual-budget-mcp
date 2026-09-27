import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  getBudgetMonth: vi.fn(),
  utils: {
    amountToInteger: (a: number) => Math.round(a * 100),
    integerToAmount: (c: number) => c / 100,
  },
}));

import * as api from '@actual-app/api';
import { budgetMonthOrMissing, readWindow } from '../budget-month.js';

describe('budgetMonthOrMissing', () => {
  beforeEach(() => {
    vi.mocked(api.getBudgetMonth).mockReset();
  });

  it('returns nothing for a month before the budget starts', async () => {
    vi.mocked(api.getBudgetMonth).mockRejectedValue(
      new Error('No budget exists for month: 2025-12'),
    );

    expect(await budgetMonthOrMissing('2025-12')).toBeNull();
  });

  it('lets every other failure through', async () => {
    // The point of matching one message rather than catching everything. A
    // tool that answers "no data" for a broken connection is how #80 stayed
    // invisible for as long as it did.
    vi.mocked(api.getBudgetMonth).mockRejectedValue(
      new Error('connection refused on port 5007'),
    );

    await expect(budgetMonthOrMissing('2026-09')).rejects.toThrow('connection refused');
  });

  it('lets an empty message through rather than reading it as missing', async () => {
    // Actual throws `new Error('')` on some sync failures, which `describeError`
    // exists for (#40). Treating that as "no budget for this month" would turn
    // a sync problem into a quietly shorter window.
    vi.mocked(api.getBudgetMonth).mockRejectedValue(new Error(''));

    await expect(budgetMonthOrMissing('2026-09')).rejects.toBeDefined();
  });

  it('returns the month when it is there', async () => {
    vi.mocked(api.getBudgetMonth).mockResolvedValue({ month: '2026-09' } as never);

    expect(await budgetMonthOrMissing('2026-09')).toEqual({ month: '2026-09' });
  });
});

describe('readWindow', () => {
  beforeEach(() => {
    vi.mocked(api.getBudgetMonth).mockReset();
  });

  it('separates the months that are there from the ones that are not', async () => {
    vi.mocked(api.getBudgetMonth).mockImplementation(async (m: unknown) => {
      if (m === '2025-11' || m === '2025-12') {
        throw new Error(`No budget exists for month: ${m as string}`);
      }
      return { month: m } as never;
    });

    const { present, missing } = await readWindow(['2026-01', '2025-12', '2025-11']);

    expect(present.map((p) => p.month)).toEqual(['2026-01']);
    expect(missing).toEqual(['2025-12', '2025-11']);
  });

  it('keeps the order it was given, so a window reads in sequence', async () => {
    vi.mocked(api.getBudgetMonth).mockImplementation(async (m: unknown) => ({ month: m }) as never);

    const { present } = await readWindow(['2026-03', '2026-02', '2026-01']);

    expect(present.map((p) => p.month)).toEqual(['2026-03', '2026-02', '2026-01']);
  });
});
