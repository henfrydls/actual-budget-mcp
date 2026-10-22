import { makeQueue } from './serialize.js';

/**
 * One queue for every tool that reads a budget figure and writes it back.
 *
 * `update_budget_amount` had its own for #121: two deltas of +1,000.00 against
 * an empty category each read before either wrote, and the second overwrote
 * the first, leaving 1,000.00. `transfer_between_categories` then grew the
 * same shape when it learned to take money out of the pool (#114), because
 * there is no engine handler for that direction that does not also write a
 * budget row for a category nobody has. Measured: two moves of 10.00 and
 * 20.00 out of the pool into one category, fired together, left 20.00.
 *
 * They share a queue rather than having one each because they compete for the
 * same thing: what a category's budgeted figure says between a read and the
 * write that depends on it. A queue each would let a delta and a transfer
 * overlap, which is the same lost update with two tool names on it.
 *
 * What is inside the queue is everything from the first read to the last,
 * not the write alone. The reply quotes the figures before and after, and a
 * second call landing between them makes those figures describe two different
 * budgets: measured on the verification this tool does, a move that worked was
 * reported as "the figures did not change the way they should have" because
 * the read-back had already caught someone else's write.
 *
 * Between processes this does nothing and cannot, which is the open half of
 * #111. Two servers on one budget are already in that state for transactions.
 */
export const queueBudgetWrite = makeQueue();
