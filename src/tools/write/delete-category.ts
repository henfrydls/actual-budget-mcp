import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { resolveCategoryId } from '../../utils/resolvers.js';
import { describeError } from '../../utils/errors.js';
import { requireConfirmation } from '../../utils/confirm.js';

const ALL_TIME_START = '1900-01-01';
const ALL_TIME_END = '9999-12-31';

export interface DeleteCategoryInput {
  category: string;
  transfer_to?: string;
  confirm?: boolean;
  confirm_name?: string;
}

/** Count how many transactions currently point at a category. */
async function countTransactions(categoryId: string): Promise<number> {
  const accounts = await api.getAccounts();
  let total = 0;
  for (const account of accounts) {
    const txns = await api.getTransactions(account.id, ALL_TIME_START, ALL_TIME_END);
    total += txns.filter((t) => t.category === categoryId).length;
  }
  return total;
}

/**
 * Delete a category, behind the shared confirmation guard.
 *
 * Actual removes the category's budget and rollover history along with it, and
 * cannot restore either. That loss is invisible at the moment of deletion and
 * usually surfaces months later, so it is worth a deliberate second call.
 */
export async function deleteCategoryGuarded(
  input: DeleteCategoryInput,
): Promise<{ deleted: boolean; lines: string[] }> {
  await ensureConnection();
  const categoryId = await resolveCategoryId(input.category);

  const categories = await api.getCategories();
  const cat = categories.find((c) => c.id === categoryId);
  const catName = cat?.name || input.category;

  const transferId = input.transfer_to ? await resolveCategoryId(input.transfer_to) : undefined;
  const transferCat = transferId ? categories.find((c) => c.id === transferId) : undefined;
  const affected = await countTransactions(categoryId);

  const confirmation = requireConfirmation({
    subject: `Category: ${catName}`,
    losses: [
      `  Transactions: ${affected}${
        transferCat ? ` (moved to ${transferCat.name})` : ' (left uncategorised)'
      }`,
      '',
      "This also destroys the category's budget and rollover history, which",
      'Actual cannot restore. The loss usually surfaces months later.',
    ],
    alternative: input.transfer_to
      ? undefined
      : 'Pass transfer_to with another category to keep the transactions categorised.',
    confirmName: catName,
    input,
  });

  if (!confirmation.confirmed) {
    return { deleted: false, lines: confirmation.lines };
  }

  await api.deleteCategory(categoryId, transferId);
  await api.sync();

  const lines = [`Category "${catName}" deleted.`];
  if (transferCat) {
    lines.push(`Transactions transferred to: ${transferCat.name}`);
  }
  return { deleted: true, lines };
}

export function registerDeleteCategory(server: McpServer): void {
  server.tool(
    'delete_category',
    'Delete a budget category. Destructive and irreversible: the first call only previews, ' +
      "and deleting requires confirm: true plus confirm_name set to the category's exact name. " +
      'Deleting a category also destroys its budget and rollover history; pass transfer_to to ' +
      'keep its transactions categorised.',
    {
      category: z.string().describe('Category name or ID to delete'),
      transfer_to: z
        .string()
        .optional()
        .describe('Category name or ID to transfer existing transactions to'),
      confirm: z
        .boolean()
        .optional()
        .describe('Must be true to delete. Without it, the tool only previews.'),
      confirm_name: z
        .string()
        .optional()
        .describe("The category's exact name, echoed back as a safeguard."),
    },
    { readOnlyHint: false, destructiveHint: true },
    async (input) => {
      try {
        const { deleted, lines } = await deleteCategoryGuarded(input);
        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          ...(deleted ? {} : { isError: true }),
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${describeError(error)}` }],
          isError: true,
        };
      }
    },
  );
}
