import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";

export interface ProducerPolicy { schema: "kxm.producers.v1"; updatedAt: string; promoted: string[]; demoted: string[]; enabled: string[]; disabled: string[]; roles: Record<string, string[]>; }
const empty = (): ProducerPolicy => ({ schema: "kxm.producers.v1", updatedAt: new Date().toISOString(), promoted: [], demoted: [], enabled: [], disabled: [], roles: {} });
export function loadProducerPolicy(root: string): ProducerPolicy {
  const path = join(root, ".kxm", "producers.yaml");
  if (!existsSync(path)) return empty();
  const value = parse(readFileSync(path, "utf8")) as Partial<ProducerPolicy>;
  if (value?.schema !== "kxm.producers.v1" || !Array.isArray(value.promoted) || !Array.isArray(value.demoted)) throw new Error("invalid .kxm/producers.yaml");
  return { schema: "kxm.producers.v1", updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(), promoted: value.promoted.filter((x): x is string => typeof x === "string"), demoted: value.demoted.filter((x): x is string => typeof x === "string"), enabled: Array.isArray(value.enabled) ? value.enabled.filter((x): x is string => typeof x === "string") : [], disabled: Array.isArray(value.disabled) ? value.disabled.filter((x): x is string => typeof x === "string") : [], roles: value.roles && typeof value.roles === "object" ? Object.fromEntries(Object.entries(value.roles).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).filter((x): x is string => typeof x === "string")])) : {} };
}
export function updateProducer(root: string, model: string, status: "promoted" | "demoted"): ProducerPolicy {
  const policy = loadProducerPolicy(root);
  policy.promoted = policy.promoted.filter((x) => x !== model);
  policy.demoted = policy.demoted.filter((x) => x !== model);
  policy[status].push(model);
  policy.updatedAt = new Date().toISOString();
  mkdirSync(join(root, ".kxm"), { recursive: true });
  writeFileSync(join(root, ".kxm", "producers.yaml"), stringify(policy), "utf8");
  return policy;
}
export function setModelState(root: string, model: string, state: "enabled" | "disabled", role?: string, removeRole = false): ProducerPolicy {
  const policy = loadProducerPolicy(root);
  policy.enabled = policy.enabled.filter((x) => x !== model);
  policy.disabled = policy.disabled.filter((x) => x !== model);
  policy[state].push(model);
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
  writeFileSync(join(root, ".kxm", "producers.yaml"), stringify(policy), "utf8");
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

export function isProducerAdmitted(root: string, modelId: string): boolean {
  const policy = loadProducerPolicy(root);
  return policy.enabled.includes(modelId) && policy.promoted.includes(modelId) && !policy.disabled.includes(modelId) && !policy.demoted.includes(modelId);
}

export function listInventoryModels(root: string): string[] {
  const path = join(root, ".kxm", "models", "inventory.yaml");
  if (!existsSync(path)) return [];
  const value = parse(readFileSync(path, "utf8")) as { models?: Array<{ id?: unknown }> };
  return (value.models ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
}
