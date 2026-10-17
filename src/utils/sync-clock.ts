import * as api from '@actual-app/api';
import { refreshBudgetDecimalPlaces } from './currency.js';
import { reauthenticate, type ReauthOutcome } from '../connection.js';

/**
 * When this process last managed to sync, in one place (#126).
 *
 * The staleness notice a read carries is built from this timestamp, so it is
 * only true if **every** successful sync updates it. An earlier version kept
 * the timestamp inside the read path, which meant the initial download and the
 * pulls writes do before their checks did not count: a process that had synced
 * a second ago as part of a write could still tell the reader its figures were
 * from twenty minutes ago. The answer was not to add a second counter but to
 * have one, here, and route every sync through `syncNow`.
 *
 * The failure is recorded too, for two reasons. A server that is down was
 * costing every read the full wait, one after another, because nothing
 * remembered that the last attempt had just failed. And the reason it gave is
 * worth repeating to the reader: `unauthorized` and `out-of-sync` need
 * different things done about them, and "could not refresh" sounds like
 * neither.
 */

let lastGood: number | undefined;
let lastTrouble: { at: number; error: unknown } | undefined;
/** When this process last had to sign in again, for the reply to mention it. */
let lastReauth: number | undefined;

export function lastReauthentication(): number | undefined {
  return lastReauth;
}

/** Record a sync that worked, which also clears any recorded failure. */
export function markGoodSync(at: number = Date.now()): void {
  lastGood = at;
  lastTrouble = undefined;
}

/** Record a sync that did not work, with whatever it threw. */
export function markFailedSync(error: unknown, at: number = Date.now()): void {
  lastTrouble = { at, error };
}

export function lastGoodSync(): number | undefined {
  return lastGood;
}

export function lastFailedSync(): { at: number; error: unknown } | undefined {
  return lastTrouble;
}

/** For tests: forget everything, as if the process had just started. */
export function resetSyncClock(): void {
  lastGood = undefined;
  lastTrouble = undefined;
  lastReauth = undefined;
}

/** What a sync did, for the caller that has to say something about it. */
export interface SyncOutcome {
  /** Whether the budget and the server are in step. */
  ok: boolean;
  /** What went wrong, when it did not. */
  error?: unknown;
  /** Whether it took signing in again to get there, which is worth saying. */
  reauthenticated?: boolean;
  /** Why signing in again did not happen or did not work. */
  recovery?: ReauthOutcome;
}

async function attempt(): Promise<SyncOutcome> {
  try {
    await api.sync();
  } catch (error) {
    markFailedSync(error);
    return { ok: false, error };
  }
  markGoodSync();

  // The budget currency, re-read here for the same reason the clock is kept
  // here: this is the one place every sync passes through. It scales every
  // amount read or written (#141), and a sync is where a currency changed in
  // the app arrives.
  //
  // Tying it to the read path instead was not enough. A write syncs before
  // its own checks, which marks the clock fresh, so the next read answers
  // from the TTL and never refreshes: on a server left running, a write could
  // keep the figure from the morning indefinitely. It reads both preference
  // stores and keeps the count it already had when neither answers, so a
  // budget whose preferences cannot be read goes on converting as it was.
  //
  // Caught here as well, rather than trusted: this runs after the sync has
  // already succeeded, and a throw from it would turn a sync that worked into
  // one that failed.
  try {
    await refreshBudgetDecimalPlaces();
  } catch {
    // The count that was already there is the better answer than none.
  }
  return { ok: true };
}

/**
 * `api.sync()`, with the clock kept, and one attempt at signing in again.
 *
 * Every sync in this server goes through here rather than calling the API
 * directly, which is what makes "when did this last sync" answerable at all.
 *
 * **It does not throw.** That is the point of it, and it is what stopped a
 * failed sync after a write being reported as a failed write (#162). Measured
 * against a disposable server with the session expired: `create_payee`
 * answered `isError: true` with a paragraph about restarting, and the payee
 * was in the budget. A caller reading "Error" tries again, and trying again
 * is what duplicates.
 *
 * The inventory that made this safe: no sync in this server runs before a
 * write in a way that stops it. Every one in a write tool runs after the
 * write, to push; the three that run before anything is written all go
 * through `pullBeforeReading`, which has caught and warned since #88 because
 * the check it guards still sees everything this process wrote; the read path
 * catches to build its staleness notice; and `verifyFailedWrite` does not
 * sync at all.
 *
 * Signing in again is tried for one error and one only. `token-expired` is a
 * code on the error, not a sentence to match, which is what makes this safe
 * to hang a recovery on.
 */
export async function syncNow(): Promise<SyncOutcome> {
  const first = await attempt();
  if (first.ok) return first;

  const code = (first.error as { code?: unknown } | undefined)?.code;
  if (code !== 'token-expired') return first;

  const recovery = await reauthenticate();
  if (recovery !== 'signed-in') return { ...first, recovery };

  lastReauth = Date.now();
  const second = await attempt();
  return { ...second, reauthenticated: true };
}
