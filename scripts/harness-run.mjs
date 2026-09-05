#!/usr/bin/env node
// Dev-helper envelope over verified headless CLIs. Not a Phase 11 product adapter.
//
// Reads a `kxm.harness-request.v1` JSON envelope (file argument or stdin),
// dispatches it to an allowlisted provider CLI, and prints a
// `kxm.harness-result.v1` envelope on stdout. Result field names match
// `RoutingRecord` in plugins/kxm/src/routing.ts so D5 can persist one later.
// Raw model/terminal payloads stay in private 0600 sidecars, not metadata.

import { spawn, spawnSync } from "node:child_process";
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
export const RESULT_SCHEMA = "kxm.harness-result.v1";
export const ROUTING_INT_CAP = 1_000_000;
export const TOKEN_BASIS = "cumulative";
export const CONTEXT_OCCUPANCY_UNKNOWN = "unknown";

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
]);

const UNSUPPORTED_LAUNCHER = /\.(cmd|bat|ps1)$/i;

/** Verified helper routes only. Kimi/Gemini/Agy/DeepSeek CLIs fail closed. */
export const ROUTES = Object.freeze({
  grok: {
    provider: "xai",
    roles: Object.freeze(["writer"]),
    permissions: Object.freeze(["edit"]),
    models: Object.freeze(["grok-4.6"]),
    efforts: Object.freeze(["low", "medium", "high"]),
    auth: Object.freeze({ args: ["models"], loginHint: "grok (OAuth to auth.x.ai)" }),
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
    roles: Object.freeze(["experiment", "planner", "reviewer-arch", "reviewer-cli"]),
    permissions: Object.freeze(["read-only", "edit"]),
    models: Object.freeze([]),
    efforts: EFFORT,
    auth: Object.freeze({ args: ["auth", "check"], loginHint: "pi /login openrouter" }),
  },
});

const UNVERIFIED_HARNESSES = Object.freeze(["kimi", "gemini", "agy", "deepseek"]);

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

function failClosed(message) {
  const error = new Error(message);
  error.failClosed = true;
  return error;
}

function loginHint(harness, detail) {
  const hint = ROUTES[harness]?.auth.loginHint ?? "the native harness CLI";
  return `${detail} Log in with ${hint} and retry; native-provider Pi fallback is not used.`;
}

export function piProviderOf(model) {
  if (typeof model !== "string" || !model.includes("/")) return undefined;
  return model.slice(0, model.indexOf("/")).trim().toLowerCase();
}

function pathApi(platform) {
  return platform === "win32" ? win32 : posix;
}

function isAbsoluteOn(path, platform) {
  if (platform === "win32") return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
  return path.startsWith("/");
}

