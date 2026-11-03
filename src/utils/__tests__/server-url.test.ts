import { describe, it, expect } from 'vitest';
import { serverUrlProblem } from '../server-url.js';

/**
 * The configuration that cannot work, refused before anything runs (#275).
 *
 * Measured: `fetch('http://user:pass@127.0.0.1:1/')` throws "Request cannot
 * be constructed from a URL that includes credentials" before it sends
 * anything, and that message quotes the URL in full. The engine turns it
 * into a network failure, so every call answers that nothing is listening on
 * an address that may be answering perfectly well.
 */
describe('a server address with credentials in it', () => {
  it('is refused, and the refusal says what to do instead', () => {
    const problem = serverUrlProblem('http://user:hunter2@actual.example:5006');

    expect(problem).toContain('cannot work');
    expect(problem).toContain('ACTUAL_PASSWORD');
  });

  it('shows the address with the credentials already out of it', () => {
    // A startup error is the first thing anyone copies into an issue.
    const problem = serverUrlProblem('http://user:hunter2@actual.example:5006');

    expect(problem).toContain('http://actual.example:5006');
    expect(problem).not.toContain('hunter2');
    expect(problem).not.toContain('user:');
  });

  it('refuses a username with no password, which is still a credential', () => {
    expect(serverUrlProblem('https://user@actual.example')).toBeDefined();
  });

  it('says nothing about an ordinary address', () => {
    expect(serverUrlProblem('http://127.0.0.1:5006')).toBeUndefined();
    expect(serverUrlProblem('https://actual.example:5006/sync')).toBeUndefined();
  });

  it('says nothing when there is no address at all', () => {
    expect(serverUrlProblem(undefined)).toBeUndefined();
    expect(serverUrlProblem('   ')).toBeUndefined();
  });

  it('refuses an address that does not parse, and repeats none of it', () => {
    // Letting this one through was a leak, not a kindness: a password with
    // a `/`, a `#` or a `?` in it is a URL that does not parse, and the
    // engine logs the whole input with "Unable to parse server URL",
    // twenty-one times. Measured, each of these throws in `new URL`.
    for (const raw of [
      'http://user:hunter2/two@203.0.113.9:5006',
      'http://user:hunter2#two@203.0.113.9:5006',
      'http://user:hunter2?two@203.0.113.9:5006',
      'http://user:hunter2@203.0.113.9:99999',
      'not a url',
    ]) {
      const problem = serverUrlProblem(raw);

      expect(problem, raw).toContain('not a URL this can read');
      // Nothing of the address comes back, not even redacted: the only
      // thing that can be said about a string that does not parse is that
      // it does not parse.
      expect(problem, raw).not.toContain('hunter2');
      expect(problem, raw).not.toContain('203.0.113.9');
    }
  });

  it('refuses a password with a space in it without printing it', () => {
    // It parses, so it reaches the other branch, and a pattern that ends at
    // a space printed the password it was refusing. The address shown is
    // built from the parsed URL instead.
    const problem = serverUrlProblem('http://user:hunter2 two@127.0.0.1:5006');

    expect(problem).toContain('http://127.0.0.1:5006');
    expect(problem).not.toContain('hunter2');
    expect(problem).not.toContain('two');
  });

  it('refuses a password with a tab in it the same way', () => {
    const problem = serverUrlProblem('http://user:hunter2\ttwo@127.0.0.1:5006');

    expect(problem).toContain('http://127.0.0.1:5006');
    expect(problem).not.toContain('hunter2');
  });
});
