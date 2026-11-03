import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sync = vi.fn();
vi.mock('@actual-app/api', () => ({ sync: (...a: unknown[]) => sync(...a) }));

const ensureConnection = vi.fn();
vi.mock('../../connection.js', () => ({
  ensureConnection: (...a: unknown[]) => ensureConnection(...a),
}));

const refreshBudgetDecimalPlaces = vi.fn();
vi.mock('../currency.js', () => ({
  refreshBudgetDecimalPlaces: (...a: unknown[]) => refreshBudgetDecimalPlaces(...a),
}));

vi.mock('../data-dir-lock.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../data-dir-lock.js')>()),
  readDataDirLock: vi.fn(),
}));

/**
 * What `syncNow` throws, when a test wants it to.
 *
 * It does not throw on its own: it catches the sync and the currency read
 * and answers either way (#162). The branch that catches it in
 * `refreshBeforeRead` is there for anything that changes, and this is the
 * only way to reach it.
 */
let syncThrows: Error | undefined;
vi.mock('../sync-clock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sync-clock.js')>();
  return {
    ...actual,
    syncNow: async (...args: never[]) => {
      if (syncThrows !== undefined) throw syncThrows;
      return actual.syncNow(...args);
    },
  };
});

import {
  refreshBeforeRead,
  stalenessNotice,
  resetSyncState,
  SYNC_TTL_MS,
  SYNC_WAIT_MS,
  SYNC_RETRY_MS,
} from '../read-sync.js';
import { syncNow } from '../sync-clock.js';
import { readDataDirLock } from '../data-dir-lock.js';

/**
 * Pulling the server's changes before a read (#126).
 *
 * The case: a long-lived process answered three times from a copy that was
 * behind, and nothing said so. A user running this as an always-on bot hit the
 * same thing and wrote a preload to work around it.
 */
