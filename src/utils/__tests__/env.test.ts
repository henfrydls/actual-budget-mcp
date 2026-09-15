import { describe, it, expect, afterEach } from 'vitest';
import { readEnv } from '../env.js';

const NAME = 'ACTUAL_TEST_VALUE';

afterEach(() => {
  delete process.env[NAME];
});

describe('reading configuration that a host may not have filled in', () => {
  it('returns a real value untouched', () => {
    process.env[NAME] = 'a-real-token';
    expect(readEnv(NAME)).toBe('a-real-token');
  });

  it('treats an unsubstituted placeholder as unset', () => {
    // The literal Claude Desktop leaves behind for an optional field the user
    // left empty. Reproduced against a real server: it is truthy, so it beat
    // the password and was sent as a session token.
    process.env[NAME] = '${user_config.session_token}';
    expect(readEnv(NAME)).toBeUndefined();
  });

  it('treats other placeholder spellings as unset too', () => {
    for (const raw of ['${user_config.encryption_password}', '${USER_CONFIG.READ_ONLY}', '${foo.bar-baz}']) {
      process.env[NAME] = raw;
      expect(readEnv(NAME)).toBeUndefined();
    }
  });

  it('treats blank and whitespace as unset', () => {
    for (const raw of ['', '   ', '\t\n']) {
      process.env[NAME] = raw;
      expect(readEnv(NAME)).toBeUndefined();
    }
  });

  it('keeps a value that merely contains a brace', () => {
    process.env[NAME] = 'p${assw}ord';
    expect(readEnv(NAME)).toBe('p${assw}ord');
  });

  it('does not trim a value that has real content', () => {
    // Passwords may legitimately end in a space; only fully blank is "unset".
    process.env[NAME] = 'secret ';
    expect(readEnv(NAME)).toBe('secret ');
  });
});
