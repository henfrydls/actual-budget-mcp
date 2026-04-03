import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getConfig } from '../../connection.js';

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
