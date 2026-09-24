import { describeError, contentionNote, readable } from './errors.js';

/**
 * What actually happened to a write that reported failure.
 *
 * Actual can apply a write and then fail, so `Error` does not mean "it did not
 * happen". Six occurrences were collected from two people using the server
 * daily (#79), every one a transaction already in the budget when the error
 * came back.
 */
export type WriteVerdict = 'applied' | 'not-applied' | 'undetermined';

/** Everything this module reads off an error, in one place. */
function errorText(error: unknown): string {
  // readable() is what describeError uses. Keeping a second reader here made
  // the two disagree about the same error, and turned `{message: '...'}` into
  // "[object Object]".
  const parts: string[] = [readable(error)];
  const tagged = error as { reason?: unknown; code?: unknown } | null | undefined;
  if (tagged?.reason) parts.push(String(tagged.reason));
  // `withErrorCode` writes `code`; missing it is what let the SDK's own wording
  // reach users once already.
  if (tagged?.code) parts.push(String(tagged.code));
  return parts.join(' ');
}

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
  const text = errorText(error);
  if (/out-of-sync-(migrations|data)/i.test(text)) return false;
  if (readable(error).trim() === '') return true;
  return /unknown problem opening/i.test(text) || /out-of-sync/i.test(text);
}

export interface WriteProbe {
  /** The label written with the transaction, used to find it again. */
  marker: string;
  /** Where the caller should look, in their own terms. */
  find: (marker: string) => Promise<Array<{ id: string }> | null>;
}

/**
 * Decide what happened by looking for the row this server labelled.
 *
 * There is no window and no snapshot: either the row carrying our marker is
 * there or it is not. `null` means the budget could not be read, which is a
 * third answer and not a zero — "you can retry" on no evidence is the mistake
 * this whole change exists to stop making.
 *
 * More than one row with the same marker should be impossible, since the marker
 * is generated per write. If it ever happens, something wrote twice and saying
 * so is more useful than picking one.
 */
export async function probeVerdict(probe: WriteProbe): Promise<WriteVerdict> {
  const rows = await probe.find(probe.marker);
  if (rows === null) return 'undetermined';
  if (rows.length === 1) return 'applied';
  if (rows.length > 1) return 'undetermined';
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
