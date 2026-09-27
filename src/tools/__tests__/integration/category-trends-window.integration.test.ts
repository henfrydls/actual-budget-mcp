import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { registerCategoryTrends } from '../../analysis/category-trends.js';
import { registerGetCategoryBalance } from '../../read/get-category-balance.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function handlerFor(): Handler {
  let handler: Handler | undefined;
  registerCategoryTrends({
    tool: (...a: unknown[]) => {
      handler = a.at(-1) as Handler;
    },
  } as never);
  return handler as Handler;
}

/** The month before this one, the way the tool derives its unanchored window. */
const prev = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1);
const PREV_MONTH = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
const dayIn = (month: string, d: number) => `${month}-${String(d).padStart(2, '0')}`;

/**
 * `category_trends` with a window that ends where the caller says (#90).
 *
 * The months in the anchored tests are fixed and in the past on purpose: they
 * are before this repository existed in that state and stay in the past however
 * long from now this runs. The unanchored one derives its month, because what
 * it is checking is precisely the relationship to today.
 */
describe.skipIf(skip)('category_trends window', () => {
  let comida = '';
  let transporte = '';

  beforeAll(async () => {
    await initTestEngine();
    await createFreshBudget(async () => {
      const acct = await api.createAccount({ name: 'Checking', type: 'checking' } as never, 0);
      const g = await api.createCategoryGroup({ name: 'Gastos' } as never);
      comida = await api.createCategory({ name: 'Comida', group_id: g } as never);
      transporte = await api.createCategory({ name: 'Transporte', group_id: g } as never);

      await api.addTransactions(acct, [
        // April, May, June 2026: a rising line in Comida.
        { date: '2026-04-10', amount: -10000, category: comida, cleared: true },
        { date: '2026-05-10', amount: -20000, category: comida, cleared: true },
        { date: '2026-06-10', amount: -30000, category: comida, cleared: true },
        // Transporte outspends Comida in May but not in June, so which month
        // the ranking comes from is visible in the order.
        { date: '2026-05-11', amount: -90000, category: transporte, cleared: true },
        { date: '2026-06-11', amount: -1000, category: transporte, cleared: true },
        // And something in the month before this one, for the unanchored case.
        { date: dayIn(PREV_MONTH, 12), amount: -45000, category: comida, cleared: true },
      ] as never);
    }, 'trends-window');
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('reads the window the caller asked for, ending in a past month', async () => {
    // The case from the issue: asking for June used to return the last three
    // months relative to today, silently.
    const result = await handlerFor()({ category: 'Comida', months: 3, month: '2026-06' });

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;

    expect(text).toContain('2026-06');
    expect(text).toContain('2026-05');
    expect(text).toContain('2026-04');
    // And the figures are those months', not this month's.
    expect(text).toContain('-300.00');
    expect(text).toContain('-200.00');
    expect(text).toContain('-100.00');
    expect(text).toContain('2026-04 to 2026-06');
  }, 60_000);

  it('still ends today when no month is given', async () => {
    const result = await handlerFor()({ category: 'Comida', months: 2 });
    const text = result.content[0].text;

    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    expect(text).toContain(thisMonth);
    expect(text).toContain(PREV_MONTH);
    expect(text).not.toContain('2026-04');
  }, 60_000);

  it('ranks the top categories by the anchored month, not the one before it', async () => {
    // Transporte outspends Comida in May, Comida outspends it in June. Asking
    // for June and being ranked by May would answer a question nobody asked.
    const result = await handlerFor()({ months: 3, month: '2026-06' });
    const text = result.content[0].text;

    expect(text).toContain('ranked by 2026-06');
    expect(text.indexOf('Comida')).toBeLessThan(text.indexOf('Transporte'));
  }, 60_000);

  it('still ranks by the last full month when nothing is anchored', async () => {
    // The existing behaviour, kept: the current month is part-spent, so
    // ranking by it would under-report whatever is billed late.
    const result = await handlerFor()({ months: 2 });

    expect(result.content[0].text).toContain(`ranked by ${PREV_MONTH}`);
  }, 60_000);

  it('says what window it read, so a silent mismatch cannot repeat', async () => {
    const result = await handlerFor()({ category: 'Comida', months: 2, month: '2026-05' });
    expect(result.content[0].text).toContain('2026-04 to 2026-05');
  }, 60_000);

  it('refuses a months count that cannot produce a window', async () => {
    for (const months of [0, -3, 2.5]) {
      const result = await handlerFor()({ category: 'Comida', months });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('whole number of at least 1');
      // And it says there is no ceiling, which is the belief that cost time.
      expect(result.content[0].text).toContain('no upper limit');
    }
  }, 60_000);

  it('reads a long window when asked, since the default is not a limit', async () => {
    const result = await handlerFor()({ category: 'Comida', months: 24, month: '2026-06' });

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('2024-07 to 2026-06');
    expect(text).toContain('2026-04');
    // The months before the budget file starts are named rather than dropped,
    // so a window that came back shorter than asked for says why. Before this,
    // the whole call died on the first of them with
    // `No budget exists for month: 2025-12`.
    expect(text).toMatch(/month.? in that window .* before this budget starts/);
  }, 120_000);

  it('is still the message the guard recognises', async () => {
    // The guard matches Actual's wording, so a version that reworded this
    // would turn it into either swallowing everything or swallowing nothing,
    // both silently. This is the notification: if it fails, the guard needs
    // updating before a long window quietly breaks again.
    //
    // Same reasoning as the handler test in #113: pin the behaviour that is
    // not ours, so its change announces itself.
    await expect(api.getBudgetMonth('2020-01' as never)).rejects.toThrow(
      /No budget exists for month/i,
    );
  }, 60_000);

  it('reads a past window in get_category_balance too', async () => {
    // Anchored the same way, for the reason written in the tool: one of the
    // two honouring `month` while the other ignored it is the shape that cost
    // the time in the issue.
    let handler: Handler | undefined;
    registerGetCategoryBalance({
      tool: (...a: unknown[]) => {
        handler = a.at(-1) as Handler;
      },
    } as never);

    const result = await handler!({ category: 'Comida', months: 3, month: '2026-06' });

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('2026-06');
    expect(text).toContain('2026-04');
    // June's figure, not this month's.
    expect(text).toContain('-300.00');
  }, 60_000);

  it('refuses an impossible months count in get_category_balance too', async () => {
    // The same check, and it had none of its own: mutating it away left the
    // suite green because only the trends one was pinned.
    let handler: Handler | undefined;
    registerGetCategoryBalance({
      tool: (...a: unknown[]) => {
        handler = a.at(-1) as Handler;
      },
    } as never);

    for (const months of [0, -3, 2.5]) {
      const result = await handler!({ category: 'Comida', months });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('whole number of at least 1');
      expect(result.content[0].text).toContain('no upper limit');
    }
  }, 60_000);

  it('does not die on a long window in get_category_balance either', async () => {
    // The same throw, in the other tool whose default was being read as a
    // limit. Fixing the description without this would have been a promise
    // that fails when taken up.
    let handler: Handler | undefined;
    registerGetCategoryBalance({
      tool: (...a: unknown[]) => {
        handler = a.at(-1) as Handler;
      },
    } as never);

    const result = await handler!({ category: 'Comida', months: 24 });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Comida');
  }, 120_000);
});
