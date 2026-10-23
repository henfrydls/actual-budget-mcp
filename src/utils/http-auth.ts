import { timingSafeEqual } from 'node:crypto';

/**
 * Who is allowed to reach an HTTP server, and nothing more (#228).
 *
 * One deployment, one Actual account, one credential: this says whether the
 * caller holds it. It is not a user system, and the token stands for the
 * whole budget, which is why the two rules below are not optional.
 */

/**
 * The shortest token this server will start with.
 *
 * A token is the only thing between the internet and someone's budget, and a
 * short one is guessable at a rate nothing here limits. Thirty-two
 * characters is what `openssl rand -hex 16` gives, which is the line the
 * documentation tells people to run.
 */
export const MIN_TOKEN_LENGTH = 32;

/**
 * The token out of an `Authorization` header, or nothing if there is none.
 *
 * One or more spaces after the scheme, which is what the standard writes
 * (`auth-scheme 1*SP credentials`) and what a client that builds the header
 * by joining strings sometimes produces. A tab is not a space and is not
 * accepted, and neither is an array: Node hands a repeated header over as
 * one, and two credentials in a request is a question nobody can answer
 * correctly.
 */
export function bearerFrom(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer +(.+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * Whether the token presented is the one configured.
 *
 * Compared with `timingSafeEqual`, which needs both halves to be the same
 * length: a plain `===` on a secret gives away how much of a guess was right
 * by how long it took to say no. The lengths are compared first and that
 * comparison is not constant time, so the length of the token leaks and its
 * content does not. Nothing is compared at all when either side is missing.
 */
export function tokenMatches(presented: string | undefined, expected: string | undefined): boolean {
  if (presented === undefined || expected === undefined) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
