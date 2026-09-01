import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../data-dir-lock.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../data-dir-lock.js')>()),
  readDataDirLock: vi.fn(),
}));

import { readDataDirLock } from '../data-dir-lock.js';
import { describeError } from '../errors.js';

/** A sync failure exactly as @actual-app/api reports it (#40: empty message). */
const syncFailure = Object.assign(new Error(''), { reason: 'out-of-sync' });

describe('describeError names data dir contention (#47)', () => {
  beforeEach(() => {
    vi.mocked(readDataDirLock).mockReset();
  });

  afterEach(() => {
    delete process.env.ACTUAL_DATA_DIR;
  });

  it('points at the other server when one holds the data dir', () => {
    vi.mocked(readDataDirLock).mockReturnValue({
      pid: 4242,
      startedAt: '2026-08-31T10:00:00.000Z',
      version: '0.8.1',
    });

    const message = describeError(syncFailure);

    expect(message).toMatch(/another/i);
    expect(message).toContain('4242');
    expect(message).toMatch(/ACTUAL_DATA_DIR/);
  });

  it('still explains how to repair, not only the contention', () => {
    vi.mocked(readDataDirLock).mockReturnValue({
      pid: 4242,
      startedAt: '2026-08-31T10:00:00.000Z',
      version: '0.8.1',
    });

    expect(describeError(syncFailure)).toContain('repair_sync');
  });

  it('says nothing about contention when the directory is free', () => {
    vi.mocked(readDataDirLock).mockReturnValue(null);

    const message = describeError(syncFailure);

    expect(message).not.toMatch(/another/i);
    expect(message).toContain('repair_sync');
  });

  it('does not blame ourselves for holding our own lock', () => {
    vi.mocked(readDataDirLock).mockReturnValue({
      pid: process.pid,
      startedAt: '2026-08-31T10:00:00.000Z',
      version: '0.8.1',
    });

    expect(describeError(syncFailure)).not.toMatch(/another/i);
  });

  it('leaves unrelated errors untouched', () => {
    vi.mocked(readDataDirLock).mockReturnValue({
      pid: 4242,
      startedAt: '2026-08-31T10:00:00.000Z',
      version: '0.8.1',
    });

    expect(describeError(new Error('No account found matching "Nope"'))).toBe(
      'No account found matching "Nope"',
    );
  });

  it('mentions contention on the empty-message sync failure too', () => {
    vi.mocked(readDataDirLock).mockReturnValue({
      pid: 4242,
      startedAt: '2026-08-31T10:00:00.000Z',
      version: '0.8.1',
    });

    expect(describeError(new Error(''))).toMatch(/another/i);
  });
});
