import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getApiKey,
  loginAntigravity,
  parsePastedCallback,
  refreshAntigravityToken,
  TOKEN_URL,
} from "../../plugins/kxm/src/providers/antigravity/auth/index.ts";
import {
  antigravityHeaders,
  clearModelCache,
  clearProjectCache,
  defaultProjectId,
  defaultUserAgent,
  endpointCandidates,
  extractProjectId,
  fetchAvailableModelsCatalog,
  fetchAvailableRuntimeModel,
  formatRequestDiagnostics,
  isUsableRuntimeModelId,
  jsonOrTextError,
  loadCodeAssist,
  mergeAvailableModelsResults,
  parseApiKey,
  resolveProjectId,
  stableProjectId,
} from "../../plugins/kxm/src/providers/antigravity/client/index.ts";
import {
  getLastDiagnostics,
  resetDiagnosticsForTests,
  runWithDiagnostics,
  setLastError,
  setLastMaskedEmail,
  setLastStatus,
  setLastTokenExpiry,
} from "../../plugins/kxm/src/providers/antigravity/diagnostics/index.ts";
import {
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_PERSIST_KEY,
  applyAntigravityCatalog,
  buildAntigravityCatalog,
  clearModelEnumCache,
  discoverAntigravityModels,
  getAntigravityRequestModelId,
  getCatalogRefreshIntervalMs,
  getCurrentAntigravityCatalog,
  getCurrentAntigravityModels,
  getFallbackRuntimeModel,
  getMaxOutputTokens,
  getModelEnum,
  getThinkingConfig,
  humanizePublicId,
  hydrateAntigravityCatalog,
  isSelectableRuntimeModelId,
  refreshAntigravityModels,
  registerDiscoveredModelEnums,
  registerModelEnum,
  resetAntigravityCatalogForTests,
  resolvedCatalog,
  restoreDynamicModelEnums,
  snapshotDynamicModelEnums,
} from "../../plugins/kxm/src/providers/antigravity/models/index.ts";
import {
  calculateCost,
  createAssistantMessageEventStream,
  type Context,
  type Model,
} from "../../plugins/kxm/src/providers/antigravity/pi-compat.ts";
import {
  antigravityProviderRegistered,
  registerAntigravityProvider,
  shouldSkipAntigravityRegistration,
} from "../../plugins/kxm/src/providers/antigravity/register.ts";
import {
  buildRequest,
  convertMessages,
  convertTools,
  fetchWithHeaderDeadline,
  friendlyAntigravityError,
  mapStopReason,
  streamAntigravity,
  streamHeaderTimeoutMs,
  streamResponse,
  streamStallTimeoutMs,
} from "../../plugins/kxm/src/providers/antigravity/stream/index.ts";
import type { ModelInfoRaw } from "../../plugins/kxm/src/providers/antigravity/types/types.ts";
import { fetchAccountUsage, formatModelsList, formatUsageSummary } from "../../plugins/kxm/src/providers/antigravity/usage/index.ts";
import { antigravityFetch, prewarmConnection } from "../../plugins/kxm/src/providers/antigravity/utils/http.ts";
import {
  assertSafeApiBaseUrl,
  maskEmail,
  redactSecrets,
  resolveCallbackHost,
  safeError,
} from "../../plugins/kxm/src/providers/antigravity/utils/security.ts";
import {
  antigravityRequestEnvelope,
  asString,
  clearSessionTrajectoryMap,
  escapeHtml,
  escapeRegExp,
  isRecord,
  nowRequestId,
  resolveSessionTrajectory,
  sanitizeText,
} from "../../plugins/kxm/src/providers/antigravity/utils/util.ts";
import {
  PROVIDER_ID,
  PROVIDER_NAME,
} from "../../plugins/kxm/src/providers/antigravity/index.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "antigravity");
const catalogRaw = JSON.parse(readFileSync(join(fixtureDir, "catalog.json"), "utf8")) as {
  models: Record<string, ModelInfoRaw>;
  defaultAgentModelId?: string;
};
const tokenExchange = JSON.parse(readFileSync(join(fixtureDir, "token-exchange.json"), "utf8")) as {
  access_token: string;
  refresh_token: string;
  expires_in: number;
};
const tokenRefresh = JSON.parse(readFileSync(join(fixtureDir, "token-refresh.json"), "utf8")) as {
  access_token: string;
  expires_in: number;
};
const userinfo = JSON.parse(readFileSync(join(fixtureDir, "userinfo.json"), "utf8")) as { email: string };
const loadCodeAssistBody = JSON.parse(readFileSync(join(fixtureDir, "load-code-assist.json"), "utf8")) as {
  projectId: string;
};
const quotaSummary = JSON.parse(readFileSync(join(fixtureDir, "quota-summary.json"), "utf8"));
const streamBody = readFileSync(join(fixtureDir, "stream-sse.txt"), "utf8");
const streamErrorBody = readFileSync(join(fixtureDir, "stream-error-sse.txt"), "utf8");
const streamMaxTokensBody = readFileSync(join(fixtureDir, "stream-max-tokens-sse.txt"), "utf8");
const streamEmptyBody = readFileSync(join(fixtureDir, "stream-empty-sse.txt"), "utf8");
const streamErrorStopBody = readFileSync(join(fixtureDir, "stream-error-stop-sse.txt"), "utf8");
const streamToolIdBody = readFileSync(join(fixtureDir, "stream-tool-id-sse.txt"), "utf8");

const originalFetch = globalThis.fetch;
type FetchOverride = (url: string, init?: RequestInit) => Promise<Response | undefined> | Response | undefined;
let fetchOverride: FetchOverride | undefined;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status = 200, contentType = "text/plain"): Response {
  return new Response(body, { status, headers: { "Content-Type": contentType } });
}

function defaultGoogleFetch(url: string): Response {
  const parsed = new URL(url);
  if (url.startsWith(TOKEN_URL) || parsed.pathname === "/token") {
    return jsonResponse(tokenRefresh);
  }
  if (parsed.pathname.includes("userinfo")) {
    return jsonResponse(userinfo);
  }
  if (parsed.pathname.includes("loadCodeAssist")) {
    return jsonResponse(loadCodeAssistBody);
  }
  if (parsed.pathname.includes("listCloudAICompanionProjects")) {
    return jsonResponse({ projects: [{ id: "listed-project" }] });
  }
  if (parsed.pathname.includes("fetchAvailableModels")) {
    return jsonResponse(catalogRaw);
  }
  if (parsed.pathname.includes("retrieveUserQuotaSummary")) {
    return jsonResponse(quotaSummary);
  }
  if (parsed.pathname.includes("streamGenerateContent")) {
    return textResponse(streamBody, 200, "text/event-stream");
  }
  return textResponse(`unhandled ${url}`, 500);
}

test.before(() => {
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (fetchOverride) {
      const handled = await fetchOverride(url, init);
      if (handled) return handled;
    }
    if (/googleapis\.com/.test(url)) return defaultGoogleFetch(url);
    return originalFetch(input, init);
  };
});

test.after(() => {
  globalThis.fetch = originalFetch;
});

const ENV_KEYS = [
  "ANTIGRAVITY_PROJECT_ID",
  "ANTIGRAVITY_BASE_URL",
  "ANTIGRAVITY_CATALOG_REFRESH_INTERVAL_MS",
  "ANTIGRAVITY_STREAM_HEADER_TIMEOUT_MS",
  "ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS",
  "ANTIGRAVITY_NO_PREWARM",
  "ANTIGRAVITY_RUNTIME_MODEL",
  "ANTIGRAVITY_REFRESH_INTERVAL_MS",
  "ANTIGRAVITY_DEBUG_DUMP",
  "ANTIGRAVITY_USER_AGENT",
  "ANTIGRAVITY_CALLBACK_HOST",
  "NOAGY_USER_AGENT",
] as const;
const savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined> = {
  ANTIGRAVITY_PROJECT_ID: process.env.ANTIGRAVITY_PROJECT_ID,
  ANTIGRAVITY_BASE_URL: process.env.ANTIGRAVITY_BASE_URL,
  ANTIGRAVITY_CATALOG_REFRESH_INTERVAL_MS: process.env.ANTIGRAVITY_CATALOG_REFRESH_INTERVAL_MS,
  ANTIGRAVITY_STREAM_HEADER_TIMEOUT_MS: process.env.ANTIGRAVITY_STREAM_HEADER_TIMEOUT_MS,
  ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS: process.env.ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS,
  ANTIGRAVITY_NO_PREWARM: process.env.ANTIGRAVITY_NO_PREWARM,
  ANTIGRAVITY_RUNTIME_MODEL: process.env.ANTIGRAVITY_RUNTIME_MODEL,
  ANTIGRAVITY_REFRESH_INTERVAL_MS: process.env.ANTIGRAVITY_REFRESH_INTERVAL_MS,
  ANTIGRAVITY_DEBUG_DUMP: process.env.ANTIGRAVITY_DEBUG_DUMP,
  ANTIGRAVITY_USER_AGENT: process.env.ANTIGRAVITY_USER_AGENT,
  ANTIGRAVITY_CALLBACK_HOST: process.env.ANTIGRAVITY_CALLBACK_HOST,
  NOAGY_USER_AGENT: process.env.NOAGY_USER_AGENT,
};

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

test.afterEach(() => {
  fetchOverride = undefined;
  resetAntigravityCatalogForTests();
  resetDiagnosticsForTests();
  clearModelCache();
  clearProjectCache();
  clearModelEnumCache();
  clearSessionTrajectoryMap();
  restoreEnv();
});

function geminiModel(id = "gemini-3.8-flash"): Model<"antigravity-api"> {
  return {
    id,
    name: id,
    api: "antigravity-api",
    provider: "antigravity",
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  };
}

function apiKeyJson(projectId = "proj-fixture"): string {
  return JSON.stringify({ token: "ya29.recorded-access", projectId });
}

async function collectStream(stream: ReturnType<typeof createAssistantMessageEventStream>) {
  const events = [];
  for await (const event of stream) events.push(event);
  return { events, message: await stream.result() };
}

test("parsePastedCallback accepts full URLs, query strings, and rejects bad pastes", () => {
  const state = "state-one";
  assert.deepEqual(
    parsePastedCallback(`http://localhost:51121/oauth-callback?code=abc&state=${state}`, state),
    { code: "abc", state },
  );
  assert.deepEqual(parsePastedCallback(`code=xyz&state=${state}`, state), { code: "xyz", state });
  assert.deepEqual(parsePastedCallback(`?code=xyz&state=${state}`, state), { code: "xyz", state });
  assert.throws(() => parsePastedCallback("   ", state), /No callback pasted/);
  assert.throws(
    () => parsePastedCallback(`http://localhost:51121/oauth-callback?error=access_denied&state=${state}`, state),
    /OAuth error from browser/,
  );
  assert.throws(() => parsePastedCallback("http://localhost:51121/oauth-callback?code=abc", state), /missing 'code' or 'state'/);
  assert.throws(
    () => parsePastedCallback(`http://localhost:51121/oauth-callback?code=abc&state=other`, state),
    /State mismatch/,
  );
});

