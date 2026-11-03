import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

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
import { usePool } from '../../workers/current.js';
import type { ToolCall } from '../../workers/pool.js';

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

/** What the pool was asked to do. */
const routed: Array<{ budgetId: string; call: ToolCall }> = [];

function fakePool(): void {
  usePool({
    call: async (budgetId: string, call: ToolCall) => {
      routed.push({ budgetId, call });
      return { content: [{ type: 'text', text: `answered by ${budgetId}` }] };
    },
    openBudgets: () => [],
    stop: async () => undefined,
  } as never);
}

/** One tool, wrapped the way registration wraps it. */
function wrapped(
  ranHere: Record<string, unknown>[],
  options: { many?: boolean; name?: string } = {},
): Handler {
  let handler: Handler | undefined;
  const server = withBudgetId(
    {
      tool: (...args: unknown[]) => {
        handler = args.at(-1) as Handler;
      },
    } as never,
    options.many ?? true,
  );
  (server as { tool: (...args: unknown[]) => unknown }).tool(
    options.name ?? 'get_budget_month',
    'a read',
    {},
    { title: 'x', readOnlyHint: true },
    async (args: Record<string, unknown>) => {
      ranHere.push(args);
      return { content: [{ type: 'text', text: 'ran here' }] };
    },
  );
  return handler as Handler;
}

/**
 * Which budget a call is for, and who answers it (#229).
 *
 * The parameter exists when there is something to choose and not otherwise,
 * because it is about a hundred bytes on each of forty-five tools and
 * nobody with one budget should pay for a choice they do not have. When it
 * does exist, every call is routed: the front end opens no budget, so there
 * is no third path where it half-answers from one of its own.
 */
describe('the budget a call names', () => {
  beforeEach(() => {
    routed.length = 0;
    fakePool();
  });

  afterEach(() => {
    for (const name of VARS) delete process.env[name];
    usePool(undefined);
  });

  it('is not asked for at all when there is one budget', () => {
    process.env.ACTUAL_BUDGET_ID = 'sync-one';

    for (const [name, keys] of shapes()) {
      expect(keys, name).not.toContain('budget_id');
    }
  });

  it('is offered by every tool that is about a budget', () => {
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    process.env.ACTUAL_BUDGET_IDS = 'sync-one,sync-two';

    const all = shapes();
    expect(all.size).toBeGreaterThan(40);
    for (const [name, keys] of all) {
      if (name === 'list_budgets') continue;
      expect(keys, name).toContain('budget_id');
    }
  });

  it('is not asked of the tool that is about the server itself', async () => {
    // `list_budgets` has no budget to take an id for, and no worker to ask
    // either: a worker holds one budget and does not know the others exist.
    // Measured against two real budgets over HTTP, routed like the rest, it
    // came back `Tool list_budgets not found`.
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    process.env.ACTUAL_BUDGET_IDS = 'sync-one,sync-two';
    const ranHere: Record<string, unknown>[] = [];

    expect(shapes().get('list_budgets')).not.toContain('budget_id');

    const reply = await wrapped(ranHere, { name: 'list_budgets' })({});

    expect(routed).toEqual([]);
    expect(ranHere).toEqual([{}]);
    expect(reply.content[0].text).toContain('ran here');
  });

  it('goes to the worker for the budget it names, without the argument', async () => {
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    process.env.ACTUAL_BUDGET_IDS = 'sync-one,sync-two';
    const ranHere: Record<string, unknown>[] = [];

    const reply = await wrapped(ranHere)({ budget_id: 'sync-two', month: '2026-01' });

    expect(routed).toEqual([
      {
        budgetId: 'sync-two',
        call: { name: 'get_budget_month', arguments: { month: '2026-01' }, readOnly: true },
      },
    ]);
    // The tool does not run in this process at all: it runs in the worker.
    expect(ranHere).toEqual([]);
    expect(reply.content[0].text).toContain('sync-two');
  });

  it('goes to the configured default when it names none', async () => {
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    process.env.ACTUAL_BUDGET_IDS = 'sync-one,sync-two';

    await wrapped([])({});

    expect(routed[0].budgetId).toBe('sync-one');
  });

  it('carries whether repeating the call is free', async () => {
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    process.env.ACTUAL_BUDGET_IDS = 'sync-one,sync-two';

    let handler: Handler | undefined;
    const server = withBudgetId(
      { tool: (...args: unknown[]) => (handler = args.at(-1) as Handler) } as never,
      true,
    );
    (server as { tool: (...args: unknown[]) => unknown }).tool(
      'create_transaction',
      'a write',
      {},
      { title: 'x' },
      async () => ({ content: [{ text: 'done' }] }),
    );
    await (handler as Handler)({});

    // A write that a worker loses cannot be repeated by anyone but a person
    // who has looked, which is what this flag decides.
    expect(routed[0].call.readOnly).toBe(false);
  });

  it('refuses a budget this server does not serve, and sends nothing', async () => {
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    process.env.ACTUAL_BUDGET_IDS = 'sync-one,sync-two';
    const ranHere: Record<string, unknown>[] = [];

    const reply = await wrapped(ranHere)({ budget_id: 'sync-nine' });

    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain('sync-nine');
    expect(routed).toEqual([]);
    expect(ranHere).toEqual([]);
  });

  it('says so rather than guessing when it has more than one budget and no workers', async () => {
    process.env.ACTUAL_BUDGET_ID = 'sync-one';
    process.env.ACTUAL_BUDGET_IDS = 'sync-one,sync-two';
    usePool(undefined);
    const ranHere: Record<string, unknown>[] = [];

    const reply = await wrapped(ranHere)({});

    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain('Nothing was read or written');
    // Not from whichever budget this process happens to hold.
    expect(ranHere).toEqual([]);
  });
});
