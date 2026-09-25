import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeQ, lastQuery } from '../../tools/__tests__/fake-query.js';

const runQuery = vi.fn();
const getTransactions = vi.fn();

vi.mock('@actual-app/api', () => ({
  default: {},
  runQuery: (...a: unknown[]) => runQuery(...a),
  getTransactions: (...a: unknown[]) => getTransactions(...a),
  q: (table: string) => fakeQ(table),
}));

import { newWriteMarker, findByMarker, corroborateAbsence } from '../write-marker.js';

beforeEach(() => {
  runQuery.mockReset();
  getTransactions.mockReset();
});

describe('the label a write carries', () => {
  it('is a uuid, so two writes can never collide', () => {
    expect(newWriteMarker()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(newWriteMarker()).not.toBe(newWriteMarker());
  });
});

describe('finding a write by its label', () => {
  it('returns the row when it is there', async () => {
    runQuery.mockResolvedValue({ data: [{ id: 'ours', amount: -5000 }] });

    expect(await findByMarker('m')).toEqual([{ id: 'ours', amount: -5000 }]);
  });

  it('returns an empty list when nothing carries it', async () => {
    runQuery.mockResolvedValue({ data: [] });

    expect(await findByMarker('m')).toEqual([]);
  });

  it('returns null when the budget cannot be read', async () => {
    // Not an empty list: "the query failed" and "there is nothing" decide
    // opposite things about whether a retry is safe.
    runQuery.mockRejectedValue(new Error('budget will not open'));

    expect(await findByMarker('m')).toBeNull();
  });

  it('returns null when the query answers with no data at all', async () => {
    runQuery.mockResolvedValue({});

    expect(await findByMarker('m')).toBeNull();
  });
});

describe('the query the lookup actually builds', () => {
  it('asks for splits, or it could never see a split it just wrote', async () => {
    // AQL defaults to `splits: 'inline'`, which adds `WHERE is_parent = 0`, and
    // the row carrying our id in a split is the parent. Without this the probe
    // reported a saved split as "not saved, and can be retried", which
    // duplicates a parent and every child under it.
    runQuery.mockResolvedValue({ data: [] });

    await findByMarker('m');

    expect(lastQuery.table).toBe('transactions');
    expect(lastQuery.filter).toEqual({ id: 'm' });
    expect(lastQuery.options).toEqual({ splits: 'all' });
  });

  it('looks the row up by id, not by imported_id', async () => {
    runQuery.mockResolvedValue({ data: [] });

    await findByMarker('m');

    expect(lastQuery.filter).not.toHaveProperty('imported_id');
  });
});

describe('the second look, used only before authorising a retry', () => {
  it('finds the row when it is there under its own id', async () => {
    getTransactions.mockResolvedValue([{ id: 'm', amount: -1 }]);

    expect(await corroborateAbsence('acc-1', 'm')).toBe('present');
  });

  it('finds it when it is a child of a split', async () => {
    getTransactions.mockResolvedValue([
      { id: 'parent', subtransactions: [{ id: 'm' }] },
    ]);

    expect(await corroborateAbsence('acc-1', 'm')).toBe('present');
  });

  it('says absent when the day holds other transactions but not ours', async () => {
    getTransactions.mockResolvedValue([{ id: 'someone-elses', amount: -5000 }]);

    expect(await corroborateAbsence('acc-1', 'm')).toBe('absent');
  });

  it('looks at the whole account, not the date we asked for', async () => {
    // Rules rewrite the date. Pinning this to the date we sent would make the
    // safety net blind in the one case it exists for.
    getTransactions.mockResolvedValue([]);

    await corroborateAbsence('acc-1', 'm');

    expect(getTransactions).toHaveBeenCalledWith('acc-1');
  });

  it('says unknown when it cannot read, rather than absent', async () => {
    getTransactions.mockRejectedValue(new Error('budget will not open'));

    expect(await corroborateAbsence('acc-1', 'm')).toBe('unknown');
  });
});