test("refreshAntigravityToken exchanges the recorded refresh fixture and preserves project id", async () => {
  fetchOverride = async (url) => {
    if (url.startsWith(TOKEN_URL)) return jsonResponse(tokenRefresh);
    return undefined;
  };
  const refreshed = await refreshAntigravityToken({
    refresh: "1/0gK8abcdefghijklmnopqrstuvwxyzABCD",
    access: "ya29.old",
    expires: 1,
    projectId: "keep-me",
    email: "tester@example.com",
  });
  assert.equal(refreshed.access, tokenRefresh.access_token);
  assert.equal(refreshed.refresh, "1/0gK8abcdefghijklmnopqrstuvwxyzABCD");
  assert.equal(refreshed.projectId, "keep-me");
  assert.ok(refreshed.expires > Date.now());
  const key = JSON.parse(getApiKey(refreshed)) as { token: string; projectId: string };
  assert.equal(key.token, tokenRefresh.access_token);
  assert.equal(key.projectId, "keep-me");
});

test("refreshAntigravityToken discovers project when credentials omit it and redacts failed token bodies", async () => {
  fetchOverride = async (url) => {
    if (url.startsWith(TOKEN_URL)) {
      return jsonResponse({ access_token: "ya29.fresh", expires_in: 60, refresh_token: "1//0eA7newrefresh" });
    }
    if (url.includes("loadCodeAssist")) return jsonResponse({ cloudaicompanionProject: { id: "discovered-from-assist" } });
    return undefined;
  };
  const refreshed = await refreshAntigravityToken({
    refresh: "1/0gK8abcdefghijklmnopqrstuvwxyzABCD",
    access: "ya29.old",
    expires: 1,
  });
  assert.equal(refreshed.projectId, "discovered-from-assist");
  assert.equal(refreshed.refresh, "1//0eA7newrefresh");

  fetchOverride = async (url) => {
    if (url.startsWith(TOKEN_URL)) {
      return textResponse(JSON.stringify({ error: "invalid_grant", error_description: "ya29.secret-should-redact" }), 400);
    }
    return undefined;
  };
  await assert.rejects(
    () => refreshAntigravityToken({ refresh: "1/0gK8abcdefghijklmnopqrstuvwxyzABCD", access: "x", expires: 1 }),
    /token refresh failed/,
  );
});

