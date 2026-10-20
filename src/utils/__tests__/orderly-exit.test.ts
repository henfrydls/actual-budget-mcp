import { describe, it, expect, vi } from 'vitest';
import {
  installExitPaths,
  EXIT_GRACE_MS,
  EXIT_IN_FLIGHT_MS,
  EXIT_QUIET_MS,
} from '../orderly-exit.js';

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
        quietMs: 10,
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
        quietMs: 10,
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
        quietMs: 10,
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
        quietMs: 10,
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

  it('looks again before deciding nothing is running', async () => {
    // Counting starts when a handler starts. A request that arrived a moment
    // before the signal has not been dispatched yet, so the count says zero:
    // measured, a batch sent 300ms before a SIGTERM was still in the pipe,
    // the budget was closed, and the call that then started answered
    // `Error: No budget file is open`.
    vi.useFakeTimers();
    try {
      const w = wiring();
      const stop = vi.fn().mockResolvedValue(undefined);
      let running = false;
      let finish: (() => void) | undefined;
      installExitPaths({
        stop,
        whenIdle: () =>
          running ? new Promise<void>((resolve) => { finish = () => { running = false; resolve(); }; })
                  : Promise.resolve(),
        busy: () => running,
        exit: w.exit,
        stdin: w.stdin,
        signals: w.signals,
        quietMs: 50,
      });

      w.signalListeners.get('SIGTERM')!();
      // The request reaches its handler just after the signal.
      running = true;
      await vi.advanceTimersByTimeAsync(60);

      expect(stop, 'it was dispatched while we were looking away').not.toHaveBeenCalled();
      expect(w.exits).toEqual([]);

      finish!();
      await vi.advanceTimersByTimeAsync(60);

      expect(stop).toHaveBeenCalledOnce();
      expect(w.exits).toEqual([0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('that second look is a beat, not a wait', () => {
    // It is paid on every exit, including the ordinary one where nothing is
    // happening: measured, an idle server leaves in about 300ms with it.
    expect(EXIT_QUIET_MS).toBeLessThanOrEqual(500);
    expect(EXIT_QUIET_MS).toBeGreaterThan(0);
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
