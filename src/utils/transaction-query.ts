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
 * The values, measured against the engine rather than taken from documentation,
 * by querying a budget holding one plain row and one split:
 *
 *  - `inline`   children only; the parent is excluded. This is the default, and
 *               the reason a query that says nothing is blind to parents.
 *  - `grouped`  parents only, with children nested. A child id resolves to its
 *               parent, which is why `updatePreservingChildAmount` must not use
 *               it (#25).
 *  - `all`      both, as separate rows
 *  - `none`     parents only, *not* expanded — it excludes children rather than
 *               ignoring splits, which is not what the name suggests
 *
 * ## What this does not cover
 *
 * Only the AQL path, which has two consumers. Most transaction reads in this
 * server go through `api.getTransactions`, around ten call sites, and that SDK
 * helper fixes `splits: 'grouped'` internally with the same invisibility this
 * guard exists to remove. The difference is that `grouped` is fixed and knowable
 * rather than a default that varies with the query: parents come back with their
 * children attached, so nothing is hidden, but anyone reading a row from it is
 * reading a parent and should know that. Saying "every transactions query
 * declares what splits mean" would be false; it is true of the AQL path.
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
  // `options()` replaces rather than merges, so a later `.options({...})` on
  // the returned builder would erase this decision silently. Nothing does that
  // today; the shape invites it, which is why it is written down here.
  return api.q('transactions').options({ splits });
}
