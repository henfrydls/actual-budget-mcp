import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeQ, lastQuery, answerByFilter } from './fake-query.js';

// Mock the external Actual API. addTransactions returns the literal 'ok'
// (matching the real SDK: api/transactions-add -> Promise<'ok'>), NOT an array
// of ids. This is the crux of #26: any logic that expects ids back is dead code.
vi.mock('@actual-app/api', () => ({
  default: {},
  getAccounts: vi.fn().mockResolvedValue([
    { id: 'acc-1', name: 'Checking', closed: false, offbudget: false },
  ]),
  getCategories: vi.fn().mockResolvedValue([
    { id: 'cat-1', name: 'Alimentación', group_id: 'grp-1', hidden: false },
    { id: 'cat-2', name: 'Cashback', group_id: 'grp-2', hidden: false },
  ]),
  getTransactions: vi.fn(),
  // No longer used to identify the row; kept because the tool reads payees.
  getPayees: vi.fn().mockResolvedValue([]),
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
import { createTransaction, registerCreateTransaction } from '../write/create-transaction.js';

describe('createTransaction (#26 explicit category must win)', () => {
  beforeEach(() => {
    vi.mocked(api.addTransactions).mockClear().mockResolvedValue('ok' as any);
    vi.mocked(api.updateTransaction).mockClear().mockResolvedValue({} as any);
    vi.mocked(api.getTransactions).mockReset().mockResolvedValue([] as any);
    vi.mocked(api.runQuery).mockReset().mockResolvedValue({ data: [] } as any);
    vi.mocked(api.sync).mockReset().mockResolvedValue(undefined as any);
  });

  it('forces the explicit category when the SDK overrides it with a learned one', async () => {
    // The created row, found by its marker, came back with the wrong (learned)
    // category.
    vi.mocked(api.runQuery).mockImplementation(answerByFilter({ byId: { data: [{ id: 'txn-new', category: 'cat-2', amount: -10000 }] } }) as any);

    await createTransaction({
      account: 'Checking',
      amount: -100,
      payee: 'Vendor',
      category: 'Alimentación',
      date: '2026-06-05',
    });

    expect(api.addTransactions).toHaveBeenCalledWith('acc-1', expect.any(Array), {
      learnCategories: false,
      runTransfers: false,
    });
    expect(api.updateTransaction).toHaveBeenCalledOnce();
    // #44: the amount is re-sent so the update can never reset it to 0.
    expect(api.updateTransaction).toHaveBeenCalledWith('txn-new', {
      category: 'cat-1',
      amount: -10000,
    });
  });

  it('does not call updateTransaction when the stored category already matches', async () => {
    vi.mocked(api.runQuery).mockImplementation(answerByFilter({ byId: { data: [{ id: 'txn-new', category: 'cat-1', amount: -10000 }] } }) as any);

    await createTransaction({
      account: 'Checking',
      amount: -100,
      category: 'Alimentación',
      date: '2026-06-05',
    });

    expect(api.updateTransaction).not.toHaveBeenCalled();
  });

  it('looks the row up only when a category has to be enforced', async () => {
    // Recorded inside the mock, per call. Reading `lastQuery` after the fact
    // only ever describes whichever query happened to run last, so it would
    // stop meaning anything the moment another query were added after this
    // one, and it could not fail.
    const byId: unknown[] = [];
    vi.mocked(api.runQuery).mockImplementation(async () => {
      if (lastQuery.filter && 'id' in lastQuery.filter) byId.push(lastQuery.filter);
      return { data: [] } as never;
    });

    await createTransaction({ account: 'Checking', amount: -50, date: '2026-06-05' });

    expect(api.addTransactions).toHaveBeenCalledOnce();
    // The duplicate check queries before writing; what must not happen is the
    // marker lookup, which only runs when a category has to be enforced.
    expect(byId).toHaveLength(0);
    expect(api.updateTransaction).not.toHaveBeenCalled();
  });

  it('can only ever touch the row it wrote, never one beside it', async () => {
    // The old code found "rows that were not there before" within a date
    // range, so another process's transaction could be given this one's
    // category. A marker lookup returns one row: ours.
    vi.mocked(api.runQuery).mockImplementation(answerByFilter({ byId: { data: [{ id: 'ours', category: 'cat-2', amount: -10000 }] } }) as any);

    await createTransaction({
      account: 'Checking',
      amount: -100,
      category: 'Alimentación',
      date: '2026-06-05',
    });

    expect(vi.mocked(api.updateTransaction).mock.calls.map((c) => c[0])).toEqual(['ours']);
  });

  it('warns on stderr when the row cannot be found to enforce its category', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(api.runQuery).mockImplementation(answerByFilter({ byId: { data: [] } }) as any);

    await createTransaction({
      account: 'Checking',
      amount: -100,
      category: 'Alimentación',
      date: '2026-06-05',
    });

    expect(api.updateTransaction).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/could not find the new transaction/));
    stderr.mockRestore();
  });
});

