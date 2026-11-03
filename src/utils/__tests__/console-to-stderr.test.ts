import { describe, it, expect, afterEach } from 'vitest';
import { sendConsoleToStderr } from '../console-to-stderr.js';

/**
 * Where the engine's own printing goes (#229).
 *
 * On stdio, stdout is the protocol: a `[Breadcrumb]` line in the middle of a
 * JSON-RPC frame is a client that stops understanding this server. The
 * engine prints with `console.log` and has no setting for it, so the console
 * is what moves. A worker is this same entry point, so a worker keeps it.
 */
describe('the engine’s console', () => {
  const restores: Array<() => void> = [];

  afterEach(() => {
    while (restores.length > 0) restores.pop()?.();
  });

  /** What was printed where, with the console as the code under test sees it. */
  function capture(run: () => void): { out: unknown[][]; err: unknown[][] } {
    const out: unknown[][] = [];
    const err: unknown[][] = [];
    const realLog = console.log;
    const realError = console.error;
    console.log = (...args: unknown[]) => out.push(args);
    console.error = (...args: unknown[]) => err.push(args);
    try {
      const restore = sendConsoleToStderr();
      restores.push(restore);
      run();
      return { out, err };
    } finally {
      console.log = realLog;
      console.error = realError;
    }
  }

  it('sends log, info and warn to stderr and nothing to stdout', () => {
    const { out, err } = capture(() => {
      console.log('[Breadcrumb]', { message: 'Closing budget' });
      console.info('Syncing since 1970-01-01');
      console.warn('Got messages from server 0');
    });

    expect(out).toEqual([]);
    expect(err).toEqual([
      ['[Breadcrumb]', { message: 'Closing budget' }],
      ['Syncing since 1970-01-01'],
      ['Got messages from server 0'],
    ]);
  });

  it('leaves console.error alone', () => {
    const realError = console.error;
    const restore = sendConsoleToStderr();
    restores.push(restore);

    expect(console.error).toBe(realError);
  });

  it('gives the console back, which is what --verify and --version need', () => {
    const realLog = console.log;
    const realInfo = console.info;
    const realWarn = console.warn;

    const restore = sendConsoleToStderr();
    expect(console.log).not.toBe(realLog);
    restore();

    expect(console.log).toBe(realLog);
    expect(console.info).toBe(realInfo);
    expect(console.warn).toBe(realWarn);
  });
});
