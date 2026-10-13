import * as api from '@actual-app/api';
import { refreshBudgetDecimalPlaces } from './currency.js';

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
}

/**
 * `api.sync()`, with the clock kept.
 *
 * Every sync in this server goes through here rather than calling the API
 * directly, which is what makes "when did this last sync" answerable at all.
 * It throws what `api.sync()` throws: callers that have their own handling
 * keep it, and the only thing added is the record.
 */
export async function syncNow(): Promise<void> {
  try {
    await api.sync();
  } catch (error) {
    markFailedSync(error);
    throw error;
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
  // been recorded, and a throw from it would turn a sync that worked into a
  // failed call for every write that syncs before its checks. The decimal
  // count is a formatting detail and must not be able to fail a sync.
  try {
    await refreshBudgetDecimalPlaces();
  } catch {
    // Keeping the count already held, which is what a failed read means.
  }
}