test("loginAntigravity completes via local callback server with recorded token exchange", async () => {
  fetchOverride = async (url) => {
    if (url.startsWith(TOKEN_URL)) return jsonResponse(tokenExchange);
    if (url.includes("userinfo")) return jsonResponse(userinfo);
    if (url.includes("loadCodeAssist")) return jsonResponse(loadCodeAssistBody);
    return undefined;
  };
  let authUrl = "";
  const login = loginAntigravity({
    onAuth(info) {
      authUrl = info.url;
    },
  });
  const started = Date.now();
  let callbackHostUp = false;
  while (Date.now() - started < 3000) {
    try {
      const probe = await originalFetch("http://127.0.0.1:51121/not-the-callback");
      assert.equal(probe.status, 404);
      const disallowed = await originalFetch("http://127.0.0.1:51121/oauth-callback", { method: "POST" });
      assert.equal(disallowed.status, 405);
      callbackHostUp = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.equal(callbackHostUp, true);
  const state = new URL(authUrl).searchParams.get("state");
  assert.ok(state);
  const callback = await originalFetch(
    `http://127.0.0.1:51121/oauth-callback?code=recorded-code&state=${state}`,
  );
  assert.equal(callback.status, 200);
  const creds = await login;
  assert.equal(creds.access, tokenExchange.access_token);
  assert.equal(creds.refresh, tokenExchange.refresh_token);
  assert.equal(creds.email, userinfo.email);
  assert.equal(creds.projectId, loadCodeAssistBody.projectId);
});

test("loginAntigravity paste path retries invalid callbacks then succeeds", async () => {
  fetchOverride = async (url) => {
    if (url.startsWith(TOKEN_URL)) return jsonResponse(tokenExchange);
    if (url.includes("userinfo")) return jsonResponse({ email: "paste@example.com" });
    if (url.includes("loadCodeAssist")) return jsonResponse({ projectId: "paste-project" });
    return undefined;
  };
  let authUrl = "";
  let prompts = 0;
  const creds = await loginAntigravity({
    onAuth(info) {
      authUrl = info.url;
    },
    async onPrompt() {
      prompts += 1;
      const state = new URL(authUrl).searchParams.get("state") ?? "";
      if (prompts === 1) return "not-a-callback";
      return `http://localhost:51121/oauth-callback?code=pasted&state=${state}`;
    },
  });
  assert.ok(prompts >= 2);
  assert.equal(creds.projectId, "paste-project");
  assert.equal(creds.email, "paste@example.com");
});

test("catalog discovery hydrates cache, refreshes from fixtures, and keeps last-known-good on failure", async () => {
  const catalog = buildAntigravityCatalog(catalogRaw.models, {
    models: ANTIGRAVITY_MODELS,
    routing: getCurrentAntigravityCatalog().routing,
  });
  applyAntigravityCatalog(catalog);
  registerDiscoveredModelEnums(catalogRaw.models);
  const snapshot = snapshotDynamicModelEnums();
  assert.equal(getModelEnum("gemini-3.8-flash-low"), "MODEL_PLACEHOLDER_M320");

  const checkedAt = hydrateAntigravityCatalog({
    [ANTIGRAVITY_PERSIST_KEY]: {
      catalog,
      checkedAt: Date.now(),
      modelEnums: snapshot,
    },
  });
  assert.ok(checkedAt > 0);
  restoreDynamicModelEnums({ "custom-wire": "MODEL_CUSTOM" });
  registerModelEnum("gemini-custom", "MODEL_CUSTOM");
  assert.equal(getModelEnum("gemini-custom"), "MODEL_CUSTOM");

  process.env.ANTIGRAVITY_CATALOG_REFRESH_INTERVAL_MS = "0";
  assert.equal(getCatalogRefreshIntervalMs(), 0);

  const discovered = await discoverAntigravityModels(apiKeyJson());
  assert.ok(discovered.models.some((model) => model.id === "gemini-3.8-flash"));

  const published: unknown[] = [];
  const models = await refreshAntigravityModels({
    allowNetwork: true,
    force: true,
    signal: new AbortController().signal,
    credential: { type: "oauth", access: "ya29.recorded-access", refresh: "r", expires: Date.now() + 60_000, projectId: "proj-fixture" },
    stored: {},
    async publish(publication) {
      published.push(publication);
      return true;
    },
  });
  assert.ok(models.length > 0);
  assert.equal(published.length, 1);

  const offline = await refreshAntigravityModels({
    allowNetwork: false,
    signal: new AbortController().signal,
    stored: {},
    async publish() {
      return true;
    },
  });
  assert.ok(offline.length > 0);

  fetchOverride = async () => textResponse("nope", 500);
  const cached = await refreshAntigravityModels({
    allowNetwork: true,
    signal: new AbortController().signal,
    credential: { type: "api_key", key: apiKeyJson() },
    stored: {
      [ANTIGRAVITY_PERSIST_KEY]: { catalog, checkedAt: Date.now(), modelEnums: snapshot },
    },
    async publish() {
      return true;
    },
  });
  assert.ok(cached.length > 0);
  await assert.rejects(
    () =>
      refreshAntigravityModels({
        allowNetwork: true,
        force: true,
        signal: new AbortController().signal,
        credential: { type: "api_key", key: apiKeyJson() },
        stored: {},
        async publish() {
          return true;
        },
      }),
    /fetchAvailableModels failed|no endpoint/,
  );
});

test("buildAntigravityCatalog synthesizes unknown families and drops hidden/image ids", () => {
  assert.equal(isSelectableRuntimeModelId("chat_hidden"), false);
  assert.equal(isSelectableRuntimeModelId("gemini-3-pro-image"), false);
  assert.equal(isSelectableRuntimeModelId("MODEL_PLACEHOLDER_M1"), false);
  assert.equal(humanizePublicId("gpt-oss-120b"), "GPT-OSS 120B");
  assert.equal(humanizePublicId("gemini-9-1-flash"), "Gemini 9.1 Flash");
  const synthesized = buildAntigravityCatalog(
    {
      "gemini-9.9-flash-low": { displayName: "Gemini 9.9 Flash (Low)", supportsThinking: true, supportsImages: true },
      "gemini-9.9-flash-high": { displayName: "Gemini 9.9 Flash (High)", supportsThinking: true, supportsImages: true },
      "claude-haiku-4": { label: "Claude Haiku 4", supportsThinking: false, supportsImages: false },
    },
    { models: ANTIGRAVITY_MODELS, routing: getCurrentAntigravityCatalog().routing },
  );
  assert.ok(synthesized.models.some((model) => model.id === "gemini-9.9-flash"));
  assert.ok(synthesized.models.some((model) => model.id === "claude-haiku-4"));
  assert.equal(resolvedCatalog({ models: [], routing: {} }, getCurrentAntigravityCatalog()).models.length > 0, true);
});

test("model routing, thinking budgets, and max tokens follow advertised families", () => {
  assert.equal(getAntigravityRequestModelId("gemini-3.8-flash", "medium"), "gemini-3.8-flash-medium");
  assert.equal(getAntigravityRequestModelId("gemini-3.8-flash", "xhigh"), "gemini-3.8-flash-high");
  assert.equal(getAntigravityRequestModelId("gemini-3.8-flash", "off"), "gemini-3.8-flash-low");
  assert.equal(getFallbackRuntimeModel("gemini-3.8-flash-high"), "gemini-3.7-flash-high");
  assert.equal(getFallbackRuntimeModel("gemini-3.7-flash"), "gemini-3.6-flash-low");
  assert.equal(getMaxOutputTokens("unknown", "claude-sonnet-4-6"), 64000);
  assert.equal(getMaxOutputTokens("unknown", "gpt-oss-120b-medium"), 32768);
  assert.equal(getMaxOutputTokens("unknown"), 8192);
  assert.deepEqual(getThinkingConfig("claude-sonnet-4-6", "high"), { includeThoughts: true, thinkingBudget: 1024 });
  assert.deepEqual(getThinkingConfig("gpt-oss-120b", "off"), { includeThoughts: false, thinkingBudget: 0 });
  assert.equal(getThinkingConfig("gemini-3.5-flash", "high")?.thinkingBudget, 10_000);
  assert.equal(getThinkingConfig("gemini-pro-agent", "low")?.thinkingBudget, 1_001);
  assert.equal(getThinkingConfig("gemini-3.8-flash", "medium")?.thinkingBudget, 4_000);
});

test("client helpers parse credentials, merge catalogs, and cache discovery", async () => {
  assert.equal(parseApiKey(apiKeyJson()).projectId, "proj-fixture");
  assert.throws(() => parseApiKey(undefined), /No Antigravity OAuth credentials/);
  assert.throws(() => parseApiKey("{"), /Invalid Antigravity credentials/);
  assert.equal(extractProjectId({ backendProjectId: "b1" }), "b1");
  assert.equal(extractProjectId({ project: { id: "nested" } }), "nested");
  assert.equal(extractProjectId({ projects: ["p-array"] }), "p-array");
  assert.equal(jsonOrTextError('{"error":{"message":"nope"}}'), "nope");
  assert.equal(jsonOrTextError("plain"), "plain");
  assert.match(defaultUserAgent(), /antigravity\/cli/);
  assert.equal(antigravityHeaders("tok").Authorization, "Bearer tok");
  assert.equal(stableProjectId("seed").length, 36);
  assert.equal(resolveProjectId({ token: "t", credentialProjectId: "from-cred" }), "from-cred");
  process.env.ANTIGRAVITY_PROJECT_ID = "env-project";
  assert.equal(defaultProjectId("ignored"), "env-project");
  process.env.ANTIGRAVITY_BASE_URL = "https://cloudcode-pa.googleapis.com/v1/";
  assert.deepEqual(endpointCandidates(), ["https://cloudcode-pa.googleapis.com/v1"]);

  const merged = mergeAvailableModelsResults([
    undefined,
    { endpoint: "https://daily-cloudcode-pa.googleapis.com", status: 200, data: catalogRaw },
  ]);
  assert.ok(merged.data.models?.["gemini-3.8-flash-low"]);
  assert.throws(() => mergeAvailableModelsResults([undefined]), /no endpoint available/);

  const first = await loadCodeAssist("token-cache");
  const second = await loadCodeAssist("token-cache");
  assert.equal(first, second);
  const runtime = await fetchAvailableRuntimeModel("token-cache", "proj-fixture", "gemini-3.8-flash-low");
  assert.equal(runtime?.id, "gemini-3.8-flash-low");
  const catalog = await fetchAvailableModelsCatalog("token-cache", "proj-fixture");
  assert.ok(catalog.data.models);
  assert.match(formatRequestDiagnostics({ projectId: "p", runtimeModel: "m" }), /project=p/);
});

test("convertMessages and convertTools cover signatures, images, skills, and schema refs", () => {
  const model = geminiModel();
  const validSig = "YWJjZA==";
  const context: Context = {
    systemPrompt: "sys",
    tools: [
      {
        name: "ok",
        description: "ok",
        parameters: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            path: { $ref: "#/$defs/path" },
          },
          $defs: { path: { type: "string" } },
        },
      },
      {
        name: "broken",
        description: "broken",
        parameters: { type: "object", properties: { x: { $ref: "#/missing" } } },
      },
    ],
    messages: [
      {
        role: "user",
        timestamp: 1,
        content: [
          { type: "text", text: "hello <skill name=\"s\">body</skill>" },
          { type: "image", data: "data:image/png;base64,abc", mimeType: "image/png" },
        ],
      },
      {
        role: "assistant",
        api: "antigravity-api",
        provider: "antigravity",
        model: model.id,
        stopReason: "toolUse",
        timestamp: 2,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        content: [
          { type: "text", text: "call", textSignature: validSig },
          { type: "thinking", thinking: "plan", thinkingSignature: validSig },
          {
            type: "toolCall",
            id: "call/1",
            name: "ok",
            arguments: { path: "a.ts" },
            thoughtSignature: validSig,
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call/1",
        toolName: "ok",
        isError: false,
        timestamp: 3,
        content: [
          { type: "text", text: "file" },
          { type: "image", data: "abc123", mimeType: "image/jpeg" },
        ],
      },
      {
        role: "assistant",
        api: "other",
        provider: "other",
        model: "other",
        stopReason: "aborted",
        timestamp: 4,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        content: [{ type: "text", text: "ignore" }],
      },
    ],
  };
  const turns = convertMessages(model, context, "gemini-3.8-flash-low");
  assert.ok(turns.some((turn) => turn.role === "user"));
  assert.ok(turns.some((turn) => turn.parts.some((part) => "functionCall" in part)));
  const tools = convertTools(context.tools);
  assert.ok(tools?.[0]?.functionDeclarations.some((decl) => decl.name === "ok"));
  assert.equal(tools?.[0]?.functionDeclarations.some((decl) => decl.name === "broken"), false);
  const claudeTools = convertTools(context.tools, true);
  assert.ok(claudeTools?.[0]?.functionDeclarations[0]?.parameters);

  const unsigned: Context = {
    messages: [
      {
        role: "assistant",
        api: "antigravity-api",
        provider: "antigravity",
        model: model.id,
        stopReason: "toolUse",
        timestamp: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        content: [{ type: "toolCall", id: "x", name: "ok", arguments: { n: 1 } }],
      },
      {
        role: "toolResult",
        toolCallId: "x",
        toolName: "ok",
        isError: true,
        timestamp: 2,
        content: [{ type: "text", text: "fail" }],
      },
    ],
  };
  const dropped = convertMessages(model, unsigned, "gemini-3.8-flash-high");
  assert.ok(
    dropped.some((turn) =>
      turn.parts.some((part) => "text" in part && String(part.text).includes("Observation")),
    ),
  );

  const request = buildRequest(model, context, "proj-fixture", { temperature: 0.2, toolChoice: "none", reasoning: "low" }, "gemini-3.8-flash-low");
  assert.equal(request.project, "proj-fixture");
  assert.equal(request.model, "gemini-3.8-flash-low");
  assert.equal(request.request.toolConfig?.functionCallingConfig.mode, "NONE");
  const claudeReq = buildRequest(
    { ...geminiModel("claude-sonnet-4-6"), id: "claude-sonnet-4-6" },
    { messages: [{ role: "user", timestamp: 1, content: "hi" }], tools: context.tools ?? [] },
    "proj-fixture",
    { reasoning: "high" },
    "claude-sonnet-4-6",
  );
  assert.ok(claudeReq.request.tools);
});

test("streaming adapter handles MAX_TOKENS, recorded errors, abort, and empty bodies", async () => {
  const encoder = new TextEncoder();
  const asStream = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });
  const output = {
    role: "assistant" as const,
    content: [],
    api: "antigravity-api",
    provider: "antigravity",
    model: "gemini-3.8-flash",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop" as const,
    timestamp: 0,
  };
  const maxTokens = createAssistantMessageEventStream();
  await streamResponse(new Response(asStream(streamMaxTokensBody)), maxTokens, output, geminiModel());
  maxTokens.end(output);
  assert.equal(output.stopReason, "length");
  assert.ok(output.usage.output > 0);

  const errorStream = createAssistantMessageEventStream();
  const errorOutput = { ...output, content: [], usage: { ...output.usage, cost: { ...output.usage.cost } } };
  await assert.rejects(
    () => streamResponse(new Response(asStream(streamErrorBody)), errorStream, errorOutput),
    /recorded stream failure/,
  );
  await assert.rejects(() => streamResponse(new Response(null), createAssistantMessageEventStream(), errorOutput), /No response body/);

  assert.equal(mapStopReason("STOP"), "stop");
  assert.equal(mapStopReason("MAX_TOKENS"), "length");
  assert.equal(mapStopReason("OTHER"), "error");
  assert.match(friendlyAntigravityError(401, "nope"), /authentication failed/);
  assert.match(friendlyAntigravityError(400, "API_KEY_INVALID"), /login expired/);
  assert.match(friendlyAntigravityError(400, "Invalid JSON payload"), /request format was rejected/);
  assert.match(friendlyAntigravityError(400, "Request contains an invalid argument"), /rejected this request/);
  assert.match(friendlyAntigravityError(403, "permission denied"), /access was denied/);
  assert.match(friendlyAntigravityError(404, "Requested entity was not found"), /not available right now/);
  assert.match(friendlyAntigravityError(429, "Individual quota reached. Resets in 5m"), /Quota reached/);
  assert.match(friendlyAntigravityError(503, "No capacity available"), /no capacity/);
  assert.match(friendlyAntigravityError(500, "x"), /internal server error/);
});

test("streamAntigravity uses recorded SSE and surfaces abort plus 404 fallback", async () => {
  const context: Context = { messages: [{ role: "user", timestamp: 1, content: "hi" }] };
  const happy = await collectStream(
    streamAntigravity(geminiModel(), context, { apiKey: apiKeyJson(), reasoning: "low" }),
  );
  assert.equal(happy.message.stopReason, "toolUse");
  assert.match(happy.message.content.map((block) => ("text" in block ? block.text : "")).join(""), /Hello world/);

  const aborted = new AbortController();
  aborted.abort();
  const cancelled = await collectStream(
    streamAntigravity(geminiModel(), context, { apiKey: apiKeyJson(), signal: aborted.signal }),
  );
  assert.equal(cancelled.message.stopReason, "aborted");

  let streamCalls = 0;
  fetchOverride = async (url) => {
    if (url.includes("streamGenerateContent")) {
      streamCalls += 1;
      if (streamCalls === 1) return textResponse("Requested entity was not found", 404);
      return textResponse(streamBody, 200, "text/event-stream");
    }
    return undefined;
  };
  const fallback = await collectStream(
    streamAntigravity(geminiModel(), context, { apiKey: apiKeyJson(), reasoning: "high" }),
  );
  assert.equal(fallback.message.stopReason, "toolUse");
  assert.ok(streamCalls >= 2);
});

test("fetchWithHeaderDeadline honors caller abort and timeout-disabled passthrough", async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () =>
      fetchWithHeaderDeadline(
        "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
        { method: "POST" },
        ac.signal,
        50,
        0,
        async (_url, init) => {
          if (init?.signal?.aborted) throw new Error("aborted");
          return textResponse("ok");
        },
      ),
    /aborted/,
  );
  const passthrough = await fetchWithHeaderDeadline(
    "https://example.invalid/skip",
    {},
    undefined,
    0,
    0,
    async () => textResponse("ok"),
  );
  assert.equal(await passthrough.text(), "ok");
  process.env.ANTIGRAVITY_STREAM_HEADER_TIMEOUT_MS = "0";
  process.env.ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS = "abc";
  assert.equal(streamHeaderTimeoutMs(), 0);
  assert.equal(streamStallTimeoutMs(), 120_000);
});

