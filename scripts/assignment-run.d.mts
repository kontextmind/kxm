export const ASSIGNMENT_SCHEMA: "kxm.assignment.v1";
export const PLAN_POINTER_SCHEMA: "kxm.plan-pointer.v1";
export const PLAN_POINTER_FILENAME: "plan-current.json";
export const COMPLETION_SCHEMA: "kxm.assignment-completion.v1";
export const REFUSAL_SCHEMA: "kxm.assignment-refusal.v1";
export const ASSIGNMENT_DISPATCH_SCHEMA: "kxm.assignment-dispatch.v1";
export const TELEMETRY_SCHEMA: "kxm.telemetry.v1";
export const RECORDING_RESOLUTION_SCHEMA: "kxm.assignment-recording-resolution.v1";
export const RUNNER_CODES: readonly string[];
export const VERIFY_WITNESS_ID: "verify";
export const VALIDATE_CI_WITNESS_ID: "validate-ci";
export const WITNESS_IDS: readonly string[];
export const FIXED_GATES: Readonly<{
  verify: readonly ["npm", "run", "verify"];
  "validate-ci": readonly ["npm", "run", "validate:ci"];
}>;
export const WITNESS_SCHEMA: "kxm.assignment-witness.v1";
export const WITNESS_LATEST_SCHEMA: "kxm.assignment-witness-latest.v1";
export const WITNESS_RESULTS: readonly string[];
export const WITNESS_CODES: readonly string[];
export const ACCEPTED_SCHEMA: "kxm.task-accepted.v1";
export const ACCEPTED_FILENAME: "accepted.json";
export const ACCEPTED_NOTE: string;
export const REQUIRED_ACCEPT_CRITICS: Readonly<Record<string, Readonly<{
  harness: string;
  model: string;
  role: string;
}>>>;
export const ASSIGNMENT_KINDS: readonly string[];
export const KIND_ROLES: Readonly<Record<string, string>>;
export const REVIEW_KINDS: readonly string[];
export const WRITER_KINDS: readonly string[];
export const CLEAN_BASE_KINDS: readonly string[];
export const READ_MECHANISMS: Readonly<Record<string, string>>;

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
  readonly record_dir: string;
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
  readonly requested_output_dir?: string;
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

export interface AssignmentCompletion {
  readonly schema: "kxm.assignment-completion.v1";
  readonly task_id: string;
  readonly assignment_id: string;
  readonly rework_of?: string;
  readonly kind: string;
  readonly role: string;
  readonly manifest: Readonly<{ sha256: string }>;
  readonly prompt: Readonly<{ sha256: string }>;
  readonly plan: Readonly<
    | { kind: "current"; path: string; sha256: string; pointer_path: string; generation: number }
    | { kind: "bootstrap"; reason: string }
  >;
  readonly route: Readonly<{
    harness: string;
    model: string;
    effort: string;
    permission: string;
    role: string;
  }>;
  readonly binding: Readonly<{
    task_dir: string;
    cwd: string;
    record_dir: string;
    output_dir: string;
  }>;
  readonly invocation: "thrown" | "returned";
  readonly candidate: Readonly<
    | { status: "recorded"; head: string; index_tree: string; clean: boolean }
    | { status: "unknown"; code: string }
  >;
  readonly recording: Readonly<
    | { status: "ok" }
    | {
      status: "failed";
      steps: Readonly<{
        candidate_snapshot: "ok" | "failed" | "skipped";
        sidecars: "ok" | "failed" | "skipped";
        routing_record: "ok" | "failed" | "skipped";
        telemetry: "ok" | "failed" | "skipped";
      }>;
      code: string;
    }
  >;
  readonly transport: Readonly<Record<string, unknown>>;
  readonly usage: Readonly<Record<string, unknown>>;
  readonly model_claim?: Readonly<Record<string, unknown>>;
  readonly sidecars: Readonly<Record<string, Readonly<{ path: string; bytes: number }>>>;
  readonly verification: Readonly<{ status: "not-run" }>;
  readonly critic: Readonly<
    | {
      kind: "none";
      reason: "not-review" | "transport-not-completed" | "candidate-unknown" | "candidate-changed" | "no-verdict";
    }
    | { kind: "review"; verdict: "PASS" | "BLOCK"; judged_tree: string; role: string }
  >;
  readonly attribution: Readonly<{ status: "unclassified" }>;
}

