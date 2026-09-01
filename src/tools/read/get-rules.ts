import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { sectionHeader } from '../../utils/formatters.js';
import { describeError } from '../../utils/errors.js';

export function registerGetRules(server: McpServer): void {
  server.tool(
    'get_rules',
    'List the automation rules that Actual applies to transactions as they are '
      + 'imported or created, with the conditions that trigger each one and the actions '
      + 'it takes. Read this before creating a rule, to see whether one already covers '
      + 'the case, and when a transaction gets a category nobody assigned by hand — a '
      + 'rule is usually the reason.',
    {},
    { readOnlyHint: true },
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

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        const message = describeError(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
