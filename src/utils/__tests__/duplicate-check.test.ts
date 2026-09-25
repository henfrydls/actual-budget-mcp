import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeQ, lastQuery } from '../../tools/__tests__/fake-query.js';

const calls: string[] = [];

vi.mock('@actual-app/api', () => ({
  default: {},
  q: (table: string) => fakeQ(table),
  // Two marks, not one. A pull that is started and not awaited still gets its
  // call in first, so recording only the start cannot tell `await pull()` from
  // `void pull()` — and the second is the regression that leaves the check
  // reading a stale copy while every test stays green.
  sync: vi.fn().mockImplementation(async () => {
    calls.push('sync:start');
    await Promise.resolve();
    await Promise.resolve();
    calls.push('sync:done');
  }),
  runQuery: vi.fn().mockImplementation(async () => { calls.push('runQuery'); return { data: [] }; }),
  getPayees: vi.fn().mockResolvedValue([
    { id: 'p-1', name: 'Farmacia Carol' },
    { id: 'p-2', name: 'Supermercado Nacional' },
  ]),
  utils: {
    amountToInteger: (amount: number) => Math.round(amount * 100),
    integerToAmount: (cents: number) => cents / 100,
  },
}));

import * as api from '@actual-app/api';
import { findPossibleDuplicates, describePossibleDuplicates } from '../duplicate-check.js';

/**
 * #88 unit cover. All of this behaviour used to be exercised only through the
 * real engine, so `SKIP_ACTUAL_INTEGRATION=1` left it at zero: the text a
 * caller reads, and the question the lookup actually asks, could both be
 * dismantled with the suite still green.
 */
describe('describePossibleDuplicates: the text the caller acts on', () => {
  const one = {
    id: 'aaaaaaaa-1111-2222-3333-444444444444',
    date: '2026-06-05',
    amount: -5000,
    payeeName: 'Farmacia Carol',
    notes: 'ibuprofeno',
    isTransfer: false,
  };

  it('names the date, the amount, the account, the payee and the notes', () => {
    const text = describePossibleDuplicates([one], 'Checking').join('\n');

    expect(text).toContain('2026-06-05');
    expect(text).toContain('-50.00');
    expect(text).toContain('Checking');
    expect(text).toContain('Farmacia Carol');
    expect(text).toContain('ibuprofeno');
  });

  it('gives the id, which is the only part that can be acted on', () => {
    // Without this the caller is told something exists and given no way to
    // look at it, update it or delete it. The PR promises the id; nothing
    // asserted it, so the line could be dropped in silence.
    const text = describePossibleDuplicates([one], 'Checking').join('\n');

    expect(text).toContain('id: aaaaaaaa-1111-2222-3333-444444444444');
  });

  it('says nothing was created, and how to go ahead anyway', () => {
    const text = describePossibleDuplicates([one], 'Checking').join('\n');

    expect(text).toMatch(/nothing was created/i);
    expect(text).toContain('allow_duplicate: true');
  });

  it('counts the matches rather than always saying one', () => {
    const two = { ...one, id: 'bbbbbbbb-1111-2222-3333-444444444444', notes: 'vitaminas' };

    expect(describePossibleDuplicates([one], 'Checking')[0]).toMatch(
      /^A transaction like this one already exists/,
    );
    expect(describePossibleDuplicates([one, two], 'Checking')[0]).toMatch(
      /^2 transactions like this one already exist/,
    );
  });

  it('says when the match is one leg of a transfer', () => {
    // Otherwise the far leg of a transfer reads as income already recorded,
    // and the caller has no way to tell the two apart.
    const leg = { ...one, payeeName: 'Savings', notes: null, isTransfer: true };

    expect(describePossibleDuplicates([leg], 'Checking').join('\n')).toMatch(/transfer/i);
  });

  it('does not call an ordinary transaction a transfer', () => {
    expect(describePossibleDuplicates([one], 'Checking').join('\n')).not.toMatch(/transfer/i);
  });

  it('omits the payee line when the existing row has none', () => {
    const bare = { ...one, payeeName: undefined, notes: null };
    const text = describePossibleDuplicates([bare], 'Checking').join('\n');

    expect(text).toContain('2026-06-05');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });
});

