/**
 * KXM Workflow Management Subsystem.
 * Supports add, remove, modify, list, and inspection of workflow YAML definitions.
 * Handles global (~/.config/kxm/workflows/) and local (.kxm/workflows/) scoping.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { repoConfigDirectory, userConfigDirectory } from "./config.ts";
import { compileKxmWorkflow } from "./engine-compile.ts";
import { KxmConfigError, KxmSchemaRegistry, kxmResourceIdentifier, parseRestrictedYaml } from "./project-config.ts";

function assertWorkflowId(workflowId: string): void {
  if (!kxmResourceIdentifier(workflowId)) {
    throw new Error(`workflow_id_invalid: '${workflowId}' must be a flat lowercase slug of at most 64 characters, starting with a letter and using letters, digits, single hyphens or underscores; paths and platform-reserved names are not allowed (use 'bug-fix', not 'software-engineering/bug-fix')`);
  }
}

let workflowSchemaRegistry: KxmSchemaRegistry | undefined;

function workflowPayload(workflowId: string, content: Record<string, unknown> | string, filePath: string): string {
  const payload = typeof content === "string" ? content : stringify(content);
  const value = parseRestrictedYaml(payload, filePath);
  const issues = (workflowSchemaRegistry ??= new KxmSchemaRegistry()).validate("workflow", value, filePath);
  if (issues.length > 0) throw new KxmConfigError(issues);
  compileKxmWorkflow({ id: workflowId, value, logicalPath: filePath });
  return payload;
}

export interface WorkflowDefSummary {
  id: string;
  description: string;
  scope: "global" | "local" | "overridden";
  filePath: string;
  stepCount: number;
  roles: string[];
}

// Fresh objects per use: YAML stringify turns a repeated object into an
// anchor and alias, which the restricted project loader refuses.
const completed = () => ({ target: "$terminal", terminalStatus: "completed" });
const failed = () => ({ target: "$terminal", terminalStatus: "failed" });

/** The project's `test` gate from `kxm init`. A gate step settles on `passed` or
 * `implementation-failure`, never `failed`. `maxAttempts` counts entries into a
 * step, so every step a back-edge re-enters allows one entry per transition. */
function verifyStep(retryStep: string): Record<string, unknown> {
  return {
    id: "verify",
    kind: "gate",
    gate: "test",
    expect: "pass",
    maxAttempts: 3,
    repositories: { control: "write" },
    on: {
      passed: completed(),
      "implementation-failure": { target: retryStep, maxTransitions: 2 },
    },
  };
}

/**
 * Built-in `kxm workflow add --template` definitions. Each is a complete
 * kxm.workflow.v1 document (the file name is the workflow id) that uses only
 * what `kxm init` creates: the coordinator and implementer agents, the control
 * repository, and the `test` gate. Agent steps declare `failed` because the
 * producer falls back to it.
 */
export const WORKFLOW_TEMPLATES: Record<string, Record<string, unknown>> = {
  "implement-and-verify": {
    schema: "kxm.workflow.v1",
    description: "Implement a change, then run the project's test gate; a failing gate sends the work back to implement.",
    coordinator: "coordinator",
    limits: {
      maxTransitions: 8,
    },
    steps: [
      {
        id: "implement",
        kind: "agent",
        agent: "implementer",
        maxAttempts: 3,
        repositories: { control: "write" },
        on: {
          passed: "verify",
          failed: failed(),
        },
      },
      verifyStep("implement"),
    ],
  },
  "dual-critic-review": {
    schema: "kxm.workflow.v1",
    description: "Implement, review twice, then run the project's test gate. Both reviews run as the coordinator agent; for independent critics, add agents under .kxm/agents and point review-arch and review-cli at them.",
    coordinator: "coordinator",
    limits: {
      maxTransitions: 12,
    },
    steps: [
      {
        id: "implement",
        kind: "agent",
        agent: "implementer",
        maxAttempts: 3,
        repositories: { control: "write" },
        on: {
          passed: "review-arch",
          failed: failed(),
        },
      },
      {
        id: "review-arch",
        kind: "agent",
        agent: "coordinator",
        maxAttempts: 3,
        repositories: { control: "read" },
        on: {
          passed: "review-cli",
          failed: { target: "implement", maxTransitions: 2 },
        },
      },
      {
        id: "review-cli",
        kind: "agent",
        agent: "coordinator",
        maxAttempts: 3,
        repositories: { control: "read" },
        on: {
          passed: "verify",
          failed: { target: "implement", maxTransitions: 2 },
        },
      },
      verifyStep("implement"),
    ],
  },
  "spec-and-plan": {
    schema: "kxm.workflow.v1",
    description: "Plan a change, then review the plan. Both steps run as the coordinator agent and only read the repository.",
    coordinator: "coordinator",
    limits: {
      maxTransitions: 8,
    },
    steps: [
      {
        id: "plan",
        kind: "agent",
        agent: "coordinator",
        maxAttempts: 3,
        repositories: { control: "read" },
        on: {
          passed: "review-arch",
          failed: failed(),
        },
      },
      {
        id: "review-arch",
        kind: "agent",
        agent: "coordinator",
        maxAttempts: 3,
        repositories: { control: "read" },
        on: {
          passed: completed(),
          failed: { target: "plan", maxTransitions: 2 },
        },
      },
    ],
  },
};

