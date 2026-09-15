// @ts-nocheck — fixture-driven vendor tests use partial Pi stream stubs.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piMeshExtension from "../../plugins/kxm/src/extension.ts";
import { looksLikeSecret, redactSecrets } from "../../plugins/kxm/src/redact.ts";
import {
  CLAUDE_BRIDGE_API,
  CLAUDE_BRIDGE_MODELS,
  MODEL_IDS_IN_ORDER,
  PROVIDER_ID,
  applyLongContext,
  claudeCodeModelId,
  registeredClaudeBridgeModels,
  resolveClaudeCodeRuntimeModel,
  resolveEffort,
  resolveModel,
} from "../../plugins/kxm/src/providers/claude-bridge/index.ts";
import {
  CLAUDE_BRIDGE_ALREADY_REGISTERED_WARNING,
  CLAUDE_BRIDGE_DOUBLE_REGISTRATION_WARNING,
  CLAUDE_BRIDGE_HOST_PROBE_METHODS,
  claudeBridgeConflictWarning,
  claudeBridgeRegistrationNotice,
  claudeBridgeStandaloneToolsPresent,
  registerClaudeBridgeProvider,
  shouldSkipClaudeBridgeRegistration,
} from "../../plugins/kxm/src/providers/claude-bridge/register.ts";
import { consumeQuery } from "../../plugins/kxm/src/providers/claude-bridge/stream.ts";
import { QueryContext } from "../../plugins/kxm/src/providers/claude-bridge/query-state.ts";
import { convertPiMessages, extractUserPrompt, extractUserPromptBlocks } from "../../plugins/kxm/src/providers/claude-bridge/convert.ts";
import { redactClaudeBridgeSecrets, looksLikeClaudeBridgeSecret } from "../../plugins/kxm/src/providers/claude-bridge/redact.ts";
import {
  streamClaudeBridge,
  resetClaudeBridgeSession,
  getClaudeBridgeSessionId,
  deliverToolResults,
  CC_CHILD_ENV,
} from "../../plugins/kxm/src/providers/claude-bridge/provider.ts";
import type { Model } from "../../plugins/kxm/src/providers/claude-bridge/pi-compat.ts";
import { loadConfig, longContextFromConfig, tryParseJson, claudeCodeSettings } from "../../plugins/kxm/src/providers/claude-bridge/config.ts";
import { makePromptStream, userMessage } from "../../plugins/kxm/src/providers/claude-bridge/prompt-stream.ts";
import {
  mapPiToolNameToSdk,
  mapToolArgs,
  pascalCase,
  piToolNameFor,
  MCP_TOOL_PREFIX,
  extractAllToolResults,
  resolveMcpTools,
} from "../../plugins/kxm/src/providers/claude-bridge/tools.ts";
import { assertObjectSchema, createToolServer } from "../../plugins/kxm/src/providers/claude-bridge/mcp-server.ts";
import { resetCtx } from "../../plugins/kxm/src/providers/claude-bridge/query-state.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "claude-bridge");

