import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { registerCreateTransfer } from '../../write/create-transfer.js';
import { registerCreateSplitTransaction } from '../../write/create-split-transaction.js';
import { registerCreateTransaction } from '../../write/create-transaction.js';

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
 * The three create paths that wrote without a duplicate check (#98).
 *
 * #97 added one to `create_transaction`, and the others kept writing blind, so
 * #88 was only half covered. They use the same comparator and the same
 * `allow_duplicate`, because a second notion of "duplicate" would answer
 * differently about the same two rows.
 */
describe.skipIf(skip)('duplicate checks on every create path', () => {
  let digital = '';
  let retiro = '';
  let otra = '';

  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  async function budget(name: string) {
    await createFreshBudget(async () => {
      digital = await api.createAccount({ name: 'Digital', offbudget: false } as never, 0);
      retiro = await api.createAccount({ name: 'Retiro', offbudget: false } as never, 0);
      otra = await api.createAccount({ name: 'Otra', offbudget: false } as never, 0);
      const group = await api.createCategoryGroup({ name: 'Gastos' } as never);
      await api.createCategory({ name: 'Comida', group_id: group } as never);
      await api.createCategory({ name: 'Limpieza', group_id: group } as never);
    }, name);
  }

  const count = async (acct: string) =>
    (await api.getTransactions(acct, '1900-01-01', '2999-12-31')).length;

  describe('create_transfer', () => {
    const move = (args: Record<string, unknown> = {}) =>
      handlerFor(registerCreateTransfer)({
        from_account: 'Digital',
        to_account: 'Retiro',
        amount: 100,
        date: '2026-09-10',
        ...args,
      });

    it('refuses a second identical transfer', async () => {
      await budget('dup-transfer');
      await move();
      const before = await count(digital);

      const second = await move();

      expect(await count(digital)).toBe(before);
      expect(second.content[0].text).toMatch(/already exists/i);
      expect(second.content[0].text).toMatch(/allow_duplicate/);
    }, 60_000);

    it('catches one entered from the other account', async () => {
      // The same movement can be asked for from either side, and the pair of
      // rows is identical: Digital -100 and Retiro +100 either way. Here the
      // first one is written from Retiro with a positive amount through the
      // payee shortcut, and the transfer asked for afterwards is the same
      // movement.
      //
      // Note that `create_transfer` itself cannot express the reverse: it
      // takes the absolute value, so a negative amount still moves from
      // `from_account` to `to_account`. Asking it the other way round is a
      // different transfer, not the same one phrased differently, and the
      // test that tried it was asserting something the tool cannot do.
      await budget('dup-transfer-other-side');
      await handlerFor(registerCreateTransaction)({
        account: 'Retiro',
        payee: 'Digital',
        amount: 100,
        date: '2026-09-10',
      });
      const before = await count(digital);

      const second = await move();

      expect(await count(digital)).toBe(before);
      expect(second.content[0].text).toMatch(/already exists/i);
    }, 60_000);

    it('treats the opposite transfer as a different movement', async () => {
      // Digital -> Retiro and Retiro -> Digital on the same day for the same
      // amount are two movements, not one entered twice. Refusing the second
      // would block a round trip, which the cash route here does make.
      await budget('dup-transfer-opposite');
      await move();
      const before = await count(digital);

      const back = await handlerFor(registerCreateTransfer)({
        from_account: 'Retiro',
        to_account: 'Digital',
        amount: 100,
        date: '2026-09-10',
      });

      expect(await count(digital)).toBe(before + 1);
      expect(back.content[0].text).toMatch(/Transfer created/i);
    }, 60_000);

    it('catches one made by naming the account as a payee', async () => {
      // The #24 shortcut writes the same pair of rows, so a transfer created
      // that way has to be visible to this check.
      await budget('dup-transfer-via-payee');
      await handlerFor(registerCreateTransaction)({
        account: 'Digital',
        payee: 'Retiro',
        amount: -100,
        date: '2026-09-10',
      });
      const before = await count(digital);

      const second = await move();

      expect(await count(digital)).toBe(before);
      expect(second.content[0].text).toMatch(/already exists/i);
    }, 60_000);

    it('tells two accounts with the same name apart', async () => {
      // Actual allows it, and a transfer payee is named after its account, so
      // comparing names made a transfer to one "Ahorro" look like a repeat of
      // a transfer to the other. Both are addressed by id here, because by
      // name there would be no way to say which one is meant.
      let first = '';
      let second = '';
      await createFreshBudget(async () => {
        digital = await api.createAccount({ name: 'Digital', offbudget: false } as never, 0);
        first = await api.createAccount({ name: 'Ahorro', offbudget: false } as never, 0);
        second = await api.createAccount({ name: 'Ahorro', offbudget: false } as never, 0);
      }, 'dup-transfer-same-name');

      const send = (to: string) =>
        handlerFor(registerCreateTransfer)({
          from_account: digital,
          to_account: to,
          amount: 100,
          date: '2026-09-10',
        });

      await send(first);
      const before = await count(digital);

      const other = await send(second);

      expect(await count(digital), 'the second account is not the first').toBe(before + 1);
      expect(other.content[0].text).toMatch(/Transfer created/i);
      // And the one that really is a repeat is still caught.
      const repeat = await send(first);
      expect(repeat.content[0].text).toMatch(/already exists/i);
    }, 60_000);

    it('still catches a repeat after the account is renamed', async () => {
      // The payee follows its account through a rename, so matching on the id
      // must not lose what matching on the name happened to get right.
      await budget('dup-transfer-renamed');
      await move();
      const before = await count(digital);

      await api.updateAccount(retiro, { name: 'Retiro Nuevo' } as never);

      const second = await handlerFor(registerCreateTransfer)({
        from_account: 'Digital',
        to_account: 'Retiro Nuevo',
        amount: 100,
        date: '2026-09-10',
      });

      expect(await count(digital)).toBe(before);
      expect(second.content[0].text).toMatch(/already exists/i);
    }, 60_000);

    it('does not count an unlinked row as the other half of a transfer', async () => {
      // A row can carry a transfer payee without being a transfer: an import
      // that did not link the two sides leaves one. It looks like half a
      // movement and is not one, so the transfer asked for afterwards is the
      // first real one and has to go through.
      await budget('dup-transfer-unlinked');
      const payees = await api.getPayees();
      const toRetiro = payees.find(
        (p) => (p as { transfer_acct?: string }).transfer_acct === retiro,
      );
      await api.addTransactions(
        digital,
        [{ date: '2026-09-10', amount: -10000, payee: toRetiro?.id }] as never,
        // Without runTransfers, so no counterpart and no transfer_id.
        { runTransfers: false } as never,
      );
      const before = await count(digital);

      const result = await move();

      expect(await count(digital)).toBe(before + 1);
      expect(result.content[0].text).toMatch(/Transfer created/i);
    }, 60_000);

    it('allows a second one when told to', async () => {
      // Two identical transfers in a day are ordinary here: a withdrawal
      // split across two operations because of the per-operation limit, or a
      // card paid twice. This is the escape and it has to work.
      await budget('dup-transfer-allowed');
      await move();
      const before = await count(digital);

      const second = await move({ allow_duplicate: true });

      expect(await count(digital)).toBe(before + 1);
      expect(second.content[0].text).toMatch(/Transfer created/i);
    }, 60_000);

    it('does not refuse a transfer to a different account', async () => {
      // Money moves through several accounts in a day -- the cash route here
      // is one account to the next to the cash machine -- so the same amount
      // on the same day to somewhere else is not a repeat.
      await budget('dup-transfer-other-account');
      await move();
      const before = await count(digital);

      const elsewhere = await handlerFor(registerCreateTransfer)({
        from_account: 'Digital',
        to_account: 'Otra',
        amount: 100,
        date: '2026-09-10',
      });

      expect(await count(digital)).toBe(before + 1);
      expect(elsewhere.content[0].text).toMatch(/Transfer created/i);
    }, 60_000);
  });

  describe('create_split_transaction', () => {
    const split = (args: Record<string, unknown> = {}) =>
      handlerFor(registerCreateSplitTransaction)({
        account: 'Digital',
        amount: -70,
        date: '2026-09-10',
        splits: [
          { amount: -40, category: 'Comida' },
          { amount: -30, category: 'Limpieza' },
        ],
        ...args,
      });

    it('refuses a split that repeats a plain transaction', async () => {
      // The case in the issue: a split of -70 written on top of an existing
      // plain row of -70, with no warning.
      await budget('dup-split-over-plain');
      await handlerFor(registerCreateTransaction)({
        account: 'Digital',
        amount: -70,
        date: '2026-09-10',
        payee: 'Colmado',
      });
      const before = await count(digital);

      const result = await split();

      expect(await count(digital)).toBe(before);
      expect(result.content[0].text).toMatch(/already exists/i);
    }, 60_000);

    it('refuses a plain transaction that repeats a split', async () => {
      // The other direction, which matters because the comparator excludes
      // children: it is the parent's total that a duplicate repeats.
      await budget('dup-plain-over-split');
      await split();
      const before = await count(digital);

      const result = await handlerFor(registerCreateTransaction)({
        account: 'Digital',
        amount: -70,
        date: '2026-09-10',
        payee: 'Colmado',
      });

      expect(await count(digital)).toBe(before);
      expect(result.content[0].text).toMatch(/already exists/i);
    }, 60_000);

    it('refuses a second identical split', async () => {
      await budget('dup-split-twice');
      await split();
      const before = await count(digital);

      const second = await split();

      expect(await count(digital)).toBe(before);
      expect(second.content[0].text).toMatch(/already exists/i);
    }, 60_000);

    it('allows one when told to', async () => {
      await budget('dup-split-allowed');
      await split();
      const before = await count(digital);

      const second = await split({ allow_duplicate: true });

      expect(await count(digital)).toBeGreaterThan(before);
      expect(second.content[0].text).toMatch(/Split transaction created/i);
    }, 60_000);

    it('does not refuse a split whose total differs', async () => {
      await budget('dup-split-different-total');
      await split();
      const before = await count(digital);

      const other = await split({
        amount: -80,
        splits: [
          { amount: -40, category: 'Comida' },
          { amount: -40, category: 'Limpieza' },
        ],
      });

      expect(await count(digital)).toBeGreaterThan(before);
      expect(other.content[0].text).toMatch(/Split transaction created/i);
    }, 60_000);
  });
});
