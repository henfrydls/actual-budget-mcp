import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PREFIX, sweepFinishedRuns } from '../../tools/__tests__/integration/temp-run-dirs.js';

/**
 * The integration harness used to leave its temp directory behind (#101).
 *
 * It is removed in a `finally` that only runs when the suite reaches its
 * `afterAll`, so a run that is cancelled part way through, which is what
 * happens every time somebody stops a slow integration file, left a full
 * budget database in the temporary directory. Counted on one machine during
 * an afternoon of work: 22 of them, at around 2.3 MB each, reclaimed by
 * nothing.
 */
let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('sweeping the directories of runs that are over', () => {
  it('removes one whose owner is gone, with everything in it', () => {
    root = mkdtempSync(join(tmpdir(), 'sweep-test-'));
    const dead = join(root, `${PREFIX}999999-abcdef`);
    mkdirSync(dead, { recursive: true });
    writeFileSync(join(dead, 'db.sqlite'), 'a budget');

    sweepFinishedRuns(root);

    expect(existsSync(dead)).toBe(false);
  });

  it('leaves a run that is still going', () => {
    // By pid and not by age: a run that takes longer than whatever cut-off
    // an age rule picked would have its directory deleted underneath it.
    root = mkdtempSync(join(tmpdir(), 'sweep-test-'));
    const live = join(root, `${PREFIX}${process.pid}-abcdef`);
    mkdirSync(live, { recursive: true });

    sweepFinishedRuns(root);

    expect(existsSync(live)).toBe(true);
  });

  it('leaves anything that is not one of ours', () => {
    root = mkdtempSync(join(tmpdir(), 'sweep-test-'));
    const theirs = join(root, 'someone-elses-999999');
    const unnamed = join(root, `${PREFIX}not-a-pid`);
    mkdirSync(theirs, { recursive: true });
    mkdirSync(unnamed, { recursive: true });

    sweepFinishedRuns(root);

    expect(existsSync(theirs)).toBe(true);
    expect(existsSync(unnamed), 'a name it cannot read is not a name it owns').toBe(true);
  });
});
