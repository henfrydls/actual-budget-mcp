import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.fn();
vi.mock('../../connection.js', () => ({ getInternal: () => ({ send }) }));

import { budgetCurrencyCode } from '../currency.js';

/**
 * Which preference store answers, and what happens when neither does.
 *
 * Each of these was a surviving mutation before it was a test: swapping the
 * order of the two stores, dropping the fallback, and having the `catch`
 * return a currency rather than nothing. All three are invisible on a budget
 * that has no currency set, which is every budget in the Dominican Republic,
 * so none of them would have been noticed by using the thing.
 */
describe('budgetCurrencyCode', () => {
  // Braces on purpose. `mockReset()` returns the mock, an arrow without them
  // returns it, and vitest calls whatever a hook returns as its teardown — so
  // the mock got invoked after the test, and the one that throws turned into
  // an unhandled rejection reported as a failure of the test that had passed.
  beforeEach(() => {
    send.mockReset();
  });

  it('prefers the synced store, which is the one the app writes to', async () => {
    // Both answer, with different values. Reversing the order is a mutation
    // that needs this to be caught: on a real budget the metadata store is
    // empty, so reversing it looks harmless until someone has written to both.
    send.mockImplementation(async (method: string) =>
      method === 'preferences/get'
        ? { defaultCurrencyCode: 'JPY' }
        : { defaultCurrencyCode: 'USD' },
    );
    expect(await budgetCurrencyCode()).toBe('JPY');
  });

  it('still falls back to the metadata store', async () => {
    // Some tooling writes with `save-prefs`, so an answer from either beats
    // none. Dropping the second attempt passes every other test here.
    send.mockImplementation(async (method: string) =>
      method === 'preferences/get' ? {} : { defaultCurrencyCode: 'KRW' },
    );
    expect(await budgetCurrencyCode()).toBe('KRW');
  });

  it('answers nothing when neither store has it', async () => {
    send.mockResolvedValue({});
    // Not `'USD'`, and not a guess. Nothing configured has to reach the engine
    // as nothing configured, so it applies its own fallback of two decimals.
    // Returning a currency here would format a budget in someone else's.
    expect(await budgetCurrencyCode()).toBeUndefined();
  });

  it('answers nothing when both stores throw, rather than guessing', async () => {
    // Thrown from the call, not `mockRejectedValue`: that builds the rejected
    // promise when the mock is configured, so it is unhandled for a moment and
    // this repository's own process guard (#39) sees it.
    send.mockImplementation(async () => {
      throw new Error('handler is not a function');
    });
    expect(await budgetCurrencyCode()).toBeUndefined();
  });

  it('treats an empty string as not configured', async () => {
    send.mockResolvedValue({ defaultCurrencyCode: '' });
    expect(await budgetCurrencyCode()).toBeUndefined();
  });

  it('asks the synced store first, in that order', async () => {
    // The order is the behaviour, so it is checked directly as well: a value
    // only in the first store proves preference, this proves sequence.
    send.mockResolvedValue({});
    await budgetCurrencyCode();
    expect(send.mock.calls.map((c) => c[0])).toEqual(['preferences/get', 'load-prefs']);
  });
});
