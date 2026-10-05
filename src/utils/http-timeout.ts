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
 * timeout argument and every caller leaves it at `null`.
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

export function resolveTimeoutMs(raw: string | undefined): number {
  const parsed = Number(raw);
  // A nonsense value is not a reason to leave requests with no deadline at
  // all, which is the state this exists to fix.
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_HTTP_TIMEOUT_MS;
  return Math.round(parsed);
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

  globalThis.fetch = ((input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    // Respect a caller that already decided. `AbortSignal.any` would let both
    // apply, but adding a deadline to a request that was given one on purpose
    // is overruling a decision rather than filling a gap.
    if (init?.signal) return original(input, init);
    return original(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
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
