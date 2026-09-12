import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const LOCK_FILE = '.actual-mcp-lock.json';

const APP_DIR = 'actual-budget-mcp';

/**
 * Where the budget cache lives when the user has not chosen a location.
 *
 * This used to be a hardcoded `/tmp/actual-budget-mcp-data`, which was wrong
 * twice over. `/tmp` is not a path on Windows — it resolves to `C:\tmp`, off the
 * current drive root, where writing may not even be permitted. And on Unix /tmp
 * is cleared on reboot, so every restart threw away the cache and forced a full
 * budget download; on a large budget that looks like a server that hangs on
 * startup.
 *
 * The per-platform user data directory fixes both: it is writable, it is where
 * each OS expects an application's cache to live, and it survives reboots.
 */
function platformDataDir(): string {
  const home = homedir();
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), APP_DIR);
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', APP_DIR);
  }
  return join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), APP_DIR);
}

/** The directory the server will actually open. */
export function effectiveDataDir(): string {
  return process.env.ACTUAL_DATA_DIR || platformDataDir();
}

/**
 * Make sure the cache directory exists before Actual is told to use it.
 *
 * `api.init()` accepts a missing directory happily; `downloadBudget()` then
 * fails with a bare `ENOENT ... scandir`. On a fresh machine the default lives
 * under /tmp, which is empty after every boot, so the very first run of a new
 * install failed every time — and the error names a file the user has never
 * heard of, so there is no way to guess that the fix is a mkdir. Worse, it
 * masks every other diagnostic: a wrong password and a wrong budget id both
 * surface as the same ENOENT, so none of the specific messages ever fire.
 *
 * Failure to create it is swallowed: Actual will raise a better-placed error
 * than anything we could invent here.
 */
export function ensureDataDirExists(dataDir: string): void {
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch {
    // Unwritable path, or a file where the directory should be.
  }
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
