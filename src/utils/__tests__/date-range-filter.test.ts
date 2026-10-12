import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/**
 * A date range written as one object drops its upper bound.
 *
 * Measured against the engine on an account holding five consecutive days,
 * the 23rd to the 27th:
 *
 *   { date: { $gte: 24th, $lte: 26th } }   24 25 26 **27**
 *   $and of the two                        24 25 26
 *
 * Each key works alone. Together in one object the `$lte` is ignored, with no
 * error, so a query asking for a window silently gets everything from its
 * start onwards. That has shipped twice: a duplicate check caught by a test
 * before release, and `reconcile_account`, where rows dated after the cutoff
 * were offered as explanations for a difference since 0.10.0 (#179).
 *
 * Both of those read correctly. There is nothing to notice in the code, and
 * the only thing that distinguishes the wrong form from the right one is the
 * shape of the literal, so that is what this looks at.
 *
 * Over the syntax tree rather than the text: written across two lines, or
 * with a comment between the keys, or with the bounds in variables, a search
 * for `$gte.*$lte` finds nothing and reports that all is well. The guard in
 * unsettled-reads.ts was defeated twice the same way before it was parsed.
 */
describe('a date range in a query', () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        return entry === 'node_modules' ? [] : sources(full);
      }
      return full.endsWith('.ts') ? [full] : [];
    });
  }

  /** Object literals that carry `$gte` and `$lte` as siblings. */
  function bothBoundsInOneObject(file: string): number[] {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const lines: number[] = [];

    const nameOf = (property: ts.ObjectLiteralElementLike): string | undefined => {
      const name = property.name;
      if (!name) return undefined;
      if (ts.isIdentifier(name)) return name.text;
      if (ts.isStringLiteral(name)) return name.text;
      return undefined;
    };

    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const keys = node.properties.map(nameOf).filter((k): k is string => k !== undefined);
        if (keys.includes('$gte') && keys.includes('$lte')) {
          lines.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return lines;
  }

  const files = sources('src');

  it('is never written with both bounds in one object', () => {
    const offenders = files
      .map((file) => ({ file, lines: bothBoundsInOneObject(file) }))
      .filter((f) => f.lines.length > 0)
      .map((f) => `${f.file}:${f.lines.join(',')}`);

    expect(
      offenders,
      'the upper bound is dropped: use dateBetween, which wraps the two in $and',
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    ).toEqual([]);
  });

  it('finds the form that does work, so this is not passing over nothing', () => {
    // A guard that parses correctly and matches nothing reports agreement
    // with an empty set. If `dateBetween` is renamed or stops using `$and`,
    // the check above goes on passing while nothing is being checked.
    const helper = files.filter((f) => f.endsWith(join('utils', 'transaction-query.ts')));
    expect(helper, 'transaction-query.ts is not where it was').toHaveLength(1);

    const text = readFileSync(helper[0], 'utf8');
    expect(text).toMatch(/\$and/);
    expect(text).toMatch(/\$gte/);
    expect(text).toMatch(/\$lte/);
    expect(text).toMatch(/export function dateBetween/);
  });

  it('is actually used for a window somewhere', () => {
    // The point of the helper is that the queries call it.
    const callers = files.filter(
      (f) => !f.includes('__tests__') && /dateBetween\s*\(/.test(readFileSync(f, 'utf8')),
    );
    expect(callers.length, 'nothing uses dateBetween').toBeGreaterThan(0);
  });
});