test("account usage formatting and fixture fetch cover quota groups and models", async () => {
  const usage = await fetchAccountUsage(apiKeyJson());
  assert.equal(usage.projectId, loadCodeAssistBody.projectId);
  assert.match(formatUsageSummary(usage), /Gemini/);
  assert.match(formatUsageSummary(usage), /Daily/);
  assert.match(formatModelsList(usage), /gemini-3.8-flash-low/);
  assert.match(formatModelsList({ ...usage, models: [] }), /No models returned/);
  assert.match(
    formatUsageSummary({ ...usage, groups: [], quotaSummaryError: "SUBSCRIPTION_REQUIRED #3501" }),
    /paid subscription/,
  );
  assert.match(formatUsageSummary({ ...usage, groups: [], quotaSummaryError: "" }), /No quota groups|Aggregate quota/);
  const emptyGroups = { ...usage, groups: [] as typeof usage.groups };
  delete emptyGroups.quotaSummaryError;
  assert.match(formatUsageSummary(emptyGroups), /No quota groups/);
});

test("security, envelope, diagnostics, and registration probes", async () => {
  assert.equal(PROVIDER_ID, "antigravity");
  assert.equal(PROVIDER_NAME, "Antigravity");
  assert.equal(resolveCallbackHost("localhost"), "127.0.0.1");
  assert.throws(() => resolveCallbackHost("evil.example"), /Unsafe ANTIGRAVITY_CALLBACK_HOST/);
  assert.equal(assertSafeApiBaseUrl("https://cloudcode-pa.googleapis.com/"), "https://cloudcode-pa.googleapis.com");
  assert.throws(() => assertSafeApiBaseUrl("http://cloudcode-pa.googleapis.com"), /must use https/);
  assert.throws(() => assertSafeApiBaseUrl("https://evil.example"), /not allowed/);
  assert.throws(() => assertSafeApiBaseUrl("https://user:pass@cloudcode-pa.googleapis.com"), /must not include credentials/);
  assert.equal(maskEmail("ab@example.com"), "a***@example.com");
  assert.equal(maskEmail("abc@example.com"), "a***c@example.com");
  assert.equal(maskEmail("not-an-email"), "[redacted-email]");
  assert.match(safeError(new Error("Bearer ya29.aaaa")), /redacted/);
  assert.equal(escapeHtml("<x>"), "&lt;x&gt;");
  assert.equal(sanitizeText("ok\uD800"), "ok\uFFFD");
  assert.equal(asString(""), undefined);
  assert.equal(isRecord([]), false);
  const traj = resolveSessionTrajectory({ messages: [{ role: "user", timestamp: 1, content: "seed" }] });
  assert.equal(resolveSessionTrajectory({ messages: [{ role: "user", timestamp: 1, content: "seed" }] }).conversationId, traj.conversationId);
  const envelope = antigravityRequestEnvelope("gemini-3.8-flash-low", { isClaude: false, step: 2 });
  assert.match(envelope.requestId, /^agent\//);
  await runWithDiagnostics(async () => {
    setLastStatus(200);
    setLastError("ya29.should-redact");
  });
  assert.equal(getLastDiagnostics().status, 200);
  assert.doesNotMatch(getLastDiagnostics().error ?? "", /ya29\./);
  prewarmConnection("https://daily-cloudcode-pa.googleapis.com");
  assert.equal(typeof antigravityFetch, "function");

  const missing = registerAntigravityProvider({} as ExtensionAPI);
  assert.deepEqual(missing, { registered: false, conflict: false });
  const throwingCommands = {
    getCommands() {
      throw new Error("unavailable");
    },
  };
  assert.equal(shouldSkipAntigravityRegistration(throwingCommands), false);
  const viaRegistry = {
    modelRegistry: {
      getProvider(id: string) {
        return id === "antigravity" ? { name: "via-registry" } : undefined;
      },
    },
  };
  assert.equal(antigravityProviderRegistered(viaRegistry), true);

  const usage = { input: 100, output: 10, cacheRead: 20, cacheWrite: 5, cacheWrite1h: 1, totalTokens: 135, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  calculateCost({ cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5, tiers: [{ inputTokensAbove: 50, input: 2, output: 4, cacheRead: 0.2, cacheWrite: 1 }] } }, usage);
  assert.ok(usage.cost.total > 0);
  calculateCost({}, usage);
  assert.equal(usage.cost.total, 0);

  const stream = createAssistantMessageEventStream();
  const waiter = (async () => {
    const seen = [];
    for await (const event of stream) seen.push(event.type);
    return seen;
  })();
  stream.push({ type: "start", partial: geminiModel() as never });
  stream.push({ type: "done", reason: "stop", message: {
    role: "assistant",
    content: [],
    api: "antigravity-api",
    provider: "antigravity",
    model: "gemini-3.8-flash",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 0,
  } });
  stream.end();
  assert.ok((await waiter).includes("done"));
});

test("loginAntigravity aborts while waiting and refuses a token response without refresh", async () => {
  const ac = new AbortController();
  const cancelled = loginAntigravity({
    onAuth() {},
    async onPrompt() {
      ac.abort();
      throw new Error("prompt closed");
    },
    signal: ac.signal,
  });
  await assert.rejects(cancelled, /cancelled|Login|prompt closed/);

  let authUrl = "";
  fetchOverride = async (url) => {
    if (url.startsWith(TOKEN_URL)) return jsonResponse({ access_token: "ya29.norefresh", expires_in: 60 });
    return undefined;
  };
  const missingRefresh = loginAntigravity({
    onAuth(info) {
      authUrl = info.url;
    },
    async onPrompt() {
      const nextState = new URL(authUrl).searchParams.get("state") ?? "";
      return `http://localhost:51121/oauth-callback?code=x&state=${nextState}`;
    },
  });
  await assert.rejects(missingRefresh, /No refresh token/);
});

test("catalog grouping merges agent aliases, tiered ids, and remaining families", () => {
  const catalog = buildAntigravityCatalog(
    {
      "gemini-9.9-flash-extra-low": { displayName: "Gemini 9.9 Flash (Extra Low)", supportsThinking: true },
      "gemini-9.9-flash-tiered": { displayName: "Gemini 9.9 Flash", supportsThinking: true },
      "gemini-9.9-flash-agent": { displayName: "Gemini 9.9 Flash (High)", supportsThinking: true },
      "gemini-9.9-pro-low": { displayName: "Gemini 9.9 Pro (Low)", supportsThinking: true, supportsImages: true },
      "gpt-oss-120b-medium": { displayName: "GPT-OSS 120B (Medium)", supportsImages: false },
      "claude-opus-4-9": { displayName: "Claude Opus 4.9 (Thinking)", supportsThinking: true },
    },
    { models: ANTIGRAVITY_MODELS, routing: getCurrentAntigravityCatalog().routing },
  );
  assert.ok(catalog.models.some((model) => model.id === "gemini-9.9-flash"));
  assert.ok(catalog.models.some((model) => model.id === "gemini-9.9-pro"));
  assert.ok(catalog.models.some((model) => model.id === "gpt-oss-120b"));
  assert.ok(catalog.models.some((model) => model.id === "claude-opus-4-9"));
  assert.equal(getFallbackRuntimeModel("gemini-3.8-flash"), "gemini-3.7-flash-low");
  assert.equal(getFallbackRuntimeModel("gemini-3.7-flash-tiered", "medium"), "gemini-3.6-flash-medium");
  assert.equal(getFallbackRuntimeModel("gemini-3.7-flash-high"), "gemini-3.6-flash-high");
  assert.equal(getFallbackRuntimeModel("claude-sonnet-4-6"), undefined);
  assert.equal(getMaxOutputTokens("unknown", "gemini-3.1-pro-low"), 65535);
  assert.equal(getMaxOutputTokens("unknown", "gemini-3.8-flash-low"), 65536);
  assert.equal(getThinkingConfig("unknown-model", "high"), undefined);
  process.env.ANTIGRAVITY_REFRESH_INTERVAL_MS = "1500";
  assert.equal(getCatalogRefreshIntervalMs(), 1500);
  delete process.env.ANTIGRAVITY_REFRESH_INTERVAL_MS;
  process.env.ANTIGRAVITY_CATALOG_REFRESH_INTERVAL_MS = "nope";
  assert.equal(getCatalogRefreshIntervalMs() > 0, true);
});

test("client discovery falls back across endpoints, labels, and empty assist payloads", async () => {
  fetchOverride = async (url) => {
    if (url.includes("loadCodeAssist")) return jsonResponse({ currentTier: { name: "Free" } });
    if (url.includes("listCloudAICompanionProjects")) {
      return jsonResponse({ cloudaicompanionProjects: [{ projectId: "listed-companion" }] });
    }
    if (url.includes("fetchAvailableModels")) {
      if (url.includes("sandbox")) return textResponse("nope", 500);
      return jsonResponse({
        models: {
          "gemini-3.8-flash-high": {
            displayName: "Gemini 3.8 Flash (High)",
            model: "MODEL_PLACEHOLDER_M318",
            modelExperiments: ["exp1"],
            apiProvider: "google",
          },
        },
        defaultAgentModel: "gemini-3.8-flash-high",
      });
    }
    return undefined;
  };
  const project = await loadCodeAssist("token-list-fallback");
  assert.equal(project, "listed-companion");
  const byLabel = await fetchAvailableRuntimeModel("token-list-fallback", "listed-companion", "gemini-3.8-flash-high");
  assert.equal(byLabel?.id, "gemini-3.8-flash-high");
  const catalog = await fetchAvailableModelsCatalog("token-list-fallback", "listed-companion");
  assert.equal(catalog.data.defaultAgentModel, "gemini-3.8-flash-high");
});

test("convertTools and convertMessages cover remaining schema and protocol branches", () => {
  const tools = convertTools([
    { name: "scalar", description: "s", parameters: "not-object" },
    {
      name: "union",
      description: "u",
      parameters: {
        type: ["string", "null"],
        properties: {
          items: { type: "array", items: { type: "string" } },
          choice: { enum: [1, 2] },
          extra: { format: "email", type: "string" },
        },
        anyOf: [{ type: "object" }],
      },
    },
    {
      name: "cycle",
      description: "c",
      parameters: { $ref: "#/$defs/loop", $defs: { loop: { $ref: "#/$defs/loop" } } },
    },
  ], true);
  assert.ok(tools?.[0]?.functionDeclarations.some((decl) => decl.name === "union"));
  assert.equal(tools?.[0]?.functionDeclarations.some((decl) => decl.name === "cycle"), false);

  const claude = geminiModel("claude-sonnet-4-6");
  const context: Context = {
    messages: [
      {
        role: "assistant",
        api: "antigravity-api",
        provider: "antigravity",
        model: claude.id,
        stopReason: "toolUse",
        timestamp: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        content: [{ type: "toolCall", id: "id/with spaces", name: "ok", arguments: { n: 1 } }],
      },
      {
        role: "toolResult",
        toolCallId: "id/with spaces",
        toolName: "ok",
        isError: false,
        timestamp: 2,
        content: [{ type: "text", text: "" }],
      },
    ],
    tools: [{ name: "ok", description: "ok", parameters: { type: "object" } }],
  };
  const turns = convertMessages(claude, context, "claude-sonnet-4-6");
  assert.ok(turns.some((turn) => turn.parts.some((part) => "text" in part && String(part.text).includes("Continue the active task"))));
  const request = buildRequest(claude, { systemPrompt: "sys", messages: [], tools: context.tools ?? [] }, "p", { toolChoice: "required" }, "claude-sonnet-4-6");
  assert.ok(request.request.contents.some((turn) => turn.parts.some((part) => "text" in part)));
});

test("streamAntigravity reports recorded HTTP errors and unknown-model discovery", async () => {
  const context: Context = { messages: [{ role: "user", timestamp: 1, content: "hi" }] };
  fetchOverride = async (url) => {
    if (url.includes("streamGenerateContent")) return textResponse('{"error":{"message":"API_KEY_INVALID"}}', 400);
    return undefined;
  };
  const bad = await collectStream(streamAntigravity(geminiModel(), context, { apiKey: apiKeyJson() }));
  assert.equal(bad.message.stopReason, "error");
  assert.match(bad.message.errorMessage ?? "", /login expired|API error/);

  fetchOverride = async (url) => {
    if (url.includes("fetchAvailableModels")) {
      return jsonResponse({ models: { "gemini-3.8-flash-low": { displayName: "Gemini 3.8 Flash (Low)", model: "MODEL_PLACEHOLDER_M320" } } });
    }
    if (url.includes("streamGenerateContent")) return textResponse(streamBody, 200, "text/event-stream");
    return undefined;
  };
  const custom = await collectStream(
    streamAntigravity({ ...geminiModel("gemini-custom-flash"), id: "gemini-custom-flash" }, context, {
      apiKey: apiKeyJson(),
    }),
  );
  assert.equal(custom.message.stopReason, "toolUse");
});

test("header deadline, stall watchdog, prewarm, and remaining helpers", async () => {
  // The product stall timer is unref'd; keep the event loop alive so later tests in
  // this file still run when other concurrent files have already finished.
  const keepAlive = setInterval(() => {}, 1000);
  try {
  await assert.rejects(
    () =>
      fetchWithHeaderDeadline(
        "https://daily-cloudcode-pa.googleapis.com/slow",
        {},
        undefined,
        20,
        0,
        async (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(init.signal?.reason ?? new Error("aborted"));
            });
          }),
      ),
    /no response headers|aborted/,
  );
  const encoder = new TextEncoder();
  await assert.rejects(async () => {
    const response = await fetchWithHeaderDeadline(
      "https://daily-cloudcode-pa.googleapis.com/stall",
      {},
      undefined,
      0,
      30,
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode("data: {\"response\":{}}\n"));
            },
          }),
          { status: 200 },
        ),
    );
    await response.text();
  }, /stream stalled/);

  process.env.ANTIGRAVITY_NO_PREWARM = "1";
  prewarmConnection("https://daily-cloudcode-pa.googleapis.com");
  const previousTestContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.ANTIGRAVITY_NO_PREWARM;
  delete process.env.NODE_TEST_CONTEXT;
  prewarmConnection("https://daily-cloudcode-pa.googleapis.com");
  process.env.NODE_TEST_CONTEXT = previousTestContext;

  assert.match(nowRequestId(), /^agent\//);
  assert.equal(escapeRegExp("a.b"), "a\\.b");
  assert.ok(resolveSessionTrajectory({ messages: [] }).conversationId);
  await runWithDiagnostics(async () => {
    setLastMaskedEmail("a***@example.com");
    setLastTokenExpiry("soon");
  });
  assert.equal(getLastDiagnostics().maskedEmail, "a***@example.com");
  assert.equal(getLastDiagnostics().tokenExpiry, "soon");

  assert.match(friendlyAntigravityError(400, "plain bad"), /Bad request/);
  assert.match(friendlyAntigravityError(403, "nope"), /denied this request/);
  assert.match(friendlyAntigravityError(404, "missing"), /could not find/);
  assert.match(friendlyAntigravityError(408, "x"), /timed out/);
  assert.match(friendlyAntigravityError(409, "x"), /conflict/);
  assert.match(friendlyAntigravityError(429, "quota hit. Resets in 2m"), /Quota reached/);
  assert.match(friendlyAntigravityError(429, "slow down"), /Rate limited/);
  assert.match(friendlyAntigravityError(502, "x"), /bad gateway/);
  assert.match(friendlyAntigravityError(504, "x"), /timed out upstream/);
  assert.match(friendlyAntigravityError(503, "busy"), /temporarily unavailable/);

  const hourReset = Date.now() + 90 * 60 * 1000;
  const dayReset = Date.now() + 26 * 60 * 60 * 1000;
  const summary = formatUsageSummary({
    projectId: "p",
    endpoint: "https://daily-cloudcode-pa.googleapis.com",
    fetchedAt: Date.now(),
    models: [],
    groups: [
      {
        displayName: "Windows",
        buckets: [
          { bucketId: "h", displayName: "Hour", remainingFraction: 0.5, resetTime: new Date(hourReset).toISOString() },
          { bucketId: "d", displayName: "Day", remainingFraction: 0.2, resetTime: new Date(dayReset).toISOString() },
          { bucketId: "bad", displayName: "Bad", remainingFraction: 0.1, resetTime: "not-a-date" },
        ],
      },
    ],
  });
  assert.match(summary, /1h/);
  assert.match(summary, /1d/);
  } finally {
    clearInterval(keepAlive);
  }
});

