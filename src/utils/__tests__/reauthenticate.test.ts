import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@actual-app/api', () => ({
  default: {},
  init: vi.fn(),
  sync: vi.fn(),
  utils: {},
}));

import * as api from '@actual-app/api';
import { reauthenticate, resetReauthClock } from '../../connection.js';
import { claimDataDir, forgetActiveDataDir, LOCK_FILE } from '../data-dir-lock.js';

/**
 * How often this signs in again, and why those are the numbers (#162).
 *
 * Measured against a disposable Actual server: `/login` allows five failed
 * attempts per fifteen minutes and then answers 429 `too-many-requests`,
 * counting only the failures. A 429 is worse than the failure it replaces,
 * because it hides `invalid-password` behind an answer about rate limits.
 */
describe('signing in again', () => {
  const env = { ...process.env };

  beforeEach(() => {
    resetReauthClock();
    vi.mocked(api.init).mockReset().mockResolvedValue({} as never);
    process.env.ACTUAL_SERVER_URL = 'http://localhost:5006';
    process.env.ACTUAL_BUDGET_ID = 'budget-1';
    process.env.ACTUAL_PASSWORD = 'secret';
    delete process.env.ACTUAL_SESSION_TOKEN;
  });

  afterEach(() => {
    process.env = { ...env };
    forgetActiveDataDir();
    vi.restoreAllMocks();
  });

  it('signs in against the directory this process holds', () => {
    // #71: when the configured directory is already held, this server steps
    // aside to a sibling. Signing in against the configured one would open a
    // second copy of the budget, and the budget that is open is the one the
    // sync that follows uses.
    const root = mkdtempSync(join(tmpdir(), 'reauth-dir-'));
    try {
      const configured = join(root, 'cache');
      mkdirSync(configured, { recursive: true });
      writeFileSync(
        join(configured, LOCK_FILE),
        JSON.stringify({ pid: process.pid, startedAt: '2026-10-17T00:00:00.000Z', version: '0.10.6' }),
      );
      process.env.ACTUAL_DATA_DIR = configured;
      vi.spyOn(process, 'pid', 'get').mockReturnValue(999_200);

      const claim = claimDataDir('0.10.6');
      expect(claim.dataDir, 'the arrangement itself').not.toBe(configured);

      return reauthenticate().then(() => {
        expect(api.init).toHaveBeenCalledWith(
          expect.objectContaining({ dataDir: claim.dataDir }),
        );
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('signs in with the password', async () => {
    await expect(reauthenticate()).resolves.toEqual({ outcome: 'signed-in' });
    expect(api.init).toHaveBeenCalledOnce();
  });

  it('has nothing to sign in with when a token is configured', async () => {
    // The only thing that path offers is setting the token you already have,
    // and the one you have is the expired one.
    process.env.ACTUAL_SESSION_TOKEN = 'tok';

    await expect(reauthenticate()).resolves.toEqual({ outcome: 'no-password' });
    expect(api.init).not.toHaveBeenCalled();
  });

  it('waits between attempts, and stops after two in an hour', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-17T09:00:00Z'));
      expect((await reauthenticate()).outcome).toBe('signed-in');

      // Nineteen minutes later: too soon. It says when the next attempt is
      // allowed, so the reply can say how long it is waiting instead of
      // covering four cases at once.
      vi.setSystemTime(new Date('2026-10-17T09:19:00Z'));
      expect(await reauthenticate()).toEqual({
        outcome: 'waiting',
        nextAttemptAt: new Date('2026-10-17T09:20:00Z').getTime(),
      });

      // Twenty-one: the second of the hour.
      vi.setSystemTime(new Date('2026-10-17T09:21:00Z'));
      expect((await reauthenticate()).outcome).toBe('signed-in');

      // And the third is refused however long it waits, until the first
      // falls out of the hour. Two per hour cannot reach five in fifteen
      // minutes, which is where the server starts answering 429.
      // Here the hour is what binds, not the gap: the gap ran out at 09:41
      // and the first attempt only leaves the hour at 10:00.
      vi.setSystemTime(new Date('2026-10-17T09:55:00Z'));
      expect(await reauthenticate()).toEqual({
        outcome: 'waiting',
        nextAttemptAt: new Date('2026-10-17T10:00:00Z').getTime(),
      });

      vi.setSystemTime(new Date('2026-10-17T10:22:00Z'));
      expect((await reauthenticate()).outcome).toBe('signed-in');
      expect(api.init).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for whichever of the two limits runs out last', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-17T09:00:00Z'));
      await reauthenticate();
      vi.setSystemTime(new Date('2026-10-17T09:45:00Z'));
      await reauthenticate();

      // Two in the hour, so the first has to age out of it at 10:00. But the
      // gap since 09:45 only runs out at 10:05, and a reply that promised
      // 10:00 would have the caller back to the same answer five minutes
      // later.
      vi.setSystemTime(new Date('2026-10-17T09:50:00Z'));
      expect(await reauthenticate()).toEqual({
        outcome: 'waiting',
        nextAttemptAt: new Date('2026-10-17T10:05:00Z').getTime(),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells a wrong password from anything else', async () => {
    // They need different things done about them, and a wrong password is
    // the one that must not be retried at all.
    vi.mocked(api.init).mockRejectedValue(
      Object.assign(new Error('Authentication failed'), { code: 'invalid-password' }),
    );

    // With what Actual said: a reply that cannot name the password as the
    // problem sends the reader to check the server instead.
    await expect(reauthenticate()).resolves.toMatchObject({
      outcome: 'refused',
      error: { code: 'invalid-password' },
    });
  });

  it('reports a failure that is not about the password', async () => {
    vi.mocked(api.init).mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(reauthenticate()).resolves.toMatchObject({
      outcome: 'failed',
      error: { message: 'connect ECONNREFUSED' },
    });
  });

  it('signs in once for everyone waiting', async () => {
    let release: (() => void) | undefined;
    vi.mocked(api.init).mockImplementation(
      () => new Promise((resolve) => { release = () => resolve({} as never); }) as never,
    );

    const both = Promise.all([reauthenticate(), reauthenticate()]);
    await new Promise((r) => setTimeout(r, 0));
    release!();

    expect(await both).toEqual([{ outcome: 'signed-in' }, { outcome: 'signed-in' }]);
    expect(api.init, 'two sign-ins would be two sessions and two chances to be refused').toHaveBeenCalledOnce();
  });
});
