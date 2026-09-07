/**
 * Legacy Pi registerProvider glue for opt-in Nous routes.
 * No @earendil-works/pi-ai import. Direct auth is NOUS_API_KEY only.
 */

import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  NOUS_DIRECT_BASE_URL,
  NOUS_DIRECT_ID,
  NOUS_PROXY_DEFAULT_BASE_URL,
  NOUS_PROXY_ID,
  NOUS_PROXY_PLACEHOLDER_KEY,
  buildModelConfigs,
  fetchNousModels,
  guidanceFor,
  isLoopbackUrl,
  modelsUrl,
  parseCatalogPin,
  parseNousEnv,
  sanitizeNousText,
  type BuiltModel,
  type CatalogLoad,
  type DiscoveryOutcome,
  type DiscoveryProvenance,
  type GuidanceMessage,
  type NousCatalogPin,
  type NousEnvParse,
  type NousProviderKind,
} from "./nous-provider.ts";

export interface NousProviderRegistration {
  id: string;
  registered: number;
  skipped: number;
  error?: string;
  reason?: string;
  provenance?: DiscoveryProvenance;
}

export interface NousRegistrationReport {
  optedIn: boolean;
  direct: NousProviderRegistration;
  proxy: NousProviderRegistration;
  guidance: GuidanceMessage[];
  registeredProviders: string[];
}

export interface NousRegisterDeps {
  env?: NodeJS.Dict<string>;
  fetch?: typeof fetch;
  readFile?: (path: string) => Promise<string>;
  nowMs?: number;
}

type LegacyPi = Pick<ExtensionAPI, "registerProvider">;

const emptySide = (id: string): NousProviderRegistration => ({ id, registered: 0, skipped: 0 });

export function emptyNousReport(): NousRegistrationReport {
  return {
    optedIn: false,
    direct: emptySide(NOUS_DIRECT_ID),
    proxy: emptySide(NOUS_PROXY_ID),
    guidance: [],
    registeredProviders: [],
  };
}

/**
 * Factory helper: unset stays synchronous; invalid tokens fail closed without
 * fetch; opted-in routes discover then register before Pi lists models.
 */
export function nousFactoryWork(
  pi: ExtensionAPI,
  onReport: (report: NousRegistrationReport) => void,
  deps: NousRegisterDeps = {},
): void | Promise<void> {
  const env = deps.env ?? process.env;
  const parsed = parseNousEnv(env);
  if (parsed.status === "unset") {
    onReport(emptyNousReport());
    return;
  }
  if (parsed.status === "invalid") {
    onReport({
      ...emptyNousReport(),
      optedIn: true,
      guidance: guidanceFor({ parsed }),
    });
    return;
  }
  return registerNousProviders(pi, deps).then(onReport);
}

export async function registerNousProviders(
  pi: LegacyPi,
  deps: NousRegisterDeps = {},
): Promise<NousRegistrationReport> {
  const env = deps.env ?? process.env;
  const parsed = parseNousEnv(env);
  if (parsed.status === "unset") return emptyNousReport();
  if (parsed.status === "invalid") {
    return { ...emptyNousReport(), optedIn: true, guidance: guidanceFor({ parsed }) };
  }

  const report = emptyNousReport();
  report.optedIn = true;
  let pin: NousCatalogPin | undefined;
  let catalogError: string | undefined;
  if (parsed.catalogFile) {
    const loaded = await loadCatalog(parsed.catalogFile, deps);
    if (loaded.ok) pin = loaded.pin;
    else catalogError = loaded.reason;
  }

  const skipped: Array<{ id: string; reason: string }> = [];
  let directDiscovery: DiscoveryOutcome | undefined;
  let proxyDiscovery: DiscoveryOutcome | undefined;
  let proxyUrlInvalid = false;
  const directHasKey = hasDirectKey(env);

  if (parsed.providers.includes("direct")) {
    const result = await registerRoute({
      pi,
      route: "direct",
      env,
      parsed,
      pin,
      hasKey: directHasKey,
      ...(deps.fetch ? { fetchImpl: deps.fetch } : {}),
      ...(deps.nowMs !== undefined ? { nowMs: deps.nowMs } : {}),
    });
    report.direct = result.side;
    directDiscovery = result.discovery;
    skipped.push(...result.skipped);
    if (result.registered) report.registeredProviders.push(NOUS_DIRECT_ID);
  }

  if (parsed.providers.includes("proxy")) {
    if (!isLoopbackUrl(parsed.proxyUrl)) {
      proxyUrlInvalid = true;
      report.proxy = {
        id: NOUS_PROXY_ID,
        registered: 0,
        skipped: 0,
        error: "non-loopback",
        reason: "proxy URL is not loopback http(s)",
      };
    } else {
      const result = await registerRoute({
        pi,
        route: "proxy",
        env,
        parsed,
        pin,
        hasKey: true,
        ...(deps.fetch ? { fetchImpl: deps.fetch } : {}),
        ...(deps.nowMs !== undefined ? { nowMs: deps.nowMs } : {}),
      });
      report.proxy = result.side;
      proxyDiscovery = result.discovery;
      skipped.push(...result.skipped);
      if (result.registered) report.registeredProviders.push(NOUS_PROXY_ID);
    }
  }

  report.guidance = guidanceFor({
    parsed,
    directHasKey,
    proxyUrlInvalid,
    skipped,
    ...(directDiscovery ? { directDiscovery } : {}),
    ...(proxyDiscovery ? { proxyDiscovery } : {}),
    ...(catalogError ? { catalogError } : {}),
  });
  return report;
}

