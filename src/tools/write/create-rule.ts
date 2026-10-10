import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { resolveCategoryId, resolvePayeeIn } from '../../utils/resolvers.js';
import { describeError } from '../../utils/errors.js';
import { syncNow } from '../../utils/sync-clock.js';

export interface CreateRuleInput {
  condition_field: string;
  condition_op: string;
  condition_value: string;
  action_field: string;
  action_value: string;
  stage?: string;
}

/**
 * The condition operators that compare a payee by id. `contains`, `matches`
 * and `doesNotContain` take text, so their value is left as given.
 */
const PAYEE_ID_OPS = new Set(['is', 'isNot']);

/**
 * A payee value as Actual stores it in a rule: the payee's id.
 *
 * Actual stores `payee` in a rule as an id. The name used to be saved as
 * typed, so "IF payee is Amazon" was reported as created and never matched,
 * because transactions hold the id. Tested against the engine: an imported
 * Amazon transaction stayed uncategorised under exactly that rule.
 *
 * Conditions and actions match names the way the other tools do: an id, an
 * exact name, or part of a name when only one payee fits. A payee that does
 * not exist is refused on both sides. A condition on it could never match, and
 * an action used to create it, so a typo like "Amazn" quietly became a new
 * payee that the rule then moved transactions to.
 */
async function resolveRulePayee(value: string): Promise<string> {
  return resolvePayeeIn(await api.getPayees(), value);
}

/**
 * Build the rule from the tool's flat input and create it.
 *
 * Returns the lines reported back to the caller.
 */
export async function createRuleFromInput(input: CreateRuleInput): Promise<string[]> {
  const { condition_field, condition_op, condition_value, action_field, action_value } = input;
  const stage = input.stage ?? 'null';

  await ensureConnection();

  // Resolve category and payee names to IDs if needed
  let resolvedCondValue: any = condition_value;
  if (condition_field === 'category') {
    resolvedCondValue = await resolveCategoryId(condition_value);
  } else if (condition_field === 'payee' && PAYEE_ID_OPS.has(condition_op)) {
    resolvedCondValue = await resolveRulePayee(condition_value);
  }

  let resolvedActionValue: any = action_value;
  if (action_field === 'category') {
    resolvedActionValue = await resolveCategoryId(action_value);
  } else if (action_field === 'payee') {
    resolvedActionValue = await resolveRulePayee(action_value);
  }

  const rule = {
    stage: stage === 'null' ? null : stage,
    conditionsOp: 'and' as const,
    conditions: [
      {
        field: condition_field,
        op: condition_op,
        value: resolvedCondValue,
      },
    ],
    actions: [
      {
        op: 'set' as const,
        field: action_field,
        value: resolvedActionValue,
      },
    ],
  };

  const result = await api.createRule(rule as any);
  await syncNow();

  return [
    'Rule created:',
    `  IF ${condition_field} ${condition_op} "${condition_value}"`,
    `  THEN set ${action_field} = "${action_value}"`,
    `  ID: ${(result as any).id}`,
  ];
}

export function registerCreateRule(server: McpServer): void {
  server.tool(
    'create_rule',
    'Create a transaction rule. When a transaction matches the condition, the action is applied automatically.',
    {
      condition_field: z.string().describe('Field to match: payee, category, amount, notes, imported_payee'),
      condition_op: z.string().describe('Operator: is, contains, oneOf, isNot, doesNotContain, matches, gt, lt, gte, lte'),
      condition_value: z
        .string()
        .describe('Value to match against. For category, a name or ID; for payee, a name (part of one is fine if only one payee matches) or an ID.'),
      action_field: z.string().describe('Field to set: category, payee, notes'),
      action_value: z
        .string()
        .describe(
          'Value to set (category name/ID, payee name/ID, or note text). The payee must already exist; use create_payee for a new one.',
        ),
      stage: z.string().optional().default('null').describe('When to apply: null (default), pre, or post'),
    },
    { title: 'Create automation rule', readOnlyHint: false },
    async (input) => {
      try {
        const lines = await createRuleFromInput(input);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        const message = describeError(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
