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

/** True when the module calls `queueTransactionWrite` anywhere in it. */
function usesQueue(file: string): boolean {
  const source = readFileSync(`src/tools/write/${file}`, 'utf8');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
  let found = false;
  // Parsed rather than searched: a mention in a comment is not a call, which
  // is the mistake the scanner in #110 made.
  const walk = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'queueTransactionWrite'
    ) {
      found = true;
    }
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(parsed, walk);
  return found;
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
  }

  for (const [file, reason] of [...NOT_QUEUED].sort()) {
    it(`${file} stays out of the queue: ${reason}`, () => {
      expect(usesQueue(file)).toBe(false);
    });
  }
});
