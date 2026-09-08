import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 as win32Path } from "node:path";

export const DEFAULT_HARNESS = "pi";
export type HarnessMode = "headless" | "either";
export type HarnessUpdateScope = "self" | "extensions" | "models" | "all";

export interface HarnessCommandResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export type OneShotPromptVia = "stdin" | "arg";

export interface OneShotUsage {
  tokensIn?: number | null | undefined;
  tokensOut?: number | null | undefined;
  cacheReadTokens?: number | null | undefined;
  cacheWriteTokens?: number | null | undefined;
  contextTokens?: number | null | undefined;
  costUsd?: number | null | undefined;
}

export interface OneShotParsedOutput {
  text: string;
  usage?: OneShotUsage | undefined;
  outcome?: string | undefined;
  isError?: boolean | undefined;
  errorMessage?: string | undefined;
}

export interface HarnessOneShotConfig {
  argv: readonly string[];
  promptVia: OneShotPromptVia;
  outputFormat: "json" | "text" | "stream-json" | "jsonl";
  usageParser: (stdout: string, stderr: string) => OneShotParsedOutput;
}

export interface HarnessCatalogEntry {
  id: string;
  label: string;
  default: boolean;
  mode: HarnessMode;
  commands: readonly string[];
  versionArgs: readonly string[];
  authArgs?: readonly string[];
  update: {
    self: readonly string[];
    extensions?: readonly string[];
    models?: readonly string[];
  };
  oneShot?: HarnessOneShotConfig | undefined;
}

export interface HarnessProbeOptions {
  env?: NodeJS.ProcessEnv | undefined;
  runCommand?: ((command: string, args: readonly string[], timeoutMs: number) => HarnessCommandResult) | undefined;
  timeoutMs?: number | undefined;
  platform?: NodeJS.Platform | undefined;
  existsSync?: ((path: string) => boolean) | undefined;
}

export interface HarnessDispatchStatus {
  status: "yes" | "no";
  supported: boolean;
  reason?: string | undefined;
}

export interface HarnessStatus {
  id: string;
  label: string;
  default: boolean;
  mode: HarnessMode;
  detected: boolean;
  authenticated: boolean | null;
  dispatch?: HarnessDispatchStatus | undefined;
  command?: string;
  version?: string;
  canUpdate: { self: boolean; extensions: boolean; models: boolean };
  issues: readonly string[];
}

export interface HarnessInventory {
  defaultHarness: typeof DEFAULT_HARNESS;
  harnesses: readonly HarnessStatus[];
}

const UNKNOWN_AUTH_HARNESSES = new Set(["gemini", "deepseek"]);
const GROK_LOGIN_LINE = "You are logged in with grok.com.";
/** Tab-separated `id<TAB>label` rows from the committed `agy models` probe. */
const AGY_MODEL_ROW = /^[a-z0-9][a-z0-9.+_-]*\t+\S/im;
const CODEX_CHATGPT_LINE = "Logged in using ChatGPT";
const CODEX_API_KEY_PREFIX = "Logged in using an API key";
const CODEX_NEGATIVE_LINE = "Not logged in";

/** Providers that have a dedicated native harness rule. */
export const NATIVE_HARNESS_PROVIDERS: Readonly<Record<string, string>> = Object.freeze({
  claude: "anthropic",
  codex: "openai",
  grok: "xai",
  agy: "google",
  gemini: "google",
  kimi: "moonshot",
  deepseek: "deepseek",
});

/** Allowlisted Pi aggregator provider prefixes. */
export const PI_ALLOWED_PROVIDERS: readonly string[] = Object.freeze([
  "openrouter",
  "nous-portal",
  "nous",
  "nous-proxy",
]);

/** Native providers Pi must not impersonate directly unless allowlisted aggregator prefix is used. */
export const PI_NATIVE_BRAKE_PROVIDERS: readonly string[] = Object.freeze([
  "anthropic",
  "openai",
  "xai",
  "moonshot",
  "google",
  "deepseek",
]);

export interface HarnessModelSpec {
  provider?: string | undefined;
  model?: string | undefined;
}

export interface HarnessModelValidation {
  valid: boolean;
  issue?: "harness_unknown" | "harness_unhosted_model" | "pi_native_impersonation_blocked";
  message?: string;
}

export interface HarnessUpdateStep {
  harness: string;
  scope: Exclude<HarnessUpdateScope, "all">;
  command: string;
  args: readonly string[];
  outcome: "would" | "passed" | "failed" | "skipped";
  code?: number | null;
  detail?: string;
}

