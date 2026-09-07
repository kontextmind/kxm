/**
 * Type definitions for the trusted roster policy loader
 */

interface RosterRoute {
  id: string;
  harness: 'pi' | 'claude' | 'kimi' | 'codex' | 'gemini' | 'deepseek' | 'grok';
  model: string;
  vendor: string;
  roles: string[];
  permissions: Record<string, unknown>;
  status: 'active' | 'disabled' | 'retired';
}

interface RosterPolicy {
  routes: RosterRoute[];
  lineup?: Record<string, string[]>;
  required_critics?: Record<'review-arch' | 'review-cli' | string, string>;
  model_origins?: Record<string, { vendor: string; evidence: string }>;
}

interface PolicyIdentity {
  source: string; // repo-relative file path
  sha256: string; // SHA256 hash of the content
  commit: string; // Git commit SHA
}

interface LoadedPolicy {
  identity: PolicyIdentity;
  policy: Readonly<RosterPolicy>;
}

/**
 * Load and validate the trusted roster policy from the current repository state
 * @param policyPath Path to the policy file, defaults to '.kxm/roster.json'
 * @returns Promise containing the policy identity and frozen policy data
 * @throws Error if the policy is invalid, untrusted, or doesn't meet requirements
 */
export function loadTrustedRosterPolicy(policyPath?: string): Promise<LoadedPolicy>;

/**
 * Resolve policy from a previously bound commit (not current working files)
 * @param identity The identity of the policy to resolve
 * @returns Promise containing the resolved policy
 * @throws Error if the commit doesn't exist or the content doesn't match
 */
export function resolveBoundPolicy(identity: PolicyIdentity): Promise<LoadedPolicy>;