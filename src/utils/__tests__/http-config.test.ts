import { describe, it, expect, afterEach } from 'vitest';
import { httpRequested, readHttpConfig } from '../http-config.js';
import { MIN_TOKEN_LENGTH } from '../http-auth.js';

const VARS = [
  'ACTUAL_HTTP_PORT',
  'ACTUAL_HTTP_HOST',
  'ACTUAL_HTTP_TOKEN',
  'ACTUAL_HTTP_WRITE_TOKEN',
  'ACTUAL_HTTP_ALLOW_REMOTE',
  'ACTUAL_HTTP_ALLOWED_HOSTS',
  'ACTUAL_READ_ONLY',
];

const TOKEN = 'a'.repeat(MIN_TOKEN_LENGTH);
const OTHER = 'b'.repeat(MIN_TOKEN_LENGTH);

/**
 * What has to be true before a port is opened (#228).
 *
 * These refuse rather than warn, which is the opposite of what an
 * unrecognised `ACTUAL_TOOLSET` does, and deliberately: the worst case there
 * is a longer tool list, and the worst case here is a budget on a network
 * with nothing in front of it. A server that came up looks exactly like one
 * that is safe.
 */
describe('the HTTP configuration', () => {
  afterEach(() => {
    for (const name of VARS) delete process.env[name];
  });

  it('asks for HTTP only when a port is set', () => {
    expect(httpRequested()).toBe(false);
    process.env.ACTUAL_HTTP_PORT = '3000';
    expect(httpRequested()).toBe(true);
  });

  it('serves loopback with a token and nothing else set', () => {
    process.env.ACTUAL_HTTP_PORT = '3000';
    process.env.ACTUAL_HTTP_TOKEN = TOKEN;

    const { config, problems } = readHttpConfig();
    expect(problems).toEqual([]);
    expect(config).toEqual({
      port: 3000,
      host: '127.0.0.1',
      allowedHosts: undefined,
      readToken: TOKEN,
      writeToken: undefined,
    });
  });

  it('refuses to start without a token', () => {
    process.env.ACTUAL_HTTP_PORT = '3000';

    const { config, problems } = readHttpConfig();
    expect(config).toBeUndefined();
    expect(problems.join('\n')).toContain('ACTUAL_HTTP_TOKEN is not set');
  });

  it('refuses a token short enough to guess', () => {
    process.env.ACTUAL_HTTP_PORT = '3000';
    process.env.ACTUAL_HTTP_TOKEN = 'short';

    expect(readHttpConfig().problems.join('\n')).toContain(`at least ${MIN_TOKEN_LENGTH}`);
  });

  it('refuses a port that is not one', () => {
    for (const value of ['0', '70000', 'three thousand', '3000.5', '-1']) {
      process.env.ACTUAL_HTTP_PORT = value;
      process.env.ACTUAL_HTTP_TOKEN = TOKEN;
      expect(readHttpConfig().problems.join('\n'), value).toContain('ACTUAL_HTTP_PORT');
    }
  });

  it('refuses to leave loopback unless the operator says so', () => {
    process.env.ACTUAL_HTTP_PORT = '3000';
    process.env.ACTUAL_HTTP_TOKEN = TOKEN;
    process.env.ACTUAL_HTTP_HOST = '0.0.0.0';

    expect(readHttpConfig().problems.join('\n')).toContain('ACTUAL_HTTP_ALLOW_REMOTE');

    process.env.ACTUAL_HTTP_ALLOW_REMOTE = '1';
    const { config, problems } = readHttpConfig();
    expect(problems).toEqual([]);
    expect(config?.host).toBe('0.0.0.0');
  });

  it('takes the host headers to accept as a list', () => {
    process.env.ACTUAL_HTTP_PORT = '3000';
    process.env.ACTUAL_HTTP_TOKEN = TOKEN;
    process.env.ACTUAL_HTTP_HOST = '0.0.0.0';
    process.env.ACTUAL_HTTP_ALLOW_REMOTE = 'yes';
    process.env.ACTUAL_HTTP_ALLOWED_HOSTS = 'budget.example.com, 10.0.0.4 ,';

    expect(readHttpConfig().config?.allowedHosts).toEqual(['budget.example.com', '10.0.0.4']);
  });

  it('refuses a write path whose credential is the read one', () => {
    process.env.ACTUAL_HTTP_PORT = '3000';
    process.env.ACTUAL_HTTP_TOKEN = TOKEN;
    process.env.ACTUAL_HTTP_WRITE_TOKEN = TOKEN;

    expect(readHttpConfig().problems.join('\n')).toContain('the split means nothing');
  });

  it('refuses a write path on a server that is read-only', () => {
    process.env.ACTUAL_HTTP_PORT = '3000';
    process.env.ACTUAL_HTTP_TOKEN = TOKEN;
    process.env.ACTUAL_HTTP_WRITE_TOKEN = OTHER;
    process.env.ACTUAL_READ_ONLY = '1';

    expect(readHttpConfig().problems.join('\n')).toContain('ACTUAL_READ_ONLY is on');
  });

  it('says everything that is wrong at once', () => {
    process.env.ACTUAL_HTTP_PORT = 'nope';
    process.env.ACTUAL_HTTP_HOST = '0.0.0.0';

    const { problems } = readHttpConfig();
    expect(problems).toHaveLength(3);
  });

  it('takes a write token that is its own', () => {
    process.env.ACTUAL_HTTP_PORT = '3000';
    process.env.ACTUAL_HTTP_TOKEN = TOKEN;
    process.env.ACTUAL_HTTP_WRITE_TOKEN = OTHER;

    const { config, problems } = readHttpConfig();
    expect(problems).toEqual([]);
    expect(config?.writeToken).toBe(OTHER);
  });
});
