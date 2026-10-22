import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { amountToCents, formatMoney } from '../../utils/money.js';
import { resolveMonth } from '../../utils/dates.js';
import { describeError } from '../../utils/errors.js';
import type { BudgetMonth } from '../../types.js';
import { syncNow } from '../../utils/sync-clock.js';
import { queueBudgetWrite } from '../../utils/budget-writes.js';

/**
 * Keep some of this month's unassigned money for the next one (#138).
 *
 * The engine's own call, `holdBudgetForNextMonth`, with three behaviours that
 * decide everything below. All three measured against it:
 *
 *   it adds          holding 200.00 and then 100.00 leaves 300.00 held, not
 *                    100.00. The amount is what to add, which is what the app
 *                    does, so this does the same and says the resulting total
 *                    rather than leaving two calls to surprise someone.
 *   it clamps        asking for 999.99 with 700.00 left to assign held 700.00
 *                    and reported nothing. Reading the figures back is the
 *                    only way to know, and saying what was actually held is
 *                    the rule this server does not break.
 *   it may refuse    with nothing left to assign it writes nothing and answers
 *                    `false`. Which is right, and has to be said, because "it
 *                    worked" would be a lie about an empty month.
 *
 * Zero resets the hold, through the engine's own `resetBudgetHold`. One tool
 * rather than two: the gesture is "how much of this month is held", and zero
 * is a perfectly good answer to it.
 */
/** What a tool call answers with, so the queued body can be typed. */
interface ToolReply {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  /** What the SDK's own result type asks for; nothing here sets one. */
  [key: string]: unknown;
}

export function registerHoldForNextMonth(server: McpServer): void {
  server.tool(
    'hold_for_next_month',
    "Hold some of a month's unassigned money so it carries into the next month, " +
      'instead of assigning it now. Adds to whatever is already held; pass 0 to ' +
      'release it all. To give money to a category, or to take it back, use ' +
      'transfer_between_categories; this one assigns nothing, it only keeps what ' +
      'is left over from being assigned this month.',
    {
      amount: z
        .number()
        .describe(
          'How much to hold, added to what is already held (human-readable, e.g. 150.00). ' +
            'Pass 0 to release the whole hold.',
        ),
      month: z
        .string()
        .optional()
        .describe('Month (YYYY-MM or natural language). Defaults to the current month.'),
    },
    { title: 'Hold money for next month', readOnlyHint: false },
    async ({ amount, month: monthInput }) => {
      try {
        await ensureConnection();
        const month = resolveMonth(monthInput);
        // The same guard `transfer_between_categories` carries, and for the
        // same reason: a month the engine cannot read is written against
        // anyway by `dbMonth`'s `parseInt`.
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
          throw new Error(
            `"${month}" is not a month this can act on. Use YYYY-MM, with the month between 01 and 12.`,
          );
        }
        if (!Number.isFinite(amount) || amount < 0) {
          throw new Error(
            `Amount must be zero or a positive number. Got ${amount}. Zero releases the hold.`,
          );
        }

        // The hold reads what is held, adds to it through the engine and
        // reads it back, and the pool it takes from is the one
        // `transfer_between_categories` and `update_budget_amount` write.
        // Measured in #114: two of those together, without the queue, each
        // read before either wrote. What goes in is everything from the
        // first read to the last, because the reply quotes both and another
        // call landing between them describes two different months.
        const run = async (): Promise<ToolReply> => {
          const before = (await api.getBudgetMonth(month)) as unknown as BudgetMonth;
          // A tracking budget has no money to assign and nothing to hold: both
          // figures come back null, and `holdBudgetForNextMonth` writes nothing
          // and says nothing. Measured. Without this the reply described an
          // envelope month that does not exist here.
          if (before?.forNextMonth === null || before?.toBudget === null) {
            throw new Error(
              `Holding money for next month is part of an envelope budget, and this is a ` +
                `tracking budget: ${month} has no money to assign and nothing to hold. ` +
                `Nothing was changed.`,
            );
          }

          const cents = amountToCents(amount);
          // Releasing is asked for with zero, and only with zero. Reading the
          // rounded figure instead let an amount below the smallest unit clear
          // the whole hold: after holding 200.00, asking to add 0.004 answered
          // "Released the 200.00" and left nothing. Someone adding a little got
          // everything taken away.
          if (amount > 0 && cents === 0) {
            throw new Error(
              `${amount} rounds to zero, so there is nothing to hold. Pass 0 if you mean to ` +
                `release the whole hold.`,
            );
          }

          if (cents === 0) {
            await api.resetBudgetHold(month);
            await syncNow();
            const after = (await api.getBudgetMonth(month)) as unknown as BudgetMonth;
            return {
              content: [
                {
                  type: 'text',
                  text: [
                    before.forNextMonth === 0
                      ? `Nothing was held for next month in ${month}, so nothing changed.`
                      : `Released the ${formatMoney(before.forNextMonth)} held for next month in ${month}.`,
                    '',
                    `  Held for next month   ${formatMoney(before.forNextMonth)} -> ${formatMoney(after.forNextMonth)}`,
                    `  Left to assign        ${formatMoney(before.toBudget)} -> ${formatMoney(after.toBudget)}`,
                  ].join('\n'),
                },
              ],
            };
          }

          await api.holdBudgetForNextMonth(month, cents);
          await syncNow();

          const after = (await api.getBudgetMonth(month)) as unknown as BudgetMonth;
          const held = after.forNextMonth - before.forNextMonth;

          // The engine's answer is read back rather than trusted: it holds what
          // it can and says nothing about the difference.
          const lines: string[] = [];
          if (held === 0) {
            lines.push(
              `Nothing was held in ${month}: it has ${formatMoney(before.toBudget)} left to assign.`,
              '',
              before.toBudget <= 0
                ? 'A month can only hold money it has not assigned yet, and this one has none.'
                : 'The engine held nothing even though there was money to hold, which is worth checking in Actual.',
            );
          } else if (held < cents) {
            lines.push(
              `Asked to hold ${formatMoney(cents)} and held ${formatMoney(held)}, which is all ` +
                `${month} had left to assign.`,
            );
          } else {
            lines.push(`Held ${formatMoney(held)} for next month in ${month}.`);
          }

          lines.push(
            '',
            `  Held for next month   ${formatMoney(before.forNextMonth)} -> ${formatMoney(after.forNextMonth)}`,
            `  Left to assign        ${formatMoney(before.toBudget)} -> ${formatMoney(after.toBudget)}`,
          );

          if (held > 0 && before.forNextMonth > 0) {
            lines.push(
              '',
              `This added to what was already held. Pass 0 to release all ${formatMoney(after.forNextMonth)}.`,
            );
          }

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
