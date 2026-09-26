import ts from 'typescript';

/**
 * Find reads that a test issues before the write it is reading has landed.
 *
 * ## The behaviour
 *
 * A read issued too soon after an `updateTransaction` or a `deleteTransaction`
 * returns the state from before it. Measured against the engine, one variable
 * at a time:
 *
 *   delete, then read by AQL              the deleted row comes back
 *   delete, a few chained microtasks      still comes back
 *   delete, enough of them                gone
 *   delete, any other engine call         gone
 *   update, then read                     the old field value
 *   add, then read                        correct immediately
 *   delete, then read by getTransactions  already gone
 *
 * So it is a promise chain finishing rather than a turn of the event loop,
 * and it is the AQL path: `getTransactions` never showed it here.
 *
 * **How many microtasks is not a constant and should not be written down as
 * one.** Three versions of this note have given three answers. The first said
 * a microtask is never enough, from measuring exactly one. The second said
 * six, stable across two runs of one fixture. An audit measured four, on
 * another. Both are real: the count is however deep that operation's promise
 * chain happens to be, so it varies with what the call did. What is reliable
 * is the shape, not the number: a handful of microtasks, or any single call
 * into the engine.
 *
 * It is not reachable through the server's own tools, and not because of the
 * transport: two calls over the in-memory transport are separated by
 * microtasks only. What closes the window is that every write tool ends in
 * `api.sync()` and every tool begins by reading from the engine, and any
 * engine call closes it. Accidental safety, worth knowing as accidental.
 *
 * ## Why this parses instead of scanning
 *
 * The first version was a regex loop; the second a hand-written character
 * scanner. Both were defeated by ordinary code, and the scanner was **already
 * blind on this repository**: a regex literal containing an apostrophe, which
 * exists in `reconcile-currency-residual.integration.test.ts`, made it read the
 * rest of the file inside out, blanking real code and emitting string
 * contents. It reported nothing and said nothing, which is the failure this
 * guard exists to prevent, committed inside the guard.
 *
 * Telling a regex literal from a division needs a real lexer, so it uses the
 * one that is already a dependency. Parsing also removes the arbitrary window
 * of lines: a test body is a sequence of calls, and the question is simply
 * what comes between a write and the next read in that sequence.
 *
 * ## What it does not see, stated rather than discovered
 *
 * It is a heuristic about *which* calls write and read, and that list is
 * maintained by hand: a helper it has not been told about is invisible.
 *
 *  - **Branches.** `if (needsReload) await api.loadBudget(id)` counts as
 *    settled on the path where it does not run, and so does a settler in a
 *    dead branch or an untaken `else`.
 *  - **Hooks.** `beforeEach`, `beforeAll`, `afterEach` and `afterAll` are not
 *    scanned, and neither is `it.each`. Only `it` and `test` bodies are.
 *  - **Deferred callbacks.** Calls are ordered by where they appear, which
 *    stops being execution order once a callback runs later.
 *  - **Loops.** A body is read as a flat sequence, so a read at the top of a
 *    loop and a write at the bottom are not paired across iterations.
 *  - **A settler passed as an argument.** `await register(sleep(0))` counts as
 *    settling and does not, while `const p = sleep(0); await p;` does settle
 *    and is reported. Both follow from the same place, and it is the boundary
 *    of the method rather than a gap in it: `await Promise.all([sleep(0)])`,
 *    which genuinely waits, and `await register(sleep(0))`, which does not,
 *    are the same shape. Telling them apart means knowing what the function
 *    does with its argument, and that is not in the tree.
 *
 * None of these has a live instance in this repository, checked by scanning
 * it. They are written down because they will be silent when they do.
 */

const WRITE_NAMES = new Set([
  'deleteTransaction',
  'updateTransaction',
  'deleteTransactionGuarded',
  'updateTransactionFields',
  'updatePreservingChildAmount',
]);

const READ_NAMES = new Set([
  'runQuery',
  'getTransactions',
  'getAccountBalance',
  'rowsDatedAfterToday',
  'findPossibleDuplicates',
  // The read tool itself, used 31 times across the integration tests and
  // missing from the first list, which knew only the engine's own API.
  'getTransactionsReport',
]);

/**
 * Calls that give the write time to land, beyond any engine call.
 *
 * `setSystemTime` was here and should not have been: moving a fake clock
 * yields nothing and settles nothing. Whatever it was reasoned from, it was
 * not a measurement.
 */
const SETTLER_NAMES = new Set(['loadBudget', 'setTimeout', 'setImmediate', 'sleep']);

const CASE_NAMES = new Set(['it', 'test']);

export interface Offence {
  line: number;
  readLine: number;
}

/** The called name, whether written `a.b()`, `a['b']()` or `b()`. */
function calleeName(node: ts.CallExpression): string | undefined {
  const e = node.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e) && e.argumentExpression) {
    const arg = e.argumentExpression;
    if (ts.isStringLiteralLike(arg)) return arg.text;
  }
  return undefined;
}

/** True when the call is on the `api` object, however it is reached. */
function isOnApi(node: ts.CallExpression): boolean {
  const e = node.expression;
  const target =
    ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) ? e.expression : undefined;
  return !!target && ts.isIdentifier(target) && target.text === 'api';
}

