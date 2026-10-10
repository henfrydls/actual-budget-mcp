import * as api from '@actual-app/api';
import { transactionsQuery } from './transaction-query.js';

/**
 * What an account's balance counts, split into the two figures that matter.
 *
 * A bank statement generally shows only what has posted, and
 * `getAccountBalance` sums everything up to its cutoff whether it is marked
 * cleared or not. So the number someone reads off a statement and the number
 * this budget reports are not measuring the same thing whenever the account
 * holds uncleared rows (#108).
 *
 * Both tools that compare against a bank figure read this, so they cannot
 * answer the same question differently.
 *
 * ## How the two are worked out
 *
 * `all` is `getAccountBalance`, unchanged: it is what every other reading in
 * this server uses, and #100 is built on its cutoff behaviour. The uncleared
 * rows are queried, and `cleared` is the difference.
 *
 * Subtracting rather than summing `cleared: true` separately is deliberate.
 * The reply tells the reader that one figure plus the excluded rows makes the
 * other, and arriving at the two ends independently is how that stops being
 * true: a row the query counts and the balance does not, or the reverse, would
 * leave the arithmetic in the message wrong with nothing failing.
 *
 * Measured, one account, one moment:
 *
 *   past, cleared               -10.00
 *   past, uncleared             -20.00
 *   past, cleared split parent  -70.00
 *   a row dated 2099            -5.00   (outside the cutoff, in neither figure)
 *
 *   getAccountBalance          -100.00
 *   the same query, is_child    -100.00   same rows, so the subtraction holds
 *   cleared only                -80.00
 *
 * `is_child: false` for the same reason the duplicate check uses it: a split's
 * children are shares of their parent, and counting both would double the
 * split. Measured above, the parent is what the balance counts.
 */
export interface BalanceBreakdown {
  /** Everything up to the cutoff, cleared or not. */
  all: number;
  /** Only what this budget says the bank has posted. */
  cleared: number;
  /** How many rows the cleared figure leaves out. */
  unclearedCount: number;
  /** What those rows add up to, so `cleared + unclearedTotal === all`. */
  unclearedTotal: number;
}

export async function balanceBreakdown(
  accountId: string,
  asOf: string,
): Promise<BalanceBreakdown> {
  const all = await api.getAccountBalance(accountId, asOf as never);

  const result = await api.runQuery(
    transactionsQuery('all')
      .filter({ account: accountId, date: { $lte: asOf }, is_child: false, cleared: false })
      .select(['amount']),
  );
  const rows = (result as { data?: Array<{ amount: number }> } | undefined)?.data ?? [];
  const unclearedTotal = rows.reduce((sum, row) => sum + Number(row.amount), 0);

  return {
    all,
    cleared: all - unclearedTotal,
    unclearedCount: rows.length,
    unclearedTotal,
  };
}
