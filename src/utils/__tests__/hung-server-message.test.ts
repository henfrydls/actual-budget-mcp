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
  it('says the sentence is generic, because it is', () => {
    // `getSyncError` returns it for any reason it has no case for, and three
    // places emit it: load-budget, download-budget on the cached branch, and
    // sync. So "opening" is one of the possibilities, not a thing that is
    // ruled out.
    const described = describeError(engineFailure());

    expect(described).toMatch(/no specific case/i);
    expect(described).toMatch(/most likely cause/i);
  });

  it('points at the server, as the likely cause and not as a fact', () => {
    const described = describeError(engineFailure());

    expect(described).toMatch(/running and reachable/i);
    // Hedged. An earlier version asserted "nothing was being opened: the
    // budget was already loaded", which is false whenever it really was
    // opening one.
    expect(described).toMatch(/If the budget was already open/i);
    expect(described).not.toMatch(/Nothing is wrong with your budget file/i);
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

  describe('when the engine named a reason', () => {
    const withCode = (code: string) =>
      Object.assign(new Error('We had an unknown problem opening "b"'), { code });

    it('does not tell someone with a wrong key that their password is fine', () => {
      // `decrypt-failure`: the encryption password is wrong or the key was
      // changed on another device. The generic text sent that person to
      // restart a server that was answering perfectly well.
      const described = describeError(withCode('decrypt-failure'));

      expect(described).toMatch(/could not decrypt/i);
      expect(described).toMatch(/encryption password/i);
      expect(described).not.toMatch(/running and reachable/i);
    });

    it('names an expired session for what it is', () => {
      // `unauthorized` from a sync in the middle of a write: connection.ts
      // only filters this while connecting.
      const described = describeError(withCode('unauthorized'));

      expect(described).toMatch(/refused the credentials/i);
      expect(described).not.toMatch(/running and reachable/i);
    });

    it.each(['opening-budget', 'loading-budget'])(
      'sends %s to the cached copy, not to the server',
      (code) => {
        const described = describeError(withCode(code));

        expect(described).toMatch(/ACTUAL_DATA_DIR/);
        expect(described).not.toMatch(/running and reachable/i);
      },
    );

    it('still says something useful for a reason it does not know', () => {
      const described = describeError(withCode('some-new-reason'));

      expect(described).toMatch(/some-new-reason/);
      // Not the server claim, which would be invented.
      expect(described).not.toMatch(/running and reachable/i);
    });

    it('keeps the generic text for a network code', () => {
      // Those are the cases it describes correctly.
      for (const code of ['network-failure', 'timeout']) {
        expect(describeError(withCode(code)), code).toMatch(/running and reachable/i);
      }
    });

    it('reads a reason given as `reason` as well as `code`', () => {
      const tagged = Object.assign(new Error('We had an unknown problem opening "b"'), {
        reason: 'decrypt-failure',
      });

      expect(describeError(tagged)).toMatch(/could not decrypt/i);
    });
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
 * Where this text must not appear.
 *
 * A read never calls `api.sync`, so if one of them meets this sentence it came
 * from `ensureConnection` -- from opening a budget for real. Claiming nothing
 * was being opened there is exactly backwards, which is why the wording is
 * conditional now.
 */
describe('the places that really are opening a budget', () => {
  it('never asserts that nothing was being opened', () => {
    // The claim may appear, but only behind the condition that makes it true.
    // Asserting it outright is what was wrong: a read meeting this sentence
    // got it from `ensureConnection`, which really was opening a budget.
    for (const error of [
      new Error('We had an unknown problem opening "b"'),
      Object.assign(new Error('We had an unknown problem opening "b"'), { code: 'internal' }),
      Object.assign(new Error('We had an unknown problem opening "b"'), {
        code: 'decrypt-failure',
      }),
    ]) {
      const described = describeError(error);
      expect(described).not.toMatch(/the budget was already loaded/i);
      if (/nothing was being opened/i.test(described)) {
        expect(described, 'the claim must be conditional').toMatch(
          /If the budget was already open, nothing was being opened/i,
        );
      }
    }
  });

  it('does not state a sync as the cause when it cannot know', () => {
    // An earlier version said "what failed was a sync" as a fact, while its
    // own comment admitted the sentence is generic and the engine does not
    // say. It is conditional now.
    const described = describeError(new Error('We had an unknown problem opening "b"'));

    expect(described).not.toMatch(/^.*what failed was a sync/i);
    expect(described).toMatch(/If the budget was already open/i);
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
