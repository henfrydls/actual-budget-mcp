import * as api from '@actual-app/api';

/**
 * How a transactions query treats splits. There is no default on purpose.
 *
 * AQL's own default is `inline`, which adds `WHERE is_parent = 0`: a query that
 * does not say anything about splits silently cannot see split parents. That
 * has been a real bug twice, and both times it was invisible until someone
 * measured against the engine:
 *
 *  - #79/#91: the probe looking for a transaction it had just written could
 *    never see a split, so a saved split was reported as "not saved, and can be
 *    retried" — the answer that duplicates a parent and every child under it.
 *    Four rounds of review missed it, because every mock returned the parent.
 *  - #82: a note on a split parent cannot be found by a text search, which is
 *    exactly where a `#Soventix` tag lands when a reimbursable purchase is
 *    split across categories. A reimbursement nobody chases, with nothing to
 *    signal it was missed.
 *
 * The values, measured rather than taken from documentation:
 *
 *  - `inline`   parents are excluded, children are returned as rows
 *  - `grouped`  parents are returned with children nested; a child id resolves
 *               to its parent, which is why `updatePreservingChildAmount` must
 *               not use it (#25)
 *  - `all`      both parents and children are returned
 *  - `none`     splits are ignored entirely
 *
 * Requiring the argument does not make anyone choose correctly. It makes the
 * choice visible in the diff, which is what was missing.
 */
export type SplitHandling = 'inline' | 'grouped' | 'all' | 'none';

/**
 * Start a transactions query, having decided what splits mean for it.
 *
 * Use this rather than `api.q('transactions')`; a test fails if production code
 * reaches for the raw builder, because that is how the two bugs above got in.
 */
export function transactionsQuery(splits: SplitHandling) {
  return api.q('transactions').options({ splits });
}
