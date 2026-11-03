import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  utils: {
    amountToInteger: (a: number, places = 2) => Math.round(a * Math.pow(10, places)),
    integerToAmount: (c: number, places = 2) => c / Math.pow(10, places),
  },
}));
vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
  getInternal: vi.fn(),
}));

import { registerAllTools } from '../index.js';
import { withBudgetId } from '../../utils/budget-id.js';

const VARS = ['ACTUAL_BUDGET_ID', 'ACTUAL_BUDGET_IDS'];

/** The shapes every tool was registered with. */
function shapes(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  registerAllTools({
    tool: (name: string, _description: string, shape: Record<string, unknown>) => {
      found.set(name, Object.keys(shape ?? {}));
    },
  } as never);
  return found;
}

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
  isError?: boolean;
}>;

/** One tool, wrapped the way registration wraps it. */
function wrapped(seen: Record<string, unknown>[], many = true): Handler {
  let handler: Handler | undefined;
  const server = withBudgetId(
    {
      tool: (...args: unknown[]) => {
        handler = args.at(-1) as Handler;
      },
    } as never,
    many,
  );
  (server as { tool: (...args: unknown[]) => unknown }).tool(
    'pretend',
    'a tool',
    {},
    { title: 'x' },
    async (args: Record<string, unknown>) => {
      seen.push(args);
      return { content: [{ text: 'done' }] };
    },
  );
  return handler as Handler;
}

/**
 * Which budget a call is for (#229).
 *
 * The parameter exists when there is something to choose and not otherwise,
 * because it is about a hundred bytes on each of forty-five tools and
 * nobody with one budget should pay for a choice they do not have.
 */
describe('the budget a call names', () => {
  afterEach(() => {
    for (const name of VARS) delete process.env[name];
  });

  it('is not asked for at all when there is one budget', () => {
    process.env.ACTUAL_BUDGET_ID = 'sync-one';

    for (const [name, keys] of shapes()) {
      expect(keys, name).not.toContain('budget_id');
    }
  });

  it('is offered by every tool when there is more than one', () => {
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    process.env.ACTUAL_BUDGET_IDS = 'sync-one,sync-two';

    const all = shapes();
    expect(all.size).toBeGreaterThan(40);
    for (const [name, keys] of all) {
      expect(keys, name).toContain('budget_id');
    }
  });

  it('never reaches the tool it was passed to', () => {
    // The tools know nothing about it, which is what lets this be one
    // wrapper rather than forty-five edits.
    const seen: Record<string, unknown>[] = [];
    process.env.ACTUAL_BUDGET_ID = 'sync-one';

    return wrapped(seen)({ budget_id: 'sync-one', month: '2026-01' }).then(() => {
      expect(seen).toEqual([{ month: '2026-01' }]);
    });
  });

  it('refuses a budget this server does not serve, before the tool runs', async () => {
    const seen: Record<string, unknown>[] = [];
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    process.env.ACTUAL_BUDGET_IDS = 'sync-one,sync-two';

    const reply = await wrapped(seen)({ budget_id: 'sync-nine' });

    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain('sync-nine');
    expect(seen).toEqual([]);
  });

  it('refuses one it serves but cannot open yet, and says which it has', async () => {
    const seen: Record<string, unknown>[] = [];
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    process.env.ACTUAL_BUDGET_IDS = 'sync-one,sync-two';

    const reply = await wrapped(seen)({ budget_id: 'sync-two' });

    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain('one budget at a time');
    expect(seen).toEqual([]);
  });

  it('lets a call through when it names the budget that is open', async () => {
    const seen: Record<string, unknown>[] = [];
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    process.env.ACTUAL_BUDGET_IDS = 'sync-one,sync-two';

    const reply = await wrapped(seen)({ budget_id: 'sync-one' });

    expect(reply.isError).toBeUndefined();
    expect(seen).toHaveLength(1);
  });

  it('lets a call through when it names no budget at all', async () => {
    const seen: Record<string, unknown>[] = [];
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    process.env.ACTUAL_BUDGET_IDS = 'sync-one,sync-two';

    await wrapped(seen)({});

    expect(seen).toEqual([{}]);
  });
});
