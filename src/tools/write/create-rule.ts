import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { resolveCategoryId } from '../../utils/resolvers.js';

export function registerCreateRule(server: McpServer): void {
  server.tool(
    'create_rule',
    'Create a transaction rule. When a transaction matches the condition, the action is applied automatically.',
    {
      condition_field: z.string().describe('Field to match: payee, category, amount, notes, imported_payee'),
      condition_op: z.string().describe('Operator: is, contains, oneOf, isNot, doesNotContain, matches, gt, lt, gte, lte'),
      condition_value: z.string().describe('Value to match against'),
      action_field: z.string().describe('Field to set: category, payee, notes'),
      action_value: z.string().describe('Value to set (category name/ID, payee name, or note text)'),
      stage: z.string().optional().default('null').describe('When to apply: null (default), pre, or post'),
    },
    { readOnlyHint: false },
    async ({ condition_field, condition_op, condition_value, action_field, action_value, stage }) => {
      try {
        await ensureConnection();

        // Resolve category names to IDs if needed
        let resolvedCondValue: any = condition_value;
        if (condition_field === 'category') {
          resolvedCondValue = await resolveCategoryId(condition_value);
        }

        let resolvedActionValue: any = action_value;
        if (action_field === 'category') {
          resolvedActionValue = await resolveCategoryId(action_value);
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
        await api.sync();

        return {
          content: [{
            type: 'text',
            text: `Rule created:\n  IF ${condition_field} ${condition_op} "${condition_value}"\n  THEN set ${action_field} = "${action_value}"\n  ID: ${(result as any).id}`,
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
