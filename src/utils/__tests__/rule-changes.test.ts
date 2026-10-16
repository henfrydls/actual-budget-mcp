import { describe, it, expect } from 'vitest';
import {
  changesMadeByRules,
  byRule,
  describeChange,
  describeSplitCategories,
  listChanges,
  type AskedRow,
} from '../rule-changes.js';
import type { SavedRow } from '../write-marker.js';

/** A saved row that matches the request below, so each test changes one thing. */
function savedRow(overrides: Partial<SavedRow> = {}): SavedRow {
  return {
    id: 'ours',
    account: 'acc-1',
    accountName: 'Checking',
    date: '2026-10-12',
    amount: -1500,
    payee: 'payee-1',
    payeeName: 'Cinema',
    notes: 'hola',
    cleared: false,
    category: null,
    categoryName: null,
    isParent: false,
    transferId: null,
    ...overrides,
  };
}

const asked: AskedRow = {
  date: '2026-10-12',
  amountCents: -1500,
  payee: 'Cinema',
  notes: 'hola',
  cleared: false,
};

describe('what a rule changed between asking and saving', () => {
  it('finds nothing when the row is the one that was asked for', () => {
    expect(changesMadeByRules(asked, savedRow())).toEqual({});
  });

  it('reads a payee written in another case as the same payee', () => {
    // Actual matches a payee name without case, so `payee: "cinema"` lands on
    // Cinema. Comparing the two as written would report every one of those as
    // a rule having changed the payee.
    expect(changesMadeByRules({ ...asked, payee: 'cinema' }, savedRow())).toEqual({});
    expect(changesMadeByRules({ ...asked, payee: '  Cinema ' }, savedRow())).toEqual({});
  });

  it('does not read a split parent as a rule having removed the payee', () => {
    // Measured: the parts carry the payee and the parent comes back with
    // none, so the parent is the wrong row to ask about it.
    const parent = savedRow({ isParent: true, payee: null, payeeName: null });
    expect(changesMadeByRules(asked, parent)).toEqual({});
  });

  it('says a rule set a payee when none was asked for', () => {
    const changes = changesMadeByRules({ ...asked, payee: undefined }, savedRow());
    expect(changes.payee).toEqual({ field: 'payee', actual: 'Cinema', asked: undefined });
    expect(byRule(changes.payee)).toBe(' (set by one of your rules)');
  });

  it('compares a transfer by the payee that links the two rows, not by name', () => {
    // A transfer payee is named after its account, so a comparison by name
    // would call a rewritten payee unchanged whenever it happened to share
    // the account's name.
    const transfer: AskedRow = {
      ...asked,
      payee: 'Savings',
      transferPayeeId: 'transfer-payee',
    };
    expect(
      changesMadeByRules(transfer, savedRow({ payee: 'transfer-payee', payeeName: 'Savings' })),
    ).toEqual({});
    expect(
      changesMadeByRules(transfer, savedRow({ payee: 'other-payee', payeeName: 'Savings' })).payee,
    ).toEqual({ field: 'payee', actual: 'Savings', asked: 'Savings' });
  });

  it('names a value a rule removed rather than leaving the line blank', () => {
    const changes = changesMadeByRules(asked, savedRow({ notes: null }));
    expect(changes.notes).toEqual({ field: 'notes', actual: 'none', asked: 'hola' });
  });

  it('reads the amount, the date and the cleared flag off the row', () => {
    const changes = changesMadeByRules(
      asked,
      savedRow({ amount: -550, date: '2026-01-05', cleared: true }),
    );
    expect(changes.amount).toEqual({ field: 'amount', actual: '-5.50', asked: '-15.00' });
    expect(changes.date).toEqual({ field: 'date', actual: '2026-01-05', asked: '2026-10-12' });
    expect(changes.cleared).toEqual({ field: 'cleared', actual: 'yes', asked: 'no' });
  });

  it('lists the changes in one order, whatever order they were found in', () => {
    const changes = changesMadeByRules(
      asked,
      savedRow({ cleared: true, amount: -550, notes: 'otra' }),
    );
    expect(listChanges(changes).map((c) => c.field)).toEqual(['amount', 'notes', 'cleared']);
  });

  it('writes a change next to its value, and again for a list', () => {
    const change = { field: 'amount' as const, actual: '-5.50', asked: '-4.40' };
    expect(byRule(change)).toBe(' (set by one of your rules, asked for -4.40)');
    expect(describeChange(change)).toBe('Amount: -5.50 (asked for -4.40)');
    expect(describeChange({ field: 'payee', actual: 'Theatre' })).toBe(
      'Payee: Theatre (nothing was asked for)',
    );
    expect(byRule(undefined), 'a value the caller chose says nothing').toBe('');
  });
});

