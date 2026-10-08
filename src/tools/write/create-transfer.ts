import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { amountToCents, formatMoney } from '../../utils/money.js';
import { resolveDate } from '../../utils/dates.js';
import { resolveAccountId } from '../../utils/resolvers.js';
import { describeError } from '../../utils/errors.js';
import { mayHaveBeenApplied, verifyFailedWrite, WriteReportedError } from '../../utils/write-outcome.js';
import { newWriteMarker, findByMarker, corroborateAbsence } from '../../utils/write-marker.js';
import { queueTransactionWrite } from '../../utils/transaction-writes.js';
import {
  findPossibleDuplicates,
  describePossibleDuplicates,
} from '../../utils/duplicate-check.js';

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
      allow_duplicate: z
        .boolean()
        .optional()
        .describe(
          'Create it even though a transfer between the same two accounts, on the same ' +
            'date, for the same amount already exists. Two identical transfers in one day ' +
            'are ordinary: a cash withdrawal split across two operations, or a card paid ' +
            'twice.',
        ),
    },
    { title: 'Transfer between accounts', readOnlyHint: false },
    async ({ from_account, to_account, amount, date, notes, allow_duplicate }) =>
      // Serialised with every other transaction write, so two calls
      // sent without awaiting the first cannot read each other half
      // done (#111).
      queueTransactionWrite(async () => {
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

        // The same check every other write uses, on the row this is about to
        // write: the source account, this date, this amount (#98).
        //
        // Both ways of asking land here. A transfer of 100 from A to B writes
        // A -100, and asking for -100 from B to A writes the same two rows, so
        // looking at the source row catches either spelling.
        //
        // Narrowed to the same pair of accounts, which the comparator already
        // tells us: for a transfer leg the payee is named after the account on
        // the other side, measured. Without that, a withdrawal of the same
        // amount to a different account on the same day would be reported as a
        // duplicate of this one, and in a real budget money moves through
        // several accounts in a day.
        if (!allow_duplicate) {
          const existing = await findPossibleDuplicates(fromId, txnDate, -amountCents);
          const toName = (await api.getAccounts()).find((a) => a.id === toId)?.name;
          const sameTransfer = existing.filter(
            (t) => t.isTransfer && t.payeeName && toName && t.payeeName === toName,
          );
          if (sameTransfer.length > 0) {
            const fromName =
              (await api.getAccounts()).find((a) => a.id === fromId)?.name ?? from_account;
            return {
              content: [
                {
                  type: 'text' as const,
                  text: describePossibleDuplicates(sameTransfer, fromName, [
                    'Same two accounts, same date, same amount. If this is a second, genuine',
                    'movement rather than the same one recorded twice, call again with',
                    'allow_duplicate: true. Two identical transfers in a day are ordinary:',
                    'a withdrawal split across two operations, or a card paid twice.',
                  ]).join('\n'),
                },
              ],
            };
          }
        }

        const transaction: Record<string, unknown> = {
          date: txnDate,
          amount: -amountCents, // negative from source
          payee: transferPayee.id,
        };

        if (notes) {
          transaction.notes = notes;
        }

        // Given its id before sending, so a failure afterwards can be answered
        // by identity rather than guessed at (#79, #93). A repeated transfer
        // moves the money twice and leaves two pairs of linked rows to unpick.
        const marker = newWriteMarker();
        transaction.id = marker;

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
          const { verdict, message } = await verifyFailedWrite(error, {
            action: 'The transfer',
            whereToLook: `${fromAcct?.name || fromId} on ${txnDate}`,
            probe: {
            marker,
            find: findByMarker,
            corroborate: () => corroborateAbsence(fromId, marker),
          },
          });
          throw new WriteReportedError(message, verdict);
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
