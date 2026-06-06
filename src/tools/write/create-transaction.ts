import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { amountToCents, formatMoney } from '../../utils/money.js';
import { resolveDate } from '../../utils/dates.js';
import { resolveAccountId, resolveCategoryId } from '../../utils/resolvers.js';

export interface CreateTransactionInput {
  account: string;
  amount: number;
  payee?: string;
  category?: string;
  date?: string;
  notes?: string;
  cleared?: boolean;
}

/**
 * Create a single transaction, guaranteeing that an explicit `category` wins.
 *
 * The Actual SDK applies the learned payee→category mapping on add via its
 * internal rules engine. This happens regardless of `learnCategories: false`
 * (that flag only disables *learning* new mappings, not *applying* existing
 * ones), so the caller's explicit category can be silently overridden (#26).
 *
 * `api.addTransactions` resolves to the literal `'ok'` (never the new ids), so
 * we cannot read the created id from its return value. Instead we snapshot the
 * account's transactions for the date, add, then diff to locate the new one and
 * force the caller's category with `updateTransaction` (which does not re-run
 * the learning override, so the correction sticks).
 *
 * Returns the human-readable confirmation lines.
 */
export async function createTransaction(input: CreateTransactionInput): Promise<string[]> {
  await ensureConnection();

  const accountId = await resolveAccountId(input.account);
  const txnDate = resolveDate(input.date);
  const amountCents = amountToCents(input.amount);
  const categoryId = input.category ? await resolveCategoryId(input.category) : undefined;

  const transaction: Record<string, unknown> = {
    date: txnDate,
    amount: amountCents,
    cleared: input.cleared ?? false,
  };
  if (input.payee) transaction.payee_name = input.payee;
  if (categoryId) transaction.category = categoryId;
  if (input.notes) transaction.notes = input.notes;

  // Snapshot existing transactions on this date so we can identify the one we
  // are about to create (addTransactions returns 'ok', not ids).
  let beforeIds: Set<string> | undefined;
  if (categoryId) {
    const before = await api.getTransactions(accountId, txnDate, txnDate);
    beforeIds = new Set(before.map((t) => t.id));
  }

  await api.addTransactions(accountId, [transaction as any], {
    learnCategories: false,
    runTransfers: false,
  });

  // Force the explicit category on the newly created transaction(s) if the SDK
  // overrode it with a learned mapping.
  if (categoryId && beforeIds) {
    const after = await api.getTransactions(accountId, txnDate, txnDate);
    const created = after.filter((t) => !beforeIds!.has(t.id));
    for (const t of created) {
      if (t.category !== categoryId) {
        await api.updateTransaction(t.id, { category: categoryId });
      }
    }
    if (created.length === 0) {
      // Could not locate the created transaction (e.g. the SDK normalized the
      // date outside the queried window), so we could not enforce the category.
      // Warn on stderr — never stdout, which is the MCP protocol channel.
      console.error(
        `[create_transaction] warning: could not verify explicit category for the new transaction on ${txnDate}; it may have been overridden by a learned mapping.`,
      );
    }
  }

  await api.sync();

  const accounts = await api.getAccounts();
  const acct = accounts.find((a) => a.id === accountId);

  const lines = [
    'Transaction created:',
    `  Account:  ${acct?.name || accountId}`,
    `  Date:     ${txnDate}`,
    `  Amount:   ${formatMoney(amountCents)}`,
  ];
  if (input.payee) lines.push(`  Payee:    ${input.payee}`);
  if (input.category) lines.push(`  Category: ${input.category}`);
  if (input.notes) lines.push(`  Notes:    ${input.notes}`);

  return lines;
}

export function registerCreateTransaction(server: McpServer): void {
  server.tool(
    'create_transaction',
    'Add a new transaction to an account. Use negative amounts for expenses, positive for income.',
    {
      account: z.string().describe('Account name or ID'),
      amount: z
        .number()
        .describe(
          'Amount (negative for expenses, positive for income). Use human amounts like -150.50, not cents.',
        ),
      payee: z.string().optional().describe('Payee name'),
      category: z.string().optional().describe('Category name or ID'),
      date: z
        .string()
        .optional()
        .describe(
          'Transaction date (YYYY-MM-DD or "today", "yesterday"). Defaults to today.',
        ),
      notes: z.string().optional().describe('Transaction notes'),
      cleared: z
        .boolean()
        .optional()
        .default(false)
        .describe('Whether the transaction is cleared'),
    },
    { readOnlyHint: false },
    async (input) => {
      try {
        const lines = await createTransaction(input);
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
