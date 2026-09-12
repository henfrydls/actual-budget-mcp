import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';

const setPlatform = (p: string) =>
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
const realPlatform = process.platform;

describe('defaultDataDir', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.ACTUAL_DATA_DIR;
    delete process.env.XDG_DATA_HOME;
    delete process.env.APPDATA;
  });

  afterEach(() => setPlatform(realPlatform));

  it('uses the XDG data dir on Linux, not /tmp', async () => {
    setPlatform('linux');
    process.env.XDG_DATA_HOME = '/home/someone/.local/share';
    const { effectiveDataDir } = await import('../data-dir-lock.js');

    expect(effectiveDataDir()).toBe('/home/someone/.local/share/actual-budget-mcp');
  });

  it('falls back to ~/.local/share when XDG_DATA_HOME is unset', async () => {
    setPlatform('linux');
    const { effectiveDataDir } = await import('../data-dir-lock.js');

    expect(effectiveDataDir()).toBe(join(homedir(), '.local', 'share', 'actual-budget-mcp'));
  });

  it('uses Application Support on macOS', async () => {
    setPlatform('darwin');
    const { effectiveDataDir } = await import('../data-dir-lock.js');

    expect(effectiveDataDir()).toBe(
      join(homedir(), 'Library', 'Application Support', 'actual-budget-mcp'),
    );
  });

  it('uses APPDATA on Windows, where /tmp is not a path at all', async () => {
    setPlatform('win32');
    process.env.APPDATA = 'C:\\Users\\someone\\AppData\\Roaming';
    const { effectiveDataDir } = await import('../data-dir-lock.js');

    expect(effectiveDataDir()).toBe(join('C:\\Users\\someone\\AppData\\Roaming', 'actual-budget-mcp'));
  });

  it('never returns a path under /tmp on any platform', async () => {
    for (const p of ['linux', 'darwin', 'win32']) {
      vi.resetModules();
      setPlatform(p);
      const { effectiveDataDir } = await import('../data-dir-lock.js');
      expect(effectiveDataDir().startsWith('/tmp')).toBe(false);
    }
  });

  it('still honours an explicit ACTUAL_DATA_DIR', async () => {
    process.env.ACTUAL_DATA_DIR = '/custom/place';
    const { effectiveDataDir } = await import('../data-dir-lock.js');

    expect(effectiveDataDir()).toBe('/custom/place');
  });
});
