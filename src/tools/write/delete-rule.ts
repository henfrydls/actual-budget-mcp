import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { describeError } from '../../utils/errors.js';
import { requireConfirmation } from '../../utils/confirm.js';
import { syncNow } from '../../utils/sync-clock.js';
import { loadRuleNames, describeRule, type RuleNames } from '../../utils/rule-describe.js';

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
 *
 * It spells them out the way `get_rules` does, through the same code (#186).
 * This used to print the values with `JSON.stringify`, which shows them as
 * the engine stores them: an amount a hundred times larger than the figure it
 * means, a recurrence as its stored config, and a payee as a uuid. The one
 * thing a confirmation exists for, recognising the rule, was the part that
 * could not be read, while `get_rules` had been translating all three for two
 * releases.
 *
 * The warnings come with them. Someone about to delete a rule that takes
 * every import down with it is entitled to know that before deciding, and it
 * is the answer to "is this the right one".
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

  // Read whether or not the preview is the thing that gets returned. The
  // alternative is for this to decide for itself whether a confirmation is
  // coming, and a guard each tool re-implements is a guard the next tool
  // forgets, which is why `requireConfirmation` exists at all. Five local
  // reads on a tool nobody calls in a loop.
  //
  // And a failure here degrades to ids rather than taking the delete with
  // it. These reads exist to make the preview readable; a budget whose payees
  // cannot be read is a budget whose rules can still be deleted, and throwing
  // would leave the caller unable to remove a rule because of the lookup that
  // was only there to name it.
  let names: RuleNames = {
    byId: new Map(),
    schedules: new Map(),
    qualified: new Map(),
    known: false,
  };
  let namesFailed = false;
  try {
    names = await loadRuleNames();
  } catch {
    namesFailed = true;
  }
  const described = describeRule(rule, names);

  const confirmation = requireConfirmation({
    subject: `Rule: ${input.rule_id}`,
    // Two spaces deeper than `get_rules` prints them, so the rule sits under
    // the line naming it. The text itself is the same text.
    losses: [
      `    Stage: ${described.stage} | Conditions: ${described.conditionsOp}`,
      ...[...described.conditions, ...described.actions].map((line) => `  ${line}`),
      ...(namesFailed && described.usesIds
        ? [
            '    The names behind these ids could not be read just now, so the ids are shown',
            '    as they are stored.',
          ]
        : []),
    ],
    input,
  });

  if (!confirmation.confirmed) {
    return { deleted: false, lines: confirmation.lines };
  }

  const result = await api.deleteRule(input.rule_id);
  await syncNow();

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
    { title: 'Delete automation rule', readOnlyHint: false, destructiveHint: true },
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
