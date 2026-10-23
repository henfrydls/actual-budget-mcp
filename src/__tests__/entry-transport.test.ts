import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Which transport the entry point starts, and what it watches for the end
 * (#228).
 *
 * The first version of this read the source and looked for the lines, which
 * a mutation walks straight past: `if (false) process.exit(1)` leaves every
 * line in place. So the entry point is imported here, with everything it
 * reaches mocked, and what it did is what is checked.
 */

const startHttpServer = vi.fn().mockResolvedValue({ address: () => ({ port: 3000 }) });
const connect = vi.fn().mockResolvedValue(undefined);
const StdioServerTransport = vi.fn();
const installExitPaths = vi.fn();
const ensureConnection = vi.fn().mockResolvedValue(undefined);

vi.mock('dotenv/config', () => ({}));
vi.mock('../utils/http-timeout.js', () => ({}));
vi.mock('@actual-app/api', () => ({ default: {}, getAccounts: vi.fn(), getCategoryGroups: vi.fn() }));
vi.mock('../http.js', () => ({ startHttpServer: (...a: unknown[]) => startHttpServer(...a) }));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {
    constructor() {
      StdioServerTransport();
    }
  },
}));
vi.mock('../mcp-server.js', () => ({
  createMcpServer: () => ({ connect: (...a: unknown[]) => connect(...a) }),
}));
vi.mock('../utils/orderly-exit.js', () => ({
  installExitPaths: (...a: unknown[]) => installExitPaths(...a),
  EXIT_GRACE_MS: 1,
  EXIT_IN_FLIGHT_MS: 1,
}));
vi.mock('../connection.js', () => ({
  ensureConnection: (...a: unknown[]) => ensureConnection(...a),
  connectionSettled: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getInternal: vi.fn(),
}));
vi.mock('../utils/native-binding.js', () => ({
  ensureNativeBinding: () => ({ status: 'mocked', detail: '' }),
}));
vi.mock('../utils/runtime-check.js', () => ({ assertSupportedRuntime: () => undefined }));

const VARS = [
  'ACTUAL_HTTP_PORT',
  'ACTUAL_HTTP_TOKEN',
  'ACTUAL_HTTP_WRITE_TOKEN',
  'ACTUAL_HTTP_HOST',
  'ACTUAL_HTTP_ALLOW_REMOTE',
  'ACTUAL_HTTP_ALLOWED_HOSTS',
  'ACTUAL_READ_ONLY',
];

const TOKEN = '9f2c41ab7d0e38516c4af0b29d7e13a5';

/** Stops the module the way `process.exit` stops a process. */
class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

async function runEntry(): Promise<{ exit?: number }> {
  vi.resetModules();
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Exited(code ?? 0);
  }) as never);
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    await import('../index.js');
    return {};
  } catch (error) {
    if (error instanceof Exited) return { exit: error.code };
    throw error;
  } finally {
    exit.mockRestore();
    quiet.mockRestore();
  }
}

describe('the transport the entry point starts', () => {
  beforeEach(() => {
    for (const name of VARS) delete process.env[name];
    startHttpServer.mockClear();
    connect.mockClear();
    StdioServerTransport.mockClear();
    installExitPaths.mockClear();
  });

  afterEach(() => {
    for (const name of VARS) delete process.env[name];
  });

  it('speaks stdio when no port was asked for, and watches stdin for the end', async () => {
    const { exit } = await runEntry();

    expect(exit).toBeUndefined();
    expect(StdioServerTransport).toHaveBeenCalled();
    expect(startHttpServer).not.toHaveBeenCalled();
    // End-of-file is how a stdio client leaves, and a server that stopped
    // watching for it is #219: the process stayed, holding its data
    // directory and its session.
    expect(installExitPaths.mock.calls[0][0]).toMatchObject({ stdin: process.stdin });
  });

  it('listens when a port was asked for, and does not watch stdin', async () => {
    process.env.ACTUAL_HTTP_PORT = '3456';
    process.env.ACTUAL_HTTP_TOKEN = TOKEN;

    const { exit } = await runEntry();

    expect(exit).toBeUndefined();
    expect(startHttpServer).toHaveBeenCalledWith(
      expect.objectContaining({ port: 3456, host: '127.0.0.1', readToken: TOKEN }),
    );
    expect(StdioServerTransport).not.toHaveBeenCalled();
    // A container started detached has no stdin, and watching for its end
    // would shut the server down a moment after it came up.
    expect(installExitPaths.mock.calls[0][0].stdin).toBeUndefined();
  });

  it('refuses to start on a configuration it cannot serve', async () => {
    process.env.ACTUAL_HTTP_PORT = '3456';

    const { exit } = await runEntry();

    expect(exit).toBe(1);
    expect(startHttpServer).not.toHaveBeenCalled();
    expect(StdioServerTransport).not.toHaveBeenCalled();
  });

  it('refuses to fall back to stdio when only the port is missing', async () => {
    process.env.ACTUAL_HTTP_TOKEN = TOKEN;
    process.env.ACTUAL_HTTP_HOST = '127.0.0.1';

    const { exit } = await runEntry();

    expect(exit).toBe(1);
    expect(StdioServerTransport).not.toHaveBeenCalled();
  });
});
