import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { amountToCents, formatMoney } from '../../utils/money.js';
import { resolveDate } from '../../utils/dates.js';
import { resolveAccountId, resolveCategoryId } from '../../utils/resolvers.js';
import { describeError } from '../../utils/errors.js';
import { mayHaveBeenApplied, verifyFailedWrite, WriteReportedError } from '../../utils/write-outcome.js';
import { newWriteMarker, findByMarker, corroborateAbsence } from '../../utils/write-marker.js';
import { queueTransactionWrite } from '../../utils/transaction-writes.js';
import {
  findPossibleDuplicates,
  describePossibleDuplicates,
} from '../../utils/duplicate-check.js';

export interface SplitInput {
  category: string;
  amount: number;
  notes?: string;
}

export interface CreateSplitTransactionInput {
  account: string;
  amount: number;
  allow_duplicate?: boolean;
  splits: SplitInput[];
  payee?: string;
  date?: string;
  notes?: string;
  cleared?: boolean;
}

/**
 * Create a split transaction: a single parent (the bank-facing total) with N
 * sub-transactions that distribute it across categories. Mirrors how Actual
 * models splits natively, preserving 1:1 traceability with the bank statement.
 *
 * The sum of `splits[].amount` must equal `amount`. Sub-transactions carry their
 * own explicit category, so no learned-mapping override applies to them.
 *
 * Returns the human-readable confirmation lines.
 */
export async function createSplitTransaction(
  input: CreateSplitTransactionInput,
): Promise<string[]> {
  await ensureConnection();

  if (!input.splits || input.splits.length < 2) {
    throw new Error('A split transaction needs at least two splits.');
  }

  const totalCents = amountToCents(input.amount);
  const splitCents = input.splits.map((s) => amountToCents(s.amount));
  const sumCents = splitCents.reduce((acc, c) => acc + c, 0);

  if (sumCents !== totalCents) {
    throw new Error(
      `Split amounts must sum to the total. Total is ${formatMoney(totalCents)} ` +
        `but the splits sum to ${formatMoney(sumCents)}.`,
    );
  }

  const accountId = await resolveAccountId(input.account);
  const txnDate = resolveDate(input.date);

  // The same check every other write uses, on the parent's total (#98).
  //
  // The total is what the bank shows and what a duplicate would repeat; the
  // parts are an internal division of it, and two splits of the same purchase
  // need not divide it the same way. The comparator already excludes children,
  // for the same reason, so this and `create_transaction` see the same rows
  // and give the same answer about them: a plain row of -70 and a split
  // totalling -70 on one account and date are the same purchase entered twice,
  // whichever was written first.
  if (!input.allow_duplicate) {
    const existing = await findPossibleDuplicates(accountId, txnDate, totalCents);
    if (existing.length > 0) {
      const accountName =
        (await api.getAccounts()).find((a) => a.id === accountId)?.name ?? input.account;
      return describePossibleDuplicates(existing, accountName, [
        'Same account, same date, same total. The split would repeat a transaction that is',
        'already there. If this is a second, genuine purchase rather than the same one',
        'recorded twice, call again with allow_duplicate: true.',
      ]);
    }
  }

  const subtransactions = await Promise.all(
    input.splits.map(async (s, i) => {
      const sub: Record<string, unknown> = {
        amount: splitCents[i],
        category: await resolveCategoryId(s.category),
      };
      if (s.notes) sub.notes = s.notes;
      return sub;
    }),
  );

  const parent: Record<string, unknown> = {
    date: txnDate,
    amount: totalCents,
    cleared: input.cleared ?? false,
    subtransactions,
  };
  if (input.payee) parent.payee_name = input.payee;
  if (input.notes) parent.notes = input.notes;

  // Given its id before sending, so the row can be found by identity rather
  // than by what appeared near a date (#79, #93). A repeated split duplicates a
  // parent and every child under it, so a wrong answer here is expensive.
  const marker = newWriteMarker();
  parent.id = marker;

  const accounts = await api.getAccounts();
  const acct = accounts.find((a) => a.id === accountId);
  const acctName = acct?.name || accountId;

  try {
    await api.addTransactions(accountId, [parent as any], {
      learnCategories: false,
      runTransfers: false,
    });
    await api.sync();
  } catch (error) {
    if (!mayHaveBeenApplied(error)) throw error;
    const { verdict, message } = await verifyFailedWrite(error, {
      action: 'The split transaction',
      whereToLook: `${acctName} on ${txnDate}`,
      probe: {
            marker,
            find: findByMarker,
            corroborate: () => corroborateAbsence(accountId, marker),
          },
    });
    throw new WriteReportedError(message, verdict);
  }

  const lines = [
    'Split transaction created:',
    `  Account:  ${acct?.name || accountId}`,
    `  Date:     ${txnDate}`,
    `  Total:    ${formatMoney(totalCents)}`,
  ];
  if (input.payee) lines.push(`  Payee:    ${input.payee}`);
  if (input.notes) lines.push(`  Notes:    ${input.notes}`);
  lines.push(`  Splits (${input.splits.length}):`);
  input.splits.forEach((s, i) => {
    lines.push(
      `    - ${s.category}: ${formatMoney(splitCents[i])}` +
        (s.notes ? ` (${s.notes})` : ''),
    );
  });

  return lines;
}

export function registerCreateSplitTransaction(server: McpServer): void {
  server.tool(
    'create_split_transaction',
    'Add a split transaction: one bank-facing total spread across multiple categories. The split amounts must sum to the total.',
    {
      account: z.string().describe('Account name or ID'),
      amount: z
        .number()
        .describe(
          'Total amount (negative for expenses, positive for income). Must equal the sum of the splits.',
        ),
      allow_duplicate: z
        .boolean()
        .optional()
        .describe(
          'Create it even though a transaction with the same account, date and total ' +
            'already exists. The total is what a duplicate repeats; how it is divided is ' +
            'internal.',
        ),
      splits: z
        .array(
          z.object({
            category: z.string().describe('Category name or ID'),
            amount: z
              .number()
              .describe('Split amount (same sign as the total). Human amounts, not cents.'),
            notes: z.string().optional().describe('Notes for this split'),
          }),
        )
        .min(2)
        .describe('Two or more splits whose amounts sum to the total.'),
      payee: z.string().optional().describe('Payee name'),
      date: z
        .string()
        .optional()
        .describe('Transaction date (YYYY-MM-DD or "today", "yesterday"). Defaults to today.'),
      notes: z.string().optional().describe('Notes for the parent transaction'),
      cleared: z
        .boolean()
        .optional()
        .default(false)
        .describe('Whether the transaction is cleared'),
    },
    { title: 'Add split transaction', readOnlyHint: false },
    async (input) =>
      // Serialised with every other transaction write, so two calls
      // sent without awaiting the first cannot read each other half
      // done (#111).
      queueTransactionWrite(async () => {
      try {
        const lines = await createSplitTransaction(input);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        // A write that landed is not an error the caller should act on by
        // retrying, whatever the operation did afterwards. A duplicate landed
        // twice, so that applies to it most of all.
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
    ),
  );
}
