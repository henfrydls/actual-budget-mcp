import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@actual-app/api', () => ({
  default: {},
  getCategories: vi.fn(),
  getBudgetMonth: vi.fn(),
  setBudgetAmount: vi.fn(),
  getNote: vi.fn().mockResolvedValue(null),
  updateNote: vi.fn().mockResolvedValue(undefined),
  sync: vi.fn().mockResolvedValue(undefined),
  utils: {
    amountToInteger: (amount: number) => Math.round(amount * 100),
    integerToAmount: (cents: number) => cents / 100,
  },
}));

vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
  getInternal: () => ({ send: sendMock }),
}));

import * as api from '@actual-app/api';
import { registerTransferBetweenCategories } from '../write/transfer-between-categories.js';
import { registerUpdateBudgetAmount } from '../write/update-budget-amount.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function handlerFor(register: (s: never) => void): Handler {
  let handler: Handler | undefined;
  register({
    tool: (...a: unknown[]) => {
      handler = a.at(-1) as Handler;
    },
  } as never);
  return handler as Handler;
}

/** A budget month with one spending category and money left to assign. */
function month(groceries: number, toBudget: number) {
  return {
    month: '2026-09',
    totalBudgeted: -groceries,
    toBudget,
    categoryGroups: [
      {
        id: 'g1',
        name: 'Spending',
        is_income: false,
        categories: [
          { id: 'cat-1', name: 'Groceries', budgeted: groceries, balance: groceries },
        ],
      },
    ],
  };
}

/** Lets a test hold a write open and release it on command. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { promise, release };
}

const tick = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

/**
 * `update_budget_amount` and `transfer_between_categories` take turns (#114).
 *
 * They share one queue because they write the same figures, and nothing in
 * either tool's own tests can tell: each is safe against itself with a queue
 * of its own, and the lost update only appears when the two are used
 * together. So this holds one tool's write open and asks whether the other
 * one goes ahead and reads anyway.
 *
 * Both modes of `update_budget_amount` are here. The absolute set reads
 * nothing it depends on, which is why it was outside the queue at first; it
 * writes the figure the other two read, which is why it is inside it now.
 */
describe('the two budget tools wait for each other', () => {
  beforeEach(() => {
    sendMock.mockReset().mockResolvedValue(undefined);
    vi.mocked(api.getCategories).mockReset().mockResolvedValue([
      { id: 'cat-1', name: 'Groceries', group_id: 'g1', hidden: false },
    ] as never);
    vi.mocked(api.getBudgetMonth).mockReset().mockResolvedValue(month(10000, 50000) as never);
    vi.mocked(api.setBudgetAmount).mockReset().mockResolvedValue(undefined as never);
    vi.mocked(api.getNote).mockReset().mockResolvedValue(null as never);
    vi.mocked(api.updateNote).mockReset().mockResolvedValue(undefined as never);
  });

  it.each([
    ['a delta', { category: 'Groceries', amount: 100, mode: 'delta', month: '2026-09' }],
    ['an absolute set', { category: 'Groceries', amount: 400, month: '2026-09' }],
  ])('makes %s wait while a transfer is half way through', async (_label, args) => {
    const held = deferred();
    let writes = 0;
    // The budget is a pair of figures the mocked engine actually keeps, so
    // the transfer's own read-back sees what it wrote and the reply it
    // builds is the real one rather than its failure branch.
    let budgeted = 10000;
    let toBudget = 50000;
    vi.mocked(api.getBudgetMonth).mockImplementation(
      async () => month(budgeted, toBudget) as never,
    );
    vi.mocked(api.setBudgetAmount).mockImplementation(async (_month, _category, amount) => {
      writes += 1;
      if (writes === 1) await held.promise;
      toBudget -= (amount as number) - budgeted;
      budgeted = amount as number;
    });

    const moving = handlerFor(registerTransferBetweenCategories)({
      from: 'To Budget',
      to: 'Groceries',
      amount: 50,
      month: '2026-09',
    });
    await tick();
    // The transfer has read the month and is inside its write.
    expect(api.getBudgetMonth).toHaveBeenCalledTimes(1);
    expect(writes).toBe(1);

    const changing = handlerFor(registerUpdateBudgetAmount)(args);
    await tick();

    // The second tool must not have read anything yet: what it would read is
    // the figure the first one is in the middle of changing.
    expect(api.getBudgetMonth).toHaveBeenCalledTimes(1);
    expect(writes).toBe(1);

    held.release();
    const [first, second] = await Promise.all([moving, changing]);

    expect(first.isError, first.content[0]?.text).toBeFalsy();
    expect(second.isError, second.content[0]?.text).toBeFalsy();
    expect(writes).toBe(2);
  });
});
