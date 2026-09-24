import { describe, it, expect, vi } from 'vitest';
import { mayHaveBeenApplied, verifyFailedWrite } from '../write-outcome.js';

const context = (probe: () => Promise<boolean>) => ({
  action: 'The transaction',
  probe,
  whereToLook: 'BHD on 2026-09-21',
});

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
      context(async () => true),
    );

    expect(verdict).toBe('applied');
    expect(message).toMatch(/was saved/i);
    expect(message).toMatch(/do not repeat it/i);
  });

  it('says it was not saved, and that retrying is safe', async () => {
    const { verdict, message } = await verifyFailedWrite(
      failure,
      context(async () => false),
    );

    expect(verdict).toBe('not-applied');
    expect(message).toMatch(/was not saved/i);
    expect(message).toMatch(/retried safely/i);
  });

  it('admits it does not know when the budget cannot be re-read', async () => {
    // The error that broke the write often breaks the next read too. This is
    // the only case where the caller has to go and look.
    const { verdict, message } = await verifyFailedWrite(
      failure,
      context(async () => {
        throw new Error('still broken');
      }),
    );

    expect(verdict).toBe('undetermined');
    expect(message).toMatch(/unknown/i);
    expect(message).toMatch(/duplicate/i);
  });

  it('names where to look in every outcome', async () => {
    for (const probe of [async () => true, async () => false, async () => { throw new Error('x'); }]) {
      const { message } = await verifyFailedWrite(failure, context(probe));
      expect(message).toContain('BHD on 2026-09-21');
    }
  });

  it('keeps the original error visible, so nothing is hidden by the summary', async () => {
    const { message } = await verifyFailedWrite(failure, context(async () => true));

    expect(message).toMatch(/unknown problem opening/i);
  });

  it('never reports a bare failure for this class of error', async () => {
    const probes = [async () => true, async () => false, async () => { throw new Error('x'); }];
    for (const probe of probes) {
      const { message } = await verifyFailedWrite(failure, context(probe));
      // Each outcome must tell the caller what to do next, not just what broke.
      expect(message).toMatch(/do not repeat it|retried safely|before trying again/i);
    }
  });
});

describe('the old caution and the new answer do not appear together', () => {
  it('drops "may already have been applied" once the answer is known', async () => {
    // The caution is for tools that cannot tell. Printing it next to "it was
    // saved" would contradict it, and a message that hedges its own conclusion
    // teaches the reader to ignore both halves.
    const { message } = await verifyFailedWrite(
      new Error('out-of-sync'),
      context(async () => true),
    );

    expect(message).toMatch(/was saved/i);
    expect(message).not.toMatch(/may already have been applied/i);
  });

  it('keeps it for callers that have not checked', async () => {
    const { describeError } = await import('../errors.js');

    expect(describeError(new Error('out-of-sync'))).toMatch(/check the budget before retrying/i);
  });
});
