import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assistantFailure } from "../plugins/kxm/src/extension.ts";
import piMeshExtension from "../plugins/kxm/src/extension.ts";
import { looksLikeSecret } from "../plugins/kxm/src/redact.ts";
import {
  NOUS_DIRECT_BASE_URL,
  NOUS_DIRECT_ID,
  NOUS_PROXY_ID,
  NOUS_PROXY_PLACEHOLDER_KEY,
} from "../plugins/kxm/src/nous-provider.ts";
import { nousFactoryWork, registerNousProviders } from "../plugins/kxm/src/nous-pi.ts";
import { preflightRequest, REQUEST_SCHEMA } from "../scripts/harness-run.mjs";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "nous");
const idsOnly = JSON.parse(readFileSync(join(fixtureDir, "models-ids-only.json"), "utf8"));
const withCapacity = JSON.parse(readFileSync(join(fixtureDir, "models-with-capacity.json"), "utf8"));
const pinPath = join(fixtureDir, "catalog-pin.json");
const PI_AI = resolve("node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js");
const PI_AI_COMPLETIONS = resolve("node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js");

const ENV_KEYS = [
  "KXM_NOUS_PROVIDERS",
  "KXM_NOUS_PROXY_URL",
  "KXM_NOUS_DISCOVERY_TIMEOUT_MS",
  "KXM_NOUS_CATALOG_FILE",
  "NOUS_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

async function isolateEnv<T>(fn: () => Promise<T> | T): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

type FakePi = {
  api: ExtensionAPI;
  providers: Map<string, Record<string, unknown>>;
  tools: Map<string, unknown>;
  emit: (name: string, ...args: unknown[]) => Promise<void>;
  notices: Array<{ message: string; type?: string }>;
};

function fakePi(options: { register?: boolean } = {}): FakePi {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const tools = new Map<string, unknown>();
  const providers = new Map<string, Record<string, unknown>>();
  const notices: Array<{ message: string; type?: string }> = [];
  const api = {
    on(name: string, handler: (...args: unknown[]) => unknown) {
      const existing = handlers.get(name) ?? [];
      existing.push(handler);
      handlers.set(name, existing);
    },
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    sendMessage() {},
    getSessionName() {
      return "nous-test";
    },
    ...(options.register === false ? {} : {
      registerProvider(name: string, config: Record<string, unknown>) {
        providers.set(name, config);
      },
    }),
  } as unknown as ExtensionAPI;
  return {
    api,
    providers,
    tools,
    notices,
    async emit(name, ...args) {
      for (const handler of handlers.get(name) ?? []) await handler(...args);
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("unset env does not fetch or register and keeps the factory synchronous", async () => {
  await isolateEnv(async () => {
    let fetched = 0;
    const pi = fakePi({ register: false });
    const returned = piMeshExtension(pi.api);
    assert.equal(returned, undefined);
    const report = await registerNousProviders(pi.api, {
      env: {},
      fetch: async () => {
        fetched += 1;
        return jsonResponse({});
      },
    });
    assert.equal(report.optedIn, false);
    assert.equal(fetched, 0);
    assert.equal(pi.providers.size, 0);
    assert.ok(pi.tools.has("kxm_fanout") || pi.tools.size > 0);
  });
});

test("unknown token registers nothing, keeps hub tools, and reports an error", async () => {
  await isolateEnv(async () => {
    process.env.KXM_NOUS_PROVIDERS = "direct,weird";
    const pi = fakePi();
    const returned = piMeshExtension(pi.api);
    assert.equal(returned, undefined);
    assert.equal(pi.providers.size, 0);
    assert.ok([...pi.tools.keys()].some((name) => name.startsWith("kxm_")));
    const report = await registerNousProviders(pi.api, { env: { KXM_NOUS_PROVIDERS: "direct,weird" } });
    assert.equal(report.registeredProviders.length, 0);
    assert.ok(report.guidance.some((item) => item.level === "error" && /unknown/.test(item.message)));
  });
});

test("direct without a key registers, does not fetch, and does not read other keys", async () => {
  const pi = fakePi();
  let fetched = 0;
  const report = await registerNousProviders(pi.api, {
    env: { KXM_NOUS_PROVIDERS: "direct", OPENROUTER_API_KEY: "or-secret-key" },
    fetch: async () => {
      fetched += 1;
      return jsonResponse(withCapacity);
    },
  });
  assert.equal(fetched, 0);
  assert.equal(pi.providers.has(NOUS_DIRECT_ID), true);
  const config = pi.providers.get(NOUS_DIRECT_ID);
  assert.equal(config?.baseUrl, NOUS_DIRECT_BASE_URL);
  assert.equal(config?.apiKey, "$NOUS_API_KEY");
  assert.deepEqual(config?.models, []);
  assert.ok(report.guidance.some((item) => /NOUS_API_KEY/.test(item.message)));
  assert.ok(report.guidance.every((item) => !looksLikeSecret(item.message)));
});

test("direct discovery sends only the Nous bearer and never OpenRouter", async () => {
  const headers: string[] = [];
  const pi = fakePi();
  await registerNousProviders(pi.api, {
    env: {
      KXM_NOUS_PROVIDERS: "direct",
      NOUS_API_KEY: "nous-only-secret",
      OPENROUTER_API_KEY: "or-secret-key",
    },
    fetch: async (url, init) => {
      headers.push(String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ""));
      assert.match(String(url), /inference-api\.nousresearch\.com/);
      return jsonResponse(withCapacity);
    },
  });
  assert.deepEqual(headers, ["Bearer nous-only-secret"]);
  const models = pi.providers.get(NOUS_DIRECT_ID)?.models as Array<{ id: string }>;
  assert.equal(models[0]?.id, "hermes-3");
});

test("proxy never sends NOUS_API_KEY and uses a placeholder bearer", async () => {
  const headers: string[] = [];
  const pi = fakePi();
  await registerNousProviders(pi.api, {
    env: {
      KXM_NOUS_PROVIDERS: "proxy",
      NOUS_API_KEY: "nous-only-secret",
      KXM_NOUS_CATALOG_FILE: pinPath,
    },
    fetch: async (_url, init) => {
      headers.push(String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ""));
      return jsonResponse(idsOnly);
    },
  });
  assert.deepEqual(headers, [`Bearer ${NOUS_PROXY_PLACEHOLDER_KEY}`]);
  const config = pi.providers.get(NOUS_PROXY_ID);
  assert.equal(config?.apiKey, NOUS_PROXY_PLACEHOLDER_KEY);
  const models = config?.models as Array<{ id: string; name: string; cost: { input: number } }>;
  assert.equal(models[0]?.id, "hermes-3-proxy");
  assert.match(models[0]?.name ?? "", /subscription proxy, market ref/);
  assert.equal(models[0]?.cost.input, 0.8);
});

test("non-loopback proxy URL fails closed without fetch", async () => {
  let fetched = 0;
  const pi = fakePi();
  const report = await registerNousProviders(pi.api, {
    env: { KXM_NOUS_PROVIDERS: "proxy", KXM_NOUS_PROXY_URL: "http://example.com:8645/v1" },
    fetch: async () => {
      fetched += 1;
      return jsonResponse(idsOnly);
    },
  });
  assert.equal(fetched, 0);
  assert.equal(pi.providers.size, 0);
  assert.ok(report.guidance.some((item) => item.level === "error" && /loopback/.test(item.message)));
});

test("proxy ECONNREFUSED registers zero models with start/status guidance", async () => {
  const pi = fakePi();
  const report = await registerNousProviders(pi.api, {
    env: { KXM_NOUS_PROVIDERS: "proxy" },
    fetch: async () => {
      const error = new Error("connect ECONNREFUSED 127.0.0.1:8645");
      (error as { code?: string }).code = "ECONNREFUSED";
      throw error;
    },
  });
  assert.equal(report.proxy.error, "connection-refused");
  assert.deepEqual(pi.providers.get(NOUS_PROXY_ID)?.models, []);
  const text = report.guidance.map((item) => item.message).join("\n");
  assert.match(text, /hermes proxy start/);
  assert.match(text, /hermes proxy status/);
});

test("proxy 401 names hermes login --provider nous first", async () => {
  const pi = fakePi();
  const report = await registerNousProviders(pi.api, {
    env: { KXM_NOUS_PROVIDERS: "proxy" },
    fetch: async () => jsonResponse({ error: "not logged in" }, 401),
  });
  assert.equal(report.proxy.error, "auth");
  assert.match(report.guidance[0]?.message ?? "", /hermes login --provider nous/);
  assert.match(report.guidance.map((item) => item.message).join("\n"), /hermes setup --portal/);
});

test("discovery timeout aborts and reports", async () => {
  const pi = fakePi();
  const report = await registerNousProviders(pi.api, {
    env: { KXM_NOUS_PROVIDERS: "direct", NOUS_API_KEY: "k", KXM_NOUS_DISCOVERY_TIMEOUT_MS: "15" },
    fetch: (_url, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    }),
  });
  assert.equal(report.direct.error, "timeout");
  assert.match(report.guidance.map((item) => item.message).join("\n"), /timed out/);
});

test("pin registers known models and skips the rest; malformed pin is unused", async () => {
  const pi = fakePi();
  const report = await registerNousProviders(pi.api, {
    env: {
      KXM_NOUS_PROVIDERS: "direct",
      NOUS_API_KEY: "k",
      KXM_NOUS_CATALOG_FILE: pinPath,
    },
    fetch: async () => jsonResponse(idsOnly),
  });
  const models = pi.providers.get(NOUS_DIRECT_ID)?.models as Array<{ id: string }>;
  assert.deepEqual(models.map((model) => model.id).sort(), ["free-zero", "hermes-3"]);
  assert.ok(report.guidance.some((item) => /unknown-unpriced/.test(item.message)));

  const broken = fakePi();
  const bad = await registerNousProviders(broken.api, {
    env: {
      KXM_NOUS_PROVIDERS: "direct",
      NOUS_API_KEY: "k",
      KXM_NOUS_CATALOG_FILE: join(fixtureDir, "models-ids-only.json"),
    },
    fetch: async () => jsonResponse(idsOnly),
  });
  assert.ok(bad.guidance.some((item) => item.level === "error" && /catalog/.test(item.message)));
  assert.deepEqual(broken.providers.get(NOUS_DIRECT_ID)?.models, []);
});

test("no guidance contains a bearer or key", async () => {
  const pi = fakePi();
  const report = await registerNousProviders(pi.api, {
    env: {
      KXM_NOUS_PROVIDERS: "direct,proxy",
      NOUS_API_KEY: "sk-leaked-nous-value",
      KXM_NOUS_PROXY_URL: "http://127.0.0.1:8645/v1",
    },
    fetch: async () => jsonResponse({ error: "Bearer sk-leaked-nous-value" }, 401),
  });
  const blob = JSON.stringify(report);
  assert.equal(looksLikeSecret(blob), false);
  assert.doesNotMatch(blob, /sk-leaked/);
  assert.doesNotMatch(blob, /Bearer /);
});

test("helper brake still refuses nous/* and nous-proxy/*", () => {
  const request = {
    schema: REQUEST_SCHEMA,
    harness: "pi",
    role: "experiment",
    permission: "read-only",
    prompt_file: "prompt.md",
  };
  assert.throws(() => preflightRequest({ ...request, model: "nous/hermes-3" }), /openrouter/);
  assert.throws(() => preflightRequest({ ...request, model: "nous-proxy/hermes-3" }), /openrouter/);
});

test("factory is async when opted in so discovery finishes before list-models", async () => {
  await isolateEnv(async () => {
    process.env.KXM_NOUS_PROVIDERS = "direct";
    process.env.NOUS_API_KEY = "k";
    const pi = fakePi();
    let reportReady = false;
    const pending = nousFactoryWork(pi.api, () => {
      reportReady = true;
    }, {
      env: { KXM_NOUS_PROVIDERS: "direct", NOUS_API_KEY: "k" },
      fetch: async () => jsonResponse(withCapacity),
    });
    assert.equal(typeof (pending as Promise<void>)?.then, "function");
    await pending;
    assert.equal(reportReady, true);
    assert.equal(pi.providers.has(NOUS_DIRECT_ID), true);
  });
});

test("HTTP 429 and 401 stream errors classify as provider_quota and provider_error", async () => {
  const quota = assistantFailure([{
    role: "assistant",
    stopReason: "error",
    errorMessage: "HTTP 429 too many requests",
  }]);
  assert.equal(quota?.code, "provider_quota");
  const auth = assistantFailure([{
    role: "assistant",
    stopReason: "error",
    errorMessage: "HTTP 401 unauthorized",
  }]);
  assert.equal(auth?.code, "provider_error");
});

async function withSseServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected tcp address");
  try {
    await fn(`http://127.0.0.1:${address.port}/v1`);
  } finally {
    await new Promise<void>((close) => server.close(() => close()));
  }
}

