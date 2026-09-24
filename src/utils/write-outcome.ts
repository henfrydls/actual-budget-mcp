import { describeError } from './errors.js';

/**
 * What actually happened to a write that reported failure.
 *
 * Actual can apply a write and then fail, so `Error` does not mean "it did not
 * happen". Six occurrences were collected from two people using the server
 * daily (#79), every one of them a transaction that was already in the budget
 * when the error came back.
 */
export type WriteVerdict = 'applied' | 'not-applied' | 'undetermined';

/**
 * Errors that arrive *after* the write rather than instead of it.
 *
 * These are budget-load and sync failures: the change reached the local
 * database and the trouble came later, while saving or syncing. Ordinary
 * validation errors ("category does not exist") are refusals and are not in
 * this set, which matters — checking the budget after every failed write would
 * be noise, and noise is what makes a warning stop being read.
 */
export function mayHaveBeenApplied(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (message.trim() === '') return true; // Actual's empty error, thrown mid-sync
  return (
    /unknown problem opening/i.test(message) ||
    /out-of-sync/i.test(message) ||
    /problem opening .*budget/i.test(message)
  );
}

export interface FailedWriteContext {
  /** What was attempted, capitalised for the start of a sentence. */
  action: string;
  /** Re-reads the budget and answers whether the change is there. */
  probe: () => Promise<boolean>;
  /** Where the caller should look, in their own terms. */
  whereToLook: string;
}

/**
 * Turn a failed write into a statement about what is true.
 *
 * The previous behaviour was to warn that the write *might* have been applied
 * (#71). That was a hedge, and a hedge printed on every failure is read as
 * boilerplate and then ignored. This checks instead, so the answer is one of
 * three specific things rather than a caution attached to all of them.
 *
 * The check can itself fail — the error that broke the write often breaks the
 * next read too — and that case is reported as its own outcome rather than
 * collapsed into either certainty.
 */
export async function verifyFailedWrite(
  error: unknown,
  context: FailedWriteContext,
): Promise<{ verdict: WriteVerdict; message: string }> {
  let verdict: WriteVerdict = 'undetermined';
  try {
    verdict = (await context.probe()) ? 'applied' : 'not-applied';
  } catch {
    // The budget could not be re-read. Undetermined is the honest answer, and
    // it is the one case where the caller genuinely has to go and look.
    verdict = 'undetermined';
  }

  // Without the caution: we just checked, so hedging beside a definite answer
  // would contradict it.
  const reported = describeError(error, { omitUncertainWriteCaution: true });

  if (verdict === 'applied') {
    return {
      verdict,
      message:
        `${context.action} was saved, and then Actual reported an error while ` +
        `finishing up. Do not repeat it: the change is already in your budget ` +
        `(${context.whereToLook}). The error was: ${reported}`,
    };
  }

  if (verdict === 'not-applied') {
    return {
      verdict,
      message:
        `${context.action} was not saved, and can be retried safely. ` +
        `Checked ${context.whereToLook} after the failure and it is not there. ` +
        `The error was: ${reported}`,
    };
  }

  return {
    verdict,
    message:
      `${context.action} failed, and the budget could not be re-read afterwards, ` +
      `so whether it was saved is unknown. Check ${context.whereToLook} before ` +
      `trying again: repeating a write that already landed creates a duplicate. ` +
      `The error was: ${reported}`,
  };
}
