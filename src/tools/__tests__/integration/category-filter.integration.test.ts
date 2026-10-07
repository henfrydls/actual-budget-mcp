import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { registerGetTransactions } from '../../read/get-transactions.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
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

/**
 * Filtering by category, by id as well as by name (#136).
 *
 * Reported from daily use: an id returned "No transactions found", which reads
 * as "this category has nothing" — and that is what the person concluded. The
 * filter compared each row's resolved *name* with the argument, so an id never
 * matched, and every other tool that takes a category accepts one.
 */
describe.skipIf(skip)('get_transactions filtered by category', () => {
  let groceriesId = '';
  let account = '';

  beforeAll(async () => {
    await initTestEngine();
    await createFreshBudget(async () => {
      account = await api.createAccount({ name: 'Checking', offbudget: false } as never, 0);
      const group = await api.createCategoryGroup({ name: 'Gastos' } as never);
      groceriesId = await api.createCategory({ name: 'Supermercado', group_id: group } as never);
      const other = await api.createCategory({ name: 'Transporte', group_id: group } as never);
      await api.addTransactions(account, [
        { date: '2026-09-10', amount: -5000, payee_name: 'Colmado', category: groceriesId },
        { date: '2026-09-11', amount: -7500, payee_name: 'Bravo', category: groceriesId },
        { date: '2026-09-12', amount: -3000, payee_name: 'Guagua', category: other },
      ] as never);
    }, 'category-filter');
  }, 90_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  const ask = async (category: string) =>
    (
      await handlerFor(registerGetTransactions)({
        category,
        start_date: '2026-09-01',
        end_date: '2026-09-30',
      })
    ).content[0].text;

  it('gives the same rows for the id as for the name', async () => {
    // The acceptance the issue asks for: the two spellings of one argument
    // must mean the same thing.
    const byName = await ask('Supermercado');
    const byId = await ask(groceriesId);

    expect(byName).toContain('Colmado');
    expect(byName).toContain('Bravo');
    expect(byName).not.toContain('Guagua');
    expect(byId).toBe(byName);
  });

  it('matches an id whole, and does not treat part of one as a search', async () => {
    // A name is matched on a substring, which is what makes "Super" find
    // "Supermercado". Half an id is not a search, it is a typo, and answering
    // it with rows would be worse than saying nothing.
    const partial = await ask(groceriesId.slice(0, 8));

    expect(partial).not.toContain('Colmado');
    expect(partial).toMatch(/No category matches/);
  });

  it('still finds a category by part of its name', async () => {
    // The behaviour that existed before and that someone may be using: this
    // change must not turn the name filter into an exact match.
    const partial = await ask('Super');

    expect(partial).toContain('Colmado');
    expect(partial).toContain('Bravo');
  });

  it('says the category was not found instead of showing an empty list', async () => {
    // The other half of the bug. "No transactions found" is a wrong answer to
    // a question nobody asked; the question was about a category that is not
    // there.
    const missing = await ask('Caprichos');

    expect(missing).toMatch(/No category matches "Caprichos"/);
    expect(missing).not.toMatch(/No transactions found/);
    // And it points somewhere useful rather than leaving the reader guessing.
    expect(missing).toMatch(/get_categories/);
  });

  it('still says "no transactions" when the category is real but empty', async () => {
    // The two answers must stay different: an empty category is not a missing
    // one, and collapsing them would trade one wrong answer for another.
    await createFreshBudget(async () => {
      await api.createAccount({ name: 'Checking', offbudget: false } as never, 0);
      const group = await api.createCategoryGroup({ name: 'Gastos' } as never);
      await api.createCategory({ name: 'Vacía', group_id: group } as never);
    }, 'category-filter-empty');

    const empty = await ask('Vacía');

    expect(empty).toMatch(/No transactions found/);
    expect(empty).not.toMatch(/No category matches/);
  }, 60_000);
});
