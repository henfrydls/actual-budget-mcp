import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { amountToCents, formatMoney } from '../../utils/money.js';
import { describeError } from '../../utils/errors.js';

export interface CreateAccountInput {
  name: string;
  offBudget?: boolean;
  initialBalance?: number;
}

/**
 * Create a new account (#38). Without this, any workflow that needs a new
 * account — a loan, an investment vehicle, a savings pot — had to stop and be
 * finished by hand in the Actual UI.
 *
 * An `initialBalance` produces Actual's opening "Starting Balance" transaction.
 *
 * There is deliberately no `type` option: Actual models accounts as on-budget
 * or off-budget only (`APIAccountEntity` has no `type` field), so accepting one
 * would report a change the API silently discards.
 *
 * Returns the human-readable confirmation lines, including the new account id
 * so follow-up calls can target it.
 */
export async function createNewAccount(input: CreateAccountInput): Promise<string[]> {
  if (!input.name || input.name.trim() === '') {
    throw new Error('Account name is required.');
  }

  await ensureConnection();

  const offbudget = input.offBudget ?? false;
  const initialCents = input.initialBalance !== undefined ? amountToCents(input.initialBalance) : 0;

  const accountId = await api.createAccount(
    {
      name: input.name.trim(),
      offbudget,
    },
    initialCents,
  );

  await api.sync();

  const lines = [
    'Account created:',
    `  Name:    ${input.name.trim()}`,
    `  Budget:  ${offbudget ? 'off-budget' : 'on-budget'}`,
  ];
  if (initialCents !== 0) lines.push(`  Balance: ${formatMoney(initialCents)}`);
  lines.push(`  ID:      ${accountId}`);

  return lines;
}

export function registerCreateAccount(server: McpServer): void {
  server.tool(
    'create_account',
    'Create a new budget account (on-budget or off-budget). Returns the new account ID ' +
      'so transactions can target it right away.',
    {
      name: z.string().describe('Account name'),
      offBudget: z
        .boolean()
        .optional()
        .describe(
          'Whether the account is off-budget (tracked but outside the budget, e.g. a loan or investment). Defaults to false.',
        ),
      initialBalance: z
        .number()
        .optional()
        .describe(
          'Opening balance in human amounts (e.g. 1500.50, not cents). Creates the "Starting Balance" transaction.',
        ),
    },
    { readOnlyHint: false },
    async (input) => {
      try {
        const lines = await createNewAccount(input);
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
