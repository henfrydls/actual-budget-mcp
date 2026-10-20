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
 */
export interface ExitPaths {
  /** What to do before going: the orderly shutdown. */
  stop: () => Promise<void>;
  /** How to leave, so a test can watch rather than die. */
  exit: (code: number) => void;
  /** Where end-of-file arrives. */
  stdin: {
    on: (event: string, listener: () => void) => unknown;
  };
  /** Where a signal arrives. */
  signals: {
    on: (event: string, listener: () => void) => unknown;
  };
  /** How long the orderly shutdown gets before we leave anyway. */
  timeoutMs?: number;
}

export const EXIT_GRACE_MS = 5_000;

export function installExitPaths(paths: ExitPaths): void {
  const limit = paths.timeoutMs ?? EXIT_GRACE_MS;
  let leaving = false;

  const leave = (): void => {
    // Once. Two of these arrive together often enough: a client that closes
    // stdin and then sends a signal, and `end` followed by `close` on the
    // same stream.
    if (leaving) return;
    leaving = true;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, limit);
      // Not a reason for the process to stay alive on its own.
      (timer as { unref?: () => void }).unref?.();
    });

    void Promise.race([
      // A shutdown that throws is still a shutdown: the client is gone and
      // there is nobody to tell.
      paths.stop().catch(() => undefined),
      grace,
    ]).then(() => {
      if (timer) clearTimeout(timer);
      paths.exit(0);
    });
  };

  // `end` is end-of-file, `close` is the stream being torn down. A client
  // that disappears gives one or the other depending on how it went.
  paths.stdin.on('end', leave);
  paths.stdin.on('close', leave);
  paths.signals.on('SIGINT', leave);
  paths.signals.on('SIGTERM', leave);
}