/**
 * What a split's parts are filed under.
 *
 * The parent carries no category: measured against the engine, the engine
 * copies the parent's onto every part, so a category asked for is applied, on
 * the parts, and a rule that sets its own on a part wins there.
 */
describe('what the parts of a split are filed under', () => {
  const part = (id: string, category: string | null, name: string | null): SavedRow =>
    savedRow({ id, category, categoryName: name, isParent: false, parentId: 'parent' });

  it('names what every part carries, and who chose it', () => {
    expect(describeSplitCategories([part('a', 'c1', 'Fun')], 'c1')).toBe(
      'A rule split this into 1 part, under Fun.',
    );
    // Told apart by the id: a category a rule chose and one the caller asked
    // for are different things, and a rule can be wrong.
    expect(describeSplitCategories([part('a', 'c2', 'Bills')], 'c1')).toBe(
      'A rule split this into 1 part, under Bills (set by your rules).',
    );
    expect(
      describeSplitCategories([part('a', 'c1', 'Fun'), part('b', 'c2', 'Bills')], 'c1'),
    ).toBe('A rule split this into 2 parts, under Bills and Fun (Bills set by a rule).');
  });

  it('says when the parts have no category rather than inventing one', () => {
    expect(describeSplitCategories([part('a', null, null)], 'c1')).toBe(
      'A rule split this into 1 part, and it has no category.',
    );
    expect(
      describeSplitCategories([part('a', null, null), part('b', null, null)], undefined),
    ).toBe('A rule split this into 2 parts, and none of them has one.');
  });

  it('reads a part Actual is about to clear as having no category', () => {
    // A part that is itself a transfer between two accounts on the same side
    // of the budget loses its category after the row can first be read, so
    // the read is as early here as it is for a plain row.
    const parts = [part('a', 'c1', 'Fun'), part('b', 'c1', 'Fun')];
    // And why, rather than leaving it to be inferred from a part having no
    // category: the caller asked for one, and the reason it is not there is
    // the engine's rather than the rule's.
    expect(describeSplitCategories(parts, 'c1', new Set(['b']))).toBe(
      'A rule split this into 2 parts, 1 of them under Fun and the rest with no category.' +
        ' The category you asked for was not kept on 1 of them: Actual discards it on a part' +
        ' that moves between two accounts on the same side of your budget.',
    );
    expect(describeSplitCategories(parts, 'c1', new Set(['a', 'b']))).toBe(
      'A rule split this into 2 parts, and none of them has one.' +
        ' The category you asked for was not kept on any of them: Actual discards it on a part' +
        ' that moves between two accounts on the same side of your budget.',
    );
    // Nothing was asked for, so there is nothing to say was not kept.
    expect(describeSplitCategories(parts, undefined, new Set(['a', 'b']))).toBe(
      'A rule split this into 2 parts, and none of them has one.',
    );
  });

  it('says only that it was split when the parts could not be read', () => {
    expect(describeSplitCategories([], 'c1')).toBe(
      'A rule split this into parts, so its category lives on them.',
    );
  });
});
