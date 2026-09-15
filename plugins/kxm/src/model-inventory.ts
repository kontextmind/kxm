import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { defaultSpawn } from "./vnext-oneshot-process.ts";

export interface InventoryPrice {
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  cacheReadPerMillion: number | null;
  cacheWritePerMillion: number | null;
}

export interface InventoryCapabilities {
  thinking: { supported: boolean | null; levels?: string[]; default?: string; source: string };
  speed: { fast: boolean | null; tiers?: string[]; source: string };
}

export interface InventoryModel {
  id: string;
  name?: string;
  contextLength?: number;
  capabilities: InventoryCapabilities;
  standard?: InventoryPrice;
  discount?: InventoryPrice;
  sources: string[];
}

export interface ModelInventory {
  schema: "kxm.model-inventory.v1";
  fetchedAt: string;
  currency: "USD";
  sources: Record<string, { url: string; ok: boolean; error?: string }>;
  models: InventoryModel[];
}

const OR_URL = "https://openrouter.ai/api/v1/models";
const NOUS_URL = "https://inference-api.nousresearch.com/v1/models";

function price(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value * 1_000_000;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0) return Number(value) * 1_000_000;
  return null;
}
function rates(raw: any): InventoryPrice | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const input = price(raw.prompt ?? raw.input);
  const output = price(raw.completion ?? raw.output);
  if (input === null && output === null) return undefined;
  return {
    inputPerMillion: input,
    outputPerMillion: output,
    cacheReadPerMillion: price(raw.input_cache_read ?? raw.cache_read),
    cacheWritePerMillion: price(raw.input_cache_write ?? raw.cache_write),
  };
}
function modelId(id: string): string {
  return id.trim().toLowerCase();
}
async function fetchModels(url: string, authorization?: string): Promise<{ data: any[]; error?: string }> {
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (authorization) headers.Authorization = `Bearer ${authorization}`;
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return { data: [], error: `HTTP ${response.status}` };
    const payload = await response.json() as any;
    if (Array.isArray(payload?.data)) return { data: payload.data };
    return { data: [], error: "response has no data array" };
  } catch (error) {
    return { data: [], error: error instanceof Error ? error.message : "request failed" };
  }
}

/** Refreshes a provenance-bearing model inventory. Aggregator prices are never treated as native auth evidence. */
export async function refreshModelInventory(options: { outputRoot: string; env?: NodeJS.ProcessEnv; now?: Date }): Promise<ModelInventory> {
  const env = options.env ?? process.env;
  const fetchedAt = (options.now ?? new Date()).toISOString();
  const sources: ModelInventory["sources"] = {};
  const byId = new Map<string, InventoryModel>();
  const add = (item: any, source: string, kind: "standard" | "discount") => {
    if (!item || typeof item.id !== "string" || !item.id.trim()) return;
    const key = modelId(item.id);
    const current: InventoryModel = byId.get(key) ?? { id: item.id, ...(typeof item.name === "string" ? { name: item.name } : {}), ...(typeof item.context_length === "number" ? { contextLength: item.context_length } : {}), capabilities: { thinking: { supported: null, source: "unknown" }, speed: { fast: null, source: "unknown" } }, sources: [] };
    if (!current.sources.includes(source)) current.sources.push(source);
    const parsed = rates(item.pricing);
    if (parsed) {
      if (kind === "standard") current.standard = parsed;
      else current.discount = parsed;
    }
    if (!current.name && typeof item.name === "string") current.name = item.name;
    if (!current.contextLength && typeof item.context_length === "number") current.contextLength = item.context_length;
    const parameters = Array.isArray(item.supported_parameters) ? item.supported_parameters.filter((value: unknown): value is string => typeof value === "string") : [];
    if (parameters.some((value: string) => /reasoning|thinking/i.test(value))) current.capabilities.thinking = { supported: true, source };
    if (parameters.some((value: string) => /speed|service.?tier|fast/i.test(value))) current.capabilities.speed = { fast: true, tiers: ["fast"], source };
    if (Array.isArray(item.thinkingLevels) && item.thinkingLevels.length > 0) current.capabilities.thinking = { supported: true, levels: item.thinkingLevels, ...(item.defaultThinking ? { default: item.defaultThinking } : {}), source };
    if (item.fast === true) current.capabilities.speed = { fast: true, tiers: ["fast"], source };
    byId.set(key, current);
  };
  const native = async (command: string, args: string[], source: string) => {
    const result = await defaultSpawn(command, args, { env, timeoutMs: 20_000 });
    const ok = result.code === 0 && !result.error;
    sources[source] = { url: `${command} ${args.join(" ")}`, ok, ...(ok ? {} : { error: (result.stderr || result.error?.message || "command failed").trim().slice(0, 240) }) };
    if (!ok) return;
    for (const line of (result.stdout || "").split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      const id = source === "pi" && parts.length >= 2 && parts[0] !== "provider" ? `${parts[0]}/${parts[1]}` : parts[0];
      if (id && /^[a-z0-9][a-z0-9._/-]+$/i.test(id) && id !== "Available") {
        const effortMatch = source === "agy" ? id.match(/-(low|medium|high)$/i) : null;
        add({ id, ...(effortMatch?.[1] ? { thinkingLevels: [effortMatch[1].toLowerCase()] } : {}) }, source, "standard");
      }
    }
  };
  await native("pi", ["--list-models"], "pi");
  await native("grok", ["models"], "grok");
  await native("agy", ["models"], "agy");
  const openrouter = await fetchModels(env.KXM_OPENROUTER_MODELS_URL?.trim() || OR_URL, env.OPENROUTER_API_KEY);
  const openrouterUrl = env.KXM_OPENROUTER_MODELS_URL?.trim() || OR_URL;
  sources.openrouter = { url: openrouterUrl, ok: !openrouter.error, ...(openrouter.error ? { error: openrouter.error } : {}) };
  for (const item of openrouter.data) add(item, "openrouter", "standard");
  const nousUrl = env.KXM_NOUS_MODELS_URL?.trim() || NOUS_URL;
  const nous = await fetchModels(nousUrl, env.NOUS_API_KEY);
  sources.nous = { url: nousUrl, ok: !nous.error, ...(nous.error ? { error: nous.error } : {}) };
  for (const item of nous.data) add(item, "nous", "discount");
  const inventory: ModelInventory = { schema: "kxm.model-inventory.v1", fetchedAt, currency: "USD", sources, models: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)) };
  mkdirSync(join(options.outputRoot, ".kxm", "models"), { recursive: true });
  writeFileSync(join(options.outputRoot, ".kxm", "models", "inventory.yaml"), stringify(inventory), "utf8");
  return inventory;
}
