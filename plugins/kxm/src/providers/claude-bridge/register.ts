/**
 * Register the Claude Bridge provider on a Pi extension host.
 * Provider id stays `claude-bridge` so `claude login` credentials carry over.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CLAUDE_BRIDGE_API,
  PROVIDER_ID,
  PROVIDER_NAME,
  registeredClaudeBridgeModels,
} from "./models.ts";
import { streamClaudeBridge } from "./provider.ts";

export const CLAUDE_BRIDGE_DOUBLE_REGISTRATION_WARNING =
  "kxm: standalone pi-claude-bridge is still installed. Remove that extension and reload. KXM will not double-register provider id claude-bridge.";

/** Tools that only the standalone extension registers. */
export const STANDALONE_CLAUDE_BRIDGE_TOOLS = Object.freeze(["AskClaude"]);

export type ClaudeBridgeRegistration = {
  registered: boolean;
  conflict: boolean;
  warning?: string;
};

type ProviderProbe = {
  getRegisteredProviderIds?: () => readonly string[];
  getCommands?: () => ReadonlyArray<{ name?: string }>;
  getTools?: () => ReadonlyArray<{ name?: string }>;
  modelRegistry?: {
    getRegisteredProviderIds?: () => readonly string[];
    getProvider?: (id: string) => unknown;
  };
};

function asProbe(pi: object): ProviderProbe {
  return pi as ProviderProbe;
}

function registeredProviderIds(probe: ProviderProbe): string[] {
  return [
    ...(probe.getRegisteredProviderIds?.() ?? []),
    ...(probe.modelRegistry?.getRegisteredProviderIds?.() ?? []),
  ];
}

export function claudeBridgeStandaloneToolsPresent(pi: object): boolean {
  const probe = asProbe(pi);
  let names: string[] = [];
  try {
    names = (probe.getTools?.() ?? [])
      .map((tool) => tool.name)
      .filter((name): name is string => typeof name === "string");
  } catch {
    return false;
  }
  return STANDALONE_CLAUDE_BRIDGE_TOOLS.some((name) => names.includes(name));
}

export function claudeBridgeProviderRegistered(pi: object): boolean {
  const probe = asProbe(pi);
  const ids = registeredProviderIds(probe);
  if (ids.includes(PROVIDER_ID)) return true;
  if (probe.modelRegistry?.getProvider?.(PROVIDER_ID)) return true;
  return false;
}

export function shouldSkipClaudeBridgeRegistration(pi: object): boolean {
  return claudeBridgeProviderRegistered(pi) || claudeBridgeStandaloneToolsPresent(pi);
}

export function claudeBridgeRegistrationNotice(
  report: ClaudeBridgeRegistration | undefined,
  pi?: object,
): { message: string; type: "warning" } | undefined {
  const conflict = Boolean(report?.conflict) || (pi ? claudeBridgeStandaloneToolsPresent(pi) : false);
  if (!conflict) return undefined;
  const warning = (report?.warning ?? CLAUDE_BRIDGE_DOUBLE_REGISTRATION_WARNING).slice(0, 400);
  return { message: warning, type: "warning" };
}

export function registerClaudeBridgeProvider(pi: ExtensionAPI): ClaudeBridgeRegistration {
  if (shouldSkipClaudeBridgeRegistration(pi)) {
    return {
      registered: false,
      conflict: true,
      warning: CLAUDE_BRIDGE_DOUBLE_REGISTRATION_WARNING,
    };
  }
  if (typeof pi.registerProvider !== "function") {
    return { registered: false, conflict: false };
  }

  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: PROVIDER_ID,
    apiKey: "not-used",
    api: CLAUDE_BRIDGE_API,
    models: registeredClaudeBridgeModels(),
    streamSimple: streamClaudeBridge,
  } as unknown as Parameters<ExtensionAPI["registerProvider"]>[1]);

  return { registered: true, conflict: false };
}
