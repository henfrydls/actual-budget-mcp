import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const SRC = fileURLToPath(new URL('../../', import.meta.url));

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue;
      sourceFiles(full, found);
    } else if (entry.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

/** Every `ensureConnection()` call that nothing waits for. */
function unawaitedCalls(source: string): number[] {
  const file = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'ensureConnection'
    ) {
      const parent = node.parent;
      // `await ensureConnection()`, and the two other honest ways to wait for
      // it: handing the promise back, or putting it in a `Promise.all`.
      const waited =
        ts.isAwaitExpression(parent) ||
        ts.isReturnStatement(parent) ||
        ts.isArrayLiteralExpression(parent) ||
        (ts.isPropertyAccessExpression(parent) && parent.name.text === 'catch');
      if (!waited) {
        lines.push(file.getLineAndCharacterOfPosition(node.getStart()).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(file);
  return lines;
}

/**
 * That the connection is waited for, which no test could see (#102).
 *
 * Every tool starts with `await ensureConnection()`, and changing one to
 * `void ensureConnection()` passed the entire suite in both modes. The reason
 * is structural rather than an oversight in one file: every test mocks
 * `ensureConnection` to a resolved promise, so whether the caller waits makes
 * no difference to any of them. It was invisible at all of its call sites at
 * once.
 *
 * So this reads the sources, the way the guard on raw `q('transactions')`
 * does. It is one place, it costs nothing to maintain, and it catches the
 * whole class rather than the file somebody remembered.
 *
 * What it would mean: resolving an account or a category against a budget
 * that is not open yet. That fails immediately and loudly rather than
 * corrupting anything, which is why this is about the suite being able to see
 * a class of mistake and not about a bug that exists today.
 */
describe('every call to ensureConnection is waited for', () => {
  const files = sourceFiles(SRC).filter((file) => readFileSync(file, 'utf8').includes('ensureConnection('));

  it('finds the files it is meant to be scanning', () => {
    // Without this the scan passes by finding nothing, which is how a guard
    // written as a loop over a glob fails silently.
    expect(files.length).toBeGreaterThan(20);
  });

  it('has none that is left to run on its own', () => {
    const offenders = files.flatMap((file) =>
      unawaitedCalls(readFileSync(file, 'utf8')).map(
        (line) => `${relative(SRC, file)}:${line}`,
      ),
    );

    expect(
      offenders,
      'A tool that does not wait for the connection reads the budget before it is open. ' +
        'Write `await ensureConnection()`.\n' + offenders.join('\n'),
    ).toEqual([]);
  });

  it('can see the mistake it is looking for', () => {
    // The scan and its own test can both be right while the matcher looks for
    // the wrong thing, and then it reports nothing for ever.
    expect(unawaitedCalls('async function f() { void ensureConnection(); }')).toEqual([1]);
    expect(unawaitedCalls('async function f() { ensureConnection(); }')).toEqual([1]);
    expect(unawaitedCalls('async function f() { await ensureConnection(); }')).toEqual([]);
    expect(unawaitedCalls('function f() { return ensureConnection(); }')).toEqual([]);
    expect(
      unawaitedCalls('async function f() { await Promise.all([ensureConnection(), x()]); }'),
    ).toEqual([]);
  });
});