/**
 * #79. Actual can apply a write and then fail, so `Error` does not mean "it did
 * not happen". Six occurrences were collected from two people using the server
 * daily, every one a transaction already in the budget when the error arrived.
 *
 * The row is found by the marker this server writes with it, so these tests
 * drive `runQuery`, not a date window.
 */
describe('a write that fails after it has already been applied', () => {
  const failure = () => new Error('We had an unknown problem opening "My-Finances-8174eb5"');

  /** What the marker lookup finds: our row, nothing, or an unreadable budget. */
  /**
   * Answers the marker lookup only. The duplicate check runs the other query
   * on the same mock, and handing it these rows would make every write look
   * like a duplicate and return before writing at all.
   */
  const lookupFinds = (rows: Array<Record<string, unknown>> | null) => {
    vi.mocked(api.runQuery).mockReset();
    if (rows === null) {
      vi.mocked(api.runQuery).mockImplementation(async () => {
        if ('id' in (lastQuery.filter ?? {})) throw new Error('budget will not open');
        return { data: [] } as never;
      });
    } else {
      vi.mocked(api.runQuery).mockImplementation(
        answerByFilter({ byId: { data: rows } }) as never,
      );
    }
  };

  beforeEach(() => {
    vi.mocked(api.getTransactions).mockReset().mockResolvedValue([] as any);
    vi.mocked(api.addTransactions).mockReset().mockResolvedValue('ok' as any);
    vi.mocked(api.sync).mockReset().mockResolvedValue(undefined as any);
    vi.mocked(api.updateTransaction).mockReset().mockResolvedValue({} as any);
  });

  const attempt = () =>
    createTransaction({ account: 'Checking', amount: -50, date: '2026-09-21' });

  it('does not report a plain failure when the transaction is there', async () => {
    lookupFinds([{ id: 'ours', amount: -5000 }]);
    vi.mocked(api.addTransactions).mockRejectedValue(failure());

    await expect(attempt()).rejects.toThrow(/was saved/i);
  });

  it('tells the caller not to repeat it, which is what duplicates', async () => {
    lookupFinds([{ id: 'ours', amount: -5000 }]);
    vi.mocked(api.addTransactions).mockRejectedValue(failure());

    await expect(attempt()).rejects.toThrow(/do not repeat it/i);
  });

  it('says a retry is safe when nothing carries the marker', async () => {
    lookupFinds([]);
    vi.mocked(api.addTransactions).mockRejectedValue(failure());

    await expect(attempt()).rejects.toThrow(/was not saved.*can be retried/is);
  });

  it('is not fooled by another row of the same amount on the same day', async () => {
    // The old probe matched on amount and date, so a second agent reconciling
    // the same statement could answer "it was saved" about a transaction that
    // was never written. A marker lookup cannot confuse the two.
    lookupFinds([]);
    vi.mocked(api.getTransactions).mockResolvedValue([
      { id: 'someone-elses', account: 'acc-1', date: '2026-09-21', amount: -5000 },
    ] as any);
    vi.mocked(api.addTransactions).mockRejectedValue(failure());

    await expect(attempt()).rejects.toThrow(/was not saved/i);
  });

  it('finds the row even when a rule moved its date and amount', async () => {
    // Rules run on every insert. Nothing else on the row stays put; the marker
    // does.
    lookupFinds([{ id: 'ours', amount: -9999 }]);
    vi.mocked(api.addTransactions).mockRejectedValue(failure());

    await expect(attempt()).rejects.toThrow(/was saved/i);
  });

  it('admits it cannot tell when the budget will not open again either', async () => {
    lookupFinds(null);
    vi.mocked(api.addTransactions).mockRejectedValue(failure());

    await expect(attempt()).rejects.toThrow(/could not be.*determined/is);
  });

  it('covers the sync step too, where the row is in and the sync is not', async () => {
    lookupFinds([{ id: 'ours', amount: -5000 }]);
    vi.mocked(api.sync).mockRejectedValue(failure());

    await expect(attempt()).rejects.toThrow(/was saved/i);
  });

  it('leaves an ordinary refusal unwrapped, not merely quoted inside a verdict', async () => {
    lookupFinds([]);
    vi.mocked(api.addTransactions).mockRejectedValue(new Error('amount is required'));

    await expect(attempt()).rejects.toThrow(/^amount is required$/);
  });

  it('labels every write, since an unlabelled one could not be found again', async () => {
    lookupFinds([]);

    await attempt();

    const [, [written]] = vi.mocked(api.addTransactions).mock.calls[0] as any;
    expect(written.id).toMatch(/^[0-9a-f-]{36}$/);
    // Not imported_id: labelling that field stops Actual deduplicating this
    // row against a later file import.
    expect(written.imported_id).toBeUndefined();
  });

  it('gives each write its own label', async () => {
    lookupFinds([]);

    await attempt();
    await attempt();

    const first = (vi.mocked(api.addTransactions).mock.calls[0] as any)[1][0].id;
    const second = (vi.mocked(api.addTransactions).mock.calls[1] as any)[1][0].id;
    expect(first).not.toBe(second);
  });
});

