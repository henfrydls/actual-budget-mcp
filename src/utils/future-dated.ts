import * as api from '@actual-app/api';
import { transactionsQuery } from './transaction-query.js';
import { formatMoney } from './money.js';

export interface FutureRow {
  id: string;
  date: string;
  amount: number;
  payeeName?: string;
  notes?: string | null;
  /** Arrived from the bank, so the bank's figure already counts it. */
  cameFromBank: boolean;
  /** Entered here and not reconciled, so the bank may not have it. */
  enteredByHand: boolean;
}

/**
 * The rows in an account dated after today, and what they come to.
 *
 * `api.getAccountBalance` counts `date <= today`, so these are exactly the
 * transactions a balance does not yet include. That matters wherever a figure
 * from a bank is compared against one from Actual, because the bank's figure
 * may already contain them: a card purchase made at the weekend is commonly
 * posted with the following business day's date, so an account legitimately
 * holds rows dated ahead for a day or two (#100).
 *
 * `all` with `is_child: false` rather than the default. Measured on an account
 * holding a plain -40.00 and a -60.00 split dated ahead: `inline` returns three
 * rows (-20, -40, -40) because it substitutes a split's parts for the parent,
 * and this returns two (-60, -40). Both total -100.00, so either would sum
 * correctly, but only one lists a split purchase as the single thing the person
 * actually bought.
 *
 * "Today" is given by the caller rather than read here, so that the balance it
 * is compared against and this lookup cannot disagree about which day it is.
 */
export async function rowsDatedAfterToday(
  accountId: string,
  /**
   * The caller's today, so that the balance it compares against and this
   * lookup cannot disagree about which day it is. Reading the clock here as
   * well leaves the same midnight window the cutoff was added to close, only
   * between two `resolveDate` calls instead of between one and the engine's.
   */
  today: string,
): Promise<{ rows: FutureRow[]; total: number }> {

  const result = await api.runQuery(
    transactionsQuery('all')
      .filter({ account: accountId, date: { $gt: today }, is_child: false })
      // Oldest first. Without it the order is AQL's own, which is descending
      // by date: the nearest row, the one most likely to be at the bank
      // already, came last. An unstated default deciding what a reader sees
      // first is the shape `transactionsQuery` exists to stop.
      .orderBy('date')
      // `imported_id` and `cleared`, which say something about the bank.
      //
      // This first read `schedule` and `transfer_id`, and both labels were
      // wrong. A schedule in Actual describes an expectation, not whether
      // anything was posted, and its rule links to transactions *arriving from
      // the bank*, so the rows most likely to carry one are exactly the rows
      // the bank has already counted. And a transfer between two real bank
      // accounts is a bank movement on both sides: measured, such a row comes
      // back `cleared: true`, so calling it "not a bank movement" was false in
      // the ordinary case.
      //
      // `imported_id` is the direct signal instead: a row carrying one came
      // from the bank, which is the question being asked.
      .select(['id', 'date', 'amount', 'payee', 'notes', 'imported_id', 'cleared']),
  );
  const data = (result as { data?: Array<Record<string, unknown>> } | undefined)?.data;
  if (!Array.isArray(data) || data.length === 0) return { rows: [], total: 0 };

  const payees = await api.getPayees();
  const names = new Map(payees.map((p) => [p.id, p.name]));

  const rows = data.map((row) => ({
    id: String(row.id),
    date: String(row.date),
    amount: Number(row.amount),
    payeeName: row.payee ? names.get(String(row.payee)) : undefined,
    notes: (row.notes as string | null) ?? null,
    cameFromBank: row.imported_id != null,
    enteredByHand: row.imported_id == null && row.cleared !== true,
  }));

  return { rows, total: rows.reduce((sum, r) => sum + r.amount, 0) };
}

/**
 * Lay out the choice, rather than guessing at it.
 *
 * Whether the bank has posted a row dated ahead decides the adjustment, and in
 * general the data does not say. Where it does, it is passed on: a row carrying
 * an `imported_id` came from the bank, so the bank's figure counts it; a row
 * entered here and not reconciled may be one the bank has not seen. Neither
 * settles the question, both narrow it, and the rest is the caller's to state.
 */
export function describeFutureRows(
  rows: FutureRow[],
  total: number,
  accountName: string,
  balanceToToday: number,
  targetCents: number,
): string[] {
  const lines = [
    `No adjustment was booked for ${accountName}.`,
    '',
    rows.length === 1
      ? 'This account holds one transaction dated after today, so the balance Actual'
      : `This account holds ${rows.length} transactions dated after today, so the balance Actual`,
    'reports and the balance your bank reports are not measuring the same thing.',
    '',
  ];

  for (const r of rows) {
    const bits = [r.date, formatMoney(r.amount)];
    if (r.payeeName) bits.push(r.payeeName);
    if (r.notes) bits.push(r.notes);
    // Said rather than left to be worked out. These do not decide anything,
    // they narrow what the caller has to decide about.
    if (r.cameFromBank) bits.push('(came from the bank, so the bank counts it)');
    else if (r.enteredByHand) bits.push('(entered here, not reconciled)');
    lines.push(`  ${bits.join('  ')}`);
  }

  lines.push(
    '',
    `  Balance to today:        ${formatMoney(balanceToToday)}`,
    `  Those rows come to:      ${formatMoney(total)}`,
    `  Balance counting them:   ${formatMoney(balanceToToday + total)}`,
    `  You said the bank says:  ${formatMoney(targetCents)}`,
    '',
    'Which is it?',
    '',
    `  future_rows: "exclude"   the bank has not posted them yet.`,
    `                           Adjustment would be ${formatMoney(targetCents - balanceToToday)}.`,
    `  future_rows: "include"   the bank has posted them already, which is usual for`,
    `                           a card purchase the bank dates a day or two ahead.`,
    `                           Adjustment would be ${formatMoney(targetCents - (balanceToToday + total))}.`,
    '',
    'Booking the wrong one puts the difference into your residual category, where',
    'it reads as currency drift and nothing later marks it as anything else.',
  );
  return lines;
}
