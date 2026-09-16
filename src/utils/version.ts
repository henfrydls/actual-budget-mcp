import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The server's own version, read from package.json at runtime so it never
 * drifts from what was published (#36). Resolves to the package root both from
 * `src/` in development and from `dist/` in the npm build.
 *
 * Read once: the file cannot change under a running process.
 */
export const packageVersion: string = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

/**
 * The version of Actual's library this server is running against.
 *
 * Reported when a budget cannot be opened because a newer Actual migrated it:
 * the number is the whole diagnosis, and the user has no way to look it up.
 * Found by resolving the entry point and walking up to the package root,
 * rather than a relative path (the package sits in a different place in a
 * bundle than in an npm install) and rather than resolving
 * `@actual-app/api/package.json` directly, which throws: the package declares
 * an `exports` map and does not list its own manifest in it.
 */
export function actualApiVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    let dir = dirname(require.resolve('@actual-app/api'));
    // Bounded: a package root is a few levels above its entry point at most.
    for (let depth = 0; depth < 5; depth++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === '@actual-app/api' && pkg.version) return pkg.version;
      } catch {
        // Not the package root yet, or unreadable; keep walking up.
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
