import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { rolePurposeForId } from "./role.ts";

const RETIRED_POLICY = ".kxm/producers.yaml";

export interface RoutePolicy { schema: "kxm.routes.v2"; updatedAt: string; admitted: string[]; disabled: string[]; }
const empty = (): RoutePolicy => ({ schema: "kxm.routes.v2", updatedAt: new Date().toISOString(), admitted: [], disabled: [] });
export function loadRoutePolicy(root: string): RoutePolicy {
  if (existsSync(join(root, RETIRED_POLICY))) throw new Error(`retired ${RETIRED_POLICY} present; use .kxm/routes.yaml (kxm.routes.v2)`);
  const path = join(root, ".kxm", "routes.yaml");
  if (!existsSync(path)) return empty();
  const value = parse(readFileSync(path, "utf8")) as Partial<RoutePolicy>;
  if (value?.schema !== "kxm.routes.v2" || !Array.isArray(value.admitted)) throw new Error("invalid .kxm/routes.yaml");
  return { schema: "kxm.routes.v2", updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(), admitted: value.admitted.filter((x): x is string => typeof x === "string"), disabled: Array.isArray(value.disabled) ? value.disabled.filter((x): x is string => typeof x === "string") : [] };
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
    const modelsDir = join(root, ".kxm", "models");
    let routeId: string | undefined;
    if (existsSync(modelsDir)) {
      for (const name of readdirSync(modelsDir)) {
        if (!name.endsWith(".yaml") || name === "inventory.yaml") continue;
        const parsedModel = parse(readFileSync(join(modelsDir, name), "utf8")) as { vendor?: unknown; model?: unknown; schema?: unknown };
        if (parsedModel?.schema !== "kxm.model.v2") continue;
        const vendor = typeof parsedModel.vendor === "string" ? parsedModel.vendor : "";
        const named = typeof parsedModel.model === "string" ? parsedModel.model : "";
        if (named === model || (vendor && `${vendor}/${named}` === model)) {
          routeId = name.slice(0, -5);
          break;
        }
      }
    }
    if (!routeId) throw new Error(`unknown route: no v2 model file matches '${model}'`);
    const existing = roster.findIndex((entry) => entry.route === routeId || entry.model === model);
    if (removeRole) { if (existing >= 0) roster.splice(existing, 1); }
    else if (existing < 0) roster.push({ route: routeId });
    const purpose = typeof roleFile.purpose === "string" ? roleFile.purpose : rolePurposeForId(role);
    roleFile.schema = "kxm.role.v2";
    roleFile.id ??= role;
    roleFile.purpose ??= purpose;
    roleFile.permission ??= purpose === "writer" ? "edit" : "read-only";
    roleFile.description ??= role;
    roleFile.roster = roster;
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
    const role = file.slice(0, -5); const value = parse(readFileSync(join(dir, file), "utf8")) as { roster?: Array<{ route?: unknown }> };
    result[role] = (value.roster ?? []).map((entry) => entry.route).filter((route): route is string => typeof route === "string");
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
