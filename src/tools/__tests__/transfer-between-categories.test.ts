import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@actual-app/api', () => ({
  default: {},
  getCategories: vi.fn().mockResolvedValue([
    { id: 'cat-1', name: 'Groceries', group_id: 'g1', hidden: false },
    { id: 'cat-2', name: 'Dining', group_id: 'g1', hidden: false },
  ]),
  getBudgetMonth: vi.fn(),
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

// `resolveMonth` is the gate that stops a malformed month reaching the engine,
// and since it was tightened there is no input that gets past it and into the
// tool's own check. Making it pass things through is the only way to exercise
// that second barrier, which exists because a month this tool accepts wrongly
// does not fail: it destroys the month's budget and reports success.
vi.mock('../../utils/dates.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/dates.js')>();
  return { ...actual, resolveMonth: vi.fn((m?: string) => m ?? actual.resolveMonth()) };
});

import * as api from '@actual-app/api';
import { registerTransferBetweenCategories } from '../write/transfer-between-categories.js';

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
  return handler as Handler;
}

/** A budget month holding the two spending categories, with the figures given. */
function month(groceries: number, dining: number, balances?: [number, number]) {
  return {
    month: '2026-09',
    totalBudgeted: -(groceries + dining),
    toBudget: 0,
    categoryGroups: [
      {
        id: 'g1',
        name: 'Spending',
        is_income: false,
        categories: [
          {
            id: 'cat-1',
            name: 'Groceries',
            budgeted: groceries,
            balance: balances ? balances[0] : groceries,
          },
          {
            id: 'cat-2',
            name: 'Dining',
            budgeted: dining,
            balance: balances ? balances[1] : dining,
          },
        ],
      },
    ],
  };
}