/**
 * Through the registered handler, not the inner function: the promise that a
 * saved write is not reported as an error lives in the handler.
 */
describe('create_transaction through its handler', () => {
  const capture = () => {
    let handler: any;
    registerCreateTransaction({ tool: (...a: unknown[]) => { handler = a.at(-1); } } as never);
    return handler as (input: Record<string, unknown>) => Promise<any>;
  };

  beforeEach(() => {
    vi.mocked(api.getTransactions).mockReset().mockResolvedValue([] as any);
    vi.mocked(api.sync).mockReset().mockResolvedValue(undefined as any);
    vi.mocked(api.addTransactions)
      .mockReset()
      .mockRejectedValue(new Error('We had an unknown problem opening "x"'));
  });

  it('does not report a saved write as an error', async () => {
    vi.mocked(api.runQuery).mockImplementation(answerByFilter({ byId: { data: [{ id: 'ours' }] } }) as any);

    const result = await capture()({ account: 'Checking', amount: -50, date: '2026-09-21' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/was saved/i);
    expect(result.content[0].text).not.toMatch(/^Error:/);
  });

  it('still reports an unknown outcome as an error', async () => {
    vi.mocked(api.runQuery).mockImplementation(async () => {
      if ('id' in (lastQuery.filter ?? {})) throw new Error('budget will not open');
      return { data: [] } as never;
    });

    const result = await capture()({ account: 'Checking', amount: -50, date: '2026-09-21' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/could not be.*determined/is);
  });
});

/**
 * The safety net, wired. "Not saved" is the only verdict that authorises a
 * retry, and the promise is that it costs two agreeing lookups. Removing the
 * corroboration from any of the three tools used to break nothing.
 */
describe('the second lookup, through the tool', () => {
  const failure = () => new Error('We had an unknown problem opening "x"');

  beforeEach(() => {
    vi.mocked(api.addTransactions).mockReset().mockRejectedValue(failure());
    vi.mocked(api.sync).mockReset().mockResolvedValue(undefined as any);
    vi.mocked(api.runQuery).mockReset().mockResolvedValue({ data: [] } as any);
  });

  it('believes the second lookup when the first missed the row', async () => {
    vi.mocked(api.getTransactions).mockReset().mockResolvedValue([
      { id: 'the-marker', account: 'acc-1', date: '2026-09-21', amount: -5000 },
    ] as any);

    // The id the tool generated is the one it looks for, so echo it back.
    let handler: any;
    registerCreateTransaction({ tool: (...a: unknown[]) => { handler = a.at(-1); } } as never);
    vi.mocked(api.addTransactions).mockImplementation(async (_acct, [txn]: any) => {
      vi.mocked(api.getTransactions).mockResolvedValue([
        { id: txn.id, account: 'acc-1', date: '2026-09-21', amount: -5000 },
      ] as any);
      throw failure();
    });

    const result = await handler({ account: 'Checking', amount: -50, date: '2026-09-21' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/was saved/i);
  });

  it('will not say "not saved" when the second lookup cannot run', async () => {
    vi.mocked(api.getTransactions).mockReset().mockRejectedValue(new Error('cannot read'));

    await expect(
      createTransaction({ account: 'Checking', amount: -50, date: '2026-09-21' }),
    ).rejects.toThrow(/could not be.*determined/is);
  });

  it('says not saved only when both lookups agree', async () => {
    vi.mocked(api.getTransactions).mockReset().mockResolvedValue([] as any);

    await expect(
      createTransaction({ account: 'Checking', amount: -50, date: '2026-09-21' }),
    ).rejects.toThrow(/was not saved/i);
  });
});

describe('when a rule turns the transaction into a split', () => {
  it('says the category was not applied instead of printing it', async () => {
    // Actual ignores the category on a split parent, so setting it does
    // nothing and reporting it would be a lie.
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(api.getTransactions).mockReset().mockResolvedValue([] as any);
    vi.mocked(api.addTransactions).mockReset().mockResolvedValue('ok' as any);
    vi.mocked(api.sync).mockReset().mockResolvedValue(undefined as any);
    vi.mocked(api.updateTransaction).mockReset().mockResolvedValue({} as any);
    vi.mocked(api.runQuery)
      .mockReset()
      .mockImplementation(
        answerByFilter({
          byId: { data: [{ id: 'ours', category: null, amount: -5000, is_parent: true }] },
        }) as never,
      );

    await createTransaction({
      account: 'Checking',
      amount: -50,
      date: '2026-09-21',
      category: 'Alimentación',
    });

    expect(api.updateTransaction).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/turned the new transaction.*into a split/i));
    stderr.mockRestore();
  });
});

/**
 * The wiring, not the util. `duplicate-check.test.ts` covers the lookup and the
 * text; none of it covered what `create_transaction` does with either, so with
 * `SKIP_ACTUAL_INTEGRATION=1` the threshold that decides whether to refuse at
 * all could be moved and nothing failed.
 */
describe('create_transaction: what it does with the duplicate check', () => {
  const anExisting = {
    data: [{ id: 'existing-1', date: '2026-09-21', amount: -5000, payee: null, notes: 'ALREADY-HERE' }],
  };

  beforeEach(() => {
    vi.mocked(api.sync).mockReset().mockResolvedValue(undefined as never);
    vi.mocked(api.addTransactions).mockReset().mockResolvedValue('ok' as never);
    vi.mocked(api.getTransactions).mockReset().mockResolvedValue([] as never);
    vi.mocked(api.runQuery).mockReset().mockImplementation(async () => ({ data: [] }) as never);
  });

  it('names the account, not the id it was given', async () => {
    // The preview's account column comes from the wiring, not the util: the
    // unit test for the text hands it a name directly, so it only proves the
    // util prints what it is given. Passing an id through and getting the id
    // back would be a row the reader cannot place.
    vi.mocked(api.runQuery).mockImplementation(
      answerByFilter({ byAccountDateAmount: anExisting }) as never,
    );

    const text = (
      await createTransaction({ account: 'acc-1', amount: -50, date: '2026-09-21' })
    ).join('\n');

    expect(text).toContain('Checking');
    expect(text).not.toContain('acc-1');
  });

  it('refuses on a single match, not only on several', async () => {
    // A `> 1` threshold would let the ordinary case straight through: one
    // existing transaction is exactly what recording a payment twice looks like.
    vi.mocked(api.runQuery).mockImplementation(
      answerByFilter({ byAccountDateAmount: anExisting }) as never,
    );

    const lines = await createTransaction({
      account: 'Checking',
      amount: -50,
      date: '2026-09-21',
    });

    expect(lines.join('\n')).toMatch(/already exists/i);
    expect(lines.join('\n')).toContain('ALREADY-HERE');
    expect(api.addTransactions).not.toHaveBeenCalled();
  });

  it('asks the lookup before writing, never after', async () => {
    const order: string[] = [];
    vi.mocked(api.runQuery).mockImplementation(async () => {
      if (lastQuery.filter && 'account' in lastQuery.filter) order.push('lookup');
      return { data: [] } as never;
    });
    vi.mocked(api.addTransactions).mockImplementation(async () => {
      order.push('write');
      return 'ok' as never;
    });

    await createTransaction({ account: 'Checking', amount: -50, date: '2026-09-21' });

    expect(order).toEqual(['lookup', 'write']);
  });

  it('skips the pull and the lookup entirely when the flag is set', async () => {
    // Not merely "creates anyway": the flag is what lets a caller avoid the
    // extra round trip, so doing the work and discarding the answer would be a
    // silent cost with no behavioural difference to catch it.
    // Recorded inside the mock, at the moment of each call. Filtering
    // `mock.calls` afterwards would read whatever `lastQuery` ended up holding
    // and could not fail.
    const lookups: unknown[] = [];
    vi.mocked(api.runQuery).mockImplementation(async () => {
      if (lastQuery.filter && 'account' in lastQuery.filter) {
        lookups.push(lastQuery.filter);
        return anExisting as never;
      }
      return { data: [] } as never;
    });

    const lines = await createTransaction({
      account: 'Checking',
      amount: -50,
      date: '2026-09-21',
      allow_duplicate: true,
    });

    expect(lines.join('\n')).toMatch(/Transaction created/);
    expect(lookups).toHaveLength(0);
    // One sync only: the one after the write. A pre-check pull would make two.
    expect(api.sync).toHaveBeenCalledTimes(1);
  });
});
