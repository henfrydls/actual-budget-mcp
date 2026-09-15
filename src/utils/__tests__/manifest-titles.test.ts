import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../manifest.json', import.meta.url)), 'utf8'),
) as { user_config: Record<string, { title: string; type: string }> };

/**
 * The titles a user has already answered, frozen on purpose.
 *
 * Upgrading from the first bundle to 0.9.1 cleared the saved server password
 * and nothing else. The password was the only filled-in field whose title had
 * changed; server_url and sync_id kept their titles and kept their values, and
 * the other two retitled fields were empty, so nobody noticed. One observation
 * is not proof that the client keys stored values by title, but it is the only
 * explanation consistent with what happened, and the cost of being wrong in the
 * other direction is a user whose extension silently stops authenticating after
 * an update and who has no reason to suspect the update.
 *
 * So titles are treated as identifiers, not copy. Rewording one has to be a
 * deliberate act: change it here too, and accept that existing users will
 * re-enter that value. Descriptions carry the explaining and are free to change.
 */
const FROZEN_TITLES: Record<string, string> = {
  server_url: 'Actual server URL',
  sync_id: 'Budget Sync ID',
  password: 'Server password (or a session token below)',
  session_token: 'Session token (optional, OIDC servers only)',
  encryption_password: 'Encryption password (optional)',
  read_only: 'Read-only mode',
};

describe('the configuration titles a user has already answered', () => {
  it('still say exactly what they said when the value was saved', () => {
    const actual = Object.fromEntries(
      Object.entries(manifest.user_config).map(([key, field]) => [key, field.title]),
    );

    expect(actual).toEqual(FROZEN_TITLES);
  });

  it('covers every field, so a new one cannot be added without a decision', () => {
    expect(Object.keys(manifest.user_config).sort()).toEqual(Object.keys(FROZEN_TITLES).sort());
  });
});
