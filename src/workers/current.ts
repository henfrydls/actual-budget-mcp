import type { WorkerPool } from './pool.js';

/**
 * The pool this process is using, for the two places that need it (#229).
 *
 * Registration does not take arguments: tools are registered by
 * `registerAllTools` long before anything decides how many budgets there
 * are. So the entry point puts the pool here when it makes one, and the
 * router and the budget listing ask for it.
 *
 * Undefined is the ordinary case and means what it says: one budget, no
 * children, nothing routed.
 */
let current: WorkerPool | undefined;

export function usePool(pool: WorkerPool | undefined): void {
  current = pool;
}

export function poolInUse(): WorkerPool | undefined {
  return current;
}
