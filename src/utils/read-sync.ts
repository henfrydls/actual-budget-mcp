import { ensureConnection } from '../connection.js';
import { describeError } from './errors.js';
import { lastFailedSync, lastGoodSync, markFailedSync, resetSyncClock, syncNow } from './sync-clock.js';

/**
 * Pull the server's changes before a read, so a long-lived server stops
 * answering from a copy that is behind (#126).
 *
 * The case: two transactions recategorised in the Actual app were not seen by
 * a reading process, which reported the old figures three times before a bank
 * sync happened to move it. Nothing said the copy was stale. A user running
 * this as an always-on chat bot hit the same thing and worked around it with a
 * `node --import` preload that wraps every handler; this is that, supported.
 *
 * What makes it affordable to do on every read:
 *
 *   a TTL          a sync per read would be a network round trip per read.
 *                  Within 60 seconds the copy is treated as current, which is
 *                  what Actual's own CLI does.
 *   one in flight  concurrent reads wait on the same promise rather than
 *                  starting a sync each.
 *   a deadline     a server that accepts and never answers would otherwise
 *                  hold a read for the full HTTP timeout. After 20 seconds the
 *                  read goes ahead with what is on disk.
 *   a pause        and then it stops trying for a while. Without this, a
 *                  server that is down charged the full 20 seconds to every
 *                  read, for as long as it stayed down: measured with SIGSTOP,
 *                  four reads in a row at 20.0 s each where they had been
 *                  instant.
 *   saying so      when the sync did not happen, the reply says how old the
 *                  figures are and why it could not refresh them. Without
 *                  that, a server that is down goes back to answering with
 *                  stale data in silence, which is the thing the issue is
 *                  named after.
 */

/** How long a copy is treated as current. Actual's own CLI uses the same. */
export const SYNC_TTL_MS = 60_000;

/** How long a read will wait for a sync before going ahead without it. */
export const SYNC_WAIT_MS = 20_000;

/**
 * How long to leave a failing server alone.
 *
 * The same minute as the TTL, and for the same reason: a read is willing to be
 * a minute behind. If the copy can be a minute old when the sync works, it can
 * be a minute old when it does not, and the alternative is paying the deadline
 * again on the next read.
 */
export const SYNC_RETRY_MS = SYNC_TTL_MS;

/** The sync currently running, shared by everything waiting on it. */
let inFlight: Promise<boolean> | undefined;

/** For tests: forget everything, as if the process had just started. */
export function resetSyncState(): void {
  inFlight = undefined;
  resetSyncClock();
}

export interface FreshnessReport {
  /** True when the local copy is current: just synced, or synced recently. */
  current: boolean;
  /** When the last successful sync was, if there has ever been one. */
  lastGoodSync?: number;
  /** What went wrong, when something did, so the notice can say. */
  failure?: unknown;
}

/**
 * Bring the local copy up to date if it is older than the TTL.
 *
 * Never throws. A read that cannot sync is still a read; what it must not do
 * is pretend the figures are current.
 */
