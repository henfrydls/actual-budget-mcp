import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The gate on the development tree (#212).
 *
 * `npm audit --audit-level=high` cannot ignore one advisory, so the day one
 * lands in the test runner with no fix available it offers two options:
 * carry it silently, or switch the step off for everything. This repository
 * ran the second for a year, which is what made ten advisories invisible.
 *
 * So an advisory can be carried by GHSA id with a reason beside it, and
 * everything else at high or above fails. That is a script, and a script
 * that decides whether CI is red is worth testing against the shapes npm
 * actually produces.
 */
function run(audit: unknown, allowed: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'audit-gate-'));
  const list = join(dir, 'allowlist.json');
  writeFileSync(list, JSON.stringify({ allowed }));
  try {
    const stdout = execFileSync(
      process.execPath,
      ['scripts/audit-tooling.mjs', '--stdin', '--allowlist', list],
      { input: JSON.stringify(audit), encoding: 'utf8' },
    );
    return { code: 0, stdout };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    return { code: failure.status ?? -1, stdout: failure.stdout ?? '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One advisory, in the shape `npm audit --json` reports it. */
const advisory = (severity: string, ghsa: string, name = 'tinypool') => ({
  vulnerabilities: {
    [name]: {
      name,
      severity,
      via: [
        {
          source: 1234,
          name,
          dependency: name,
          title: 'something is wrong with it',
          url: `https://github.com/advisories/${ghsa}`,
          severity,
          range: '<1.0.0',
        },
      ],
    },
  },
});

describe('the audit gate', () => {
  it('passes a clean tree', () => {
    const { code, stdout } = run({ vulnerabilities: {} }, {});

    expect(code).toBe(0);
    expect(stdout).toContain('no high or critical advisory outside the allowlist');
  });

  it('fails on a high advisory nobody has accounted for', () => {
    const { code, stdout } = run(advisory('high', 'GHSA-aaaa-bbbb-cccc'), {});

    expect(code).toBe(1);
    expect(stdout).toContain('GHSA-aaaa-bbbb-cccc high in tinypool');
    expect(stdout).toContain('::error::');
    expect(stdout).toContain('.github/audit-allowlist.json');
  });

  it('fails on a critical one too', () => {
    expect(run(advisory('critical', 'GHSA-dddd-eeee-ffff'), {}).code).toBe(1);
  });

  it('carries one that has a reason written beside it', () => {
    const { code, stdout } = run(advisory('high', 'GHSA-aaaa-bbbb-cccc'), {
      'GHSA-aaaa-bbbb-cccc': 'no fix in vitest yet; revisit when 5.1 lands',
    });

    expect(code).toBe(0);
    expect(stdout).toContain('carried: GHSA-aaaa-bbbb-cccc');
    expect(stdout).toContain('revisit when 5.1 lands');
  });

  it('carries one and still fails on the one beside it', () => {
    const two = {
      vulnerabilities: {
        ...advisory('high', 'GHSA-aaaa-bbbb-cccc', 'tinypool').vulnerabilities,
        ...advisory('critical', 'GHSA-1111-2222-3333', 'esbuild').vulnerabilities,
      },
    };

    const { code, stdout } = run(two, { 'GHSA-aaaa-bbbb-cccc': 'carried on purpose' });

    expect(code).toBe(1);
    expect(stdout).toContain('GHSA-1111-2222-3333 critical in esbuild');
    expect(stdout).toContain('carried: GHSA-aaaa-bbbb-cccc');
  });

  it('leaves moderate and low alone', () => {
    expect(run(advisory('moderate', 'GHSA-aaaa-bbbb-cccc'), {}).code).toBe(0);
    expect(run(advisory('low', 'GHSA-aaaa-bbbb-cccc'), {}).code).toBe(0);
  });

  it('says when the allowlist is carrying something that is gone', () => {
    // An allowlist nobody prunes is how a list of exceptions becomes the
    // policy.
    const { code, stdout } = run({ vulnerabilities: {} }, { 'GHSA-old1-old2-old3': 'fixed ages ago' });

    expect(code).toBe(0);
    expect(stdout).toContain('::notice::GHSA-old1-old2-old3');
    expect(stdout).toContain('take it out');
  });

  it('ignores a via that is only the name of another package', () => {
    // npm puts both shapes in the same array: the advisory as an object, and
    // a plain string for a package that brought it in.
    const mixed = {
      vulnerabilities: {
        vite: { name: 'vite', severity: 'high', via: ['esbuild'] },
      },
    };

    expect(run(mixed, {}).code).toBe(0);
  });
});
