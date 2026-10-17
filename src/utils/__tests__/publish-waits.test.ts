import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';

/**
 * What the release does while it waits for the two things it cannot hurry
 * (#199).
 *
 * The step that publishes to the MCP registry waits for the container image,
 * built by a workflow running alongside this one, and for npm, which answers
 * "your package is being processed" and serves the new version some minutes
 * later.
 *
 * It is run by GitHub and by nothing here, so it is the kind of thing that
 * stops being true quietly, and reading it with a regular expression is how a
 * test about a shell script passes while the script does the opposite: an
 * `echo` in the right place satisfied the pattern that was looking for a
 * `sleep`. So the script is run, against stubs, and what it does is what is
 * checked.
 *
 * 0.10.6 is what this cost twice over. One loop was shared between both
 * waits, which gave the pair five minutes; and the registry's token lasts
 * five minutes from the login, so waiting with a session already open spent
 * the session, which is why re-running the job by hand worked.
 */
describe.skipIf(process.platform === 'win32')('what the release does while it waits', () => {
  const workflow = parse(readFileSync('.github/workflows/publish.yml', 'utf8')) as {
    jobs: Record<
      string,
      { steps: Array<{ name?: string; run?: string; 'timeout-minutes'?: number }> }
    >;
  };
  const step = workflow.jobs.registry.steps.find(
    (one) => one.name === 'Publish to the MCP registry',
  )!;

  interface Run {
    status: number;
    out: string;
    /** Every stubbed command, in the order the script called it. */
    calls: string[];
    sleeps: number[];
  }

  /**
   * Run the real script with stubs for everything it shells out to.
   *
   * `imageAfter` and `npmAfter` are how many attempts each one refuses before
   * answering, and `publish` is what the publisher prints and exits with.
   */
  function run(options: {
    imageAfter?: number;
    npmAfter?: number;
    npmBroken?: boolean;
    loginFails?: boolean;
    publish?: Array<{ out: string; status: number }>;
  }): Run {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'publish-step-'));
    try {
      const log = path.join(dir, 'calls.log');
      const stub = (name: string, body: string) => {
        const file = path.join(dir, name);
        writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
        chmodSync(file, 0o755);
      };
      const count = (what: string) =>
        `n=$(cat "${dir}/${what}.n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${dir}/${what}.n"`;

      stub('node', `echo "node $*" >> "${log}"; case "$*" in *name*) echo actual-budget-mcp;; *) echo 9.9.9;; esac`);
      stub(
        'curl',
        `echo "curl" >> "${log}"
         case "$*" in
           *token\\?*) echo '{"token":"t"}'; exit 0;;
         esac
         ${count('image')}
         [ "$n" -gt "${options.imageAfter ?? 0}" ]`,
      );
      stub('jq', `cat >/dev/null; echo t`);
      // It answers about the version it was asked for, so swapping the
      // argument for one that is always there cannot pass.
      stub(
        'npm',
        `echo "npm $*" >> "${log}"
         case "$*" in *actual-budget-mcp@9.9.9*) ;; *) echo "E404 not in this registry"; exit 1;; esac
         ${options.npmBroken ? 'echo "npm ERR! network ETIMEDOUT"; exit 1' : ''}
         ${count('npm')}
         if [ "$n" -gt "${options.npmAfter ?? 0}" ]; then exit 0; fi
         echo "npm ERR! code E404"; exit 1`,
      );
      stub('sleep', `echo "sleep $1" >> "${log}"`);
      stub('seq', `s=$1; e=$2; while [ "$s" -le "$e" ]; do echo "$s"; s=$((s+1)); done`);

      const publishes = options.publish ?? [{ out: 'ok', status: 0 }];
      writeFileSync(
        path.join(dir, 'mcp-publisher'),
        `#!/usr/bin/env bash\n` +
          `echo "mcp-publisher $1" >> "${log}"\n` +
          `if [ "$1" = login ]; then ${options.loginFails ? 'echo "no OIDC token"; exit 1' : 'exit 0'}; fi\n` +
          `${count('publish')}\n` +
          publishes
            .map(
              (one, index) =>
                `if [ "$n" = "${index + 1}" ]; then echo ${JSON.stringify(one.out)}; exit ${one.status}; fi`,
            )
            .join('\n') +
          `\necho ${JSON.stringify(publishes[publishes.length - 1].out)}\nexit ${publishes[publishes.length - 1].status}\n`,
      );
      chmodSync(path.join(dir, 'mcp-publisher'), 0o755);
      writeFileSync(path.join(dir, 'script.sh'), step.run!);

      let status = 0;
      let out = '';
      try {
        out = execFileSync('bash', ['script.sh'], {
          cwd: dir,
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        const failure = error as { status?: number; stdout?: string; stderr?: string };
        status = failure.status ?? 1;
        out = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
      }
      const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
      return {
        status,
        out,
        calls,
        sleeps: calls.filter((c) => c.startsWith('sleep ')).map((c) => Number(c.slice(6))),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('signs in only once both waits are over', () => {
    // The registry's token lasts five minutes from the login, and the
    // publisher does not renew it, so waiting with a session open spends it.
    const result = run({ imageAfter: 2, npmAfter: 3 });

    expect(result.status).toBe(0);
    const firstLogin = result.calls.indexOf('mcp-publisher login');
    const lastWait = result.calls.map((c) => c.startsWith('npm ')).lastIndexOf(true);
    expect(firstLogin, 'there has to be a login').toBeGreaterThan(-1);
    expect(firstLogin, 'and it comes after the last thing it waited for').toBeGreaterThan(lastWait);
  });

  it('asks npm itself rather than finding out through the publisher', () => {
    // A 404 from npm is then told apart from everything else that can refuse
    // a publish, and the waiting costs no session.
    const result = run({ npmAfter: 2 });

    expect(result.calls.filter((c) => c.startsWith('npm ')).length).toBeGreaterThan(1);
    expect(
      result.calls.filter((c) => c === 'mcp-publisher publish'),
      'the publisher is not what waits',
    ).toHaveLength(1);
  });

  it('gives the image five minutes and npm ten', () => {
    const image = run({ imageAfter: 999 });
    expect(image.status).toBe(1);
    expect(image.out).toContain('ghcr has no');
    // Twenty tries, fifteen seconds apart, and no sleep after the last one.
    expect(image.sleeps.filter((s) => s === 15)).toHaveLength(19);

    const npm = run({ npmAfter: 999 });
    expect(npm.status).toBe(1);
    expect(npm.out).toContain('npm is still not serving');
    expect(npm.sleeps.filter((s) => s === 30)).toHaveLength(19);
  });

  it('stops without waiting when waiting cannot help', () => {
    const refused = run({ publish: [{ out: 'error: 401 unauthorized', status: 1 }] });
    expect(refused.status).toBe(1);
    expect(refused.out).toContain("refused the workflow's credentials");
    expect(
      refused.calls.filter((c) => c === 'mcp-publisher publish'),
      'retrying a 401 only wastes the window',
    ).toHaveLength(1);

    const invalid = run({ publish: [{ out: 'error: 422 validation failed', status: 1 }] });
    expect(invalid.status).toBe(1);
    expect(invalid.out).toContain('rejected server.json');
  });

  it('treats a version the registry already has as done', () => {
    // Which is what a re-run of this job finds after a partial success. The
    // text is the registry's own, taken from v1.8.1: a made-up one let the
    // pattern that matches it be deleted with every test still green.
    const result = run({
      publish: [
        { out: 'Error: failed to publish: 400 invalid version: cannot publish duplicate version', status: 1 },
      ],
    });

    expect(result.status).toBe(0);
    expect(result.out).toContain('already has');
  });

  it('does not wait out a 400 the registry will keep giving', () => {
    // What the registry checks about the package comes back as a 400, not a
    // 422: a missing mcpName in the published package, or an image it cannot
    // pull. Those used to fall into the generic retry and end on a message
    // about npm being slow, which is the wrong remedy.
    const refused = run({
      publish: [{ out: 'Error: 400 validation error: npm package is missing mcpName', status: 1 }],
    });

    expect(refused.status).toBe(1);
    expect(refused.out).toContain('waiting will not');
    expect(refused.calls.filter((c) => c === 'mcp-publisher publish')).toHaveLength(1);
  });

  it('tries again when the registry has not caught up with npm', () => {
    // The one 400 that resolves itself, which the wait above makes unlikely
    // and does not make impossible.
    const result = run({
      publish: [
        { out: 'Error: 400 package not found in npm registry (404)', status: 1 },
        { out: 'published', status: 0 },
      ],
    });

    expect(result.status).toBe(0);
    expect(result.calls.filter((c) => c === 'mcp-publisher publish')).toHaveLength(2);
  });

  it('says so when it cannot sign in at all', () => {
    // `bash -e` killed the step with no message of its own, so the log ended
    // on the publisher's output and nothing said what to do about it.
    const result = run({ loginFails: true });

    expect(result.status).toBe(1);
    expect(result.out).toContain('could not sign in');
    expect(result.calls.filter((c) => c === 'mcp-publisher publish')).toHaveLength(0);
  });

  it('does not call npm not answering the same thing as npm not having it', () => {
    const result = run({ npmBroken: true });

    expect(result.status).toBe(1);
    expect(result.out).toContain('npm did not answer');
    expect(result.out).not.toContain('is still not serving');
  });

  it('tries again when the registry fails for no stated reason', () => {
    const result = run({
      publish: [
        { out: 'error: 503 service unavailable', status: 1 },
        { out: 'published', status: 0 },
      ],
    });

    expect(result.status).toBe(0);
    expect(result.calls.filter((c) => c === 'mcp-publisher publish')).toHaveLength(2);
    expect(
      result.calls.filter((c) => c === 'mcp-publisher login'),
      'each attempt signs in again, because the token does not outlive five minutes',
    ).toHaveLength(2);
  });

  it('does not let a hanging request eat the window', () => {
    // Checked as text, not by running it: a curl with no timeout and a curl
    // with one behave the same against a stub, and the difference only shows
    // against a server that never answers. Both calls reach the network.
    const curls = [...step.run!.matchAll(/curl [^\n]*/g)].map((m) => m[0]);
    expect(curls.length, 'the token and the manifest').toBeGreaterThanOrEqual(2);
    for (const call of curls) expect(call).toContain('--max-time');
    // And npm, which is the one with ten minutes to lose.
    for (const call of [...step.run!.matchAll(/npm view [^\n]*/g)].map((m) => m[0])) {
      expect(call).toContain('--fetch-timeout');
    }
  });

  it('is allowed to run for longer than it can wait', () => {
    // Five minutes for the image plus ten for npm plus the retries.
    expect(step['timeout-minutes']).toBeGreaterThan(15);
  });
});
