import { describe, it, expect, beforeEach } from 'vitest';
import { inFlightCount, resetInFlight, trackInFlight, whenIdle, withInFlight } from '../in-flight.js';
import type { McpServerLike } from '../read-sync.js';

/**
 * Knowing whether this server is in the middle of something (#219).
 *
 * Leaving used to close the budget beside whatever a tool was doing with it.
 * This is what the exit waits on, counted in the wrapper every tool call
 * already goes through.
 */
describe('what is in flight', () => {
  beforeEach(() => {
    resetInFlight();
  });

  it('is nothing to begin with, and idle is immediate', async () => {
    expect(inFlightCount()).toBe(0);
    await expect(whenIdle()).resolves.toBeUndefined();
  });

  it('counts a call while it runs and not after', async () => {
    let finish: (() => void) | undefined;
    const call = trackInFlight(() => new Promise<void>((resolve) => { finish = resolve; }));

    expect(inFlightCount()).toBe(1);
    finish!();
    await call;

    expect(inFlightCount()).toBe(0);
  });

  it('stops counting a call that threw', async () => {
    await expect(trackInFlight(() => Promise.reject(new Error('no')))).rejects.toThrow('no');

    expect(inFlightCount(), 'a failed call is a finished call').toBe(0);
  });

  it('waits for the last one, not the first', async () => {
    let finishA: (() => void) | undefined;
    let finishB: (() => void) | undefined;
    const a = trackInFlight(() => new Promise<void>((r) => { finishA = r; }));
    const b = trackInFlight(() => new Promise<void>((r) => { finishB = r; }));
    let idle = false;
    void whenIdle().then(() => { idle = true; });

    finishA!();
    await a;
    expect(idle, 'one is still running').toBe(false);

    finishB!();
    await b;
    await Promise.resolve();

    expect(idle).toBe(true);
  });

  it('wakes everyone waiting', async () => {
    let finish: (() => void) | undefined;
    const call = trackInFlight(() => new Promise<void>((r) => { finish = r; }));
    const waits = [whenIdle(), whenIdle(), whenIdle()];

    finish!();
    await call;

    await expect(Promise.all(waits)).resolves.toHaveLength(3);
  });

  it('hands back what the call returned', async () => {
    await expect(trackInFlight(async () => 'the reply')).resolves.toBe('the reply');
  });

  describe('the wrapper', () => {
    const registered = () => {
      let handler: ((...a: unknown[]) => Promise<unknown>) | undefined;
      const server = {
        tool: (...args: unknown[]) => {
          handler = args[args.length - 1] as never;
        },
      };
      return {
        server: withInFlight(server as unknown as McpServerLike),
        handlerOf: () => handler!,
      };
    };

    it('counts a call made through it', async () => {
      const { server, handlerOf } = registered();
      let finish: (() => void) | undefined;
      server.tool(
        'a_tool' as never,
        'd' as never,
        {} as never,
        {} as never,
        (() => new Promise<void>((r) => { finish = r; })) as never,
      );

      const call = handlerOf()();
      expect(inFlightCount()).toBe(1);
      finish!();
      await call;

      expect(inFlightCount()).toBe(0);
    });

    it('passes the arguments and the reply through untouched', async () => {
      const { server, handlerOf } = registered();
      server.tool(
        'a_tool' as never,
        'd' as never,
        {} as never,
        {} as never,
        (async (input: { n: number }) => ({ doubled: input.n * 2 })) as never,
      );

      await expect(handlerOf()({ n: 21 })).resolves.toEqual({ doubled: 42 });
    });
  });
});

/**
 * That the server counts them, which the counter cannot say for itself.
 */
describe('the wiring', () => {
  it('puts every tool through the counter, outside the other wrappers', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      fileURLToPath(new URL('../../tools/index.ts', import.meta.url)),
      'utf8',
    );

    expect(source).toContain('withInFlight(withWriteNotice(');
  });
});
