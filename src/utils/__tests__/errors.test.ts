import { describe, it, expect } from 'vitest';
import { alreadyDescribed, describeError } from '../errors.js';

describe('describeError (#40 never surface an empty error)', () => {
  it('returns the message of an ordinary error', () => {
    expect(describeError(new Error('Budget not found'))).toBe('Budget not found');
  });

  it('never returns an empty string when the API throws Error("")', () => {
    const described = describeError(new Error(''));

    expect(described).not.toBe('');
    expect(described.length).toBeGreaterThan(0);
  });

  it('points at the server logs when the error carries no message', () => {
    expect(describeError(new Error(''))).toMatch(/log|stderr/i);
  });

  it('explains an out-of-sync failure and how to recover', () => {
    const described = describeError(new Error('SyncError: out-of-sync'));

    expect(described).toMatch(/sync/i);
    expect(described).toMatch(/repair/i);
  });

  it('detects out-of-sync from the reason property of an empty error', () => {
    const error = Object.assign(new Error(''), { reason: 'out-of-sync' });

    expect(describeError(error)).toMatch(/repair/i);
  });

  it('stringifies a non-Error value', () => {
    expect(describeError('plain failure')).toBe('plain failure');
  });

  // What the SDK really throws for a sync failure is `new Error('')` with no
  // `reason`: getSyncError() falls through to an i18next instance that is never
  // initialised, so the message comes out empty. Matching only the literal
  // "out-of-sync" text left the actionable advice unreachable in practice.
  it('offers the repair path for the empty error the SDK actually throws', () => {
    expect(describeError(new Error(''))).toMatch(/repair_sync/);
  });

  it('tells the user to upgrade, not repair, when the budget needs migrations', () => {
    const described = describeError(new Error('out-of-sync-migrations'));

    expect(described).toMatch(/version|upgrade|update/i);
    expect(described).not.toMatch(/repair_sync/);
  });

  it('names the repair tool when out-of-sync is reported explicitly', () => {
    expect(describeError(new Error('SyncError: out-of-sync'))).toMatch(/repair_sync/);
  });

  // String(someObject) is "[object Object]", which hides the failure just as
  // effectively as an empty message. Actual throws plain objects in places.
  it('never returns [object Object] for a thrown plain object', () => {
    const described = describeError({ code: 'EPERM', detail: 'nope' });

    expect(described).not.toContain('[object Object]');
    expect(described).toContain('EPERM');
  });

  it('prefers a message property when the thrown value is not an Error', () => {
    expect(describeError({ message: 'budget is locked' })).toContain('budget is locked');
  });

  it('still detects out-of-sync inside a thrown plain object', () => {
    expect(describeError({ reason: 'out-of-sync' })).toMatch(/repair_sync/);
  });
});

/**
 * A message that is already an explanation, described twice.
 *
 * `repair_sync` builds its own sentence around `describeError` and throws it;
 * whatever catches it describes what it caught. Measured live against a
 * disposable server with the session expired: Actual's own "unknown problem
 * opening" inside the message sent the second pass down the branch for a
 * server that is not answering, so the reply opened by telling the reader to
 * check a server that had just answered.
 */
describe('alreadyDescribed', () => {
  it('hands back the message instead of explaining it again', () => {
    const once = describeError(
      Object.assign(new Error('We had an unknown problem opening "b"'), { code: 'token-expired' }),
    );

    expect(describeError(alreadyDescribed(`Repair failed: ${once}`))).toBe(
      `Repair failed: ${once}`,
    );
  });

  it('describes an ordinary error as it always did', () => {
    expect(describeError(new Error('plain'))).toBe('plain');
  });
});

/**
 * The desktop app, in the message every other failure gets (#240).
 *
 * Its server runs on 127.0.0.1:5007 and only while the app is open, so
 * closing it mid-session fails exactly like a server that is down. The
 * field report is hours spent checking a self-hosted server that does not
 * exist, with "check that it is running" in front of the reader the whole
 * time.
 */
describe('the clause for a closed desktop app', () => {
  const unknownOpen = () => new Error('We had an unknown problem opening "b"');
  const original = process.env.ACTUAL_SERVER_URL;

  const withServer = (url: string | undefined, run: () => void) => {
    if (url === undefined) delete process.env.ACTUAL_SERVER_URL;
    else process.env.ACTUAL_SERVER_URL = url;
    try {
      run();
    } finally {
      if (original === undefined) delete process.env.ACTUAL_SERVER_URL;
      else process.env.ACTUAL_SERVER_URL = original;
    }
  };

  it.each(['http://127.0.0.1:5007', 'http://localhost:5007', 'http://[::1]:5007'])(
    'says so on %s, with what tells it from a sync problem',
    (url) => {
      withServer(url, () => {
        const described = describeError(unknownOpen());

        expect(described).toContain('the Actual desktop app is closed');
        expect(described).toContain('only while the app is open');
        // The tell is what `repair_sync` says, not that it fails: it probes
        // the server and refuses when nothing is listening, and that refusal
        // is the one that means the app is closed.
        expect(described).toContain(
          'If repair_sync answers that nothing is listening, that is this rather than a ' +
            'sync problem.',
        );
      });
    },
  );

  it.each([
    ['http://localhost:5006', 'a self-hosted server on its usual port'],
    ['https://budget.example.com:5007', 'that port on someone else'],
    ['https://budget.example.com', 'a server that is not on this machine'],
    // A host that merely contains one of the local names. Compared as a
    // substring, this is somebody else's machine wearing the clause.
    ['http://localhost.example.com:5007', 'a host that only looks local'],
    ['http://127.0.0.1.example.com:5007', 'the same trick with the address'],
    // Local, and not that port: without the port in the comparison every
    // local server would be called the desktop app.
    ['http://localhost', 'a local server on the default port'],
    ['http://127.0.0.1:5006', 'a local server on the self-hosted port'],
    // Local addresses the app does not listen on.
    ['http://0.0.0.0:5007', 'every interface rather than this machine'],
    ['http://127.0.0.2:5007', 'another address in the loopback range'],
    [undefined, 'nothing configured'],
    ['not a url at all', 'an address that cannot be read'],
  ])('leaves it out for %s', (url, _why) => {
    withServer(url, () => {
      expect(describeError(unknownOpen())).not.toContain('desktop app');
    });
  });

  it.each(['timeout', 'network-failure', 'ECONNREFUSED', 'ETIMEDOUT'])(
    'still says it when Actual named %s, which is about the connection',
    (code) => {
      withServer('http://127.0.0.1:5007', () => {
        const described = describeError(Object.assign(unknownOpen(), { code }));

        expect(described).toContain('the Actual desktop app is closed');
      });
    },
  );

  it('leaves it out of an ordinary error that says what it is', () => {
    // The clause belongs to the one failure that says nothing about its
    // cause. Appended to every message it would turn up under errors that
    // have nothing to do with the server.
    withServer('http://127.0.0.1:5007', () => {
      expect(describeError(new Error('Budget not found'))).not.toContain('desktop app');
      expect(describeError(new Error(''))).not.toContain('desktop app');
    });
  });

  it('leaves it out when Actual named a reason of its own', () => {
    // The clause belongs to the failure that says nothing. A wrong
    // encryption key on the desktop app is not the app being closed.
    withServer('http://127.0.0.1:5007', () => {
      const described = describeError(
        Object.assign(unknownOpen(), { code: 'decrypt-failure' }),
      );

      expect(described).toContain('decrypt');
      expect(described).not.toContain('desktop app');
    });
  });
});
