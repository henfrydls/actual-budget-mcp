import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { amountToCents, centsToAmount, formatMoney } from '../../utils/money.js';
import { resolveAccountId } from '../../utils/resolvers.js';
import { resolveDate, formatDate } from '../../utils/dates.js';
import { createTransaction } from './create-transaction.js';
import { pullBeforeReading, isDuplicatePreview } from '../../utils/duplicate-check.js';
import { rowsDatedAfterToday, describeFutureRows } from '../../utils/future-dated.js';
import { describeError } from '../../utils/errors.js';
import { WriteReportedError } from '../../utils/write-outcome.js';

export interface ReconcileResidualInput {
  account: string;
  category: string;
  target_balance?: number;
  notes?: string;
  date?: string;
  payee?: string;
  /** Book the adjustment even though a transaction of that amount is already on that day. */
  allow_duplicate?: boolean;
  /**
   * What the bank's figure does with transactions dated after today.
   * `exclude` reconciles against the balance up to today, `include` against
   * the balance counting every row. Required only when such rows exist.
   */
  future_rows?: 'exclude' | 'include';
}

/**
 * Reconcile a multi-currency residual: when an account tracks foreign-currency
 * activity in local-currency equivalents, FX-rate drift leaves a residual even
 * when the bank reports a different (often zero) outstanding balance.
 *
 * Computes the delta between the account's current balance and `target_balance`
 * (what the bank reports, default 0) and books a single adjustment transaction
 * in `category` to close the gap. Returns the confirmation lines.
 */
/**
 * Append what the adjustment was measured against, when that was a choice.
 *
 * Only when rows dated ahead exist, since otherwise there was nothing to
 * decide and the clause would be noise on every ordinary reconciliation.
 */
function futureNote(base: string, futureCount: number, reading?: 'exclude' | 'include'): string {
  if (futureCount === 0 || !reading) return base;
  const what = futureCount === 1 ? '1 transaction' : `${futureCount} transactions`;
  return reading === 'include'
    ? `${base} (counting ${what} dated after today)`
    : `${base} (not counting ${what} dated after today)`;
}

