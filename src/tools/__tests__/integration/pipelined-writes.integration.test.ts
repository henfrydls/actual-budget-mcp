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
import { registerCreateTransactions } from '../../write/create-transactions.js';
import { queueTransactionWrite } from '../../../utils/transaction-writes.js';

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

  /** No rows at all: these tests must not write before the call under test. */
  async function emptyBudget(name: string) {
    let account = '';
    await createFreshBudget(async () => {
      account = await api.createAccount({ name: 'Checking', offbudget: false } as never, 0);
    }, name);
    return account;
  }

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

  // The batch tool had the gap the single-row tool never had. Its queue opened
  // around the write alone, so the duplicate checks — which read the
  // transactions table and decide whether the write happens at all — ran
  // outside it. An audit reproduced all three of these against the engine.

  it('does not refuse a batch over a row another call is deleting', async () => {
    // Measured with the queue around the write alone: `Nothing was created.
    // 1 of 1 rows could not be used`, naming a row the delete had removed
    // before the batch got to write. Nothing was created at all.
    await budgetWithOneRow('batch-race-delete');
    const remove = handlerFor(registerDeleteTransaction);
    const batch = handlerFor(registerCreateTransactions);

    const [, created] = await Promise.all([
      remove({ transaction_id: ROW_ID, confirm: true }),
      batch({
        transactions: [
          { account: 'Checking', amount: -50, date: '2026-09-10', payee: 'Colmado' },
        ],
      }),
    ]);

    const text = created.content[0].text;
    expect(text).not.toContain('could not be used');
    expect(text).toContain('Created 1 transaction');
  }, 60_000);

  it('does not write the same movement twice when a batch races a single create', async () => {
    // The other direction, and worse: measured with the old boundary, both
    // calls reported success and the budget ended with two rows for one
    // movement. Which of the two refuses is not the point and is not asserted;
    // that only one row exists is.
    const account = await emptyBudget('batch-race-create');
    const create = handlerFor(registerCreateTransaction);
    const batch = handlerFor(registerCreateTransactions);

    const row = { account: 'Checking', amount: -50, date: '2026-09-10', payee: 'Colmado' };
    const [single, bulk] = await Promise.all([
      create({ ...row }),
      batch({ transactions: [{ ...row }] }),
    ]);

    const rows = await api.getTransactions(account, '1900-01-01', '2999-12-31');
    expect(
      rows,
      `single: ${single.content[0].text}\nbatch: ${bulk.content[0].text}`,
    ).toHaveLength(1);
  }, 60_000);

  it('refuses a batch retried while the first one is still queued', async () => {
    // The shape an MCP client creates on its own: a slow write holds the
    // queue, the client's own request timeout fires, the agent retries, and
    // the first call is still in the queue and will write. Measured with the
    // old boundary: `Created 1 transaction.` twice and two rows, because the
    // retry read the table before the first write had happened.
    //
    // The three seconds are the hold, not a timeout: what matters is that the
    // retry is sent while the first is queued behind something.
    const account = await emptyBudget('batch-retry');
    const batch = handlerFor(registerCreateTransactions);

    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = queueTransactionWrite(() => held);

    const row = { account: 'Checking', amount: -50, date: '2026-09-10', payee: 'Colmado' };
    const first = batch({ transactions: [{ ...row }] });
    const retry = batch({ transactions: [{ ...row }] });

    release();
    await blocker;
    const [a, b] = await Promise.all([first, retry]);

    const rows = await api.getTransactions(account, '1900-01-01', '2999-12-31');
    expect(
      rows,
      `first: ${a.content[0].text}\nretry: ${b.content[0].text}`,
    ).toHaveLength(1);
  }, 60_000);

  it('applies both calls, in the order they arrived', async () => {
    // The new row deliberately matches the one being deleted. That is what
    // makes the order observable: delete first and the create sees nothing to
    // warn about, so one row is left; create first and it finds the original,
    // refuses, and the delete then leaves none.
    //
    // A first version used a different date and amount, where the two calls
    // commute: the same single row came out whichever ran first, so the test
    // was named for an order it could not see.
    await budgetWithOneRow('pipelined-order');
    const remove = handlerFor(registerDeleteTransaction);
    const create = handlerFor(registerCreateTransaction);

    const account = (await api.getAccounts()).find((a) => a.name === 'Checking')!.id;
    await Promise.all([
      remove({ transaction_id: ROW_ID, confirm: true }),
      create({ account: 'Checking', amount: -50, date: '2026-09-10', payee: 'Colmado' }),
    ]);

    const rows = await api.getTransactions(account, '1900-01-01', '2999-12-31');
    expect(rows).toHaveLength(1);
    // The one that is there is the new one: the original carried the marker.
    expect(rows[0].id).not.toBe(ROW_ID);
    expect(rows[0].amount).toBe(-5000);
  }, 60_000);
});
