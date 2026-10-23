import { describe, it, expect, vi, beforeEach } from 'vitest';

const ensureConnection = vi.fn();

vi.mock('@actual-app/api', () => ({
  getAccounts: vi.fn(),
  getCategoryGroups: vi.fn(),
  getCategories: vi.fn(),
  getPayees: vi.fn(),
  getAccountBalance: vi.fn(),
  utils: {
    amountToInteger: (a: number) => Math.round(a * 100),
    integerToAmount: (c: number) => c / 100,
  },
}));
vi.mock('../connection.js', () => ({
  ensureConnection: (...a: unknown[]) => ensureConnection(...a),
  getInternal: vi.fn(),
}));

import { registerAllResources } from '../resources.js';

type Reader = () => Promise<unknown>;

/** Every resource's read function, by name. */
function readers(): Map<string, Reader> {
  const found = new Map<string, Reader>();
  registerAllResources({
    // `tool` is here because the wrappers the resources go through are the
    // ones the tools go through, and they bind it on their way in.
    tool: () => undefined,
    resource: (name: string, _uri: unknown, _meta: unknown, read: Reader) => {
      found.set(name, read);
    },
  } as never);
  return found;
}

/**
 * What a resource says when it cannot be read (#275).
 *
 * These had no catch at all. The SDK serialises whatever is thrown, so the
 * one text in this server that never passed through `describeError` was the
 * one a resource failed with, and `ensureConnection` names the address it
 * could not reach. With credentials in that address, reading
 * `actual://accounts` answered with the password.
 */
describe('a resource that cannot be read', () => {
  beforeEach(() => {
    ensureConnection.mockReset();
  });

  it('describes the failure instead of handing the raw error over', async () => {
    ensureConnection.mockRejectedValue(
      new Error(
        'Could not reach the Actual Budget server at http://user:hunter2@actual.example:5006.',
      ),
    );

    for (const [name, read] of readers()) {
      const failure = await read().then(
        () => new Error('it should not have read anything'),
        (error: unknown) => error as Error,
      );

      expect(failure.message, name).toContain('actual.example:5006');
      expect(failure.message, name).not.toContain('hunter2');
    }
  });

  it('covers every resource this server offers', () => {
    // So that one added later is not left without the catch, which is how
    // this got through: the three were written before `describeError`
    // existed and nothing went back for them.
    expect([...readers().keys()].sort()).toEqual(['accounts', 'categories', 'payees']);
  });
});
