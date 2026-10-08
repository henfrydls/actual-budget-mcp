/**
 * Error message helpers.
 *
 * #40: `@actual-app/api` throws `new Error('')` for some failures — notably a
 * budget whose sync state is out-of-sync, where `getSyncError()` falls through
 * to an i18next instance the API bundle never initialises, so the message comes
 * out empty and no `reason` is attached. Rendering that verbatim produced a bare
 * "Error:" in the client while the real cause only appeared on stderr, which MCP
 * users never see. Every tool routes its catch block through here, so a blank
 * message can never reach the client — and because a blank message from Actual
 * is in practice a sync/load failure, that is the case the fallback speaks to.
 */

import { readDataDirLock, activeDataDir, effectiveDataDir } from './data-dir-lock.js';

/**
 * #47: two servers sharing an ACTUAL_DATA_DIR drive the budget out-of-sync, but
 * the failure says nothing about concurrency, so the natural suspects are the
 * credentials, the server, or the budget itself. If another live process holds
 * the directory, say so — that is the difference between an hour of guessing
 * and one line the user can act on.
 */
/**
 * Name the other process when one is sharing this server's cache.
 *
 * Reads the directory actually in use, not the configured one: since #71 they
 * differ whenever this server stepped aside, and naming a directory it is not
 * touching would be worse than saying nothing.
 *
 * Exported so a write that failed can distinguish "another process has the
 * file" from "the file is broken", which #79 asks for and which the two people
 * who reported it both guessed at without being able to confirm.
 */
export function contentionNote(): string {
  const inUse = activeDataDir();
  const configured = effectiveDataDir();

  const sharing = readDataDirLock(inUse);
  if (sharing && sharing.pid !== process.pid) {
    return (
      ` Another actual-budget-mcp server (pid ${sharing.pid}, started ${sharing.startedAt}) ` +
      `is using the same ACTUAL_DATA_DIR (${inUse}). Two servers sharing it ` +
      'is what puts the budget out of sync in the first place: give each client its own ' +
      'ACTUAL_DATA_DIR, or close the other one, or the problem will come straight back.'
    );
  }

  // Since #71 this server steps aside when the configured directory is taken,
  // so it holds its own lock and the check above finds only itself. Reporting
  // nothing then was a regression: another server is still running against the
  // same budget, which is the thing worth knowing. It just is not sharing this
  // cache, so it gets its own wording rather than the one about sharing.
  if (inUse !== configured) {
    const neighbour = readDataDirLock(configured);
    if (neighbour && neighbour.pid !== process.pid) {
      return (
        ` Another actual-budget-mcp server (pid ${neighbour.pid}, started ${neighbour.startedAt}) ` +
        `is running against the same budget from ${configured}; this one stepped aside to ` +
        `${inUse}. They do not share a cache, so neither can corrupt the other's, but both ` +
        'are writing to the same Actual server.'
      );
    }
  }

  return '';
}

const REPAIR_HINT =
  'Run the `repair_sync` tool to rebuild the sync state (non-destructive), or ' +
  "repair it in the Actual app under Settings > Show advanced settings. Note that " +
  'deleting the local ACTUAL_DATA_DIR does not help: the inconsistency lives in ' +
  'the sync state, not in the local cache.';

const EMPTY_ERROR_HINT =
  'Actual Budget threw an error with no message. This is almost always a sync or ' +
  `budget-load failure. ${REPAIR_HINT} ` +
  'The underlying reason is logged on stderr (check the server logs).';

const OUT_OF_SYNC_HELP =
  "The budget's sync state is out of sync with the Actual server, so no operation " +
  `can run until it is repaired. ${REPAIR_HINT}`;

/**
 * The part of an out-of-sync failure that costs money if it is left unsaid.
 *
 * These failures land mid-write, and the write has often already been applied
 * locally before the error comes back (#71: two crashes on 10 and 11 September,
 * both mid-write, both with the transaction already in the budget). An error
 * reads as "it did not happen", so the natural response is to do it again, and
 * doing it again duplicates a transaction that was already there. Both times it
 * had to be checked by hand.
 *
 * So the error says what it cannot rule out. Verifying once is cheap; finding a
 * duplicate a month later, during a reconciliation that no longer balances, is
 * not.
 */
const MAY_ALREADY_BE_APPLIED =
  ' If this happened during a write, check the budget before retrying: a change ' +
  'can be applied and still report an error, and repeating it would duplicate it.';

