import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { sectionHeader } from '../../utils/formatters.js';
import { describeError } from '../../utils/errors.js';
import { formatMoney } from '../../utils/money.js';
import { resolveDate, formatDate } from '../../utils/dates.js';
import { describeRecurrence } from '../../utils/schedule-recurrence.js';
import { transactionsQuery, dateBetween } from '../../utils/transaction-query.js';

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
 * Whether the last one posted is not in the schedule: it is in the
 * transactions, which carry the id of the schedule that created them. So the
 * rows are read per account over a year, which covers a yearly schedule's
 * last occurrence, and a schedule with nothing in that window says so rather
 * than claiming it never posted.
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

/** How far back to look for the last transaction a schedule posted. */
const POSTED_WINDOW_DAYS = 365;

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

        // When each schedule last posted: one query for every transaction in
        // the window that carries a schedule id, whatever account it is in.
        //
        // Reading the accounts the schedules name was wrong twice over. A
        // schedule does not have to name an account at all, and the app
        // allows that, so those read nothing and the line claimed nothing
        // had posted. And a schedule that names one can still be paid from
        // another: the rule links the transaction, the account does not.
        //
        // `today` is the local calendar day, the same one `resolveDate`
        // hands out everywhere else. A row dated after it is a payment that
        // has not happened yet, so the window ends there rather than
        // reporting it as the last one.
        const today = resolveDate('today');
        const from = new Date();
        from.setDate(from.getDate() - POSTED_WINDOW_DAYS);
        const start = formatDate(from);
        const posted = (await api.runQuery(
          transactionsQuery('all')
            .filter({ $and: [{ schedule: { $ne: null } }, dateBetween(start, today)] })
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
          if (
            row.completed !== true &&
            row.next_date !== null &&
            row.next_date !== undefined &&
            row.next_date < today
          ) {
            // Strictly before today: a payment due today is due, not late.
            notes.push(`due since ${row.next_date}`);
          }
          notes.push(row.posts_transaction === true ? 'posts by itself' : 'waits to be approved');
          const posted = lastPosted.get(row.id);
          notes.push(
            posted === undefined
              ? `nothing posted in the last ${POSTED_WINDOW_DAYS} days`
              : `last posted ${posted}`,
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
