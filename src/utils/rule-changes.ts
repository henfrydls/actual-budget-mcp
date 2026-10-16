import { formatMoney } from './money.js';
import type { SavedRow } from './write-marker.js';

/**
 * What a rule did to a transaction between asking for it and saving it.
 *
 * Actual runs the rules on every insert, so the row that lands can differ from
 * the row that was asked for. The reply used to read the request back, with
 * one line, the category, reading the row: one sentence spoke for the budget
 * and the rest spoke for the caller, and nothing said which was which (#184).
 *
 * Each field here was measured one at a time against the engine, with a rule
 * that changes exactly that field and nothing else:
 *
 *  - `set amount`, `set date`, `set payee`, `set cleared`, `set notes`,
 *    `prepend-notes` and `append-notes` all land before the row is saved, so
 *    the first read after the write already shows them.
 *  - `set account` does not. `addTransactions` builds the row it inserts as
 *    `{ id, ...trans, account: acctId }`, so the account argument is written
 *    over whatever the rule chose, and a transaction cannot be moved to
 *    another account on the way in. That is the engine's doing and not a
 *    coincidence, so there is no account comparison here; an integration test
 *    holds the engine to it.
 */
export interface AskedRow {
  date: string;
  amountCents: number;
  /** The payee the caller wrote, on an ordinary row. */
  payee?: string;
  /** The transfer payee's id, when the caller asked for a transfer. */
  transferPayeeId?: string;
  notes?: string;
  cleared: boolean;
}

export type ChangedField = 'amount' | 'date' | 'payee' | 'notes' | 'cleared';

export interface RuleChange {
  field: ChangedField;
  /** The value on the saved row, as it reads. */
  actual: string;
  /** What was asked for, absent when nothing was asked for. */
  asked?: string;
}

export type RuleChanges = Partial<Record<ChangedField, RuleChange>>;

/** The order a reply mentions them in, so two replies read the same way. */
export const CHANGED_FIELDS: ChangedField[] = [
  'amount',
  'date',
  'payee',
  'notes',
  'cleared',
];

export const FIELD_LABEL: Record<ChangedField, string> = {
  amount: 'Amount',
  date: 'Date',
  payee: 'Payee',
  notes: 'Notes',
  cleared: 'Cleared',
};

/** A value that is not there, said in a word rather than left blank. */
const NOTHING = 'none';

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

/** Two payee names are the same payee: Actual matches a name without case. */
function samePayeeName(a: string | null, b: string | undefined): boolean {
  const left = (a ?? '').trim().toLowerCase();
  const right = (b ?? '').trim().toLowerCase();
  return left === right;
}

export function changesMadeByRules(asked: AskedRow, saved: SavedRow): RuleChanges {
  const changes: RuleChanges = {};

  if (saved.amount !== asked.amountCents) {
    changes.amount = {
      field: 'amount',
      actual: formatMoney(saved.amount),
      asked: formatMoney(asked.amountCents),
    };
  }

  if (saved.date !== asked.date) {
    changes.date = { field: 'date', actual: saved.date, asked: asked.date };
  }

  // A split parent carries no payee: measured, the parts hold it and the
  // parent comes back with none. Comparing it would report every split as a
  // rule having removed the payee, which is the opposite of what happened.
  if (!saved.isParent) {
    if (asked.transferPayeeId) {
      // The caller named one of their accounts, so the payee that was asked
      // for is an id and nothing else links the two rows. Compared by id
      // rather than by name, because a transfer payee is named after its
      // account and would otherwise match the account's own name.
      if (saved.payee !== asked.transferPayeeId) {
        changes.payee = {
          field: 'payee',
          actual: saved.payeeName ?? NOTHING,
          asked: asked.payee,
        };
      }
    } else if (!samePayeeName(saved.payeeName, asked.payee)) {
      changes.payee = {
        field: 'payee',
        actual: saved.payeeName ?? NOTHING,
        // Absent when nothing was asked for, so the reply says a rule set a
        // payee rather than that it replaced one.
        asked: asked.payee,
      };
    }
  }

  if ((saved.notes ?? '') !== (asked.notes ?? '')) {
    changes.notes = {
      field: 'notes',
      actual: saved.notes ?? NOTHING,
      asked: asked.notes,
    };
  }

  if (saved.cleared !== asked.cleared) {
    changes.cleared = {
      field: 'cleared',
      actual: yesNo(saved.cleared),
      asked: yesNo(asked.cleared),
    };
  }

  return changes;
}

/** The changes in a fixed order, for a reply that lists them. */
export function listChanges(changes: RuleChanges): RuleChange[] {
  return CHANGED_FIELDS.map((field) => changes[field]).filter(
    (change): change is RuleChange => change !== undefined,
  );
}

/**
 * What to put after a value a rule decided, and nothing at all after one the
 * caller chose.
 *
 * The wording follows the category line, which has said this since 0.10.4: a
 * rule's choice is something that happened to the transaction, not something
 * that was asked for, and a rule can be wrong.
 */