/**
 * `deleteTransactionGuarded` writes only when told to.
 *
 * Reads the argument as a tree rather than matching braces, because a nested
 * object defeated the text version: `({ transaction_id: id, opts: { a: 1 } })`
 * was read as having no `confirm`.
 */
function guardedCallWrites(node: ts.CallExpression): boolean {
  const arg = node.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return true;
  return arg.properties.some(
    (p) => p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === 'confirm',
  );
}

type Kind = 'write' | 'read' | 'settle';

/**
 * Is this call inside something the test actually waits for?
 *
 * A settler that is never awaited settles nothing, and the detector was
 * matching the shape of the call rather than its execution. Measured as
 * accepted when they should not have been:
 *
 *   const wait = () => setTimeout(noop, 0);   declared, never run
 *   sleep(0);                                 called, not awaited
 *
 * `await new Promise((r) => setTimeout(r, 0))` is the real idiom, and there
 * the `setTimeout` sits inside a callback inside the awaited expression. A
 * first version stopped at every function boundary and rejected it; a second
 * crossed every boundary and accepted things that never run, such as a helper
 * that is declared and not called, or a callback handed to something the test
 * only awaits the result of. The boundary is crossed for exactly one shape:
 * the executor of a `new Promise` that the test awaits. That is the single
 * call site in this repository which needs it, against nineteen that use
 * `await api.loadBudget(...)`.
 *
 * The await has to be found on the way up to the test body and not merely
 * somewhere above the call: `const wait = async () => { await sleep(0); };`
 * has an await directly over the call, inside a function that is never
 * invoked. Noticing the boundary first, and the await only outside it, is
 * what tells those apart.
 */
function isAwaited(node: ts.Node, body: ts.Node): boolean {
  let seen = false;
  for (let n: ts.Node | undefined = node; n && n !== body; n = n.parent) {
    if (ts.isAwaitExpression(n)) { seen = true; continue; }
    if (ts.isFunctionLike(n) && n !== node) {
      // Crossing into a function body normally means the await belongs to
      // that function rather than to the test's sequence. The one exception
      // is the executor of a promise the test itself awaits, which is the
      // `await new Promise((r) => setTimeout(r, 0))` idiom.
      const parent: ts.Node | undefined = n.parent;
      if (
        parent &&
        ts.isNewExpression(parent) &&
        ts.isIdentifier(parent.expression) &&
        parent.expression.text === 'Promise'
      ) {
        n = parent;
        continue;
      }
      return false;
    }
  }
  return seen;
}

function classify(node: ts.CallExpression, body: ts.Node): Kind | undefined {
  const name = calleeName(node);
  if (!name) return undefined;

  if (WRITE_NAMES.has(name)) {
    if (name === 'deleteTransactionGuarded' && !guardedCallWrites(node)) return undefined;
    return 'write';
  }
  if (READ_NAMES.has(name)) return 'read';
  if (SETTLER_NAMES.has(name)) return isAwaited(node, body) ? 'settle' : undefined;
  // Any other engine call closes the window, which is what the measurements
  // above say and what the tools rely on. An earlier version flagged
  // `await api.sync()` between a write and a read, contradicting its own
  // header.
  if (isOnApi(node)) return isAwaited(node, body) ? 'settle' : undefined;
  return undefined;
}

/**
 * Every read that follows a write with nothing to settle it, per test case.
 *
 * Calls are collected in source order within each `it()` so that a write in
 * one case can never pair with a read in the next, which the line-window
 * version did.
 */
export function findUnsettledReads(source: string): Offence[] {
  const file = ts.createSourceFile('t.ts', source, ts.ScriptTarget.ES2022, true);
  const offences: Offence[] = [];
  const lineOf = (node: ts.Node) =>
    file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;

  const scanCase = (body: ts.Node) => {
    const calls: Array<{ kind: Kind; line: number; pos: number }> = [];
    const walk = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const kind = classify(n, body);
        if (kind) calls.push({ kind, line: lineOf(n), pos: n.getStart(file) });
      }
      ts.forEachChild(n, walk);
    };
    ts.forEachChild(body, walk);

    // Sorted by where they appear, rather than by the shape of the tree.
    // Walking arguments before their call read `api.deleteTransaction(id)
    // .then(() => api.runQuery(q))` as a read before a write, which is the
    // wrong way round and let that shape through. Source order gets both that
    // and `expect((await api.runQuery(q)).data)` right.
    //
    // Source order is not execution order once a callback is deferred, which
    // is a declared limit rather than a claim.
    calls.sort((a, b) => a.pos - b.pos);

    let pendingWrite: number | undefined;
    for (const c of calls) {
      if (c.kind === 'write') { pendingWrite = c.line; continue; }
      if (c.kind === 'settle') { pendingWrite = undefined; continue; }
      if (pendingWrite !== undefined) {
        offences.push({ line: pendingWrite, readLine: c.line });
        pendingWrite = undefined;
      }
    }
  };

  const findCases = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      const base = ts.isPropertyAccessExpression(e) ? e.expression : e;
      const name = ts.isIdentifier(base) ? base.text : undefined;
      if (name && CASE_NAMES.has(name)) {
        const fn = n.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
        if (fn && 'body' in fn && fn.body) scanCase(fn.body as ts.Node);
        return;
      }
    }
    ts.forEachChild(n, findCases);
  };

  findCases(file);
  return offences;
}
