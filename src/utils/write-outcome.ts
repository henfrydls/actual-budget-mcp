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

/** A row as `getTransactions` returns it. */
type Row = Record<string, any>;

export interface WriteProbe {
  /**
   * Ids present across the window before the write was attempted, or null if
   * that snapshot could not be taken.
   *
   * Null means the verdict can only be "unknown": without a baseline, a row
   * that is there now might have been there all along. The write still goes
   * ahead — a check that cannot run must not stop the operation it was added
   * to describe.
   */
  before: Set<string> | null;
  /** Re-read the same window. */
  read: () => Promise<Row[] | undefined>;
  /** Whether a row looks like the one we tried to write. */
  matches: (row: Row) => boolean;
  /** The window that was searched, for the message. */
  window: string;
}

/**
 * Decide what happened, erring towards "I do not know".
 *
 * The first version of this asked one question — is there a new row on this day
 * with this amount — and answered "not saved, safe to retry" whenever it found
 * none. An audit showed that answer is wrong in two ways that both end in a
 * duplicate:
 *
 *  - Actual runs rules on every insert, and a rule can rewrite the amount or
 *    the date. The row lands; the probe does not recognise it; the caller is
 *    told it is safe to write it again. The old code already knew this could
 *    happen: it warns on stderr that the SDK may normalise a date outside the
 *    queried window.
 *  - `api.sync()` applies remote messages before failing its push, so another
 *    agent's transaction can materialise inside the window during the very
 *    operation that failed. Same amount, same day, same account is not a freak
 *    coincidence when two agents reconcile the same statement: it is the normal
 *    case.
 *
 * So a bare "no match" is no longer enough to say "not saved". Anything new and
 * unrecognised, or more than one candidate, is reported as unknown. A confident
 * wrong answer here authorises the one action that corrupts data, which makes
 * it worse than the plain error this replaced.
 */
export async function probeVerdict(probe: WriteProbe): Promise<WriteVerdict> {
  let rows: Row[] | undefined;
  try {
    rows = await probe.read();
  } catch (error) {
    // stderr, never stdout: stdout carries the MCP protocol. Logged because
    // the evidence for this whole issue came out of these logs.
    console.error(
      `[actual-budget-mcp] could not re-read after a failed write: ${describeError(error)}`,
    );
    return 'undetermined';
  }

  if (!probe.before) return 'undetermined';
  // No rows at all is not the same as an empty account: it means the read
  // answered nothing. Treating it as "nothing is there" would say "you can
  // retry" on no evidence, which is the asymmetry `before: null` already
  // guards against.
  if (rows === undefined) return 'undetermined';
  const fresh = rows.filter((row) => !probe.before!.has(row.id));
  const matching = fresh.filter((row) => probe.matches(row));

  if (matching.length === 1) return 'applied';
  // Two candidates means one of them is probably someone else's. Guessing
  // which would be the same confident wrong answer in a different direction.
  if (matching.length > 1) return 'undetermined';
  // Something landed that we do not recognise. A rule may have rewritten ours.
  if (fresh.length > 0) return 'undetermined';
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
        `${context.action} was not saved, and can be retried. Nothing new ` +
        `appeared in ${context.whereToLook} (${context.probe.window}) after the ` +
        `failure. One caveat before repeating it: Actual runs rules on every ` +
        `insert, and a rule that sets a date outside that window would hide a ` +
        `transaction that was in fact written. The error was: ${reported}${contention}`,
    };
  }

  return {
    verdict,
    message:
      `${context.action} failed, and whether it was saved could not be ` +
      `determined. Check ${context.whereToLook} (${context.probe.window}) before ` +
      `trying again: repeating a write that already landed creates a duplicate. ` +
      `The error was: ${reported}${contention}`,
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