export function byRule(change: RuleChange | undefined): string {
  if (!change) return '';
  if (change.asked === undefined) return ' (set by one of your rules)';
  return ` (set by one of your rules, asked for ${change.asked})`;
}

/**
 * One change, written for a list rather than for the line it belongs to.
 *
 * `create_transaction` puts the change next to the value it is about, so the
 * suffix says who decided it. A batch has no such line for every row, so each
 * change names its own field under a heading that has already said a rule did
 * this.
 */
export function describeChange(change: RuleChange): string {
  const asked =
    change.asked === undefined ? 'nothing was asked for' : `asked for ${change.asked}`;
  return `${FIELD_LABEL[change.field]}: ${change.actual} (${asked})`;
}

/**
 * The payee the parts of a split agree on, when they agree on one.
 *
 * A split parent carries no payee: measured against the engine, the engine
 * copies the parent's onto every part and leaves the parent with none, and a
 * rule can then set another one on the parts. So the parent is the wrong row
 * to ask, and reading it reported every split as a rule having removed the
 * payee, or as having left the one that was asked for, depending on which way
 * it was read.
 */
export function splitPayee(parts: SavedRow[]): {
  /** The part whose payee stands for the whole, or undefined if they differ. */
  agreed: SavedRow | undefined;
  /** Every payee the parts carry, in the order they came back. */
  names: Array<string | null>;
} {
  const names = [...new Set(parts.map((part) => part.payeeName))];
  return {
    agreed: names.length === 1 ? parts.find((part) => part.payeeName === names[0]) : undefined,
    names,
  };
}

/**
 * The row that stands for the transaction, for comparing against the request.
 *
 * The same row for anything that is not a split. For a split, the parts' payee
 * when they agree on one; when they do not, the parent is returned unchanged
 * and the payee is left uncompared, because nothing single stands for it.
 */
export function rowForComparison(saved: SavedRow, parts: SavedRow[]): SavedRow {
  if (!saved.isParent) return saved;
  const { agreed } = splitPayee(parts);
  if (!agreed) return saved;
  return { ...saved, isParent: false, payee: agreed.payee, payeeName: agreed.payeeName };
}

/**
 * What a split's parts are filed under, said from the parts.
 *
 * Measured against the engine: `makeChild` copies the parent's category onto
 * every part, so a category asked for is applied, on the parts, and the
 * parent comes back with none. A rule can then set its own category on a
 * part, and that part keeps the rule's. The reply used to say the category
 * had not been applied, which was false either way.
 */
export function describeSplitCategories(
  allParts: SavedRow[],
  asked: string | undefined,
  cleared: Set<string> = new Set(),
): string {
  // A part Actual is about to take the category off has none, however it
  // reads right now.
  const parts = allParts.map((part) =>
    cleared.has(part.id) ? { ...part, category: null, categoryName: null } : part,
  );
  const count = parts.length;
  if (count === 0) {
    // The parts could not be read. The split is a fact of the parent row.
    return 'A rule split this into parts, so its category lives on them.';
  }
  // Said rather than left to be inferred from a part having no category: the
  // caller asked for one and it is not on that part, and the reason is the
  // engine's, not the rule's.
  const discarded =
    cleared.size > 0 && asked !== undefined
      ? ` The category you asked for was not kept on ${cleared.size === count ? (count === 1 ? 'it' : 'any of them') : `${cleared.size} of them`}: Actual discards it on a part that moves between two accounts on the same side of your budget.`
      : '';
  const head = `A rule split this into ${count} part${count === 1 ? '' : 's'}`;
  const named = parts.filter((part) => part.categoryName !== null);
  const names = [...new Set(named.map((part) => part.categoryName as string))].sort();
  if (names.length === 0) {
    return `${head}, and ${count === 1 ? 'it has no category' : 'none of them has one'}.${discarded}`;
  }
  const list = (of: string[]) =>
    of.length === 1 ? of[0] : `${of.slice(0, -1).join(', ')} and ${of[of.length - 1]}`;
  // Which of them a rule chose, told apart by the id rather than by the name,
  // and said out loud: a category the caller asked for and one a rule put
  // there are different things, and a rule can be wrong.
  const fromRules = [
    ...new Set(
      named.filter((part) => part.category !== asked).map((part) => part.categoryName as string),
    ),
  ].sort();
  const credit =
    fromRules.length === 0
      ? ''
      : fromRules.length === names.length
        ? ' (set by your rules)'
        : ` (${list(fromRules)} set by ${fromRules.length === 1 ? 'a rule' : 'your rules'})`;
  if (named.length === count) {
    return `${head}, under ${list(names)}${credit}.${discarded}`;
  }
  return `${head}, ${named.length} of them under ${list(names)}${credit} and the rest with no category.${discarded}`;
}

