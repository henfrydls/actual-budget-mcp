import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('@actual-app/api', () => ({
  default: {},
  utils: {
    amountToInteger: (a: number) => Math.round(a * 100),
    integerToAmount: (c: number) => c / 100,
  },
}));
vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
  getInternal: vi.fn(),
}));

import { registerAllTools } from '../index.js';
import { registerAllPrompts } from '../../prompts.js';

type Prompt = { name: string; text: string };

/** Register tools and prompts the way the entry point does, and read both. */
async function offered(env: Record<string, string>): Promise<{
  tools: string[];
  prompts: Prompt[];
}> {
  for (const key of ['ACTUAL_TOOLSET', 'ACTUAL_READ_ONLY']) delete process.env[key];
  Object.assign(process.env, env);

  const tools: string[] = [];
  registerAllTools({ tool: (name: string) => { tools.push(name); } } as never);

  const prompts: Prompt[] = [];
  const handlers: Array<{ name: string; run: (args: Record<string, unknown>) => Promise<unknown> }> = [];
  registerAllPrompts({
    prompt: (name: string, ...rest: unknown[]) => {
      handlers.push({ name, run: rest[rest.length - 1] as never });
    },
  } as never);

  for (const { name, run } of handlers) {
    const result = (await run({})) as { messages: Array<{ content: { text: string } }> };
    prompts.push({ name, text: result.messages.map((m) => m.content.text).join('\n') });
  }
  return { tools, prompts };
}

/**
 * A prompt is a script, and a script that names tools nobody has is broken
 * (#222).
 *
 * Each prompt here says "use get_budget_summary, then budget_vs_actual, then
 * tell me". With the chat toolset none of the analysis tools is offered, so
 * `prompts/list` answered with three prompts naming five tools `tools/list`
 * does not have.
 */
describe('the prompts and the tools they call', () => {
  afterEach(() => {
    delete process.env.ACTUAL_TOOLSET;
    delete process.env.ACTUAL_READ_ONLY;
  });

  it.each([
    ['everything', {}],
    ['the chat set', { ACTUAL_TOOLSET: 'chat' }],
    ['read-only', { ACTUAL_READ_ONLY: '1' }],
    ['the chat set, read-only', { ACTUAL_TOOLSET: 'chat', ACTUAL_READ_ONLY: '1' }],
  ])('offers no prompt that calls a tool it does not offer, with %s', async (_label, env) => {
    const { tools, prompts } = await offered(env);
    const available = new Set(tools);
    // Every tool name this server has, so the scan finds the ones a prompt
    // mentions rather than a list kept by hand here.
    const everyTool = new Set((await offered({})).tools);

    for (const prompt of prompts) {
      const named = [...everyTool].filter((tool) => prompt.text.includes(tool));
      expect(named.length, `${prompt.name} names no tool at all`).toBeGreaterThan(0);
      for (const tool of named) {
        expect(available.has(tool), `${prompt.name} calls ${tool}, which is not offered`).toBe(
          true,
        );
      }
    }
  });

  it('still offers all three when everything is offered', async () => {
    const { prompts } = await offered({});

    expect(prompts.map((p) => p.name).sort()).toEqual([
      'monthly-review',
      'spending-check',
      'spending-patterns',
    ]);
  });

  it('offers none of them with the chat set, because they are analysis', async () => {
    const { prompts } = await offered({ ACTUAL_TOOLSET: 'chat' });

    expect(prompts).toEqual([]);
  });

  it('registers the tools before the prompts, which is what makes this work', () => {
    // The prompts ask what was registered, and the record they ask is
    // overwritten by the tool registration, so the order is the wiring. Read
    // from the factory rather than run: building a server is cheap, but the
    // thing being checked is the order in the source, and in HTTP mode this
    // runs once per request (#228).
    const factory = readFileSync('src/mcp-server.ts', 'utf8');

    expect(factory.indexOf('registerAllTools(server')).toBeLessThan(
      factory.indexOf('registerAllPrompts(server)'),
    );
  });
});
