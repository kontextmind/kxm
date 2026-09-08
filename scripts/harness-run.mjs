#!/usr/bin/env node
// Dev-helper envelope over verified headless CLIs. Not a Phase 11 product adapter.
//
// Reads a `kxm.harness-request.v1` JSON envelope (file argument or stdin),
// dispatches it to an allowlisted provider CLI, and prints a
// `kxm.harness-result.v2` envelope on stdout. Transport `completed` requires
// an observed exit code of exactly 0 and observed stdout/stderr completion
// (close or both streams drained). Valid JSON alone is not complete output.
// Transport completion is not product `routing-record.v1` finalOutcome and is
// not a model claim.
// Raw model/terminal payloads stay in private 0600 sidecars, not metadata.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const { posix, win32, join } = nodePath;
const resolvePath = nodePath.resolve;

export const REQUEST_SCHEMA = "kxm.harness-request.v1";
export const RESULT_SCHEMA = "kxm.harness-result.v2";
export const OBSOLETE_RESULT_SCHEMA = "kxm.harness-result.v1";
export const ROUTING_INT_CAP = 1_000_000;
export const TOKEN_BASIS = "cumulative";
export const CONTEXT_OCCUPANCY_UNKNOWN = "unknown";
export const COST_BASIS = Object.freeze(["provider-reported", "list", "unmetered", "unknown"]);
export const MODEL_CLAIM_STATUSES = Object.freeze(["done", "partial", "fail", "blocked"]);
export const REVIEW_VERDICTS = Object.freeze(["PASS", "BLOCK"]);
export const CLAIM_SOURCES = Object.freeze(["structured_output", "result", "none"]);
export const CLAIM_COUNT_CAP = 1000;
export const TRANSPORT_STATUSES = Object.freeze(["completed", "failed", "interrupted"]);
export const TRANSPORT_STAGES = Object.freeze(["preflight", "auth", "spawn", "run"]);
export const STOP_REASONS = Object.freeze(["end_turn", "stop", "error", "aborted", "toolUse", "unrecognized"]);
export const ERROR_CODES = Object.freeze([
  "preflight_failed",
  "auth_failed",
  "spawn_failed",
  "empty_payload",
  "timed_out",
  "signaled",
  "model_error",
  "turn_failed",
  "stop_error",
  "stop_aborted",
  "normalization_failed",
  "write_failed",
  "stdio_incomplete",
  "unknown_exit",
  "unrecognized",
]);
const DEFAULT_KILL_GRACE_MS = 2_000;
const KNOWN_RESULT_SCHEMAS = Object.freeze([RESULT_SCHEMA, OBSOLETE_RESULT_SCHEMA]);

export const EFFORT = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Pi must not impersonate a provider that has a native harness rule. */
export const NATIVE_PI_BRAKE_PROVIDERS = Object.freeze([
  "anthropic",
  "openai",
  "xai",
  "moonshot",
  "google",
  "deepseek",
]);

/** Verified Pi aggregator prefixes. Not a catalog and not a writer grant. */
export const PI_ALLOWED_PROVIDERS = Object.freeze(["openrouter", "nous-portal"]);

/** Exact helper model string after `@jayteelabs/pi-nous-portal-provider` is installed. */
export const PI_NOUS_PORTAL_HY4 = "nous-portal/tencent/hy4-preview";

/** Narrowly admitted Pi writer. Other Pi models need reviewed route admission. */
export const PI_ADMITTED_WRITER = "openrouter/qwen/qwen3-coder-plus";

const REQUEST_KEYS = Object.freeze([
  "schema",
  "role",
  "harness",
  "model",
  "effort",
  "permission",
  "prompt_file",
  "cwd",
  "skills",
  "hooks",
  "max_cost_usd",
  "output_schema",
  "timeout_ms",
  "output_dir",
  "max_turns",
]);

const UNSUPPORTED_LAUNCHER = /\.(cmd|bat|ps1)$/i;

const AGY_MODELS = Object.freeze([
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-low",
  "gemini-3.7-flash-high",
  "gemini-3.7-flash-medium",
  "gemini-3.7-flash-low",
  "gemini-3.6-flash-high",
  "gemini-3.6-flash-medium",
  "gemini-3.6-flash-low",
  "gemini-3.1-pro-high",
  "gemini-3.1-pro-low",
]);

/** Tab-separated `id<TAB>label` rows from `agy models` (committed probe fixture). */
const AGY_MODEL_ROW = /^[a-z0-9][a-z0-9.+_-]*\t+\S/im;

function agyModelsListed(text) {
  return AGY_MODEL_ROW.test(String(text ?? ""));
}

/** Verified helper routes only. Kimi/Gemini/DeepSeek CLIs fail closed. */
export const ROUTES = Object.freeze({
  grok: {
    provider: "xai",
    roles: Object.freeze(["writer"]),
    permissions: Object.freeze(["edit"]),
    models: Object.freeze(["grok-4.6"]),
    efforts: Object.freeze(["low", "medium", "high"]),
    auth: Object.freeze({ args: ["models"], loginHint: "grok (OAuth to auth.x.ai)" }),
  },
  agy: {
    provider: "google",
    roles: Object.freeze(["writer", "experiment"]),
    permissions: Object.freeze(["edit"]),
    models: AGY_MODELS,
    efforts: Object.freeze(["low", "medium", "high"]),
    auth: Object.freeze({ args: ["models"], loginHint: "agy (Antigravity OAuth)" }),
  },
  claude: {
    provider: "anthropic",
    roles: Object.freeze(["planner", "reviewer-arch"]),
    permissions: Object.freeze(["read-only"]),
    models: Object.freeze(["fable"]),
    efforts: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
    auth: Object.freeze({ args: ["auth", "status"], loginHint: "claude auth login" }),
  },
  codex: {
    provider: "openai",
    roles: Object.freeze(["reviewer-cli"]),
    permissions: Object.freeze(["read-only"]),
    models: Object.freeze(["gpt-5.6-sol"]),
    efforts: Object.freeze(["low", "medium", "high"]),
    auth: Object.freeze({ args: ["login", "status"], loginHint: "codex login" }),
  },
  pi: {
    provider: "openrouter",
    roles: Object.freeze(["experiment", "planner", "reviewer-arch", "reviewer-cli", "writer"]),
    permissions: Object.freeze(["read-only", "edit"]),
    models: Object.freeze([]),
    efforts: EFFORT,
    auth: Object.freeze({
      args: ["auth", "check"],
      loginHint: "pi /login openrouter or install @jayteelabs/pi-nous-portal-provider and /login Nous Research Portal",
    }),
  },
});

const UNVERIFIED_HARNESSES = Object.freeze(["kimi", "gemini", "deepseek"]);

export function clampEffort(harness, effort) {
  const accepted = ROUTES[harness]?.efforts ?? [];
  if (!effort) return { effort: undefined, clamped: undefined };
  if (!EFFORT.includes(effort)) {
    throw failClosed(`unknown effort ${effort}; expected one of ${EFFORT.join(", ")}`);
  }
  if (accepted.length === 0) return { effort: undefined, clamped: effort };
  if (accepted.includes(effort)) return { effort, clamped: undefined };
  const want = EFFORT.indexOf(effort);
  let best = accepted[0];
  for (const candidate of accepted) {
    if (Math.abs(EFFORT.indexOf(candidate) - want) < Math.abs(EFFORT.indexOf(best) - want)) {
      best = candidate;
    }
  }
  return { effort: best, clamped: effort };
}

