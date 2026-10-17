import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  init: vi.fn(),
  sync: vi.fn(),
  utils: {},
}));

import * as api from '@actual-app/api';
import { reauthenticate, resetReauthClock } from '../../connection.js';

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
  });

  it('signs in with the password', async () => {
    await expect(reauthenticate()).resolves.toBe('signed-in');
    expect(api.init).toHaveBeenCalledOnce();
  });

  it('has nothing to sign in with when a token is configured', async () => {
    // The only thing that path offers is setting the token you already have,
    // and the one you have is the expired one.
    process.env.ACTUAL_SESSION_TOKEN = 'tok';

    await expect(reauthenticate()).resolves.toBe('no-password');
    expect(api.init).not.toHaveBeenCalled();
  });

  it('waits between attempts, and stops after two in an hour', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-17T09:00:00Z'));
      expect(await reauthenticate()).toBe('signed-in');

      // Nineteen minutes later: too soon.
      vi.setSystemTime(new Date('2026-10-17T09:19:00Z'));
      expect(await reauthenticate()).toBe('waiting');

      // Twenty-one: the second of the hour.
      vi.setSystemTime(new Date('2026-10-17T09:21:00Z'));
      expect(await reauthenticate()).toBe('signed-in');

      // And the third is refused however long it waits, until the first
      // falls out of the hour. Two per hour cannot reach five in fifteen
      // minutes, which is where the server starts answering 429.
      vi.setSystemTime(new Date('2026-10-17T09:55:00Z'));
      expect(await reauthenticate()).toBe('waiting');

      vi.setSystemTime(new Date('2026-10-17T10:22:00Z'));
      expect(await reauthenticate()).toBe('signed-in');
      expect(api.init).toHaveBeenCalledTimes(3);
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

    await expect(reauthenticate()).resolves.toBe('refused');
  });

  it('reports a failure that is not about the password', async () => {
    vi.mocked(api.init).mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(reauthenticate()).resolves.toBe('failed');
  });

  it('signs in once for everyone waiting', async () => {
    let release: (() => void) | undefined;
    vi.mocked(api.init).mockImplementation(
      () => new Promise((resolve) => { release = () => resolve({} as never); }) as never,
    );

    const both = Promise.all([reauthenticate(), reauthenticate()]);
    await new Promise((r) => setTimeout(r, 0));
    release!();

    expect(await both).toEqual(['signed-in', 'signed-in']);
    expect(api.init, 'two sign-ins would be two sessions and two chances to be refused').toHaveBeenCalledOnce();
  });
});
