import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { registerReconcileAccount } from '../../read/reconcile-account.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

function handlerFor(): Handler {
  let handler: Handler | undefined;
  registerReconcileAccount({
    tool: (...a: unknown[]) => {
      handler = a.at(-1) as Handler;
    },
  } as never);
  return handler as Handler;
}

/**
 * What the cutoff means for the candidates (#179).
 *
 * A date range written as one object drops its upper bound in AQL, so both
 * searches ran from the start of the window to the end of the budget and rows
 * dated after the cutoff were offered as explanations for a difference the
 * balance computes without them.
 *
 * Checked through the tool, not through the query: the query returning the
 * right rows is not the claim, what reaches the reader is.
 */
describe.skipIf(skip)('reconcile_account and the cutoff', () => {
  let checking = '';
  let savings = '';

  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  async function budget(name: string, seed: (ids: { checking: string; savings: string }) => Promise<void>) {
    await createFreshBudget(async () => {
      checking = await api.createAccount({ name: 'Checking', offbudget: false } as never, 0);
      savings = await api.createAccount({ name: 'Savings', offbudget: false } as never, 0);
      await seed({ checking, savings });
    }, name);
    for (let i = 0; i < 6; i += 1) await api.getCategories();
  }

  it('does not offer a row on another account dated after the cutoff', async () => {
    // Reported first, as the most telling, which is the worst place for it:
    // a row the compared balance does not count cannot explain a difference
    // against that balance.
    await budget('cutoff-elsewhere', async ({ checking: c, savings: s }) => {
      await api.addTransactions(
        c,
        [{ date: '2026-09-01', amount: -10000, payee_name: 'Rent' }] as never,
        { learnCategories: false, runTransfers: false },
      );
      await api.addTransactions(
        s,
        [{ date: '2026-09-21', amount: -4733, payee_name: 'ELSEWHERE-AFTER-CUTOFF' }] as never,
        { learnCategories: false, runTransfers: false },
      );
    });

    const text = (
      await handlerFor()({
        account: 'Checking',
        expected_balance: -147.33,
        as_of: '2026-09-10',
        lookback_days: 90,
      })
    ).content[0].text;

    expect(text).not.toContain('ELSEWHERE-AFTER-CUTOFF');
    expect(text).not.toContain('this amount is on Savings');
  }, 60_000);

  it('still offers one on another account inside the window', async () => {
    // The search itself has to go on working, or the fix is just a narrower
    // tool.
    await budget('cutoff-elsewhere-inside', async ({ checking: c, savings: s }) => {
      await api.addTransactions(
        c,
        [{ date: '2026-09-01', amount: -10000, payee_name: 'Rent' }] as never,
        { learnCategories: false, runTransfers: false },
      );
      await api.addTransactions(
        s,
        [{ date: '2026-09-08', amount: -4733, payee_name: 'ELSEWHERE-INSIDE' }] as never,
        { learnCategories: false, runTransfers: false },
      );
    });

    const text = (
      await handlerFor()({
        account: 'Checking',
        expected_balance: -147.33,
        as_of: '2026-09-10',
        lookback_days: 90,
      })
    ).content[0].text;

    expect(text).toContain('ELSEWHERE-INSIDE');
    expect(text).toContain('this amount is on Savings');
  }, 60_000);

  it('does not offer a row on this account dated after the cutoff as an amount match', async () => {
    // The half that hid the bug: when such a row is classified as
    // after_cutoff it comes back correctly labelled, and the output looks
    // right. It is only when the amount match wins that it is presented as
    // an explanation, with a note saying the match is worth chasing.
    await budget('cutoff-amount-match', async ({ checking: c }) => {
      await api.addTransactions(
        c,
        [
          { date: '2026-09-01', amount: -10000, payee_name: 'Rent' },
          { date: '2026-09-05', amount: -2500, payee_name: 'Shop' },
          { date: '2026-09-20', amount: -2500, payee_name: 'AFTER-CUTOFF-TWIN' },
        ] as never,
        { learnCategories: false, runTransfers: false },
      );
    });

    const text = (
      await handlerFor()({
        account: 'Checking',
        expected_balance: -100,
        as_of: '2026-09-10',
        lookback_days: 90,
      })
    ).content[0].text;

    // The one inside the window is still offered.
    expect(text).toContain('2026-09-05');
    // The one after it is not offered as a match for the difference.
    const lines = text.split('\n');
    const twin = lines.findIndex((l) => l.includes('AFTER-CUTOFF-TWIN'));
    if (twin !== -1) {
      // If it appears at all it must be as what it is, not as an explanation.
      expect(lines.slice(twin, twin + 3).join('\n')).toContain('dated after the cutoff');
      expect(lines.slice(twin, twin + 3).join('\n')).not.toContain('same amount as the difference');
    }
  }, 60_000);

  it('still labels a row after the cutoff when it is worth naming', async () => {
    // The separate `$gt` query was always right, and it must keep reporting.
    await budget('cutoff-after-label', async ({ checking: c }) => {
      await api.addTransactions(
        c,
        [
          { date: '2026-09-01', amount: -10000, payee_name: 'Rent' },
          { date: '2026-09-20', amount: -4733, payee_name: 'AFTER-CUTOFF-ROW' },
        ] as never,
        { learnCategories: false, runTransfers: false },
      );
    });

    const text = (
      await handlerFor()({
        account: 'Checking',
        expected_balance: -147.33,
        as_of: '2026-09-10',
        lookback_days: 90,
      })
    ).content[0].text;

    expect(text).toContain('AFTER-CUTOFF-ROW');
    expect(text).toContain('dated after the cutoff');
  }, 60_000);

  it('does not reach back past the lookback window either', async () => {
    // The other end of the same range. A row older than `lookback_days` is
    // outside what this tool says it looked at, and the closing line names
    // that range, so offering one from before it is the same fault read the
    // other way.
    await budget('cutoff-lookback', async ({ checking: c }) => {
      await api.addTransactions(
        c,
        [
          { date: '2026-06-01', amount: -4733, payee_name: 'TOO-OLD' },
          { date: '2026-09-01', amount: -10000, payee_name: 'Rent' },
        ] as never,
        { learnCategories: false, runTransfers: false },
      );
    });

    const text = (
      await handlerFor()({
        account: 'Checking',
        // The budget is at -147.33 to the cutoff; the bank is 47.33 lower.
        expected_balance: -194.66,
        as_of: '2026-09-10',
        lookback_days: 15,
      })
    ).content[0].text;

    expect(text, 'a row older than the window was offered').not.toContain('TOO-OLD');
    expect(text).toMatch(/Looked at 1 transaction between 2026-08-26 and 2026-09-10/);
  }, 60_000);

  it('counts what is in the range it names', async () => {
    // The closing line states a range and a count, and they disagreed: it
    // counted the rows the dropped bound had let in.
    await budget('cutoff-count', async ({ checking: c }) => {
      await api.addTransactions(
        c,
        [
          { date: '2026-09-01', amount: -10000, payee_name: 'Rent' },
          { date: '2026-09-05', amount: -2500, payee_name: 'Shop' },
          { date: '2026-09-20', amount: -2500, payee_name: 'After' },
          { date: '2026-09-25', amount: -1700, payee_name: 'Later' },
        ] as never,
        { learnCategories: false, runTransfers: false },
      );
    });

    const text = (
      await handlerFor()({
        account: 'Checking',
        expected_balance: -100,
        as_of: '2026-09-10',
        lookback_days: 90,
      })
    ).content[0].text;

    // Two rows are inside 2026-06-12 to 2026-09-10; two are after it.
    expect(text).toMatch(/Looked at 2 transactions between \d{4}-\d{2}-\d{2} and 2026-09-10/);
  }, 60_000);
});
