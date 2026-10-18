import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimDataDir, crowdedNotice, readDataDirLock, LOCK_FILE } from '../data-dir-lock.js';

let root: string;

/** A lock file naming a process that is certainly alive: this one. */
const liveLock = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, LOCK_FILE),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), version: '0.0.0' }),
  );
};

/** A live lock that says it has been there since a given day. */
const liveLockFrom = (dir: string, startedAt: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, LOCK_FILE),
    JSON.stringify({ pid: process.pid, startedAt, version: '0.0.0' }),
  );
};

/** A lock naming a pid that cannot exist, standing in for a crashed server. */
const deadLock = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, LOCK_FILE),
    JSON.stringify({ pid: 2 ** 30, startedAt: '2026-01-01T00:00:00.000Z', version: '0.0.0' }),
  );
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'claim-test-'));
  process.env.ACTUAL_DATA_DIR = join(root, 'cache');
});

afterEach(() => {
  delete process.env.ACTUAL_DATA_DIR;
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('claiming a data dir that another server may be using', () => {
  it('uses the configured directory when nobody holds it', () => {
    const claim = claimDataDir('1.0.0');

    expect(claim.dataDir).toBe(join(root, 'cache'));
    expect(claim.contended).toBeUndefined();
    expect(claim.shared).toBeUndefined();
  });

  it('creates the directory, since a missing one masks every later error', () => {
    claimDataDir('1.0.0');

    expect(existsSync(join(root, 'cache'))).toBe(true);
  });

  it('records itself as the holder', () => {
    claimDataDir('1.0.0');

    expect(readDataDirLock(join(root, 'cache'))?.pid).toBe(process.pid);
  });

  it('steps aside rather than sharing a directory a live server holds', () => {
    // A different process cannot be faked with our own pid, so the lock is
    // written first and the claim then finds it taken.
    liveLock(join(root, 'cache'));
    vi.spyOn(process, 'pid', 'get').mockReturnValue(999_001);

    const claim = claimDataDir('1.0.0');

    expect(claim.dataDir).toBe(join(root, 'cache-2'));
    expect(claim.contended).toBe(join(root, 'cache'));
    expect(claim.shared).toBeUndefined();
    vi.restoreAllMocks();
  });

  it('keeps stepping aside past several live servers', () => {
    liveLock(join(root, 'cache'));
    liveLock(join(root, 'cache-2'));
    liveLock(join(root, 'cache-3'));
    vi.spyOn(process, 'pid', 'get').mockReturnValue(999_002);

    expect(claimDataDir('1.0.0').dataDir).toBe(join(root, 'cache-4'));
    vi.restoreAllMocks();
  });

  it('keeps every server it stepped past, not just the first', () => {
    // The count is what the startup line is for (#207): landing on `-4` means
    // three others are running, and naming only the holder of the first
    // directory says nothing about the other two.
    liveLock(join(root, 'cache'));
    liveLock(join(root, 'cache-2'));
    liveLock(join(root, 'cache-3'));
    vi.spyOn(process, 'pid', 'get').mockReturnValue(999_003);

    const claim = claimDataDir('1.0.0');
    vi.restoreAllMocks();

    expect(claim.others).toHaveLength(3);
  });

  it('reclaims a directory whose holder is gone instead of leaving it behind', () => {
    // The state after a crash or a reboot. Abandoning these would grow a new
    // cache directory on every restart.
    deadLock(join(root, 'cache'));

    const claim = claimDataDir('1.0.0');

    expect(claim.dataDir).toBe(join(root, 'cache'));
    expect(claim.contended).toBeUndefined();
  });

  it('never refuses to start, even when every candidate is taken', () => {
    liveLock(join(root, 'cache'));
    for (let n = 2; n <= 8; n++) liveLock(join(root, `cache-${n}`));
    vi.spyOn(process, 'pid', 'get').mockReturnValue(999_003);

    const claim = claimDataDir('1.0.0');

    // Sharing is wrong. Not starting is worse, and #47 settled that.
    expect(claim.dataDir).toBe(join(root, 'cache'));
    expect(claim.shared).toBe(true);
    vi.restoreAllMocks();
  });

  it('leaves the incumbent nameable, so the warning can say who is there', () => {
    const incumbent = process.pid;
    liveLock(join(root, 'cache'));
    vi.spyOn(process, 'pid', 'get').mockReturnValue(999_004);

    const claim = claimDataDir('1.0.0');

    expect(claim.heldBy?.pid).toBe(incumbent);
    vi.restoreAllMocks();
  });
});

/**
 * What the server says at startup when it is not on the first directory.
 *
 * In the live test of 0.10.7 it started on `-7`, and the line it printed
 * named one directory and one pid. Six servers were running against the same
 * budget, one of them for three weeks, and nothing said so.
 */
describe('the line about a crowded directory', () => {
  it('counts them, including this one, and says since when', () => {
    // The oldest second, on purpose: the directories are met in order and
    // the one it met first is not the one that has been there longest.
    liveLockFrom(join(root, 'cache'), '2026-10-11T10:00:00.000Z');
    liveLockFrom(join(root, 'cache-2'), '2026-09-24T10:00:00.000Z');
    vi.spyOn(process, 'pid', 'get').mockReturnValue(999_004);

    const notice = crowdedNotice(claimDataDir('1.0.0'))!;
    vi.restoreAllMocks();

    expect(notice).toContain('3 actual-budget-mcp servers');
    expect(notice, 'the oldest, not whichever came first').toContain(
      'The oldest started on 2026-09-24.',
    );
    expect(notice).toContain('left over from sessions');
    expect(notice).toContain('Closing the ones you are not using');
  });

  it('names no pids', () => {
    // What clears this is closing the sessions that left them. A list of
    // numbers reads as something to go and kill one by one.
    liveLockFrom(join(root, 'cache'), '2026-09-24T10:00:00.000Z');
    vi.spyOn(process, 'pid', 'get').mockReturnValue(999_005);

    const notice = crowdedNotice(claimDataDir('1.0.0'))!;
    vi.restoreAllMocks();

    expect(notice).not.toMatch(/pid/i);
    expect(notice).not.toContain(String(process.pid));
  });

  it('says nothing when this server has the directory to itself', () => {
    expect(crowdedNotice(claimDataDir('1.0.0'))).toBeUndefined();
  });

  it('says nothing when the holder was gone and the directory was reclaimed', () => {
    deadLock(join(root, 'cache'));

    expect(crowdedNotice(claimDataDir('1.0.0'))).toBeUndefined();
  });
});