export function parseJson(text) {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Mixed stdout: take the outermost object if it parses.
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function failClosed(message, stage = "preflight") {
  const error = new Error(message);
  error.failClosed = true;
  error.stage = stage;
  return error;
}

function piLoginHint(provider) {
  if (provider === "nous-portal") {
    return "pi install npm:@jayteelabs/pi-nous-portal-provider, then /login → subscription or API key → Nous Research Portal (or NOUS_API_KEY)";
  }
  if (provider === "openrouter") return "pi /login openrouter";
  return ROUTES.pi.auth.loginHint;
}

function loginHint(harness, detail, provider) {
  const hint = harness === "pi"
    ? piLoginHint(provider)
    : (ROUTES[harness]?.auth.loginHint ?? "the native harness CLI");
  return `${detail} Log in with ${hint} and retry; native-provider Pi fallback is not used.`;
}

export function piProviderOf(model) {
  if (typeof model !== "string" || !model.includes("/")) return undefined;
  return model.slice(0, model.indexOf("/")).trim().toLowerCase();
}

export function piModelId(model) {
  const provider = piProviderOf(model);
  if (!provider) return undefined;
  const id = model.slice(model.indexOf("/") + 1).trim();
  return id || undefined;
}

function piProviderLabel(provider) {
  if (provider === "nous-portal") return "Nous Portal";
  if (provider === "openrouter") return "OpenRouter";
  return "Pi provider";
}

export function piAuthCheckArgs(request) {
  const provider = piProviderOf(request.model);
  if (!provider) throw failClosed("pi model must be provider/id");
  const args = [...ROUTES.pi.auth.args, "--provider", provider];
  if (request.role === "writer") {
    const modelId = piModelId(request.model);
    if (!modelId) throw failClosed("pi writer requires provider/id");
    args.push("--model", modelId, "--json");
  }
  return args;
}

function pathApi(platform) {
  return platform === "win32" ? win32 : posix;
}

function isAbsoluteOn(path, platform) {
  if (platform === "win32") return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
  return path.startsWith("/");
}

/** Allowlisted npm-global inner launchers, relative to the directory that contains `name.cmd`. */
export const WIN_NPM_INNER_EXE = Object.freeze({
  claude: Object.freeze(["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"]),
});
export const WIN_NPM_INNER_NODE_SCRIPT = Object.freeze({
  pi: Object.freeze(["node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"]),
});

export function resolveLaunch(cliId, options = {}) {
  const platform = options.platform ?? process.platform;
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const exists = options.existsSync ?? existsSync;
  const delim = platform === "win32" ? ";" : ":";
  const path = pathApi(platform);

  if (!cliId || typeof cliId !== "string" || cliId !== cliId.trim()) {
    throw failClosed("launcher id is required");
  }
  if (cliId.includes("\0")) throw failClosed("launcher id is invalid");

  const explicit = cliId.includes("/") || cliId.includes("\\") || isAbsoluteOn(cliId, platform);
  if (explicit) return { command: assertWinExecutable(cliId, platform, options), args: [] };

  const dirs = pathEnv.split(delim).filter(Boolean);
  let rejectedShim;
  if (platform === "win32") {
    const exeName = cliId.toLowerCase().endsWith(".exe") ? cliId : `${cliId}.exe`;
    for (const dir of dirs) {
      const exe = path.join(dir, exeName);
      if (exists(exe)) return { command: canonicalize(exe, { ...options, platform }), args: [] };
    }
    for (const dir of dirs) {
      const cmdShim = path.join(dir, `${cliId}.cmd`);
      if (!exists(cmdShim)) continue;
      const exeSegs = WIN_NPM_INNER_EXE[cliId];
      if (exeSegs) {
        const inner = path.join(dir, ...exeSegs);
        if (exists(inner)) {
          return { command: assertWinExecutable(inner, platform, options), args: [] };
        }
      }
      const scriptSegs = WIN_NPM_INNER_NODE_SCRIPT[cliId];
      if (scriptSegs) {
        const script = path.join(dir, ...scriptSegs);
        const nodeExe = options.execPath ?? process.execPath;
        if (exists(script) && exists(nodeExe)) {
          return {
            command: canonicalize(nodeExe, { ...options, platform }),
            args: [canonicalize(script, { ...options, platform })],
          };
        }
      }
      rejectedShim = cmdShim;
      break;
    }
    if (!rejectedShim) {
      for (const dir of dirs) {
        for (const ext of [".bat", ".ps1", ""]) {
          const shim = path.join(dir, `${cliId}${ext}`);
          if (exists(shim)) {
            rejectedShim = shim;
            break;
          }
        }
        if (rejectedShim) break;
      }
    }
  } else {
    for (const dir of dirs) {
      if (exists(path.join(dir, cliId))) {
        return { command: canonicalize(path.join(dir, cliId), { ...options, platform }), args: [] };
      }
    }
  }
  if (rejectedShim) {
    throw failClosed(unsupportedLauncherMessage(rejectedShim, platform));
  }
  throw failClosed(`missing binary ${cliId}; install and authenticate the native CLI`);
}

export function resolveLauncher(cliId, options = {}) {
  return resolveLaunch(cliId, options).command;
}

function canonicalize(target, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32" && process.platform !== "win32") return target;
  const realpath = options.realpathSync ?? realpathSync;
  try {
    return realpath(target);
  } catch {
    return resolvePath(target);
  }
}

function assertWinExecutable(target, platform, options = {}) {
  const base = pathApi(platform).basename(target);
  if (UNSUPPORTED_LAUNCHER.test(base)) {
    throw failClosed(unsupportedLauncherMessage(target, platform));
  }
  if (platform === "win32") {
    if (!isAbsoluteOn(target, platform)) {
      throw failClosed(unsupportedLauncherMessage(target, platform));
    }
    if (!base.toLowerCase().endsWith(".exe")) {
      throw failClosed(unsupportedLauncherMessage(target, platform));
    }
  }
  return canonicalize(target, { ...options, platform });
}

export function unsupportedLauncherMessage(target, platform = process.platform) {
  return `unsupported-launcher: Windows helper dispatch is unverified and refuses ${pathApi(platform).basename(target)} `
    + "(.cmd/.bat/.ps1/extensionless). Use an absolute .exe; do not run shims through a shell.";
}

export function parseAuth(harness, stdio, options = {}) {
  const observedAt = options.observedAt ?? new Date().toISOString().slice(0, 10);
  const stdout = stdio.stdout ?? "";
  const stderr = stdio.stderr ?? "";
  const code = stdio.exitCode ?? stdio.status ?? 0;
  if (code !== 0) {
    throw failClosed(loginHint(harness, `${harness} auth command exited ${code}.`), "auth");
  }
  if (harness === "grok") {
    if (!/logged in/i.test(stdout)) {
      throw failClosed(loginHint("grok", "grok models did not report a logged-in session."), "auth");
    }
    const method = /grok\.com/i.test(stdout) ? "grok.com" : "unknown";
    if (method === "unknown") {
      throw failClosed(loginHint("grok", "grok auth method could not be determined."), "auth");
    }
    return { loggedIn: true, method, observedAt };
  }
  if (harness === "claude") {
    const payload = parseJson(stdout);
    if (!payload || typeof payload !== "object") {
      throw failClosed(loginHint("claude", "claude auth status was not parseable JSON."), "auth");
    }
    if (payload.loggedIn !== true) {
      throw failClosed(loginHint("claude", "claude auth status is logged out."), "auth");
    }
    const method = typeof payload.authMethod === "string" ? payload.authMethod : undefined;
    if (!method) {
      throw failClosed(loginHint("claude", "claude auth method is undetermined."), "auth");
    }
    return { loggedIn: true, method, observedAt, subscriptionType: payload.subscriptionType };
  }
  if (harness === "codex") {
    const text = `${stdout}\n${stderr}`;
    if (!/logged in using chatgpt/i.test(text)) {
      throw failClosed(loginHint("codex", "codex login status did not report ChatGPT auth."), "auth");
    }
    return { loggedIn: true, method: "ChatGPT", observedAt };
  }
  if (harness === "pi") {
    const requested = typeof options.provider === "string" && options.provider.trim()
      ? options.provider.trim().toLowerCase()
      : undefined;
    const text = `${stdout}\n${stderr}`;
    const payload = parseJson(stdout);
    const reportedFromJson = typeof payload?.provider === "string"
      ? payload.provider.trim().toLowerCase()
      : undefined;
    const reportedFromText = /\bnous-portal\b/i.test(text)
      ? "nous-portal"
      : /\bopenrouter\b/i.test(text)
        ? "openrouter"
        : undefined;
    const reported = reportedFromJson ?? reportedFromText ?? requested;
    const jsonStatus = typeof payload?.status === "string" ? payload.status : undefined;
    if (/not[_ ]ready/i.test(text) || (jsonStatus !== undefined && jsonStatus !== "ready")
      || !/\bready\b/i.test(text)) {
      throw failClosed(
        loginHint("pi", `pi auth check did not report ${piProviderLabel(requested ?? reported)} ready.`, requested ?? reported),
        "auth",
      );
    }
    if (!reported || (requested && reported !== requested)) {
      throw failClosed(loginHint("pi", "pi auth check provider could not be determined.", requested), "auth");
    }
    if (!PI_ALLOWED_PROVIDERS.includes(reported)) {
      throw failClosed(
        loginHint("pi", `pi helper allows only openrouter/* or nous-portal/*; ${reported} is not allowlisted.`, requested),
        "auth",
      );
    }
    return { loggedIn: true, method: reported, observedAt };
  }
  if (harness === "agy") {
    const text = `${stdout}\n${stderr}`;
    if (!agyModelsListed(text)) {
      throw failClosed(loginHint("agy", "agy models did not print a models list."), "auth");
    }
    return { loggedIn: true, method: "antigravity-oauth", observedAt };
  }
  throw failClosed(`unknown harness ${harness} for auth parse`, "auth");
}

function claudeIsolationArgs(mcpConfigPath) {
  return [
    "--safe-mode",
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfigPath,
    "--disable-slash-commands",
  ];
}

function piDisableArgs(request) {
  const args = [];
  if (request.permission === "read-only") {
    args.push("--no-extensions", "--no-skills", "--no-prompt-templates");
  } else {
    if (request.hooks === false) args.push("--no-extensions");
    if (Array.isArray(request.skills) && request.skills.length === 0) args.push("--no-skills");
  }
  return args;
}

export function buildArgv(request, ctx = {}) {
  const harness = request.harness;
  const model = request.model;
  const effort = request.effort;
  const permission = request.permission;
  const promptPath = ctx.promptPath ?? request.prompt_file;
  const schemaPath = ctx.schemaPath ?? request.output_schema;
  const schemaText = ctx.schemaText ?? (request.output_schema ? readFileSync(request.output_schema, "utf8") : undefined);
  if (harness === "agy") {
    const promptText = ctx.promptText ?? (promptPath ? readFileSync(promptPath, "utf8") : "");
    return [
      "-p",
      promptText,
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
      "--model",
      model,
      ...(effort ? ["--effort", effort] : []),
      ...(schemaPath ? ["--json-schema", schemaPath] : []),
      ...(request.timeout_ms !== undefined ? ["--print-timeout", `${request.timeout_ms}ms`] : []),
    ];
  }
  if (harness === "grok") {
    return [
      "--prompt-file",
      promptPath,
      "-m",
      model,
      ...(effort ? ["--reasoning-effort", effort] : []),
      "--always-approve",
      "--no-subagents",
      "--disable-web-search",
      ...(request.max_turns !== undefined ? ["--max-turns", String(request.max_turns)] : []),
      ...(schemaText !== undefined ? ["--json-schema", schemaText] : []),
      "--output-format",
      "json",
    ];
  }
  if (harness === "claude") {
    const mcpConfigPath = ctx.mcpConfigPath;
    if (!mcpConfigPath) throw failClosed("claude read-only requires an empty MCP config sidecar");
    return [
      "-p",
      "--model",
      model,
      ...(effort ? ["--effort", effort] : []),
      "--tools",
      "Read,Glob,Grep",
      ...claudeIsolationArgs(mcpConfigPath),
      ...(request.max_cost_usd !== undefined ? ["--max-budget-usd", String(request.max_cost_usd)] : []),
      ...(schemaText !== undefined ? ["--json-schema", schemaText] : []),
      "--output-format",
      "json",
    ];
  }
  if (harness === "codex") {
    return [
      "exec",
      "-m",
      model,
      ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
      "--sandbox",
      "read-only",
      "--ignore-user-config",
      ...(schemaPath ? ["--output-schema", schemaPath] : []),
      "--json",
      "-",
    ];
  }
  if (harness === "pi") {
    return [
      "-p",
      "--model",
      model,
      ...(effort ? ["--thinking", effort] : []),
      ...(permission === "read-only" ? ["--tools", "read,grep,find,ls"] : ["-a"]),
      ...piDisableArgs(request),
      "--mode",
      "json",
      `@${promptPath}`,
    ];
  }
  throw failClosed(`no argv builder for harness ${harness}`);
}

export function formatRunCost(result) {
  const basis = result?.costBasis;
  if (basis === "unmetered") return "unmetered";
  if (basis === "unknown" || basis == null) return "unknown";
  const billed = typeof result.costUsd === "number" && Number.isFinite(result.costUsd)
    ? result.costUsd
    : undefined;
  const estimate = typeof result.providerReportedCostUsd === "number"
    && Number.isFinite(result.providerReportedCostUsd)
    ? result.providerReportedCostUsd
    : undefined;
  const amount = billed ?? estimate;
  if (amount === undefined) return "unknown";
  const dollars = `$${amount.toFixed(4)}`;
  if (basis === "list") return `list ${dollars}`;
  if (basis === "billed") return `billed ${dollars}`;
  return `${basis} ${dollars}`;
}

function jsonlEvents(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return undefined;
      try {
        return JSON.parse(trimmed);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
}

function addNumber(left, right) {
  if (typeof right !== "number" || !Number.isFinite(right)) return left;
  return (typeof left === "number" ? left : 0) + right;
}

function closeStopReason(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string" && STOP_REASONS.includes(value)) return value;
  return "unrecognized";
}

function joinDetail(...parts) {
  return parts.filter((part) => typeof part === "string" && part.length > 0).join("\n");
}

export function normalizePi(stdout) {
  const events = jsonlEvents(stdout);
  if (events.length === 0) {
    return {
      emptyPayload: true,
      errorCode: "empty_payload",
      errorDetail: "empty JSON payload",
      costBasis: "unknown",
    };
  }
  const errorEvent = events.find((event) => event.type === "error" || event.type === "agent_error"
    || event.stopReason === "error" || event.message?.stopReason === "error");
  const assistantEnds = events.filter((event) => event.type === "message_end" && event.message?.role === "assistant");
  const usageEvents = [];
  const seen = new Set();
  for (const event of assistantEnds) {
    const identity = event.id ?? event.message?.id;
    if (identity !== undefined && identity !== null && identity !== "") {
      const key = String(identity);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const usage = event.message?.usage ?? {};
    usageEvents.push({
      model: event.message?.model,
      tokensIn: usage.input,
      tokensOut: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheCreationTokens: usage.cacheWrite,
      costUsd: usage.cost?.total,
      stopReason: closeStopReason(event.message?.stopReason),
    });
  }
  const last = assistantEnds.at(-1)?.message;
  let tokensIn;
  let tokensOut;
  let cacheReadTokens;
  let cacheCreationTokens;
  let costUsd;
  for (const entry of usageEvents) {
    tokensIn = addNumber(tokensIn, entry.tokensIn);
    tokensOut = addNumber(tokensOut, entry.tokensOut);
    cacheReadTokens = addNumber(cacheReadTokens, entry.cacheReadTokens);
    cacheCreationTokens = addNumber(cacheCreationTokens, entry.cacheCreationTokens);
    costUsd = addNumber(costUsd, entry.costUsd);
  }
  const rawStop = last?.stopReason;
  const stopReason = closeStopReason(rawStop);
  let errorCode;
  let errorDetail;
  if (errorEvent) {
    errorCode = "model_error";
    errorDetail = String(errorEvent.message?.errorMessage ?? errorEvent.error ?? errorEvent.message ?? "error");
  } else if (stopReason === "error") {
    errorCode = "stop_error";
    errorDetail = "pi stopReason error";
  } else if (stopReason === "aborted") {
    errorCode = "stop_aborted";
    errorDetail = "pi stopReason aborted";
  }
  if (rawStop !== undefined && stopReason === "unrecognized") {
    errorDetail = joinDetail(errorDetail, `stopReason ${String(rawStop)}`);
  }
  return {
    text: assistantText(last),
    sessionId: events.find((event) => event.type === "session")?.id,
    effectiveModel: last?.model,
    tokensIn,
    tokensOut,
    cacheReadTokens,
    cacheCreationTokens,
    costUsd,
    costBasis: costUsd === undefined ? "unknown" : "list",
    stopReason,
    usageEvents,
    tokenBasis: TOKEN_BASIS,
    ...(errorCode ? { errorCode } : {}),
    ...(errorDetail ? { errorDetail } : {}),
  };
}

function assistantText(message) {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
}

export function normalizeCodex(stdout) {
  const events = jsonlEvents(stdout);
  if (events.length === 0) {
    return {
      emptyPayload: true,
      errorCode: "empty_payload",
      errorDetail: "empty JSON payload",
      costBasis: "unknown",
    };
  }
  const message = events.filter((event) => event.item?.type === "agent_message").pop();
  const usage = events.find((event) => event.type === "turn.completed")?.usage ?? {};
  const failure = events.find((event) => event.type === "turn.failed" || event.type === "error");
  return {
    text: message?.item?.text ?? "",
    tokensIn: usage.input_tokens,
    tokensOut: usage.output_tokens,
    cacheReadTokens: usage.cached_input_tokens,
    cacheCreationTokens: usage.cache_write_input_tokens,
    reasoningTokens: usage.reasoning_output_tokens,
    tokenBasis: TOKEN_BASIS,
    costBasis: "unmetered",
    ...(failure
      ? {
        errorCode: "turn_failed",
        errorDetail: String(failure.message ?? failure.error?.message ?? "turn.failed"),
      }
      : {}),
  };
}

export function resolveModelUsage(modelUsage, requestedModel) {
  const entries = Object.entries(modelUsage ?? {});
  const candidates = entries.map(([key]) => key);
  if (entries.length === 0) {
    return { effectiveModel: undefined, primary: undefined, auxiliary: [], candidates };
  }
  const exact = entries.find(([key]) => key === requestedModel);
  if (exact) {
    return {
      effectiveModel: exact[0],
      primary: exact[1],
      auxiliary: entries.filter(([key]) => key !== exact[0]).map(([model, usage]) => usageRow(model, usage)),
      candidates,
      matched: "exact",
    };
  }
  const needle = String(requestedModel ?? "").toLowerCase();
  const unique = needle
    ? entries.filter(([key]) => {
      const lower = key.toLowerCase();
      return lower === needle
        || lower.startsWith(`${needle}-`)
        || lower.split(/[^a-z0-9]+/).includes(needle);
    })
    : [];
  if (unique.length === 1) {
    const [model, usage] = unique[0];
    return {
      effectiveModel: model,
      primary: usage,
      auxiliary: entries.filter(([key]) => key !== model).map(([auxModel, auxUsage]) => usageRow(auxModel, auxUsage)),
      candidates,
      matched: "unique-segment",
    };
  }
  return {
    effectiveModel: "unknown",
    primary: undefined,
    auxiliary: entries.map(([model, usage]) => usageRow(model, usage)),
    candidates,
    matched: "none",
  };
}

function usageRow(model, usage = {}) {
  return {
    model,
    tokensIn: usage.inputTokens ?? usage.input_tokens,
    tokensOut: usage.outputTokens ?? usage.output_tokens,
    cacheReadTokens: usage.cacheReadInputTokens ?? usage.cache_read_input_tokens,
    cacheCreationTokens: usage.cacheCreationInputTokens ?? usage.cache_creation_input_tokens,
    costUsd: usage.costUSD ?? usage.costUsd,
    costBasis: usage.costBasis,
  };
}

export function normalizeAgy(payload) {
  if (!payload || typeof payload !== "object") {
    return {
      emptyPayload: true,
      errorCode: "empty_payload",
      errorDetail: "empty JSON payload",
      costBasis: "unmetered",
    };
  }
  const usage = payload.usage && typeof payload.usage === "object" ? payload.usage : {};
  const denied = Array.isArray(payload.denied_actions)
    ? payload.denied_actions.filter((item) => item !== undefined && item !== null && String(item).length > 0)
    : (typeof payload.denied_actions === "string" && payload.denied_actions.trim()
      ? [payload.denied_actions.trim()]
      : []);
  const rawError = payload.error;
  const errorText = rawError === undefined || rawError === null || rawError === ""
    ? undefined
    : String(rawError?.message ?? rawError);
  const isTimeout = errorText === "timeout waiting for response";
  let errorCode;
  let errorDetail;
  if (denied.length > 0) {
    errorCode = "turn_failed";
    errorDetail = joinDetail(`denied_actions: ${JSON.stringify(denied)}`, errorText);
  } else if (payload.status === "SUCCESS") {
    errorCode = undefined;
  } else if (payload.status === "ERROR" && isTimeout) {
    errorCode = "timed_out";
    errorDetail = errorText;
  } else if (payload.status === "ERROR") {
    errorCode = "model_error";
    errorDetail = errorText ?? "ERROR";
  } else {
    errorCode = "model_error";
    errorDetail = errorText ?? `unrecognized agy status ${String(payload.status ?? "missing")}`;
  }
  const reportedModel = typeof payload.model === "string" && payload.model.trim()
    ? payload.model.trim()
    : undefined;
  const text = typeof payload.response === "string" ? payload.response : "";
  return {
    text,
    sessionId: typeof payload.conversation_id === "string" ? payload.conversation_id : undefined,
    ...(reportedModel ? { effectiveModel: reportedModel } : {}),
    tokensIn: usage.input_tokens,
    tokensOut: usage.output_tokens,
    cacheReadTokens: usage.cache_read_tokens,
    reasoningTokens: usage.thinking_tokens,
    totalTokens: usage.total_tokens,
    tokenBasis: TOKEN_BASIS,
    costBasis: "unmetered",
    ...(payload.structured_output !== undefined ? { structuredOutput: payload.structured_output } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(errorDetail ? { errorDetail } : {}),
  };
}

export function normalizeClaudeOrGrok(payload, requestedModel) {
  if (!payload || typeof payload !== "object") {
    return {
      emptyPayload: true,
      errorCode: "empty_payload",
      errorDetail: "empty JSON payload",
      costBasis: "unknown",
    };
  }
  const usage = payload.usage ?? {};
  const resolved = resolveModelUsage(payload.modelUsage ?? {}, requestedModel);
  const detail = resolved.primary ?? {};
  const tokensIn = detail.inputTokens ?? usage.input_tokens;
  const tokensOut = detail.outputTokens ?? usage.output_tokens;
  const cacheReadTokens = detail.cacheReadInputTokens ?? usage.cache_read_input_tokens;
  const cacheCreationTokens = detail.cacheCreationInputTokens ?? usage.cache_creation_input_tokens;
  const providerReportedCostUsd = payload.total_cost_usd ?? detail.costUSD;
  const rawStop = payload.stop_reason ?? payload.stopReason;
  const stopReason = closeStopReason(rawStop);
  let errorCode;
  let errorDetail;
  if (payload.is_error) {
    errorCode = "model_error";
    errorDetail = String(payload.result ?? payload.error?.message ?? payload.error ?? "is_error");
  } else if (stopReason === "error") {
    errorCode = "stop_error";
    errorDetail = "stopReason error";
  } else if (stopReason === "aborted") {
    errorCode = "stop_aborted";
    errorDetail = "stopReason aborted";
  } else if (payload.error) {
    errorCode = "model_error";
    errorDetail = String(payload.error?.message ?? payload.error);
  }
  if (rawStop !== undefined && stopReason === "unrecognized") {
    errorDetail = joinDetail(errorDetail, `stopReason ${String(rawStop)}`);
  }
  let text = "";
  let malformedText = false;
  if (typeof payload.result === "string") {
    text = payload.result;
  } else if (payload.result !== undefined && payload.result !== null) {
    malformedText = true;
  } else if (typeof payload.text === "string") {
    text = payload.text;
  } else if (payload.text !== undefined) {
    malformedText = true;
  }
  if (malformedText && !errorCode) {
    errorCode = "normalization_failed";
    errorDetail = joinDetail(errorDetail, "malformed optional text field");
  }
  return {
    text,
    sessionId: payload.sessionId ?? payload.session_id,
    effectiveModel: resolved.effectiveModel,
    tokensIn,
    tokensOut,
    cacheReadTokens,
    cacheCreationTokens,
    reasoningTokens: usage.reasoning_tokens ?? usage.output_tokens_details?.thinking_tokens,
    providerReportedCostUsd,
    costUsd: providerReportedCostUsd,
    costBasis: resolveHelperCostBasis(detail.costBasis, providerReportedCostUsd),
    stopReason,
    tokenBasis: TOKEN_BASIS,
    auxiliaryUsage: resolved.auxiliary,
    candidateModels: resolved.candidates,
    ...(errorCode ? { errorCode } : {}),
    ...(errorDetail ? { errorDetail } : {}),
    ...(resolved.effectiveModel === "unknown" ? { modelResolution: "unresolved-alias" } : {}),
    ...(payload.structured_output !== undefined ? { structuredOutput: payload.structured_output } : {}),
  };
}

function resolveHelperCostBasis(explicit, providerReportedCostUsd) {
  if (explicit === "list") return "list";
  if (explicit === "unmetered") return "unmetered";
  if (providerReportedCostUsd === undefined) return "unknown";
  return "provider-reported";
}

const CLAIM_SIDECAR_KEYS = Object.freeze([
  "summary",
  "deferredItems",
  "findings",
  "notes",
  "notes_for_next_agent",
  "notesForNextAgent",
  "report",
  "lists",
]);
const CLAIM_COUNT_SOURCE_KEYS = Object.freeze(["completed", "deferred", "artifacts"]);
const CLAIM_CLOSED_KEYS = Object.freeze([
  "status",
  "completedCount",
  "deferredCount",
  "artifactCount",
  "verdict",
]);
const RESULT_PUBLIC_KEYS = Object.freeze([
  "schema",
  "ok",
  "status",
  "stage",
  "harness",
  "provider",
  "role",
  "requestedModel",
  "effectiveModel",
  "reasoningEffort",
  "effortClampedFrom",
  "startedAt",
  "finishedAt",
  "latencyMs",
  "exitCode",
  "signal",
  "timedOut",
  "killRequest",
  "observedChildExit",
  "tokenBasis",
  "contextOccupancy",
  "tokensIn",
  "tokensOut",
  "cacheReadTokens",
  "cacheCreationTokens",
  "reasoningTokens",
  "totalTokens",
  "costUsd",
  "costBasis",
  "providerReportedCostUsd",
  "usagePartial",
  "sessionId",
  "stopReason",
  "errorCode",
  "error",
  "auxiliaryUsage",
  "usageEvents",
  "candidateModels",
  "auth",
  "command",
  "dispatchPath",
  "answerPath",
  "answerBytes",
  "stderrPath",
  "stderrBytes",
  "errorPath",
  "errorBytes",
  "modelClaim",
  "providerMetadata",
]);
const MODEL_CLAIM_PUBLIC_KEYS = Object.freeze([
  "status",
  "completedCount",
  "deferredCount",
  "artifactCount",
  "verdict",
  "claimSource",
  "unrecognizedCount",
  "path",
  "bytes",
]);
const AUTH_PUBLIC_KEYS = Object.freeze(["loggedIn", "method", "observedAt", "subscriptionType"]);
const KILL_REQUEST_KEYS = Object.freeze(["signal", "escalated"]);
const USAGE_ROW_KEYS = Object.freeze([
  "model",
  "tokensIn",
  "tokensOut",
  "cacheReadTokens",
  "cacheCreationTokens",
  "costUsd",
  "costBasis",
  "stopReason",
]);
const PROVIDER_METADATA_KEYS = Object.freeze([
  "tokensIn",
  "tokensOut",
  "cacheReadTokens",
  "cacheCreationTokens",
  "reasoningTokens",
  "totalTokens",
  "tokenBasis",
]);

function pickKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out = {};
  for (const key of keys) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  return out;
}

function closedNonnegInt(value) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  return undefined;
}

function closedNonnegFinite(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  return undefined;
}

function closedString(value) {
  return typeof value === "string" ? value : undefined;
}

function closedBoolean(value) {
  return value === true || value === false ? value : undefined;
}

function closedCostBasis(value) {
  return typeof value === "string" && COST_BASIS.includes(value) ? value : undefined;
}

const PUBLIC_STRING_KEYS = Object.freeze([
  "schema",
  "harness",
  "provider",
  "role",
  "requestedModel",
  "effectiveModel",
  "reasoningEffort",
  "effortClampedFrom",
  "startedAt",
  "finishedAt",
  "signal",
  "tokenBasis",
  "contextOccupancy",
  "sessionId",
  "error",
  "command",
  "dispatchPath",
  "answerPath",
  "stderrPath",
  "errorPath",
]);
const PUBLIC_TOKEN_KEYS = Object.freeze([
  "tokensIn",
  "tokensOut",
  "cacheReadTokens",
  "cacheCreationTokens",
  "reasoningTokens",
  "totalTokens",
]);
const PUBLIC_COST_KEYS = Object.freeze(["costUsd", "providerReportedCostUsd"]);
const PUBLIC_BYTE_KEYS = Object.freeze(["answerBytes", "stderrBytes", "errorBytes"]);

function closeUsageRow(row) {
  const closed = pickKeys(row, USAGE_ROW_KEYS);
  if (!closed) return undefined;
  const model = closedString(closed.model);
  if (model === undefined) delete closed.model;
  else closed.model = model;
  for (const key of PUBLIC_TOKEN_KEYS) {
    if (!(key in closed)) continue;
    const value = closedNonnegInt(closed[key]);
    if (value === undefined) delete closed[key];
    else closed[key] = value;
  }
  const costUsd = closedNonnegFinite(closed.costUsd);
  if (costUsd === undefined) delete closed.costUsd;
  else closed.costUsd = costUsd;
  const costBasis = closedCostBasis(closed.costBasis);
  if (costBasis === undefined) delete closed.costBasis;
  else closed.costBasis = costBasis;
  if (closed.stopReason !== undefined) {
    const stopReason = closeStopReason(closed.stopReason);
    if (stopReason === undefined) delete closed.stopReason;
    else closed.stopReason = stopReason;
  }
  return Object.keys(closed).length > 0 ? closed : undefined;
}

function closePublicResult(result) {
  const closed = pickKeys(result, RESULT_PUBLIC_KEYS) ?? {};
  closed.schema = RESULT_SCHEMA;
  if (closed.stopReason !== undefined) closed.stopReason = closeStopReason(closed.stopReason);
  if (closed.errorCode !== undefined && !ERROR_CODES.includes(closed.errorCode)) {
    closed.errorCode = "unrecognized";
  }
  if (closed.status !== undefined && !TRANSPORT_STATUSES.includes(closed.status)) {
    closed.status = "failed";
  }
  if (closed.stage !== undefined && !TRANSPORT_STAGES.includes(closed.stage)) {
    closed.stage = "run";
  }
  const ok = closedBoolean(closed.ok);
  if (ok === undefined) delete closed.ok;
  else closed.ok = ok;
  const timedOut = closedBoolean(closed.timedOut);
  if (timedOut === undefined) delete closed.timedOut;
  else closed.timedOut = timedOut;
  const observedChildExit = closedBoolean(closed.observedChildExit);
  if (observedChildExit === undefined) delete closed.observedChildExit;
  else closed.observedChildExit = observedChildExit;
  if (closed.usagePartial === true) closed.usagePartial = true;
  else delete closed.usagePartial;
  if (closed.exitCode !== undefined && closed.exitCode !== null
    && !(typeof closed.exitCode === "number" && Number.isInteger(closed.exitCode))) {
    delete closed.exitCode;
  }
  const latencyMs = closedNonnegFinite(closed.latencyMs);
  if (latencyMs === undefined) delete closed.latencyMs;
  else closed.latencyMs = latencyMs;
  for (const key of PUBLIC_STRING_KEYS) {
    if (closed[key] === undefined) continue;
    const value = closedString(closed[key]);
    if (value === undefined) delete closed[key];
    else closed[key] = value;
  }
  for (const key of PUBLIC_TOKEN_KEYS) {
    if (closed[key] === undefined) continue;
    const value = closedNonnegInt(closed[key]);
    if (value === undefined) delete closed[key];
    else closed[key] = value;
  }
  for (const key of PUBLIC_COST_KEYS) {
    if (closed[key] === undefined) continue;
    const value = closedNonnegFinite(closed[key]);
    if (value === undefined) delete closed[key];
    else closed[key] = value;
  }
  for (const key of PUBLIC_BYTE_KEYS) {
    if (closed[key] === undefined) continue;
    const value = closedNonnegInt(closed[key]);
    if (value === undefined) delete closed[key];
    else closed[key] = value;
  }
  const costBasis = closedCostBasis(closed.costBasis);
  if (costBasis === undefined) delete closed.costBasis;
  else closed.costBasis = costBasis;
  if (closed.tokenBasis !== undefined && closed.tokenBasis !== TOKEN_BASIS) delete closed.tokenBasis;
  if (closed.contextOccupancy !== undefined && closed.contextOccupancy !== CONTEXT_OCCUPANCY_UNKNOWN) {
    delete closed.contextOccupancy;
  }
  if (closed.modelClaim) {
    closed.modelClaim = pickKeys(closed.modelClaim, MODEL_CLAIM_PUBLIC_KEYS);
    if (
      closed.modelClaim.status !== undefined
      && !MODEL_CLAIM_STATUSES.includes(closed.modelClaim.status)
      && closed.modelClaim.status !== "unrecognized"
    ) {
      closed.modelClaim.status = "unrecognized";
    }
    if (typeof closed.modelClaim.status !== "string") delete closed.modelClaim.status;
    if (closed.modelClaim.verdict !== undefined && !REVIEW_VERDICTS.includes(closed.modelClaim.verdict)) {
      delete closed.modelClaim.verdict;
    }
    if (closed.modelClaim.claimSource !== undefined && !CLAIM_SOURCES.includes(closed.modelClaim.claimSource)) {
      closed.modelClaim.claimSource = "none";
    }
    for (const key of ["completedCount", "deferredCount", "artifactCount", "unrecognizedCount", "bytes"]) {
      const value = closedNonnegInt(closed.modelClaim[key]);
      if (value === undefined) delete closed.modelClaim[key];
      else closed.modelClaim[key] = value;
    }
    const claimPath = closedString(closed.modelClaim.path);
    if (claimPath === undefined) delete closed.modelClaim.path;
    else closed.modelClaim.path = claimPath;
  }
  if (closed.auth) {
    closed.auth = pickKeys(closed.auth, AUTH_PUBLIC_KEYS);
    const loggedIn = closedBoolean(closed.auth.loggedIn);
    if (loggedIn === undefined) delete closed.auth.loggedIn;
    else closed.auth.loggedIn = loggedIn;
    const method = closedString(closed.auth.method);
    if (method === undefined) delete closed.auth.method;
    else closed.auth.method = method;
    const observedAt = closedString(closed.auth.observedAt);
    if (observedAt === undefined) delete closed.auth.observedAt;
    else closed.auth.observedAt = observedAt;
    const subscriptionType = closed.auth.subscriptionType;
    if (subscriptionType !== undefined
      && typeof subscriptionType !== "string"
      && typeof subscriptionType !== "number"
      && typeof subscriptionType !== "boolean") {
      delete closed.auth.subscriptionType;
    }
  }
  if (closed.killRequest) {
    closed.killRequest = pickKeys(closed.killRequest, KILL_REQUEST_KEYS);
    const killSignal = closedString(closed.killRequest.signal);
    if (killSignal === undefined) delete closed.killRequest.signal;
    else closed.killRequest.signal = killSignal;
    closed.killRequest.escalated = closed.killRequest.escalated === true;
  }
  if (Array.isArray(closed.auxiliaryUsage)) {
    closed.auxiliaryUsage = closed.auxiliaryUsage.map(closeUsageRow).filter(Boolean);
  } else {
    delete closed.auxiliaryUsage;
  }
  if (Array.isArray(closed.usageEvents)) {
    closed.usageEvents = closed.usageEvents.map(closeUsageRow).filter(Boolean);
  } else {
    delete closed.usageEvents;
  }
  if (closed.providerMetadata) {
    closed.providerMetadata = pickKeys(closed.providerMetadata, PROVIDER_METADATA_KEYS);
    if (closed.providerMetadata) {
      for (const key of PUBLIC_TOKEN_KEYS) {
        if (closed.providerMetadata[key] === undefined) continue;
        const value = closedNonnegInt(closed.providerMetadata[key]);
        if (value === undefined) delete closed.providerMetadata[key];
        else closed.providerMetadata[key] = value;
      }
      if (closed.providerMetadata.tokenBasis !== undefined
        && closed.providerMetadata.tokenBasis !== TOKEN_BASIS) {
        delete closed.providerMetadata.tokenBasis;
      }
      if (Object.keys(closed.providerMetadata).length === 0) delete closed.providerMetadata;
    }
  }
  if (Array.isArray(closed.candidateModels)) {
    closed.candidateModels = closed.candidateModels.filter((name) => typeof name === "string");
  } else {
    delete closed.candidateModels;
  }
  if (closed.signal == null) delete closed.signal;
  delete closed.stderr;
  delete closed.stdout;
  delete closed.text;
  delete closed.argv;
  delete closed.harnessError;
  assertClosedResult(closed);
  return closed;
}

function assertClosedResult(result) {
  for (const key of Object.keys(result)) {
    if (!RESULT_PUBLIC_KEYS.includes(key)) {
      throw failClosed(`result leaked unknown field ${key}`, "run");
    }
  }
  if (Object.hasOwn(result, "stderr") || Object.hasOwn(result, "stdout") || Object.hasOwn(result, "text")) {
    throw failClosed("structured result must not carry raw stdio");
  }
  if (Object.hasOwn(result, "harnessError")) {
    throw failClosed("structured result must not carry raw harnessError text");
  }
  if (Object.hasOwn(result, "contextTokens")) {
    throw failClosed("contextTokens is removed; occupancy is unknown");
  }
}

function capClaimCount(value) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return Math.min(value, CLAIM_COUNT_CAP);
  }
  return undefined;
}

