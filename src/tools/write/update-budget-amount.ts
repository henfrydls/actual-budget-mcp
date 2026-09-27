import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { amountToCents, formatMoney } from '../../utils/money.js';
import { resolveMonth } from '../../utils/dates.js';
import { resolveCategoryId } from '../../utils/resolvers.js';
import type { BudgetMonth, BudgetMonthGroup, BudgetMonthCategory } from '../../types.js';
import { describeError } from '../../utils/errors.js';

/**
 * Set a category's budgeted amount, absolutely or by adding to it.
 *
 * Absolute was the only mode, and it turned every ordinary adjustment into
 * arithmetic the caller had to do first. The example in #84, assigning
 * envelopes from a bonus, is exact: a category carrying 5,500.00 forward with
 * 19,161.07 spent sits at -13,661.07, so reaching a balance of 10,000.00 means
 * budgeting 23,661.07. Measured against the engine, that is the right figure
 * and the balance lands on 10,000.00. It is also a number produced to reach a
 * number: nothing about 23,661.07 shows it was computed wrongly, and a wrong
 * one corrupts the month quietly.
 *
 * `mode: "delta"` reads the figure and adds to it, so the caller can say what
 * they mean, which is almost always "put 10,000 more into this envelope".
 * Measured: +10,000.00 moved the balance from -13,661.07 to -3,661.07, and a
 * negative delta moved it back down by exactly its size.
 *
 * ## The delta is a read and then a write, so it is serialised
 *
 * There is no engine handler that adds to a budget figure, so this reads the
 * current value and writes the sum. Two deltas at once each read before either
 * wrote, and the second overwrote the first: measured, two of +1,000.00 against
 * an empty category left 1,000.00 rather than 2,000.00.
 *
 * An earlier version of this said the reply made that visible, since it prints
 * the figure read and the figure written. Measured, it does not: both replies
 * said `Old: 0.00 | New: 1,000.00`, each correct about itself, and nothing in
 * either showed the other had been lost. Only re-reading the budget showed it.
 *
 * So the read-add-write goes through a queue and calls in this process apply
 * one after another. `budget/transfer-available` was measured as an
 * alternative, because the engine serialises its own mutators and two of those
 * in parallel do add up. It is not usable: it clamps silently, with
 * `max(min(amount, leftover), 0)`, so -500.00 against 1,000.00 changed nothing
 * and +999,999.99 against a pool of 10,000.00 moved 10,000.00, neither raising
 * an error.
 *
 * Between processes this is still open, and it is the shape of #111. A queue
 * here cannot see another process and nothing in this server can.
 *
 * An absolute set does not queue: it reads nothing, so it has nothing to lose.
 * An absolute landing between a delta's read and its write still wins, which is
 * what setting a figure outright means.
 */

/**
 * Run the work one at a time, in call order, within this process.
 *
 * The `catch` does both jobs, and a first version had a second mechanism next
 * to it that did neither. It keeps the queue moving, because what is stored is
 * always a settled-successfully promise, so the next piece of work runs after a
 * failed one. And it means the stored promise, which nobody awaits, cannot
 * carry a rejection with no handler: that surfaces as an unhandled rejection,
 * which this server takes seriously enough to install a process guard for
 * (#39). The caller still gets its own error, from `next`.
 *
 * The version before this also wrote `then(work, work)`, and a comment saying
 * that was what kept the queue moving. It was not: with the `catch` in place
 * the queue never rejects, so the second handler never ran. Mutating it away
 * changed nothing, which is how it was found.
 */
let deltaQueue: Promise<unknown> = Promise.resolve();

export function serializeDelta<T>(work: () => Promise<T>): Promise<T> {
  const next = deltaQueue.then(work);
  deltaQueue = next.catch(() => undefined);
  return next;
}
export function registerUpdateBudgetAmount(server: McpServer): void {
  server.tool(
    'update_budget_amount',
    'Set the budgeted amount for a category in a specific month, or add to it with mode: "delta".',
    {
      category: z.string().describe('Category name or ID'),
      amount: z
        .number()
        .describe(
          'Human-readable amount, e.g., 5000.00. With mode "absolute" this is the new budgeted figure; with mode "delta" it is added to what is already there, and may be negative.',
        ),
      month: z
        .string()
        .optional()
        .describe('Month (YYYY-MM or natural language). Defaults to current month.'),
      mode: z
        .enum(['absolute', 'delta'])
        .optional()
        .describe(
          'How to apply the amount. "absolute" (default) sets the budgeted figure. "delta" adds to it, which is what an ordinary adjustment is: putting more into an envelope rather than working out what the total should become.',
        ),
    },
    { title: 'Set budgeted amount', readOnlyHint: false, idempotentHint: true },
    async ({ category, amount, month: monthInput, mode }) => {
      try {
        await ensureConnection();

        const categoryId = await resolveCategoryId(category);
        const month = resolveMonth(monthInput);
        const inputCents = amountToCents(amount);
        const isDelta = mode === 'delta';

        // Everything from the read to the write, so the queue can hold it all.
        const run = async (): Promise<string> => {
        // Get old value
        const budget = (await api.getBudgetMonth(month)) as unknown as BudgetMonth;
        let oldBudgeted: number | undefined;
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

        if (isDelta && !Number.isFinite(oldBudgeted)) {
          // An income category comes back with `budgeted` undefined, and one
          // moved into a spending group with null. Adding to either gives NaN
          // or silently treats it as zero, so a delta refuses rather than
          // guessing what it was adding to. An absolute set is unchanged: it
          // does not need to read anything.
          throw new Error(
            `"${catName}" has no budgeted figure in ${month} to add to, so a delta has ` +
              `nothing to start from. Income categories are not budgeted. Use mode ` +
              `"absolute" if you mean to set a figure outright.`,
          );
        }

        const previous = oldBudgeted ?? 0;
        const amountCents = isDelta ? previous + inputCents : inputCents;

        await api.setBudgetAmount(month, categoryId, amountCents);
        await api.sync();

        return [
          `Budget updated for ${catName} in ${month}:`,
          `  Old: ${formatMoney(previous)}`,
          `  New: ${formatMoney(amountCents)}`,
          `  Change: ${formatMoney(amountCents - previous)}`,
          ...(isDelta
            ? [
                '',
                `Added ${formatMoney(inputCents)} to what was there, rather than setting it.`,
              ]
            : []),
        ].join('\n');
        };

        // Only the delta needs the queue; an absolute set reads nothing.
        const text = isDelta ? await serializeDelta(run) : await run();
        return { content: [{ type: 'text', text }] };
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
