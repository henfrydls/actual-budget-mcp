/**
 * Keep a password out of anything this server says (#275).
 *
 * `ACTUAL_SERVER_URL` can carry credentials. `http://user:pass@actual.example:5006`
 * is a legitimate way to write it, and a reverse proxy with basic auth in
 * front of Actual is reason enough to. An error that quotes the address
 * therefore quotes the password, and this server returns an error as the text
 * of a tool reply: it reaches a model, a transcript, a log, and a bug report
 * pasted into an issue.
 *
 * Over stdio that reply goes to a client the person started themselves. Over
 * HTTP it crosses a network, which is why this is done before HTTP ships
 * rather than after.
 *
 * The host stays. Which server failed is the useful half of the sentence, and
 * a message that says only "a server did not answer" sends the reader to
 * check the wrong one.
 */

/**
 * The userinfo of any URL in `text`, taken out.
 *
 * Matches a scheme, `//`, and everything up to an `@` that is not a space or
 * a slash, which is where userinfo can be and nowhere else. A URL with no
 * credentials has no `@` before its host and is left exactly as it was, and
 * so is an email address, which has no `scheme://` in front of it.
 */
const USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;

export function withoutCredentials(text: string | undefined): string {
  return (text ?? '').replace(USERINFO, '$1');
}
