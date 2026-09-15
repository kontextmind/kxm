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
  "kxm: standalone pi-claude-bridge is still installed (AskClaude tool is present). Remove that extension and reload. KXM will not register provider id claude-bridge.";

export const CLAUDE_BRIDGE_ALREADY_REGISTERED_WARNING =
  "kxm: standalone pi-claude-bridge is still installed (AskClaude tool is present). KXM already registered provider id claude-bridge. Remove that extension and reload to avoid override or ambiguity.";

/** Tools that only the standalone extension registers. */
export const STANDALONE_CLAUDE_BRIDGE_TOOLS = Object.freeze(["AskClaude"]);

/** Real ExtensionAPI probes that can observe the standalone AskClaude tool. */
export const CLAUDE_BRIDGE_HOST_PROBE_METHODS = Object.freeze([
  "getAllTools",
  "getActiveTools",
  "getCommands",
] as const);

export type ClaudeBridgeRegistration = {
  registered: boolean;
  conflict: boolean;
  warning?: string;
};

type HostProbe = Pick<ExtensionAPI, (typeof CLAUDE_BRIDGE_HOST_PROBE_METHODS)[number]>;

function asProbe(pi: object): Partial<HostProbe> {
  return pi as Partial<HostProbe>;
}

function collectHostSignalNames(pi: object): string[] {
  const probe = asProbe(pi);
  const names: string[] = [];
  try {
    for (const tool of probe.getAllTools?.() ?? []) {
      if (typeof tool.name === "string") names.push(tool.name);
    }
  } catch {
    /* getAllTools may throw before the runner is bound */
  }
  try {
    for (const name of probe.getActiveTools?.() ?? []) {
      if (typeof name === "string") names.push(name);
    }
  } catch {
    /* getActiveTools may throw before the runner is bound */
  }
  try {
    for (const command of probe.getCommands?.() ?? []) {
      if (typeof command.name === "string") names.push(command.name);
    }
  } catch {
    /* getCommands may throw before the session is ready */
  }
  return names;
}

export function claudeBridgeStandaloneToolsPresent(pi: object): boolean {
  const names = collectHostSignalNames(pi);
  return STANDALONE_CLAUDE_BRIDGE_TOOLS.some((name) => names.includes(name));
}

export function shouldSkipClaudeBridgeRegistration(pi: object): boolean {
  return claudeBridgeStandaloneToolsPresent(pi);
}

function boundedRegistrationWarning(message: string): string {
  return message.slice(0, 400);
}

export function claudeBridgeConflictWarning(registered: boolean): string {
  return boundedRegistrationWarning(
    registered
      ? CLAUDE_BRIDGE_ALREADY_REGISTERED_WARNING
      : CLAUDE_BRIDGE_DOUBLE_REGISTRATION_WARNING,
  );
}

export function claudeBridgeRegistrationNotice(
  report: ClaudeBridgeRegistration | undefined,
  pi?: object,
): { message: string; type: "warning" } | undefined {
  const conflict = Boolean(report?.conflict) || (pi ? claudeBridgeStandaloneToolsPresent(pi) : false);
  if (!conflict) return undefined;
  return {
    message: claudeBridgeConflictWarning(Boolean(report?.registered)),
    type: "warning",
  };
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
    api: CLAUDE_BRIDGE_API,
    models: registeredClaudeBridgeModels(),
    streamSimple: streamClaudeBridge,
  } as unknown as Parameters<ExtensionAPI["registerProvider"]>[1]);

  return { registered: true, conflict: false };
}
