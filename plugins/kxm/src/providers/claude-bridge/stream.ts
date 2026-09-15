// @ts-nocheck — vendored snapshot; host tsconfig is stricter than upstream.
import type { AssistantMessage, AssistantMessageEventStream, Model } from "./pi-compat.ts";
import { QueryContext } from "./query-state.ts";
import { mapToolArgs, piToolNameFor } from "./tools.ts";

export type SdkMessage = {
  type: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  errors?: unknown;
  error?: unknown;
  event?: Record<string, any>;
  message?: { content?: Array<Record<string, any>>; usage?: Record<string, number | undefined> };
  session_id?: string;
  rate_limit_info?: {
    status?: string;
    rateLimitType?: string;
    resetsAt?: number;
    utilization?: number;
    surpassedThreshold?: number;
  };
  modelUsage?: Record<string, { contextWindow?: number; maxOutputTokens?: number }>;
};

const completedStreams = new WeakSet<object>();

export function markStreamComplete(stream: AssistantMessageEventStream | null): void {
  if (stream) completedStreams.add(stream as object);
}

export function claimCurrentPiStream(
  stream: AssistantMessageEventStream,
  _label: string,
  c: QueryContext,
): void {
  c.currentPiStream = stream;
}

export function ensureTurnStarted(c: QueryContext): void {
  if (!c.turnStarted && c.currentPiStream && c.turnOutput) {
    c.currentPiStream.push({ type: "start", partial: c.turnOutput });
    c.turnStarted = true;
  }
}

export function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
  switch (reason) {
    case "tool_use":
      return "toolUse";
    case "max_tokens":
      return "length";
    default:
      return "stop";
  }
}

export function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!input) return fallback;
  try {
    return JSON.parse(input);
  } catch {
    return fallback;
  }
}

export function updateUsage(
  output: AssistantMessage,
  usage: Record<string, number | undefined>,
  _model?: Model,
): void {
  if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
  if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
  if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
  if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
  const reasoning = usage.reasoning_tokens ?? usage.thinking_tokens;
  if (reasoning != null) output.usage.reasoning = reasoning;
  output.usage.totalTokens =
    output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
}

export function resultErrorText(message: SdkMessage): string | undefined {
  if (message.subtype === "success") {
    return message.is_error ? message.result || "Claude Code reported an error" : undefined;
  }
  if (Array.isArray(message.errors) && message.errors.length) return message.errors.map(String).join("\n");
  if (typeof message.error === "string") return message.error;
  if (message.type === "result") return `Claude Code failed: ${message.subtype ?? "unknown result"}`;
  return undefined;
}

export function describeRateLimitFailure(
  rejection: { rateLimitType?: string; resetsAt?: number },
  failure: string,
): string {
  const kind = rejection.rateLimitType ? ` (${rejection.rateLimitType})` : "";
  const resets = rejection.resetsAt
    ? ` — resets ${new Date(rejection.resetsAt * 1000).toLocaleTimeString()}`
    : "";
  return `Claude rate limit${kind}${resets}: ${failure}`;
}

export function finalizeCurrentStream(c: QueryContext, stopReason?: string): void {
  if (!c.currentPiStream || !c.turnOutput) return;
  if (!c.turnStarted) ensureTurnStarted(c);
  const stream = c.currentPiStream;
  if (c.turnOutput.stopReason === "error") {
    stream.push({ type: "error", reason: "error", error: c.turnOutput });
  } else {
    const reason = stopReason === "length" ? "length" : "stop";
    stream.push({ type: "done", reason, message: c.turnOutput });
  }
  markStreamComplete(stream);
  stream.end();
  c.currentPiStream = null;
}

