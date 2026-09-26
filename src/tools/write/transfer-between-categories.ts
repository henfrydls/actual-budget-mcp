import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection, getInternal } from '../../connection.js';
import { amountToCents, formatMoney } from '../../utils/money.js';
import { resolveMonth } from '../../utils/dates.js';
import { resolveCategoryId } from '../../utils/resolvers.js';
import { describeError } from '../../utils/errors.js';
import type { BudgetMonth, BudgetMonthGroup } from '../../types.js';

/**
 * Move budgeted money between two categories, creating no transaction.
 *
 * ## Why this goes through the engine's own handler
 *
 * Actual has `budget/transfer-category` internally, and the alternative was two
 * `setBudgetAmount` calls. The handler is worth reaching for three things that
 * composing it loses: it runs inside `batchMessages`, so the two figures move
 * together or not at all; it is `undoable`, so the app's undo puts it back; and
 * it appends a line to the month's note, which is the same trail the desktop UI
 * leaves. Money moving in two separate writes can stop halfway, and that is the
 * one failure this tool must not have.
 *
 * Reaching an internal handler is not new here: `repair_sync` (#41) does it
 * through the same `getInternal()`.
 *
 * ## Why every check below exists
 *
 * The handler validates nothing. Measured against the engine, one case at a
 * time, each of these returned success and wrote:
 *
 *   month "2026-09-15"   the money does not move, it is destroyed. `sheetForMonth`
 *                        replaces only the first dash, so the read comes from a
 *                        sheet that does not exist (0), while `dbMonth`'s
 *                        `parseInt` stops at the dash and writes to real
 *                        September. Asking to move 10.00 took a category from
 *                        200.00 to -10.00 and the other from 50.00 to 10.00.
 *   month "2026-9"       accepted, and nothing moves: `parseInt` gives 20269,
 *                        a month that does not exist. The money is "moved" to
 *                        nowhere and the person is told it worked.
 *   month "2026-13"      same, and this one passes a `YYYY-MM` regex.
 *   an id nobody owns    accepted, budget written against a category that is not
 *                        there.
 *   an income category   the source loses the money and nothing gains it. An
 *                        income category's `budgeted` is not spendable and its
 *                        `balance` comes back null.
 *   amount 0             a no-op that still writes a note line.
 *   a negative amount    silently moves the money the other way.
 *   from === to          a no-op that still writes a note line.
 *
 * `resolveMonth` already refuses a date with a day on it, which is the easiest
 * of these to hit by accident: `resolveDate('today')` returns `YYYY-MM-DD` and
 * it is one field name away. The month is still re-checked here, because what
 * makes that input dangerous is this handler rather than the resolver.
 *
 * ## What is allowed through on purpose
 *
 * Leaving the source negative is not refused. Covering an overspent category
 * from one that still has room is the ordinary envelope move, and which
 * envelope ends up short is the person's call, not this tool's. It is reported
 * rather than blocked.
 *
 * A past month is not refused either, and it does not stay in that month:
 * measured, moving 50.00 in August also shifted both categories' balances in
 * September by the same amount, because what a category carries forward changed.
 * That is correct, and invisible if the reply only talks about August, so the
 * reply says it.
 */

interface Snapshot {
  name: string;
  budgeted: number;
  balance: number;
  isIncome: boolean;
}

/** A category's figures for the month, plus whether its group is income. */
function snapshot(budget: BudgetMonth, id: string): Snapshot | undefined {
  for (const group of budget.categoryGroups as BudgetMonthGroup[]) {
    const found = (group.categories ?? []).find((c) => c.id === id);
    if (found) {
      return {
        name: found.name,
        // An income category comes back with null for both, which is the
        // evidence that its budgeted figure is not money.
        budgeted: found.budgeted ?? 0,
        balance: found.balance ?? 0,
        isIncome: group.is_income === true,
      };
    }
  }
  return undefined;
}

