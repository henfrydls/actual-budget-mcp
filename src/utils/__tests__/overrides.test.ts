import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * That every override still overrides something (#135).
 *
 * An override is a claim about a package in the tree. `adm-zip` was pinned at
 * `^0.6.0` and was not in the tree at all: nothing resolved through it,
 * nothing would have warned, and it read as a package this project had
 * decided something about. The same shape hides the live version of the
 * problem, a pin that stops matching what is installed.
 *
 * What this cannot check is the other half, which is the one #135 is named
 * for: a pin can satisfy itself and still sit inside an advisory that grew
 * past it. Only `npm audit` knows that, and only with a network, so CI is
 * where that question is asked.
 */
const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
  overrides?: Record<string, string>;
};
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
  packages: Record<string, { version?: string }>;
};

/** Every version of `name` the lock installs, wherever it sits in the tree. */
function installed(name: string): string[] {
  const suffix = `node_modules/${name}`;
  return Object.entries(lock.packages)
    .filter(([path]) => path === suffix || path.endsWith(`/${suffix}`))
    .map(([, info]) => info.version)
    .filter((version): version is string => typeof version === 'string');
}

/**
 * The floor of a `^x.y.z` pin, as numbers.
 *
 * Anything it cannot read is a failure and not a pass. `$hono` parsed to
 * `[NaN]`, every comparison against NaN was false, and the check said the
 * version was at or above the pin: a typo in the one file this test exists
 * to watch, waved through by the test.
 */
function floorOf(pin: string): number[] {
  const parts = pin.replace(/^[\^~>=]+/, '').split('.').map(Number);
  if (parts.length === 0 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error(`"${pin}" is not a version this can compare`);
  }
  return parts;
}

function atLeast(version: string, pin: string): boolean {
  const have = version.split('.').map(Number);
  const want = floorOf(pin);
  for (let i = 0; i < want.length; i++) {
    if ((have[i] ?? 0) > (want[i] ?? 0)) return true;
    if ((have[i] ?? 0) < (want[i] ?? 0)) return false;
  }
  return true;
}

describe('the version overrides', () => {
  const overrides = Object.entries(manifest.overrides ?? {});

  it('are all a package and a version', () => {
    // npm also takes an object, to override a package only underneath
    // another one. Nothing here uses that, and the two checks below would
    // throw on one rather than say what it found.
    for (const [name, pin] of overrides) {
      expect(typeof pin, `the override for ${name} is not a version string`).toBe('string');
    }
  });

  it('has some, or this file is measuring nothing', () => {
    expect(overrides.length).toBeGreaterThan(0);
  });

  it.each(overrides)('%s is in the tree it claims to pin', (name) => {
    expect(installed(name), `${name} is overridden and nothing installs it`).not.toHaveLength(0);
  });

  it.each(overrides)('%s resolves at or above its pin', (name, pin) => {
    for (const version of installed(name)) {
      expect(atLeast(version, pin), `${name} ${version} is below ${pin}`).toBe(true);
    }
  });
});
