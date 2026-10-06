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
