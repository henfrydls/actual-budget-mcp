import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

/**
 * The runtime check has to be called, and called before anything opens a
 * database.
 *
 * Its own guard because nothing else can be: what it prevents is a segfault on
 * a Node this machine is not running, so no test can exercise the real path.
 * Removing the call from `index.ts` left the whole suite green, which is the
 * same shape as the dead queue call an audit found in #111.
 */
describe('the Node check runs at startup', () => {
  const source = readFileSync('src/index.ts', 'utf8');
  const file = ts.createSourceFile('index.ts', source, ts.ScriptTarget.ES2022, true);

  /** Top-level calls, in the order they are evaluated. */
  const calls: Array<{ name: string; pos: number }> = [];
  const walk = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
      if (name) calls.push({ name, pos: node.getStart(file) });
    }
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(file, walk);

  it('is called at all', () => {
    // Parsed rather than searched: the comment above the call names it too.
    expect(calls.map((c) => c.name)).toContain('assertSupportedRuntime');
  });

  it('is called before the SQLite binding is touched', () => {
    const check = calls.find((c) => c.name === 'assertSupportedRuntime');
    const binding = calls.find((c) => c.name === 'ensureNativeBinding');

    expect(check, 'the startup check is gone').toBeDefined();
    expect(binding, 'the binding call changed name; update this test').toBeDefined();
    expect(check!.pos).toBeLessThan(binding!.pos);
  });
});
