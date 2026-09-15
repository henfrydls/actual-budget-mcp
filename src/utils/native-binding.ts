import { existsSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Put the right `better_sqlite3.node` in place before anything opens a database.
 *
 * `better-sqlite3` is not N-API, so its binary is tied to one Node ABI. Loading
 * a mismatched one fails with `ERR_DLOPEN_FAILED`, verified directly: the ABI
 * 137 build refuses to run on a Node that reports ABI 127. The package resolves
 * its binary through `bindings`, which looks in `build/Release`, and it does so
 * lazily inside the `Database` constructor, so this only has to run before the
 * first connection rather than before any import.
 *
 * The bundle therefore ships one binary per (ABI, platform, arch) it supports
 * and this picks the match at startup. Doing it at runtime rather than at build
 * time is what makes a single bundle correct on a host that runs it with its own
 * Node as well as one that runs it with the user's, which is a question we could
 * not answer and no longer need to.
 *
 * Installing from npm never reaches this: npm resolves the binary itself and
 * there is no `prebuilds` directory to find.
 */

const BUNDLED_PREBUILDS = 'prebuilds';
/**
 * Records which ABI the binary currently in place was built for.
 *
 * Comparing file sizes would be cheaper and wrong: two builds for different
 * ABIs are near enough the same size that a mismatch would read as a match,
 * and the failure that follows is a dlopen error with no hint of the cause.
 */
const INSTALLED_MARKER = '.installed-abi';

export interface BindingOutcome {
  /** What happened, for the startup diagnostic line. */
  status: 'not-bundled' | 'already-correct' | 'replaced' | 'unsupported' | 'failed';
  detail?: string;
}

/** `node-v127-darwin-arm64`, the layout the prebuild archives already use. */
export function abiKey(
  modules = process.versions.modules,
  platform = process.platform,
  arch = process.arch,
): string {
  return `node-v${modules}-${platform}-${arch}`;
}

function resolveBetterSqlite3Dir(from: string): string | null {
  try {
    const require = createRequire(from);
    return dirname(require.resolve('better-sqlite3/package.json'));
  } catch {
    return null;
  }
}

/**
 * `moduleUrl` defaults to this module's own location on purpose. Passing the
 * caller's would make the answer depend on how deep the caller sits, and it
 * already did: called from `server/index.js` the prebuilds directory resolved
 * one level too high and every start reported "not bundled" while sitting next
 * to 24 usable binaries. Only the tests pass it, to stage a bundle on disk.
 */
export function ensureNativeBinding(moduleUrl: string = import.meta.url): BindingOutcome {
  // fileURLToPath, not URL.pathname: on Windows the latter yields
  // "/C:/Users/..." with a leading slash, and every path built from it misses.
  const here = dirname(fileURLToPath(moduleUrl));
  // The bundle lays prebuilds beside the compiled server; a source checkout has
  // none, which is the normal case and not a problem.
  // Beside the compiled server (server/prebuilds), so this path does not depend
  // on how deep the bundle nests the server inside the extension directory.
  const prebuiltDir = join(here, '..', BUNDLED_PREBUILDS);
  if (!existsSync(prebuiltDir)) {
    return { status: 'not-bundled' };
  }

  const key = abiKey();
  const candidate = join(prebuiltDir, key, 'better_sqlite3.node');
  const packageDir = resolveBetterSqlite3Dir(moduleUrl);
  if (!packageDir) {
    return { status: 'failed', detail: 'better-sqlite3 is not installed next to the server' };
  }
  const target = join(packageDir, 'build', 'Release', 'better_sqlite3.node');

  if (!existsSync(candidate)) {
    // Naming the ABI matters more than apologising: it is the one fact that
    // makes the bug report actionable, and the user cannot look it up.
    return {
      status: 'unsupported',
      detail:
        `this bundle has no SQLite binary for ${key}. ` +
        'Please report this, quoting that name.',
    };
  }

  // The common case writes nothing: the binary shipped as the default already
  // matches, which matters because an install directory is not always writable.
  const marker = join(dirname(target), INSTALLED_MARKER);
  if (existsSync(target) && existsSync(marker)) {
    try {
      if (readFileSync(marker, 'utf8').trim() === key) {
        return { status: 'already-correct', detail: key };
      }
    } catch {
      // An unreadable marker just means we copy again, which is harmless.
    }
  }

  try {
    copyFileSync(candidate, target);
    writeFileSync(marker, key + '\n');
    return { status: 'replaced', detail: key };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      detail: `could not install the ${key} SQLite binary: ${message}`,
    };
  }
}
