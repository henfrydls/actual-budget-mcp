import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * How the entry point chooses between stdio and HTTP (#228).
 *
 * Read as source rather than run, for the same reason the other guards on
 * this file are: importing it starts a server, connects a transport and
 * opens a budget. What is checked here is the wiring that has no other
 * test, and each line is one a mutation can remove while the whole suite
 * stays green.
 */
describe('the entry point', () => {
  const entry = readFileSync('src/index.ts', 'utf8');

  it('watches stdin only when stdio is how the client left', () => {
    // An HTTP server's clients come and go over the network, and a
    // container started detached has no stdin: watching for its end would
    // shut the server down a moment after it came up. A stdio server that
    // stops watching is the regression in #219, where a desktop client that
    // went away left the process holding its data directory.
    expect(entry).toContain('stdin: overHttp ? undefined : process.stdin');
  });

  it('refuses to serve a configuration it cannot serve', () => {
    // The branch and what is inside it, because a condition turned off
    // leaves every line below it in place and unreachable.
    expect(entry).toMatch(
      /if \(http !== undefined && http\.config === undefined\) \{[\s\S]*?process\.exit\(1\)/,
    );
  });

  it('says so when the port is the only thing missing', () => {
    expect(entry).toMatch(/if \(halfConfigured\.length > 0\) \{[\s\S]*?process\.exit\(1\)/);
  });

  it('starts one transport or the other, never neither', () => {
    expect(entry).toMatch(
      /if \(http\?\.config !== undefined\) \{[\s\S]*?await startHttpServer\(config\)/,
    );
    expect(entry).toMatch(/\} else \{[\s\S]*?new StdioServerTransport\(\)/);
  });
});
