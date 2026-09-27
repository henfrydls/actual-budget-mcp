import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  getCategories: vi.fn().mockResolvedValue([
    { id: 'cat-1', name: 'Salud', group_id: 'g1', hidden: false },
  ]),
  getBudgetMonth: vi.fn(),
  setBudgetAmount: vi.fn().mockResolvedValue(undefined),
  sync: vi.fn().mockResolvedValue(undefined),
  utils: {
    amountToInteger: (a: number) => Math.round(a * 100),
    integerToAmount: (c: number) => c / 100,
  },
}));

vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import * as api from '@actual-app/api';
import { registerUpdateBudgetAmount } from '../write/update-budget-amount.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function handlerFor(): Handler {
  let handler: Handler | undefined;
  registerUpdateBudgetAmount({
    tool: (...a: unknown[]) => {
      handler = a.at(-1) as Handler;
    },
  } as never);
  return handler as Handler;
}

const month = (budgeted: number | undefined) => ({
  month: '2026-09',
  totalBudgeted: 0,
  toBudget: 0,
  categoryGroups: [
    {
      id: 'g1',
      name: 'Gastos',
      is_income: false,
      categories: [{ id: 'cat-1', name: 'Salud', budgeted, spent: 0, balance: 0 }],
    },
  ],
});

/**
 * The parts of `update_budget_amount` the engine cannot show.
 *
 * Both of these were mutations that survived an audit: the reported change,
 * and the sync between the write and whatever reads next.
 */
describe('update_budget_amount', () => {
  beforeEach(() => {
    vi.mocked(api.getBudgetMonth).mockReset();
    vi.mocked(api.setBudgetAmount).mockReset().mockResolvedValue(undefined as never);
    vi.mocked(api.sync).mockReset().mockResolvedValue(undefined as never);
  });

  it('reports the change, which is the figure the caller checks', async () => {
    // Pinned because it could be fixed at 0.00 with the whole suite green: the
    // two figures around it would still be right and the line between them
    // would be a lie.
    vi.mocked(api.getBudgetMonth).mockResolvedValue(month(250000) as never);

    const result = await handlerFor()({ category: 'Salud', amount: 4000, month: '2026-09' });

    const text = result.content[0].text;
    expect(text).toContain('Old: 2,500.00');
    expect(text).toContain('New: 4,000.00');
    expect(text).toContain('Change: 1,500.00');
  });

  it('reports a negative change as negative', async () => {
    vi.mocked(api.getBudgetMonth).mockResolvedValue(month(400000) as never);

    const result = await handlerFor()({ category: 'Salud', amount: 2500, month: '2026-09' });

    expect(result.content[0].text).toContain('Change: -1,500.00');
  });

  it('syncs after writing, before anything reads again', async () => {
    // Removing the sync left the suite green: no integration test can see it,
    // because there is no server there and the call is a no-op. The order is
    // what can be asserted, so the order is what is asserted. Same shape as
    // the guard in #105.
    const order: string[] = [];
    vi.mocked(api.getBudgetMonth).mockImplementation(async () => {
      order.push('read');
      return month(0) as never;
    });
    vi.mocked(api.setBudgetAmount).mockImplementation(async () => {
      order.push('write');
    });
    vi.mocked(api.sync).mockImplementation(async () => {
      order.push('sync');
    });

    await handlerFor()({ category: 'Salud', amount: 1000, month: '2026-09' });

    expect(order).toEqual(['read', 'write', 'sync']);
  });

  it('syncs on the delta path too', async () => {
    const order: string[] = [];
    vi.mocked(api.getBudgetMonth).mockImplementation(async () => {
      order.push('read');
      return month(50000) as never;
    });
    vi.mocked(api.setBudgetAmount).mockImplementation(async () => {
      order.push('write');
    });
    vi.mocked(api.sync).mockImplementation(async () => {
      order.push('sync');
    });

    await handlerFor()({ category: 'Salud', amount: 1000, month: '2026-09', mode: 'delta' });

    expect(order).toEqual(['read', 'write', 'sync']);
  });

  it('leaves no unhandled rejection behind when a delta fails', async () => {
    // The promise kept on the queue is a derived one that nobody awaits, so a
    // rejection reaching it has no handler. This server installs a process
    // guard for exactly that class of thing (#39), and an unhandled rejection
    // there would kill the process seconds after an unrelated call.
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      vi.mocked(api.getBudgetMonth).mockResolvedValue(month(0) as never);
      vi.mocked(api.setBudgetAmount).mockRejectedValue(new Error('engine said no'));

      const result = await handlerFor()({
        category: 'Salud',
        amount: 1000,
        month: '2026-09',
        mode: 'delta',
      });
      expect(result.isError).toBe(true);

      // Unhandled rejections are reported a turn later, so give it one.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('keeps the queue moving after one delta fails', async () => {
    // A rejection must not wedge everything behind it. Without the two-sided
    // continuation the next delta never settles and the tool hangs.
    vi.mocked(api.getBudgetMonth).mockResolvedValue(month(0) as never);
    vi.mocked(api.setBudgetAmount)
      .mockRejectedValueOnce(new Error('engine said no'))
      .mockResolvedValue(undefined as never);

    const handler = handlerFor();
    const failed = await handler({
      category: 'Salud',
      amount: 1000,
      month: '2026-09',
      mode: 'delta',
    });
    expect(failed.isError).toBe(true);

    const after = await handler({
      category: 'Salud',
      amount: 1000,
      month: '2026-09',
      mode: 'delta',
    });
    expect(after.isError).toBeFalsy();
  });
});
