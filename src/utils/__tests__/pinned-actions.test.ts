import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// From this file, not from wherever the runner happened to start: the first
// version used a relative path and found nothing on the Windows job, so the
// guard passed by reading no files at all.
const WORKFLOWS = fileURLToPath(new URL('../../../.github/workflows', import.meta.url));

/** Every `uses:` in every workflow, with where it is, for a message worth reading. */
function usesLines(): Array<{ file: string; line: number; value: string }> {
  const found: Array<{ file: string; line: number; value: string }> = [];
  for (const file of readdirSync(WORKFLOWS)) {
    if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
    readFileSync(join(WORKFLOWS, file), 'utf8')
      // `\r` and all: a checkout with CRLF endings would otherwise leave one
      // on the end of every line, where it is invisible and fails the match.
      .split(/\r?\n/)
      .forEach((text, index) => {
        const match = /^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/.exec(text);
        if (match) found.push({ file, line: index + 1, value: `${match[1]}${match[2]}` });
      });
  }
  return found;
}

/**
 * Actions pinned to a commit, not to a tag (#224).
 *
 * A tag is a label somebody can move, so `actions/checkout@v4` is a promise
 * that whatever is at `v4` tomorrow is what runs with this repository's
 * token. A commit cannot be moved. The tag goes in a comment so the pin can
 * still be read, and Dependabot raises it from there.
 */
describe('the actions these workflows run', () => {
  const lines = usesLines();

  it('finds the workflows it is meant to be reading', () => {
    // Without this the check below passes by finding nothing, which is how a
    // guard written as a loop over a glob fails silently.
    expect(lines.length).toBeGreaterThan(10);
  });

  it.each(lines.map((l) => [`${l.file}:${l.line}`, l.value] as const))(
    '%s is pinned to a commit, with the version it is',
    (_where, value) => {
      expect(value, 'pin it to a commit SHA, with the tag in a comment').toMatch(
        /^[\w.-]+\/[\w.-]+(?:\/[\w.-]+)*@[0-9a-f]{40} # v\d+\.\d+\.\d+$/,
      );
    },
  );
});

/**
 * And that something raises the pins (#224).
 *
 * A pin nobody updates is last year's action running for ever, which is the
 * other half of the same decision.
 */
describe('what keeps the pins current', () => {
  it('has Dependabot watching the actions', () => {
    const config = readFileSync(
      fileURLToPath(new URL('../../../.github/dependabot.yml', import.meta.url)),
      'utf8',
    );

    expect(config).toMatch(/package-ecosystem:\s*github-actions/);
  });
});
