import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { readEnv } from './env.js';
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

/** The directory the configuration asks for. */
export function effectiveDataDir(): string {
  return readEnv('ACTUAL_DATA_DIR') || platformDataDir();
}

/**
 * The directory this process actually holds, which is not always the
 * configured one: #71 has it step aside when a live server already holds that.
 *
 * Kept here rather than in the caller because the error messages need it too.
 * Reporting contention on the configured directory after stepping away from it
 * would name a directory this process is not touching, which is a confident
 * wrong answer of exactly the kind these messages exist to prevent.
 */
let activeDir: string | null = null;

export function activeDataDir(): string {
  return activeDir ?? effectiveDataDir();
}

export function forgetActiveDataDir(): void {
  activeDir = null;
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

  // Created exclusively so two servers starting at the same moment cannot both
  // decide the directory is free. That is not a rare race: it is what happens
  // when a machine boots and several clients launch their servers together,
  // which is exactly the case #71 is about. A plain write would let both win.
  try {
    writeFileSync(lockPath(dataDir), JSON.stringify(info), { flag: 'wx' });
    return { acquired: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
      // A missing or read-only directory must not stop the server: the lock is
      // a diagnostic aid, never a prerequisite.
      return { acquired: true };
    }
  }

  // The file existed. Either it is stale, in which case take it over, or
  // someone claimed it between our check and our write.
  const now = readDataDirLock(dataDir);
  if (now && now.pid !== process.pid) return { acquired: false, heldBy: now };
  try {
    writeFileSync(lockPath(dataDir), JSON.stringify(info));
  } catch {
    // As above: never a prerequisite.
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

/** Where the server ended up, and why, so the caller can say so once. */
export interface ClaimedDataDir {
  /** The directory to actually open. */
  dataDir: string;
  /** The configured directory, when it was in use and we stepped aside. */
  contended?: string;
  /** The live process holding the configured directory. */
  heldBy?: LockInfo;
  /**
   * Every live server this one stepped past, in the order it met them.
   *
   * The count is the point (#207). A server that lands on `-7` has six others
   * running against the same budget, each with a full copy of it on disk, and
   * "<dir> is in use" says none of that: in the live test of 0.10.7 one of
   * them had been running for three weeks.
   */
  others?: LockInfo[];
  /** True when every candidate was taken and we are sharing after all. */
  shared?: boolean;
}

/**
 * What to say at startup when this server is not on the first directory.
 *
 * The count, how long the oldest has been there, and what it costs. Not the
 * pids: what clears this is closing the sessions that left them, and a list
 * of numbers reads as something to go and kill one by one.
 *
 * Nothing is reclaimed on a guess. A directory whose holder is gone is taken
 * over already, which is `readDataDirLock` answering null for a pid that no
 * longer exists. What is left after that is a pid the system has handed to
 * something else, and telling that apart costs a platform-specific lookup
 * that can be wrong. Wrong puts two servers in one directory, which is the
 * thing this mechanism exists to prevent; right saves one download.
 */
export function crowdedNotice(claim: ClaimedDataDir): string | undefined {
  const others = claim.others ?? [];
  if (claim.contended === undefined || others.length === 0) return undefined;

  const total = others.length + 1;
  const oldest = others
    .map((other) => other.startedAt)
    .filter((at): at is string => typeof at === 'string' && at !== '')
    .sort()[0];
  const since = oldest === undefined ? '' : ` The oldest started on ${oldest.slice(0, 10)}.`;

  return (
    `${total} actual-budget-mcp servers are running against this budget, counting this ` +
    `one.${since} They are usually left over from sessions that were closed without ` +
    `stopping the server. This one is using ${claim.dataDir}, which holds its own copy ` +
    'of the budget: every one of them is a full download on disk and one more client ' +
    'writing to the same Actual server. Closing the ones you are not using is what ' +
    'clears this.'
  );
}

/**
 * How many siblings to try before giving up and sharing.
 *
 * Eight is far past any real setup: it means eight live servers on one machine
 * all pointed at the same directory. Past that, sharing is still better than
 * refusing to start.
 */
const MAX_SIBLINGS = 8;

/**
 * Claim a data directory, stepping aside instead of sharing a contended one.
 *
 * Two servers on one directory drive the budget `out-of-sync` (#47), and the
 * lock used to do nothing about it but say so on stderr. That was not enough,
 * and #71 has the measurement: four live servers on this project's own machine,
 * all configured with the same directory, one of them already holding the
 * budget open. The warning had been printed correctly every time and nobody had
 * ever seen it.
 *
 * The constraint from #47 still holds and is still right: never refuse to
 * start. A stale lock must never leave someone unable to run the server at all.
 * So this never blocks. It picks `<dir>-2`, `-3` and so on until it finds one
 * no live process holds, which means:
 *
 *   - one server, the common case, is untouched and keeps its warm cache
 *   - a second client pays one budget download and gets a correct budget
 *   - a directory whose lock names a dead process is reclaimed, not abandoned,
 *     so these do not pile up after a reboot
 *
 * Stepping aside applies to an explicitly configured ACTUAL_DATA_DIR too. That
 * is deliberate, and it is the case that actually bites: the four servers
 * measured in #71 all had it set to the same path. Honouring the setting to the
 * letter would mean corrupting the budget it points at.
 */
export function claimDataDir(version: string): ClaimedDataDir {
  const configured = effectiveDataDir();
  // Kept as they are met, so the startup line can say how many there are
  // rather than naming the first one and leaving the rest unsaid (#207).
  const others: LockInfo[] = [];

  for (let n = 1; n <= MAX_SIBLINGS; n++) {
    const candidate = n === 1 ? configured : `${configured}-${n}`;
    ensureDataDirExists(candidate);
    const lock = acquireDataDirLock(candidate, version);
    if (lock.acquired) {
      activeDir = candidate;
      return n === 1
        ? { dataDir: candidate }
        : {
            dataDir: candidate,
            contended: configured,
            heldBy: readDataDirLock(configured) ?? undefined,
            others,
          };
    }
    if (lock.heldBy) others.push(lock.heldBy);
  }

  // Everything is taken. Sharing is wrong, and not starting is worse.
  ensureDataDirExists(configured);
  activeDir = configured;
  return {
    dataDir: configured,
    contended: configured,
    heldBy: readDataDirLock(configured) ?? undefined,
    others,
    shared: true,
  };
}
