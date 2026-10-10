import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { amountToCents, formatMoney } from '../../utils/money.js';
import { resolveDate } from '../../utils/dates.js';
import { resolveAccountId } from '../../utils/resolvers.js';

import { findReconcileCandidates, type Candidate } from '../../utils/reconcile-candidates.js';
import { balanceBreakdown } from '../../utils/account-balance.js';
import { describeError } from '../../utils/errors.js';

/**
 * Compare an account against the figure a bank reports, and say what might
 * explain the gap.
 *
 * Reconciling is described as most of the real work, and the arithmetic is not
 * the slow part: finding which movement is missing is. So the difference is the
 * cheap half of this, and everything below the figure is the point.
 *
 * It writes nothing. Booking an adjustment is `reconcile_currency_residual`,
 * which is a different decision and already asks its own questions.
 *
 * ## Why the balance counts uncleared rows by default
 *
 * `getAccountBalance` sums everything up to its cutoff, cleared or not, and a
 * statement generally shows only what has posted, so the two can measure
 * different things (#108). Measured on a real budget file before choosing a
 * default: most uncleared rows were weeks old and **none** carried a
 * `financial_id`, so not one had come from a bank. They had been typed in by
 * hand. There, `cleared = 0` does not mean the bank has not posted it, it
 * means nobody ticked it off, and the bank does show it.
 *
 * Defaulting to a cleared-only balance would have dropped every one of them
 * and invented a gap on most of the accounts at once, sending the reader to
 * look for a transaction that is not missing. So counting everything is the
 * default, the other is `balance_counts: "cleared_only"`, and the reply always
 * says which one produced the figure.
 *
 * The `reconciled` flag is 0 on every row in that file, so nothing here is
 * built on it.
 *
 * `reconcile_currency_residual` reads the same way, for the same reason, and
 * reports the other figure rather than switching to it: measured again when
 * that change was considered, the same pattern held and had grown, so
 * reconciling against the cleared figure would have booked the accumulated
 * difference as an adjustment. Both tools read the same two numbers from
 * `balanceBreakdown`, which is what keeps them from drifting.
 */

const KIND_TEXT: Record<Candidate['kind'], (c: Candidate) => string> = {
  duplicate: (c) => `looks entered twice, the other is dated ${c.twinDate}`,
  other_account: (c) => `this amount is on ${c.accountName ?? 'another account'}`,
  after_cutoff: () => `dated after the cutoff, so the balance above does not count it`,
  amount_match: () => `same amount as the difference`,
};

/**
 * Whether a bare amount match means anything, which depends on the difference.
 *
 * Measured on generated accounts with realistic amounts, counting how often
 * some row happens to equal a difference that nothing should explain:
 *
 *   difference              40 rows   100 rows   200 rows
 *   a multiple of 100.00      64%       73%        75%
 *   whole pesos, not 100s      0%        0.2%       0%
 *   anything with centavos     0%        0%         0%
 *
 * So the warning that an amount match is probably noise is true only for round
 * differences, and saying it about the others argues against a good lead: an
 * exact match on a figure with centavos is rare enough to be worth chasing.
 * An audit caught this being said about 3,333.33.
 */
function differenceIsRound(cents: number): boolean {
  return Math.abs(cents) % 10000 === 0;
}

/** Strongest signal first. A bare amount match is common by chance, so it goes last. */
const KIND_ORDER: Candidate['kind'][] = [
  'duplicate',
  'other_account',
  'after_cutoff',
  'amount_match',
];

function describeCandidate(c: Candidate): string {
  const bits = [c.date, formatMoney(c.amount)];
  if (c.payeeName) bits.push(c.payeeName);
  if (c.notes) bits.push(c.notes);
  if (c.cleared !== true) bits.push('(uncleared)');
  return `  ${bits.join('  ')}\n      ${KIND_TEXT[c.kind](c)}\n      id: ${c.id}`;
}

