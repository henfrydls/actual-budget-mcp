import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { findUnsettledReads } from '../unsettled-reads.js';

/**
 * Apply the detector to the tests that touch the real engine.
 *
 * It lives beside the detector rather than under `integration/` because that
 * directory is excluded from `--project unit`, so the survey never ran in the
 * fast loop, which is the loop people watch. It reads files and starts no
 * engine, so it belongs with the unit tests anyway.
 *
 * The detection itself lives in `src/utils/unsettled-reads.ts` and is tested
 * against its own evasions and false positives next to it, which is the part
 * the first version of this file lacked: it was a regex loop with no cover, and
 * four different ways of neutralising it left the suite green.
 *
 * It scans `describe.skip`ped files on purpose. The case that started this sits
 * in a smoke test behind an environment variable, so the files least likely to
 * be run are exactly the ones that need reading rather than running.
 */
function integrationTestFiles(): string[] {
  const root = path.join(process.cwd(), 'src');
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.test\.ts$/.test(entry.name) && /integration|e2e/.test(full)) found.push(full);
    }
  };
  walk(root);
  return found;
}

describe('reads that follow a write in a test must let it settle first', () => {
  it('finds the integration tests it is meant to be scanning', () => {
    // Without this the scan below passes by finding nothing, which is how a
    // guard written as a loop over a glob fails silently.
    expect(integrationTestFiles().length).toBeGreaterThan(5);
  });

  it('has no unsettled read after an update or a delete', () => {
    const offences = integrationTestFiles().flatMap((file) =>
      findUnsettledReads(fs.readFileSync(file, 'utf8')).map(
        (o) =>
          `${path.relative(process.cwd(), file)}:${o.line} writes, then reads at line ${o.readLine}`,
      ),
    );

    expect(
      offences,
      'A read issued too soon after an update or a delete returns the state from before it, ' +
        'so an assertion on it can hold whether or not the write happened. Put an await that ' +
        'reaches the next macrotask between them, or `await api.loadBudget(id)` if the test ' +
        'needs the budget reloaded anyway.\n' + offences.join('\n'),
    ).toEqual([]);
  });
});
