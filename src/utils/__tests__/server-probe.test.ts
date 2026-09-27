import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { probeServer, probeTarget } from '../server-probe.js';

/** A listening server on a free port, and the port a closed one just freed. */
async function listening(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const servers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of servers.splice(0)) await close();
});

describe('probeServer', () => {
  it('says yes when something is listening', async () => {
    const server = await listening();
    servers.push(server.close);

    expect(await probeServer(`http://127.0.0.1:${server.port}`)).toBe('answering');
  });

  it('says yes to a server that accepts and then says nothing', async () => {
    // Deliberate: "is anyone there" is a connection question. A server that
    // accepts and stays quiet is still there, and whether its answer is any
    // good is the repair's problem to report, not this one's to guess.
    const server = net.createServer(() => {
      /* accept, and never write */
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    servers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    expect(await probeServer(`http://127.0.0.1:${port}`)).toBe('answering');
  });

  it('says no when the port is closed', async () => {
    const server = await listening();
    const port = server.port;
    await server.close();

    expect(await probeServer(`http://127.0.0.1:${port}`)).toBe('not-answering');
  });

  it('gives up rather than waiting on an address that never answers', async () => {
    // 192.0.2.0/24 is reserved for documentation (RFC 5737) and is not routed,
    // so a connection to it hangs rather than being refused. On a network that
    // refuses it instead, the answer is the same and only arrives sooner: what
    // this pins is that there is a deadline at all, since a probe that waits as
    // long as a hung server does separates nothing (#99).
    const started = Date.now();

    const answered = await probeServer('http://192.0.2.1:5007', 150);

    expect(answered).toBe('not-answering');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('does not call a malformed address unreachable, and does not call it fine either', async () => {
    // A configuration problem is not a connectivity problem, so it must not
    // get the "open the desktop app" advice. It also must not pass for
    // reachable: this returned `true` for both meanings, and a repair then ran
    // against an address nothing could connect to.
    expect(await probeServer('not a url')).toBe('unusable-url');
    expect(await probeServer('')).toBe('unusable-url');
  });

  it('treats a port outside the valid range as unusable, not as fine', async () => {
    // `new URL` rejects the whole address when the port is out of range, which
    // is one mistyped digit away from a working config. The probe used to say
    // "reachable" here, which switched the protection off entirely.
    expect(await probeServer('http://127.0.0.1:99999')).toBe('unusable-url');
    expect(probeTarget('http://127.0.0.1:99999')).toBeNull();
  });

});

describe('probeTarget', () => {
  it('uses the protocol default when the URL carries no port', () => {
    // `new URL('http://x').port` is the empty string and `Number('')` is 0, so
    // without the fallback every URL written without a port would be probed on
    // port 0 and reported missing. A first version of this test asserted the
    // probe returned a boolean, which it always does.
    expect(probeTarget('http://actual.example')).toEqual({ host: 'actual.example', port: 80 });
    expect(probeTarget('https://actual.example')).toEqual({ host: 'actual.example', port: 443 });
  });

  it('keeps an explicit port over the default', () => {
    expect(probeTarget('http://localhost:5007')).toEqual({ host: 'localhost', port: 5007 });
    expect(probeTarget('https://actual.example:5006')).toEqual({
      host: 'actual.example',
      port: 5006,
    });
  });

  it('returns nothing for something that is not a URL', () => {
    expect(probeTarget('not a url')).toBeNull();
    expect(probeTarget('')).toBeNull();
  });
});
