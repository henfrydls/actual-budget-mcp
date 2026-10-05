import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import {
  installHttpTimeout,
  resolveTimeoutMs,
  DEFAULT_HTTP_TIMEOUT_MS,
} from '../http-timeout.js';

/** A server that accepts the connection and then says nothing: the #99 shape. */
async function hungServer() {
  // The sockets are kept so they can be destroyed on the way out. `close()`
  // waits for open connections to finish, and these never do by design, so
  // without this the teardown hangs instead of the request.
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    /* accept, never reply */
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/sync/sync`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

describe('a hung server does not hold a request for five minutes (#99)', () => {
  it('rejects at the deadline instead of waiting', async () => {
    const server = await hungServer();
    cleanups.push(server.close);
    cleanups.push(installHttpTimeout(200));

    const started = Date.now();
    await expect(fetch(server.url, { method: 'POST' })).rejects.toThrow();
    const elapsed = Date.now() - started;

    // The point is that it ended, and ended near the deadline rather than at
    // Node's own header timeout, which is five minutes: measured at 312
    // seconds before this.
    expect(elapsed).toBeLessThan(5000);
  }, 20_000);

  it('hangs without it, which is what this is for', async () => {
    // The same request with the wrapper uninstalled. Rather than wait out the
    // five minutes, this asserts it is still pending after a second — the
    // behaviour the test above would otherwise be measuring nothing against.
    const server = await hungServer();
    cleanups.push(server.close);

    const uninstall = installHttpTimeout(200);
    uninstall();

    const request = fetch(server.url, { method: 'POST' }).then(
      () => 'settled',
      () => 'settled',
    );
    const outcome = await Promise.race([
      request,
      new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 1000)),
    ]);

    expect(outcome).toBe('still pending');
  }, 20_000);

  it('leaves a request that brought its own signal alone', async () => {
    // Adding a deadline to a request that was given one on purpose overrules a
    // decision rather than filling a gap.
    const server = await hungServer();
    cleanups.push(server.close);
    cleanups.push(installHttpTimeout(10_000));

    const started = Date.now();
    await expect(
      fetch(server.url, { method: 'POST', signal: AbortSignal.timeout(150) }),
    ).rejects.toThrow();

    // It ended on the caller's 150 ms, not on the wrapper's 10 s.
    expect(Date.now() - started).toBeLessThan(5000);
  }, 20_000);

  it('puts the original fetch back', async () => {
    const before = globalThis.fetch;
    const uninstall = installHttpTimeout(500);
    expect(globalThis.fetch).not.toBe(before);
    uninstall();
    expect(globalThis.fetch).toBe(before);
  });
});

describe('resolveTimeoutMs', () => {
  it('takes a number from the environment', () => {
    expect(resolveTimeoutMs('5000')).toBe(5000);
  });

  it('falls back rather than leaving requests with no deadline', () => {
    // A nonsense value is not a reason to restore the five-minute hang, which
    // is the state this exists to fix.
    for (const raw of [undefined, '', 'soon', '0', '-1', 'NaN']) {
      expect(resolveTimeoutMs(raw), `for ${JSON.stringify(raw)}`).toBe(
        DEFAULT_HTTP_TIMEOUT_MS,
      );
    }
  });
});
