import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { resolveMonth } from '../../utils/dates.js';
import { resolveCategoryId } from '../../utils/resolvers.js';
import { isIncome } from '../../utils/income.js';
import { describeError } from '../../utils/errors.js';
import type { BudgetMonth, BudgetMonthGroup } from '../../types.js';
import { syncNow } from '../../utils/sync-clock.js';

/** The category as the month reports it, which is where carryover is readable. */
function carryoverOf(
  budget: BudgetMonth,
  id: string,
): { name: string; carryover: boolean; isIncome: boolean } | undefined {
  for (const group of budget.categoryGroups as BudgetMonthGroup[]) {
    const found = (group.categories ?? []).find((c) => c.id === id);
    if (found) {
      return {
        name: found.name,
        carryover: found.carryover === true,
        isIncome: isIncome(group, found),
      };
    }
  }
  return undefined;
}

/**
 * The months this write lands in, which is never only the one asked for.
 *
 * `setCategoryCarryover` writes the flag into every month from the one given
 * through the last month the budget has: `rangeInclusive(startMonth, latest
 * createdMonth)` inside a single batch. Measured: turning it on in October
 * left it on in every month to the following September, including ones where
 * it had been turned off by hand.
 *
 * `getBudgetMonths()` is that same list as the public API reports it, and a
 * month outside it cannot be read at all, so it is both the reach of the
 * write and the limit of what can be read back.
 */
async function monthsTouched(from: string): Promise<string[]> {
  return (await api.getBudgetMonths()).filter((month) => month >= from);
}

/** `2026-10, 2026-11 and 2027-01`, or a count and the two ends when there are many. */
function listMonths(months: string[]): string {
  if (months.length <= 4) {
    if (months.length === 1) return months[0];
    return `${months.slice(0, -1).join(', ')} and ${months[months.length - 1]}`;
  }
  return `${months.length} months, ${months[0]} to ${months[months.length - 1]}`;
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
    "Turn a category's carryover on or off from a month onwards, so overspending " +
      'rolls into that category next month instead of coming off the money to ' +
      'assign. Actual writes the flag into every month from the one given to the ' +
      'last the budget has, not only that one.',
    {
      category: z.string().describe('Category name or ID'),
      enabled: z
        .boolean()
        .describe('true to carry overspending forward in this category, false to stop'),
      month: z
        .string()
        .optional()
        .describe(
          'Month this starts from, and every month after it in the budget is set too ' +
            '(YYYY-MM or natural language). Defaults to this month.',
        ),
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
        // The engine refuses an income category, in a message that names it
        // by id. The id is not what anyone asked with, and there is nothing
        // to do with it: say which category it is.
        if (was.isIncome) {
          throw new Error(
            `"${was.name}" is an income category, and carryover is about overspending, ` +
              `which an income category does not have. Nothing was changed.`,
          );
        }

        // Every month the write reaches, read before it happens. What
        // "changed" means is this list, not the one month that was asked
        // about: saying "already had carryover on" while turning it on in
        // nine other months is a true sentence about a small part of what
        // just happened.
        const months = await monthsTouched(month);
        const flagBefore = new Map<string, boolean>();
        for (const touched of months) {
          const read =
            touched === month
              ? was
              : carryoverOf((await api.getBudgetMonth(touched)) as unknown as BudgetMonth, categoryId);
          if (read) flagBefore.set(touched, read.carryover);
        }

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

        // Read back rather than counted from what was asked for, the same
        // way the one month is.
        const changed: string[] = [];
        for (const touched of months) {
          const read =
            touched === month
              ? now
              : carryoverOf((await api.getBudgetMonth(touched)) as unknown as BudgetMonth, categoryId);
          if (read && read.carryover === enabled && flagBefore.get(touched) !== enabled) {
            changed.push(touched);
          }
        }
        const already = months.length - changed.length;
        const last = months[months.length - 1];

        const lines = [
          changed.length === 0
            ? `${was.name} already had carryover ${enabled ? 'on' : 'off'} in ${month} and in ` +
              `every month to ${last}, so nothing changed.`
            : `Carryover for ${was.name} is ${enabled ? 'on' : 'off'} from ${month}.`,
          ...(changed.length === 0
            ? []
            : [
                '',
                `  Changed in ${listMonths(changed)}.`,
                ...(already > 0
                  ? [`  Already ${enabled ? 'on' : 'off'} in ${already} of the other months.`]
                  : []),
              ]),
          '',
          `Actual writes this flag into every month from ${month} to ${last}, which is the ` +
            `last month the budget has. Months created after that start without it.`,
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
