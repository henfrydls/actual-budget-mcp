import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireDataDirLock, releaseDataDirLock, readDataDirLock, LOCK_FILE } from '../data-dir-lock.js';

describe('data dir lock', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lock-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('acquires the lock when the directory is free', () => {
    const result = acquireDataDirLock(dir, '0.8.1');

    expect(result.acquired).toBe(true);
    expect(result.heldBy).toBeUndefined();
    expect(existsSync(join(dir, LOCK_FILE))).toBe(true);
  });

  it('records our pid so another process can name us', () => {
    acquireDataDirLock(dir, '0.8.1');

    expect(readDataDirLock(dir)?.pid).toBe(process.pid);
  });

  it('reports contention when a live process already holds it', () => {
    // A pid that is certainly alive and is not us: the parent process.
    const otherPid = process.ppid;
    writeFileSync(
      join(dir, LOCK_FILE),
      JSON.stringify({ pid: otherPid, startedAt: new Date().toISOString(), version: '0.8.1' }),
    );

    const result = acquireDataDirLock(dir, '0.8.1');

    expect(result.acquired).toBe(false);
    expect(result.heldBy?.pid).toBe(otherPid);
  });

  it('leaves the incumbent lock alone so the error can still name it', () => {
    const otherPid = process.ppid;
    writeFileSync(
      join(dir, LOCK_FILE),
      JSON.stringify({ pid: otherPid, startedAt: '2026-01-01T00:00:00.000Z', version: '0.8.1' }),
    );

    acquireDataDirLock(dir, '0.8.1');

    expect(readDataDirLock(dir)?.pid).toBe(otherPid);
  });

  it('takes over a stale lock left by a dead process', () => {
    // Very high pid that no live process can plausibly own.
    writeFileSync(
      join(dir, LOCK_FILE),
      JSON.stringify({ pid: 4194303, startedAt: '2020-01-01T00:00:00.000Z', version: '0.1.0' }),
    );

    const result = acquireDataDirLock(dir, '0.8.1');

    expect(result.acquired).toBe(true);
    expect(readDataDirLock(dir)?.pid).toBe(process.pid);
  });

  it('re-acquiring in the same process is not contention', () => {
    acquireDataDirLock(dir, '0.8.1');
    const again = acquireDataDirLock(dir, '0.8.1');

    expect(again.acquired).toBe(true);
  });

  it('treats an unreadable lock file as absent rather than failing', () => {
    writeFileSync(join(dir, LOCK_FILE), 'not json at all');

    const result = acquireDataDirLock(dir, '0.8.1');

    expect(result.acquired).toBe(true);
  });

  it('never throws when the directory does not exist', () => {
    const missing = join(dir, 'nope', 'deeper');

    expect(() => acquireDataDirLock(missing, '0.8.1')).not.toThrow();
    expect(readDataDirLock(missing)).toBeNull();
  });

  it('releases only its own lock', () => {
    acquireDataDirLock(dir, '0.8.1');
    releaseDataDirLock(dir);

    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
  });

  it('does not release a lock held by someone else', () => {
    const otherPid = process.ppid;
    writeFileSync(
      join(dir, LOCK_FILE),
      JSON.stringify({ pid: otherPid, startedAt: new Date().toISOString(), version: '0.8.1' }),
    );

    releaseDataDirLock(dir);

    expect(readDataDirLock(dir)?.pid).toBe(otherPid);
  });

  it('reports no holder once the lock is gone', () => {
    expect(readDataDirLock(dir)).toBeNull();
  });

  it('ignores a lock whose owner has died when reporting a holder', () => {
    writeFileSync(
      join(dir, LOCK_FILE),
      JSON.stringify({ pid: 4194303, startedAt: '2020-01-01T00:00:00.000Z', version: '0.1.0' }),
    );

    expect(readDataDirLock(dir)).toBeNull();
  });
});
