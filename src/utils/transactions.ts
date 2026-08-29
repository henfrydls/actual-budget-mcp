import * as api from '@actual-app/api';

/**
 * Update a transaction without destroying a split child's amount.
 *
 * #25/#44: `updateTransaction` resets a sub-transaction's amount to 0 when the
 * update omits `amount`, which silently unbalances the parent split — the tool
 * reports success while the children stop summing to the parent. The guard has
 * to live on every path that updates a transaction, so it lives here rather
 * than being repeated (and forgotten) per tool.
 *
 * When no `amount` is supplied and the target turns out to be a split child, its
 * current amount is re-sent so the value is preserved.
 *
 * The lookup deliberately relies on the query default, which returns the child
 * row itself. Adding `options({ splits: 'grouped' })` would resolve a child id
 * to its parent, `is_child` would never be set, and the guard would silently
 * stop firing.
 */
export async function updatePreservingChildAmount(
  id: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const safe = { ...updates };

  if (safe.amount === undefined) {
    const result = await api.runQuery(
      api.q('transactions').filter({ id }).select(['id', 'amount', 'is_child']),
    );
    const txn = (result as { data?: Array<{ amount: number; is_child?: boolean }> } | undefined)
      ?.data?.[0];
    if (txn?.is_child) {
      safe.amount = txn.amount;
    }
  }

  await api.updateTransaction(id, safe as Parameters<typeof api.updateTransaction>[1]);
}
