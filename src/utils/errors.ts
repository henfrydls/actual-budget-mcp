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
import { readEnv } from './env.js';
import { withoutCredentials } from './redact.js';

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
 * The one cause of this failure that is nothing to do with the server (#240).
 *
 * The desktop app runs its own sync server on 127.0.0.1:5007, and only while
 * the app is open. Close the app mid-session and every call fails exactly
 * like a server that is down, so the reader of this message is sent to check
 * a self-hosted server they do not have. The field report that opened the
 * issue is hours spent doing that.
 *
 * It is a clause rather than its own message because the same text serves
 * everyone, and it is behind the address so the person with a self-hosted
 * server never reads it: both halves of #206's lesson about the most-read
 * failure text in this server.
 *
 * The tell comes with it. Both causes fail the same way, and what separates
 * them is that `repair_sync` fails too when the app is closed, because it
 * probes the server before repairing anything. That is in the README, where
 * nobody is while they are reading this.
 *
 * `connection.ts` names the same port for the same reason, and the two do not
 * share a sentence on purpose: that one is about a server that never answered
 * at startup and offers the other port as the likely mistake, this one is
 * about a session that was working a moment ago.
 *
 * `repair_sync` turns it off, through `omitDesktopAppNote`: it has already
 * asked the server whether it is there.
 */
function desktopAppClause(options: DescribeErrorOptions): string {
  if (options.omitDesktopAppNote === true) return '';
  const configured = readEnv('ACTUAL_SERVER_URL');
  if (configured === undefined) return '';
  let url: URL;
  try {
    url = new URL(configured.trim());
  } catch {
    return '';
  }
  const ownMachine = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!ownMachine || url.port !== '5007') return '';
  return (
    'On this address that usually means the Actual desktop app is closed: it runs its ' +
    'own server on 5007, and only while the app is open. If repair_sync answers that ' +
    'nothing is listening, that is this rather than a sync problem. '
  );
}

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
 *
 * The likely cause goes first (#206). It used to open by explaining Actual's
 * wording and reach "the server not answering" in the third clause, so the
 * one actionable sentence was the one nobody read to. Seen in the live test
 * of 0.10.7 with the server stopped: a `create_payee` that had worked
 * answered with a paragraph of hedging about a message, for a failure that
 * is almost always a server that is not there.
 *
 * Two cases reach it, and the difference is worth a clause. With no code it
 * is a guess, a good one. With `timeout` or `network-failure` the connection
 * is what Actual itself is naming, and saying "it arrived with no code of its
 * own" there was simply false.
 */
function unknownOpenHelp(reason: string, options: DescribeErrorOptions): string {
  const sure =
    reason === ''
      ? 'That is what this almost always is. '
      : `The code it came with, "${reason}", is about the connection too. `;
  const noCode =
    reason === ''
      ? ', and it arrived with no code of its own'
      : '';
  return (
    'The Actual server did not answer: check that it is running and reachable. ' +
    sure +
    desktopAppClause(options) +
    'Actual reports it as a problem opening the budget, which is the message it falls ' +
    `back on for anything it has no specific case for${noCode}. If the budget was ` +
    'already open, nothing was being opened and this came from a sync.'
  );
}

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
    'The budget itself is open and undamaged, and the local copy is intact. With a ' +
    'password configured this server signs in again by itself and retries, at most ' +
    'twice an hour, so seeing this means that was tried and did not work, or that it ' +
    'has been tried too recently. If it is configured with ACTUAL_SESSION_TOKEN rather ' +
    'than a password, there is nothing to sign in with: generate a new token and ' +
    'restart with that.',
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
  /**
   * Leave out the clause about the desktop app being closed (#240).
   *
   * Set by `repair_sync`, which probes the server before it repairs
   * anything and refuses when nothing is listening. By the time it is
   * describing a failure of its own, the server has answered, so "the app
   * is probably closed, and repair_sync saying nothing is listening is how
   * you tell" contradicts the step the reader has just watched succeed.
   */
  omitDesktopAppNote?: boolean;
}

/**
 * Mark a message that is already a finished explanation.
 *
 * A tool that builds its own sentence around `describeError` and then throws
 * it hands that message to whatever catches it, which describes it again.
 * Measured on `repair_sync`: the inner text ended with Actual's own
 * "unknown problem opening", the outer pass matched on that, and the reply
 * opened by telling the reader to check that a server which had just answered
 * was running, with the write caution printed twice underneath.
 *
 * A symbol rather than a field: nothing serialises it by accident, and it
 * cannot collide with a property Actual puts on its own errors.
 */
const DESCRIBED = Symbol.for('actual-mcp.described');

export function alreadyDescribed(message: string): Error {
  return Object.assign(new Error(message), { [DESCRIBED]: true });
}

/**
 * Whether two servers on one budget could be what produced this failure.
 *
 * One criterion, named once, because three places answer it: `describeError`,
 * `verifyFailedWrite`, which builds its own message around the note, and
 * anything added later. Deciding it per caller is what left the note attached
 * to failures it has nothing to do with (#206): a read whose figures were
 * stale, a tool that failed with the server stopped, a sign-in that did not
 * work.
 *
 * Sharing a cache produces two things and not the rest of the list: Actual
 * reports the budget as out-of-sync, or it throws the empty error of #40
 * mid-sync. A version mismatch says out-of-sync too and is not this: it means
 * the library and the file disagree, which one server alone does just as
 * well. A server that did not answer, a session that expired, a key that
 * cannot decrypt and a local copy that will not open are not things another
 * server on this budget does.
 */
export function contentionExplains(error: unknown): boolean {
  const text = haystack(error);
  if (/out-of-sync-(migrations|data)/i.test(text)) return false;
  if (/out-of-sync/i.test(text)) return true;
  if (/unknown problem opening/i.test(text)) return false;
  return readable(error).trim() === '';
}

/**
 * The text of a failure, with no credential left in it (#275).
 *
 * Here rather than in each branch below: one place, whatever the branch
 * decided to say.
 *
 * On the way out rather than on the error object, which is caution and not
 * a demonstrated hazard: `mayHaveBeenApplied` recognises a mid-write
 * failure by a string on that object, and nothing good comes of rewriting
 * an object other code reads. The strings it matches hold no address, so
 * redacting one would not break it today.
 */
export function describeError(error: unknown, options: DescribeErrorOptions = {}): string {
  return withoutCredentials(describeFailure(error, options));
}

function describeFailure(error: unknown, options: DescribeErrorOptions): string {
  if (typeof error === 'object' && error !== null && (error as Record<symbol, unknown>)[DESCRIBED]) {
    return readable(error);
  }

  const text = haystack(error);
  const caution = options.omitUncertainWriteCaution ? '' : MAY_ALREADY_BE_APPLIED;
  // Only where contention is a cause of **this** failure (#206). It used to
  // be appended to every description, and each caller that did not want it
  // had to remember to say so; three did not.
  const contention =
    options.omitContentionNote || !contentionExplains(error) ? '' : contentionNote();

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
      return unknownOpenHelp(reason, options) + quoting(error) + caution + contention;
    }
    const known = CODE_HELP[reason];
    // An expired session is the one code whose explanation contradicts the
    // sentence in front of it: "a problem opening" and then "the budget
    // itself is open". Actual's own words are kept, by `quoting`, where they
    // read as the detail they are rather than as the verdict. The other codes
    // leave them in front, because in front of those they are accurate.
    if (reason === 'token-expired') {
      return (known ?? '').trim() + quoting(error) + caution + contention;
    }
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
