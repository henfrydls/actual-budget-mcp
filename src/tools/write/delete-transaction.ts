import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { formatMoney } from '../../utils/money.js';
import { describeError } from '../../utils/errors.js';
import { requireConfirmation } from '../../utils/confirm.js';

const ALL_TIME_START = '2000-01-01';

export interface DeleteTransactionInput {
  transaction_id: string;
  confirm?: boolean;
}

/**
 * Delete a transaction, behind the shared confirmation guard.
 *
 * No `confirm_name` here: the target is an exact id, so there is no
 * wrong-target ambiguity for a name echo to catch and requiring one would be
 * empty ceremony. The preview carries the weight instead — it shows the
 * transaction so the caller can see whether it is the one they meant.
 */
export async function deleteTransactionGuarded(
  input: DeleteTransactionInput,
): Promise<{ deleted: boolean; lines: string[] }> {
  await ensureConnection();

  const accounts = await api.getAccounts();
  const categories = await api.getCategories();
  const categoryMap = new Map(categories.filter((c) => 'group_id' in c).map((c) => [c.id, c.name]));
  const payees = await api.getPayees();
  const payeeMap = new Map(payees.map((p) => [p.id, p.name]));

  const today = new Date().toISOString().slice(0, 10);
  const details: string[] = [];
  let isSplitParent = false;

  for (const acct of accounts) {
    if (acct.closed) continue;
    const txns = await api.getTransactions(acct.id, ALL_TIME_START, today);
    const found = txns.find((t) => t.id === input.transaction_id);
    if (!found) continue;

    const payeeName = found.payee ? payeeMap.get(found.payee) || '' : '';
    const catName = found.category ? categoryMap.get(found.category) || '' : '';
    isSplitParent = Boolean((found as { is_parent?: boolean }).is_parent);
    details.push(
      `  Date:     ${found.date}`,
      `  Amount:   ${formatMoney(found.amount)}`,
      ...(payeeName ? [`  Payee:    ${payeeName}`] : []),
      ...(catName ? [`  Category: ${catName}`] : []),
      `  Account:  ${acct.name}`,
    );
    break;
  }

  if (details.length === 0) {
    details.push('  (transaction not found in any open account)');
  }
  if (isSplitParent) {
    details.push('', 'This is a split parent: all of its child transactions are deleted with it.');
  }

  const confirmation = requireConfirmation({
    subject: `Transaction: ${input.transaction_id}`,
    losses: details,
    input,
  });

  if (!confirmation.confirmed) {
    return { deleted: false, lines: confirmation.lines };
  }

  await api.deleteTransaction(input.transaction_id);
  await api.sync();

  return {
    deleted: true,
    lines: [`Transaction ${input.transaction_id} deleted.`, 'Deleted transaction:', ...details],
  };
}

export function registerDeleteTransaction(server: McpServer): void {
  server.tool(
    'delete_transaction',
    'Delete a transaction by its ID. Destructive and irreversible: the first call only ' +
      'previews what would be lost, and deleting requires confirm: true.',
    {
      transaction_id: z.string().describe('Transaction ID to delete'),
      confirm: z
        .boolean()
        .optional()
        .describe('Must be true to delete. Without it, the tool only previews.'),
    },
    { readOnlyHint: false, destructiveHint: true },
    async (input) => {
      try {
        const { deleted, lines } = await deleteTransactionGuarded(input);
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