export function assignmentOutputSchema(kind: string): Record<string, unknown>;
export function renderAssignmentPrompt(validated: ValidatedAssignment, deps?: {
  existsSync?: typeof import("node:fs").existsSync;
  readFileSync?: typeof import("node:fs").readFileSync;
  statSync?: typeof import("node:fs").statSync;
}): string;
export function assignmentTelemetryPath(outputDir: string): string;
export function appendAssignmentTelemetry(completion: object, outputDir: string, deps?: object): boolean;
export function runAssignment(manifest: unknown, deps?: Record<string, unknown>): Promise<AssignmentCompletion>;
export function observeAssignment(outputDir: string, deps?: Record<string, unknown>): Promise<boolean>;

export interface AssignmentWitnessReceipt {
  readonly schema: "kxm.assignment-witness.v1";
  readonly receipt_id: string;
  readonly task_id: string;
  readonly assignment_id: string;
  readonly kind?: string;
  readonly recordedAt: string;
  readonly manifest: Readonly<{ path: string; sha256: string }>;
  readonly completion: Readonly<{ path: string; sha256: string }>;
  readonly plan: Readonly<
    | { kind: "current"; path?: string; sha256?: string; pointer_path?: string; generation?: number }
    | { kind: "bootstrap"; reason?: string }
  >;
  readonly binding: Readonly<{
    task_dir: string;
    cwd: string;
    record_dir: string;
  }>;
  readonly candidate: Readonly<{
    before?: Readonly<{ head: string; index_tree: string; clean: boolean } | { status: "unknown"; code: string }>;
    after?: Readonly<{ head: string; index_tree: string; clean: boolean } | { status: "unknown"; code: string }>;
  }>;
  readonly gates: readonly Readonly<{
    id: string;
    argv: readonly string[];
    shell: false;
    cwd: string;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    durationMs: number;
    log: Readonly<{ path: string; bytes: number }>;
  }>[];
  readonly result: "passed" | "failed" | "refused";
  readonly code?: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly path?: string;
  readonly sha256?: string;
}

export function witnessAssignment(recordDir: string, deps?: Record<string, unknown>): Promise<AssignmentWitnessReceipt>;

export interface TaskAccepted {
  readonly schema: "kxm.task-accepted.v1";
  readonly task_id: string;
  readonly commit: string;
  readonly tree: string;
  readonly writer: Readonly<{
    assignment_id: string;
    record_dir: string;
    kind: string;
    completion: Readonly<{ path: string; sha256: string }>;
    manifest: Readonly<{ path: string; sha256: string }>;
    receipt: Readonly<{ id: string; path: string; sha256: string }>;
  }>;
  readonly plan: Readonly<{
    kind: "current";
    path: string;
    sha256: string;
    pointer_path: string;
    generation: number;
  }>;
  readonly critics: readonly Readonly<{
    kind: string;
    role: string;
    harness: string;
    model: string;
    assignment_id: string;
    record_dir: string;
    completion: Readonly<{ path: string; sha256: string }>;
    verdict: "PASS";
    judged_tree: string;
  }>[];
  readonly acceptedAt: string;
  readonly observed: Readonly<{
    pr?: Readonly<{ id: string; validated: false }>;
    ci?: Readonly<{ id: string; validated: false }>;
  }>;
  readonly note: string;
  readonly path?: string;
  readonly sha256?: string;
}

export function acceptAssignment(request: {
  taskDir: string;
  commit: string;
  recordDir: string;
  critics: readonly string[];
  observedPr?: string;
  observedCi?: string;
}, deps?: Record<string, unknown>): Promise<TaskAccepted>;

export interface AssignmentRecordingResolution {
  readonly schema: "kxm.assignment-recording-resolution.v1";
  readonly task_id: string;
  readonly assignment_id: string;
  readonly resolvedAt?: string;
  readonly completion_sha256: string;
  readonly steps: Readonly<{
    candidate_snapshot: "ok" | "failed" | "skipped";
    sidecars: "ok" | "failed" | "skipped";
    routing_record: "ok" | "failed" | "skipped";
    telemetry: "ok" | "failed" | "skipped";
  }>;
}

export function main(argv?: string[], io?: {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  spawnSync?: typeof import("node:child_process").spawnSync;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}): Promise<AssignmentCompletion | AssignmentRecordingResolution | AssignmentWitnessReceipt | TaskAccepted>;
