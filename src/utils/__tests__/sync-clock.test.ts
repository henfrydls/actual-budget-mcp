import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const sync = vi.fn();
vi.mock('@actual-app/api', () => ({ sync: (...a: unknown[]) => sync(...a) }));

import { syncNow, markGoodSync, lastGoodSync, lastFailedSync, resetSyncClock } from '../sync-clock.js';

/**
 * One record of when this process last synced (#126, round 2).
 *
 * The staleness notice is built from this timestamp, so it is only true if
 * every successful sync updates it. The first version kept the timestamp
 * inside the read path, which left the pulls writes do before their checks
 * uncounted: a process that had synced a second ago could still tell the
 * reader its figures were from the copy it downloaded at startup.
 */
describe('the sync clock', () => {
  beforeEach(() => {
    resetSyncClock();
    sync.mockReset().mockResolvedValue(undefined);
  });

  it('records a sync that worked', async () => {
    const before = Date.now();
    await syncNow();

    expect(lastGoodSync()).toBeGreaterThanOrEqual(before);
    expect(lastFailedSync()).toBeUndefined();
  });

  it('records what a failed sync threw, and rethrows it', async () => {
    const thrown = new Error('network-failure');
    sync.mockRejectedValue(thrown);

    await expect(syncNow()).rejects.toThrow('network-failure');

    expect(lastFailedSync()?.error).toBe(thrown);
    expect(lastGoodSync()).toBeUndefined();
  });

  it('clears a recorded failure once a sync works again', async () => {
    sync.mockRejectedValueOnce(new Error('network-failure'));
    await syncNow().catch(() => undefined);
    expect(lastFailedSync()).toBeDefined();

    await syncNow();

    expect(lastFailedSync(), 'a server that came back is still marked down').toBeUndefined();
  });

  it('does not record a sync that threw as a good one', async () => {
    markGoodSync(1_000);
    sync.mockRejectedValue(new Error('network-failure'));

    await syncNow().catch(() => undefined);

    expect(lastGoodSync()).toBe(1_000);
  });
});

/**
 * The structural half, which is what actually keeps the record honest.
 *
 * The notice says "this process has not synced since it started" when there is
 * no timestamp, and that sentence is a claim about the whole process, not
 * about the read path. One `api.sync()` called directly anywhere else makes it
 * false, and nothing else in the suite would notice: the sync would work, the
 * tool would pass, and only the wording of an unrelated reply would be wrong.
 */
describe('every sync goes through the clock', () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        return entry === '__tests__' || entry === 'node_modules' ? [] : sources(full);
      }
      return full.endsWith('.ts') ? [full] : [];
    });

  it('has no api.sync() outside sync-clock.ts', () => {
    const offenders = sources('src')
      .filter((file) => !file.endsWith(join('utils', 'sync-clock.ts')))
      .filter((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          // Comments talk about `api.sync()` in several places, and rightly so.
          .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
          .some((line) => /\bapi\.sync\s*\(/.test(line)),
      );

    expect(offenders, `call syncNow() instead: ${offenders.join(', ')}`).toEqual([]);
  });

  it('finds the file it is guarding, so the search is not vacuous', () => {
    // A rename would otherwise leave this passing over nothing.
    const clock = sources('src').filter((file) => file.endsWith(join('utils', 'sync-clock.ts')));

    expect(clock).toHaveLength(1);
    expect(readFileSync(clock[0], 'utf8')).toMatch(/\bapi\.sync\s*\(/);
  });
});
