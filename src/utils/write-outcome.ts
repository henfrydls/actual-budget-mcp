import { describeError, contentionNote, readable, haystack } from './errors.js';

/**
 * What actually happened to a write that reported failure.
 *
 * Actual can apply a write and then fail, so `Error` does not mean "it did not
 * happen". Six occurrences were collected from two people using the server
 * daily (#79), every one a transaction already in the budget when the error
 * came back.
 */
export type WriteVerdict = 'applied' | 'not-applied' | 'undetermined' | 'duplicated';

/**
 * Errors that arrive *after* the write rather than instead of it.
 *
 * These are budget-load and sync failures: the change reached the local
 * database and the trouble came later, while saving or syncing. Ordinary
 * validation errors are refusals and are not in this set, which matters —
 * checking the budget after every failed write would be noise, and noise is
 * what makes a warning stop being read.
 *
 * `out-of-sync-migrations` and `out-of-sync-data` are excluded on purpose even
 * though they contain "out-of-sync": they mean the budget could not be loaded
 * at all, so nothing was written, and treating them as uncertain would invent
 * doubt and bury the message that actually helps (update Actual).
 */
export function mayHaveBeenApplied(error: unknown): boolean {
  // The same reader describeError uses, so the two cannot disagree about one error.
  const text = haystack(error);
  if (/out-of-sync-(migrations|data)/i.test(text)) return false;
  if (readable(error).trim() === '') return true;
  return /unknown problem opening/i.test(text) || /out-of-sync/i.test(text);
}

export interface WriteProbe {
  /** The id written with the transaction, used to find it again. */
  marker: string;
  /** Looks the row up by that id. `null` means the budget could not be read. */
  find: (marker: string) => Promise<Array<{ id: string }> | null>;
  /**
   * A second, independent look, consulted only before saying "not saved".
   *
   * That verdict is the one that authorises a retry, so it is the only one that
   * has to be right. The rest of the design has a single point of failure: if
   * the lookup goes blind it asserts absence rather than doubt, and an audit
   * found that already happening for splits.
   */
  corroborate?: () => Promise<'absent' | 'present' | 'unknown'>;
}

/**
 * Decide what happened by looking for the row this server labelled.
 *
 * No window and no snapshot: either the row with our id is there or it is not.
 * `null` means the budget could not be read, which is a third answer and not a
 * zero — "you can retry" on no evidence is the mistake this exists to stop.
 */
export async function probeVerdict(probe: WriteProbe): Promise<WriteVerdict> {
  const rows = await probe.find(probe.marker);
  if (rows === null) return 'undetermined';
  if (rows.length === 1) return 'applied';
  // Unreachable in practice, and kept because the alternative is to guess.
  // Two rows cannot share an id: Actual does not reject a colliding id, it
  // overwrites the existing row in place. So a collision would destroy a
  // transaction rather than duplicate one — invisible and unrecoverable, which
  // is worse, and the reason nothing but `randomUUID` may ever generate these.
  // If this branch is ever reached, something wrote twice and saying so beats
  // hiding it behind "could not be determined".
  if (rows.length > 1) return 'duplicated';

  // Nothing found. Before authorising a retry, ask again a different way.
  if (probe.corroborate) {
    const second = await probe.corroborate();
    if (second === 'present') return 'applied';
    if (second === 'unknown') return 'undetermined';
  }
  return 'not-applied';
}

export interface FailedWriteContext {
  /** What was attempted, capitalised for the start of a sentence. */
  action: string;
  /** Where the caller should look, in their own terms. */
  whereToLook: string;
  probe: WriteProbe;
}

export interface FailedWriteReport {
  verdict: WriteVerdict;
  message: string;
}

/**
 * Turn a failed write into a statement about what is true, or an honest
 * admission that it is not known.
 *
 * The caution this replaces (#71) said the write *might* have been applied, on
 * every failure. A hedge printed every time is read as boilerplate and then
 * ignored, and it left the caller to do the checking themselves.
 */
export async function verifyFailedWrite(
  error: unknown,
  context: FailedWriteContext,
): Promise<FailedWriteReport> {
  const verdict = await probeVerdict(context.probe);

  // Without the caution: a definite answer that also hedges contradicts itself.
  const reported = describeError(error, {
    omitUncertainWriteCaution: true,
    omitContentionNote: true,
  });
  // #79 asks that contention be named where it is the cause, so the message can
  // distinguish "another process has the file" from "the file is broken".
  const contention = contentionNote();

  if (verdict === 'applied') {
    return {
      verdict,
      message:
        `${context.action} was saved, and then Actual reported an error while ` +
        `finishing up. Do not repeat it: the change is already in your budget ` +
        `(${context.whereToLook}). The error was: ${reported}${contention}`,
    };
  }

  if (verdict === 'not-applied') {
    return {
      verdict,
      message:
        `${context.action} was not saved, and can be retried. It is not in ` +
        `${context.whereToLook}, or anywhere else: this server labels what it ` +
        `writes and no transaction carries that label. The error was: ` +
        `${reported}${contention}`,
    };
  }

  if (verdict === 'duplicated') {
    return {
      verdict,
      message:
        `${context.action} was saved more than once. Do not repeat it: there is ` +
        `already a duplicate in ${context.whereToLook} to remove. Saying the ` +
        `outcome was unknown here would hide something that is known and needs ` +
        `acting on. The error was: ${reported}${contention}`,
    };
  }

  return {
    verdict,
    message:
      `${context.action} failed, and whether it was saved could not be ` +
      `determined: the budget could not be read back. Check ${context.whereToLook} ` +
      `before trying again, because repeating a write that already landed creates ` +
      `a duplicate. The error was: ${reported}${contention}`,
  };
}

/**
 * A failure that already knows what happened to the write.
 *
 * Carries the verdict so the tool can decide how to report it. A write that was
 * saved must not come back as `isError: true` under a line starting "Error:":
 * an agent reading that has every reason to try again, which is the one action
 * that duplicates. The operation did fail, but the caller's intent succeeded,
 * and the reply has to say the second thing louder than the first.
 */
export class WriteReportedError extends Error {
  readonly verdict: WriteVerdict;

  constructor(message: string, verdict: WriteVerdict) {
    super(message);
    this.name = 'WriteReportedError';
    this.verdict = verdict;
  }
}
