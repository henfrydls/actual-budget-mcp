import { afterEach, describe, expect, it } from 'vitest';
import {
  encryptionPasswordFor,
  encryptionPasswordsProblem,
  workerEnvironment,
} from '../worker-env.js';

const VARS = [
  'TZ',
  'HTTPS_PROXY',
  'no_proxy',
  'SSL_CERT_FILE',
  'NODE_OPTIONS',
  'ACTUAL_SERVER_URL',
  'ACTUAL_PASSWORD',
  'ACTUAL_SESSION_TOKEN',
  'ACTUAL_READ_ONLY',
  'ACTUAL_TOOLSET',
  'ACTUAL_HTTP_PORT',
  'ACTUAL_HTTP_TOKEN',
  'ACTUAL_HTTP_WRITE_TOKEN',
  'ACTUAL_BUDGET_ID',
  'ACTUAL_BUDGET_IDS',
  'ACTUAL_DATA_DIR',
  'ACTUAL_ENCRYPTION_PASSWORD',
  'ACTUAL_ENCRYPTION_PASSWORDS',
];

describe('what a worker is started with', () => {
  afterEach(() => {
    for (const name of VARS) delete process.env[name];
  });

  it('passes the server and the read-only flag, and nothing about the front door', () => {
    process.env.ACTUAL_SERVER_URL = 'http://localhost:5006';
    process.env.ACTUAL_PASSWORD = 'hunter2';
    process.env.ACTUAL_READ_ONLY = '1';
    process.env.ACTUAL_TOOLSET = 'chat';
    process.env.ACTUAL_HTTP_PORT = '3000';
    process.env.ACTUAL_HTTP_TOKEN = 'read-token';
    process.env.ACTUAL_HTTP_WRITE_TOKEN = 'write-token';
    process.env.ACTUAL_BUDGET_IDS = 'one,two';

    const env = workerEnvironment({ budgetId: 'two', dataDir: '/data/two' });

    expect(env.ACTUAL_SERVER_URL).toBe('http://localhost:5006');
    expect(env.ACTUAL_PASSWORD).toBe('hunter2');
    // A read-only front end starts read-only children: the write tools do
    // not exist in the process that holds the budget either.
    expect(env.ACTUAL_READ_ONLY).toBe('1');
    expect(env.ACTUAL_TOOLSET).toBe('chat');
    // A worker that read these would start a second HTTP server, on a port
    // that is taken, holding a budget nobody can reach.
    expect(env.ACTUAL_HTTP_PORT).toBeUndefined();
    expect(env.ACTUAL_HTTP_TOKEN).toBeUndefined();
    expect(env.ACTUAL_HTTP_WRITE_TOKEN).toBeUndefined();
    // A worker serves one budget; a list would make it think otherwise.
    expect(env.ACTUAL_BUDGET_IDS).toBeUndefined();
  });

  it('carries the clock, the proxy and the certificates, which are the machine', () => {
    // A worker in UTC while the front end is in its own zone gives two
    // different answers to "today", and a date is what half of these tools
    // are about. The proxy and the certificates are how it reaches the
    // Actual server at all, which is its job now.
    process.env.TZ = 'America/Santo_Domingo';
    process.env.HTTPS_PROXY = 'http://proxy.internal:3128';
    process.env.no_proxy = 'localhost,127.0.0.1';
    process.env.SSL_CERT_FILE = '/etc/ssl/certs/ca.pem';

    const env = workerEnvironment({ budgetId: 'one', dataDir: '/data/one' });

    expect(env.TZ).toBe('America/Santo_Domingo');
    expect(env.HTTPS_PROXY).toBe('http://proxy.internal:3128');
    expect(env.no_proxy).toBe('localhost,127.0.0.1');
    expect(env.SSL_CERT_FILE).toBe('/etc/ssl/certs/ca.pem');
  });

  it('passes NODE_OPTIONS without the inspector, which is a port and not a setting', () => {
    // Measured: a second process with --inspect says `Starting inspector on
    // 127.0.0.1:9229 failed: address already in use` and runs on, so three
    // workers would each say it every time somebody debugged the front end.
    process.env.NODE_OPTIONS = '--max-old-space-size=4096 --inspect=9229 --use-openssl-ca';

    const env = workerEnvironment({ budgetId: 'one', dataDir: '/data/one' });

    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=4096 --use-openssl-ca');
  });

  it('leaves NODE_OPTIONS out entirely when the inspector was all it held', () => {
    process.env.NODE_OPTIONS = '--inspect-brk';

    expect(workerEnvironment({ budgetId: 'one', dataDir: '/d' }).NODE_OPTIONS).toBeUndefined();
  });

  it('gives each worker its own budget and its own directory', () => {
    process.env.ACTUAL_BUDGET_ID = 'one';
    process.env.ACTUAL_DATA_DIR = '/data';

    const env = workerEnvironment({ budgetId: 'two', dataDir: '/data/budgets/two' });

    expect(env.ACTUAL_BUDGET_ID).toBe('two');
    expect(env.ACTUAL_DATA_DIR).toBe('/data/budgets/two');
  });

  it('hands down one password and never the map', () => {
    process.env.ACTUAL_ENCRYPTION_PASSWORDS = JSON.stringify({ one: 'first', two: 'second' });

    const env = workerEnvironment({
      budgetId: 'two',
      dataDir: '/data/two',
      encryptionPassword: encryptionPasswordFor('two'),
    });

    expect(env.ACTUAL_ENCRYPTION_PASSWORD).toBe('second');
    expect(env.ACTUAL_ENCRYPTION_PASSWORDS).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain('first');
  });

  it('keeps the single password working for the budget it was set for', () => {
    process.env.ACTUAL_BUDGET_ID = 'one';
    process.env.ACTUAL_ENCRYPTION_PASSWORD = 'only one';

    expect(encryptionPasswordFor('one')).toBe('only one');
    // Another budget's file is not encrypted with this budget's password.
    expect(encryptionPasswordFor('two')).toBeUndefined();
  });

  it('says what is wrong with the map at startup, once', () => {
    expect(encryptionPasswordsProblem()).toBeUndefined();

    process.env.ACTUAL_ENCRYPTION_PASSWORDS = 'secret';
    expect(encryptionPasswordsProblem()).toContain('is not a JSON object');

    process.env.ACTUAL_ENCRYPTION_PASSWORDS = JSON.stringify(['one']);
    expect(encryptionPasswordsProblem()).toContain('is not a JSON object');

    process.env.ACTUAL_ENCRYPTION_PASSWORDS = JSON.stringify({ one: 'first' });
    expect(encryptionPasswordsProblem()).toBeUndefined();
  });
});
