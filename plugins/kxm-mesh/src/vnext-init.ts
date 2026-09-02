import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { stringify } from "yaml";
import {
  VnextConfigError,
  discoverGitRoot,
  loadVnextProject,
  planVnextInitialization,
  type JsonObject,
  type VnextConfigIssue,
  type VnextConfigOptions,
  type VnextInitializationPlan,
} from "./vnext-config.ts";

export interface VnextInitOptions extends VnextConfigOptions {
  projectId?: string;
  projectName?: string;
  dryRun?: boolean;
}

export interface VnextInitResult {
  action: "planned" | "created" | "validated";
  plan: VnextInitializationPlan;
  projectRoot?: string;
  configRevision?: string;
  files: readonly string[];
}

const PROJECT_ID = /^prj_[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/;
const TEMPLATE_FILES = [
  ".kxm/agents/coordinator.yaml",
  ".kxm/agents/implementer.yaml",
  ".kxm/project.yaml",
  ".kxm/repo/repo.yaml",
  ".kxm/workflows/default.yaml",
] as const;

function initIssue(code: string, file: string, message: string): VnextConfigIssue {
  return { phase: "discovery", code, file, message };
}

function normalizedProjectName(root: string, requested?: string): string {
  const name = (requested ?? basename(root) ?? "KXM Project").trim();
  if (name.length < 1 || name.length > 120 || /[\u0000\r\n]/.test(name)) {
    throw new VnextConfigError([initIssue("project_name_invalid", ".kxm/project.yaml", "project name must contain 1-120 characters on one line")]);
  }
  return name;
}

function generatedProjectId(requested?: string): string {
  const id = requested?.trim() || `prj_${randomUUID().replaceAll("-", "")}`;
  if (!PROJECT_ID.test(id) || id.length > 144) {
    throw new VnextConfigError([initIssue("project_id_invalid", ".kxm/project.yaml", "project ID must satisfy the kxm.project.v1 opaque ID grammar and use the prj_ prefix")]);
  }
  return id;
}

function template(projectId: string, projectName: string): ReadonlyMap<string, JsonObject> {
  return new Map<string, JsonObject>([
    [".kxm/project.yaml", {
      schema: "kxm.project.v1",
      id: projectId,
      name: projectName,
      defaultWorkflow: "default",
      defaultExecutor: "local",
      repositories: [{ id: "control", role: "control", required: true, pathHint: "." }],
      workspace: {
        dirtySnapshot: {
          untracked: "ask",
          dirtySubmodules: "fail",
        },
      },
    }],
    [".kxm/repo/repo.yaml", {
      schema: "kxm.repository.v1",
      projectId,
      repositoryId: "control",
      description: "Authoritative project configuration and repository content.",
      defaultAccess: "write",
    }],
    [".kxm/agents/coordinator.yaml", {
      schema: "kxm.agent.v1",
      purpose: "Coordinate the pinned workflow and emit schema-validated commands.",
      tools: { preset: "coordinator" },
      defaultRepositoryAccess: "read",
      repositories: { control: "read" },
      network: "provider-only",
      resultSchema: "kxm.assignment-result.v1",
    }],
    [".kxm/agents/implementer.yaml", {
      schema: "kxm.agent.v1",
      purpose: "Implement the approved change within the declared repository scope.",
      tools: { preset: "workspace-writer" },
      defaultRepositoryAccess: "none",
      repositories: { control: "write" },
      network: "provider-only",
      resultSchema: "kxm.assignment-result.v1",
    }],
    [".kxm/workflows/default.yaml", {
      schema: "kxm.workflow.v1",
      description: "Plan, implement, and verify a local change.",
      coordinator: "coordinator",
      limits: {
        maxTransitions: 8,
        maxRunDurationMs: 14_400_000,
        maxAgentTimeMs: 21_600_000,
      },
      steps: [
        {
          id: "plan",
          kind: "agent",
          agent: "coordinator",
          maxAttempts: 2,
          repositories: { control: "read" },
          requiredEvidence: [{ key: "plan", kind: "artifact" }],
          timeoutMs: 1_200_000,
          on: {
            passed: "implement",
            blocked: { target: "$terminal", terminalStatus: "failed" },
          },
        },
        {
          id: "implement",
          kind: "agent",
          agent: "implementer",
          maxAttempts: 3,
          repositories: { control: "write" },
          assignments: {
            allowedAgents: ["implementer"],
            minimum: 1,
            target: 1,
            maximum: 1,
            maxParallel: 1,
            maxAttemptsPerAssignment: 2,
            maxWriteRepositories: 1,
          },
          requiredEvidence: [{ key: "implementation-diff", kind: "artifact" }],
          timeoutMs: 3_600_000,
          on: {
            passed: "verify",
            failed: { target: "$terminal", terminalStatus: "failed" },
            blocked: { target: "$terminal", terminalStatus: "failed" },
          },
        },
        {
          id: "verify",
          kind: "gate",
          gate: "test",
          maxAttempts: 3,
          repositories: { control: "write" },
          requiredEvidence: [{ key: "local-gates", kind: "gate" }],
          timeoutMs: 3_600_000,
          on: {
            passed: { target: "$terminal", terminalStatus: "completed" },
            "implementation-failure": { target: "implement", maxTransitions: 3 },
            failed: { target: "$terminal", terminalStatus: "failed" },
          },
        },
      ],
    }],
  ]);
}

function writeTemplate(stagingRoot: string, resources: ReadonlyMap<string, JsonObject>): void {
  for (const [portablePath, value] of resources) {
    const file = join(stagingRoot, ...portablePath.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, stringify(value, { lineWidth: 0 }), { encoding: "utf8", flag: "wx" });
  }
}

/**
 * Idempotent first slice of unified init: validate an existing vNext project,
 * produce a non-mutating migration/repair plan, or atomically create the
 * minimal Git-tracked project configuration in an otherwise uninitialized
 * Git root. Existing files are never overwritten.
 */
export function initializeVnextProject(start = process.cwd(), options: VnextInitOptions = {}): VnextInitResult {
  const plan = planVnextInitialization(start, options);
  const gitRoot = discoverGitRoot(start);
  if (!gitRoot) {
    throw new VnextConfigError([initIssue("git_root_required", ".", "kxm init must run inside the authoritative Git worktree")]);
  }
  if (options.projectId !== undefined) generatedProjectId(options.projectId);
  if (options.projectName !== undefined) normalizedProjectName(gitRoot, options.projectName);
  if (plan.mode === "migrate" || plan.mode === "repair") {
    return { action: "planned", plan, ...(plan.projectRoot ? { projectRoot: plan.projectRoot } : {}), files: [] };
  }
  if (plan.mode === "ready") {
    if (options.dryRun) return { action: "planned", plan, ...(plan.projectRoot ? { projectRoot: plan.projectRoot } : {}), files: [] };
    return {
      action: "validated",
      plan,
      ...(plan.projectRoot ? { projectRoot: plan.projectRoot } : {}),
      ...(plan.configRevision ? { configRevision: plan.configRevision } : {}),
      files: [],
    };
  }

  if (plan.projectRoot !== gitRoot) {
    throw new VnextConfigError([initIssue("git_root_required", ".", "kxm init must run inside the authoritative Git worktree")]);
  }
  const projectId = generatedProjectId(options.projectId);
  const projectName = normalizedProjectName(gitRoot, options.projectName);
  const resources = template(projectId, projectName);
  if (options.dryRun) return { action: "planned", plan, projectRoot: gitRoot, files: TEMPLATE_FILES };
  if (existsSync(join(gitRoot, ".kxm"))) {
    throw new VnextConfigError([initIssue("workspace_changed", ".kxm", "workspace changed after planning; existing .kxm state was not overwritten")]);
  }
  const staging = mkdtempSync(join(gitRoot, ".kxm-init-"));
  try {
    writeTemplate(staging, resources);
    const stagedBundle = loadVnextProject(staging, options);
    if (existsSync(join(gitRoot, ".kxm"))) {
      throw new VnextConfigError([initIssue("workspace_changed", ".kxm", "workspace changed during validation; existing state was not overwritten")]);
    }
    try {
      renameSync(join(staging, ".kxm"), join(gitRoot, ".kxm"));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTEMPTY") {
        throw new VnextConfigError([initIssue("workspace_changed", ".kxm", "workspace changed during installation; existing state was not overwritten")]);
      }
      throw error;
    }
    const installedBundle = loadVnextProject(gitRoot, options);
    if (installedBundle.configRevision !== stagedBundle.configRevision) {
      throw new VnextConfigError([initIssue("install_verification_failed", ".kxm", "installed configuration does not match the validated staging bundle")]);
    }
    const completedPlan = planVnextInitialization(gitRoot, options);
    return {
      action: "created",
      plan: completedPlan,
      projectRoot: gitRoot,
      configRevision: installedBundle.configRevision,
      files: TEMPLATE_FILES,
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
    // Once the atomic rename succeeds, validation errors leave the complete
    // configuration in place for deterministic repair rather than deleting
    // an installation another process may already have observed.
  }
}
