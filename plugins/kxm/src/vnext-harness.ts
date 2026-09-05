import { spawnSync } from "node:child_process";

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
}

export interface HarnessProbeOptions {
  env?: NodeJS.ProcessEnv;
  runCommand?: (command: string, args: readonly string[], timeoutMs: number) => HarnessCommandResult;
  timeoutMs?: number;
}

export interface HarnessStatus {
  id: string;
  label: string;
  default: boolean;
  mode: HarnessMode;
  detected: boolean;
  authenticated: boolean | null;
  command?: string;
  version?: string;
  canUpdate: { self: boolean; extensions: boolean; models: boolean };
  issues: readonly string[];
}

export interface HarnessInventory {
  defaultHarness: typeof DEFAULT_HARNESS;
  harnesses: readonly HarnessStatus[];
}

const UNKNOWN_AUTH_HARNESSES = new Set(["kimi", "gemini", "deepseek"]);
const GROK_LOGIN_LINE = "You are logged in with grok.com.";
const CODEX_CHATGPT_LINE = "Logged in using ChatGPT";
const CODEX_API_KEY_PREFIX = "Logged in using an API key";
const CODEX_NEGATIVE_LINE = "Not logged in";

export interface HarnessUpdateStep {
  harness: string;
  scope: Exclude<HarnessUpdateScope, "all">;
  command: string;
  args: readonly string[];
  outcome: "would" | "passed" | "failed" | "skipped";
  code?: number | null;
  detail?: string;
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
  },
  {
    id: "kimi",
    label: "Kimi Code",
    default: false,
    mode: "either",
    commands: ["kimi"],
    versionArgs: ["--version"],
    update: { self: ["upgrade"] },
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
  },
]);

export const BUILTIN_HARNESS_IDS: readonly string[] = BUILTIN_HARNESSES.map((entry) => entry.id);

export function isKnownHarnessId(id: string, extra: Iterable<string> = []): boolean {
  if (BUILTIN_HARNESS_IDS.includes(id)) return true;
  for (const candidate of extra) if (candidate === id) return true;
  return false;
}

function defaultRunner(env: NodeJS.ProcessEnv): (command: string, args: readonly string[], timeoutMs: number) => HarnessCommandResult {
  return (command, args, timeoutMs) => {
    try {
      const result = spawnSync(command, [...args], {
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
        env,
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
  return { authenticated: null, issues: ["auth_unparsed"] };
}

function probeEntry(
  entry: HarnessCatalogEntry,
  runCommand: (command: string, args: readonly string[], timeoutMs: number) => HarnessCommandResult,
  timeoutMs: number,
): HarnessStatus {
  const issues: string[] = [];
  let detected = false;
  let command: string | undefined;
  let version: string | undefined;
  for (const candidate of entry.commands) {
    const result = runCommand(candidate, entry.versionArgs, timeoutMs);
    if (result.error === "ENOENT") continue;
    if (result.error && result.code === null && !result.stdout && !result.stderr) continue;
    detected = true;
    command = candidate;
    version = firstLine(result.stdout) ?? firstLine(result.stderr);
    break;
  }
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
  return {
    id: entry.id,
    label: entry.label,
    default: entry.default,
    mode: entry.mode,
    detected,
    authenticated,
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
  return {
    defaultHarness: DEFAULT_HARNESS,
    harnesses: BUILTIN_HARNESSES.map((entry) => probeEntry(entry, runCommand, timeoutMs)),
  };
}

export function eligibleHarnesses(inventory: HarnessInventory): readonly string[] {
  const eligible = inventory.harnesses
    .filter((entry) => entry.detected && entry.authenticated === true)
    .map((entry) => entry.id);
  if (eligible.length === 0) throw new Error("no_authenticated_harness");
  return eligible;
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
  const header = "id        default  detected  auth     updates";
  const rows = inventory.harnesses.map((entry) => {
    const auth = entry.authenticated === true ? "yes" : entry.authenticated === false ? "no" : "unknown";
    const updates = [
      entry.canUpdate.self ? "self" : undefined,
      entry.canUpdate.extensions ? "extensions" : undefined,
      entry.canUpdate.models ? "models" : undefined,
    ].filter(Boolean).join(",") || "none";
    const apiKeyNote = entry.issues.includes("auth_api_key") ? " API key" : "";
    return [
      entry.id.padEnd(9),
      (entry.default ? "yes" : "no").padEnd(7),
      (entry.detected ? "yes" : "no").padEnd(8),
      auth.padEnd(8),
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