function claimCount(value) {
  if (Array.isArray(value)) return Math.min(value.length, CLAIM_COUNT_CAP);
  return capClaimCount(value);
}

function extractModelClaimFromObject(candidate, role) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  if (typeof candidate.status !== "string" && candidate.verdict === undefined
    && candidate.completed === undefined && candidate.deferred === undefined
    && candidate.artifacts === undefined && candidate.completedCount === undefined) {
    return undefined;
  }

  const known = new Set([...CLAIM_CLOSED_KEYS, ...CLAIM_SIDECAR_KEYS, ...CLAIM_COUNT_SOURCE_KEYS]);
  let unrecognizedCount = 0;
  for (const key of Object.keys(candidate)) {
    if (!known.has(key)) unrecognizedCount += 1;
  }

  const rawStatus = candidate.status;
  const status = MODEL_CLAIM_STATUSES.includes(rawStatus) ? rawStatus : "unrecognized";
  if (typeof rawStatus === "string" && !MODEL_CLAIM_STATUSES.includes(rawStatus)) {
    unrecognizedCount += 1;
  } else if (rawStatus !== undefined && typeof rawStatus !== "string") {
    unrecognizedCount += 1;
  }

  const completedCount = claimCount(candidate.completedCount ?? candidate.completed);
  const deferredCount = claimCount(candidate.deferredCount ?? candidate.deferred);
  const artifactCount = claimCount(candidate.artifactCount ?? candidate.artifacts);

  const review = role === "reviewer-arch" || role === "reviewer-cli";
  let verdict;
  if (candidate.verdict !== undefined) {
    if (review && REVIEW_VERDICTS.includes(candidate.verdict)) {
      verdict = candidate.verdict;
    } else {
      unrecognizedCount += 1;
    }
  }

  return {
    status,
    ...(completedCount !== undefined ? { completedCount } : {}),
    ...(deferredCount !== undefined ? { deferredCount } : {}),
    ...(artifactCount !== undefined ? { artifactCount } : {}),
    ...(verdict ? { verdict } : {}),
    unrecognizedCount,
    raw: candidate,
  };
}

