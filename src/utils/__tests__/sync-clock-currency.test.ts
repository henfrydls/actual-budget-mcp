import { describe, it, expect, vi, beforeEach } from 'vitest';

const sync = vi.fn();
vi.mock('@actual-app/api', () => ({ sync: (...a: unknown[]) => sync(...a) }));

const refreshBudgetDecimalPlaces = vi.fn();
vi.mock('../currency.js', () => ({
  refreshBudgetDecimalPlaces: (...a: unknown[]) => refreshBudgetDecimalPlaces(...a),
}));

import { syncNow, resetSyncClock, lastGoodSync } from '../sync-clock.js';

/**
 * The budget currency is re-read wherever a sync happens, not only before a
 * read (#141).
 *
 * It was tied to the read path first, and that left writes out twice over.
 * A write syncs before its own duplicate checks, and that sync marks the
 * clock fresh, so the next read answers from the TTL without refreshing
 * either: on a server left running, writing was enough to keep yesterday's
 * currency indefinitely. `syncNow` is the one place every sync in this server
 * passes through, which is why the clock lives there, and the currency now
 * does too.
 */
describe('syncing re-reads the budget currency', () => {
  beforeEach(() => {
    resetSyncClock();
    sync.mockReset().mockResolvedValue(undefined);
    refreshBudgetDecimalPlaces.mockReset().mockResolvedValue(2);
  });

  it('re-reads it after a sync that worked', async () => {
    await syncNow();
    expect(refreshBudgetDecimalPlaces).toHaveBeenCalledTimes(1);
  });

  it('does not re-read it when the sync threw', async () => {
    // Nothing arrived, and the engine is the thing not answering.
    sync.mockRejectedValue(new Error('server is down'));
    await expect(syncNow()).rejects.toThrow('server is down');
    expect(refreshBudgetDecimalPlaces).not.toHaveBeenCalled();
  });

  it('does not fail a sync because the currency could not be re-read', async () => {
    // The currency is a formatting detail, and this runs after the sync has
    // already worked. Letting it throw would fail every write that syncs
    // before its own checks, over a preference.
    refreshBudgetDecimalPlaces.mockRejectedValue(new Error('preferences unavailable'));
    await expect(syncNow()).resolves.toBeUndefined();
    expect(lastGoodSync(), 'the sync itself did work').not.toBeUndefined();
  });
});
