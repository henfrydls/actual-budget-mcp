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
 * `setBudgetAmount` calls. The handler is worth reaching for two things that
 * composing it loses: it runs inside `batchMessages`, so the two figures move
 * together or not at all, and it appends a line to the month's note, which is
 * the same trail the desktop UI leaves. Money moving in two separate writes can
 * stop halfway, and that is the one failure this tool must not have.
 *
 * It is also wrapped in `undoable`, which was given here as a third reason
 * until it was checked: the undo history is a module-level array and this
 * server is a different process from the app, so the app's undo will not see a
 * move made here. Atomicity alone is reason enough.
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
 *   from === to          **creates money**. Moving 10.00 from a category to
 *                        itself took it from 200.00 to 210.00 and left the
 *                        month 10.00 further over-assigned, because the handler
 *                        reads the destination's budgeted figure inside the
 *                        batch, before its own subtraction has landed. Called a
 *                        harmless no-op here three times before it was run.
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
        // The category's own flag, not just its group's. Actual records income
        // per category, and a category keeps the flag when it is dragged into a
        // spending group, which is what the desktop UI's `category-move` does:
        // measured, such a category comes back under a group with
        // `is_income: false` while carrying `is_income: true` itself, and its
        // balance is null. Reading only the group let money move into one where
        // nobody could spend it, and out of one, inventing money that was never
        // there. The engine asks the same question of the category row, in
        // `validateExpenseCategory`.
        isIncome: group.is_income === true || found.is_income === true,
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
        // Reachable, which an earlier version of this comment doubted.
        // `resolveMonth`'s natural-language branch does not pad the year, so
        // "January 0999" returns "999-01", "20000 months ago" returns "360-01"
        // and "hace 30000 meses" returns "-474-09". Those arrive here alive.
        // This is not the only thing standing between them and the engine,
        // since `getBudgetMonth` refuses them on its own, but the shape is
        // confirmed rather than trusted, because this handler turns a malformed
        // month into destroyed budget rather than into an error.
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
          // Measured: a self-transfer of 10.00 raised the category from 200.00
          // to 210.00, because the handler reads the destination's figure
          // before its own subtraction has landed.
          throw new Error(
            `"${from}" and "${to}" are the same category. Moving a category to ` +
              `itself does not leave it unchanged, it adds the amount to it, so ` +
              `nothing was done.`,
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
        // reads it with `getCurrency(currencyCode)`, which is
        // `currencies.find((c) => c.code === code) || currencies[0]`. With
        // nothing passed that is the first entry, which has two decimals, not
        // the budget's own currency as this comment claimed before anyone read
        // it. It decides how the note is formatted and nothing else, so in a
        // budget whose currency has no decimals the note reads 100.00 where the
        // app writes 100. Tracked in #115; the figures are unaffected.
        const payload = { month, amount: cents, from: fromId, to: toId };
        try {
          await getInternal().send('budget/transfer-category', payload as never);
        } catch (error) {
          // An internal handler behind a caret range can go away without anyone
          // editing this repository. Failing loudly is the right outcome;
          // failing as `handler is not a function` is not one anyone can act on.
          throw new Error(
            `Actual's budget/transfer-category handler did not run, so nothing ` +
              `was moved: ${describeError(error)}`,
          );
        }
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
