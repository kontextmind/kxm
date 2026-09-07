/**
 * Opt-in Nous provider helpers. Pure: env parse, loopback checks, catalog
 * validation, model-config building, and guidance. No Pi / pi-ai imports.
 *
 * Public GET /v1/models catalog fields are observed: context_length,
 * top_provider.max_completion_tokens, architecture.input_modalities,
 * supported_parameters, and pricing.prompt/completion/input_cache_* as
 * per-token decimal strings plus pricing.overrides[]. Convert once to
 * usd_per_million_tokens. Never apply pricing.original or a blanket discount.
 * Assumed OpenAI-style fixtures remain valid. Streaming flags are unverified.
 */

import { createHash } from "node:crypto";
import { redactSecrets } from "./redact.ts";

export const NOUS_DIRECT_ID = "nous";
export const NOUS_PROXY_ID = "nous-proxy";
export const NOUS_DIRECT_BASE_URL = "https://inference-api.nousresearch.com/v1";
export const NOUS_PROXY_DEFAULT_BASE_URL = "http://127.0.0.1:8645/v1";
export const NOUS_PROXY_PLACEHOLDER_KEY = "kxm-nous-proxy";
export const NOUS_CATALOG_SCHEMA = "kxm.nous-catalog.v1";
export const NOUS_PRICE_UNITS = "usd_per_million_tokens";
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;
export const NOUS_CATALOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const PROVIDER_TOKENS = new Set(["direct", "proxy"]);

export type NousProviderKind = "direct" | "proxy";
export type NousPriceBasis = "list" | "upper-bound";
export type NousBilling = "metered" | "subscription" | "subscription_plus_usage";
export type NousInputModality = "text" | "image";

const PER_TOKEN_TO_USD_PER_M = 1_000_000;
const PI_INPUT_ORDER: NousInputModality[] = ["text", "image"];

export interface NousCostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface NousCostTier extends NousCostRates {
  inputTokensAbove: number;
}

export interface NousModelRecord {
  id: string;
  contextWindow: number;
  maxTokens: number;
  cost: NousCostRates;
  priceBasis: NousPriceBasis;
  billing: NousBilling;
  verified: boolean;
  name?: string;
}

export interface NousCatalogPin {
  schema: typeof NOUS_CATALOG_SCHEMA;
  recordedAt: string;
  source: string;
  units: typeof NOUS_PRICE_UNITS;
  hash: string;
  models: Record<string, Omit<NousModelRecord, "id">>;
}

export interface DiscoveredModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  cost?: NousCostRates;
  units?: string;
  verified?: boolean;
  tiers?: NousCostTier[];
  input?: NousInputModality[];
  reasoning?: boolean;
  tools?: boolean;
  pricingIssue?: string;
  capabilityIssue?: string;
}

export interface DiscoveryProvenance {
  source: string;
  fetchedAt: string;
  rawSha256: string;
}

export type DiscoveryOutcome =
  | { ok: true; models: DiscoveredModel[]; provenance?: DiscoveryProvenance }
  | { ok: false; error: "timeout" | "connection-refused" | "auth" | "http" | "invalid"; status?: number; reason: string };

export type CatalogLoad =
  | { ok: true; pin: NousCatalogPin }
  | { ok: false; reason: string };

export interface BuiltModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  cost: NousCostRates;
  priceBasis: NousPriceBasis;
  billing: NousBilling;
  verified: boolean;
  input?: NousInputModality[];
  reasoning?: boolean;
  tools?: boolean;
  tiers?: NousCostTier[];
}

export interface BuildModelsResult {
  registered: BuiltModel[];
  skipped: Array<{ id: string; reason: string }>;
}

export type GuidanceLevel = "info" | "error";
export interface GuidanceMessage {
  message: string;
  level: GuidanceLevel;
}

export type NousEnvParse =
  | { status: "unset"; providers: []; timeoutMs: number }
  | { status: "invalid"; providers: []; unknownTokens: string[]; timeoutMs: number; error: string }
  | {
    status: "ready";
    providers: NousProviderKind[];
    timeoutMs: number;
    proxyUrl: string;
    catalogFile?: string;
  };

