// @ts-nocheck — vendored snapshot; host tsconfig is stricter than upstream.
import { createRequire } from "node:module";
import type { Context, Model, SimpleStreamOptions } from "./pi-compat.ts";
import { createAssistantMessageEventStream, type AssistantMessageEventStream } from "./pi-compat.ts";
import {
  claudeCodeModelId,
  DEFAULT_LONG_CONTEXT,
  resolveEffort,
  type LongContextSettings,
} from "./models.ts";
import { claudeCodeSettings, loadConfig, longContextFromConfig, type ClaudeBridgeConfig } from "./config.ts";
import { extractUserPrompt, extractUserPromptBlocks } from "./convert.ts";
import { createToolServer } from "./mcp-server.ts";
import { makePromptStream, userMessage } from "./prompt-stream.ts";
import { QueryContext, ctx } from "./query-state.ts";
import {
  claimCurrentPiStream,
  consumeQuery,
  finalizeCurrentStream,
  markStreamComplete,
} from "./stream.ts";
import {
  extractAllToolResults,
  MCP_SERVER_NAME,
  resolveMcpTools,
  type McpResult,
} from "./tools.ts";

export const CC_CHILD_ENV = {
  ENABLE_CLAUDEAI_MCP_SERVERS: "0",
  DISABLE_AUTO_COMPACT: "1",
} as const;

export const CLAUDE_MD_EXCLUDES = ["**/CLAUDE.md", "**/.claude/rules/**"];

const require = createRequire(import.meta.url);
const activeQueryContexts = new Set<QueryContext>();

export type QueryHandle = AsyncIterable<unknown> & {
  interrupt?: () => Promise<unknown> | unknown;
  close?: () => void;
};

export type QueryFactory = (args: { prompt: unknown; options: Record<string, unknown> }) => QueryHandle;

export type StreamDeps = {
  query?: QueryFactory;
  config?: ClaudeBridgeConfig;
  longContext?: LongContextSettings;
  nowCwd?: () => string;
};

let lastSessionId: string | undefined;

export function resetClaudeBridgeSession(): void {
  lastSessionId = undefined;
  activeQueryContexts.clear();
}

export function getClaudeBridgeSessionId(): string | undefined {
  return lastSessionId;
}

function buildMcpServers(tools: Context["tools"], queryCtx: QueryContext) {
  if (!tools?.length) return undefined;
  const mcpTools = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
    handler: async (toolCallId: string) => {
      if (queryCtx.pendingResults.has(toolCallId)) {
        const result = queryCtx.pendingResults.get(toolCallId)!;
        queryCtx.pendingResults.delete(toolCallId);
        return result;
      }
      return new Promise<McpResult>((resolve) => {
        queryCtx.pendingToolCalls.set(toolCallId, { toolName: tool.name, resolve });
      });
    },
  }));
  return { [MCP_SERVER_NAME]: createToolServer(MCP_SERVER_NAME, mcpTools) };
}

export function deliverToolResults(c: QueryContext, results: McpResult[]): void {
  for (const result of results) {
    const id = result.toolCallId;
    if (id && c.pendingToolCalls.has(id)) {
      const pending = c.pendingToolCalls.get(id)!;
      c.pendingToolCalls.delete(id);
      pending.resolve(result);
    } else if (id) {
      c.pendingResults.set(id, result);
    }
  }
}

function contextForToolResults(results: McpResult[]): QueryContext | undefined {
  for (const result of results) {
    const id = result.toolCallId;
    if (!id) continue;
    for (const queryCtx of activeQueryContexts) {
      if (
        queryCtx.pendingToolCalls.has(id) ||
        queryCtx.pendingResults.has(id) ||
        queryCtx.turnToolCallIds.includes(id)
      ) {
        return queryCtx;
      }
    }
  }
  return undefined;
}

let cachedQuery: QueryFactory | undefined;

function loadAgentSdkQuery(): QueryFactory {
  if (cachedQuery) return cachedQuery;
  const mod = require("@anthropic-ai/claude-agent-sdk") as { query: QueryFactory };
  cachedQuery = (args) => mod.query(args);
  return cachedQuery;
}

export function setAgentSdkQueryForTests(factory: QueryFactory | undefined): void {
  cachedQuery = factory;
}

