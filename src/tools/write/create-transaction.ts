import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { amountToCents, formatMoney } from '../../utils/money.js';
import { resolveDate } from '../../utils/dates.js';
import { resolveAccountId, resolveCategoryId } from '../../utils/resolvers.js';
import { describeError } from '../../utils/errors.js';
import { mayHaveBeenApplied, verifyFailedWrite, WriteReportedError } from '../../utils/write-outcome.js';
import { probeWindow } from '../../utils/write-window.js';
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

  // Snapshot before writing, over a window rather than the single day: this is
  // what answers "did the write land?" if the call fails afterwards (#79), and
  // Actual's rules can move the date off the day we asked for.
  const window = probeWindow(txnDate);
  // A failed snapshot must not stop the write: it only costs the ability to
  // say afterwards what happened, which is reported as "unknown".
  let beforeIds: Set<string> | null = null;
  try {
    const before = await api.getTransactions(accountId, window.start, window.end);
    beforeIds = new Set((before ?? []).map((t) => t.id));
  } catch {
    beforeIds = null;
  }

  const acctName = accounts.find((a) => a.id === accountId)?.name || accountId;

  const probe = {
    before: beforeIds,
    window: window.label,
    read: () => api.getTransactions(accountId, window.start, window.end),
    // Amount alone is not enough: with two agents reconciling one statement,
    // the same amount on the same day in the same account is the normal case,
    // not a coincidence. Every field we sent is compared, and an unrecognised
    // new row makes the answer "unknown" rather than "not saved".
    matches: (row: Record<string, any>) =>
      row.amount === amountCents &&
      (input.notes === undefined || row.notes === input.notes) &&
      (transferPayeeId === undefined || row.payee === transferPayeeId),
  };

  // One wrapper around the whole write, not one per call. The middle step below
  // reads and updates the row that was just created, so by then it certainly
  // exists; leaving it outside meant the same error came out raw, with no
  // verdict at all, and only when a category was given, which is almost always.
  try {
    await api.addTransactions(accountId, [transaction as any], {
      learnCategories: false,
      runTransfers: !!transferPayeeId,
    });

    // Force the explicit category on the newly created transaction(s) if the
    // SDK overrode it with a learned mapping.
    if (categoryId) {
      const after = (await api.getTransactions(accountId, window.start, window.end)) ?? [];
      const created = beforeIds ? after.filter((t) => !beforeIds!.has(t.id)) : [];
      for (const t of created) {
        if (t.category !== categoryId) {
          // #44: pass the amount we already have, so the update can never reset
          // it (no extra lookup needed — these rows come from getTransactions).
          await updatePreservingChildAmount(t.id, { category: categoryId, amount: t.amount });
        }
      }
      if (created.length === 0) {
        // Warn on stderr — never stdout, which is the MCP protocol channel.
        console.error(
          `[create_transaction] warning: could not verify explicit category for the new transaction on ${txnDate}; it may have been overridden by a learned mapping.`,
        );
      }
    }

    await api.sync();
  } catch (error) {
    if (!mayHaveBeenApplied(error)) throw error;

    // Actual can apply a write and fail afterwards, so "Error" does not mean
    // "it did not happen". Go and look before saying anything.
    const { verdict, message } = await verifyFailedWrite(error, {
      action: 'The transaction',
      whereToLook: `${acctName} around ${txnDate}`,
      probe,
    });
    throw new WriteReportedError(message, verdict);
  }

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
    { title: 'Add transaction', readOnlyHint: false },
    async (input) => {
      try {
        const lines = await createTransaction(input);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        // A write that landed is not reported as an error, however the
        // operation ended: an agent reading "Error:" has every reason to try
        // again, and trying again is what duplicates.
        if (error instanceof WriteReportedError && error.verdict === 'applied') {
          return { content: [{ type: 'text', text: error.message }] };
        }
        const message = describeError(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
