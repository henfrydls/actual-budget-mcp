import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('@actual-app/api', () => ({
  default: {},
  utils: {
    amountToInteger: (a: number) => Math.round(a * 100),
    integerToAmount: (c: number) => c / 100,
  },
}));
vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
  getInternal: vi.fn(),
}));

import { registerAllTools } from '../../tools/index.js';

function countTools(env: Record<string, string>): number {
  for (const key of ['ACTUAL_TOOLSET', 'ACTUAL_READ_ONLY']) delete process.env[key];
  Object.assign(process.env, env);
  let count = 0;
  registerAllTools({ tool: () => { count += 1; } } as never);
  return count;
}

/**
 * The numbers written in prose, checked against the server (#222).
 *
 * "41 tools" and "the 17 everyday tools" are in the README, the manifest,
 * the registry entry and the Gemini extension, and nothing read them back.
 * A number in four files is a number that is wrong in four files the day a
 * tool is added, and the counts are the part of the claim that can be
 * checked exactly: the sizes come from `scripts/measure-toolset.mjs` and
 * move with every description, so they are not pinned here.
 */
describe('the tool counts the documentation quotes', () => {
  afterEach(() => {
    delete process.env.ACTUAL_TOOLSET;
    delete process.env.ACTUAL_READ_ONLY;
  });

  const files = {
    README: readFileSync('README.md', 'utf8'),
    manifest: readFileSync('manifest.json', 'utf8'),
    registry: readFileSync('server.json', 'utf8'),
    gemini: readFileSync('gemini-extension.json', 'utf8'),
  };

  it('matches what the server registers', () => {
    const full = countTools({});
    const chat = countTools({ ACTUAL_TOOLSET: 'chat' });
    const readOnly = countTools({ ACTUAL_READ_ONLY: '1' });
    const both = countTools({ ACTUAL_TOOLSET: 'chat', ACTUAL_READ_ONLY: '1' });

    // The table in the README, read as rows rather than as prose.
    expect(files.README).toContain(`| \`full\` (default) | ${full} |`);
    expect(files.README).toContain(`| \`chat\` | ${chat} |`);
    expect(files.README).toContain(`| \`chat\` with \`ACTUAL_READ_ONLY=1\` | ${both} |`);
    expect(files.README).toContain(`| \`full\` with \`ACTUAL_READ_ONLY=1\` | ${readOnly} |`);
    expect(files.README).toContain(`## Tools (${full})`);
    expect(files.README).toContain(`exposes only the ${readOnly} read, analysis and`);
    expect(files.README).toContain(`the ${chat} everyday tools instead of all ${full}`);

    for (const [where, text] of Object.entries(files)) {
      if (where === 'README') continue;
      expect(text, `${where} says how many the chat set has`).toContain(
        `${chat} everyday tools`,
      );
      expect(text, `${where} says how many there are in total`).toContain(`all ${full}`);
    }
  });
});
