import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { sectionHeader } from '../../utils/formatters.js';
import { describeError } from '../../utils/errors.js';
import { formatMoney } from '../../utils/money.js';
import { resolveDate, formatDate } from '../../utils/dates.js';
import { describeRecurrence } from '../../utils/schedule-recurrence.js';
import { transactionsQuery } from '../../utils/transaction-query.js';

/**
 * The recurring payments a budget has, which nothing here could see (#150).
 *
 * "What bills are coming up this month" and "did the rent go out" are two of
 * the most ordinary questions about a budget, and the answer lived only in
 * the app. Reading is the whole of this tool: creating and changing a
 * schedule is a separate decision and a separate issue.
 *
 * Measured against the engine, because the shapes are not uniform:
 *
 *   date      an object for a recurring schedule, `{start, frequency, ...}`,
 *             and a plain string for one that happens once
 *   amount    a number, or `{num1, num2}` when the rule is `isbetween`
 *   payee     null when the schedule has none, and an id otherwise
 *
 * Whether it posted is not in the schedule either: it is in the
 * transactions, which carry the id of the schedule that created them. One
 * query asks for every transaction in the last year that carries one,
 * whatever account it is in, because a schedule need not name an account and
 * one that does can still be paid from another. A year covers a yearly
 * schedule's last occurrence, and a schedule with nothing in that window
 * says so rather than claiming it never posted.
 */
interface ScheduleRow {
  id: string;
  name?: string | null;
  next_date?: string | null;
  completed?: boolean;
  posts_transaction?: boolean;
  payee?: string | null;
  account?: string | null;
  amount?: number | { num1: number; num2: number } | null;
  amountOp?: string;
  date?: string | Record<string, unknown> | null;
}

/** How far back to look for the transactions a schedule posted. */
const POSTED_WINDOW_DAYS = 365;

/**
 * How early a manual recurring schedule may be paid and still count.
 *
 * The engine's own number, from the query behind the app's status: a
 * schedule whose date condition is approximate matches a transaction up to
 * two days before the day it is due.
 */
const EARLY_DAYS = 2;

/** A stored `YYYY-MM-DD`, some days earlier, in the same local calendar. */
function daysBefore(date: string, days: number): string {
  // `T00:00:00` and no zone, so this is the local day the string names
  // rather than a UTC instant that can land on the day before.
  const moment = new Date(`${date}T00:00:00`);
  moment.setDate(moment.getDate() - days);
  return formatDate(moment);
}

/**
 * The earliest a transaction can be dated and still pay the day a schedule
 * is waiting on, or nothing when there is no day to pay.
 *
 * The app's rule, read from the engine rather than described: a schedule
 * with a transaction linked to it and dated at or after this counts as paid,
 * and paid is answered before late. The window starts on the day itself when
 * the date condition is exact or the schedule posts by itself, because both
 * of those produce an exact day, and two days earlier otherwise, to catch a
 * payment made early.
 *
 * One part of that is not in what the API returns. Whether the date
 * condition is `is` or `isapprox` lives in the rule, not in the schedule. A
 * date stored as a string is a single day, which is always `is`; a
 * recurrence the app wrote is `isapprox`. So the two days are allowed for a
 * recurrence that does not post by itself, which is where the app allows
 * them, and the case left over is a recurrence with an exact condition,
 * which the app's own form does not produce. Reading every rule in the
 * budget to tell that one apart is a call for two days of difference.
 */
function paidFrom(row: ScheduleRow): string | undefined {
  const next = row.next_date;
  if (typeof next !== 'string') return undefined;
  if (typeof row.date === 'string' || row.posts_transaction === true) return next;
  return daysBefore(next, EARLY_DAYS);
}

function amountOf(row: ScheduleRow): string {
  const amount = row.amount;
  if (amount === null || amount === undefined) return '(no amount)';
  if (typeof amount === 'number') {
    return row.amountOp === 'isapprox' ? `about ${formatMoney(amount)}` : formatMoney(amount);
  }
  // Ordered, because the rule does not order them: the app writes whichever
  // was typed first, and "50.00 to 10.00" reads as a mistake in the budget
  // rather than in the listing.
  return `${formatMoney(Math.min(amount.num1, amount.num2))} to ${formatMoney(Math.max(amount.num1, amount.num2))}`;
}

/**
 * How often it happens, in the same words the rules listing uses.
 *
 * Printing `date.frequency` on its own called a fortnightly schedule
 * "weekly", because the interval lives beside the frequency and the patterns
 * only count on a monthly. `describeRecurrence` is the module that measured
 * all of that for #182, and a recurrence it will not describe is printed as
 * the config it is rather than described from the half that parses.
 */
function everyOf(row: ScheduleRow): string | undefined {
  const date = row.date;
  if (date === null || date === undefined) return undefined;
  if (typeof date === 'string') return 'once';
  return describeRecurrence(date) ?? JSON.stringify(date);
}

