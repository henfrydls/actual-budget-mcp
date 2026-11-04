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

/**
 * The file, with its line endings flattened.
 *
 * Windows checks these out with CRLF, and a regular expression looking for
 * `)\n` finds `)\r\n` instead: measured on the Windows runner, every
 * heading lost its count and the whole comparison went with it.
 */
function read(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

function registeredTools(env: Record<string, string> = {}): string[] {
  for (const key of ['ACTUAL_TOOLSET', 'ACTUAL_READ_ONLY', 'ACTUAL_BUDGET_IDS']) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  const names: string[] = [];
  registerAllTools({
    tool: (...args: unknown[]) => {
      if (typeof args[0] === 'string') names.push(args[0]);
    },
  } as never);
  return names;
}

function countTools(env: Record<string, string>): number {
  return registeredTools(env).length;
}

/**
 * The tool tables in the README, read as tables.
 *
 * `## Tools (n)` is one number and was already checked. What was not is the
 * subsections under it: `### Write: Transactions (11)` listed thirteen
 * tools, so the headings added up to forty-two while the rows added up to
 * forty-four, and nothing noticed because nothing read the rows.
 */
function readmeSections(): Array<{ name: string; stated: number | undefined; tools: string[] }> {
  const readme = read('README.md');
  const from = readme.indexOf('\n## Tools (');
  const section = readme.slice(from + 1);
  const to = section.indexOf('\n## ', 1);
  const tools = section.slice(0, to);

  // Split rather than one regex with a lookahead: `\\Z` is not an escape in
  // JavaScript, it is the letter Z, and a body that happened to contain one
  // ended there. That cost one section two of its rows.
  // Split rather than one regex with a lookahead: `\\Z` is not an escape in
  // JavaScript, it is the letter Z, and a body that happened to contain one
  // ended there. That cost one section two of its rows.
  //
  // A subsection with no count in its heading is prose rather than a table
  // of tools, and `### Environment` is the one there is. It is kept only
  // if it holds tool rows, so a table that loses its count fails here
  // rather than disappearing from the comparison.
  return tools
    .split(/^### /m)
    .slice(1)
    .map((chunk) => {
      const header = /^(.+?)(?: \((\d+)\))?\n/.exec(chunk);
      return {
        name: header?.[1] ?? chunk.slice(0, 20),
        stated: header?.[2] === undefined ? undefined : Number(header[2]),
        tools: [...chunk.matchAll(/^\| `([a-z_]+)`/gm)].map((row) => row[1]),
      };
    })
    .filter((section) => section.stated !== undefined || section.tools.length > 0);
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
    README: read('README.md'),
    manifest: read('manifest.json'),
    registry: read('server.json'),
    gemini: read('gemini-extension.json'),
  };

  it('lists every tool once, in a section whose count is its rows', () => {
    const registered = registeredTools();
    const sections = readmeSections();
    const listed = sections.flatMap((section) => section.tools);

    for (const section of sections) {
      expect(section.tools.length, `### ${section.name} says ${section.stated}`).toBe(
        section.stated,
      );
    }
    expect([...listed].sort()).toEqual([...registered].sort());
    expect(new Set(listed).size, 'a tool listed twice').toBe(listed.length);
  });

  it('does not count the tool that only exists with several budgets', () => {
    // `list_budgets` is registered when ACTUAL_BUDGET_IDS names more than
    // one budget, so it belongs in the prose and not in the tables: a count
    // that includes it is wrong for almost every reader.
    const many = registeredTools({ ACTUAL_BUDGET_IDS: 'one,two' });
    expect(many).toContain('list_budgets');

    const listed = readmeSections().flatMap((section) => section.tools);
    expect(listed).not.toContain('list_budgets');
    expect(files.README, 'the README says where it comes from').toContain('`list_budgets`');
  });

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
