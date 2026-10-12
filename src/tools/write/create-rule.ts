import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { resolveCategoryId, resolvePayeeIn } from '../../utils/resolvers.js';
import { describeError } from '../../utils/errors.js';
import { isTextOpOnIdField, refuseTextOpOnIdField } from '../../utils/rule-fields.js';
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
 * A payee value as Actual stores it in a rule: the payee's id, and the name it
 * belongs to.
 *
 * Actual stores `payee` in a rule as an id. The name used to be saved as
 * typed, so "IF payee is Amazon" was reported as created and never matched,
 * because transactions hold the id. Tested against the engine: an imported
 * Amazon transaction stayed uncategorised under exactly that rule.
 *
 * An id, or a name in full. Not part of a name, which the tools that resolve
 * an account or a category do accept: those answer one call, and this is
 * stored and keeps running until somebody deletes it. "Uber" saved as "Uber
 * Eats", because that was the only payee containing it, recategorises
 * transactions for months under a rule whose reply said "Uber".
 *
 * A payee that does not exist is refused on both sides. A condition on it
 * could never match, and an action used to create it, so a typo like "Amazn"
 * quietly became a new payee that the rule then moved transactions to.
 *
 * The name comes back as well so the reply can say which payee this turned
 * out to be, which is the other half of the same problem: the caller typed
 * something, and what the rule holds is an id they cannot read.
 */
async function resolveRulePayee(value: string): Promise<{ id: string; name: string }> {
  const payees = await api.getPayees();
  const id = resolvePayeeIn(payees, value);
  return { id, name: payees.find((p) => p.id === id)?.name ?? value };
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

  // Refused before anything is resolved or created (#169). The engine accepts
  // these and the rule then fires on the wrong transactions, with nothing
  // saying so: a rule is stored, so this is the one chance to stop it.
  if (isTextOpOnIdField(condition_field, condition_op)) {
    throw new Error(refuseTextOpOnIdField(condition_field, condition_op));
  }

  // Resolve category and payee names to IDs if needed
  let resolvedCondValue: any = condition_value;
  let conditionPayee: { id: string; name: string } | undefined;
  if (condition_field === 'category') {
    resolvedCondValue = await resolveCategoryId(condition_value);
  } else if (condition_field === 'payee' && PAYEE_ID_OPS.has(condition_op)) {
    conditionPayee = await resolveRulePayee(condition_value);
    resolvedCondValue = conditionPayee.id;
  }

  let resolvedActionValue: any = action_value;
  let actionPayee: { id: string; name: string } | undefined;
  if (action_field === 'category') {
    resolvedActionValue = await resolveCategoryId(action_value);
  } else if (action_field === 'payee') {
    actionPayee = await resolveRulePayee(action_value);
    resolvedActionValue = actionPayee.id;
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

  // Which payee this turned out to be, said rather than left to be trusted.
  // The caller typed a name and the rule holds an id, so a name that matched
  // one they did not have in mind is invisible otherwise, and a rule runs
  // until somebody deletes it.
  const matched: string[] = [];
  if (conditionPayee) {
    matched.push(`  Condition payee: ${conditionPayee.name} (${conditionPayee.id})`);
  }
  if (actionPayee) {
    matched.push(`  Action payee: ${actionPayee.name} (${actionPayee.id})`);
  }

  return [
    'Rule created:',
    `  IF ${condition_field} ${condition_op} "${condition_value}"`,
    `  THEN set ${action_field} = "${action_value}"`,
    ...matched,
    `  ID: ${(result as any).id}`,
  ];
}

export function registerCreateRule(server: McpServer): void {
  server.tool(
    'create_rule',
    'Create a transaction rule. When a transaction matches the condition, the action is applied automatically.',
    {
      condition_field: z
        .string()
        .describe(
          'Field to match: payee, payee_name, category, category_group, account, amount, ' +
            'notes, imported_payee',
        ),
      condition_op: z
        .string()
        .describe(
          'Operator: is, isNot, contains, doesNotContain, matches, gt, lt, gte, lte. ' +
            'contains, doesNotContain and matches are refused on payee, category, ' +
            'category_group and account, which Actual stores as ids: they would compare ' +
            'against the id. For text on a payee, imported_payee holds what the row arrived with, ' +
            'and payee_name the payee name, once that payee exists.',
        ),
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
