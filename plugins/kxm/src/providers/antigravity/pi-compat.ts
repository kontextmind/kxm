/**
 * Structural Pi stream/auth types used by the vendored Antigravity provider.
 * No @earendil-works/pi-ai import (nested copy is forbidden).
 */

export type Api = string;
export type ProviderId = string;
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ModelThinkingLevel = "off" | ThinkingLevel;
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;
export type ToolChoiceSimple = "auto" | "none";

export type ModelCostRates = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type ModelCost = ModelCostRates & {
  tiers?: Array<ModelCostRates & { inputTokensAbove: number }>;
};

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
  headers?: Record<string, string>;
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
  cacheWrite1h?: number;
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
  rawStopReason?: string;
  timestamp: number;
};

export type ToolResultMessage = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Array<TextContent | ImageContent>;
  isError: boolean;
  timestamp: number;
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

export function calculateCost(model: { cost?: ModelCost }, usage: Usage): Usage["cost"] {
  const rates = model.cost;
  if (!rates) {
    usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    return usage.cost;
  }
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  let applied: ModelCostRates = rates;
  let matchedThreshold = -1;
  for (const tier of rates.tiers ?? []) {
    if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
      applied = tier;
      matchedThreshold = tier.inputTokensAbove;
    }
  }
  const longWrite = usage.cacheWrite1h ?? 0;
  const shortWrite = usage.cacheWrite - longWrite;
  usage.cost.input = (applied.input / 1_000_000) * usage.input;
  usage.cost.output = (applied.output / 1_000_000) * usage.output;
  usage.cost.cacheRead = (applied.cacheRead / 1_000_000) * usage.cacheRead;
  usage.cost.cacheWrite = (applied.cacheWrite * shortWrite + applied.input * 2 * longWrite) / 1_000_000;
  usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  return usage.cost;
}

export type OAuthCredentials = {
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
};

export type OAuthLoginCallbacks = {
  onAuth(info: { url: string; instructions?: string }): void;
  onDeviceCode?(info: { userCode: string; verificationUri: string }): void;
  onPrompt?(prompt: { message: string; placeholder?: string }): Promise<string>;
  onProgress?(message: string): void;
  onSelect?(prompt: { message: string; options: Array<{ id: string; label: string }> }): Promise<string | undefined>;
  signal?: AbortSignal;
};

export type ApiKeyCredential = {
  type: "api_key";
  key?: string;
};

export type OAuthCredential = OAuthCredentials & {
  type: "oauth";
};

export type Credential = ApiKeyCredential | OAuthCredential;

export type ModelsStoreEntry = Record<string, unknown>;

export type RefreshModelsContext = {
  credential?: Credential;
  stored?: Readonly<ModelsStoreEntry>;
  publish(publication: { persist?: ModelsStoreEntry | null }): Promise<boolean>;
  allowNetwork: boolean;
  force?: boolean;
  signal: AbortSignal;
};

export type SimpleStreamOptions = {
  signal?: AbortSignal;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  sessionId?: string;
  reasoning?: ThinkingLevel;
  toolChoice?: ToolChoiceSimple | string;
  onPayload?: (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;
  onResponse?: (response: { status: number; headers: Record<string, string> }, model: Model<Api>) => void | Promise<void>;
};
