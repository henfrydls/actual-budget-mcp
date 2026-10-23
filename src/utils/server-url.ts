import { withoutCredentials } from './redact.js';

/**
 * The one way of writing `ACTUAL_SERVER_URL` that cannot work (#275).
 *
 * Node's `fetch` refuses a URL that carries credentials, before any request
 * is made: measured, `fetch('http://user:pass@127.0.0.1:1/')` throws
 * "Request cannot be constructed from a URL that includes credentials", and
 * the message it throws quotes the URL in full, password and all. The engine
 * catches that and reports a network failure, so a server configured this
 * way answers "nothing is listening on that address" to everything, which is
 * false, and spends the whole time with the password in its logs.
 *
 * A reader of an earlier version of this will have seen it defended as a way
 * to put basic auth in front of Actual. It is not: it is a configuration
 * that never connects.
 *
 * So the server refuses to start, rather than running and failing every
 * call. The message shows the address with the credentials already taken
 * out, because a startup error is the first thing anyone copies into an
 * issue.
 */
export function serverUrlProblem(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    // Not this check's business. An address that does not parse fails later
    // with its own message, and guessing at what was meant here would
    // produce two errors for one mistake.
    return undefined;
  }

  if (url.username === '' && url.password === '') return undefined;

  return (
    'ACTUAL_SERVER_URL carries a username or a password, and that cannot work: ' +
    'the HTTP client refuses a URL with credentials in it before it sends ' +
    `anything. Configure it as ${withoutCredentials(raw.trim())} and put the ` +
    'password in ACTUAL_PASSWORD, or in whatever sits in front of Actual.'
  );
}
