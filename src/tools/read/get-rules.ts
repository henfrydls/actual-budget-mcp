import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { sectionHeader } from '../../utils/formatters.js';
import { describeError } from '../../utils/errors.js';
import { isTextOpOnIdField, warnTextOpOnIdField } from '../../utils/rule-fields.js';

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

        const categories = await api.getCategories();
        const categoryMap = new Map(categories.filter((c) => 'group_id' in c).map((c) => [c.id, c.name]));
        const payees = await api.getPayees();
        const payeeMap = new Map(payees.map((p) => [p.id, p.name]));

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
            let value = cond.value;
            if (cond.field === 'category' && categoryMap.has(value)) value = categoryMap.get(value);
            if (cond.field === 'payee' && payeeMap.has(value)) value = payeeMap.get(value);
            lines.push(`  IF ${cond.field} ${cond.op} "${value}"`);
            if (isTextOpOnIdField(cond.field, cond.op)) {
              flagged += 1;
              lines.push(`      warning: ${warnTextOpOnIdField(cond.field, cond.op)}`);
            }
          }

          for (const action of actions) {
            let value = action.value;
            if (action.field === 'category' && categoryMap.has(value)) value = categoryMap.get(value);
            if (action.field === 'payee' && payeeMap.has(value)) value = payeeMap.get(value);
            const field = action.field || action.op;
            lines.push(`  THEN ${action.op} ${field} = "${value}"`);
          }

          lines.push('');
        }

        if (flagged > 0) {
          // At the end as well as beside each one: a long list scrolls, and
          // this is the part worth acting on.
          lines.push(
            `${flagged} condition${flagged === 1 ? '' : 's'} above compare${flagged === 1 ? 's' : ''} ` +
              `text against an internal id and may be firing on the wrong transactions. ` +
              `create_rule refuses these now; the ones already saved have to be rewritten or ` +
              `deleted by hand.`,
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