function fixture(name: string) {
  return readFileSync(join(fixtureDir, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

type ClaudeBridgeHostProbe = Pick<ExtensionAPI, (typeof CLAUDE_BRIDGE_HOST_PROBE_METHODS)[number]>;

function fakePi(options: { standaloneTools?: string[]; probeVia?: "getAllTools" | "getActiveTools" | "getCommands" } = {}) {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const providers = new Map<string, Record<string, unknown>>();
  const standalone = options.standaloneTools ?? [];
  const probeVia = options.probeVia ?? "getAllTools";
  const api = {
    on(name: string, handler: (...args: unknown[]) => unknown) {
      const existing = handlers.get(name) ?? [];
      existing.push(handler);
      handlers.set(name, existing);
    },
    registerTool() {},
    registerCommand() {},
    sendMessage() {},
    getSessionName() {
      return "claude-bridge-test";
    },
    getCommands() {
      return probeVia === "getCommands" ? standalone.map((name) => ({ name })) : [];
    },
    getAllTools() {
      return probeVia === "getAllTools" ? standalone.map((name) => ({ name })) : [];
    },
    getActiveTools() {
      return probeVia === "getActiveTools" ? [...standalone] : [];
    },
    registerProvider(name: string, config: Record<string, unknown>) {
      providers.set(name, config);
    },
  } as unknown as ExtensionAPI;
  const probe: ClaudeBridgeHostProbe = {
    getCommands: api.getCommands,
    getAllTools: api.getAllTools,
    getActiveTools: api.getActiveTools,
  };
  void probe;
  return {
    api,
    providers,
    async emit(name: string, ...args: unknown[]) {
      for (const handler of handlers.get(name) ?? []) await handler(...args);
    },
  };
}

const model: Model = {
  id: "claude-haiku-4-5",
  name: "Claude Haiku 4.5",
  api: CLAUDE_BRIDGE_API,
  provider: PROVIDER_ID,
  baseUrl: PROVIDER_ID,
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 32_000,
};

async function replay(name: string, toolNames = ["read"]) {
  const events: Array<{ type: string }> = [];
  const c = new QueryContext();
  c.currentPiStream = {
    push: (e: { type: string }) => events.push(e),
    end: () => events.push({ type: "end" }),
  } as unknown as QueryContext["currentPiStream"];
  c.resetTurnState(model);
  const customToolNameToPi = new Map(toolNames.map((n) => [`${MCP_TOOL_PREFIX}${n}`, n]));
  const messages = fixture(name);
  async function* stream() {
    for (const m of messages) yield m;
  }
  const { capturedSessionId } = await consumeQuery(
    stream() as AsyncIterable<{ type: string }>,
    customToolNameToPi,
    model,
    () => false,
    c,
  );
  return { events, ctx: c, capturedSessionId };
}

test("registration exposes the static catalog under provider id claude-bridge", () => {
  const pi = fakePi();
  const result = registerClaudeBridgeProvider(pi.api);
  assert.equal(result.registered, true);
  assert.equal(result.conflict, false);
  assert.equal(pi.providers.has("claude-bridge"), true);
  const config = pi.providers.get("claude-bridge");
  assert.equal(config?.name, "Claude Bridge");
  assert.equal(config?.api, "claude-bridge");
  assert.equal(config?.baseUrl, "claude-bridge");
  const models = config?.models as Array<{ id: string }>;
  const ids = models.map((entry) => entry.id);
  assert.deepEqual(ids, [...MODEL_IDS_IN_ORDER]);
  for (const expected of CLAUDE_BRIDGE_MODELS.map((entry) => entry.id)) {
    assert.ok(ids.includes(expected as string), `missing catalog model ${expected}`);
  }
});

test("registered models use measured context windows and zero subscription cost", () => {
  const models = registeredClaudeBridgeModels();
  const haiku = models.find((entry) => entry.id === "claude-haiku-4-5");
  const opus47 = models.find((entry) => entry.id === "claude-opus-4-7");
  assert.equal(haiku?.contextWindow, 200_000);
  assert.equal(opus47?.contextWindow, 1_000_000);
  assert.match(opus47?.name ?? "", /1M/);
  for (const entry of models) {
    assert.deepEqual(entry.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(entry.provider, "claude-bridge");
    assert.equal(entry.reasoning, true);
  }
});

test("thinking variants map reasoning to Agent SDK effort", () => {
  assert.equal(resolveEffort("minimal"), "low");
  assert.equal(resolveEffort("low"), "low");
  assert.equal(resolveEffort("medium"), "medium");
  assert.equal(resolveEffort("high"), "high");
  assert.equal(resolveEffort("xhigh"), "max");
  assert.equal(resolveEffort("xhigh", { xhigh: "xhigh", max: "max" }), "xhigh");
  assert.equal(resolveEffort(undefined), undefined);
  const opus = registeredClaudeBridgeModels().find((entry) => entry.id === "claude-opus-4-8");
  assert.equal(resolveEffort("xhigh", opus?.thinkingLevelMap), "xhigh");
  assert.equal(claudeCodeModelId({ id: "claude-opus-4-6" }, { plan: "pro", longContextExtraUsage: false }), "claude-opus-4-6");
  assert.equal(claudeCodeModelId({ id: "claude-opus-4-6" }, { plan: "max", longContextExtraUsage: false }), "claude-opus-4-6[1m]");
  assert.equal(
    resolveClaudeCodeRuntimeModel("claude-sonnet-4-6", { plan: "pro", longContextExtraUsage: true }).cliModelId,
    "claude-sonnet-4-6[1m]",
  );
  assert.equal(resolveModel(CLAUDE_BRIDGE_MODELS, "haiku")?.id, "claude-haiku-4-5");
  const labeled = applyLongContext([{ id: "claude-opus-5", name: "Claude Opus 5", contextWindow: 200_000 }], {
    plan: "pro",
    longContextExtraUsage: false,
  });
  assert.match(labeled[0]?.name ?? "", /1M/);
});

test("streaming adapter converts a recorded text fixture including thinking", async () => {
  const { ctx: query, events, capturedSessionId } = await replay("text");
  const text = query.turnOutput?.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const thinking = query.turnOutput?.content
    .filter((b) => b.type === "thinking")
    .map((b) => b.thinking)
    .join("");
  assert.equal(text?.trim(), "ALPHA");
  assert.match(thinking ?? "", /straightforward request/);
  assert.equal(query.turnOutput?.stopReason, "stop");
  assert.equal(query.turnSawToolCall, false);
  assert.ok(events.some((e) => e.type === "thinking_delta"));
  assert.ok(events.some((e) => e.type === "text_delta"));
  assert.ok((query.turnOutput?.usage.output ?? 0) > 0);
  assert.match(capturedSessionId ?? "", /^[0-9a-f-]{36}$/);
});

test("streaming adapter converts a recorded single-tool fixture to pi tool names", async () => {
  const { ctx: query } = await replay("single-tool");
  const calls = query.turnOutput?.content.filter((b) => b.type === "toolCall") ?? [];
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "read");
  assert.equal(query.turnSawToolCall, true);
  assert.equal(query.turnOutput?.stopReason, "toolUse");
});

test("unserved tool names never reach pi", async () => {
  const { ctx: query } = await replay("parallel-tools", []);
  assert.equal(query.turnOutput?.content.filter((b) => b.type === "toolCall").length, 0);
  assert.equal(query.turnSawToolCall, false);
});

test("parallel tool fixture keeps every served call", async () => {
  const { ctx: query } = await replay("parallel-tools");
  const calls = query.turnOutput?.content.filter((b) => b.type === "toolCall") ?? [];
  assert.ok(calls.length >= 2);
  assert.deepEqual(query.turnToolCallIds, calls.map((c) => c.id));
});

test("double-registration is skipped when AskClaude is present on a real host probe", async () => {
  const pi = fakePi({ standaloneTools: ["AskClaude"] });
  const result = registerClaudeBridgeProvider(pi.api);
  assert.equal(result.registered, false);
  assert.equal(result.conflict, true);
  assert.equal(result.warning, CLAUDE_BRIDGE_DOUBLE_REGISTRATION_WARNING);
  assert.equal(result.warning, claudeBridgeConflictWarning(false));
  assert.match(result.warning, /AskClaude tool is present/);
  assert.match(result.warning, /will not register provider id claude-bridge/);
  assert.doesNotMatch(result.warning, /already registered/);
  assert.equal(pi.providers.has("claude-bridge"), false);
  const notice = claudeBridgeRegistrationNotice(result);
  assert.equal(notice?.type, "warning");
  assert.equal(notice?.message, CLAUDE_BRIDGE_DOUBLE_REGISTRATION_WARNING);
  assert.match(notice?.message ?? "", /standalone pi-claude-bridge/);
  assert.match(notice?.message ?? "", /AskClaude/);
  assert.ok((notice?.message.length ?? 0) <= 400);

  const extensionPi = fakePi({ standaloneTools: ["AskClaude"] });
  piMeshExtension(extensionPi.api);
  assert.equal(extensionPi.providers.has("claude-bridge"), false);
});

test("standalone AskClaude on real host probes skips registration before KXM registers", () => {
  const standalone = fakePi({ standaloneTools: ["AskClaude"] });
  assert.equal(claudeBridgeStandaloneToolsPresent(standalone.api), true);
  assert.equal(shouldSkipClaudeBridgeRegistration(standalone.api), true);
  const skipped = registerClaudeBridgeProvider(standalone.api);
  assert.equal(skipped.registered, false);
  assert.equal(skipped.conflict, true);
  assert.equal(standalone.providers.has("claude-bridge"), false);
  const notice = claudeBridgeRegistrationNotice(skipped, standalone.api);
  assert.equal(notice?.message, CLAUDE_BRIDGE_DOUBLE_REGISTRATION_WARNING);
  assert.match(notice?.message ?? "", /will not register/);
  assert.doesNotMatch(notice?.message ?? "", /already registered/);

  const viaActive = fakePi({ standaloneTools: ["AskClaude"], probeVia: "getActiveTools" });
  assert.equal(claudeBridgeStandaloneToolsPresent(viaActive.api), true);
  const viaCommands = fakePi({ standaloneTools: ["AskClaude"], probeVia: "getCommands" });
  assert.equal(claudeBridgeStandaloneToolsPresent(viaCommands.api), true);
});

test("late AskClaude detection warns that KXM already registered", () => {
  const ours = fakePi();
  const registered = registerClaudeBridgeProvider(ours.api);
  assert.equal(registered.registered, true);
  assert.equal(registered.conflict, false);
  assert.equal(registered.warning, undefined);
  assert.equal(ours.providers.has("claude-bridge"), true);
  const lateStandalone = fakePi({ standaloneTools: ["AskClaude"] });
  const notice = claudeBridgeRegistrationNotice(registered, lateStandalone.api);
  assert.equal(notice?.type, "warning");
  assert.equal(notice?.message, CLAUDE_BRIDGE_ALREADY_REGISTERED_WARNING);
  assert.equal(notice?.message, claudeBridgeConflictWarning(true));
  assert.match(notice?.message ?? "", /AskClaude tool is present/);
  assert.match(notice?.message ?? "", /already registered provider id claude-bridge/);
  assert.match(notice?.message ?? "", /override or ambiguity/);
  assert.doesNotMatch(notice?.message ?? "", /will not register/);
  assert.ok((notice?.message.length ?? 0) <= 400);
});

test("no standalone detection emits no registration warning", () => {
  const clean = fakePi();
  const registered = registerClaudeBridgeProvider(clean.api);
  assert.equal(registered.registered, true);
  assert.equal(registered.conflict, false);
  assert.equal(claudeBridgeRegistrationNotice(registered), undefined);
  assert.equal(claudeBridgeRegistrationNotice(registered, clean.api), undefined);
  assert.equal(claudeBridgeRegistrationNotice(undefined), undefined);
  assert.equal(claudeBridgeRegistrationNotice(undefined, clean.api), undefined);
  const missingProvider = registerClaudeBridgeProvider({} as never);
  assert.equal(missingProvider.registered, false);
  assert.equal(missingProvider.conflict, false);
  assert.equal(claudeBridgeRegistrationNotice(missingProvider), undefined);
});

test("host probes used by the fake exist on Pi ExtensionAPI types", () => {
  const typesPath = fileURLToPath(
    new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts", import.meta.url),
  );
  const types = readFileSync(typesPath, "utf8");
  for (const method of CLAUDE_BRIDGE_HOST_PROBE_METHODS) {
    assert.match(types, new RegExp(`\\b${method}\\(`));
  }
  assert.doesNotMatch(types, /\bgetTools\(/);
  assert.doesNotMatch(types, /\bgetRegisteredProviderIds\(/);
  const registerSrc = readFileSync(
    fileURLToPath(new URL("../../plugins/kxm/src/providers/claude-bridge/register.ts", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(registerSrc, /\bgetTools\b/);
  assert.doesNotMatch(registerSrc, /\bgetRegisteredProviderIds\b/);
  assert.doesNotMatch(registerSrc, /\bmodelRegistry\b/);
  type _ProbeExists = Pick<ExtensionAPI, (typeof CLAUDE_BRIDGE_HOST_PROBE_METHODS)[number]>;
  const assigned: _ProbeExists = fakePi().api;
  assert.equal(typeof assigned.getAllTools, "function");
  assert.equal(typeof assigned.getActiveTools, "function");
  assert.equal(typeof assigned.getCommands, "function");
});

test("claude-bridge fixtures do not retain raw thinking signatures", () => {
  for (const name of ["text", "single-tool", "parallel-tools"]) {
    const raw = readFileSync(join(fixtureDir, `${name}.jsonl`), "utf8");
    assert.doesNotMatch(raw, /"signature":"[A-Za-z0-9+/=_-]{40,}"/);
  }
});

test("Anthropic session and Keychain secret shapes are redacted", () => {
  const apiKey = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD";
  const sessionJson = '{"sessionKey":"sk-ant-sid01-secretSessionMaterialValue"}';
  const env = "ANTHROPIC_API_KEY=sk-ant-api03-envvalue CLAUDE_API_KEY=sk-ant-oat01-xyz";
  for (const sample of [apiKey, sessionJson, env]) {
    const redacted = redactSecrets(sample);
    assert.equal(looksLikeSecret(sample), true, sample);
    assert.doesNotMatch(redacted, /sk-ant-api03-abcdefghijklmnopqrstuvwxyz/);
    assert.match(redacted, /\[redacted/);
    const local = redactClaudeBridgeSecrets(sample);
    assert.doesNotMatch(local, /sk-ant-api03-abcdefghijklmnopqrstuvwxyz/);
    assert.equal(looksLikeClaudeBridgeSecret(sample), true);
  }
  assert.equal(looksLikeClaudeBridgeSecret("plain text"), false);
});

test("convertPiMessages keeps claude-bridge thinking signatures and drops foreign ones", () => {
  const { anthropicMessages, dropped } = convertPiMessages([
    { role: "user", content: "hi", timestamp: 1 },
    {
      role: "assistant",
      provider: "claude-bridge",
      api: "claude-bridge",
      model: "claude-haiku-4-5",
      content: [
        { type: "thinking", thinking: "plan", thinkingSignature: "sig-ours" },
        { type: "text", text: "ok" },
      ],
      usage: model.cost && {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    },
    {
      role: "assistant",
      provider: "openrouter",
      api: "openai",
      model: "other",
      content: [{ type: "thinking", thinking: "foreign", thinkingSignature: "sig-other" }],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 3,
    },
  ] as never);
  const ours = anthropicMessages.find((m) => Array.isArray(m.content) && (m.content as Array<{ type: string }>).some((b) => b.type === "thinking"));
  assert.ok(ours);
  assert.equal(dropped.thinking, 1);
  assert.ok(dropped.providers.has("openrouter"));
});

test("tool name mapping and bash timeout default", () => {
  const map = new Map([["read", `${MCP_TOOL_PREFIX}read`]]);
  assert.equal(mapPiToolNameToSdk("read", map), `${MCP_TOOL_PREFIX}read`);
  assert.equal(mapPiToolNameToSdk("read"), "Read");
  assert.equal(pascalCase("my_custom_tool"), "MyCustomTool");
  assert.equal(piToolNameFor(`${MCP_TOOL_PREFIX}read`, new Map([[`${MCP_TOOL_PREFIX}read`, "read"]])), "read");
  assert.equal(mapToolArgs("read", { file_path: "/tmp/a" }).path, "/tmp/a");
  assert.equal(mapToolArgs("bash", { command: "ls" }).timeout, 120);
  assert.throws(() => mapPiToolNameToSdk(`${MCP_TOOL_PREFIX}read`));
});

test("config loads project over global and maps long-context flags", () => {
  const home = mkdtempSync(join(tmpdir(), "cb-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "cb-cwd-"));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "claude-bridge.json"),
    JSON.stringify({ provider: { plan: "pro", longContextExtraUsage: false } }),
  );
  writeFileSync(
    join(cwd, ".pi", "claude-bridge.json"),
    JSON.stringify({ provider: { plan: "max", longContextExtraUsage: true } }),
  );
  assert.deepEqual(tryParseJson(join(cwd, "missing.json")), {});
  const broken = join(cwd, "broken.json");
  writeFileSync(broken, "{");
  assert.deepEqual(tryParseJson(broken), {});
  const loaded = loadConfig(cwd, home);
  assert.equal(longContextFromConfig(loaded).plan, "max");
  assert.equal(longContextFromConfig(loaded).longContextExtraUsage, true);
  assert.deepEqual(claudeCodeSettings({ autoMemoryEnabled: true }), { autoMemoryEnabled: true });
  assert.deepEqual(claudeCodeSettings({}), { autoMemoryEnabled: false });
});

test("prompt stream acks after the consumer yields", async () => {
  const ps = makePromptStream();
  const written: string[] = [];
  const pumping = (async () => {
    for await (const msg of ps.stream) {
      written.push(String((msg.message.content as Array<{ text: string }>)[0]?.text));
    }
  })();
  await ps.push(userMessage([{ type: "text", text: "hello" }]));
  assert.deepEqual(written, ["hello"]);
  ps.end();
  await pumping;
});

test("MCP tool server refuses non-object schemas", () => {
  assert.throws(
    () =>
      createToolServer("custom-tools", [
        { name: "bad", description: "x", inputSchema: { type: "string" }, handler: async () => ({ content: [] }) },
      ]),
    /object schema/,
  );
  const server = createToolServer("custom-tools", [
    {
      name: "read",
      description: "read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
    },
  ]);
  assert.equal(server.type, "sdk");
  assert.equal(server.name, "custom-tools");
  assert.throws(
    () => assertObjectSchema({ name: "x", description: "", inputSchema: { type: "array" }, handler: async () => ({ content: [] }) }),
    /object schema/,
  );
});

test("streamClaudeBridge converts a mocked Agent SDK query without live calls", async () => {
  resetCtx();
  resetClaudeBridgeSession();
  const messages = fixture("text");
  const stream = streamClaudeBridge(
    model,
    { messages: [{ role: "user", content: "say ALPHA", timestamp: 1 }] },
    { reasoning: "low" },
    {
      query: () => {
        const iter = (async function* () {
          for (const message of messages) yield message;
        })();
        return Object.assign(iter, { interrupt: async () => {}, close() {} });
      },
      config: { provider: { plan: "pro" } },
    },
  );
  const events = [];
  for await (const event of stream) events.push(event);
  const done = events.find((event) => event.type === "done");
  assert.equal(done?.type, "done");
  if (done?.type === "done") {
    const text = done.message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    assert.equal(text.trim(), "ALPHA");
  }
  assert.equal(CC_CHILD_ENV.DISABLE_AUTO_COMPACT, "1");
  assert.match(getClaudeBridgeSessionId() ?? "", /^[0-9a-f-]{36}$/);
});

test("extract user prompt and tool results from context", () => {
  const messages = [
    { role: "user" as const, content: "one", timestamp: 1 },
    {
      role: "assistant" as const,
      content: [{ type: "toolCall" as const, id: "t1", name: "read", arguments: {} }],
      api: "claude-bridge",
      provider: "claude-bridge",
      model: "claude-haiku-4-5",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse" as const,
      timestamp: 2,
    },
    { role: "toolResult" as const, toolCallId: "t1", content: [{ type: "text" as const, text: "body" }], isError: false },
  ];
  assert.equal(extractUserPrompt(messages), null);
  const { results } = extractAllToolResults(messages);
  assert.equal(results[0]?.toolCallId, "t1");
  const imageTurn = [
    {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "see" },
        { type: "image" as const, data: "QQ==", mimeType: "image/png" },
      ],
      timestamp: 1,
    },
  ];
  const blocks = extractUserPromptBlocks(imageTurn);
  assert.equal(blocks?.[1]?.type, "image");
  const tools = resolveMcpTools({
    messages: [],
    tools: [{ name: "read", description: "r", parameters: { type: "object" } }],
  });
  assert.equal(tools.mcpTools.length, 1);
});

test("deliverToolResults resolves a parked MCP handler", async () => {
  const c = new QueryContext();
  const got = new Promise((resolve) => {
    c.pendingToolCalls.set("t1", { toolName: "read", resolve });
  });
  deliverToolResults(c, [{ toolCallId: "t1", content: [{ type: "text", text: "ok" }] }]);
  const result = await got;
  assert.equal((result as { content: Array<{ text: string }> }).content[0]?.text, "ok");
});
