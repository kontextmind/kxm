/**
 * KXM role files (kxm.role.v2).
 * Global (~/.config/kxm/roles/) and local (.kxm/roles/) files. A local id overrides a global one.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { repoConfigDirectory, userConfigDirectory } from "./config.ts";

export const KXM_ROLE_SCHEMA = "kxm.role.v2" as const;

export type KxmRolePurpose = "writer" | "planner" | "reviewer-arch" | "reviewer-cli" | "experiment";
export type KxmRolePermission = "edit" | "read-only";
export type KxmRoleEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface KxmRosterEntry {
  route: string;
  effort?: KxmRoleEffort | undefined;
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

export interface KxmRoleFallback {
  onError?: Array<"rate_limit" | "transport" | "provider_unavailable"> | undefined;
  maxSwitches?: number | undefined;
  revert?: "next_run" | "never" | undefined;
}

export interface KxmRolePolicy {
  vendorIndependenceRequired?: boolean | undefined;
  maxTransitions?: number | undefined;
  requiresGateVerification?: boolean | undefined;
  fallback?: KxmRoleFallback | undefined;
}

export interface KxmRoleDefinition {
  schema: typeof KXM_ROLE_SCHEMA;
  id: string;
  purpose: KxmRolePurpose;
  permission: KxmRolePermission;
  description: string;
  extends?: string | undefined;
  skills?: string[] | undefined;
  tools?: KxmRoleToolPolicy | undefined;
  produces?: KxmTemplateContract[] | undefined;
  consumes?: KxmTemplateContract[] | undefined;
  roster: KxmRosterEntry[];
  policy?: KxmRolePolicy | undefined;
}

export interface KxmRoleSummary {
  id: string;
  purpose?: KxmRolePurpose | undefined;
  permission?: KxmRolePermission | undefined;
  description: string;
  scope: "global" | "local" | "overridden";
  filePath: string;
  skills: string[];
  toolsCount: number;
  roster: KxmRosterEntry[];
  primaryRoute?: string | undefined;
}

const ROLE_PURPOSES: readonly KxmRolePurpose[] = ["writer", "planner", "reviewer-arch", "reviewer-cli", "experiment"];

export function rolePurposeForId(id: string): KxmRolePurpose {
  return (ROLE_PURPOSES as readonly string[]).includes(id) ? id as KxmRolePurpose : "experiment";
}

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

export function parseRoleFile(filePath: string): KxmRoleDefinition | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = parse(raw) as Partial<KxmRoleDefinition>;
    if (!parsed || typeof parsed !== "object" || parsed.schema !== KXM_ROLE_SCHEMA) {
      return undefined;
    }
    const id = parsed.id || filePath.replace(/^.*[\\/]/, "").replace(/\.ya?ml$/i, "");
    const purpose = parsed.purpose ?? rolePurposeForId(id);
    const permission = parsed.permission ?? (purpose === "writer" ? "edit" : "read-only");
    return {
      schema: KXM_ROLE_SCHEMA,
      id,
      purpose,
      permission,
      description: parsed.description || "",
      ...(parsed.extends ? { extends: parsed.extends } : {}),
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
      purpose: role.purpose,
      permission: role.permission,
      description: role.description,
      scope: isOverridden ? "overridden" : "local",
      filePath,
      skills: role.skills ?? [],
      toolsCount: (role.tools?.allow?.length ?? 0),
      roster: role.roster,
      primaryRoute: primary?.route,
    });
  }

  // 2. Process global roles not in local (or if scope is global only)
  for (const [id, { role, filePath }] of globalRoles) {
    if (scopeFilter === "global" || !localRoles.has(id)) {
      const primary = role.roster[0];
      result.push({
        id,
        purpose: role.purpose,
        permission: role.permission,
        description: role.description,
        scope: "global",
        filePath,
        skills: role.skills ?? [],
        toolsCount: (role.tools?.allow?.length ?? 0),
        roster: role.roster,
        primaryRoute: primary?.route,
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
    dryRun?: boolean | undefined;
  } = {},
): { id: string; filePath: string; scope: "global" | "local" } {
  const scope = options.scope ?? "local";
  const repoRoot = options.repoRoot ?? process.cwd();
  const dir = options.dryRun
    ? rolesDirectory(scope, repoRoot, options.userConfigDir)
    : ensureRolesDirectory(scope, repoRoot, options.userConfigDir);
  const filePath = join(dir, `${role.id}.yaml`);

  if (existsSync(filePath) && !options.overwrite) {
    throw new Error(`role_already_exists: role '${role.id}' already exists at ${filePath}`);
  }

  if (!options.dryRun) writeFileSync(filePath, stringify(role), "utf8");
  return { id: role.id, filePath, scope };
}

export function removeRole(
  roleId: string,
  options: {
    scope?: "global" | "local" | undefined;
    repoRoot?: string | undefined;
    userConfigDir?: string | undefined;
    dryRun?: boolean | undefined;
  } = {},
): { id: string; removed: boolean; filePath: string; scope: "global" | "local" } {
  const scope = options.scope ?? "local";
  const repoRoot = options.repoRoot ?? process.cwd();
  const dir = rolesDirectory(scope, repoRoot, options.userConfigDir);
  const filePath = join(dir, `${roleId}.yaml`);

  if (!existsSync(filePath)) {
    throw new Error(`role_not_found: role '${roleId}' not found in ${scope} directory (${filePath})`);
  }

  if (options.dryRun) return { id: roleId, removed: false, filePath, scope };
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
    dryRun?: boolean | undefined;
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
  const dir = options.dryRun
    ? rolesDirectory(scope, repoRoot, options.userConfigDir)
    : ensureRolesDirectory(scope, repoRoot, options.userConfigDir);
  const filePath = join(dir, `${roleId}.yaml`);

  if (!options.dryRun) writeFileSync(filePath, stringify(updated), "utf8");
  return { id: roleId, role: updated, filePath, scope };
}
