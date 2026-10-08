import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

/**
 * The dependency watch, checked rather than assumed (#146).
 *
 * It is a file GitHub reads and nothing here executes, which is the kind of
 * thing that silently stops being true. An audit proved the point against the
 * first version of these tests: `directory` misspelled as `directroy`, `day:
 * mondey`, `labels` as `lables` -- all four left eleven tests green, and
 * Dependabot would have rejected or ignored the file.
 *
 * So the keys are checked against a list, at every level. A key that is not on
 * it is either a typo or something new, and both are worth stopping for.
 *
 * Read with the `yaml` package rather than by shelling out to Python, which
 * the first version did. Python is not a given on Windows, and PyYAML is not a
 * given on a macOS with the system python, so that version failed with
 * `spawnSync python3 ENOENT` on the very machines where someone edits this
 * file. A skipped test on the editor's machine and a passing one in CI is the
 * wrong way round: 686 KB in devDependencies reaches no user, no bundle and no
 * production audit.
 */

/** Every key the Dependabot schema defines, by where it appears. */
const TOP_LEVEL_KEYS = ['version', 'updates', 'registries', 'enable-beta-ecosystems'];
const UPDATE_KEYS = [
  'package-ecosystem',
  'directory',
  'directories',
  'schedule',
  'allow',
  'assignees',
  'commit-message',
  'cooldown',
  'groups',
  'ignore',
  'insecure-external-code-execution',
  'labels',
  'milestone',
  'open-pull-requests-limit',
  'patterns',
  'pull-request-branch-name',
  'rebase-strategy',
  'registries',
  'reviewers',
  'target-branch',
  'vendor',
  'versioning-strategy',
];
const SCHEDULE_KEYS = ['interval', 'day', 'time', 'timezone', 'cronjob'];
/** The values Dependabot accepts for the keys that are enumerations. */
const SCHEDULE_VALUES: Record<string, string[]> = {
  interval: ['daily', 'weekly', 'monthly', 'quarterly', 'semiannually', 'yearly', 'cron'],
  day: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
};
const ALLOW_KEYS = ['dependency-name', 'dependency-type'];
const GROUP_KEYS = ['applies-to', 'dependency-type', 'patterns', 'exclude-patterns', 'update-types'];

interface Update {
  'package-ecosystem': string;
  schedule: { interval: string; day?: string };
  allow?: Array<{ 'dependency-name'?: string; 'dependency-type'?: string }>;
  groups?: Record<string, { patterns: string[] }>;
  'open-pull-requests-limit'?: number;
  labels?: string[];
}

const config = parse(readFileSync('.github/dependabot.yml', 'utf8')) as {
  version: number;
  updates: Update[];
};

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
    // Daily, not weekly: 26.10 landed on Friday 2 October and the report came
    // in on the 4th, so a Monday run would have arrived after the user did.
    expect(npm?.schedule.interval).toBe('daily');
  });

  it('uses no key the schema does not define', () => {
    // A misspelled key is not a smaller mistake than a missing one: Dependabot
    // rejects the file or ignores the setting, and either way the watch is not
    // running while everything here stays green. Measured: `directroy`,
    // `mondey` and `lables` all passed the first version of these tests.
    expect(Object.keys(config)).toEqual(
      expect.arrayContaining([]),
    );
    for (const key of Object.keys(config)) {
      expect(TOP_LEVEL_KEYS, `unknown top-level key "${key}"`).toContain(key);
    }
    for (const update of config.updates) {
      for (const key of Object.keys(update)) {
        expect(UPDATE_KEYS, `unknown key "${key}" in an update`).toContain(key);
      }
      for (const key of Object.keys(update.schedule ?? {})) {
        expect(SCHEDULE_KEYS, `unknown key "${key}" in schedule`).toContain(key);
      }
      for (const entry of update.allow ?? []) {
        for (const key of Object.keys(entry)) {
          expect(ALLOW_KEYS, `unknown key "${key}" in allow`).toContain(key);
        }
      }
      for (const [name, group] of Object.entries(update.groups ?? {})) {
        for (const key of Object.keys(group)) {
          expect(GROUP_KEYS, `unknown key "${key}" in group "${name}"`).toContain(key);
        }
      }
    }
  });

  it('uses no value the schema does not accept either', () => {
    // Checking the key was not enough: `day: mondey` is a valid key with a
    // value that is not a day, and Dependabot takes the whole schedule as
    // malformed. A typo in a value is as silent as one in a key.
    for (const update of config.updates) {
      for (const [key, value] of Object.entries(update.schedule ?? {})) {
        const allowed = SCHEDULE_VALUES[key];
        if (!allowed) continue;
        expect(allowed, `"${String(value)}" is not a valid ${key}`).toContain(String(value));
      }
      // `day` only means something on a weekly schedule. Left over from one,
      // it is a line that reads as configuration and does nothing.
      if (update.schedule?.interval !== 'weekly') {
        expect(
          update.schedule?.day,
          'day only applies to a weekly schedule',
        ).toBeUndefined();
      }
    }
  });

  it('gives each watched dependency a group of its own', () => {
    // Counting groups was not enough: putting both patterns in one group and
    // adding an empty one to make the count passed. What matters is that each
    // watched name is matched by exactly one group.
    const groups = Object.entries(npm?.groups ?? {});
    for (const entry of npm?.allow ?? []) {
      const name = entry['dependency-name'];
      if (!name) continue;
      const matching = groups.filter(([, g]) =>
        (g.patterns ?? []).some((pattern) => {
          const prefix = pattern.replace(/\*$/, '');
          return pattern.endsWith('*') ? name.startsWith(prefix) : name === pattern;
        }),
      );
      expect(matching.map(([n]) => n), `${name} should be in exactly one group`).toHaveLength(1);
    }
    // And no group that matches nothing, which is how the count was padded.
    for (const [name, group] of groups) {
      const matchesSomething = (npm?.allow ?? []).some((a) =>
        (group.patterns ?? []).some((pattern) => {
          const dep = a['dependency-name'] ?? '';
          const prefix = pattern.replace(/\*$/, '');
          return pattern.endsWith('*') ? dep.startsWith(prefix) : dep === pattern;
        }),
      );
      expect(matchesSomething, `group "${name}" matches nothing that is watched`).toBe(true);
    }
  });

  it('asks for a label, and one that someone has created', () => {
    // Dependabot drops an unknown label without a word, so a label nobody
    // created is a setting that looks applied and is not. `dependencies` was
    // created in the repository for this; checking it over the network on
    // every test run would make the suite need `gh` and a token, which is the
    // same mistake as needing Python.
    expect(npm?.labels).toEqual(['dependencies']);
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
