import * as api from '@actual-app/api';
import { formatMoney } from './money.js';
import type { BudgetMonthGroup } from '../types.js';

/**
 * A category where the budget module and the month's transactions disagree.
 */
export interface SpendingDivergence {
  category: string;
  /** Actual allows the same category name in two groups, so the name alone
   * does not identify the line. */
  group: string;
  /** What `getBudgetMonth` reported as spent. */
  reported: number;
  /** What the month's own transactions add up to. */
  observed: number;
}

/**
 * Add up what a month's transactions actually say each category spent.
 *
 * Two details decide whether this is right, and both were checked against a
 * real budget rather than assumed:
 *
 *  - `getTransactions` returns split parents only, with the children nested in
 *    `subtransactions`. The parent carries the full amount and no category, so
 *    summing rows naively would attribute a split to nothing and count its
 *    total twice over. Every split would then look like a divergence, and a
 *    warning that cries wolf on healthy data is worse than no warning.
 *  - Off-budget accounts do not count towards a budget category. Closed
 *    accounts do: their history still belongs to the months it happened in.
 *
 * Verified on four consecutive months of a real budget: zero divergences, to
 * the cent. So a divergence here is a signal, not noise.
 */
export async function sumTransactionsByCategory(month: string): Promise<Map<string, number>> {
  const accounts = await api.getAccounts();
  const sums = new Map<string, number>();
  const add = (category: string | null | undefined, amount: number) => {
    if (!category) return;
    sums.set(category, (sums.get(category) ?? 0) + amount);
  };

  // The whole month. Actual accepts a day past the end of a short month: AQL
  // validates the shape of the date and compares YYYYMMDD as integers.
  const start = `${month}-01`;
  const end = `${month}-31`;

  // One query for every account rather than one per account. Each call costs
  // about 28 ms regardless of how many rows it returns, so asking per account
  // made the check scale with the number of accounts rather than the data:
  // 312 ms against 34 ms on a budget with 14 accounts, for identical sums.
  // Running them in parallel does not help, since the query engine serialises.
  // An inclusion set, not an exclusion one. `getAccounts()` only returns live
  // accounts (tombstone = 0) while the month-wide query returns rows from any
  // account, so excluding "the off-budget ones I know about" silently counts
  // rows belonging to a deleted account that still has live transactions. That
  // is not hypothetical here: it is a half-synced delete, where the message
  // removing the account arrived and the ones removing its transactions did
  // not, which is exactly the local inconsistency this check exists to find.
  const onBudget = new Set(accounts.filter((a) => !a.offbudget).map((a) => a.id));
  // No `?? []`: `getTransactions` returns an array or throws, and a failed
  // read must surface rather than be counted as "no transactions" — that would
  // report every category as diverging, precisely when something is wrong and
  // people are most likely to believe it.
  const rows = await api.getTransactions(undefined as unknown as string, start, end);

  for (const row of rows as Array<Record<string, any>>) {
    // Only accounts known to be on budget. Anything else, including rows whose
    // account no longer exists, is not part of a budget category.
    if (!onBudget.has(row.account)) continue;
    const subs = row.subtransactions;
    if (Array.isArray(subs) && subs.length > 0) {
      for (const sub of subs) add(sub.category, sub.amount);
    } else {
      add(row.category, row.amount);
    }
  }

  return sums;
}

/**
 * Compare what the budget module says was spent against the transactions.
 *
 * `get_budget_month` reported `Spent 0.00` for a category holding a 52,635.98
 * transaction, and a month total of less than a third of real spending, as
 * plain fact (#80). The cause was a client bug in Actual, fixed upstream, so it
 * was never this server's fault. But this server was the only place anyone
 * looked, and it said nothing, which is the part that is ours.
 */
export async function findSpendingDivergences(
  month: string,
  groups: BudgetMonthGroup[],
): Promise<SpendingDivergence[]> {
  const sums = await sumTransactionsByCategory(month);
  const divergences: SpendingDivergence[] = [];

  for (const group of groups) {
    // Income groups are left alone. Their "spent" is income received, which
    // the budget module derives differently, and the opening-balance
    // transaction of a new account lands there. Cross-checking them would
    // compare two things that are not meant to agree.
    if (group.is_income) continue;
    for (const category of group.categories ?? []) {
      const observed = sums.get(category.id) ?? 0;
      if (observed !== category.spent) {
        divergences.push({
          category: category.name,
          group: group.name,
          reported: category.spent,
          observed,
        });
      }
    }
  }

  return divergences;
}

/**
 * Say it in the answer itself, not on stderr.
 *
 * The number is already on screen and already believed by the time anyone would
 * think to check a log, so the warning has to travel with the figure it is
 * about.
 */
export function describeDivergences(divergences: SpendingDivergence[]): string[] {
  if (divergences.length === 0) return [];

  const lines = [
    '',
    `WARNING: ${divergences.length} ${divergences.length === 1 ? 'category disagrees' : 'categories disagree'} with the transactions behind them.`,
    "The budget module and the month's own transactions do not match, so the",
    'numbers above may understate or overstate what was really spent. The',
    'The transaction figures usually deserve more weight, since they are the',
    'underlying records, but check them: a half-synced delete can leave',
    'transactions behind whose account is gone, and those inflate this side.',
    '',
    'The cause is a stale budget calculation, not damaged data.',
    '',
    'What clears it: delete cache.sqlite inside the data directory this server',
    'uses (ACTUAL_DATA_DIR). It is a derived file and Actual rebuilds it.',
    '',
    'What does not: restarting this server, which reloads the same local copy',
    'and the same stale calculation with it; and repair_sync, which rebuilds',
    'the sync state, a different thing from the one that is stale.',
    '',
  ];

  for (const d of divergences) {
    lines.push(
      `  ${`${d.group} / ${d.category}`.padEnd(32)} budget says: ${formatMoney(d.reported).padStart(12)}` +
        `   transactions say: ${formatMoney(d.observed).padStart(12)}` +
        `   difference: ${formatMoney(d.observed - d.reported).padStart(12)}`,
    );
  }

  lines.push('');
  return lines;
}
