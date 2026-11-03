/**
 * The engine's console, kept off stdout.
 *
 * `@actual-app/api` prints as it works: `[Breadcrumb]`, `Syncing since ...`,
 * `Got messages from server N`. It prints them with `console.log`, and on
 * stdio stdout is the protocol, so one of those lines in the middle of a
 * JSON-RPC frame is a client that stops understanding this server. The
 * engine has no setting for it, so the console is what gets moved.
 *
 * `console.error` is left alone: stderr is where all of this is going, and
 * wrapping it would only add a frame to every line.
 *
 * A worker keeps this (#229). It is this same entry point, run as a child
 * with its stdout spoken for by the protocol, and the front end reads its
 * stderr, prefixes each line with the budget it came from and takes any
 * credentials out of it on the way (#275).
 *
 * The restore is for `--verify`, which is a person at a terminal rather than
 * a client: there, what it prints is the output, and it belongs on stdout.
 */
export function sendConsoleToStderr(): () => void {
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
  };

  // Through `console.error` rather than `process.stderr.write`, so that
  // formatting, inspection of objects and anything a host has installed on
  // the console are the engine's own and not reimplemented here.
  console.log = (...args: unknown[]) => console.error(...args);
  console.info = (...args: unknown[]) => console.error(...args);
  console.warn = (...args: unknown[]) => console.error(...args);

  return () => {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
  };
}
