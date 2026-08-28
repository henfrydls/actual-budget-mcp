import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  getCategories: vi.fn().mockResolvedValue([
    { id: 'cat-1', name: 'Groceries', group_id: 'g1', hidden: false },
  ]),
  updateTransaction: vi.fn().mockResolvedValue({}),
  sync: vi.fn().mockResolvedValue(undefined),
  runQuery: vi.fn(),
  q: () => ({ filter: () => ({ select: () => ({}) }) }),
  utils: {
    amountToInteger: (amount: number) => Math.round(amount * 100),
    integerToAmount: (cents: number) => cents / 100,
  },
}));

vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import * as api from '@actual-app/api';
import { registerRecategorizeTransaction } from '../write/recategorize-transaction.js';

/** Capture the handler a tool registers so it can be invoked directly. */
function captureHandler(register: (server: any) => void): (args: any) => Promise<any> {
  let handler: ((args: any) => Promise<any>) | undefined;
  register({
    tool: (...args: unknown[]) => {
      handler = args[args.length - 1] as (args: any) => Promise<any>;
    },
  });
  if (!handler) throw new Error('tool did not register a handler');
  return handler;
}

describe('recategorize_transaction (#44: must not zero a split child)', () => {
  beforeEach(() => {
    vi.mocked(api.updateTransaction).mockClear().mockResolvedValue({} as any);
    vi.mocked(api.runQuery).mockReset();
  });

  // updateTransaction resets a sub-transaction's amount to 0 when the update
  // omits `amount` (#25), which silently unbalances the parent split.
  it('re-sends the current amount when the target is a split child', async () => {
    vi.mocked(api.runQuery).mockResolvedValue({
      data: [{ id: 'sub-1', amount: -81599, is_child: true }],
    } as any);
    const handler = captureHandler(registerRecategorizeTransaction);

    await handler({ transaction_id: 'sub-1', category: 'cat-1' });

    expect(api.updateTransaction).toHaveBeenCalledWith('sub-1', {
      category: 'cat-1',
      amount: -81599,
    });
  });

  it('does not inject an amount for an ordinary transaction', async () => {
    vi.mocked(api.runQuery).mockResolvedValue({
      data: [{ id: 't-1', amount: -500, is_child: false }],
    } as any);
    const handler = captureHandler(registerRecategorizeTransaction);

    await handler({ transaction_id: 't-1', category: 'cat-1' });

    expect(api.updateTransaction).toHaveBeenCalledWith('t-1', { category: 'cat-1' });
  });
});
