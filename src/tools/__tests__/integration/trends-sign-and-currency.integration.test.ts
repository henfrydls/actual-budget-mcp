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
    await internal.send('save-prefs', { defaultCurrencyCode: 'JPY' });
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
