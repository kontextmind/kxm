import type { JsonObject } from "./restricted-yaml.mjs";

export const POLICY_DRAFT_MODEL_SCHEMA: "kxm.model.v2";
export const POLICY_DRAFT_ROLE_SCHEMA: "kxm.role.v2";
export const POLICY_DRAFT_PURPOSES: readonly [
  "writer",
  "planner",
  "reviewer-arch",
  "reviewer-cli",
  "experiment",
];
export const POLICY_DRAFT_PERMISSIONS: readonly ["edit", "read-only"];
export const POLICY_DRAFT_STATUSES: readonly ["admitted", "candidate", "retired"];

export interface PolicyDraftIssue {
  phase: "parse" | "schema" | "reference" | "semantic";
  code: string;
  file: string;
  message: string;
}

export interface PolicyDraftCeiling {
  readonly provider: string;
  readonly roles?: readonly string[];
  readonly permissions: readonly string[];
  readonly models?: readonly string[];
  readonly efforts?: readonly string[];
}

export interface PolicyDraftOptions {
  readonly ceilings: Readonly<Record<string, PolicyDraftCeiling>>;
  readonly nativePiBrakeProviders: readonly string[];
  readonly piAllowedProviders: readonly string[];
  readonly piNativeVendorProviders?: Readonly<Record<string, string>>;
  readonly vendorAliases?: Readonly<Record<string, string>>;
}

export type PolicyDraftDocument = JsonObject | string | Uint8Array;

export interface PolicyDraftInput {
  readonly models?: Readonly<Record<string, PolicyDraftDocument>> | readonly PolicyDraftDocument[];
  readonly roles?: Readonly<Record<string, PolicyDraftDocument>> | readonly PolicyDraftDocument[];
  readonly evidence?: Readonly<Record<string, string | Uint8Array>>;
}

export interface PolicyDraftData {
  readonly models: Readonly<Record<string, JsonObject>>;
  readonly roles: Readonly<Record<string, JsonObject>>;
}

export type PolicyDraftResult =
  | { readonly ok: true; readonly data: PolicyDraftData }
  | { readonly ok: false; readonly issues: readonly PolicyDraftIssue[] };

/** Pure draft validation. Not admission, not a trusted loader, and not file I/O. */
export function validatePolicyDraft(input: PolicyDraftInput, options: PolicyDraftOptions): PolicyDraftResult;