export function streamClaudeBridge(
  model: Model,
  context: Context,
  options?: SimpleStreamOptions,
  deps: StreamDeps = {},
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const lastMsg = context.messages[context.messages.length - 1];
  const allResults = activeQueryContexts.size > 0 ? extractAllToolResults(context.messages).results : [];
  const resultCtx = allResults.length > 0 ? contextForToolResults(allResults) : undefined;

  if (resultCtx) {
    claimCurrentPiStream(stream, "tool-result", resultCtx);
    resultCtx.resetTurnState(model);
    deliverToolResults(resultCtx, allResults);
    resultCtx.latestCursor = Math.max(resultCtx.latestCursor, context.messages.length);
    return stream;
  }

  if (lastMsg?.role === "toolResult") {
    const c = new QueryContext();
    c.resetTurnState(model);
    queueMicrotask(() => {
      stream.push({ type: "done", reason: "stop", message: c.turnOutput });
      markStreamComplete(stream);
      stream.end();
    });
    return stream;
  }

  const queryCtx = ctx().activeQuery !== null ? new QueryContext() : ctx();
  const { mcpTools, customToolNameToPi } = resolveMcpTools(context);
  claimCurrentPiStream(stream, "fresh-query", queryCtx);
  queryCtx.pendingToolCalls.clear();
  queryCtx.pendingResults.clear();
  queryCtx.turnToolCallIds = [];
  queryCtx.resetTurnState(model);

  const cwd = options?.cwd ?? deps.nowCwd?.() ?? process.cwd();
  const config = deps.config ?? loadConfig(cwd);
  const longContext = deps.longContext ?? longContextFromConfig(config);
  const cliModel = claudeCodeModelId(model, longContext);
  const promptBlocks = extractUserPromptBlocks(context.messages);
  let promptText = extractUserPrompt(context.messages) ?? "";
  if (!promptText && !promptBlocks) promptText = "[continue]";

  const promptStream = makePromptStream();
  void promptStream.push(userMessage(promptBlocks ?? [{ type: "text", text: promptText }])).catch(() => {});
  queryCtx.promptStream = promptStream;
  const mcpServers = buildMcpServers(mcpTools, queryCtx);
  const effort = resolveEffort(options?.reasoning, model.thinkingLevelMap);
  const extraArgs: Record<string, string | null> = { model: cliModel };
  if (config.provider?.strictMcpConfig !== false) extraArgs["strict-mcp-config"] = null;
  if (effort) extraArgs["thinking-display"] = "summarized";

  const queryOptions: Record<string, unknown> = {
    cwd,
    env: { ...process.env, ...CC_CHILD_ENV },
    tools: [],
    permissionMode: "bypassPermissions",
    includePartialMessages: true,
    settings: {
      ...claudeCodeSettings(config.provider),
      claudeMdExcludes: CLAUDE_MD_EXCLUDES,
      includeGitInstructions: false,
    },
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: context.systemPrompt,
    },
    extraArgs,
    ...(effort ? { effort } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    ...(lastSessionId ? { resume: lastSessionId } : {}),
    ...(config.provider?.pathToClaudeCodeExecutable
      ? { pathToClaudeCodeExecutable: config.provider.pathToClaudeCodeExecutable }
      : {}),
  };

  const queryFn = deps.query ?? loadAgentSdkQuery();
  let wasAborted = false;
  const sdkQuery = queryFn({ prompt: promptStream.stream, options: queryOptions });
  queryCtx.activeQuery = sdkQuery;
  activeQueryContexts.add(queryCtx);

  const onAbort = () => {
    wasAborted = true;
    promptStream.fail(new Error("Operation aborted"));
    queryCtx.releasePendingToolCalls("Operation aborted");
    void sdkQuery.interrupt?.();
    try {
      sdkQuery.close?.();
    } catch {
      /* ignore */
    }
  };
  if (options?.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  consumeQuery(sdkQuery as AsyncIterable<any>, customToolNameToPi, model, () => wasAborted, queryCtx)
    .then(({ capturedSessionId }) => {
      if (wasAborted || options?.signal?.aborted) {
        if (queryCtx.turnOutput) {
          queryCtx.turnOutput.stopReason = "aborted";
          queryCtx.turnOutput.errorMessage = "Operation aborted";
        }
        const current = queryCtx.currentPiStream;
        current?.push({ type: "error", reason: "aborted", error: queryCtx.turnOutput });
        markStreamComplete(current);
        current?.end();
        queryCtx.currentPiStream = null;
        return;
      }
      if (capturedSessionId) lastSessionId = capturedSessionId;
      if (queryCtx.activeQuery === sdkQuery) queryCtx.activeQuery = null;
      finalizeCurrentStream(queryCtx, queryCtx.turnOutput?.stopReason);
    })
    .catch((error) => {
      promptStream.fail(error instanceof Error ? error : new Error(String(error)));
      if (queryCtx.turnOutput) {
        queryCtx.turnOutput.stopReason = options?.signal?.aborted ? "aborted" : "error";
        queryCtx.turnOutput.errorMessage ??= error instanceof Error ? error.message : String(error);
      }
      if (queryCtx.activeQuery === sdkQuery) {
        queryCtx.releasePendingToolCalls("Query ended");
        queryCtx.activeQuery = null;
      }
      const current = queryCtx.currentPiStream;
      current?.push({
        type: "error",
        reason: queryCtx.turnOutput?.stopReason ?? "error",
        error: queryCtx.turnOutput,
      });
      markStreamComplete(current);
      current?.end();
      queryCtx.currentPiStream = null;
    })
    .finally(() => {
      options?.signal?.removeEventListener("abort", onAbort);
      promptStream.fail(new Error("query ended"));
      if (queryCtx.promptStream === promptStream) queryCtx.promptStream = null;
      if (queryCtx.activeQuery === sdkQuery || queryCtx.activeQuery === null) {
        queryCtx.releasePendingToolCalls("Query ended");
        queryCtx.activeQuery = null;
        activeQueryContexts.delete(queryCtx);
      }
      try {
        sdkQuery.close?.();
      } catch {
        /* ignore */
      }
    });

  return stream;
}

export { DEFAULT_LONG_CONTEXT };
