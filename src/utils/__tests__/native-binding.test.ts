import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { abiKey, ensureNativeBinding } from '../native-binding.js';

let root: string;

/** A bundle laid out the way build-mcpb.sh lays one out. */
function makeBundle(prebuildKeys: string[], installedKey?: string) {
  const server = join(root, 'server');
  mkdirSync(server, { recursive: true });
  const release = join(root, 'node_modules', 'better-sqlite3', 'build', 'Release');
  mkdirSync(release, { recursive: true });
  writeFileSync(join(root, 'node_modules', 'better-sqlite3', 'package.json'), '{"name":"better-sqlite3","main":"x.js"}');
  writeFileSync(join(release, 'better_sqlite3.node'), 'installed-binary');
  if (installedKey) writeFileSync(join(release, '.installed-abi'), installedKey + '\n');

  for (const key of prebuildKeys) {
    const dir = join(server, 'prebuilds', key);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'better_sqlite3.node'), `binary-for-${key}`);
  }
  return pathToFileURL(join(server, 'utils', 'native-binding.js')).href;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'abi-test-'));
});
afterEach(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('choosing the SQLite binary for the Node that is actually running', () => {
  it('names the ABI the way the prebuild archives do', () => {
    expect(abiKey('127', 'darwin', 'arm64')).toBe('node-v127-darwin-arm64');
  });

  it('does nothing when there are no bundled prebuilds, which is the npm install', () => {
    mkdirSync(join(root, 'server'), { recursive: true });
    const url = pathToFileURL(join(root, 'server', 'utils', 'native-binding.js')).href;

    expect(ensureNativeBinding(url).status).toBe('not-bundled');
  });

  it('installs the binary for this Node when the bundled default is another one', () => {
    const url = makeBundle([abiKey()], 'node-v999-other-arch');

    const outcome = ensureNativeBinding(url);

    expect(outcome.status).toBe('replaced');
    const target = join(root, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
    expect(readFileSync(target, 'utf8')).toBe(`binary-for-${abiKey()}`);
  });

  it('writes nothing when the binary in place is already the right one', () => {
    const url = makeBundle([abiKey()], abiKey());

    const outcome = ensureNativeBinding(url);

    expect(outcome.status).toBe('already-correct');
    const target = join(root, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
    expect(readFileSync(target, 'utf8')).toBe('installed-binary');
  });

  it('records which ABI it installed, so the next start can skip the copy', () => {
    const url = makeBundle([abiKey()], 'node-v999-other-arch');

    ensureNativeBinding(url);

    const marker = join(root, 'node_modules', 'better-sqlite3', 'build', 'Release', '.installed-abi');
    expect(readFileSync(marker, 'utf8').trim()).toBe(abiKey());
  });

  it('names the missing ABI rather than apologising, since only that is actionable', () => {
    const url = makeBundle(['node-v1-nope-nope'], 'node-v1-nope-nope');

    const outcome = ensureNativeBinding(url);

    expect(outcome.status).toBe('unsupported');
    expect(outcome.detail).toContain(abiKey());
  });

  it('reports a read-only install instead of dying on the copy', () => {
    const url = makeBundle([abiKey()], 'node-v999-other-arch');
    const release = join(root, 'node_modules', 'better-sqlite3', 'build', 'Release');
    const target = join(release, 'better_sqlite3.node');
    // A read-only file is what an install directory the user cannot write
    // actually looks like from here.
    chmodSync(target, 0o444);
    chmodSync(release, 0o555);

    const outcome = ensureNativeBinding(url);

    chmodSync(release, 0o755);
    chmodSync(target, 0o644);
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toContain(abiKey());
  });

  it('survives a bundle whose better-sqlite3 is missing entirely', () => {
    mkdirSync(join(root, 'server'), { recursive: true });
    mkdirSync(join(root, 'server', 'prebuilds', abiKey()), { recursive: true });
    writeFileSync(join(root, 'server', 'prebuilds', abiKey(), 'better_sqlite3.node'), 'x');
    const url = pathToFileURL(join(root, 'server', 'utils', 'native-binding.js')).href;

    expect(ensureNativeBinding(url).status).toBe('failed');
  });
});
