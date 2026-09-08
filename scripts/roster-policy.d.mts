export interface RosterRoute {
  readonly harness: 'grok' | 'claude' | 'codex' | 'pi';
  readonly model: string;
  readonly vendor: string;
  readonly roles: readonly string[];
  readonly permissions: readonly ('read-only' | 'edit')[];
  readonly status: 'admitted' | 'retired';
}
export interface RosterPolicy {
  readonly schema: 'kxm.developer-roster.v1';
  readonly routes: Readonly<Record<string, RosterRoute>>;
  readonly lineup: Readonly<Record<string, readonly string[]>>;
  readonly required_critics: Readonly<Record<'review-arch' | 'review-cli', string>>;
  readonly model_origins: Readonly<Record<string, { readonly vendor: string; readonly evidence: { readonly source: string; readonly sha256: string } }>>;
}
export interface PolicyIdentity { readonly commit: string; readonly blob: string; readonly sha256: string }
export interface LoadedPolicy { readonly identity: PolicyIdentity; readonly policy: RosterPolicy }
export function loadTrustedRosterPolicy(): LoadedPolicy;
export function resolveBoundPolicy(identity: PolicyIdentity): LoadedPolicy;
export function canonicalVendor(value: string): string;
