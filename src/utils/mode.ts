/**
 * Whether the server runs read-only, hiding every write tool from discovery.
 *
 * Hiding rather than refusing is deliberate: an agent cannot be talked into
 * calling a tool it never sees, which is the mitigation the MCP specification
 * names against prompt injection. A tool that exists and says no still burns
 * context and invites retries.
 *
 * Off unless explicitly set — the default stays exactly as it has always been,
 * because writing is what most callers install this server for.
 */
export function isReadOnly(): boolean {
  const raw = process.env.ACTUAL_READ_ONLY;
  if (!raw) return false;
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}