export async function reconcileCurrencyResidual(input: ReconcileResidualInput): Promise<string[]> {
  await ensureConnection();

  const accountId = await resolveAccountId(input.account);

  const txnDate = resolveDate(input.date);

  // `resolveDate` only checks the shape, so an impossible day reaches here
  // looking like an ordinary date. Reject it as what it is: saying "that is in
  // the future" about 2026-09-31 is misleading, and 2026-02-30 would otherwise
  // be written and counted in the balance as though it were a real day.
  const asDate = new Date(`${txnDate}T00:00:00`);
  if (Number.isNaN(asDate.getTime()) || formatDate(asDate) !== txnDate) {
    throw new Error(
      `"${txnDate}" is not a real calendar date, so nothing was booked. Use YYYY-MM-DD.`,
    );
  }

  // An adjustment dated ahead cannot do what this tool is for. The promise is
  // "bring the account to the balance the bank reports"; a row that takes
  // effect later leaves the account not matching the bank today, so the reply
  // would state a reconciliation that has not happened.
  //
  // It was also unsound. `getAccountBalance` counts `date <= cutoff` with the
  // cutoff defaulting to now, so a future-dated adjustment never entered the
  // balance: every run computed the same delta and wrote another one. An
  // earlier attempt moved the cutoff to the adjustment's own date instead,
  // which stopped the identical repeat but made `Was:` stop matching the
  // statement the user compares against, and still left a second run with no
  // date free to book again.
  //
  // Compared as strings. Both sides are `YYYY-MM-DD`, so this is exact and has
  // no timezone or DST behaviour of its own.
  //
  // "Today" comes from `resolveDate`, the same source that turns a caller's
  // "today" into a date everywhere else in this server, rather than from a
  // second formatting of `new Date()` here. Two notions of today in one
  // process drift apart across a timezone or a DST boundary, and the drift is
  // invisible to a suite running in UTC: swapping this line for the common
  // `toISOString().slice(0, 10)` idiom passes every test on a UTC runner and
  // rejects a client's own date for part of the day anywhere east of it.
  //
  // It remains this server's today, not the client's. A client ahead of the
  // server can still be told its date is in the future; omitting `date`, or
  // passing "today", goes through this same call and always works.
  const today = resolveDate('today');
  if (txnDate > today) {
    throw new Error(
      `Cannot book a reconciliation adjustment on ${txnDate}, which is after this ` +
        `server's today (${today}). The adjustment would not take effect until then, ` +
        'so the account would not match the balance the bank reports now. Use today or ' +
        'a past date, or omit the date. To record a transaction that is genuinely dated ' +
        'ahead, such as a card purchase the bank posts on a later day, use ' +
        'create_transaction instead.',
    );
  }

  // Only now, after the input is known to be usable. A refusal must not cost a
  // sync: this is a full network round trip, and against a server that accepts
  // the connection and stops answering it can hold for minutes.
  //
  // Before reading the balance, not after. Two agents reconciling the same
  // drift both read a stale balance and both book an adjustment, which is the
  // #88 scenario reappearing on the one path that computes what it writes.
  await pullBeforeReading('reading the balance to reconcile');

  // What the balance counts, before comparing it to anything.
  //
  // `getAccountBalance` sums `date <= today`. A bank's figure may already
  // include a transaction dated after today, because a card purchase made at
  // the weekend is commonly posted with the following business day's date. When
  // that happens the two numbers are not measuring the same thing, and the
  // difference between them lands in the residual category as though it were
  // currency drift.
  //
  // Measured: an account at -100.00 to today, a -40.00 purchase dated ahead
  // that the bank has already posted, a -80.00 transfer scheduled for later
  // that it has not, and a bank figure of -140.00. This booked -40.00 and left
  // the account summing to -260.00 where the bank will end at -220.00. The
  // adjustment was exactly the purchase, recorded a second time.
  //
  // In general the data does not tell the two kinds apart, so the choice is
  // the caller's and this refuses to make it for them. Where it does say
  // something, `rowsDatedAfterToday` passes it on rather than deciding with
  // it; see the note there about the two labels that got this wrong first.
  // One reading of the clock, threaded through both.
  //
  // The balance stops at a cutoff and the lookup starts after a date, so if
  // those two come from different reads a row dated between them is in
  // neither: not counted in the balance, not reported as ahead, so the
  // question is never asked and an adjustment is written.
  //
  // Passing a cutoff at all was the first fix, and it only narrowed the
  // window: it replaced "the engine's clock against `resolveDate`" with
  // "`resolveDate` against `resolveDate`", the same width, because the two
  // calls sat in different modules with an `await` between them. Measured
  // across midnight: cutoff 2026-09-26, `$gt` 2026-09-27, and a row dated the
  // 27th in neither.
  //
  // `today` is already computed above for the refusal, so this is the same
  // value the rest of the function reasons about as well.
  const accounts = await api.getAccounts();
  const acctName = accounts.find((a) => a.id === accountId)?.name || accountId;

  const balanceToToday = await api.getAccountBalance(accountId, today as never);
  const future = await rowsDatedAfterToday(accountId, today);

  if (future.rows.length > 0 && !input.future_rows) {
    return describeFutureRows(
      future.rows,
      future.total,
      acctName,
      balanceToToday,
      amountToCents(input.target_balance ?? 0),
    );
  }

  const currentCents =
    input.future_rows === 'include' ? balanceToToday + future.total : balanceToToday;
  const targetCents = amountToCents(input.target_balance ?? 0);
  const deltaCents = targetCents - currentCents;

  if (deltaCents === 0) {
    return [
      `No adjustment needed: ${acctName} already at ${formatMoney(currentCents)}.`,
    ];
  }

  // The #88 check stays on. An earlier attempt passed `allow_duplicate` here,
  // reasoning that this cannot duplicate itself because a second run computes a
  // delta of zero; that was wrong on two measured paths, a future-dated
  // adjustment and two agents reconciling at once, and turning the check off
  // made this the only write in the server that neither synced nor looked. The
  // delta is computed above from a synced balance that counts the adjustment's
  // own date, so a genuine repeat now stops before reaching here, and what the
  // check catches is what it should: an unrelated transaction that happens to
  // match, which is worth pausing on rather than silently double-booking.
  const lines = await createTransaction({
    account: accountId,
    amount: centsToAmount(deltaCents),
    category: input.category,
    // The row records which reading it was taken under. #100's complaint was
    // that a wrong adjustment is indistinguishable afterwards: it sits in the
    // residual category saying it is currency drift. If the caller answers
    // this question wrongly the figure is still wrong, but the row now says
    // what it was computed against, which is the difference between a puzzle
    // and a lookup.
    notes: futureNote(input.notes || 'FX residual adjustment', future.rows.length, input.future_rows),
    // The date already resolved and validated above, not the raw input. Sent
    // raw, `createTransaction` resolves it a second time, so across midnight
    // the row is written on the new day while the balance was measured on the
    // old one, on a date that never went through the future-date refusal. The
    // same class as the window closed above, and closed the same way: read
    // once, pass it on.
    date: txnDate,
    payee: input.payee,
    allow_duplicate: input.allow_duplicate,
    // Not "pass allow_duplicate", which is this tool's least safe move: it
    // forces the write past the check while the delta was computed from a
    // balance read moments earlier. Running again recomputes from a fresh
    // balance and stops by itself if the adjustment is already there.
    duplicateAdvice: [
      'Same account, same date, same amount. If that row is this adjustment,',
      'already booked, run this again and it will recompute from the balance',
      'and stop. Only pass allow_duplicate: true if the match is unrelated.',
    ],
  });

  // Nothing was written, so nothing may be announced. The header used to print
  // regardless, so the reply stated the adjustment, then stated that nothing
  // had been created, then advised a flag this tool did not accept, while the
  // balance sat unchanged.
  if (isDuplicatePreview(lines)) {
    return [
      `No adjustment was booked for ${acctName}.`,
      `It would have been ${formatMoney(deltaCents)} on ${txnDate}.`,
      '',
      ...lines,
    ];
  }

  return [
    'Currency residual reconciled:',
    `  Account:    ${acctName}`,
    `  Was:        ${formatMoney(currentCents)}`,
    `  Target:     ${formatMoney(targetCents)}`,
    `  Adjustment: ${formatMoney(deltaCents)}`,
    ...lines,
  ];
}

