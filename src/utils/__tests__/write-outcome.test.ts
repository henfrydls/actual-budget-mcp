import { describe, it, expect, vi } from 'vitest';
import { mayHaveBeenApplied, verifyFailedWrite } from '../write-outcome.js';

/**
 * The probe is a lookup by the marker written with the transaction. `null`
 * means the budget could not be read, which is a third answer and not a zero.
 */
const context = (rows: Array<{ id: string }> | null) => ({
  action: 'The transaction',
  whereToLook: 'BHD on 2026-09-21',
  probe: {
    marker: 'marker-1',
    find: async () => rows,
  },
});

const present = [{ id: 'ours' }];
const absent: Array<{ id: string }> = [];

describe('which failures can have landed anyway', () => {
  it('counts the one people actually hit', () => {
    // The exact string from six reported occurrences (#79).
    expect(
      mayHaveBeenApplied(new Error('We had an unknown problem opening "My-Finances-8174eb5"')),
    ).toBe(true);
  });

  it('counts a sync state that is out of step', () => {
    expect(mayHaveBeenApplied(new Error('out-of-sync'))).toBe(true);
  });

  it('counts the empty error Actual throws mid-sync', () => {
    expect(mayHaveBeenApplied(new Error(''))).toBe(true);
  });

  it('leaves a plain refusal alone, since nothing was written', () => {
    // Checking the budget after every validation error would be noise, and
    // noise is what stops a warning being read.
    expect(mayHaveBeenApplied(new Error('Category "Food" does not exist'))).toBe(false);
    expect(mayHaveBeenApplied(new Error('No account found matching "BHD"'))).toBe(false);
  });
});

describe('reporting what really happened to a failed write', () => {
  const failure = new Error('We had an unknown problem opening "My-Finances-8174eb5"');

  it('says it was saved, and says not to repeat it', async () => {
    const { verdict, message } = await verifyFailedWrite(
      failure,
      context(present),
    );

    expect(verdict).toBe('applied');
    expect(message).toMatch(/was saved/i);
    expect(message).toMatch(/do not repeat it/i);
  });

  it('says it was not saved, and that retrying is safe', async () => {
    const { verdict, message } = await verifyFailedWrite(
      failure,
      context(absent),
    );

    expect(verdict).toBe('not-applied');
    expect(message).toMatch(/was not saved/i);
    expect(message).toMatch(/can be retried/i);
  });

  it('admits it does not know when the budget cannot be re-read', async () => {
    // The error that broke the write often breaks the next read too. This is
    // the only case where the caller has to go and look.
    const { verdict, message } = await verifyFailedWrite(
      failure,
      context(null),
    );

    expect(verdict).toBe('undetermined');
    expect(message).toMatch(/unknown/i);
    expect(message).toMatch(/duplicate/i);
  });

  it('names where to look in every outcome', async () => {
    for (const rows of [present, absent, null]) {
      const { message } = await verifyFailedWrite(failure, context(rows));
      expect(message).toContain('BHD on 2026-09-21');
    }
  });

  it('keeps the original error visible, so nothing is hidden by the summary', async () => {
    const { message } = await verifyFailedWrite(failure, context(present));

    expect(message).toMatch(/unknown problem opening/i);
  });

  it('never reports a bare failure for this class of error', async () => {
    const cases = [present, absent, null];
    for (const rows of cases) {
      const { message } = await verifyFailedWrite(failure, context(rows));
      // Each outcome must tell the caller what to do next, not just what broke.
      expect(message).toMatch(/do not repeat it|can be retried|before trying again/i);
    }
  });
});

