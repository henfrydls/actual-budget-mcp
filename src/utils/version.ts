import { readFileSync } from 'node:fs';
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