export function processStreamEvent(
  message: SdkMessage,
  customToolNameToPi: Map<string, string>,
  model: Model,
  c: QueryContext,
): void {
  if (!c.currentPiStream || !c.turnOutput) return;
  c.turnSawStreamEvent = true;
  const event = message.event;
  if (!event) return;

  if (event.type === "message_start") {
    c.turnToolCallIds = [];
    if (event.message?.usage) updateUsage(c.turnOutput, event.message.usage, model);
    return;
  }

  if (event.type === "content_block_start") {
    ensureTurnStarted(c);
    if (event.content_block?.type === "text") {
      c.turnBlocks.push({ type: "text", text: "", index: event.index });
      c.currentPiStream.push({ type: "text_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
    } else if (event.content_block?.type === "thinking") {
      c.turnBlocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
      c.currentPiStream.push({
        type: "thinking_start",
        contentIndex: c.turnBlocks.length - 1,
        partial: c.turnOutput,
      });
    } else if (event.content_block?.type === "tool_use") {
      const piName = piToolNameFor(event.content_block.name, customToolNameToPi);
      if (!piName) return;
      c.turnSawToolCall = true;
      c.turnToolCallIds.push(event.content_block.id);
      c.turnBlocks.push({
        type: "toolCall",
        id: event.content_block.id,
        name: piName,
        arguments: event.content_block.input ?? {},
        partialJson: "",
        index: event.index,
      });
      c.currentPiStream.push({
        type: "toolcall_start",
        contentIndex: c.turnBlocks.length - 1,
        partial: c.turnOutput,
      });
    }
    return;
  }

  if (event.type === "content_block_delta") {
    const index = c.turnBlocks.findIndex((b) => b.index === event.index);
    const block = c.turnBlocks[index];
    if (!block) return;
    if (event.delta?.type === "text_delta" && block.type === "text") {
      block.text += event.delta.text;
      c.currentPiStream.push({
        type: "text_delta",
        contentIndex: index,
        delta: event.delta.text,
        partial: c.turnOutput,
      });
    } else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
      block.thinking += event.delta.thinking;
      c.currentPiStream.push({
        type: "thinking_delta",
        contentIndex: index,
        delta: event.delta.thinking,
        partial: c.turnOutput,
      });
    } else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
      block.partialJson += event.delta.partial_json;
      block.arguments = parsePartialJson(block.partialJson, block.arguments);
      c.currentPiStream.push({
        type: "toolcall_delta",
        contentIndex: index,
        delta: event.delta.partial_json,
        partial: c.turnOutput,
      });
    } else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
      block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
    }
    return;
  }

  if (event.type === "content_block_stop") {
    const index = c.turnBlocks.findIndex((b) => b.index === event.index);
    const block = c.turnBlocks[index];
    if (!block) return;
    delete block.index;
    if (block.type === "text") {
      c.currentPiStream.push({ type: "text_end", contentIndex: index, content: block.text, partial: c.turnOutput });
    } else if (block.type === "thinking") {
      c.currentPiStream.push({
        type: "thinking_end",
        contentIndex: index,
        content: block.thinking,
        partial: c.turnOutput,
      });
    } else if (block.type === "toolCall") {
      c.turnSawToolCall = true;
      block.arguments = mapToolArgs(block.name, parsePartialJson(block.partialJson, block.arguments));
      delete block.partialJson;
      c.currentPiStream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: c.turnOutput });
    }
    return;
  }

  if (event.type === "message_delta") {
    c.turnOutput.stopReason = mapStopReason(event.delta?.stop_reason);
    if (event.usage) updateUsage(c.turnOutput, event.usage, model);
    return;
  }

  if (event.type === "message_stop" && c.turnSawToolCall) {
    c.turnOutput.stopReason = "toolUse";
    const stream = c.currentPiStream;
    stream.push({ type: "done", reason: "toolUse", message: c.turnOutput });
    markStreamComplete(stream);
    stream.end();
    c.currentPiStream = null;
  }
}

