/**
 * KXM Workflow Management Subsystem.
 * Supports add, remove, modify, list, and inspection of workflow YAML definitions.
 * Handles global (~/.config/kxm/workflows/) and local (.kxm/workflows/) scoping.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { repoConfigDirectory, userConfigDirectory } from "./config.ts";

export interface WorkflowDefSummary {
  id: string;
  description: string;
  scope: "global" | "local" | "overridden";
  filePath: string;
  stepCount: number;
  roles: string[];
}

export const WORKFLOW_TEMPLATES: Record<string, Record<string, unknown>> = {
  "implement-and-verify": {
    schema: "kxm.workflow.v1",
    description: "Standard implement and verify workflow",
    coordinator: "coordinator",
    limits: {
      maxTransitions: 8,
    },
    steps: [
      {
        id: "implement",
        kind: "agent",
        role: "writer",
        maxAttempts: 2,
        on: {
          passed: "verify",
          failed: {
            target: "$terminal",
            terminalStatus: "failed",
          },
        },
      },
      {
        id: "verify",
        kind: "gate",
        gate: "verify-gate",
        expect: "pass",
        maxAttempts: 1,
        on: {
          passed: {
            target: "$terminal",
            terminalStatus: "completed",
          },
          failed: {
            target: "implement",
            maxTransitions: 2,
          },
        },
      },
    ],
  },
  "dual-critic-review": {
    schema: "kxm.workflow.v1",
    description: "Dual-critic review workflow with independent Fable architecture and Sol CLI critics",
    coordinator: "coordinator",
    limits: {
      maxTransitions: 12,
    },
    steps: [
      {
        id: "implement",
        kind: "agent",
        role: "writer",
        maxAttempts: 2,
        on: {
          passed: "review-arch",
          failed: {
            target: "$terminal",
            terminalStatus: "failed",
          },
        },
      },
      {
        id: "review-arch",
        kind: "agent",
        role: "critic-arch",
        maxAttempts: 2,
        on: {
          passed: "review-cli",
          failed: {
            target: "implement",
            maxTransitions: 2,
          },
        },
      },
      {
        id: "review-cli",
        kind: "agent",
        role: "critic-cli",
        maxAttempts: 2,
        on: {
          passed: "verify",
          failed: {
            target: "implement",
            maxTransitions: 2,
          },
        },
      },
      {
        id: "verify",
        kind: "gate",
        gate: "verify-gate",
        expect: "pass",
        maxAttempts: 1,
        on: {
          passed: {
            target: "$terminal",
            terminalStatus: "completed",
          },
          failed: {
            target: "implement",
            maxTransitions: 2,
          },
        },
      },
    ],
  },
  "spec-and-plan": {
    schema: "kxm.workflow.v1",
    description: "Specification and architecture breakdown planning workflow",
    coordinator: "coordinator",
    limits: {
      maxTransitions: 6,
    },
    steps: [
      {
        id: "plan",
        kind: "agent",
        role: "planner",
        maxAttempts: 2,
        on: {
          passed: "review-arch",
          failed: {
            target: "$terminal",
            terminalStatus: "failed",
          },
        },
      },
      {
        id: "review-arch",
        kind: "agent",
        role: "critic-arch",
        maxAttempts: 2,
        on: {
          passed: {
            target: "$terminal",
            terminalStatus: "completed",
          },
          failed: {
            target: "plan",
            maxTransitions: 2,
          },
        },
      },
    ],
  },
};

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
    const parsed = parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed;
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
      if (entry.endsWith(".yaml") || entry.endsWith(".yml")) {
        const filePath = join(localDir, entry);
        const def = parseWorkflowFile(filePath);
        if (def) {
          const id = (def.id as string) || entry.replace(/\.ya?ml$/i, "");
          localDefs.set(id, { def, filePath });
        }
      }
    }
  }

  const globalDefs = new Map<string, { def: Record<string, unknown>; filePath: string }>();
  if (scopeFilter !== "local" && existsSync(globalDir)) {
    for (const entry of readdirSync(globalDir)) {
      if (entry.endsWith(".yaml") || entry.endsWith(".yml")) {
        const filePath = join(globalDir, entry);
        const def = parseWorkflowFile(filePath);
        if (def) {
          const id = (def.id as string) || entry.replace(/\.ya?ml$/i, "");
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
        const role = (step as Record<string, unknown>).role || (step as Record<string, unknown>).agent;
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
  } = {},
): { id: string; filePath: string; scope: "global" | "local" } {
  const scope = options.scope ?? "local";
  const repoRoot = options.repoRoot ?? process.cwd();
  const dir = ensureWorkflowsDirectory(scope, repoRoot, options.userConfigDir);
  const filePath = join(dir, `${workflowId}.yaml`);

  if (existsSync(filePath) && !options.overwrite) {
    throw new Error(`workflow_already_exists: workflow '${workflowId}' already exists at ${filePath}`);
  }

  const payload = typeof content === "string" ? content : stringify(content);
  writeFileSync(filePath, payload, "utf8");
  return { id: workflowId, filePath, scope };
}

export function removeWorkflowDefinition(
  workflowId: string,
  options: {
    scope?: "global" | "local" | undefined;
    repoRoot?: string | undefined;
    userConfigDir?: string | undefined;
  } = {},
): { id: string; removed: boolean; filePath: string; scope: "global" | "local" } {
  const scope = options.scope ?? "local";
  const repoRoot = options.repoRoot ?? process.cwd();
  const dir = workflowsDirectory(scope, repoRoot, options.userConfigDir);
  const filePath = join(dir, `${workflowId}.yaml`);

  if (!existsSync(filePath)) {
    throw new Error(`workflow_not_found: workflow '${workflowId}' not found in ${scope} directory (${filePath})`);
  }

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
  const dir = ensureWorkflowsDirectory(scope, repoRoot, options.userConfigDir);
  const filePath = join(dir, `${workflowId}.yaml`);

  writeFileSync(filePath, stringify(updated), "utf8");
  return { id: workflowId, workflow: updated, filePath, scope };
}
