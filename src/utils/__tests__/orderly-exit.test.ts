import { describe, it, expect, vi } from 'vitest';
import { installExitPaths, EXIT_GRACE_MS } from '../orderly-exit.js';

/** A stand-in for `process.stdin` and `process`, so nothing here really exits. */
function wiring() {
  const stdinListeners = new Map<string, () => void>();
  const signalListeners = new Map<string, () => void>();
  const exits: number[] = [];
  return {
    stdinListeners,
    signalListeners,
    exits,
    stdin: { on: (e: string, l: () => void) => stdinListeners.set(e, l) },
    signals: { on: (e: string, l: () => void) => signalListeners.set(e, l) },
    exit: (code: number) => void exits.push(code),
  };
}

/**
 * Leaving when the client does (#219).
 *
 * The SDK's stdio transport listens for `data` and `error` on stdin and
 * nothing else, so end-of-file, which is how a client says it has gone,
 * reached nobody. Measured against a disposable server: closing stdin left
 * the process running until it was killed, with its data directory held
 * (#207) and, from Actual 26.11, a session on the server that nothing ever
 * clears.
 */
describe('leaving when the client goes away', () => {
  it.each(['end', 'close'])('shuts down and leaves on stdin %s', async (event) => {
    const w = wiring();
    const stop = vi.fn().mockResolvedValue(undefined);
    installExitPaths({ stop, exit: w.exit, stdin: w.stdin, signals: w.signals });

    w.stdinListeners.get(event)!();
    await vi.waitFor(() => expect(w.exits).toEqual([0]));

    expect(stop).toHaveBeenCalledOnce();
  });

  it.each(['SIGINT', 'SIGTERM'])('shuts down and leaves on %s', async (signal) => {
    const w = wiring();
    const stop = vi.fn().mockResolvedValue(undefined);
    installExitPaths({ stop, exit: w.exit, stdin: w.stdin, signals: w.signals });

    w.signalListeners.get(signal)!();
    await vi.waitFor(() => expect(w.exits).toEqual([0]));

    expect(stop).toHaveBeenCalledOnce();
  });

  it('leaves once, however many ways it is told to', async () => {
    // A client that closes stdin and then sends a signal is ordinary, and so
    // is `end` followed by `close` on the same stream.
    const w = wiring();
    const stop = vi.fn().mockResolvedValue(undefined);
    installExitPaths({ stop, exit: w.exit, stdin: w.stdin, signals: w.signals });

    w.stdinListeners.get('end')!();
    w.stdinListeners.get('close')!();
    w.signalListeners.get('SIGTERM')!();
    await vi.waitFor(() => expect(w.exits).toEqual([0]));

    expect(stop).toHaveBeenCalledOnce();
  });

  it('leaves anyway when the shutdown will not finish', async () => {
    // Shutting down talks to the server and the HTTP deadline is a minute.
    // The client has already gone; what is left to lose is one session row.
    vi.useFakeTimers();
    try {
      const w = wiring();
      installExitPaths({
        stop: () => new Promise<void>(() => {}),
        exit: w.exit,
        stdin: w.stdin,
        signals: w.signals,
        timeoutMs: 50,
      });

      w.signalListeners.get('SIGTERM')!();
      expect(w.exits, 'not before the grace period').toEqual([]);
      await vi.advanceTimersByTimeAsync(60);

      expect(w.exits).toEqual([0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves when the shutdown throws, because nobody is left to tell', async () => {
    const w = wiring();
    installExitPaths({
      stop: () => Promise.reject(new Error('the server is gone')),
      exit: w.exit,
      stdin: w.stdin,
      signals: w.signals,
    });

    w.stdinListeners.get('end')!();
    await vi.waitFor(() => expect(w.exits).toEqual([0]));
  });

  it('waits for a shutdown that finishes inside the grace period', async () => {
    vi.useFakeTimers();
    try {
      const w = wiring();
      let finish: (() => void) | undefined;
      installExitPaths({
        stop: () => new Promise<void>((resolve) => { finish = resolve; }),
        exit: w.exit,
        stdin: w.stdin,
        signals: w.signals,
        timeoutMs: 10_000,
      });

      w.signalListeners.get('SIGINT')!();
      await vi.advanceTimersByTimeAsync(100);
      expect(w.exits, 'still shutting down').toEqual([]);

      finish!();
      await vi.advanceTimersByTimeAsync(1);
      expect(w.exits).toEqual([0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives the shutdown seconds and not minutes', () => {
    expect(EXIT_GRACE_MS).toBeLessThanOrEqual(10_000);
    expect(EXIT_GRACE_MS).toBeGreaterThan(0);
  });
});

/**
 * That the server actually installs them, and before it opens the budget.
 *
 * A listener registered after the event never hears it: measured, ending
 * stdin while the budget was still downloading left the process running
 * until it was killed, because the wiring came after `ensureConnection`.
 */
describe('the wiring', () => {
  it('installs the exit paths before the budget is opened', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/index.ts', 'utf8');

    expect(source).toContain('installExitPaths({');
    // The last one is the startup call; the first belongs to the
    // `test:connection` command, which exits on its own.
    expect(
      source.indexOf('installExitPaths({'),
      'a client that leaves during the first download is the case this is for',
    ).toBeLessThan(source.lastIndexOf('await ensureConnection()'));
    expect(
      source.indexOf('installExitPaths({'),
      'and before the transport, since that is when a client can first leave',
    ).toBeLessThan(source.indexOf('new StdioServerTransport()'));
  });
});