export function registerReconcileAccount(server: McpServer): void {
  server.tool(
    'reconcile_account',
    'Compare an account against the balance a bank reports, and list what might explain the difference. ' +
      'Reads only; books nothing.',
    {
      account: z.string().describe('Account name or ID'),
      expected_balance: z
        .number()
        .describe('Balance the bank reports for this account (human amount, e.g., 45230.18)'),
      as_of: z
        .string()
        .optional()
        .describe(
          'Date the bank figure is from (YYYY-MM-DD or "today"). Defaults to today. Transactions after this date are not counted in the balance.',
        ),
      balance_counts: z
        .enum(['all', 'cleared_only'])
        .optional()
        .describe(
          'Which transactions the balance counts. "all" (default) counts uncleared rows too, which is right when uncleared means nobody ticked it off rather than the bank has not posted it. "cleared_only" counts only cleared rows.',
        ),
      lookback_days: z
        .number()
        .optional()
        .describe('How far back to look for candidates, in days. Defaults to 90.'),
    },
    { title: 'Reconcile an account against a bank figure', readOnlyHint: true },
    async ({ account, expected_balance, as_of, balance_counts, lookback_days }) => {
      try {
        await ensureConnection();

        const accountId = await resolveAccountId(account);
        const accounts = await api.getAccounts();
        const accountName = accounts.find((a) => a.id === accountId)?.name ?? account;

        // One resolved date, threaded to everything that asks what day it is,
        // so the balance and the candidate search cannot disagree (#100).
        const asOf = resolveDate(as_of);
        const countsAll = (balance_counts ?? 'all') === 'all';
        const lookback =
          lookback_days === undefined ? 90 : Math.max(1, Math.round(lookback_days));

        // Both figures from one place, so this and the tool that books an
        // adjustment cannot answer "what does the balance count" differently
        // (#108). It computed its own cleared sum before, which was the same
        // arithmetic written twice.
        const breakdown = await balanceBreakdown(accountId, asOf);
        const actualCents = countsAll ? breakdown.all : breakdown.cleared;

        const expectedCents = amountToCents(expected_balance);
        const difference = expectedCents - actualCents;

        const lines = [
          `${accountName} as of ${asOf}`,
          '',
          `  This budget says:  ${formatMoney(actualCents)}${countsAll ? '' : '   (cleared rows only)'}`,
          `  The bank says:     ${formatMoney(expectedCents)}`,
          `  Difference:        ${formatMoney(difference)}`,
          '',
        ];

        const report = await findReconcileCandidates(accountId, asOf, difference, lookback);

        if (difference === 0) {
          lines.push('These agree.');
          if (report.unclearedCount > 0 || report.afterCutoffCount > 0) {
            lines.push('', 'Worth knowing anyway:');
            if (report.unclearedCount > 0) {
              lines.push(
                `  ${report.unclearedCount} row${report.unclearedCount === 1 ? '' : 's'} in this window ${report.unclearedCount === 1 ? 'is' : 'are'} not marked cleared, and the balance above counts ${report.unclearedCount === 1 ? 'it' : 'them'}.`,
              );
            }
            if (report.afterCutoffCount > 0) {
              lines.push(
                `  ${report.afterCutoffCount} row${report.afterCutoffCount === 1 ? '' : 's'} dated after ${asOf}, not counted above.`,
              );
            }
          }
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        lines.push(
          difference > 0
            ? `The bank is higher by ${formatMoney(difference)}. Either something that came in is not recorded here, or something recorded here did not happen.`
            : `The bank is lower by ${formatMoney(-difference)}. Either something that went out is not recorded here, or something recorded here did not happen.`,
          '',
        );

        // The same footer whichever branch is taken. It used to sit only on the
        // empty one, so the window was never mentioned in the case an audit
        // showed is worse: a duplicate pair 120 days back, with a decoy of the
        // same amount inside the window. The reply offered the decoy, labelled
        // it weak, and said nothing about the window being short. The stronger
        // answer existed and the default hid it.
        const footer = [
          `Looked at ${report.rowsExamined} transaction${report.rowsExamined === 1 ? '' : 's'} between ${report.from} and ${report.to}, at the other accounts for the same amount, and after the cutoff.`,
          `If what you are looking for is older than ${lookback} days, raise lookback_days.`,
        ];

        if (report.candidates.length === 0) {
          lines.push(
            'Nothing here explains it.',
            '',
            ...footer,
            `${report.unclearedCount} of the rows in that window ${report.unclearedCount === 1 ? 'is' : 'are'} uncleared; ${report.afterCutoffCount} row${report.afterCutoffCount === 1 ? '' : 's'} sit after ${asOf}.`,
            '',
            'That usually means a movement that was never entered, which nothing here can',
            'show you because it is not here. Combinations of transactions are not searched',
            'on purpose: on an account this size some pair adds up to almost any round',
            'figure, so a list of them would be arithmetic rather than evidence.',
          );
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        const ordered = [...report.candidates].sort(
          (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
        );
        lines.push(
          `${ordered.length} thing${ordered.length === 1 ? '' : 's'} worth looking at, most telling first:`,
          '',
        );
        for (const c of ordered) lines.push(describeCandidate(c), '');

        const weak = ordered.filter((c) => c.kind === 'amount_match').length;
        if (weak > 0) {
          const subject = weak === 1 ? 'one is' : `${weak} are`;
          lines.push(
            differenceIsRound(difference)
              ? `The last ${subject} only an amount match, and this difference is a round figure. On an account of this size some row happens to equal a round figure about two times in three when nothing is wrong at all, so treat it as a place to look rather than an answer.`
              : `The last ${subject} only an amount match, but this difference is not a round figure, and an exact match on one of those is rare: measured, it almost never happens by chance. Worth chasing.`,
            '',
          );
        }
        lines.push(...footer);

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
