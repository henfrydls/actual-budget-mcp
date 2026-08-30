import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { resolveAccountId } from '../../utils/resolvers.js';
import { formatMoney } from '../../utils/money.js';
import { describeError } from '../../utils/errors.js';
import { requireConfirmation } from '../../utils/confirm.js';

// Same trick as list-accounts: a far-future cutoff yields the full balance
// instead of only transactions dated up to today (#21).
const FULL_BALANCE_CUTOFF = new Date('9999-12-31');
const ALL_TIME_START = '1900-01-01';
const ALL_TIME_END = '9999-12-31';

export interface DeleteAccountInput {
  account: string;
  confirm?: boolean;
  confirm_name?: string;
}

export interface DeleteAccountResult {
  deleted: boolean;
  lines: string[];
}

/**
 * Delete an account, behind deliberate guardrails.
 *
 * Deleting an account also destroys its transaction history, and an agent can
 * reach this tool from a vague instruction, so a single call is never enough:
 *
 *  1. The first call *previews* — it reports what would be lost and deletes
 *     nothing.
 *  2. `confirm: true` alone is still refused; the caller must also echo the
 *     account's exact name in `confirm_name` (the pattern GitHub uses for
 *     repository deletion), which makes a wrong-account deletion take a
 *     deliberate, verifiable step.
 *  3. The preview points at closing the account instead, which is Actual's
 *     non-destructive way to retire an account and keeps its history.
 */
export async function deleteAccountGuarded(
  input: DeleteAccountInput,
): Promise<DeleteAccountResult> {
  await ensureConnection();

  const accountId = await resolveAccountId(input.account);
  const accounts = await api.getAccounts();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) {
    throw new Error(`No account found matching "${input.account}".`);
  }

  // `api.deleteAccount` early-returns for an already-closed account, so it would
  // report a deletion that never happened. Worse, it unlinks bank sync *before*
  // that return, and Actual cannot undo an unlink. Refuse instead.
  if (account.closed) {
    throw new Error(
      `Account "${account.name}" is closed, and Actual cannot delete a closed account. ` +
        'Reopen it first if you really need it gone; otherwise leave it closed — ' +
        'closed accounts keep their history and stay out of the way.',
    );
  }

  const balance = await api.getAccountBalance(accountId, FULL_BALANCE_CUTOFF);
  const transactions = await api.getTransactions(accountId, ALL_TIME_START, ALL_TIME_END);
  const count = transactions.length;

  // Guardrails 1 and 2 (preview until confirmed, and the exact name echoed
  // back) live in the shared helper so every destructive tool enforces them
  // the same way.
  const confirmation = requireConfirmation({
    subject: `Account:      ${account.name}`,
    losses: [
      `  Balance:      ${formatMoney(balance)}`,
      `  Transactions: ${count} (deleted along with the account)`,
      '',
      'Two side effects Actual cannot undo:',
      '  - Any bank-sync link on this account is unlinked.',
      '  - Transfers pointing here lose their payee and transfer link in the',
      '    other account, leaving orphaned transactions there.',
    ],
    // Guardrail 3: offer the reversible option first.
    alternative:
      'Consider closing the account instead — in Actual, closing retires an\n' +
      'account while keeping its history, and it can be reopened later.',
    confirmName: account.name,
    input,
  });

  if (!confirmation.confirmed) {
    return { deleted: false, lines: confirmation.lines };
  }

  await api.deleteAccount(accountId);
  await api.sync();

  return {
    deleted: true,
    lines: [
      `Account "${account.name}" deleted.`,
      `  Balance was:  ${formatMoney(balance)}`,
      `  Transactions: ${count} removed`,
    ],
  };
}

export function registerDeleteAccount(server: McpServer): void {
  server.tool(
    'delete_account',
    'Delete an account and its entire transaction history. Destructive and irreversible: ' +
      'the first call only previews what would be lost, and deleting requires both ' +
      "confirm: true and confirm_name set to the account's exact name. Prefer closing an " +
      'account when you just want to retire it.',
    {
      account: z.string().describe('Account name or ID to delete'),
      confirm: z
        .boolean()
        .optional()
        .describe('Must be true to delete. Without it, the tool only previews.'),
      confirm_name: z
        .string()
        .optional()
        .describe(
          "The account's exact name, echoed back as a safeguard against deleting the wrong account.",
        ),
    },
    { readOnlyHint: false, destructiveHint: true },
    async (input) => {
      try {
        const { deleted, lines } = await deleteAccountGuarded(input);
        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          // Not deleting is reported as an error so the confirmation step is
          // never mistaken for a completed deletion.
          ...(deleted ? {} : { isError: true }),
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
