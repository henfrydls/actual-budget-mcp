import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { sectionHeader } from '../../utils/formatters.js';
import { describeError } from '../../utils/errors.js';
import {
  ID_FIELDS,
  isTextOpOnIdField,
  warnTextOpOnIdField,
  looksLikeAnId,
} from '../../utils/rule-fields.js';

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

        // Every field the engine stores by id, not two of them. A rule listing
        // raw UUIDs cannot be checked by the person who asked for it, which is
        // the whole job of this tool.
        const categories = await api.getCategories();
        const groups = await api.getCategoryGroups();
        const payees = await api.getPayees();
        const accounts = await api.getAccounts();
        const names = new Map<string, string>([
          ...categories.filter((c) => 'group_id' in c).map((c) => [c.id, c.name] as const),
          ...groups.map((g) => [g.id, g.name] as const),
          ...payees.map((p) => [p.id, p.name] as const),
          ...accounts.map((a) => [a.id, a.name] as const),
        ]);

        /**
         * A stored value, as the person who wrote the rule would recognise it.
         *
         * Lists as well as single values: `oneOf` holds an array, and printing
         * it raw was a row of UUIDs separated by commas.
         */
        const readable = (field: string, value: unknown): string => {
          const one = (v: unknown) => {
            const text = String(v);
            return ID_FIELDS.has(field) ? (names.get(text) ?? text) : text;
          };
          return Array.isArray(value) ? value.map(one).join(', ') : one(value);
        };

        /**
         * Whether an id field is holding something that is not an id of
         * anything, which is what a rule left behind by #167 and #170 looks
         * like: it reads perfectly well and has never matched a transaction.
         *
         * A name and a deleted thing are told apart by the shape, because the
         * advice differs: one was never pointing anywhere, the other was.
         */
        const brokenValues = (field: string, value: unknown): string[] => {
          if (!ID_FIELDS.has(field)) return [];
          const list = Array.isArray(value) ? value : [value];
          return list
            .map((v) => String(v))
            .filter((text) => text !== '' && !names.has(text));
        };

        const describeBroken = (field: string, bad: string[]): string => {
          const asNames = bad.filter((v) => !looksLikeAnId(v));
          if (asNames.length > 0) {
            return (
              `warning: this stores ${asNames.map((v) => `"${v}"`).join(', ')} where Actual ` +
              `expects ${field === 'account' ? 'an' : 'a'} ${field.replace('_', ' ')} id, so ` +
              `it never fires. Recreate the rule with create_rule, which resolves the name.`
            );
          }
          return (
            `warning: this points at ${bad.length === 1 ? 'an id' : 'ids'} that no longer ` +
            `exist in the budget, so it never fires. Recreate the rule or delete it.`
          );
        };

        const lines: string[] = [sectionHeader(`Rules (${rules.length})`), ''];

        // Rules created before this was refused are still here and still
        // firing (#169). Nothing in the listing shows what is wrong with
        // them: the condition reads like any other, and the damage is that it
        // is compared against an id.
        let flagged = 0;

        for (const rule of rules) {
          const conditions = (rule as any).conditions || [];
          const actions = (rule as any).actions || [];
          const stage = (rule as any).stage || 'default';
          const condOp = (rule as any).conditionsOp || 'and';

          lines.push(`Rule: ${rule.id}`);
          lines.push(`  Stage: ${stage} | Conditions: ${condOp}`);

          for (const cond of conditions) {
            lines.push(`  IF ${cond.field} ${cond.op} "${readable(cond.field, cond.value)}"`);
            // One complaint per line. A text operator on an id field holds
            // text on purpose, so the check below would call the same
            // condition broken for a second reason and send the reader
            // looking for two fixes.
            if (isTextOpOnIdField(cond.field, cond.op)) {
              flagged += 1;
              lines.push(`      warning: ${warnTextOpOnIdField(cond.field, cond.op)}`);
              continue;
            }
            const bad = brokenValues(cond.field, cond.value);
            if (bad.length > 0) {
              flagged += 1;
              lines.push(`      ${describeBroken(cond.field, bad)}`);
            }
          }

          for (const action of actions) {
            const field = action.field || action.op;
            lines.push(`  THEN ${action.op} ${field} = "${readable(field, action.value)}"`);
            const bad = brokenValues(field, action.value);
            if (bad.length > 0) {
              flagged += 1;
              lines.push(`      ${describeBroken(field, bad)}`);
            }
          }

          lines.push('');
        }

        if (flagged > 0) {
          // At the end as well as beside each one: a long list scrolls, and
          // this is the part worth acting on.
          lines.push(
            `${flagged} line${flagged === 1 ? '' : 's'} above ${flagged === 1 ? 'is' : 'are'} ` +
              `marked. A rule that compares text against an internal id may be firing on the ` +
              `wrong transactions; one holding a name where an id belongs has never fired at ` +
              `all. create_rule refuses both now, so the ones already saved are the ones to ` +
              `rewrite or delete.`,
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