export function parseNousEnv(env: NodeJS.Dict<string> = process.env): NousEnvParse {
  const raw = env.KXM_NOUS_PROVIDERS?.trim() ?? "";
  const timeoutMs = parseTimeout(env.KXM_NOUS_DISCOVERY_TIMEOUT_MS);
  if (!raw) {
    return { status: "unset", providers: [], timeoutMs };
  }
  const tokens = raw.split(",").map((part) => part.trim()).filter(Boolean);
  const unknownTokens = [...new Set(tokens.filter((token) => !PROVIDER_TOKENS.has(token)))];
  if (unknownTokens.length > 0) {
    return {
      status: "invalid",
      providers: [],
      unknownTokens,
      timeoutMs,
      error: `unknown KXM_NOUS_PROVIDERS token(s): ${unknownTokens.join(", ")}; expected direct and/or proxy`,
    };
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return {
      status: "invalid",
      providers: [],
      unknownTokens: [],
      timeoutMs: DEFAULT_DISCOVERY_TIMEOUT_MS,
      error: "KXM_NOUS_DISCOVERY_TIMEOUT_MS must be a positive finite number of milliseconds",
    };
  }
  const providers = [...new Set(tokens)] as NousProviderKind[];
  const catalogFile = env.KXM_NOUS_CATALOG_FILE?.trim();
  const proxyOverride = env.KXM_NOUS_PROXY_URL?.trim();
  return {
    status: "ready",
    providers,
    timeoutMs,
    proxyUrl: proxyOverride && proxyOverride.length > 0 ? proxyOverride : NOUS_PROXY_DEFAULT_BASE_URL,
    ...(catalogFile ? { catalogFile } : {}),
  };
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_DISCOVERY_TIMEOUT_MS;
  const value = Number(raw);
  return value;
}

export function isLoopbackUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK_HOSTS.has(host);
}

export function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}

export function sanitizeNousText(value: string): string {
  const stripped = value
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(NOUS_API_KEY|OPENROUTER_API_KEY|ANTHROPIC_API_KEY|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]");
  return redactSecrets(stripped).slice(0, 500);
}

export function catalogCanonicalPayload(pin: { recordedAt: string; source: string; units: string; models: unknown }): string {
  return canonicalJson({
    recordedAt: pin.recordedAt,
    source: pin.source,
    units: pin.units,
    models: pin.models,
  });
}

export function catalogHash(pin: { recordedAt: string; source: string; units: string; models: unknown }): string {
  return `sha256:${createHash("sha256").update(catalogCanonicalPayload(pin)).digest("hex")}`;
}

export function parseCatalogPin(raw: unknown, nowMs = Date.now()): CatalogLoad {
  if (!isRecord(raw)) return { ok: false, reason: "catalog is not an object" };
  if (raw.schema !== NOUS_CATALOG_SCHEMA) {
    return { ok: false, reason: `catalog schema must be ${NOUS_CATALOG_SCHEMA}` };
  }
  if (typeof raw.recordedAt !== "string" || Number.isNaN(Date.parse(raw.recordedAt))) {
    return { ok: false, reason: "catalog recordedAt must be an ISO-8601 timestamp" };
  }
  if (typeof raw.source !== "string" || raw.source.trim().length === 0) {
    return { ok: false, reason: "catalog source is required" };
  }
  if (raw.units !== NOUS_PRICE_UNITS) {
    return { ok: false, reason: `catalog units must be ${NOUS_PRICE_UNITS}` };
  }
  if (typeof raw.hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(raw.hash)) {
    return { ok: false, reason: "catalog hash must be sha256:<64 hex>" };
  }
  if (!isRecord(raw.models)) return { ok: false, reason: "catalog models must be an object" };

  const expected = catalogHash({
    recordedAt: raw.recordedAt,
    source: raw.source.trim(),
    units: NOUS_PRICE_UNITS,
    models: raw.models,
  });
  if (raw.hash !== expected) {
    return { ok: false, reason: "catalog hash does not match recordedAt/source/units/models" };
  }

  const models: NousCatalogPin["models"] = {};
  for (const [id, entry] of Object.entries(raw.models)) {
    const parsed = parsePinModel(id, entry);
    if (!parsed.ok) return parsed;
    models[id] = parsed.model;
  }

  const pin: NousCatalogPin = {
    schema: NOUS_CATALOG_SCHEMA,
    recordedAt: raw.recordedAt,
    source: raw.source.trim(),
    units: NOUS_PRICE_UNITS,
    hash: raw.hash,
    models,
  };
  const recordedAtMs = Date.parse(pin.recordedAt);
  if (recordedAtMs > nowMs + 60_000) {
    return { ok: false, reason: "catalog recordedAt is in the future" };
  }
  if (nowMs - recordedAtMs > NOUS_CATALOG_MAX_AGE_MS) {
    return { ok: false, reason: "catalog is stale (recordedAt older than 30 days)" };
  }
  return { ok: true, pin };
}

