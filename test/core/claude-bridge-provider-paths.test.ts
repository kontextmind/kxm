// @ts-nocheck — fixture-driven vendor tests use partial Pi stream stubs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  claudeBridgeRegistrationNotice,
  claudeBridgeStandaloneToolsPresent,
  registerClaudeBridgeProvider,
} from "../../plugins/kxm/src/providers/claude-bridge/register.ts";
import {
  describeRateLimitFailure,
  finalizeCurrentStream,
  mapStopReason,
  parsePartialJson,
  processAssistantMessage,
  resultErrorText,
  consumeQuery,
  updateUsage,
} from "../../plugins/kxm/src/providers/claude-bridge/stream.ts";
import { QueryContext, ctx, resetCtx } from "../../plugins/kxm/src/providers/claude-bridge/query-state.ts";
import {
  CLAUDE_BRIDGE_API,
  PROVIDER_ID,
  resolveClaudeCodeRuntimeModel,
} from "../../plugins/kxm/src/providers/claude-bridge/models.ts";
import type { Model } from "../../plugins/kxm/src/providers/claude-bridge/pi-compat.ts";
import {
  createAssistantMessageEventStream,
  emptyUsage,
} from "../../plugins/kxm/src/providers/claude-bridge/pi-compat.ts";
import {
  streamClaudeBridge,
  resetClaudeBridgeSession,
  setAgentSdkQueryForTests,
} from "../../plugins/kxm/src/providers/claude-bridge/provider.ts";
import { dispatchToolCall, TOOL_USE_ID_META } from "../../plugins/kxm/src/providers/claude-bridge/mcp-server.ts";
import { makePromptStream, userMessage } from "../../plugins/kxm/src/providers/claude-bridge/prompt-stream.ts";
import { convertPiMessages, alreadySdkToolName, messageContentToText } from "../../plugins/kxm/src/providers/claude-bridge/convert.ts";
import { globalConfigPath, projectConfigPath } from "../../plugins/kxm/src/providers/claude-bridge/config.ts";
import { MCP_TOOL_PREFIX } from "../../plugins/kxm/src/providers/claude-bridge/tools.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "claude-bridge");

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

test("streamClaudeBridge attaches an in-process MCP server for pi tools", async () => {
  resetCtx();
  resetClaudeBridgeSession();
  let captured: { options: Record<string, unknown> } | undefined;
  const messages = readFileSync(join(fixtureDir, "text.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const stream = streamClaudeBridge(
    model,
    {
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
      tools: [{ name: "read", description: "read", parameters: { type: "object", properties: {} } }],
      systemPrompt: "be brief",
    },
    { reasoning: "high", cwd: process.cwd() },
    {
      query: (args) => {
        captured = args;
        const iter = (async function* () {
          for (const message of messages) yield message;
        })();
        return Object.assign(iter, { interrupt: async () => {}, close() {} });
      },
      config: { provider: { strictMcpConfig: true, pathToClaudeCodeExecutable: "/bin/claude" } },
    },
  );
  for await (const _event of stream) {
    /* drain */
  }
  assert.ok(captured?.options.mcpServers);
  assert.equal(captured?.options.permissionMode, "bypassPermissions");
  assert.equal((captured?.options.extraArgs as { model?: string }).model, "claude-haiku-4-5");
});

test("register skips when registerProvider is missing and notices stay bounded", () => {
  const skipped = registerClaudeBridgeProvider({} as never);
  assert.equal(skipped.registered, false);
  assert.equal(skipped.conflict, false);
  assert.equal(claudeBridgeRegistrationNotice(undefined), undefined);
  const throwingAll = {
    getAllTools() {
      throw new Error("no tools");
    },
    getActiveTools() {
      throw new Error("no active tools");
    },
    getCommands() {
      throw new Error("no commands");
    },
  };
  assert.equal(claudeBridgeStandaloneToolsPresent(throwingAll), false);
  const viaActiveOnly = {
    getAllTools() {
      throw new Error("no tools");
    },
    getActiveTools() {
      return ["AskClaude"];
    },
    getCommands() {
      throw new Error("no commands");
    },
  };
  assert.equal(claudeBridgeStandaloneToolsPresent(viaActiveOnly), true);
});

test("unknown model ids default to 200K context", () => {
  const runtime = resolveClaudeCodeRuntimeModel("claude-mystery", { plan: "pro", longContextExtraUsage: false });
  assert.equal(runtime.contextWindow, 200_000);
  assert.equal(runtime.cliModelId, "claude-mystery");
});

test("assistant fallback path emits thinking and tool calls without stream_events", async () => {
  const c = new QueryContext();
  const events: Array<{ type: string }> = [];
  c.currentPiStream = {
    push: (e: { type: string }) => events.push(e),
    end: () => events.push({ type: "end" }),
  } as QueryContext["currentPiStream"];
  c.resetTurnState(model);
  processAssistantMessage(
    {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "hmm", signature: "sig" },
          { type: "text", text: "hi" },
          { type: "tool_use", id: "toolu_1", name: `${MCP_TOOL_PREFIX}read`, input: { file_path: "a.ts" } },
          { type: "tool_use", id: "toolu_x", name: "Bash", input: {} },
        ],
        usage: { input_tokens: 3, output_tokens: 2 },
      },
    },
    model,
    new Map([[`${MCP_TOOL_PREFIX}read`, "read"]]),
    c,
  );
  assert.equal(c.turnSawToolCall, true);
  assert.equal(c.turnOutput?.stopReason, "toolUse");
  assert.ok(events.some((e) => e.type === "thinking_start"));
  assert.ok(events.some((e) => e.type === "toolcall_end"));
  const call = c.turnOutput?.content.find((b) => b.type === "toolCall");
  assert.equal(call && call.type === "toolCall" ? call.arguments.path : undefined, "a.ts");
});

