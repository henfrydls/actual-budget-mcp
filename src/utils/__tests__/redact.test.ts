import { describe, it, expect } from 'vitest';
import { withoutCredentials } from '../redact.js';
import { describeError, alreadyDescribed } from '../errors.js';

/**
 * A password in the server address, which an error quotes without meaning to
 * (#275).
 *
 * `http://user:pass@actual.example:5006` is a legitimate `ACTUAL_SERVER_URL`,
 * and a reverse proxy with basic auth in front of Actual is reason enough to
 * write one. Every message this server gives a client goes through
 * `describeError`, so that is where it is taken out, and the host stays:
 * which server failed is the useful half of the sentence.
 */
describe('credentials in an address', () => {
  it('takes the credentials out and leaves the server', () => {
    expect(withoutCredentials('http://user:pass@actual.example:5006')).toBe(
      'http://actual.example:5006',
    );
  });

  it('takes out a user with no password, which is still a credential', () => {
    expect(withoutCredentials('https://user@actual.example')).toBe('https://actual.example');
  });

  it('leaves an address that carries none', () => {
    const plain = 'Could not reach http://127.0.0.1:5006/sync. Check that it is running.';

    expect(withoutCredentials(plain)).toBe(plain);
  });

  it('works on an address in the middle of a sentence, and on more than one', () => {
    const text =
      'Tried https://u1:p1@one.example:5006/sync, then http://u2:p2@two.example, and gave up.';

    expect(withoutCredentials(text)).toBe(
      'Tried https://one.example:5006/sync, then http://two.example, and gave up.',
    );
    expect(withoutCredentials(text)).not.toContain('p1');
    expect(withoutCredentials(text)).not.toContain('p2');
  });

  it('leaves text with no address in it alone', () => {
    const text = 'The server refused the credentials. A session token may have expired.';

    expect(withoutCredentials(text)).toBe(text);
  });

  it('leaves an email address alone, which has no scheme in front of it', () => {
    const text = 'Sent to someone@example.com by the rule.';

    expect(withoutCredentials(text)).toBe(text);
  });

  it('takes nothing for text that is not there', () => {
    expect(withoutCredentials(undefined)).toBe('');
  });

  it('is applied to every failure this server describes', () => {
    // The whole point: the engine quotes the address it was given, and this
    // is the one funnel every tool's catch block goes through.
    const described = describeError(
      new Error('request to http://user:hunter2@actual.example:5006/sync failed'),
    );

    expect(described).not.toContain('hunter2');
    expect(described).toContain('actual.example:5006');
  });

  it('is applied to a message a tool had already finished writing', () => {
    const described = describeError(
      alreadyDescribed('Nothing was repaired: http://admin:letmein@actual.example is not reachable'),
    );

    expect(described).not.toContain('letmein');
    expect(described).toContain('actual.example');
  });
});