/**
 * Actual's generic failure, which names the one thing that did not happen.
 *
 * `We had an unknown problem opening "<id>"` is the engine's fallback when it
 * has no more specific case, and it comes back from a **sync** in the middle of
 * a write as readily as from opening anything. Measured: with the budget
 * already loaded and the server replaced by a socket that accepts and never
 * answers, a write ends with exactly that. The reader is sent to look at their
 * budget file, their sync id and their credentials, none of which are the
 * problem.
 *
 * It does not claim the server is the cause, because the message is generic and
 * the engine does not say. What it can state is what did not happen -- nothing
 * was being opened -- and what to check first.
 *
 * The translation lives here, in the layer that turns an error into words.
 * `mayHaveBeenApplied` in write-outcome.ts recognises this failure by that same
 * string on the **error object**, and uses it to decide whether a write might
 * have landed. Rewriting the object would take that away and the answer would
 * silently become "not applied", which is the one verdict that authorises a
 * retry.
 */
const UNKNOWN_OPEN_HELP =
  'Actual reported a generic failure that mentions opening the budget, but nothing ' +
  'was being opened: the budget was already loaded and what failed was a sync. The ' +
  'usual cause is the Actual server not answering, so check that it is running and ' +
  'reachable. Nothing is wrong with your budget file, sync id or password.';

/**
 * The engine's own words, kept after the explanation rather than replaced by it.
 *
 * Two tests already insisted on this and they were right: the summary must not
 * hide what Actual said. Someone searching for that string, or pasting it into
 * an issue, needs it to still be there. What changes is that it is no longer
 * the *only* thing said, and no longer the first.
 */
function quoting(error: unknown): string {
  const original = readable(error).trim();
  return original === '' ? '' : ` Actual's own words: ${original}`;
}

const VERSION_MISMATCH_HELP =
  'This budget cannot be loaded by this version of Actual: its data or migrations ' +
  'are newer or older than the API supports. Update the Actual app and the ' +
  '@actual-app/api dependency to matching versions. Repairing the sync state will ' +
  'not fix a version mismatch.';

/**
 * Best-effort readable text for anything that can be thrown.
 *
 * `String(value)` on a plain object yields "[object Object]", which hides the
 * failure as effectively as an empty message — and Actual does throw plain
 * objects. So prefer an explicit `message`, then fall back to serialising the
 * object.
 */
export function readable(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error === null || error === undefined) return '';
  if (typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') return message;
    try {
      const json = JSON.stringify(error);
      // JSON.stringify returns undefined for e.g. a lone function.
      if (json && json !== '{}') return json;
    } catch {
      /* circular or otherwise unserialisable — fall through */
    }
    return '';
  }
  return String(error);
}

/**
 * Everything worth reading off a thrown value, in one place.
 *
 * `withErrorCode` writes `code` and `FileDownloadError` writes `reason`, so both
 * have to be read. Missing `code` is what let the SDK's own wording reach users
 * once already, and a second reader elsewhere that disagreed with this one made
 * two parts of the server classify the same error differently.
 */
export function haystack(error: unknown): string {
  const tagged = error as { reason?: unknown; code?: unknown } | null;
  return [readable(error), tagged?.reason, tagged?.code]
    .filter((part) => part !== undefined && part !== null && part !== '')
    .map(String)
    .join(' ');
}

/**
 * Turn any thrown value into a message worth showing the user. Never returns
 * an empty string.
 */
export interface DescribeErrorOptions {
  /**
   * Leave out the contention note.
   *
   * Set by a caller that adds it itself, so the paragraph does not appear
   * twice in the same message.
   */
  omitContentionNote?: boolean;
  /**
   * Leave out the "this may already have been applied" caution.
   *
   * Set by a caller that has gone and checked. The caution exists for tools
   * that cannot tell; repeating it next to a definite answer would contradict
   * it, and a message that hedges its own conclusion teaches the reader to
   * ignore both halves.
   */
  omitUncertainWriteCaution?: boolean;
}

export function describeError(error: unknown, options: DescribeErrorOptions = {}): string {
  const text = haystack(error);
  const caution = options.omitUncertainWriteCaution ? '' : MAY_ALREADY_BE_APPLIED;
  const contention = options.omitContentionNote ? '' : contentionNote();

  // Checked before plain out-of-sync: these mean "upgrade", not "repair", and
  // the reasons Actual reports are `out-of-sync-migrations` / `out-of-sync-data`.
  if (/out-of-sync-(migrations|data)/i.test(text)) return VERSION_MISMATCH_HELP;
  if (/out-of-sync/i.test(text)) return OUT_OF_SYNC_HELP + caution + contention;

  // After the out-of-sync cases, which are more specific, and before falling
  // through to the engine's own words.
  if (/unknown problem opening/i.test(text)) {
    return UNKNOWN_OPEN_HELP + quoting(error) + caution + contention;
  }

  const message = readable(error);
  return message.trim() === ''
    ? EMPTY_ERROR_HINT + caution + contention
    : message;
}
