import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  sync: vi.fn().mockResolvedValue(undefined),
  utils: {
    amountToInteger: (amount: number) => Math.round(amount * 100),
    integerToAmount: (cents: number) => cents / 100,
  },
}));

const send = vi.fn();

vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
  getInternal: () => ({ send }),
}));

import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { repairSyncState } from '../write/repair-sync.js';

describe('repairSyncState (#41 recover from an out-of-sync budget)', () => {
  beforeEach(() => {
    send.mockReset().mockResolvedValue(undefined);
    vi.mocked(api.sync).mockClear().mockResolvedValue(undefined);
    vi.mocked(ensureConnection).mockReset().mockResolvedValue(undefined);
  });

  it('still repairs when the connection failed because the budget is out of sync', async () => {
    // ensureConnection() runs downloadBudget(), which is exactly what throws on
    // an out-of-sync budget. Bailing out there would make this tool useless in
    // the only situation it exists for: the budget is already loaded by then,
    // so the repair must go ahead.
    vi.mocked(ensureConnection).mockRejectedValue(new Error(''));

    await repairSyncState();

    expect(send).toHaveBeenCalledWith('sync-repair');
  });

  it("runs Actual's sync-repair handler", async () => {
    await repairSyncState();

    expect(send).toHaveBeenCalledWith('sync-repair');
  });

  it('syncs afterwards so the repaired state reaches the server', async () => {
    await repairSyncState();

    expect(api.sync).toHaveBeenCalled();
  });

  it('reports success in the returned lines', async () => {
    const lines = await repairSyncState();

    expect(lines.join('\n')).toMatch(/repair/i);
  });

  it('surfaces a clear error when the repair itself fails', async () => {
    send.mockRejectedValue(new Error('boom'));

    await expect(repairSyncState()).rejects.toThrow(/repair/i);
  });
});
