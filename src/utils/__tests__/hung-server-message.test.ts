import { describe, it, expect } from 'vitest';
import { describeError } from '../errors.js';
import { mayHaveBeenApplied } from '../write-outcome.js';

/**
 * The failure that names the one thing that did not happen (#142).
 *
 * `We had an unknown problem opening "<id>"` is Actual's fallback when it has
 * no more specific case, and it comes back from a sync in the middle of a
 * write as readily as from opening anything. Measured: with the budget already
 * loaded and the server replaced by a socket that accepts and never answers, a
 * write ends with exactly that, and the reader is sent to check their budget
 * file, their sync id and their password -- none of which are the problem.
 */
const engineFailure = () => new Error('We had an unknown problem opening "my-budget-8174eb5"');

describe('a sync that failed being reported as a problem opening the budget', () => {
  it('says what did not happen, since the engine says the opposite', () => {
    const described = describeError(engineFailure());

    expect(described).toMatch(/nothing was being opened/i);
    expect(described).toMatch(/already loaded/i);
    expect(described).toMatch(/what failed was a sync/i);
  });

  it('points at the server rather than at the budget', () => {
    const described = describeError(engineFailure());

    expect(described).toMatch(/server not answering|running and reachable/i);
    expect(described).toMatch(/Nothing is wrong with your budget file/i);
  });

  it('still shows what Actual said', () => {
    // The summary must not hide the engine's words: someone searching for that
    // string, or pasting it into an issue, needs it to still be there. What
    // changed is that it is no longer the only thing said, or the first.
    const described = describeError(engineFailure());

    expect(described).toMatch(/unknown problem opening/i);
    // And the explanation comes first, which is the whole point.
    expect(described.indexOf('nothing was being opened')).toBeLessThan(
      described.indexOf('unknown problem opening'),
    );
  });

  it('lets the more specific failure win when both strings are present', () => {
    // An error can carry both: the engine's generic sentence with the real
    // cause nested inside it. `out-of-sync-migrations` means "update", which
    // is actionable; "the server is not answering" would send that person to
    // restart a server that is answering fine.
    const both = new Error(
      'We had an unknown problem opening "b": Error: out-of-sync-migrations',
    );

    expect(describeError(both)).toMatch(/cannot be loaded by this version/i);
    expect(describeError(both)).not.toMatch(/nothing was being opened/i);
  });

  it('still translates when the nested cause is an ordinary sync failure', () => {
    // `out-of-sync` without a suffix is the repairable kind, and it keeps its
    // own message too.
    const both = new Error('We had an unknown problem opening "b": out-of-sync');

    expect(describeError(both)).toMatch(/sync state/i);
  });

  it('warns that the write may have landed anyway', () => {
    // This failure arrives after the change is in the local file often enough
    // that the caution is the difference between one transaction and two.
    expect(describeError(engineFailure())).toMatch(/check the budget before retrying/i);
  });

  it('leaves that caution out when the caller already knows the outcome', () => {
    // `verifyFailedWrite` has looked the row up, so a definite answer that
    // also hedges would contradict itself.
    const described = describeError(engineFailure(), { omitUncertainWriteCaution: true });

    expect(described).not.toMatch(/check the budget before retrying/i);
    expect(described).toMatch(/nothing was being opened/i);
  });
});

/**
 * The trap.
 *
 * `mayHaveBeenApplied` recognises this failure by that same string, and uses
 * it to decide whether a write might have landed. It reads the **error
 * object**; the translation happens in `describeError`, which turns an error
 * into words. Rewriting the object instead would take the marker away and the
 * verdict would silently become "not applied" -- the one verdict that
 * authorises a retry, and a retry here is a duplicate transaction.
 */
describe('translating the message does not move the marker', () => {
  it('still treats this failure as one that may have been applied', () => {
    expect(mayHaveBeenApplied(engineFailure())).toBe(true);
  });

  it('reads the error, not the description', () => {
    // The described text no longer leads with the engine's string, so a
    // version of this check that read `describeError` output would answer
    // differently. It must not.
    const error = engineFailure();
    const described = describeError(error);

    expect(mayHaveBeenApplied(error)).toBe(true);
    expect(described).not.toBe(error.message);
  });

  it('is unchanged for every other case it decides', () => {
    // The rest of its answers, so the translation cannot have shifted one of
    // them sideways.
    expect(mayHaveBeenApplied(new Error('out-of-sync'))).toBe(true);
    expect(mayHaveBeenApplied(new Error('out-of-sync-migrations'))).toBe(false);
    expect(mayHaveBeenApplied(new Error('out-of-sync-data'))).toBe(false);
    expect(mayHaveBeenApplied(new Error(''))).toBe(true);
    expect(mayHaveBeenApplied(new Error('No budget file is open'))).toBe(false);
  });
});
