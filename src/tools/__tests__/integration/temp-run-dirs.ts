import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The directory this run owns, named so another run can tell whose it is.
 *
 * Its own prefix, not the one `mkdtemp` used before this (#101). That one is
 * still in use by every branch and every checkout that does not have this
 * sweep, and their directories end in a random suffix: `actual-mcp-it-482913`
 * is a perfectly ordinary name for one, and reading 482913 as a pid would
 * have this delete a run that is going on elsewhere. Nothing writes this
 * prefix except a run that puts its pid after it.
 */
export const PREFIX = 'actual-mcp-itpid-';

/** Whether a pid belongs to a process that still exists. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Remove the directories left by runs that are over (#101).
 *
 * `shutdownTestEngine` removes this run's directory in a `finally`, and that
 * only runs when the suite reaches its `afterAll`. A run killed part way
 * through, which is what happens every time somebody cancels a slow
 * integration file or stops a mutation sweep, leaves a full budget database
 * behind: counted on one machine during an afternoon of work, 22 of them at
 * around 2.3 MB each, reclaimed by nothing until the system clears its
 * temporary directory.
 *
 * By pid rather than by age. A directory whose owner is gone is finished,
 * whatever o'clock it is, and a run that takes longer than whatever cut-off
 * an age rule picked would have its directory deleted underneath it. The pid
 * goes in the name for the same reason the data directory lock writes one:
 * it is the only thing that answers the question.
 */
export function sweepFinishedRuns(root: string = os.tmpdir()): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.startsWith(PREFIX)) continue;
    // Digits only, rather than whatever `Number` is willing to read: it takes
    // `0x1a2b` and `100e10` as numbers, and both are things a random suffix
    // can be.
    const owner = entry.slice(PREFIX.length).split('-')[0];
    if (!/^\d+$/.test(owner) || isAlive(Number(owner))) continue;
    const full = path.join(root, entry);
    try {
      // Directories only. A file that happens to carry the prefix was not
      // left by this harness, and removing it is not this function's business.
      if (!fs.statSync(full).isDirectory()) continue;
      fs.rmSync(full, { recursive: true, force: true });
    } catch {
      // Another run may be removing the same one. Nothing here is worth
      // failing a test over.
    }
  }
}

