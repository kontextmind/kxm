/**
 * Register the Antigravity provider on a Pi extension host.
 * Provider id stays `antigravity` so existing auth-store logins carry over.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getApiKey, loginAntigravity, refreshAntigravityToken } from "./auth/index.ts";
import { DEFAULT_ENDPOINT, endpointCandidates } from "./client/index.ts";
import {
  getCurrentAntigravityCatalog,
  PROVIDER_ID,
  PROVIDER_NAME,
  refreshAntigravityModels,
} from "./models/index.ts";
import { ANTIGRAVITY_API, streamAntigravity } from "./stream/index.ts";
import { prewarmConnection } from "./utils/index.ts";

export const ANTIGRAVITY_DOUBLE_REGISTRATION_WARNING =
  "kxm: standalone pi-antigravity is still installed. Remove that extension and reload. KXM will not double-register provider id antigravity.";

/** Slash commands that only the standalone extension registers. */
export const STANDALONE_ANTIGRAVITY_COMMANDS = Object.freeze([
  "antigravity.image",
  "antigravity.models",
  "antigravity.doctor",
  "antigravity.usage",
  "antigravity.refresh",
]);

export type AntigravityRegistration = {
  registered: boolean;
  conflict: boolean;
  warning?: string;
};

type ProviderProbe = {
  getRegisteredProviderIds?: () => readonly string[];
  getCommands?: () => ReadonlyArray<{ name?: string }>;
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

export function antigravityStandaloneCommandsPresent(pi: object): boolean {
  const probe = asProbe(pi);
  let names: string[] = [];
  try {
    names = (probe.getCommands?.() ?? [])
      .map((command) => command.name)
      .filter((name): name is string => typeof name === "string");
  } catch {
    return false;
  }
  return STANDALONE_ANTIGRAVITY_COMMANDS.some((name) => names.includes(name));
}

export function antigravityProviderRegistered(pi: object): boolean {
  const probe = asProbe(pi);
  const ids = registeredProviderIds(probe);
  if (ids.includes(PROVIDER_ID)) return true;
  if (probe.modelRegistry?.getProvider?.(PROVIDER_ID)) return true;
  return false;
}

export function shouldSkipAntigravityRegistration(pi: object): boolean {
  return antigravityProviderRegistered(pi) || antigravityStandaloneCommandsPresent(pi);
}

export function antigravityRegistrationNotice(
  report: AntigravityRegistration | undefined,
  pi?: object,
): { message: string; type: "warning" } | undefined {
  const conflict = Boolean(report?.conflict) || (pi ? antigravityStandaloneCommandsPresent(pi) : false);
  if (!conflict) return undefined;
  const warning = (report?.warning ?? ANTIGRAVITY_DOUBLE_REGISTRATION_WARNING).slice(0, 400);
  return { message: warning, type: "warning" };
}

export function registerAntigravityProvider(pi: ExtensionAPI): AntigravityRegistration {
  if (shouldSkipAntigravityRegistration(pi)) {
    return {
      registered: false,
      conflict: true,
      warning: ANTIGRAVITY_DOUBLE_REGISTRATION_WARNING,
    };
  }
  if (typeof pi.registerProvider !== "function") {
    return { registered: false, conflict: false };
  }

  const primaryEndpoint = endpointCandidates()[0];
  if (primaryEndpoint) prewarmConnection(primaryEndpoint);

  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: DEFAULT_ENDPOINT,
    api: ANTIGRAVITY_API,
    models: getCurrentAntigravityCatalog().models,
    refreshModels: refreshAntigravityModels,
    oauth: {
      name: PROVIDER_NAME,
      isSubscription: true,
      login: loginAntigravity,
      refreshToken: refreshAntigravityToken,
      getApiKey,
    },
    streamSimple: streamAntigravity,
  } as unknown as Parameters<ExtensionAPI["registerProvider"]>[1]);

  return { registered: true, conflict: false };
}
