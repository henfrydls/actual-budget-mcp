import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../../../connection.js', async () => {
  const real = await vi.importActual<typeof import('@actual-app/api')>('@actual-app/api');
  return {
    ensureConnection: vi.fn().mockResolvedValue(undefined),
    getInternal: () => (real as unknown as { internal: unknown }).internal,
  };
});

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { registerCategoryTrends } from '../../analysis/category-trends.js';
import { registerTransferBetweenCategories } from '../../write/transfer-between-categories.js';
import { getInternal } from '../../../connection.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function handlerFor(register: (s: never) => void): Handler {
  let handler: Handler | undefined;
  register({
    tool: (...a: unknown[]) => {
      handler = a.at(-1) as Handler;
    },
  } as never);
  return handler as Handler;
}

describe.skipIf(skip)('a change of direction, and the budget currency', () => {
  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('says the direction changed instead of printing a ratio (#133)', async () => {
    // Spent 400.00 in July, received 2,430.00 in August. The ratio between
    // figures of opposite sign printed -707.5%, which looks like a figure and
    // is not one: spending did not fall by seven hundred percent.
    let category = '';
    await createFreshBudget(async () => {
      const account = await api.createAccount(
        { name: 'Checking', offbudget: false } as never,
        0,
      );
      const group = await api.createCategoryGroup({ name: 'Gastos' } as never);
      category = await api.createCategory({ name: 'Reembolsos', group_id: group } as never);
      await api.addTransactions(account, [
        { date: '2026-07-10', amount: -40000, category },
        { date: '2026-08-10', amount: 243000, category },
      ] as never);
    }, 'trend-sign');

    const result = await handlerFor(registerCategoryTrends)({
      category: 'Reembolsos',
      months: 2,
      month: '2026-08',
    });
    const text = result.content[0].text;

    expect(text).not.toContain('707.5%');
    expect(text).toContain('now receiving');
    // The August row carries no percentage at all.
    const august = text.split('\n').find((l) => l.startsWith('2026-08')) ?? '';
    expect(august).not.toMatch(/\d+(\.\d+)?%/);
  }, 60_000);

  it('says "now spending" when the direction turns the other way', async () => {
    // The other half of the label, which nothing covered: renaming it killed
    // no test, because only the received-then-spent direction was exercised.
    let category = '';
    await createFreshBudget(async () => {
      const account = await api.createAccount(
        { name: 'Checking', offbudget: false } as never,
        0,
      );
      const group = await api.createCategoryGroup({ name: 'Gastos' } as never);
      category = await api.createCategory({ name: 'Reembolsos', group_id: group } as never);
      await api.addTransactions(account, [
        { date: '2026-07-10', amount: 243000, category },
        { date: '2026-08-10', amount: -40000, category },
      ] as never);
    }, 'trend-sign-other-way');

    const result = await handlerFor(registerCategoryTrends)({
      category: 'Reembolsos',
      months: 2,
      month: '2026-08',
    });
    const august = result.content[0].text.split('\n').find((l) => l.startsWith('2026-08')) ?? '';

    expect(august).toContain('now spending');
    expect(august).not.toContain('now receiving');
    expect(august).not.toMatch(/\d+(\.\d+)?%/);
  }, 60_000);

  it('still gives a percentage when both months point the same way', async () => {
    // The guard must not swallow the ordinary case.
    let category = '';
    await createFreshBudget(async () => {
      const account = await api.createAccount(
        { name: 'Checking', offbudget: false } as never,
        0,
      );
      const group = await api.createCategoryGroup({ name: 'Gastos' } as never);
      category = await api.createCategory({ name: 'Comida', group_id: group } as never);
      await api.addTransactions(account, [
        { date: '2026-07-10', amount: -40000, category },
        { date: '2026-08-10', amount: -50000, category },
      ] as never);
    }, 'trend-same-sign');

    const result = await handlerFor(registerCategoryTrends)({
      category: 'Comida',
      months: 2,
      month: '2026-08',
    });
    const august = result.content[0].text.split('\n').find((l) => l.startsWith('2026-08')) ?? '';

    expect(august).toMatch(/\+?25\.0%/);
    expect(august).not.toContain('now');
  }, 60_000);

  it('ranks the top categories with the real sign too (#133)', async () => {
    // The same bug lived in both modes of the same tool. The default mode kept
    // negating a magnitude, so a month that received 2,430.00 read as
    // -2,430.00 spent with a change of +507.5%.
    let category = '';
    await createFreshBudget(async () => {
      const account = await api.createAccount(
        { name: 'Checking', offbudget: false } as never,
        0,
      );
      const group = await api.createCategoryGroup({ name: 'Gastos' } as never);
      category = await api.createCategory({ name: 'Comida', group_id: group } as never);
      const other = await api.createCategory({ name: 'Reembolsos', group_id: group } as never);
      await api.addTransactions(account, [
        { date: '2026-07-10', amount: -40000, category: other },
        { date: '2026-08-10', amount: 243000, category: other },
        { date: '2026-07-11', amount: -90000, category },
        { date: '2026-08-11', amount: -95000, category },
      ] as never);
    }, 'trend-top-sign');

    const result = await handlerFor(registerCategoryTrends)({ months: 2, month: '2026-08' });
    const text = result.content[0].text;

    // Comida spent in both months and keeps a percentage.
    expect(text).toMatch(/Comida\s+Avg:\s+-925\.00/);
    expect(text).toMatch(/Comida[^\n]*Change: \+5\.6%/);
    // A category that received money is not ranked among the top spenders at
    // all (#131), so the one that crossed signs must not appear here.
    expect(text).not.toContain('Reembolsos');
    expect(text).not.toContain('+507.5%');
  }, 60_000);

  it('labels a direction change in the top-categories mode too', async () => {
    // The gap the first version of the test above could not see. The ranking
    // only lists categories whose reference month is spending (#131), so a
    // category that crosses signs appears there only when it **ends** on
    // spending: received in July, spent in August. Without such a row, both
    // negating the sign and dropping the label changed nothing.
    let category = '';
    await createFreshBudget(async () => {
      const account = await api.createAccount(
        { name: 'Checking', offbudget: false } as never,
        0,
      );
      const group = await api.createCategoryGroup({ name: 'Gastos' } as never);
      category = await api.createCategory({ name: 'Mixta', group_id: group } as never);
      await api.addTransactions(account, [
        { date: '2026-07-10', amount: 243000, category },
        { date: '2026-08-10', amount: -95000, category },
      ] as never);
    }, 'trend-top-crossing');

    const result = await handlerFor(registerCategoryTrends)({ months: 2, month: '2026-08' });
    const line = result.content[0].text.split('\n').find((l) => l.startsWith('Mixta')) ?? '';

    expect(line).not.toBe('');
    // August is spending, July was receiving: the ratio between them has no
    // reading, and the latest figure keeps its own sign.
    expect(line).toContain('now spending');
    // Not 740.00. The reimbursed month is not part of an average of what was
    // spent; averaging it in turned the figure positive.
    expect(line).toContain('Avg:      -950.00');
    expect(line).toContain('Latest:      -950.00');
    expect(line).not.toMatch(/Change: [+-]?\d/);
  }, 60_000);

  it('gives the same average for a category in either mode', async () => {
    // The two modes answer the same question about the same category, and
    // until #133 they answered it differently: the ranking averaged quiet
    // months and reimbursements in, the single-category view did not. A reader
    // comparing the two had no way to tell which was wrong.
    let category = '';
    await createFreshBudget(async () => {
      const account = await api.createAccount(
        { name: 'Checking', offbudget: false } as never,
        0,
      );
      const group = await api.createCategoryGroup({ name: 'Gastos' } as never);
      category = await api.createCategory({ name: 'Luz', group_id: group } as never);
      // June spent, July quiet, August spent: one month of each kind.
      await api.addTransactions(account, [
        { date: '2026-06-10', amount: -120000, category },
        { date: '2026-08-10', amount: -80000, category },
      ] as never);
    }, 'trend-mode-agreement');

    const handler = handlerFor(registerCategoryTrends);
    const ranked = (await handler({ months: 3, month: '2026-08' })).content[0].text;
    const single = (await handler({ category: 'Luz', months: 3, month: '2026-08' })).content[0]
      .text;

    const rankedAvg = ranked.split('\n').find((l) => l.startsWith('Luz'))?.match(/Avg:\s+(\S+)/)?.[1];
    const singleAvg = single.match(/Average:\s+(\S+)/)?.[1];

    expect(rankedAvg).toBeDefined();
    expect(singleAvg).toBeDefined();
    // Two spending months of 1,200.00 and 800.00; the quiet one is not an
    // amount that was spent, so neither mode counts it.
    expect(singleAvg).toBe('-1,000.00');
    expect(rankedAvg).toBe(singleAvg);
  }, 60_000);

  it("writes the month note in the budget's own currency (#115)", async () => {
    // `getCurrency` falls back to `{code: "", decimalPlaces: 2}`, and that
    // decimal count is the divisor the note is formatted with. On a currency
    // with none, the figure came out wrong by a factor of a hundred.
    let from = '';
    let to = '';
    await createFreshBudget(async () => {
      const group = await api.createCategoryGroup({ name: 'Gastos' } as never);
      from = await api.createCategory({ name: 'Origen', group_id: group } as never);
      to = await api.createCategory({ name: 'Destino', group_id: group } as never);
    }, 'currency-note');

    const internal = getInternal() as unknown as {
      send: (m: string, a?: unknown) => Promise<unknown>;
    };
    // The way the app saves it: a synced preference. Saving it with
    // `save-prefs` instead writes the metadata store, which `preferences/get`
    // does not return — and a test that seeded it there passed while the tool
    // found nothing on a real budget.
    await internal.send('preferences/save', { id: 'defaultCurrencyCode', value: 'JPY' });
    await api.setBudgetAmount('2026-09', from, 2000000);

    await handlerFor(registerTransferBetweenCategories)({
      from: 'Origen',
      to: 'Destino',
      amount: 100,
      month: '2026-09',
    });

    const note = (await internal.send('notes-get', { id: 'budget-2026-09' })) as {
      note?: string;
    } | null;
    const line = String(note?.note ?? '').split('\n').pop() ?? '';

    // 10,000 cents in a zero-decimal currency is 10,000, not 100.
    expect(line).toContain('10,000');
    expect(line).not.toMatch(/Reassigned 100\.00 /);
  }, 60_000);

  it('writes the note unchanged when the budget has no currency set', async () => {
    // A fresh budget has no `defaultCurrencyCode` at all, and absent is not a
    // currency: the engine's own fallback is what should apply.
    let from = '';
    let to = '';
    await createFreshBudget(async () => {
      const group = await api.createCategoryGroup({ name: 'Gastos' } as never);
      from = await api.createCategory({ name: 'Origen', group_id: group } as never);
      to = await api.createCategory({ name: 'Destino', group_id: group } as never);
    }, 'currency-note-absent');

    await api.setBudgetAmount('2026-09', from, 2000000);
    const result = await handlerFor(registerTransferBetweenCategories)({
      from: 'Origen',
      to: 'Destino',
      amount: 100,
      month: '2026-09',
    });

    expect(result.isError).toBeFalsy();
    const internal = getInternal() as unknown as {
      send: (m: string, a?: unknown) => Promise<unknown>;
    };
    const note = (await internal.send('notes-get', { id: 'budget-2026-09' })) as {
      note?: string;
    } | null;
    expect(String(note?.note ?? '')).toContain('100.00');
  }, 60_000);
});