function extractModelClaim(text, role) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = parseJson(fenced ? fenced[1] : text);
  return extractModelClaimFromObject(candidate, role);
}

function extractClaim(fields, role, schemaRequested) {
  if (schemaRequested && fields?.structuredOutput !== undefined) {
    const raw = fields.structuredOutput;
    const extracted = extractModelClaimFromObject(raw, role);
    if (extracted) return { ...extracted, claimSource: "structured_output" };
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return {
        status: "unrecognized",
        unrecognizedCount: Object.keys(raw).length,
        claimSource: "structured_output",
        raw,
      };
    }
    return {
      status: "unrecognized",
      unrecognizedCount: 1,
      claimSource: "structured_output",
      raw: { structured_output: raw },
    };
  }
  const fromText = extractModelClaim(typeof fields?.text === "string" ? fields.text : "", role);
  if (fromText) return { ...fromText, claimSource: "result" };
  return undefined;
}

export function diagnoseHarnessResult(payload, filePath = "-") {
  const rawObserved = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload.schema
    : undefined;
  const observed = typeof rawObserved === "string" && rawObserved.length > 0 ? rawObserved : "none";
  if (observed === RESULT_SCHEMA) return { result: payload };
  const observedLabel = observed === "none" || KNOWN_RESULT_SCHEMAS.includes(observed)
    ? observed
    : "unrecognized";
  return {
    diagnostic: `${filePath}: observed schema ${observedLabel}; obsolete result schema ${OBSOLETE_RESULT_SCHEMA}; expected ${RESULT_SCHEMA}`,
  };
}

