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
  "kxm: provider id antigravity is already registered by another extension (standalone pi-antigravity). Remove that extension and reload. KXM will not double-register.";

export type AntigravityRegistration = {
  registered: boolean;
  conflict: boolean;
  warning?: string;
};

type ProviderProbe = {
  getRegisteredProviderIds?: () => readonly string[];
  modelRegistry?: {
    getRegisteredProviderIds?: () => readonly string[];
    getProvider?: (id: string) => unknown;
  };
};

export function antigravityProviderRegistered(pi: ExtensionAPI): boolean {
  const probe = pi as ExtensionAPI & ProviderProbe;
  const ids = [
    ...(probe.getRegisteredProviderIds?.() ?? []),
    ...(probe.modelRegistry?.getRegisteredProviderIds?.() ?? []),
  ];
  if (ids.includes(PROVIDER_ID)) return true;
  if (probe.modelRegistry?.getProvider?.(PROVIDER_ID)) return true;
  return false;
}

export function antigravityRegistrationNotice(
  report: AntigravityRegistration | undefined,
): { message: string; type: "warning" } | undefined {
  if (!report?.conflict || !report.warning) return undefined;
  return { message: report.warning.slice(0, 400), type: "warning" };
}

export function registerAntigravityProvider(pi: ExtensionAPI): AntigravityRegistration {
  if (antigravityProviderRegistered(pi)) {
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
      login: loginAntigravity,
      refreshToken: refreshAntigravityToken,
      getApiKey,
    },
    streamSimple: streamAntigravity,
  } as unknown as Parameters<ExtensionAPI["registerProvider"]>[1]);

  return { registered: true, conflict: false };
}
