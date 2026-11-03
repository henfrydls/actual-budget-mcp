import { describe, it, expect } from 'vitest';
import { withoutCredentials } from '../redact.js';
import { describeError, alreadyDescribed } from '../errors.js';

/**
 * A password in the server address (#275).
 *
 * It is written `http://user:pass@actual.example:5006`, it cannot work, and
 * this server refuses to start with it. This is the second line: the text
 * that still quotes an address keeps the host and loses the credentials,
 * because which server failed is the useful half of the sentence.
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

  it('takes out a password with an unencoded @ in it, all of it', () => {
    // WHATWG reads the authority up to the **last** `@`, so this is a valid
    // URL whose password is `p@SECRETPASS`. A pattern that stopped at the
    // first one left the second half of the password in the text, which is
    // the likeliest password to have an `@` in it at all.
    const redacted = withoutCredentials('http://user:p@SECRETPASS@127.0.0.1:5299');

    expect(redacted).toBe('http://127.0.0.1:5299');
    expect(redacted).not.toContain('SECRETPASS');
  });

  it('does not care what the scheme is written next to, or in what case', () => {
    expect(withoutCredentials('HTTP://user:hunter2@HOST:5006')).toBe('HTTP://HOST:5006');
    // A scheme in the middle of a word still introduces an address, and an
    // earlier version left this one whole.
    expect(withoutCredentials('foo_http://user:hunter2@host')).toBe('foo_http://host');
  });

  it('leaves an @ that is past the authority, in a path or a query', () => {
    expect(withoutCredentials('http://host/a@b')).toBe('http://host/a@b');
    expect(withoutCredentials('http://host/x?q=a@b')).toBe('http://host/x?q=a@b');
    expect(withoutCredentials('http://host/x#a@b')).toBe('http://host/x#a@b');
  });

  it('runs on a long string without holding the server up', () => {
    // An earlier pattern was quadratic: 100 KB of `a.` took 4,750 ms, which
    // over HTTP is the whole event loop. A name that long reaches this
    // through any message that quotes what it was given, and
    // `get_transactions` quotes an account it could not find.
    const long = 'a.'.repeat(50_000);

    const started = Date.now();
    withoutCredentials(long);
    const took = Date.now() - started;

    expect(took).toBeLessThan(500);
  });

  it('stops at the end of the address, not at the next @ in the line', () => {
    // The authority cannot hold a quote, an angle bracket, a backtick or a
    // comma, and without that the pattern ran on to an `@` further along
    // and rewrote the host: this came back saying the server was at
    // `b.com`, which is untrue as well as unhelpful.
    expect(withoutCredentials('{"url":"http://h:1","who":"a@b.com"}')).toBe(
      '{"url":"http://h:1","who":"a@b.com"}',
    );
    expect(withoutCredentials('server http://h:5006,contact=ops@corp.com')).toBe(
      'server http://h:5006,contact=ops@corp.com',
    );
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
