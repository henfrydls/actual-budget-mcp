import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { amountToCents, centsToAmount, formatMoney } from '../../utils/money.js';
import { resolveAccountId } from '../../utils/resolvers.js';
import { resolveDate } from '../../utils/dates.js';
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

  // Before reading the balance, not after. Two agents reconciling the same
  // drift both read a stale balance and both book an adjustment, which is the
  // #88 scenario reappearing on the one path that computes what it writes.
  await pullBeforeReading('reading the balance to reconcile');

  // `getAccountBalance` defaults its cutoff to now, and the query behind it is
  // `date <= cutoff`. An adjustment booked with a future date therefore never
  // counts towards the balance, so every run computed the same delta and wrote
  // another adjustment: two runs, two adjustments, and an account left at +200
  // while the balance still read -100. Counting up to the adjustment's own date
  // makes the second run see the first one and stop at "No adjustment needed".
  //
  // The later of the two, so a past or same-day adjustment keeps the previous
  // meaning exactly: today's balance, not the balance as of some date in the
  // past.
  const txnDate = resolveDate(input.date);
  const today = new Date();
  const asOf = new Date(`${txnDate}T00:00:00`);
  const cutoff = asOf > today ? asOf : today;

  const currentCents = await api.getAccountBalance(accountId, cutoff);
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