export function parseClaudeOneShotUsage(stdout: string, stderr: string): OneShotParsedOutput {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {
      text: "",
      isError: true,
      errorMessage: stderr.trim() || "empty stdout from claude",
    };
  }
  try {
    const payload = JSON.parse(trimmed) as Record<string, unknown>;
    const usage = (payload.usage as Record<string, unknown> | undefined) ?? {};
    let modelUsageDetail: Record<string, unknown> | undefined;
    if (payload.modelUsage && typeof payload.modelUsage === "object") {
      const values = Object.values(payload.modelUsage as Record<string, unknown>);
      if (values.length > 0 && values[0] && typeof values[0] === "object") {
        modelUsageDetail = values[0] as Record<string, unknown>;
      }
    }
    const tokensIn = (typeof modelUsageDetail?.inputTokens === "number" ? modelUsageDetail.inputTokens : undefined)
      ?? (typeof usage.input_tokens === "number" ? usage.input_tokens : null);
    const tokensOut = (typeof modelUsageDetail?.outputTokens === "number" ? modelUsageDetail.outputTokens : undefined)
      ?? (typeof usage.output_tokens === "number" ? usage.output_tokens : null);
    const cacheReadTokens = (typeof modelUsageDetail?.cacheReadInputTokens === "number" ? modelUsageDetail.cacheReadInputTokens : undefined)
      ?? (typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : null);
    const cacheWriteTokens = (typeof modelUsageDetail?.cacheCreationInputTokens === "number" ? modelUsageDetail.cacheCreationInputTokens : undefined)
      ?? (typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : null);
    const costUsd = typeof payload.total_cost_usd === "number"
      ? payload.total_cost_usd
      : (typeof modelUsageDetail?.costUSD === "number" ? modelUsageDetail.costUSD : null);

    const isError = Boolean(payload.is_error || payload.error);
    const text = typeof payload.result === "string" ? payload.result : (typeof payload.text === "string" ? payload.text : "");
    const errorMessage = isError
      ? (typeof payload.error === "string"
        ? payload.error
        : (typeof (payload.error as Record<string, unknown> | undefined)?.message === "string"
          ? ((payload.error as Record<string, unknown>).message as string)
          : text))
      : undefined;

    return {
      text,
      isError,
      errorMessage,
      usage: {
        tokensIn,
        tokensOut,
        cacheReadTokens,
        cacheWriteTokens,
        contextTokens: tokensIn,
        costUsd,
      },
    };
  } catch {
    return {
      text: trimmed,
      usage: {},
    };
  }
}

export function parseCodexOneShotUsage(stdout: string, stderr: string): OneShotParsedOutput {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    return {
      text: "",
      isError: true,
      errorMessage: stderr.trim() || "empty stdout from codex",
    };
  }
  const events: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") events.push(parsed as Record<string, unknown>);
    } catch {
      // non-json line ignored
    }
  }

  const messageTexts: string[] = [];
  let usage: Record<string, unknown> | undefined;
  let hasError = false;
  let errorMessage: string | undefined;

  for (const ev of events) {
    if (ev.type === "turn.failed" || ev.type === "error") {
      hasError = true;
      errorMessage = typeof ev.message === "string"
        ? ev.message
        : (typeof (ev.error as Record<string, unknown> | undefined)?.message === "string"
          ? ((ev.error as Record<string, unknown>).message as string)
          : "turn_failed");
    }
    if (ev.item && typeof ev.item === "object" && (ev.item as Record<string, unknown>).type === "agent_message") {
      const t = (ev.item as Record<string, unknown>).text;
      if (typeof t === "string") messageTexts.push(t);
    }
    if (ev.type === "turn.completed" && ev.usage && typeof ev.usage === "object") {
      usage = ev.usage as Record<string, unknown>;
    }
  }

  const text = messageTexts.join("\n").trim();
  const tokensIn = typeof usage?.input_tokens === "number" ? usage.input_tokens : null;
  const tokensOut = typeof usage?.output_tokens === "number" ? usage.output_tokens : null;
  const cacheReadTokens = typeof usage?.cached_input_tokens === "number" ? usage.cached_input_tokens : null;
  const cacheWriteTokens = typeof usage?.cache_write_input_tokens === "number" ? usage.cache_write_input_tokens : null;

  return {
    text,
    isError: hasError,
    errorMessage,
    usage: {
      tokensIn,
      tokensOut,
      cacheReadTokens,
      cacheWriteTokens,
      contextTokens: tokensIn,
      costUsd: null,
    },
  };
}

export function parseGenericOneShotUsage(stdout: string, _stderr: string): OneShotParsedOutput {
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      const text = typeof rec.result === "string"
        ? rec.result
        : (typeof rec.text === "string"
          ? rec.text
          : (typeof rec.response === "string" ? rec.response : trimmed));
      return { text, usage: {} };
    }
  } catch {
    // not json
  }
  return { text: trimmed, usage: {} };
}

export function parseKimiOneShotUsage(stdout: string, _stderr: string): OneShotParsedOutput {
  const trimmed = stdout.trim();
  const assistantTexts: string[] = [];
  let isError = false;
  let errorMessage: string | undefined;

  for (const line of trimmed.split("\n")) {
    const lineTrimmed = line.trim();
    if (!lineTrimmed) continue;
    try {
      const parsed = JSON.parse(lineTrimmed);
      if (parsed && typeof parsed === "object") {
        const rec = parsed as Record<string, unknown>;
        if (rec.role === "assistant" && typeof rec.content === "string") {
          assistantTexts.push(rec.content);
        } else if (rec.role === "error" || rec.type === "error") {
          isError = true;
          errorMessage = typeof rec.message === "string" ? rec.message : (typeof rec.content === "string" ? rec.content : "kimi_error");
        }
      }
    } catch {
      // non-JSON line (e.g. startup banner or markdown)
    }
  }

  const text = assistantTexts.length > 0 ? assistantTexts.join("\n") : trimmed;
  return {
    text,
    isError,
    errorMessage,
    usage: {
      tokensIn: null,
      tokensOut: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      contextTokens: null,
      costUsd: null,
    },
  };
}

