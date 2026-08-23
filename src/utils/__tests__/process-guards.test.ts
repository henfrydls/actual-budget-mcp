import { describe, it, expect, vi } from 'vitest';
import { installProcessGuards } from '../process-guards.js';

/** Minimal stand-in for `process` that records the handlers installed on it. */
function fakeProcess() {
  const handlers = new Map<string, (reason: unknown) => void>();
  return {
    on(event: string, handler: (reason: unknown) => void) {
      handlers.set(event, handler);
      return this;
    },
    emit(event: string, reason: unknown) {
      const handler = handlers.get(event);
      if (!handler) throw new Error(`no handler for ${event}`);
      handler(reason);
    },
    has(event: string) {
      return handlers.has(event);
    },
  };
}

describe('installProcessGuards (#39 a library rejection must not kill the server)', () => {
  it('installs an unhandledRejection handler', () => {
    const proc = fakeProcess();

    installProcessGuards(proc as any, vi.fn());

    expect(proc.has('unhandledRejection')).toBe(true);
  });

  it('swallows the rejection instead of rethrowing, so the process survives', () => {
    const proc = fakeProcess();
    installProcessGuards(proc as any, vi.fn());

    expect(() => proc.emit('unhandledRejection', new Error('out-of-sync'))).not.toThrow();
  });

  it('logs the reason so the failure is diagnosable', () => {
    const proc = fakeProcess();
    const log = vi.fn();
    installProcessGuards(proc as any, log);

    proc.emit('unhandledRejection', new Error('SyncError: out-of-sync'));

    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toMatch(/out-of-sync/i);
  });

  it('still logs something identifiable when the rejection has no message', () => {
    const proc = fakeProcess();
    const log = vi.fn();
    installProcessGuards(proc as any, log);

    proc.emit('unhandledRejection', new Error(''));

    const logged = String(log.mock.calls[0][0]);
    expect(logged.trim()).not.toBe('');
    expect(logged).toMatch(/unhandled/i);
  });
});
