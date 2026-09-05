export const REQUEST_SCHEMA: "kxm.harness-request.v1";
export const RESULT_SCHEMA: "kxm.harness-result.v1";
export const ROUTING_INT_CAP: number;
export const TOKEN_BASIS: "cumulative";
export const CONTEXT_OCCUPANCY_UNKNOWN: "unknown";
export const EFFORT: readonly string[];
export const NATIVE_PI_BRAKE_PROVIDERS: readonly string[];
export const ROUTES: Record<string, {
  provider: string;
  roles: readonly string[];
  permissions: readonly string[];
  models: readonly string[];
  efforts: readonly string[];
  auth: { args: readonly string[]; loginHint: string };
}>;

export function clampEffort(harness: string, effort?: string): { effort?: string; clamped?: string };
export function parseJson(text: string): unknown;
export function piProviderOf(model?: string): string | undefined;
export function resolveLauncher(cliId: string, options?: {
  platform?: NodeJS.Platform | string;
  pathEnv?: string;
  existsSync?: (path: string) => boolean;
  realpathSync?: (path: string) => string;
}): string;
export function unsupportedLauncherMessage(target: string, platform?: string): string;
export function parseAuth(harness: string, stdio: {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  status?: number | null;
}, options?: { observedAt?: string }): {
  loggedIn: true;
  method: string;
  observedAt: string;
  subscriptionType?: unknown;
};
export function buildArgv(request: Record<string, unknown>, ctx?: {
  mcpConfigPath?: string;
  promptPath?: string;
  schemaPath?: string;
  schemaText?: string;
}): string[];
export function formatRunCost(result: {
  costBasis?: string | null;
  costUsd?: number;
  providerReportedCostUsd?: number;
}): string;
export function normalizePi(stdout: string): Record<string, any>;
export function normalizeCodex(stdout: string): Record<string, any>;
export function resolveModelUsage(modelUsage: Record<string, unknown>, requestedModel?: string): {
  effectiveModel?: string;
  primary?: Record<string, unknown>;
  auxiliary: unknown[];
  candidates: string[];
  matched?: string;
};
export function normalizeClaudeOrGrok(payload: unknown, requestedModel?: string): Record<string, any>;
export function preflightRequest(request: unknown): unknown;
export function runHarness(request: unknown, deps?: Record<string, unknown>): Promise<Record<string, any>>;
export function main(argv?: string[], io?: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }): Promise<Record<string, unknown>>;