/** The one-step definition `kxm workflow add <id>` writes without a template or file. */
export function scaffoldWorkflowDefinition(description: string): Record<string, unknown> {
  return {
    schema: "kxm.workflow.v1",
    description,
    coordinator: "coordinator",
    limits: { maxTransitions: 8 },
    steps: [
      {
        id: "step-1",
        kind: "agent",
        agent: "implementer",
        repositories: { control: "write" },
        on: { passed: completed(), failed: failed() },
      },
    ],
  };
}

export const DEFAULT_WORKFLOW_TEMPLATE = WORKFLOW_TEMPLATES["implement-and-verify"]!;

export function workflowsDirectory(
  scope: "global" | "local",
  repoRoot = process.cwd(),
  userConfigDir?: string,
): string {
  if (scope === "global") {
    return join(userConfigDirectory(userConfigDir), "workflows");
  }
  return join(repoConfigDirectory(repoRoot), "workflows");
}

export function ensureWorkflowsDirectory(
  scope: "global" | "local",
  repoRoot = process.cwd(),
  userConfigDir?: string,
): string {
  const dir = workflowsDirectory(scope, repoRoot, userConfigDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function parseWorkflowFile(filePath: string): Record<string, unknown> | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const raw = readFileSync(filePath, "utf8");
    return parseRestrictedYaml(raw, filePath);
  } catch {
    return undefined;
  }
}

export function listWorkflowDefinitions(options: {
  scope?: "all" | "global" | "local" | undefined;
  repoRoot?: string | undefined;
  userConfigDir?: string | undefined;
} = {}): WorkflowDefSummary[] {
  const scopeFilter = options.scope ?? "all";
  const repoRoot = options.repoRoot ?? process.cwd();
  const globalDir = workflowsDirectory("global", repoRoot, options.userConfigDir);
  const localDir = workflowsDirectory("local", repoRoot, options.userConfigDir);

  const localDefs = new Map<string, { def: Record<string, unknown>; filePath: string }>();
  if (scopeFilter !== "global" && existsSync(localDir)) {
    for (const entry of readdirSync(localDir)) {
      if (entry.endsWith(".yaml") && kxmResourceIdentifier(entry.slice(0, -5))) {
        const filePath = join(localDir, entry);
        const def = parseWorkflowFile(filePath);
        if (def) {
          const id = entry.slice(0, -5);
          localDefs.set(id, { def, filePath });
        }
      }
    }
  }

  const globalDefs = new Map<string, { def: Record<string, unknown>; filePath: string }>();
  if (scopeFilter !== "local" && existsSync(globalDir)) {
    for (const entry of readdirSync(globalDir)) {
      if (entry.endsWith(".yaml") && kxmResourceIdentifier(entry.slice(0, -5))) {
        const filePath = join(globalDir, entry);
        const def = parseWorkflowFile(filePath);
        if (def) {
          const id = entry.slice(0, -5);
          globalDefs.set(id, { def, filePath });
        }
      }
    }
  }

  const extractRoles = (def: Record<string, unknown>): string[] => {
    const roles: string[] = [];
    const steps = Array.isArray(def.steps) ? def.steps : [];
    for (const step of steps) {
      if (step && typeof step === "object") {
        const role = (step as Record<string, unknown>).agent;
        if (typeof role === "string" && !roles.includes(role)) {
          roles.push(role);
        }
      }
    }
    return roles;
  };

  const result: WorkflowDefSummary[] = [];

  for (const [id, { def, filePath }] of localDefs) {
    const isOverridden = globalDefs.has(id);
    const steps = Array.isArray(def.steps) ? def.steps : [];
    result.push({
      id,
      description: typeof def.description === "string" ? def.description : "",
      scope: isOverridden ? "overridden" : "local",
      filePath,
      stepCount: steps.length,
      roles: extractRoles(def),
    });
  }

  for (const [id, { def, filePath }] of globalDefs) {
    if (scopeFilter === "global" || !localDefs.has(id)) {
      const steps = Array.isArray(def.steps) ? def.steps : [];
      result.push({
        id,
        description: typeof def.description === "string" ? def.description : "",
        scope: "global",
        filePath,
        stepCount: steps.length,
        roles: extractRoles(def),
      });
    }
  }

  result.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}

