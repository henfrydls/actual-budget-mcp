import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeQ, lastQuery, answerByFilter } from './fake-query.js';

vi.mock('@actual-app/api', () => ({
  default: {},
  getAccounts: vi.fn().mockResolvedValue([
    { id: 'acc-1', name: 'Card (USD)', closed: false, offbudget: false },
  ]),
  getAccountBalance: vi.fn(),
  getPayees: vi.fn().mockResolvedValue([]),
  getCategories: vi.fn().mockResolvedValue([
    { id: 'cat-1', name: 'Cashback', group_id: 'g1', hidden: false },
  ]),
  getTransactions: vi.fn().mockResolvedValue([]),
  addTransactions: vi.fn().mockResolvedValue('ok'),
  updateTransaction: vi.fn().mockResolvedValue({}),
  sync: vi.fn().mockResolvedValue(undefined),
  // The write is given an id of our own and found again by querying for it,
  // which is what replaced the date window and the snapshot (#93).
  runQuery: vi.fn().mockImplementation(async () => ({ data: [] })),
  q: (table: string) => fakeQ(table),
  utils: {
    amountToInteger: (amount: number) => Math.round(amount * 100),
    integerToAmount: (cents: number) => cents / 100,
  },
}));

vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import * as api from '@actual-app/api';
import { resolveDate } from '../../utils/dates.js';
import {
  reconcileCurrencyResidual,
  registerReconcileCurrencyResidual,
} from '../write/reconcile-currency-residual.js';

describe('reconcileCurrencyResidual (#30)', () => {
  beforeEach(() => {
    vi.mocked(api.addTransactions).mockClear().mockResolvedValue('ok' as any);
    vi.mocked(api.getTransactions).mockReset().mockResolvedValue([] as any);
  });

  it('books an adjustment equal to the delta toward the target balance', async () => {
    // residual debt of -100.00; bank says 0 -> need +100.00 to reach 0
    vi.mocked(api.getAccountBalance).mockResolvedValue(-10000);

    await reconcileCurrencyResidual({ account: 'Card (USD)', target_balance: 0, category: 'Cashback' });

    expect(api.addTransactions).toHaveBeenCalledOnce();
    const [accountId, txns] = vi.mocked(api.addTransactions).mock.calls[0];
    expect(accountId).toBe('acc-1');
    const txn = (txns as any[])[0];
    expect(txn.amount).toBe(10000);
    expect(txn.category).toBe('cat-1');
    expect(txn.notes).toBe('FX residual adjustment');
  });

  it('books a negative adjustment when the balance is above target', async () => {
    vi.mocked(api.getAccountBalance).mockResolvedValue(5000); // +50.00, target 0 -> -50.00
    await reconcileCurrencyResidual({ account: 'Card (USD)', target_balance: 0, category: 'Cashback' });
    const txn = (vi.mocked(api.addTransactions).mock.calls[0][1] as any[])[0];
    expect(txn.amount).toBe(-5000);
  });

  it('respects a non-zero target balance', async () => {
    vi.mocked(api.getAccountBalance).mockResolvedValue(-10000); // -100, target -30 -> +70
    await reconcileCurrencyResidual({ account: 'Card (USD)', target_balance: -30, category: 'Cashback' });
    const txn = (vi.mocked(api.addTransactions).mock.calls[0][1] as any[])[0];
    expect(txn.amount).toBe(7000);
  });

  it('does nothing when the balance already matches the target', async () => {
    vi.mocked(api.getAccountBalance).mockResolvedValue(0);
    const lines = await reconcileCurrencyResidual({ account: 'Card (USD)', target_balance: 0, category: 'Cashback' });
    expect(api.addTransactions).not.toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(/no adjustment/i);
  });

  it('allows a custom adjustment note', async () => {
    vi.mocked(api.getAccountBalance).mockResolvedValue(-10000);
    await reconcileCurrencyResidual({ account: 'Card (USD)', category: 'Cashback', notes: 'Q2 FX cleanup' });
    const txn = (vi.mocked(api.addTransactions).mock.calls[0][1] as any[])[0];
    expect(txn.notes).toBe('Q2 FX cleanup');
  });
});