describe('the old caution and the new answer do not appear together', () => {
  it('drops the retry caution once the answer is known', async () => {
    // The caution is for tools that cannot tell. Printing it next to "it was
    // saved" would contradict it, and a message that hedges its own conclusion
    // teaches the reader to ignore both halves.
    const { message } = await verifyFailedWrite(
      new Error('out-of-sync'),
      context(present),
    );

    expect(message).toMatch(/was saved/i);
    // The caution's actual words. An earlier version of this test asserted the
    // absence of a phrase the constant never contained, so it could not fail:
    // mutating describeError to ignore the option broke nothing.
    expect(message).not.toMatch(/check the budget before retrying/i);
  });

  it('keeps it for callers that have not checked', async () => {
    const { describeError } = await import('../errors.js');

    expect(describeError(new Error('out-of-sync'))).toMatch(/check the budget before retrying/i);
  });
});

describe('which errors the gate lets through', () => {
  it('reads the tag Actual sets, not only the message', async () => {
    // withErrorCode writes `code`; FileDownloadError writes `reason`. Reading
    // only `message` made this disagree with describeError about the same error.
    expect(mayHaveBeenApplied(Object.assign(new Error('x'), { reason: 'out-of-sync' }))).toBe(true);
    expect(mayHaveBeenApplied(Object.assign(new Error('x'), { code: 'out-of-sync' }))).toBe(true);
  });

  it('excludes a version mismatch, where nothing was written at all', async () => {
    // out-of-sync-migrations contains "out-of-sync" but means the budget could
    // not be loaded. Treating it as uncertain invents doubt and buries the
    // message that actually helps: update Actual.
    expect(mayHaveBeenApplied(new Error('out-of-sync-migrations'))).toBe(false);
    expect(mayHaveBeenApplied(new Error('out-of-sync-data'))).toBe(false);
  });
});

describe('the message and the verdict stay consistent', () => {
  it('warns about date rules on the verdict that authorises a retry', async () => {
    // It used to say this only on "unknown", which is the one verdict where
    // nobody is about to repeat anything. The caveat belongs where the retry is.
    const { message } = await verifyFailedWrite(
      new Error('We had an unknown problem opening "x"'),
      context(absent),
    );

    expect(message).toMatch(/can be retried/i);
    expect(message).toMatch(/no transaction carries that label/i);
  });

  it('prints the contention paragraph exactly once, not twice', async () => {
    // With no other server the note is empty and a "<= 1" assertion counts
    // zero and passes whatever the code does. Contention has to be real for
    // this to mean anything.
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { claimDataDir, forgetActiveDataDir, LOCK_FILE } = await import('../data-dir-lock.js');

    const root = mkdtempSync(join(tmpdir(), 'contend-twice-'));
    const configured = join(root, 'cache');
    mkdirSync(configured, { recursive: true });
    writeFileSync(
      join(configured, LOCK_FILE),
      JSON.stringify({ pid: process.pid, startedAt: '2026-09-24T00:00:00.000Z', version: '0.9.2' }),
    );
    process.env.ACTUAL_DATA_DIR = configured;
    const spy = vi.spyOn(process, 'pid', 'get').mockReturnValue(999_300);
    claimDataDir('0.9.2');

    // out-of-sync is the message describeError would also decorate.
    const { message } = await verifyFailedWrite(new Error('out-of-sync'), context(present));

    spy.mockRestore();
    forgetActiveDataDir();
    delete process.env.ACTUAL_DATA_DIR;
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }

    const occurrences = message.split('Another actual-budget-mcp server').length - 1;
    expect(occurrences).toBe(1);
  });

  it('treats a read that answers nothing as unknown, not as an empty account', async () => {
    const { verdict } = await verifyFailedWrite(new Error('out-of-sync'), {
      action: 'The transaction',
      whereToLook: 'BHD around 2026-09-21',
      probe: { marker: 'm', find: async () => null },
    });

    expect(verdict).toBe('undetermined');
  });

  it('reads an error that is not an Error instance', async () => {
    // String(error) turned { message } into "[object Object]".
    expect(mayHaveBeenApplied({ message: 'We had an unknown problem opening "x"' })).toBe(true);
  });
});

