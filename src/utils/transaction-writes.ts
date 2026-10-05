import { makeQueue } from './serialize.js';

/**
 * One queue for every tool that changes the transactions table.
 *
 * Two tool calls sent without awaiting the first interleave inside this
 * server, and a check that reads the table while another handler is half way
 * through changing it sees a state that is already gone. Measured (#111):
 * `delete_transaction` and `create_transaction` fired together made the
 * duplicate warning name the row the delete had just removed, so a transaction
 * that should have been created was refused. The same pair in sequence creates
 * normally.
 *
 * It is not the deferred write window of #105. That one closes after a handful
 * of chained microtasks or any engine call, and a sequential pair of tool calls
 * clears it. Here both handlers are genuinely in flight at once.
 *
 * ## Why one queue rather than one each
 *
 * They compete for the same thing: what the transactions table says between a
 * read and the write that depends on it. A queue per tool would let a delete
 * and a create overlap, which is precisely the pair that was measured failing.
 *
 * ## Why this wraps handlers and not the exported functions
 *
 * `reconcile_currency_residual` calls `createTransaction`, and
 * `create_transfer` reaches the same path. Queueing inside those functions
 * would have an outer call waiting for an inner one that can never start,
 * which is a deadlock rather than a race. The queue goes around the tool
 * handler, which is the outermost point and the one that corresponds to "a
 * call arrived".
 *
 * Between processes this does nothing and cannot; that is the open half of
 * #111, and a single MCP server is the case that was failing.
 */
export const queueTransactionWrite = makeQueue();
