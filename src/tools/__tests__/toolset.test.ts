import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// As in read-only-mode.test.ts: importing the aggregator pulls in every tool
// module, and each one imports the SDK bundle. Counting registrations does
// not need it.
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
import { CHAT_TOOLS, chosenToolset, unrecognisedToolset } from '../../utils/toolset.js';

function registeredToolNames(): string[] {
  const names: string[] = [];
  registerAllTools({
    tool: (name: string) => {
      names.push(name);
    },
  } as never);
  return names;
}

/**
 * Tools that are not in the chat set, each with the reason.
 *
 * The same shape as the write-queue declaration, and for the same reason: a
 * tool added later has to be put on one side or the other, and the decision
 * is easy to make and easy to forget. The test below fails until it is on
 * one of the two lists.
 */
const NOT_IN_CHAT = new Map([
  // #138's two. Henfry chose set A, which is the everyday gestures; holding
  // money for next month and carrying a category's overspending are budget
  // mechanics a person sets up rather than things a conversation about the
  // month reaches for.
  ['hold_for_next_month', 'budget mechanics, set up rather than discussed'],
  ['set_category_carryover', 'budget mechanics, set up rather than discussed'],
  ['budget_vs_actual', 'analysis; the figures it compares are in get_budget_month'],
  ['spending_projection', 'analysis'],
  ['category_trends', 'analysis'],
  ['spending_by_category', 'analysis'],
  ['monthly_summary', 'analysis'],
  ['balance_history', 'analysis'],
  ['reconcile_account', 'reconciling against a statement, not an everyday question'],
  ['reconcile_currency_residual', 'repair, and one of the largest descriptions in the list'],
  ['repair_sync', 'repair'],
  ['get_rules', 'rules are set up once, not discussed'],
  ['create_rule', 'rules; the largest description in the list'],
  ['delete_rule', 'rules'],
  ['create_account', 'setting up a budget'],
  ['delete_account', 'setting up a budget'],
  ['update_account', 'setting up a budget'],
  ['create_category', 'setting up a budget'],
  ['update_category', 'setting up a budget'],
  ['delete_category', 'setting up a budget'],
  ['create_category_group', 'setting up a budget'],
  ['update_category_group', 'setting up a budget'],
  ['delete_category_group', 'setting up a budget'],
  ['create_payee', 'setting up a budget'],
  ['update_payee', 'setting up a budget'],
  ['delete_payee', 'setting up a budget'],
]);

describe('the chat toolset (#222)', () => {
  afterEach(() => {
    delete process.env.ACTUAL_TOOLSET;
    delete process.env.ACTUAL_READ_ONLY;
  });

  it('offers every tool when nothing is set', () => {
    expect(registeredToolNames().length).toBe(44);
    expect(chosenToolset()).toBe('full');
  });

  it('offers the everyday set and nothing else', () => {
    process.env.ACTUAL_TOOLSET = 'chat';
    const names = registeredToolNames();

    expect(names.length).toBe(18);
    expect([...names].sort()).toEqual([...CHAT_TOOLS].sort());
    // The ones a conversation about money actually reaches for.
    expect(names).toContain('get_transactions');
    expect(names).toContain('create_transaction');
    expect(names).toContain('transfer_between_categories');
    // And the ones it does not.
    expect(names).not.toContain('create_rule');
    expect(names).not.toContain('delete_account');
    expect(names).not.toContain('repair_sync');
  });

  it('puts every tool on one side or the other', () => {
    // The declaration this file exists for. A new tool fails here until
    // someone says whether it belongs in a conversation.
    const all = registeredToolNames();
    const undeclared = all.filter((name) => !CHAT_TOOLS.has(name) && !NOT_IN_CHAT.has(name));

    expect(undeclared, 'put these in CHAT_TOOLS or in NOT_IN_CHAT with a reason').toEqual([]);
    // And nothing declared twice, which would make the reason a lie.
    expect([...CHAT_TOOLS].filter((name) => NOT_IN_CHAT.has(name))).toEqual([]);
    // Nor a name on either list that no longer exists.
    expect([...CHAT_TOOLS].filter((name) => !all.includes(name))).toEqual([]);
    expect([...NOT_IN_CHAT.keys()].filter((name) => !all.includes(name))).toEqual([]);
  });

  it('narrows with read-only rather than fighting it', () => {
    process.env.ACTUAL_TOOLSET = 'chat';
    process.env.ACTUAL_READ_ONLY = '1';
    const names = registeredToolNames();

    expect(names.length).toBe(8);
    expect(names).toContain('get_budget_month');
    expect(names).not.toContain('create_transaction');
    expect(names).not.toContain('reconcile_account');
  });

  it('offers everything when the setting is not a set, and names it once', () => {
    process.env.ACTUAL_TOOLSET = 'everything please';

    expect(registeredToolNames().length).toBe(44);
    // Said by the entry point and nowhere else: asking at registration time
    // as well printed it twice, because both places ask the same question.
    expect(unrecognisedToolset()).toBe('everything please');
    const entry = readFileSync('src/index.ts', 'utf8');
    expect(entry).toContain('unrecognisedToolset()');
    expect(entry).toContain('which is not "chat" or ');
  });

  it('calls nothing unrecognised when the value is one of the two', () => {
    process.env.ACTUAL_TOOLSET = ' CHAT ';
    expect(unrecognisedToolset()).toBeUndefined();
    process.env.ACTUAL_TOOLSET = 'full';
    expect(unrecognisedToolset()).toBeUndefined();
    delete process.env.ACTUAL_TOOLSET;
    expect(unrecognisedToolset()).toBeUndefined();
  });

  it('reads the value the way the other settings are read', () => {
    process.env.ACTUAL_TOOLSET = '  CHAT  ';
    expect(chosenToolset()).toBe('chat');
    process.env.ACTUAL_TOOLSET = 'Full';
    expect(chosenToolset()).toBe('full');
  });
});