function parsePinModel(id: string, entry: unknown): { ok: true; model: Omit<NousModelRecord, "id"> } | { ok: false; reason: string } {
  if (!id.trim()) return { ok: false, reason: "catalog model id is empty" };
  if (!isRecord(entry)) return { ok: false, reason: `catalog model ${id} is not an object` };
  const contextWindow = asPositiveInt(entry.contextWindow);
  const maxTokens = asPositiveInt(entry.maxTokens);
  if (contextWindow === undefined || maxTokens === undefined) {
    return { ok: false, reason: `catalog model ${id} is missing positive contextWindow/maxTokens` };
  }
  if (entry.priceBasis !== "list" && entry.priceBasis !== "upper-bound") {
    return { ok: false, reason: `catalog model ${id} priceBasis must be list or upper-bound` };
  }
  if (entry.billing !== "metered" && entry.billing !== "subscription" && entry.billing !== "subscription_plus_usage") {
    return { ok: false, reason: `catalog model ${id} billing must be metered, subscription, or subscription_plus_usage` };
  }
  if (typeof entry.verified !== "boolean") {
    return { ok: false, reason: `catalog model ${id} verified must be a boolean` };
  }
  const rates = parseRates(entry.cost);
  if (!rates) return { ok: false, reason: `catalog model ${id} cost rates must be finite nonnegative numbers` };
  let cost = rates;
  let priceBasis: NousPriceBasis = entry.priceBasis;
  if (entry.tiers !== undefined) {
    if (!Array.isArray(entry.tiers) || entry.tiers.length === 0) {
      return { ok: false, reason: `catalog model ${id} tiers must be a nonempty array when present` };
    }
    const tierRates: NousCostRates[] = [rates];
    for (const tier of entry.tiers) {
      if (!isRecord(tier)) return { ok: false, reason: `catalog model ${id} has a malformed tier` };
      const parsedTier = parseRates(tier);
      if (!parsedTier) return { ok: false, reason: `catalog model ${id} tier rates must be finite nonnegative numbers` };
      if (asNonnegInt(tier.inputTokensAbove) === undefined) {
        return { ok: false, reason: `catalog model ${id} tier is missing inputTokensAbove` };
      }
      tierRates.push(parsedTier);
    }
    cost = upperBoundRates(tierRates);
    priceBasis = "upper-bound";
  }
  if (!entry.verified && hasZeroRate(cost)) {
    return { ok: false, reason: `catalog model ${id} has unverified zero rates` };
  }
  return {
    ok: true,
    model: {
      contextWindow,
      maxTokens,
      cost,
      priceBasis,
      billing: entry.billing,
      verified: entry.verified,
      ...(typeof entry.name === "string" && entry.name.trim() ? { name: entry.name.trim() } : {}),
    },
  };
}

