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

/** The local names `ensureConnection` goes by in this file, aliases included. */
function localNames(file: ts.SourceFile): Set<string> {
  const names = new Set(['ensureConnection']);
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === 'ensureConnection') {
        names.add(element.name.text);
      }
    }
  }
  return names;
}

/** The called name, whether written `a.b()` or `b()`. */
function calleeName(call: ts.CallExpression): string | undefined {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

/** Wrappers that change nothing about when the promise is waited for. */
function transparent(node: ts.Node, child: ts.Node): boolean {
  if (ts.isConditionalExpression(node)) {
    // `await (flag ? ensureConnection() : Promise.resolve())`. Either branch
    // is the value being awaited; the condition is not.
    return node.whenTrue === child || node.whenFalse === child;
  }
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  );
}

/**
 * Callers that wait for the callback they are given.
 *
 * By hand, like the list in `unsettled-reads`: whether a function awaits what
 * it is handed is not in the tree. `tool` and `resource` are the MCP
 * registration, whose handler the SDK awaits, and `queueTransactionWrite`
 * runs its callback and returns the promise. Anything not on this list, such
 * as `setTimeout` or `forEach`, takes the callback and walks away.
 */
const AWAITS_ITS_CALLBACK = new Set(['tool', 'resource', 'queueTransactionWrite']);

/** `Promise.all`, `allSettled`, `race`, `any`: waiting on one waits on all. */
function isPromiseCombinator(call: ts.CallExpression): boolean {
  const e = call.expression;
  return (
    ts.isPropertyAccessExpression(e) &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === 'Promise' &&
    ['all', 'allSettled', 'race', 'any'].includes(e.name.text)
  );
}

