import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actual-app/api')>();
  return { ...actual, sync: vi.fn().mockResolvedValue(undefined) };
});

// `get_rules` reads through the public API, so this is all it needs. The
// schedules are created straight from the harness, which hands out the
// engine's own handlers.
vi.mock('../../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
}));

import { initTestEngine, shutdownTestEngine, createFreshBudget, api, testInternal } from './actual-engine.js';
import { registerGetRules } from '../../read/get-rules.js';

const skip = process.env.SKIP_ACTUAL_INTEGRATION === '1';

type Handler = () => Promise<{ content: Array<{ type: string; text: string }> }>;

function handlerFor(): Handler {
  let handler: Handler | undefined;
  registerGetRules({
    tool: (...a: unknown[]) => {
      handler = a.at(-1) as Handler;
    },
  } as never);
  return handler as Handler;
}

/**
 * Listing the rules Actual writes for a schedule (#182).
 *
 * Every schedule in a budget has one, and all three of its interesting parts
 * came out unreadable: the recurrence as `[object Object]`, the amount as the
 * integer the engine stores, and the link as the schedule's id with the
 * operation printed twice. Nothing was wrong with the rules themselves, which
 * is why it survived two releases: the tool that exists to let someone check
 * their rules was the only thing affected.
 *
 * Written against real schedules rather than hand-made rule rows, because the
 * shapes are the engine's and every one of them was found by measuring.
 */
describe.skipIf(skip)('listing a schedule rule (#182)', () => {
  let accountId = '';
  let payeeId = '';

  beforeAll(async () => {
    await initTestEngine();
    await createFreshBudget(async () => {
      accountId = (await api.createAccount({ name: 'Checking', offbudget: false } as never, 0)) as string;
      payeeId = (await api.createPayee({ name: 'Landlord' } as never)) as string;
    }, 'schedule-rules');

    // A named monthly schedule, as the app writes one.
    await testInternal().send('schedule/create' as never, {
      schedule: { name: 'Rent', posts_transaction: false },
      conditions: [
        { op: 'is', field: 'account', value: accountId },
        { op: 'is', field: 'payee', value: payeeId },
        {
          op: 'isapprox',
          field: 'date',
          value: {
            start: '2026-11-01',
            frequency: 'monthly',
            patterns: [],
            skipWeekend: false,
            weekendSolveMode: 'after',
            endMode: 'never',
            endOccurrences: 1,
            endDate: '2026-11-01',
          },
        },
        { op: 'is', field: 'amount', value: -450000 },
      ],
    } as never);

    // One with no name, which is what the app creates unless you type one,
    // every two weeks and with a range for the amount. It carries a pattern
    // the engine ignores on a weekly, which is ordinary: the app's picker
    // opens on monthly and leaves the pattern behind when you switch to
    // weeks. 2026-11-06 is a Friday, and this falls every other Friday
    // whatever the pattern says.
    await testInternal().send('schedule/create' as never, {
      schedule: { posts_transaction: true },
      conditions: [
        { op: 'is', field: 'account', value: accountId },
        {
          op: 'isapprox',
          field: 'date',
          value: {
            start: '2026-11-06',
            frequency: 'weekly',
            interval: 2,
            patterns: [{ type: 'day', value: 12 }],
            skipWeekend: true,
            weekendSolveMode: 'before',
            endMode: 'after_n_occurrences',
            endOccurrences: 10,
            endDate: '2027-11-06',
          },
        },
        { op: 'isbetween', field: 'amount', value: { num1: -200000, num2: -100000 } },
      ],
    } as never);

    // A monthly one, where patterns are what the engine goes by, and an
    // amount condition with the direction stored beside it.
    await testInternal().send('schedule/create' as never, {
      schedule: { name: 'Card payment', posts_transaction: false },
      conditions: [
        { op: 'is', field: 'account', value: accountId },
        {
          op: 'isapprox',
          field: 'date',
          value: {
            start: '2026-11-01',
            frequency: 'monthly',
            patterns: [
              { type: 'day', value: 15 },
              { type: 'day', value: -1 },
            ],
            skipWeekend: false,
            weekendSolveMode: 'after',
            endMode: 'never',
            endOccurrences: 1,
            endDate: '2026-11-01',
          },
        },
        { op: 'gte', field: 'amount', value: 450000, options: { outflow: true } },
      ],
    } as never);
  }, 60_000);

  afterAll(async () => {
    await shutdownTestEngine();
  });

  async function listing(): Promise<string> {
    const reply = await handlerFor()();
    return reply.content[0].text;
  }

  it('says when the schedule runs instead of [object Object]', async () => {
    const text = await listing();
    expect(text).not.toContain('[object Object]');
    expect(text).toContain('IF date isapprox every month, from 2026-11-01');
  });

  it('describes a weekly by the day it falls on, not by a pattern it ignores', async () => {
    // This asked for "the last Friday" before, which was a sentence about a
    // pattern the engine does not read on a weekly schedule. It passed only
    // because 2026-11-06 happens to be a Friday. Measured through
    // `get-upcoming-dates`, a weekly repeats its start and nothing else.
    const text = await listing();
    expect(text).toContain(
      'every 2 weeks on Friday, from 2026-11-06, 10 times, weekends moved earlier',
    );
    expect(text, 'the stored pattern says the 12th and nothing happens on it').not.toContain(
      'day 12',
    );
  });

  it('reads the patterns of a monthly, in the order they happen', async () => {
    const text = await listing();
    expect(text).toContain('every month on the 15th and last day, from 2026-11-01');
  });

  it('says which direction an amount is compared in', async () => {
    // Stored positive with `outflow` beside it, so "amount gte 4,500.00"
    // reads as a rule about income when it is about spending.
    const text = await listing();
    expect(text).toContain('IF amount (outflow) gte 4,500.00');
  });

  it('shows an amount as an amount', async () => {
    const text = await listing();
    expect(text).toContain('IF amount is -4,500.00');
    expect(text, 'the raw integer should be gone').not.toContain('-450000');
  });

  it('shows both bounds of a range', async () => {
    const text = await listing();
    expect(text).toContain('IF amount isbetween -2,000.00 and -1,000.00');
  });

  it('names the schedule the rule links to, once', async () => {
    const text = await listing();
    expect(text).toContain('THEN link-schedule = "Rent"');
    expect(text, 'the operation was printed twice').not.toContain('link-schedule link-schedule');
  });

  it('falls back to the id for a schedule with no name', async () => {
    // Which is most of them: the app only stores a name if one was typed.
    // The id is no use to the reader, but inventing a name would be worse,
    // and the rule's own conditions say what it is for.
    const text = await listing();
    const links = [...text.matchAll(/THEN link-schedule = "([^"]+)"/g)].map((m) => m[1]);
    expect(links).toHaveLength(3);
    expect(links).toContain('Rent');
    expect(links).toContain('Card payment');
    const unnamed = links.find((l) => l !== 'Rent' && l !== 'Card payment')!;
    expect(unnamed).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('still reads the account and payee back as names', async () => {
    // The rest of the line keeps working: a schedule rule holds ids in the
    // same fields as any other rule.
    const text = await listing();
    expect(text).toContain('IF account is "Checking"');
    expect(text).toContain('IF payee is "Landlord"');
  });

  it('marks nothing on a rule Actual wrote itself', async () => {
    // A schedule rule is correct by construction, so a warning here would be
    // this tool crying wolf on every budget that has a schedule.
    const text = await listing();
    expect(text).not.toContain('warning:');
  });
});
