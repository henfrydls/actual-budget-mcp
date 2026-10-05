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

function parse(file: string): Parsed {
  const source = readFileSync(`src/tools/write/${file}`, 'utf8');
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
function usesQueue(file: string): boolean {
  return parse(file).queued.length > 0;
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
function handlerReachesQueue(file: string): boolean {
  const p = parse(file);
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
const DECIDING_READS = ['findPossibleDuplicates', 'pullBeforeReading', 'runQuery'];

function readsOutsideQueue(file: string): string[] {
  const p = parse(file);
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

  it('would notice a read left outside, so the check is not vacuous', () => {
    // The guard above passes when nobody does the thing it forbids, which is
    // indistinguishable from a guard that cannot see it. This is the shape it
    // is meant to catch, checked directly.
    const offending = `
      import { queueTransactionWrite } from '../../utils/transaction-writes.js';
      async function handler() {
        const existing = await findPossibleDuplicates(a, b, c);
        if (existing.length > 0) return 'already exists';
        return await queueTransactionWrite(() => write());
      }
    `;
    const parsed = ts.createSourceFile('x.ts', offending, ts.ScriptTarget.ES2022, true);
    let queueStart = -1;
    let readPos = -1;
    const walk = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        if (node.expression.text === 'queueTransactionWrite') queueStart = node.getStart(parsed);
        if (node.expression.text === 'findPossibleDuplicates') readPos = node.getStart(parsed);
      }
      ts.forEachChild(node, walk);
    };
    ts.forEachChild(parsed, walk);
    expect(readPos).toBeGreaterThan(-1);
    expect(queueStart).toBeGreaterThan(-1);
    // Outside: the read comes before the queue call even opens.
    expect(readPos).toBeLessThan(queueStart);
  });

  for (const [file, reason] of [...NOT_QUEUED].sort()) {
    it(`${file} stays out of the queue: ${reason}`, () => {
      expect(usesQueue(file)).toBe(false);
    });
  }
});