describe('transfer_between_categories (#86)', () => {
  beforeEach(() => {
    sendMock.mockClear().mockResolvedValue(undefined);
    vi.mocked(api.getBudgetMonth).mockReset();
  });

  it('sends the move in cents and reports both figures', async () => {
    // Budgeted and available are given different figures on purpose. With the
    // two sections showing the same numbers, an assertion meant for one of them
    // is satisfied by the other, and either section could then be deleted
    // whole with the suite still green. All four figures below are distinct.
    vi.mocked(api.getBudgetMonth)
      .mockResolvedValueOnce(month(20000, 5000, [25000, 1000]) as never)
      .mockResolvedValueOnce(month(8594, 16406, [13594, 12406]) as never);

    const result = await handlerFor()({
      from: 'Groceries',
      to: 'Dining',
      amount: 114.06,
      month: '2026-09',
    });

    expect(result.isError).toBeFalsy();
    expect(sendMock).toHaveBeenCalledWith('budget/transfer-category', {
      month: '2026-09',
      amount: 11406,
      from: 'cat-1',
      to: 'cat-2',
    });

    const text = result.content[0].text;
    expect(text).toContain('Moved 114.06 from Groceries to Dining in 2026-09');

    // What the person actually reads to see what happened, which is the part
    // that can rot without anything noticing.
    expect(text).toContain('Budgeted:');
    expect(text).toMatch(/Groceries\s+200\.00 -> 85\.94/);
    expect(text).toMatch(/Dining\s+50\.00 -> 164\.06/);
    expect(text).toContain('Available:');
    expect(text).toMatch(/Groceries\s+250\.00 -> 135\.94/);
    expect(text).toMatch(/Dining\s+10\.00 -> 124\.06/);
  });

  describe('what it refuses before touching the engine', () => {
    const rejected: Array<[string, Record<string, unknown>, string]> = [
      // Accepted by the engine, which moves the money the other way without
      // saying so.
      ['a negative amount', { from: 'Groceries', to: 'Dining', amount: -50 }, 'positive number'],
      // A no-op that still appends a line to the month's note.
      ['zero', { from: 'Groceries', to: 'Dining', amount: 0 }, 'positive number'],
      ['an amount below half a cent', { from: 'Groceries', to: 'Dining', amount: 0.004 }, 'rounds to zero cents'],
      ['an infinite amount', { from: 'Groceries', to: 'Dining', amount: Infinity }, 'positive number'],
      // Also a no-op that writes a note line.
      ['the same category twice', { from: 'Groceries', to: 'Groceries', amount: 10 }, 'same category'],
      ['the same category by id and by name', { from: 'cat-1', to: 'Groceries', amount: 10 }, 'same category'],
      // `parseInt` in the engine turns this into month 202613, which no reader
      // ever looks at. Measured: the money never arrives anywhere.
      ['a month outside 01-12', { from: 'Groceries', to: 'Dining', amount: 10, month: '2026-13' }, 'not a month this can act on'],
      // `sheetForMonth` replaces only the first dash, so the figures are read
      // from a sheet that does not exist while the write lands on the real
      // month. Measured: it destroys both categories' budgets.
      ['a month with a day on it', { from: 'Groceries', to: 'Dining', amount: 10, month: '2026-09-15' }, 'not a month this can act on'],
    ];

    for (const [name, args, expected] of rejected) {
      it(`refuses ${name}`, async () => {
        vi.mocked(api.getBudgetMonth).mockResolvedValue(month(20000, 5000) as never);

        const result = await handlerFor()(args);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain(expected);
        // The refusal has to happen before the write, not after it.
        expect(sendMock).not.toHaveBeenCalled();
      });
    }

    it('refuses an income category at either end', async () => {
      const withIncome = {
        ...month(20000, 5000),
        categoryGroups: [
          ...month(20000, 5000).categoryGroups,
          {
            id: 'g2',
            name: 'Income',
            is_income: true,
            categories: [{ id: 'cat-3', name: 'Salary', budgeted: null, balance: null }],
          },
        ],
      };
      vi.mocked(api.getCategories).mockResolvedValue([
        { id: 'cat-1', name: 'Groceries', group_id: 'g1', hidden: false },
        { id: 'cat-2', name: 'Dining', group_id: 'g1', hidden: false },
        { id: 'cat-3', name: 'Salary', group_id: 'g2', hidden: false },
      ] as never);

      for (const args of [
        { from: 'Groceries', to: 'Salary', amount: 50 },
        { from: 'Salary', to: 'Groceries', amount: 50 },
      ]) {
        sendMock.mockClear();
        vi.mocked(api.getBudgetMonth).mockResolvedValue(withIncome as never);

        const result = await handlerFor()(args);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('income category');
        expect(sendMock).not.toHaveBeenCalled();
      }
    });
  });

  it('does not claim a move the figures do not show', async () => {
    // The engine returns success whatever it did, so a reply that trusted it
    // would report money moved that is still where it was. Both reads return
    // the same figures here.
    vi.mocked(api.getBudgetMonth).mockResolvedValue(month(20000, 5000) as never);

    const result = await handlerFor()({
      from: 'Groceries',
      to: 'Dining',
      amount: 50,
      month: '2026-09',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('did not change the way they should have');
    expect(result.content[0].text).not.toContain('Moved 50.00 from');
  });

  it('warns when the source is left overspent', async () => {
    vi.mocked(api.getBudgetMonth)
      .mockResolvedValueOnce(month(10000, 0, [10000, 0]) as never)
      .mockResolvedValueOnce(month(-5000, 15000, [-5000, 15000]) as never);

    const result = await handlerFor()({
      from: 'Groceries',
      to: 'Dining',
      amount: 150,
      month: '2026-09',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Groceries is now overspent by 50.00');
  });

  it('does not call a past month current', async () => {
    vi.mocked(api.getBudgetMonth)
      .mockResolvedValueOnce(month(20000, 5000) as never)
      .mockResolvedValueOnce(month(15000, 10000) as never);

    const result = await handlerFor()({
      from: 'Groceries',
      to: 'Dining',
      amount: 50,
      month: '2020-01',
    });

    expect(result.content[0].text).toContain('2020-01 is a past month');
  });
});