describe('findPossibleDuplicates: the question it asks', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.mocked(api.sync).mockClear().mockImplementation(async () => {
      calls.push('sync:start');
      await Promise.resolve();
      await Promise.resolve();
      calls.push('sync:done');
    });
    vi.mocked(api.runQuery)
      .mockClear()
      .mockImplementation(async () => { calls.push('runQuery'); return { data: [] } as never; });
  });

  it('waits for the pull to finish before it looks', async () => {
    // The whole of #88 is two agents against one budget. Everything this
    // server syncs, it syncs after writing, to push. This one pulls first: a
    // lookup against the local copy cannot contain the row another process
    // wrote, so the motivating case would be the one case it never caught.
    //
    // Asserting the finish and not just the start: `void pullBeforeReading()`
    // still issues the sync first and would satisfy an order-of-start check,
    // while the query races the pull it was supposed to wait for.
    await findPossibleDuplicates('acc-1', '2026-06-05', -5000);

    expect(calls).toEqual(['sync:start', 'sync:done', 'runQuery']);
  });

  it('excludes split children, which are not transactions anyone records twice', async () => {
    // A child inherits the parent's payee and carries no mark of being part of
    // anything, so reporting one refuses a legitimate purchase and names a row
    // the user cannot find.
    await findPossibleDuplicates('acc-1', '2026-06-05', -4000);

    expect(lastQuery.filter).toEqual({
      account: 'acc-1',
      date: '2026-06-05',
      amount: -4000,
      is_child: false,
    });
  });

  it('asks for splits, so a duplicated split parent is visible', async () => {
    await findPossibleDuplicates('acc-1', '2026-06-05', -7000);

    expect(lastQuery.options).toEqual({ splits: 'all' });
  });

  it('selects the transfer marker, or a transfer cannot be named as one', async () => {
    await findPossibleDuplicates('acc-1', '2026-06-05', -5000);

    expect(lastQuery.select).toContain('transfer_id');
    expect(lastQuery.select).toContain('id');
  });

  it('says on stderr that the check was weakened when the pull fails', async () => {
    // Silently falling back leaves no trace anywhere: the caller gets an
    // ordinary answer computed from a copy that may be missing exactly the row
    // it was asked about. The whole branch could be deleted and only the
    // fallback behaviour was covered, not the telling.
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(api.sync).mockRejectedValue(new Error('server offline or unreachable'));

    await findPossibleDuplicates('acc-1', '2026-06-05', -5000);

    expect(stderr).toHaveBeenCalledWith(
      expect.stringMatching(/could not sync.*only this machine/is),
    );
    // And it carries the reason, or the note is unactionable.
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('server offline or unreachable'));
    stderr.mockRestore();
  });

  it('does not name one tool in a warning this module shares', async () => {
    // It said `[create_transaction]` from inside a shared module. #98 gives it
    // create_transfer and create_split_transaction as callers, at which point
    // the prefix states something false.
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(api.sync).mockRejectedValue(new Error('offline'));

    await findPossibleDuplicates('acc-1', '2026-06-05', -5000);

    const said = stderr.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toContain('[actual-budget-mcp]');
    expect(said).not.toContain('create_transaction');
    stderr.mockRestore();
  });

  it('still answers from the local copy when the sync fails', async () => {
    // Being unable to reach the server must not stop anyone recording a
    // transaction. The check gets weaker, not fatal.
    vi.mocked(api.sync).mockRejectedValue(new Error('server offline or unreachable'));
    vi.mocked(api.runQuery).mockResolvedValue({
      data: [{ id: 't-1', date: '2026-06-05', amount: -5000, payee: 'p-1', notes: null }],
    } as never);

    const found = await findPossibleDuplicates('acc-1', '2026-06-05', -5000);

    expect(found).toHaveLength(1);
    expect(found[0].id).toBe('t-1');
  });

  it('resolves the payee id to a name, since an id names nothing', async () => {
    vi.mocked(api.runQuery).mockResolvedValue({
      data: [{ id: 't-1', date: '2026-06-05', amount: -5000, payee: 'p-2', notes: null }],
    } as never);

    const found = await findPossibleDuplicates('acc-1', '2026-06-05', -5000);

    expect(found[0].payeeName).toBe('Supermercado Nacional');
  });

  it('reports a row carrying a transfer id as a transfer', async () => {
    vi.mocked(api.runQuery).mockResolvedValue({
      data: [
        { id: 't-1', date: '2026-06-05', amount: 5000, payee: 'p-1', notes: null, transfer_id: 't-2' },
        { id: 't-3', date: '2026-06-05', amount: 5000, payee: 'p-1', notes: null, transfer_id: null },
      ],
    } as never);

    const found = await findPossibleDuplicates('acc-1', '2026-06-05', 5000);

    expect(found.map((f) => f.isTransfer)).toEqual([true, false]);
  });

  it('finds nothing when nothing matches', async () => {
    expect(await findPossibleDuplicates('acc-1', '2026-06-05', -5000)).toEqual([]);
  });
});
