import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { amountToCents, formatMoney } from '../../utils/money.js';
import { resolveDate } from '../../utils/dates.js';
import { resolveCategoryId } from '../../utils/resolvers.js';

export function registerUpdateTransaction(server: McpServer): void {
  server.tool(
    'update_transaction',
    'Update fields of an existing transaction. Only the fields you provide will be changed.',
    {
      transaction_id: z.string().describe('Transaction ID'),
      amount: z
        .number()
        .optional()
        .describe('New amount (negative for expenses, positive for income). Human amounts, not cents.'),
      payee: z.string().optional().describe('New payee name'),
      category: z.string().optional().describe('New category name or ID'),
      date: z
        .string()
        .optional()
        .describe('New date (YYYY-MM-DD or "today", "yesterday")'),
      notes: z.string().optional().describe('New notes'),
      cleared: z.boolean().optional().describe('Whether the transaction is cleared'),
    },
    async ({ transaction_id, amount, payee, category, date, notes, cleared }) => {
      try {
        await ensureConnection();

        const updates: Record<string, unknown> = {};
        const changes: string[] = [];

        if (amount !== undefined) {
          updates.amount = amountToCents(amount);
          changes.push(`Amount → ${formatMoney(updates.amount as number)}`);
        }

        if (payee !== undefined) {
          updates.payee_name = payee;
          changes.push(`Payee → ${payee}`);
        }

        if (category !== undefined) {
          updates.category = await resolveCategoryId(category);
          const categories = await api.getCategories();
          const cat = categories.find((c) => c.id === updates.category);
          changes.push(`Category → ${cat?.name || category}`);
        }

        if (date !== undefined) {
          updates.date = resolveDate(date);
          changes.push(`Date → ${updates.date}`);
        }

        if (notes !== undefined) {
          updates.notes = notes;
          changes.push(`Notes → ${notes}`);
        }

        if (cleared !== undefined) {
          updates.cleared = cleared;
          changes.push(`Cleared → ${cleared}`);
        }

        if (changes.length === 0) {
          return {
            content: [{ type: 'text', text: 'No fields to update. Provide at least one field to change.' }],
            isError: true,
          };
        }

        await api.updateTransaction(transaction_id, updates as any);
        await api.sync();

        const lines = [
          `Transaction ${transaction_id} updated:`,
          ...changes.map((c) => `  ${c}`),
        ];

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
