import { randomUUID } from 'node:crypto';
import * as api from '@actual-app/api';

/**
 * A label this server puts on a transaction before writing it, so it can find
 * that exact row afterwards.
 *
 * Everything before this identified a written row by when it arrived: snapshot
 * the account over a range of dates, write, read again, and treat anything new
 * and similar-looking as ours. Four rounds of review found four confident wrong
 * answers in that approach, and two of them were introduced while fixing the
 * previous one. The reason is structural rather than careless: Actual runs
 * rules on every insert, so the amount and the date can both change between
 * asking and landing, and `api.sync()` pulls other people's rows into the same
 * window during the very call that failed. There is nothing left to match on
 * that is both stable and unique.
 *
 * `imported_id` is stable and unique. It is the field Actual uses to recognise
 * a transaction it has seen before, rules do not touch it, and it survives any
 * rewrite of amount, date, payee or notes.
 *
 * Verified against a real Actual (26.9) rather than assumed:
 *
 *   - `addTransactions` preserves it outside a bank import: a row written with
 *     a uuid came back carrying that uuid.
 *   - It can be queried with no date range at all, which is what removes the
 *     window: `q('transactions').filter({ imported_id })` returned exactly the
 *     one row.
 *   - Actual does *not* deduplicate on it here. Sending the same id twice
 *     created two rows. So this buys exact identification, not idempotency,
 *     and nothing in this server should claim otherwise.
 */
export function newWriteMarker(): string {
  return randomUUID();
}

/** The rows carrying this marker, by id, or null if the budget cannot be read. */
export async function findByMarker(
  marker: string,
): Promise<Array<{ id: string; category?: string | null; amount?: number }> | null> {
  try {
    const result = await api.runQuery(
      api
        .q('transactions')
        .filter({ imported_id: marker })
        .select(['id', 'category', 'amount']),
    );
    const data = (result as { data?: Array<{ id: string }> } | undefined)?.data;
    // A query that answers nothing is not a query that answered "none": the
    // difference decides whether a retry is safe, so it is not flattened.
    return Array.isArray(data) ? (data as Array<{ id: string }>) : null;
  } catch {
    return null;
  }
}
