/**
 * Keep a password out of anything this server says (#275).
 *
 * `ACTUAL_SERVER_URL` can be written with credentials in it,
 * `http://user:pass@actual.example:5006`, and someone who has seen that form
 * elsewhere will write it here. It never works: Node's `fetch` refuses a URL
 * with credentials outright ("Request cannot be constructed from a URL that
 * includes credentials"), and the error it throws quotes the whole URL,
 * password included. So the first answer is to refuse that configuration at
 * startup, which `serverUrlProblem` does.
 *
 * This is the second answer, and it stays because the first one is a check
 * that can be moved, bypassed by a library consumer, or outlived by some
 * other address that turns up in a message. Nothing here is a reason to
 * relax the check.
 *
 * The host stays. Which server failed is the useful half of the sentence,
 * and a message that says only "a server did not answer" sends the reader to
 * check the wrong one.
 */

/**
 * The userinfo of any URL in `text`, taken out.
 *
 * Reads like the URL standard does rather than like a guess at one: a
 * scheme, `//`, then the authority, which ends at the first `/`, `?` or `#`.
 * The last `@` inside that authority is where userinfo ends, which is what
 * WHATWG parses and what a password containing an unencoded `@` produces.
 * Stopping at the first one, as an earlier version did, left half of such a
 * password in the text.
 *
 * What it covers: one or many URLs, anywhere in a sentence, with or without
 * a password, with an unencoded `@` in the password, and an address with no
 * credentials, which it leaves exactly as it was. An email address has no
 * scheme in front of it and is left alone, and so is an `@` in a path or a
 * query, because the authority has already ended.
 *
 * There is no word boundary in front of the scheme on purpose. With one,
 * `foo_http://user:pass@host` went through untouched, because the scheme
 * does not start a word there; without one the match starts at `http://`
 * and the rest of the line is left where it was.
 *
 * The authority also ends at a quote, an angle bracket, a backtick or a
 * comma. None of those belong in one, and without them the pattern ran past
 * the end of an address to reach an `@` further along the line:
 * `{"url":"http://h:1","who":"a@b.com"}` came back with `b.com` as the host,
 * which is a sentence that now says something untrue about where the server
 * is.
 *
 * What it does not cover: a password with a space, a tab or a comma in it, a
 * URL escaped inside JSON as `http:\/\/`, one that is entirely
 * percent-encoded, and a malformed `http:/user:pass@host` with one slash.
 * Each of those is an address this server refuses to start with, by one
 * branch of `serverUrlProblem` or the other, which is what makes the list
 * acceptable.
 *
 * The bound on the scheme is not decoration. Without it the pattern is
 * quadratic, and a 100 KB string of `a.` took 4,750 ms against 9 ms with it:
 * long enough to hold the whole event loop, which over HTTP is the whole
 * server. A name that long reaches this through any message that quotes what
 * it was given.
 */
const USERINFO = /([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/?#"'<>`,]*@/gi;

export function withoutCredentials(text: string | undefined): string {
  return (text ?? '').replace(USERINFO, '$1');
}
