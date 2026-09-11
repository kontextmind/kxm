/**
 * Safety, security, process integrity, and command seatbelts.
 *
 * Implements deterministic safety invariants:
 * - Literal blocklist intercepting destructive shell mutations (rm -rf, git reset --hard, etc.)
 * - Unbypassable raw byte fidelity brake for verification gates and critic reviews (bypassing lossy compression)
 * - Pinned SSH host key verification policy for headless remote execution
 */

export const DESTRUCTIVE_COMMAND_PATTERNS: readonly RegExp[] = Object.freeze([
  /^\s*rm\s+.*-[a-zA-Z]*r[a-zA-Z]*f/i,
  /^\s*rm\s+.*-[a-zA-Z]*f[a-zA-Z]*r/i,
  /^\s*rm\s+.*(-[a-zA-Z]*r[a-zA-Z]*\s+.*-[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*\s+.*-[a-zA-Z]*r[a-zA-Z]*)/i,
  /^\s*git\s+reset\s+--hard/i,
  /^\s*git\s+clean\s+-[a-zA-Z]*f/i,
  /^\s*git\s+checkout\s+--\s+/i,
  /^\s*git\s+restore\s+(\.|\*|--staged\s+(\.|\*))/i,
]);

/**
 * Literal command seatbelt: blocks destructive mutations from autonomous agents.
 * Throws a descriptive error if command matches any destructive pattern.
 */
export function assertCommandSeatbelt(command: string): void {
  for (const pattern of DESTRUCTIVE_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      throw new Error(
        `Command blocked by KXM safety seatbelt: "${command}". Destructive workspace mutations require explicit operator override.`,
      );
    }
  }
}

export interface RtkBypassContext {
  stepKind?: string | undefined;
  agentRole?: string | undefined;
  preset?: string | undefined;
}

const CRITIC_PRESETS = new Set(["critic-arch", "critic-cli", "auditor"]);
const CRITIC_ROLES = new Set(["critic-arch", "critic-cli", "auditor", "reviewer-arch", "reviewer-cli"]);

/**
 * Gate and Critic RTK Brake:
 * Hardcode an unbypassable check ensuring lossy command output compression (RTK)
 * is strictly prohibited for:
 * 1. Verification gates (stepKind === "gate")
 * 2. Critic and auditor agents (critic-arch, critic-cli, auditor)
 */
export function isRtkBypassRequired(context: RtkBypassContext): boolean {
  if (context.stepKind === "gate") return true;
  if (context.agentRole && CRITIC_ROLES.has(context.agentRole)) return true;
  if (context.preset && CRITIC_PRESETS.has(context.preset)) return true;
  return false;
}

const INSECURE_SSH_HOST_KEY_PATTERNS: readonly RegExp[] = Object.freeze([
  /StrictHostKeyChecking=(accept-new|no|off)/i,
  /UserKnownHostsFile=\/dev\/null/i,
]);

/**
 * Pinned host key verification policy for headless SSH remote execution.
 * Rejects TOFU (accept-new) and disabled host key checking.
 */
export function assertPinnedSshHostKeyPolicy(sshArgs: readonly string[]): void {
  for (const arg of sshArgs) {
    for (const pattern of INSECURE_SSH_HOST_KEY_PATTERNS) {
      if (pattern.test(arg)) {
        throw new Error(
          `Insecure SSH host key policy rejected: "${arg}". KXM headless SSH requires pinned host keys with StrictHostKeyChecking=yes and BatchMode=yes.`,
        );
      }
    }
  }
}