export function parseAgyOneShotUsage(stdout: string, _stderr: string): OneShotParsedOutput {
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      const text = typeof rec.response === "string"
        ? rec.response
        : (typeof rec.result === "string" ? rec.result : trimmed);
      const isError = rec.status === "ERROR";
      const rawError = rec.error;
      const errorMessage = isError
        ? (typeof rawError === "string"
          ? rawError
          : (typeof (rawError as any)?.message === "string" ? (rawError as any).message : "agy_error"))
        : undefined;

      const usageRec = rec.usage && typeof rec.usage === "object" ? rec.usage as Record<string, unknown> : {};
      const tokensIn = typeof usageRec.input_tokens === "number" ? usageRec.input_tokens : null;
      const tokensOut = typeof usageRec.output_tokens === "number" ? usageRec.output_tokens : null;
      const cacheReadTokens = typeof usageRec.cache_read_tokens === "number" ? usageRec.cache_read_tokens : null;
      const contextTokens = typeof usageRec.total_tokens === "number" ? usageRec.total_tokens : tokensIn;

      return {
        text,
        isError,
        errorMessage,
        usage: {
          tokensIn,
          tokensOut,
          cacheReadTokens,
          cacheWriteTokens: null,
          contextTokens,
          costUsd: null,
        },
      };
    }
  } catch {
    // not json
  }
  return {
    text: trimmed,
    usage: {
      tokensIn: null,
      tokensOut: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      contextTokens: null,
    },
  };
}

/** Built-in harnesses. Unknown ids fail closed. Model lists live in `.kxm/models/*.yaml`, not here. */
export const BUILTIN_HARNESSES: readonly HarnessCatalogEntry[] = Object.freeze([
  {
    id: "pi",
    label: "Pi",
    default: true,
    mode: "headless",
    commands: ["pi"],
    versionArgs: ["--version"],
    update: {
      self: ["update", "--self"],
      extensions: ["update", "--extensions"],
      models: ["update", "--models"],
    },
    oneShot: {
      argv: ["-p", "--mode", "json"],
      promptVia: "arg",
      outputFormat: "json",
      usageParser: parseGenericOneShotUsage,
    },
  },
  {
    id: "claude",
    label: "Claude Code",
    default: false,
    mode: "either",
    commands: ["claude"],
    versionArgs: ["--version"],
    authArgs: ["auth", "status"],
    update: {
      self: ["update"],
      extensions: ["plugin", "update", "kxm", "-y"],
    },
    oneShot: {
      argv: ["-p", "--output-format", "json"],
      promptVia: "stdin",
      outputFormat: "json",
      usageParser: parseClaudeOneShotUsage,
    },
  },
  {
    id: "kimi",
    label: "Kimi Code",
    default: false,
    mode: "either",
    commands: ["kimi"],
    versionArgs: ["--version"],
    authArgs: ["provider", "list"],
    update: { self: ["upgrade"] },
    oneShot: {
      argv: ["--output-format", "stream-json", "-p"],
      promptVia: "arg",
      outputFormat: "stream-json",
      usageParser: parseKimiOneShotUsage,
    },
  },
  {
    id: "codex",
    label: "Codex",
    default: false,
    mode: "either",
    commands: ["codex"],
    versionArgs: ["--version"],
    authArgs: ["login", "status"],
    update: { self: ["update"] },
    oneShot: {
      argv: ["exec", "--json", "-"],
      promptVia: "stdin",
      outputFormat: "json",
      usageParser: parseCodexOneShotUsage,
    },
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    default: false,
    mode: "either",
    commands: ["gemini"],
    versionArgs: ["--version"],
    update: { self: ["update"] },
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    default: false,
    mode: "either",
    commands: ["deepseek"],
    versionArgs: ["--version"],
    update: { self: ["update"] },
    oneShot: {
      argv: ["--json"],
      promptVia: "stdin",
      outputFormat: "json",
      usageParser: parseGenericOneShotUsage,
    },
  },
  {
    id: "grok",
    label: "Grok CLI",
    default: false,
    mode: "either",
    commands: ["grok"],
    versionArgs: ["--version"],
    authArgs: ["models"],
    update: { self: ["update"] },
    oneShot: {
      argv: ["--output-format", "json"],
      promptVia: "stdin",
      outputFormat: "json",
      usageParser: parseClaudeOneShotUsage,
    },
  },
  {
    id: "agy",
    label: "Antigravity CLI",
    default: false,
    mode: "either",
    commands: ["agy"],
    versionArgs: ["--version"],
    authArgs: ["models"],
    update: { self: ["update"] },
    oneShot: {
      argv: ["--output-format", "json", "-p"],
      promptVia: "arg",
      outputFormat: "json",
      usageParser: parseAgyOneShotUsage,
    },
  },
]);

export const BUILTIN_HARNESS_IDS: readonly string[] = BUILTIN_HARNESSES.map((entry) => entry.id);

export function isKnownHarnessId(id: string, extra: Iterable<string> = []): boolean {
  if (BUILTIN_HARNESS_IDS.includes(id)) return true;
  for (const candidate of extra) if (candidate === id) return true;
  return false;
}

/** Bare catalog command ids only; never a path or shell metacharacter. */
export const SAFE_HARNESS_COMMAND_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

