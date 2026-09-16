import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../${name}`, import.meta.url)), 'utf8'));

const manifest = read('manifest.json') as { compatibility: { runtimes: { node: string } } };
const pkg = read('package.json') as { engines: { node: string } };

const floor = (range: string) => Number(range.replace(/[^0-9.]/g, '').split('.')[0]);

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

/**
 * The extension ships the same server the npm package does, so it cannot
 * require an older Node than the package supports: the code would not be
 * expected to run there. The reverse is allowed, and was true until 0.9.2 —
 * the package supported Node 20 while the bundle, bound by which SQLite
 * prebuilds exist, needed 22.
 */
describe('the two floors we publish', () => {
  it('never lets the extension claim a Node the package does not support', () => {
    expect(floor(manifest.compatibility.runtimes.node)).toBeGreaterThanOrEqual(
      floor(pkg.engines.node),
    );
  });

  it('keeps the package off versions with no SQLite prebuild', () => {
    // 20 (ABI 115) and 23 (131) have none. Installing there compiles from
    // source and needs a C++ toolchain, which is not a fair thing to require
    // of someone adding a budgeting tool to their chat client.
    expect(floor(pkg.engines.node)).toBeGreaterThanOrEqual(22);
  });
});
