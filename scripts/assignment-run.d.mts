export const ASSIGNMENT_SCHEMA: "kxm.assignment.v1";
export const PLAN_POINTER_SCHEMA: "kxm.plan-pointer.v1";
export const PLAN_POINTER_FILENAME: "plan-current.json";
export const COMPLETION_SCHEMA: "kxm.assignment-completion.v1";
export const VERIFY_WITNESS_ID: "verify";
export const WITNESS_IDS: readonly string[];
export const ASSIGNMENT_KINDS: readonly string[];
export const KIND_ROLES: Readonly<Record<string, string>>;
export const REVIEW_KINDS: readonly string[];
export const WRITER_KINDS: readonly string[];
export const CLEAN_BASE_KINDS: readonly string[];

export interface ValidatedAssignmentGit {
  readonly head: string;
  readonly index_tree: string;
  readonly clean: boolean;
}

export interface ValidatedAssignment {
  readonly schema: "kxm.assignment.v1";
  readonly task_id: string;
  readonly assignment_id: string;
  readonly rework_of?: string;
  readonly kind: string;
  readonly role: string;
  readonly harness: string;
  readonly model: string;
  readonly effort: string;
  readonly permission: string;
  readonly cwd: string;
  readonly task_dir: string;
  readonly base: Readonly<{ kind: "clean"; commit: string } | { kind: "staged"; commit: string; index_tree: string }>;
  readonly plan_ref: Readonly<
    | { kind: "current"; path: string; sha256: string; pointer_path: string; generation: number }
    | { kind: "bootstrap"; reason: string }
  >;
  readonly inputs: readonly Readonly<{ path: string; sha256: string }>[];
  readonly contract: Readonly<{
    boundary: string;
    deliverables: readonly string[];
    witness: Readonly<{ id: string }>;
    deferred: readonly string[];
  }>;
  readonly output_dir: string;
  readonly timeout_ms?: number;
  readonly max_turns?: number;
  readonly git: ValidatedAssignmentGit;
}

export function validateAssignmentManifest(manifest: unknown, deps?: {
  spawnSync?: typeof import("node:child_process").spawnSync;
  existsSync?: typeof import("node:fs").existsSync;
  readFileSync?: typeof import("node:fs").readFileSync;
  realpathSync?: typeof import("node:fs").realpathSync;
  lstatSync?: typeof import("node:fs").lstatSync;
  statSync?: typeof import("node:fs").statSync;
}): ValidatedAssignment;
