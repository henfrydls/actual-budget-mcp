import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Real @actual-app/api, only api.sync() neutralized (server-less mode).
vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api } from './actual-engine.js';
import { newWriteMarker, findByMarker, corroborateAbsence } from '../../../utils/write-marker.js';
import { createTransaction } from '../../write/create-transaction.js';
import { createSplitTransaction } from '../../write/create-split-transaction.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

/**
 * Against the real engine, because this cannot be proved with mocks.
 *
 * An audit found the lookup unable to see a split it had just written: AQL
 * defaults to `splits: 'inline'`, which adds `WHERE is_parent = 0`, and the row
 * carrying our id is the parent. Every unit test passed, because the mock
 * returned the parent — it encoded the belief rather than the behaviour.
 */
describe.skipIf(skip)('finding a written row by the id we gave it', () => {
  beforeAll(async () => {
    await initTestEngine();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  it('finds a plain transaction', async () => {
    let acctId = '';
    await createFreshBudget(async () => {
      acctId = await api.createAccount({ name: 'Checking', type: 'checking' } as any, 0);
    });
    const marker = newWriteMarker();

    await api.addTransactions(acctId, [
      { id: marker, date: '2026-06-05', amount: -1234 } as any,
    ]);

    const found = await findByMarker(marker);
    expect(found?.map((r) => r.id)).toEqual([marker]);
  });

  it('finds a split, which the default query cannot see at all', async () => {
    let acctId = '';
    let cat = '';
    await createFreshBudget(async () => {
      acctId = await api.createAccount({ name: 'Checking', type: 'checking' } as any, 0);
      const g = await api.createCategoryGroup({ name: 'G' } as any);
      cat = await api.createCategory({ name: 'Groceries', group_id: g } as any);
    });
    const marker = newWriteMarker();

    await api.addTransactions(acctId, [
      {
        id: marker,
        date: '2026-06-05',
        amount: -5000,
        subtransactions: [
          { amount: -3000, category: cat },
          { amount: -2000, category: cat },
        ],
      } as any,
    ]);

    // The whole point: the default options return nothing here.
    const withDefaults = await api.runQuery(
      api.q('transactions').filter({ id: marker }).select(['id']),
    );
    expect(((withDefaults as any)?.data ?? []).length).toBe(0);

    const found = await findByMarker(marker);
    expect(found?.map((r) => r.id)).toEqual([marker]);
  });

  it('says a row is absent when it really is', async () => {
    await createFreshBudget(async () => {
      await api.createAccount({ name: 'Checking', type: 'checking' } as any, 0);
    });

    expect(await findByMarker(newWriteMarker())).toEqual([]);
  });

  it('leaves imported_id alone, so Actual can still deduplicate imports', async () => {
    // Labelling imported_id would make matchTransactions skip fuzzy matching
    // for this row, so a later file import of the same movement would be added
    // instead of merged.
    let acctId = '';
    await createFreshBudget(async () => {
      acctId = await api.createAccount({ name: 'Checking', type: 'checking' } as any, 0);
    });

    await createTransaction({ account: 'Checking', amount: -12.34, date: '2026-06-05' });

    const rows = await api.getTransactions(acctId, '2026-06-05', '2026-06-05');
    expect(rows.length).toBe(1);
    expect((rows[0] as Record<string, unknown>).imported_id ?? null).toBeNull();
  });

  it('corroborates a split through the other code path too', async () => {
    let acctId = '';
    let cat = '';
    await createFreshBudget(async () => {
      acctId = await api.createAccount({ name: 'Checking', type: 'checking' } as any, 0);
      const g = await api.createCategoryGroup({ name: 'G' } as any);
      cat = await api.createCategory({ name: 'Groceries', group_id: g } as any);
    });

    await createSplitTransaction({
      account: 'Checking',
      amount: -100,
      date: '2026-06-05',
      splits: [
        { category: 'Groceries', amount: -60 },
        { category: 'Groceries', amount: -40 },
      ],
    });

    const rows = await api.getTransactions(acctId, '2026-06-05', '2026-06-05');
    const parentId = (rows[0] as Record<string, any>).id as string;

    expect(await corroborateAbsence(acctId, '2026-06-05', parentId)).toBe('present');
    expect(await corroborateAbsence(acctId, '2026-06-05', newWriteMarker())).toBe('absent');
  });
});
