import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { amountToCents, formatMoney } from '../../utils/money.js';
import { resolveDate } from '../../utils/dates.js';
import { resolveAccountId } from '../../utils/resolvers.js';
import { describeError } from '../../utils/errors.js';
import { mayHaveBeenApplied, verifyFailedWrite } from '../../utils/write-outcome.js';

export function registerCreateTransfer(server: McpServer): void {
  server.tool(
    'create_transfer',
    'Create a transfer between two accounts.',
    {
      from_account: z.string().describe('Source account name or ID'),
      to_account: z.string().describe('Destination account name or ID'),
      amount: z
        .number()
        .describe('Transfer amount (positive number, e.g., 5000.00)'),
      date: z
        .string()
        .optional()
        .describe('Date (YYYY-MM-DD or natural language). Defaults to today.'),
      notes: z.string().optional().describe('Transfer notes'),
    },
    { title: 'Transfer between accounts', readOnlyHint: false },
    async ({ from_account, to_account, amount, date, notes }) => {
      try {
        await ensureConnection();

        const fromId = await resolveAccountId(from_account);
        const toId = await resolveAccountId(to_account);
        const txnDate = resolveDate(date);
        const amountCents = amountToCents(Math.abs(amount));

        // Find the transfer payee for the destination account
        const payees = await api.getPayees();
        const transferPayee = payees.find((p) => p.transfer_acct === toId);

        if (!transferPayee) {
          throw new Error(
            `Could not find transfer payee for destination account. This may indicate the account is not set up for transfers.`,
          );
        }

        const transaction: Record<string, unknown> = {
          date: txnDate,
          amount: -amountCents, // negative from source
          payee: transferPayee.id,
        };

        if (notes) {
          transaction.notes = notes;
        }

        // Snapshot first, so a failure afterwards can be answered rather than
        // guessed at. A repeated transfer moves the money twice and leaves two
        // pairs of linked rows to unpick (#79).
        const before = await api.getTransactions(fromId, txnDate, txnDate);
        const beforeIds = new Set((before ?? []).map((t) => t.id));

        // Get account names for confirmation
        const accounts = await api.getAccounts();
        const fromAcct = accounts.find((a) => a.id === fromId);
        const toAcct = accounts.find((a) => a.id === toId);

        try {
          await api.addTransactions(fromId, [transaction as any], {
            runTransfers: true,
          });
          await api.sync();
        } catch (error) {
          if (!mayHaveBeenApplied(error)) throw error;
          const { message } = await verifyFailedWrite(error, {
            action: 'The transfer',
            whereToLook: `${fromAcct?.name || fromId} on ${txnDate}`,
            probe: async () => {
              const after = await api.getTransactions(fromId, txnDate, txnDate);
              return (after ?? []).some(
                (t) => !beforeIds.has(t.id) && t.amount === -amountCents,
              );
            },
          });
          throw new Error(message);
        }

        return {
          content: [
            {
              type: 'text',
              text: [
                'Transfer created:',
                `  From:   ${fromAcct?.name || fromId}`,
                `  To:     ${toAcct?.name || toId}`,
                `  Amount: ${formatMoney(amountCents)}`,
                `  Date:   ${txnDate}`,
                notes ? `  Notes:  ${notes}` : '',
              ]
                .filter(Boolean)
                .join('\n'),
            },
          ],
        };
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
