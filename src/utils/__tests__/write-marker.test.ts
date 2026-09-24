import { describe, it, expect, vi, beforeEach } from 'vitest';

const runQuery = vi.fn();

vi.mock('@actual-app/api', () => ({
  default: {},
  runQuery: (...a: unknown[]) => runQuery(...a),
  q: () => ({ filter: () => ({ select: () => ({}) }) }),
}));

import { newWriteMarker, findByMarker } from '../write-marker.js';

beforeEach(() => {
  runQuery.mockReset();
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
