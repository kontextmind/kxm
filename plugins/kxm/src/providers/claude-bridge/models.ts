// Canonical selection + display order for the model picker.
// Extracted from pi-claude-bridge 0.7.0; catalog is static (no pi-ai getModels).

import type { Model, ProviderModelConfig, ThinkingLevel, ThinkingLevelMap } from "./pi-compat.ts";

export const PROVIDER_ID = "claude-bridge";
export const PROVIDER_NAME = "Claude Bridge";
export const CLAUDE_BRIDGE_API = "claude-bridge";

export const MODEL_IDS_IN_ORDER = [
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
] as const;

export type ClaudeBridgeModelId = (typeof MODEL_IDS_IN_ORDER)[number];

const DISPLAY_NAMES: Record<ClaudeBridgeModelId, string> = {
  "claude-fable-5-1": "Claude Fable 5.1",
  "claude-fable-5": "Claude Fable 5",
  "claude-opus-5": "Claude Opus 5",
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-opus-4-7": "Claude Opus 4.7",
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-haiku-4-5": "Claude Haiku 4.5",
};

/** Per-model effort overrides (pi-ai 0.72+ shipped these for later Opus). */
const THINKING_LEVEL_MAPS: Partial<Record<ClaudeBridgeModelId, ThinkingLevelMap>> = {
  "claude-opus-4-8": { xhigh: "xhigh", max: "max" },
  "claude-opus-4-7": { xhigh: "xhigh", max: "max" },
  "claude-opus-5": { xhigh: "xhigh", max: "max" },
};

export type LongContextSettings = {
  plan: "pro" | "max";
  longContextExtraUsage: boolean;
};

export type ClaudeCodeRuntimeModel = {
  cliModelId: string;
  contextWindow: number;
};

const TWO_HUNDRED_K_CONTEXT = 200_000;
const ONE_M_CONTEXT = 1_000_000;

export const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

export const DEFAULT_LONG_CONTEXT: LongContextSettings = {
  plan: "pro",
  longContextExtraUsage: false,
};

/** Pi reasoning levels → Claude Agent SDK effort levels. */
export const REASONING_TO_EFFORT: Record<string, string> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
};

export function resolveEffort(
  reasoning: ThinkingLevel | undefined,
  thinkingLevelMap?: ThinkingLevelMap,
): string | undefined {
  if (!reasoning) return undefined;
  const mapped = thinkingLevelMap?.[reasoning];
  if (typeof mapped === "string") return mapped;
  return REASONING_TO_EFFORT[reasoning];
}

export function resolveClaudeCodeRuntimeModel(
  modelId: string,
  settings: LongContextSettings,
): ClaudeCodeRuntimeModel {
  switch (modelId) {
    case "claude-opus-5":
      return { cliModelId: "claude-opus-5[1m]", contextWindow: ONE_M_CONTEXT };
    case "claude-opus-4-8":
      return { cliModelId: "claude-opus-4-8[1m]", contextWindow: ONE_M_CONTEXT };
    case "claude-opus-4-7":
      return { cliModelId: "claude-opus-4-7", contextWindow: ONE_M_CONTEXT };
    case "claude-opus-4-6": {
      const useOneM = settings.plan === "max" || settings.longContextExtraUsage;
      return {
        cliModelId: useOneM ? "claude-opus-4-6[1m]" : "claude-opus-4-6",
        contextWindow: useOneM ? ONE_M_CONTEXT : TWO_HUNDRED_K_CONTEXT,
      };
    }
    case "claude-fable-5-1":
      return { cliModelId: "claude-fable-5-1[1m]", contextWindow: ONE_M_CONTEXT };
    case "claude-fable-5":
      return { cliModelId: "claude-fable-5[1m]", contextWindow: ONE_M_CONTEXT };
    case "claude-sonnet-5":
      return { cliModelId: "claude-sonnet-5[1m]", contextWindow: ONE_M_CONTEXT };
    case "claude-sonnet-4-6":
      return {
        cliModelId: settings.longContextExtraUsage ? "claude-sonnet-4-6[1m]" : "claude-sonnet-4-6",
        contextWindow: settings.longContextExtraUsage ? ONE_M_CONTEXT : TWO_HUNDRED_K_CONTEXT,
      };
    case "claude-haiku-4-5":
      return { cliModelId: "claude-haiku-4-5", contextWindow: TWO_HUNDRED_K_CONTEXT };
    default:
      return { cliModelId: modelId, contextWindow: TWO_HUNDRED_K_CONTEXT };
  }
}

export function claudeCodeModelId(model: { id: string }, settings: LongContextSettings): string {
  return resolveClaudeCodeRuntimeModel(model.id, settings).cliModelId;
}

export function resolveModel<T extends { id: string }>(models: T[], input: string): T | undefined {
  const lower = input.toLowerCase();
  return models.find((m) => m.id === lower || m.id.includes(lower));
}

export function applyLongContext<T extends { id: string; name: string; contextWindow?: number | null }>(
  models: T[],
  settings: LongContextSettings,
): T[] {
  return models.map((m) => {
    const { contextWindow } = resolveClaudeCodeRuntimeModel(m.id, settings);
    const name =
      contextWindow > TWO_HUNDRED_K_CONTEXT && !/\b1M\b/i.test(m.name) ? `${m.name} 1M` : m.name;
    return contextWindow === m.contextWindow && name === m.name ? m : { ...m, contextWindow, name };
  });
}

function staticModel(id: ClaudeBridgeModelId): ProviderModelConfig {
  const runtime = resolveClaudeCodeRuntimeModel(id, DEFAULT_LONG_CONTEXT);
  const name = DISPLAY_NAMES[id];
  const thinkingLevelMap = THINKING_LEVEL_MAPS[id];
  return {
    id,
    name: runtime.contextWindow > TWO_HUNDRED_K_CONTEXT && !/\b1M\b/i.test(name) ? `${name} 1M` : name,
    reasoning: true,
    input: ["text", "image"],
    cost: { ...ZERO_COST },
    contextWindow: runtime.contextWindow,
    maxTokens: 32_000,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
  };
}

export const CLAUDE_BRIDGE_MODELS: ProviderModelConfig[] = MODEL_IDS_IN_ORDER.map(staticModel);

export function registeredClaudeBridgeModels(
  settings: LongContextSettings = DEFAULT_LONG_CONTEXT,
): Model[] {
  return applyLongContext(CLAUDE_BRIDGE_MODELS, settings).map((model) => ({
    ...model,
    api: CLAUDE_BRIDGE_API,
    provider: PROVIDER_ID,
    baseUrl: PROVIDER_ID,
  }));
}