export function harnessCommandCandidates(
  command: string,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  if (platform !== "win32" || !SAFE_HARNESS_COMMAND_ID.test(command)) return [command];
  return [command, `${command}.exe`, `${command}.cmd`];
}

export function isWindowsHarnessShim(command: string): boolean {
  return /\.(cmd|bat)$/i.test(command.replace(/\\/g, "/").split("/").pop() ?? command);
}

/** Shell only for allowlisted `name.cmd` on win32. Bare ids stay spawn-without-shell. */
export function harnessSpawnUsesShell(command: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return false;
  const base = command.replace(/\\/g, "/").split("/").pop() ?? "";
  return /^[A-Za-z][A-Za-z0-9_-]*\.cmd$/i.test(base);
}

/** Allowlisted npm-global inner `.exe`, relative to the directory that contains `name.cmd`. */
export const WIN_NPM_INNER_EXE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  claude: Object.freeze(["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"]),
});

export function findWinNpmInnerExe(
  cliId: string,
  options: {
    platform?: NodeJS.Platform | undefined;
    pathEnv?: string | undefined;
    existsSync?: ((path: string) => boolean) | undefined;
  } = {},
): string | undefined {
  if ((options.platform ?? process.platform) !== "win32") return undefined;
  const segments = WIN_NPM_INNER_EXE[cliId];
  if (!segments) return undefined;
  const exists = options.existsSync ?? existsSync;
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  for (const dir of pathEnv.split(";").filter(Boolean)) {
    if (!exists(win32Path.join(dir, `${cliId}.cmd`))) continue;
    const inner = win32Path.join(dir, ...segments);
    if (exists(inner)) return inner;
  }
  return undefined;
}

function defaultRunner(env: NodeJS.ProcessEnv): (command: string, args: readonly string[], timeoutMs: number) => HarnessCommandResult {
  return (command, args, timeoutMs) => {
    try {
      const result = spawnSync(command, [...args], {
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
        env,
        shell: harnessSpawnUsesShell(command),
      });
      if (result.error) {
        const code = (result.error as NodeJS.ErrnoException).code;
        return { ok: false, code: result.status, stdout: "", stderr: result.stderr?.toString() ?? "", error: code ?? result.error.message };
      }
      return {
        ok: result.status === 0,
        code: result.status,
        stdout: result.stdout?.toString() ?? "",
        stderr: result.stderr?.toString() ?? "",
      };
    } catch (error) {
      return { ok: false, code: null, stdout: "", stderr: "", error: error instanceof Error ? error.message : "spawn_failed" };
    }
  };
}

function firstLine(text: string): string | undefined {
  const line = text.split(/\r?\n/).map((candidate) => candidate.trim()).find(Boolean);
  return line && line.length <= 200 ? line : undefined;
}

function boundText(text: string, max = 4000): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