/** The function a node lives in, or the file when it lives in none. */
function enclosingBody(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessor(current) ||
      ts.isSetAccessor(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return node.getSourceFile();
}

/**
 * Whether an `await` inside this function names this variable.
 *
 * Inside this one, not anywhere in the file: two functions can both call a
 * variable `open`, and one of them awaiting it says nothing about the other.
 */
function awaitedByName(scope: ts.Node, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isAwaitExpression(node)) {
      const mentions = (inner: ts.Node): void => {
        if (ts.isIdentifier(inner) && inner.text === name) found = true;
        else ts.forEachChild(inner, mentions);
      };
      mentions(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

/** Every call to `ensureConnection` in this source that nothing waits for. */
export function unawaitedCalls(source: string): number[] {
  const file = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  const names = localNames(file);
  const lines: number[] = [];

  const waited = (call: ts.CallExpression): boolean => {
    let node: ts.Node = call;
    let parent: ts.Node | undefined = node.parent;

    while (parent) {
      if (transparent(parent, node)) {
        node = parent;
        parent = parent.parent;
        continue;
      }
      // A `.then`/`.catch`/`.finally` chain: what matters is what happens to
      // the end of it, so climb to the outer call and keep asking.
      if (
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        ['then', 'catch', 'finally'].includes(parent.name.text) &&
        parent.parent &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent
      ) {
        node = parent.parent;
        parent = node.parent;
        continue;
      }
      if (ts.isAwaitExpression(parent)) return true;
      if (ts.isReturnStatement(parent)) return true;
      // `() => ensureConnection()` hands the promise to whoever has the
      // arrow, so the question moves to the arrow rather than being answered
      // by it: returned or awaited or handed to something that waits, yes;
      // given to `setTimeout` or `forEach`, no.
      if (ts.isArrowFunction(parent) && parent.body === node) {
        node = parent;
        parent = node.parent;
        continue;
      }
      if (
        ts.isCallExpression(parent) &&
        parent.arguments.includes(node as ts.Expression) &&
        AWAITS_ITS_CALLBACK.has(calleeName(parent) ?? '')
      ) {
        return true;
      }
      if (ts.isVoidExpression(parent)) return false;
      // An array on its way into `Promise.all([...])`: climb, and let the
      // combinator's own parent decide. An array going anywhere else is not
      // a wait, which is why this does not stop here.
      if (ts.isArrayLiteralExpression(parent)) {
        node = parent;
        parent = parent.parent;
        continue;
      }
      if (
        ts.isCallExpression(parent) &&
        isPromiseCombinator(parent) &&
        parent.arguments.includes(node as ts.Expression)
      ) {
        node = parent;
        parent = node.parent;
        continue;
      }
      // `const open = ensureConnection()` is fine if something awaits `open`.
      if (
        ts.isVariableDeclaration(parent) &&
        parent.initializer === node &&
        ts.isIdentifier(parent.name)
      ) {
        return awaitedByName(enclosingBody(parent), parent.name.text);
      }
      return false;
    }
    return false;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name !== undefined && names.has(name) && !waited(node)) {
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
 * does. It parses rather than matching text, for the reason `unsettled-reads`
 * gives at length: the first version of this was a shape test on the parent
 * node and an audit got past it five ways and made it cry wolf five more.
 *
 * What it would mean: resolving an account or a category against a budget
 * that is not open yet. That fails immediately and loudly rather than
 * corrupting anything, which is why this is about the suite being able to see
 * a class of mistake and not about a bug that exists today.
 */
describe('every call to ensureConnection is waited for', () => {
  const files = sourceFiles(SRC).filter((file) =>
    readFileSync(file, 'utf8').includes('ensureConnection('),
  );

  it('finds the files it is meant to be scanning', () => {
    // Without this the scan passes by finding nothing, which is how a guard
    // written as a loop over a glob fails silently.
    expect(files.length).toBeGreaterThan(20);
  });

  it('has none that is left to run on its own', () => {
    const offenders = files.flatMap((file) =>
      unawaitedCalls(readFileSync(file, 'utf8')).map((line) => `${relative(SRC, file)}:${line}`),
    );

    expect(
      offenders,
      'A tool that does not wait for the connection reads the budget before it is open. ' +
        'Write `await ensureConnection()`.\n' + offenders.join('\n'),
    ).toEqual([]);
  });

  /**
   * The guard, guarded. A scan that answers the wrong question reports
   * nothing for ever, and one that cries wolf gets switched off.
   */
  describe('what it counts as waiting', () => {
    const scan = (body: string) => unawaitedCalls(`async function f() { ${body} }`);

    it.each([
      ['a plain await', 'await ensureConnection();'],
      ['parentheses', 'await (ensureConnection());'],
      ['a cast', 'await (ensureConnection() as Promise<void>);'],
      ['a non-null assertion', 'await ensureConnection()!;'],
      ['a catch on the end', 'await ensureConnection().catch(() => undefined);'],
      ['a then on the end', 'await ensureConnection().then(() => 1);'],
      ['returning it', 'return ensureConnection();'],
      ['returning a chain', 'return ensureConnection().then(() => 1);'],
      ['a concise arrow body kept and called', 'const g = () => ensureConnection(); await g();'],
      ['a concise arrow body returned', 'return () => ensureConnection();'],
      ['a concise arrow body as a tool handler', "server.tool('t', 'd', {}, a, () => ensureConnection());"],
      ['a conditional branch', 'await (flag ? ensureConnection() : Promise.resolve());'],
      ['the other conditional branch', 'await (flag ? Promise.resolve() : ensureConnection());'],
      ['Promise.all', 'await Promise.all([ensureConnection(), g()]);'],
      ['Promise.allSettled', 'await Promise.allSettled([ensureConnection()]);'],
      ['a variable awaited later', 'const open = ensureConnection(); await open;'],
      ['a variable awaited inside Promise.all', 'const open = ensureConnection(); await Promise.all([open]);'],
    ])('accepts %s', (_what, body) => {
      expect(scan(body)).toEqual([]);
    });

    it.each([
      ['a bare call', 'ensureConnection();'],
      ['void', 'void ensureConnection();'],
      ['a catch with nothing waiting for it', 'ensureConnection().catch(() => undefined);'],
      ['a then with nothing waiting for it', 'ensureConnection().then(() => 1);'],
      ['Promise.all nobody awaits', 'Promise.all([ensureConnection(), g()]);'],
      ['an array that goes nowhere', 'const xs = [ensureConnection()];'],
      ['a variable nothing awaits', 'const open = ensureConnection(); use(open);'],
      ['an arrow handed to setTimeout', 'setTimeout(() => ensureConnection());'],
      ['an arrow handed to forEach', '[1].forEach(() => ensureConnection());'],
    ])('reports %s', (_what, body) => {
      expect(scan(body)).toEqual([1]);
    });

    it('reads a variable in the function it lives in, not in the file', () => {
      // Two functions can both call it `open`, and one of them awaiting it
      // says nothing about the other.
      const source = `
        async function one() { const open = ensureConnection(); use(open); }
        async function two() { const open = somethingElse(); await open; }
      `;

      expect(unawaitedCalls(source)).toEqual([2]);
    });

    it('sees it through a namespace and through an alias', () => {
      expect(unawaitedCalls('async function f() { conn.ensureConnection(); }')).toEqual([1]);
      expect(
        unawaitedCalls(
          "import { ensureConnection as open } from './connection.js';\nasync function f() { open(); }",
        ),
      ).toEqual([2]);
      expect(
        unawaitedCalls(
          "import { ensureConnection as open } from './connection.js';\nasync function f() { await open(); }",
        ),
      ).toEqual([]);
    });
  });
});
