import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { amountToCents, formatMoney } from '../../utils/money.js';
import { resolveDate } from '../../utils/dates.js';
import { resolveAccountId, resolveCategoryId } from '../../utils/resolvers.js';

export interface SplitInput {
  category: string;
  amount: number;
  notes?: string;
}

export interface CreateSplitTransactionInput {
  account: string;
  amount: number;
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

  await api.addTransactions(accountId, [parent as any], {
    learnCategories: false,
    runTransfers: false,
  });

  await api.sync();

  const accounts = await api.getAccounts();
  const acct = accounts.find((a) => a.id === accountId);

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
    { readOnlyHint: false },
    async (input) => {
      try {
        const lines = await createSplitTransaction(input);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
