import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getConfig, unreachableMessage } from '../../connection.js';

describe('getConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns config when all required vars are set', () => {
    process.env.ACTUAL_SERVER_URL = 'http://localhost:5007';
    process.env.ACTUAL_PASSWORD = 'test123';
    process.env.ACTUAL_BUDGET_ID = 'abc-123';

    const config = getConfig();
    expect(config.serverURL).toBe('http://localhost:5007');
    expect(config.password).toBe('test123');
    expect(config.budgetId).toBe('abc-123');
  });

  it('refuses an address with credentials in it, which cannot connect', () => {
    // Measured: Node's `fetch` throws "Request cannot be constructed from a
    // URL that includes credentials" before it sends anything, so a server
    // configured this way answers that nothing is listening to every call
    // (#275). One clear error beats every call being wrong.
    process.env.ACTUAL_SERVER_URL = 'http://user:hunter2@actual.example:5006';
    process.env.ACTUAL_BUDGET_ID = 'abc-123';

    expect(() => getConfig()).toThrow(/cannot work/);
    expect(() => getConfig()).not.toThrow(/hunter2/);
  });

  it('defaults password to empty string when not set', () => {
    process.env.ACTUAL_SERVER_URL = 'http://localhost:5007';
    process.env.ACTUAL_BUDGET_ID = 'abc-123';
    delete process.env.ACTUAL_PASSWORD;

    const config = getConfig();
    expect(config.password).toBe('');
  });

  it('includes optional encryption password', () => {
    process.env.ACTUAL_SERVER_URL = 'http://localhost:5007';
    process.env.ACTUAL_BUDGET_ID = 'abc-123';
    process.env.ACTUAL_ENCRYPTION_PASSWORD = 'secret';

    const config = getConfig();
    expect(config.encryptionPassword).toBe('secret');
  });

  it('includes optional data dir', () => {
    process.env.ACTUAL_SERVER_URL = 'http://localhost:5007';
    process.env.ACTUAL_BUDGET_ID = 'abc-123';
    process.env.ACTUAL_DATA_DIR = '/custom/path';

    const config = getConfig();
    expect(config.dataDir).toBe('/custom/path');
  });

  it('throws when ACTUAL_SERVER_URL is missing', () => {
    delete process.env.ACTUAL_SERVER_URL;
    process.env.ACTUAL_BUDGET_ID = 'abc-123';

    expect(() => getConfig()).toThrow('Missing required environment variables: ACTUAL_SERVER_URL');
  });

  it('throws when ACTUAL_BUDGET_ID is missing', () => {
    process.env.ACTUAL_SERVER_URL = 'http://localhost:5007';
    delete process.env.ACTUAL_BUDGET_ID;

    expect(() => getConfig()).toThrow('Missing required environment variables: ACTUAL_BUDGET_ID');
  });

  it('throws when both required vars are missing', () => {
    delete process.env.ACTUAL_SERVER_URL;
    delete process.env.ACTUAL_BUDGET_ID;

    expect(() => getConfig()).toThrow('ACTUAL_SERVER_URL');
    try {
      getConfig();
    } catch (e: any) {
      expect(e.message).toContain('ACTUAL_BUDGET_ID');
    }
  });
});

describe('the message for a server that did not answer', () => {
  it('names the address without its credentials', () => {
    // Second line, tested as a function rather than through a call: an
    // address with credentials is refused by `getConfig` before anything
    // reaches here, so nothing can drive the path to it (#275).
    const message = unreachableMessage('http://user:hunter2@actual.example:5006');

    expect(message).toContain('actual.example:5006');
    expect(message).not.toContain('hunter2');
  });

  it('still points at the port someone probably meant', () => {
    // The thing the message is for, unchanged by the redaction.
    expect(unreachableMessage('http://127.0.0.1:5006')).toContain('5007');
    expect(unreachableMessage('http://127.0.0.1:5007')).toContain('5006');
  });
});