/**
 * This tool creates its adjustment through createTransaction, so it receives
 * the same verdicts. Both audits found the handler turning "the transaction was
 * saved, do not repeat it" into `isError: true` under a line starting "Error:",
 * which is the contradictory reply the whole change exists to remove.
 */
describe('a verdict arriving from createTransaction', () => {
  it('does not come back as an error when the write was saved', async () => {
    let handler: any;
    registerReconcileCurrencyResidual({
      tool: (...a: unknown[]) => { handler = a.at(-1); },
    } as never);

    vi.mocked(api.getAccountBalance).mockResolvedValue(-10000 as any);
    vi.mocked(api.getTransactions).mockReset().mockResolvedValue([] as any);
    // Found by the marker written with it, not by scanning a date range.
    vi.mocked(api.runQuery)
      .mockReset()
      .mockImplementation(answerByFilter({ byId: { data: [{ id: 'new' }] } }) as never);
    vi.mocked(api.addTransactions)
      .mockReset()
      .mockRejectedValue(new Error('We had an unknown problem opening "x"'));

    const result = await handler({
      account: 'Card (USD)',
      target_balance: -50,
      category: 'Cashback',
      date: '2026-09-21',
    });

    expect(result.content[0].text).not.toMatch(/^Error:/);
    expect(result.isError).toBeUndefined();
  });
});

