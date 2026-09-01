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

import { readDataDirLock, effectiveDataDir } from './data-dir-lock.js';

/**
 * #47: two servers sharing an ACTUAL_DATA_DIR drive the budget out-of-sync, but
 * the failure says nothing about concurrency, so the natural suspects are the
 * credentials, the server, or the budget itself. If another live process holds
 * the directory, say so — that is the difference between an hour of guessing
 * and one line the user can act on.
 */
function contentionNote(): string {
  const holder = readDataDirLock(effectiveDataDir());
  if (!holder || holder.pid === process.pid) return '';
  return (
    ` Another actual-budget-mcp server (pid ${holder.pid}, started ${holder.startedAt}) ` +
    `is using the same ACTUAL_DATA_DIR (${effectiveDataDir()}). Two servers sharing it ` +
    'is what puts the budget out of sync in the first place: give each client its own ' +
    'ACTUAL_DATA_DIR, or close the other one, or the problem will come straight back.'
  );
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
function readable(error: unknown): string {
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

function haystack(error: unknown): string {
  const reason = (error as { reason?: unknown } | null)?.reason;
  return `${readable(error)} ${String(reason ?? '')}`;
}

/**
 * Turn any thrown value into a message worth showing the user. Never returns
 * an empty string.
 */
export function describeError(error: unknown): string {
  const text = haystack(error);

  // Checked before plain out-of-sync: these mean "upgrade", not "repair", and
  // the reasons Actual reports are `out-of-sync-migrations` / `out-of-sync-data`.
  if (/out-of-sync-(migrations|data)/i.test(text)) return VERSION_MISMATCH_HELP;
  if (/out-of-sync/i.test(text)) return OUT_OF_SYNC_HELP + contentionNote();

  const message = readable(error);
  return message.trim() === '' ? EMPTY_ERROR_HINT + contentionNote() : message;
}
