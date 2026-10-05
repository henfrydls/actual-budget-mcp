import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';

/**
 * Every tool that changes the transactions table goes through one queue (#111).
 *
 * That sentence is in the pull request, in `transaction-writes.ts` and in each
 * handler's comment, and when it was first written it was not true: two audits
 * found `run_bank_sync` outside the queue independently of each other, and one
 * of them found three more. Three of the eight handlers had a test; removing
 * the queue from the others killed nothing.
 *
 * So the claim is checked against the directory rather than against memory. A
 * new tool in `src/tools/write/` fails this until someone says which side it is
 * on, which is the point: the decision is easy to make and easy to forget.
 */

/** Writes rows to the transactions table, directly or through the engine. */
const QUEUED = new Set([
  'create-transaction.ts',
  'create-transactions.ts',
  'create-split-transaction.ts',
  'create-transfer.ts',
  'update-transaction.ts',
  'delete-transaction.ts',
  'recategorize-transaction.ts',
  'reconcile-currency-residual.ts',
  // Imports rows from the bank: a create running beside it checks for
  // duplicates against a table being filled underneath it.
  'run-bank-sync.ts',
  // Closing an account moves or deletes its transactions.
  'delete-account.ts',
  // With `transfer_to`, recategorises rows in bulk.
  'delete-category.ts',
  // Rewrites the transactions that referenced the payee.
  'delete-payee.ts',
  // `deleteCategoryGroup(groupId, transferId)` moves every transaction of
  // every category in the group.
  'delete-category-group.ts',
]);

/** Does not touch the transactions table, with the reason it does not. */
const NOT_QUEUED = new Map([
  ['create-account.ts', 'creates an account; its opening balance goes through the engine'],
  ['create-category.ts', 'categories only'],
  ['create-category-group.ts', 'groups only'],
  ['create-payee.ts', 'payees only'],
  ['create-rule.ts', 'rules only, applied later'],
  ['delete-rule.ts', 'rules only'],
  ['update-account.ts', 'renames an account; measured not to touch its rows (#87)'],
  ['update-category.ts', 'category fields only'],
  ['update-category-group.ts', 'group fields only'],
  ['update-payee.ts', 'payee fields only'],
  ['update-budget-amount.ts', 'budget figures; has its own queue for its own race (#121)'],
  ['transfer-between-categories.ts', 'budget figures only, creates no transaction (#86)'],
  ['repair-sync.ts', 'rebuilds sync bookkeeping, not budget data'],
]);

/**
 * What this check cannot see, measured rather than guessed.
 *
 * It works on names and on syntactic scope, so an audit got all of these past
 * it with the whole suite green:
 *
 *   the queue call inside `if (false)`        syntactically present, never run
 *   a local function named `queueTransactionWrite`, or an import of that
 *     name from somewhere else                the name is all it matches on
 *   a helper called both inside the queue and outside it
 *                                             following calls marks the body
 *                                             as covered, so the call outside
 *                                             stops being visible
 *
 * And one false positive, which fails the safe way: a handler passed as a
 * variable rather than written inline at `server.tool` is not recognised as a
 * handler, so the file is reported as unqueued.
 *
 * None of these are defended against, on purpose. Each needs more analysis
 * than the thing is worth, and all of them are deliberate acts rather than the
 * mistake this exists for, which is someone adding a write tool and not
 * thinking about the queue at all. What covers the rest is the integration
 * tests: the helper case was caught by one of those and by nothing here.
 */

/** The pieces of a module this check reasons about, parsed once. */
interface Parsed {
  file: ts.SourceFile;
  /** Module-level functions by name, so a call can be followed into one. */
  functions: Map<string, [number, number]>;
  calls: Array<{ name: string; pos: number; line: number }>;
  /** `queueTransactionWrite(...)` call ranges. */
  queued: Array<[number, number]>;
  /** The last argument of each `server.tool(...)`: the handler itself. */
  handlers: Array<[number, number]>;
}