export function registerReconcileCurrencyResidual(server: McpServer): void {
  server.tool(
    'reconcile_currency_residual',
    'Book an adjustment transaction to bring a multi-currency account to the balance the bank reports, clearing accumulated FX-rate residual. ' +
      'The date must be today or earlier. If a transaction with the same account, date and amount already exists this books nothing and ' +
      'reports it instead; run it again to recompute, or pass allow_duplicate if the match is unrelated. ' +
      'If the account holds transactions dated after today, it reports those and books nothing until future_rows says ' +
      'whether the balance you gave already counts them.',
    {
      account: z.string().describe('Account name or ID to reconcile'),
      category: z.string().describe('Category to book the adjustment under (name or ID)'),
      target_balance: z
        .number()
        .optional()
        .default(0)
        .describe('Balance the bank reports for this account (human amount). Defaults to 0.'),
      notes: z
        .string()
        .optional()
        .describe('Note for the adjustment. Defaults to "FX residual adjustment".'),
      date: z
        .string()
        .optional()
        .describe('Date for the adjustment (YYYY-MM-DD or "today"). Defaults to today.'),
      payee: z.string().optional().describe('Optional payee for the adjustment'),
      future_rows: z
        .enum(['exclude', 'include'])
        .optional()
        .describe(
          'What the balance you gave does with transactions dated after today. "exclude" if the bank has not posted them, "include" if it has, which is usual for a card purchase the bank dates a day or two ahead. Only needed when the account holds such rows; without it, this reports them and books nothing.',
        ),
      allow_duplicate: z
        .boolean()
        .optional()
        .describe(
          'Book the adjustment even though a transaction with the same account, date and amount already exists. Without this, such a call reports the existing one and books nothing.',
        ),
    },
    { title: 'Reconcile currency residual', readOnlyHint: false },
    async (input) => {
      try {
        const lines = await reconcileCurrencyResidual(input);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        // This calls createTransaction internally, so it can receive a verdict
        // about a write that landed. Reporting that as an error would invite
        // the retry the verdict exists to prevent.
        if (error instanceof WriteReportedError && (error.verdict === 'applied' || error.verdict === 'duplicated')) {
          return { content: [{ type: 'text', text: error.message }] };
        }
        const message = describeError(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
