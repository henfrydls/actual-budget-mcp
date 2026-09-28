import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { formatMoney, centsToAmount } from '../../utils/money.js';
import { resolveMonth, getMonthRange } from '../../utils/dates.js';
import { resolveCategoryId } from '../../utils/resolvers.js';
import { sectionHeader, formatTable, formatPercent } from '../../utils/formatters.js';
import type { BudgetMonth, BudgetMonthGroup, BudgetMonthCategory } from '../../types.js';
import { describeError } from '../../utils/errors.js';
import { isIncome } from '../../utils/income.js';
import { readWindow, budgetMonthOrMissing } from '../../utils/budget-month.js';

/**
 * Spending across a window of months, ending where the caller says.
 *
 * The window used to always end today, and there was no parameter to say
 * otherwise. Passing `month: "2026-06"` returned the last three months
 * relative to today and said nothing, because an argument the schema does not
 * declare is dropped silently over the wire: the caller believed they had asked
 * for June and were reading this month (#90). `month` is now declared, so it is
 * either honoured or refused.
 *
 * `months` is a length and has no maximum. Its default has been read as a hard
 * limit by people who then rebuilt history from differences rather than asking
 * for twenty-four months, so the description says it is a default and nothing
 * more.
 */
export function registerCategoryTrends(server: McpServer): void {
  server.tool(
    'category_trends',
    'Show spending trends for a category across a window of months, ending in the month you name or this month. Identifies increasing/decreasing patterns.',
    {
      category: z
        .string()
        .optional()
        .describe('Category name or ID. If omitted, shows trends for top spending categories.'),
      months: z
        .number()
        .optional()
        .default(6)
        .describe(
          'How many months the window covers. Defaults to 6, which is a default and not a limit: ask for 24 or 36 if that is what you want.',
        ),
      month: z
        .string()
        .optional()
        .describe(
          'The month the window ends in (YYYY-MM or natural language). Defaults to this month. Use it to look at a past period: month "2026-06" with months 3 reads April, May and June.',
        ),
    },
    { title: 'Category spending trends', readOnlyHint: true },
    async ({ category, months: monthCount, month: monthInput }) => {
      try {
        await ensureConnection();
        if (!Number.isInteger(monthCount) || monthCount < 1) {
          throw new Error(
            `months must be a whole number of at least 1. Got ${monthCount}. There is no upper limit.`,
          );
        }
        const anchored = monthInput !== undefined;
        const endMonth = resolveMonth(monthInput);
        const monthRange = getMonthRange(endMonth, monthCount);

        if (category) {
          return await singleCategoryTrend(category, monthRange, monthCount);
        } else {
          return await topCategoryTrends(monthRange, monthCount, anchored);
        }
      } catch (error) {
        const message = describeError(error);
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
    sectionHeader(
      `Spending Trends: ${catName} (${monthCount} months, ${monthRange[monthRange.length - 1]} to ${monthRange[0]})`,
    ),
    '',
  ];

  const headers = ['Month', 'Spent', 'Change'];
  const rows: string[][] = [];
  const spentValues: number[] = [];

  // A month before the budget file starts throws rather than coming back
  // empty, so a long window used to die on the first one and return nothing at
  // all. Those months are listed at the end instead.
  const { present, missing } = await readWindow(monthRange);
  const months = present.map((p) => p.month);

  for (const { budget } of present) {
    let found: BudgetMonthCategory | undefined;

    for (const group of budget.categoryGroups as BudgetMonthGroup[]) {
      if (!group.categories) continue;
      found = group.categories.find((c) => c.id === categoryId);
      if (found) break;
    }

    // The figure as it stands, not its size. Taking the absolute value and
    // printing it negated turned a month that only **received** money into one
    // that spent it: measured, a category holding 20,113.00 of reimbursements
    // was reported as -20,113.00 of spending, average included (#131).
    //
    // The month-on-month change is unaffected for ordinary months, since two
    // negatives divide to the same ratio two positives would.
    spentValues.push(found ? found.spent : 0);
  }

  for (let i = 0; i < months.length; i++) {
    let change = '---';
    if (i < months.length - 1 && spentValues[i + 1] !== 0) {
      const pctChange =
        ((spentValues[i] - spentValues[i + 1]) / spentValues[i + 1]) * 100;
      change = `${pctChange >= 0 ? '+' : ''}${formatPercent(pctChange)}`;
    }
    if (i === 0 && months[0] === resolveMonth()) {
      change += ' (in progress)';
    }

    rows.push([months[i], formatMoney(spentValues[i]), change]);
  }

  lines.push(formatTable(headers, rows, ['left', 'right', 'right']));
  if (missing.length > 0) {
    lines.push(
      '',
      `${missing.length} month${missing.length === 1 ? '' : 's'} in that window ${missing.length === 1 ? 'is' : 'are'} before this budget starts and ${missing.length === 1 ? 'was' : 'were'} left out: ${missing.join(', ')}.`,
    );
  }

  // Months with no activity are not part of an average of what was spent; a
  // month that received money is not either, and would drag the average
  // towards zero as if less had been spent.
  const validValues = spentValues.filter((v) => v < 0);
  if (validValues.length > 0) {
    const avg = Math.round(
      validValues.reduce((sum, v) => sum + v, 0) / validValues.length,
    );
    lines.push('');
    // Not `-avg`. That was right while `spentValues` held magnitudes, and
    // became a sign inversion the moment they started carrying the real
    // figure: a category that spent 400.00 a month reported an average of
    // 400.00 positive, reading as money received. Introduced by the sign fix
    // in this same change and caught by reading the output of a probe, not by
    // any test — which is why there is one now.
    lines.push(`Average: ${formatMoney(avg)}`);

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

async function topCategoryTrends(
  monthRange: string[],
  monthCount: number,
  anchored: boolean,
) {
  // Which month decides who the top spenders are.
  //
  // With no anchor the window ends in the current month, which is part-spent,
  // so ranking by it would under-report whatever is billed late in the month.
  // The last full month is the better question and has been the behaviour all
  // along.
  //
  // With an anchor the caller named the month they care about, and it is
  // already complete if it is in the past. Ranking by the month before the one
  // they asked for would answer a question nobody asked.
  const refMonth = anchored || monthRange.length === 1 ? monthRange[0] : monthRange[1];
  const budget = await budgetMonthOrMissing(refMonth);
  if (!budget) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `${refMonth} is before this budget starts, so there is nothing to rank by. Pick a month inside the budget with the month argument.`,
        },
      ],
    };
  }

  const catSpending: Array<{ id: string; name: string; spent: number }> = [];
  for (const group of budget.categoryGroups as BudgetMonthGroup[]) {
    if (group.is_income) continue;
    if (!group.categories) continue;
    for (const cat of group.categories) {
      // The category's own flag; see #116. A salary here would rank as one of
      // the largest "spending" categories.
      if (isIncome(group, cat)) continue;
      // Only categories that actually spent. A category whose net is positive
      // received money, and ranking it among the top spenders by the size of
      // what came in is the same mistake as giving it a share of spending
      // (#128, #131).
      if (cat.spent < 0) {
        catSpending.push({ id: cat.id, name: cat.name, spent: Math.abs(cat.spent) });
      }
    }
  }

  catSpending.sort((a, b) => b.spent - a.spent);
  const top = catSpending.slice(0, 5);

  const lines: string[] = [
    sectionHeader(
      `Top Category Trends (${monthCount} months to ${monthRange[0]}, ranked by ${refMonth})`,
    ),
    '',
  ];

  // A heading over nothing reads like a failure. It is not: the ranking month
  // simply had no spending in it, which happens on a new budget and on any
  // window whose reference month is quiet. Saying so costs a line and saves
  // the reader deciding whether the tool broke.
  if (top.length === 0) {
    lines.push(
      `Nothing was spent in ${refMonth}, so there is nothing to rank. The window still covers ${monthCount} month${monthCount === 1 ? '' : 's'} to ${monthRange[0]}; name a category to see it, or anchor on a month with spending in it.`,
    );
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  }

  for (const cat of top) {
    const values: number[] = [];
    for (const month of monthRange) {
      const b = await budgetMonthOrMissing(month);
      if (!b) {
        values.push(0);
        continue;
      }
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
