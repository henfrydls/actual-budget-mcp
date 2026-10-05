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
import { registerCreateTransaction } from '../../write/create-transaction.js';
import { registerDeleteTransaction } from '../../write/delete-transaction.js';

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

const ROW_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

/**
 * #111: two tool calls sent without awaiting the first.
 *
 * The handlers interleave inside this server, so a check that reads the
 * transactions table while another handler is half way through changing it
 * sees a state that is already gone.
 */
describe.skipIf(skip)('tool calls that arrive together', () => {
  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  async function budgetWithOneRow(name: string) {
    let account = '';
    await createFreshBudget(async () => {
      account = await api.createAccount({ name: 'Checking', offbudget: false } as never, 0);
      await api.addTransactions(account, [
        { id: ROW_ID, date: '2026-09-10', amount: -5000, payee_name: 'Colmado' },
      ] as never);
    }, name);
    return account;
  }

  it('does not warn about a row another call is deleting', async () => {
    // Measured before the queue: fired together, the duplicate warning named
    // the row the delete had already removed, and the transaction that should
    // have been created was refused. The same pair in sequence creates
    // normally, which is what made it look like the settle window of #105 and
    // is not.
    await budgetWithOneRow('pipelined-race');
    const remove = handlerFor(registerDeleteTransaction);
    const create = handlerFor(registerCreateTransaction);

    // Both sent before either is awaited, which is the shape that fails.
    const [, created] = await Promise.all([
      remove({ transaction_id: ROW_ID, confirm: true }),
      create({ account: 'Checking', amount: -50, date: '2026-09-10', payee: 'Colmado' }),
    ]);

    const text = created.content[0].text;
    expect(text).not.toContain('already exists');
    expect(text).toContain('Transaction created');
  }, 60_000);

  it('still warns about a row that is really there', async () => {
    // The guard the queue must not have silenced: with nothing deleting it,
    // the duplicate warning is still the right answer.
    await budgetWithOneRow('pipelined-real-duplicate');
    const create = handlerFor(registerCreateTransaction);

    const created = await create({
      account: 'Checking',
      amount: -50,
      date: '2026-09-10',
      payee: 'Colmado',
    });

    expect(created.content[0].text).toContain('already exists');
  }, 60_000);

  it('applies both calls, in the order they arrived', async () => {
    await budgetWithOneRow('pipelined-order');
    const remove = handlerFor(registerDeleteTransaction);
    const create = handlerFor(registerCreateTransaction);

    const account = (await api.getAccounts()).find((a) => a.name === 'Checking')!.id;
    await Promise.all([
      remove({ transaction_id: ROW_ID, confirm: true }),
      create({ account: 'Checking', amount: -77, date: '2026-09-11', payee: 'Otro' }),
    ]);

    const rows = await api.getTransactions(account, '1900-01-01', '2999-12-31');
    // The original is gone and the new one is there: one in, one out.
    expect(rows.map((r) => r.amount).sort()).toEqual([-7700]);
  }, 60_000);
});
