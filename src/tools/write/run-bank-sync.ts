import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { resolveAccountId } from '../../utils/resolvers.js';

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
    { readOnlyHint: false },
    async ({ account }) => {
      try {
        await ensureConnection();

        const accounts = await api.getAccounts();

        if (account) {
          const accountId = await resolveAccountId(account);
          const acct = accounts.find((a) => a.id === accountId);

          await api.runBankSync({ accountId });
          await api.sync();

          return {
            content: [
              {
                type: 'text',
                text: `Bank sync completed for: ${acct?.name || accountId}`,
              },
            ],
          };
        }

        // Sync all accounts (no arg = all)
        await api.runBankSync();
        await api.sync();

        const openAccounts = accounts.filter((a) => !a.closed);
        return {
          content: [
            {
              type: 'text',
              text: `Bank sync completed for all linked accounts (${openAccounts.length} accounts).`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

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
  );
}
