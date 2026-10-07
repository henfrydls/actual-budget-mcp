import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * The dependency watch, checked rather than assumed (#146).
 *
 * It is a file GitHub reads and nothing here executes, which is the kind of
 * thing that silently stops being true: a typo in a key, a dependency renamed,
 * `allow` and `groups` drifting apart. None of that fails a build.
 *
 * Parsed with Python's YAML rather than by matching text. A hand-written
 * reader of a structured format is the mistake that cost this repository two
 * rounds on #110, and adding an npm dependency to read one config file at test
 * time is worse than shelling out to something every machine running this
 * already has.
 */
const config = (() => {
  const yaml = readFileSync('.github/dependabot.yml', 'utf8');
  const json = execFileSync(
    'python3',
    ['-c', 'import sys, yaml, json; json.dump(yaml.safe_load(sys.stdin.read()), sys.stdout)'],
    { input: yaml, encoding: 'utf8' },
  );
  return JSON.parse(json) as {
    version: number;
    updates: Array<{
      'package-ecosystem': string;
      schedule: { interval: string };
      allow?: Array<{ 'dependency-name'?: string; 'dependency-type'?: string }>;
      groups?: Record<string, { patterns: string[] }>;
      'open-pull-requests-limit'?: number;
    }>;
  };
})();

const npm = config.updates.find((u) => u['package-ecosystem'] === 'npm');

describe('the dependency watch', () => {
  it('is a schema version GitHub reads', () => {
    expect(config.version).toBe(2);
    expect(npm, 'no npm entry at all').toBeDefined();
  });

  it('watches the library whose version broke a user', () => {
    // #139: the budget was migrated past the library and every tool answered
    // "No budget file is open".
    const named = (npm?.allow ?? []).map((a) => a['dependency-name']);
    expect(named).toContain('@actual-app/api');
  });

  it('watches the dependency that carries the protocol', () => {
    // It moved the audit gate under this repository between one day and the
    // next, with four advisories including a critical one.
    const named = (npm?.allow ?? []).map((a) => a['dependency-name']);
    expect(named).toContain('@modelcontextprotocol/sdk');
  });

  it('every watched dependency is one this package actually declares', () => {
    // A rename or a removal would leave a watch on nothing, which looks like
    // "we are covered" and is not.
    const declared = Object.keys(
      (JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> })
        .dependencies,
    );
    for (const entry of npm?.allow ?? []) {
      const name = entry['dependency-name'];
      if (name) expect(declared, `${name} is watched but not a dependency`).toContain(name);
    }
  });

  it('does not open an unbounded number of pull requests', () => {
    // The failure mode of a config like this is noise, and a config that
    // produces noise gets switched off.
    expect(npm?.['open-pull-requests-limit']).toBeLessThanOrEqual(5);
  });

  it('leaves development dependencies out', () => {
    // They fail loudly at build time. These two fail in someone's budget.
    const named = (npm?.allow ?? []).map((a) => a['dependency-name']);
    const devDeps = Object.keys(
      (
        JSON.parse(readFileSync('package.json', 'utf8')) as {
          devDependencies: Record<string, string>
        }
      ).devDependencies,
    );
    for (const dev of devDeps) expect(named).not.toContain(dev);
  });

  it('keeps the two apart, because they are read for different reasons', () => {
    const patterns = Object.values(npm?.groups ?? {}).flatMap((g) => g.patterns);
    expect(patterns).toContain('@actual-app/*');
    expect(patterns).toContain('@modelcontextprotocol/*');
    // Not one group holding both: a bump of one should not arrive wearing the
    // other's reasoning.
    expect(Object.keys(npm?.groups ?? {}).length).toBeGreaterThanOrEqual(2);
  });

  it('runs often enough to catch a release before a user does', () => {
    // 26.10 landed on 2 October and the report came on the 4th.
    expect(['daily', 'weekly']).toContain(npm?.schedule.interval);
  });
});

/**
 * The pull requests it opens have to run the checks that would have caught it.
 *
 * A Dependabot PR gets no secrets, so a workflow that needs one outside a
 * release would be skipped or fail for the wrong reason. Both of these run on
 * `pull_request` and use a secret only when publishing.
 */
describe('what a dependency pull request would run', () => {
  it.each([
    ['.github/workflows/ci.yml', 'build-mcpb'],
    ['.github/workflows/docker.yml', 'image'],
  ])('%s runs on pull requests and contains %s', (file, job) => {
    const text = readFileSync(file, 'utf8');
    expect(text).toMatch(/^\s*pull_request:/m);
    expect(text).toMatch(new RegExp(`^\\s*${job}:`, 'm'));
  });

  it('needs no secret outside a release', () => {
    // Both of the failures this is for showed up in these jobs: the bundle
    // build and the Alpine image.
    for (const file of ['.github/workflows/ci.yml', '.github/workflows/docker.yml']) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!line.includes('secrets.')) return;
        // The only use is pushing to GHCR, which is guarded by the event.
        const nearby = lines.slice(Math.max(0, i - 6), i + 1).join('\n');
        expect(nearby, `${file}:${i + 1} uses a secret without a release guard`).toMatch(
          /if:\s*github\.event_name == 'release'/,
        );
      });
    }
  });
});
