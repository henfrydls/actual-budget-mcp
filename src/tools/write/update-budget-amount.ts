import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { amountToCents, formatMoney } from '../../utils/money.js';
import { resolveMonth } from '../../utils/dates.js';
import { resolveCategoryId } from '../../utils/resolvers.js';
import type { BudgetMonth, BudgetMonthGroup, BudgetMonthCategory } from '../../types.js';

export function registerUpdateBudgetAmount(server: McpServer): void {
  server.tool(
    'update_budget_amount',
    'Set the budgeted amount for a category in a specific month.',
    {
      category: z.string().describe('Category name or ID'),
      amount: z
        .number()
        .describe('New budgeted amount (human-readable, e.g., 5000.00)'),
      month: z
        .string()
        .optional()
        .describe('Month (YYYY-MM or natural language). Defaults to current month.'),
    },
    { readOnlyHint: false, idempotentHint: true },
    async ({ category, amount, month: monthInput }) => {
      try {
        await ensureConnection();

        const categoryId = await resolveCategoryId(category);
        const month = resolveMonth(monthInput);
        const amountCents = amountToCents(amount);

        // Get old value
        const budget = (await api.getBudgetMonth(month)) as unknown as BudgetMonth;
        let oldBudgeted = 0;
        let catName = category;

        for (const group of budget.categoryGroups as BudgetMonthGroup[]) {
          if (!group.categories) continue;
          const found = group.categories.find((c) => c.id === categoryId);
          if (found) {
            oldBudgeted = found.budgeted;
            catName = found.name;
            break;
          }
        }

        await api.setBudgetAmount(month, categoryId, amountCents);
        await api.sync();

        return {
          content: [
            {
              type: 'text',
              text: [
                `Budget updated for ${catName} in ${month}:`,
                `  Old: ${formatMoney(oldBudgeted)}`,
                `  New: ${formatMoney(amountCents)}`,
                `  Change: ${formatMoney(amountCents - oldBudgeted)}`,
              ].join('\n'),
            },
          ],
        };
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
