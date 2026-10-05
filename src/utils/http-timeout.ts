/**
 * Give every request the SDK makes a deadline, because it gives them none.
 *
 * A sync against a server that accepts the connection and then never answers
 * does not fail promptly: `@actual-app/api` passes no timeout and no abort
 * signal, so the request falls back to Node's own header timeout, which is five
 * minutes. Measured at 312 seconds, rejecting with `UND_ERR_HEADERS_TIMEOUT`
 * (#99). And `fullSync` is wrapped in `once()`, so every write in the process
 * queues behind the same hang rather than failing on its own.
 *
 * ## Why not `Promise.race` around `api.sync()`
 *
 * It returns control, and that is all it does. The losing promise stays pending
 * inside `once()`, so the next write joins a sync that never settles: worse
 * than the hang it replaces.
 *
 * ## Why this has to be imported first
 *
 * The bundle captures `var fetch$1 = globalThis.fetch` when it loads, so a
 * wrapper installed afterwards is never seen. Measured both ways: with the
 * wrapper installed before importing the SDK, a request to a hung server came
 * through it and carried the URL; the SDK's own `post()` already accepts a
 * timeout argument, and almost every caller leaves it at `null`. Not quite
 * every one: the SimpleFIN, Pluggy and Akahu `/accounts` calls pass 60
 * seconds, which is also the only reason this file's own default is that
 * number rather than one somebody liked. Those three bring their own signal
 * and are left alone here; what has no limit of its own is everything else,
 * including the GoCardless transaction download.
 *
 * ## What it does not do
 *
 * It is a global patch, so it applies to the bank sync too, which can
 * legitimately take a while. That is the reason for the environment variable
 * rather than a fixed number, and for a default generous enough that only a
 * genuinely stuck request reaches it. A request that brings its own signal is
 * left alone: the caller has already decided.
 */

/** Long enough that only a stuck request reaches it, short of Node's five minutes. */
export const DEFAULT_HTTP_TIMEOUT_MS = 60_000;

/** Below this, every request fails; the value is a mistake rather than a choice. */
export const MIN_HTTP_TIMEOUT_MS = 1_000;
/** `setTimeout` takes a 32-bit signed delay; past it, Node fires immediately. */
export const MAX_HTTP_TIMEOUT_MS = 2_147_483_647;

export function resolveTimeoutMs(raw: string | undefined): number {
  const parsed = Number(raw);
  // A nonsense value is not a reason to leave requests with no deadline at
  // all, which is the state this exists to fix.
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_HTTP_TIMEOUT_MS;

  // `Infinity` is not nonsense, it is a request: no limit. It used to fall
  // into the line above and quietly become 60 seconds, so the one value
  // someone would write to turn this off was the one that said nothing. It is
  // simply a value above the maximum, and it is treated like any other, with
  // the same warning: there is no way to turn the deadline off, and the
  // largest a timer can hold is 24 days, which is the same thing in practice.
  const rounded = parsed === Infinity ? Infinity : Math.round(parsed);

  // Both ends produce the same failure, and it is the worst one: every request
  // aborts at once and the server is reported as unreachable, so a healthy
  // setup reads as a network problem.
  //
  // Measured against a server that answered instantly: `0.4` rounds to 0 and
  // aborted in 2 ms; `3000000000` overflowed `setTimeout`'s 32-bit delay,
  // printed `TimeoutOverflowWarning` and aborted in 6 ms. Raising the value is
  // exactly what the README invites someone to do for a slow bank sync.
  if (rounded < MIN_HTTP_TIMEOUT_MS) {
    console.error(
      `[actual-budget-mcp] ACTUAL_HTTP_TIMEOUT_MS=${raw} is below ${MIN_HTTP_TIMEOUT_MS}ms. A server that takes longer than that to start replying would be reported as unreachable, which over anything but a local network is most of them. Using ${MIN_HTTP_TIMEOUT_MS}ms.`,
    );
    return MIN_HTTP_TIMEOUT_MS;
  }
  if (rounded > MAX_HTTP_TIMEOUT_MS) {
    console.error(
      `[actual-budget-mcp] ACTUAL_HTTP_TIMEOUT_MS=${raw} is larger than a timer can hold, and a timer given one fires at once, so every request would abort immediately. Using ${MAX_HTTP_TIMEOUT_MS}ms, which is 24 days.`,
    );
    return MAX_HTTP_TIMEOUT_MS;
  }
  return rounded;
}

type FetchFn = typeof globalThis.fetch;

let installed: { original: FetchFn } | undefined;

/**
 * Wrap `globalThis.fetch` so a request with no signal of its own gets one.
 *
 * Returns a function that puts the original back, which is what tests use and
 * what makes the wrapper possible to reason about: nothing here is permanent.
 */
export function installHttpTimeout(timeoutMs: number): () => void {
  if (installed) {
    globalThis.fetch = installed.original;
    installed = undefined;
  }

  const original = globalThis.fetch;
  installed = { original };

  globalThis.fetch = (async (
    input: Parameters<FetchFn>[0],
    init?: Parameters<FetchFn>[1],
  ) => {
    // Respect a caller that already decided. Adding a deadline to a request
    // that was given one on purpose is overruling a decision rather than
    // filling a gap.
    if (init?.signal) return original(input, init);

    // The deadline covers the wait for a reply, not the reply itself.
    //
    // `AbortSignal.timeout` would cover both, and that breaks healthy work:
    // measured, a 6 MB download that streams for 6.5 s was aborted at 3 s with
    // `TimeoutError`, which the SDK reports as
    // `Downloading the file failed. Check your network connection.` A first
    // budget download, a Docker start with no volume, and a second concurrent
    // agent sent to an empty data directory all download in full, so a slow
    // link would have turned a working setup into a network error that blames
    // the network.
    //
    // `fetch` resolves when the headers arrive, so clearing the timer there
    // leaves the body to stream at its own pace. Node still cuts an idle body
    // off on its own.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await original(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }) as FetchFn;

  return () => {
    if (installed?.original === original) {
      globalThis.fetch = original;
      installed = undefined;
    }
  };
}

// Installed on import, and this module is imported before `@actual-app/api`
// anywhere it matters. The bundle reads `globalThis.fetch` once, at load.
installHttpTimeout(resolveTimeoutMs(process.env.ACTUAL_HTTP_TIMEOUT_MS));