test("consumeQuery records result errors and rate-limit labels", async () => {
  const c = new QueryContext();
  c.currentPiStream = createAssistantMessageEventStream();
  c.resetTurnState(model);
  async function* stream() {
    yield { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1 } };
    yield { type: "rate_limit_event", rate_limit_info: { status: "allowed" } };
    yield { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", utilization: 0.81, surpassedThreshold: 0.8 } };
    yield { type: "result", subtype: "error", errors: ["capacity"] };
  }
  await consumeQuery(stream(), new Map(), model, () => false, c);
  assert.equal(c.turnOutput?.stopReason, "error");
  assert.match(c.turnOutput?.errorMessage ?? "", /capacity/);
});

test("consumeQuery success result without stream events becomes text", async () => {
  const c = new QueryContext();
  const events: Array<{ type: string }> = [];
  c.currentPiStream = {
    push: (e: { type: string }) => events.push(e),
    end: () => events.push({ type: "end" }),
  } as QueryContext["currentPiStream"];
  c.resetTurnState(model);
  async function* stream() {
    yield { type: "system", subtype: "init", session_id: "11111111-1111-4111-8111-111111111111" };
    yield { type: "result", subtype: "success", is_error: false, result: "DONE" };
  }
  const { capturedSessionId } = await consumeQuery(stream(), new Map(), model, () => false, c);
  assert.equal(capturedSessionId, "11111111-1111-4111-8111-111111111111");
  assert.equal(c.turnBlocks[0]?.text, "DONE");
});

test("consumeQuery stops when aborted", async () => {
  const c = new QueryContext();
  c.currentPiStream = createAssistantMessageEventStream();
  c.resetTurnState(model);
  let n = 0;
  async function* stream() {
    yield { type: "assistant", message: { content: [{ type: "text", text: "x" }] } };
    n += 1;
    yield { type: "result", subtype: "success", result: "nope" };
  }
  await consumeQuery(stream(), new Map(), model, () => true, c);
  assert.equal(n, 0);
});

test("resultErrorText and stop-reason mapping", () => {
  assert.equal(resultErrorText({ type: "result", subtype: "success", is_error: true, result: "boom" }), "boom");
  assert.equal(resultErrorText({ type: "result", subtype: "success", is_error: false }), undefined);
  assert.equal(resultErrorText({ type: "result", subtype: "error", error: "nope" }), "nope");
  assert.match(resultErrorText({ type: "result", subtype: "other" }) ?? "", /failed/);
  assert.equal(mapStopReason("tool_use"), "toolUse");
  assert.equal(mapStopReason("max_tokens"), "length");
  assert.equal(mapStopReason("end_turn"), "stop");
  assert.deepEqual(parsePartialJson("", { a: 1 }), { a: 1 });
  assert.deepEqual(parsePartialJson("{", { a: 1 }), { a: 1 });
  assert.deepEqual(parsePartialJson('{"b":2}', { a: 1 }), { b: 2 });
  assert.match(describeRateLimitFailure({ rateLimitType: "five_hour", resetsAt: 1 }, "x"), /Claude rate limit/);
  const usage = emptyUsage();
  updateUsage({ usage } as never, { input_tokens: 1, output_tokens: 2, thinking_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 5 });
  assert.equal(usage.reasoning, 3);
  assert.equal(usage.totalTokens, 12);
});

test("finalizeCurrentStream emits error vs stop", () => {
  const c = new QueryContext();
  const events: Array<{ type: string }> = [];
  c.currentPiStream = {
    push: (e: { type: string }) => events.push(e),
    end: () => events.push({ type: "end" }),
  } as QueryContext["currentPiStream"];
  c.resetTurnState(model);
  c.turnOutput!.stopReason = "error";
  finalizeCurrentStream(c, "error");
  assert.ok(events.some((e) => e.type === "error"));
  const d = new QueryContext();
  d.currentPiStream = {
    push: (e: { type: string }) => events.push(e),
    end: () => events.push({ type: "end" }),
  } as QueryContext["currentPiStream"];
  d.resetTurnState(model);
  finalizeCurrentStream(d, "length");
  assert.ok(events.some((e) => e.type === "done"));
});