function parse(file: string, given?: string): Parsed {
  const source = given ?? readFileSync(`src/tools/write/${file}`, 'utf8');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
  const functions = new Map<string, [number, number]>();
  const calls: Parsed['calls'] = [];
  const queued: Array<[number, number]> = [];
  const handlers: Array<[number, number]> = [];

  const name = (node: ts.CallExpression): string | undefined => {
    const callee = node.expression;
    if (ts.isIdentifier(callee)) return callee.text;
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
    return undefined;
  };

  const walk = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      functions.set(node.name.text, [node.body.getStart(parsed), node.body.end]);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        functions.set(node.name.text, [init.getStart(parsed), init.end]);
      }
    }
    if (ts.isCallExpression(node)) {
      const called = name(node);
      const pos = node.getStart(parsed);
      if (called === 'queueTransactionWrite') queued.push([pos, node.end]);
      if (called === 'tool' && node.arguments.length > 0) {
        const handler = node.arguments[node.arguments.length - 1];
        handlers.push([handler.getStart(parsed), handler.end]);
      }
      if (called) {
        calls.push({ name: called, pos, line: parsed.getLineAndCharacterOfPosition(pos).line + 1 });
      }
    }
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(parsed, walk);
  return { file: parsed, functions, calls, queued, handlers };
}

/**
 * Grow a set of ranges by following calls into this module's own functions.
 *
 * Both checks below need it. Most of these handlers queue the handler and do
 * the work in an exported function underneath, so what matters is reachable
 * from a range rather than written inside it.
 */
function follow(p: Parsed, seed: Array<[number, number]>): (pos: number) => boolean {
  const ranges = [...seed];
  const covered = (pos: number) => ranges.some(([a, b]) => pos > a && pos < b);
  for (let grew = true; grew; ) {
    grew = false;
    for (const call of p.calls) {
      if (!covered(call.pos)) continue;
      const body = p.functions.get(call.name);
      if (body && !ranges.some(([a, b]) => a === body[0] && b === body[1])) {
        ranges.push(body);
        grew = true;
      }
    }
  }
  return covered;
}

/** True when the module calls `queueTransactionWrite` anywhere in it. */
function usesQueue(file: string, source?: string): boolean {
  return parse(file, source).queued.length > 0;
}

/**
 * True when the tool's own handler reaches the queue.
 *
 * Asking whether the module calls the queue is not enough, and an audit showed
 * it with a mutation worth remembering: take the queue off `update_transaction`
 * and add `void queueTransactionWrite(async () => undefined)` at module level.
 * The call is there, it even runs, it protects nothing, and the whole suite
 * stayed green. Ten of the thirteen queued tools have no behavioural test of
 * their own and rest on this check alone, so the check has to be about the
 * handler and not about the file.
 */
function handlerReachesQueue(file: string, source?: string): boolean {
  const p = parse(file, source);
  if (p.handlers.length === 0 || p.queued.length === 0) return false;
  const reachable = follow(p, p.handlers);
  return p.queued.some(([start]) => reachable(start));
}

/**
 * The reads a write depends on, which have to be inside the queue with it.
 *
 * `create_transactions` called the queue, passed the check above, and still had
 * the gap: its queue opened around the write alone, so the duplicate checks ran
 * outside it and an audit reproduced the original #111 failure against it — a
 * delete removing the row the batch was checking, and the batch refusing every
 * row it had been given.
 */
const DECIDING_READS = [
  'findPossibleDuplicates',
  'pullBeforeReading',
  'runQuery',
  // Resolving a name is a read of the budget too, and the write depends on
  // what it found. `create_transactions` loaded these before its queue, so a
  // `delete_account` running first left it holding an id that had stopped
  // existing: measured, the row went in with `account: null`, invisible in
  // every account view, and the tool reported `Created 1 transaction.`
  'getAccounts',
  'getCategories',
];

function readsOutsideQueue(file: string, source?: string): string[] {
  const p = parse(file, source);
  const inside = follow(p, p.queued);
  return p.calls
    .filter((c) => DECIDING_READS.includes(c.name) && !inside(c.pos))
    .map((c) => `${c.name}() at line ${c.line}`);
}