export function getWorkflowDefinition(
  workflowId: string,
  options: {
    scope?: "all" | "global" | "local" | undefined;
    repoRoot?: string | undefined;
    userConfigDir?: string | undefined;
  } = {},
): { workflow: Record<string, unknown>; scope: "global" | "local"; filePath: string } | undefined {
  assertWorkflowId(workflowId);
  const scope = options.scope ?? "all";
  const repoRoot = options.repoRoot ?? process.cwd();

  // 1. Check local first
  if (scope !== "global") {
    const localDir = workflowsDirectory("local", repoRoot, options.userConfigDir);
    const localFile = join(localDir, `${workflowId}.yaml`);
    const parsed = parseWorkflowFile(localFile);
    if (parsed) return { workflow: parsed, scope: "local", filePath: localFile };
  }

  // 2. Check global
  if (scope !== "local") {
    const globalDir = workflowsDirectory("global", repoRoot, options.userConfigDir);
    const globalFile = join(globalDir, `${workflowId}.yaml`);
    const parsed = parseWorkflowFile(globalFile);
    if (parsed) return { workflow: parsed, scope: "global", filePath: globalFile };
  }

  return undefined;
}

export function addWorkflowDefinition(
  workflowId: string,
  content: Record<string, unknown> | string = DEFAULT_WORKFLOW_TEMPLATE,
  options: {
    scope?: "global" | "local" | undefined;
    repoRoot?: string | undefined;
    userConfigDir?: string | undefined;
    overwrite?: boolean | undefined;
    dryRun?: boolean | undefined;
  } = {},
): { id: string; filePath: string; scope: "global" | "local" } {
  assertWorkflowId(workflowId);
  const scope = options.scope ?? "local";
  const repoRoot = options.repoRoot ?? process.cwd();
  const dir = workflowsDirectory(scope, repoRoot, options.userConfigDir);
  const filePath = join(dir, `${workflowId}.yaml`);

  if (existsSync(filePath) && !options.overwrite) {
    throw new Error(`workflow_already_exists: workflow '${workflowId}' already exists at ${filePath}`);
  }

  const payload = workflowPayload(workflowId, content, filePath);
  if (!options.dryRun) {
    ensureWorkflowsDirectory(scope, repoRoot, options.userConfigDir);
    writeFileSync(filePath, payload, "utf8");
  }
  return { id: workflowId, filePath, scope };
}

export function removeWorkflowDefinition(
  workflowId: string,
  options: {
    scope?: "global" | "local" | undefined;
    repoRoot?: string | undefined;
    userConfigDir?: string | undefined;
    dryRun?: boolean | undefined;
  } = {},
): { id: string; removed: boolean; filePath: string; scope: "global" | "local" } {
  assertWorkflowId(workflowId);
  const scope = options.scope ?? "local";
  const repoRoot = options.repoRoot ?? process.cwd();
  const dir = workflowsDirectory(scope, repoRoot, options.userConfigDir);
  const filePath = join(dir, `${workflowId}.yaml`);

  if (!existsSync(filePath)) {
    throw new Error(`workflow_not_found: workflow '${workflowId}' not found in ${scope} directory (${filePath})`);
  }

  if (options.dryRun) return { id: workflowId, removed: false, filePath, scope };
  rmSync(filePath);
  return { id: workflowId, removed: true, filePath, scope };
}

export function modifyWorkflowDefinition(
  workflowId: string,
  updates: Record<string, unknown>,
  options: {
    scope?: "global" | "local" | undefined;
    repoRoot?: string | undefined;
    userConfigDir?: string | undefined;
    dryRun?: boolean | undefined;
  } = {},
): { id: string; workflow: Record<string, unknown>; filePath: string; scope: "global" | "local" } {
  const target = getWorkflowDefinition(workflowId, { scope: options.scope, repoRoot: options.repoRoot, userConfigDir: options.userConfigDir });
  if (!target) {
    throw new Error(`workflow_not_found: workflow '${workflowId}' does not exist`);
  }

  const updated: Record<string, unknown> = {
    ...target.workflow,
    ...updates,
  };

  const scope = options.scope ?? target.scope;
  const repoRoot = options.repoRoot ?? process.cwd();
  const dir = workflowsDirectory(scope, repoRoot, options.userConfigDir);
  const filePath = join(dir, `${workflowId}.yaml`);

  const payload = workflowPayload(workflowId, updated, filePath);
  if (!options.dryRun) {
    ensureWorkflowsDirectory(scope, repoRoot, options.userConfigDir);
    writeFileSync(filePath, payload, "utf8");
  }
  return { id: workflowId, workflow: updated, filePath, scope };
}