export function registerTransferBetweenCategories(server: McpServer): void {
  server.tool(
    'transfer_between_categories',
    'Move budgeted money from one category to another for a month. Creates no transaction.',
    {
      from: z.string().describe('Category to take the money from (name or ID)'),
      to: z.string().describe('Category to give the money to (name or ID)'),
      amount: z
        .number()
        .describe('Amount to move (human-readable, e.g., 114.06). Must be positive.'),
      month: z
        .string()
        .optional()
        .describe('Month (YYYY-MM or natural language). Defaults to the current month.'),
    },
    { title: 'Move money between categories', readOnlyHint: false, idempotentHint: false },
    async ({ from, to, amount, month: monthInput }) => {
      try {
        await ensureConnection();

        const month = resolveMonth(monthInput);
        // `resolveMonth` is the only caller-facing gate, and this handler turns
        // a malformed month into destroyed budget rather than an error, so the
        // shape is confirmed here too rather than trusted.
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
          throw new Error(
            `"${month}" is not a month this can act on. Use YYYY-MM, with the month between 01 and 12.`,
          );
        }

        if (!Number.isFinite(amount) || amount <= 0) {
          throw new Error(
            `Amount must be a positive number. Got ${amount}. To move money the other way, swap "from" and "to".`,
          );
        }
        const cents = amountToCents(amount);
        if (cents <= 0) {
          throw new Error(`${amount} rounds to zero cents, so there is nothing to move.`);
        }

        const fromId = await resolveCategoryId(from);
        const toId = await resolveCategoryId(to);
        if (fromId === toId) {
          throw new Error(
            `"${from}" and "${to}" are the same category, so there is nothing to move.`,
          );
        }

        const before = (await api.getBudgetMonth(month)) as unknown as BudgetMonth;
        const beforeFrom = snapshot(before, fromId);
        const beforeTo = snapshot(before, toId);
        if (!beforeFrom) throw new Error(`Category "${from}" has no budget row in ${month}.`);
        if (!beforeTo) throw new Error(`Category "${to}" has no budget row in ${month}.`);

        for (const [label, snap] of [
          [from, beforeFrom],
          [to, beforeTo],
        ] as Array<[string, Snapshot]>) {
          if (snap.isIncome) {
            throw new Error(
              `"${snap.name}" is an income category, and budgeted money moved into or out of one ` +
                `disappears: the other category loses it and an income category's budgeted figure ` +
                `is not money anyone can spend. Nothing was moved. (Asked for "${label}".)`,
            );
          }
        }

        // The bundled types mark `currencyCode` as required; the implementation
        // reads it with `getCurrency(currencyCode)`, which falls back to the
        // budget's own currency when it is undefined. Measured: omitting it
        // appended the note with the right two decimals. Sending an empty
        // string instead was not measured, so it is not what goes on the wire.
        const payload = { month, amount: cents, from: fromId, to: toId };
        await getInternal().send('budget/transfer-category', payload as never);
        await api.sync();

        const after = (await api.getBudgetMonth(month)) as unknown as BudgetMonth;
        const afterFrom = snapshot(after, fromId);
        const afterTo = snapshot(after, toId);

        // The handler reports success whatever it did, so the figures are read
        // back and checked rather than assumed. Saying money moved when it did
        // not is the failure that costs the most to discover later.
        const moved =
          afterFrom !== undefined &&
          afterTo !== undefined &&
          afterFrom.budgeted === beforeFrom.budgeted - cents &&
          afterTo.budgeted === beforeTo.budgeted + cents;

        const width = Math.max(beforeFrom.name.length, beforeTo.name.length);
        const row = (name: string, was: number, now: number) =>
          `  ${name.padEnd(width)}   ${formatMoney(was)} -> ${formatMoney(now)}`;

        if (!moved) {
          return {
            content: [
              {
                type: 'text',
                text: [
                  `The engine accepted the move of ${formatMoney(cents)} in ${month} but the figures`,
                  'did not change the way they should have. Reporting what is actually there:',
                  '',
                  row(beforeFrom.name, beforeFrom.budgeted, afterFrom?.budgeted ?? 0),
                  row(beforeTo.name, beforeTo.budgeted, afterTo?.budgeted ?? 0),
                  '',
                  'Check these two categories in Actual before doing anything else.',
                ].join('\n'),
              },
            ],
            isError: true,
          };
        }

        const lines = [
          `Moved ${formatMoney(cents)} from ${beforeFrom.name} to ${beforeTo.name} in ${month}.`,
          '',
          'Budgeted:',
          row(beforeFrom.name, beforeFrom.budgeted, afterFrom.budgeted),
          row(beforeTo.name, beforeTo.budgeted, afterTo.budgeted),
          '',
          'Available:',
          row(beforeFrom.name, beforeFrom.balance, afterFrom.balance),
          row(beforeTo.name, beforeTo.balance, afterTo.balance),
          '',
          'No transaction was created, and the month total is unchanged.',
        ];

        if (afterFrom.balance < 0) {
          lines.push(
            '',
            `${beforeFrom.name} is now overspent by ${formatMoney(-afterFrom.balance)}.`,
          );
        }

        if (month < resolveMonth()) {
          lines.push(
            '',
            `${month} is a past month, so this also moves what both categories carry into`,
            'every month after it by the same amount.',
          );
        }

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
