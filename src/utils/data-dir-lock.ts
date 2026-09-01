import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const LOCK_FILE = '.actual-mcp-lock.json';

/**
 * Where the budget cache lives. Defined here rather than in connection.ts so
 * the lock and the error messages resolve the same directory the server
 * actually opens — a second copy of the default would drift.
 */
export const DEFAULT_DATA_DIR = '/tmp/actual-budget-mcp-data';

export function effectiveDataDir(): string {
  return process.env.ACTUAL_DATA_DIR || DEFAULT_DATA_DIR;
}

export interface LockInfo {
  pid: number;
  startedAt: string;
  version: string;
}

export interface LockResult {
  acquired: boolean;
  /** The live process already using this directory, when there is one. */
  heldBy?: LockInfo;
}

/**
 * Whether a pid belongs to a process that still exists.
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. EPERM means the process is alive but owned by someone else, which
 * still counts as "in use".
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function lockPath(dataDir: string): string {
  return join(dataDir, LOCK_FILE);
}

/** The live holder of this data dir, or null if nobody holds it. */
export function readDataDirLock(dataDir: string): LockInfo | null {
  let raw: string;
  try {
    raw = readFileSync(lockPath(dataDir), 'utf8');
  } catch {
    return null;
  }

  let info: LockInfo;
  try {
    info = JSON.parse(raw) as LockInfo;
  } catch {
    // A truncated or hand-edited file tells us nothing; treat it as absent.
    return null;
  }

  if (typeof info?.pid !== 'number' || !isAlive(info.pid)) return null;
  return info;
}

/**
 * Claim this data dir, or report who already has it.
 *
 * Advisory on purpose. Two servers sharing an `ACTUAL_DATA_DIR` push the budget
 * into `out-of-sync` (#47), but refusing to start would break setups that work
 * most of the time today, and a stale lock would leave someone unable to start
 * at all. So this never blocks: it records who is here, and lets the caller
 * explain the contention when something later fails.
 *
 * When another live process holds the lock its file is left untouched, so the
 * incumbent stays nameable in error messages rather than being overwritten by
 * whoever started last.
 */
export function acquireDataDirLock(dataDir: string, version: string): LockResult {
  const holder = readDataDirLock(dataDir);
  if (holder && holder.pid !== process.pid) {
    return { acquired: false, heldBy: holder };
  }

  const info: LockInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    version,
  };
  try {
    writeFileSync(lockPath(dataDir), JSON.stringify(info));
  } catch {
    // A missing or read-only directory must not stop the server: the lock is a
    // diagnostic aid, never a prerequisite.
  }
  return { acquired: true };
}

/** Drop our own lock. A lock held by anyone else is left alone. */
export function releaseDataDirLock(dataDir: string): void {
  try {
    const raw = readFileSync(lockPath(dataDir), 'utf8');
    if ((JSON.parse(raw) as LockInfo)?.pid !== process.pid) return;
    unlinkSync(lockPath(dataDir));
  } catch {
    // Nothing to release, or someone removed it first.
  }
}
