import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { DEFAULT_HTTP_TIMEOUT_MS } from '../http-timeout.js';

/**
 * The deadline from #99 only works if it is installed before the SDK loads.
 *
 * `@actual-app/api` captures `var fetch$1 = globalThis.fetch` when its bundle
 * is evaluated, so a wrapper installed afterwards is never seen. ES modules
 * evaluate in import order, which makes the position of one line in
 * `src/index.ts` load-bearing.
 *
 * Nothing said so until this test. The other tests for the wrapper call
 * `installHttpTimeout` themselves, so every one of them would stay green with
 * the import moved to the bottom of the file and the fix silently undone — the
 * shape that keeps turning up here: the module is tested, the wire to it is
 * not.
 */
describe('the fetch deadline installs itself, and says what it does', () => {
  it('installs on import, not only when someone calls it', () => {
    // Every other test here calls `installHttpTimeout` itself, so deleting the
    // call at the bottom of the module — the one that makes importing it do
    // anything — killed nothing. Parsed rather than searched: the module's own
    // comments describe the call.
    const source = readFileSync('src/utils/http-timeout.ts', 'utf8');
    const parsed = ts.createSourceFile('http-timeout.ts', source, ts.ScriptTarget.ES2022, true);

    const installsAtTopLevel = parsed.statements.some(
      (node) =>
        ts.isExpressionStatement(node) &&
        ts.isCallExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'installHttpTimeout',
    );

    expect(installsAtTopLevel, 'importing the module must install the deadline').toBe(true);
  });

  it('documents the default it actually uses', () => {
    // The default is a number someone reads in the README and then relies on.
    // A test comparing the constant to itself would pass with either changed,
    // so this compares the code to the documentation.
    const readme = readFileSync('README.md', 'utf8');
    const documented = readme.match(/ACTUAL_HTTP_TIMEOUT_MS[^\n]*default (\d+)/);

    expect(documented, 'the README must state the default').not.toBeNull();
    expect(Number(documented?.[1])).toBe(DEFAULT_HTTP_TIMEOUT_MS);
  });
});

/**
 * Both entry points, not just the server.
 *
 * `test:connection` was left out of the first version and an audit found it:
 * it is the command someone runs *because* the server is not answering, so it
 * was the one place still waiting five minutes to say so. Listing them here
 * rather than checking one means a third entry point has to be added on
 * purpose.
 */
const ENTRY_POINTS = ['src/index.ts', 'src/test-connection.ts'];

describe.each(ENTRY_POINTS)('the fetch deadline is installed before the SDK loads in %s (#99)', (entry) => {
  const source = readFileSync(entry, 'utf8');
  const file = ts.createSourceFile(entry, source, ts.ScriptTarget.ES2022, true);

  /** Every module specifier in the entry point, in the order they are evaluated. */
  const specifiers = file.statements
    .filter(ts.isImportDeclaration)
    .map((node) => (node.moduleSpecifier as ts.StringLiteral).text);

  it('is imported, and for its side effect', () => {
    expect(specifiers).toContain('./utils/http-timeout.js');
    // A side-effect import: giving it a binding would invite someone to "tidy
    // it up" by moving it in with the others.
    const declaration = file.statements
      .filter(ts.isImportDeclaration)
      .find((node) => (node.moduleSpecifier as ts.StringLiteral).text === './utils/http-timeout.js');
    expect(declaration?.importClause).toBeUndefined();
  });

  it('comes before anything that can reach @actual-app/api', () => {
    const ours = specifiers.indexOf('./utils/http-timeout.js');
    expect(ours).toBeGreaterThanOrEqual(0);

    // The whole graph, not one level. `./tools/index.js` imports no SDK
    // itself: it imports the tools, and they do. An audit asked whether this
    // walked one level or all of them, and measuring answered it — with a
    // single level, moving the deadline import to just after
    // `./tools/index.js` left this test green while the fix was undone, which
    // is the most likely place for someone to move it to.
    //
    // Parsed, not searched. A first version asked whether a file contained the
    // string `@actual-app/api`, and the deadline module's own comment explains
    // what the SDK does, so it matched itself and the test failed on correct
    // code. Same mistake as the scanner in #110: prose is not code.
    const importsOf = (filePath: string): string[] => {
      try {
        const text = readFileSync(filePath, 'utf8');
        const parsed = ts.createSourceFile(filePath, text, ts.ScriptTarget.ES2022, true);
        return parsed.statements
          .filter(ts.isImportDeclaration)
          .map((node) => (node.moduleSpecifier as ts.StringLiteral).text);
      } catch {
        return [];
      }
    };

    /** `./tools/index.js` seen from `src/index.ts` is `src/tools/index.ts`. */
    const resolve = (fromFile: string, spec: string): string => {
      const dir = fromFile.slice(0, fromFile.lastIndexOf('/'));
      const joined = `${dir}/${spec}`.replace(/\/\.\//g, '/');
      const parts: string[] = [];
      for (const part of joined.split('/')) {
        if (part === '..') parts.pop();
        else if (part !== '.') parts.push(part);
      }
      return parts.join('/').replace(/\.js$/, '.ts');
    };

    const reaches = (fromFile: string, spec: string, seen = new Set<string>()): boolean => {
      if (spec === '@actual-app/api') return true;
      if (!spec.startsWith('.')) return false;
      const target = resolve(fromFile, spec);
      // A cycle is not a path to the SDK, and following one forever is worse
      // than missing it.
      if (seen.has(target)) return false;
      seen.add(target);
      return importsOf(target).some((child) => reaches(target, child, seen));
    };

    const reachesSdk = specifiers.filter((spec) => reaches(entry, spec));

    // The test must have something to check, or the loop below is vacuous.
    expect(reachesSdk.length, 'no import reaches the SDK at all').toBeGreaterThan(0);

    // Everything that reaches the SDK must come after. The assertion is
    // phrased on the index so a failure says which line moved.
    for (const spec of reachesSdk) {
      expect(specifiers.indexOf(spec), `${spec} must be imported after the deadline`).toBeGreaterThan(
        ours,
      );
    }

    // The list is built without regard to position, so moving the deadline
    // import to the bottom fails on the line above with the name of what now
    // precedes it. A first version filtered by position first, which made that
    // same move fail here instead, reporting "this test checked nothing" —
    // true, and not what had happened.
  });
});
