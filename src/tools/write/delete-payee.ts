import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { resolvePayeeId } from '../../utils/resolvers.js';
import { describeError } from '../../utils/errors.js';
import { requireConfirmation } from '../../utils/confirm.js';

const ALL_TIME_START = '1900-01-01';
const ALL_TIME_END = '9999-12-31';

export interface DeletePayeeInput {
  payee: string;
  confirm?: boolean;
  confirm_name?: string;
}

/**
 * Delete a payee, behind the shared confirmation guard.
 *
 * The transactions survive with their amounts intact, but they lose the payee,
 * which is often the only human-readable trace of what a line item was. The
 * preview reports how many are affected before that happens.
 */
export async function deletePayeeGuarded(
  input: DeletePayeeInput,
): Promise<{ deleted: boolean; lines: string[] }> {
  await ensureConnection();
  const payeeId = await resolvePayeeId(input.payee);

  const payees = await api.getPayees();
  const found = payees.find((x) => x.id === payeeId);
  const payeeName = found?.name || input.payee;

  const accounts = await api.getAccounts();
  let affected = 0;
  for (const account of accounts) {
    const txns = await api.getTransactions(account.id, ALL_TIME_START, ALL_TIME_END);
    affected += txns.filter((t) => t.payee === payeeId).length;
  }

  const confirmation = requireConfirmation({
    subject: `Payee: ${payeeName}`,
    losses: [
      `  Transactions referencing it: ${affected} (they keep their amounts but lose the payee)`,
    ],
    confirmName: payeeName,
    input,
  });

  if (!confirmation.confirmed) {
    return { deleted: false, lines: confirmation.lines };
  }

  await api.deletePayee(payeeId);
  await api.sync();

  return { deleted: true, lines: [`Payee "${payeeName}" deleted.`] };
}

export function registerDeletePayee(server: McpServer): void {
  server.tool(
    'delete_payee',
    'Delete a payee. Destructive and irreversible: the first call only previews, and ' +
      "deleting requires confirm: true plus confirm_name set to the payee's exact name.",
    {
      payee: z.string().describe('Payee name or ID to delete'),
      confirm: z
        .boolean()
        .optional()
        .describe('Must be true to delete. Without it, the tool only previews.'),
      confirm_name: z
        .string()
        .optional()
        .describe("The payee's exact name, echoed back as a safeguard."),
    },
    { readOnlyHint: false, destructiveHint: true },
    async (input) => {
      try {
        const { deleted, lines } = await deletePayeeGuarded(input);
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
