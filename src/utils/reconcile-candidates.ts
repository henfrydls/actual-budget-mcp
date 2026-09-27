import * as api from '@actual-app/api';
import { transactionsQuery } from './transaction-query.js';

/**
 * What might explain the gap between an account's balance here and a bank's.
 *
 * ## Why this does not look for combinations
 *
 * The obvious thing is to search for any set of transactions summing to the
 * difference. Measured on generated accounts with realistic amounts, against a
 * round difference that nothing in the account should explain:
 *
 *   rows   a single row matches   a pair sums to it   pairs found
 *     40           59%                   70%               4
 *    100           64%                   89%              27
 *    200           69%                   87%             102
 *
 * A round figure is the realistic case, because the difference is usually a
 * transfer or a payment. So on an ordinary month's account, a pair that sums to
 * the difference is found almost always, and there are dozens of them. That is
 * not a list of candidates, it is a list of arithmetic coincidences, and every
 * one of them costs the reader time to dismiss.
 *
 * A single row matching is weak for the same reason: it turns up about two
 * times in three when nothing is wrong at all.
 *
 * So the ranking below is by how *rare* a signal is, not by how well it fits:
 * a duplicate pair, or the same amount sitting on another account, is unusual
 * enough to be worth reading. A bare amount match is reported last and labelled
 * for what it is.
 *
 * ## The signs, which are easy to get backwards
 *
 * `difference = expected - actual`.
 *
 *  - A row **in this account that should not be here**: removing it moves the
 *    balance by minus its amount, so it has `amount === -difference`.
 *  - A row **that belongs here but is somewhere else**, or one dated past the
 *    cutoff: adding it moves the balance by its amount, so it has
 *    `amount === difference`.
 *
 * Both directions are tested, because reading one of them off the other by
 * symmetry is how the sign gets flipped.
 */

export type CandidateKind = 'duplicate' | 'other_account' | 'after_cutoff' | 'amount_match';

export interface Candidate {
  kind: CandidateKind;
  id: string;
  date: string;
  amount: number;
  payeeName?: string;
  notes?: string | null;
  cleared?: boolean;
  /** For `other_account`: where the row actually sits. */
  accountName?: string;
  /** For `duplicate`: the row it appears to duplicate. */
  twinDate?: string;
}

export interface CandidateReport {
  candidates: Candidate[];
  rowsExamined: number;
  from: string;
  to: string;
  unclearedCount: number;
  afterCutoffCount: number;
}

interface Row {
  id: string;
  date: string;
  amount: number;
  payee?: string | null;
  notes?: string | null;
  cleared?: boolean;
  account?: string;
}

function rowsOf(result: unknown): Row[] {
  const data = (result as { data?: unknown } | undefined)?.data;
  return Array.isArray(data) ? (data as Row[]) : [];
}

/** How far apart two rows can be dated and still look like the same charge twice. */
const TWIN_DAYS = 7;

function daysBetween(a: string, b: string): number {
  return Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);
}

export async function findReconcileCandidates(
  accountId: string,
  asOf: string,
  differenceCents: number,
  lookbackDays: number,
): Promise<CandidateReport> {
  const from = new Date(Date.parse(asOf) - lookbackDays * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const inWindow = rowsOf(
    await api.runQuery(
      transactionsQuery('all')
        .filter({ account: accountId, date: { $gte: from, $lte: asOf }, is_child: false })
        .orderBy('date')
        .select(['id', 'date', 'amount', 'payee', 'notes', 'cleared']),
    ),
  );

  const afterCutoff = rowsOf(
    await api.runQuery(
      transactionsQuery('all')
        .filter({ account: accountId, date: { $gt: asOf }, is_child: false })
        .orderBy('date')
        .select(['id', 'date', 'amount', 'payee', 'notes', 'cleared']),
    ),
  );

  const report: CandidateReport = {
    candidates: [],
    rowsExamined: inWindow.length,
    from,
    to: asOf,
    unclearedCount: inWindow.filter((r) => r.cleared !== true).length,
    afterCutoffCount: afterCutoff.length,
  };

  // A difference of zero has nothing to explain, and every filter below would
  // match on amount 0 rows.
  if (differenceCents === 0) return report;

  const payees = await api.getPayees();
  const payeeName = new Map(payees.map((p) => [p.id, p.name]));
  const named = (r: Row) => (r.payee ? payeeName.get(String(r.payee)) : undefined);

  const surplus = -differenceCents; // a row here that should not be
  const missing = differenceCents; // a row that belongs here

  // 1. A charge that looks entered twice, where dropping one closes the gap.
  //    Two rows, same amount and same payee, within a week.
  const sameAmount = inWindow.filter((r) => r.amount === surplus);
  for (const r of sameAmount) {
    const twin = inWindow.find(
      (o) =>
        o.id !== r.id &&
        o.amount === r.amount &&
        String(o.payee ?? '') === String(r.payee ?? '') &&
        daysBetween(o.date, r.date) <= TWIN_DAYS,
    );
    if (twin) {
      report.candidates.push({
        kind: 'duplicate',
        id: r.id,
        date: r.date,
        amount: r.amount,
        payeeName: named(r),
        notes: r.notes ?? null,
        cleared: r.cleared,
        twinDate: twin.date,
      });
    }
  }

  // 2. The amount sitting on a different account, which is what entering a
  //    movement against the wrong one looks like from here.
  const elsewhere = rowsOf(
    await api.runQuery(
      transactionsQuery('all')
        .filter({
          amount: missing,
          is_child: false,
          date: { $gte: from, $lte: asOf },
        })
        .select(['id', 'date', 'amount', 'payee', 'notes', 'cleared', 'account']),
    ),
  ).filter((r) => r.account !== accountId);

  if (elsewhere.length > 0) {
    const accounts = await api.getAccounts();
    const accountName = new Map(accounts.map((a) => [a.id, a.name]));
    for (const r of elsewhere) {
      report.candidates.push({
        kind: 'other_account',
        id: r.id,
        date: r.date,
        amount: r.amount,
        payeeName: named(r),
        notes: r.notes ?? null,
        cleared: r.cleared,
        accountName: r.account ? accountName.get(String(r.account)) : undefined,
      });
    }
  }

  // 3. A row dated past the cutoff whose amount is the gap: the balance does
  //    not count it and the bank may already have.
  for (const r of afterCutoff.filter((r) => r.amount === missing)) {
    report.candidates.push({
      kind: 'after_cutoff',
      id: r.id,
      date: r.date,
      amount: r.amount,
      payeeName: named(r),
      notes: r.notes ?? null,
      cleared: r.cleared,
    });
  }

  // 4. Last and weakest: the amount is simply here. Reported so the reader can
  //    look, labelled so they know how little it means on its own.
  const alreadyNamed = new Set(report.candidates.map((c) => c.id));
  for (const r of sameAmount) {
    if (alreadyNamed.has(r.id)) continue;
    report.candidates.push({
      kind: 'amount_match',
      id: r.id,
      date: r.date,
      amount: r.amount,
      payeeName: named(r),
      notes: r.notes ?? null,
      cleared: r.cleared,
    });
  }

  return report;
}
