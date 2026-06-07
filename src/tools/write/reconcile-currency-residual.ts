import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { amountToCents, centsToAmount, formatMoney } from '../../utils/money.js';
import { resolveAccountId } from '../../utils/resolvers.js';
import { createTransaction } from './create-transaction.js';

export interface ReconcileResidualInput {
  account: string;
  category: string;
  target_balance?: number;
  notes?: string;
  date?: string;
  payee?: string;
}

/**
 * Reconcile a multi-currency residual: when an account tracks foreign-currency
 * activity in local-currency equivalents, FX-rate drift leaves a residual even
 * when the bank reports a different (often zero) outstanding balance.
 *
 * Computes the delta between the account's current balance and `target_balance`
 * (what the bank reports, default 0) and books a single adjustment transaction
 * in `category` to close the gap. Returns the confirmation lines.
 */
export async function reconcileCurrencyResidual(input: ReconcileResidualInput): Promise<string[]> {
  await ensureConnection();

  const accountId = await resolveAccountId(input.account);
  const currentCents = await api.getAccountBalance(accountId);
  const targetCents = amountToCents(input.target_balance ?? 0);
  const deltaCents = targetCents - currentCents;

  const accounts = await api.getAccounts();
  const acctName = accounts.find((a) => a.id === accountId)?.name || accountId;

  if (deltaCents === 0) {
    return [
      `No adjustment needed: ${acctName} already at ${formatMoney(currentCents)}.`,
    ];
  }

  const lines = await createTransaction({
    account: accountId,
    amount: centsToAmount(deltaCents),
    category: input.category,
    notes: input.notes || 'FX residual adjustment',
    date: input.date,
    payee: input.payee,
  });

  return [
    'Currency residual reconciled:',
    `  Account:    ${acctName}`,
    `  Was:        ${formatMoney(currentCents)}`,
    `  Target:     ${formatMoney(targetCents)}`,
    `  Adjustment: ${formatMoney(deltaCents)}`,
    ...lines,
  ];
}

export function registerReconcileCurrencyResidual(server: McpServer): void {
  server.tool(
    'reconcile_currency_residual',
    'Book an adjustment transaction to bring a multi-currency account to the balance the bank reports, clearing accumulated FX-rate residual.',
    {
      account: z.string().describe('Account name or ID to reconcile'),
      category: z.string().describe('Category to book the adjustment under (name or ID)'),
      target_balance: z
        .number()
        .optional()
        .default(0)
        .describe('Balance the bank reports for this account (human amount). Defaults to 0.'),
      notes: z
        .string()
        .optional()
        .describe('Note for the adjustment. Defaults to "FX residual adjustment".'),
      date: z
        .string()
        .optional()
        .describe('Date for the adjustment (YYYY-MM-DD or "today"). Defaults to today.'),
      payee: z.string().optional().describe('Optional payee for the adjustment'),
    },
    { readOnlyHint: false },
    async (input) => {
      try {
        const lines = await reconcileCurrencyResidual(input);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
