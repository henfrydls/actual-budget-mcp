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
}));

import { registerAllTools } from '../index.js';
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
