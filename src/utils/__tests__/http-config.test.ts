import { describe, it, expect, afterEach } from 'vitest';
import {
  httpRequested,
  httpHalfConfigured,
  readHttpConfig,
  displayHost,
} from '../http-config.js';
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

const TOKEN = '9f2c41ab7d0e38516c4af0b29d7e13a5';
const OTHER = '0b7e4d1c92a6358f1e0c4ab7d539e62f';

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
    // Still not enough: off loopback the automatic host validation does not
    // apply, and without a list every Host header is answered.
    expect(readHttpConfig().problems.join('\n')).toContain('ACTUAL_HTTP_ALLOWED_HOSTS');

    process.env.ACTUAL_HTTP_ALLOWED_HOSTS = 'budget.example.com';
    const { config, problems } = readHttpConfig();
    expect(problems).toEqual([]);
    expect(config?.host).toBe('0.0.0.0');
  });

  it('takes an IPv6 address written the way a URL writes it', () => {
    process.env.ACTUAL_HTTP_PORT = '3000';
    process.env.ACTUAL_HTTP_TOKEN = TOKEN;
    process.env.ACTUAL_HTTP_HOST = '[::1]';

    // The brackets belong to the URL. `listen` cannot resolve them, and the
    // server came up bound to nothing.
    const { config, problems } = readHttpConfig();
    expect(problems).toEqual([]);
    expect(config?.host).toBe('::1');
  });

  it('writes an IPv6 address the way a URL writes it', () => {
    // The line a server prints at startup is what gets pasted into a
    // client, and `http://::1:3000` is not an address.
    expect(displayHost('::1')).toBe('[::1]');
    expect(displayHost('127.0.0.1')).toBe('127.0.0.1');
    expect(displayHost('budget.example.com')).toBe('budget.example.com');
  });

  it('refuses a token nobody could send', () => {
    process.env.ACTUAL_HTTP_PORT = '3000';
    process.env.ACTUAL_HTTP_TOKEN = `${TOKEN} `;

    // The header is trimmed before it is compared, so this one starts a
    // server that refuses its own credential.
    expect(readHttpConfig().problems.join('\n')).toContain('no client could send it');
  });

  it('refuses a token that is one character repeated', () => {
    process.env.ACTUAL_HTTP_PORT = '3000';
    process.env.ACTUAL_HTTP_TOKEN = 'a'.repeat(MIN_TOKEN_LENGTH);

    expect(readHttpConfig().problems.join('\n')).toContain('one character repeated');
  });

  it('says so when everything but the port is set', () => {
    process.env.ACTUAL_HTTP_TOKEN = TOKEN;
    process.env.ACTUAL_HTTP_HOST = '127.0.0.1';

    // Starting quietly on stdio answers nothing and looks like the server
    // is up.
    expect(httpRequested()).toBe(false);
    expect(httpHalfConfigured()).toEqual(['ACTUAL_HTTP_TOKEN', 'ACTUAL_HTTP_HOST']);
  });

  it('says nothing when nothing was set', () => {
    expect(httpHalfConfigured()).toEqual([]);
    process.env.ACTUAL_HTTP_PORT = '3000';
    process.env.ACTUAL_HTTP_TOKEN = TOKEN;
    expect(httpHalfConfigured()).toEqual([]);
  });

  it('takes the host headers to accept as a list', () => {
    process.env.ACTUAL_HTTP_PORT = '3000';
    process.env.ACTUAL_HTTP_TOKEN = TOKEN;
    process.env.ACTUAL_HTTP_HOST = '0.0.0.0';
    process.env.ACTUAL_HTTP_ALLOW_REMOTE = 'yes';
    process.env.ACTUAL_HTTP_ALLOWED_HOSTS = 'budget.example.com, 10.0.0.4 ,';

    const { config, problems } = readHttpConfig();
    expect(problems).toEqual([]);
    expect(config?.allowedHosts).toEqual(['budget.example.com', '10.0.0.4']);
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

    // The port, the missing token, leaving loopback, and the host list that
    // leaving loopback needs. One restart, not four.
    const { problems } = readHttpConfig();
    expect(problems).toHaveLength(4);
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
