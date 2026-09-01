import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { resolveCategoryId } from '../../utils/resolvers.js';
import { describeError } from '../../utils/errors.js';

export interface UpdateRuleInput {
  rule_id: string;
  condition_field?: string;
  condition_op?: string;
  condition_value?: string;
  action_field?: string;
  action_value?: string;
  stage?: string;
}

/** The shape Actual stores a rule in. The SDK type does not model it. */
interface RuleShape {
  id: string;
  stage: string | null;
  conditionsOp?: string;
  conditions: Array<{ field: string; op: string; value: unknown }>;
  actions: Array<{ op: string; field: string; value: unknown }>;
}

/**
 * Edit an existing rule, completing the rule CRUD (get/create/delete were
 * there; update was not).
 *
 * The rule is read, amended in memory and sent back whole rather than as a
 * patch of the changed fields. Actual's `updateRule` does update column by
 * column, so a partial write would probably survive — but "probably survives a
 * partial write" is exactly the assumption that cost us #44, where an omitted
 * field was silently zeroed. Sending the full rule makes the outcome
 * independent of that behaviour.
 *
 * Returns the human-readable summary lines.
 */
export async function updateRuleFields(input: UpdateRuleInput): Promise<string[]> {
  await ensureConnection();

  const touchesCondition =
    input.condition_field !== undefined ||
    input.condition_op !== undefined ||
    input.condition_value !== undefined;
  const touchesAction = input.action_field !== undefined || input.action_value !== undefined;

  if (!touchesCondition && !touchesAction && input.stage === undefined) {
    throw new Error(
      'No fields to update. Provide at least one of: condition_field, condition_op, ' +
        'condition_value, action_field, action_value, stage.',
    );
  }

  const rules = (await api.getRules()) as unknown as RuleShape[];
  const rule = rules.find((r) => r.id === input.rule_id);
  if (!rule) {
    throw new Error(`Rule ${input.rule_id} not found. Use get_rules to list the existing rules.`);
  }

  const conditions = (rule.conditions ?? []).map((c) => ({ ...c }));
  const actions = (rule.actions ?? []).map((a) => ({ ...a }));
  const changes: string[] = [];

  if (touchesCondition) {
    const target = conditions[0] ?? { field: 'payee', op: 'is', value: '' };
    if (input.condition_field !== undefined) {
      target.field = input.condition_field;
      changes.push(`  Condition field → ${input.condition_field}`);
    }
    if (input.condition_op !== undefined) {
      target.op = input.condition_op;
      changes.push(`  Condition operator → ${input.condition_op}`);
    }
    if (input.condition_value !== undefined) {
      // A condition on category is stored by id, like create_rule does.
      target.value =
        target.field === 'category'
          ? await resolveCategoryId(input.condition_value)
          : input.condition_value;
      changes.push(`  Condition value → "${input.condition_value}"`);
    }
    conditions[0] = target;
  }

  if (touchesAction) {
    const target = actions[0] ?? { op: 'set', field: 'category', value: '' };
    if (input.action_field !== undefined) {
      target.field = input.action_field;
      changes.push(`  Action field → ${input.action_field}`);
    }
    if (input.action_value !== undefined) {
      target.value =
        target.field === 'category'
          ? await resolveCategoryId(input.action_value)
          : input.action_value;
      changes.push(`  Action value → "${input.action_value}"`);
    }
    actions[0] = target;
  }

  const updated: RuleShape = {
    ...rule,
    // `stage: 'null'` is how create_rule spells "no stage"; keep them consistent.
    stage: input.stage === undefined ? rule.stage : input.stage === 'null' ? null : input.stage,
    conditions,
    actions,
  };
  if (input.stage !== undefined) {
    changes.push(`  Stage → ${updated.stage ?? 'null'}`);
  }

  await api.updateRule(updated as unknown as Parameters<typeof api.updateRule>[0]);
  await api.sync();

  return [`Rule ${input.rule_id} updated:`, ...changes];
}

export function registerUpdateRule(server: McpServer): void {
  server.tool(
    'update_rule',
    'Edit an existing rule without recreating it: change what it matches, what it does, ' +
      'or when it runs. Only the fields you pass change; the rest of the rule is kept. ' +
      'Use get_rules first to find the rule id and see its current condition and action.',
    {
      rule_id: z.string().describe('Rule ID to update (from get_rules)'),
      condition_field: z
        .string()
        .optional()
        .describe('New field to match: payee, category, amount, notes, imported_payee'),
      condition_op: z
        .string()
        .optional()
        .describe('New operator: is, contains, oneOf, isNot, doesNotContain, matches, gt, lt, gte, lte'),
      condition_value: z.string().optional().describe('New value to match against'),
      action_field: z.string().optional().describe('New field to set: category, payee, notes'),
      action_value: z
        .string()
        .optional()
        .describe('New value to set (category name/ID, payee name, or note text)'),
      stage: z.string().optional().describe('When to apply: null, pre, or post'),
    },
    { readOnlyHint: false, idempotentHint: true },
    async (input) => {
      try {
        const lines = await updateRuleFields(input);
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${describeError(error)}` }],
          isError: true,
        };
      }
    },
  );
}
