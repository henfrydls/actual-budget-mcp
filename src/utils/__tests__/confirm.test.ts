import { describe, it, expect } from 'vitest';
import { requireConfirmation } from '../confirm.js';

describe('requireConfirmation', () => {
  const base = {
    subject: 'Category "Groceries"',
    losses: ['  Transactions: 12'],
    input: {},
  };

  it('previews instead of confirming on the first call', () => {
    const out = requireConfirmation(base);

    expect(out.confirmed).toBe(false);
    expect(out.lines.join('\n')).toContain('Nothing was deleted');
    expect(out.lines.join('\n')).toContain('Transactions: 12');
  });

  it('confirms when confirm is true and no name echo is required', () => {
    const out = requireConfirmation({ ...base, input: { confirm: true } });

    expect(out.confirmed).toBe(true);
    expect(out.lines).toEqual([]);
  });

  it('still previews when a name echo is required but missing', () => {
    const out = requireConfirmation({
      ...base,
      confirmName: 'Groceries',
      input: { confirm: true },
    });

    expect(out.confirmed).toBe(false);
    expect(out.lines.join('\n')).toContain('confirm_name: "Groceries"');
  });

  it('confirms when the echoed name matches', () => {
    const out = requireConfirmation({
      ...base,
      confirmName: 'Groceries',
      input: { confirm: true, confirm_name: 'Groceries' },
    });

    expect(out.confirmed).toBe(true);
  });

  it('throws when the echoed name does not match, deleting nothing', () => {
    expect(() =>
      requireConfirmation({
        ...base,
        confirmName: 'Groceries',
        input: { confirm: true, confirm_name: 'Grocerys' },
      }),
    ).toThrow(/does not match/i);
  });

  it('offers the non-destructive alternative when one is given', () => {
    const out = requireConfirmation({ ...base, alternative: 'Use transfer_to instead.' });

    expect(out.lines.join('\n')).toContain('Use transfer_to instead.');
  });
});
