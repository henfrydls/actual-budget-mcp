import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The directory this run owns, named so another run can tell whose it is. */
export const PREFIX = 'actual-mcp-it-';

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
    const owner = Number(entry.slice(PREFIX.length).split('-')[0]);
    if (!Number.isInteger(owner) || owner <= 0 || isAlive(owner)) continue;
    try {
      fs.rmSync(path.join(root, entry), { recursive: true, force: true });
    } catch {
      // Another run may be removing the same one. Nothing here is worth
      // failing a test over.
    }
  }
}