export function formatRunListing(payload, filePath = "-") {
  const diagnosed = diagnoseHarnessResult(payload, filePath);
  if (diagnosed.diagnostic) return diagnosed.diagnostic;
  const row = diagnosed.result;
  const cost = formatRunCost(row);
  return `${row.ok ? "ok" : "FAIL"} ${row.harness ?? ""} ${row.effectiveModel ?? ""} ${(row.latencyMs ?? "?") + "ms"} ${cost}`;
}

function applyRoutingCap(fields) {
  const metadata = {};
  const capped = {};
  for (const name of PUBLIC_TOKEN_KEYS) {
    const value = closedNonnegInt(fields[name]);
    if (value === undefined) continue;
    if (value > ROUTING_INT_CAP) {
      metadata[name] = value;
      metadata.tokenBasis = TOKEN_BASIS;
    } else {
      capped[name] = value;
    }
  }
  return { capped, metadata };
}

function requireNonemptyString(request, key) {
  const value = request[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw failClosed(`${key} is required as a nonempty string; refusing CLI defaults`);
  }
}

function optionalNonemptyString(request, key) {
  if (request[key] === undefined) return;
  if (typeof request[key] !== "string" || request[key].length === 0) {
    throw failClosed(`${key} must be a nonempty string when present`);
  }
}

