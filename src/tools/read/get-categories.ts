import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { sectionHeader } from '../../utils/formatters.js';

export function registerGetCategories(server: McpServer): void {
  server.tool(
    'get_categories',
    'List all category groups with their categories and IDs. Useful for seeing the full budget structure.',
    {},
    async () => {
      try {
        await ensureConnection();
        const groups = await api.getCategoryGroups();
        const categories = await api.getCategories();

        const lines: string[] = [sectionHeader('Categories'), ''];

        for (const group of groups) {
          if (group.is_income) continue;

          const groupCats = categories.filter(
            (c) => 'group_id' in c && (c as any).group_id === group.id && !c.hidden,
          );

          if (groupCats.length === 0) continue;

          lines.push(`${group.name} (${group.id})`);

          for (const cat of groupCats) {
            lines.push(`  ${cat.name} (${cat.id})`);
          }

          lines.push('');
        }

        // Income group
        const incomeGroup = groups.find((g) => g.is_income);
        if (incomeGroup) {
          const incomeCats = categories.filter(
            (c) => 'group_id' in c && (c as any).group_id === incomeGroup.id && !c.hidden,
          );
          if (incomeCats.length > 0) {
            lines.push(`${incomeGroup.name} (${incomeGroup.id})`);
            for (const cat of incomeCats) {
              lines.push(`  ${cat.name} (${cat.id})`);
            }
            lines.push('');
          }
        }

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
