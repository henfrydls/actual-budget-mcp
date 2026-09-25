import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { amountToCents, centsToAmount, formatMoney } from '../../utils/money.js';
import { resolveAccountId } from '../../utils/resolvers.js';
import { resolveDate, formatDate } from '../../utils/dates.js';
import { createTransaction } from './create-transaction.js';
import { pullBeforeReading, isDuplicatePreview } from '../../utils/duplicate-check.js';
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
export async function reconcileCurrencyResidual(input: ReconcileResidualInput): Promise<string[]> {
  await ensureConnection();

  const accountId = await resolveAccountId(input.account);

  // An adjustment dated ahead cannot do what this tool is for. The promise is
  // "bring the account to the balance the bank reports"; a row that takes
  // effect next year leaves the account not matching the bank today, so the
  // reply would state a reconciliation that has not happened.
  //
  // It was also unsound. `getAccountBalance` counts `date <= cutoff` with the
  // cutoff defaulting to now, so a future-dated adjustment never enters the
  // balance: every run computed the same delta and wrote another one. An
  // earlier attempt moved the cutoff to the adjustment's own date instead,
  // which stopped the identical repeat but bought two worse problems. It made
  // `Was:` mean the balance as of a future date, so with any pre-existing
  // future row the figure stopped matching the statement the user is comparing
  // against (measured: the bank says -100.00, the tool said -150.00 and booked
  // +150.00). And it did not even close the hole, because a second run with no
  // date measures at today, does not count the future adjustment, and books a
  // second one (measured: two adjustments, account left at +100.00).
  //
  // Refusing is the whole fix: the cutoff goes back to today, `Was:` means what
  // the bank means, and a repeat at the same date is caught by the duplicate
  // check that #88 put in front of every create.
  //
  // Compared as strings. Both sides are `YYYY-MM-DD`, so this is exact and has
  // no timezone or DST behaviour to get wrong, unlike parsing to `Date` (which
  // also silently rolls an impossible date like 2026-02-30 into March while
  // the stored transaction keeps the original string).
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
  // "Today" is this server's today. A client in a timezone ahead of the server
  // can be told its own date is in the future; omitting `date`, or passing
  // "today", uses the same clock as this check and always works.
  const today = formatDate(new Date());
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

  const currentCents = await api.getAccountBalance(accountId);
  const targetCents = amountToCents(input.target_balance ?? 0);
  const deltaCents = targetCents - currentCents;

  const accounts = await api.getAccounts();
  const acctName = accounts.find((a) => a.id === accountId)?.name || accountId;

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
    notes: input.notes || 'FX residual adjustment',
    date: input.date,
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
    'Book an adjustment transaction to bring a multi-currency account to the balance the bank reports, clearing accumulated FX-rate residual.',
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
