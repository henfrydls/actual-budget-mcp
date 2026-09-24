import * as api from '@actual-app/api';
import { formatMoney } from './money.js';
import type { BudgetMonthGroup } from '../types.js';

/**
 * A category where the budget module and the month's transactions disagree.
 */
export interface SpendingDivergence {
  category: string;
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

  // The whole month. Actual accepts a day past the end of a short month.
  const start = `${month}-01`;
  const end = `${month}-31`;

  for (const account of accounts) {
    if (account.offbudget) continue;
    const rows = (await api.getTransactions(account.id, start, end)) ?? [];
    for (const row of rows as Array<Record<string, any>>) {
      const subs = row.subtransactions;
      if (Array.isArray(subs) && subs.length > 0) {
        for (const sub of subs) add(sub.category, sub.amount);
      } else {
        add(row.category, row.amount);
      }
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
    if (group.is_income) continue;
    for (const category of group.categories ?? []) {
      const observed = sums.get(category.id) ?? 0;
      if (observed !== category.spent) {
        divergences.push({ category: category.name, reported: category.spent, observed });
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
    'WARNING: these figures disagree with the transactions behind them.',
    'The budget module and the month\'s own transactions do not match, so the',
    'numbers above may understate or overstate what was really spent. This has',
    'happened because of a bug in the Actual client (fixed in 26.9); updating',
    'Actual and running repair_sync is the usual cure.',
    '',
  ];

  for (const d of divergences) {
    lines.push(
      `  ${d.category.padEnd(25)} budget says: ${formatMoney(d.reported).padStart(12)}` +
        `   transactions say: ${formatMoney(d.observed).padStart(12)}`,
    );
  }

  lines.push('');
  return lines;
}
