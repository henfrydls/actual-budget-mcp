import { describe, it, expect, afterEach } from 'vitest';
import { isReadOnly } from '../mode.js';

describe('isReadOnly', () => {
  afterEach(() => {
    delete process.env.ACTUAL_READ_ONLY;
  });

  it('is off when the variable is unset', () => {
    expect(isReadOnly()).toBe(false);
  });

  it.each(['1', 'true', 'TRUE', 'yes', ' true '])('is on for %j', (value) => {
    process.env.ACTUAL_READ_ONLY = value;
    expect(isReadOnly()).toBe(true);
  });

  it.each(['0', 'false', 'no', ''])('is off for %j', (value) => {
    process.env.ACTUAL_READ_ONLY = value;
    expect(isReadOnly()).toBe(false);
  });
});
