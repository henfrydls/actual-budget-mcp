import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { resolveAccountId } from '../../utils/resolvers.js';
import { describeError } from '../../utils/errors.js';
import { syncNow } from '../../utils/sync-clock.js';

/**
 * Rename an account.
 *
 * Accounts could be created (#38) and deleted (#42) but not renamed, so
 * renaming meant opening the Actual app for something trivial (#87).
 *
 * ## Why only the name
 *
 * `api.updateAccount` also accepts `offbudget` and `closed`. Neither is here,
 * and that is a decision rather than an oversight:
 *
 *  - **`offbudget`** moves the whole account into or out of the budget, which
 *    changes every month's totals at once. That is the size of operation the
 *    delete tools ask for confirmation before doing, and it deserves the same
 *    treatment rather than sitting next to the name as another field.
 *  - **`closed`** has its own flow in the app, which asks where the remaining
 *    balance should go. Flipping the flag from here would be half of that
 *    operation, and `delete_account` already covers wanting an account gone.
 *
 * ## What the engine does not check, measured
 *
 *   updateAccount({ name: '' })       accepted, and the account is left with
 *                                     no name at all
 *   updateAccount({ name: '   ' })    accepted, the name is three spaces
 *   a second account called "Ahorro"  allowed, so two accounts can share a
 *                                     name and neither can be resolved by it
 *                                     afterwards
 *   updateAccount({ nickname: 'x' })  reaches SQLite as
 *                                     `no such column: nickname`
 *
 * The last one is why the update object is built here field by field and the
 * caller's input is never passed through.
 *
 * Renaming does **not** disturb anything else: measured, an on-budget account
 * stayed on-budget, an off-budget one stayed off-budget, the balance was
 * unchanged and the transactions were all still there.
 *
 * ## Closed accounts are out of reach
 *
 * `getAccounts()` omits closed accounts, and so does an AQL query on the
 * accounts table: measured, a closed account came back as `[]` from both.
 * `updateAccount` on one returns without error and nothing can read the
 * result. So a closed account cannot be renamed here, and cannot be confirmed
 * if it were.
 */
export function registerUpdateAccount(server: McpServer): void {
  server.tool(
    'update_account',
    'Rename an account. Transactions, balance and budget status are untouched.',
    {
      account: z.string().describe('Account name or ID to rename'),
      name: z.string().describe('The new name'),
    },
    { title: 'Rename an account', readOnlyHint: false, idempotentHint: true },
    async ({ account, name }) => {
      try {
        await ensureConnection();

        const newName = name.trim();
        if (newName.length === 0) {
          // The engine takes this and leaves the account with no name, which
          // nothing else in the app or here can then refer to.
          throw new Error('A new name is required. An empty name would leave the account unnamed.');
        }

        const accountId = await resolveAccountId(account);
        const accounts = await api.getAccounts();
        const current = accounts.find((a) => a.id === accountId);
        if (!current) {
          throw new Error(`Account "${account}" could not be read back after resolving it.`);
        }
        const oldName = current.name;

        if (oldName === newName) {
          return {
            content: [
              {
                type: 'text',
                text: `"${oldName}" is already called that. Nothing was changed.`,
              },
            ],
          };
        }

        // Actual allows two accounts to share a name, and then neither can be
        // resolved by it: every later call naming it is ambiguous or picks the
        // wrong one. Measured, creating a second "Ahorro" was accepted.
        const clash = accounts.find(
          (a) => a.id !== accountId && a.name.toLowerCase() === newName.toLowerCase(),
        );
        if (clash) {
          throw new Error(
            `Another account is already called "${clash.name}". Two accounts sharing a name ` +
              `cannot be told apart by name afterwards, so nothing was changed.`,
          );
        }

        // Built here rather than passed through: an unrecognised field reaches
        // SQLite as `no such column`.
        await api.updateAccount(accountId, { name: newName } as never);
        await syncNow();

        const after = (await api.getAccounts()).find((a) => a.id === accountId);
        if (!after || after.name !== newName) {
          return {
            content: [
              {
                type: 'text',
                text: [
                  `The rename was accepted but the account does not read back as "${newName}".`,
                  `It is currently ${after ? `"${after.name}"` : 'not readable'}.`,
                  'Check it in Actual before doing anything else.',
                ].join('\n'),
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: [
                `Renamed "${oldName}" to "${after.name}".`,
                '',
                'Transactions, balance and budget status are unchanged.',
              ].join('\n'),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${describeError(error)}` }],
          isError: true,
        };
      }
    },
  );
}
