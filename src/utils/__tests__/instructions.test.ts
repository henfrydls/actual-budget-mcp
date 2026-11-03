import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { serverInstructions } from '../instructions.js';

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
    // is imported: it connects a transport and opens a budget. The factory
    // is where every server is built, stdio's one and HTTP's one per
    // request (#228), so this is the one place the field can go missing.
    const factory = readFileSync('src/mcp-server.ts', 'utf8');

    expect(factory).toContain('instructions: serverInstructions(');
    // Read-only decides what the instructions say, and in HTTP mode the read
    // path is read-only whatever the process is allowed to do.
    expect(factory).toContain('serverInstructions({ readOnly })');
    expect(factory).toContain('options.readOnly ?? isReadOnly()');
  });

  it('say the conventions a caller cannot infer from one description', () => {
    const instructions = serverInstructions();

    expect(instructions).toContain('25.50');
    expect(instructions).toContain('YYYY-MM');
    expect(instructions).toContain('confirm: true');
    expect(instructions).toContain('allow_duplicate');
    expect(instructions).toMatch(/ambiguous name is[\s\S]*refused, with the ids/);
    expect(instructions).toContain('creates no transaction');
  });

  it('leave out what read-only takes away', () => {
    // Every write tool is hidden there, so a paragraph about what a delete
    // previews and when a duplicate is refused describes tools the client
    // cannot see.
    const instructions = serverInstructions({ readOnly: true });

    expect(instructions).toContain('running read-only');
    expect(instructions).not.toMatch(/delete|duplicate|confirm: true|allow_duplicate/i);
    // What survives is how anything is named and how a read behaves.
    expect(instructions).toContain('YYYY-MM');
    expect(instructions).toContain('ambiguous name');
    expect(instructions).toContain("A read pulls the server's changes first");
  });

  it('stay short, because they are sent on every connection', () => {
    // The tool list this was written beside is 37.0 KB. A paragraph that
    // grows into a manual spends the saving back.
    expect(serverInstructions().length).toBeLessThan(1200);
    expect(serverInstructions().split('\n').length).toBeLessThan(25);
  });
});