describe('reconcile_currency_residual: verdicts other than "saved"', () => {
  it('still reports an unknown outcome as an error', async () => {
    // Only the `applied` path was covered, so exempting every verdict from
    // isError broke nothing.
    let handler: any;
    registerReconcileCurrencyResidual({
      tool: (...a: unknown[]) => { handler = a.at(-1); },
    } as never);

    vi.mocked(api.getAccountBalance).mockResolvedValue(-10000 as any);
    vi.mocked(api.getTransactions).mockReset().mockRejectedValue(new Error('cannot read'));
    vi.mocked(api.runQuery).mockReset().mockResolvedValue({ data: [] } as any);
    vi.mocked(api.addTransactions)
      .mockReset()
      .mockRejectedValue(new Error('We had an unknown problem opening "x"'));

    const result = await handler({
      account: 'Card (USD)',
      target_balance: -50,
      category: 'Cashback',
      date: '2026-09-21',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/could not be.*determined/is);
  });
});

/**
 * Everything #88 added to this tool, covered here and not only in the
 * integration file. That file is `describe.skipIf(SKIP_ACTUAL_INTEGRATION)`,
 * so with the engine skipped the pull, the refusal, the flag and the
 * conditional header all had no net at all.
 */
describe('reconcile_currency_residual: what #88 added', () => {
  const order: string[] = [];

  beforeEach(() => {
    order.length = 0;
    vi.mocked(api.addTransactions).mockReset().mockResolvedValue('ok' as never);
    vi.mocked(api.getTransactions).mockReset().mockResolvedValue([] as never);
    vi.mocked(api.runQuery).mockReset().mockImplementation(async () => ({ data: [] }) as never);
    vi.mocked(api.sync).mockReset().mockImplementation(async () => {
      order.push('sync:start');
      await Promise.resolve();
      await Promise.resolve();
      order.push('sync:done');
    });
    vi.mocked(api.getAccountBalance).mockReset().mockImplementation(async () => {
      order.push('balance');
      return -10000;
    });
  });

  it('waits for the pull to finish before reading the balance', async () => {
    // Start and finish, because a promise started without being awaited still
    // gets its call in first.
    await reconcileCurrencyResidual({
      account: 'Card (USD)',
      target_balance: 0,
      category: 'Cashback',
      date: '2026-06-05',
    });

    expect(order.slice(0, 3)).toEqual(['sync:start', 'sync:done', 'balance']);
  });

  it('refuses a date after this server\'s today and writes nothing', async () => {
    await expect(
      reconcileCurrencyResidual({
        account: 'Card (USD)',
        target_balance: 0,
        category: 'Cashback',
        date: '2099-01-01',
      }),
    ).rejects.toThrow(/2099-01-01.*after this server's today/s);

    expect(api.addTransactions).not.toHaveBeenCalled();
    expect(api.getAccountBalance).not.toHaveBeenCalled();
  });

  it('refuses without paying for a sync', async () => {
    // The refusal used to happen after the pull, so rejecting an input cost a
    // full network round trip, which against a server that accepts the
    // connection and stops answering can hold for minutes.
    await expect(
      reconcileCurrencyResidual({
        account: 'Card (USD)',
        target_balance: 0,
        category: 'Cashback',
        date: '2099-01-01',
      }),
    ).rejects.toThrow();

    expect(api.sync).not.toHaveBeenCalled();
  });

  it('explains why, not just that it refused', async () => {
    // The remedy and the reason were the only parts a reader can act on and
    // the only parts nothing pinned: the whole explanation could be deleted
    // with the suite green, leaving a bare refusal.
    await expect(
      reconcileCurrencyResidual({
        account: 'Card (USD)',
        target_balance: 0,
        category: 'Cashback',
        date: '2099-01-01',
      }),
    ).rejects.toThrow(/would not take effect/);

    await expect(
      reconcileCurrencyResidual({
        account: 'Card (USD)',
        target_balance: 0,
        category: 'Cashback',
        date: '2099-01-01',
      }),
    ).rejects.toThrow(/balance the bank reports now/);

    await expect(
      reconcileCurrencyResidual({
        account: 'Card (USD)',
        target_balance: 0,
        category: 'Cashback',
        date: '2099-01-01',
      }),
    ).rejects.toThrow(/Use today or a past date/);
  });

  it('refuses through the handler as an error, not as a result', async () => {
    // The two refusal tests call the function directly, so nothing watched the
    // wire. Returning the refusal without `isError` would let its text read as
    // a reconciliation that happened.
    let handler: any;
    registerReconcileCurrencyResidual({
      tool: (...a: unknown[]) => { handler = a.at(-1); },
    } as never);

    const res = await handler({
      account: 'Card (USD)',
      target_balance: 0,
      category: 'Cashback',
      date: '2099-01-01',
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/^Error:/);
    expect(res.content[0].text).toMatch(/after this server's today/);
  });

  it('points at the tool that does record a date ahead', async () => {
    // Recording a purchase before the bank posts it is ordinary, and it is
    // create_transaction's job. Saying only "use a past date" sends someone
    // away from the thing they actually wanted.
    await expect(
      reconcileCurrencyResidual({
        account: 'Card (USD)',
        target_balance: 0,
        category: 'Cashback',
        date: '2099-01-01',
      }),
    ).rejects.toThrow(/create_transaction/);
  });

  it('calls an impossible date what it is, not "in the future"', async () => {
    // 2026-09-31 has no 31st. Reporting it as a future date is misleading, and
    // an impossible date in the past would otherwise be written and counted in
    // the balance as though it were a real day.
    await expect(
      reconcileCurrencyResidual({
        account: 'Card (USD)',
        target_balance: 0,
        category: 'Cashback',
        date: '2026-09-31',
      }),
    ).rejects.toThrow(/not a real calendar date/);

    await expect(
      reconcileCurrencyResidual({
        account: 'Card (USD)',
        target_balance: 0,
        category: 'Cashback',
        date: '2026-02-30',
      }),
    ).rejects.toThrow(/not a real calendar date/);

    expect(api.addTransactions).not.toHaveBeenCalled();
  });

  it('asks for the account balance without imposing a cutoff of its own', async () => {
    // Both wrong versions of this line are a second argument: the adjustment's
    // own date, which was attempt two, and any fixed date. Asserting the shape
    // of the call catches both, and says something about this code rather than
    // about which transactions the SDK should count, which is #100's question
    // and not settled here. Matching is arity-strict, so a second argument
    // fails whatever it holds.
    await reconcileCurrencyResidual({
      account: 'Card (USD)',
      target_balance: 0,
      category: 'Cashback',
      date: '2026-06-05',
    });

    expect(api.getAccountBalance).toHaveBeenCalledWith('acc-1');
  });

  it('measures today with the same clock as every other date in the server', async () => {
    // Not a second formatting of `new Date()` here. Two notions of today in
    // one process drift across a timezone or a DST boundary, and a UTC runner
    // cannot see the drift, so this is held by construction rather than by a
    // test that could not fail where it runs.
    const lines = await reconcileCurrencyResidual({
      account: 'Card (USD)',
      target_balance: 0,
      category: 'Cashback',
      date: resolveDate('today'),
    });

    expect(lines.join('\n')).toMatch(/Currency residual reconciled/);

    await expect(
      reconcileCurrencyResidual({
        account: 'Card (USD)',
        target_balance: 0,
        category: 'Cashback',
        date: '2099-01-01',
      }),
    ).rejects.toThrow();
  });

  it('tells a client what the flag is for, in the text a client reads', () => {
    // The description is as much the wire as the schema: it is the only place
    // an agent learns that the flag exists and that "already exists" is a
    // question rather than a refusal. Without it the agent retries, which is
    // what the whole PR exists to stop.
    let description: string | undefined;
    registerReconcileCurrencyResidual({
      tool: (...a: unknown[]) => { description = a[1] as string; },
    } as never);

    expect(description).toMatch(/allow_duplicate/);
  });

  it('accepts today, which is the boundary the refusal must not eat', async () => {
    const lines = await reconcileCurrencyResidual({
      account: 'Card (USD)',
      target_balance: 0,
      category: 'Cashback',
      date: 'today',
    });

    expect(lines.join('\n')).toMatch(/Currency residual reconciled/);
  });

  it('does not announce a reconciliation when the create found a duplicate', async () => {
    vi.mocked(api.runQuery).mockImplementation(
      answerByFilter({
        byAccountDateAmount: {
          data: [{ id: 'other-1', date: '2026-06-05', amount: 10000, payee: null, notes: 'UNRELATED' }],
        },
      }) as never,
    );

    const text = (
      await reconcileCurrencyResidual({
        account: 'Card (USD)',
        target_balance: 0,
        category: 'Cashback',
        date: '2026-06-05',
      })
    ).join('\n');

    expect(text).not.toMatch(/Currency residual reconciled/);
    expect(text).toMatch(/No adjustment was booked/);
    expect(text).toContain('UNRELATED');
    expect(api.addTransactions).not.toHaveBeenCalled();
  });

  it('tells the caller to run it again, not to force the write past the check', async () => {
    // The generic advice is "pass allow_duplicate", which for this tool is its
    // least safe move: it writes an amount computed from an earlier balance.
    vi.mocked(api.runQuery).mockImplementation(
      answerByFilter({
        byAccountDateAmount: {
          data: [{ id: 'other-1', date: '2026-06-05', amount: 10000, payee: null, notes: 'X' }],
        },
      }) as never,
    );

    const text = (
      await reconcileCurrencyResidual({
        account: 'Card (USD)',
        target_balance: 0,
        category: 'Cashback',
        date: '2026-06-05',
      })
    ).join('\n');

    expect(text).toMatch(/run this again/i);
    expect(text).toMatch(/recompute/i);
  });

  it('passes the flag through, so the caller can overrule the match', async () => {
    vi.mocked(api.runQuery).mockImplementation(
      answerByFilter({
        byAccountDateAmount: {
          data: [{ id: 'other-1', date: '2026-06-05', amount: 10000, payee: null, notes: 'X' }],
        },
      }) as never,
    );

    const text = (
      await reconcileCurrencyResidual({
        account: 'Card (USD)',
        target_balance: 0,
        category: 'Cashback',
        date: '2026-06-05',
        allow_duplicate: true,
      })
    ).join('\n');

    expect(text).toMatch(/Currency residual reconciled/);
    expect(api.addTransactions).toHaveBeenCalled();
  });

  it('advertises allow_duplicate on its schema, or the flag never arrives', async () => {
    // Unknown keys are dropped silently over the wire, so an interface field
    // without a schema field is a parameter nobody can pass.
    let schema: Record<string, unknown> | undefined;
    registerReconcileCurrencyResidual({
      tool: (...a: unknown[]) => {
        schema = a[2] as Record<string, unknown>;
      },
    } as never);

    expect(Object.keys(schema ?? {})).toContain('allow_duplicate');
  });
});
