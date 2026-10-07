import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The line people paste into issues.
 *
 * It said `sqlite=not-bundled` on a bundle carrying eight SQLite binaries,
 * because what it reports is whether an ABI-keyed binary was *installed* --
 * which, with N-API binaries, never happens and never needs to. Read on its
 * own in a bug report it says the opposite of the truth.
 *
 * Checked as source rather than by running the server: the line is printed at
 * module scope, before anything can be stubbed.
 */
describe('the startup diagnostic line', () => {
  const source = readFileSync('src/index.ts', 'utf8');

  it('does not call the ABI install status "sqlite"', () => {
    expect(source).not.toMatch(/sqlite=\$\{binding\.status\}/);
  });

  it('labels it for what it measures', () => {
    expect(source).toMatch(/abi-install=\$\{binding\.status\}/);
  });

  it('reports the N-API version, which is what decides whether it can run', () => {
    // The floor is an N-API floor; a reader looking at `abi 127` cannot tell
    // whether their Node is new enough, and that is the question.
    expect(source).toMatch(/napi \$\{process\.versions\.napi/);
  });
});
