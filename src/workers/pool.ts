import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readEnv } from '../utils/env.js';
import { withoutCredentials } from '../utils/redact.js';
import { effectiveDataDir } from '../utils/data-dir-lock.js';
import { unsafeBudgetId } from '../utils/budgets.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { WORKER_LOGGER, tidyCheck, tidyName, type BudgetReport } from './report.js';
import { WORKER_FLAG } from './worker-env.js';
import { encryptionPasswordFor, workerEnvironment } from './worker-env.js';

/**
 * One worker process per budget, and the front end that routes to them
 * (#229).
 *
 * `api.init` and `loadBudget` are process-global: one process has one budget
 * open, and so is everything built on them here, the data directory lock of
 * #207, the write queues, the currency cache and, from 26.11, the session on
 * the Actual server. That is not a layer to work around, so the unit of
 * isolation is a process.
 *
 * A worker is this server, unchanged, in the mode it has always had. The
 * pool holds an SDK `Client` over a `StdioClientTransport`, which is the
 * protocol two audits have already been through rather than a second
 * dispatch layer written for this, and it means every invariant that has
 * been audited holds inside the process that owns the budget.
 *
 * ## What the front end does not do
 *
 * It opens no budget, holds no data directory and takes no lock. That is
 * what lets it answer `tools/list` and `list_budgets` without starting
 * anything, and it means a call is either routed or refused, never
 * half-served from here.
 */

/** How many budgets are open at once. */
const DEFAULT_WORKERS = 3;
/** How long a worker with nothing to do is kept. */
const DEFAULT_IDLE_MINUTES = 15;
/**
 * How long a call waits for a budget to open.
 *
 * Below what the caller will put up with, rather than above how long a
 * download takes. Measured in the versions this server pins: the SDK's
 * client gives a request 60 seconds (`DEFAULT_REQUEST_TIMEOUT_MSEC`), and
 * this server puts 60 seconds on each HTTP request it makes
 * (`DEFAULT_HTTP_TIMEOUT_MS`). A wait longer than that buys nothing: the
 * client has already given up, and what it shows is its own timeout rather
 * than anything written here. Forty-five leaves fifteen seconds of the
 * client's minute for the rest of the call.
 */
const DEFAULT_READY_SECONDS = 45;
/**
 * How large a reply a worker may send.
 *
 * Measured: a listed transaction costs about 206 bytes, so the transport's
 * own 10 MB is about 48,000 rows, and `limit` is a number the caller picks.
 * A client asking for fifty thousand would not get an error, it would kill
 * the worker's transport. Thirty-two megabytes is about 160,000 rows, and a
 * reply that still does not fit is answered by naming `limit`.
 */
const BUFFER_BYTES = 32 * 1024 * 1024;
/**
 * How long the front end waits for a write before it stops waiting.
 *
 * The SDK gives a request 60 seconds by default, and that default is wrong
 * here in the one case that matters: a write that takes longer is not a
 * write that failed, it is a write still being applied in a process this
 * one cannot see into. Sixty seconds of it produced `Request timed out`,
 * which reads like a refusal, while `WRITE APPLIED` turned up in the
 * worker's log three seconds later.
 *
 * So it is an hour, flat. Not `resetTimeoutOnProgress`: the SDK only sends
 * a progress token when the caller passes `onprogress`, and these tools
 * report no progress, so the option would have been a comment that was not
 * true of the code. An hour is far past any write a budget has, and still
 * an upper bound rather than none, which is the difference between a
 * worker that will never answer and a budget held for the life of the
 * process.
 */
const WRITE_TIMEOUT_MS = 60 * 60_000;
/**
 * And how long a read waits.
 *
 * The SDK's own default, written down here because the answer names it:
 * reading it off `DEFAULT_REQUEST_TIMEOUT_MSEC` would say 60 in one place
 * and 3600 in the other, which is how a reply came to tell a caller their
 * read had been waiting an hour.
 */
