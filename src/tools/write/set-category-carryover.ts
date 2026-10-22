import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection, getInternal } from '../../connection.js';
import { resolveMonth } from '../../utils/dates.js';
import { resolveCategoryId } from '../../utils/resolvers.js';
import { isIncome } from '../../utils/income.js';
import { describeError } from '../../utils/errors.js';
import type { BudgetMonth, BudgetMonthGroup } from '../../types.js';
import { syncNow } from '../../utils/sync-clock.js';
import { queueBudgetWrite } from '../../utils/budget-writes.js';

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
 * The months this write lands in, which is never only the one asked for, and
 * the ones that can be read back afterwards, which is not all of them.
 *
 * `setCategoryCarryover` writes the flag into every month from the one given
 * through the last month the budget has: `rangeInclusive(startMonth, latest
 * createdMonth)` inside a single batch. Measured: turning it on in October
 * left a row in `zero_budgets` for every month to the following October, the
 * thirteenth included.
 *
 * `getBudgetMonths()` is one month short of that, and not by accident:
 * `api/budget-months` asks the same handler for the bounds and then calls
 * `monthUtils.range(start, end)`, which excludes the end. So the public list
 * ended at 2027-09 while the write reached 2027-10, and the reply named the
 * wrong last month and said the next one would start without the flag, when
 * that month had just been given it.
 *
 * `get-budget-bounds` is where the real end comes from. It is an internal
 * handler, reached the way `repair_sync` and `transfer_between_categories`
 * reach theirs, and it is the same call `getBudgetMonths()` makes one step
 * further down, so it costs nothing extra and creates nothing that was not
 * created already. If it ever goes away, the listed months are still an
 * answer, one month short, rather than an error.
 *
 * The last month cannot be read back: `api/budget-month` validates against
 * that same exclusive list and answers "No budget exists" for it. So it is
 * written and not checked, and the reply says so rather than counting it.
 */
async function monthsTouched(
  from: string,
): Promise<{ written: string[]; readable: string[]; end: string }> {
  const readable = (await api.getBudgetMonths()).filter((month) => month >= from);
  const end = await lastCreatedMonth(readable, from);
  return { written: monthsBetween(from, end), readable, end };
}

/** The last month Actual has created, which is one past what it will list. */
async function lastCreatedMonth(readable: string[], from: string): Promise<string> {
  const listed = readable[readable.length - 1] ?? from;
  try {
    const bounds = (await getInternal().send('get-budget-bounds' as never, undefined as never)) as {
      end?: string;
    };
    if (typeof bounds?.end === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(bounds.end)) {
      return bounds.end > listed ? bounds.end : listed;
    }
  } catch {
    // Behind a caret range like every other internal handler this server
    // reaches for. Being one month short is better than failing a write
    // that has already happened.
  }
  return listed;
}

/** Every month from one to another, both ends included. */
function monthsBetween(from: string, to: string): string[] {
  const months: string[] = [];
  const [year, month] = from.split('-').map(Number);
  for (let i = 0; i < 600; i += 1) {
    const at = new Date(year, month - 1 + i, 1);
    const name = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`;
    months.push(name);
    if (name >= to) break;
  }
  return months;
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
/** What a tool call answers with, so the queued body can be typed. */
interface ToolReply {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  /** What the SDK's own result type asks for; nothing here sets one. */
  [key: string]: unknown;
}

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

        // On the same queue as the rest (#114). This one writes a flag
        // rather than a figure, so it cannot lose anybody's money, but it
        // reads every month before the write and reads them again after,
        // and a budget write landing in between would make those two
        // readings describe different budgets. Which is the same reason the
        // others are in it.
        const run = async (): Promise<ToolReply> => {
          const before = (await api.getBudgetMonth(month)) as unknown as BudgetMonth;
          // A tracking budget has no envelopes, so there is no overspending
          // to carry into one: measured, the month comes back with
          // `toBudget` and `forNextMonth` null there, and the flag is
          // written into rows nothing reads. The reply used to describe
          // twelve months of a mechanism that budget does not have.
          if (before?.toBudget === null || before?.forNextMonth === null) {
            throw new Error(
              `Carrying overspending forward is part of an envelope budget, and this is a ` +
                `tracking budget: a category's overspending is not carried anywhere. Nothing ` +
                `was changed.`,
            );
          }
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
          const { written, readable, end: lastWritten } = await monthsTouched(month);
          const flagBefore = new Map<string, boolean>();
          for (const touched of readable) {
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
          for (const touched of readable) {
            const read =
              touched === month
                ? now
                : carryoverOf((await api.getBudgetMonth(touched)) as unknown as BudgetMonth, categoryId);
            if (read && read.carryover === enabled && flagBefore.get(touched) !== enabled) {
              changed.push(touched);
            }
          }
          const already = readable.length - changed.length;
          // The months the write reached that cannot be read back. Normally
          // one, the last: Actual's API refuses to read it, so it is written
          // and not checked rather than counted as unchanged.
          const unchecked = written.filter((m) => !readable.includes(m));
          const lastRead = readable[readable.length - 1] ?? month;

          const lines = [
            changed.length === 0
              ? `${was.name} already had carryover ${enabled ? 'on' : 'off'} in ${month} and in ` +
                `every month to ${lastRead}, so nothing changed there.`
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
            `Actual writes this flag into every month from ${month} to ${lastWritten}, which is ` +
              `the last month it has created. Months created after that start without it.`,
            ...(unchecked.length === 0
              ? []
              : [
                  '',
                  `The figures above stop at ${lastRead}: Actual's API refuses to read its last ` +
                    `month, so ${listMonths(unchecked)} ${
                      unchecked.length === 1 ? 'is' : 'are'
                    } written and not checked here.`,
                ]),
            '',
            enabled
              ? 'Overspending in this category now rolls into the category next month, instead ' +
                'of coming off the money there is to assign.'
              : 'Overspending in this category now comes off the money there is to assign next ' +
                'month, instead of staying with the category.',
          ];

          return { content: [{ type: 'text', text: lines.join('\n') }] };
        };
        return await queueBudgetWrite(run);
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${describeError(error)}` }],
          isError: true,
        };
      }
    },
  );
}