function requirePositiveFinite(request, key) {
  if (request[key] === undefined) return;
  const value = request[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw failClosed(`${key} must be a positive finite number; zero is not a verified constraint`);
  }
}

export function preflightRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw failClosed("request must be an object");
  }
  if (request.schema !== REQUEST_SCHEMA) {
    throw failClosed(`request schema must be ${REQUEST_SCHEMA}, got ${request.schema ?? "none"}`);
  }
  const unknown = Object.keys(request).filter((key) => !REQUEST_KEYS.includes(key));
  if (unknown.length > 0) {
    throw failClosed(`unknown request field(s) ${unknown.join(", ")}; refusing to guess a route`);
  }
  for (const key of ["harness", "role", "model", "permission", "prompt_file"]) {
    requireNonemptyString(request, key);
  }
  for (const key of ["cwd", "output_schema", "output_dir"]) {
    optionalNonemptyString(request, key);
  }
  if (request.effort !== undefined && (typeof request.effort !== "string" || !request.effort)) {
    throw failClosed("effort must be a nonempty string when present");
  }
  if (request.hooks !== undefined && typeof request.hooks !== "boolean") {
    throw failClosed("hooks must be a boolean when present");
  }
  if (request.skills !== undefined) {
    if (!Array.isArray(request.skills) || request.skills.some((skill) => typeof skill !== "string" || skill.length === 0)) {
      throw failClosed("skills must be an array of nonempty strings when present");
    }
  }
  requirePositiveFinite(request, "timeout_ms");
  requirePositiveFinite(request, "max_cost_usd");
  const harness = request.harness;
  if (UNVERIFIED_HARNESSES.includes(harness)) {
    throw failClosed(`${harness} helper dispatch is unverified and fails closed before any model call`);
  }
  const route = ROUTES[harness];
  if (!route) {
    throw failClosed(`unknown harness ${harness}; expected one of ${Object.keys(ROUTES).join(", ")}`);
  }
  if (!route.roles.includes(request.role)) {
    throw failClosed(`${harness} does not accept role ${request.role}; allowed: ${route.roles.join(", ")}`);
  }
  if (harness === "grok" && request.permission === "read-only") {
    throw failClosed("grok read-only is unsupported pending a permission-mode probe");
  }
  if (!route.permissions.includes(request.permission)) {
    throw failClosed(`${harness} does not accept permission ${request.permission}; allowed: ${route.permissions.join(", ")}`);
  }
  if (harness === "pi" && request.permission === "edit" && !["experiment", "writer"].includes(request.role)) {
    throw failClosed(`pi ${request.role} cannot edit; only experiment or admitted writer may use permission edit`);
  }
  if (harness !== "pi" && !route.models.includes(request.model)) {
    throw failClosed(`${harness} does not accept model ${request.model}; allowed: ${route.models.join(", ")}`);
  }
  if (harness === "pi") {
    const provider = piProviderOf(request.model);
    if (!provider) {
      throw failClosed("pi model must be provider/id (openrouter/* or nous-portal/* in this helper)");
    }
    if (NATIVE_PI_BRAKE_PROVIDERS.includes(provider)) {
      throw failClosed(`pi brake: ${provider} has a native harness; refusing Pi impersonation`);
    }
    if (!PI_ALLOWED_PROVIDERS.includes(provider)) {
      throw failClosed(`pi helper allows only openrouter/* or nous-portal/*; ${provider} is not a native CLI and is not allowlisted`);
    }
    if (request.role === "writer" && (request.model !== PI_ADMITTED_WRITER || request.permission !== "edit")) {
      throw failClosed("pi writer refuses unsupported route; allows only authenticated openrouter/qwen/qwen3-coder-plus with edit permission; other models need reviewed route admission");
    }
  }
  if (harness === "claude") {
    if (request.hooks === true) {
      throw failClosed("read-only claude refuses hooks; it runs --safe-mode with no hook/skill loading");
    }
    if (Array.isArray(request.skills) && request.skills.length > 0) {
      throw failClosed("read-only claude refuses skills; it runs --safe-mode with no hook/skill loading");
    }
  } else if (harness === "pi") {
    if (request.hooks === true) {
      throw failClosed("pi does not accept hooks:true; read-only uses --no-extensions");
    }
    if (Array.isArray(request.skills) && request.skills.length > 0) {
      throw failClosed("pi does not accept skills in this helper");
    }
  } else if (request.hooks !== undefined || request.skills !== undefined) {
    throw failClosed(`${harness} does not accept hooks/skills in this helper`);
  }
  if (request.max_cost_usd !== undefined && harness !== "claude") {
    throw failClosed(`${harness} does not accept max_cost_usd in this helper`);
  }
  if (request.max_turns !== undefined) {
    const value = request.max_turns;
    if (!Number.isInteger(value) || value <= 0) {
      throw failClosed("max_turns must be a positive integer; zero is not a verified constraint");
    }
    if (harness !== "grok") {
      throw failClosed(`${harness} does not accept max_turns in this helper`);
    }
  }
  return route;
}

function writePrivate(path, body, options = {}) {
  const write = options.writeFileSync ?? writeFileSync;
  const chmod = options.chmodSync ?? chmodSync;
  write(path, body, { encoding: "utf8", mode: 0o600 });
  try {
    chmod(path, 0o600);
  } catch {
    // Windows cannot honor POSIX 0600; the create mode still ran.
  }
}

