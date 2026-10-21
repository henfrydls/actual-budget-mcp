import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { resolveMonth } from '../../utils/dates.js';
import { resolveCategoryId } from '../../utils/resolvers.js';
import { describeError } from '../../utils/errors.js';
import type { BudgetMonth, BudgetMonthGroup } from '../../types.js';
import { syncNow } from '../../utils/sync-clock.js';

/** The category as the month reports it, which is where carryover is readable. */
function carryoverOf(budget: BudgetMonth, id: string): { name: string; carryover: boolean } | undefined {
  for (const group of budget.categoryGroups as BudgetMonthGroup[]) {
    const found = (group.categories ?? []).find((c) => c.id === id);
    if (found) return { name: found.name, carryover: found.carryover === true };
  }
  return undefined;
}

/**
 * Carry a category's overspending forward instead of taking it off the top
 * (#138).
 *
 * Without it, a category that ends the month negative takes that overspend
 * out of next month's money to assign. With it, the category starts the next
 * month negative and carries its own problem, which is how an envelope
 * budget is usually run.
 *
 * The engine's public call validates what matters: it refuses a month it
 * cannot read and a category that does not exist, and it refuses an income
 * category outright. So the work here is reading the flag back, which is the
 * part nothing else does.
 */
export function registerSetCategoryCarryover(server: McpServer): void {
  server.tool(
    'set_category_carryover',
    'Turn a category\'s carryover on or off for a month, so overspending rolls ' +
      'into that category next month instead of coming off the money to assign.',
    {
      category: z.string().describe('Category name or ID'),
      enabled: z
        .boolean()
        .describe('true to carry overspending forward in this category, false to stop'),
      month: z
        .string()
        .optional()
        .describe('Month this starts from (YYYY-MM or natural language). Defaults to this month.'),
    },
    { title: 'Set category carryover', readOnlyHint: false, idempotentHint: true },
    async ({ category, enabled, month: monthInput }) => {
      try {
        await ensureConnection();
        const month = resolveMonth(monthInput);
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
          throw new Error(
            `"${month}" is not a month this can act on. Use YYYY-MM, with the month between 01 and 12.`,
          );
        }
        const categoryId = await resolveCategoryId(category);

        const before = (await api.getBudgetMonth(month)) as unknown as BudgetMonth;
        const was = carryoverOf(before, categoryId);
        if (!was) throw new Error(`Category "${category}" has no budget row in ${month}.`);

        await api.setBudgetCarryover(month, categoryId, enabled);
        await syncNow();

        const after = (await api.getBudgetMonth(month)) as unknown as BudgetMonth;
        const now = carryoverOf(after, categoryId);

        if (now?.carryover !== enabled) {
          return {
            content: [
              {
                type: 'text',
                text:
                  `Actual accepted the change but ${was.name} still reports carryover ` +
                  `${now?.carryover === true ? 'on' : 'off'} in ${month}. Nothing can be ` +
                  `promised about it; check the category in Actual.`,
              },
            ],
            isError: true,
          };
        }

        const lines = [
          was.carryover === enabled
            ? `${was.name} already had carryover ${enabled ? 'on' : 'off'} in ${month}.`
            : `Carryover for ${was.name} is ${enabled ? 'on' : 'off'} from ${month}.`,
          '',
          enabled
            ? 'Overspending in this category now rolls into the category next month, instead ' +
              'of coming off the money there is to assign.'
            : 'Overspending in this category now comes off the money there is to assign next ' +
              'month, instead of staying with the category.',
        ];

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${describeError(error)}` }],
          isError: true,
        };
      }
    },
  );
}
