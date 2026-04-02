import * as api from '@actual-app/api';
import { ensureConnection } from '../connection.js';

export async function resolveAccountId(nameOrId: string): Promise<string> {
  await ensureConnection();
  const accounts = await api.getAccounts();

  // Exact ID match
  const byId = accounts.find((a) => a.id === nameOrId);
  if (byId) return byId.id;

  // Case-insensitive name match
  const lower = nameOrId.toLowerCase();
  const matches = accounts.filter(
    (a) => !a.closed && a.name.toLowerCase().includes(lower),
  );

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

  // Case-insensitive name match (filter only actual categories, not groups)
  const lower = nameOrId.toLowerCase();
  const cats = categories.filter(
    (c) => 'group_id' in c && !c.hidden && c.name.toLowerCase().includes(lower),
  );

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

export async function resolvePayeeName(name: string): Promise<string | undefined> {
  await ensureConnection();
  const payees = await api.getPayees();
  const lower = name.toLowerCase();
  const match = payees.find((p) => p.name.toLowerCase() === lower);
  return match?.id;
}

export async function resolveCategoryGroupId(nameOrId: string): Promise<string> {
  await ensureConnection();
  const groups = await api.getCategoryGroups();

  // Exact ID match
  const byId = groups.find((g) => g.id === nameOrId);
  if (byId) return byId.id;

  // Case-insensitive name match
  const lower = nameOrId.toLowerCase();
  const matches = groups.filter(
    (g) => g.name.toLowerCase().includes(lower),
  );

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

  // Case-insensitive name match (exclude transfer payees)
  const lower = nameOrId.toLowerCase();
  const matches = payees.filter(
    (p) => !p.name.startsWith('Transfer:') && p.name !== '' && p.name.toLowerCase().includes(lower),
  );

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