test("usage fetch keeps models when quota and assist endpoints fail closed", async () => {
  fetchOverride = async (url) => {
    if (url.includes("retrieveUserQuotaSummary")) {
      return textResponse("not-json", 400);
    }
    if (url.includes("loadCodeAssist")) {
      throw new Error("assist down");
    }
    return undefined;
  };
  const usage = await fetchAccountUsage(apiKeyJson());
  assert.match(usage.quotaSummaryError ?? "", /failed/);
  assert.ok(usage.models.length > 0);
  const minuteReset = Date.now() + 5 * 60 * 1000;
  assert.match(
    formatUsageSummary({
      projectId: "p",
      endpoint: "https://daily-cloudcode-pa.googleapis.com",
      fetchedAt: Date.now(),
      models: [],
      groups: [
        {
          displayName: "Soon",
          buckets: [
            {
              bucketId: "m",
              displayName: "Minute",
              remainingFraction: 0.9,
              resetTime: new Date(minuteReset).toISOString(),
            },
          ],
        },
      ],
    }),
    /5m/,
  );
  assert.equal(extractProjectId(undefined), undefined);
  assert.equal(extractProjectId({ projects: [{ nested: true }, "fallback-id"] }), "fallback-id");
});

test("catalog refresh falls back on abort, empty discovery, and unusable credentials", async () => {
  assert.equal(hydrateAntigravityCatalog(undefined), 0);
  assert.equal(hydrateAntigravityCatalog({ other: true }), 0);
  assert.equal(
    hydrateAntigravityCatalog({
      [ANTIGRAVITY_PERSIST_KEY]: { catalog: { models: [], routing: {} }, checkedAt: 0, modelEnums: { a: 1 } },
    }),
    0,
  );
  registerDiscoveredModelEnums(undefined);
  restoreDynamicModelEnums({ "": "skip", ok: "MODEL_OK" });
  assert.equal(getModelEnum("ok"), "MODEL_OK");

  fetchOverride = async () => jsonResponse({ models: {} });
  const empty = await discoverAntigravityModels(apiKeyJson());
  assert.deepEqual(empty.models, []);

  const aborted = new AbortController();
  aborted.abort();
  const skipped = await refreshAntigravityModels({
    allowNetwork: true,
    signal: aborted.signal,
    credential: { type: "oauth", access: "ya29.recorded-access", refresh: "r", expires: Date.now() + 60_000 },
    stored: {},
    async publish() {
      return true;
    },
  });
  assert.ok(skipped.length > 0);

  const noKey = await refreshAntigravityModels({
    allowNetwork: true,
    signal: new AbortController().signal,
    credential: { type: "api_key", key: "" },
    stored: {},
    async publish() {
      return true;
    },
  });
  assert.ok(noKey.length > 0);

  const unknownCred = await refreshAntigravityModels({
    allowNetwork: true,
    signal: new AbortController().signal,
    credential: { type: "unknown" as "api_key" },
    stored: {},
    async publish() {
      return true;
    },
  });
  assert.ok(unknownCred.length > 0);

  process.env.ANTIGRAVITY_CATALOG_REFRESH_INTERVAL_MS = "-5";
  assert.equal(getCatalogRefreshIntervalMs() > 0, true);

  const midAbort = new AbortController();
  fetchOverride = async () => {
    midAbort.abort();
    return jsonResponse(catalogRaw);
  };
  const afterAbort = await refreshAntigravityModels({
    allowNetwork: true,
    force: true,
    signal: midAbort.signal,
    credential: { type: "oauth", access: "ya29.recorded-access", refresh: "r", expires: Date.now() + 60_000, projectId: "proj-fixture" },
    stored: {},
    async publish() {
      throw new Error("should not publish aborted discovery");
    },
  });
  assert.ok(afterAbort.length > 0);

  fetchOverride = async () => jsonResponse({ models: {} });
  const emptyRefresh = await refreshAntigravityModels({
    allowNetwork: true,
    force: true,
    signal: new AbortController().signal,
    credential: { type: "api_key", key: apiKeyJson() },
    stored: {},
    async publish() {
      throw new Error("should not publish empty discovery");
    },
  });
  assert.ok(emptyRefresh.length > 0);
});

