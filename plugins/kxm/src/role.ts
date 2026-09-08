/**
 * KXM Role Management Subsystem (kxm.role.v1).
 * Supports modular per-role YAML files with descriptions, skills, tool permissions, and model rosters.
 * Implements global (~/.config/kxm/roles/) and local (.kxm/roles/) inheritance.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { repoConfigDirectory, userConfigDirectory } from "./config.ts";

export const KXM_ROLE_SCHEMA = "kxm.role.v1" as const;

export interface KxmRosterEntry {
  harness: string;
  model: string;
  provider?: string | undefined;
  effort?: "low" | "medium" | "high" | "xhigh" | undefined;
  mode?: "headless" | "interactive" | "either" | undefined;
}

export interface KxmRoleToolPolicy {
  preset?: string | undefined;
  allow?: string[] | undefined;
  deny?: string[] | undefined;
}

export interface KxmTemplateContract {
  template: string;
  schema?: string | undefined;
}

export interface KxmRolePolicy {
  vendorIndependenceRequired?: boolean | undefined;
  maxTransitions?: number | undefined;
  requiresGateVerification?: boolean | undefined;
}

export interface KxmRoleDefinition {
  schema: typeof KXM_ROLE_SCHEMA;
  id: string;
  description: string;
  skills?: string[] | undefined;
  tools?: KxmRoleToolPolicy | undefined;
  produces?: KxmTemplateContract[] | undefined;
  consumes?: KxmTemplateContract[] | undefined;
  roster: KxmRosterEntry[];
  policy?: KxmRolePolicy | undefined;
}

export interface KxmRoleSummary {
  id: string;
  description: string;
  scope: "global" | "local" | "overridden";
  filePath: string;
  skills: string[];
  toolsCount: number;
  roster: KxmRosterEntry[];
  primaryModel?: string | undefined;
  primaryHarness?: string | undefined;
}

export const DEFAULT_ROLES: Record<string, KxmRoleDefinition> = {
  writer: {
    schema: KXM_ROLE_SCHEMA,
    id: "writer",
    description: "Primary implementation agent. Writes code, refactors components, and authors unit tests.",
    skills: ["kxm", "unit-testing"],
    tools: {
      preset: "author",
      allow: ["view_file", "replace_file_content", "write_to_file", "run_command"],
      deny: ["git push"],
    },
    produces: [{ template: "code-patch" }],
    roster: [
      { harness: "grok", model: "grok-4.6", effort: "low", mode: "headless" },
      { harness: "pi", provider: "openrouter", model: "openrouter/qwen/qwen3-coder-plus", effort: "medium" },
      { harness: "agy", model: "gemini-2.5-pro", effort: "low" },
    ],
  },
  planner: {
    schema: KXM_ROLE_SCHEMA,
    id: "planner",
    description: "Architecture breakdown, requirement decomposition, and safety boundary definition.",
    skills: ["kxm-session", "architecture-planning"],
    tools: {
      preset: "read_only",
      allow: ["view_file", "grep_search", "find_by_name", "list_dir"],
      deny: ["write_to_file", "replace_file_content", "run_command"],
    },
    produces: [{ template: "implementation-plan" }],
    roster: [
      { harness: "claude", model: "fable", effort: "medium" },
    ],
  },
  "critic-arch": {
    schema: KXM_ROLE_SCHEMA,
    id: "critic-arch",
    description: "Independent critic reviewing implementation diffs for architectural integrity and permission boundaries.",
    policy: { vendorIndependenceRequired: true },
    tools: {
      preset: "critic",
      allow: ["view_file", "grep_search"],
    },
    produces: [{ template: "critic-signoff" }],
    roster: [
      { harness: "claude", model: "fable", effort: "medium" },
    ],
  },
  "critic-cli": {
    schema: KXM_ROLE_SCHEMA,
    id: "critic-cli",
    description: "CLI, documentation, and developer ergonomics critic.",
    policy: { vendorIndependenceRequired: true },
    tools: {
      preset: "critic",
      allow: ["view_file", "grep_search"],
    },
    produces: [{ template: "critic-signoff" }],
    roster: [
      { harness: "codex", model: "gpt-5.6-sol", effort: "low" },
    ],
  },
  verifier: {
    schema: KXM_ROLE_SCHEMA,
    id: "verifier",
    description: "Deterministic gate evaluation runner.",
    tools: {
      preset: "verifier",
      allow: ["run_command"],
    },
    produces: [{ template: "verification-receipt" }],
    roster: [
      { harness: "pi", model: "evaluator", effort: "low" },
    ],
  },
};

export function rolesDirectory(
  scope: "global" | "local",
  repoRoot = process.cwd(),
  userConfigDir?: string,
): string {
  if (scope === "global") {
    return join(userConfigDirectory(userConfigDir), "roles");
  }
  return join(repoConfigDirectory(repoRoot), "roles");
}

export function ensureRolesDirectory(
  scope: "global" | "local",
  repoRoot = process.cwd(),
  userConfigDir?: string,
): string {
  const dir = rolesDirectory(scope, repoRoot, userConfigDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function ensureDefaultRoles(userConfigDir?: string): void {
  const dir = ensureRolesDirectory("global", undefined, userConfigDir);
  for (const [id, def] of Object.entries(DEFAULT_ROLES)) {
    const filePath = join(dir, `${id}.yaml`);
    if (!existsSync(filePath)) {
      writeFileSync(filePath, stringify(def), "utf8");
    }
  }
}

export function parseRoleFile(filePath: string): KxmRoleDefinition | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = parse(raw) as Partial<KxmRoleDefinition>;
    if (!parsed || typeof parsed !== "object" || parsed.schema !== KXM_ROLE_SCHEMA) {
      return undefined;
    }
    const id = parsed.id || filePath.replace(/^.*[\\/]/, "").replace(/\.yaml$/i, "");
    return {
      schema: KXM_ROLE_SCHEMA,
      id,
      description: parsed.description || "",
      skills: Array.isArray(parsed.skills) ? parsed.skills : [],
      tools: parsed.tools,
      produces: parsed.produces,
      consumes: parsed.consumes,
      roster: Array.isArray(parsed.roster) ? parsed.roster : [],
      policy: parsed.policy,
    };
  } catch {
    return undefined;
  }
}

export function listRoles(options: {
  scope?: "all" | "global" | "local" | undefined;
  repoRoot?: string | undefined;
  userConfigDir?: string | undefined;
} = {}): KxmRoleSummary[] {
  const scopeFilter = options.scope ?? "all";
  const repoRoot = options.repoRoot ?? process.cwd();
  const globalDir = rolesDirectory("global", repoRoot, options.userConfigDir);
  const localDir = rolesDirectory("local", repoRoot, options.userConfigDir);

  const localRoles = new Map<string, { role: KxmRoleDefinition; filePath: string }>();
  if (scopeFilter !== "global" && existsSync(localDir)) {
    for (const entry of readdirSync(localDir)) {
      if (entry.endsWith(".yaml") || entry.endsWith(".yml")) {
        const filePath = join(localDir, entry);
        const parsed = parseRoleFile(filePath);
        if (parsed) {
          localRoles.set(parsed.id, { role: parsed, filePath });
        }
      }
    }
  }

  const globalRoles = new Map<string, { role: KxmRoleDefinition; filePath: string }>();
  if (scopeFilter !== "local" && existsSync(globalDir)) {
    for (const entry of readdirSync(globalDir)) {
      if (entry.endsWith(".yaml") || entry.endsWith(".yml")) {
        const filePath = join(globalDir, entry);
        const parsed = parseRoleFile(filePath);
        if (parsed) {
          globalRoles.set(parsed.id, { role: parsed, filePath });
        }
      }
    }
  }

  const result: KxmRoleSummary[] = [];

  // 1. Process local roles
  for (const [id, { role, filePath }] of localRoles) {
    const isOverridden = globalRoles.has(id);
    const primary = role.roster[0];
    result.push({
      id,
      description: role.description,
      scope: isOverridden ? "overridden" : "local",
      filePath,
      skills: role.skills ?? [],
      toolsCount: (role.tools?.allow?.length ?? 0),
      roster: role.roster,
      primaryModel: primary?.model,
      primaryHarness: primary?.harness,
    });
  }

  // 2. Process global roles not in local (or if scope is global only)
  for (const [id, { role, filePath }] of globalRoles) {
    if (scopeFilter === "global" || !localRoles.has(id)) {
      const primary = role.roster[0];
      result.push({
        id,
        description: role.description,
        scope: "global",
        filePath,
        skills: role.skills ?? [],
        toolsCount: (role.tools?.allow?.length ?? 0),
        roster: role.roster,
        primaryModel: primary?.model,
        primaryHarness: primary?.harness,
      });
    }
  }

  result.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}

export function getRole(
  roleId: string,
  options: {
    scope?: "all" | "global" | "local" | undefined;
    repoRoot?: string | undefined;
    userConfigDir?: string | undefined;
  } = {},
): { role: KxmRoleDefinition; scope: "global" | "local"; filePath: string } | undefined {
  const scope = options.scope ?? "all";
  const repoRoot = options.repoRoot ?? process.cwd();

  // Check local first if allowed
  if (scope !== "global") {
    const localDir = rolesDirectory("local", repoRoot, options.userConfigDir);
    const localFile = join(localDir, `${roleId}.yaml`);
    const parsed = parseRoleFile(localFile);
    if (parsed) return { role: parsed, scope: "local", filePath: localFile };
  }

  // Check global
  if (scope !== "local") {
    const globalDir = rolesDirectory("global", repoRoot, options.userConfigDir);
    const globalFile = join(globalDir, `${roleId}.yaml`);
    const parsed = parseRoleFile(globalFile);
    if (parsed) return { role: parsed, scope: "global", filePath: globalFile };
  }

  return undefined;
}

export function addRole(
  role: KxmRoleDefinition,
  options: {
    scope?: "global" | "local" | undefined;
    repoRoot?: string | undefined;
    userConfigDir?: string | undefined;
    overwrite?: boolean | undefined;
  } = {},
): { id: string; filePath: string; scope: "global" | "local" } {
  const scope = options.scope ?? "local";
  const repoRoot = options.repoRoot ?? process.cwd();
  const dir = ensureRolesDirectory(scope, repoRoot, options.userConfigDir);
  const filePath = join(dir, `${role.id}.yaml`);

  if (existsSync(filePath) && !options.overwrite) {
    throw new Error(`role_already_exists: role '${role.id}' already exists at ${filePath}`);
  }

  writeFileSync(filePath, stringify(role), "utf8");
  return { id: role.id, filePath, scope };
}

export function removeRole(
  roleId: string,
  options: {
    scope?: "global" | "local" | undefined;
    repoRoot?: string | undefined;
    userConfigDir?: string | undefined;
  } = {},
): { id: string; removed: boolean; filePath: string; scope: "global" | "local" } {
  const scope = options.scope ?? "local";
  const repoRoot = options.repoRoot ?? process.cwd();
  const dir = rolesDirectory(scope, repoRoot, options.userConfigDir);
  const filePath = join(dir, `${roleId}.yaml`);

  if (!existsSync(filePath)) {
    throw new Error(`role_not_found: role '${roleId}' not found in ${scope} directory (${filePath})`);
  }

  rmSync(filePath);
  return { id: roleId, removed: true, filePath, scope };
}

export function modifyRole(
  roleId: string,
  updates: Partial<KxmRoleDefinition>,
  options: {
    scope?: "global" | "local" | undefined;
    repoRoot?: string | undefined;
    userConfigDir?: string | undefined;
  } = {},
): { id: string; role: KxmRoleDefinition; filePath: string; scope: "global" | "local" } {
  const target = getRole(roleId, { scope: options.scope, repoRoot: options.repoRoot, userConfigDir: options.userConfigDir });
  if (!target) {
    throw new Error(`role_not_found: role '${roleId}' does not exist`);
  }

  const updated: KxmRoleDefinition = {
    ...target.role,
    ...updates,
    schema: KXM_ROLE_SCHEMA,
    id: roleId, // preserve identity
  };

  const scope = options.scope ?? target.scope;
  const repoRoot = options.repoRoot ?? process.cwd();
  const dir = ensureRolesDirectory(scope, repoRoot, options.userConfigDir);
  const filePath = join(dir, `${roleId}.yaml`);

  writeFileSync(filePath, stringify(updated), "utf8");
  return { id: roleId, role: updated, filePath, scope };
}