async function registerRoute(input: {
  pi: LegacyPi;
  route: NousProviderKind;
  env: NodeJS.Dict<string>;
  parsed: Extract<NousEnvParse, { status: "ready" }>;
  pin: NousCatalogPin | undefined;
  fetchImpl?: typeof fetch;
  hasKey: boolean;
  nowMs?: number;
}): Promise<{
  side: NousProviderRegistration;
  discovery?: DiscoveryOutcome;
  skipped: Array<{ id: string; reason: string }>;
  registered: boolean;
}> {
  const providerId = input.route === "direct" ? NOUS_DIRECT_ID : NOUS_PROXY_ID;
  const baseUrl = input.route === "direct" ? NOUS_DIRECT_BASE_URL : input.parsed.proxyUrl;
  const side: NousProviderRegistration = { id: providerId, registered: 0, skipped: 0 };

  if (input.route === "direct" && !input.hasKey) {
    registerLegacy(input.pi, providerId, baseUrl, "$NOUS_API_KEY", []);
    return { side, skipped: [], registered: true };
  }

  const authorization = input.route === "direct"
    ? input.env.NOUS_API_KEY
    : NOUS_PROXY_PLACEHOLDER_KEY;

  const discovery = await fetchNousModels({
    url: modelsUrl(baseUrl),
    timeoutMs: input.parsed.timeoutMs,
    ...(authorization ? { authorization } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
  });

  if (!discovery.ok) {
    side.error = discovery.error;
    side.reason = discovery.reason;
    registerLegacy(input.pi, providerId, baseUrl, apiKeyRef(input.route), []);
    return { side, discovery, skipped: [], registered: true };
  }

  if (discovery.provenance) side.provenance = discovery.provenance;
  const built = buildModelConfigs(discovery.models, input.pin, input.route);
  side.registered = built.registered.length;
  side.skipped = built.skipped.length;
  registerLegacy(input.pi, providerId, baseUrl, apiKeyRef(input.route), built.registered);
  return { side, discovery, skipped: built.skipped, registered: true };
}

function apiKeyRef(route: NousProviderKind): string {
  return route === "direct" ? "$NOUS_API_KEY" : NOUS_PROXY_PLACEHOLDER_KEY;
}

function registerLegacy(
  pi: LegacyPi,
  id: string,
  baseUrl: string,
  apiKey: string,
  models: BuiltModel[],
): void {
  if (typeof pi.registerProvider !== "function") {
    throw new Error("Pi registerProvider is unavailable");
  }
  pi.registerProvider(id, {
    name: id === NOUS_DIRECT_ID ? "Nous" : "Nous subscription proxy",
    baseUrl,
    apiKey,
    api: "openai-completions",
    authHeader: true,
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning === true,
      input: model.input && model.input.length > 0 ? model.input : ["text"],
      cost: model.tiers && model.tiers.length > 0
        ? { ...model.cost, tiers: model.tiers }
        : model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  });
}

function hasDirectKey(env: NodeJS.Dict<string>): boolean {
  const key = env.NOUS_API_KEY;
  return typeof key === "string" && key.trim().length > 0;
}

async function loadCatalog(path: string, deps: NousRegisterDeps): Promise<CatalogLoad> {
  try {
    const read = deps.readFile ?? ((filePath: string) => readFile(filePath, "utf8"));
    const text = await read(path);
    return parseCatalogPin(JSON.parse(text) as unknown, deps.nowMs ?? Date.now());
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { ok: false, reason: "catalog file is not valid JSON" };
    }
    return { ok: false, reason: sanitizeNousText(error instanceof Error ? error.message : "catalog file could not be read") };
  }
}

export const NOUS_PROXY_DEFAULT = NOUS_PROXY_DEFAULT_BASE_URL;
