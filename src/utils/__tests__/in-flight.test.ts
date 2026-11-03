import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  inFlightCount,
  isLeaving,
  resetInFlight,
  startLeaving,
  trackInFlight,
  whenIdle,
  withInFlight,
} from '../in-flight.js';
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

  it('is not leaving to begin with', () => {
    expect(isLeaving()).toBe(false);
    startLeaving();
    expect(isLeaving()).toBe(true);
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

    it('refuses a call that arrives once the server is leaving', async () => {
      // The counter starts when a handler starts, so a request that had not
      // been dispatched when the signal arrived was invisible: measured, one
      // sent 300ms before a SIGTERM reached a budget that was being closed
      // and answered `Error: No budget file is open`. Refusing it outright
      // is faster and says what happened.
      const { server, handlerOf } = registered();
      const ran = vi.fn().mockResolvedValue({ content: [] });
      server.tool('a_tool' as never, 'd' as never, {} as never, {} as never, ran as never);

      startLeaving();
      const reply = (await handlerOf()({})) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };

      expect(ran, 'it must not reach the budget').not.toHaveBeenCalled();
      expect(reply.isError).toBe(true);
      expect(reply.content[0].text).toContain('shutting down');
      expect(reply.content[0].text).toContain('Nothing was read or written');
      expect(inFlightCount(), 'and it is not work to wait for').toBe(0);
    });

    it('lets a call that was already running finish', async () => {
      const { server, handlerOf } = registered();
      let finish: ((value: string) => void) | undefined;
      server.tool(
        'a_tool' as never,
        'd' as never,
        {} as never,
        {} as never,
        (() => new Promise<string>((r) => { finish = r; })) as never,
      );

      const call = handlerOf()();
      startLeaving();
      finish!('the reply');

      await expect(call).resolves.toBe('the reply');
    });

    it('refuses a resource read once the server is leaving', async () => {
      // A resource reads the budget exactly as a read tool does. Left out of
      // this, a `resources/read` arriving five milliseconds after the signal
      // answered the engine's own `No budget file is open`.
      let handler: ((...a: unknown[]) => Promise<unknown>) | undefined;
      const server = withInFlight({
        tool: () => {},
        resource: (...args: unknown[]) => {
          handler = args[args.length - 1] as never;
        },
      } as unknown as McpServerLike);
      const ran = vi.fn().mockResolvedValue({ contents: [] });
      (server as unknown as { resource: (...a: unknown[]) => unknown }).resource(
        'accounts',
        'actual://accounts',
        ran,
      );

      startLeaving();

      await expect(handler!()).rejects.toThrow(/shutting down/);
      expect(ran).not.toHaveBeenCalled();
    });

    it('counts a resource read while it runs', async () => {
      let handler: ((...a: unknown[]) => Promise<unknown>) | undefined;
      const server = withInFlight({
        tool: () => {},
        resource: (...args: unknown[]) => {
          handler = args[args.length - 1] as never;
        },
      } as unknown as McpServerLike);
      let finish: (() => void) | undefined;
      (server as unknown as { resource: (...a: unknown[]) => unknown }).resource(
        'accounts',
        'actual://accounts',
        () => new Promise<void>((r) => { finish = r; }),
      );

      const call = handler!();
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
  it('counts a routed call while it runs, and lets go of it after', async () => {
    // It used to be read off the source of `tools/index.ts`, which stopped
    // saying anything the day the chain below it changed shape: with more
    // than one budget the wrappers that touch the engine are left out, and
    // the counter is not one of them. The exit waits on this, so a routed
    // call that is not counted is a budget closed underneath a worker.
    const { registerAllTools } = await import('../../tools/index.js');
    const { usePool } = await import('../../workers/current.js');

    resetInFlight();
    process.env.ACTUAL_BUDGET_ID = 'bud-a';
    process.env.ACTUAL_BUDGET_IDS = 'bud-a,bud-b';
    let counted = -1;
    usePool({
      call: async () => {
        counted = inFlightCount();
        return { content: [{ type: 'text', text: 'answered' }] };
      },
      openBudgets: () => [],
      stop: async () => undefined,
    } as never);

    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    registerAllTools({
      tool: (...args: unknown[]) => {
        if (typeof args[0] === 'string') {
          handlers.set(args[0], args.at(-1) as (a: Record<string, unknown>) => Promise<unknown>);
        }
      },
    } as never);

    try {
      await handlers.get('get_budget_month')!({ month: '2026-01', budget_id: 'bud-b' });

      expect(counted).toBe(1);
      expect(inFlightCount()).toBe(0);
    } finally {
      usePool(undefined);
      delete process.env.ACTUAL_BUDGET_ID;
      delete process.env.ACTUAL_BUDGET_IDS;
    }
  }, 30_000);

  it('puts the resources through it too', async () => {
    // They are registered in their own file and were left out: a resource
    // read is the same read, against the same budget.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      fileURLToPath(new URL('../../resources.ts', import.meta.url)),
      'utf8',
    );

    expect(source).toContain('withInFlight(withReadSync(');
  });
});
