/**
 * The ways of writing `ACTUAL_SERVER_URL` that cannot work (#275).
 *
 * Node's `fetch` refuses a URL that carries credentials, before any request
 * is made: measured, `fetch('http://user:pass@127.0.0.1:1/')` throws
 * "Request cannot be constructed from a URL that includes credentials", and
 * the message it throws quotes the URL in full, password and all. The engine
 * catches that and reports a network failure, so a server configured this
 * way answers "nothing is listening on that address" to everything, which is
 * false, and spends the whole time with the password in its logs.
 *
 * An address that does not parse cannot work either, and leaving it to fail
 * later was worse than it sounds: the engine logs "Unable to parse server
 * URL" with the whole input attached, twenty-one times, and a password
 * containing `/`, `#` or `?` is a password that does not parse. Measured,
 * each of those throws in `new URL`, as does a port outside 1-65535.
 *
 * A reader of an earlier version of this will have seen credentials in the
 * URL defended as a way to put basic auth in front of Actual. It is not: it
 * is a configuration that never connects.
 *
 * So the server refuses to start, rather than running and failing every
 * call.
 */

/**
 * The address with nothing private left in it, built from the parsed URL.
 *
 * Not from the text that was given, and not with a pattern: a password with
 * a space in it ends the match, and the refusal then printed the password it
 * was refusing. The parser has already told us where the credentials end.
 */
function plainAddress(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

export function serverUrlProblem(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    // Nothing of the address is repeated here, not even redacted. This is
    // the branch a password with a `/` or a `#` in it lands in, and the
    // only thing that can be said about a string that does not parse is
    // that it does not parse.
    return (
      'ACTUAL_SERVER_URL is not a URL this can read, so nothing can be reached with ' +
      'it. Write it as scheme, host and port, for example http://127.0.0.1:5006. ' +
      'If it has a username or a password in it, those are not accepted either: the ' +
      'HTTP client refuses a URL with credentials before it sends anything, so put ' +
      'the password in ACTUAL_PASSWORD instead.'
    );
  }

  if (url.username === '' && url.password === '') return undefined;

  return (
    'ACTUAL_SERVER_URL carries a username or a password, and that cannot work: ' +
    'the HTTP client refuses a URL with credentials in it before it sends ' +
    `anything. Configure it as ${plainAddress(url)} and put the password in ` +
    'ACTUAL_PASSWORD, or in whatever sits in front of Actual.'
  );
}