function ensureOutputDir(dir, options = {}) {
  const mkdir = options.mkdirSync ?? mkdirSync;
  mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function emptyMcpConfig(dir, options = {}) {
  const path = join(dir, "mcp-empty.json");
  writePrivate(path, `${JSON.stringify({ mcpServers: {} })}\n`, options);
  return path;
}

function readResolvedInput(label, relativePath) {
  const resolved = resolvePath(process.cwd(), relativePath);
  try {
    return { path: resolved, text: readFileSync(resolved, "utf8") };
  } catch {
    throw failClosed(`${label} is missing or unreadable: ${resolved}`);
  }
}

export async function runHarness(request, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const spawnImpl = deps.spawn ?? spawn;
  const spawnSyncImpl = deps.spawnSync ?? spawnSync;
  const now = deps.now ?? Date.now;
  const exists = deps.existsSync ?? existsSync;
  const route = preflightRequest(request);
  // Request file paths resolve against the invocation cwd, then become
  // absolute before the child runs in request.cwd, so a brief in the
  // control repo works while the agent runs in a worktree.
  const promptInput = readResolvedInput("prompt_file", request.prompt_file);
  const schemaInput = request.output_schema
    ? readResolvedInput("output_schema", request.output_schema)
    : undefined;
  const cwd = request.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const { effort, clamped } = clampEffort(request.harness, request.effort);
  const prepared = { ...request, effort };
  const outputDir = ensureOutputDir(
    request.output_dir ?? join(cwd, ".kxm", "logs", `harness-${now()}`),
    deps,
  );
  const mcpConfigPath = request.harness === "claude" ? emptyMcpConfig(outputDir, deps) : undefined;
  const argv = buildArgv(prepared, {
    mcpConfigPath,
    promptPath: promptInput.path,
    promptText: promptInput.text,
    schemaPath: schemaInput?.path,
    schemaText: schemaInput?.text,
  });
  const cliId = request.harness;
  const launch = resolveLaunch(cliId, {
    platform,
    pathEnv: env.PATH,
    existsSync: exists,
    realpathSync: deps.realpathSync,
    execPath: deps.execPath ?? process.execPath,
  });
  const resolved = launch.command;
  const launchArgs = launch.args;

  const authArgs = request.harness === "claude"
    ? [...claudeIsolationArgs(mcpConfigPath), ...route.auth.args]
    : request.harness === "pi"
      ? piAuthCheckArgs(request)
      : [...route.auth.args];
  const auth = spawnSyncImpl(resolved, [...launchArgs, ...authArgs], {
    cwd,
    env,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: deps.authTimeoutMs ?? 15_000,
  });
  if (auth.error && auth.error.code === "ENOENT") {
    throw failClosed(loginHint(cliId, `missing binary ${cliId}.`), "auth");
  }
  let authStatus;
  authStatus = parseAuth(cliId, {
    stdout: auth.stdout?.toString?.() ?? "",
    stderr: auth.stderr?.toString?.() ?? "",
    exitCode: auth.status ?? (auth.error ? -1 : 0),
  }, {
    observedAt: deps.observedAt,
    ...(request.harness === "pi" ? { provider: piProviderOf(request.model) } : {}),
  });

  if (request.harness === "pi" && request.role === "writer") {
    const proof = parseJson(auth.stdout?.toString?.() ?? "");
    if (proof?.provider !== piProviderOf(request.model) || proof?.status !== "ready") {
      throw failClosed("pi writer requires exact provider/model auth readiness", "auth");
    }
  }

  const stdinPrompt = request.harness === "claude" || request.harness === "codex";
  const started = now();
  const dispatchRecord = {
    requestHash: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
    timestamp: new Date(started).toISOString(),
    command: cliId,
    pid: null,
  };
  const dispatchPath = join(outputDir, "dispatch.json");
  writePrivate(dispatchPath, `${JSON.stringify(dispatchRecord)}\n`, deps);

  const killGraceMs = deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  let timedOut = false;
  let killRequest;
  let child;
  try {
    child = spawnImpl(resolved, [...launchArgs, ...argv], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: [stdinPrompt ? "pipe" : "ignore", "pipe", "pipe"],
    });
  } catch {
    return closePublicResult(buildTransportResult({
      request,
      route,
      effort,
      clamped,
      authStatus,
      started,
      latencyMs: now() - started,
      collected: { stdout: "", stderr: "", exitCode: null, signal: null, observedChildExit: false },
      fields: { costBasis: "unknown" },
      timedOut: false,
      killRequest: undefined,
      outputDir,
      dispatchPath,
      cliId,
      stage: "spawn",
      errorCode: "spawn_failed",
      errorDetail: "spawn failed",
      writeFailed: false,
      modelClaim: undefined,
      answerBytes: 0,
      stderrBytes: 0,
      errorBytes: 0,
    }));
  }

  let writeFailed = false;
  let writeDetail;
  const requestTermination = (signal) => {
    killRequest = { signal, escalated: signal === "SIGKILL" };
    try {
      child.kill(signal);
    } catch {
      // Direct child may already have exited; missing completion is not process-death proof.
    }
  };
  const collectedPromise = collectChildStdio(child, {
    timeoutMs: request.timeout_ms,
    killGraceMs,
    onTimeout: () => {
      timedOut = true;
    },
    requestTermination,
  });
  try {
    if (child?.pid != null) {
      dispatchRecord.pid = child.pid;
      writePrivate(dispatchPath, `${JSON.stringify(dispatchRecord)}\n`, deps);
    }
  } catch (error) {
    writeFailed = true;
    writeDetail = String(error?.message ?? "pid record amend failed");
  }
  if (stdinPrompt && child.stdin) {
    const noteStdinFailure = (error) => {
      writeFailed = true;
      writeDetail = joinDetail(writeDetail, String(error?.message ?? "stdin write failed"));
    };
    child.stdin.on("error", noteStdinFailure);
    try {
      child.stdin.write(promptInput.text);
      child.stdin.end();
    } catch (error) {
      noteStdinFailure(error);
    }
  }
  const collected = await collectedPromise;
  const latencyMs = now() - started;
  const spawnFailed = Boolean(collected.error) && collected.observedChildExit !== true;

  let fields;
  try {
    fields = request.harness === "codex"
      ? normalizeCodex(collected.stdout)
      : request.harness === "pi"
        ? normalizePi(collected.stdout)
        : request.harness === "agy"
          ? normalizeAgy(parseJson(collected.stdout))
          : normalizeClaudeOrGrok(parseJson(collected.stdout), request.model);
  } catch (error) {
    fields = {
      errorCode: "normalization_failed",
      errorDetail: String(error?.message ?? "normalization failed"),
      costBasis: "unknown",
    };
  }

  if (request.harness === "claude" && authStatus.method === "claude.ai") {
    fields.costBasis = "unmetered";
    fields.costUsd = undefined;
  } else if (request.harness === "codex" && authStatus.method === "ChatGPT") {
    fields.costBasis = "unmetered";
    fields.costUsd = undefined;
  } else if (request.harness === "agy" && authStatus.method === "antigravity-oauth") {
    fields.costBasis = "unmetered";
    fields.costUsd = undefined;
  } else if (fields.costUsd === undefined && fields.providerReportedCostUsd === undefined) {
    fields.costBasis = fields.costBasis ?? "unknown";
  }
  if (fields.costBasis === "billed" || (fields.costBasis && !COST_BASIS.includes(fields.costBasis))) {
    fields.costBasis = fields.providerReportedCostUsd !== undefined || fields.costUsd !== undefined
      ? "provider-reported"
      : "unknown";
  }

  const stderrPath = join(outputDir, "stderr.log");
  const answerPath = join(outputDir, "answer.txt");
  const errorPath = join(outputDir, "error.txt");
  const stderrBytes = Buffer.byteLength(collected.stderr ?? "", "utf8");
  const answerText = typeof fields.text === "string" ? fields.text : "";
  const answerBytes = Buffer.byteLength(answerText, "utf8");
  let extractedClaim;
  let modelClaim;
  try {
    if (stderrBytes > 0) writePrivate(stderrPath, collected.stderr, deps);
    if (answerBytes > 0) writePrivate(answerPath, answerText, deps);
    extractedClaim = extractClaim(fields, request.role, Boolean(schemaInput));
    if (extractedClaim) {
      const claimPath = join(outputDir, "model-claim.json");
      const claimBody = `${JSON.stringify(extractedClaim.raw)}\n`;
      writePrivate(claimPath, claimBody, deps);
      modelClaim = {
        status: extractedClaim.status,
        ...(extractedClaim.completedCount !== undefined ? { completedCount: extractedClaim.completedCount } : {}),
        ...(extractedClaim.deferredCount !== undefined ? { deferredCount: extractedClaim.deferredCount } : {}),
        ...(extractedClaim.artifactCount !== undefined ? { artifactCount: extractedClaim.artifactCount } : {}),
        ...(extractedClaim.verdict ? { verdict: extractedClaim.verdict } : {}),
        claimSource: extractedClaim.claimSource ?? "none",
        unrecognizedCount: extractedClaim.unrecognizedCount,
        path: claimPath,
        bytes: Buffer.byteLength(claimBody),
      };
    }
  } catch (error) {
    writeFailed = true;
    writeDetail = joinDetail(writeDetail, String(error?.message ?? "sidecar write failed"));
  }

  const emptyPayload = fields.emptyPayload === true
    || ((request.harness === "codex" || request.harness === "pi")
      ? jsonlEvents(collected.stdout).length === 0
      : !parseJson(collected.stdout));
  let errorCode = fields.errorCode;
  let errorDetail = fields.errorDetail;
  if (timedOut) {
    errorCode = "timed_out";
    errorDetail = joinDetail(errorDetail, "timed out");
  } else if (collected.signal && collected.observedChildExit) {
    errorCode = errorCode ?? "signaled";
    errorDetail = joinDetail(errorDetail, `signal ${collected.signal}`);
  } else if (spawnFailed) {
    errorCode = "spawn_failed";
    errorDetail = joinDetail(errorDetail, String(collected.error?.message ?? "spawn failed"));
  } else if (collected.outputComplete !== true) {
    errorCode = "stdio_incomplete";
    errorDetail = joinDetail(errorDetail, "stdio incomplete");
  } else if (collected.observedChildExit === true && collected.exitCode === null && !collected.signal) {
    errorCode = errorCode ?? "unknown_exit";
    errorDetail = joinDetail(errorDetail, "unknown exit");
  } else if (emptyPayload && !errorCode) {
    errorCode = "empty_payload";
    errorDetail = errorDetail ?? "empty JSON payload";
  }
  if (writeFailed) {
    errorCode = errorCode ?? "write_failed";
    errorDetail = joinDetail(errorDetail, writeDetail ?? "sidecar write failed");
  }

  let errorBytes = 0;
  if (errorDetail) {
    try {
      writePrivate(errorPath, `${errorDetail}\n`, deps);
      errorBytes = Buffer.byteLength(`${errorDetail}\n`, "utf8");
    } catch {
      writeFailed = true;
      errorCode = errorCode ?? "write_failed";
    }
  }

  return closePublicResult(buildTransportResult({
    request,
    route,
    effort,
    clamped,
    authStatus,
    started,
    latencyMs,
    collected,
    fields,
    timedOut,
    killRequest,
    outputDir,
    dispatchPath,
    cliId,
    stage: spawnFailed ? "spawn" : "run",
    errorCode,
    errorDetail,
    writeFailed,
    modelClaim,
    answerPath,
    answerBytes,
    stderrPath,
    stderrBytes,
    errorPath,
    errorBytes,
  }));
}

