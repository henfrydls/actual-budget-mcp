import * as api from '@actual-app/api';

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
 * Four things make it safe to do on every read:
 *
 *   a TTL          a sync per read would be a network round trip per read.
 *                  Within 60 seconds the copy is treated as current, which is
 *                  what Actual's own CLI does.
 *   one in flight  concurrent reads wait on the same promise rather than
 *                  starting a sync each.
 *   a deadline     a server that accepts and never answers would otherwise
 *                  hold a read for the full HTTP timeout. After 20 seconds the
 *                  read goes ahead with what is on disk.
 *   saying so      when the sync did not happen, the reply says how old the
 *                  figures are. Without that, a server that is down goes back
 *                  to answering with stale data in silence, which is the thing
 *                  the issue is named after.
 */

/** How long a copy is treated as current. Actual's own CLI uses the same. */
export const SYNC_TTL_MS = 60_000;

/** How long a read will wait for a sync before going ahead without it. */
export const SYNC_WAIT_MS = 20_000;

interface SyncState {
  /** When the last sync that actually succeeded finished. */
  lastGoodSync?: number;
  /** The sync currently running, shared by everything waiting on it. */
  inFlight?: Promise<boolean>;
}

const state: SyncState = {};

/** For tests: forget everything, as if the process had just started. */
export function resetSyncState(): void {
  state.lastGoodSync = undefined;
  state.inFlight = undefined;
}

export interface FreshnessReport {
  /** True when the local copy is current: just synced, or synced recently. */
  current: boolean;
  /** When the last successful sync was, if there has ever been one. */
  lastGoodSync?: number;
}

/**
 * Bring the local copy up to date if it is older than the TTL.
 *
 * Never throws. A read that cannot sync is still a read; what it must not do
 * is pretend the figures are current.
 */
export async function refreshBeforeRead(now = Date.now()): Promise<FreshnessReport> {
  if (state.lastGoodSync !== undefined && now - state.lastGoodSync < SYNC_TTL_MS) {
    return { current: true, lastGoodSync: state.lastGoodSync };
  }

  // One sync for everyone waiting. Without this, ten concurrent reads on a
  // cold cache start ten syncs, which is the shape that makes a per-read sync
  // expensive in the first place.
  if (!state.inFlight) {
    state.inFlight = (async () => {
      try {
        await api.sync();
        state.lastGoodSync = Date.now();
        return true;
      } catch (error) {
        // stdout carries JSON-RPC.
        console.error(
          `[actual-budget-mcp] could not sync before reading: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return false;
      } finally {
        state.inFlight = undefined;
      }
    })();
  }

  // The wait is capped, not the sync: the sync carries on and whoever reads
  // next gets the benefit. What is capped is how long this read is held up.
  const timed = await Promise.race([
    state.inFlight,
    new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), SYNC_WAIT_MS);
      // Not left holding the event loop open once the sync wins the race.
      timer.unref?.();
    }),
  ]);

  return {
    current: timed === true,
    lastGoodSync: state.lastGoodSync,
  };
}

/**
 * What to tell the reader when the figures could not be refreshed.
 *
 * Built from the recorded timestamp rather than from which failure happened:
 * a timeout, an error and a server that is down all leave the same question,
 * which is how old this is.
 */
export function stalenessNotice(report: FreshnessReport, now = Date.now()): string | undefined {
  if (report.current) return undefined;

  if (report.lastGoodSync === undefined) {
    return (
      'Could not refresh from the Actual server, and this process has not synced since it ' +
      'started, so these figures are from the copy it downloaded then. Anything changed in ' +
      'the Actual app since may be missing.'
    );
  }

  const minutes = Math.max(1, Math.round((now - report.lastGoodSync) / 60_000));
  return (
    `Could not refresh from the Actual server; these figures are from the last sync, ` +
    `${minutes} minute${minutes === 1 ? '' : 's'} ago. Anything changed in the Actual app ` +
    `since then may be missing.`
  );
}

/** The part of `McpServer` this needs: somewhere to register a tool. */
export interface McpServerLike {
  tool: (...args: never[]) => unknown;
}

/**
 * Wrap the read tools so each one pulls the server's changes first (#126).
 *
 * Here rather than in fifteen files, because this is the one place every tool
 * goes through and a tool added later should not have to remember. It is also
 * where the user who hit this put their own workaround, by patching
 * `McpServer.prototype.tool`; doing it on the way in is the same idea without
 * the monkey patch.
 *
 * Only the read tools. The write tools already pull where it matters, before
 * the checks that decide whether to write, and syncing again on the way in
 * would be a second round trip for the same answer.
 *
 * `readOnlyHint` is what marks them, which is the same flag read-only mode
 * uses, so the two cannot drift apart.
 */
export function withReadSync<T extends McpServerLike>(server: T): T {
  const wrapped = Object.create(server) as T;
  const original = server.tool.bind(server) as (...args: unknown[]) => unknown;

  (wrapped as { tool: unknown }).tool = (...args: unknown[]) => {
    const annotations = args.find(
      (a): a is { readOnlyHint?: boolean } =>
        typeof a === 'object' && a !== null && 'readOnlyHint' in a,
    );
    if (annotations?.readOnlyHint !== true) return original(...args);

    const handler = args[args.length - 1] as (
      ...handlerArgs: unknown[]
    ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

    const wrappedHandler = async (...handlerArgs: unknown[]) => {
      const report = await refreshBeforeRead();
      const result = await handler(...handlerArgs);
      const notice = stalenessNotice(report);
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

    return original(...args.slice(0, -1), wrappedHandler);
  };

  return wrapped;
}

