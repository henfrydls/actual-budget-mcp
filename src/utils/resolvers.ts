import * as api from '@actual-app/api';
import { ensureConnection } from '../connection.js';

/**
 * Match candidates by name, preferring an exact (case-insensitive) match.
 * Substring matching only runs as a fallback when no exact match exists.
 * This prevents "ambiguous" errors when a name is a prefix/substring of
 * another (e.g. "Savings" vs "Savings - Emergency Fund"). See #22/#27.
 */
function matchByName<T>(items: T[], nameOrId: string, getName: (item: T) => string): T[] {
  const lower = nameOrId.toLowerCase();
  const exact = items.filter((item) => getName(item).toLowerCase() === lower);
  if (exact.length > 0) return exact;
  return items.filter((item) => getName(item).toLowerCase().includes(lower));
}

/**
 * The same resolution, against a list already in hand.
 *
 * A batch resolves many names at once (#83), and calling the loading versions
 * per row would fetch every account and category once per transaction: for the
 * 22 movements of one day, 44 round trips to answer questions whose answers
 * cannot change between them. The loading versions below now call these, so
 * there is one rule rather than two that can drift.
 */
export function resolveAccountIn(
  accounts: Array<{ id: string; name: string; closed?: boolean }>,
  nameOrId: string,
): string {
  const byId = accounts.find((a) => a.id === nameOrId);
  if (byId) return byId.id;

  const candidates = accounts.filter((a) => !a.closed);
  const matches = matchByName(candidates, nameOrId, (a) => a.name);

  if (matches.length === 0) {
    const names = candidates.map((a) => a.name).join(', ');
    throw new Error(`No account found matching "${nameOrId}". Available: ${names}`);
  }
  if (matches.length > 1) {
    const names = matches.map((a) => a.name).join(', ');
    throw new Error(`Ambiguous account name "${nameOrId}". Matches: ${names}`);
  }
  return matches[0].id;
}

export function resolveCategoryIn(
  categories: Array<{ id: string; name: string; hidden?: boolean; group_id?: string }>,
  nameOrId: string,
): string {
  const byId = categories.find((c) => c.id === nameOrId);
  if (byId) return byId.id;

  const candidates = categories.filter((c) => 'group_id' in c && !c.hidden);
  const cats = matchByName(candidates, nameOrId, (c) => c.name);

  if (cats.length === 0) {
    const names = candidates.map((c) => c.name).join(', ');
    throw new Error(`No category found matching "${nameOrId}". Available: ${names}`);
  }
  if (cats.length > 1) {
    const names = cats.map((c) => c.name).join(', ');
    throw new Error(`Ambiguous category name "${nameOrId}". Matches: ${names}`);
  }
  return cats[0].id;
}

/**
 * A payee by id or name, against a list already in hand.
 *
 * Transfer payees are left out of the name match by `transfer_acct`. They carry
 * their account's name, so "Checking" would otherwise find the payee every
 * transfer into that account uses. Asked for by id, any payee is found.
 */
export function resolvePayeeIn(
  payees: Array<{ id: string; name: string; transfer_acct?: string | null }>,
  nameOrId: string,
): string {
  const byId = payees.find((p) => p.id === nameOrId);
  if (byId) return byId.id;

  const candidates = payees.filter((p) => !p.transfer_acct && p.name !== '');
  const matches = matchByName(candidates, nameOrId, (p) => p.name);

  if (matches.length === 0) {
    const names = candidates.map((p) => p.name).join(', ');
    throw new Error(`No payee found matching "${nameOrId}". Available: ${names}`);
  }
  if (matches.length > 1) {
    const names = matches.map((p) => p.name).join(', ');
    throw new Error(`Ambiguous payee name "${nameOrId}". Matches: ${names}`);
  }
  return matches[0].id;
}

