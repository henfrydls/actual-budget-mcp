import { describe, it, expect } from 'vitest';
import { bearerFrom, tokenMatches, MIN_TOKEN_LENGTH } from '../http-auth.js';

/**
 * The one credential an HTTP deployment has (#228).
 *
 * It stands for the whole budget, so the two things checked here are the
 * whole of the defence: that the header is read the way clients send it, and
 * that a wrong token is refused without saying how wrong it was.
 */
describe('the bearer token', () => {
  const token = 'a'.repeat(MIN_TOKEN_LENGTH);

  it('reads the token out of the header', () => {
    expect(bearerFrom(`Bearer ${token}`)).toBe(token);
    // Clients differ on the case, and the scheme is case-insensitive.
    expect(bearerFrom(`bearer ${token}`)).toBe(token);
    expect(bearerFrom(`  Bearer ${token}  `)).toBe(token);
  });

  it('reads nothing out of a header that is not one', () => {
    expect(bearerFrom(undefined)).toBeUndefined();
    expect(bearerFrom('')).toBeUndefined();
    expect(bearerFrom(token)).toBeUndefined();
    expect(bearerFrom(`Basic ${token}`)).toBeUndefined();
    // The scheme is the start of the header, not something found in it: a
    // pattern without that anchor let this through as a credential.
    expect(bearerFrom(`Mac Bearer ${token}`)).toBeUndefined();
    expect(bearerFrom('Bearer ')).toBeUndefined();
    // Node hands a repeated header over as an array, and an array is not a
    // credential: a client sending two is a client to refuse, not one to
    // pick a favourite from.
    expect(bearerFrom([`Bearer ${token}`, `Bearer ${token}`])).toBeUndefined();
  });

  it('accepts the token it was given', () => {
    expect(tokenMatches(token, token)).toBe(true);
  });

  it('refuses anything else, including a prefix of the right length', () => {
    expect(tokenMatches(`${token}x`, token)).toBe(false);
    expect(tokenMatches(token.slice(0, -1), token)).toBe(false);
    expect(tokenMatches(`${token.slice(0, -1)}b`, token)).toBe(false);
    expect(tokenMatches('', token)).toBe(false);
  });

  it('refuses when either side is missing, rather than matching nothing', () => {
    expect(tokenMatches(undefined, token)).toBe(false);
    expect(tokenMatches(token, undefined)).toBe(false);
    expect(tokenMatches(undefined, undefined)).toBe(false);
  });
});
