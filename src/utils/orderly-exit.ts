/**
 * Leave when the client does, and never take long about it (#219).
 *
 * A stdio server ends when its client goes away, and the way that arrives is
 * end-of-file on stdin. The SDK's `StdioServerTransport` listens for `data`
 * and `error` on it and nothing else, so nothing in this process noticed:
 * measured against a disposable server, closing stdin left the server running
 * and it had to be killed after fifteen seconds. That is where the servers in
 * #207 come from, each one still holding its data directory.
 *
 * From Actual 26.11 it costs more than a process. Every sign-in makes its own
 * session row with `expires_at = -1`, which nothing ever clears, and
 * `api.shutdown()` is what signs it out. Measured on the nightly: with a
 * signal, the row goes; with stdin closed, it stays for good.
 *
 * The time limit is the other half. Shutting down talks to the server, the
 * HTTP deadline is sixty seconds by default, and an exit that waits that long
 * for a server that is not answering is an exit nobody waits for: the client
 * has already gone, and what is left to lose is one session row.
 *
 * ## Why there are two waits and not one
 *
 * Closing the budget beside a tool that is using it is worse than leaving a
 * session open. Measured against a disposable server: a batch of three
 * thousand rows with a signal sent 300ms in answered `Error: No budget file
 * is open` and wrote all three thousand anyway. A tool that writes in
 * several steps could be cut between two of them.
 *
 * So leaving waits for what is in flight first, and only then shuts down.
 * The first wait is generous, because the work it is waiting for is real:
 * three thousand rows took up to seventeen seconds. If it runs out, this
 * leaves **without** closing, because cutting a write in half is the thing
 * it is avoiding. The second is the short one above.
 *
 * Neither wait can be relied on to the millisecond: the engine's database
 * calls are synchronous, so a timer cannot fire while one is running. That
 * is the same reason the first wait exists. What these limits bound is a
 * server that is stuck, not one that is busy.
 */
export interface ExitPaths {
  /** What to do before going: the orderly shutdown. */
  stop: () => Promise<void>;
  /** Resolves when no tool call is still running. */
  whenIdle?: () => Promise<void>;
  /** Stop taking new calls, so nothing new reaches a budget being closed. */
  stopAccepting?: () => void;
  /** How to leave, so a test can watch rather than die. */
  exit: (code: number) => void;
  /**
   * Where end-of-file arrives, when end-of-file is how the client leaves.
   *
   * A stdio server passes `process.stdin`. An HTTP server passes nothing
   * (#228): its clients come and go over the network, and a container
   * started detached has no stdin to speak of, so watching for its end would
   * shut the server down a moment after it came up.
   */
  stdin?: {
    on: (event: string, listener: () => void) => unknown;
  };
  /** Where a signal arrives. */
  signals: {
    on: (event: string, listener: () => void) => unknown;
  };
  /** How long the orderly shutdown gets before we leave anyway. */
  timeoutMs?: number;
  /** How long a tool call in flight gets to finish before we leave it alone. */
  inFlightMs?: number;
}

export const EXIT_GRACE_MS = 5_000;
/**
 * Long, because reaching it is not a graceful fallback.
 *
 * Giving up on a call in flight means leaving while it runs, and leaving
 * kills the process: the write is cut after all, which is the thing this
 * wait exists to prevent. So the limit is not a budget for ordinary work,
 * it is the point at which something is stuck and never leaving is worse
 * than leaving badly.
 *
 * What ordinary work costs, measured: a batch of three thousand rows took
 * fifty seconds on one machine and seventeen on another, and every network
 * call inside it is already bounded by the HTTP deadline, sixty seconds by
 * default. Five minutes is past all of that.
 */
export const EXIT_IN_FLIGHT_MS = 300_000;

export function installExitPaths(paths: ExitPaths): void {
  const limit = paths.timeoutMs ?? EXIT_GRACE_MS;
  let leaving = false;

  const leave = (): void => {
    // Once. Two of these arrive together often enough: a client that closes
    // stdin and then sends a signal, and `end` followed by `close` on the
    // same stream.
    if (leaving) return;
    leaving = true;

    // First of all, before any waiting: nothing new is taken from here on.
    // A request that had not been dispatched yet is refused rather than run
    // against a budget that is being closed, which is what the counter
    // could not see. It is also what keeps the exit short enough to matter:
    // Claude Code sends SIGINT, SIGTERM 100ms later and SIGKILL 400ms after
    // that, so everything here has about half a second.
    paths.stopAccepting?.();

    const timers: Array<ReturnType<typeof setTimeout>> = [];
    /** `work`, or `'gave up'` when it takes longer than `ms`. */
    const atMost = async (work: Promise<unknown>, ms: number): Promise<'done' | 'gave up'> => {
      let mark: (value: 'gave up') => void = () => {};
      const ran = new Promise<'gave up'>((resolve) => {
        mark = resolve;
      });
      const timer = setTimeout(() => mark('gave up'), ms);
      // Not a reason for the process to stay alive on its own.
      (timer as { unref?: () => void }).unref?.();
      timers.push(timer);
      return Promise.race([work.then(() => 'done' as const), ran]);
    };

    void (async () => {
      // What is in flight first. Closing the budget underneath a tool that
      // is using it answers "no budget file is open" to a call that then
      // writes everything anyway.
      const idle = paths.whenIdle?.() ?? Promise.resolve();
      const settled = await atMost(idle, paths.inFlightMs ?? EXIT_IN_FLIGHT_MS);

      // Still working after all that: something is stuck, and a server that
      // never leaves is where this issue started. Leaving without closing
      // costs one session row.
      if (settled === 'done') {
        // A shutdown that throws is still a shutdown: the client is gone and
        // there is nobody to tell.
        await atMost(paths.stop().catch(() => undefined), limit);
      }

      for (const timer of timers) clearTimeout(timer);
      paths.exit(0);
    })();
  };

  // `end` is end-of-file, `close` is the stream being torn down. A client
  // that disappears gives one or the other depending on how it went.
  paths.stdin?.on('end', leave);
  paths.stdin?.on('close', leave);
  paths.signals.on('SIGINT', leave);
  paths.signals.on('SIGTERM', leave);
}
