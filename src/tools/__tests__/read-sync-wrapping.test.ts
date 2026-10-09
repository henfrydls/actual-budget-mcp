import { describe, it, expect, vi, beforeEach } from 'vitest';

// Everything real except the engine. Stubbing `refreshBeforeRead` would not
// work anyway: mocking a module's export does not change the calls made inside
// that same module, so the wrapper would go on using its own. What is
// observable from outside is whether a sync happened, so that is what this
// asks about.
const sync = vi.fn();
vi.mock('@actual-app/api', () => ({
  sync: (...a: unknown[]) => sync(...a),
  getAccounts: vi.fn().mockResolvedValue([]),
  getCategoryGroups: vi.fn().mockResolvedValue([]),
  getCategories: vi.fn().mockResolvedValue([]),
  getPayees: vi.fn().mockResolvedValue([]),
  getAccountBalance: vi.fn().mockResolvedValue(0),
}));

// There is no Actual server here, so the real one would throw before anything
// could sync. What this file is about is which handlers got wrapped.
vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { registerAllTools } from '../index.js';
import { registerAllResources } from '../../resources.js';
import { resetSyncState } from '../../utils/read-sync.js';

interface Registered {
  name: string;
  readOnly: boolean;
  handler: (args: unknown) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

/**
 * Which tools get the sync, and what reaches the caller (#126).
 *
 * Wrapping happens where every tool is registered rather than in fifteen
 * files, so what has to be checked is that the wrapper picks the right ones
 * and passes everything else through untouched.
 */
function registerAndCollect(): Registered[] {
  const tools: Registered[] = [];
  const server = {
    tool: (...args: unknown[]) => {
      const annotations = args.find(
        (a): a is { readOnlyHint?: boolean } =>
          typeof a === 'object' && a !== null && 'readOnlyHint' in a,
      );
      tools.push({
        name: String(args[0]),
        readOnly: annotations?.readOnlyHint === true,
        handler: args[args.length - 1] as Registered['handler'],
      });
    },
  };
  registerAllTools(server as never);
  return tools;
}

describe('which tools sync before running', () => {
  beforeEach(() => {
    resetSyncState();
    sync.mockReset().mockResolvedValue(undefined);
  });

  it('registers both kinds, so the split is not vacuous', () => {
    const tools = registerAndCollect();

    expect(tools.filter((t) => t.readOnly).length).toBeGreaterThan(5);
    expect(tools.filter((t) => !t.readOnly).length).toBeGreaterThan(5);
  });

  it('syncs before a read tool runs', async () => {
    const tools = registerAndCollect();
    const read = tools.find((t) => t.name === 'get_transactions');

    expect(read, 'get_transactions is not registered').toBeDefined();
    await read!.handler({}).catch(() => undefined);

    expect(sync, 'a read should have pulled first').toHaveBeenCalled();
  });

  it('does not sync before a write tool', async () => {
    // Writes already pull where it matters, before the checks that decide
    // whether to write. A second round trip would buy the same answer twice.
    const tools = registerAndCollect();
    const write = tools.find((t) => t.name === 'create_transaction');

    expect(write, 'create_transaction is not registered').toBeDefined();
    await write!.handler({}).catch(() => undefined);

    expect(sync, 'a write should not pay for a second pull').not.toHaveBeenCalled();
  });

});

/**
 * The resources, against their real registration (#126, round 2).
 *
 * Wrapping them is a second call to `withReadSync`, in a second file, which is
 * exactly the kind of thing that gets added for one of the two and not the
 * other. So this asks the real `registerAllResources`, not a stand-in.
 */
describe('resources sync before answering', () => {
  beforeEach(() => {
    resetSyncState();
    sync.mockReset().mockResolvedValue(undefined);
  });

  const collect = () => {
    const handlers: Array<{ name: string; handler: () => Promise<unknown> }> = [];
    registerAllResources({
      // A real McpServer has both; the wrapper takes the server, not one method.
      tool: () => {},
      resource: (...args: unknown[]) => {
        handlers.push({
          name: String(args[0]),
          handler: args[args.length - 1] as () => Promise<unknown>,
        });
      },
    } as never);
    return handlers;
  };

  it('registers the ones this is about', () => {
    expect(collect().map((r) => r.name).sort()).toEqual(['accounts', 'categories', 'payees']);
  });

  it('pulls first, every one of them', async () => {
    for (const resource of collect()) {
      resetSyncState();
      sync.mockClear();

      await resource.handler().catch(() => undefined);

      expect(sync, `${resource.name} did not pull first`).toHaveBeenCalledTimes(1);
    }
  });
});