const READ_TIMEOUT_MS = 60_000;
/**
 * How long a worker is left alone after a write outlasted its timeout.
 *
 * The write is still running in there and nothing here can see the end of
 * it: the SDK has already given up on the request, so the answer, whenever
 * it comes, lands nowhere. Holding the budget for the life of the process
 * is not an answer either -- measured, another budget went on being told
 * everything was busy long after the write had been applied. So the slot
 * comes back after this, and the worker is closed rather than reused,
 * because a budget whose last write is unaccounted for is better reopened.
 */
const RECLAIM_MS = 5 * 60_000;

export interface ToolCall {
  name: string;
  arguments?: Record<string, unknown>;
  /** Whether repeating it is free, which decides what happens if a worker dies. */
  readOnly: boolean;
}

export interface ToolReply {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export interface PoolOptions {
  command?: string;
  args?: string[];
  maxWorkers?: number;
  idleMs?: number;
  readyMs?: number;
  bufferBytes?: number;
  writeTimeoutMs?: number;
  readTimeoutMs?: number;
  reclaimMs?: number;
  dataDirFor?: (budgetId: string) => string;
  log?: (line: string) => void;
}

interface Worker {
  budgetId: string;
  client: Client;
  transport: StdioClientTransport;
  ready: Promise<void>;
  inFlight: number;
  /**
   * Writes that were sent and never came back.
   *
   * A write that outlasts the front end's patience is still running in the
   * worker, and the worker is the only thing that knows how it ends. It is
   * counted so that nothing here closes that budget underneath it.
   */
  unfinishedWrites: number;
  lastUsed: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  reclaimTimer?: ReturnType<typeof setTimeout>;
  stopping?: boolean;
  died?: Error;
  /**
   * The last thing the transport complained about, which is not a death.
   *
   * Kept apart from `died` on purpose: a reply too large to read arrives
   * here and nowhere else, so the answer that names `limit` is built from
   * it, while the process it came from is still running and still has to
   * be closed rather than dropped.
   */
  lastError?: Error;
}

function text(message: string, isError = true): ToolReply {
  return { content: [{ type: 'text', text: message }], isError };
}

/** The entry point a worker runs, which is this server. */
function defaultEntry(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js');
}

function number(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class WorkerPool {
  private readonly workers = new Map<string, Worker>();
  /**
   * The last thing each budget's worker said about itself.
   *
   * Kept by budget and not by worker, on purpose: a worker is closed after
   * fifteen idle minutes, and a name that went with it would leave
   * `list_budgets` saying "not opened yet" about a budget it opened twice
   * this morning. So this is the last seen, and a new worker replaces it.
   */
  private readonly seen = new Map<string, BudgetReport>();
  /**
   * Workers that are on their way out and still hold a budget.
   *
   * A write that outlasted its timeout leaves one of these: the process is
   * alive, the budget is open in it, and this server is not going to send
   * it anything else. They are out of the map so that the next call for
   * that budget does not land on one, and counted so that leaving one
   * behind cannot quietly raise the number of budgets open at once.
   */
  private readonly retiring = new Set<Worker>();
  private readonly options: Required<Omit<PoolOptions, 'dataDirFor' | 'log'>> &
    Pick<PoolOptions, 'dataDirFor' | 'log'>;
  private stopped = false;

  constructor(options: PoolOptions = {}) {
    this.options = {
      command: options.command ?? process.execPath,
      args: options.args ?? [defaultEntry()],
      maxWorkers: options.maxWorkers ?? number('ACTUAL_BUDGET_WORKERS', DEFAULT_WORKERS),
      idleMs: options.idleMs ?? number('ACTUAL_WORKER_IDLE_MINUTES', DEFAULT_IDLE_MINUTES) * 60_000,
      readyMs: options.readyMs ?? number('ACTUAL_WORKER_READY_SECONDS', DEFAULT_READY_SECONDS) * 1_000,
      bufferBytes: options.bufferBytes ?? BUFFER_BYTES,
      writeTimeoutMs: options.writeTimeoutMs ?? WRITE_TIMEOUT_MS,
      readTimeoutMs: options.readTimeoutMs ?? READ_TIMEOUT_MS,
      reclaimMs: options.reclaimMs ?? RECLAIM_MS,
      dataDirFor: options.dataDirFor,
      log: options.log,
    };
  }

  /** Which budgets are open, for diagnostics and for the tests. */
  openBudgets(): string[] {
    return [...new Set([...this.workers.keys(), ...[...this.retiring].map((w) => w.budgetId)])];
  }

  /** What each budget's worker said about it, the last time one ran. */
  knownBudgets(): ReadonlyMap<string, BudgetReport> {
    return this.seen;
  }

  /**
   * Believe a worker about its own budget, and nothing else.
   *
   * It arrives as a log notification, which anything on the other end of a
   * pipe can send, so what is accepted is narrow: this pool's own child,
   * the logger name a worker uses, its own budget id, and a name that is a
   * string of a sane length. Anything else is dropped without a word, and
   * none of it is ever passed on to the client.
   */
  private heard(worker: Worker, params: unknown): void {
    const data = (params as { logger?: unknown; data?: unknown })?.data;
    if ((params as { logger?: unknown })?.logger !== WORKER_LOGGER) return;
    if (typeof data !== 'object' || data === null) return;

    const { budgetId, name, version } = data as {
      budgetId?: unknown;
      name?: unknown;
      version?: unknown;
    };
    if (budgetId !== worker.budgetId) return;

    // Not just the type and the length: this name is going into a list
    // where every line is a budget, so what it must not contain is a line
    // of its own.
    const tidy = tidyName(name);
    if (name !== undefined && tidy === undefined) return;

    // The same for what it says about the versions, which becomes a
    // sentence in that same reply.
    const checked = tidyCheck(version);
    if (version !== undefined && checked === undefined) return;

    this.seen.set(worker.budgetId, {
      budgetId: worker.budgetId,
      ...(tidy === undefined ? {} : { name: tidy }),
      ...(checked === undefined ? {} : { version: checked }),
    });
  }

  async call(budgetId: string, call: ToolCall): Promise<ToolReply> {
    if (this.stopped) return text('This server is shutting down and did not run that.');

    let worker: { worker: Worker } | { refusal: ToolReply };
    try {
      worker = await this.waitingFor(budgetId);
    } catch (error) {
      // Nothing was started, so there is nothing to clean up and nothing
      // was sent: an id that is not an id lands here.
      return text(
        `That budget could not be opened: ${withoutCredentials(
          error instanceof Error ? error.message : String(error),
        )}`,
      );
    }
    if ('refusal' in worker) return worker.refusal;

    try {
      return await this.dispatch(worker.worker, call, true);
    } finally {
      // Claimed in `waitingFor`, released here: a worker is spoken for from
      // the moment a call starts waiting on it, not from the moment the
      // call is dispatched. Otherwise a second budget arriving during the
      // wait finds it idle and evicts it underneath (measured: the first
      // call came back "Not connected").
      worker.worker.inFlight -= 1;
      this.touch(worker.worker);
    }
  }

  /** The worker to use, or what to tell the caller instead. */
  private async waitingFor(budgetId: string): Promise<{ worker: Worker } | { refusal: ToolReply }> {
    const started = Date.now();
    let existing = this.workers.get(budgetId);

    if (existing === undefined) {
      const room = await this.makeRoom(budgetId, started);
      if (room !== undefined) return { refusal: room };
      existing = this.workers.get(budgetId) ?? this.start(budgetId);
    }

    existing.inFlight += 1;
    const left = this.options.readyMs - (Date.now() - started);
    const ready = await this.within(existing.ready, left);
    if (ready === 'too slow') {
      existing.inFlight -= 1;
      // Nothing was dispatched, which is the half that matters on a write.
      return {
        refusal: text(
          `That budget is still opening. It started ${Math.round(
            (Date.now() - started) / 1000,
          )} seconds ago, and the first time it is read the whole file is downloaded. ` +
            'Nothing was read or written, and nothing was sent to it: ask again in a moment ' +
            'and it will answer from the copy it has.',
        ),
      };
    }
    if (ready instanceof Error) {
      existing.inFlight -= 1;
      this.forget(existing);
      return { refusal: text(`That budget could not be opened: ${ready.message}`) };
    }

    return { worker: existing };
  }

  /**
   * Room for one more budget, or what to tell the caller.
   *
   * The least recently used worker goes, and only one with nothing in
   * flight: closing a budget underneath a call that is using it is the
   * failure the orderly exit exists to avoid (#219). When every worker is
   * busy, the call waits as it would for a download, and is answered the
   * same way.
   */
  private async makeRoom(budgetId: string, started: number): Promise<ToolReply | undefined> {
    while (
      this.workers.size + this.retiring.size >= this.options.maxWorkers &&
      !this.workers.has(budgetId)
    ) {
      const idle = [...this.workers.values()]
        .filter(
          (worker) =>
            worker.inFlight === 0 && worker.unfinishedWrites === 0 && worker.stopping !== true,
        )
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];

      if (idle !== undefined) {
        await this.stopWorker(idle, 'evicted to make room');
        continue;
      }

      if (Date.now() - started >= this.options.readyMs) {
        return text(
          `This server keeps ${this.options.maxWorkers} budgets open at once and all of them ` +
            `are busy, so ${budgetId} was not opened. Nothing was read or written, and nothing ` +
            'was sent to it: ask again in a moment.',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return undefined;
  }

  /** Spawn one, and probe it until the budget is actually open. */
  private start(budgetId: string): Worker {
    // The id names a directory, so it has to be an id. Startup says this
    // about the configuration; this is the place that would build the path.
    if (unsafeBudgetId(budgetId)) {
      throw new Error(
        `${budgetId} is not a budget id, and each budget is kept in a directory named after ` +
          'its id. Nothing was opened.',
      );
    }

    const dataDir =
      this.options.dataDirFor?.(budgetId) ?? path.join(effectiveDataDir(), 'budgets', budgetId);

    const transport = new StdioClientTransport({
      command: this.options.command,
      // The flag that tells the child it is a worker. On the command line
      // rather than in the environment, so that nothing a user exports can
      // make a server behave like one.
      args: [...this.options.args, WORKER_FLAG],
      env: workerEnvironment({
        budgetId,
        dataDir,
        encryptionPassword: encryptionPasswordFor(budgetId),
      }),
      stderr: 'pipe',
      maxBufferSize: this.options.bufferBytes,
    });

    const client = new Client({ name: 'actual-budget-mcp', version: '0' });
    const worker: Worker = {
      budgetId,
      client,
      transport,
      inFlight: 0,
      unfinishedWrites: 0,
      lastUsed: Date.now(),
      ready: Promise.resolve(),
    };

    // Before connecting, because a worker says it as soon as its budget is
    // open and that can be before the probe comes back.
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      this.heard(worker, notification.params);
    });

    worker.ready = (async () => {
      await client.connect(transport);
      this.pipeStderr(worker);
      this.watch(worker);
      // A real read, because only a read proves the budget is open: the
      // handshake answers long before the file has been downloaded.
      await client.callTool({ name: 'list_accounts', arguments: {} });
    })();

    this.workers.set(budgetId, worker);
    this.touch(worker);
    return worker;
  }

  /**
   * Notice when a worker dies, without taking the SDK's notice away.
   *
   * `connect` installs the protocol's own `onclose`, and that is what
   * rejects the requests still in flight when a child exits. Replacing it
   * leaves them pending until the client's own minute runs out, which is a
   * call that hangs instead of a call that fails: measured, a write whose
   * worker exited never came back. So this is installed after `connect`,
   * and it calls the handler it found.
   */
  private watch(worker: Worker): void {
    const closedBefore = worker.transport.onclose;
    worker.transport.onclose = () => {
      worker.died ??= new Error('the worker stopped');
      // Out of the map the moment it dies, and by identity: the next call
      // for this budget starts a worker instead of sending to a transport
      // that is already closed, and a replacement that is already there is
      // left alone.
      this.forget(worker);
      closedBefore?.();
    };
    const erroredBefore = worker.transport.onerror;
    worker.transport.onerror = (error: Error) => {
      // Not a death. `onerror` is also how the transport reports a line it
      // could not parse, and the process that wrote it is alive and well:
      // measured, one `this is not json` on stdout used to leave three
      // processes for one budget, two of them running and one in no map at
      // all, which on a real server is the data directory lock refusing the
      // replacement until the orphan idles out. Only `onclose` is a death.
      // The line itself is worth saying, once, where the worker's own
      // output goes.
      worker.lastError = error;
      this.say(worker, `transport error: ${error.message}`);
      erroredBefore?.(error);
    };
  }

  /** One line about a worker, where that worker's own output goes. */
  private say(worker: Worker, line: string): void {
    const said = `[${worker.budgetId}] ${withoutCredentials(line)}`;
    if (this.options.log) this.options.log(said);
    else console.error(said);
  }

  /** The child's own output, prefixed and with no credentials in it. */
  private pipeStderr(worker: Worker): void {
    const stream = worker.transport.stderr;
    if (!stream) return;
    let rest = '';
    const say = (line: string) => {
      if (line.trim() === '') return;
      this.say(worker, line);
    };
    stream.on('data', (chunk: Buffer) => {
      const lines = (rest + String(chunk)).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) say(line);
    });
    // Whatever was written without a newline behind it. A process that dies
    // mid-sentence says the most interesting thing it will ever say, and
    // waiting for a newline that is never coming is how it gets dropped.
    const flush = () => {
      const last = rest;
      rest = '';
      say(last);
    };
    stream.on('end', flush);
    stream.on('close', flush);
  }

  private async dispatch(worker: Worker, call: ToolCall, mayRetry: boolean): Promise<ToolReply> {
    this.touch(worker);

    // A worker that died while it was idle is still the one this call was
    // handed, and sending into a closed transport fails in a way that reads
    // like a write that may have happened. It did not: nothing left this
    // process.
    if (worker.died !== undefined) {
      void this.stopWorker(worker, 'it had already stopped');
      return this.neverSent(worker, call, mayRetry);
    }

    // A clock on each, and the one the answer names. The SDK's minute is
    // for a question and an answer; a write is neither until the engine
    // says so.
    const options = {
      timeout: call.readOnly ? this.options.readTimeoutMs : this.options.writeTimeoutMs,
    };

    if (!call.readOnly) worker.unfinishedWrites += 1;
    try {
      const reply = (await worker.client.callTool(
        { name: call.name, arguments: call.arguments ?? {} },
        undefined,
        options,
      )) as ToolReply;
      if (!call.readOnly) worker.unfinishedWrites -= 1;
      return reply;
    } catch (error) {
      // A write that threw is only finished if the worker is gone. A
      // timeout leaves it running in there, and the count is what keeps
      // this process from closing that budget underneath it.
      if (!call.readOnly && (worker.died !== undefined || this.isTimeout(error) !== true)) {
        worker.unfinishedWrites -= 1;
      } else if (!call.readOnly) {
        this.reclaimLater(worker);
      }
      return this.failed(worker, call, mayRetry, error);
    }
  }

  /**
   * Give the slot back, a while after a write outlasted its timeout.
   *
   * Nothing here can see that write end: the SDK gave up on the request,
   * so its answer lands nowhere. Holding the budget until this process
   * exits is not the answer either -- measured, another budget went on
   * being told everything was busy long after the write had landed. So the
   * worker is left alone for the reclaim window, and then closed rather
   * than reused: a budget whose last write is unaccounted for is better
   * reopened from the server than carried on with.
   */
  private reclaimLater(worker: Worker): void {
    if (worker.reclaimTimer) return;
    // Out of the map first. Another call for this budget would otherwise
    // be handed a worker this server has stopped waiting on, and a second
    // write would be sent to a process that is about to be closed.
    this.retiring.add(worker);
    if (this.workers.get(worker.budgetId) === worker) this.workers.delete(worker.budgetId);
    worker.reclaimTimer = setTimeout(() => {
      worker.reclaimTimer = undefined;
      worker.unfinishedWrites = 0;
      if (worker.inFlight > 0) {
        // Busy with something else, so it goes when that ends. It stays
        // counted until then, because it is still a process holding a
        // budget.
        this.touch(worker);
        return;
      }
      void this.stopWorker(worker, 'a write outlasted the time this server waits for one');
    }, this.options.reclaimMs);
    worker.reclaimTimer.unref?.();
  }

  /** `true` when the call ran out of time rather than failing. */
  private isTimeout(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: unknown })?.code;
    return /timed out|timeout/i.test(message) || code === -32001;
  }

  /** The answer for a call that was never put on the wire. */
  private neverSent(worker: Worker, call: ToolCall, mayRetry: boolean): Promise<ToolReply> {
    if (call.readOnly && mayRetry) return this.retryRead(worker.budgetId, call);
    return Promise.resolve(
      text(
        `The worker holding that budget had already stopped, so nothing was sent to it and ` +
          'nothing was read or written. Ask again and it will be started.',
      ),
    );
  }

  /**
   * A call that did not come back, which is two different situations.
   *
   * A read can be repeated, once, on a worker that is not the dead one: a
   * read that happens twice costs a round trip. A write cannot, and the
   * front end is in a worse position than the engine's own mid-write
   * handling: it has no budget to look in. So it says what it cannot rule
   * out, in the words the engine's own failures use, and never repeats the
   * call by itself.
   */
  private async failed(
    worker: Worker,
    call: ToolCall,
    mayRetry: boolean,
    error: unknown,
  ): Promise<ToolReply> {
    const message = error instanceof Error ? error.message : String(error);
    const budgetId = worker.budgetId;
    // What the call threw and what the transport said on its way out. A
    // reply too large to read kills the transport, so the call itself comes
    // back as "Connection closed" and the reason is only in the other half:
    // `ReadBuffer exceeded maximum size of N bytes`.
    const detail = `${message} ${worker.died?.message ?? ''} ${worker.lastError?.message ?? ''}`;
    const gone = worker.died !== undefined || /closed|terminated|EPIPE|exited/i.test(message);

    if (/ReadBuffer exceeded|maximum size|too large/i.test(detail)) {
      await this.stopWorker(worker, 'a reply it could not carry');
      return text(
        'That reply was too large to carry back from the budget it was read in. Ask for ' +
          'less of it: `limit` is what decides how many rows a listing returns.',
      );
    }

    // Out of time rather than gone. The worker is alive and the call is
    // still in it, so the worker is left exactly where it is: a write that
    // is still being applied must not have its budget closed underneath it,
    // which is what evicting or idling it out would do.
    if (!gone && this.isTimeout(error)) {
      return call.readOnly
        ? text(
            `That budget did not answer within ${Math.round(
              this.options.readTimeoutMs / 1000,
            )} seconds. Nothing was changed. It may still be downloading: ask again in a moment.`,
          )
        : text(
            'That budget did not answer in time, and the worker holding it is still working ' +
              'on it. Check the budget before repeating it: the change may have been applied ' +
              'already, and repeating it would duplicate it.',
          );
    }

    if (gone) {
      // Closed rather than dropped. A worker stops being tracked only by
      // being stopped: anything else is how a live process ends up with no
      // one holding its handle, on a data directory the next one cannot
      // claim.
      await this.stopWorker(worker, 'it stopped while a call was running');
      if (call.readOnly && mayRetry) return this.retryRead(budgetId, call);
      if (!call.readOnly) {
        return text(
          `The worker holding that budget stopped while this was running: ${withoutCredentials(
            message,
          )}. Check the budget before repeating it: a change can be applied and still report ` +
            'an error, and repeating it would duplicate it.',
        );
      }
    }

    return text(`That budget could not answer: ${withoutCredentials(message)}`);
  }

  /**
   * One more go at a read, on a worker that is not the dead one.
   *
   * A read that happens twice costs a round trip, so it is worth repeating
   * once; `mayRetry` is false the second time, so this cannot loop.
   */
  private async retryRead(budgetId: string, call: ToolCall): Promise<ToolReply> {
    const fresh = this.workers.get(budgetId) ?? this.start(budgetId);
    fresh.inFlight += 1;
    try {
      const ready = await this.within(fresh.ready, this.options.readyMs);
      if (ready === undefined) return await this.dispatch(fresh, call, false);
      return text(`That budget could not be opened: ${String(ready)}`);
    } finally {
      fresh.inFlight -= 1;
      this.touch(fresh);
    }
  }

  private touch(worker: Worker): void {
    worker.lastUsed = Date.now();
    if (worker.idleTimer) clearTimeout(worker.idleTimer);
    worker.idleTimer = undefined;
    // Every worker gets a timer, including one that has been forgotten:
    // that is the one most worth closing, and `stopWorker` is identity-safe,
    // so a timer left over from a replaced worker cannot take the live one
    // out of the map. Measured before that: the healthy worker was dropped
    // with a call in flight, by its predecessor's timer.
    if (worker.inFlight > 0 || worker.unfinishedWrites > 0) return;
    worker.idleTimer = setTimeout(() => {
      // No identity check here on purpose: a worker that has been forgotten
      // and is somehow still alive is exactly the one that should be closed
      // rather than left running. `stopWorker` only removes it from the map
      // if it is still the one there.
      if (worker.inFlight > 0 || worker.unfinishedWrites > 0) return;
      void this.stopWorker(worker, 'idle');
    }, this.options.idleMs);
    worker.idleTimer.unref?.();
  }

  /**
   * Drop this worker, if it is still the one holding its budget.
   *
   * By identity and not by id. Two calls in flight on a worker that dies
   * each come through here, and the second one deleting by id would take
   * out the replacement the first one had already started: measured, three
   * processes for one budget, two of them alive on the same data directory,
   * one of them in no map at all and still running after `stop()`.
   */
  private forget(worker: Worker): void {
    if (worker.idleTimer) clearTimeout(worker.idleTimer);
    worker.idleTimer = undefined;
    if (worker.reclaimTimer) clearTimeout(worker.reclaimTimer);
    worker.reclaimTimer = undefined;
    if (this.workers.get(worker.budgetId) === worker) this.workers.delete(worker.budgetId);
  }

  /**
   * Stop one, the way a stdio client stops a server.
   *
   * Closing the transport ends the child's stdin, which is the end-of-file
   * its own exit path watches for: it finishes what is in flight, signs out
   * of the Actual server, which is what clears the session 26.11 keeps, and
   * leaves. The SDK waits two seconds and then signals.
   */
  private async stopWorker(worker: Worker, why: string): Promise<void> {
    if (worker.stopping === true) return;
    worker.stopping = true;
    this.retiring.delete(worker);
    this.forget(worker);
    const said = `[actual-budget-mcp] closing the worker for ${worker.budgetId} (${why})`;
    if (this.options.log) this.options.log(said);
    try {
      await worker.client.close();
    } catch {
      // It is on its way out either way.
    }
  }

  /** Stop all of them, for the orderly exit. */
  async stop(): Promise<void> {
    this.stopped = true;
    const all = [...this.workers.values(), ...this.retiring];
    await Promise.all(all.map((worker) => this.stopWorker(worker, 'leaving')));
  }

  /** `work`, or `'too slow'`, or the error it failed with. */
  private async within(
    work: Promise<unknown>,
    ms: number,
  ): Promise<undefined | 'too slow' | Error> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'too slow'>((resolve) => {
      timer = setTimeout(() => resolve('too slow'), Math.max(0, ms));
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([
        work.then(
          () => undefined,
          (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
        ),
        late,
      ]);
      return outcome;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
