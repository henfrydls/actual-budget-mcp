import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ID_FIELDS, TEXT_OPS, LIST_FIELDS, isTextOpOnIdField, looksLikeAnId } from '../rule-fields.js';

/**
 * The list of id fields, against the engine's own.
 *
 * `FIELD_INFO` is where the engine says which rule fields hold an id, and it
 * is not exported, so the list in `rule-fields.ts` is written out by hand.
 * Written by hand from the three fields an issue happened to name, it missed
 * `category_group`, and a rule on that one fires on transactions in the group
 * it was written to exclude. Nothing in the suite noticed, because every test
 * used a field that was already in the list.
 *
 * So the list is checked against the installed copy of the engine. A new field
 * of type id in a later version fails this rather than passing quietly.
 */
describe('the fields Actual stores by id', () => {
  const bundle = (() => {
    // Resolved from the package's own entry point rather than by a path into
    // it: `exports` does not expose `dist/index.js`, so requiring that path
    // fails. The package entry is the file, so its directory is where to look.
    const require = createRequire(import.meta.url);
    const entry = require.resolve('@actual-app/api');
    return readFileSync(entry, 'utf8');
  })();

  /** The `name: { type: "id" ... }` entries inside the FIELD_INFO object. */
  function idFieldsFromEngine(): string[] {
    const start = bundle.indexOf('FIELD_INFO = {');
    expect(start, 'FIELD_INFO is not in the bundle any more, so this guard reads nothing').
      toBeGreaterThan(-1);
    // To the end of the object literal, which is the first line that closes it
    // at column zero in this build. Taking a generous window and parsing the
    // entries is enough, and does not depend on the exact formatting.
    const block = bundle.slice(start, start + 2000);
    const end = block.indexOf('\n};');
    expect(end, 'could not find the end of FIELD_INFO').toBeGreaterThan(-1);

    const fields: string[] = [];
    // Each entry is `name: {` followed by its properties, and `type: "..."` is
    // the first of them in every entry in this build.
    const entry = /(\w+):\s*\{\s*(?:\/\*[^*]*\*\/\s*)?type:\s*"(\w+)"/g;
    let match: RegExpExecArray | null;
    while ((match = entry.exec(block.slice(0, end))) !== null) {
      if (match[2] === 'id') fields.push(match[1]);
    }
    return fields;
  }

  it('finds enough of FIELD_INFO for the comparison to mean something', () => {
    // A guard that silently parses nothing is worse than no guard: it reports
    // agreement with an empty list.
    const found = idFieldsFromEngine();
    expect(found.length).toBeGreaterThanOrEqual(4);
    expect(found).toContain('payee');
  });

  it('lists exactly the id fields the engine does', () => {
    expect([...ID_FIELDS].sort()).toEqual(idFieldsFromEngine().sort());
  });

  it('leaves the string fields alone', () => {
    // `payee_name` and `imported_payee` are what the refusal points people at,
    // so sweeping either into the id list would take away the way out.
    for (const field of ['payee_name', 'imported_payee', 'notes']) {
      expect(ID_FIELDS.has(field), `${field} is a string field`).toBe(false);
      for (const op of TEXT_OPS) {
        expect(isTextOpOnIdField(field, op)).toBe(false);
      }
    }
  });

  it('refuses every text operator on every id field', () => {
    for (const field of ID_FIELDS) {
      for (const op of TEXT_OPS) expect(isTextOpOnIdField(field, op)).toBe(true);
    }
  });

  it('lists exactly the fields the engine takes a list on', () => {
    // Measured one rule at a time: the four id fields plus payee_name and
    // imported_payee. The engine's own table agrees, and says why: `notes`
    // disallows these operators by name, and the date, number and boolean
    // types do not offer them at all.
    const start = bundle.indexOf('FIELD_INFO = {');
    const block = bundle.slice(start, start + 2000);
    const end = block.indexOf('\n};');
    const body = block.slice(0, end);

    // Each entry runs from its own `name: {` to the next one, which handles
    // the one-line entries and the multi-line ones the same way. Matching an
    // entry's braces with a regex does not, and the first attempt at this
    // found only the four long ones and reported agreement with them.
    const starts = [...body.matchAll(/(\w+):\s*\{/g)];
    const takesList: string[] = [];
    starts.forEach((start, i) => {
      const from = start.index!;
      const to = i + 1 < starts.length ? starts[i + 1].index! : body.length;
      const inner = body.slice(from, to);
      const type = /type:\s*"(\w+)"/.exec(inner)?.[1];
      if (type !== 'id' && type !== 'string') return;
      if (/disallowedOps[\s\S]*?oneOf/.test(inner)) return;
      takesList.push(start[1]);
    });

    expect(takesList.length, 'the parse found nothing to compare').toBeGreaterThanOrEqual(6);
    expect([...LIST_FIELDS].sort()).toEqual(takesList.sort());
  });

  it('leaves the operators that work alone', () => {
    for (const field of ID_FIELDS) {
      for (const op of ['is', 'isNot', 'oneOf', 'notOneOf']) {
        expect(isTextOpOnIdField(field, op)).toBe(false);
      }
    }
  });

  it('tells an id apart from a name stored where an id belongs', () => {
    expect(looksLikeAnId('7f46d9e7-1b2c-4d3e-8f90-a1b2c3d4e5f6')).toBe(true);
    expect(looksLikeAnId('Checking')).toBe(false);
    expect(looksLikeAnId('')).toBe(false);
    // Close but not an id: a rule holding this was never pointing at anything.
    expect(looksLikeAnId('7f46d9e7-1b2c-4d3e-8f90')).toBe(false);
  });
});
