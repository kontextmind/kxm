// @ts-nocheck — vendored snapshot; host tsconfig is stricter than upstream.
import {
  emptyUsage,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
} from "./pi-compat.ts";
import type { McpResult } from "./tools.ts";
import type { PromptStream } from "./prompt-stream.ts";

export interface PendingToolCall {
  toolName: string;
  resolve: (result: McpResult) => void;
}

export class QueryContext {
  activeQuery: unknown | null = null;
  currentPiStream: AssistantMessageEventStream | null = null;
  latestCursor = 0;
  pendingToolCalls = new Map<string, PendingToolCall>();
  pendingResults = new Map<string, McpResult>();
  turnToolCallIds: string[] = [];
  promptStream: PromptStream | null = null;
  rateLimitRejection: { rateLimitType?: string; resetsAt?: number } | null = null;
  lastRateLimitWarnStep: number | null = null;
  lastRateLimitWarnThreshold: number | undefined;
  sessionId: string | undefined;

  turnOutput: AssistantMessage | null = null;
  turnStarted = false;
  turnSawStreamEvent = false;
  turnSawToolCall = false;

  get turnBlocks(): Array<any> {
    if (!this.turnOutput) throw new Error("turnBlocks accessed before resetTurnState");
    return this.turnOutput.content;
  }

  releasePendingToolCalls(reason: string): void {
    for (const pending of this.pendingToolCalls.values()) {
      pending.resolve({ content: [{ type: "text", text: reason }] });
    }
    this.pendingToolCalls.clear();
    this.pendingResults.clear();
  }

  resetTurnState(model: Model): void {
    this.turnOutput = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };
    this.turnStarted = false;
    this.turnSawStreamEvent = false;
    this.turnSawToolCall = false;
  }
}

let _ctx = new QueryContext();

export function ctx(): QueryContext {
  return _ctx;
}

export function resetCtx(): void {
  _ctx = new QueryContext();
}
