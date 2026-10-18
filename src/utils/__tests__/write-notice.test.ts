import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actual-app/api', () => ({ default: {}, sync: vi.fn(), utils: {} }));
vi.mock('../currency.js', () => ({ refreshBudgetDecimalPlaces: vi.fn() }));
vi.mock('../../connection.js', () => ({ reauthenticate: vi.fn() }));
vi.mock('../data-dir-lock.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../data-dir-lock.js')>()),
  readDataDirLock: vi.fn(),
}));

import * as api from '@actual-app/api';
import { reauthenticate } from '../../connection.js';
import { readDataDirLock } from '../data-dir-lock.js';
import { resetSyncClock, syncNow, withSyncScope } from '../sync-clock.js';
import { syncFailureNotice, withWriteNotice } from '../write-notice.js';
import type { McpServerLike } from '../read-sync.js';

const withCode = (code: string) => Object.assign(new Error('sync refused'), { code });

/** A write tool as the server sees it: a handler behind the notice wrapper. */
function wrap(
  handler: () => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>,
  annotations: Record<string, unknown> = { readOnlyHint: false },
) {
  let registered: (() => Promise<{ content: Array<{ text: string }> }>) | undefined;
  const server = {
    tool: (...args: unknown[]) => {
      registered = args[args.length - 1] as never;
    },
  };
  withWriteNotice(server as unknown as McpServerLike).tool(
    'create_payee' as never,
    'd' as never,
    {} as never,
    annotations as never,
    handler as never,
  );
  return registered!;
}

/** A tool that writes and then pushes, which is what twenty-six of them do. */
const writeThenPush = (text = 'Payee created:') => async () => {
  await syncNow();
  return { content: [{ type: 'text', text }] };
};

