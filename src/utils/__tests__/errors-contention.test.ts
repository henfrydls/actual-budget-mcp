import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../data-dir-lock.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../data-dir-lock.js')>()),
  readDataDirLock: vi.fn(),
}));

import { readDataDirLock } from '../data-dir-lock.js';
import { describeError } from '../errors.js';

/** A sync failure exactly as @actual-app/api reports it (#40: empty message). */
const syncFailure = Object.assign(new Error(''), { reason: 'out-of-sync' });

describe('describeError names data dir contention (#47)', () => {
  beforeEach(() => {
    vi.mocked(readDataDirLock).mockReset();
  });

  afterEach(() => {
    delete process.env.ACTUAL_DATA_DIR;
  });

  it('points at the other server when one holds the data dir', () => {
    vi.mocked(readDataDirLock).mockReturnValue({
      pid: 4242,
      startedAt: '2026-08-31T10:00:00.000Z',
      version: '0.8.1',
    });

    const message = describeError(syncFailure);

    expect(message).toMatch(/another/i);
    expect(message).toContain('4242');
    expect(message).toMatch(/ACTUAL_DATA_DIR/);
  });

  it('still explains how to repair, not only the contention', () => {
    vi.mocked(readDataDirLock).mockReturnValue({
      pid: 4242,
      startedAt: '2026-08-31T10:00:00.000Z',
      version: '0.8.1',
    });

    expect(describeError(syncFailure)).toContain('repair_sync');
  });

  it('says nothing about contention when the directory is free', () => {
    vi.mocked(readDataDirLock).mockReturnValue(null);

    const message = describeError(syncFailure);

    expect(message).not.toMatch(/another/i);
    expect(message).toContain('repair_sync');
  });

  it('does not blame ourselves for holding our own lock', () => {
    vi.mocked(readDataDirLock).mockReturnValue({
      pid: process.pid,
      startedAt: '2026-08-31T10:00:00.000Z',
      version: '0.8.1',
    });

    expect(describeError(syncFailure)).not.toMatch(/another/i);
  });

  it('leaves unrelated errors untouched', () => {
    vi.mocked(readDataDirLock).mockReturnValue({
      pid: 4242,
      startedAt: '2026-08-31T10:00:00.000Z',
      version: '0.8.1',
    });

    expect(describeError(new Error('No account found matching "Nope"'))).toBe(
      'No account found matching "Nope"',
    );
  });

  it('says nothing about contention on a failure contention does not cause', () => {
    // #206: the note was appended to every description, so a read that could
    // not refresh, and a tool that failed with the server stopped, both ended
    // on a paragraph about another server. Two servers on one budget produce
    // an out-of-sync budget and the empty mid-sync error; they do not stop a
    // server answering.
    vi.mocked(readDataDirLock).mockReturnValue({
      pid: 4242,
      startedAt: '2026-08-31T10:00:00.000Z',
      version: '0.8.1',
    });

    const unreachable = describeError(new Error('We had an unknown problem opening "b"'));
    const expired = describeError(
      Object.assign(new Error('We had an unknown problem opening "b"'), {
        code: 'token-expired',
      }),
    );
    const decrypt = describeError(
      Object.assign(new Error('We had an unknown problem opening "b"'), {
        code: 'decrypt-failure',
      }),
    );

    expect(unreachable).not.toContain('4242');
    expect(expired).not.toContain('4242');
    expect(decrypt).not.toContain('4242');
  });

  it('mentions contention on the empty-message sync failure too', () => {
    vi.mocked(readDataDirLock).mockReturnValue({
      pid: 4242,
      startedAt: '2026-08-31T10:00:00.000Z',
      version: '0.8.1',
    });

    expect(describeError(new Error(''))).toMatch(/another/i);
  });
});

/**
 * #71, from two real crashes on 10 and 11 September: both landed mid-write and
 * the transaction was already in the budget when the error came back. An error
 * reads as "it did not happen", so the natural next step duplicates it.
 */
describe('an error that cannot promise the write did not happen', () => {
  it('warns before a retry when the sync state is out of sync', async () => {
    const { describeError } = await import('../errors.js');

    const text = describeError(new Error('out-of-sync'));

    expect(text).toMatch(/check the budget before retrying/i);
    expect(text).toMatch(/duplicate/i);
  });

  it('warns the same way for the empty error Actual throws mid-sync', async () => {
    const { describeError } = await import('../errors.js');

    expect(describeError(new Error(''))).toMatch(/check the budget before retrying/i);
  });

  it('stays quiet for an ordinary error that says what went wrong', async () => {
    const { describeError } = await import('../errors.js');

    expect(describeError(new Error('Category "Food" does not exist'))).not.toMatch(/duplicate/i);
  });
});
