import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerPool } from '../pool.js';

const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stub-worker.mjs');

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
