import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { amountToCents, formatMoney } from '../../utils/money.js';
import { resolveDate } from '../../utils/dates.js';
import { resolveAccountId, resolveCategoryId } from '../../utils/resolvers.js';

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
    async ({ account, amount, payee, category, date, notes, cleared }) => {
      try {
        await ensureConnection();

        const accountId = await resolveAccountId(account);
        const txnDate = resolveDate(date);
        const amountCents = amountToCents(amount);

        const transaction: Record<string, unknown> = {
          date: txnDate,
          amount: amountCents,
          cleared: cleared,
        };

        if (payee) {
          transaction.payee_name = payee;
        }

        if (category) {
          transaction.category = await resolveCategoryId(category);
        }

        if (notes) {
          transaction.notes = notes;
        }

        await api.addTransactions(accountId, [transaction as any], {
          learnCategories: true,
          runTransfers: false,
        });

        await api.sync();

        // Get account name for confirmation
        const accounts = await api.getAccounts();
        const acct = accounts.find((a) => a.id === accountId);

        const lines = [
          'Transaction created:',
          `  Account:  ${acct?.name || accountId}`,
          `  Date:     ${txnDate}`,
          `  Amount:   ${formatMoney(amountCents)}`,
        ];
        if (payee) lines.push(`  Payee:    ${payee}`);
        if (category) lines.push(`  Category: ${category}`);
        if (notes) lines.push(`  Notes:    ${notes}`);

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
