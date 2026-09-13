import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../${name}`, import.meta.url)), 'utf8'));

/**
 * The version is written in five places, and only one of them is authoritative.
 *
 * The server reads package.json at runtime (#36, after reporting 0.4.2 for three
 * releases). The other four are parsed by third parties — npm, the Gemini
 * gallery, the MCP registry — so they cannot do the same and have to be kept in
 * step by hand at bump time.
 *
 * An earlier version of this file only checked gemini-extension.json, which
 * left server.json free to fall behind silently. That file is what the official
 * registry publishes from, so a stale copy there means the registry advertises a
 * version that is not the one on npm — exactly the mismatch that already
 * happened once, with the registry stuck on 0.8.2 while npm served 0.8.3.
 */
describe('the version is the same everywhere', () => {
  const expected = read('package.json').version as string;

  it('package-lock.json agrees, in both places it records it', () => {
    const lock = read('package-lock.json');

    expect(lock.version).toBe(expected);
    expect(lock.packages['']?.version).toBe(expected);
  });

  it('gemini-extension.json agrees', () => {
    expect(read('gemini-extension.json').version).toBe(expected);
  });

  it('server.json agrees at the top level', () => {
    expect(read('server.json').version).toBe(expected);
  });

  it('server.json agrees in every package entry it declares', () => {
    const packages = (read('server.json').packages ?? []) as Array<{
      registryType?: string;
      version?: string;
      identifier?: string;
    }>;

    expect(packages.length, 'server.json declares no packages').toBeGreaterThan(0);
    for (const pkg of packages) {
      // An OCI entry carries no `version` field: the registry validator rejects
      // one and wants the tag inside the identifier instead. That makes it the
      // easiest copy to forget, and it is the copy that decides which image the
      // registry actually serves.
      if (pkg.registryType === 'oci') {
        expect(pkg.identifier, 'the OCI image tag is behind').toMatch(new RegExp(`:${expected}$`));
      } else {
        expect(pkg.version, `${pkg.identifier ?? 'a package entry'} is behind`).toBe(expected);
      }
    }
  });

  it('declares the session token, so OIDC users are told it exists', () => {
    const packages = (read('server.json').packages ?? []) as Array<{
      environmentVariables?: Array<{ name: string; isSecret?: boolean }>;
    }>;

    for (const pkg of packages) {
      const token = pkg.environmentVariables?.find((v) => v.name === 'ACTUAL_SESSION_TOKEN');
      expect(token, 'a package entry does not mention ACTUAL_SESSION_TOKEN').toBeTruthy();
      expect(token!.isSecret, 'the session token is not marked secret').toBe(true);
    }
  });
});
