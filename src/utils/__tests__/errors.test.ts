import { describe, it, expect } from 'vitest';
import { describeError } from '../errors.js';

describe('describeError (#40 never surface an empty error)', () => {
  it('returns the message of an ordinary error', () => {
    expect(describeError(new Error('Budget not found'))).toBe('Budget not found');
  });

  it('never returns an empty string when the API throws Error("")', () => {
    const described = describeError(new Error(''));

    expect(described).not.toBe('');
    expect(described.length).toBeGreaterThan(0);
  });

  it('points at the server logs when the error carries no message', () => {
    expect(describeError(new Error(''))).toMatch(/log|stderr/i);
  });

  it('explains an out-of-sync failure and how to recover', () => {
    const described = describeError(new Error('SyncError: out-of-sync'));

    expect(described).toMatch(/sync/i);
    expect(described).toMatch(/repair/i);
  });

  it('detects out-of-sync from the reason property of an empty error', () => {
    const error = Object.assign(new Error(''), { reason: 'out-of-sync' });

    expect(describeError(error)).toMatch(/repair/i);
  });

  it('stringifies a non-Error value', () => {
    expect(describeError('plain failure')).toBe('plain failure');
  });

  // What the SDK really throws for a sync failure is `new Error('')` with no
  // `reason`: getSyncError() falls through to an i18next instance that is never
  // initialised, so the message comes out empty. Matching only the literal
  // "out-of-sync" text left the actionable advice unreachable in practice.
  it('offers the repair path for the empty error the SDK actually throws', () => {
    expect(describeError(new Error(''))).toMatch(/repair_sync/);
  });

  it('tells the user to upgrade, not repair, when the budget needs migrations', () => {
    const described = describeError(new Error('out-of-sync-migrations'));

    expect(described).toMatch(/version|upgrade|update/i);
    expect(described).not.toMatch(/repair_sync/);
  });

  it('names the repair tool when out-of-sync is reported explicitly', () => {
    expect(describeError(new Error('SyncError: out-of-sync'))).toMatch(/repair_sync/);
  });

  // String(someObject) is "[object Object]", which hides the failure just as
  // effectively as an empty message. Actual throws plain objects in places.
  it('never returns [object Object] for a thrown plain object', () => {
    const described = describeError({ code: 'EPERM', detail: 'nope' });

    expect(described).not.toContain('[object Object]');
    expect(described).toContain('EPERM');
  });

  it('prefers a message property when the thrown value is not an Error', () => {
    expect(describeError({ message: 'budget is locked' })).toContain('budget is locked');
  });

  it('still detects out-of-sync inside a thrown plain object', () => {
    expect(describeError({ reason: 'out-of-sync' })).toMatch(/repair_sync/);
  });
});
