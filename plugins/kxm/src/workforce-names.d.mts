export const ROLE_IDS: readonly string[];
export const ROUTE_RENAMES: readonly (readonly [string, string])[];
export const AGENT_RENAMES: readonly (readonly [string, string])[];
export const WORKFLOW_RENAMES: readonly (readonly [string, string])[];
export const STEP_RENAMES: readonly (readonly [string, string])[];

export function noteDeprecatedId(kind: string, from: string, to: string): void;
export function resetDeprecatedIdWarnings(): void;
export function resolveRenamedId(
  requested: string,
  knownIds: ReadonlySet<string>,
  pairs: readonly (readonly [string, string])[],
): string;
export function canonicalRouteId(harness: string, model: string): string | undefined;

export function lookupById<T extends { id?: string | undefined; aliases?: readonly string[] | undefined }>(
  records: Iterable<T>,
  requested: string,
  kind: "route" | "agent" | "workflow" | "step",
): { record: T; viaAlias: boolean } | undefined;

export function findYamlBasename(
  directory: string,
  requested: string,
  kind: "route" | "agent" | "workflow" | "step",
): string | undefined;

export interface WorkforceLintIssue {
  severity: "error" | "warning";
  code: string;
  file: string;
  message: string;
}

export function lintWorkforce(root: string): {
  errors: WorkforceLintIssue[];
  warnings: WorkforceLintIssue[];
};