export function registerGetSchedules(server: McpServer): void {
  server.tool(
    'get_schedules',
    "List the budget's schedules: what is due next, how much, from which account, and " +
      'whether the last one posted. Read-only; creating and changing schedules is not here.',
    {},
    { title: 'List schedules', readOnlyHint: true },
    async () => {
      try {
        await ensureConnection();
        const schedules = (await api.getSchedules()) as unknown as ScheduleRow[];

        if (schedules.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No schedules in this budget. Actual calls a recurring payment a schedule.',
              },
            ],
          };
        }

        const accounts = await api.getAccounts();
        const payees = (await api.getPayees()) as Array<{
          id: string;
          name: string;
          transfer_acct?: string | null;
        }>;
        const accountName = new Map(accounts.map((a) => [a.id, a.name]));
        // A transfer's other side is a payee whose name is an account's, so
        // "Checking / Savings" reads as a payee called Savings. Actual marks
        // those with `transfer_acct`, and every account has one, so this is
        // the only thing that tells the two apart.
        const payeeName = new Map(
          payees.map((p) => [p.id, p.transfer_acct ? `transfer: ${p.name}` : p.name]),
        );

        // What each schedule has posted: one query for every transaction in
        // the window that carries a schedule id, whatever account it is in.
        //
        // Reading the accounts the schedules name was wrong twice over. A
        // schedule does not have to name an account at all, and the app
        // allows that, so those read nothing and the line claimed nothing
        // had posted. And a schedule that names one can still be paid from
        // another: the rule links the transaction, the account does not.
        //
        // Splits count as `all`, which is what the engine's own version of
        // this query uses: a scheduled payment split across categories is a
        // parent row, and the default would leave parents out (#79, #82).
        //
        // No upper bound on the date. A schedule that posts by itself can
        // have put the next payment in already, and the day it covers is
        // what decides whether it is still waiting to be paid.
        const today = resolveDate('today');
        const from = new Date();
        from.setDate(from.getDate() - POSTED_WINDOW_DAYS);
        const start = formatDate(from);
        const posted = (await api.runQuery(
          transactionsQuery('all')
            .filter({ $and: [{ schedule: { $ne: null } }, { date: { $gte: start } }] })
            .select(['schedule', 'date']) as never,
        )) as unknown as { data?: Array<{ schedule?: string | null; date?: string | null }> };

        const lastPosted = new Map<string, string>();
        for (const row of posted.data ?? []) {
          if (typeof row.schedule !== 'string' || typeof row.date !== 'string') continue;
          const seen = lastPosted.get(row.schedule);
          if (seen === undefined || seen < row.date) lastPosted.set(row.schedule, row.date);
        }

        // Finished last, the rest by the day they are next due. The app
        // hides a finished schedule altogether; a listing that reads the
        // budget should not hide a row, but it should not file one that will
        // never happen again among the ones that will.
        const sorted = [...schedules].sort((a, b) => {
          if ((a.completed === true) !== (b.completed === true)) {
            return a.completed === true ? 1 : -1;
          }
          return (a.next_date ?? '9999-12-31').localeCompare(b.next_date ?? '9999-12-31');
        });
        const width = Math.max(...sorted.map((s) => (s.name ?? '(unnamed)').length));

        const lines: string[] = [sectionHeader(`Schedules (${schedules.length})`), ''];
        for (const row of sorted) {
          const where = [accountName.get(row.account ?? ''), payeeName.get(row.payee ?? '')]
            .filter(Boolean)
            .join(' / ');
          // A finished schedule has a next date and will never reach it, so
          // the column says what is true instead of a day nothing happens on.
          const when = row.completed === true ? 'finished' : `next ${row.next_date ?? '(none)'}`;
          lines.push(
            `${(row.name ?? '(unnamed)').padEnd(width)}  ${when}  ` +
              `${amountOf(row)}${where === '' ? '' : `  ${where}`}`,
          );

          // The second line is what is true about the schedule rather than
          // what it is: how often, whether it is late, who posts it, and what
          // it last did. Keeping it off the first line is what lets the names
          // and the amounts line up down the page.
          const notes: string[] = [];
          const every = everyOf(row);
          if (every !== undefined) notes.push(every);
          // Paid before late, which is the order the app answers in: a
          // schedule whose day has passed and whose payment is already in is
          // not late, and saying it is sends someone to pay it twice. The
          // engine only moves a schedule on when its daily service runs, so
          // between the payment and that run the next date still points at
          // the day that was paid.
          const latest = lastPosted.get(row.id);
          const from = paidFrom(row);
          const paid = latest !== undefined && from !== undefined && latest >= from;

          if (row.completed !== true) {
            if (paid) {
              notes.push('paid');
            } else if (
              row.next_date !== null &&
              row.next_date !== undefined &&
              row.next_date < today
            ) {
              // Strictly before today: a payment due today is due, not late.
              notes.push(`due since ${row.next_date}`);
            }
            // Who posts it is about what happens next, and nothing happens
            // next for a finished schedule either.
            notes.push(row.posts_transaction === true ? 'posts by itself' : 'waits to be approved');
          }
          notes.push(
            latest === undefined
              ? `nothing posted in the last ${POSTED_WINDOW_DAYS} days`
              : latest <= today
                ? `last posted ${latest}`
                : // A schedule that posts by itself can be ahead of the day
                  // it covers, and "last posted" about a day that has not
                  // happened yet reads as a payment that has.
                  `already posted for ${latest}`,
          );
          lines.push(`  ${notes.join('; ')}`);
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
