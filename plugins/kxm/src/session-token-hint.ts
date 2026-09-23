/** User-directed fix for a `session_token_invalid` tool-policy denial.
 *
 * `enforceToolPolicy` (commands.ts) returns that error from three places: an
 * invalid `KXM_SESSION_TOKEN` in the environment (detail starts with
 * `KXM_SESSION_TOKEN`), and an unreadable or malformed/expired session token
 * file on disk. The Claude SessionStart hook and the MCP server both use this
 * text, so a session sees one explanation. Neither text prints or reissues a
 * token: `kxm session token --issue` and bare `kxm session token` print one. */

const ENV_TEXT = "KXM_SESSION_TOKEN in the environment Claude Code was launched from is malformed or expired, so every kxm_* tool fails with tool_policy_denied. Ask the user to unset or replace KXM_SESSION_TOKEN in the environment Claude Code was launched from, then restart Claude Code.";

const DISK_TEXT = "The KXM session token file on this machine is expired, malformed or unreadable, so every kxm_* tool fails with tool_policy_denied. Ask the user to run `kxm session token --clear` in their own terminal. `kxm session token --status` reports No active session token found for an expired file even though the file still blocks tools. The kxm plugin no longer refreshes that 24-hour token.";

export function sessionTokenFixHint(policy: { error?: string | undefined; detail?: string | undefined }): string | undefined {
  if (policy.error !== "session_token_invalid") return undefined;
  return policy.detail?.startsWith("KXM_SESSION_TOKEN") ? ENV_TEXT : DISK_TEXT;
}
