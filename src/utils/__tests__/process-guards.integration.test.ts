import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';

const run = promisify(execFile);

// The child imports the compiled guard, so this needs a build first.
const BUILT = existsSync('dist/utils/process-guards.js');

/**
 * The unit tests exercise an injected fake `process`, which proves the handler
 * is wired but not the claim that actually matters for #39: that a stray
 * rejection no longer terminates the process. Only a real child process can
 * show that, since Node's default mode is what kills it.
 */
describe('installProcessGuards in a real process (#39)', () => {
  const rejectAndKeepGoing = `
    import { installProcessGuards } from './dist/utils/process-guards.js';
    installProcessGuards();
    Promise.reject(new Error('stray rejection'));
    setTimeout(() => { console.log('SURVIVED'); process.exit(0); }, 50);
  `;

  it('a process WITHOUT the guard dies on an unhandled rejection', async () => {
    const withoutGuard = `
      Promise.reject(new Error('stray rejection'));
      setTimeout(() => { console.log('SURVIVED'); process.exit(0); }, 50);
    `;

    await expect(
      run(process.execPath, ['--input-type=module', '-e', withoutGuard]),
    ).rejects.toMatchObject({ code: 1 });
  }, 20000);

  it.skipIf(!BUILT)('a process WITH the guard survives and keeps running', async () => {
    const { stdout } = await run(process.execPath, [
      '--input-type=module',
      '-e',
      rejectAndKeepGoing,
    ]);

    expect(stdout).toContain('SURVIVED');
  }, 20000);
});
