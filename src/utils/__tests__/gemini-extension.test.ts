import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../${name}`, import.meta.url)), 'utf8'));

/**
 * The Gemini CLI gallery reads `gemini-extension.json` from the repository root
 * at release time, so its version is a second copy of the package version.
 *
 * A second copy is how the server ended up reporting 0.4.2 for three releases
 * (#36). That one was fixed by reading package.json at runtime; a manifest a
 * third party parses cannot do that, so the drift is caught here instead.
 */
describe('gemini-extension.json', () => {
  it('declares the same version as package.json', () => {
    expect(read('gemini-extension.json').version).toBe(read('package.json').version);
  });

  it('runs the published package rather than a local path', () => {
    const server = read('gemini-extension.json').mcpServers.actual;

    expect(server.command).toBe('npx');
    expect(server.args).toContain('actual-budget-mcp');
  });

  it('marks every credential as sensitive, so nothing lands in plain settings', () => {
    const settings = read('gemini-extension.json').settings as Array<{
      envVar: string;
      sensitive?: boolean;
    }>;
    const secrets = settings.filter((s) =>
      ['ACTUAL_PASSWORD', 'ACTUAL_SESSION_TOKEN'].includes(s.envVar),
    );

    expect(secrets).toHaveLength(2);
    for (const s of secrets) expect(s.sensitive, `${s.envVar} is not marked sensitive`).toBe(true);
  });

  it('offers every environment variable the server actually reads', () => {
    const declared = (read('gemini-extension.json').settings as Array<{ envVar: string }>).map(
      (s) => s.envVar,
    );

    for (const required of ['ACTUAL_SERVER_URL', 'ACTUAL_BUDGET_ID']) {
      expect(declared, `${required} is missing from the manifest`).toContain(required);
    }
  });
});
