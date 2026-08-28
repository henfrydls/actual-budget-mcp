import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { amountToCents, formatMoney } from '../../utils/money.js';
import { resolveDate } from '../../utils/dates.js';
import { resolveAccountId, resolveCategoryId } from '../../utils/resolvers.js';
import { describeError } from '../../utils/errors.js';
import { updatePreservingChildAmount } from '../../utils/transactions.js';

export interface CreateTransactionInput {
  account: string;
  amount: number;
  payee?: string;
  category?: string;
  date?: string;
  notes?: string;
  cleared?: boolean;
}

/**
 * Create a single transaction, guaranteeing that an explicit `category` wins.
 *
 * The Actual SDK applies the learned payee→category mapping on add via its
 * internal rules engine. This happens regardless of `learnCategories: false`
 * (that flag only disables *learning* new mappings, not *applying* existing
 * ones), so the caller's explicit category can be silently overridden (#26).
 *
 * `api.addTransactions` resolves to the literal `'ok'` (never the new ids), so
 * we cannot read the created id from its return value. Instead we snapshot the
 * account's transactions for the date, add, then diff to locate the new one and
 * force the caller's category with `updateTransaction` (which does not re-run
 * the learning override, so the correction sticks).
 *
 * Returns the human-readable confirmation lines.
 */
export async function createTransaction(input: CreateTransactionInput): Promise<string[]> {
  await ensureConnection();

  const accountId = await resolveAccountId(input.account);
  const txnDate = resolveDate(input.date);
  const amountCents = amountToCents(input.amount);
  const accounts = await api.getAccounts();

  // A payee that names another on-budget account is a transfer: route it through
  // that account's transfer payee with runTransfers so both sides are linked (#24).
  let transferPayeeId: string | undefined;
  let transferTargetName: string | undefined;
  if (input.payee) {
    const lower = input.payee.toLowerCase();
    const target = accounts.find(
      (a) => !a.closed && (a.id === input.payee || a.name.toLowerCase() === lower),
    );
    if (target) {
      if (target.id === accountId) {
        throw new Error('Cannot transfer to the same account.');
      }
      const payees = await api.getPayees();
      const transferPayee = payees.find((p) => p.transfer_acct === target.id);
      if (!transferPayee) {
        throw new Error(`No transfer payee found for account "${target.name}".`);
      }
      transferPayeeId = transferPayee.id;
      transferTargetName = target.name;
    }
  }

  // A transfer carries no ordinary category; only resolve one for plain payees.
  const categoryId =
    !transferPayeeId && input.category ? await resolveCategoryId(input.category) : undefined;

  const transaction: Record<string, unknown> = {
    date: txnDate,
    amount: amountCents,
    cleared: input.cleared ?? false,
  };
  if (transferPayeeId) {
    transaction.payee = transferPayeeId;
  } else if (input.payee) {
    transaction.payee_name = input.payee;
  }
  if (categoryId) transaction.category = categoryId;
  if (input.notes) transaction.notes = input.notes;

  // Snapshot existing transactions on this date so we can identify the one we
  // are about to create (addTransactions returns 'ok', not ids).
  let beforeIds: Set<string> | undefined;
  if (categoryId) {
    const before = await api.getTransactions(accountId, txnDate, txnDate);
    beforeIds = new Set(before.map((t) => t.id));
  }

  await api.addTransactions(accountId, [transaction as any], {
    learnCategories: false,
    runTransfers: !!transferPayeeId,
  });

  // Force the explicit category on the newly created transaction(s) if the SDK
  // overrode it with a learned mapping.
  if (categoryId && beforeIds) {
    const after = await api.getTransactions(accountId, txnDate, txnDate);
    const created = after.filter((t) => !beforeIds!.has(t.id));
    for (const t of created) {
      if (t.category !== categoryId) {
        // #44: pass the amount we already have, so the update can never reset
        // it (no extra lookup needed — these rows come from getTransactions).
        await updatePreservingChildAmount(t.id, { category: categoryId, amount: t.amount });
      }
    }
    if (created.length === 0) {
      // Could not locate the created transaction (e.g. the SDK normalized the
      // date outside the queried window), so we could not enforce the category.
      // Warn on stderr — never stdout, which is the MCP protocol channel.
      console.error(
        `[create_transaction] warning: could not verify explicit category for the new transaction on ${txnDate}; it may have been overridden by a learned mapping.`,
      );
    }
  }

  await api.sync();

  const acct = accounts.find((a) => a.id === accountId);

  const lines = [
    transferPayeeId ? 'Transfer created:' : 'Transaction created:',
    `  Account:  ${acct?.name || accountId}`,
    `  Date:     ${txnDate}`,
    `  Amount:   ${formatMoney(amountCents)}`,
  ];
  if (transferPayeeId) {
    lines.push(`  Transfer to: ${transferTargetName}`);
  } else if (input.payee) {
    lines.push(`  Payee:    ${input.payee}`);
  }
  if (!transferPayeeId && input.category) lines.push(`  Category: ${input.category}`);
  if (input.notes) lines.push(`  Notes:    ${input.notes}`);

  return lines;
}

export function registerCreateTransaction(server: McpServer): void {
  server.tool(
    'create_transaction',
    'Add a new transaction to an account. Use negative amounts for expenses, positive for income.',
    {
      account: z.string().describe('Account name or ID'),
      amount: z
        .number()
        .describe(
          'Amount (negative for expenses, positive for income). Use human amounts like -150.50, not cents.',
        ),
      payee: z.string().optional().describe('Payee name'),
      category: z.string().optional().describe('Category name or ID'),
      date: z
        .string()
        .optional()
        .describe(
          'Transaction date (YYYY-MM-DD or "today", "yesterday"). Defaults to today.',
        ),
      notes: z.string().optional().describe('Transaction notes'),
      cleared: z
        .boolean()
        .optional()
        .default(false)
        .describe('Whether the transaction is cleared'),
    },
    { readOnlyHint: false },
    async (input) => {
      try {
        const lines = await createTransaction(input);
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