test("orphaned tool result ends the stream without a live query", async () => {
  resetCtx();
  resetClaudeBridgeSession();
  const stream = streamClaudeBridge(model, {
    messages: [{ role: "toolResult", toolCallId: "missing", content: [{ type: "text", text: "x" }], isError: false }],
  });
  const events = [];
  for await (const event of stream) events.push(event);
  assert.ok(events.some((event) => event.type === "done"));
});

test("streamClaudeBridge abort pushes an aborted error", async () => {
  resetCtx();
  resetClaudeBridgeSession();
  const controller = new AbortController();
  controller.abort();
  const stream = streamClaudeBridge(
    model,
    { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    { signal: controller.signal },
    {
      query: () => {
        const iter = (async function* () {
          yield { type: "assistant", message: { content: [{ type: "text", text: "x" }] } };
        })();
        return Object.assign(iter, { interrupt: async () => {}, close() {} });
      },
      config: {},
    },
  );
  const events = [];
  for await (const event of stream) events.push(event);
  assert.ok(events.some((event) => event.type === "error"));
});

test("streamClaudeBridge query throw becomes a stream error", async () => {
  resetCtx();
  resetClaudeBridgeSession();
  const stream = streamClaudeBridge(
    model,
    { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    undefined,
    {
      query: () => {
        const iter = (async function* () {
          throw new Error("sdk down");
        })();
        return Object.assign(iter, { interrupt: async () => {}, close() {} });
      },
      config: { provider: { pathToClaudeCodeExecutable: "/usr/bin/claude", strictMcpConfig: false } },
    },
  );
  const events = [];
  for await (const event of stream) events.push(event);
  assert.ok(events.some((event) => event.type === "error"));
});

test("dispatchToolCall pairs on Claude Code toolUseId meta", async () => {
  const byName = new Map([
    [
      "read",
      {
        name: "read",
        description: "r",
        inputSchema: { type: "object" },
        handler: async (id: string) => ({ content: [{ type: "text", text: id }] }),
      },
    ],
  ]);
  await assert.rejects(dispatchToolCall(byName, { params: { name: "missing" } }), /Unknown tool/);
  await assert.rejects(dispatchToolCall(byName, { params: { name: "read" } }), /toolUseId/);
  const result = await dispatchToolCall(byName, {
    params: { name: "read", _meta: { [TOOL_USE_ID_META]: "toolu_9" } },
  });
  assert.equal((result.content[0] as { text: string }).text, "toolu_9");
});

test("prompt stream fail rejects queued pushes", async () => {
  const ps = makePromptStream();
  const pending = ps.push(userMessage("x"));
  ps.fail(new Error("dead"));
  await assert.rejects(pending, /dead/);
  await assert.rejects(ps.push(userMessage("y")), /dead/);
});

test("convert helpers cover empty and image-less content", () => {
  assert.equal(messageContentToText("hi"), "hi");
  assert.equal(messageContentToText([{ type: "text", text: "a" }, { type: "other" } as never]), "a\n[other]");
  assert.equal(alreadySdkToolName(`${MCP_TOOL_PREFIX}read`), true);
  const converted = convertPiMessages([
    { role: "user", content: "", timestamp: 1 },
    {
      role: "assistant",
      provider: "claude-bridge",
      api: "claude-bridge",
      model: "x",
      content: [],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "aborted",
      timestamp: 2,
    },
    {
      role: "assistant",
      provider: "claude-bridge",
      api: "claude-bridge",
      model: "x",
      content: [{ type: "toolCall", id: "id/with spaces", name: "read", arguments: { path: "a" } }],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 3,
    },
    {
      role: "toolResult",
      toolCallId: "id/with spaces",
      content: [
        { type: "text", text: "shot" },
        { type: "image", data: "QQ==", mimeType: "image/png" },
      ],
      isError: false,
    },
  ]);
  assert.ok(converted.dropped.abortedTurns >= 1);
  assert.ok(converted.sanitizedIds.size >= 1);
  assert.match(globalConfigPath("/tmp/home"), /claude-bridge.json/);
  assert.match(projectConfigPath("/tmp/proj"), /\.pi/);
});

test("QueryContext turnBlocks throws before reset and releasePendingToolCalls resolves", async () => {
  const c = new QueryContext();
  assert.throws(() => c.turnBlocks, /resetTurnState/);
  const parked = new Promise((resolve) => {
    c.pendingToolCalls.set("z", { toolName: "read", resolve });
  });
  c.releasePendingToolCalls("gone");
  const result = await parked;
  assert.match(JSON.stringify(result), /gone/);
  resetCtx();
  assert.equal(ctx().activeQuery, null);
  setAgentSdkQueryForTests(undefined);
});

test("pi-compat stream result() resolves on done", async () => {
  const stream = createAssistantMessageEventStream();
  const pending = stream.result();
  stream.push({
    type: "done",
    reason: "stop",
    message: {
      role: "assistant",
      content: [],
      api: "claude-bridge",
      provider: "claude-bridge",
      model: "x",
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: 1,
    },
  });
  const message = await pending;
  assert.equal(message.stopReason, "stop");
});