/**
 * What a write says about its sync (#162).
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
    vi.mocked(reauthenticate).mockReset().mockResolvedValue({ outcome: 'signed-in' });
  });

  it('says nothing when the sync worked', async () => {
    const reply = await wrap(writeThenPush())();

    expect(reply.content[0].text).toBe('Payee created:');
  });

  it('says the write is only on this machine when the sync failed', async () => {
    // Any failure, not only an expired session: a server that is down leaves
    // the write in exactly the same place.
    vi.mocked(api.sync).mockRejectedValue(new Error('connect ECONNREFUSED'));

    const reply = await wrap(writeThenPush())();

    expect(reply.content[0].text).toContain('did not reach the Actual server');
    expect(reply.content[0].text, 'a retry would write it twice').toContain(
      'Do not repeat the call',
    );
    expect(reply.content[0].text).toContain('ECONNREFUSED');
  });

  it('says when it had to sign in again to get there', async () => {
    vi.mocked(api.sync).mockRejectedValueOnce(withCode('token-expired'));

    const reply = await wrap(writeThenPush())();

    expect(reply.content[0].text).toContain('signed in again');
  });

  /**
   * Whose failure it is, which the process-wide clock cannot answer.
   *
   * Measured on the first version of this, against a disposable server: a
   * refusal that wrote nothing came back telling the caller not to repeat a
   * write that had never happened.
   */
  describe('the call it belongs to', () => {
    it('says nothing when only the pull before the check failed', async () => {
      // `create_transaction` refusing a duplicate: it pulls, finds the row
      // already there, writes nothing and never reaches a push.
      vi.mocked(api.sync).mockRejectedValue(new Error('server is down'));

      const refusal = async () => {
        await syncNow({ pulling: true });
        return { content: [{ type: 'text', text: 'Nothing was created: already recorded.' }] };
      };
      const reply = await wrap(refusal)();

      expect(reply.content[0].text).toBe('Nothing was created: already recorded.');
    });

    it('does not lend one call the failure of the one before it', async () => {
      vi.mocked(api.sync).mockRejectedValue(new Error('server is down'));
      await wrap(writeThenPush())();

      // A second call that writes nothing and syncs nothing. The clock still
      // holds the first one's failure, and this reply is not about it.
      const reply = await wrap(async () => ({
        content: [{ type: 'text', text: 'Nothing to do.' }],
      }))();

      expect(reply.content[0].text).toBe('Nothing to do.');
    });

    it('keeps two calls in flight apart', async () => {
      // The failing one is slower, so it settles after the other has read its
      // own scope: with one clock for the process, whichever replied last
      // carried the other's failure.
      vi.mocked(api.sync).mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error('server is down');
      });
      const failing = wrap(writeThenPush('Payee created: A'))();
      const quick = wrap(async () => ({ content: [{ type: 'text', text: 'Payee created: B' }] }))();

      const [slowReply, quickReply] = await Promise.all([failing, quick]);

      expect(quickReply.content[0].text).toBe('Payee created: B');
      expect(slowReply.content[0].text).toContain('did not reach the Actual server');
    });

    it('keeps the last push and not the first', async () => {
      // A sync pushes everything still pending, so a second one that worked
      // did send what the first left behind.
      vi.mocked(api.sync)
        .mockRejectedValueOnce(new Error('server is down'))
        .mockResolvedValue(undefined as never);

      const twice = async () => {
        await syncNow();
        await syncNow();
        return { content: [{ type: 'text', text: 'Rows created: 2' }] };
      };

      expect((await wrap(twice)()).content[0].text).toBe('Rows created: 2');
    });
  });

  /**
   * The other server on the same budget, which is not why this failed (#206).
   *
   * Seen in the live test of 0.10.7: a push against a stopped server ended on
   * a paragraph about a server from three weeks earlier, attached to
   * `Reason:` where it reads as the cause.
   */
  describe('the note about another server', () => {
    beforeEach(() => {
      vi.mocked(readDataDirLock).mockReset().mockReturnValue({
        pid: 4242,
        startedAt: '2026-09-24T10:00:00.000Z',
        version: '0.10.7',
      });
    });

    it('leaves it out of a failure it did not cause', async () => {
      vi.mocked(api.sync).mockRejectedValue(
        Object.assign(new Error('We had an unknown problem opening "b"'), {}),
      );

      const text = (await wrap(writeThenPush())()).content[0].text;

      expect(text).toContain('did not reach the Actual server');
      expect(text).toContain('did not answer');
      expect(text, 'a fact about startup, not about this sync').not.toContain('pid 4242');
    });

    it('keeps it for the failure two servers do cause', async () => {
      // An out-of-sync budget is what sharing a cache produces, and there the
      // other server is the answer rather than a distraction.
      vi.mocked(api.sync).mockRejectedValue(
        Object.assign(new Error(''), { reason: 'out-of-sync' }),
      );

      const text = (await wrap(writeThenPush())()).content[0].text;

      expect(text).toContain('pid 4242');
    });
  });

  /**
   * Why the session was not renewed, in the words of the case that happened.
   *
   * The general text covers four cases at once. Measured against a disposable
   * server configured with the wrong password: Actual answered
   * `invalid-password`, and the reply never said so.
   */
  describe('why it could not sign in again', () => {
    beforeEach(() => {
      vi.mocked(api.sync).mockReset().mockRejectedValue(withCode('token-expired'));
    });

    it('says when the server refused the password', async () => {
      vi.mocked(reauthenticate).mockResolvedValue({
        outcome: 'refused',
        error: Object.assign(new Error('Authentication failed'), { code: 'invalid-password' }),
      });

      const text = (await wrap(writeThenPush())()).content[0].text;

      expect(text).toContain('refused the password');
      expect(text).toContain('ACTUAL_PASSWORD');
      expect(text, 'four cases at once is what this replaces').not.toContain('too recently');
    });

    it('says when there is no password to sign in with', async () => {
      vi.mocked(reauthenticate).mockResolvedValue({ outcome: 'no-password' });

      const text = (await wrap(writeThenPush())()).content[0].text;

      expect(text).toContain('ACTUAL_SESSION_TOKEN');
      expect(text).toContain('issue a new token');
    });

    it('says how long it is waiting for, rounded up', async () => {
      // Up, not down: thirteen and a half minutes announced as thirteen has
      // the caller back with the same answer thirty seconds early.
      vi.mocked(reauthenticate).mockResolvedValue({
        outcome: 'waiting',
        nextAttemptAt: Date.now() + 13 * 60_000 + 30_000,
      });

      const text = (await wrap(writeThenPush())()).content[0].text;

      expect(text).toContain('in 14 minutes');
    });

    it('never counts down past a minute', async () => {
      // The wait can have run out between the attempt and the reply, and "in
      // 0 minutes" reads as an answer about nothing.
      vi.mocked(reauthenticate).mockResolvedValue({
        outcome: 'waiting',
        nextAttemptAt: Date.now() - 5_000,
      });

      const text = (await wrap(writeThenPush())()).content[0].text;

      expect(text).toContain('in 1 minute.');
    });

    it('says what went wrong when the sign-in itself failed', async () => {
      vi.mocked(reauthenticate).mockResolvedValue({
        outcome: 'failed',
        error: new Error('connect ECONNREFUSED 127.0.0.1:5006'),
      });

      const text = (await wrap(writeThenPush())()).content[0].text;

      expect(text).toContain('signing in again did not work');
      expect(text).toContain('ECONNREFUSED');
    });

    it('says the sync failed even so, when the sign-in worked', async () => {
      vi.mocked(reauthenticate).mockResolvedValue({ outcome: 'signed-in' });

      const text = (await wrap(writeThenPush())()).content[0].text;

      expect(text).toContain('signed in again');
      expect(text).toContain('failed even so');
    });
  });

  describe('the wrapper every write reply goes through', () => {
    it('adds the notice to the reply rather than replacing it', async () => {
      vi.mocked(api.sync).mockRejectedValue(new Error('server is down'));

      const reply = await wrap(writeThenPush())();

      // What the tool wrote and what it said are the answer; this is a
      // caveat that belongs with it.
      expect(reply.content[0].text).toContain('Payee created:');
      expect(reply.content[0].text).toContain('did not reach the Actual server');
    });

    it('leaves a read tool alone, which has a notice of its own', async () => {
      vi.mocked(api.sync).mockRejectedValue(new Error('server is down'));

      const reply = await wrap(writeThenPush('Accounts'), { readOnlyHint: true })();

      expect(reply.content[0].text).toBe('Accounts');
    });

    it('says nothing extra on a reply that already reports a failure', async () => {
      vi.mocked(api.sync).mockRejectedValue(new Error('server is down'));

      const reply = await wrap(async () => {
        await syncNow();
        return { content: [{ type: 'text', text: 'Error: no' }], isError: true };
      })();

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
    vi.mocked(reauthenticate).mockReset().mockResolvedValue({ outcome: 'signed-in' });
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
    vi.mocked(reauthenticate).mockResolvedValue({ outcome: 'waiting' });

    const outcome = await syncNow();

    expect(outcome).toMatchObject({ ok: false, recovery: { outcome: 'waiting' } });
    expect(api.sync, 'one attempt, not two').toHaveBeenCalledTimes(1);
  });

  it('says nothing was signed in when there is no password', async () => {
    vi.mocked(api.sync).mockRejectedValue(withCode('token-expired'));
    vi.mocked(reauthenticate).mockResolvedValue({ outcome: 'no-password' });

    expect(await syncNow()).toMatchObject({ recovery: { outcome: 'no-password' } });
  });

  it('keeps a pull out of the answer a write gives', async () => {
    // The flag, measured where it matters: the scope is what the reply reads.
    vi.mocked(api.sync).mockRejectedValue(new Error('server is down'));

    const { scope } = await withSyncScope(async () => {
      await syncNow({ pulling: true });
    });

    expect(scope.failure).toBeUndefined();
    expect(syncFailureNotice(scope)).toBeUndefined();
  });
});