export async function resolveAccountId(nameOrId: string): Promise<string> {
  await ensureConnection();
  const accounts = await api.getAccounts();

  // Exact ID match
  const byId = accounts.find((a) => a.id === nameOrId);
  if (byId) return byId.id;

  // Case-insensitive name match (exact wins over substring)
  const candidates = accounts.filter((a) => !a.closed);
  const matches = matchByName(candidates, nameOrId, (a) => a.name);

  if (matches.length === 0) {
    const names = accounts
      .filter((a) => !a.closed)
      .map((a) => a.name)
      .join(', ');
    throw new Error(
      `No account found matching "${nameOrId}". Available: ${names}`,
    );
  }
  if (matches.length > 1) {
    const names = matches.map((a) => a.name).join(', ');
    throw new Error(
      `Ambiguous account name "${nameOrId}". Matches: ${names}`,
    );
  }

  return matches[0].id;
}

export async function resolveCategoryId(nameOrId: string): Promise<string> {
  await ensureConnection();
  const categories = await api.getCategories();

  // Exact ID match
  const byId = categories.find((c) => c.id === nameOrId);
  if (byId) return byId.id;

  // Case-insensitive name match (filter only actual categories, not groups;
  // exact wins over substring)
  const candidates = categories.filter((c) => 'group_id' in c && !c.hidden);
  const cats = matchByName(candidates, nameOrId, (c) => c.name);

  if (cats.length === 0) {
    const names = categories
      .filter((c) => 'group_id' in c && !c.hidden)
      .map((c) => c.name)
      .join(', ');
    throw new Error(
      `No category found matching "${nameOrId}". Available: ${names}`,
    );
  }
  if (cats.length > 1) {
    const names = cats.map((c) => c.name).join(', ');
    throw new Error(
      `Ambiguous category name "${nameOrId}". Matches: ${names}`,
    );
  }

  return cats[0].id;
}

/**
 * Find a payee id by exact name, or undefined when there is no such payee.
 *
 * Transfer payees are excluded: Actual stores them with an empty name and a
 * `transfer_acct`, so a blank (or account-named) lookup would otherwise return
 * one and silently turn a plain transaction into a one-sided transfer.
 */
export async function resolvePayeeName(name: string): Promise<string | undefined> {
  const lower = name.trim().toLowerCase();
  if (lower === '') return undefined;

  await ensureConnection();
  const payees = await api.getPayees();
  const match = payees.find(
    (p) => !p.transfer_acct && p.name.toLowerCase() === lower,
  );
  return match?.id;
}

export async function resolveCategoryGroupId(nameOrId: string): Promise<string> {
  await ensureConnection();
  const groups = await api.getCategoryGroups();

  // Exact ID match
  const byId = groups.find((g) => g.id === nameOrId);
  if (byId) return byId.id;

  // Case-insensitive name match (exact wins over substring)
  const matches = matchByName(groups, nameOrId, (g) => g.name);

  if (matches.length === 0) {
    const names = groups.map((g) => g.name).join(', ');
    throw new Error(
      `No category group found matching "${nameOrId}". Available: ${names}`,
    );
  }
  if (matches.length > 1) {
    const names = matches.map((g) => g.name).join(', ');
    throw new Error(
      `Ambiguous category group name "${nameOrId}". Matches: ${names}`,
    );
  }

  return matches[0].id;
}

export async function resolvePayeeId(nameOrId: string): Promise<string> {
  await ensureConnection();
  const payees = await api.getPayees();

  // Exact ID match
  const byId = payees.find((p) => p.id === nameOrId);
  if (byId) return byId.id;

  // Case-insensitive name match (exclude transfer payees; exact wins over substring)
  const candidates = payees.filter(
    (p) => !p.name.startsWith('Transfer:') && p.name !== '',
  );
  const matches = matchByName(candidates, nameOrId, (p) => p.name);

  if (matches.length === 0) {
    const names = payees
      .filter((p) => !p.name.startsWith('Transfer:') && p.name !== '')
      .map((p) => p.name)
      .join(', ');
    throw new Error(
      `No payee found matching "${nameOrId}". Available: ${names}`,
    );
  }
  if (matches.length > 1) {
    const names = matches.map((p) => p.name).join(', ');
    throw new Error(
      `Ambiguous payee name "${nameOrId}". Matches: ${names}`,
    );
  }

  return matches[0].id;
}
