import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { sectionHeader } from '../../utils/formatters.js';
import { describeError } from '../../utils/errors.js';
import { loadRuleNames, describeRule } from '../../utils/rule-describe.js';

export function registerGetRules(server: McpServer): void {
  server.tool(
    'get_rules',
    'List all transaction rules showing their conditions and actions.',
    {},
    { title: 'List automation rules', readOnlyHint: true },
    async () => {
      try {
        await ensureConnection();
        const rules = await api.getRules();

        if (rules.length === 0) {
          return { content: [{ type: 'text', text: 'No rules configured.' }] };
        }

        const names = await loadRuleNames();
        const lines: string[] = [sectionHeader(`Rules (${rules.length})`), ''];

        let flagged = 0;
        // What was marked, not what this tool is able to mark. The closing
        // paragraph is built from these.
        const kinds = new Set<string>();

        for (const rule of rules) {
          const described = describeRule(rule, names);
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

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        const message = describeError(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
