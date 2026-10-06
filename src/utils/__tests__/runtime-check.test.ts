import { describe, it, expect } from 'vitest';
import {
  unsupportedRuntimeMessage,
  REQUIRED_NAPI,
  MINIMUM_NODE,
} from '../runtime-check.js';

/**
 * The Node floor, which is a segfault rather than an error when it is wrong.
 *
 * `better-sqlite3` 13 is built against N-API 10, and Node 22.13 reports 9.
 * Measured on a real 22.13.1: `new Database(':memory:')` exits 139 with no
 * message, no stack and nothing in any log, so there is nothing to report
 * afterwards and a host that restarts the server would do it forever.
 */
describe('refusing a Node that would crash instead of failing', () => {
  it('refuses the N-API the SQLite binary cannot use', () => {
    const message = unsupportedRuntimeMessage('9', 'v22.13.1');
    expect(message).toBeDefined();
    expect(message).toContain(MINIMUM_NODE);
    expect(message).toContain('v22.13.1');
    // The number it reports and the number it needs, both, because the person
    // reading this has to be able to tell which Node they are on.
    expect(message).toMatch(new RegExp(String(REQUIRED_NAPI)));
    expect(message).toMatch(/9/);
  });

  it('says what happens, since nothing else will', () => {
    const message = unsupportedRuntimeMessage('9', 'v22.13.1') ?? '';
    expect(message).toMatch(/crash|no message/i);
    expect(message).toMatch(/Update Node|Docker/);
  });

  it('allows the first version that reports enough', () => {
    expect(unsupportedRuntimeMessage(String(REQUIRED_NAPI), 'v22.14.0')).toBeUndefined();
  });

  it('allows anything newer', () => {
    expect(unsupportedRuntimeMessage('10', 'v24.21.0')).toBeUndefined();
    expect(unsupportedRuntimeMessage('12', 'v26.0.0')).toBeUndefined();
  });

  it('allows a runtime that does not report N-API at all', () => {
    // Absent is not old. Every Node that can run this reports it, so the safe
    // reading of silence is "not a Node we know" and the safe action is to let
    // it try rather than refuse to start.
    expect(unsupportedRuntimeMessage(undefined, 'v22.14.0')).toBeUndefined();
    expect(unsupportedRuntimeMessage('not-a-number', 'v22.14.0')).toBeUndefined();
  });

  it('refuses every N-API below the requirement, not just the one measured', () => {
    for (const napi of ['1', '8', '9']) {
      expect(unsupportedRuntimeMessage(napi, 'v22.0.0'), `napi ${napi}`).toBeDefined();
    }
  });
});
