import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../manifest.json', import.meta.url)), 'utf8'),
) as { compatibility: { runtimes: { node: string } } };

/**
 * The bundle can only serve a Node whose ABI it carries a SQLite binary for.
 * better-sqlite3 publishes prebuilds for ABI 127, 137, 141 and 147, which is
 * Node 22, 24, 25 and 26. Node 20 and 23 have none, and a bundle cannot compile
 * one, so claiming them would promise what the artifact cannot do.
 *
 * The npm package's own floor is a separate question (#64): installing from npm
 * can compile, and a toolchain is a fair expectation there.
 */
describe('what the extension says it runs on', () => {
  it('claims no Node older than the oldest SQLite binary it ships', () => {
    expect(manifest.compatibility.runtimes.node).toBe('>=22.0.0');
  });
});
