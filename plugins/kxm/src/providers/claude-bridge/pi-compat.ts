/**
 * Structural Pi stream types used by the vendored claude-bridge provider.
 * No @earendil-works/pi-ai import (nested copy is forbidden).
 */

export type Api = string;
export type ProviderId = string;
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ModelThinkingLevel = "off" | ThinkingLevel;
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;

export type ModelCostRates = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type ModelCost = ModelCostRates;

export type ProviderModelConfig = {
  id: string;
  name: string;
  api?: Api;
  baseUrl?: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input: Array<"text" | "image">;
  cost: ModelCost;
  contextWindow: number;
  maxTokens: number;
};

export type Model<TApi extends Api = Api> = ProviderModelConfig & {
  api: TApi;
  provider: ProviderId;
  baseUrl: string;
};

export type TextContent = {
  type: "text";
  text: string;
  textSignature?: string;
};

export type ThinkingContent = {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
};

export type ImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

export type ToolCall = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
};

export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

export type UserMessage = {
  role: "user";
  content: string | Array<TextContent | ImageContent>;
  timestamp: number;
};

export type AssistantMessage = {
  role: "assistant";
  content: Array<TextContent | ThinkingContent | ToolCall>;
  api: Api;
  provider: ProviderId;
  model: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
};

export type ToolResultMessage = {
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
  content: string | Array<TextContent | ImageContent>;
  isError?: boolean;
  timestamp?: number;
};

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type Tool = {
  name: string;
  description: string;
  parameters: unknown;
};

export type Context = {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
};

export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; reason: StopReason; message: AssistantMessage }
  | { type: "error"; reason: StopReason; error: AssistantMessage };

export class AssistantMessageEventStream {
  queue: AssistantMessageEvent[] = [];
  waiting: Array<(result: { value?: AssistantMessageEvent; done: boolean }) => void> = [];
  done = false;
  finalResultPromise: Promise<AssistantMessage>;
  private resolveFinalResult!: (message: AssistantMessage) => void;

  constructor() {
    this.finalResultPromise = new Promise((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }

  push(event: AssistantMessageEvent): void {
    if (this.done) return;
    if (event.type === "done") {
      this.done = true;
      this.resolveFinalResult(event.message);
    } else if (event.type === "error") {
      this.done = true;
      this.resolveFinalResult(event.error);
    }
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }

  end(result?: AssistantMessage): void {
    this.done = true;
    if (result !== undefined) this.resolveFinalResult(result);
    while (this.waiting.length > 0) {
      this.waiting.shift()?.({ done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else if (this.done) {
        return;
      } else {
        const next = await new Promise<{ value?: AssistantMessageEvent; done: boolean }>((resolve) => {
          this.waiting.push(resolve);
        });
        if (next.done) return;
        if (next.value) yield next.value;
      }
    }
  }

  result(): Promise<AssistantMessage> {
    return this.finalResultPromise;
  }
}

export function createAssistantMessageEventStream(): AssistantMessageEventStream {
  return new AssistantMessageEventStream();
}

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export type SimpleStreamOptions = {
  signal?: AbortSignal;
  cwd?: string;
  reasoning?: ThinkingLevel;
};
