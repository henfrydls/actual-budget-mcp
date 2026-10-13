import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  BOOLEAN_FIELDS,
  BOOLEAN_OPS,
  ID_FIELDS,
  LIST_FIELDS,
  MATCHABLE_FIELDS,
  NUMBER_FIELDS,
  RULE_FIELDS,
  TEXT_OPS,
  describeBooleanField,
  isTextOpOnIdField,
  looksLikeAnId,
  refuseListOnField,
  refuseListValue,
  refuseMatchingField,
  refuseOpOnBoolean,
} from '../rule-fields.js';

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

  /** The `name: { type: "number" ... }` entries, the same way. */
  function numberFieldsFromEngine(): string[] {
    const start = bundle.indexOf('FIELD_INFO = {');
    const block = bundle.slice(start, start + 2000);
    const end = block.indexOf('\n};');
    const fields: string[] = [];
    const entry = /(\w+):\s*\{\s*(?:\/\*[^*]*\*\/\s*)?type:\s*"(\w+)"/g;
    let match: RegExpExecArray | null;
    while ((match = entry.exec(block.slice(0, end))) !== null) {
      if (match[2] === 'number') fields.push(match[1]);
    }
    return fields;
  }

  it('lists exactly the numeric fields the engine does', () => {
    // These are formatted as money (#182), so a numeric field that is not an
    // amount would start being printed as currency. One field today, and the
    // comparison is what keeps that true.
    const found = numberFieldsFromEngine();
    expect(found.length, 'the parse found no numeric field at all').toBeGreaterThan(0);
    expect([...NUMBER_FIELDS].sort()).toEqual(found.sort());
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

  /** The `name: { type: "boolean" ... }` entries, the same way. */
  function booleanFieldsFromEngine(): string[] {
    const start = bundle.indexOf('FIELD_INFO = {');
    const block = bundle.slice(start, start + 2000);
    const end = block.indexOf('\n};');
    const fields: string[] = [];
    const entry = /(\w+):\s*\{\s*(?:\/\*[^*]*\*\/\s*)?type:\s*"(\w+)"/g;
    let match: RegExpExecArray | null;
    while ((match = entry.exec(block.slice(0, end))) !== null) {
      if (match[2] === 'boolean') fields.push(match[1]);
    }
    return fields;
  }

  it('lists exactly the boolean fields the engine does', () => {
    // The issue that reported this named `cleared` and `reconciled`, and the
    // engine has two more. A list written from the fields an issue happens to
    // mention is how `category_group` was missed above, and the fields missed
    // here are the two a rule must never set (#187).
    const found = booleanFieldsFromEngine();
    expect(found.length, 'the parse found no boolean field at all').toBeGreaterThan(0);
    expect([...BOOLEAN_FIELDS].sort()).toEqual(found.sort());
  });

  it('offers exactly the operators the engine takes on a boolean', () => {
    // `TYPE_INFO` is where the engine says which operators each type takes,
    // and the boolean type takes one. Measured as well, one rule per operator
    // on `cleared`: everything but `is` comes back as a bare refusal. If a
    // later version adds `isNot` there, this fails and the advice can change.
    const start = bundle.indexOf('var TYPE_INFO = {');
    expect(start, 'TYPE_INFO is not in the bundle any more').toBeGreaterThan(-1);
    const block = bundle.slice(start, bundle.indexOf('var FIELD_INFO = {', start));
    const entry = /boolean:\s*\{\s*ops:\s*\[([^\]]*)\]/.exec(block);
    expect(entry, 'the boolean type is not in TYPE_INFO any more').not.toBeNull();

    const ops = [...entry![1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
    expect(ops.length, 'the parse found no operator at all').toBeGreaterThan(0);
    expect([...BOOLEAN_OPS].sort()).toEqual(ops.sort());
  });

  it('has words for every boolean field', () => {
    // The reply and the refusals are built from this, so a field with no entry
    // is said back as "undefined" in the one sentence written to be read.
    for (const field of BOOLEAN_FIELDS) {
      expect(describeBooleanField(field), `${field} has no words`).toBeTypeOf('string');
    }
  });

  /** Every name in FIELD_INFO, whatever its type. */
  function ruleFieldsFromEngine(): string[] {
    const start = bundle.indexOf('FIELD_INFO = {');
    const block = bundle.slice(start, start + 2000);
    const end = block.indexOf('\n};');
    const entry = /(\w+):\s*\{\s*(?:\/\*[^*]*\*\/\s*)?type:\s*"(\w+)"/g;
    return [...block.slice(0, end).matchAll(entry)].map((m) => m[1]);
  }

  /** The columns the engine keeps on a transaction. */
  function transactionColumnsFromEngine(): string[] {
    const start = bundle.indexOf('var schema = {');
    expect(start, 'the engine schema is not in the bundle any more').toBeGreaterThan(-1);
    const table = bundle.indexOf('transactions: {', start);
    expect(table, 'the transactions table is not in the schema any more').toBeGreaterThan(-1);
    const body = bundle.slice(table, bundle.indexOf('\n\t},', table));
    return [...body.matchAll(/^\t\t(\w+): f\(/gm)].map((m) => m[1]);
  }

  it('knows every field the engine has a rule field for', () => {
    // Not to use them all: three of these can never be matched on. It is so
    // that a field added in a later version is refused by its name here
    // instead of falling through as one Actual has never heard of.
    const found = ruleFieldsFromEngine();
    expect(found.length, 'the parse found no field at all').toBeGreaterThan(10);
    expect([...RULE_FIELDS].sort()).toEqual(found.sort());
  });

  it('lists exactly the fields a condition can be answered on', () => {
    // A rule is evaluated against a transaction row plus what
    // `prepareTransactionForRules` puts on it. Anything else in FIELD_INFO is
    // answered `undefined`, and `Condition.eval` returns false for that
    // without a word, so the rule is saved and never fires.
    const columns = new Set(transactionColumnsFromEngine());
    expect(columns.size, 'the parse found no column at all').toBeGreaterThan(10);

    const derived = new Set([
      ...[...RULE_FIELDS].filter((field) => columns.has(field)),
      'payee_name',
      'category_group',
    ]);
    expect([...MATCHABLE_FIELDS].sort()).toEqual([...derived].sort());
  });

  it('adds exactly the two fields the engine adds before a rule runs', () => {
    // The pair above is hand-written, and this is what holds it honest: the
    // function that prepares a transaction for the rules sets `payee_name`
    // and `category_group`, and nothing else a rule field is named after. If
    // a later version starts handing the rules a transfer or a split flag,
    // this fails and the refusal can be lifted.
    const from = bundle.indexOf('async function prepareTransactionForRules');
    expect(from, 'the engine no longer prepares a transaction for the rules').toBeGreaterThan(-1);
    const body = bundle.slice(from, bundle.indexOf('\n}', from));

    expect(body).toContain('r.payee_name = payee.name');
    expect(body).toContain('r.category_group = category.cat_group');
    for (const field of ['transfer', 'parent', 'saved']) {
      expect(body, `the engine now provides ${field}`).not.toContain(`r.${field} =`);
    }
  });

  it('refuses a field a condition cannot be answered on, and says which', () => {
    for (const field of ['transfer', 'parent', 'saved']) {
      const message = refuseMatchingField(field);
      expect(message, field).toContain('never runs the rule on its own');
      expect(message, field).toContain('cleared');
      // A field Actual knows is refused for a different reason than one it
      // does not, and saying the wrong one sends the reader to the wrong fix.
      expect(message, field).not.toContain('no rule field called');
    }

    const unknown = refuseMatchingField('banana');
    expect(unknown).toContain('no rule field called');
    expect(unknown).not.toContain('never runs the rule');
  });

  it('gives the reason the engine actually has, which is the name', () => {
    // The first version of this said a transaction knows about its transfer
    // only once the rules have run, which is not what was measured: a row
    // that already had its transfer_id does not match either. The engine
    // hands the rules `transfer_id` and `is_parent`, and a rule asks for
    // `transfer` and `parent`. That is all it is.
    expect(refuseMatchingField('transfer')).toContain('carries this as `transfer_id`');
    expect(refuseMatchingField('parent')).toContain('carries this as `is_parent`');
    for (const field of ['transfer', 'parent']) {
      expect(refuseMatchingField(field), field).not.toContain('once the rules have run');
    }
  });

  it('does not claim a rule can never match, only that Actual will not run it', () => {
    // `make-filters-from-conditions` turns `transfer is true` into
    // `transfer_id isNot null`, and `parent is true` into `is_parent true`,
    // so applying a rule by hand from the rules page does match. Saying it
    // never fires would be telling somebody to delete a rule that works in
    // the one place they may have made it.
    for (const field of ['transfer', 'parent']) {
      const message = refuseMatchingField(field);
      expect(message, field).toContain('by hand from the rules page');
      expect(message, field).not.toContain('never fire');
    }
  });

  it('says what the field was asking without doubling the punctuation', () => {
    for (const field of ['transfer', 'parent']) {
      expect(refuseMatchingField(field), field).not.toContain(',.');
    }
  });

  it('never points at an operator the field cannot take, whatever the refusal', () => {
    // `oneOf` is the general answer to a list, and on a boolean it is refused
    // outright, so offering it there is the same broken promise as `isNot`.
    for (const field of BOOLEAN_FIELDS) {
      const message = refuseListValue(field, 'is');
      expect(message, message).not.toContain('oneOf');
      expect(message, message).toContain('one value');
    }
    // Where a list does work, it is still the thing to say.
    expect(refuseListValue('payee', 'is')).toContain('oneOf');
  });

  it('never offers an operator a boolean field does not take', () => {
    // The list refusal used to send everyone to `is` or `isNot`, and the
    // engine does not accept `isNot` on a boolean: the way out of one bare
    // failure was another one.
    for (const field of BOOLEAN_FIELDS) {
      // Neither of these was asked about `isNot`, so the word appearing at all
      // is the tool offering it.
      for (const message of [
        refuseListOnField(field, 'oneOf'),
        refuseOpOnBoolean(field, 'contains'),
      ]) {
        expect(message, message).not.toContain('isNot');
        expect(message, message).toContain('`is`');
      }

      // And where it was asked about, it is named once, as the thing that does
      // not work, alongside the thing that does.
      const answer = refuseOpOnBoolean(field, 'isNot');
      expect(answer.match(/isNot/g), answer).toHaveLength(1);
      expect(answer, answer).toContain('`is` with false');
    }
  });
});
