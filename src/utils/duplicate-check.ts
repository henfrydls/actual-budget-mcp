import * as api from '@actual-app/api';
import { transactionsQuery } from './transaction-query.js';
import { formatMoney } from './money.js';

/**
 * Look for a transaction that already says what this one is about to say.
 *
 * Two agents working against one budget is the normal case here, and neither
 * can see what the other just wrote. Recording the same payment twice was
 * reported with no way to tell it had happened except syncing and reading by
 * hand (#88). It pairs with #79: an error that lies about whether a write
 * landed, and no duplicate detection, is the combination that quietly corrupts
 * a budget.
 *
 * Same account, same date, same amount. Deliberately not the payee or the
 * notes: a rule can rewrite both between asking and landing, and two entries of
 * one payment often differ in exactly those fields — one typed by hand, one
 * imported. Matching on them would miss the case this exists for.
 *
 * `splits: 'all'` and not the default. AQL's default adds `WHERE is_parent = 0`,
 * so a duplicated split would be invisible to this check, which is the failure
 * #91 spent four rounds on.
 */
export interface ExistingTransaction {
  id: string;
  date: string;
  amount: number;
  payeeName?: string;
  notes?: string | null;
}

export async function findPossibleDuplicates(
  accountId: string,
  date: string,
  amountCents: number,
): Promise<ExistingTransaction[]> {
  const result = await api.runQuery(
    transactionsQuery('all')
      .filter({ account: accountId, date, amount: amountCents })
      .select(['id', 'date', 'amount', 'notes', 'payee']),
  );
  const rows = (result as { data?: Array<Record<string, unknown>> } | undefined)?.data;
  if (!Array.isArray(rows) || rows.length === 0) return [];

  // Payee ids mean nothing to a reader, and the whole point is to name the
  // transaction well enough to recognise it.
  const payees = await api.getPayees();
  const names = new Map(payees.map((p) => [p.id, p.name]));

  return rows.map((row) => ({
    id: String(row.id),
    date: String(row.date),
    amount: Number(row.amount),
    payeeName: row.payee ? names.get(String(row.payee)) : undefined,
    notes: (row.notes as string | null) ?? null,
  }));
}

/**
 * Describe what was found, and how to go ahead anyway.
 *
 * A warning that only warns leaves the duplicate created, which is the harm.
 * This returns a preview instead, so the caller decides before anything is
 * written — the same shape the destructive tools use, for the same reason.
 *
 * Two identical coffees on one card on one day are a real thing, so the way
 * through is one flag and one more call, not an argument.
 */
export function describePossibleDuplicates(
  existing: ExistingTransaction[],
  accountName: string,
): string[] {
  const lines = [
    existing.length === 1
      ? 'A transaction like this one already exists, so nothing was created:'
      : `${existing.length} transactions like this one already exist, so nothing was created:`,
    '',
  ];

  for (const t of existing) {
    const bits = [t.date, formatMoney(t.amount), accountName];
    if (t.payeeName) bits.push(t.payeeName);
    if (t.notes) bits.push(t.notes);
    lines.push(`  ${bits.join('  ')}`);
    lines.push(`    id: ${t.id}`);
  }

  lines.push(
    '',
    'Same account, same date, same amount. If this is a second, genuine payment',
    'rather than the same one recorded twice, call again with allow_duplicate: true.',
  );
  return lines;
}
