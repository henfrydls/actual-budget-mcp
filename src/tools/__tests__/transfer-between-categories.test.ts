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
    // Reset this too. The income test replaces it with a three-category list,
    // and without this that list leaks into every test declared after it. It
    // breaks nothing today, which is exactly what made #106 the same shape.
    vi.mocked(api.getCategories).mockReset().mockResolvedValue([
      { id: 'cat-1', name: 'Groceries', group_id: 'g1', hidden: false },
      { id: 'cat-2', name: 'Dining', group_id: 'g1', hidden: false },
    ] as never);
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
      // ever looks at. Measured: the money never arrives anywhere. Stopped by
      // `resolveMonth` since it was tightened.
      ['a month outside 01-12', { from: 'Groceries', to: 'Dining', amount: 10, month: '2026-13' }, 'Could not parse month'],
      // `sheetForMonth` replaces only the first dash, so the figures are read
      // from a sheet that does not exist while the write lands on the real
      // month. Measured: it destroys both categories' budgets.
      ['a month with a day on it', { from: 'Groceries', to: 'Dining', amount: 10, month: '2026-09-15' }, 'Could not parse month'],
      // These reach the tool's own shape check, which is why it is there.
      // `resolveMonth`'s natural-language branch does not pad the year:
      // measured, "20000 months ago" returns "360-01" and "January 0999"
      // returns "999-01", both of which it hands back as a resolved month.
      ['a year the resolver did not pad', { from: 'Groceries', to: 'Dining', amount: 10, month: '20000 months ago' }, 'not a month this can act on'],
      ['a four-digit year written short', { from: 'Groceries', to: 'Dining', amount: 10, month: 'January 0999' }, 'not a month this can act on'],
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

  it('explains a handler that is not there, instead of a TypeError', async () => {
    // `budget/transfer-category` is internal and the dependency is a caret
    // range, so it can go away without anyone editing this repository.
    vi.mocked(api.getBudgetMonth).mockResolvedValue(month(20000, 5000) as never);
    sendMock.mockRejectedValue(new TypeError('handler is not a function'));

    const result = await handlerFor()({
      from: 'Groceries',
      to: 'Dining',
      amount: 50,
      month: '2026-09',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('did not run, so nothing was moved');
  });

  it('does not claim a move when the source did not give the money up', async () => {
    // Half of the read-back check. Removing this comparison alone left the
    // suite green, and the reply would then say "Moved 114.06" about money
    // that never left the source: the destination is credited and the source
    // still holds it, which is money invented.
    vi.mocked(api.getBudgetMonth)
      .mockResolvedValueOnce(month(20000, 5000) as never)
      .mockResolvedValueOnce(month(20000, 16406) as never);

    const result = await handlerFor()({
      from: 'Groceries',
      to: 'Dining',
      amount: 114.06,
      month: '2026-09',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('did not change the way they should have');
  });

  it('does not claim a move when the destination never received it', async () => {
    // The other half, and the one that matters most: it is the shape the
    // income-category bug produced. The source is debited, nothing arrives,
    // and without this comparison the reply reports a successful move.
    vi.mocked(api.getBudgetMonth)
      .mockResolvedValueOnce(month(20000, 5000) as never)
      .mockResolvedValueOnce(month(8594, 5000) as never);

    const result = await handlerFor()({
      from: 'Groceries',
      to: 'Dining',
      amount: 114.06,
      month: '2026-09',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('did not change the way they should have');
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

  it('does not call the current month past', async () => {
    // The half this test's name always promised and never checked. With `<`
    // relaxed to `<=`, every ordinary move in the current month would carry a
    // warning about shifting the months after it, which would be false.
    const now = new Date();
    const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    vi.mocked(api.getBudgetMonth)
      .mockResolvedValueOnce(month(20000, 5000) as never)
      .mockResolvedValueOnce(month(15000, 10000) as never);

    const result = await handlerFor()({
      from: 'Groceries',
      to: 'Dining',
      amount: 50,
      month: current,
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).not.toContain('past month');
  });

  it('syncs between writing and reading the figures back', async () => {
    // Without the sync the read-back can answer from before the write, which is
    // the whole subject of #105. No integration test can see this: there is no
    // server there, so `api.sync()` is a no-op and its absence changes nothing.
    // The order is what can be asserted, so the order is what is asserted.
    const order: string[] = [];
    let reads = 0;
    vi.mocked(api.sync).mockImplementation(async () => {
      order.push('sync');
    });
    vi.mocked(api.getBudgetMonth).mockImplementation(async () => {
      order.push('read');
      reads += 1;
      return (reads === 1 ? month(20000, 5000) : month(15000, 10000)) as never;
    });
    // The tool also asks the engine for the budget's currency (#115), through
    // the same `send`. Only the transfer counts as the write here.
    sendMock.mockImplementation(async (method: string) => {
      if (method === 'preferences/get' || method === 'load-prefs') return {};
      order.push('write');
      return undefined;
    });

    const result = await handlerFor()({
      from: 'Groceries',
      to: 'Dining',
      amount: 50,
      month: '2026-09',
    });

    expect(result.isError).toBeFalsy();
    expect(order).toEqual(['read', 'write', 'sync', 'read']);
  });
});
