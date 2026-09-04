#!/usr/bin/env node
// Common envelope over the headless agent CLIs.
//
// Reads a `kxm.harness-request.v1` JSON envelope (file argument or stdin),
// dispatches it to the right provider CLI, and prints a
// `kxm.harness-result.v1` envelope on stdout.
//
// The result field names deliberately match `RoutingRecord` in
// plugins/kxm/src/routing.ts so unit D5 can persist one of these directly, and
// the dispatch table is the prototype for unit E4b's one-shot adapter. Do not
// invent field names here that D5 will have to rename.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const REQUEST_SCHEMA = "kxm.harness-request.v1";
const RESULT_SCHEMA = "kxm.harness-result.v1";

// Normalized effort ladder. Each harness clamps to what it actually accepts;
// clamping is reported so routing telemetry is never silently wrong.
const EFFORT = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const HARNESS = {
  pi: {
    provider: "xai",
    efforts: EFFORT,
    build: (r) => [
      "-p",
      ...(r.model ? ["--model", r.model] : []),
      ...(r.effort ? ["--thinking", r.effort] : []),
      ...(r.permission === "read-only" ? ["--tools", "read,grep,find,ls"] : ["-a"]),
      ...(r.skills ?? []).flatMap((s) => ["--skill", s]),
      ...(r.hooks === false ? ["--no-extensions"] : []),
      "--mode", "json",
      "@" + r.prompt_file,
    ],
  },
  claude: {
    provider: "anthropic",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    stdinPrompt: true,
    build: (r) => [
      "-p",
      ...(r.model ? ["--model", r.model] : []),
      ...(r.effort ? ["--effort", r.effort] : []),
      ...(r.permission === "read-only"
        ? ["--allowedTools", "Read", "Grep", "Glob", "Bash"]
        : ["--dangerously-skip-permissions"]),
      ...(r.skills ?? []).flatMap((s) => ["--plugin-dir", s]),
      ...(r.hooks === false ? ["--bare"] : []),
      ...(r.max_cost_usd ? ["--max-budget-usd", String(r.max_cost_usd)] : []),
      ...(r.output_schema ? ["--json-schema", readFileSync(r.output_schema, "utf8")] : []),
      "--output-format", "json",
    ],
  },
  grok: {
    provider: "xai",
    efforts: ["low", "medium", "high"],
    build: (r) => [
      "--prompt-file", r.prompt_file,
      ...(r.model ? ["-m", r.model] : []),
      ...(r.effort ? ["--reasoning-effort", r.effort] : []),
      ...(r.permission === "read-only" ? ["--permission-mode", "plan"] : ["--always-approve"]),
      ...(r.output_schema ? ["--json-schema", readFileSync(r.output_schema, "utf8")] : []),
      "--output-format", "json",
    ],
  },
  codex: {
    provider: "openai",
    efforts: ["low", "medium", "high"],
    // `-` makes codex exec read the prompt from stdin. Passing it positionally
    // blows the Windows command-line limit (spawn ENAMETOOLONG) on real briefs.
    stdinPrompt: true,
    build: (r) => [
      "exec",
      ...(r.model ? ["-m", r.model] : []),
      ...(r.effort ? ["-c", 'model_reasoning_effort="' + r.effort + '"'] : []),
      "--sandbox", r.permission === "read-only" ? "read-only" : "workspace-write",
      ...(r.output_schema ? ["--output-schema", r.output_schema] : []),
      "--json",
      "-",
    ],
  },
  kimi: {
    provider: "moonshot",
    efforts: [],
    build: (r) => [
      ...(r.model ? ["-m", r.model] : []),
      ...(r.skills ?? []).flatMap((s) => ["--skills-dir", s]),
      ...(r.permission === "read-only" ? [] : ["--auto"]),
      "-p", readFileSync(r.prompt_file, "utf8"),
    ],
  },
  gemini: {
    provider: "google",
    efforts: [],
    build: (r) => [
      ...(r.model ? ["-m", r.model] : []),
      "--approval-mode", r.permission === "read-only" ? "plan" : "yolo",
      "-o", "json",
      "-p", readFileSync(r.prompt_file, "utf8"),
    ],
  },
  agy: {
    provider: "gateway",
    efforts: ["low", "medium", "high"],
    build: (r) => [
      "-p", readFileSync(r.prompt_file, "utf8"),
      ...(r.model ? ["--model", r.model] : []),
      ...(r.effort ? ["--effort", r.effort] : []),
      ...(r.permission === "read-only" ? [] : ["--dangerously-skip-permissions"]),
      ...(r.timeout_ms ? ["--print-timeout", Math.ceil(r.timeout_ms / 1000) + "s"] : []),
      "--output-format", "json",
    ],
  },
};

