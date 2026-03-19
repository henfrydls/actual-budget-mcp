import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { formatMoney, centsToAmount } from '../../utils/money.js';
import { resolveMonth, getMonthRange } from '../../utils/dates.js';
import { resolveCategoryId } from '../../utils/resolvers.js';
import { sectionHeader, formatTable, formatPercent } from '../../utils/formatters.js';
import type { BudgetMonth, BudgetMonthGroup, BudgetMonthCategory } from '../../types.js';

export function registerCategoryTrends(server: McpServer): void {
  server.tool(
    'category_trends',
    'Show spending trends for a category across multiple months. Identifies increasing/decreasing patterns.',
    {
      category: z
        .string()
        .optional()
        .describe('Category name or ID. If omitted, shows trends for top spending categories.'),
      months: z
        .number()
        .optional()
        .default(6)
        .describe('Number of months to analyze (default 6)'),
    },
    async ({ category, months: monthCount }) => {
      try {
        await ensureConnection();
        const currentMonth = resolveMonth();
        const monthRange = getMonthRange(currentMonth, monthCount);

        if (category) {
          return await singleCategoryTrend(category, monthRange, monthCount);
        } else {
          return await topCategoryTrends(monthRange, monthCount);
        }
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

async function singleCategoryTrend(
  category: string,
  monthRange: string[],
  monthCount: number,
) {
  const categoryId = await resolveCategoryId(category);
  const categories = await api.getCategories();
  const catEntity = categories.find((c) => c.id === categoryId);
  const catName = catEntity?.name || category;

  const lines: string[] = [
    sectionHeader(`Spending Trends: ${catName} (${monthCount} months)`),
    '',
  ];

  const headers = ['Month', 'Spent', 'Change'];
  const rows: string[][] = [];
  const spentValues: number[] = [];

  for (const month of monthRange) {
    const budget = (await api.getBudgetMonth(month)) as unknown as BudgetMonth;
    let found: BudgetMonthCategory | undefined;

    for (const group of budget.categoryGroups as BudgetMonthGroup[]) {
      if (!group.categories) continue;
      found = group.categories.find((c) => c.id === categoryId);
      if (found) break;
    }

    const spent = found ? Math.abs(found.spent) : 0;
    spentValues.push(spent);
  }

  for (let i = 0; i < monthRange.length; i++) {
    let change = '---';
    if (i < monthRange.length - 1 && spentValues[i + 1] !== 0) {
      const pctChange =
        ((spentValues[i] - spentValues[i + 1]) / spentValues[i + 1]) * 100;
      change = `${pctChange >= 0 ? '+' : ''}${formatPercent(pctChange)}`;
    }
    if (i === 0 && monthRange[0] === resolveMonth()) {
      change += ' (in progress)';
    }

    rows.push([monthRange[i], formatMoney(-spentValues[i]), change]);
  }

  lines.push(formatTable(headers, rows, ['left', 'right', 'right']));

  const validValues = spentValues.filter((v) => v > 0);
  if (validValues.length > 0) {
    const avg = Math.round(
      validValues.reduce((sum, v) => sum + v, 0) / validValues.length,
    );
    lines.push('');
    lines.push(`Average: ${formatMoney(-avg)}`);

    // Trend direction
    if (validValues.length >= 3) {
      const changes: number[] = [];
      for (let i = 0; i < validValues.length - 1; i++) {
        if (validValues[i + 1] !== 0) {
          changes.push(
            ((validValues[i] - validValues[i + 1]) / validValues[i + 1]) * 100,
          );
        }
      }
      if (changes.length > 0) {
        const avgChange =
          changes.reduce((sum, c) => sum + c, 0) / changes.length;
        const direction = avgChange > 2 ? 'Increasing' : avgChange < -2 ? 'Decreasing' : 'Stable';
        lines.push(
          `Trend: ${direction} (${avgChange >= 0 ? '+' : ''}${formatPercent(avgChange)} avg monthly change)`,
        );
      }
    }
  }

  return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
}

async function topCategoryTrends(monthRange: string[], monthCount: number) {
  // Get last full month's data to find top categories
  const refMonth = monthRange.length > 1 ? monthRange[1] : monthRange[0];
  const budget = (await api.getBudgetMonth(refMonth)) as unknown as BudgetMonth;

  const catSpending: Array<{ id: string; name: string; spent: number }> = [];
  for (const group of budget.categoryGroups as BudgetMonthGroup[]) {
    if (group.is_income) continue;
    if (!group.categories) continue;
    for (const cat of group.categories) {
      if (cat.spent !== 0) {
        catSpending.push({ id: cat.id, name: cat.name, spent: Math.abs(cat.spent) });
      }
    }
  }

  catSpending.sort((a, b) => b.spent - a.spent);
  const top = catSpending.slice(0, 5);

  const lines: string[] = [
    sectionHeader(`Top Category Trends (${monthCount} months)`),
    '',
  ];

  for (const cat of top) {
    const values: number[] = [];
    for (const month of monthRange) {
      const b = (await api.getBudgetMonth(month)) as unknown as BudgetMonth;
      let found: BudgetMonthCategory | undefined;
      for (const g of b.categoryGroups as BudgetMonthGroup[]) {
        if (!g.categories) continue;
        found = g.categories.find((c) => c.id === cat.id);
        if (found) break;
      }
      values.push(found ? Math.abs(found.spent) : 0);
    }

    const avg = Math.round(
      values.reduce((sum, v) => sum + v, 0) / values.length,
    );
    const latest = values[0];
    const previous = values[1] || 0;
    const change = previous > 0 ? ((latest - previous) / previous) * 100 : 0;

    lines.push(
      `${cat.name.padEnd(25)} Avg: ${formatMoney(-avg).padStart(12)}  Latest: ${formatMoney(-latest).padStart(12)}  Change: ${change >= 0 ? '+' : ''}${formatPercent(change)}`,
    );
  }

  return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
}
