import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sync = vi.fn();
vi.mock('@actual-app/api', () => ({ sync: (...a: unknown[]) => sync(...a) }));

import {
  refreshBeforeRead,
  stalenessNotice,
  resetSyncState,
  SYNC_TTL_MS,
  SYNC_WAIT_MS,
} from '../read-sync.js';

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
    const start = Date.now();
    await refreshBeforeRead(start);
    // The clock the second call is told about is the one that decides, so the
    // test does not have to wait a minute.
    await refreshBeforeRead(start + SYNC_TTL_MS + 1);

    expect(sync).toHaveBeenCalledTimes(2);
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

  it('tries again after a failure rather than giving up', async () => {
    sync.mockImplementationOnce(async () => {
      throw new Error('network-failure');
    });
    await refreshBeforeRead();

    sync.mockResolvedValue(undefined);
    const second = await refreshBeforeRead();

    expect(sync).toHaveBeenCalledTimes(2);
    expect(second.current).toBe(true);
  });
});

describe('what the reader is told when it could not refresh', () => {
  beforeEach(() => resetSyncState());

  it('says nothing when the copy is current', () => {
    expect(stalenessNotice({ current: true, lastGoodSync: Date.now() })).toBeUndefined();
  });

  it('gives the age of the last good sync', () => {
    // From the recorded timestamp, not from which failure happened: a
    // timeout, an error and a server that is down leave the same question.
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
  });

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
