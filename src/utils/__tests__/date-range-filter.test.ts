import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/**
 * A range written as one object keeps only its first bound.
 *
 * Measured against the engine on an account holding five consecutive days,
 * the 23rd to the 27th:
 *
 *   { date: { $gte: 24th, $lte: 26th } }   24 25 26 **27**
 *   { date: { $lte: 26th, $gte: 24th } }   23 24 25 26
 *   $and of the two                        24 25 26
 *
 * Each key works alone. Together in one object only the **first** is applied,
 * with no error, so which half of the range disappears depends on the order
 * someone happened to type the keys in. It is not special to dates either:
 * `$gt` with `$lt` on an amount behaves the same way.
 *
 * That has shipped twice: a duplicate check caught by a test before release,
 * and `reconcile_account`, where rows dated after the cutoff were offered as
 * explanations for a difference since 0.10.0 (#179).
 *
 * Both read correctly. There is nothing to notice in the code, and the only
 * thing that distinguishes the wrong form from the right one is the shape of
 * the literal, so that is what this looks at.
 *
 * Over the syntax tree rather than the text: written across two lines, with a
 * comment between the keys, or with the bounds in variables, a search for the
 * pair finds nothing and reports that all is well. The guard in
 * unsettled-reads.ts was defeated twice the same way before it was parsed.
 *
 * ## What it does not see, stated rather than discovered
 *
 * It reads literals as written. An object built up in a variable and then
 * spread into a filter, a key computed at run time, or bounds passed through
 * a helper of someone's own all pass it. None of those exist in `src` today,
 * and the single-key uses that do, in account-balance.ts, future-dated.ts and
 * reconcile-candidates.ts, are correct and stay quiet.
 */
describe('a date range in a query', () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        return entry === 'node_modules' ? [] : sources(full);
      }
      // `.mts` as well: a module written that way is still compiled into the
      // same server.
      return full.endsWith('.ts') || full.endsWith('.mts') ? [full] : [];
    });
  }

  /** The operators a range is built from, in either direction. */
  const RANGE_OPS = new Set(['$gt', '$gte', '$lt', '$lte']);

  /**
   * Object literals carrying more than one of them as siblings.
   *
   * Any two, not only `$gte` with `$lte`: the engine applies the first key it
   * finds whatever it is, so `{ $lt, $gt }` loses its lower bound exactly as
   * `{ $gte, $lte }` loses its upper one.
   */
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
        if (keys.filter((k) => RANGE_OPS.has(k)).length > 1) {
          lines.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return lines;
  }

  const files = sources('src');

  it('is never written with two range operators in one object', () => {
    const offenders = files
      .map((file) => ({ file, lines: bothBoundsInOneObject(file) }))
      .filter((f) => f.lines.length > 0)
      .map((f) => `${f.file}:${f.lines.join(',')}`);

    expect(
      offenders,
      'only the first of them is applied: use dateBetween, which wraps the two in $and',
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