export function parseModelsResponse(raw: unknown): DiscoveryOutcome {
  if (!isRecord(raw) || !Array.isArray(raw.data)) {
    return { ok: false, error: "invalid", reason: "models response is not an object with a data array" };
  }
  const models: DiscoveredModel[] = [];
  for (const item of raw.data) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) {
      return { ok: false, error: "invalid", reason: "models response contains an entry without an id" };
    }
    const model: DiscoveredModel = { id: item.id.trim() };
    if (typeof item.name === "string" && item.name.trim()) model.name = item.name.trim();
    const topProvider = isRecord(item.top_provider) ? item.top_provider : undefined;
    const contextWindow = asPositiveInt(item.contextWindow ?? item.context_window ?? item.context_length);
    const maxTokens = asPositiveInt(
      item.maxTokens ?? item.max_tokens ?? item.max_output_tokens ?? topProvider?.max_completion_tokens,
    );
    if (contextWindow !== undefined) model.contextWindow = contextWindow;
    if (maxTokens !== undefined) model.maxTokens = maxTokens;
    if (typeof item.units === "string") model.units = item.units;
    if (typeof item.verified === "boolean") model.verified = item.verified;

    const architecture = isRecord(item.architecture) ? item.architecture : undefined;
    if (architecture && "input_modalities" in architecture) {
      const input = parseInputModalities(architecture.input_modalities);
      if (!input) model.capabilityIssue = "unknown input modalities";
      else model.input = input;
    }

    const supported = parseSupportedParameters(item.supported_parameters);
    if (supported) {
      model.reasoning = supported.reasoning;
      model.tools = supported.tools;
    }

    if (isRecord(item.pricing)) {
      const live = parseLivePricing(item.pricing);
      if (!live) {
        model.pricingIssue = "malformed or incomplete live pricing; costly tiers are not dropped and zeros are not guessed";
      } else {
        model.cost = live.cost;
        model.units = NOUS_PRICE_UNITS;
        if (live.tiers.length > 0) model.tiers = live.tiers;
      }
    } else {
      const cost = isRecord(item.cost) ? parseRates(item.cost) : undefined;
      if (cost) model.cost = cost;
      if (Array.isArray(item.tiers)) {
        const tiers: NousCostTier[] = [];
        for (const tier of item.tiers) {
          if (!isRecord(tier)) {
            model.pricingIssue = "malformed assumed-shape tier";
            break;
          }
          const rates = parseRates(tier);
          const above = asNonnegInt(tier.inputTokensAbove ?? tier.input_tokens_above);
          if (!rates || above === undefined) {
            model.pricingIssue = "incomplete assumed-shape tier";
            break;
          }
          tiers.push({ ...rates, inputTokensAbove: above });
        }
        if (!model.pricingIssue && tiers.length > 0) model.tiers = tiers;
        if (model.pricingIssue) {
          delete model.cost;
          delete model.tiers;
        }
      }
    }
    models.push(model);
  }
  return { ok: true, models };
}

export async function fetchNousModels(options: {
  url: string;
  timeoutMs: number;
  authorization?: string;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}): Promise<DiscoveryOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.authorization) headers.Authorization = `Bearer ${options.authorization}`;
    const response = await fetchImpl(options.url, { method: "GET", headers, signal: controller.signal });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: "auth", status: response.status, reason: `HTTP ${response.status}` };
    }
    if (!response.ok) {
      return { ok: false, error: "http", status: response.status, reason: `HTTP ${response.status}` };
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      return { ok: false, error: "invalid", reason: "models response is not JSON" };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      return { ok: false, error: "invalid", reason: "models response is not JSON" };
    }
    const parsed = parseModelsResponse(payload);
    if (!parsed.ok) return parsed;
    return {
      ...parsed,
      provenance: {
        source: options.url,
        fetchedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
        rawSha256: `sha256:${createHash("sha256").update(text).digest("hex")}`,
      },
    };
  } catch (error) {
    if (isAbortError(error)) {
      return { ok: false, error: "timeout", reason: `discovery timed out after ${options.timeoutMs}ms` };
    }
    if (isConnectionRefused(error)) {
      return { ok: false, error: "connection-refused", reason: "connection refused" };
    }
    return { ok: false, error: "http", reason: sanitizeNousText(error instanceof Error ? error.message : "discovery failed") };
  } finally {
    clearTimeout(timer);
  }
}

