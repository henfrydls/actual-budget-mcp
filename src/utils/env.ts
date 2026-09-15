/**
 * Read a configuration value, treating "the host never filled this in" as unset.
 *
 * MCP clients substitute user configuration into the environment, and a client
 * that leaves an optional field empty does not necessarily unset the variable:
 * Claude Desktop passes the literal `${user_config.session_token}` through.
 * That string is truthy, so `value || undefined` lets it past, and the server
 * then sends a placeholder to Actual as if it were a credential.
 *
 * Reproduced against a real server: with the literal set, the session token
 * beat a perfectly good password and the connection failed claiming the token
 * had expired. The MCPB specification says nothing about what a host should do
 * with an unfilled optional, so the defence belongs here rather than in a bug
 * report against one client.
 */
const UNSUBSTITUTED = /^\$\{[\w.-]+\}$/;

export function readEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  // Only a fully blank value counts as unset: a password may legitimately end
  // in a space, so the trim decides, and the original is what gets returned.
  if (raw.trim() === '') return undefined;
  if (UNSUBSTITUTED.test(raw.trim())) return undefined;
  return raw;
}