export async function refreshBeforeRead(now?: number): Promise<FreshnessReport> {
  // Before anything else, and this is not a formality. `server.connect()`
  // happens before the startup `ensureConnection()`, so a client that asks
  // something immediately arrives while the budget is still being downloaded
  // and loaded. Syncing into that was measured doing real damage to the
  // attempt: seventeen `Cannot destructure property 'id' of 'getPrefs(...)'`,
  // a `TypeError` reading 'timestamp' inside `_fullSync` before the clock was
  // loaded, and one sync that "succeeded" halfway through a load. Waiting here
  // costs nothing, because the handler is about to await the same call.
  //
  // It also answers "is a budget open at all": `ensureConnection` only returns
  // once one is, and throws otherwise, so there is no separate check to keep
  // in step with it.
  try {
    await ensureConnection();
  } catch (error) {
    // Not recorded as a sync failure: nothing was synced, and the handler is
    // about to call this same function and report the real problem. All this
    // read owes the caller is not to claim the figures are fresh.
    return { current: false, lastGoodSync: lastGoodSync(), failure: error };
  }

  // Read after the wait above, not before it: loading a budget can take a
  // while, and a clock from before it would measure the TTL from the wrong
  // moment.
  const at = now ?? Date.now();

  const good = lastGoodSync();
  if (good !== undefined && at - good < SYNC_TTL_MS) {
    return { current: true, lastGoodSync: good };
  }

  // A server that is down, left alone for a while. Checked before joining a
  // sync already in flight, because the flight is exactly the problem: a
  // stopped server holds one open until the HTTP deadline, and every read that
  // joined it paid the full wait.
  const failed = lastFailedSync();
  if (failed !== undefined && at - failed.at < SYNC_RETRY_MS) {
    return { current: false, lastGoodSync: good, failure: failed.error };
  }

  // One sync for everyone waiting. Without this, ten concurrent reads on a
  // cold cache start ten syncs, which is the shape that makes a per-read sync
  // expensive in the first place.
  if (!inFlight) {
    inFlight = (async () => {
      try {
        await syncNow();
        return true;
      } catch (error) {
        // stdout carries JSON-RPC. `syncNow` has already recorded it.
        console.error(
          `[actual-budget-mcp] could not sync before reading: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return false;
      } finally {
        inFlight = undefined;
      }
    })();
  }

  // The wait is capped, not the sync: the sync carries on and whoever reads
  // next gets the benefit. What is capped is how long this read is held up.
  const timed = await Promise.race([
    inFlight,
    new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), SYNC_WAIT_MS);
      // Not left holding the event loop open once the sync wins the race.
      timer.unref?.();
    }),
  ]);

  if (timed === 'timeout') {
    // A sync still running after the deadline counts as trouble, which is what
    // starts the pause. If it does finish, successfully, `markGoodSync` clears
    // this again, so a merely slow server costs one slow read and not a
    // minute of notices.
    markFailedSync(
      new Error(`the Actual server did not answer within ${SYNC_WAIT_MS / 1000} seconds`),
    );
  }

  return {
    current: timed === true,
    lastGoodSync: lastGoodSync(),
    failure: timed === true ? undefined : lastFailedSync()?.error,
  };
}

/**
 * What to tell the reader when the figures could not be refreshed.
 *
 * Two things, because they answer different questions. How old the figures are
 * comes from the recorded timestamp, since a timeout, an error and a server
 * that is down all leave the reader asking the same thing. Why it could not
 * refresh comes from the error, because they do not: `out-of-sync` needs
 * `repair_sync` run, `unauthorized` needs the credentials looked at and
 * `decrypt-failure` needs the encryption key, and "could not refresh" on its
 * own sounds like a passing network blip in all three.
 */
export function stalenessNotice(report: FreshnessReport, now = Date.now()): string | undefined {
  if (report.current) return undefined;

  const age =
    report.lastGoodSync === undefined
      ? 'Could not refresh from the Actual server, and this process has not synced since it ' +
        'started, so these figures are from the copy it downloaded then. Anything changed in ' +
        'the Actual app since may be missing.'
      : (() => {
          const minutes = Math.max(1, Math.round((now - report.lastGoodSync!) / 60_000));
          return (
            `Could not refresh from the Actual server; these figures are from the last sync, ` +
            `${minutes} minute${minutes === 1 ? '' : 's'} ago. Anything changed in the Actual ` +
            `app since then may be missing.`
          );
        })();

  if (report.failure === undefined) return age;

  // The same wording the tools use for the same errors (#152), so a reader who
  // has seen one recognises the other. The write caution is left out: nothing
  // was being written here.
  const reason = describeError(report.failure, { omitUncertainWriteCaution: true }).trim();
  return reason === '' ? age : `${age} Reason: ${reason}`;
}

/** The part of `McpServer` this needs: somewhere to register a tool. */
export interface McpServerLike {
  tool: (...args: never[]) => unknown;
  resource?: (...args: never[]) => unknown;
}

/**
 * Wrap the read tools and the resources so each one pulls the server's changes
 * first (#126).
 *
 * At the points where registration happens rather than in fifteen files,
 * because those are the places every tool and every resource goes through and
 * a tool added later should not have to remember. It is also where the user
 * who hit this put their own workaround, by patching `McpServer.prototype.tool`;
 * doing it on the way in is the same idea without the monkey patch.
 *
 * Only the read tools. The write tools already pull where it matters, before
 * the checks that decide whether to write, and syncing again on the way in
 * would be a second round trip for the same answer.
 *
 * `readOnlyHint` is what marks them, which is the same flag read-only mode
 * uses, so the two cannot drift apart. Resources have no such flag and need
 * none: a resource is a read by definition, and `actual://accounts` went stale
 * exactly the way the tools did.
 */
export function withReadSync<T extends McpServerLike>(server: T): T {
  const wrapped = Object.create(server) as T;

  const originalTool = server.tool.bind(server) as (...args: unknown[]) => unknown;
  (wrapped as { tool: unknown }).tool = (...args: unknown[]) => {
    const annotations = args.find(
      (a): a is { readOnlyHint?: boolean } =>
        typeof a === 'object' && a !== null && 'readOnlyHint' in a,
    );
    if (annotations?.readOnlyHint !== true) return originalTool(...args);

    const handler = args[args.length - 1] as (
      ...handlerArgs: unknown[]
    ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

    const wrappedHandler = async (...handlerArgs: unknown[]) => {
      const report = await refreshBeforeRead();
      const result = await handler(...handlerArgs);
      const notice = stalenessNotice(report);
      // An error already says something went wrong; two problems in one reply
      // send the reader looking for two fixes.
      if (!notice || result.isError) return result;

      // Appended, not prepended: the answer is what was asked for, and the
      // caveat belongs with it rather than in front of it.
      const content = [...result.content];
      const last = content[content.length - 1];
      if (last && last.type === 'text') {
        content[content.length - 1] = { ...last, text: `${last.text}\n\n${notice}` };
      } else {
        content.push({ type: 'text', text: notice });
      }
      return { ...result, content };
    };

    return originalTool(...args.slice(0, -1), wrappedHandler);
  };

  const resource = server.resource;
  if (typeof resource === 'function') {
    const originalResource = resource.bind(server) as (...args: unknown[]) => unknown;
    (wrapped as { resource: unknown }).resource = (...args: unknown[]) => {
      const handler = args[args.length - 1] as (
        ...handlerArgs: unknown[]
      ) => Promise<{ contents: Array<{ uri: string; text?: string; mimeType?: string }> }>;

      const wrappedHandler = async (...handlerArgs: unknown[]) => {
        const report = await refreshBeforeRead();
        const result = await handler(...handlerArgs);
        const notice = stalenessNotice(report);
        if (!notice) return result;
        // A resource entry has no `type`, so the shape the tools share does
        // not quite fit: what marks a text entry here is having text.
        const contents = [...result.contents];
        const last = contents[contents.length - 1];
        if (last && typeof last.text === 'string') {
          contents[contents.length - 1] = { ...last, text: `${last.text}\n\n${notice}` };
        } else if (last) {
          // Nothing to append to. Saying nothing would be the failure this is
          // about, so it goes in an entry of its own, under the same uri.
          contents.push({ uri: last.uri, text: notice, mimeType: 'text/plain' });
        }
        return { ...result, contents };
      };

      return originalResource(...args.slice(0, -1), wrappedHandler);
    };
  }

  return wrapped;
}
