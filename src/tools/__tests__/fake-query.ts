/**
 * A query builder that records what was asked.
 *
 * The mocks used to be `q: () => ({ filter: () => ({ select: () => ({}) }) })`,
 * which ignores its arguments and does not model the chain. No test could
 * assert anything about the query, and one of them encoded a false belief about
 * it: the split probe was mocked to return the parent while the real engine
 * returned nothing, because the default `splits: 'inline'` adds
 * `WHERE is_parent = 0`. A green test described the opposite of production.
 *
 * This records instead, so the shape of the query is testable.
 */
export interface RecordedQuery {
  table?: string;
  filter?: Record<string, unknown>;
  options?: Record<string, unknown>;
  select?: string[];
}

export const lastQuery: RecordedQuery = {};

export function fakeQ(table: string) {
  lastQuery.table = table;
  lastQuery.filter = undefined;
  lastQuery.options = undefined;
  lastQuery.select = undefined;

  const builder: Record<string, (arg?: unknown) => unknown> = {
    filter: (f?: unknown) => {
      lastQuery.filter = f as Record<string, unknown>;
      return builder;
    },
    options: (o?: unknown) => {
      lastQuery.options = o as Record<string, unknown>;
      return builder;
    },
    select: (s?: unknown) => {
      lastQuery.select = s as string[];
      return builder;
    },
  };
  return builder;
}

/**
 * Answer a query by what it asked for.
 *
 * `create_transaction` now runs two different queries: the duplicate check
 * before writing (by account, date and amount) and the marker lookup after a
 * failure (by id). A single `runQuery` mock cannot serve both — it would hand
 * the marker's row to the duplicate check and make every test look like a
 * duplicate — and telling them apart is exactly what recording the query is
 * for.
 */
export function answerByFilter(answers: {
  byId?: unknown;
  byAccountDateAmount?: unknown;
  fallback?: unknown;
}) {
  return async () => {
    const filter = lastQuery.filter ?? {};
    if ('id' in filter) return answers.byId ?? { data: [] };
    if ('account' in filter) return answers.byAccountDateAmount ?? { data: [] };
    return answers.fallback ?? { data: [] };
  };
}
