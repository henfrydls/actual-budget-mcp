import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimDataDir, forgetActiveDataDir, LOCK_FILE } from '../data-dir-lock.js';
import { contentionNote } from '../errors.js';

/**
 * #71 made the server step aside from a contended directory. The first attempt
 * at naming contention then read the directory in use — which this process
 * holds, so the note fell silent exactly when another server was running.
 * Saying nothing is a worse diagnosis than saying it imprecisely.
 */
let root: string | null = null;

afterEach(() => {
  forgetActiveDataDir();
  delete process.env.ACTUAL_DATA_DIR;
  vi.restoreAllMocks();
  if (root) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    root = null;
  }
});

describe('naming the other server after stepping aside', () => {
  it('still names it, and says the two do not share a cache', () => {
    root = mkdtempSync(join(tmpdir(), 'contend-msg-'));
    const configured = join(root, 'cache');
    mkdirSync(configured, { recursive: true });
    const incumbent = process.pid;
    writeFileSync(
      join(configured, LOCK_FILE),
      JSON.stringify({ pid: incumbent, startedAt: '2026-09-24T00:00:00.000Z', version: '0.9.2' }),
    );
    process.env.ACTUAL_DATA_DIR = configured;

    vi.spyOn(process, 'pid', 'get').mockReturnValue(999_100);
    const claim = claimDataDir('0.9.2');
    const note = contentionNote();

    expect(claim.dataDir).not.toBe(configured);
    expect(note).toMatch(new RegExp(String(incumbent)));
    expect(note).toMatch(/same budget/i);
    expect(note).toMatch(/stepped aside/i);
  });

  it('uses the sharing wording when the cache really is shared', () => {
    root = mkdtempSync(join(tmpdir(), 'contend-shared-'));
    const configured = join(root, 'cache');
    mkdirSync(configured, { recursive: true });
    process.env.ACTUAL_DATA_DIR = configured;

    // This process claims it, then another asks: it sees a live holder on the
    // directory it is itself using.
    claimDataDir('0.9.2');
    vi.spyOn(process, 'pid', 'get').mockReturnValue(999_101);

    expect(contentionNote()).toMatch(/same ACTUAL_DATA_DIR/i);
  });

  it('says nothing when this server is alone', () => {
    root = mkdtempSync(join(tmpdir(), 'contend-alone-'));
    process.env.ACTUAL_DATA_DIR = join(root, 'cache');

    claimDataDir('0.9.2');

    expect(contentionNote()).toBe('');
  });
});
