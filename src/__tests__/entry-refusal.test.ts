import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * What the entry point does with an address it cannot use (#275).
 *
 * The first line of defence, so it is checked by running it rather than by
 * reading it: the whole refusal could be deleted and every other test here
 * stayed green.
 */

const connect = vi.fn().mockResolvedValue(undefined);
const StdioServerTransport = vi.fn();
const ensureConnection = vi.fn().mockResolvedValue(undefined);

vi.mock('dotenv/config', () => ({}));
vi.mock('../utils/http-timeout.js', () => ({}));
vi.mock('@actual-app/api', () => ({
  default: {},
  getAccounts: vi.fn().mockResolvedValue([]),
  getCategoryGroups: vi.fn().mockResolvedValue([]),
  utils: {
    amountToInteger: (a: number) => Math.round(a * 100),
    integerToAmount: (c: number) => c / 100,
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    tool() {}
    prompt() {}
    resource() {}
    connect(...a: unknown[]) {
      return connect(...a);
    }
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {
    constructor() {
      StdioServerTransport();
    }
  },
}));
vi.mock('../tools/index.js', () => ({ registerAllTools: vi.fn(), offeredTools: () => new Set() }));
vi.mock('../prompts.js', () => ({ registerAllPrompts: vi.fn() }));
vi.mock('../resources.js', () => ({ registerAllResources: vi.fn() }));
vi.mock('../connection.js', () => ({
  ensureConnection: (...a: unknown[]) => ensureConnection(...a),
  connectionSettled: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getInternal: vi.fn(),
}));
vi.mock('../utils/orderly-exit.js', () => ({
  installExitPaths: vi.fn(),
  EXIT_GRACE_MS: 1,
  EXIT_IN_FLIGHT_MS: 1,
}));
vi.mock('../utils/native-binding.js', () => ({
  ensureNativeBinding: () => ({ status: 'mocked', detail: '' }),
}));
vi.mock('../utils/runtime-check.js', () => ({ assertSupportedRuntime: () => undefined }));

/** Stops the module the way `process.exit` stops a process. */
class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

async function runEntry(): Promise<{ exit?: number; said: string }> {
  vi.resetModules();
  const lines: string[] = [];
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Exited(code ?? 0);
  }) as never);
  const quiet = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    await import('../index.js');
    return { said: lines.join('\n') };
  } catch (error) {
    if (error instanceof Exited) return { exit: error.code, said: lines.join('\n') };
    throw error;
  } finally {
    exit.mockRestore();
    quiet.mockRestore();
  }
}

describe('the entry point and the server address', () => {
  beforeEach(() => {
    process.env.ACTUAL_BUDGET_ID = 'budget-1';
    StdioServerTransport.mockClear();
  });

  afterEach(() => {
    delete process.env.ACTUAL_SERVER_URL;
    delete process.env.ACTUAL_BUDGET_ID;
  });

  it('refuses to start when the address carries credentials', async () => {
    process.env.ACTUAL_SERVER_URL = 'http://user:hunter2@actual.example:5006';

    const { exit, said } = await runEntry();

    expect(exit).toBe(1);
    expect(StdioServerTransport).not.toHaveBeenCalled();
    expect(said).toContain('cannot work');
    expect(said).not.toContain('hunter2');
  });

  it('refuses to start when the address does not parse, and repeats none of it', async () => {
    process.env.ACTUAL_SERVER_URL = 'http://user:hunter2/two@203.0.113.9:5006';

    const { exit, said } = await runEntry();

    expect(exit).toBe(1);
    expect(said).toContain('not a URL this can read');
    expect(said).not.toContain('hunter2');
    expect(said).not.toContain('203.0.113.9');
  });

  it('starts on an ordinary address', async () => {
    process.env.ACTUAL_SERVER_URL = 'http://127.0.0.1:5006';

    const { exit } = await runEntry();

    expect(exit).toBeUndefined();
    expect(StdioServerTransport).toHaveBeenCalled();
  });
});