describe('the verdict carries the contention note', () => {
  it('names another server when one is there', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { claimDataDir, forgetActiveDataDir, LOCK_FILE } = await import('../data-dir-lock.js');

    const root = mkdtempSync(join(tmpdir(), 'verdict-contention-'));
    const configured = join(root, 'cache');
    mkdirSync(configured, { recursive: true });
    const incumbent = process.pid;
    writeFileSync(
      join(configured, LOCK_FILE),
      JSON.stringify({ pid: incumbent, startedAt: '2026-09-24T00:00:00.000Z', version: '0.9.2' }),
    );
    process.env.ACTUAL_DATA_DIR = configured;

    const spy = vi.spyOn(process, 'pid', 'get').mockReturnValue(999_200);
    claimDataDir('0.9.2');

    const { message } = await verifyFailedWrite(
      new Error('We had an unknown problem opening "x"'),
      context(present),
    );

    spy.mockRestore();
    forgetActiveDataDir();
    delete process.env.ACTUAL_DATA_DIR;
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }

    // #79 asks that contention be named, so the reader can tell "another
    // process has the file" from "the file is broken". Dropping it from the
    // verdict used to break no test at all.
    expect(message).toMatch(new RegExp(String(incumbent)));
  });
});

describe('one reader for an error, shared with describeError', () => {
  it('agrees with describeError about the same error', async () => {
    const { describeError } = await import('../errors.js');
    const tagged = Object.assign(new Error(''), { code: 'out-of-sync' });

    // Two readers that disagreed made one part of the server call this a sync
    // failure and another call it a refusal.
    expect(mayHaveBeenApplied(tagged)).toBe(true);
    expect(describeError(tagged)).toMatch(/out of sync|sync/i);
  });
});

/**
 * The two branches an audit found unprotected: a duplicate reported as a
 * success, and a failed second look reported as absence.
 */
describe('the verdicts that must not be guessed', () => {
  it('calls a duplicate a duplicate, not a clean save', async () => {
    // Two rows carrying an id we generated means the write landed twice. That
    // is knowledge, and the most actionable kind: there is a row to delete.
    // Reporting it as "saved" would leave the duplicate in place unmentioned.
    const { verdict, message } = await verifyFailedWrite(
      new Error('We had an unknown problem opening "x"'),
      {
        action: 'The transaction',
        whereToLook: 'BHD on 2026-09-21',
        probe: {
          marker: 'm',
          find: async () => [{ id: 'm' }, { id: 'm' }],
        },
      },
    );

    expect(verdict).toBe('duplicated');
    expect(message).toMatch(/more than once/i);
    expect(message).toMatch(/already a duplicate/i);
    expect(message).not.toMatch(/could not be determined/i);
  });

  it('does not turn a failed second look into "you can retry"', async () => {
    // The second look exists because the first can go blind. If it cannot run
    // either, there is no evidence at all, and "not saved" on no evidence is
    // the mistake this whole change exists to stop.
    const { verdict } = await verifyFailedWrite(new Error('out-of-sync'), {
      action: 'The transaction',
      whereToLook: 'BHD on 2026-09-21',
      probe: {
        marker: 'm',
        find: async () => [],
        corroborate: async () => 'unknown',
      },
    });

    expect(verdict).toBe('undetermined');
  });

  it('believes the second look when it finds what the first missed', async () => {
    const { verdict } = await verifyFailedWrite(new Error('out-of-sync'), {
      action: 'The split transaction',
      whereToLook: 'BHD on 2026-09-21',
      probe: {
        marker: 'm',
        find: async () => [],
        corroborate: async () => 'present',
      },
    });

    expect(verdict).toBe('applied');
  });

  it('says not saved only when both looks agree', async () => {
    const { verdict } = await verifyFailedWrite(new Error('out-of-sync'), {
      action: 'The transaction',
      whereToLook: 'BHD on 2026-09-21',
      probe: {
        marker: 'm',
        find: async () => [],
        corroborate: async () => 'absent',
      },
    });

    expect(verdict).toBe('not-applied');
  });
});
