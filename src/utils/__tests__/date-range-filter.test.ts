import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findTwoBoundRanges } from '../range-filter-scan.js';

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
 * It reads literals as written, including a key spelled `['$gte']` or with
 * backticks, which is the same key written longer. What it does not see is an
 * object built up in a variable and then spread into a filter, a key whose
 * name is computed from something other than a literal, and bounds passed
 * through a helper of someone's own. None of those exist in `src` today, and
 * the single-key uses that do, in account-balance.ts, future-dated.ts and
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

  const files = sources('src');

  it('is never written with two range operators in one object', () => {
    const offenders = files
      .map((file) => ({ file, lines: findTwoBoundRanges(readFileSync(file, 'utf8'), file) }))
      .filter((f) => f.lines.length > 0)
      .map((f) => `${f.file}:${f.lines.join(',')}`);

    expect(
      offenders,
      'only the first of them is applied: use dateBetween, which wraps the two in $and',
    ).toEqual([]);
    // Thirty seconds, not the default five. This parses every source file in
    // the repository with the TypeScript compiler, which takes a couple of
    // seconds on an idle machine and more than five under a loaded one: it
    // timed out in a full run while passing on its own, and every file added
    // to src brings it closer. A guard that fails for being slow trains
    // people to re-run the suite until it is green, which is the opposite of
    // what a guard is for.
  }, 30_000);

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

  it('catches every way the pair can be written', () => {
    // Checked here rather than by planting each one in a real file: the shape
    // is what distinguishes the wrong form, and each of these reads as
    // correct.
    const caught = (code: string) => findTwoBoundRanges(code).length > 0;

    expect(caught('const f = { date: { $gte: a, $lte: b } };'), 'plain').toBe(true);
    expect(caught('const f = { date: { $lte: b, $gte: a } };'), 'other order').toBe(true);
    expect(caught("const f = { date: { '$gte': a, '$lte': b } };"), 'quoted').toBe(true);
    expect(caught("const f = { date: { ['$gte']: a, ['$lte']: b } };"), 'computed').toBe(true);
    expect(caught('const f = { date: { [`$gte`]: a, [`$lte`]: b } };'), 'backticks').toBe(true);
    expect(caught("const f = { date: { ['$gte']: a, $lte: b } };"), 'mixed').toBe(true);
    expect(caught('const f = { amount: { $gt: 1, $lt: 2 } };'), 'on an amount').toBe(true);
    expect(
      caught('const f = {\n  date: {\n    $gte: a,\n    // the upper end\n    $lte: b,\n  },\n};'),
      'across lines, with a comment between',
    ).toBe(true);
  });

  it('leaves a single bound, and the correct form, alone', () => {
    const caught = (code: string) => findTwoBoundRanges(code).length > 0;

    expect(caught('const f = { date: { $gte: a } };')).toBe(false);
    expect(caught('const f = { date: { $lte: b } };')).toBe(false);
    expect(caught('const f = { $and: [{ date: { $gte: a } }, { date: { $lte: b } }] };')).toBe(
      false,
    );
    // Two bounds on different fields of the same object are two filters, not
    // one range, and the engine applies both.
    expect(caught('const f = { date: { $gte: a }, amount: { $lte: b } };')).toBe(false);
  });

  it('reports where it found one', () => {
    const lines = findTwoBoundRanges('const a = 1;\nconst f = { date: { $gte: x, $lte: y } };');
    expect(lines).toEqual([2]);
  });
});
