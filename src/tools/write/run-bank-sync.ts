import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { resolveAccountId } from '../../utils/resolvers.js';
import { describeError } from '../../utils/errors.js';
import { queueTransactionWrite } from '../../utils/transaction-writes.js';
import { syncNow } from '../../utils/sync-clock.js';
import { describeSync, type SyncOutcome } from '../../utils/bank-sync-report.js';

export function registerRunBankSync(server: McpServer): void {
  server.tool(
    'run_bank_sync',
    'Sync bank transactions from linked accounts (GoCardless/SimpleFIN). Syncs a specific account or all linked accounts if none specified.',
    {
      account: z
        .string()
        .optional()
        .describe('Account name or ID to sync. If omitted, syncs all linked accounts.'),
    },
    { title: 'Sync with bank', readOnlyHint: false },
    async ({ account }) =>
      // Queued with every other transaction write. A bank sync imports rows,
      // so a create running beside it checks for duplicates against a table
      // being filled underneath it — the /actualiza case. It can take a while,
      // and other writes wait: that is the point, since writing transactions
      // while the bank's are arriving is what duplicates them (#111).
      queueTransactionWrite(async () => {
      try {
        await ensureConnection();

        const accounts = await api.getAccounts();

        if (account) {
          const accountId = await resolveAccountId(account);
          const acct = accounts.find((a) => a.id === accountId);

          // From 26.11 this answers what it brought in; before that it
          // answers nothing, and `describeSync` says nothing in return
          // rather than guessing (#221).
          const outcome = (await api.runBankSync({ accountId })) as unknown as
            | SyncOutcome
            | undefined;
          await syncNow();

          return {
            content: [
              {
                type: 'text',
                text: [
                  `Bank sync completed for: ${acct?.name || accountId}`,
                  ...(await describeSync(outcome, accounts)),
                ].join('\n'),
              },
            ],
          };
        }

        // Sync all accounts (no arg = all)
        const outcome = (await api.runBankSync()) as unknown as SyncOutcome | undefined;
        await syncNow();

        const openAccounts = accounts.filter((a) => !a.closed);
        return {
          content: [
            {
              type: 'text',
              text: [
                `Bank sync completed for all linked accounts (${openAccounts.length} accounts).`,
                ...(await describeSync(outcome, accounts)),
              ].join('\n'),
            },
          ],
        };
      } catch (error) {
        const message = describeError(error);

        if (message.includes('not linked') || message.includes('no bank')) {
          return {
            content: [
              {
                type: 'text',
                text: `Bank sync failed: ${message}. Make sure your accounts are linked to a bank provider (GoCardless or SimpleFIN) in Actual Budget settings.`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        };
      }
      },
    ),
  );
}
