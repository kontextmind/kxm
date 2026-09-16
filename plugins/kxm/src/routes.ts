import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";

const RETIRED_POLICY = ".kxm/producers.yaml";

export interface RoutePolicy { schema: "kxm.routes.v2"; updatedAt: string; admitted: string[]; disabled: string[]; roles: Record<string, string[]>; }
const empty = (): RoutePolicy => ({ schema: "kxm.routes.v2", updatedAt: new Date().toISOString(), admitted: [], disabled: [], roles: {} });
export function loadRoutePolicy(root: string): RoutePolicy {
  if (existsSync(join(root, RETIRED_POLICY))) throw new Error(`retired ${RETIRED_POLICY} present; use .kxm/routes.yaml (kxm.routes.v2)`);
  const path = join(root, ".kxm", "routes.yaml");
  if (!existsSync(path)) return empty();
  const value = parse(readFileSync(path, "utf8")) as Partial<RoutePolicy>;
  if (value?.schema !== "kxm.routes.v2" || !Array.isArray(value.admitted)) throw new Error("invalid .kxm/routes.yaml");
  return { schema: "kxm.routes.v2", updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(), admitted: value.admitted.filter((x): x is string => typeof x === "string"), disabled: Array.isArray(value.disabled) ? value.disabled.filter((x): x is string => typeof x === "string") : [], roles: value.roles && typeof value.roles === "object" ? Object.fromEntries(Object.entries(value.roles).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).filter((x): x is string => typeof x === "string")])) : {} };
}
export function updateRouteState(root: string, model: string, state: "admitted" | "disabled"): RoutePolicy {
  return setRouteState(root, model, state);
}
export function setRouteState(root: string, model: string, state: "admitted" | "disabled", role?: string, removeRole = false): RoutePolicy {
  const policy = loadRoutePolicy(root);
  policy.admitted = policy.admitted.filter((x) => x !== model);
  policy.disabled = policy.disabled.filter((x) => x !== model);
  if (state === "admitted") policy.admitted.push(model);
  else policy.disabled.push(model);
  if (role) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(role)) throw new Error("invalid role id");
    const rolePath = join(root, ".kxm", "roles", `${role}.yaml`);
    let roleFile: Record<string, unknown> = {};
    if (existsSync(rolePath)) {
      const parsed = parse(readFileSync(rolePath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) roleFile = parsed as Record<string, unknown>;
    }
    const roster = Array.isArray(roleFile.roster) ? roleFile.roster.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)) : [];
    const existing = roster.findIndex((entry) => entry.model === model);
    if (removeRole) { if (existing >= 0) roster.splice(existing, 1); }
    else if (existing < 0) roster.push({ model, enabled: true });
    roleFile.schema ??= "kxm.role.v1"; roleFile.id ??= role; roleFile.roster = roster;
    mkdirSync(join(root, ".kxm", "roles"), { recursive: true });
    writeFileSync(rolePath, stringify(roleFile), "utf8");
  }
  policy.updatedAt = new Date().toISOString();
  mkdirSync(join(root, ".kxm"), { recursive: true });
  writeFileSync(join(root, ".kxm", "routes.yaml"), stringify(policy), "utf8");
  return policy;
}

export function listRoleBindings(root: string): Record<string, string[]> {
  const dir = join(root, ".kxm", "roles"); const result: Record<string, string[]> = {};
  if (!existsSync(dir)) return result;
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".yaml"))) {
    const role = file.slice(0, -5); const value = parse(readFileSync(join(dir, file), "utf8")) as { roster?: Array<{ model?: unknown }> };
    result[role] = (value.roster ?? []).map((entry) => entry.model).filter((model): model is string => typeof model === "string");
  }
  return result;
}

export function isRouteAdmitted(root: string, modelId: string): boolean {
  const policy = loadRoutePolicy(root);
  return policy.admitted.includes(modelId) && !policy.disabled.includes(modelId);
}

export function listInventoryModels(root: string): string[] {
  const path = join(root, ".kxm", "models", "inventory.yaml");
  if (!existsSync(path)) return [];
  const value = parse(readFileSync(path, "utf8")) as { models?: Array<{ id?: unknown }> };
  return (value.models ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
}
