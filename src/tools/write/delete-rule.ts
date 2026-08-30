import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { describeError } from '../../utils/errors.js';
import { requireConfirmation } from '../../utils/confirm.js';

export interface DeleteRuleInput {
  rule_id: string;
  confirm?: boolean;
}

/**
 * Delete a rule, behind the shared confirmation guard.
 *
 * Like `delete_transaction`, the target is an exact id, so no name echo. The
 * preview matters more here than elsewhere: a rule id says nothing about what
 * the rule does, so without spelling out its conditions and actions the caller
 * has no way to tell whether it is the right one.
 */
export async function deleteRuleGuarded(
  input: DeleteRuleInput,
): Promise<{ deleted: boolean; lines: string[] }> {
  await ensureConnection();

  const rules = await api.getRules();
  const rule = rules.find((r) => r.id === input.rule_id);

  // Reported as "not deleted" rather than thrown: the caller asked to remove
  // something that is already absent, which is not an error to recover from.
  if (!rule) {
    return { deleted: false, lines: [`Rule ${input.rule_id} not found. Nothing was deleted.`] };
  }

  // The SDK's rule type does not model conditions/actions/stage, though they
  // are present at runtime — `read/get-rules.ts` reads them the same way. A
  // narrow shape beats `any`: it keeps the fields typed where they are used.
  const detail = rule as unknown as {
    stage?: string;
    conditions?: Array<{ field: string; op: string; value: unknown }>;
    actions?: Array<{ field: string; op: string; value: unknown }>;
  };
  const conditions = detail.conditions ?? [];
  const actions = detail.actions ?? [];

  const confirmation = requireConfirmation({
    subject: `Rule: ${input.rule_id}`,
    losses: [
      `  Stage:      ${detail.stage ?? 'default'}`,
      `  Conditions: ${conditions.length}`,
      ...conditions.map((c) => `    - ${c.field} ${c.op} ${JSON.stringify(c.value)}`),
      `  Actions:    ${actions.length}`,
      ...actions.map((a) => `    - ${a.field} ${a.op} ${JSON.stringify(a.value)}`),
    ],
    input,
  });

  if (!confirmation.confirmed) {
    return { deleted: false, lines: confirmation.lines };
  }

  const result = await api.deleteRule(input.rule_id);
  await api.sync();

  if (!result) {
    return { deleted: false, lines: [`Rule ${input.rule_id} could not be deleted.`] };
  }
  return { deleted: true, lines: [`Rule ${input.rule_id} deleted.`] };
}

export function registerDeleteRule(server: McpServer): void {
  server.tool(
    'delete_rule',
    'Delete a transaction rule by its ID. Destructive and irreversible: the first call ' +
      'only previews the rule, and deleting requires confirm: true.',
    {
      rule_id: z.string().describe('Rule ID to delete'),
      confirm: z
        .boolean()
        .optional()
        .describe('Must be true to delete. Without it, the tool only previews.'),
    },
    { readOnlyHint: false, destructiveHint: true },
    async (input) => {
      try {
        const { deleted, lines } = await deleteRuleGuarded(input);
        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          ...(deleted ? {} : { isError: true }),
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${describeError(error)}` }],
          isError: true,
        };
      }
    },
  );
}
