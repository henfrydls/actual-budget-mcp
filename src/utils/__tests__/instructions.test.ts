import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SERVER_INSTRUCTIONS } from '../instructions.js';

/**
 * What the server says about itself at connection (#222).
 *
 * The protocol has a field for it and this server left it empty, so every
 * convention that holds across the tools had to be inferred from the
 * descriptions or found out by getting it wrong. It is sent on every
 * connection, so it is checked for being short as well as for being there.
 */
describe('the server instructions', () => {
  it('are passed to the server rather than only defined', () => {
    // Read from the source because the entry point starts a server when it
    // is imported: it connects a transport and opens a budget.
    const entry = readFileSync('src/index.ts', 'utf8');

    expect(entry).toContain('instructions: SERVER_INSTRUCTIONS');
  });

  it('say the conventions a caller cannot infer from one description', () => {
    expect(SERVER_INSTRUCTIONS).toContain('114.06');
    expect(SERVER_INSTRUCTIONS).toContain('YYYY-MM');
    expect(SERVER_INSTRUCTIONS).toContain('confirm: true');
    expect(SERVER_INSTRUCTIONS).toContain('allow_duplicate');
    expect(SERVER_INSTRUCTIONS).toMatch(/ambiguous name is[\s\S]*refused/);
    expect(SERVER_INSTRUCTIONS).toContain('creates no transaction');
  });

  it('stay short, because they are sent on every connection', () => {
    // The tool list this was written beside is 37.0 KB. A paragraph that
    // grows into a manual spends the saving back.
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(1200);
    expect(SERVER_INSTRUCTIONS.split('\n').length).toBeLessThan(25);
  });
});
