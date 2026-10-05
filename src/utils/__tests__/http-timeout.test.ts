import { describe, it, expect, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import {
  installHttpTimeout,
  resolveTimeoutMs,
  DEFAULT_HTTP_TIMEOUT_MS,
  MIN_HTTP_TIMEOUT_MS,
  MAX_HTTP_TIMEOUT_MS,
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

  it('changes nothing about the request but the signal', async () => {
    // The wrapper sits in front of every request the SDK makes, so what it
    // does *not* do matters as much as what it does. Adding a header nobody
    // asked for left the whole suite green, which is how this gap was found:
    // mutating by addition rather than by removal.
    const seen: Array<[unknown, RequestInit | undefined]> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      seen.push([input, init]);
      return new Response('ok');
    }) as typeof globalThis.fetch;
    const restoreSpy = () => {
      globalThis.fetch = original;
    };

    try {
      const uninstall = installHttpTimeout(5000);
      await fetch('http://example.test/path', {
        method: 'POST',
        body: 'payload',
        headers: { 'X-Mine': 'kept' },
      });
      uninstall();

      expect(seen).toHaveLength(1);
      const [url, init] = seen[0];
      expect(url).toBe('http://example.test/path');
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe('payload');
      expect(init?.headers).toEqual({ 'X-Mine': 'kept' });
      // Exactly one thing added, and it is the signal.
      expect(Object.keys(init ?? {}).sort()).toEqual(['body', 'headers', 'method', 'signal']);
    } finally {
      restoreSpy();
    }
  });

  it('lets a slow body finish, because the deadline is for the reply', async () => {
    // The deadline covers the wait for a reply, not the reply itself. With
    // `AbortSignal.timeout` it covered both, and a healthy 6 MB download that
    // streams for seconds was aborted mid-body: the SDK reports that as
    // "Downloading the file failed. Check your network connection", so a slow
    // link read as a broken one. A first budget download, a Docker start with
    // no volume and a second concurrent agent all download in full.
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      let sent = 0;
      const chunk = Buffer.alloc(100_000);
      const timer = setInterval(() => {
        if (sent >= 600_000) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(chunk);
        sent += chunk.length;
      }, 120);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as import('node:net').AddressInfo).port;
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    // Headers arrive at once; the body takes about 0.7 s, well past this.
    cleanups.push(installHttpTimeout(300));

    const response = await fetch(`http://127.0.0.1:${port}/download-user-file`);
    const body = await response.arrayBuffer();

    expect(body.byteLength).toBe(600_000);
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
  it('refuses a value a timer cannot hold', () => {
    // Measured against a server that answered instantly: 3000000000 overflows
    // `setTimeout`'s 32-bit delay, so Node warns and fires at once, and every
    // request aborts and is reported as the server being unreachable. Raising
    // the value is what the README invites for a slow bank sync.
    expect(resolveTimeoutMs('3000000000')).toBe(MAX_HTTP_TIMEOUT_MS);
    expect(resolveTimeoutMs('9999999999')).toBe(MAX_HTTP_TIMEOUT_MS);
  });

  it('treats Infinity as the request it is, and says so', () => {
    // It used to fall in with the unparseable values and become 60 seconds in
    // silence — the one value someone would write to turn the deadline off was
    // the one that said nothing back. It is a value above the maximum and is
    // handled like any other, warning included.
    const warnings: string[] = [];
    const original = console.error;
    console.error = (msg: unknown) => void warnings.push(String(msg));
    try {
      expect(resolveTimeoutMs('Infinity')).toBe(MAX_HTTP_TIMEOUT_MS);
    } finally {
      console.error = original;
    }
    expect(warnings.join(' ')).toContain('Infinity');
    // Still silent for a value that is simply not a number: there is nothing
    // to tell someone who never set it.
    const quiet: string[] = [];
    console.error = (msg: unknown) => void quiet.push(String(msg));
    try {
      resolveTimeoutMs(undefined);
      resolveTimeoutMs('soon');
    } finally {
      console.error = original;
    }
    expect(quiet).toEqual([]);
  });

  it('refuses a value too small to let anything through', () => {
    // `0.4` rounded to 0 and aborted every request in 2 ms.
    expect(resolveTimeoutMs('0.4')).toBe(MIN_HTTP_TIMEOUT_MS);
    expect(resolveTimeoutMs('1')).toBe(MIN_HTTP_TIMEOUT_MS);
    expect(resolveTimeoutMs('999')).toBe(MIN_HTTP_TIMEOUT_MS);
  });

  it('keeps a sensible value as it is', () => {
    expect(resolveTimeoutMs('5000')).toBe(5000);
    expect(resolveTimeoutMs('300000')).toBe(300000);
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

  it('survives what the extension can put in the variable', () => {
    // `manifest.json` maps this to `${user_config.http_timeout_ms}`, and the
    // field is optional, so what arrives when nobody fills it in is not
    // something this code decides. These are the forms that came out of the
    // packaged extension and the host around it, including the placeholder
    // arriving unsubstituted. Every one of them has to mean "use the default",
    // because the alternative is a server that refuses to start over a field
    // the person never touched.
    for (const raw of ['   ', '${user_config.http_timeout_ms}', 'null', 'undefined']) {
      expect(resolveTimeoutMs(raw), `for ${JSON.stringify(raw)}`).toBe(
        DEFAULT_HTTP_TIMEOUT_MS,
      );
    }
    // And a value the person did fill in is honoured, so the test above is not
    // passing because everything falls back.
    expect(resolveTimeoutMs('300000')).toBe(300_000);
  });
});

describe('the packaged extension can reach the deadline (#99)', () => {
  it('exposes the variable and keeps the documented default', async () => {
    // Without this the extension's user has no way to raise the limit, and
    // raising it is the only remedy when a bank is slower than the deadline:
    // GoCardless downloads transactions through a call that carries no timeout
    // of its own, so the global one governs it.
    const manifest = JSON.parse(
      await readFile(new URL('../../../manifest.json', import.meta.url), 'utf8'),
    ) as {
      server: { mcp_config: { env: Record<string, string> } };
      user_config: Record<string, { type: string; default?: unknown; required?: boolean }>;
    };

    expect(manifest.server.mcp_config.env.ACTUAL_HTTP_TIMEOUT_MS).toBe(
      '${user_config.http_timeout_ms}',
    );
    const field = manifest.user_config.http_timeout_ms;
    expect(field).toBeDefined();
    expect(field.type).toBe('number');
    // Not required: someone who never opens the field must still get a server.
    expect(field.required).toBe(false);
    // One default, not two that drift apart.
    expect(field.default).toBe(DEFAULT_HTTP_TIMEOUT_MS);
  });
});
