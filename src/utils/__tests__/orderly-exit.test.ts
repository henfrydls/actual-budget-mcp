import { describe, it, expect, vi } from 'vitest';
import { installExitPaths, EXIT_GRACE_MS, EXIT_IN_FLIGHT_MS } from '../orderly-exit.js';

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
      await vi.advanceTimersByTimeAsync(80);

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
 * A tool that is still running when the client goes away (#219, round two).
 *
 * Measured against a disposable server: a batch of three thousand rows with
 * a signal sent 300ms in answered `Error: No budget file is open` and wrote
 * all three thousand anyway, because the shutdown ran beside the handler
 * rather than after it. A tool that writes in several steps could be cut
 * between two of them.
 */
describe('leaving while a tool is still running', () => {
  it('does not shut down until the call has finished', async () => {
    vi.useFakeTimers();
    try {
      const w = wiring();
      const stop = vi.fn().mockResolvedValue(undefined);
      let finishCall: (() => void) | undefined;
      installExitPaths({
        stop,
        whenIdle: () => new Promise<void>((resolve) => { finishCall = resolve; }),
        exit: w.exit,
        stdin: w.stdin,
        signals: w.signals,
      });

      w.signalListeners.get('SIGTERM')!();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(stop, 'the budget is still being written to').not.toHaveBeenCalled();
      expect(w.exits).toEqual([]);

      finishCall!();
      await vi.advanceTimersByTimeAsync(40);

      expect(stop).toHaveBeenCalledOnce();
      expect(w.exits).toEqual([0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves without closing when the call never finishes', async () => {
    // A session left open costs one row. A write cut in half costs the thing
    // this server is for.
    vi.useFakeTimers();
    try {
      const w = wiring();
      const stop = vi.fn().mockResolvedValue(undefined);
      installExitPaths({
        stop,
        whenIdle: () => new Promise<void>(() => {}),
        exit: w.exit,
        stdin: w.stdin,
        signals: w.signals,
        inFlightMs: 100,
      });

      w.stdinListeners.get('end')!();
      await vi.advanceTimersByTimeAsync(150);

      expect(stop, 'never beside a call that is still running').not.toHaveBeenCalled();
      expect(w.exits).toEqual([0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shuts down at once when nothing is running', async () => {
    const w = wiring();
    const stop = vi.fn().mockResolvedValue(undefined);
    installExitPaths({
      stop,
      whenIdle: () => Promise.resolve(),
      exit: w.exit,
      stdin: w.stdin,
      signals: w.signals,
    });

    w.signalListeners.get('SIGINT')!();
    await vi.waitFor(() => expect(w.exits).toEqual([0]));

    expect(stop).toHaveBeenCalledOnce();
  });

  it('stops taking calls before it waits for anything', async () => {
    // Measured: Claude Code sends SIGINT, SIGTERM 100ms later and SIGKILL
    // 400ms after that. Everything here has about half a second, and a
    // request that arrives inside it must not reach a budget being closed.
    const w = wiring();
    const order: string[] = [];
    installExitPaths({
      stop: async () => void order.push('stop'),
      whenIdle: async () => void order.push('waited'),
      stopAccepting: () => order.push('stopped accepting'),
      exit: w.exit,
      stdin: w.stdin,
      signals: w.signals,
    });

    w.signalListeners.get('SIGTERM')!();
    await vi.waitFor(() => expect(w.exits).toEqual([0]));

    expect(order).toEqual(['stopped accepting', 'waited', 'stop']);
  });

  it('waits far longer for a call than for the shutdown', () => {
    // Reaching this limit means leaving while the call runs, which kills it:
    // it is a "something is stuck" threshold, not a budget for real work.
    // Measured, three thousand rows took fifty seconds on one machine.
    expect(EXIT_IN_FLIGHT_MS).toBeGreaterThan(EXIT_GRACE_MS);
    expect(EXIT_IN_FLIGHT_MS).toBeGreaterThanOrEqual(120_000);
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
    // And that the wait covers the first download, not only the tool calls:
    // the session it is there to close was opened by `api.init` at the start
    // of that download. Dropping `connectionSettled` from the composition
    // left the suite green.
    expect(source).toMatch(/whenIdle:[\s\S]{0,160}connectionSettled\(\)/);
    expect(source, 'and nothing new is taken once leaving has begun').toContain(
      'stopAccepting: startLeaving',
    );
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
