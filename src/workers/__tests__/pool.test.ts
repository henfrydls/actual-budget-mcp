import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerPool } from '../pool.js';

const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stub-worker.mjs');
const RAW = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'raw-worker.mjs');

const VARS = ['ACTUAL_BUDGET_ID', 'ACTUAL_BUDGET_IDS'];

const pools: WorkerPool[] = [];

function pool(options: Record<string, unknown> = {}, flags: string[] = []): WorkerPool {
  const made = new WorkerPool({
    command: process.execPath,
    args: [STUB, ...flags],
    dataDirFor: (budgetId) => path.join('/tmp/actual-mcp-pool-test', budgetId),
    log: () => undefined,
    ...options,
  });
  pools.push(made);
  return made;
}

function said(reply: { content: Array<{ text: string }> }): string {
  return reply.content.map((part) => part.text).join(' ');
}

/**
 * One worker per budget (#229).
 *
 * The workers here are not this server: the pool's contract is "spawn this
 * command and talk MCP to it", so the tests give it a command that answers
 * MCP and nothing else. What is being checked is the pool, which is the
 * part that is new, rather than the engine, which every other test in this
 * repository already covers.
 */
describe('the worker pool', () => {
  afterEach(async () => {
    for (const name of VARS) delete process.env[name];
    await Promise.all(pools.splice(0).map((made) => made.stop()));
  });

  it('answers from the worker that holds the budget it was asked for', async () => {
    const workers = pool();

    const one = await workers.call('sync-one', { name: 'get_budget_month', readOnly: true });
    const two = await workers.call('sync-two', { name: 'get_budget_month', readOnly: true });

    expect(said(one)).toContain('month of sync-one');
    expect(said(two)).toContain('month of sync-two');
    expect(workers.openBudgets().sort()).toEqual(['sync-one', 'sync-two']);
  }, 30_000);

  it('keeps a worker between calls rather than starting one each time', async () => {
    const workers = pool();

    await workers.call('sync-one', { name: 'get_budget_month', readOnly: true });
    await workers.call('sync-one', { name: 'get_budget_month', readOnly: true });

    expect(workers.openBudgets()).toEqual(['sync-one']);
  }, 30_000);

  it('gives a worker only the environment it needs', async () => {
    // The allowlist, read back from the child itself rather than from the
    // code that builds it.
    process.env.ACTUAL_HTTP_PORT = '3000';
    process.env.ACTUAL_HTTP_TOKEN = 'a-read-token-that-is-long-enough';
    process.env.ACTUAL_HTTP_WRITE_TOKEN = 'a-write-token-that-is-long-enough';
    process.env.ACTUAL_BUDGET_IDS = 'sync-one,sync-two';
    process.env.ACTUAL_ENCRYPTION_PASSWORDS = JSON.stringify({ 'sync-one': 'one-password' });
    process.env.ACTUAL_READ_ONLY = '1';
    try {
      const reply = await pool().call('sync-one', { name: 'echo_env', readOnly: true });
      const env = JSON.parse(said(reply)) as Record<string, string>;

      expect(env.ACTUAL_BUDGET_ID).toBe('sync-one');
      expect(env.ACTUAL_DATA_DIR).toContain('sync-one');
      // Its own password, out of the map, and not the map.
      expect(env.ACTUAL_ENCRYPTION_PASSWORD).toBe('one-password');
      expect(env.ACTUAL_ENCRYPTION_PASSWORDS).toBeUndefined();
      // Nothing about the front door: a worker that read these would start
      // an HTTP server of its own, on a port that is taken.
      expect(env.ACTUAL_HTTP_PORT).toBeUndefined();
      expect(env.ACTUAL_HTTP_TOKEN).toBeUndefined();
      expect(env.ACTUAL_HTTP_WRITE_TOKEN).toBeUndefined();
      // Nor the list: a worker serves one budget.
      expect(env.ACTUAL_BUDGET_IDS).toBeUndefined();
      // Read-only passes on purpose, so the write tools do not exist in the
      // process that holds the budget either.
      expect(env.ACTUAL_READ_ONLY).toBe('1');
    } finally {
      for (const name of [
        'ACTUAL_HTTP_PORT',
        'ACTUAL_HTTP_TOKEN',
        'ACTUAL_HTTP_WRITE_TOKEN',
        'ACTUAL_ENCRYPTION_PASSWORDS',
        'ACTUAL_READ_ONLY',
      ]) {
        delete process.env[name];
      }
    }
  }, 30_000);

  it('answers a budget that is still opening without sending anything to it', async () => {
    // Told through argv, because the environment a worker gets is an
    // allowlist and nothing a test invents is on it.
    const workers = pool({ readyMs: 150 }, ['--ready-ms=4000']);

    const reply = await workers.call('sync-one', { name: 'create_transaction', readOnly: false });

    expect(reply.isError).toBe(true);
    expect(said(reply)).toContain('still opening');
    // The half that matters on a write: repeating it cannot duplicate
    // anything, because it was never dispatched.
    expect(said(reply)).toContain('nothing was sent to it');
  }, 30_000);

  it('keeps at most the budgets it was told to, and drops the least used', async () => {
    const workers = pool({ maxWorkers: 2 });

    await workers.call('sync-one', { name: 'get_budget_month', readOnly: true });
    await workers.call('sync-two', { name: 'get_budget_month', readOnly: true });
    await workers.call('sync-three', { name: 'get_budget_month', readOnly: true });

    const open = workers.openBudgets();
    expect(open).toHaveLength(2);
    expect(open).toContain('sync-three');
    expect(open).not.toContain('sync-one');
  }, 30_000);

  it('does not drop a worker that is in the middle of a call', async () => {
    const workers = pool({ maxWorkers: 1, readyMs: 2_000 }, ['--slow-call-ms=300']);
    await workers.call('sync-one', { name: 'get_budget_month', readOnly: true });

    // One worker allowed, one call in flight on it, and another budget
    // asking: the call in flight wins, and the one asking waits and is told.
    const slow = workers.call('sync-one', { name: 'get_budget_month', readOnly: true });
    const second = workers.call('sync-two', { name: 'get_budget_month', readOnly: true });

    const [first, other] = await Promise.all([slow, second]);
    expect(said(first)).toContain('month of sync-one');
    expect(other).toBeDefined();
  }, 30_000);

  it('does not repeat a write whose worker stopped, and says what it cannot rule out', async () => {
    const workers = pool({}, ['--die=write']);

    const reply = await workers.call('sync-one', { name: 'create_transaction', readOnly: false });

    expect(reply.isError).toBe(true);
    expect(said(reply)).toContain('Check the budget before repeating it');
    expect(said(reply)).toContain('duplicate');
  }, 30_000);

  it('sends a write once, and not again, when the worker dies holding it', async () => {
    // The attempts are counted in a file, because a worker that exits
    // mid-call takes its own tally with it. What is being checked is that
    // the pool does not quietly try the write a second time: the engine
    // can apply a change and still report an error, and a retry would then
    // write it twice.
    const counted = path.join(mkdtempSync(path.join(os.tmpdir(), 'actual-mcp-writes-')), 'log');
    const workers = pool({}, ['--die=write', `--count-file=${counted}`]);

    await workers.call('sync-one', { name: 'create_transaction', readOnly: false });

    expect(readFileSync(counted, 'utf8').trim().split('\n')).toEqual(['write in sync-one']);
  }, 30_000);

  it('repeats a read whose worker died, because repeating it costs a round trip', async () => {
    const counted = path.join(mkdtempSync(path.join(os.tmpdir(), 'actual-mcp-reads-')), 'log');
    const workers = pool({}, ['--die=read', `--count-file=${counted}`]);

    const reply = await workers.call('sync-one', { name: 'get_budget_month', readOnly: true });

    // The stub dies on the read, so what came back is the failure; what
    // matters here is that the pool did try a second worker, which the
    // write above never gets.
    expect(reply.isError).toBe(true);
    expect(readFileSync(counted, 'utf8').trim().split('\n')).toEqual([
      'read in sync-one',
      'read in sync-one',
    ]);
  }, 30_000);

  it('says which budget a worker is talking about, without its credentials', async () => {
    const lines: string[] = [];
    const workers = pool({ log: (line: string) => lines.push(line) });

    await workers.call('sync-one', { name: 'get_budget_month', readOnly: true });
    const start = Date.now();
    while (!lines.some((line) => line.includes('stub worker up')) && Date.now() - start < 5_000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const line = lines.find((said) => said.includes('stub worker up'));
    expect(line).toBeDefined();
    // Which of them said it, since several are talking at once.
    expect(line).toContain('[sync-one]');
    // And not the password that was in the URL it printed.
    expect(line).not.toContain('hunter2');
    expect(line).toContain('actual.example');
  }, 30_000);

  it('says to ask for less when a reply is too large to carry back', async () => {
    // Measured: a listed transaction is about 206 bytes, so the transport's
    // own 10 MB is about 48,000 rows and `limit` is a number the caller
    // picks. The buffer is 32 MB in a real server; here it is small enough
    // to reach in a test, and what matters is the sentence.
    const workers = pool({ bufferBytes: 64 * 1024 }, ['--big-bytes=200000']);

    const reply = await workers.call('sync-one', { name: 'get_budget_month', readOnly: true });

    expect(reply.isError).toBe(true);
    expect(said(reply)).toContain('limit');
  }, 30_000);

  it('carries a reply larger than the transport would take by default', async () => {
    // The SDK's own buffer is 10 MB, and a budget's largest listing is
    // bigger than that: measured, `get_transactions` at 20,000 rows is
    // 3.93 MiB, so about 48,000 rows reaches 10 MB. The pool asks for 32 MB
    // so that a listing a caller can legitimately ask for is not cut off by
    // the pipe. Nothing here is configured: this is the default.
    const workers = pool({}, ['--big-bytes=12000000']);

    const reply = await workers.call('sync-one', { name: 'get_budget_month', readOnly: true });

    expect(reply.isError).toBeFalsy();
    expect(said(reply).length).toBeGreaterThan(11_000_000);
  }, 30_000);

  /** A temporary file path for the stub to write to. */
  function scratch(name: string): string {
    return path.join(mkdtempSync(path.join(os.tmpdir(), 'actual-mcp-pool-')), name);
  }

  /** Which processes the stub started, and which of them are still alive. */
  function processes(pidFile: string): { started: number[]; alive: number[] } {
    const started = readFileSync(pidFile, 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line !== '')
      .map(Number);
    const alive = started.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    return { started, alive };
  }

  it('starts one replacement for a dead worker, not one per call in flight', async () => {
    // Two reads on a worker that dies. Each of them learns about it, and
    // each of them goes looking for a worker: measured before the fix,
    // three processes for one budget, two alive at once on the same data
    // directory, one of them in no map at all and still running after
    // `stop()`. What makes the difference is comparing identity rather
    // than the budget id when forgetting one.
    const pidFile = scratch('pids');
    const workers = pool({}, ['--die=read', `--pid-file=${pidFile}`]);

    await Promise.all([
      workers.call('sync-one', { name: 'get_budget_month', readOnly: true }),
      workers.call('sync-one', { name: 'get_budget_month', readOnly: true }),
    ]);

    // The one that died, and one replacement between them.
    expect(processes(pidFile).started).toHaveLength(2);

    await workers.stop();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(processes(pidFile).alive).toEqual([]);
  }, 30_000);

  it('does not let a dead worker take its replacement out of the map', async () => {
    // The dead one's idle timer is armed after the call it died in, and it
    // used to fire `stopWorker` on a worker that had already been replaced,
    // which deleted the budget from the map: the healthy worker was dropped
    // with a call in flight and never closed again.
    const pidFile = scratch('pids');
    const dieOnce = scratch('died');
    const workers = pool({ idleMs: 400 }, [
      `--die-once=${dieOnce}`,
      `--pid-file=${pidFile}`,
      '--slow-call-ms=700',
    ]);

    // Dies, is replaced, and the replacement answers.
    const first = await workers.call('sync-one', { name: 'get_budget_month', readOnly: true });
    expect(said(first)).toContain('month of sync-one');

    // In flight across the moment the dead one's timer comes due.
    const second = workers.call('sync-one', { name: 'get_budget_month', readOnly: true });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(workers.openBudgets()).toEqual(['sync-one']);
    expect(said(await second)).toContain('month of sync-one');

    await workers.stop();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(processes(pidFile).alive).toEqual([]);
  }, 30_000);

  it('says a slow write may have been applied, and leaves its worker alone', async () => {
    // Sixty seconds of the SDK's default produced `Request timed out`, which
    // reads like a refusal, while the worker logged the write three seconds
    // later. The sentence is the fix; not touching the worker is the rest of
    // it, because a budget closed underneath a write is how one gets half
    // applied.
    const counted = scratch('writes');
    // `readyMs` well above what spawning costs, including on the slowest
    // runner: it is the wait for a worker to open, and this test is about
    // what happens after one has. It is also how long the second budget
    // waits for room before saying everything is busy.
    const workers = pool({ writeTimeoutMs: 300, maxWorkers: 1, readyMs: 5_000 }, [
      '--slow-write-ms=1500',
      `--count-file=${counted}`,
    ]);

    const reply = await workers.call('sync-one', { name: 'create_transaction', readOnly: false });

    expect(reply.isError).toBe(true);
    expect(said(reply)).toContain('may have been applied');
    expect(said(reply)).toContain('duplicate');
    // Still holding its budget, and still the only worker there is room for.
    expect(workers.openBudgets()).toEqual(['sync-one']);
    const other = await workers.call('sync-two', { name: 'get_budget_month', readOnly: true });
    expect(said(other)).toMatch(/busy/i);
    expect(workers.openBudgets()).toEqual(['sync-one']);

    // And the write it was still running did land.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(readFileSync(counted, 'utf8')).toContain('write in sync-one');
  }, 30_000);

  it('starts a new worker for a write when the old one died while idle', async () => {
    // Nothing was sent to the dead one, so there is nothing to be careful
    // about: the write goes to a worker that is alive, once.
    const pidFile = scratch('pids');
    const counted = scratch('writes');
    const workers = pool({}, [`--pid-file=${pidFile}`, `--count-file=${counted}`]);

    await workers.call('sync-one', { name: 'get_budget_month', readOnly: true });
    const [first] = processes(pidFile).started;
    process.kill(first, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 400));

    const reply = await workers.call('sync-one', { name: 'create_transaction', readOnly: false });

    expect(said(reply)).toContain('written in sync-one');
    expect(said(reply)).not.toContain('may have been applied');
    const writes = readFileSync(counted, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('write'));
    expect(writes).toEqual(['write in sync-one']);
  }, 30_000);

  it('refuses an id that would put a budget outside the data directory', async () => {
    const pidFile = scratch('pids');
    const workers = pool({}, [`--pid-file=${pidFile}`]);

    const reply = await workers.call('../elsewhere', { name: 'get_budget_month', readOnly: true });

    expect(reply.isError).toBe(true);
    expect(said(reply)).toContain('not a budget id');
    expect(existsSync(pidFile)).toBe(false);
  }, 30_000);

  it('says the last thing a worker wrote, newline or not', async () => {
    const lines: string[] = [];
    const workers = pool({ log: (line: string) => lines.push(line) }, [
      '--last-word=the last thing it ever said',
    ]);

    await workers.call('sync-one', { name: 'get_budget_month', readOnly: true });
    await workers.stop();
    await new Promise((resolve) => setTimeout(resolve, 300));

    // A line of its own: nothing followed it, so without the flush on
    // close it is never said at all.
    expect(lines).toContain('[sync-one] the last thing it ever said');
  }, 30_000);

  it('keeps a worker that wrote something it could not parse', async () => {
    // `onerror` is not a death: the transport reports a line it could not
    // read, and the process that wrote it is alive. Measured before this,
    // one `this is not json` on stdout left three processes for one budget,
    // two of them running and one in no map at all -- on a real server the
    // data directory lock then refuses the replacement until the orphan
    // idles out.
    const pidFile = scratch('pids');
    const lines: string[] = [];
    const workers = pool({ log: (line: string) => lines.push(line) }, [
      '--junk-line',
      `--pid-file=${pidFile}`,
    ]);

    const reply = await workers.call('sync-one', { name: 'get_budget_month', readOnly: true });
    // The second call is where a transport error mistaken for a death
    // shows: the next dispatch finds a worker it believes is gone and
    // starts another one on the same data directory.
    const again = await workers.call('sync-one', { name: 'get_budget_month', readOnly: true });

    expect(said(reply)).toContain('month of sync-one');
    expect(said(again)).toContain('month of sync-one');
    expect(processes(pidFile).started).toHaveLength(1);
    expect(workers.openBudgets()).toEqual(['sync-one']);
    // Said once, where that worker's own output goes.
    expect(lines.some((line) => line.includes('[sync-one] transport error'))).toBe(true);

    await workers.stop();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(processes(pidFile).alive).toEqual([]);
  }, 30_000);

  it('closes a worker it was told had gone, rather than dropping it', async () => {
    // "Connection closed" from a process that is alive and goes on running.
    // Forgetting one of those leaves nobody holding its handle, on a data
    // directory the next worker for that budget cannot claim, until it
    // idles out -- which is the same orphan the transport errors made.
    const pidFile = scratch('pids');
    const workers = pool({ args: [RAW, `--pid-file=${pidFile}`] });

    const reply = await workers.call('sync-one', { name: 'get_budget_month', readOnly: true });
    expect(reply.isError).toBe(true);

    await workers.stop();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(processes(pidFile).alive).toEqual([]);
  }, 30_000);

  it('gives the slot back a while after a write outlasted its timeout', async () => {
    // The write is still running in there and nothing here can see it end,
    // so the budget was held for the life of the process: measured, another
    // budget went on being told everything was busy long after the write
    // had landed.
    const counted = scratch('writes');
    const workers = pool(
      { writeTimeoutMs: 300, reclaimMs: 700, maxWorkers: 1, readyMs: 5_000 },
      ['--slow-write-ms=1200', `--count-file=${counted}`],
    );

    const reply = await workers.call('sync-one', { name: 'create_transaction', readOnly: false });
    expect(said(reply)).toContain('may have been applied');

    // Held at first, which is the point of the window.
    expect(workers.openBudgets()).toEqual(['sync-one']);

    await new Promise((resolve) => setTimeout(resolve, 1_500));

    // And then let go, so the one budget this pool has room for is free.
    expect(workers.openBudgets()).toEqual([]);
    const other = await workers.call('sync-two', { name: 'get_budget_month', readOnly: true });
    expect(said(other)).toContain('month of sync-two');
  }, 30_000);

  it('sends nothing else to a worker whose write outlasted its timeout', async () => {
    // The first write is still being applied in there and this server has
    // stopped waiting on it. A second write handed to the same worker
    // would be sent to a process that is about to be closed, and closed
    // halfway through is how one gets half applied.
    const counted = scratch('writes');
    const pidFile = scratch('pids');
    const workers = pool(
      { writeTimeoutMs: 300, reclaimMs: 4_000, maxWorkers: 1, readyMs: 600 },
      ['--slow-write-ms=1200', `--count-file=${counted}`, `--pid-file=${pidFile}`],
    );

    const first = await workers.call('sync-one', { name: 'create_transaction', readOnly: false });
    expect(said(first)).toContain('may have been applied');

    const second = await workers.call('sync-one', { name: 'create_transaction', readOnly: false });

    // No room for another, because the one on its way out still counts.
    expect(said(second)).toMatch(/busy/i);
    expect(processes(pidFile).started).toHaveLength(1);

    // And the write that was already running is the only one that landed.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const writes = readFileSync(counted, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('write'));
    expect(writes).toEqual(['write in sync-one']);

    // Leaving closes it too, even though it is no longer the worker for
    // its budget: it is still a process holding one.
    await workers.stop();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(processes(pidFile).alive).toEqual([]);
  }, 30_000);

  it('starts another worker for that budget when there is room for one', async () => {
    const pidFile = scratch('pids');
    const workers = pool(
      { writeTimeoutMs: 300, reclaimMs: 4_000, maxWorkers: 2, readyMs: 5_000 },
      ['--slow-write-ms=1200', `--pid-file=${pidFile}`],
    );

    await workers.call('sync-one', { name: 'create_transaction', readOnly: false });
    const second = await workers.call('sync-one', { name: 'get_budget_month', readOnly: true });

    expect(said(second)).toContain('month of sync-one');
    // A second process for the same budget, not the one that is retiring.
    expect(processes(pidFile).started).toHaveLength(2);
  }, 30_000);

  it('keeps a reported name to one line, whatever it is told', async () => {
    // It lands in a list where every line is a budget, so a name with a
    // newline in it is two budgets and one ending in `  [open]` is a lie
    // about which of them is open.
    // `NUL` is spelled out because a command line cannot carry that byte;
    // the stub turns it back into one.
    const nasty = 'Household\n' + 'sync-nine  [open]' + '\u001B[31m  more' + '\u0007NULend';
    const workers = pool({}, [`--report-name=${nasty}`]);

    await workers.call('sync-one', { name: 'get_budget_month', readOnly: true });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const name = workers.knownBudgets().get('sync-one')?.name ?? '';
    expect(name).not.toContain('\n');
    expect(name).not.toContain('\u001B');
    expect(name).not.toContain('\u0007');
    expect(name).not.toContain('\u0000');
    expect(name).not.toContain('  ');
    expect(name).toBe('Household sync-nine [open] more end');
  }, 30_000);

  it('names the time a read actually waited, not the time a write would', async () => {
    const workers = pool({ readTimeoutMs: 2_000 }, ['--slow-call-ms=5000']);

    const reply = await workers.call('sync-one', { name: 'get_budget_month', readOnly: true });

    expect(said(reply)).toContain('within 2 seconds');
    expect(said(reply)).not.toContain('3600');
    expect(said(reply)).toContain('Nothing was changed');
  }, 30_000);

  it('learns a budget name from the worker that opened it, and keeps it', async () => {
    // The front end cannot read it: the name is inside the budget file, in
    // the worker's data directory. It arrives as a notification on the pipe
    // the pool is already listening to, so it costs no round trip, and it
    // outlives the worker because a worker is closed after fifteen idle
    // minutes and a list of ids is what this was meant to stop.
    const workers = pool({}, ['--report-name=Household']);

    await workers.call('sync-one', { name: 'get_budget_month', readOnly: true });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(workers.knownBudgets().get('sync-one')?.name).toBe('Household');

    await workers.stop();
    expect(workers.openBudgets()).toEqual([]);
    expect(workers.knownBudgets().get('sync-one')?.name).toBe('Household');
  }, 30_000);

  it('learns what the two versions said, from the process that could tell', async () => {
    // The front end has no connection to the Actual server, so this is the
    // only way it can say anything about versions at all.
    const check = JSON.stringify({
      kind: 'mismatch',
      server: '26.12.0',
      library: '26.11.0',
      serverIs: 'ahead',
    });
    const workers = pool({}, ['--report-name=Household', `--report-version=${check}`]);

    await workers.call('sync-one', { name: 'get_budget_month', readOnly: true });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(workers.knownBudgets().get('sync-one')?.version).toEqual({
      kind: 'mismatch',
      server: '26.12.0',
      library: '26.11.0',
      serverIs: 'ahead',
    });
  }, 30_000);

  it('drops a version it cannot make sense of, and the name with it', async () => {
    const cases = [
      '{"kind":"something-else","library":"26.11.0"}',
      '{"kind":"mismatch","server":"26.12.0","library":"26.11.0","serverIs":"sideways"}',
      '{"kind":"mismatch","server":"26.12.0"}',
      `{"kind":"match","server":"${'9'.repeat(60)}","library":"26.11.0"}`,
    ];

    for (const version of cases) {
      const workers = pool({}, ['--report-name=Household', `--report-version=${version}`]);
      await workers.call('sync-one', { name: 'get_budget_month', readOnly: true });
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect([...workers.knownBudgets().keys()], version).toEqual([]);
      await workers.stop();
    }
  }, 30_000);

  it('believes a worker about its own budget and nothing else', async () => {
    // It arrives as a log notification, which anything on the other end of
    // a pipe can send.
    const cases = [
      ['--report-id=sync-two', '--report-name=Somebody else'],
      ['--report-name=TOO-LONG'],
      ['--report-logger=something-else', '--report-name=Household'],
    ];

    for (const flags of cases) {
      const workers = pool({}, flags);
      await workers.call('sync-one', { name: 'get_budget_month', readOnly: true });
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect([...workers.knownBudgets().keys()], flags.join(' ')).toEqual([]);
      await workers.stop();
    }
  }, 30_000);

  it('lets go of a worker that has had nothing to do', async () => {
    const workers = pool({ idleMs: 60 });
    await workers.call('sync-one', { name: 'get_budget_month', readOnly: true });
    expect(workers.openBudgets()).toEqual(['sync-one']);

    await new Promise((resolve) => setTimeout(resolve, 400));

    // Closing it is what signs the worker out of the Actual server, which
    // is what clears the session 26.11 keeps for every sign-in (#219).
    expect(workers.openBudgets()).toEqual([]);
  }, 30_000);

  it('closes everything when it is told to leave', async () => {
    const workers = pool();
    await workers.call('sync-one', { name: 'get_budget_month', readOnly: true });
    expect(workers.openBudgets()).toHaveLength(1);

    await workers.stop();

    expect(workers.openBudgets()).toEqual([]);
    const after = await workers.call('sync-one', { name: 'get_budget_month', readOnly: true });
    expect(after.isError).toBe(true);
  }, 30_000);
});
