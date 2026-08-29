import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { amountToCents, formatMoney } from '../../utils/money.js';
import { resolveDate } from '../../utils/dates.js';
import { resolveCategoryId, resolvePayeeName } from '../../utils/resolvers.js';
import { updatePreservingChildAmount } from '../../utils/transactions.js';
import { describeError } from '../../utils/errors.js';

export interface UpdateTransactionInput {
  transaction_id: string;
  amount?: number;
  payee?: string;
  category?: string;
  date?: string;
  notes?: string;
  cleared?: boolean;
}

/**
 * Update fields of an existing transaction. Only the provided fields change.
 *
 * #25: updating a split sub-transaction without an explicit `amount` makes the
 * SDK reset that sub-transaction's amount to 0 (silent corruption of the split
 * total). To prevent this, when no `amount` is provided we look up the target;
 * if it is a sub-transaction (`is_child`), we re-send its current amount so it
 * is preserved. The preserved amount is not reported as a change.
 *
 * Returns the human-readable confirmation lines.
 */
export async function updateTransactionFields(input: UpdateTransactionInput): Promise<string[]> {
  await ensureConnection();

  const updates: Record<string, unknown> = {};
  const changes: string[] = [];

  if (input.amount !== undefined) {
    updates.amount = amountToCents(input.amount);
    changes.push(`Amount → ${formatMoney(updates.amount as number)}`);
  }

  if (input.payee !== undefined) {
    // #37: updateTransaction only accepts a payee *id*. `payee_name` is an
    // import-only convenience field, and passing it here makes the SDK throw
    // ("Field payee_name does not exist on table transactions") outside our
    // try/catch, which used to take the whole server process down.
    if (input.payee.trim() === '') {
      throw new Error(
        'Payee cannot be blank. Actual has no "no payee" value to set here; ' +
          'pass a payee name, or leave the payee out to keep the current one.',
      );
    }
    // An id may come straight from get_transactions output; treating it as a
    // name would create a junk payee named with the UUID.
    const payees = await api.getPayees();
    const byId = payees.find((p) => p.id === input.payee);
    const existing = byId?.id ?? (await resolvePayeeName(input.payee));
    updates.payee = existing ?? (await api.createPayee({ name: input.payee }));
    changes.push(`Payee → ${byId?.name || input.payee}`);
  }

  if (input.category !== undefined) {
    updates.category = await resolveCategoryId(input.category);
    const categories = await api.getCategories();
    const cat = categories.find((c) => c.id === updates.category);
    changes.push(`Category → ${cat?.name || input.category}`);
  }

  if (input.date !== undefined) {
    updates.date = resolveDate(input.date);
    changes.push(`Date → ${updates.date}`);
  }

  if (input.notes !== undefined) {
    updates.notes = input.notes;
    changes.push(`Notes → ${input.notes}`);
  }

  if (input.cleared !== undefined) {
    updates.cleared = input.cleared;
    changes.push(`Cleared → ${input.cleared}`);
  }

  if (changes.length === 0) {
    throw new Error('No fields to update. Provide at least one field to change.');
  }

  // #25/#44: the guard that preserves a sub-transaction's amount lives in
  // updatePreservingChildAmount so every write path shares it.
  await updatePreservingChildAmount(input.transaction_id, updates);
  await api.sync();

  return [`Transaction ${input.transaction_id} updated:`, ...changes.map((c) => `  ${c}`)];
}

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
    { readOnlyHint: false, idempotentHint: true },
    async (input) => {
      try {
        const lines = await updateTransactionFields(input);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        const message = describeError(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