export function buildModelConfigs(
  discovered: DiscoveredModel[],
  pin: NousCatalogPin | undefined,
  route: NousProviderKind,
): BuildModelsResult {
  const registered: BuiltModel[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const requiredBilling: NousBilling[] = route === "direct"
    ? ["metered"]
    : ["subscription", "subscription_plus_usage"];

  for (const item of discovered) {
    if (item.capabilityIssue) {
      skipped.push({ id: item.id, reason: `excluded: ${item.capabilityIssue}` });
      continue;
    }
    if (item.pricingIssue) {
      skipped.push({ id: item.id, reason: `unpriced, not registered: ${item.pricingIssue}` });
      continue;
    }
    const fromPin = pin?.models[item.id];
    const capacity = {
      contextWindow: fromPin?.contextWindow ?? item.contextWindow,
      maxTokens: fromPin?.maxTokens ?? item.maxTokens,
    };
    if (capacity.contextWindow === undefined || capacity.maxTokens === undefined) {
      skipped.push({ id: item.id, reason: "unpriced, not registered: missing contextWindow or maxTokens" });
      continue;
    }
    let cost: NousCostRates | undefined;
    let priceBasis: NousPriceBasis = "list";
    let verified = false;
    let tiers: NousCostTier[] | undefined;
    if (fromPin) {
      cost = fromPin.cost;
      priceBasis = fromPin.priceBasis;
      verified = fromPin.verified;
    } else {
      const rateSources: NousCostRates[] = [];
      if (item.cost) rateSources.push(item.cost);
      if (item.tiers && item.tiers.length > 0) rateSources.push(...item.tiers);
      if (rateSources.length === 0) {
        skipped.push({ id: item.id, reason: "unpriced, not registered: no numeric cost rates and no catalog pin" });
        continue;
      }
      if (item.units !== NOUS_PRICE_UNITS) {
        skipped.push({ id: item.id, reason: `unpriced, not registered: units must be ${NOUS_PRICE_UNITS}` });
        continue;
      }
      if (item.tiers && item.tiers.length > 0) {
        priceBasis = "upper-bound";
        cost = upperBoundRates(rateSources);
        tiers = item.tiers;
      } else {
        cost = item.cost;
      }
      verified = item.verified === true;
    }
    if (!cost) {
      skipped.push({ id: item.id, reason: "unpriced, not registered" });
      continue;
    }
    if (hasZeroRate(cost) && !verified) {
      skipped.push({ id: item.id, reason: "unpriced, not registered: unverified zero rates" });
      continue;
    }
    const billing: NousBilling = fromPin?.billing ?? (route === "direct" ? "metered" : "subscription");
    if (!requiredBilling.includes(billing)) {
      skipped.push({ id: item.id, reason: `excluded: billing ${billing} is not valid for ${route}` });
      continue;
    }
    const display = route === "proxy"
      ? `${fromPin?.name ?? item.name ?? item.id} (subscription proxy, market ref)`
      : (fromPin?.name ?? item.name ?? item.id);
    registered.push({
      id: item.id,
      name: display,
      contextWindow: capacity.contextWindow,
      maxTokens: capacity.maxTokens,
      cost,
      priceBasis,
      billing,
      verified,
      ...(item.input ? { input: item.input } : {}),
      ...(item.reasoning !== undefined ? { reasoning: item.reasoning } : {}),
      ...(item.tools !== undefined ? { tools: item.tools } : {}),
      ...(tiers ? { tiers } : {}),
    });
  }
  return { registered, skipped };
}

export function guidanceFor(input: {
  parsed: NousEnvParse;
  directHasKey?: boolean;
  directDiscovery?: DiscoveryOutcome;
  proxyDiscovery?: DiscoveryOutcome;
  proxyUrlInvalid?: boolean;
  catalogError?: string;
  skipped?: Array<{ id: string; reason: string }>;
}): GuidanceMessage[] {
  const messages: GuidanceMessage[] = [];
  if (input.parsed.status === "invalid") {
    messages.push({ message: input.parsed.error, level: "error" });
    return messages;
  }
  if (input.parsed.status !== "ready") return messages;
  if (input.parsed.providers.includes("direct") && !input.directHasKey) {
    messages.push({
      message: "Nous direct API is opted in but NOUS_API_KEY is unset. Set NOUS_API_KEY. This slice does not use stored Pi /login credentials.",
      level: "info",
    });
  }
  if (input.proxyUrlInvalid) {
    messages.push({
      message: "KXM_NOUS_PROXY_URL must be a loopback http(s) URL (127.0.0.1, localhost, or ::1). Failing closed.",
      level: "error",
    });
  }
  if (input.proxyDiscovery?.ok === false && input.proxyDiscovery.error === "connection-refused") {
    messages.push({
      message: "Nous proxy is not reachable. Start it with `hermes proxy start` and check `hermes proxy status`. KXM does not install, spawn, or log in for you.",
      level: "info",
    });
  }
  if (input.proxyDiscovery?.ok === false && input.proxyDiscovery.error === "auth") {
    messages.push({
      message: "Nous proxy returned unauthorized. Log in with `hermes login --provider nous`. Newer docs also mention `hermes setup --portal` (not verified on this CLI).",
      level: "info",
    });
  }
  if (input.directDiscovery?.ok === false && input.directDiscovery.error === "timeout") {
    messages.push({ message: `Nous direct discovery ${input.directDiscovery.reason}.`, level: "info" });
  }
  if (input.proxyDiscovery?.ok === false && input.proxyDiscovery.error === "timeout") {
    messages.push({ message: `Nous proxy discovery ${input.proxyDiscovery.reason}.`, level: "info" });
  }
  if (input.catalogError) {
    messages.push({ message: `Nous catalog pin not used: ${input.catalogError}.`, level: "error" });
  }
  if (input.skipped && input.skipped.length > 0) {
    const preview = input.skipped.slice(0, 8).map((item) => `${item.id} (${item.reason})`).join("; ");
    messages.push({
      message: `Skipped ${input.skipped.length} Nous model(s) as unpriced or invalid: ${preview}.`,
      level: "info",
    });
  }
  return messages.map((item) => ({ ...item, message: sanitizeNousText(item.message) }));
}

function parseLivePricing(pricing: Record<string, unknown>): { cost: NousCostRates; tiers: NousCostTier[] } | undefined {
  const cost = parseLiveRates(pricing);
  if (!cost) return undefined;
  if (!("overrides" in pricing) || pricing.overrides === undefined) {
    return { cost, tiers: [] };
  }
  if (!Array.isArray(pricing.overrides)) return undefined;
  const tiers: NousCostTier[] = [];
  for (const override of pricing.overrides) {
    if (!isRecord(override)) return undefined;
    const rates = parseLiveRates(override);
    const above = asNonnegInt(override.min_prompt_tokens ?? override.minPromptTokens);
    if (!rates || above === undefined) return undefined;
    tiers.push({ ...rates, inputTokensAbove: above });
  }
  return { cost, tiers };
}

function parseLiveRates(value: Record<string, unknown>): NousCostRates | undefined {
  const input = perTokenToUsdPerM(value.prompt);
  const output = perTokenToUsdPerM(value.completion);
  const cacheRead = perTokenToUsdPerM(value.input_cache_read ?? value.inputCacheRead);
  const cacheWrite = perTokenToUsdPerM(value.input_cache_write ?? value.inputCacheWrite);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined;
  return { input, output, cacheRead, cacheWrite };
}

function perTokenToUsdPerM(value: unknown): number | undefined {
  let perToken: number | undefined;
  if (typeof value === "number") perToken = value;
  else if (typeof value === "string" && value.trim() !== "") perToken = Number(value);
  if (perToken === undefined || !Number.isFinite(perToken) || perToken < 0) return undefined;
  const usdPerM = Number((perToken * PER_TOKEN_TO_USD_PER_M).toFixed(8));
  if (!Number.isFinite(usdPerM) || usdPerM < 0) return undefined;
  return usdPerM;
}

function parseInputModalities(value: unknown): NousInputModality[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const present = new Set(value.filter((item): item is NousInputModality => item === "text" || item === "image"));
  const mapped = PI_INPUT_ORDER.filter((item) => present.has(item));
  return mapped.length > 0 ? mapped : undefined;
}

function parseSupportedParameters(value: unknown): { reasoning: boolean; tools: boolean } | undefined {
  if (!Array.isArray(value)) return undefined;
  const params = new Set(value.filter((item): item is string => typeof item === "string"));
  return {
    reasoning: params.has("reasoning") || params.has("include_reasoning"),
    tools: params.has("tools") || params.has("tool_choice"),
  };
}

function parseRates(value: unknown): NousCostRates | undefined {
  if (!isRecord(value)) return undefined;
  const input = asFiniteNonneg(value.input);
  const output = asFiniteNonneg(value.output);
  const cacheRead = asFiniteNonneg(value.cacheRead ?? value.cache_read ?? value.cache_input);
  const cacheWrite = asFiniteNonneg(value.cacheWrite ?? value.cache_write);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined;
  return { input, output, cacheRead, cacheWrite };
}

function upperBoundRates(list: NousCostRates[]): NousCostRates {
  return {
    input: Math.max(...list.map((item) => item.input)),
    output: Math.max(...list.map((item) => item.output)),
    cacheRead: Math.max(...list.map((item) => item.cacheRead)),
    cacheWrite: Math.max(...list.map((item) => item.cacheWrite)),
  };
}

function hasZeroRate(cost: NousCostRates): boolean {
  return cost.input === 0 || cost.output === 0 || cost.cacheRead === 0 || cost.cacheWrite === 0;
}

function asFiniteNonneg(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

function asNonnegInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: string }).name;
  return name === "AbortError" || name === "TimeoutError";
}

function isConnectionRefused(error: unknown): boolean {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") codes.push(code);
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string" && /ECONNREFUSED/i.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return codes.includes("ECONNREFUSED");
}
