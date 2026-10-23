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

  it('leaves an address that does not parse to the error it causes later', () => {
    // Two errors for one mistake is worse than one, and guessing at what
    // was meant is not this check's business.
    expect(serverUrlProblem('http://host:99999')).toBeUndefined();
    expect(serverUrlProblem('not a url')).toBeUndefined();
  });
});
