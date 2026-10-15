import { randomUUID } from 'node:crypto';
import * as api from '@actual-app/api';
import { transactionsQuery } from './transaction-query.js';

/**
 * The id this server gives a transaction before writing it, so it can find that
 * exact row afterwards.
 *
 * Everything before this identified a written row by when it arrived: snapshot
 * the account over a range of dates, write, read again, treat anything new and
 * similar-looking as ours. Four rounds of review found four confident wrong
 * answers in that approach, two of them introduced while fixing the previous
 * one. The reason is structural: Actual runs rules on every insert, so the
 * amount and the date can change between asking and landing, and `api.sync()`
 * pulls other processes' rows into the same window during the very call that
 * failed. Nothing left to match on is both stable and unique.
 *
 * It is the transaction's own `id`, not `imported_id`. `addTransactions` spreads
 * the caller's fields over a generated id (`{ id: v4(), ...trans }`), so a
 * provided id wins. `imported_id` was the first choice and was wrong, measured
 * rather than argued: `matchTransactions` skips fuzzy matching whenever both the
 * incoming and the existing row carry one
 * (`imported_id IS NULL OR ? IS NULL`), so labelling our writes that way would
 * have stopped Actual deduplicating them against a later file import. A PR
 * whose purpose is to prevent duplicates would have created a new way to make
 * them.
 */
export function newWriteMarker(): string {
  return randomUUID();
}

export interface MarkedRow {
  id: string;
  category?: string | null;
  amount?: number;
  /** True when a rule turned this into a split; its category lives on the parts. */
  is_parent?: boolean;
}

/**
 * The row with this id, or null if the budget could not be read.
 *
 * `options({ splits: 'all' })` is not decoration. AQL defaults to
 * `splits: 'inline'`, which adds `WHERE is_parent = 0`, and the row carrying
 * our id in a split *is* the parent — `makeChild` does not copy it down. Without
 * this the probe could never see a split it had just written, and would report
 * a saved split as "not saved, and can be retried", which duplicates a parent
 * and every child under it. Measured against the engine: the default returned
 * `[]` for a split that was sitting in the budget.
 */
