import { describe, it, expect } from 'vitest';
import { checkVersions, versionNote, versionSentence } from '../server-version.js';

/**
 * The two versions, compared and said (#229).
 *
 * The rule is: say it, in both directions, and open anyway. Actual's minor
 * is the month, so a server that updates itself is a minor ahead of this
 * library from the day Actual releases until the day this server follows;
 * refusing on that would leave every deployment without a budget for those
 * days, every month, by default.
 */
describe('the Actual server version against this library', () => {
  it('is a match when major and minor agree, whatever the patch', () => {
    expect(checkVersions('26.11.0', '26.11.0').kind).toBe('match');
    expect(checkVersions('26.11.7', '26.11.0').kind).toBe('match');
    expect(checkVersions('26.11.0', '26.11.9').kind).toBe('match');
  });

  it('tells the two directions apart', () => {
    expect(checkVersions('26.10.0', '26.11.0')).toMatchObject({
      kind: 'mismatch',
      serverIs: 'behind',
    });
    expect(checkVersions('26.12.0', '26.11.0')).toMatchObject({
      kind: 'mismatch',
      serverIs: 'ahead',
    });
    expect(checkVersions('25.12.0', '26.1.0')).toMatchObject({
      kind: 'mismatch',
      serverIs: 'behind',
    });
    expect(checkVersions('27.1.0', '26.12.0')).toMatchObject({
      kind: 'mismatch',
      serverIs: 'ahead',
    });
  });

  it('treats a version it cannot read or parse as nothing learned', () => {
    // A server that is down, one behind a proxy that hides /info, and one
    // old enough to have no /info all answer the same way.
    expect(checkVersions(undefined, '26.11.0').kind).toBe('unreadable');
    expect(checkVersions('', '26.11.0').kind).toBe('unreadable');
    expect(checkVersions('not-a-version', '26.11.0').kind).toBe('unreadable');
    expect(checkVersions('26', '26.11.0').kind).toBe('unreadable');
  });

  it('says both versions, and what opening a budget would do, in each direction', () => {
    const behind = versionSentence(checkVersions('26.10.0', '26.11.0')) ?? '';
    expect(behind).toContain('26.10.0');
    expect(behind).toContain('26.11.0');
    expect(behind).toMatch(/migrate/i);
    expect(behind).toMatch(/no longer open it/i);

    const ahead = versionSentence(checkVersions('26.12.0', '26.11.0')) ?? '';
    expect(ahead).toContain('26.12.0');
    expect(ahead).toContain('26.11.0');
    expect(ahead).toMatch(/ahead/i);

    // Neither of them tells anyone to stop using their budget.
    for (const said of [behind, ahead]) {
      expect(said).not.toMatch(/refus|cannot open|will not open|nothing was opened/i);
    }
  });

  it('says nothing at all when the versions match', () => {
    expect(versionSentence(checkVersions('26.11.0', '26.11.0'))).toBeUndefined();
    expect(versionNote(checkVersions('26.11.0', '26.11.0'))).toBeUndefined();
  });

  it('says on stderr, and not in a reply, that the check did not happen', () => {
    const check = checkVersions(undefined, '26.11.0');
    expect(versionSentence(check)).toMatch(/did not report a version/i);
    // A reply is not a log: a non-finding in front of somebody who asked
    // which budgets there are is noise.
    expect(versionNote(check)).toBeUndefined();
  });

  it('fits a mismatch in one line for a reply, in both directions', () => {
    for (const server of ['26.10.0', '26.12.0']) {
      const note = versionNote(checkVersions(server, '26.11.0')) ?? '';
      expect(note).toContain(server);
      expect(note).toContain('26.11.0');
      expect(note.split('\n')).toHaveLength(1);
    }
  });
});
