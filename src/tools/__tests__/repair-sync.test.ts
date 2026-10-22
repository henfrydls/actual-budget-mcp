import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actual-app/api', () => ({
  default: {},
  sync: vi.fn().mockResolvedValue(undefined),
  utils: {
    amountToInteger: (amount: number) => Math.round(amount * 100),
    integerToAmount: (cents: number) => cents / 100,
  },
}));

const send = vi.fn();
const answering = vi.hoisted(() => vi.fn());

vi.mock('../../connection.js', () => ({
  ensureConnection: vi.fn().mockResolvedValue(undefined),
  getInternal: () => ({ send }),
  // Without this the mock had no `getConfig`, so the probe added in #89 threw
  // on its way in and was skipped by the catch around it. Every test here
  // passed without the probe ever running.
  getConfig: () => ({ serverURL: 'http://localhost:5007' }),
  // `syncNow` signs in again on `token-expired`, and the test below sends
  // exactly that code through it.
  reauthenticate: vi.fn().mockResolvedValue({ outcome: 'no-password' }),
}));

vi.mock('../../utils/server-probe.js', () => ({ probeServer: answering }));

import * as api from '@actual-app/api';
import { ensureConnection } from '../../connection.js';
import { repairSyncState } from '../write/repair-sync.js';

describe('repairSyncState (#41 recover from an out-of-sync budget)', () => {
  beforeEach(() => {
    answering.mockReset().mockResolvedValue('answering');
    send.mockReset().mockResolvedValue(undefined);
    vi.mocked(api.sync).mockReset().mockResolvedValue(undefined);
    vi.mocked(ensureConnection).mockReset().mockResolvedValue(undefined);
  });

  it('still repairs when the connection failed because the budget is out of sync', async () => {
    // ensureConnection() runs downloadBudget(), which is exactly what throws on
    // an out-of-sync budget. Bailing out there would make this tool useless in
    // the only situation it exists for: the budget is already loaded by then,
    // so the repair must go ahead.
    vi.mocked(ensureConnection).mockRejectedValue(new Error(''));

    await repairSyncState();

    expect(send).toHaveBeenCalledWith('sync-repair');
  });

  it("runs Actual's sync-repair handler", async () => {
    await repairSyncState();

    expect(send).toHaveBeenCalledWith('sync-repair');
  });

  it('syncs afterwards so the repaired state reaches the server', async () => {
    await repairSyncState();

    expect(api.sync).toHaveBeenCalled();
  });

  /** The tool as the server registers it, so the reply is the real one. */
  const callTheTool = async () => {
    const { registerRepairSync } = await import('../write/repair-sync.js');
    let handler:
      | (() => Promise<{ content: Array<{ text: string }>; isError?: boolean }>)
      | undefined;
    registerRepairSync({
      tool: (...args: unknown[]) => {
        handler = args[args.length - 1] as never;
      },
    } as never);
    return handler!();
  };

  it('does not describe its own explanation a second time', async () => {
    // Measured live, with an expired session: the message carries Actual's
    // own "unknown problem opening", the reply described the whole thing
    // again, and so opened by telling the reader to check that a server
    // which had just answered was running. The write caution came out twice
    // underneath, about a tool that writes no budget data at all.
    vi.mocked(api.sync).mockRejectedValue(
      Object.assign(new Error('We had an unknown problem opening "b"'), {
        code: 'token-expired',
      }),
    );
    const reply = await callTheTool();
    const text = reply.content[0].text;

    expect(reply.isError).toBe(true);
    expect(text).toContain('repair is not finished');
    expect(text).toContain('session with the Actual server expired');
    expect(text, 'the server answered; it refused the session').not.toContain(
      'running and reachable',
    );
    expect(text.match(/check the budget before retrying/g) ?? []).toHaveLength(0);
  });

  it('describes a repair that failed outright once, not twice', async () => {
    // The same hazard on the other throw in this tool: its message carries a
    // description, and whatever catches it describes what it caught.
    send.mockRejectedValue(
      Object.assign(new Error('We had an unknown problem opening "b"'), {
        code: 'opening-budget',
      }),
    );

    const text = (await callTheTool()).content[0].text;

    expect(text).toContain('Sync repair failed');
    expect(text).toContain('could not open the local copy');
    expect(text.match(/Actual reported:/g) ?? [], 'described once').toHaveLength(1);
    expect(text.match(/check the budget before retrying/g) ?? []).toHaveLength(1);
  });

  it('does not send the reader back to itself when the app could be closed', async () => {
    // The server is the desktop app's address, which is where the clause
    // from #240 lives: "the app is probably closed, and repair_sync saying
    // nothing is listening is how you tell". This tool has already probed
    // the server and had an answer, and it is the thing being quoted, so
    // inside its own failure the sentence is both contradicted and circular.
    const original = process.env.ACTUAL_SERVER_URL;
    process.env.ACTUAL_SERVER_URL = 'http://localhost:5007';
    send.mockRejectedValue(new Error('We had an unknown problem opening "b"'));
    try {
      const text = (await callTheTool()).content[0].text;

      expect(text).toContain('Sync repair failed');
      expect(text).not.toContain('desktop app');
    } finally {
      if (original === undefined) delete process.env.ACTUAL_SERVER_URL;
      else process.env.ACTUAL_SERVER_URL = original;
    }
  });

  it('says the repair did not finish when the sync that checks it fails', async () => {
    // This sync is not the push after a write that #162 turned into a notice
    // on an otherwise successful reply. It is the verification, and the whole
    // point of the repair: answering "completed... synced with the server"
    // with a caveat underneath would be false twice over, since the advice
    // that comes with the notice is not to repeat the call, and repairing
    // twice writes nothing twice.
    vi.mocked(api.sync).mockRejectedValue(new Error('connect ECONNREFUSED'));

    const message = await repairSyncState().then(
      () => '',
      (error: Error) => error.message,
    );

    expect(message).toContain('repair is not finished');
    expect(message).toContain('rebuilt');
    expect(message).toContain('ECONNREFUSED');
  });

  it('reports success in the returned lines', async () => {
    const lines = await repairSyncState();

    expect(lines.join('\n')).toMatch(/repair/i);
  });

  it('surfaces a clear error when the repair itself fails', async () => {
    send.mockRejectedValue(new Error('boom'));

    await expect(repairSyncState()).rejects.toThrow(/repair/i);
  });
});