export function resolveLauncher(cliId, options = {}) {
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
  if (explicit) return assertWinExecutable(cliId, platform, options);

  const dirs = pathEnv.split(delim).filter(Boolean);
  let rejectedShim;
  for (const dir of dirs) {
    if (platform === "win32") {
      const exeName = cliId.toLowerCase().endsWith(".exe") ? cliId : `${cliId}.exe`;
      const exe = path.join(dir, exeName);
      if (exists(exe)) return canonicalize(exe, { ...options, platform });
      for (const ext of [".cmd", ".bat", ".ps1", ""]) {
        const shim = path.join(dir, `${cliId}${ext}`);
        if (exists(shim)) {
          rejectedShim = shim;
          break;
        }
      }
      if (rejectedShim) break;
    } else if (exists(path.join(dir, cliId))) {
      return canonicalize(path.join(dir, cliId), { ...options, platform });
    }
  }
  if (rejectedShim) {
    throw failClosed(unsupportedLauncherMessage(rejectedShim, platform));
  }
  throw failClosed(`missing binary ${cliId}; install and authenticate the native CLI`);
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
    throw failClosed(loginHint(harness, `${harness} auth command exited ${code}.`));
  }
  if (harness === "grok") {
    if (!/logged in/i.test(stdout)) {
      throw failClosed(loginHint("grok", "grok models did not report a logged-in session."));
    }
    const method = /grok\.com/i.test(stdout) ? "grok.com" : "unknown";
    if (method === "unknown") {
      throw failClosed(loginHint("grok", "grok auth method could not be determined."));
    }
    return { loggedIn: true, method, observedAt };
  }
  if (harness === "claude") {
    const payload = parseJson(stdout);
    if (!payload || typeof payload !== "object") {
      throw failClosed(loginHint("claude", "claude auth status was not parseable JSON."));
    }
    if (payload.loggedIn !== true) {
      throw failClosed(loginHint("claude", "claude auth status is logged out."));
    }
    const method = typeof payload.authMethod === "string" ? payload.authMethod : undefined;
    if (!method) {
      throw failClosed(loginHint("claude", "claude auth method is undetermined."));
    }
    return { loggedIn: true, method, observedAt, subscriptionType: payload.subscriptionType };
  }
  if (harness === "codex") {
    const text = `${stdout}\n${stderr}`;
    if (!/logged in using chatgpt/i.test(text)) {
      throw failClosed(loginHint("codex", "codex login status did not report ChatGPT auth."));
    }
    return { loggedIn: true, method: "ChatGPT", observedAt };
  }
  if (harness === "pi") {
    const text = `${stdout}\n${stderr}`;
    if (/not[_ ]ready/i.test(text) || !/\bready\b/i.test(text)) {
      throw failClosed(loginHint("pi", "pi auth check did not report OpenRouter ready."));
    }
    return { loggedIn: true, method: "openrouter", observedAt };
  }
  throw failClosed(`unknown harness ${harness} for auth parse`);
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
  if (harness === "grok") {
    return [
      "--prompt-file",
      promptPath,
      "-m",
      model,
      ...(effort ? ["--reasoning-effort", effort] : []),
      "--always-approve",
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

export function normalizePi(stdout) {
  const events = jsonlEvents(stdout);
  if (events.length === 0) {
    return { emptyPayload: true, harnessError: "empty JSON payload", costBasis: "unknown" };
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
      stopReason: event.message?.stopReason,
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
  const stopReason = last?.stopReason;
  const harnessError = errorEvent
    ? String(errorEvent.message?.errorMessage ?? errorEvent.error ?? errorEvent.message ?? "error").slice(0, 500)
    : stopReason === "error" || stopReason === "aborted"
      ? `pi stopReason ${stopReason}`
      : undefined;
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
    ...(harnessError ? { harnessError } : {}),
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
    return { emptyPayload: true, harnessError: "empty JSON payload", costBasis: "unknown" };
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
      ? { harnessError: String(failure.message ?? failure.error?.message ?? "turn.failed").slice(0, 500) }
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

export function normalizeClaudeOrGrok(payload, requestedModel) {
  if (!payload || typeof payload !== "object") {
    return { emptyPayload: true, harnessError: "empty JSON payload", costBasis: "unknown" };
  }
  const usage = payload.usage ?? {};
  const resolved = resolveModelUsage(payload.modelUsage ?? {}, requestedModel);
  const detail = resolved.primary ?? {};
  const tokensIn = detail.inputTokens ?? usage.input_tokens;
  const tokensOut = detail.outputTokens ?? usage.output_tokens;
  const cacheReadTokens = detail.cacheReadInputTokens ?? usage.cache_read_input_tokens;
  const cacheCreationTokens = detail.cacheCreationInputTokens ?? usage.cache_creation_input_tokens;
  const providerReportedCostUsd = payload.total_cost_usd ?? detail.costUSD;
  const stopReason = payload.stop_reason ?? payload.stopReason;
  const harnessError = payload.is_error
    ? String(payload.result ?? payload.error ?? "is_error")
    : stopReason === "error" || stopReason === "aborted"
      ? `stopReason ${stopReason}`
      : payload.error
        ? String(payload.error?.message ?? payload.error).slice(0, 500)
        : undefined;
  return {
    text: typeof payload.result === "string" ? payload.result : (payload.text ?? ""),
    sessionId: payload.sessionId ?? payload.session_id,
    effectiveModel: resolved.effectiveModel,
    tokensIn,
    tokensOut,
    cacheReadTokens,
    cacheCreationTokens,
    reasoningTokens: usage.reasoning_tokens ?? usage.output_tokens_details?.thinking_tokens,
    providerReportedCostUsd,
    costUsd: providerReportedCostUsd,
    costBasis: detail.costBasis ?? (providerReportedCostUsd === undefined ? "unknown" : "list"),
    stopReason,
    tokenBasis: TOKEN_BASIS,
    auxiliaryUsage: resolved.auxiliary,
    candidateModels: resolved.candidates,
    ...(harnessError ? { harnessError } : {}),
    ...(resolved.effectiveModel === "unknown" ? { modelResolution: "unresolved-alias" } : {}),
  };
}

function agentEnvelope(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = parseJson(fenced ? fenced[1] : text);
  if (!candidate || typeof candidate.status !== "string") return undefined;
  return {
    status: candidate.status,
    summary: candidate.summary ?? "",
    artifacts: Array.isArray(candidate.artifacts) ? candidate.artifacts : [],
    notesForNextAgent: candidate.notes_for_next_agent ?? candidate.notesForNextAgent ?? "",
    ...candidate,
  };
}

function applyRoutingCap(fields) {
  const metadata = {};
  const capped = {};
  for (const name of ["tokensIn", "tokensOut", "cacheReadTokens", "cacheCreationTokens", "reasoningTokens"]) {
    const value = fields[name];
    if (value === undefined) continue;
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value > ROUTING_INT_CAP) {
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
  if (harness === "pi" && request.permission === "edit" && request.role !== "experiment") {
    throw failClosed(`pi ${request.role} cannot edit; only experiment may use permission edit`);
  }
  if (harness !== "pi" && !route.models.includes(request.model)) {
    throw failClosed(`${harness} does not accept model ${request.model}; allowed: ${route.models.join(", ")}`);
  }
  if (harness === "pi") {
    const provider = piProviderOf(request.model);
    if (!provider) {
      throw failClosed("pi model must be provider/id (OpenRouter only in this helper)");
    }
    if (NATIVE_PI_BRAKE_PROVIDERS.includes(provider)) {
      throw failClosed(`pi brake: ${provider} has a native harness; refusing Pi impersonation`);
    }
    if (provider !== "openrouter") {
      throw failClosed(`pi helper allows only openrouter/*; ${provider} is not a native CLI and is not allowlisted`);
    }
    if (request.role === "writer") {
      throw failClosed("pi is not a Grok writer fallback; native grok must be logged in");
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
    schemaPath: schemaInput?.path,
    schemaText: schemaInput?.text,
  });
  const cliId = request.harness;
  const resolved = resolveLauncher(cliId, {
    platform,
    pathEnv: env.PATH,
    existsSync: exists,
    realpathSync: deps.realpathSync,
  });

  const authArgs = request.harness === "claude"
    ? [...claudeIsolationArgs(mcpConfigPath), ...route.auth.args]
    : request.harness === "pi"
      ? [...route.auth.args, "--provider", "openrouter"]
      : [...route.auth.args];
  const auth = spawnSyncImpl(resolved, authArgs, {
    cwd,
    env,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: deps.authTimeoutMs ?? 15_000,
  });
  if (auth.error && auth.error.code === "ENOENT") {
    throw failClosed(loginHint(cliId, `missing binary ${cliId}.`));
  }
  let authStatus;
  authStatus = parseAuth(cliId, {
    stdout: auth.stdout?.toString?.() ?? "",
    stderr: auth.stderr?.toString?.() ?? "",
    exitCode: auth.status ?? (auth.error ? -1 : 0),
  }, { observedAt: deps.observedAt });

  const stdinPrompt = request.harness === "claude" || request.harness === "codex";
  const started = now();
  const child = spawnImpl(resolved, argv, {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: [stdinPrompt ? "pipe" : "ignore", "pipe", "pipe"],
  });
  if (stdinPrompt && child.stdin) {
    child.stdin.write(promptInput.text);
    child.stdin.end();
  }

  let timedOut = false;
  let timer;
  if (request.timeout_ms !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, request.timeout_ms);
  }
  const collected = await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on?.("data", (chunk) => { stdout += chunk; });
    child.stderr?.on?.("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ stdout, stderr, exitCode: -1, error }));
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
  });
  if (timer) clearTimeout(timer);
  const latencyMs = now() - started;

  const fields = request.harness === "codex"
    ? normalizeCodex(collected.stdout)
    : request.harness === "pi"
      ? normalizePi(collected.stdout)
      : normalizeClaudeOrGrok(parseJson(collected.stdout), request.model);

  if (request.harness === "claude" && authStatus.method === "claude.ai") {
    fields.costBasis = "unmetered";
    fields.costUsd = undefined;
  } else if (request.harness === "codex" && authStatus.method === "ChatGPT") {
    fields.costBasis = "unmetered";
    fields.costUsd = undefined;
  } else if (fields.costUsd === undefined && fields.providerReportedCostUsd === undefined) {
    fields.costBasis = fields.costBasis ?? "unknown";
  }

  const stderrPath = join(outputDir, "stderr.log");
  const stderrBytes = Buffer.byteLength(collected.stderr ?? "", "utf8");
  if (stderrBytes > 0) writePrivate(stderrPath, collected.stderr, deps);
  const answerText = fields.text ?? "";
  const answerPath = join(outputDir, "answer.txt");
  const answerBytes = Buffer.byteLength(answerText, "utf8");
  if (answerBytes > 0) writePrivate(answerPath, answerText, deps);

  const agent = agentEnvelope(answerText);
  const emptyPayload = fields.emptyPayload === true
    || ((request.harness === "codex" || request.harness === "pi")
      ? jsonlEvents(collected.stdout).length === 0
      : !parseJson(collected.stdout));
  const harnessError = timedOut
    ? (fields.harnessError ?? "timed out")
    : emptyPayload
      ? (fields.harnessError ?? "empty JSON payload")
      : fields.harnessError;
  const ok = collected.exitCode === 0
    && !timedOut
    && !harnessError
    && !emptyPayload
    && agent?.status !== "fail";

  const { capped, metadata } = applyRoutingCap(fields);
  const result = {
    schema: RESULT_SCHEMA,
    ok,
    harness: request.harness,
    provider: request.harness === "pi" ? piProviderOf(request.model) : route.provider,
    role: request.role,
    requestedModel: request.model,
    effectiveModel: fields.effectiveModel,
    reasoningEffort: effort,
    ...(clamped ? { effortClampedFrom: clamped } : {}),
    latencyMs,
    exitCode: collected.exitCode,
    timedOut,
    finalOutcome: ok ? "passed" : "failed",
    tokenBasis: TOKEN_BASIS,
    contextOccupancy: CONTEXT_OCCUPANCY_UNKNOWN,
    ...capped,
    ...(fields.costUsd !== undefined ? { costUsd: fields.costUsd } : {}),
    costBasis: fields.costBasis,
    ...(fields.providerReportedCostUsd !== undefined ? { providerReportedCostUsd: fields.providerReportedCostUsd } : {}),
    ...(fields.sessionId ? { sessionId: fields.sessionId } : {}),
    ...(fields.stopReason ? { stopReason: fields.stopReason } : {}),
    ...(harnessError ? { harnessError: String(harnessError).slice(0, 500) } : {}),
    ...(fields.auxiliaryUsage?.length ? { auxiliaryUsage: fields.auxiliaryUsage } : {}),
    ...(fields.usageEvents?.length ? { usageEvents: fields.usageEvents } : {}),
    ...(fields.candidateModels && fields.effectiveModel === "unknown"
      ? { candidateModels: fields.candidateModels }
      : {}),
    auth: authStatus,
    command: cliId,
    ...(answerBytes > 0 ? { answerPath, answerBytes } : {}),
    ...(stderrBytes > 0 ? { stderrPath, stderrBytes } : {}),
    ...(agent ? { agent } : {}),
    ...(Object.keys(metadata).length > 0 ? { providerMetadata: metadata } : {}),
  };
  assertNoRawTransport(result, collected);
  return result;
}

function assertNoRawTransport(result, collected) {
  const serialized = JSON.stringify(result);
  if (Object.hasOwn(result, "stderr") && typeof result.stderr === "string") {
    throw failClosed("structured result must not carry raw stderr");
  }
  if (Object.hasOwn(result, "contextTokens")) {
    throw failClosed("contextTokens is removed; occupancy is unknown");
  }
  if (collected.stderr && collected.stderr.length > 80 && serialized.includes(collected.stderr.slice(0, 80))) {
    throw failClosed("structured result leaked raw stderr");
  }
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
    const failure = {
      schema: RESULT_SCHEMA,
      ok: false,
      error: error.message,
    };
    process.stdout.write(`${JSON.stringify(failure, undefined, 2)}\n`);
    process.exit(2);
  });
}
