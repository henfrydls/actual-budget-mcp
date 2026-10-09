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
 * Actual's generic failure, which names the one thing that may not have happened.
 *
 * `getSyncError` in the bundle returns `We had an unknown problem opening
 * "<id>"` for **any** reason it has no case for, and three places emit it:
 * `api/load-budget`, `api/download-budget` on the cached branch, and
 * `api/sync`. So the sentence says "opening" whatever went wrong, and opening
 * really is one of the possibilities.
 *
 * What tells them apart is the code. `withErrorCode` leaves the reason on
 * `error.code`, so `decrypt-failure`, `unauthorized`, `opening-budget` and the
 * rest arrive with a name attached, and only an error with **no** code, or a
 * network or timeout one, is the case this text is about. An earlier version
 * of this said "nothing was being opened: the budget was already loaded" for
 * all of them, which told someone with a wrong encryption key that their
 * password was fine and sent them to restart a server that was answering.
 *
 * The translation lives here, in the layer that turns an error into words.
 * `mayHaveBeenApplied` in write-outcome.ts recognises this failure by that same
 * string on the **error object**, and uses it to decide whether a write might
 * have landed. Rewriting the object would take that away and the answer would
 * silently become "not applied", which is the one verdict that authorises a
 * retry.
 */
const UNKNOWN_OPEN_HELP =
  'Actual reported a generic failure that names opening the budget, which it uses ' +
  'for anything it has no specific case for. It carries no code, so the most ' +
  'likely cause is the Actual server not answering: check that it is running and ' +
  'reachable. If the budget was already open, nothing was being opened and this ' +
  'came from a sync.';

/** What a named reason means, where knowing it changes what to do. */
const CODE_HELP: Record<string, string> = {
  'decrypt-failure':
    ' Actual could not decrypt the budget: the encryption password is wrong, or the ' +
    'key was changed on another device. Nothing is wrong with the server.',
  unauthorized:
    ' The server refused the credentials. A session token may have expired, or the ' +
    'password may have changed.',
  // Its own case rather than a shade of `unauthorized`, because what to do
  // about it is different and the sentence it arrives wearing is misleading:
  // the budget did open, and the reader is being told about a problem opening
  // it. Measured by deleting the server's sessions while a server was running,
  // which is the always-on case this matters for.
  'token-expired':
    ' The session with the Actual server expired, which is why the sync was refused. ' +
    'The budget itself is open and undamaged, and the local copy is intact. This ' +
    'server does not sign in again on its own, so every attempt from here will fail ' +
    'the same way: restart it to sign in again. If it is configured with ' +
    'ACTUAL_SESSION_TOKEN rather than a password, there is nothing to sign in with, ' +
    'so generate a new token first and restart with that.',
  'opening-budget':
    ' Actual could not open the local copy, which usually means the cached file is ' +
    'damaged. Deleting the budget folder in ACTUAL_DATA_DIR downloads it again.',
  'loading-budget':
    ' Actual downloaded the budget but could not finish loading it. Deleting the ' +
    'budget folder in ACTUAL_DATA_DIR downloads it again.',
  'invalid-schema':
    ' The budget schema is not one this version of Actual understands, which is a ' +
    'version mismatch rather than a connection problem.',
  internal: ' Actual reported an internal failure and gave no further detail.',
};

/** Codes that mean "nothing answered", which is what the generic text assumes. */
const NETWORK_CODES = new Set(['network-failure', 'timeout', 'ETIMEDOUT', 'ECONNREFUSED']);

function reasonOf(error: unknown): string {
  const tagged = error as { code?: unknown; reason?: unknown } | null | undefined;
  return String(tagged?.code ?? tagged?.reason ?? '');
}

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
    const reason = reasonOf(error);
    // Only an error with no code, or a network one, is the case the generic
    // text describes. With a named reason, say what that reason means and
    // leave Actual's sentence as the detail instead of contradicting it.
    if (reason === '' || NETWORK_CODES.has(reason)) {
      return UNKNOWN_OPEN_HELP + quoting(error) + caution + contention;
    }
    const known = CODE_HELP[reason];
    return (
      `Actual reported: ${readable(error)}` +
      (known ?? ` The reason it gave is "${reason}".`) +
      caution +
      contention
    );
  }

  const message = readable(error);
  return message.trim() === ''
    ? EMPTY_ERROR_HINT + caution + contention
    : message;
}