/** Clamp a normalized effort to what this harness actually accepts. */
function clampEffort(harness, effort) {
  const accepted = HARNESS[harness].efforts;
  if (!effort || accepted.length === 0) {
    return { effort: undefined, clamped: effort ?? undefined };
  }
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

/** Pull the first JSON object out of mixed stdout. */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    // Not pure JSON; fall through to a bounded scan.
  }
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  try {
    return JSON.parse(text.slice(start, text.lastIndexOf("}") + 1));
  } catch {
    return undefined;
  }
}

/** Codex speaks JSONL, not one object: `item.completed` carries the agent
 * message, `turn.completed` carries usage. A ChatGPT-account run is billed by
 * subscription, so its cost basis is `unmetered`, never `unknown`. */
function normalizeCodex(stdout) {
  const events = stdout.split("\n").map((line) => parseJson(line)).filter(Boolean);
  const message = events.filter((e) => e.item?.type === "agent_message").pop();
  const usage = events.find((e) => e.type === "turn.completed")?.usage ?? {};
  const failure = events.find((e) => e.type === "turn.failed" || e.type === "error");
  return {
    text: message?.item?.text ?? stdout.trim(),
    tokensIn: usage.input_tokens,
    tokensOut: usage.output_tokens,
    cacheReadTokens: usage.cached_input_tokens,
    cacheCreationTokens: usage.cache_write_input_tokens,
    reasoningTokens: usage.reasoning_output_tokens,
    contextTokens: sumDefined(usage.input_tokens, usage.output_tokens),
    costBasis: "unmetered",
    ...(failure ? { harnessError: String(failure.message ?? failure.error?.message).slice(0, 500) } : {}),
  };
}

/** Normalize a CLI's native payload into the shared usage and cost fields. */
function normalize(payload, stdout) {
  if (!payload) return { text: stdout.trim(), costBasis: "unknown" };
  // claude and grok are near wire-compatible: `usage` + `modelUsage` + total_cost_usd.
  const usage = payload.usage ?? {};
  const modelUsage = payload.modelUsage ?? {};
  const [effectiveModel, detail] = Object.entries(modelUsage)[0] ?? [];
  const cost = payload.total_cost_usd ?? detail?.costUSD;
  const tokensIn = usage.input_tokens ?? detail?.inputTokens;
  const tokensOut = usage.output_tokens ?? detail?.outputTokens;
  const cacheReadTokens = usage.cache_read_input_tokens ?? detail?.cacheReadInputTokens;
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? detail?.cacheCreationInputTokens;
  return {
    text: payload.text ?? payload.result ?? stdout.trim(),
    sessionId: payload.sessionId ?? payload.session_id,
    effectiveModel,
    tokensIn,
    tokensOut,
    cacheReadTokens,
    cacheCreationTokens,
    // Thinking is a share of `tokensOut`, not a fifth component. It bills at the
    // output rate; never add it to the other four or the totals stop reconciling.
    reasoningTokens: usage.reasoning_tokens ?? usage.output_tokens_details?.thinking_tokens,
    // Occupancy, not spend: how full the window was when the agent stopped.
    // The billing counters above only ever grow; this one does not.
    contextTokens: usage.total_tokens
      ?? sumDefined(tokensIn, tokensOut, cacheReadTokens, cacheCreationTokens),
    costUsd: cost,
    // Claude reports costBasis directly; anything priced but unlabeled is `list`.
    costBasis: detail?.costBasis ?? (cost === undefined ? "unknown" : "list"),
    stopReason: payload.stop_reason ?? payload.stopReason,
  };
}