describe('the transaction-write queue covers what it claims', () => {
  const files = readdirSync('src/tools/write').filter((f) => f.endsWith('.ts'));

  it('has every write tool on one list or the other', () => {
    const unclassified = files.filter((f) => !QUEUED.has(f) && !NOT_QUEUED.has(f));
    expect(
      unclassified,
      'a new write tool must be declared as queued or not, with a reason',
    ).toEqual([]);
  });

  it('found the tools at all, so the lists are not checking nothing', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of [...QUEUED].sort()) {
    it(`${file} goes through the queue`, () => {
      expect(usesQueue(file)).toBe(true);
    });

    it(`${file} queues the handler, not just something in the file`, () => {
      expect(
        handlerReachesQueue(file),
        'the queue has to be reachable from the tool handler: a call somewhere ' +
          'else in the module protects nothing',
      ).toBe(true);
    });

    it(`${file} reads the table inside the queue, not before it`, () => {
      expect(
        readsOutsideQueue(file),
        'a read that decides whether to write has to be inside the queue, ' +
          'or another call can change the table between the two',
      ).toEqual([]);
    });
  }

  describe('the checks above can see an offence when there is one', () => {
    // The first version of this re-implemented the walk over a fixture and
    // asserted about its own result, so it never called the guard: making
    // `readsOutsideQueue` return `[]` and `handlerReachesQueue` return `true`
    // left all of it green. It passes the fixtures to the real functions now.
    const good = `
      import { queueTransactionWrite } from '../../utils/transaction-writes.js';
      export function register(server) {
        server.tool('t', 'd', {}, {}, async (input) =>
          queueTransactionWrite(async () => {
            const existing = await findPossibleDuplicates(a, b, c);
            return existing.length > 0 ? 'already exists' : await write();
          }),
        );
      }
    `;

    it('passes the shape it is meant to allow', () => {
      expect(readsOutsideQueue('fixture.ts', good)).toEqual([]);
      expect(handlerReachesQueue('fixture.ts', good)).toBe(true);
    });

    it('names a read left outside the queue', () => {
      const offending = `
        import { queueTransactionWrite } from '../../utils/transaction-writes.js';
        export function register(server) {
          server.tool('t', 'd', {}, {}, async (input) => {
            const existing = await findPossibleDuplicates(a, b, c);
            if (existing.length > 0) return 'already exists';
            return await queueTransactionWrite(() => write());
          });
        }
      `;
      expect(readsOutsideQueue('fixture.ts', offending)).toEqual([
        'findPossibleDuplicates() at line 5',
      ]);
    });

    it('names resolution left outside the queue', () => {
      // The shape `create_transactions` actually had: names resolved before
      // the queue, so a delete running first invalidated them.
      const offending = `
        import { queueTransactionWrite } from '../../utils/transaction-writes.js';
        export function register(server) {
          server.tool('t', 'd', {}, {}, async (input) => {
            const accounts = await api.getAccounts();
            return await queueTransactionWrite(() => write(accounts));
          });
        }
      `;
      expect(readsOutsideQueue('fixture.ts', offending)).toEqual(['getAccounts() at line 5']);
    });

    it('refuses a queue call the handler cannot reach', () => {
      // The audit's mutation: the handler does the work unqueued and a dead
      // call at module level keeps the name in the file.
      const offending = `
        import { queueTransactionWrite } from '../../utils/transaction-writes.js';
        void queueTransactionWrite(async () => undefined);
        export function register(server) {
          server.tool('t', 'd', {}, {}, async (input) => await write());
        }
      `;
      // The module does mention it, which is exactly why the weaker check passed.
      expect(usesQueue('fixture.ts', offending)).toBe(true);
      expect(handlerReachesQueue('fixture.ts', offending)).toBe(false);
    });

    it('follows the queue through a function the handler calls', () => {
      // Most of these tools are written this way, and a check that did not
      // follow calls would report every one of them as an offence.
      const indirect = `
        import { queueTransactionWrite } from '../../utils/transaction-writes.js';
        export async function doIt() {
          return await queueTransactionWrite(async () => await write());
        }
        export function register(server) {
          server.tool('t', 'd', {}, {}, async (input) => await doIt());
        }
      `;
      expect(handlerReachesQueue('fixture.ts', indirect)).toBe(true);
    });
  });

  for (const [file, reason] of [...NOT_QUEUED].sort()) {
    it(`${file} stays out of the queue: ${reason}`, () => {
      expect(usesQueue(file)).toBe(false);
    });
  }
});