function writeSse(res: ServerResponse, body: string): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.end(body);
}

async function loadPiAi(): Promise<{
  createProvider: (input: Record<string, unknown>) => { id: string };
  createModels: (options?: Record<string, unknown>) => {
    setProvider(provider: unknown): void;
    completeSimple(model: unknown, context: unknown): Promise<{
      content: Array<{ type: string; text?: string; name?: string; arguments?: unknown }>;
      stopReason: string;
      usage: { input: number; output: number; cost: { total: number } };
      errorMessage?: string;
    }>;
    getModel(provider: string, id: string): unknown;
  };
  openAICompletionsApi: () => unknown;
  InMemoryCredentialStore: new () => unknown;
}> {
  const core = await import(pathToFileURL(PI_AI).href) as Record<string, unknown>;
  const completions = await import(pathToFileURL(PI_AI_COMPLETIONS).href) as Record<string, unknown>;
  return { ...core, ...completions } as never;
}

test("installed Pi openai-completions transport streams text, tools, usage, and HTTP errors", async () => {
  const piAi = await loadPiAi();
  const sseText = readFileSync(join(fixtureDir, "sse-text.txt"), "utf8");
  const sseTool = readFileSync(join(fixtureDir, "sse-tool-call.txt"), "utf8");
  const sseUsage = readFileSync(join(fixtureDir, "sse-usage.txt"), "utf8");

  await withSseServer((req, res) => {
    if (req.url?.includes("/429/")) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "HTTP 429 rate limit" } }));
      return;
    }
    if (req.url?.includes("/401/")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "HTTP 401 unauthorized" } }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const payload = Buffer.concat(chunks).toString("utf8");
      if (payload.includes("tool-call")) writeSse(res, sseTool);
      else if (payload.includes("usage-only")) writeSse(res, sseUsage);
      else writeSse(res, sseText);
    });
  }, async (baseUrl) => {
    const store = new piAi.InMemoryCredentialStore();
    const models = piAi.createModels({ credentials: store });
    const cost = { input: 0.8, output: 2.4, cacheRead: 0.08, cacheWrite: 0.8 };
    const provider = piAi.createProvider({
      id: "nous",
      name: "Nous",
      baseUrl,
      auth: {
        apiKey: {
          name: "Nous API key",
          async resolve() {
            return { auth: { apiKey: "test-key" }, source: "test" };
          },
        },
      },
      models: [{
        id: "hermes-3",
        name: "Hermes 3",
        api: "openai-completions",
        provider: "nous",
        baseUrl,
        reasoning: false,
        input: ["text"],
        cost,
        contextWindow: 131072,
        maxTokens: 8192,
      }],
      api: piAi.openAICompletionsApi(),
    });
    models.setProvider(provider);
    const model = models.getModel("nous", "hermes-3");
    assert.ok(model);

    const text = await models.completeSimple(model, { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] });
    assert.equal(text.stopReason, "stop");
    const textBits = text.content.filter((part) => part.type === "text").map((part) => part.text).join("");
    assert.match(textBits, /Hello world/);
    assert.equal(text.usage.input, 12);
    assert.equal(text.usage.output, 4);
    assert.ok(text.usage.cost.total > 0);

    const tool = await models.completeSimple(model, {
      messages: [{ role: "user", content: [{ type: "text", text: "tool-call" }] }],
      tools: [{ name: "grep", description: "search", parameters: { type: "object", properties: { pattern: { type: "string" } } } }],
    });
    assert.equal(tool.stopReason, "toolUse");
    const call = tool.content.find((part) => part.type === "toolCall");
    assert.equal(call?.name, "grep");
    assert.deepEqual(call?.arguments, { pattern: "Nous" });

    const usage = await models.completeSimple(model, { messages: [{ role: "user", content: [{ type: "text", text: "usage-only" }] }] });
    assert.equal(usage.usage.input, 9);
    assert.equal(usage.usage.output, 1);

    const errorModels = piAi.createModels({ credentials: store });
    const quotaProvider = piAi.createProvider({
      id: "nous-429",
      name: "Nous",
      baseUrl: baseUrl.replace("/v1", "/429/v1"),
      auth: { apiKey: { name: "k", async resolve() { return { auth: { apiKey: "test-key" }, source: "test" }; } } },
      models: [{
        id: "hermes-3",
        name: "Hermes 3",
        api: "openai-completions",
        provider: "nous-429",
        baseUrl: baseUrl.replace("/v1", "/429/v1"),
        reasoning: false,
        input: ["text"],
        cost,
        contextWindow: 131072,
        maxTokens: 8192,
      }],
      api: piAi.openAICompletionsApi(),
    });
    errorModels.setProvider(quotaProvider);
    const quotaModel = errorModels.getModel("nous-429", "hermes-3");
    const quota = await errorModels.completeSimple(quotaModel, { messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] });
    assert.equal(quota.stopReason, "error");
    assert.equal(assistantFailure([quota])?.code, "provider_quota");

    const authProvider = piAi.createProvider({
      id: "nous-401",
      name: "Nous",
      baseUrl: baseUrl.replace("/v1", "/401/v1"),
      auth: { apiKey: { name: "k", async resolve() { return { auth: { apiKey: "test-key" }, source: "test" }; } } },
      models: [{
        id: "hermes-3",
        name: "Hermes 3",
        api: "openai-completions",
        provider: "nous-401",
        baseUrl: baseUrl.replace("/v1", "/401/v1"),
        reasoning: false,
        input: ["text"],
        cost,
        contextWindow: 131072,
        maxTokens: 8192,
      }],
      api: piAi.openAICompletionsApi(),
    });
    const authModels = piAi.createModels({ credentials: store });
    authModels.setProvider(authProvider);
    const authModel = authModels.getModel("nous-401", "hermes-3");
    const auth = await authModels.completeSimple(authModel, { messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] });
    assert.equal(auth.stopReason, "error");
    assert.equal(assistantFailure([auth])?.code, "provider_error");
  });
});