function sumDefined(...values) {
  const present = values.filter((value) => typeof value === "number");
  return present.length === 0 ? undefined : present.reduce((sum, value) => sum + value, 0);
}

/** The agent-authored report, distinct from the harness-measured telemetry above.
 * Shape follows SSSF's `EnvelopeBase`: `status` is the only required field, and a
 * parsed envelope reporting `status: "fail"` is a failed phase even on exit 0.
 * The envelope is a manifest of claims; gates verify the claims afterwards. */
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

async function main() {
  const source = process.argv[2];
  const raw = source && source !== "-" ? readFileSync(source, "utf8") : readFileSync(0, "utf8");
  const request = JSON.parse(raw);

  if (request.schema !== REQUEST_SCHEMA) {
    throw new Error("request schema must be " + REQUEST_SCHEMA + ", got " + (request.schema ?? "none"));
  }
  const spec = HARNESS[request.harness];
  if (!spec) {
    throw new Error("unknown harness " + request.harness + "; expected one of " + Object.keys(HARNESS).join(", "));
  }
  if (!request.prompt_file) {
    throw new Error("prompt_file is required; inline prompts are not supported");
  }

  const { effort, clamped } = clampEffort(request.harness, request.effort);
  const argv = spec.build({ ...request, effort });

  // Windows caps a command line near 32k. kimi, gemini and agy have no
  // prompt-file or stdin option, so a long brief would die as a bare
  // `spawn ENAMETOOLONG`. Fail with something that names the cause instead.
  if (!spec.stdinPrompt) {
    const inlineBytes = argv.reduce((total, arg) => total + Buffer.byteLength(String(arg)), 0);
    if (inlineBytes > 30000) {
      throw new Error(
        `${request.harness} takes its prompt inline and this brief is ${inlineBytes} bytes, `
        + "over the ~32k Windows command-line limit. Shorten the brief, or use a harness that "
        + "reads a prompt file or stdin (grok, claude, codex, pi).",
      );
    }
  }

  const started = Date.now();

  const child = spawn(request.harness, argv, {
    cwd: request.cwd ?? process.cwd(),
    shell: process.platform === "win32",
    stdio: [spec.stdinPrompt ? "pipe" : "ignore", "pipe", "pipe"],
  });
  if (spec.stdinPrompt) {
    child.stdin.write(readFileSync(request.prompt_file, "utf8"));
    child.stdin.end();
  }

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const timer = request.timeout_ms ? setTimeout(() => child.kill("SIGKILL"), request.timeout_ms) : undefined;
  const exitCode = await new Promise((resolve) => {
    child.on("error", () => resolve(-1));
    child.on("close", resolve);
  });
  if (timer) clearTimeout(timer);

  const latencyMs = Date.now() - started;
  const fields = request.harness === "codex"
    ? normalizeCodex(stdout)
    : normalize(parseJson(stdout), stdout);
  const agent = agentEnvelope(fields.text ?? "");

  // A parsed envelope that declares its own failure is a failed phase, even
  // when the CLI exited 0. An agent saying it failed is not a success.
  const ok = exitCode === 0 && agent?.status !== "fail";

  const result = {
    schema: RESULT_SCHEMA,
    ok,
    harness: request.harness,
    provider: spec.provider,
    role: request.role,
    requestedModel: request.model,
    reasoningEffort: effort,
    ...(clamped ? { effortClampedFrom: clamped } : {}),
    latencyMs,
    exitCode,
    finalOutcome: ok ? "passed" : "failed",
    ...fields,
    ...(agent ? { agent } : {}),
    ...(stderr.trim() ? { stderr: stderr.trim().slice(0, 4000) } : {}),
  };
  process.stdout.write(JSON.stringify(result, undefined, 2) + "\n");
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  const failure = { schema: RESULT_SCHEMA, ok: false, error: error.message };
  process.stdout.write(JSON.stringify(failure, undefined, 2) + "\n");
  process.exit(2);
});
