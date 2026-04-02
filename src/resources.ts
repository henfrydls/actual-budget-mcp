import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as api from '@actual-app/api';
import { ensureConnection } from './connection.js';
import { formatMoney } from './utils/money.js';

export function registerAllResources(server: McpServer): void {
  server.resource(
    'accounts',
    'actual://accounts',
    {
      description: 'List of all budget accounts with current balances',
      mimeType: 'text/plain',
    },
    async () => {
      await ensureConnection();
      const accounts = await api.getAccounts();

      const lines: string[] = ['Accounts:'];
      for (const a of accounts) {
        if (a.closed) continue;
        const balance = await api.getAccountBalance(a.id);
        const type = a.offbudget ? 'off-budget' : 'on-budget';
        lines.push(`  ${a.name} (${a.id}) [${type}]: ${formatMoney(balance)}`);
      }

      return {
        contents: [
          {
            uri: 'actual://accounts',
            text: lines.join('\n'),
            mimeType: 'text/plain',
          },
        ],
      };
    },
  );

  server.resource(
    'categories',
    'actual://categories',
    {
      description: 'All category groups and categories with IDs',
      mimeType: 'text/plain',
    },
    async () => {
      await ensureConnection();
      const groups = await api.getCategoryGroups();
      const categories = await api.getCategories();

      const lines: string[] = ['Categories:'];
      for (const group of groups) {
        const groupCats = categories.filter(
          (c) => 'group_id' in c && (c as any).group_id === group.id && !c.hidden,
        );
        if (groupCats.length === 0) continue;

        lines.push(`  ${group.name} (${group.id})${group.is_income ? ' [Income]' : ''}`);
        for (const cat of groupCats) {
          lines.push(`    ${cat.name} (${cat.id})`);
        }
      }

      return {
        contents: [
          {
            uri: 'actual://categories',
            text: lines.join('\n'),
            mimeType: 'text/plain',
          },
        ],
      };
    },
  );

  server.resource(
    'payees',
    'actual://payees',
    {
      description: 'All payees in the budget',
      mimeType: 'text/plain',
    },
    async () => {
      await ensureConnection();
      const payees = await api.getPayees();
      const regular = payees
        .filter((p) => !p.name.startsWith('Transfer:') && p.name !== '')
        .sort((a, b) => a.name.localeCompare(b.name));

      const lines: string[] = [`Payees (${regular.length}):`];
      for (const p of regular) {
        lines.push(`  ${p.name} (${p.id})`);
      }

      return {
        contents: [
          {
            uri: 'actual://payees',
            text: lines.join('\n'),
            mimeType: 'text/plain',
          },
        ],
      };
    },
  );
}