test("buildAntigravityCatalog covers internal ids, suffixes, and family templates", () => {
  const fallback = getCurrentAntigravityCatalog();
  assert.ok(getCurrentAntigravityModels().some((model) => model.id === "gemini-3.8-flash"));
  assert.equal(
    buildAntigravityCatalog(
      { "chat_hidden": { displayName: "Hidden" }, "tab_complete": { displayName: "Tab" } },
      fallback,
    ).models.length,
    fallback.models.length,
  );
  const catalog = buildAntigravityCatalog(
    {
      "gemini-9.1-flash-extra-low": { displayName: "Gemini 9.1 Flash (Extra Low)", supportsThinking: true, supportsImages: false },
      "gemini-9.1-flash-extra-high": { displayName: "Gemini 9.1 Flash (Extra High)", supportsThinking: true, supportsImages: false },
      "gemini-9.1-flash-thinking": { displayName: "Gemini 9.1 Flash (Thinking)", supportsThinking: true },
      "gemini-9.1-flash-minimal": { displayName: "Gemini 9.1 Flash (Minimal)", supportsThinking: true },
      "gemini-9.1-pro-high": { displayName: "Gemini 9.1 Pro (High)", supportsThinking: true, supportsImages: true },
      "claude-opus-9-internal": { displayName: "Claude Opus 9", isInternal: true, supportsThinking: true },
      "gpt-oss-9b": { label: "GPT OSS 9B", supportsThinking: false, supportsImages: false },
      "gemini-9.2-flash": { modelName: "Gemini 9.2 Flash", supportsThinking: false },
      "gemini-9.1-flash-agent": { displayName: "Gemini 9.1 Flash (High)", supportsThinking: true },
    },
    fallback,
  );
  assert.ok(catalog.models.some((model) => model.id === "gemini-9.1-flash"));
  assert.ok(catalog.models.some((model) => model.id === "gemini-9.1-pro"));
  assert.ok(catalog.models.some((model) => model.id === "gpt-oss-9b"));
  assert.ok(catalog.models.some((model) => model.id === "gemini-9.2-flash"));
  assert.equal(catalog.models.some((model) => model.id === "claude-opus-9-internal"), false);
  const flash = catalog.models.find((model) => model.id === "gemini-9.1-flash");
  assert.deepEqual(flash?.input, ["text"]);
  assert.equal(getMaxOutputTokens("gemini-3.8-flash"), 65536);
  assert.equal(getMaxOutputTokens("unknown", "gemini-custom"), 65536);
  assert.equal(getAntigravityRequestModelId("missing-model", "high"), "missing-model");
  assert.deepEqual(getThinkingConfig("gpt-oss-120b", "high"), { includeThoughts: true, thinkingBudget: 8192 });
  assert.deepEqual(getThinkingConfig("gemini-3.5-flash", "off"), { includeThoughts: false, thinkingBudget: 0 });
  assert.equal(getThinkingConfig("gemini-3.1-pro", "medium")?.thinkingBudget, 1_001);
  assert.equal(getThinkingConfig("gemini-3.8-flash", "high")?.thinkingBudget, -1);
  assert.equal(humanizePublicId("gpt-oss-1-2"), "GPT-OSS 1.2");
});

test("convertTools hits schema depth, cycles, pointers, and gpt-oss protocol branches", () => {
  let deep: unknown = { type: "string" };
  for (let i = 0; i < 70; i++) deep = { not: deep };
  const skipped = convertTools([{ name: "deep", description: "d", parameters: deep }]);
  assert.equal(skipped, undefined);

  const circular: Record<string, unknown> = { type: "object", properties: {} };
  circular.properties = circular;
  const cycled = convertTools([{ name: "cycle-obj", description: "c", parameters: circular }]);
  assert.equal(cycled, undefined);

  const pointers = convertTools([
    {
      name: "pointers",
      description: "p",
      parameters: {
        type: "object",
        properties: {
          nested: { $ref: "#/$defs/a~1b" },
          fromArray: { $ref: "#/allOf/0" },
        },
        allOf: [{ type: "string" }],
        $defs: { "a/b": { type: "string" } },
      },
    },
    {
      name: "bad-pointer",
      description: "b",
      parameters: {
        type: "object",
        properties: { badIndex: { $ref: "#/allOf/01" } },
        allOf: [{ type: "string" }],
      },
    },
    {
      name: "map-scalar",
      description: "m",
      parameters: { type: "object", properties: "nope" },
    },
  ]);
  assert.ok(pointers?.[0]?.functionDeclarations.some((decl) => decl.name === "pointers"));
  assert.equal(pointers?.[0]?.functionDeclarations.some((decl) => decl.name === "bad-pointer"), false);

  const gpt = geminiModel("gpt-oss-120b");
  const cyclicArgs: Record<string, unknown> = { n: 1 };
  cyclicArgs.self = cyclicArgs;
  const context: Context = {
    messages: [
      { role: "user", timestamp: 1, content: [{ type: "image", data: "", mimeType: "image/png" }, { type: "text", text: "   " }] },
      {
        role: "assistant",
        api: "antigravity-api",
        provider: "antigravity",
        model: gpt.id,
        stopReason: "toolUse",
        timestamp: 2,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        content: [
          { type: "text", text: "   " },
          { type: "thinking", thinking: "   " },
          { type: "toolCall", id: "", name: "ok", arguments: cyclicArgs },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "",
        toolName: "ok",
        isError: false,
        timestamp: 3,
        content: [{ type: "text", text: "out" }],
      },
    ],
    tools: [{ name: "ok", description: "ok", parameters: { type: "object" } }],
  };
  const turns = convertMessages(gpt, context, "gpt-oss-120b-medium");
  assert.ok(turns.some((turn) => turn.parts.some((part) => "functionCall" in part || "functionResponse" in part || "text" in part)));
  const unsignedGemini: Context = {
    messages: [
      {
        role: "assistant",
        api: "antigravity-api",
        provider: "antigravity",
        model: "gemini-3.8-flash",
        stopReason: "toolUse",
        timestamp: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        content: [{ type: "toolCall", id: "", name: "ok", arguments: { n: 1 } }],
      },
      {
        role: "toolResult",
        toolCallId: "",
        toolName: "ok",
        isError: false,
        timestamp: 2,
        content: [{ type: "text", text: "saw" }],
      },
    ],
  };
  const dropped = convertMessages(geminiModel(), unsignedGemini, "gemini-flash");
  assert.ok(
    dropped.some((turn) => turn.parts.some((part) => "text" in part && String(part.text).includes("Observation"))),
  );
  const request = buildRequest(
    gpt,
    { messages: [{ role: "user", timestamp: 1, content: "hi" }], tools: context.tools ?? [] },
    "proj-fixture",
    { maxTokens: 99, toolChoice: "any", sessionId: "sess-1", reasoning: "medium" },
    "gpt-oss-120b-medium",
  );
  assert.equal(request.request.sessionId, "sess-1");
  assert.equal(request.request.toolConfig?.functionCallingConfig.mode, "ANY");
  assert.ok((request.request.generationConfig?.maxOutputTokens ?? 0) <= 99);
});

test("streamAntigravity retries empty SSE, 503 endpoints, quota, and 404 dynamic ids", async () => {
  const context: Context = { messages: [{ role: "user", timestamp: 1, content: "hi" }] };
  let emptyCalls = 0;
  fetchOverride = async (url) => {
    if (url.includes("streamGenerateContent")) {
      emptyCalls += 1;
      if (emptyCalls === 1) return textResponse(streamEmptyBody, 200, "text/event-stream");
      return textResponse(streamBody, 200, "text/event-stream");
    }
    return undefined;
  };
  const retried = await collectStream(streamAntigravity(geminiModel(), context, { apiKey: apiKeyJson() }));
  assert.equal(retried.message.stopReason, "toolUse");
  assert.ok(emptyCalls >= 2);

  fetchOverride = async (url) => {
    if (url.includes("streamGenerateContent") && url.includes("sandbox")) {
      return textResponse(streamBody, 200, "text/event-stream");
    }
    if (url.includes("streamGenerateContent")) return textResponse("No capacity available", 503);
    return undefined;
  };
  const viaFallbackEndpoint = await collectStream(streamAntigravity(geminiModel(), context, { apiKey: apiKeyJson() }));
  assert.equal(viaFallbackEndpoint.message.stopReason, "toolUse");

  fetchOverride = async (url) => {
    if (url.includes("streamGenerateContent")) {
      return textResponse("Individual quota reached. Resets in 1h", 429);
    }
    return undefined;
  };
  const quota = await collectStream(streamAntigravity(geminiModel(), context, { apiKey: apiKeyJson() }));
  assert.equal(quota.message.stopReason, "error");
  assert.match(quota.message.errorMessage ?? "", /Quota reached|API error/);

  fetchOverride = async (url, init) => {
    if (url.includes("fetchAvailableModels")) {
      return jsonResponse({
        models: {
          "gemini-3.8-flash-preview-low": {
            displayName: "Gemini 3.8 Flash (Low)",
            model: "MODEL_PLACEHOLDER_M320",
          },
        },
      });
    }
    if (url.includes("streamGenerateContent")) {
      const body = String(init?.body ?? "");
      if (body.includes("gemini-3.8-flash-preview-low")) {
        return textResponse(streamBody, 200, "text/event-stream");
      }
      return textResponse("Requested entity was not found", 404);
    }
    return undefined;
  };
  const dynamic = await collectStream(streamAntigravity(geminiModel(), context, { apiKey: apiKeyJson() }));
  assert.equal(dynamic.message.stopReason, "toolUse");

  process.env.ANTIGRAVITY_RUNTIME_MODEL = "gemini-3.6-flash-low";
  fetchOverride = async (url) => {
    if (url.includes("streamGenerateContent")) return textResponse(streamBody, 200, "text/event-stream");
    return undefined;
  };
  const pinned = await collectStream(
    streamAntigravity({ ...geminiModel("gemini-custom-flash"), id: "gemini-custom-flash" }, context, {
      apiKey: apiKeyJson(),
    }),
  );
  assert.equal(pinned.message.stopReason, "toolUse");

  process.env.ANTIGRAVITY_DEBUG_DUMP = "1";
  fetchOverride = async (url) => {
    if (url.includes("streamGenerateContent")) return textResponse("nope", 400);
    return undefined;
  };
  const dumped = await collectStream(streamAntigravity(geminiModel(), context, { apiKey: apiKeyJson() }));
  assert.equal(dumped.message.stopReason, "error");
});

test("streamResponse covers malformed chunks, error stop, tool ids, and unmetered usage", async () => {
  const encoder = new TextEncoder();
  const mixed = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue("not-bytes" as unknown as Uint8Array);
      controller.enqueue(encoder.encode(streamErrorStopBody));
      controller.close();
    },
  });
  const output = {
    role: "assistant" as const,
    content: [],
    api: "antigravity-api" as const,
    provider: "antigravity",
    model: "gemini-3.8-flash",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop" as const,
    timestamp: 0,
  };
  const errorStop = createAssistantMessageEventStream();
  const collected = collectStream(errorStop);
  await streamResponse(new Response(mixed), errorStop, output);
  errorStop.end(output);
  const seen = await collected;
  assert.equal(output.stopReason, "error");
  assert.ok(seen.events.some((event) => event.type === "text_delta" || event.type === "start"));

  const unmetered = {
    ...output,
    content: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop" as const,
  };
  const toolStream = createAssistantMessageEventStream();
  await streamResponse(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(streamToolIdBody));
          controller.close();
        },
      }),
    ),
    toolStream,
    unmetered,
  );
  toolStream.end(unmetered);
  assert.equal(unmetered.stopReason, "toolUse");
  assert.equal(unmetered.usage.cost.total, 0);

  const context: Context = { messages: [{ role: "user", timestamp: 1, content: "hi" }] };
  fetchOverride = async (url) => {
    if (url.includes("streamGenerateContent")) return textResponse(streamErrorStopBody, 200, "text/event-stream");
    return undefined;
  };
  const errored = await collectStream(streamAntigravity(geminiModel(), context, { apiKey: apiKeyJson() }));
  assert.equal(errored.message.stopReason, "error");
});