export function processAssistantMessage(
  message: SdkMessage,
  model: Model,
  customToolNameToPi: Map<string, string>,
  c: QueryContext,
): void {
  if (c.turnSawStreamEvent) return;
  const assistantMsg = message.message;
  if (!assistantMsg?.content) return;
  c.turnToolCallIds = [];
  for (const block of assistantMsg.content) {
    if (block.type === "text" && block.text) {
      ensureTurnStarted(c);
      c.turnBlocks.push({ type: "text", text: block.text });
      const idx = c.turnBlocks.length - 1;
      c.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: c.turnOutput });
      c.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: block.text, partial: c.turnOutput });
      c.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: block.text, partial: c.turnOutput });
    } else if (block.type === "thinking") {
      ensureTurnStarted(c);
      c.turnBlocks.push({
        type: "thinking",
        thinking: block.thinking ?? "",
        thinkingSignature: block.signature ?? "",
      });
      const idx = c.turnBlocks.length - 1;
      c.currentPiStream?.push({ type: "thinking_start", contentIndex: idx, partial: c.turnOutput });
      if (block.thinking) {
        c.currentPiStream?.push({
          type: "thinking_delta",
          contentIndex: idx,
          delta: block.thinking,
          partial: c.turnOutput,
        });
      }
      c.currentPiStream?.push({
        type: "thinking_end",
        contentIndex: idx,
        content: block.thinking ?? "",
        partial: c.turnOutput,
      });
    } else if (block.type === "tool_use") {
      const piName = piToolNameFor(block.name, customToolNameToPi);
      if (!piName) continue;
      ensureTurnStarted(c);
      c.turnSawToolCall = true;
      c.turnToolCallIds.push(block.id);
      c.turnBlocks.push({
        type: "toolCall",
        id: block.id,
        name: piName,
        arguments: mapToolArgs(piName, block.input),
      });
      const idx = c.turnBlocks.length - 1;
      c.currentPiStream?.push({ type: "toolcall_start", contentIndex: idx, partial: c.turnOutput });
      c.currentPiStream?.push({ type: "toolcall_end", contentIndex: idx, toolCall: c.turnBlocks[idx], partial: c.turnOutput });
    }
  }
  if (assistantMsg.usage && c.turnOutput) updateUsage(c.turnOutput, assistantMsg.usage, model);
  if (c.turnSawToolCall && c.currentPiStream && c.turnOutput) {
    c.turnOutput.stopReason = "toolUse";
    const stream = c.currentPiStream;
    stream.push({ type: "done", reason: "toolUse", message: c.turnOutput });
    markStreamComplete(stream);
    stream.end();
    c.currentPiStream = null;
  }
}

export async function consumeQuery(
  sdkQuery: AsyncIterable<SdkMessage>,
  customToolNameToPi: Map<string, string>,
  model: Model,
  wasAborted: () => boolean,
  queryCtx: QueryContext,
): Promise<{ capturedSessionId?: string }> {
  let capturedSessionId: string | undefined;

  for await (const message of sdkQuery) {
    if (wasAborted()) break;
    let resultError: string | undefined;
    if (message.type === "result") {
      queryCtx.promptStream?.end();
      resultError = resultErrorText(message);
      if (resultError !== undefined) {
        if (queryCtx.rateLimitRejection) {
          resultError = describeRateLimitFailure(queryCtx.rateLimitRejection, resultError);
          queryCtx.rateLimitRejection = null;
        }
        if (queryCtx.turnOutput) {
          queryCtx.turnOutput.stopReason = "error";
          queryCtx.turnOutput.errorMessage = resultError;
        }
      }
    }
    if (message.type === "rate_limit_event") {
      const info = message.rate_limit_info;
      if (info?.status === "rejected") {
        queryCtx.rateLimitRejection = info;
        queryCtx.lastRateLimitWarnStep = null;
        queryCtx.lastRateLimitWarnThreshold = undefined;
      } else if (info?.status === "allowed") {
        queryCtx.lastRateLimitWarnStep = null;
        queryCtx.lastRateLimitWarnThreshold = undefined;
      } else if (info?.status === "allowed_warning") {
        const percent = Math.round((info.utilization ?? 0) * 100);
        const step = Math.floor(percent / 5);
        const rose = queryCtx.lastRateLimitWarnStep === null || step > queryCtx.lastRateLimitWarnStep;
        if (rose || info.surpassedThreshold !== queryCtx.lastRateLimitWarnThreshold) {
          queryCtx.lastRateLimitWarnStep = step;
          queryCtx.lastRateLimitWarnThreshold = info.surpassedThreshold;
        }
      }
      continue;
    }
    if (!queryCtx.currentPiStream || !queryCtx.turnOutput) continue;

    switch (message.type) {
      case "stream_event":
        processStreamEvent(message, customToolNameToPi, model, queryCtx);
        break;
      case "assistant":
        processAssistantMessage(message, model, customToolNameToPi, queryCtx);
        break;
      case "result": {
        if (resultError === undefined && !queryCtx.turnSawStreamEvent && message.subtype === "success") {
          ensureTurnStarted(queryCtx);
          const text = message.result || "";
          queryCtx.turnBlocks.push({ type: "text", text });
          const idx = queryCtx.turnBlocks.length - 1;
          queryCtx.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: queryCtx.turnOutput });
          queryCtx.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: text, partial: queryCtx.turnOutput });
          queryCtx.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: text, partial: queryCtx.turnOutput });
        }
        break;
      }
      case "system":
        if (message.subtype === "init" && (message as { session_id?: string }).session_id) {
          capturedSessionId = (message as { session_id?: string }).session_id;
        }
        break;
      default:
        break;
    }
  }

  return { capturedSessionId };
}
