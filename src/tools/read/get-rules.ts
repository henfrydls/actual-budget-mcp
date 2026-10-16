import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { sectionHeader } from '../../utils/formatters.js';
import { describeError } from '../../utils/errors.js';
import { RULE_FIELDS } from '../../utils/rule-fields.js';
import { loadRuleNames, describeRule } from '../../utils/rule-describe.js';

/** How many rules a reply carries when nobody says otherwise. */
const PAGE = 100;

export interface GetRulesInput {
  flagged_only?: boolean;
  field?: string;
  limit?: number;
  offset?: number;
}

/**
 * List the rules, and let the caller ask for fewer of them.
 *
 * Every rule, every condition and every action in one reply is around 161
 * bytes per rule, measured against the engine on rules of three shapes. On a
 * budget holding 1500 of them that is 242 KB, a large part of an assistant's
 * context spent on a list nobody read all of. The same listing builds in 10
 * ms at 600 rules, so the cost is the size of the answer and not the work
 * (#177).
 *
 * A hundred rules is 16 KB, which is why that is the page. Below it nothing
 * changes: a budget with a hundred rules or fewer, asked without arguments,
 * gets the same bytes it got before, and a test holds that.
 *
 * What a page must not do is hide a warning. The order is the engine's, so
 * paging cannot be made to put the marked ones first without changing every
 * reply; instead the reply says how many of the rules it did not list are
 * marked, and how to ask for exactly those.
 */