test("client discovery matches labels, concurrent cache, and remaining URL guards", async () => {
  process.env.ANTIGRAVITY_USER_AGENT = "";
  process.env.NOAGY_USER_AGENT = "noagy-agent/1";
  assert.equal(antigravityHeaders("tok")["User-Agent"], "noagy-agent/1");
  assert.equal(resolveCallbackHost("::1"), "::1");
  assert.throws(() => assertSafeApiBaseUrl("::::"), /Invalid ANTIGRAVITY_BASE_URL/);
  assert.equal(assertSafeApiBaseUrl("https://googleapis.com/v1"), "https://googleapis.com/v1");
  assert.equal(maskEmail(undefined), undefined);
  assert.equal(maskEmail(""), undefined);

  fetchOverride = async (url) => {
    if (url.includes("fetchAvailableModels")) {
      return jsonResponse({
        models: {
          "MODEL_PLACEHOLDER_M1": { displayName: "enum" },
          "gemini-3.7-flash-low": { displayName: "Gemini 3.7 Flash (Low)", model: "MODEL_PLACEHOLDER_M300", modelExperiments: ["e1", 2] },
        },
        nested: [{ label: "gemini-3.7-flash-low" }],
      });
    }
    return undefined;
  };
  const [a, b] = await Promise.all([
    fetchAvailableRuntimeModel("tok-conc", "proj", "gemini-3.7-flash-low"),
    fetchAvailableRuntimeModel("tok-conc", "proj", "gemini-3.7-flash-low"),
  ]);
  assert.equal(a?.id, "gemini-3.7-flash-low");
  assert.equal(b?.id, "gemini-3.7-flash-low");
  const byLabel = await fetchAvailableRuntimeModel("tok-conc-2", "proj", "gemini-3.7-flash-low");
  assert.equal(byLabel?.id, "gemini-3.7-flash-low");

  const envelope = antigravityRequestEnvelope("gemini-3.8-flash-low", true);
  assert.equal(envelope.labels.used_claude, "true");
  const traj = resolveSessionTrajectory({
    messages: [{ role: "user", timestamp: 1, content: [{ type: "text", text: "seed-array" }] }],
  });
  assert.ok(traj.conversationId);
  for (let i = 0; i < 66; i++) {
    resolveSessionTrajectory({ messages: [{ role: "user", timestamp: i + 10, content: `seed-${i}` }] });
  }

  fetchOverride = async (url) => {
    if (url.includes("loadCodeAssist")) {
      return jsonResponse({
        currentTier: { id: "free", name: "Free" },
        paidTier: { id: "g1-pro-tier", name: "Google AI Pro", description: "paid" },
        projectId: "tier-project",
      });
    }
    if (url.includes("retrieveUserQuotaSummary")) {
      return jsonResponse({
        description: "pool",
        groups: [
          { displayName: "" },
          {
            displayName: "Pool",
            buckets: [
              { remainingFraction: -1, bucketId: "neg" },
              { remainingFraction: 2, displayName: "Over" },
              { remainingFraction: Number.NaN },
            ],
          },
        ],
      });
    }
    if (url.includes("fetchAvailableModels")) {
      return jsonResponse({
        models: {
          "chat_hidden": { displayName: "Hidden" },
          "gemini-3.8-flash-low": {
            label: "Flash Low",
            quotaInfo: { remainingFraction: 0.4, resetTime: new Date(Date.now() - 1000).toISOString() },
            recommended: true,
            supportsThinking: true,
            supportsImages: true,
            modelProvider: "google",
          },
          "tab_complete": { modelName: "Tab", isInternal: false },
        },
        defaultAgentModelId: "gemini-3.8-flash-low",
      });
    }
    return undefined;
  };
  const usage = await fetchAccountUsage(apiKeyJson("tier-project"));
  assert.match(usage.planLabel ?? "", /Google AI Pro/);
  assert.match(formatUsageSummary(usage), /now|0%/);
  assert.match(formatModelsList(usage, { all: true }), /tab_complete|Flash Low|recommended/);
});

test("header deadline cancels an invalid body chunk and passthrough abort reason", async () => {
  await assert.rejects(async () => {
    const response = await fetchWithHeaderDeadline(
      "https://daily-cloudcode-pa.googleapis.com/invalid-chunk",
      {},
      undefined,
      0,
      5_000,
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue("nope" as unknown as Uint8Array);
            },
          }),
          { status: 200 },
        ),
    );
    await response.arrayBuffer();
  }, /invalid chunk/);

  const ac = new AbortController();
  const pending = fetchWithHeaderDeadline(
    "https://daily-cloudcode-pa.googleapis.com/later-abort",
    {},
    ac.signal,
    5_000,
    5_000,
    async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason ?? new Error("aborted"));
        });
      }),
  );
  ac.abort(new Error("caller-cancel"));
  await assert.rejects(pending, /caller-cancel|aborted/);
});

test("usage postJson retries parse failures and keeps assist/quota error legs honest", async () => {
  let quotaHits = 0;
  fetchOverride = async (url) => {
    if (url.includes("retrieveUserQuotaSummary")) {
      quotaHits += 1;
      if (quotaHits === 1) return textResponse("not-json-503", 503);
      if (quotaHits === 2) throw new Error("socket reset");
      return jsonResponse(quotaSummary);
    }
    if (url.includes("loadCodeAssist")) {
      return textResponse(JSON.stringify({ error: { message: "assist 400" } }), 400);
    }
    if (url.includes("fetchAvailableModels")) {
      return jsonResponse({
        models: {
          "gemini-name-only": { modelName: "Name Only Model", apiProvider: "google" },
          "gemini-label-only": { label: "Label Only" },
        },
      });
    }
    return undefined;
  };
  const usage = await fetchAccountUsage(apiKeyJson());
  assert.ok(quotaHits >= 2);
  assert.equal(usage.models.some((model) => model.displayName === "Name Only Model"), true);
  assert.equal(usage.models.some((model) => model.displayName === "Label Only"), true);

  fetchOverride = async (url) => {
    if (url.includes("loadCodeAssist")) {
      return jsonResponse({ currentTier: { id: "free-tier", name: "Free" }, projectId: "tier-only" });
    }
    if (url.includes("retrieveUserQuotaSummary")) {
      return jsonResponse({
        groups: [
          {
            displayName: "Hourly",
            buckets: [
              { displayName: "Hour", remainingFraction: 0.4, resetTime: new Date(Date.now() + 130 * 60 * 1000).toISOString() },
              { remainingFraction: 0.1 },
            ],
          },
        ],
      });
    }
    return undefined;
  };
  const freeTier = await fetchAccountUsage(apiKeyJson("tier-only"));
  assert.match(freeTier.planLabel ?? "", /Free/);
  assert.match(formatUsageSummary(freeTier), /2h|1h|n\/a/);
  assert.match(formatUsageSummary({ ...freeTier, groups: [], quotaSummaryError: "timeout talking to quota" }), /unavailable/);
  assert.match(formatUsageSummary({ ...freeTier, groups: [], quotaSummaryError: "account missing license for quota" }), /paid subscription/);
  assert.match(
    formatModelsList({
      ...freeTier,
      models: [{ modelId: "same", displayName: "same", remainingFraction: undefined }],
    }),
    /same/,
  );
});

test("prewarmConnection actually issues HEAD and swallows warm-up failures", async () => {
  const previousTestContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.ANTIGRAVITY_NO_PREWARM;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    let seenMethod = "";
    const warmed = new Promise<void>((resolve) => {
      fetchOverride = async (url, init) => {
        seenMethod = String(init?.method ?? "");
        if (url.includes("daily-cloudcode-pa.googleapis.com")) {
          resolve();
          return textResponse("", 200);
        }
        return undefined;
      };
    });
    prewarmConnection("https://daily-cloudcode-pa.googleapis.com");
    await Promise.race([
      warmed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("prewarm success timeout")), 2000)),
    ]);
    assert.equal(seenMethod, "HEAD");

    const failed = new Promise<void>((resolve) => {
      fetchOverride = async () => {
        resolve();
        throw new Error("warm fail");
      };
    });
    prewarmConnection("https://cloudcode-pa.googleapis.com");
    await Promise.race([
      failed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("prewarm fail timeout")), 2000)),
    ]);
  } finally {
    if (previousTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousTestContext;
  }
});