describe('repair_sync when the problem is that the server is not there (#89)', () => {
  beforeEach(() => {
    answering.mockReset();
    send.mockReset().mockResolvedValue(undefined);
    vi.mocked(api.sync).mockReset().mockResolvedValue(undefined);
    vi.mocked(ensureConnection).mockReset().mockResolvedValue(undefined);
  });

  it('repairs nothing when nothing is listening', async () => {
    // The assertion that matters is not the wording, it is that the
    // state-changing call never happened.
    answering.mockResolvedValue('not-answering');

    await expect(repairSyncState()).rejects.toThrow('was not touched');

    expect(send).not.toHaveBeenCalled();
    expect(api.sync).not.toHaveBeenCalled();
  });

  it('names both causes and which one this is', async () => {
    answering.mockResolvedValue('not-answering');

    const message = await repairSyncState().then(
      () => '',
      (error: Error) => error.message,
    );

    expect(message).toContain('http://localhost:5007');
    expect(message).toContain('port 5007');
    expect(message).toContain('only while the app is open');
    expect(message).toContain('the sync state is broken');
  });

  it('still repairs when the server answers and the sync state is the problem', async () => {
    // The case the tool exists for (#41). A probe that treated any failure as
    // unreachable would make it useless here, and the suite would stay green
    // without this.
    answering.mockResolvedValue('answering');
    vi.mocked(ensureConnection).mockRejectedValue(new Error('out-of-sync-data'));

    const lines = await repairSyncState();

    expect(send).toHaveBeenCalledWith('sync-repair');
    expect(lines[0]).toContain('Sync repair completed');
  });

  it('repairs nothing when the configured URL is not an address', async () => {
    // A different problem and a different sentence: telling someone to open
    // the desktop app when their URL has a mistyped port sends them somewhere
    // with nothing to find. What both cases share is that nothing is repaired.
    answering.mockResolvedValue('unusable-url');

    const message = await repairSyncState().then(
      () => '',
      (error: Error) => error.message,
    );

    expect(send).not.toHaveBeenCalled();
    expect(message).toContain('not an address this can reach');
    expect(message).toContain('Nothing was repaired');
    expect(message).not.toContain('only while the app is open');
  });

  it('does not probe its way out of repairing when there is no server configured', async () => {
    // `getConfig` throwing means the configuration is missing, which
    // `ensureConnection` has already failed on. Calling that "unreachable"
    // would name the wrong problem.
    answering.mockResolvedValue('not-answering');
    const connection = await import('../../connection.js');
    const original = connection.getConfig;
    (connection as { getConfig: unknown }).getConfig = () => {
      throw new Error('Missing required environment variables: ACTUAL_SERVER_URL');
    };
    try {
      await repairSyncState();
      expect(send).toHaveBeenCalledWith('sync-repair');
    } finally {
      (connection as { getConfig: unknown }).getConfig = original;
    }
  });
});
