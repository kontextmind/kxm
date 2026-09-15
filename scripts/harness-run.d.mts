export const REQUEST_SCHEMA: "kxm.harness-request.v1";
export const RESULT_SCHEMA: "kxm.harness-result.v2";
export const OBSOLETE_RESULT_SCHEMA: "kxm.harness-result.v1";
export const ROUTING_INT_CAP: number;
export const TOKEN_BASIS: "cumulative";
export const CONTEXT_OCCUPANCY_UNKNOWN: "unknown";
export const COST_BASIS: readonly string[];
export const MODEL_CLAIM_STATUSES: readonly string[];
export const REVIEW_VERDICTS: readonly string[];
export const CLAIM_SOURCES: readonly string[];
export const CLAIM_COUNT_CAP: number;
export const TRANSPORT_STATUSES: readonly string[];
export const TRANSPORT_STAGES: readonly string[];
export const STOP_REASONS: readonly string[];
export const ERROR_CODES: readonly string[];
export const EFFORT: readonly string[];
export const NATIVE_PI_BRAKE_PROVIDERS: readonly string[];
export const PI_ALLOWED_PROVIDERS: readonly string[];
export const PI_NATIVE_VENDOR_PROVIDERS: Readonly<Record<string, string>>;
export const PI_ANTIGRAVITY_MODEL_ID: RegExp;
export const PI_NOUS_PORTAL_HY4: "nous-portal/tencent/hy4-preview";
export const PI_ADMITTED_WRITER: "openrouter/qwen/qwen3-coder-plus";
export const ROUTES: Record<string, {
  provider: string;
  roles: readonly string[];
  permissions: readonly string[];
  models: readonly string[];
  efforts: readonly string[];
  auth: { args: readonly string[]; loginHint: string };
}>;

export function clampEffort(harness: string, effort?: string, model?: string): { effort?: string; clamped?: string };
export function parseJson(text: string): unknown;
export function piProviderOf(model?: string): string | undefined;
export function piModelId(model?: string): string | undefined;
export function piAuthCheckArgs(request: { model: string; role: string }): string[];
export function resolveLaunch(cliId: string, options?: {
  platform?: NodeJS.Platform | string | undefined;
  pathEnv?: string | undefined;
  existsSync?: ((path: string) => boolean) | undefined;
  realpathSync?: ((path: string) => string) | undefined;
  execPath?: string | undefined;
}): { command: string; args: string[] };
export function resolveLauncher(cliId: string, options?: {
  platform?: NodeJS.Platform | string | undefined;
  pathEnv?: string | undefined;
  existsSync?: ((path: string) => boolean) | undefined;
  realpathSync?: ((path: string) => string) | undefined;
  execPath?: string | undefined;
}): string;
export function unsupportedLauncherMessage(target: string, platform?: string): string;
export function parseAuth(harness: string, stdio: {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  status?: number | null;
}, options?: { observedAt?: string; provider?: string }): {
  loggedIn: true;
  method: string;
  observedAt: string;
  subscriptionType?: unknown;
};
export function buildArgv(request: Record<string, unknown>, ctx?: {
  mcpConfigPath?: string;
  promptPath?: string;
  promptText?: string;
  schemaPath?: string;
  schemaText?: string;
}): string[];
export function formatRunCost(result: {
  costBasis?: string | null;
  costUsd?: number;
  providerReportedCostUsd?: number;
}): string;
export function diagnoseHarnessResult(payload: unknown, filePath?: string): {
  result?: Record<string, any>;
  diagnostic?: string;
};
export function formatRunListing(payload: unknown, filePath?: string): string;
export function normalizePi(stdout: string): Record<string, any>;
export function normalizeCodex(stdout: string): Record<string, any>;
export function normalizeAgy(payload: unknown): Record<string, any>;
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
