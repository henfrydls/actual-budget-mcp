import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * WRITE smoke test against a REAL Actual server, exercising the real connection
 * and the real `api.sync()` push (the paths the local server-less integration
 * tests stub out).
 *
 * This WRITES, so it is heavily gated and must target a DEDICATED throwaway
 * budget — never your real one. It creates its own uniquely-named account and
 * deletes it (and its transactions) on teardown.
 *
 * Enable with:
 *   ACTUAL_WRITE_SMOKE=1            # explicit opt-in / acknowledgement
 *   ACTUAL_SERVER_URL=...           # your server
 *   ACTUAL_PASSWORD=...
 *   ACTUAL_BUDGET_ID=<TEST budget>  # a dedicated throwaway budget sync id
 *   npm test -- real-server-write.smoke
 */

const enabled =
  process.env.ACTUAL_WRITE_SMOKE === '1' &&
  !!process.env.ACTUAL_SERVER_URL &&
  !!process.env.ACTUAL_BUDGET_ID;

describe.skipIf(!enabled)('real server WRITE smoke (#28/#25/#30, dedicated budget)', () => {
  let api: typeof import('@actual-app/api');
  let shutdown: typeof import('../../../connection.js').shutdown;
  let createSplitTransaction: typeof import('../../write/create-split-transaction.js').createSplitTransaction;
  let updateTransactionFields: typeof import('../../write/update-transaction.js').updateTransactionFields;
  let reconcileCurrencyResidual: typeof import('../../write/reconcile-currency-residual.js').reconcileCurrencyResidual;

  const stamp = `smoke-${Date.now()}`;
  let acctId = '';
  let groupId = '';

  beforeAll(async () => {
    const conn = await import('../../../connection.js');
    shutdown = conn.shutdown;
    api = await import('@actual-app/api');
    createSplitTransaction = (await import('../../write/create-split-transaction.js')).createSplitTransaction;
    updateTransactionFields = (await import('../../write/update-transaction.js')).updateTransactionFields;
    reconcileCurrencyResidual = (await import('../../write/reconcile-currency-residual.js')).reconcileCurrencyResidual;

    await conn.ensureConnection(); // real connect + download of the TEST budget

    acctId = await api.createAccount({ name: `Z-${stamp}`, type: 'checking' } as any, 0);
    groupId = await api.createCategoryGroup({ name: `ZG-${stamp}` } as any);
    await api.createCategory({ name: `ZC1-${stamp}`, group_id: groupId } as any);
    await api.createCategory({ name: `ZC2-${stamp}`, group_id: groupId } as any);
    await api.sync();
  }, 120_000);

  afterAll(async () => {
    // Clean up everything this test created so the budget is left as it was.
    try {
      if (acctId) await api.deleteAccount(acctId);
      if (groupId) await api.deleteCategoryGroup(groupId);
      await api.sync();
    } catch {
      // best-effort cleanup
    }
    if (shutdown) await shutdown();
  }, 120_000);

  it('create_split_transaction persists through a real sync', async () => {
    await createSplitTransaction({
      account: `Z-${stamp}`,
      amount: -150,
      date: '2026-06-05',
      payee: `ZP-${stamp}`,
      splits: [
        { category: `ZC1-${stamp}`, amount: -90 },
        { category: `ZC2-${stamp}`, amount: -60 },
      ],
    });

    const parent = (await api.getTransactions(acctId, '2026-06-05', '2026-06-05')).find((t: any) => t.is_parent);
    expect((parent as any)?.amount).toBe(-15000);
    expect((parent as any)?.subtransactions).toHaveLength(2);
  }, 120_000);

  it('update_transaction preserves a split sub amount through a real sync', async () => {
    const parent = (await api.getTransactions(acctId, '2026-06-05', '2026-06-05')).find((t: any) => t.is_parent);
    const sub = (parent as any).subtransactions[0];
    await updateTransactionFields({ transaction_id: sub.id, notes: 'smoke' });

    const after = (await api.getTransactions(acctId, '2026-06-05', '2026-06-05')).find((t: any) => t.is_parent);
    const target = (after as any).subtransactions.find((s: any) => s.id === sub.id);
    expect(target.amount).toBe(sub.amount);
    expect((after as any).amount).toBe(-15000);
  }, 120_000);

  it('reconcile_currency_residual hits the target through a real sync', async () => {
    await reconcileCurrencyResidual({
      account: `Z-${stamp}`,
      target_balance: 0,
      category: `ZC1-${stamp}`,
      date: '2026-06-06',
    });
    expect(await api.getAccountBalance(acctId)).toBe(0);
  }, 120_000);
});