export async function findByMarker(marker: string): Promise<MarkedRow[] | null> {
  try {
    const result = await api.runQuery(
      transactionsQuery('all')
        .filter({ id: marker })
        .select(['id', 'category', 'amount', 'is_parent']),
    );
    const data = (result as { data?: MarkedRow[] } | undefined)?.data;
    // A query that answers nothing is not a query that answered "none": the
    // difference decides whether a retry is safe, so it is not flattened.
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/**
 * A second, independent look for the same row.
 *
 * Used only before saying "not saved", which is the one verdict that authorises
 * a retry. The whole design has a single point of failure — if the lookup goes
 * blind, it does not degrade to "I don't know", it asserts "it is not there" —
 * and an audit found exactly that failure already materialised for splits. So
 * the dangerous verdict now costs two agreeing answers, reached through
 * different code paths: this one goes through `getTransactions`, which uses
 * `splits: 'grouped'` and returns parents with their children attached.
 */
export async function corroborateAbsence(
  accountId: string,
  marker: string,
): Promise<'absent' | 'present' | 'unknown'> {
  try {
    // The whole account, not the date we asked for. The premise of this design
    // is that rules rewrite the date, so pinning the second look to that date
    // would make the safety net fail in exactly the case it exists for: a rule
    // moves the row, the net reports "absent", and "absent" is the verdict that
    // authorises a retry.
    // The dates are optional at runtime — `transactions-get` only narrows when
    // they are given — but the published types insist on them.
    const rows = await (api.getTransactions as unknown as (
      accountId: string,
    ) => Promise<unknown[]>)(accountId);
    for (const row of (rows ?? []) as Array<Record<string, any>>) {
      if (row.id === marker) return 'present';
      const subs = row.subtransactions;
      if (Array.isArray(subs) && subs.some((s: { id?: string }) => s.id === marker)) {
        return 'present';
      }
    }
    return 'absent';
  } catch {
    return 'unknown';
  }
}

/**
 * A row this server wrote, read back with the names its ids stand for.
 *
 * Everything a reply says about a transaction it has just created comes from
 * here, so the reply speaks for the row in the budget and not for the request
 * that produced it (#184). Actual runs the rules on every insert, and measured
 * one field at a time against the engine, a rule can rewrite the amount, the
 * date, the payee, the notes and the cleared flag of a transaction while it is
 * being added.
 *
 * The three `x.name` entries are joins AQL resolves inside the same query, so
 * reading the row back with its payee, account and category in words costs one
 * query rather than one lookup per id.
 */
export interface SavedRow {
  id: string;
  account: string;
  accountName: string | null;
  date: string;
  amount: number;
  payee: string | null;
  payeeName: string | null;
  notes: string | null;
  cleared: boolean;
  category: string | null;
  categoryName: string | null;
  /** True when a rule turned this into a split; the parts carry its category and payee. */
  isParent: boolean;
  /** The row on the other side, set only when this really is a transfer. */
  transferId: string | null;
}

/**
 * The rows carrying these ids, or null if the budget could not be read.
 *
 * Separate from `findByMarker` on purpose. That one is the probe that decides
 * whether a failed write may be retried, and the safest question it can ask is
 * the narrowest one; this asks for four tables at once so a reply can be
 * written without going back for names. Keeping them apart means a join cannot
 * turn "the row is there" into "I could not tell".
 */
async function readSavedRows(
  filter: Record<string, unknown>,
): Promise<SavedRow[] | null> {
  try {
    const result = await api.runQuery(
      transactionsQuery('all')
        .filter(filter)
        .select([
          'id',
          'account',
          'account.name',
          'date',
          'amount',
          'payee',
          'payee.name',
          'notes',
          'cleared',
          'category',
          'category.name',
          'is_parent',
          'transfer_id',
        ]),
    );
    const data = (result as { data?: Array<Record<string, unknown>> } | undefined)?.data;
    // Same distinction as `findByMarker`: a query that answered nothing is not
    // a query that answered "none".
    if (!Array.isArray(data)) return null;
    return data.map((row) => {
      const text = (key: string): string | null => {
        const value = row[key];
        return typeof value === 'string' && value !== '' ? value : null;
      };
      return {
        id: String(row.id),
        account: String(row.account ?? ''),
        accountName: text('account.name'),
        date: String(row.date ?? ''),
        amount: Number(row.amount ?? 0),
        payee: text('payee'),
        payeeName: text('payee.name'),
        notes: text('notes'),
        cleared: row.cleared === true,
        category: text('category'),
        categoryName: text('category.name'),
        isParent: row.is_parent === true,
        transferId: text('transfer_id'),
      };
    });
  } catch {
    return null;
  }
}

/**
 * The single row carrying this id, or null if it is not there or could not be
 * read.
 *
 * The query filters on the id, so whatever comes back is that row; it is not
 * matched against the id a second time, because that would make the answer
 * depend on the id being echoed back rather than on the filter that chose it.
 */
export async function findSavedRow(marker: string): Promise<SavedRow | null> {
  const rows = await readSavedRows({ id: marker });
  return rows?.[0] ?? null;
}

/**
 * The rows carrying these ids, by id, or null if the budget could not be read.
 *
 * One query for a whole batch. A marker with no row in the answer was not
 * found, which is a different thing from a null here and the caller has to
 * tell them apart.
 */
export async function findSavedRowsByMarker(
  markers: string[],
): Promise<Map<string, SavedRow> | null> {
  if (markers.length === 0) return new Map();
  const rows = await readSavedRows({ id: { $oneof: markers } });
  return rows ? new Map(rows.map((row) => [row.id, row])) : null;
}
