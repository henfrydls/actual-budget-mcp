import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { formatMoney } from '../../utils/money.js';
import { sectionHeader } from '../../utils/formatters.js';

export function registerListAccounts(server: McpServer): void {
  server.tool(
    'list_accounts',
    'List all budget accounts with their current balances, type (on-budget/off-budget), and status.',
    {},
    async () => {
      try {
        await ensureConnection();
        const accounts = await api.getAccounts();

        const onBudget = accounts.filter((a) => !a.closed && !a.offbudget);
        const offBudget = accounts.filter((a) => !a.closed && a.offbudget);

        const lines: string[] = [sectionHeader('Accounts'), ''];

        let totalOnBudget = 0;
        if (onBudget.length > 0) {
          lines.push('On-Budget:');
          for (const account of onBudget) {
            const balance = await api.getAccountBalance(account.id);
            totalOnBudget += balance;
            lines.push(`  ${account.name}: ${formatMoney(balance)}`);
          }
          lines.push('');
        }

        let totalOffBudget = 0;
        if (offBudget.length > 0) {
          lines.push('Off-Budget:');
          for (const account of offBudget) {
            const balance = await api.getAccountBalance(account.id);
            totalOffBudget += balance;
            lines.push(`  ${account.name}: ${formatMoney(balance)}`);
          }
          lines.push('');
        }

        lines.push(`Total on-budget: ${formatMoney(totalOnBudget)}`);
        lines.push(`Total off-budget: ${formatMoney(totalOffBudget)}`);

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