test("client helpers cover remaining project, catalog, and runtime-match branches", async () => {
  assert.equal(extractProjectId({ antigravityProjectId: "a1" }), "a1");
  assert.equal(extractProjectId({ userDefinedCloudaicompanionProject: "u1" }), "u1");
  assert.equal(extractProjectId({ projectIds: ["from-ids"] }), "from-ids");
  assert.equal(extractProjectId({}), undefined);
  assert.equal(jsonOrTextError('{"error":{}}'), '{"error":{}}');
  assert.throws(() => parseApiKey(JSON.stringify({ token: "t" })), /Invalid Antigravity credentials/);
  assert.equal(isUsableRuntimeModelId("MODEL_PLACEHOLDER_M1"), false);
  assert.equal(isUsableRuntimeModelId("gemini-3.8-flash has space"), false);
  assert.equal(isUsableRuntimeModelId("gemini-3.8-flash"), true);
  delete process.env.ANTIGRAVITY_PROJECT_ID;
  assert.match(resolveProjectId({ token: "t", email: "seed@example.com" }), /-/);

  fetchOverride = async (url) => {
    if (url.includes("fetchAvailableModels")) {
      if (url.includes("sandbox")) throw new Error("sandbox down");
      if (url.includes("daily-cloudcode-pa.googleapis.com")) {
        return textResponse(JSON.stringify({ error: { message: "catalog 500" } }), 500);
      }
      return jsonResponse({
        other: {
          models: {
            "gemini-3.8-flash-medium": { displayName: "Gemini 3.8 Flash (Medium)", model: "MODEL_PLACEHOLDER_M319" },
            "claude-opus-4-6": { displayName: "Claude Opus 4.6", model: "MODEL_PLACEHOLDER_M26" },
            "gpt-oss-120b-medium": { displayName: "GPT OSS 120B (Medium)" },
            "gemini-3.1-pro-high": { displayName: "Gemini 3.1 Pro (High)" },
          },
        },
      });
    }
    return undefined;
  };
  const medium = await fetchAvailableRuntimeModel("tok-match", "proj", "gemini-3.8-flash-medium");
  assert.equal(medium?.id, "gemini-3.8-flash-medium");
  const opus = await fetchAvailableRuntimeModel("tok-match-2", "proj", "claude-opus-4-6");
  assert.equal(opus?.id, "claude-opus-4-6");
  const oss = await fetchAvailableRuntimeModel("tok-match-3", "proj", "gpt-oss-120b");
  assert.equal(oss?.id, "gpt-oss-120b-medium");
  const pro = await fetchAvailableRuntimeModel("tok-match-4", "proj", "gemini-3.1-pro-high");
  assert.equal(pro?.id, "gemini-3.1-pro-high");

  fetchOverride = async (url) => {
    if (url.includes("fetchAvailableModels")) return jsonResponse(["gemini-custom-flash"]);
    return undefined;
  };
  const fromString = await fetchAvailableRuntimeModel("tok-string", "proj", "gemini-custom-flash");
  assert.equal(fromString?.id, "gemini-custom-flash");

  fetchOverride = async (url) => {
    if (url.includes("loadCodeAssist")) throw new Error("assist boom");
    if (url.includes("listCloudAICompanionProjects")) throw new Error("list boom");
    return undefined;
  };
  assert.equal(await loadCodeAssist("tok-all-fail"), undefined);

  fetchOverride = async (url) => {
    if (url.includes("loadCodeAssist")) return jsonResponse({ currentTier: { name: "Free" } });
    if (url.includes("listCloudAICompanionProjects")) {
      if (url.includes("daily")) throw new Error("list daily down");
      return jsonResponse({ projectIds: ["listed-after-error"] });
    }
    return undefined;
  };
  assert.equal(await loadCodeAssist("tok-list-retry"), "listed-after-error");

  fetchOverride = async (url) => {
    if (url.includes("fetchAvailableModels")) {
      return jsonResponse({ models: { "gemini-3.6-flash-low": { displayName: "Gemini 3.6 Flash (Low)" } } });
    }
    return undefined;
  };
  for (let i = 0; i < 66; i++) {
    await fetchAvailableRuntimeModel(`tok-evict-${i}`, "proj", "gemini-3.6-flash-low");
  }
  for (let i = 0; i < 34; i++) {
    await loadCodeAssist(`tok-project-evict-${i}`);
  }
});

test("oauth callback server rejects provider errors and token exchange failures", async () => {
  async function waitForCallbackHost(): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < 3000) {
      try {
        const probe = await originalFetch("http://127.0.0.1:51121/not-the-callback");
        assert.equal(probe.status, 404);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    throw new Error("callback host did not start");
  }

  let authUrl = "";
  const deniedLogin = loginAntigravity({
    onAuth(info) {
      authUrl = info.url;
    },
  });
  const deniedResult = assert.rejects(deniedLogin, /OAuth error|access_denied/);
  await waitForCallbackHost();
  const head = await originalFetch("http://127.0.0.1:51121/not-the-callback", { method: "HEAD" });
  assert.equal(head.status, 404);
  const state = new URL(authUrl).searchParams.get("state");
  assert.ok(state);
  const denied = await originalFetch(
    `http://127.0.0.1:51121/oauth-callback?error=access_denied&state=${state}`,
  );
  assert.equal(denied.status, 400);
  await deniedResult;

  let missingUrl = "";
  const missingLogin = loginAntigravity({
    onAuth(info) {
      missingUrl = info.url;
    },
  });
  const missingResult = assert.rejects(missingLogin, /Missing code or state/);
  await waitForCallbackHost();
  const missingState = new URL(missingUrl).searchParams.get("state");
  const missingCode = await originalFetch(
    `http://127.0.0.1:51121/oauth-callback?state=${missingState}`,
  );
  assert.equal(missingCode.status, 400);
  await missingResult;

  const mismatchLogin = loginAntigravity({
    onAuth() {},
  });
  const mismatchResult = assert.rejects(mismatchLogin, /state mismatch/i);
  await waitForCallbackHost();
  const mismatch = await originalFetch("http://127.0.0.1:51121/oauth-callback?code=abc&state=other");
  assert.equal(mismatch.status, 400);
  await mismatchResult;

  fetchOverride = async (url) => {
    if (url.startsWith(TOKEN_URL)) return textResponse("{}", 400);
    return undefined;
  };
  let tokenUrl = "";
  const tokenLogin = loginAntigravity({
    onAuth(info) {
      tokenUrl = info.url;
    },
  });
  const tokenResult = assert.rejects(tokenLogin, /Token exchange failed/);
  await waitForCallbackHost();
  const tokenState = new URL(tokenUrl).searchParams.get("state");
  const tokenCallback = await originalFetch(
    `http://127.0.0.1:51121/oauth-callback?code=x&state=${tokenState}`,
  );
  assert.equal(tokenCallback.status, 200);
  await tokenResult;

  fetchOverride = async (url) => {
    if (url.startsWith(TOKEN_URL)) return jsonResponse(tokenExchange);
    if (url.includes("userinfo")) throw new Error("userinfo down");
    if (url.includes("loadCodeAssist")) return jsonResponse({ projectId: "after-userinfo-fail" });
    return undefined;
  };
  let recoveredUrl = "";
  const recovered = loginAntigravity({
    onAuth(info) {
      recoveredUrl = info.url;
    },
  });
  await waitForCallbackHost();
  const recoveredState = new URL(recoveredUrl).searchParams.get("state");
  const ok = await originalFetch(
    `http://127.0.0.1:51121/oauth-callback?code=ok&state=${recoveredState}`,
  );
  assert.equal(ok.status, 200);
  const creds = await recovered;
  assert.equal(creds.projectId, "after-userinfo-fail");
  assert.equal(creds.email, undefined);

  fetchOverride = async (url) => {
    if (url.startsWith(TOKEN_URL)) return textResponse("{}", 400);
    return undefined;
  };
  await assert.rejects(
    () => refreshAntigravityToken({ refresh: "1/0gK8abcdefghijklmnopqrstuvwxyzABCD", access: "x", expires: 1 }),
    /token refresh failed/,
  );

  const blocker = createServer((_req, res) => {
    res.writeHead(200);
    res.end("busy");
  });
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(51121, "127.0.0.1", resolve);
  });
  try {
    await assert.rejects(
      () =>
        loginAntigravity({
          onAuth() {},
        }),
      /Port 51121 is already in use/,
    );
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

test("stream and catalog helpers cover remaining request and grouping legs", async () => {
  const model = geminiModel();
  const sourceImage: Context = {
    messages: [
      {
        role: "user",
        timestamp: 1,
        content: [
          { type: "text", text: "see" },
          { type: "image", source: { data: "abcd", mediaType: "image/webp" } },
          { type: "image" },
          "skip-me" as never,
        ],
      },
      {
        role: "assistant",
        api: "other",
        provider: "other",
        model: "other",
        stopReason: "stop",
        timestamp: 2,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        content: [{ type: "thinking", thinking: "foreign" }],
      },
    ],
  };
  const turns = convertMessages(model, sourceImage, "gemini-3.8-flash-low");
  assert.ok(turns.some((turn) => turn.parts.some((part) => "inlineData" in part)));

  const request = buildRequest(model, { messages: [{ role: "user", timestamp: 1, content: "hi" }] }, "p", {}, "gemini-3.8-flash-low");
  assert.ok(request.request.systemInstruction?.parts.length);
  assert.ok((request.request.generationConfig?.maxOutputTokens ?? 0) > 0);
  assert.equal(mapStopReason(undefined), "stop");
  assert.match(friendlyAntigravityError(undefined, "plain"), /plain/);
  assert.match(friendlyAntigravityError(429, "quota exceeded"), /Quota reached/);
  assert.match(friendlyAntigravityError(418, "teapot"), /teapot/);

  const tools = convertTools([
    {
      name: "root-ref",
      description: "r",
      parameters: { $ref: "#/allOf/9", allOf: [{ type: "string" }] },
    },
    {
      name: "into-scalar",
      description: "s",
      parameters: { $ref: "#/type/nope", type: "string" },
    },
  ]);
  assert.equal(tools, undefined);

  const missingKey = await collectStream(streamAntigravity(model, { messages: [{ role: "user", timestamp: 1, content: "hi" }] }));
  assert.equal(missingKey.message.stopReason, "error");

  assert.equal(getMaxOutputTokens("gemini-3.8-flash"), 65536);
  assert.equal(getMaxOutputTokens("x", "claude-unknown-9"), 64000);
  assert.equal(getMaxOutputTokens("x", "gpt-oss-unknown"), 32768);
  assert.equal(getMaxOutputTokens("x", "gemini-3.1-pro-custom"), 65535);
  assert.deepEqual(getThinkingConfig("gemini-3-flash-agent", "medium"), { includeThoughts: true, thinkingBudget: 4_000 });
  assert.deepEqual(getThinkingConfig("gemini-3.1-pro", undefined), { includeThoughts: false, thinkingBudget: 0 });
  assert.equal(getThinkingConfig("gemini-pro-agent", "xhigh")?.thinkingBudget, 10_001);
  assert.match(nowRequestId(), /^agent\//);

  const grouped = buildAntigravityCatalog(
    {
      "gemini-9.3-flash-low": { displayName: "Gemini 9.3 Flash (Low)", supportsThinking: true },
      "gemini-9.3-flash-agent": { displayName: "Gemini 9.3 Flash", supportsThinking: true },
      "claude-haiku-9": { displayName: "Claude Haiku 9" },
      "gemini-custom-other": { displayName: "Gemini Custom Other" },
    },
    getCurrentAntigravityCatalog(),
  );
  assert.ok(grouped.models.some((item) => item.id === "gemini-9.3-flash"));
  assert.ok(grouped.models.some((item) => item.id === "claude-haiku-9"));
  assert.ok(grouped.models.some((item) => item.id === "gemini-custom-other"));
});

