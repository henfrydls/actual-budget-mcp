import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actual-app/api', () => ({ default: {}, sync: vi.fn(), utils: {} }));
vi.mock('../currency.js', () => ({ refreshBudgetDecimalPlaces: vi.fn() }));
vi.mock('../../connection.js', () => ({ reauthenticate: vi.fn() }));

import * as api from '@actual-app/api';
import { reauthenticate } from '../../connection.js';
import { markFailedSync, markGoodSync, resetSyncClock, syncNow } from '../sync-clock.js';
import { syncFailureNotice, withWriteNotice } from '../write-notice.js';

const withCode = (code: string) => Object.assign(new Error('sync refused'), { code });

/**
 * What a write says when its sync did not reach the server (#162).
 *
 * Actual writes locally and pushes on the next sync, so a write whose sync
 * fails is in the budget on this machine and nowhere else. Measured against a
 * disposable server with the session expired: the reply was `isError: true`
 * and the payee was there, which is the answer that invites a retry.
 */
describe('what a write says about its sync', () => {
  beforeEach(() => {
    resetSyncClock();
    vi.mocked(api.sync).mockReset().mockResolvedValue(undefined as never);
    vi.mocked(reauthenticate).mockReset().mockResolvedValue('signed-in');
  });

  it('says nothing when the sync worked', () => {
    markGoodSync();
    expect(syncFailureNotice(Date.now() - 10)).toBeUndefined();
  });

  it('says the write is only on this machine when the sync failed', () => {
    // Any failure, not only an expired session: a server that is down leaves
    // the write in exactly the same place.
    markFailedSync(new Error('connect ECONNREFUSED'));
    const notice = syncFailureNotice(Date.now() - 10)!;

    expect(notice).toContain('did not reach the Actual server');
    expect(notice, 'a retry would write it twice').toContain('Do not repeat the call');
    expect(notice).toContain('ECONNREFUSED');
  });

  it('says when it had to sign in again to get there', async () => {
    const startedAt = Date.now();
    vi.mocked(api.sync).mockRejectedValueOnce(withCode('token-expired'));

    const outcome = await syncNow();

    expect(outcome).toMatchObject({ ok: true, reauthenticated: true });
    expect(syncFailureNotice(startedAt)).toContain('signed in again');
  });

  it('does not claim a sign-in that happened before this call', async () => {
    vi.mocked(api.sync).mockRejectedValueOnce(withCode('token-expired'));
    await syncNow();

    // A later write, with nothing to report of its own.
    expect(syncFailureNotice(Date.now() + 1)).toBeUndefined();
  });

  describe('the wrapper every write reply goes through', () => {
    const wrap = (annotations: Record<string, unknown>, text = 'Payee created:') => {
      let registered: ((...a: unknown[]) => Promise<unknown>) | undefined;
      const server = {
        tool: (...args: unknown[]) => {
          registered = args[args.length - 1] as never;
        },
      };
      withWriteNotice(server as never).tool(
        'create_payee' as never,
        'd' as never,
        {} as never,
        annotations as never,
        (async () => ({ content: [{ type: 'text', text }] })) as never,
      );
      return registered!;
    };

    it('adds the notice to the reply rather than replacing it', async () => {
      markFailedSync(new Error('server is down'));
      const reply = (await wrap({ readOnlyHint: false })()) as {
        content: Array<{ text: string }>;
      };

      // What the tool wrote and what it said are the answer; this is a
      // caveat that belongs with it.
      expect(reply.content[0].text).toContain('Payee created:');
      expect(reply.content[0].text).toContain('did not reach the Actual server');
    });

    it('leaves a read tool alone, which has a notice of its own', async () => {
      markFailedSync(new Error('server is down'));
      const reply = (await wrap({ readOnlyHint: true }, 'Accounts')()) as {
        content: Array<{ text: string }>;
      };

      expect(reply.content[0].text).toBe('Accounts');
    });

    it('says nothing extra on a reply that already reports a failure', async () => {
      markFailedSync(new Error('server is down'));
      let registered: ((...a: unknown[]) => Promise<unknown>) | undefined;
      const server = { tool: (...args: unknown[]) => { registered = args[args.length - 1] as never; } };
      withWriteNotice(server as never).tool(
        'x' as never,
        'd' as never,
        {} as never,
        { readOnlyHint: false } as never,
        (async () => ({ content: [{ type: 'text', text: 'Error: no' }], isError: true })) as never,
      );
      const reply = (await registered!()) as { content: Array<{ text: string }> };

      expect(reply.content[0].text).toBe('Error: no');
    });
  });
});

/**
 * That the wrapper is actually on the tools.
 *
 * The wrapper and its tests can both be right while nothing is wrapped, and
 * then every write reply goes back to saying "created" with the change on
 * this machine only. The source is read rather than the server built, which
 * needs a connection; what matters is that the one line is there and that the
 * reads are inside it, since a tool wrapped by both would carry two notices.
 */
describe('the wiring', () => {
  it('puts every tool through the write notice', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/tools/index.ts', 'utf8');

    expect(source).toContain('withWriteNotice(withReadSync(');
  });
});

/**
 * Which errors are worth signing in again for, and how often.
 */
describe('signing in again after the session expired', () => {
  beforeEach(() => {
    resetSyncClock();
    vi.mocked(api.sync).mockReset();
    vi.mocked(reauthenticate).mockReset().mockResolvedValue('signed-in');
  });

  it('retries the sync once it has signed in again', async () => {
    vi.mocked(api.sync).mockRejectedValueOnce(withCode('token-expired')).mockResolvedValue(
      undefined as never,
    );

    const outcome = await syncNow();

    expect(reauthenticate).toHaveBeenCalledOnce();
    expect(outcome.ok).toBe(true);
    expect(api.sync).toHaveBeenCalledTimes(2);
  });

  it('does not sign in again for anything else', async () => {
    // A code, not a sentence to match, which is what makes this safe to hang
    // a recovery on. A server that is down is not a session that expired.
    vi.mocked(api.sync).mockRejectedValue(new Error('connect ECONNREFUSED'));

    const outcome = await syncNow();

    expect(reauthenticate).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
  });

  it('reports why it did not recover, rather than trying again', async () => {
    // Too soon, or nothing to sign in with. The server allows five failed
    // logins per fifteen minutes and then answers 429, so a retry per call
    // would end in an answer about rate limits hiding the real one.
    vi.mocked(api.sync).mockRejectedValue(withCode('token-expired'));
    vi.mocked(reauthenticate).mockResolvedValue('waiting');

    const outcome = await syncNow();

    expect(outcome).toMatchObject({ ok: false, recovery: 'waiting' });
    expect(api.sync, 'one attempt, not two').toHaveBeenCalledTimes(1);
  });

  it('says nothing was signed in when there is no password', async () => {
    vi.mocked(api.sync).mockRejectedValue(withCode('token-expired'));
    vi.mocked(reauthenticate).mockResolvedValue('no-password');

    expect(await syncNow()).toMatchObject({ recovery: 'no-password' });
  });
});
