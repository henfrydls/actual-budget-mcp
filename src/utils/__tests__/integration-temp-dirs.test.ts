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

  it('leaves the directories of the harness that has no pid in the name', () => {
    // Every branch and checkout without this sweep still names its
    // directories `actual-mcp-it-<random>`, and a random suffix can look like
    // a number. Reading one as a pid would delete a run going on elsewhere.
    root = mkdtempSync(join(tmpdir(), 'sweep-test-'));
    const older = ['actual-mcp-it-482913', 'actual-mcp-it-0x1a2b', 'actual-mcp-it-100e10'];
    for (const name of older) mkdirSync(join(root, name), { recursive: true });

    sweepFinishedRuns(root);

    for (const name of older) expect(existsSync(join(root, name)), name).toBe(true);
  });

  it('reads only digits as a pid', () => {
    root = mkdtempSync(join(tmpdir(), 'sweep-test-'));
    // `Number` takes both of these, and a random suffix can be either.
    const hex = join(root, `${PREFIX}0x1a2b-rest`);
    const exponent = join(root, `${PREFIX}100e10-rest`);
    mkdirSync(hex, { recursive: true });
    mkdirSync(exponent, { recursive: true });

    sweepFinishedRuns(root);

    expect(existsSync(hex)).toBe(true);
    expect(existsSync(exponent)).toBe(true);
  });

  it('removes directories and not files', () => {
    root = mkdtempSync(join(tmpdir(), 'sweep-test-'));
    const file = join(root, `${PREFIX}999999-stray.log`);
    writeFileSync(file, 'not ours to delete');

    sweepFinishedRuns(root);

    expect(existsSync(file)).toBe(true);
  });
});
