import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

/**
 * Publishing to npm with the workflow's own identity (#241).
 *
 * The automation token this replaces bypassed 2FA, and npm is taking that
 * kind away: they lost account changes in August 2026 and lose direct
 * publishing around January 2027. A release would simply stop working.
 *
 * Checked here because the file is read by GitHub and run by nothing, and
 * because the failure mode is quiet in both directions: a token put back
 * would publish perfectly well while being the thing that is going away, and
 * an npm too old to speak OIDC fails with a 404 on the publish, after the
 * tag exists and while everything else in the release has already run.
 */
const workflow = parse(readFileSync('.github/workflows/publish.yml', 'utf8')) as {
  jobs: Record<
    string,
    {
      permissions?: Record<string, string>;
      steps: Array<{ name?: string; run?: string; env?: Record<string, string> }>;
    }
  >;
};

const publish = workflow.jobs.publish;
const steps = publish?.steps ?? [];
const publishStep = steps.find((step) => (step.run ?? '').includes('npm publish'));

/** The npm the job installs for itself, as [major, minor, patch]. */
function installedNpm(): number[] | undefined {
  for (const step of steps) {
    const match = /npm install -g npm@(\d+)\.(\d+)\.(\d+)/.exec(step.run ?? '');
    if (match) return [Number(match[1]), Number(match[2]), Number(match[3])];
  }
  return undefined;
}

describe('the npm publish step', () => {
  it('runs with an OIDC identity', () => {
    expect(publish?.permissions?.['id-token']).toBe('write');
  });

  it('publishes without a token anywhere in the job', () => {
    // npm tries the OIDC exchange first, so a token left behind would not
    // announce itself by failing: it would sit there as a second credential
    // for the same package, of exactly the kind being taken away, and it
    // would be what publishes on any path where the exchange does not
    // happen.
    const file = readFileSync('.github/workflows/publish.yml', 'utf8');
    expect(file).not.toContain('NODE_AUTH_TOKEN');
    expect(file).not.toContain('NPM_TOKEN');
    expect(publishStep, 'no step publishes to npm').toBeDefined();
    expect(publishStep?.env ?? {}).toEqual({});
  });

  it('installs an npm that can do it, before publishing', () => {
    // 11.5.1 is the floor npm documents for trusted publishing. Node 22
    // bundles 10.9.x, which fails with a 404 that says nothing about the
    // cause.
    const version = installedNpm();
    expect(version, 'the job installs no npm of its own').toBeDefined();
    const [major, minor, patch] = version as number[];
    expect(major).toBeGreaterThanOrEqual(11);
    if (major === 11) {
      expect(minor * 1000 + patch).toBeGreaterThanOrEqual(5 * 1000 + 1);
    }

    const installIndex = steps.findIndex((step) =>
      /npm install -g npm@/.test(step.run ?? ''),
    );
    const publishIndex = steps.findIndex((step) => (step.run ?? '').includes('npm publish'));
    expect(installIndex).toBeLessThan(publishIndex);
  });

  it('asks for provenance rather than hoping for it', () => {
    // npm's own OIDC path swallows every failure at verbose level and only
    // turns provenance on by itself when it was not asked for explicitly.
    // Without the flag a publish that cannot be signed goes out unsigned.
    expect(publishStep?.run).toContain('--provenance');
  });

  it('says what to check when npm refuses the publish', () => {
    // A misconfigured trusted publisher answers with a bare 401 or 404,
    // during a release, with nothing in it about the configuration.
    expect(publishStep?.run).toContain('::error::');
    expect(publishStep?.run).toContain('publish.yml');
  });

  it('stays on npm 11, where install scripts still run', () => {
    // npm 12 stops running them by default, which changes what every
    // `npm ci` in this job does. That is a separate decision from how the
    // publish authenticates.
    expect((installedNpm() as number[])[0]).toBe(11);
  });
});
