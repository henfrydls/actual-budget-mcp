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