function collectChildStdio(child, options) {
  const { timeoutMs, killGraceMs, onTimeout, requestTermination } = options;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let observedExit;
    let gotClose = false;
    let stdoutEnded = !child.stdout;
    let stderrEnded = !child.stderr;
    let timer;
    let escalateTimer;
    let missingTimer;
    let drainTimer;
    const stdioDrained = () => stdoutEnded && stderrEnded;
    const requestKill = (signal) => {
      if (observedExit) return;
      requestTermination(signal);
    };
    const unrefHandle = (handle) => {
      try {
        handle?.unref?.();
      } catch {
        // Unref is best-effort; missing unref is not a death claim.
      }
    };
    const facts = (extra = {}) => ({
      stdout,
      stderr,
      exitCode: observedExit ? observedExit.code : null,
      signal: observedExit ? observedExit.signal ?? null : null,
      observedChildExit: Boolean(observedExit),
      outputComplete: gotClose || stdioDrained(),
      ...extra,
    });
    const onStdout = (chunk) => { stdout += chunk; };
    const onStderr = (chunk) => { stderr += chunk; };
    const onStdoutEnd = () => {
      stdoutEnded = true;
      if (observedExit && stdioDrained()) finish();
    };
    const onStderrEnd = () => {
      stderrEnded = true;
      if (observedExit && stdioDrained()) finish();
    };
    const onError = (error) => finish({ error });
    const onExit = (code, signal) => {
      observedExit = { code, signal };
      if (gotClose || stdioDrained()) {
        finish();
        return;
      }
      if (!drainTimer) {
        drainTimer = setTimeout(() => finish(), killGraceMs);
      }
    };
    const onClose = (code, signal) => {
      gotClose = true;
      stdoutEnded = true;
      stderrEnded = true;
      if (!observedExit) observedExit = { code, signal };
      finish();
    };
    const detach = () => {
      child.stdout?.off?.("data", onStdout);
      child.stdout?.off?.("end", onStdoutEnd);
      child.stderr?.off?.("data", onStderr);
      child.stderr?.off?.("end", onStderrEnd);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("close", onClose);
    };
    const releaseIncomplete = () => {
      try { child.stdout?.pause?.(); } catch { /* owned collection pause only */ }
      try { child.stderr?.pause?.(); } catch { /* owned collection pause only */ }
      unrefHandle(child.stdout);
      unrefHandle(child.stderr);
      unrefHandle(child);
    };
    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (escalateTimer) clearTimeout(escalateTimer);
      if (missingTimer) clearTimeout(missingTimer);
      if (drainTimer) clearTimeout(drainTimer);
      detach();
      if (!gotClose) releaseIncomplete();
      resolve(facts(extra));
    };
    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on?.("data", onStdout);
    child.stderr?.on?.("data", onStderr);
    child.stdout?.on?.("end", onStdoutEnd);
    child.stderr?.on?.("end", onStderrEnd);
    child.on("error", onError);
    child.on("exit", onExit);
    child.on("close", onClose);
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        if (observedExit) {
          finish();
          return;
        }
        onTimeout();
        requestKill("SIGTERM");
        escalateTimer = setTimeout(() => {
          if (settled) return;
          requestKill("SIGKILL");
          missingTimer = setTimeout(() => finish(), killGraceMs);
        }, killGraceMs);
      }, timeoutMs);
    }
  });
}

function buildTransportResult(input) {
  const {
    request,
    route,
    effort,
    clamped,
    authStatus,
    started,
    latencyMs,
    collected,
    fields,
    timedOut,
    killRequest,
    dispatchPath,
    cliId,
    stage,
    errorCode,
    writeFailed,
    modelClaim,
    answerPath,
    answerBytes,
    stderrPath,
    stderrBytes,
    errorPath,
    errorBytes,
  } = input;
  const emptyPayload = fields.emptyPayload === true;
  const spawnFailed = stage === "spawn";
  const signaled = Boolean(collected.signal) && collected.observedChildExit === true;
  const successfulExit = request.harness === "agy"
    ? collected.observedChildExit === true
    : collected.observedChildExit === true && collected.exitCode === 0;
  const outputComplete = collected.outputComplete === true;
  const status = timedOut || killRequest || signaled
    ? "interrupted"
    : (errorCode || emptyPayload || writeFailed || !successfulExit || !outputComplete || spawnFailed)
      ? "failed"
      : "completed";
  const ok = status === "completed";
  const { capped, metadata } = applyRoutingCap(fields);
  const usagePresent = [
    capped.tokensIn, capped.tokensOut, capped.cacheReadTokens, capped.cacheCreationTokens,
    capped.reasoningTokens, capped.totalTokens, fields.costUsd, fields.providerReportedCostUsd, metadata.tokensIn,
  ].some((value) => value !== undefined);
  const usagePartial = status !== "completed" && usagePresent;
  const publicErrorCode = status === "completed" ? undefined : errorCode;
  return {
    schema: RESULT_SCHEMA,
    ok,
    status,
    stage,
    harness: request.harness,
    provider: request.harness === "pi" ? piProviderOf(request.model) : route.provider,
    role: request.role,
    requestedModel: request.model,
    effectiveModel: fields.effectiveModel,
    reasoningEffort: effort,
    ...(clamped ? { effortClampedFrom: clamped } : {}),
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(started + latencyMs).toISOString(),
    latencyMs,
    exitCode: collected.exitCode === undefined ? null : collected.exitCode,
    ...(collected.signal ? { signal: collected.signal } : {}),
    timedOut,
    ...(killRequest ? { killRequest } : {}),
    observedChildExit: collected.observedChildExit === true,
    tokenBasis: TOKEN_BASIS,
    contextOccupancy: CONTEXT_OCCUPANCY_UNKNOWN,
    ...capped,
    ...(closedNonnegFinite(fields.costUsd) !== undefined ? { costUsd: closedNonnegFinite(fields.costUsd) } : {}),
    costBasis: fields.costBasis,
    ...(closedNonnegFinite(fields.providerReportedCostUsd) !== undefined
      ? { providerReportedCostUsd: closedNonnegFinite(fields.providerReportedCostUsd) }
      : {}),
    ...(usagePartial ? { usagePartial: true } : {}),
    ...(typeof fields.sessionId === "string" ? { sessionId: fields.sessionId } : {}),
    ...(fields.stopReason ? { stopReason: fields.stopReason } : {}),
    ...(publicErrorCode ? { errorCode: publicErrorCode } : {}),
    ...(fields.auxiliaryUsage?.length ? { auxiliaryUsage: fields.auxiliaryUsage } : {}),
    ...(fields.usageEvents?.length ? { usageEvents: fields.usageEvents } : {}),
    ...(fields.candidateModels && fields.effectiveModel === "unknown"
      ? { candidateModels: fields.candidateModels }
      : {}),
    auth: authStatus,
    command: cliId,
    dispatchPath,
    ...(answerBytes > 0 ? { answerPath, answerBytes } : {}),
    ...(stderrBytes > 0 ? { stderrPath, stderrBytes } : {}),
    ...(errorBytes > 0 ? { errorPath, errorBytes } : {}),
    ...(modelClaim ? { modelClaim } : {}),
    ...(Object.keys(metadata).length > 0 ? { providerMetadata: metadata } : {}),
  };
}

export async function main(argv = process.argv, io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }) {
  const source = argv.slice(2).find((arg) => arg !== "--");
  const raw = source && source !== "-"
    ? readFileSync(source, "utf8")
    : readFileSync(0, "utf8");
  const request = JSON.parse(raw);
  const result = await runHarness(request);
  io.stdout.write(JSON.stringify(result, undefined, 2) + "\n");
  process.exitCode = result.ok ? 0 : 1;
  return result;
}

function invokedAsMain() {
  const self = fileURLToPath(import.meta.url);
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return resolvePath(argv1) === self;
  } catch {
    return false;
  }
}

if (invokedAsMain()) {
  main().catch((error) => {
    const stage = TRANSPORT_STAGES.includes(error.stage) ? error.stage : "preflight";
    const failure = closePublicResult({
      schema: RESULT_SCHEMA,
      ok: false,
      status: "failed",
      stage,
      errorCode: stage === "auth" ? "auth_failed" : stage === "spawn" ? "spawn_failed" : "preflight_failed",
      error: error.message,
    });
    process.stdout.write(`${JSON.stringify(failure, undefined, 2)}\n`);
    process.exit(2);
  });
}