function authLines(result: HarnessCommandResult): string[] {
  return `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text.trim());
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Inventory auth is fail-closed unknown, not a dump of the raw body.
  }
  return undefined;
}

function authConflictIssue(result: HarnessCommandResult): string | undefined {
  const fields: string[] = [];
  const okTrue = result.ok === true;
  const codeZero = result.code === 0;
  if (okTrue !== codeZero) fields.push("ok", "code");
  if (okTrue && result.error) {
    if (!fields.includes("ok")) fields.push("ok");
    fields.push("error");
  }
  return fields.length > 0 ? `auth_conflict:${fields.join(",")}` : undefined;
}

function commandSucceeded(result: HarnessCommandResult): boolean {
  return result.ok === true && result.code === 0 && !result.error;
}

function isCodexApiKeyLine(line: string): boolean {
  return line === CODEX_API_KEY_PREFIX || line.startsWith(`${CODEX_API_KEY_PREFIX} - `);
}

function interpretAuth(id: string, result: HarnessCommandResult): { authenticated: boolean | null; issues: string[] } {
  const conflict = authConflictIssue(result);
  if (conflict) return { authenticated: null, issues: [conflict] };
  if (result.error) return { authenticated: null, issues: ["auth_probe_error"] };

  const lines = authLines(result);
  if (id === "claude") {
    const payload = parseJsonObject(result.stdout);
    if (payload && payload.loggedIn === false) return { authenticated: false, issues: ["not_authenticated"] };
    if (commandSucceeded(result) && payload && payload.loggedIn === true) return { authenticated: true, issues: [] };
    return { authenticated: null, issues: ["auth_unparsed"] };
  }
  if (id === "codex") {
    if (lines.some((line) => line === CODEX_NEGATIVE_LINE || line.startsWith(`${CODEX_NEGATIVE_LINE} `))) {
      return { authenticated: false, issues: ["not_authenticated"] };
    }
    if (commandSucceeded(result) && lines.some((line) => line === CODEX_CHATGPT_LINE)) {
      return { authenticated: true, issues: [] };
    }
    if (commandSucceeded(result) && lines.some((line) => isCodexApiKeyLine(line))) {
      return { authenticated: true, issues: ["auth_api_key"] };
    }
    return { authenticated: null, issues: ["auth_unparsed"] };
  }
  if (id === "grok") {
    if (commandSucceeded(result) && lines.some((line) => line === GROK_LOGIN_LINE)) return { authenticated: true, issues: [] };
    return { authenticated: null, issues: ["auth_unparsed"] };
  }
  if (id === "agy") {
    const text = `${result.stdout}\n${result.stderr}`;
    if (!commandSucceeded(result) || !text.trim()) {
      return { authenticated: false, issues: ["not_authenticated"] };
    }
    if (AGY_MODEL_ROW.test(text)) return { authenticated: true, issues: [] };
    return { authenticated: null, issues: ["auth_unparsed"] };
  }
  if (id === "kimi") {
    if (!commandSucceeded(result)) {
      return { authenticated: false, issues: ["not_authenticated"] };
    }
    if (lines.some((line) => /not logged in|no provider/i.test(line))) {
      return { authenticated: false, issues: ["not_authenticated"] };
    }
    if (lines.some((line) => line.includes("managed:kimi") || line.includes("type=kimi") || line.includes("Default model:"))) {
      return { authenticated: true, issues: [] };
    }
    return { authenticated: null, issues: ["auth_unparsed"] };
  }
  return { authenticated: null, issues: ["auth_unparsed"] };
}

export function resolveDispatchStatus(
  entry: HarnessCatalogEntry,
  detected: boolean,
  authenticated: boolean | null,
  issues: readonly string[],
): HarnessDispatchStatus {
  if (!detected) {
    return { status: "no", supported: false, reason: "not_detected" };
  }
  if (entry.id !== "pi" && !entry.oneShot) {
    return {
      status: "no",
      supported: false,
      reason: entry.id === "gemini" ? "deprecated_client" : "no_headless_mode",
    };
  }
  if (authenticated === false) {
    return { status: "no", supported: false, reason: "not_authenticated" };
  }
  if (authenticated === null) {
    const authIssue = issues.find((issue) => issue === "auth_context_required" || issue === "auth_unknown" || issue === "auth_unparsed" || issue.startsWith("auth_"));
    return { status: "no", supported: false, reason: authIssue ?? issues[0] ?? "auth_unknown" };
  }
  return { status: "yes", supported: true };
}

function tryHarnessCommand(
  candidate: string,
  entry: HarnessCatalogEntry,
  runCommand: (command: string, args: readonly string[], timeoutMs: number) => HarnessCommandResult,
  timeoutMs: number,
): { command: string; version: string | undefined } | undefined {
  const result = runCommand(candidate, entry.versionArgs, timeoutMs);
  if (result.error === "ENOENT") return undefined;
  if (result.error && result.code === null && !result.stdout && !result.stderr) return undefined;
  return {
    command: candidate,
    version: firstLine(result.stdout) ?? firstLine(result.stderr),
  };
}

function detectHarnessCommand(
  entry: HarnessCatalogEntry,
  runCommand: (command: string, args: readonly string[], timeoutMs: number) => HarnessCommandResult,
  timeoutMs: number,
  platform: NodeJS.Platform,
  probe: Pick<HarnessProbeOptions, "env" | "existsSync"> = {},
): { command: string; version: string | undefined } | undefined {
  const candidates = entry.commands.flatMap((base) => [...harnessCommandCandidates(base, platform)]);
  for (const candidate of candidates) {
    if (isWindowsHarnessShim(candidate)) continue;
    const found = tryHarnessCommand(candidate, entry, runCommand, timeoutMs);
    if (found) return found;
  }
  const inner = findWinNpmInnerExe(entry.id, {
    platform,
    pathEnv: probe.env?.PATH ?? process.env.PATH ?? "",
    existsSync: probe.existsSync,
  });
  if (inner) {
    const found = tryHarnessCommand(inner, entry, runCommand, timeoutMs);
    if (found) return found;
  }
  for (const candidate of candidates) {
    if (!isWindowsHarnessShim(candidate)) continue;
    const found = tryHarnessCommand(candidate, entry, runCommand, timeoutMs);
    if (found) return found;
  }
  return undefined;
}

function probeEntry(
  entry: HarnessCatalogEntry,
  runCommand: (command: string, args: readonly string[], timeoutMs: number) => HarnessCommandResult,
  timeoutMs: number,
  platform: NodeJS.Platform,
  probe: Pick<HarnessProbeOptions, "env" | "existsSync"> = {},
): HarnessStatus {
  const issues: string[] = [];
  const found = detectHarnessCommand(entry, runCommand, timeoutMs, platform, probe);
  const detected = Boolean(found);
  const command = found?.command;
  const version = found?.version;
  let authenticated: boolean | null = null;
  if (!detected) authenticated = false;
  else if (entry.id === "pi") {
    authenticated = null;
    issues.push("auth_context_required");
  } else if (UNKNOWN_AUTH_HARNESSES.has(entry.id) || !entry.authArgs) {
    authenticated = null;
    if (UNKNOWN_AUTH_HARNESSES.has(entry.id)) issues.push("auth_unknown");
  } else if (command) {
    const parsed = interpretAuth(entry.id, runCommand(command, entry.authArgs, timeoutMs));
    authenticated = parsed.authenticated;
    issues.push(...parsed.issues);
  }
  if (command && isWindowsHarnessShim(command)) issues.push("windows_shim");
  const dispatch = resolveDispatchStatus(entry, detected, authenticated, issues);
  return {
    id: entry.id,
    label: entry.label,
    default: entry.default,
    mode: entry.mode,
    detected,
    authenticated,
    dispatch,
    ...(command ? { command } : {}),
    ...(version ? { version } : {}),
    canUpdate: {
      self: Boolean(entry.update.self.length),
      extensions: Boolean(entry.update.extensions?.length),
      models: Boolean(entry.update.models?.length),
    },
    issues,
  };
}

export function probeHarnesses(options: HarnessProbeOptions = {}): HarnessInventory {
  const timeoutMs = options.timeoutMs ?? 3000;
  const runCommand = options.runCommand ?? defaultRunner(options.env ?? process.env);
  const platform = options.platform ?? process.platform;
  return {
    defaultHarness: DEFAULT_HARNESS,
    harnesses: BUILTIN_HARNESSES.map((entry) => probeEntry(entry, runCommand, timeoutMs, platform, options)),
  };
}

export function eligibleHarnesses(inventory: HarnessInventory): readonly string[] {
  const eligible = inventory.harnesses
    .filter((entry) => entry.detected && entry.authenticated === true)
    .map((entry) => entry.id);
  if (eligible.length === 0) throw new Error("no_authenticated_harness");
  return eligible;
}

export function validateHarnessModelPair(
  harnessId: string,
  modelSpec: string | HarnessModelSpec,
): HarnessModelValidation {
  if (!isKnownHarnessId(harnessId)) {
    return { valid: false, issue: "harness_unknown", message: `unknown harness: ${harnessId}` };
  }
  let provider: string | undefined;
  let model: string | undefined;
  if (typeof modelSpec === "string") {
    const trimmed = modelSpec.trim();
    if (trimmed.includes("/")) {
      const idx = trimmed.indexOf("/");
      provider = trimmed.slice(0, idx).toLowerCase();
      model = trimmed.slice(idx + 1);
    } else {
      model = trimmed;
    }
  } else {
    provider = modelSpec.provider?.trim().toLowerCase();
    model = modelSpec.model?.trim();
  }

  if (harnessId === "claude") {
    if (provider && provider !== "anthropic") {
      return { valid: false, issue: "harness_unhosted_model", message: `harness claude does not host provider ${provider}` };
    }
    if (model && /^(gpt|o1|o3|grok|gemini|kimi|moonshot|deepseek|qwen)-/i.test(model)) {
      return { valid: false, issue: "harness_unhosted_model", message: `harness claude does not host model ${model}` };
    }
    return { valid: true };
  }

  if (harnessId === "codex") {
    if (provider && provider !== "openai") {
      return { valid: false, issue: "harness_unhosted_model", message: `harness codex does not host provider ${provider}` };
    }
    if (model && /^(claude|fable|grok|gemini|kimi|moonshot|deepseek|qwen)-/i.test(model)) {
      return { valid: false, issue: "harness_unhosted_model", message: `harness codex does not host model ${model}` };
    }
    return { valid: true };
  }

  if (harnessId === "grok") {
    if (provider && provider !== "xai") {
      return { valid: false, issue: "harness_unhosted_model", message: `harness grok does not host provider ${provider}` };
    }
    if (model && !/^grok-/i.test(model)) {
      return { valid: false, issue: "harness_unhosted_model", message: `harness grok only hosts grok models, received ${model}` };
    }
    return { valid: true };
  }

  if (harnessId === "agy" || harnessId === "gemini") {
    if (provider && provider !== "google") {
      return { valid: false, issue: "harness_unhosted_model", message: `harness ${harnessId} does not host provider ${provider}` };
    }
    if (model && !/^gemini-/i.test(model)) {
      return { valid: false, issue: "harness_unhosted_model", message: `harness ${harnessId} only hosts gemini models, received ${model}` };
    }
    return { valid: true };
  }

  if (harnessId === "kimi") {
    if (provider && provider !== "moonshot") {
      return { valid: false, issue: "harness_unhosted_model", message: `harness kimi does not host provider ${provider}` };
    }
    if (model && !/^(kimi|moonshot)-/i.test(model)) {
      return { valid: false, issue: "harness_unhosted_model", message: `harness kimi only hosts kimi/moonshot models, received ${model}` };
    }
    return { valid: true };
  }

  if (harnessId === "deepseek") {
    if (provider && provider !== "deepseek") {
      return { valid: false, issue: "harness_unhosted_model", message: `harness deepseek does not host provider ${provider}` };
    }
    if (model && !/^deepseek-/i.test(model)) {
      return { valid: false, issue: "harness_unhosted_model", message: `harness deepseek only hosts deepseek models, received ${model}` };
    }
    return { valid: true };
  }

  if (harnessId === "pi") {
    if (provider && PI_NATIVE_BRAKE_PROVIDERS.includes(provider)) {
      return {
        valid: false,
        issue: "pi_native_impersonation_blocked",
        message: `pi must not impersonate native provider ${provider}; use the native harness`,
      };
    }
    if (!provider && model && PI_NATIVE_BRAKE_PROVIDERS.some((p) => model!.toLowerCase().startsWith(`${p}/`))) {
      return {
        valid: false,
        issue: "pi_native_impersonation_blocked",
        message: `pi must not impersonate native model ${model}; use the native harness`,
      };
    }
    return { valid: true };
  }

  return { valid: true };
}

export interface HarnessAssignmentProbeOptions {
  harness: string;
  provider?: string | undefined;
  model?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  runCommand?: ((command: string, args: readonly string[], timeoutMs: number) => HarnessCommandResult) | undefined;
  timeoutMs?: number | undefined;
  platform?: NodeJS.Platform | undefined;
  existsSync?: ((path: string) => boolean) | undefined;
}

export function probeHarnessAssignment(options: HarnessAssignmentProbeOptions): HarnessStatus {
  const timeoutMs = options.timeoutMs ?? 3000;
  const runCommand = options.runCommand ?? defaultRunner(options.env ?? process.env);
  const platform = options.platform ?? process.platform;
  const entry = BUILTIN_HARNESSES.find((candidate) => candidate.id === options.harness);
  if (!entry) {
    return {
      id: options.harness,
      label: options.harness,
      default: false,
      mode: "either",
      detected: false,
      authenticated: false,
      dispatch: { status: "no", supported: false, reason: "harness_unknown" },
      canUpdate: { self: false, extensions: false, models: false },
      issues: ["harness_unknown"],
    };
  }

  if (options.provider || options.model) {
    const validation = validateHarnessModelPair(options.harness, { provider: options.provider, model: options.model });
    if (!validation.valid) {
      return {
        id: entry.id,
        label: entry.label,
        default: entry.default,
        mode: entry.mode,
        detected: false,
        authenticated: false,
        dispatch: { status: "no", supported: false, reason: validation.issue ?? "harness_unhosted_model" },
        canUpdate: {
          self: Boolean(entry.update.self.length),
          extensions: Boolean(entry.update.extensions?.length),
          models: Boolean(entry.update.models?.length),
        },
        issues: [validation.issue ?? "harness_unhosted_model"],
      };
    }
  }

  const found = detectHarnessCommand(entry, runCommand, timeoutMs, platform, options);
  const detected = Boolean(found);
  const command = found?.command;
  const version = found?.version;
  const shimIssue = command && isWindowsHarnessShim(command) ? ["windows_shim"] : [];

  if (!detected || !command) {
    return {
      id: entry.id,
      label: entry.label,
      default: entry.default,
      mode: entry.mode,
      detected: false,
      authenticated: false,
      dispatch: { status: "no", supported: false, reason: "not_detected" },
      canUpdate: {
        self: Boolean(entry.update.self.length),
        extensions: Boolean(entry.update.extensions?.length),
        models: Boolean(entry.update.models?.length),
      },
      issues: [],
    };
  }

  if (entry.id === "pi") {
    if (!options.provider && !options.model) {
      return {
        id: entry.id,
        label: entry.label,
        default: entry.default,
        mode: entry.mode,
        detected: true,
        authenticated: null,
        dispatch: { status: "no", supported: false, reason: "auth_context_required" },
        command,
        ...(version ? { version } : {}),
        canUpdate: {
          self: Boolean(entry.update.self.length),
          extensions: Boolean(entry.update.extensions?.length),
          models: Boolean(entry.update.models?.length),
        },
        issues: ["auth_context_required", ...shimIssue],
      };
    }

    const authArgs = ["auth", "check"];
    if (options.model) {
      authArgs.push("--model", options.model);
    } else if (options.provider) {
      authArgs.push("--provider", options.provider);
    }
    authArgs.push("--json");
    const result = runCommand(command, authArgs, timeoutMs);
    const parsed = parseJsonObject(result.stdout);
    let authenticated: boolean | null = false;
    const issues: string[] = [];
    if (result.error) {
      issues.push("auth_probe_error");
    } else if (parsed && parsed.status === "ready") {
      authenticated = true;
    } else if (parsed && parsed.status === "not_ready") {
      authenticated = false;
      issues.push("not_authenticated");
    } else if (commandSucceeded(result) && /\bready\b/i.test(`${result.stdout}\n${result.stderr}`)) {
      authenticated = true;
    } else {
      authenticated = false;
      issues.push("not_authenticated");
    }
    issues.push(...shimIssue);

    const dispatch = resolveDispatchStatus(entry, true, authenticated, issues);

    return {
      id: entry.id,
      label: entry.label,
      default: entry.default,
      mode: entry.mode,
      detected: true,
      authenticated,
      dispatch,
      command,
      ...(version ? { version } : {}),
      canUpdate: {
        self: Boolean(entry.update.self.length),
        extensions: Boolean(entry.update.extensions?.length),
        models: Boolean(entry.update.models?.length),
      },
      issues,
    };
  }

  return probeEntry(entry, runCommand, timeoutMs, platform);
}

export function probeHarnessesForModel(
  modelSpec: HarnessModelSpec,
  options: HarnessProbeOptions = {},
): HarnessInventory {
  const timeoutMs = options.timeoutMs ?? 3000;
  const runCommand = options.runCommand ?? defaultRunner(options.env ?? process.env);
  const platform = options.platform ?? process.platform;
  return {
    defaultHarness: DEFAULT_HARNESS,
    harnesses: BUILTIN_HARNESSES.map((entry) =>
      probeHarnessAssignment({
        harness: entry.id,
        provider: modelSpec.provider,
        model: modelSpec.model,
        runCommand,
        timeoutMs,
        platform,
        env: options.env,
        existsSync: options.existsSync,
      })
    ),
  };
}

function scopesFor(scope: HarnessUpdateScope, entry: HarnessCatalogEntry): Exclude<HarnessUpdateScope, "all">[] {
  if (scope === "self") return ["self"];
  if (scope === "extensions") return entry.update.extensions ? ["extensions"] : [];
  if (scope === "models") return entry.update.models ? ["models"] : [];
  return [
    ...(entry.update.self.length ? ["self" as const] : []),
    ...(entry.update.extensions ? ["extensions" as const] : []),
    ...(entry.update.models ? ["models" as const] : []),
  ];
}

function argsFor(entry: HarnessCatalogEntry, scope: Exclude<HarnessUpdateScope, "all">): readonly string[] | undefined {
  if (scope === "self") return entry.update.self;
  if (scope === "extensions") return entry.update.extensions;
  return entry.update.models;
}

export function planHarnessUpdate(
  inventory: HarnessInventory,
  requested: { harness?: string; scope: HarnessUpdateScope },
): HarnessUpdateStep[] {
  const selected = requested.harness
    ? inventory.harnesses.filter((entry) => entry.id === requested.harness)
    : inventory.harnesses.filter((entry) => entry.detected);
  if (requested.harness && selected.length === 0) {
    return [{
      harness: requested.harness,
      scope: "self",
      command: requested.harness,
      args: [],
      outcome: "skipped",
      detail: isKnownHarnessId(requested.harness) ? "not_detected" : "unknown_harness",
    }];
  }
  const steps: HarnessUpdateStep[] = [];
  for (const status of selected) {
    const entry = BUILTIN_HARNESSES.find((candidate) => candidate.id === status.id);
    if (!entry) continue;
    const scopes = scopesFor(requested.scope, entry);
    if (scopes.length === 0) {
      steps.push({
        harness: status.id,
        scope: requested.scope === "all" ? "self" : requested.scope,
        command: status.command ?? entry.commands[0]!,
        args: [],
        outcome: "skipped",
        detail: "no_updater",
      });
      continue;
    }
    if (!status.detected || !status.command) {
      steps.push({
        harness: status.id,
        scope: scopes[0]!,
        command: entry.commands[0]!,
        args: argsFor(entry, scopes[0]!) ?? [],
        outcome: "skipped",
        detail: "not_detected",
      });
      continue;
    }
    for (const scope of scopes) {
      const args = argsFor(entry, scope) ?? [];
      steps.push({ harness: status.id, scope, command: status.command, args, outcome: "would" });
    }
  }
  return steps;
}

export function runHarnessUpdate(
  steps: readonly HarnessUpdateStep[],
  options: HarnessProbeOptions & { dryRun?: boolean; updateTimeoutMs?: number } = {},
): HarnessUpdateStep[] {
  if (options.dryRun) return steps.map((step) => ({ ...step, outcome: step.outcome === "would" ? "would" : step.outcome }));
  const timeoutMs = options.updateTimeoutMs ?? 180_000;
  const runCommand = options.runCommand ?? defaultRunner(options.env ?? process.env);
  return steps.map((step) => {
    if (step.outcome !== "would") return step;
    const result = runCommand(step.command, step.args, timeoutMs);
    const detail = boundText(result.stderr) ?? boundText(result.stdout) ?? result.error;
    return {
      ...step,
      outcome: result.ok ? "passed" : "failed",
      ...(result.code !== undefined && result.code !== null ? { code: result.code } : {}),
      ...(detail ? { detail } : {}),
    };
  });
}

export function formatHarnessInventory(inventory: HarnessInventory): string {
  const header = [
    "id".padEnd(9),
    "default".padEnd(8),
    "detected".padEnd(9),
    "auth".padEnd(8),
    "dispatch".padEnd(26),
    "updates",
  ].join(" ");
  const rows = inventory.harnesses.map((entry) => {
    const auth = entry.authenticated === true ? "yes" : entry.authenticated === false ? "no" : "unknown";
    const dispatchText = entry.dispatch
      ? (entry.dispatch.status === "yes" ? "yes" : `no (${entry.dispatch.reason ?? "unsupported"})`)
      : (entry.authenticated === true ? "yes" : "no");
    const updates = [
      entry.canUpdate.self ? "self" : undefined,
      entry.canUpdate.extensions ? "extensions" : undefined,
      entry.canUpdate.models ? "models" : undefined,
    ].filter(Boolean).join(",") || "none";
    const apiKeyNote = entry.issues.includes("auth_api_key") ? " API key" : "";
    return [
      entry.id.padEnd(9),
      (entry.default ? "yes" : "no").padEnd(8),
      (entry.detected ? "yes" : "no").padEnd(9),
      auth.padEnd(8),
      dispatchText.padEnd(26),
      `${updates}${apiKeyNote}`,
    ].join(" ");
  });
  return [
    `default harness: ${inventory.defaultHarness} (omit agent harness: to use headless Pi)`,
    "enable/disable = Git YAML (.kxm/agents, .kxm/models) or the harness's own plugin CLI",
    "governed kxm skills are not auto-updated",
    header,
    ...rows,
  ].join("\n");
}

export function formatHarnessUpdate(steps: readonly HarnessUpdateStep[]): string {
  if (steps.length === 0) return "nothing to update";
  return steps.map((step) => {
    const argv = [step.command, ...step.args].join(" ");
    const detail = step.detail ? ` (${step.detail})` : "";
    return `${step.harness} ${step.scope}: ${step.outcome} ${argv}${detail}`;
  }).join("\n");
}
