import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeQ } from './fake-query.js';

vi.mock('@actual-app/api', () => ({
  default: {},
  getAccounts: vi.fn(),
  getCategories: vi.fn(),
  getTransactions: vi.fn(),
  addTransactions: vi.fn(),
  getPayees: vi.fn(),
  runQuery: vi.fn(),
  sync: vi.fn().mockResolvedValue(undefined),
  q: (table: string) => fakeQ(table),
  utils: {
    amountToInteger: (a: number) => Math.round(a * 100),
    integerToAmount: (c: number) => c / 100,
  },
}));

vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../utils/duplicate-check.js', () => ({
  findPossibleDuplicates: vi.fn().mockResolvedValue([]),
  findUnlinkedCounterpart: vi.fn().mockResolvedValue([]),
  pullBeforeReading: vi.fn().mockResolvedValue(undefined),
}));

import * as api from '@actual-app/api';
import { createTransactions } from '../write/create-transactions.js';

const ACCOUNTS = [
  { id: 'acc-1', name: 'Checking', closed: false },
  { id: 'acc-2', name: 'Savings', closed: false },
];

/**
 * The parts of the batch the engine cannot be made to show.
 *
 * Everything the server validates is checked before the write, so against the
 * real engine the second account's write does not fail — which is exactly why
 * the branch that handles it having failed had never run.
 */
describe('create_transactions', () => {
  beforeEach(() => {
    vi.mocked(api.getAccounts).mockReset().mockResolvedValue(ACCOUNTS as never);
    vi.mocked(api.getCategories).mockReset().mockResolvedValue([] as never);
    vi.mocked(api.addTransactions).mockReset().mockResolvedValue('ok' as never);
    vi.mocked(api.getPayees)
      .mockReset()
      .mockResolvedValue([{ id: 'payee-savings', name: 'Savings', transfer_acct: 'acc-2' }] as never);
    vi.mocked(api.runQuery).mockReset().mockResolvedValue({ data: [] } as never);
    vi.mocked(api.sync).mockReset().mockResolvedValue(undefined as never);
    vi.mocked(api.getTransactions).mockReset().mockResolvedValue([] as never);
  });

  it('says what landed when the second account fails part way through', async () => {
    // A batch spanning two accounts is two writes, because the engine ignores
    // an `account` on the row. If the second throws, the first is already
    // there. This is the #79 shape and the reply must not read as a clean
    // failure.
    let checkingRows = 0;
    vi.mocked(api.getTransactions).mockImplementation(async (id: unknown) =>
      (id === 'acc-1' ? new Array(checkingRows).fill({}) : []) as never,
    );
    vi.mocked(api.addTransactions).mockImplementation(async (id: unknown) => {
      if (id === 'acc-2') throw new Error('database is locked');
      checkingRows = 2;
      return 'ok' as never;
    });

    const lines = await createTransactions({
      transactions: [
        { account: 'Checking', amount: -10, date: '2026-09-01' },
        { account: 'Checking', amount: -20, date: '2026-09-02' },
        { account: 'Savings', amount: -30, date: '2026-09-03' },
      ],
    });

    const text = lines.join('\n');
    expect(text).toContain('stopped part way through, at Savings');
    expect(text).toContain('database is locked');
    expect(text).toContain('2 of 3 rows were written before it stopped');
    // The counts as they stand: Checking moved, Savings did not.
    expect(text).toContain('Checking: 0 -> 2');
    expect(text).toContain('Savings: 0 -> 0');
    // And the advice that stops the obvious next move from duplicating.
    expect(text).toContain('Do not resend the whole list');
    expect(text).not.toContain('Created 3 transactions');
  });

  it('syncs after writing, before reading the counts back', async () => {
    const order: string[] = [];
    vi.mocked(api.getTransactions).mockImplementation(async () => {
      order.push('count');
      return [] as never;
    });
    vi.mocked(api.addTransactions).mockImplementation(async () => {
      order.push('write');
      return 'ok' as never;
    });
    vi.mocked(api.sync).mockImplementation(async () => {
      order.push('sync');
    });

    await createTransactions({
      transactions: [{ account: 'Checking', amount: -10, date: '2026-09-01' }],
    });

    // Count before, write, sync, count after. Without the sync the figures
    // reported can come from before the write (#105).
    expect(order).toEqual(['count', 'write', 'sync', 'count']);
  });

  it('does not let two batches interleave their counts', async () => {
    // Without the queue both batches read "before" at the same time and both
    // report the same jump, each claiming the other's rows. The totals would
    // be right and the reply would still be wrong.
    let rows = 0;
    vi.mocked(api.getTransactions).mockImplementation(async () => new Array(rows).fill({}) as never);
    vi.mocked(api.addTransactions).mockImplementation(async () => {
      // A turn of the loop between reading and writing, which is all a race
      // needs.
      await new Promise((resolve) => setTimeout(resolve, 0));
      rows += 2;
      return 'ok' as never;
    });

    const [first, second] = await Promise.all([
      createTransactions({
        transactions: [
          { account: 'Checking', amount: -10, date: '2026-09-01' },
          { account: 'Checking', amount: -20, date: '2026-09-02' },
        ],
      }),
      createTransactions({
        transactions: [
          { account: 'Checking', amount: -30, date: '2026-09-03' },
          { account: 'Checking', amount: -40, date: '2026-09-04' },
        ],
      }),
    ]);

    const texts = [first.join('\n'), second.join('\n')];
    expect(texts.some((t) => t.includes('Checking: 0 -> 2'))).toBe(true);
    expect(texts.some((t) => t.includes('Checking: 2 -> 4'))).toBe(true);
  });

  /**
   * `runTransfers` is per call, so it is a decision about the whole group.
   *
   * On when the group has a transfer in it and off when it does not. Leaving
   * it off for a group that has one writes a one-legged movement, and the
   * engine cannot be made to show the other direction: with it on and no
   * transfer to run, nothing observable changes, so the flag itself is what
   * has to be asserted.
   */
  it('turns runTransfers on only for a group that has one', async () => {
    vi.mocked(api.getTransactions).mockResolvedValue([] as never);
    vi.mocked(api.runQuery).mockResolvedValue({ data: [] } as never);

    await createTransactions({
      transactions: [{ account: 'Checking', amount: -10, payee: 'Shop', date: '2026-09-01' }],
    });
    expect(vi.mocked(api.addTransactions).mock.calls.at(-1)?.[2]).toMatchObject({
      runTransfers: false,
    });

    await createTransactions({
      transactions: [{ account: 'Checking', amount: -10, payee: 'Savings', date: '2026-09-02' }],
    });
    expect(vi.mocked(api.addTransactions).mock.calls.at(-1)?.[2]).toMatchObject({
      runTransfers: true,
    });
  });
});