describe('refreshing before a read', () => {
  let stderr: string[];
  let restore: () => void;

  beforeEach(() => {
    resetSyncState();
    sync.mockReset().mockResolvedValue(undefined);
    ensureConnection.mockReset().mockResolvedValue(undefined);
    refreshBudgetDecimalPlaces.mockReset().mockResolvedValue(2);
    stderr = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void stderr.push(args.map(String).join(' '));
    restore = () => {
      console.error = original;
    };
  });

  afterEach(() => restore());

  it('syncs when nothing has been synced yet', async () => {
    const report = await refreshBeforeRead();

    expect(sync).toHaveBeenCalledTimes(1);
    expect(report.current).toBe(true);
  });

  it('does not sync again inside the TTL', async () => {
    // A sync per read is a network round trip per read, which is what makes
    // doing this on every read affordable or not.
    const start = Date.now();
    await refreshBeforeRead(start);
    await refreshBeforeRead(start + SYNC_TTL_MS - 1);

    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('syncs again once the TTL has passed', async () => {
    // Fake timers, so the clock this test reasons about and the clock the sync
    // records are the same one. With the real clock, `markGoodSync` stamps the
    // moment the sync finished, which is a millisecond or two after `start`,
    // and `start + TTL + 1` can land inside the TTL. Measured by making the
    // sync take 5 ms: the test fails. That is a test that goes red only when
    // the machine is busy, which is the worst way to find out.
    vi.useFakeTimers();
    try {
      const start = Date.now();
      await refreshBeforeRead(start);
      // The clock the second call is told about is the one that decides, so
      // the test does not have to wait a minute.
      await refreshBeforeRead(start + SYNC_TTL_MS + 1);

      expect(sync).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares one sync between concurrent reads', async () => {
    // Ten reads arriving together on a cold cache would otherwise start ten
    // syncs, which is the shape that makes this expensive.
    let release = () => {};
    sync.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const reads = [refreshBeforeRead(), refreshBeforeRead(), refreshBeforeRead()];
    // The reads have to reach the sync before it is released, and each one
    // awaits `ensureConnection` on the way.
    await Promise.resolve();
    await Promise.resolve();
    release();
    const reports = await Promise.all(reads);

    expect(sync).toHaveBeenCalledTimes(1);
    for (const report of reports) expect(report.current).toBe(true);
  });

  it('goes ahead with the local copy when the sync does not answer', async () => {
    // A server that accepts and never replies would otherwise hold the read
    // for the full HTTP timeout.
    vi.useFakeTimers();
    try {
      sync.mockImplementation(() => new Promise(() => {}));

      const pending = refreshBeforeRead();
      await vi.advanceTimersByTimeAsync(SYNC_WAIT_MS + 10);
      const report = await pending;

      expect(report.current).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('survives a sync that throws, and says why on stderr', async () => {
    sync.mockImplementation(async () => {
      throw new Error('network-failure');
    });

    const report = await refreshBeforeRead();

    expect(report.current).toBe(false);
    expect(stderr.join('\n')).toMatch(/could not sync before reading/i);
  });

  it('survives a sync that throws past `syncNow`, and names no password', async () => {
    // The defensive branch: `syncNow` answers rather than throwing, so
    // nothing reaches this today, and a read that threw here would be a
    // read that fails because the server is down, which is what #126
    // exists to avoid.
    syncThrows = new Error('request to http://user:hunter2@actual.example:5006/sync failed');
    try {
      const report = await refreshBeforeRead();

      expect(report.current).toBe(false);
      const said = stderr.join('\n');
      expect(said).toContain('could not sync before reading');
      expect(said).toContain('actual.example:5006');
      expect(said).not.toContain('hunter2');

      // And the failure is recorded, so the next read does not try again
      // straight away: a server that is down would otherwise be asked once
      // per read, each paying the HTTP deadline.
      syncThrows = undefined;
      sync.mockClear();
      await refreshBeforeRead();
      expect(sync).not.toHaveBeenCalled();
    } finally {
      syncThrows = undefined;
    }
  });

  it('names the server in that line without its password (#275)', async () => {
    // The engine quotes the address it was given, and this line is on
    // stderr, which is where a bug report comes from.
    sync.mockImplementation(async () => {
      throw new Error('request to http://user:hunter2@actual.example:5006/sync failed');
    });

    await refreshBeforeRead();

    const said = stderr.join('\n');
    expect(said).toContain('actual.example:5006');
    expect(said).not.toContain('hunter2');
  });

  /**
   * The clock is shared with the rest of the server (#126, round 2). A write
   * pulls before the checks that decide whether to write, and that pull makes
   * the copy just as current as one a read started.
   */
  it('counts a sync a write did, instead of starting its own', async () => {
    await syncNow();

    const report = await refreshBeforeRead();

    expect(sync, 'synced again a moment after a write had').toHaveBeenCalledTimes(1);
    expect(report.current).toBe(true);
  });

  it('does not claim it has never synced when a write just did', async () => {
    // The sentence it would otherwise reach for says these figures are from
    // the copy downloaded at startup, which is the one thing they are not.
    await syncNow();
    const start = Date.now();
    sync.mockImplementation(async () => {
      throw new Error('network-failure');
    });

    const report = await refreshBeforeRead(start + SYNC_TTL_MS + 1);
    const notice = stalenessNotice(report, start + SYNC_TTL_MS + 1);

    expect(notice).not.toMatch(/has not synced since it started/i);
    expect(notice).toMatch(/1 minute ago/);
  });
});

/**
 * A read that arrives while the budget is still being loaded (#126, round 2).
 *
 * `server.connect()` happens before the startup `ensureConnection()`, so this
 * is not hypothetical: reads in a loop during startup produced seventeen
 * `Cannot destructure property 'id' of 'getPrefs(...)'`, a `TypeError` reading
 * 'timestamp' inside `_fullSync` before the clock was loaded, and one sync
 * that reported success halfway through a load.
 */
describe('a read that arrives during startup', () => {
  beforeEach(() => {
    resetSyncState();
    sync.mockReset().mockResolvedValue(undefined);
    ensureConnection.mockReset().mockResolvedValue(undefined);
  });

  it('waits for the budget to finish loading before syncing', async () => {
    let loaded = () => {};
    ensureConnection.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          loaded = resolve;
        }),
    );

    const pending = refreshBeforeRead();
    // Enough turns for a sync to have started if nothing were holding it.
    await Promise.resolve();
    await Promise.resolve();
    expect(sync, 'synced into a half-loaded budget').not.toHaveBeenCalled();

    loaded();
    await pending;
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('does not sync at all when no budget could be opened', async () => {
    // Nothing to bring up to date, and `api.sync()` against an unloaded budget
    // is where the destructuring errors came from.
    ensureConnection.mockRejectedValue(new Error('No budget file is open'));

    const report = await refreshBeforeRead();

    expect(sync).not.toHaveBeenCalled();
    expect(report.current).toBe(false);
  });
});

/**
 * What a server that is down costs (#126, round 2).
 *
 * Measured with SIGSTOP on the Actual server: four reads in a row at 20.0 s
 * each, where they had been instant. Nothing remembered that the last attempt
 * had just failed, so every read paid the deadline again.
 */
describe('a server that is not answering', () => {
  beforeEach(() => {
    resetSyncState();
    sync.mockReset().mockResolvedValue(undefined);
    ensureConnection.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it('is left alone for a while after it fails', async () => {
    sync.mockImplementation(async () => {
      throw new Error('network-failure');
    });
    const start = Date.now();
    await refreshBeforeRead(start);

    const second = await refreshBeforeRead(start + SYNC_RETRY_MS - 1);

    expect(sync, 'tried again inside the pause').toHaveBeenCalledTimes(1);
    expect(second.current).toBe(false);
  });

  it('is tried again once the pause is over', async () => {
    // A pause, not giving up: a server that comes back has to be noticed.
    //
    // Fake timers for the same reason as the TTL case above: the failure is
    // stamped with the real clock, so a margin of one millisecond is not a
    // margin at all once anything takes time.
    vi.useFakeTimers();
    try {
      sync.mockImplementationOnce(async () => {
        throw new Error('network-failure');
      });
      const start = Date.now();
      await refreshBeforeRead(start);

      sync.mockResolvedValue(undefined);
      const second = await refreshBeforeRead(start + SYNC_RETRY_MS + 1);

      expect(sync).toHaveBeenCalledTimes(2);
      expect(second.current).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not make the next read wait out the deadline again', async () => {
    // The measured case: the sync neither fails nor returns, so without the
    // pause the next read joins the same flight and pays another 20 seconds.
    vi.useFakeTimers();
    try {
      sync.mockImplementation(() => new Promise(() => {}));

      const first = refreshBeforeRead();
      await vi.advanceTimersByTimeAsync(SYNC_WAIT_MS + 10);
      await first;

      let settled = false;
      const second = refreshBeforeRead().then((report) => {
        settled = true;
        return report;
      });
      // Microtasks only: the clock does not move, so anything still waiting
      // on the deadline cannot have finished.
      await vi.advanceTimersByTimeAsync(0);

      expect(settled, 'the second read waited again').toBe(true);
      expect((await second).current).toBe(false);
      expect(sync).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets the pause when a slow sync does finish', async () => {
    // A merely slow server costs one slow read, not a minute of notices.
    vi.useFakeTimers();
    try {
      let finish = () => {};
      sync.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );

      const first = refreshBeforeRead();
      await vi.advanceTimersByTimeAsync(SYNC_WAIT_MS + 10);
      expect((await first).current).toBe(false);

      finish();
      await vi.advanceTimersByTimeAsync(0);

      const second = await refreshBeforeRead();
      expect(second.current, 'the late sync did not count').toBe(true);
      expect(sync).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('what the reader is told when it could not refresh', () => {
  beforeEach(() => resetSyncState());

  it('says nothing when the copy is current', () => {
    expect(stalenessNotice({ current: true, lastGoodSync: Date.now() })).toBeUndefined();
  });

  it('gives the age of the last good sync', () => {
    const now = Date.now();
    const notice = stalenessNotice({ current: false, lastGoodSync: now - 5 * 60_000 }, now);

    expect(notice).toMatch(/could not refresh/i);
    expect(notice).toMatch(/5 minutes ago/);
  });

  it('says one minute without an s', () => {
    const now = Date.now();
    expect(stalenessNotice({ current: false, lastGoodSync: now - 60_000 }, now)).toMatch(
      /1 minute ago/,
    );
  });

  it('rounds up rather than saying zero', () => {
    // "0 minutes ago" reads as current, which is the opposite of the point.
    const now = Date.now();
    expect(stalenessNotice({ current: false, lastGoodSync: now - 1_000 }, now)).toMatch(
      /1 minute ago/,
    );
  });

  it('says so differently when it has never synced', () => {
    const notice = stalenessNotice({ current: false }, Date.now());

    expect(notice).toMatch(/has not synced since it started/i);
    expect(notice).not.toMatch(/minutes? ago/);
  });

  it('says nothing about a reason when there is none to give', () => {
    expect(stalenessNotice({ current: false, lastGoodSync: Date.now() })).not.toMatch(/reason/i);
  });

  /**
   * The age answers "how old is this". The reason answers "what do I do about
   * it", and those have different answers (#126, round 2): a passing network
   * blip needs nothing, an out-of-sync budget needs repairing, and a wrong
   * password needs a person. One sentence for all three sent the reader to
   * wait for a network that was never the problem.
   */
  it('points an out-of-sync budget at repair_sync', () => {
    const notice = stalenessNotice(
      { current: false, lastGoodSync: Date.now(), failure: new Error('out-of-sync') },
      Date.now(),
    );

    expect(notice).toMatch(/repair_sync/);
  });

  it('does not blame another server for a server that did not answer', () => {
    // #206, found on this route by the audit: the note about another server
    // on the same budget was appended to every description, so a read whose
    // figures were stale ended on a paragraph about a process started weeks
    // earlier, attached to the reason where it reads as the cause.
    vi.mocked(readDataDirLock).mockReturnValue({
      pid: 4242,
      startedAt: '2026-09-24T10:00:00.000Z',
      version: '0.10.7',
    });
    const failure = new Error('We had an unknown problem opening "budget-id"');

    const notice = stalenessNotice({ current: false, failure }, Date.now())!;
    vi.mocked(readDataDirLock).mockReset();

    expect(notice).toContain('did not answer');
    expect(notice).not.toContain('4242');
  });

  it('still names another server when that is what out-of-sync means', () => {
    vi.mocked(readDataDirLock).mockReturnValue({
      pid: 4242,
      startedAt: '2026-09-24T10:00:00.000Z',
      version: '0.10.7',
    });

    const notice = stalenessNotice(
      { current: false, failure: new Error('out-of-sync') },
      Date.now(),
    )!;
    vi.mocked(readDataDirLock).mockReset();

    expect(notice).toContain('4242');
  });

  it('points a refused login at the credentials', () => {
    const failure = Object.assign(new Error('We had an unknown problem opening "budget-id"'), {
      code: 'unauthorized',
    });

    const notice = stalenessNotice({ current: false, failure }, Date.now());

    expect(notice).toMatch(/refused the credentials/i);
  });

  it('points a bad encryption key at the key', () => {
    const failure = Object.assign(new Error('We had an unknown problem opening "budget-id"'), {
      code: 'decrypt-failure',
    });

    const notice = stalenessNotice({ current: false, failure }, Date.now());

    expect(notice).toMatch(/encryption password/i);
  });

  it('tells an always-on server its session expired', () => {
    // The case this matters most for: a server left running for days whose
    // session the Actual server has since forgotten. It keeps answering, from
    // a copy that stops moving, and retries with the dead token every minute.
    const failure = Object.assign(new Error('We had an unknown problem opening "budget-id"'), {
      code: 'token-expired',
    });

    const notice = stalenessNotice({ current: false, lastGoodSync: Date.now() }, Date.now());
    const withReason = stalenessNotice({ current: false, failure }, Date.now());

    expect(notice).not.toMatch(/restart/i);
    expect(withReason).toMatch(/session .* expired/i);
    expect(withReason).toMatch(/restart/i);
  });

  it('still gives the age when it gives a reason', () => {
    // The reason is extra, not a replacement: how old the figures are is the
    // question the reader came with.
    const now = Date.now();
    const notice = stalenessNotice(
      { current: false, lastGoodSync: now - 3 * 60_000, failure: new Error('out-of-sync') },
      now,
    );

    expect(notice).toMatch(/3 minutes ago/);
  });
});

import { withReadSync, type McpServerLike } from '../read-sync.js';

/**
 * What the wrapper does to a reply, tested on handlers of its own.
 *
 * Through the real tools these cases need an Actual server to answer at all,
 * and then they would be measuring the tool rather than the wrapper. Which
 * tools get wrapped is checked separately, against the real registration.
 */
describe('the notice a wrapped read carries', () => {
  const register = (
    readOnly: boolean,
    handler: (args: unknown) => Promise<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>,
  ) => {
    let registered: typeof handler | undefined;
    const server: McpServerLike = {
      tool: ((...args: unknown[]) => {
        registered = args[args.length - 1] as typeof handler;
      }) as never,
    };
    withReadSync(server).tool(
      'probe' as never,
      'description' as never,
      {} as never,
      { readOnlyHint: readOnly } as never,
      handler as never,
    );
    return registered!;
  };

  const ok = async () => ({ content: [{ type: 'text', text: 'the answer' }] });

  beforeEach(() => {
    resetSyncState();
    sync.mockReset().mockResolvedValue(undefined);
    ensureConnection.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it('appends the notice rather than leading with it', async () => {
    // The answer is what was asked for; the caveat belongs with it.
    sync.mockImplementation(async () => {
      throw new Error('down');
    });

    const result = await register(true, ok)({});

    expect(result.content[0].text).toMatch(/^the answer/);
    expect(result.content[0].text).toMatch(/could not refresh/i);
  });

  it('says nothing when the sync worked', async () => {
    const result = await register(true, ok)({});

    expect(result.content[0].text).toBe('the answer');
  });

  it('does not bolt the notice onto an error', async () => {
    // An error already says something went wrong; two problems in one reply
    // send the reader looking for two fixes.
    sync.mockImplementation(async () => {
      throw new Error('down');
    });
    const failing = async () => ({
      content: [{ type: 'text', text: 'Error: something else' }],
      isError: true,
    });

    const result = await register(true, failing)({});

    expect(result.content[0].text).not.toMatch(/could not refresh/i);
  });

  it('leaves a write tool completely alone', async () => {
    sync.mockImplementation(async () => {
      throw new Error('down');
    });

    const result = await register(false, ok)({});

    expect(sync).not.toHaveBeenCalled();
    expect(result.content[0].text).toBe('the answer');
  });
});

/**
 * Resources are reads too (#126, round 2).
 *
 * They were missed the first time round, which was worse than leaving both
 * alone: `actual://accounts` went on serving balances from a copy that was
 * behind while every tool had stopped doing it, so only one of the two ways of
 * asking was honest.
 */
describe('a wrapped resource', () => {
  const register = () => {
    let registered: (() => Promise<{ contents: Array<{ uri: string; text: string }> }>) | undefined;
    const server: McpServerLike = {
      tool: (() => {}) as never,
      resource: ((...args: unknown[]) => {
        registered = args[args.length - 1] as typeof registered;
      }) as never,
    };
    withReadSync(server).resource!(
      'accounts' as never,
      'actual://accounts' as never,
      {} as never,
      (async () => ({
        contents: [{ uri: 'actual://accounts', text: 'Accounts:' }],
      })) as never,
    );
    return registered!;
  };

  beforeEach(() => {
    resetSyncState();
    sync.mockReset().mockResolvedValue(undefined);
    ensureConnection.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it('pulls before answering', async () => {
    await register()();

    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('carries the same notice a read tool does', async () => {
    sync.mockImplementation(async () => {
      throw new Error('down');
    });

    const result = await register()();

    expect(result.contents[0].text).toMatch(/^Accounts:/);
    expect(result.contents[0].text).toMatch(/could not refresh/i);
  });

  it('says nothing when the sync worked', async () => {
    const result = await register()();

    expect(result.contents[0].text).toBe('Accounts:');
  });

  it('still says it on a resource with nothing to append to', async () => {
    // Saying nothing is the failure this is about, so an entry that carries no
    // text gets the notice in one of its own rather than losing it.
    sync.mockImplementation(async () => {
      throw new Error('down');
    });
    let registered: (() => Promise<{ contents: Array<{ uri: string; text?: string }> }>) | undefined;
    const server: McpServerLike = {
      tool: (() => {}) as never,
      resource: ((...args: unknown[]) => {
        registered = args[args.length - 1] as typeof registered;
      }) as never,
    };
    withReadSync(server).resource!(
      'chart' as never,
      'actual://chart' as never,
      (async () => ({ contents: [{ uri: 'actual://chart', blob: 'AAAA' }] })) as never,
    );

    const result = await registered!();

    expect(result.contents).toHaveLength(2);
    expect(result.contents[1].text).toMatch(/could not refresh/i);
  });
});

/**
 * The budget currency, refreshed where a change to it arrives (#141).
 *
 * The decimal count scales every amount read or written, and it is read once
 * when a budget opens. A server that stays up for days would hold the count
 * from the morning, so a currency changed in the app is picked up with the
 * same sync that picks up a recategorised transaction, and no more often than
 * that: the count is not worth an engine call per read.
 */
describe('keeping the budget currency current', () => {
  beforeEach(() => {
    resetSyncState();
    sync.mockReset().mockResolvedValue(undefined);
    ensureConnection.mockReset().mockResolvedValue(undefined);
    refreshBudgetDecimalPlaces.mockReset().mockResolvedValue(2);
  });

  it('re-reads it after a sync that happened', async () => {
    await refreshBeforeRead();
    expect(refreshBudgetDecimalPlaces).toHaveBeenCalledTimes(1);
  });

  it('does not re-read it on a read answered from the TTL', async () => {
    // The sync is what is skipped, and this goes with it. Without the check a
    // read that costs nothing today would start costing an engine call.
    const start = Date.now();
    await refreshBeforeRead(start);
    await refreshBeforeRead(start + SYNC_TTL_MS - 1);
    expect(refreshBudgetDecimalPlaces).toHaveBeenCalledTimes(1);
  });

  it('does not re-read it when the sync failed', async () => {
    // Nothing arrived, so there is nothing to pick up, and the engine is the
    // thing that is not answering.
    sync.mockRejectedValue(new Error('server is down'));
    await refreshBeforeRead();
    expect(refreshBudgetDecimalPlaces).not.toHaveBeenCalled();
  });
});