export async function getRules(input: GetRulesInput = {}): Promise<string> {
  await ensureConnection();
  const rules = await api.getRules();

  if (rules.length === 0) return 'No rules configured.';

  const wanted = input.field?.trim().toLowerCase();
  if (wanted !== undefined && !RULE_FIELDS.has(wanted)) {
    // Named rather than answered with an empty list, which reads as "you have
    // no rules about that" and is a different thing from "there is no such
    // field".
    return (
      `Actual keeps no rule field called "${input.field}", so no rule can mention one. ` +
      `The fields a rule uses are ${[...RULE_FIELDS].sort().join(', ')}.`
    );
  }

  const names = await loadRuleNames();
  // Described first, all of them: whether a rule carries a warning is only
  // knowable by writing it out, and writing it out is the cheap half.
  const all = rules.map((rule) => ({ rule, described: describeRule(rule, names) }));

  const matching = all.filter(
    (entry) =>
      (!input.flagged_only || entry.described.flagged > 0) &&
      (wanted === undefined || entry.described.fields.has(wanted)),
  );

  const limit = input.limit ?? PAGE;
  const offset = input.offset ?? 0;
  const shown = matching.slice(offset, offset + limit);
  const filtered = matching.length !== rules.length;

  if (matching.length === 0) {
    return input.flagged_only && wanted !== undefined
      ? `None of your ${rules.length} rules mentions ${wanted} and carries a warning.`
      : input.flagged_only
        ? `None of your ${rules.length} rules carries a warning.`
        : `None of your ${rules.length} rules mentions ${wanted}.`;
  }
  if (shown.length === 0) {
    return (
      `Nothing to list at offset ${offset}: there ${matching.length === 1 ? 'is' : 'are'} ` +
      `${matching.length} ${matching.length === 1 ? 'rule' : 'rules'} to page through.`
    );
  }

  const lines: string[] = [sectionHeader(`Rules (${rules.length})`)];
  if (filtered) {
    // Said at the top, because the count in the header is the whole budget
    // and the list below it is not.
    const one = matching.length === 1;
    const what =
      input.flagged_only && wanted !== undefined
        ? `carrying a warning and mentioning ${wanted}`
        : input.flagged_only
          ? 'carrying a warning'
          : `that ${one ? 'mentions' : 'mention'} ${wanted}`;
    lines.push(`Showing the ${matching.length} ${one ? 'rule' : 'rules'} ${what}.`);
  }
  lines.push('');

  let flagged = 0;
  // What was marked, not what this tool is able to mark. The closing
  // paragraph is built from these.
  const kinds = new Set<string>();

  for (const { rule, described } of shown) {
    flagged += described.flagged;
    for (const kind of described.kinds) kinds.add(kind);

    lines.push(`Rule: ${rule.id}`);
    lines.push(`  Stage: ${described.stage} | Conditions: ${described.conditionsOp}`);
    lines.push(...described.conditions, ...described.actions, '');
  }

  if (flagged > 0) {
    // At the end as well as beside each one: a long list scrolls, and
    // this is the part worth acting on.
    //
    // Built from what was actually marked. The fixed version named
    // every kind this can find, so a budget whose only marked rule
    // compares text against an id was told that some of them take the
    // next import down, and the sentence that mattered looked exactly
    // like the four that did not apply. The import one comes first
    // where it applies, because nothing about a failed import points
    // back at the rule that caused it.
    const BY_KIND: [string, string][] = [
      // Both of these take an import down, and they do it for different
      // reasons: one writes a field that is not there, the other writes
      // a value the column will not take. `amount` has a column.
      [
        'import-field',
        'A rule that writes a field Actual keeps no column for takes the next import ' +
          'down with it, and none of that batch arrives.',
      ],
      [
        'import-value',
        'A rule holding the text of a figure where Actual keeps a figure takes the ' +
          'next import down with it, and none of that batch arrives.',
      ],
      [
        'zero',
        'A rule holding nothing where a figure belongs sets every transaction it ' +
          'matches to zero.',
      ],
      [
        'opposite',
        'A rule holding a word where Actual keeps true or false means true, whatever ' +
          'the word says.',
      ],
      [
        'empty-boolean',
        'A rule holding an empty value where Actual keeps true or false means false, ' +
          'which is what an empty value happens to mean rather than what anyone wrote.',
      ],
      [
        'wrong-rows',
        'A rule comparing text against an internal id fires on transactions it has ' +
          'nothing to do with.',
      ],
      ['never-alone', 'A condition Actual cannot answer means the rule never runs on its own.'],
      ['never-fires', 'A rule pointing at something that is not there has never fired.'],
      ['nothing', 'A rule writing a field that is not stored does nothing at all.'],
    ];
    const said = BY_KIND.filter(([kind]) => kinds.has(kind)).map(([, text]) => text);

    lines.push(
      `${flagged} line${flagged === 1 ? '' : 's'} above ${flagged === 1 ? 'is' : 'are'} ` +
        `marked. ${said.join(' ')} create_rule refuses ` +
        `${flagged === 1 ? 'it' : 'all of them'} now, so the ones already saved are the ` +
        `ones to rewrite or delete.`,
    );
  }


  // What is not in the reply, and how to ask for it. A page that says nothing
  // about the rest invites the reader to believe they have seen it all.
  const rest = matching.length - offset - shown.length;
  if (rest > 0) {
    const unseen = matching
      .slice(offset + shown.length)
      .filter((entry) => entry.described.flagged > 0).length;
    lines.push(
      `Showing ${shown.length} of ${matching.length}${filtered ? ' matching' : ''} rules. ` +
        `Pass offset: ${offset + shown.length} for the next ${Math.min(limit, rest)}.`,
    );
    if (unseen > 0 && !input.flagged_only) {
      // The one thing paging must not bury. The order is the engine's, so a
      // marked rule can be anywhere in it.
      lines.push(
        `${unseen} of the ${rest} not listed ${unseen === 1 ? 'carries a warning' : 'carry a warning'}. ` +
          `Pass flagged_only: true to see ${unseen === 1 ? 'it' : 'them'}, wherever in the list ${unseen === 1 ? 'it is' : 'they are'}.`,
      );
    }
  }

  return lines.join('\n');
}

export function registerGetRules(server: McpServer): void {
  server.tool(
    'get_rules',
    'List transaction rules with their conditions and actions. Returns the first 100 rules; ' +
      'pass offset for the next page, flagged_only for just the ones with a warning, or field ' +
      'to see only the rules that mention one field.',
    {
      flagged_only: z
        .boolean()
        .optional()
        .describe(
          'Only the rules carrying a warning, wherever they are in the list. These are the ones worth acting on.',
        ),
      field: z
        .string()
        .optional()
        .describe(
          'Only the rules that mention this field in a condition or an action, such as payee, amount or category.',
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('How many rules to list. 100 by default, which is about 16 KB of text.'),
      offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('How many rules to skip, for reading the list a page at a time.'),
    },
    { title: 'List automation rules', readOnlyHint: true },
    async (input) => {
      try {
        return { content: [{ type: 'text', text: await getRules(input) }] };
      } catch (error) {
        const message = describeError(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
