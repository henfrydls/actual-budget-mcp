import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * A budget newer than the library that has to open it (#139).
 *
 * Measured against a 26.10 budget with the 26.9 library: `downloadBudget` does
 * **not** throw. It logs `out-of-sync-migrations` and resolves, so the server
 * believed it had connected and the first tool answered `No budget file is
 * open` — a message about a file, for a version problem, with nothing in the
 * logs the person could act on.
 *
 * The detection added in #72 worked and handed the flag back. Nothing read it,
 * because the only place that looked was a `catch` for an error that is never
 * thrown. These tests hold both routes, since the engine may start propagating
 * it and then the other one is the only one that fires.
 */
vi.mock('../data-dir-lock.js', () => ({
  claimDataDir: () => ({ dataDir: '/tmp/does-not-matter', shared: false, contended: null }),
  releaseDataDir: () => {},
  effectiveDataDir: () => '/tmp/does-not-matter',
  ensureDataDirExists: () => {},
}));

const downloadBudget = vi.fn();
const getBudgetMonths = vi.fn();
const getServerVersion = vi.fn();
vi.mock('@actual-app/api', () => ({
  init: vi.fn(async () => ({ send: vi.fn() })),
  downloadBudget: (...args: unknown[]) => downloadBudget(...args),
  // What decides whether the budget opened. The engine discards the code it
  // was given, so this is the only honest question to ask.
  getBudgetMonths: (...args: unknown[]) => getBudgetMonths(...args),
  getServerVersion: (...args: unknown[]) => getServerVersion(...args),
  shutdown: vi.fn(async () => {}),
  sync: vi.fn(async () => {}),
}));

/** What the engine prints on its way to resolving anyway. */
const ENGINE_LOG = 'Error updating Error: out-of-sync-migrations';

describe('a budget that does not open (#139)', () => {
  let stderr: string[];
  let restore: () => void;

  /** The engine's way of not opening: log something, resolve anyway. */
  const engineLogs = (line: string) => {
    downloadBudget.mockImplementation(async () => {
      console.error(line);
    });
    getBudgetMonths.mockImplementation(async () => {
      throw new Error('No budget file is open');
    });
  };

  beforeEach(() => {
    vi.resetModules();
    downloadBudget.mockReset();
    getBudgetMonths.mockReset();
    getServerVersion.mockReset().mockResolvedValue({ version: '26.10.0' });
    process.env.ACTUAL_SERVER_URL = 'http://127.0.0.1:5099';
    process.env.ACTUAL_BUDGET_ID = 'a-sync-id';
    process.env.ACTUAL_PASSWORD = 'not-a-real-password';
    stderr = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void stderr.push(args.map(String).join(' '));
    restore = () => {
      console.error = original;
    };
  });

  afterEach(() => restore());

  const connect = async () => {
    const { ensureConnection } = await import('../../connection.js');
    return ensureConnection().catch((e: Error) => e);
  };

  it('fails when the budget did not open, however quietly', async () => {
    // The route the user took. `downloadBudget` resolves, so there is no error
    // to inspect; what is wrong is that no budget is open.
    engineLogs('Error updating Error: out-of-sync-migrations');

    const error = await connect();
    expect((error as Error).message).toMatch(/could not open your budget/);
    expect((error as Error).message).not.toMatch(/No budget file is open/);
  });

  it('gives both causes of a migration mismatch, with opposite fixes', async () => {
    // From 26.10 the engine accepts unknown migrations past its cutoff, so this
    // code no longer means only "your Actual is newer". It also fires on a
    // local copy missing a migration it should have, and telling that person to
    // update the server sends them nowhere.
    engineLogs('Error updating Error: out-of-sync-migrations');

    const message = ((await connect()) as Error).message;
    expect(message).toMatch(/update actual-budget-mcp|Desktop Extension/i);
    expect(message).toMatch(/delete/i);
    // Never again: on the inconsistent-copy path the local copy IS damaged.
    expect(message).not.toMatch(/nothing in your budget is damaged/i);
  });

  it('tells a drifted local copy to delete it, not to update anything', async () => {
    engineLogs('Error updating Error: out-of-sync-data');

    const message = ((await connect()) as Error).message;
    expect(message).toMatch(/out of sync with your server/i);
    expect(message).toMatch(/delete/i);
  });

  // Two markers, two tests. A first version used one line carrying both, so
  // removing either changed nothing: the fixture has to need the thing it is
  // meant to be testing.
  it.each([
    ['the SQLite error code', 'SqliteError: SQLITE_NOTADB: unable to open'],
    ['the plain-English form', 'Error: file is not a database'],
  ])('names a corrupt cache for what it is, from %s', async (_name, line) => {
    // `opening-budget` is returned without a log, so the only thing in the
    // console is SQLite's own complaint, and it has more than one wording.
    engineLogs(line);

    const message = ((await connect()) as Error).message;
    expect(message).toMatch(/not a readable database/i);
    expect(message).toMatch(/delete/i);
  });

  it('separates "downloaded but did not finish opening" from the rest', async () => {
    // `loading-budget`: the download worked and the open did not, which is a
    // different sentence from the ones above and a different thing to tell
    // someone.
    engineLogs('Error updating budget abc Error: something nobody has seen');

    const message = ((await connect()) as Error).message;
    expect(message).toMatch(/could not finish opening/i);
    expect(message).toMatch(/delete/i);
  });

  it('carries the engine line when there is no marker at all', async () => {
    downloadBudget.mockImplementation(async () => {});
    getBudgetMonths.mockImplementation(async () => {
      throw new Error('No budget file is open');
    });

    const message = ((await connect()) as Error).message;
    expect(message).toMatch(/not one it recognises/i);
    expect(message).toMatch(/said nothing at all/i);
  });

  it('repeats what the engine said when it recognises nothing', async () => {
    // The whole point of that message, and it never worked: `detail` was only
    // ever set next to a marker, so the branch for an unrecognised cause
    // always ended "The engine said nothing at all". This is the line the
    // engine really prints on the `budget-not-found` path.
    engineLogs('[Exception] Error: budget directory does not exist');

    const message = ((await connect()) as Error).message;
    expect(message).toMatch(/not one it recognises/i);
    expect(message).toContain('budget directory does not exist');
    expect(message).not.toMatch(/said nothing at all/i);
    // One remedy is offered here, so it must not ask which of them fits.
    expect(message).not.toMatch(/If neither fits/i);
  });

  it('ignores chatter that is not about a failure', async () => {
    // Keeping *any* line would make the message quote a breadcrumb.
    downloadBudget.mockImplementation(async () => {
      console.error('[Breadcrumb] { message: loading spreadsheet }');
    });
    getBudgetMonths.mockImplementation(async () => {
      throw new Error('No budget file is open');
    });

    const message = ((await connect()) as Error).message;
    expect(message).toMatch(/said nothing at all/i);
    expect(message).not.toMatch(/Breadcrumb/);
  });

  const databaseAnswers = (error: string) => {
    downloadBudget.mockImplementation(async () => {});
    getBudgetMonths.mockImplementation(async () => {
      throw new Error(error);
    });
  };

  it('keeps the real reason when the read fails for another reason', async () => {
    // `budgetIsOpen` used to swallow everything, so a locked database came out
    // as "the budget did not open, delete your cache" — advice that destroys a
    // healthy copy and loses the one line that said what was wrong.
    databaseAnswers('SQLITE_BUSY: database is locked');

    const message = ((await connect()) as Error).message;
    expect(message).toContain('SQLITE_BUSY');
    expect(message).not.toMatch(/said nothing at all/i);
  });

  it('does not send a locked database to be deleted', async () => {
    // Quoting the error was half of it. A lock clears on its own when whatever
    // holds it lets go; deleting the folder destroys a healthy copy to fix a
    // problem that was never about the file.
    databaseAnswers('SQLITE_BUSY: database is locked');

    const message = ((await connect()) as Error).message;
    // `/delet/i`, not `/delete/i`. The wording this is here to prevent was
    // "**Deleting** the budget's folder… is the usual fix", and `delete` does
    // not match `Deleting`: the assertion could not see the sentence it was
    // written against. Measured — putting that exact sentence back left the
    // whole file green.
    expect(message).not.toMatch(/delet/i);
    expect(message).toMatch(/close it and try again/i);
  });

  it('ends its sentences', async () => {
    // The quoted line ran straight into the next sentence: "…is locked Please
    // report this at…".
    databaseAnswers('SQLITE_BUSY: database is locked');

    const message = ((await connect()) as Error).message;
    expect(message).not.toMatch(/locked Please/);
    expect(message).toMatch(/locked\. /);
  });

  it('ends the quoted engine line too', async () => {
    // Two places quote a line, and only one of them had the full stop.
    engineLogs('[Exception] Error: budget directory does not exist');

    const message = ((await connect()) as Error).message;
    expect(message).not.toMatch(/exist Please/);
    expect(message).toMatch(/exist\. /);
  });

  it('leaves no timer running once it has connected', async () => {
    // The version check races a five-second timer. Left unclear, it holds the
    // event loop open for its full duration after everything else is done,
    // which `test:connection` pays for on every successful run.
    vi.useFakeTimers();
    try {
      getServerVersion.mockResolvedValue({ version: '26.10.0' });
      downloadBudget.mockImplementation(async () => {});
      getBudgetMonths.mockResolvedValue(['2026-01']);

      const { ensureConnection } = await import('../../connection.js');
      await ensureConnection();

      expect(vi.getTimerCount(), 'a timer outlived the connection').toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['ACTUAL_PASSWORD', 'hunter2-the-real-one'],
    ['ACTUAL_SESSION_TOKEN', 'tok_live_9f3b2a7c4e1d'],
    ['ACTUAL_ENCRYPTION_PASSWORD', 'e2e-key-correct-horse'],
  ])('never quotes %s back', async (name, value) => {
    // The quoted line reaches the model, a log file, and a public issue the
    // message itself asks the person to open. The engine builds its own error
    // strings and has put credentials in them before.
    process.env[name] = value;
    try {
      databaseAnswers(`connection failed for ${value} at the server`);

      const message = ((await connect()) as Error).message;
      expect(message).not.toContain(value);
      expect(message).toContain('***');
      // Still useful: the rest of the line survives.
      expect(message).toMatch(/connection failed for/);
    } finally {
      delete process.env[name];
    }
  });

  it('redacts a secret quoted from the console too', async () => {
    // Not only the read's own error: the line scraped off the engine's log
    // goes to the same three places.
    process.env.ACTUAL_PASSWORD = 'hunter2-the-real-one';
    try {
      engineLogs('Error: auth failed for hunter2-the-real-one');

      const message = ((await connect()) as Error).message;
      expect(message).not.toContain('hunter2-the-real-one');
      expect(message).toContain('***');
    } finally {
      process.env.ACTUAL_PASSWORD = 'not-a-real-password';
    }
  });

  it('leaves a short value alone rather than blanking the sentence', async () => {
    // A two-character secret would match half the words in the line, and a
    // message redacted to nothing hides the thing it was quoted for.
    process.env.ACTUAL_PASSWORD = 'ab';
    try {
      databaseAnswers('database is locked');

      const message = ((await connect()) as Error).message;
      expect(message).toContain('database is locked');
    } finally {
      process.env.ACTUAL_PASSWORD = 'not-a-real-password';
    }
  });

  it('offers one remedy without asking which one fits', async () => {
    engineLogs('Error updating Error: out-of-sync-data');

    const message = ((await connect()) as Error).message;
    expect(message).not.toMatch(/If neither fits/i);
    expect(message).toMatch(/Please report this/);
  });

  it('says so on stderr too, not only in the reply', async () => {
    // The reply reaches the model; stderr is where a person looks, and the
    // report said there was nothing in the logs.
    engineLogs('Error updating Error: out-of-sync-migrations');

    await connect();
    const ours = stderr.filter((line) => line.includes('[actual-budget-mcp]'));
    expect(ours.join('\n')).toMatch(/could not open your budget/);
  });

  it('does not blame the credentials', async () => {
    engineLogs('Error updating Error: out-of-sync-migrations');

    const message = ((await connect()) as Error).message;
    expect(message).toMatch(/Nothing is wrong with your password/);
  });

  it('still reports it when the engine does throw', async () => {
    downloadBudget.mockImplementation(async () => {
      console.error('Error updating Error: out-of-sync-migrations');
      throw new Error('No budget file is open');
    });
    getBudgetMonths.mockImplementation(async () => {
      throw new Error('No budget file is open');
    });

    const message = ((await connect()) as Error).message;
    expect(message).toMatch(/could not open your budget/);
  });

  it('leaves an ordinary failure alone', async () => {
    // The check is on the budget not opening, not on downloading having failed,
    // so an auth problem must still read as an auth problem.
    downloadBudget.mockImplementation(async () => {
      throw new Error('Could not get remote files');
    });
    getBudgetMonths.mockResolvedValue(['2026-01']);

    const message = ((await connect()) as Error).message;
    expect(message).not.toMatch(/could not open your budget/);
  });

  describe('a server older than this library', () => {
    const connectCleanly = async (serverVersion: string | undefined) => {
      getServerVersion.mockResolvedValue(
        serverVersion === undefined ? undefined : { version: serverVersion },
      );
      downloadBudget.mockImplementation(async () => {});
      getBudgetMonths.mockResolvedValue(['2026-01']);
      const { ensureConnection } = await import('../../connection.js');
      await ensureConnection();
      return stderr.filter((line) => line.includes('[actual-budget-mcp]')).join('\n');
    };

    it('warns that opening the budget will migrate it past that server', async () => {
      // Measured: a 26.10 library against a 26.9 server takes the budget from
      // 59 migrations to 60 and uploads it, after which a 26.9 app downloading
      // from scratch fails exactly the way #139 did.
      const said = await connectCleanly('26.9.0');
      expect(said).toMatch(/26\.9\.0/);
      expect(said).toMatch(/migrate/i);
      expect(said).toMatch(/no longer open it/i);
    });

    it('warns before downloading, which is when it still helps', async () => {
      // Downloading is what migrates the budget and the sync uploads it, so a
      // warning after that is a notification of something already done.
      const order: string[] = [];
      getServerVersion.mockImplementation(async () => {
        order.push('version');
        return { version: '26.9.0' };
      });
      downloadBudget.mockImplementation(async () => {
        order.push('download');
      });
      getBudgetMonths.mockResolvedValue(['2026-01']);

      const { ensureConnection } = await import('../../connection.js');
      await ensureConnection();

      expect(order).toEqual(['version', 'download']);
    });

    it('says nothing when the server matches', async () => {
      expect(await connectCleanly('26.10.0')).not.toMatch(/migrate/i);
    });

    it('says nothing when the server is newer', async () => {
      // That direction is the one #139 is about and is reported elsewhere; it
      // is not this warning's business.
      expect(await connectCleanly('26.11.0')).not.toMatch(/migrate/i);
    });

    it('works when the server does not report a version', async () => {
      // Not every server answers, and a missing version is not a reason to
      // refuse to work.
      expect(await connectCleanly(undefined)).not.toMatch(/migrate/i);
    });

    it('gives up on a server that never answers the version', async () => {
      // No timeout inside the SDK for this call, and it runs before the
      // download: a server that accepts and goes quiet would hang startup on a
      // warning nobody asked for.
      getServerVersion.mockImplementation(() => new Promise(() => {}));
      downloadBudget.mockImplementation(async () => {});
      getBudgetMonths.mockResolvedValue(['2026-01']);

      const { ensureConnection } = await import('../../connection.js');
      const started = Date.now();
      await ensureConnection();
      const elapsed = Date.now() - started;

      // Tight enough to fail if the deadline is gone: the call never settles,
      // so without it this waits forever and with it, five seconds.
      expect(elapsed, `took ${elapsed}ms`).toBeLessThan(9_000);
      expect(stderr.join('\n')).not.toMatch(/migrate/i);
    }, 30_000);

    it('works when asking for the version throws', async () => {
      getServerVersion.mockImplementation(async () => {
        throw new Error('not supported');
      });
      downloadBudget.mockImplementation(async () => {});
      getBudgetMonths.mockResolvedValue(['2026-01']);
      const { ensureConnection } = await import('../../connection.js');
      await expect(ensureConnection()).resolves.toBeUndefined();
    });
  });

  it('connects normally when the budget does open', async () => {
    downloadBudget.mockImplementation(async () => {});
    getBudgetMonths.mockResolvedValue(['2026-01']);

    const { ensureConnection } = await import('../../connection.js');
    await expect(ensureConnection()).resolves.toBeUndefined();
  });
});
