import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import { nativeCriticLaunch } from "../../scripts/native-critic.mjs";
import {
  agyAuth,
  authFixture,
  claudeAuth,
  codexAuth,
  dispatch,
  fakeChild,
  grokAuth,
  piAuth,
  promptFile,
  tempDir,
} from "../helpers/harness-fake.ts";
import {
  NATIVE_PI_BRAKE_PROVIDERS,
  PI_ADMITTED_WRITER,
  PI_ALLOWED_PROVIDERS,
  PI_NOUS_PORTAL_HY4,
  REQUEST_SCHEMA,
  RESULT_SCHEMA,
  ROUTING_INT_CAP,
  buildArgv,
  clampEffort,
  diagnoseHarnessResult,
  formatRunCost,
  formatRunListing,
  normalizeAgy,
  normalizeClaudeOrGrok,
  normalizeCodex,
  normalizePi,
  parseAuth,
  piAuthCheckArgs,
  piModelId,
  piProviderOf,
  preflightRequest,
  resolveLaunch,
  resolveLauncher,
  resolveModelUsage,
  runHarness,
  unsupportedLauncherMessage,
} from "../../scripts/harness-run.mjs";

const printArgv = resolve("test/fixtures/harness/print-argv.mjs");
const helper = resolve("scripts/harness-run.mjs");

const claudeFablePayload = {
  result: "## Plan\nUse the helper.",
  is_error: false,
  session_id: "sess-fable",
  stop_reason: "end_turn",
  total_cost_usd: 2.749939,
  usage: {
    input_tokens: 32,
    output_tokens: 15209,
    cache_read_input_tokens: 902564,
    cache_creation_input_tokens: 88094,
  },
  modelUsage: {
    "claude-haiku-4-5-20251001": {
      inputTokens: 1533,
      outputTokens: 23,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0.001648,
      costBasis: "list",
    },
    "claude-fable-5-1": {
      inputTokens: 32,
      outputTokens: 15209,
      cacheReadInputTokens: 902564,
      cacheCreationInputTokens: 88094,
      costUSD: 2.748291,
      costBasis: "list",
    },
  },
};

function piLine(event: unknown): string {
  return `${JSON.stringify(event)}\n`;
}

function piAssistantEnd(overrides: Record<string, unknown> = {}) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      model: "openrouter/nous-research/deephermes-3-mistral-24b-preview",
      content: [{ type: "text", text: "later answer" }],
      stopReason: "stop",
      usage: {
        input: 10,
        output: 4,
        cacheRead: 2,
        cacheWrite: 1,
        cost: { total: 0.02 },
      },
      ...overrides,
    },
  };
}

test("auth fixtures contain no account emails, tokens, or user ids", () => {
  const raw = readFileSync(resolve("test/fixtures/harness/auth-fixtures.json"), "utf8");
  assert.doesNotMatch(raw, /@/);
  assert.doesNotMatch(raw, /sk-|Bearer |token/i);
  assert.doesNotMatch(raw, /user[_-]?id/i);
  assert.doesNotMatch(raw, /acct_/);
});

test("preflight refuses role, mode, pair, and native-provider Pi routes before spawn", async () => {
  const dir = tempDir();
  try {
    const prompt = promptFile(dir);
    const cases = [
      { harness: "grok", role: "planner", model: "grok-4.6", permission: "edit", prompt_file: prompt },
      { harness: "claude", role: "writer", model: "fable", permission: "read-only", prompt_file: prompt },
      { harness: "codex", role: "reviewer-cli", model: "gpt-5", permission: "read-only", prompt_file: prompt },
      { harness: "grok", role: "writer", model: "grok-4.6", permission: "read-only", prompt_file: prompt },
      { harness: "kimi", role: "writer", model: "kimi-for-coding", permission: "edit", prompt_file: prompt },
      { harness: "agy", role: "planner", model: "gemini-3", permission: "read-only", prompt_file: prompt },
      { harness: "agy", role: "planner", model: "x", permission: "read-only", prompt_file: prompt },
      { harness: "pi", role: "experiment", model: "xai/grok-4.6", permission: "edit", prompt_file: prompt },
      { harness: "pi", role: "writer", model: "openrouter/nous", permission: "edit", prompt_file: prompt },
      { harness: "claude", role: "planner", model: "fable", permission: "read-only", prompt_file: prompt, hooks: true },
      { harness: "claude", role: "planner", model: "fable", permission: "read-only", prompt_file: prompt, skills: ["x"] },
      { harness: "grok", role: "writer", model: "grok-4.6", permission: "edit", prompt_file: prompt, bare: true },
    ];
    let spawned = 0;
    for (const request of cases) {
      await assert.rejects(
        () => runHarness({ schema: REQUEST_SCHEMA, ...request } as never, {
          spawn: () => {
            spawned += 1;
            return fakeChild();
          },
          spawnSync: () => {
            spawned += 1;
            return grokAuth();
          },
        }),
        /fail|refus|unsupported|unverified|unknown|brake|does not accept|pending/i,
      );
    }
    assert.equal(spawned, 0);
    for (const provider of NATIVE_PI_BRAKE_PROVIDERS) {
      assert.throws(
        () => preflightRequest({
          schema: REQUEST_SCHEMA,
          harness: "pi",
          role: "experiment",
          model: `${provider}/anything`,
          permission: "read-only",
          prompt_file: prompt,
        }),
        /pi brake/,
      );
    }
    preflightRequest({
      schema: REQUEST_SCHEMA,
      harness: "pi",
      role: "experiment",
      model: "openrouter/nous-research/deephermes-3-mistral-24b-preview",
      permission: "read-only",
      prompt_file: prompt,
    });
    preflightRequest({
      schema: REQUEST_SCHEMA,
      harness: "pi",
      role: "experiment",
      model: PI_NOUS_PORTAL_HY4,
      permission: "read-only",
      prompt_file: prompt,
    });
    preflightRequest({
      schema: REQUEST_SCHEMA,
      harness: "pi",
      role: "experiment",
      model: PI_NOUS_PORTAL_HY4,
      permission: "edit",
      prompt_file: prompt,
    });
    assert.throws(
      () => preflightRequest({
        schema: REQUEST_SCHEMA,
        harness: "pi",
        role: "writer",
        model: PI_NOUS_PORTAL_HY4,
        permission: "edit",
        prompt_file: prompt,
      }),
      /pi writer/,
    );
    assert.throws(
      () => preflightRequest({
        schema: REQUEST_SCHEMA,
        harness: "pi",
        role: "experiment",
        model: "together/secret-model",
        permission: "read-only",
        prompt_file: prompt,
      }),
      /nous-portal\/\*/,
    );
    assert.throws(
      () => preflightRequest({
        schema: REQUEST_SCHEMA,
        harness: "pi",
        role: "experiment",
        model: "nous-portal-api-key/tencent/hy4-preview",
        permission: "read-only",
        prompt_file: prompt,
      }),
      /not allowlisted/,
    );
    preflightRequest({
      schema: REQUEST_SCHEMA,
      harness: "agy",
      role: "writer",
      model: "gemini-3.8-flash-low",
      permission: "edit",
      prompt_file: prompt,
    });
    preflightRequest({
      schema: REQUEST_SCHEMA,
      harness: "agy",
      role: "experiment",
      model: "gemini-3.1-pro-high",
      permission: "edit",
      prompt_file: prompt,
    });
    assert.throws(
      () => preflightRequest({
        schema: REQUEST_SCHEMA,
        harness: "agy",
        role: "writer",
        model: "claude-sonnet-4-6",
        permission: "edit",
        prompt_file: prompt,
      }),
      /does not accept model/,
    );
    assert.throws(
      () => preflightRequest({
        schema: REQUEST_SCHEMA,
        harness: "agy",
        role: "planner",
        model: "gemini-3.8-flash-low",
        permission: "edit",
        prompt_file: prompt,
      }),
      /does not accept role/,
    );
    assert.throws(
      () => preflightRequest({
        schema: REQUEST_SCHEMA,
        harness: "agy",
        role: "writer",
        model: "gemini-3.8-flash-low",
        permission: "read-only",
        prompt_file: prompt,
      }),
      /does not accept permission/,
    );
    assert.deepEqual([...PI_ALLOWED_PROVIDERS], ["openrouter", "nous-portal"]);
    assert.equal(piProviderOf(PI_NOUS_PORTAL_HY4), "nous-portal");
    assert.equal(piModelId(PI_NOUS_PORTAL_HY4), "tencent/hy4-preview");
    assert.equal(PI_ADMITTED_WRITER, "openrouter/qwen/qwen3-coder-plus");
    assert.deepEqual(
      piAuthCheckArgs({
        model: "openrouter/nous-research/deephermes-3-mistral-24b-preview",
        role: "experiment",
      }),
      ["auth", "check", "--provider", "openrouter"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claude argv is safe-mode read-only tools without --bare or Bash", () => {
  const argv = buildArgv({
    harness: "claude",
    model: "fable",
    effort: "high",
    permission: "read-only",
    prompt_file: "/tmp/brief.md",
  }, { mcpConfigPath: "/tmp/mcp-empty.json" });
  assert.deepEqual(argv.slice(0, 6), ["-p", "--model", "fable", "--effort", "high", "--tools"]);
  assert.equal(argv[6], "Read,Glob,Grep");
  assert(argv.includes("--safe-mode"));
  assert(argv.includes("--strict-mcp-config"));
  assert(argv.includes("--disable-slash-commands"));
  assert(!argv.includes("--bare"));
  assert(!argv.includes("Bash"));
  assert(!argv.includes("--allowedTools"));
});

test("grok and codex argv match verified A4 flags", () => {
  const grok = buildArgv({
    harness: "grok",
    model: "grok-4.6",
    effort: "high",
    permission: "edit",
    prompt_file: "/tmp/brief.md",
  });
  assert.deepEqual(grok, [
    "--prompt-file", "/tmp/brief.md",
    "-m", "grok-4.6",
    "--reasoning-effort", "high",
    "--always-approve",
    "--no-subagents",
    "--disable-web-search",
    "--output-format", "json",
  ]);
  const { effort, clamped } = clampEffort("codex", "xhigh");
  assert.equal(effort, "high");
  assert.equal(clamped, "xhigh");
  const codex = buildArgv({
    harness: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    permission: "read-only",
    prompt_file: "/tmp/brief.md",
  });
  assert.equal(codex[0], "exec");
  assert.deepEqual(codex.slice(1, 5), ["-m", "gpt-5.6-sol", "-c", 'model_reasoning_effort="high"']);
  assert.deepEqual(codex.slice(5, 7), ["--sandbox", "read-only"]);
  assert(codex.includes("--ignore-user-config"));
  assert(codex.includes('approval_policy="never"'));
  assert(!codex.includes("--full-auto"));
  assert(!codex.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert(!codex.includes("--ignore-rules"));
  assert(codex.includes("--json"));
  assert.equal(codex.at(-1), "-");
});

test("native Astra critic binds the requested model to safe Codex argv without launching on import", () => {
  const launch = nativeCriticLaunch("astra");
  assert.equal(launch.command, "codex");
  assert.equal(launch.model, "gpt-6-astra");
  assert.deepEqual(launch.args, [
    "exec", "-m", "gpt-6-astra",
    "-c", 'model_reasoning_effort="low"',
    "--sandbox", "read-only", "--ignore-user-config",
    "-c", 'approval_policy="never"', "--json", "-",
  ]);
  assert.throws(() => nativeCriticLaunch("unknown"), /usage:/);
});

test("agy argv uses prompt text, json schema path, effort, and print-timeout; no prompt-file or stdin", () => {
  const argv = buildArgv({
    harness: "agy",
    model: "gemini-3.8-flash-low",
    effort: "medium",
    permission: "edit",
    prompt_file: "/tmp/brief.md",
    timeout_ms: 45000,
  }, {
    promptText: "brief body",
    schemaPath: "/tmp/schema.json",
  });
  assert.deepEqual(argv, [
    "-p", "brief body",
    "--output-format", "json",
    "--dangerously-skip-permissions",
    "--model", "gemini-3.8-flash-low",
    "--effort", "medium",
    "--json-schema", "/tmp/schema.json",
    "--print-timeout", "45000ms",
  ]);
  assert(!argv.includes("--prompt-file"));
  const { effort, clamped } = clampEffort("agy", "xhigh");
  assert.equal(effort, "high");
  assert.equal(clamped, "xhigh");
});

test("auth parse: success, logout, and garbage fail closed", () => {
  const grok = parseAuth("grok", authFixture("grok") as { stdout: string; stderr: string; exitCode: number }, { observedAt: "2026-09-05" });
  assert.deepEqual(grok, { loggedIn: true, method: "grok.com", observedAt: "2026-09-05" });
  assert.throws(() => parseAuth("grok", { stdout: "Available models:\n", stderr: "", exitCode: 0 }), /logged-in/);
  assert.throws(() => parseAuth("grok", { stdout: "????", stderr: "", exitCode: 0 }), /logged-in/);
  assert.throws(() => parseAuth("claude", { stdout: "logged in maybe", stderr: "", exitCode: 0 }), /parseable/);
  assert.throws(() => parseAuth("claude", {
    stdout: JSON.stringify({ loggedIn: false, authMethod: "claude.ai" }),
    stderr: "",
    exitCode: 0,
  }), /logged out/);
  const claude = parseAuth("claude", {
    stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
    stderr: "",
    exitCode: 0,
  }, { observedAt: "2026-09-05" });
  assert.equal(claude.method, "claude.ai");
  const codex = parseAuth("codex", authFixture("codex") as { stdout: string; stderr: string; exitCode: number }, { observedAt: "2026-09-05" });
  assert.equal(codex.method, "ChatGPT");
  assert.throws(() => parseAuth("codex", { stdout: "garbage", stderr: "nope", exitCode: 0 }), /ChatGPT/);
  assert.throws(() => parseAuth("pi", { stdout: "openrouter  not_ready", stderr: "", exitCode: 0 }), /OpenRouter/);
  const openrouter = parseAuth("pi", { stdout: "openrouter  ready\n", stderr: "", exitCode: 0 }, {
    observedAt: "2026-09-05",
    provider: "openrouter",
  });
  assert.deepEqual(openrouter, { loggedIn: true, method: "openrouter", observedAt: "2026-09-05" });
  const nous = parseAuth("pi", { stdout: "nous-portal  ready\n", stderr: "", exitCode: 0 }, {
    observedAt: "2026-09-05",
    provider: "nous-portal",
  });
  assert.deepEqual(nous, { loggedIn: true, method: "nous-portal", observedAt: "2026-09-05" });
  assert.throws(
    () => parseAuth("pi", { stdout: "nous-portal  not_ready\n", stderr: "", exitCode: 0 }, { provider: "nous-portal" }),
    /Nous Portal/,
  );
  assert.throws(
    () => parseAuth("pi", { stdout: "openrouter  ready\n", stderr: "", exitCode: 0 }, { provider: "nous-portal" }),
    /could not be determined/,
  );
  const agy = parseAuth("agy", authFixture("agy") as { stdout: string; stderr: string; exitCode: number }, { observedAt: "2026-09-08" });
  assert.deepEqual(agy, { loggedIn: true, method: "antigravity-oauth", observedAt: "2026-09-08" });
  assert.throws(() => parseAuth("agy", { stdout: "Fetching available models...\n", stderr: "", exitCode: 0 }), /models list/);
  assert.throws(() => parseAuth("agy", { stdout: "", stderr: "", exitCode: 0 }), /models list/);
});

test("subscription billed cost is unmetered; list estimate stays separate; missing cost is unknown", async () => {
  const dir = tempDir();
  try {
    const prompt = promptFile(dir);
    const claude = await dispatch({
      schema: REQUEST_SCHEMA,
      harness: "claude",
      role: "planner",
      model: "fable",
      effort: "high",
      permission: "read-only",
      prompt_file: prompt,
      output_dir: join(dir, "out-claude"),
    }, { stdout: `${JSON.stringify(claudeFablePayload)}\n` }, claudeAuth());
    assert.equal(claude.result.ok, true);
    assert.equal(claude.result.costBasis, "unmetered");
    assert.equal(claude.result.costUsd, undefined);
    assert.equal(claude.result.providerReportedCostUsd, 2.749939);
    assert.equal(claude.result.effectiveModel, "claude-fable-5-1");
    assert.equal(claude.result.tokensIn, 32);
    assert.equal(claude.result.auxiliaryUsage[0].model, "claude-haiku-4-5-20251001");
    assert.equal(claude.result.auxiliaryUsage[0].tokensIn, 1533);
    assert.doesNotMatch(JSON.stringify(claude.result), /"stderr":"/);
    assert.equal(claude.result.contextTokens, undefined);
    assert.equal(claude.result.contextOccupancy, "unknown");
    assert.equal(claude.result.tokenBasis, "cumulative");
    assert.match(readFileSync(claude.result.answerPath as string, "utf8"), /Plan/);

    const grokPayload = {
      result: "files written",
      sessionId: "g1",
      stop_reason: "end_turn",
      modelUsage: { "grok-4.6-build": { inputTokens: 9, outputTokens: 3 } },
    };
    const grok = await dispatch({
      schema: REQUEST_SCHEMA,
      harness: "grok",
      role: "writer",
      model: "grok-4.6",
      effort: "high",
      permission: "edit",
      prompt_file: prompt,
      output_dir: join(dir, "out-grok"),
    }, { stdout: `${JSON.stringify(grokPayload)}\n` });
    assert.equal(grok.result.ok, true);
    assert.equal(grok.result.costBasis, "unknown");
    assert.equal(grok.result.costUsd, undefined);
    assert.equal(grok.result.effectiveModel, "grok-4.6-build");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claude alias with no exact key is unknown with candidate metadata", () => {
  const resolved = resolveModelUsage(claudeFablePayload.modelUsage, "sonnet");
  assert.equal(resolved.effectiveModel, "unknown");
  assert.deepEqual(resolved.candidates, ["claude-haiku-4-5-20251001", "claude-fable-5-1"]);
  const fields = normalizeClaudeOrGrok(claudeFablePayload, "sonnet");
  assert.equal(fields.effectiveModel, "unknown");
  assert.equal(fields.modelResolution, "unresolved-alias");
  assert.equal(fields.tokensIn, claudeFablePayload.usage.input_tokens);
});

test("pi JSONL sums every assistant message_end and keeps last text/model", () => {
  const stdout = [
    piLine({ type: "session", id: "sess-pi", version: 3 }),
    piLine({ type: "agent_start" }),
    piLine({
      type: "message_end",
      message: {
        role: "user",
        content: "ignore me",
        usage: { input: 999, output: 999, cacheRead: 999, cacheWrite: 999, cost: { total: 9 } },
      },
    }),
    piLine({
      type: "message_end",
      message: {
        role: "assistant",
        model: "openrouter/first",
        content: [{ type: "text", text: "first call" }],
        stopReason: "toolUse",
        usage: {
          input: 11,
          output: 5,
          cacheRead: 3,
          cacheWrite: 2,
          cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.03 },
        },
      },
    }),
    piLine({ type: "tool_execution_end", toolName: "read", isError: false }),
    piLine(piAssistantEnd({
      model: "openrouter/second",
      content: [{ type: "text", text: "final answer" }],
      usage: {
        input: 7,
        output: 8,
        cacheRead: 1,
        cacheWrite: 4,
        cost: { total: 0.05 },
      },
    })),
  ].join("");
  const fields = normalizePi(stdout);
  assert.equal(fields.text, "final answer");
  assert.equal(fields.effectiveModel, "openrouter/second");
  assert.equal(fields.tokensIn, 18);
  assert.equal(fields.tokensOut, 13);
  assert.equal(fields.cacheReadTokens, 4);
  assert.equal(fields.cacheCreationTokens, 6);
  assert.equal(fields.costUsd, 0.08);
  assert.equal(fields.costBasis, "list");
  assert.equal(fields.stopReason, "stop");
  assert.equal(fields.usageEvents?.length, 2);
  assert.equal(fields.sessionId, "sess-pi");
});

test("pi aborted stopReason is a harness error even on exit 0", async () => {
  const dir = tempDir();
  try {
    const prompt = promptFile(dir);
    const stdout = [
      piLine({ type: "session", id: "s" }),
      piLine(piAssistantEnd({ stopReason: "aborted", content: [{ type: "text", text: "cut short" }] })),
    ].join("");
    const { result, spawns } = await dispatch({
      schema: REQUEST_SCHEMA,
      harness: "pi",
      role: "experiment",
      model: "openrouter/nous-research/deephermes-3-mistral-24b-preview",
      permission: "read-only",
      prompt_file: prompt,
      output_dir: join(dir, "out"),
    }, { stdout, exitCode: 0 }, piAuth());
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "stop_aborted");
    assert.equal(result.stopReason, "aborted");
    assert.equal(result.harnessError, undefined);
    assert.equal(result.status, "failed");
    assert.equal(result.finalOutcome, undefined);
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0]?.options.shell, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native error payloads fail even when the CLI exits 0", async () => {
  const dir = tempDir();
  try {
    const prompt = promptFile(dir);
    const claudeErr = await dispatch({
      schema: REQUEST_SCHEMA,
      harness: "claude",
      role: "planner",
      model: "fable",
      permission: "read-only",
      prompt_file: prompt,
      output_dir: join(dir, "c"),
    }, { stdout: `${JSON.stringify({ ...claudeFablePayload, is_error: true, result: "boom" })}\n`, exitCode: 0 }, claudeAuth());
    assert.equal(claudeErr.result.ok, false);

    const codexErr = await dispatch({
      schema: REQUEST_SCHEMA,
      harness: "codex",
      role: "reviewer-cli",
      model: "gpt-5.6-sol",
      permission: "read-only",
      prompt_file: prompt,
      output_dir: join(dir, "x"),
    }, {
      stdout: [
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "nope" } }),
        JSON.stringify({ type: "turn.failed", message: "turn exploded" }),
      ].join("\n"),
      exitCode: 0,
    }, codexAuth());
    assert.equal(codexErr.result.ok, false);
    assert.equal(codexErr.result.errorCode, "turn_failed");
    assert.equal(codexErr.result.harnessError, undefined);
    assert.doesNotMatch(JSON.stringify(codexErr.result), /exploded/);

    const empty = await dispatch({
      schema: REQUEST_SCHEMA,
      harness: "grok",
      role: "writer",
      model: "grok-4.6",
      permission: "edit",
      prompt_file: prompt,
      output_dir: join(dir, "e"),
    }, { stdout: "   ", exitCode: 0 });
    assert.equal(empty.result.ok, false);
    assert.equal(empty.result.errorCode, "empty_payload");
    assert.equal(empty.result.harnessError, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function agyPayload(overrides: Record<string, unknown> = {}) {
  return {
    conversation_id: "agy-1",
    status: "SUCCESS",
    response: "files written",
    duration_seconds: 1.2,
    num_turns: 1,
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      thinking_tokens: 2,
      cache_read_tokens: 3,
      total_tokens: 19,
    },
    ...overrides,
  };
}

test("agy JSON status is trusted over exit code; timeout, unmetered, and denied_actions map", async () => {
  const dir = tempDir();
  try {
    const prompt = promptFile(dir, "agy brief");
    const schema = join(dir, "schema.json");
    writeFileSync(schema, JSON.stringify({ type: "object", additionalProperties: false }));
    const fields = normalizeAgy(agyPayload());
    assert.equal(fields.text, "files written");
    assert.equal(fields.sessionId, "agy-1");
    assert.equal(fields.tokensIn, 10);
    assert.equal(fields.tokensOut, 4);
    assert.equal(fields.reasoningTokens, 2);
    assert.equal(fields.cacheReadTokens, 3);
    assert.equal(fields.totalTokens, 19);
    assert.equal(fields.costBasis, "unmetered");
    assert.equal(fields.costUsd, undefined);
    assert.equal(fields.effectiveModel, undefined);
    assert.equal(normalizeAgy(agyPayload({ model: "gemini-3.8-flash-low" })).effectiveModel, "gemini-3.8-flash-low");

    const ok = await dispatch({
      schema: REQUEST_SCHEMA,
      harness: "agy",
      role: "writer",
      model: "gemini-3.8-flash-low",
      effort: "low",
      permission: "edit",
      prompt_file: prompt,
      output_schema: schema,
      timeout_ms: 30_000,
      output_dir: join(dir, "ok"),
    }, { stdout: `${JSON.stringify(agyPayload())}\n`, exitCode: 0 }, agyAuth());
    assert.equal(ok.result.ok, true);
    assert.equal(ok.result.status, "completed");
    assert.equal(ok.result.costBasis, "unmetered");
    assert.equal(ok.result.costUsd, undefined);
    assert.equal(ok.result.effectiveModel, undefined);
    assert.equal(ok.result.tokensIn, 10);
    assert.equal(ok.result.reasoningTokens, 2);
    assert.equal(ok.result.totalTokens, 19);
    assert.doesNotMatch(JSON.stringify(ok.result), /"costUsd":0/);
    assert.equal(ok.spawns[0]?.options.shell, false);
    const stdio = ok.spawns[0]?.options.stdio;
    assert(Array.isArray(stdio));
    assert.equal(stdio[0], "ignore");
    const argv = ok.spawns[0]?.argv ?? [];
    assert.equal(argv[0], "-p");
    assert.equal(argv[1], "agy brief");
    assert(!argv.includes("--prompt-file"));
    assert(argv.includes("--dangerously-skip-permissions"));
    const schemaAt = argv.indexOf("--json-schema");
    assert.equal(argv[schemaAt + 1], schema);
    const timeoutAt = argv.indexOf("--print-timeout");
    assert.equal(argv[timeoutAt + 1], "30000ms");

    const modelErr = await dispatch({
      schema: REQUEST_SCHEMA,
      harness: "agy",
      role: "writer",
      model: "gemini-3.8-flash-low",
      permission: "edit",
      prompt_file: prompt,
      output_dir: join(dir, "err"),
    }, {
      stdout: `${JSON.stringify(agyPayload({ status: "ERROR", error: "unknown model", response: "" }))}\n`,
      exitCode: 0,
    }, agyAuth());
    assert.equal(modelErr.result.ok, false);
    assert.equal(modelErr.result.exitCode, 0);
    assert.equal(modelErr.result.errorCode, "model_error");
    assert.match(readFileSync(modelErr.result.errorPath as string, "utf8"), /unknown model/);

    const timed = await dispatch({
      schema: REQUEST_SCHEMA,
      harness: "agy",
      role: "experiment",
      model: "gemini-3.1-pro-low",
      permission: "edit",
      prompt_file: prompt,
      output_dir: join(dir, "to"),
    }, {
      stdout: `${JSON.stringify(agyPayload({ status: "ERROR", error: "timeout waiting for response", response: "" }))}\n`,
      exitCode: 0,
    }, agyAuth());
    assert.equal(timed.result.ok, false);
    assert.equal(timed.result.errorCode, "timed_out");
    assert.equal(timed.result.exitCode, 0);

    const denied = await dispatch({
      schema: REQUEST_SCHEMA,
      harness: "agy",
      role: "writer",
      model: "gemini-3.8-flash-medium",
      permission: "edit",
      prompt_file: prompt,
      output_dir: join(dir, "denied"),
    }, {
      stdout: `${JSON.stringify(agyPayload({ denied_actions: ["write_file", "command"] }))}\n`,
      exitCode: 0,
    }, agyAuth());
    assert.equal(denied.result.ok, false);
    assert.equal(denied.result.errorCode, "turn_failed");
    assert.match(readFileSync(denied.result.errorPath as string, "utf8"), /write_file/);
    assert.doesNotMatch(JSON.stringify(denied.result), /write_file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("large counters stay in metadata and are not clipped to zero; occupancy stays unknown", () => {
  const huge = ROUTING_INT_CAP + 5;
  const fields = normalizeClaudeOrGrok({
    result: "ok",
    is_error: false,
    stop_reason: "end_turn",
    modelUsage: {
      "grok-4.6-build": {
        inputTokens: huge,
        outputTokens: 3,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
  }, "grok-4.6");
  assert.equal(fields.tokensIn, huge);
  assert.equal(fields.contextTokens, undefined);
});

test("runHarness moves oversized counters to metadata without zeroing them", async () => {
  const dir = tempDir();
  try {
    const prompt = promptFile(dir);
    const huge = ROUTING_INT_CAP + 9;
    const { result } = await dispatch({
      schema: REQUEST_SCHEMA,
      harness: "grok",
      role: "writer",
      model: "grok-4.6",
      permission: "edit",
      prompt_file: prompt,
      output_dir: join(dir, "out"),
    }, {
      stdout: `${JSON.stringify({
        result: "ok",
        modelUsage: { "grok-4.6-build": { inputTokens: huge, outputTokens: 2 } },
        total_cost_usd: 0.1,
      })}\n`,
    });
    assert.equal(result.tokensIn, undefined);
    assert.equal(result.providerMetadata?.tokensIn, huge);
    assert.notEqual(result.providerMetadata?.tokensIn, 0);
    assert.equal(result.tokensOut, 2);
    assert.equal(result.contextOccupancy, "unknown");
    assert.equal(result.costBasis, "provider-reported");
    assert.equal(result.costUsd, 0.1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timeout kill sets timedOut and fails", async () => {
  const dir = tempDir();
  try {
    const prompt = promptFile(dir);
    const { result } = await dispatch({
      schema: REQUEST_SCHEMA,
      harness: "grok",
      role: "writer",
      model: "grok-4.6",
      permission: "edit",
      prompt_file: prompt,
      timeout_ms: 5,
      output_dir: join(dir, "out"),
    }, { hang: true, stdout: "" });
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.status, "interrupted");
    assert.notEqual(result.status, "completed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("structured result has sidecar paths, not raw stderr or model transport", async () => {
  const dir = tempDir();
  try {
    const prompt = promptFile(dir);
    const secret = "RAW-STDERR-MODEL-TRACE-do-not-serialize";
    const { result } = await dispatch({
      schema: REQUEST_SCHEMA,
      harness: "grok",
      role: "writer",
      model: "grok-4.6",
      permission: "edit",
      prompt_file: prompt,
      output_dir: join(dir, "out"),
    }, {
      stdout: `${JSON.stringify({ result: "visible answer for callers", modelUsage: { "grok-4.6-build": { inputTokens: 1, outputTokens: 1 } }, total_cost_usd: 0.01 })}\n`,
      stderr: secret,
    });
    const serialized = JSON.stringify(result);
    assert.equal(result.ok, true);
    assert.equal(result.stderr, undefined);
    assert.ok(result.stderrPath);
    assert.equal(result.stderrBytes, Buffer.byteLength(secret));
    assert.equal(readFileSync(String(result.stderrPath), "utf8"), secret);
    assert.doesNotMatch(serialized, /RAW-STDERR-MODEL-TRACE/);
    assert.equal(result.text, undefined);
    assert.match(readFileSync(String(result.answerPath), "utf8"), /visible answer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("win32 launcher rejects .cmd/.bat/.ps1/extensionless without spawn", () => {
  const exists = (path: string) => path.endsWith(".cmd") || path.endsWith("grok");
  assert.throws(
    () => resolveLauncher(String.raw`C:\Tools\grok.cmd`, { platform: "win32", existsSync: () => true }),
    /unsupported-launcher/,
  );
  assert.throws(
    () => resolveLauncher(String.raw`C:\Tools\grok.bat`, { platform: "win32", existsSync: () => true }),
    /unsupported-launcher/,
  );
  assert.throws(
    () => resolveLauncher(String.raw`C:\Tools\grok.ps1`, { platform: "win32", existsSync: () => true }),
    /unsupported-launcher/,
  );
  assert.throws(
    () => resolveLauncher("grok", {
      platform: "win32",
      pathEnv: String.raw`C:\Tools`,
      existsSync: exists,
    }),
    /unsupported-launcher/,
  );
  const exe = resolveLauncher(String.raw`C:\Tools\grok.exe`, { platform: "win32", existsSync: () => true });
  assert.equal(exe, String.raw`C:\Tools\grok.exe`);
  assert.match(unsupportedLauncherMessage("pi.cmd", "win32"), /pi.cmd/);
});

test("win32 launcher unwraps npm inner claude.exe and pi node script", () => {
  const npmDir = String.raw`C:\Users\me\AppData\Roaming\npm`;
  const claudeCmd = String.raw`C:\Users\me\AppData\Roaming\npm\claude.cmd`;
  const claudeExe = String.raw`C:\Users\me\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`;
  const piCmd = String.raw`C:\Users\me\AppData\Roaming\npm\pi.cmd`;
  const piScript = String.raw`C:\Users\me\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js`;
  const nodeExe = String.raw`C:\Program Files\nodejs\node.exe`;
  const present = new Set([claudeCmd, claudeExe, piCmd, piScript, nodeExe]);
  const exists = (path: string) => present.has(path);

  const claude = resolveLaunch("claude", {
    platform: "win32",
    pathEnv: npmDir,
    existsSync: exists,
  });
  assert.equal(claude.command, claudeExe);
  assert.deepEqual(claude.args, []);
  assert.equal(resolveLauncher("claude", {
    platform: "win32",
    pathEnv: npmDir,
    existsSync: exists,
  }), claudeExe);

  const pi = resolveLaunch("pi", {
    platform: "win32",
    pathEnv: npmDir,
    existsSync: exists,
    execPath: nodeExe,
  });
  assert.equal(pi.command, nodeExe);
  assert.deepEqual(pi.args, [piScript]);

  assert.throws(
    () => resolveLaunch("claude", {
      platform: "win32",
      pathEnv: npmDir,
      existsSync: (path: string) => path === claudeCmd,
    }),
    /unsupported-launcher/,
  );

  const binDir = String.raw`C:\Users\me\bin`;
  const exeDir = String.raw`C:\Users\me\AppData\Local\Programs\OpenAI\Codex\bin`;
  const codexCmd = String.raw`C:\Users\me\bin\codex.cmd`;
  const codexExe = String.raw`C:\Users\me\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe`;
  const shadowed = resolveLaunch("codex", {
    platform: "win32",
    pathEnv: `${binDir};${exeDir}`,
    existsSync: (path: string) => path === codexCmd || path === codexExe,
  });
  assert.equal(shadowed.command, codexExe);
  assert.deepEqual(shadowed.args, []);
});

test("shell:false argv transport keeps metacharacters literal via process.execPath", () => {
  const args = ["a&b", "x|y", "$(oops)", ">out", "`tick`"];
  const ran = spawnSync(process.execPath, [printArgv, ...args], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  assert.equal(ran.status, 0, ran.stderr);
  const payload = JSON.parse(ran.stdout) as { argv: string[]; execPath: string };
  assert.equal(payload.execPath, process.execPath);
  assert.deepEqual(payload.argv, args);
  assert.equal(process.versions.node.split(".")[0] === "22" || Number(process.versions.node.split(".")[0]) >= 22, true);
});

test("runHarness assignment spawn is always shell:false with literal argv", async () => {
  const dir = tempDir();
  try {
    const prompt = promptFile(dir);
    const { spawns } = await dispatch({
      schema: REQUEST_SCHEMA,
      harness: "grok",
      role: "writer",
      model: "grok-4.6",
      permission: "edit",
      prompt_file: prompt,
      output_dir: join(dir, "out"),
    }, { stdout: `${JSON.stringify({ result: "ok", modelUsage: { "grok-4.6-build": { inputTokens: 1, outputTokens: 1 } } })}\n` });
    assert.equal(spawns[0]?.options.shell, false);
    assert(spawns[0]?.argv.includes("--prompt-file"));
    assert(!spawns[0]?.argv.includes("--bare"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing binary and unparseable auth fail closed with login hint, no assignment spawn", async () => {
  const dir = tempDir();
  try {
    const prompt = promptFile(dir);
    let assignments = 0;
    await assert.rejects(() => runHarness({
      schema: REQUEST_SCHEMA,
      harness: "grok",
      role: "writer",
      model: "grok-4.6",
      permission: "edit",
      prompt_file: prompt,
      output_dir: join(dir, "out"),
    } as never, {
      existsSync: () => false,
      spawn: () => {
        assignments += 1;
        return fakeChild();
      },
      spawnSync: () => ({ error: { code: "ENOENT" }, status: null, stdout: "", stderr: "" }),
    }), /missing binary|Log in/);
    await assert.rejects(() => runHarness({
      schema: REQUEST_SCHEMA,
      harness: "grok",
      role: "writer",
      model: "grok-4.6",
      permission: "edit",
      prompt_file: prompt,
      output_dir: join(dir, "out2"),
    } as never, {
      existsSync: () => true,
      spawn: () => {
        assignments += 1;
        return fakeChild();
      },
      spawnSync: () => ({ status: 0, stdout: "garbage-auth", stderr: "", error: undefined }),
    }), /logged-in|Log in/);
    assert.equal(assignments, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const inputHarnesses: Array<{
  harness: string;
  role: string;
  model: string;
  permission: string;
  auth: () => Record<string, unknown>;
  assignment: { stdout: string };
}> = [
  {
    harness: "agy",
    role: "writer",
    model: "gemini-3.8-flash-low",
    permission: "edit",
    auth: agyAuth,
    assignment: {
      stdout: `${JSON.stringify({
        conversation_id: "agy-rel",
        status: "SUCCESS",
        response: "ok",
        usage: { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 },
      })}\n`,
    },
  },
  {
    harness: "grok",
    role: "writer",
    model: "grok-4.6",
    permission: "edit",
    auth: grokAuth,
    assignment: {
      stdout: `${JSON.stringify({ result: "ok", modelUsage: { "grok-4.6-build": { inputTokens: 1, outputTokens: 1 } } })}\n`,
    },
  },
  {
    harness: "claude",
    role: "planner",
    model: "fable",
    permission: "read-only",
    auth: claudeAuth,
    assignment: { stdout: `${JSON.stringify(claudeFablePayload)}\n` },
  },
  {
    harness: "codex",
    role: "reviewer-cli",
    model: "gpt-5.6-sol",
    permission: "read-only",
    auth: codexAuth,
    assignment: {
      stdout: [
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "review notes" } }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 4, output_tokens: 6 } }),
      ].join("\n"),
    },
  },
  {
    harness: "pi",
    role: "experiment",
    model: "openrouter/nous-research/deephermes-3-mistral-24b-preview",
    permission: "read-only",
    auth: piAuth,
    assignment: {
      stdout: [
        piLine({ type: "session", id: "s" }),
        piLine(piAssistantEnd()),
      ].join(""),
    },
  },
];

test("missing brief fails closed before any spawn for each harness", async () => {
  const dir = tempDir();
  try {
    const missing = join(dir, "no-such-brief.md");
    for (const spec of inputHarnesses) {
      const spawnSyncCalls: unknown[] = [];
      const spawnCalls: unknown[] = [];
      await assert.rejects(() => runHarness({
        schema: REQUEST_SCHEMA,
        harness: spec.harness,
        role: spec.role,
        model: spec.model,
        permission: spec.permission,
        prompt_file: missing,
        output_dir: join(dir, `out-${spec.harness}`),
      } as never, {
        existsSync: () => true,
        spawnSync: (...args: unknown[]) => {
          spawnSyncCalls.push(args);
          return spec.auth();
        },
        spawn: (...args: unknown[]) => {
          spawnCalls.push(args);
          return fakeChild();
        },
      }), /prompt_file is missing or unreadable/);
      assert.equal(spawnSyncCalls.length, 0, spec.harness);
      assert.equal(spawnCalls.length, 0, spec.harness);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing schema fails closed before any spawn for each harness", async () => {
  const dir = tempDir();
  try {
    const prompt = promptFile(dir);
    const missing = join(dir, "no-such-schema.json");
    for (const spec of inputHarnesses) {
      const spawnSyncCalls: unknown[] = [];
      const spawnCalls: unknown[] = [];
      await assert.rejects(() => runHarness({
        schema: REQUEST_SCHEMA,
        harness: spec.harness,
        role: spec.role,
        model: spec.model,
        permission: spec.permission,
        prompt_file: prompt,
        output_schema: missing,
        output_dir: join(dir, `out-${spec.harness}`),
      } as never, {
        existsSync: () => true,
        spawnSync: (...args: unknown[]) => {
          spawnSyncCalls.push(args);
          return spec.auth();
        },
        spawn: (...args: unknown[]) => {
          spawnCalls.push(args);
          return fakeChild();
        },
      }), /output_schema is missing or unreadable/);
      assert.equal(spawnSyncCalls.length, 0, spec.harness);
      assert.equal(spawnCalls.length, 0, spec.harness);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("relative prompt and schema resolve from invocation cwd, not request.cwd", async () => {
  const invokeDir = tempDir();
  const agentDir = tempDir();
  const previous = process.cwd();
  const briefBody = "brief from invocation cwd";
  const schemaBody = JSON.stringify({ type: "object", additionalProperties: false });
  try {
    writeFileSync(join(invokeDir, "brief.md"), briefBody);
    writeFileSync(join(invokeDir, "schema.json"), schemaBody);
    process.chdir(invokeDir);
    const invocationCwd = process.cwd();
    const expectedPrompt = resolve(invocationCwd, "brief.md");
    const expectedSchema = resolve(invocationCwd, "schema.json");
    for (const spec of inputHarnesses) {
      let stdinText = "";
      const spawns: Array<{ argv: string[] }> = [];
      await runHarness({
        schema: REQUEST_SCHEMA,
        harness: spec.harness,
        role: spec.role,
        model: spec.model,
        permission: spec.permission,
        prompt_file: "brief.md",
        output_schema: "schema.json",
        cwd: agentDir,
        output_dir: join(agentDir, `out-${spec.harness}`),
      } as never, {
        platform: process.platform,
        env: { PATH: "/tmp/kxm-harness-bin" },
        existsSync: (path: string) => String(path).includes(spec.harness),
        spawnSync: () => spec.auth(),
        spawn: (_command: string, argv: string[]) => {
          const child = fakeChild(spec.assignment);
          const write = child.stdin.write.bind(child.stdin);
          child.stdin.write = ((chunk: string | Buffer, ...rest: unknown[]) => {
            stdinText += String(chunk);
            return write(chunk, ...rest as []);
          }) as typeof child.stdin.write;
          spawns.push({ argv });
          return child;
        },
        observedAt: "2026-09-05",
        now: () => 1_000,
      });
      assert.equal(spawns.length, 1, spec.harness);
      const argv = spawns[0]?.argv ?? [];
      if (spec.harness === "agy") {
        assert.equal(argv[argv.indexOf("-p") + 1], briefBody, spec.harness);
        assert(!argv.includes("--prompt-file"), spec.harness);
        assert.equal(stdinText, "", spec.harness);
        const schemaAt = argv.indexOf("--json-schema");
        assert.notEqual(schemaAt, -1, spec.harness);
        assert.equal(argv[schemaAt + 1], expectedSchema, spec.harness);
      }
      if (spec.harness === "grok" || spec.harness === "pi") {
        const promptToken = spec.harness === "grok"
          ? argv[argv.indexOf("--prompt-file") + 1]
          : argv.find((token) => token.startsWith("@"));
        const promptPath = spec.harness === "grok" ? promptToken : String(promptToken).slice(1);
        assert.equal(promptPath, expectedPrompt, spec.harness);
        assert.ok(String(promptPath).startsWith(invocationCwd), spec.harness);
      }
      if (spec.harness === "grok" || spec.harness === "claude") {
        const schemaAt = argv.indexOf("--json-schema");
        assert.notEqual(schemaAt, -1, spec.harness);
        assert.equal(argv[schemaAt + 1], schemaBody, spec.harness);
      }
      if (spec.harness === "codex") {
        const schemaAt = argv.indexOf("--output-schema");
        assert.notEqual(schemaAt, -1);
        assert.equal(argv[schemaAt + 1], expectedSchema);
        assert.ok(argv[schemaAt + 1]?.startsWith(invocationCwd));
      }
      if (spec.harness === "claude" || spec.harness === "codex") {
        assert.equal(stdinText, briefBody, spec.harness);
      }
    }
  } finally {
    process.chdir(previous);
    rmSync(invokeDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("CLI unknown/unverified harness exits 2 without PATH binaries", () => {
  const dir = tempDir();
  try {
    const prompt = promptFile(dir);
    const ran = spawnSync(process.execPath, [helper], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      input: JSON.stringify({
        schema: REQUEST_SCHEMA,
        harness: "kimi",
        role: "writer",
        model: "kimi",
        permission: "edit",
        prompt_file: prompt,
      }),
    });
    assert.equal(ran.status, 2);
    const payload = JSON.parse(ran.stdout) as { ok: boolean; error: string; schema: string };
    assert.equal(payload.schema, RESULT_SCHEMA);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /unverified/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codex JSONL maps usage and stays unmetered under ChatGPT auth", () => {
  const fields = normalizeCodex([
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "review notes" } }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 4, output_tokens: 6, cached_input_tokens: 1, cache_write_input_tokens: 2 },
    }),
  ].join("\n"));
  assert.equal(fields.text, "review notes");
  assert.equal(fields.tokensIn, 4);
  assert.equal(fields.tokensOut, 6);
  assert.equal(fields.costBasis, "unmetered");
  assert.equal(fields.contextTokens, undefined);
});

test("justfile no longer ships an impl-pi Grok fallback", () => {
  const just = readFileSync(resolve("justfile"), "utf8");
  assert.doesNotMatch(just, /impl-pi/);
  assert.doesNotMatch(just, /xai\/grok-4\.6/);
});

test("just transport recipes use evidence-informed effort defaults without retired assignment transport", () => {
  const just = readFileSync(resolve("justfile"), "utf8");
  assert.match(just, /role:"writer",harness:"grok",model:"grok-4\.6",effort:"medium"/);
  assert.match(just, /role:"planner",harness:"claude",model:"fable",effort:"medium"/);
  assert.match(just, /role:"reviewer-arch",harness:"claude",model:"fable",effort:"medium"/);
  assert.match(just, /role:"reviewer-cli",harness:"codex",model:"gpt-5\.6-sol",effort:"low"/);
  assert.doesNotMatch(just, /effort:"high"/);
  assert.doesNotMatch(just, /Normal assignment workflow/);
  assert.doesNotMatch(just, /assignment-run\.mjs/);
});

test("preflight requires routing fields, types, and Pi edit pair ceilings before spawn", async () => {
  const dir = tempDir();
  try {
    const prompt = promptFile(dir);
    const base = {
      schema: REQUEST_SCHEMA,
      harness: "grok",
      role: "writer",
      model: "grok-4.6",
      permission: "edit",
      prompt_file: prompt,
    };
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...base, role: undefined }, /role is required/],
      [{ ...base, model: undefined }, /model is required/],
      [{ ...base, permission: undefined }, /permission is required/],
      [{ ...base, harness: undefined }, /harness is required/],
      [{ ...base, prompt_file: undefined }, /prompt_file is required/],
      [{ ...base, role: "" }, /role is required/],
      [{ ...base, model: 1 }, /model is required/],
      [{ ...base, permission: true }, /permission is required/],
      [{ ...base, cwd: 1 }, /cwd must be a nonempty string/],
      [{ ...base, hooks: "false" }, /hooks must be a boolean/],
      [{ ...base, skills: true }, /skills must be an array/],
      [{ ...base, hooks: false }, /does not accept hooks\/skills/],
      [{ ...base, timeout_ms: 0 }, /timeout_ms must be a positive finite number/],
      [{ ...base, timeout_ms: Number.NaN }, /timeout_ms must be a positive finite number/],
      [{ ...base, timeout_ms: "5" }, /timeout_ms must be a positive finite number/],
      [{
        schema: REQUEST_SCHEMA,
        harness: "claude",
        role: "planner",
        model: "fable",
        permission: "read-only",
        prompt_file: prompt,
        max_cost_usd: 0,
      }, /max_cost_usd must be a positive finite number/],
      [{
        schema: REQUEST_SCHEMA,
        harness: "claude",
        role: "planner",
        model: "fable",
        permission: "read-only",
        prompt_file: prompt,
        max_cost_usd: -1,
      }, /max_cost_usd must be a positive finite number/],
      [{
        schema: REQUEST_SCHEMA,
        harness: "pi",
        role: "planner",
        model: "openrouter/nous",
        permission: "edit",
        prompt_file: prompt,
      }, /cannot edit; only experiment/],
      [{
        schema: REQUEST_SCHEMA,
        harness: "pi",
        role: "reviewer-arch",
        model: "openrouter/nous",
        permission: "edit",
        prompt_file: prompt,
      }, /cannot edit; only experiment/],
      [{
        schema: REQUEST_SCHEMA,
        harness: "pi",
        role: "reviewer-cli",
        model: "openrouter/nous",
        permission: "edit",
        prompt_file: prompt,
      }, /cannot edit; only experiment/],
    ];
    let spawned = 0;
    for (const [request, pattern] of cases) {
      await assert.rejects(
        () => runHarness(request as never, {
          spawn: () => {
            spawned += 1;
            return fakeChild();
          },
          spawnSync: () => {
            spawned += 1;
            return grokAuth();
          },
        }),
        pattern,
      );
    }
    assert.equal(spawned, 0);
    preflightRequest({
      schema: REQUEST_SCHEMA,
      harness: "pi",
      role: "experiment",
      model: "openrouter/nous",
      permission: "edit",
      prompt_file: prompt,
    });
    preflightRequest({
      schema: REQUEST_SCHEMA,
      harness: "claude",
      role: "planner",
      model: "fable",
      permission: "read-only",
      prompt_file: prompt,
      hooks: false,
      skills: [],
      max_cost_usd: 1.25,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claude max_cost_usd is forwarded; zero is not dropped", () => {
  const argv = buildArgv({
    harness: "claude",
    model: "fable",
    effort: "high",
    permission: "read-only",
    prompt_file: "/tmp/brief.md",
    max_cost_usd: 1.25,
  }, { mcpConfigPath: "/tmp/mcp-empty.json" });
  const budgetAt = argv.indexOf("--max-budget-usd");
  assert.notEqual(budgetAt, -1);
  assert.equal(argv[budgetAt + 1], "1.25");
});

test("pi read-only argv uses verified disable flags; experiment edit may auto-approve", () => {
  const readOnly = buildArgv({
    harness: "pi",
    model: "openrouter/nous",
    effort: "low",
    permission: "read-only",
    prompt_file: "/tmp/brief.md",
    hooks: false,
  });
  assert(readOnly.includes("--tools"));
  assert(readOnly.includes("read,grep,find,ls"));
  assert(readOnly.includes("--no-extensions"));
  assert(readOnly.includes("--no-skills"));
  assert(readOnly.includes("--no-prompt-templates"));
  assert(!readOnly.includes("-a"));
  const edit = buildArgv({
    harness: "pi",
    model: "openrouter/nous",
    permission: "edit",
    prompt_file: "/tmp/brief.md",
    hooks: false,
    skills: [],
  });
  assert(edit.includes("-a"));
  assert(edit.includes("--no-extensions"));
  assert(edit.includes("--no-skills"));
});

test("formatRunCost never treats absent cost as zero", () => {
  assert.equal(formatRunCost({ costBasis: "unmetered", providerReportedCostUsd: 2.7499 }), "unmetered");
  assert.equal(formatRunCost({ costBasis: "list", costUsd: 0.08 }), "list $0.0800");
  assert.equal(formatRunCost({ costBasis: "billed", costUsd: 1.5 }), "billed $1.5000");
  assert.equal(formatRunCost({ costBasis: "unknown" }), "unknown");
  assert.equal(formatRunCost({}), "unknown");
  assert.equal(formatRunCost({ costBasis: "list" }), "unknown");
  assert.equal(formatRunCost({ costBasis: "provider-reported", providerReportedCostUsd: 0.1 }), "provider-reported $0.1000");
});

const captureBin = resolve("test/fixtures/harness/capture-dispatch.mjs");
const justfileText = readFileSync(resolve("justfile"), "utf8");
const posixShell = process.platform !== "win32";
const justAvailable = spawnSync("just", ["--version"], { encoding: "utf8" }).status === 0;

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function recipeLines(name: string): string[] {
  const lines = justfileText.split("\n");
  const header = new RegExp(`^${name}(?:\\s|:|$)`);
  const start = lines.findIndex((line) => header.test(line));
  assert.ok(start >= 0, `missing just recipe ${name}`);
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.length === 0) continue;
    if (!/^[ \t]/.test(line)) break;
    body.push(line.replace(/^[ \t]+@?/, ""));
  }
  assert.ok(body.length > 0, `empty just recipe ${name}`);
  return body;
}

function firstRecipeLine(name: string): string {
  const line = recipeLines(name)[0];
  assert.ok(line, `missing first line for just recipe ${name}`);
  return line;
}

function substituteRun(body: string): string {
  assert.match(body, /\{\{run\}\}/);
  return body.replaceAll("{{run}}", `${shQuote(process.execPath)} ${shQuote(captureBin)}`);
}

function extractNodeEval(body: string): string {
  const source = body.match(/node -e '([^']*)'/)?.[1];
  assert.ok(source, `recipe is missing node -e: ${body}`);
  return source;
}

function spawnPosixRecipe(script: string, positional: string[], extra: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
} = {}) {
  return spawnSync("sh", ["-c", script, "just-recipe", ...positional], {
    encoding: "utf8",
    env: extra.env ?? process.env,
    cwd: extra.cwd ?? process.cwd(),
  });
}

function waitForFile(path: string, timeoutMs = 2000): void {
  const start = Date.now();
  const slot = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(path) && Date.now() - start < timeoutMs) {
    Atomics.wait(slot, 0, 0, 50);
  }
}

function readCapture(capturePath: string): { argv: string[]; stdin: string } {
  return JSON.parse(readFileSync(capturePath, "utf8")) as { argv: string[]; stdin: string };
}

function assertPromptEnvelope(raw: string, promptFile: string, cwd: string): void {
  const envelope = JSON.parse(raw) as { prompt_file: string; cwd: string; schema: string };
  assert.equal(envelope.schema, REQUEST_SCHEMA);
  assert.equal(envelope.prompt_file, promptFile);
  assert.equal(envelope.cwd, cwd);
}

test("just recipes transport user paths without interpolating them as shell or JSON source", () => {
  const dir = tempDir();
  const capturePath = join(dir, "capture.json");
  const captureEnv = { ...process.env, KXM_CAPTURE: capturePath };
  const brief = `a"b\\c $d.md`;
  const cwd = "cwd; rm -rf / && echo `oops` | cat";
  const winMeta = "a b%c^d&e.md";
  const newlineBrief = "line1\nline2.md";
  const dashBrief = "-n.md";
  const requestPath = `req"uest.json`;
  try {
    const recipes = ["impl", "plan", "review-arch", "review-cli"] as const;
    for (const recipe of recipes) {
      const line = firstRecipeLine(recipe);
      assert.match(line, /-- "\$1" "\$2" \| \{\{run\}\} -/);
      const cases: Array<[string, string]> = [
        [brief, cwd],
        [winMeta, cwd],
        [newlineBrief, "."],
        [dashBrief, "."],
      ];
      for (const [promptFile, cwdArg] of cases) {
        if (posixShell) {
          const ran = spawnPosixRecipe(substituteRun(line), [promptFile, cwdArg], { env: captureEnv });
          assert.equal(ran.status, 0, `${recipe}: ${ran.stderr}\n${ran.stdout}`);
          const captured = readCapture(capturePath);
          assert.deepEqual(captured.argv, ["-"]);
          assertPromptEnvelope(captured.stdin, promptFile, cwdArg);
          continue;
        }
        const evaled = spawnSync(process.execPath, ["-e", extractNodeEval(line), "--", promptFile, cwdArg], {
          encoding: "utf8",
        });
        assert.equal(evaled.status, 0, `${recipe} node -e: ${evaled.stderr}`);
        assertPromptEnvelope(evaled.stdout, promptFile, cwdArg);
        const piped = spawnSync(process.execPath, [captureBin, "-"], {
          encoding: "utf8",
          input: evaled.stdout,
          env: captureEnv,
        });
        assert.equal(piped.status, 0, piped.stderr);
        const captured = readCapture(capturePath);
        assert.deepEqual(captured.argv, ["-"]);
        assertPromptEnvelope(captured.stdin, promptFile, cwdArg);
      }
    }

    const dispatchLine = firstRecipeLine("dispatch");
    assert.match(dispatchLine, /\{\{run\}\} -- "\$1"/);
    if (posixShell) {
      const dispatch = spawnPosixRecipe(substituteRun(dispatchLine), [requestPath], { env: captureEnv });
      assert.equal(dispatch.status, 0, dispatch.stderr);
    } else {
      const dispatch = spawnSync(process.execPath, [captureBin, "--", requestPath], {
        encoding: "utf8",
        env: captureEnv,
      });
      assert.equal(dispatch.status, 0, dispatch.stderr);
    }
    assert.deepEqual(readCapture(capturePath).argv, ["--", requestPath]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("just impl-bg and worktree pass user args as positional argv, not interpolated source", (t) => {
  const bg = recipeLines("impl-bg").join("\n");
  const wt = recipeLines("worktree").join("\n");
  const drop = recipeLines("worktree-drop").join("\n");
  assert.match(bg, /just impl "\$1" "\$2"/);
  assert.match(wt, /git worktree add -b "\$1" -- "\.\.\/kxm-\$1"/);
  assert.match(drop, /git worktree remove -- "\.\.\/kxm-\$1"/);
  if (!posixShell) {
    t.skip("POSIX shebang PATH mocks, nohup, and git recipe bodies are scoped off win32");
    return;
  }
  const dir = tempDir();
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const justCapture = join(dir, "just-argv.txt");
  const gitCapture = join(dir, "git-argv.txt");
  writeFileSync(join(bin, "just"), `#!/bin/sh\nprintf '%s\\n' "$@" > "$KXM_JUST_CAPTURE"\n`);
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$@" > "$KXM_GIT_CAPTURE"\n`);
  chmodSync(join(bin, "just"), 0o755);
  chmodSync(join(bin, "git"), 0o755);
  const unit = `a"b $c; rm -rf -- --dash`;
  const brief = `brief"q.md`;
  const cwdArg = `tree\\path`;
  const mockEnv = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
  };
  try {
    const bgRan = spawnPosixRecipe(bg, [brief, cwdArg], {
      env: { ...mockEnv, KXM_JUST_CAPTURE: justCapture },
      cwd: dir,
    });
    assert.equal(bgRan.status, 0, bgRan.stderr);
    waitForFile(justCapture);
    const justArgv = readFileSync(justCapture, "utf8").trim().split("\n");
    assert.deepEqual(justArgv, ["impl", brief, cwdArg]);

    const wtRan = spawnPosixRecipe(wt, [unit], {
      env: { ...mockEnv, KXM_GIT_CAPTURE: gitCapture },
      cwd: dir,
    });
    assert.equal(wtRan.status, 0, wtRan.stderr);
    const gitArgv = readFileSync(gitCapture, "utf8").trim().split("\n");
    assert.equal(gitArgv[0], "worktree");
    assert.equal(gitArgv[1], "add");
    assert.equal(gitArgv[2], "-b");
    assert.equal(gitArgv[3], unit);
    assert.equal(gitArgv[4], "--");
    assert.equal(gitArgv[5], `../kxm-${unit}`);
    assert.equal(gitArgv[6], "origin/main");

    const dropRan = spawnPosixRecipe(drop, [unit], {
      env: { ...mockEnv, KXM_GIT_CAPTURE: gitCapture },
      cwd: dir,
    });
    assert.equal(dropRan.status, 0, dropRan.stderr);
    const dropArgv = readFileSync(gitCapture, "utf8").trim().split("\n");
    assert.deepEqual(dropArgv, ["worktree", "remove", "--", `../kxm-${unit}`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("just runs displays billed, list, unmetered, and unknown — never absent cost as $0", () => {
  const nodeEval = extractNodeEval(recipeLines("runs").join("\n"));
  const rows = [
    { schema: RESULT_SCHEMA, ok: true, harness: "claude", effectiveModel: "claude-fable-5-1", latencyMs: 10, costBasis: "unmetered", providerReportedCostUsd: 2.7499 },
    { schema: RESULT_SCHEMA, ok: true, harness: "pi", effectiveModel: "openrouter/nous", latencyMs: 11, costBasis: "list", costUsd: 0.08 },
    { schema: RESULT_SCHEMA, ok: true, harness: "pi", effectiveModel: "openrouter/nous", latencyMs: 12, costBasis: "billed", costUsd: 1.5 },
    { schema: RESULT_SCHEMA, ok: true, harness: "grok", effectiveModel: "grok-4.6-build", latencyMs: 13, costBasis: "unknown" },
    { schema: RESULT_SCHEMA, ok: false, harness: "grok", effectiveModel: "grok-4.6-build", latencyMs: 14 },
    { schema: "kxm.harness-result.v1", ok: true, harness: "grok", finalOutcome: "passed", costUsd: 0.1 },
  ];
  const stdout = rows.map((body) => {
    const ran = spawnSync(process.execPath, ["-e", nodeEval], {
      encoding: "utf8",
      input: `${JSON.stringify(body)}\n`,
    });
    assert.equal(ran.status, 0, ran.stderr);
    return ran.stdout;
  }).join("");
  assert.match(stdout, /unmetered/);
  assert.match(stdout, /list \$0\.0800/);
  assert.match(stdout, /billed \$1\.5000/);
  assert.match(stdout, /unknown/);
  assert.match(stdout, /obsolete result schema kxm\.harness-result\.v1/);
  assert.doesNotMatch(stdout, /\$0\.0000/);
});

test("capability fixtures record help hashes and Codex parser evidence without inventing top-level help", () => {
  const capDir = resolve("test/fixtures/harness/capabilities");
  const manifest = JSON.parse(readFileSync(join(capDir, "manifest.json"), "utf8")) as {
    helpFiles: Record<string, string>;
    grokHelpFlags: string[];
    codexIgnoreUserConfig: {
      topLevelHelpPresent: boolean;
      execHelpPresent: boolean;
      parserProbe: { command: string[]; exitCode: number };
    };
  };
  for (const [name, expected] of Object.entries(manifest.helpFiles)) {
    const digest = createHash("sha256").update(readFileSync(join(capDir, name))).digest("hex");
    assert.equal(digest, expected, name);
  }
  const grokHelp = readFileSync(join(capDir, "grok-help.txt"), "utf8");
  for (const flag of manifest.grokHelpFlags) {
    assert.match(grokHelp, new RegExp(flag.replace(/-/g, "\\-")));
  }
  const top = readFileSync(join(capDir, "codex-help.txt"), "utf8");
  const execHelp = readFileSync(join(capDir, "codex-exec-help.txt"), "utf8");
  assert.equal(manifest.codexIgnoreUserConfig.topLevelHelpPresent, false);
  assert.doesNotMatch(top, /--ignore-user-config/);
  assert.equal(manifest.codexIgnoreUserConfig.execHelpPresent, execHelp.includes("--ignore-user-config"));
  assert.deepEqual(manifest.codexIgnoreUserConfig.parserProbe.command, [
    "codex", "exec", "--ignore-user-config", "--help",
  ]);
  assert.equal(manifest.codexIgnoreUserConfig.parserProbe.exitCode, 0);
});

test("grok argv adds isolation flags and optional max_turns; other harnesses refuse max_turns before spawn", async () => {
  const grok = buildArgv({
    harness: "grok",
    model: "grok-4.6",
    effort: "high",
    permission: "edit",
    prompt_file: "/tmp/brief.md",
    max_turns: 70,
  });
  assert(grok.includes("--always-approve"));
  assert(grok.includes("--no-subagents"));
  assert(grok.includes("--disable-web-search"));
  const maxAt = grok.indexOf("--max-turns");
  assert.notEqual(maxAt, -1);
  assert.equal(grok[maxAt + 1], "70");
  const grokDefault = buildArgv({
    harness: "grok",
    model: "grok-4.6",
    permission: "edit",
    prompt_file: "/tmp/brief.md",
  });
  assert(!grokDefault.includes("--max-turns"));
  const dir = tempDir();
  try {
    const prompt = promptFile(dir);
    const refusals: Array<[Record<string, unknown>, RegExp]> = [
      [{
        schema: REQUEST_SCHEMA,
        harness: "claude",
        role: "planner",
        model: "fable",
        permission: "read-only",
        prompt_file: prompt,
        max_turns: 3,
      }, /max_turns/],
      [{
        schema: REQUEST_SCHEMA,
        harness: "codex",
        role: "reviewer-cli",
        model: "gpt-5.6-sol",
        permission: "read-only",
        prompt_file: prompt,
        max_turns: 3,
      }, /max_turns/],
      [{
        schema: REQUEST_SCHEMA,
        harness: "grok",
        role: "writer",
        model: "grok-4.6",
        permission: "edit",
        prompt_file: prompt,
        max_turns: 0,
      }, /max_turns/],
      [{
        schema: REQUEST_SCHEMA,
        harness: "grok",
        role: "writer",
        model: "grok-4.6",
        permission: "edit",
        prompt_file: prompt,
        max_turns: 1.5,
      }, /max_turns/],
    ];
    let spawned = 0;
    for (const [request, pattern] of refusals) {
      await assert.rejects(() => runHarness(request as never, {
        spawn: () => {
          spawned += 1;
          return fakeChild();
        },
        spawnSync: () => {
          spawned += 1;
          return grokAuth();
        },
      }), pattern);
    }
    assert.equal(spawned, 0);
    preflightRequest({
      schema: REQUEST_SCHEMA,
      harness: "grok",
      role: "writer",
      model: "grok-4.6",
      permission: "edit",
      prompt_file: prompt,
      max_turns: 70,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codex argv includes --ignore-user-config from parser evidence, not top-level help", () => {
  const argv = buildArgv({
    harness: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    permission: "read-only",
    prompt_file: "/tmp/brief.md",
  });
  assert(argv.includes("--ignore-user-config"));
  const top = readFileSync(resolve("test/fixtures/harness/capabilities/codex-help.txt"), "utf8");
  assert.doesNotMatch(top, /--ignore-user-config/);
});

test("result v2 has no helper finalOutcome or agent; grok total_cost_usd is provider-reported", async () => {
  assert.equal(RESULT_SCHEMA, "kxm.harness-result.v2");
  const dir = tempDir();
  try {
    const prompt = promptFile(dir);
    const { result } = await dispatch({
      schema: REQUEST_SCHEMA,
      harness: "grok",
      role: "writer",
      model: "grok-4.6",
      permission: "edit",
      prompt_file: prompt,
      output_dir: join(dir, "out"),
    }, {
      stdout: `${JSON.stringify({
        result: "ok",
        modelUsage: { "grok-4.6-build": { inputTokens: 9, outputTokens: 3 } },
        total_cost_usd: 0.1,
      })}\n`,
    });
    assert.equal(result.schema, "kxm.harness-result.v2");
    assert.equal(result.finalOutcome, undefined);
    assert.equal(result.agent, undefined);
    assert.equal(result.status, "completed");
    assert.equal(result.stage, "run");
    assert.equal(result.costBasis, "provider-reported");
    assert.equal(result.costUsd, 0.1);
    assert.equal(result.providerReportedCostUsd, 0.1);
    assert.notEqual(result.costBasis, "billed");
    assert.equal(result.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writes dispatch.json before spawn, amends pid, and keeps prompt/argv out of metadata", async () => {
  const dir = tempDir();
  const outputDir = join(dir, "out");
  const sentinel = "PROMPT-SENTINEL-not-in-dispatch-or-result-meta";
  try {
    const prompt = promptFile(dir, sentinel);
    let seenAtSpawn: Record<string, unknown> | undefined;
    const result = await runHarness({
      schema: REQUEST_SCHEMA,
      harness: "grok",
      role: "writer",
      model: "grok-4.6",
      permission: "edit",
      prompt_file: prompt,
      output_dir: outputDir,
    } as never, {
      platform: process.platform,
      env: { PATH: "/tmp/kxm-harness-bin" },
      existsSync: (path: string) => String(path).includes("grok"),
      spawnSync: () => grokAuth(),
      spawn: () => {
        seenAtSpawn = JSON.parse(readFileSync(join(outputDir, "dispatch.json"), "utf8")) as Record<string, unknown>;
        const child = fakeChild({
          stdout: `${JSON.stringify({
            result: "ok",
            modelUsage: { "grok-4.6-build": { inputTokens: 1, outputTokens: 1 } },
          })}\n`,
        });
        (child as { pid?: number }).pid = 4242;
        return child;
      },
      observedAt: "2026-09-05",
      now: () => 1_000,
    });
    assert.equal(seenAtSpawn?.pid, null);
    assert.equal(typeof seenAtSpawn?.requestHash, "string");
    assert.equal(typeof seenAtSpawn?.timestamp, "string");
    assert.equal(seenAtSpawn?.command, "grok");
    const spawnDump = JSON.stringify(seenAtSpawn);
    assert.doesNotMatch(spawnDump, /PROMPT-SENTINEL/);
    assert.doesNotMatch(spawnDump, /--prompt-file|--always-approve|--max-turns/);
    const after = JSON.parse(readFileSync(join(outputDir, "dispatch.json"), "utf8")) as { pid: number };
    assert.equal(after.pid, 4242);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /PROMPT-SENTINEL/);
    assert.equal(result.argv, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timeout interruption records timedOut without completed or process-dead claims", async () => {
  const dir = tempDir();
  try {
    const prompt = promptFile(dir);
    const kills: string[] = [];
    const result = await runHarness({
      schema: REQUEST_SCHEMA,
      harness: "grok",
      role: "writer",
      model: "grok-4.6",
      permission: "edit",
      prompt_file: prompt,
      timeout_ms: 5,
      output_dir: join(dir, "out"),
    } as never, {
      platform: process.platform,
      env: { PATH: "/tmp/kxm-harness-bin" },
      existsSync: (path: string) => String(path).includes("grok"),
      spawnSync: () => grokAuth(),
      killGraceMs: 15,
      spawn: () => {
        const child = fakeChild({ hang: true });
        (child as { pid?: number }).pid = 7;
        child.kill = (signal?: string) => {
          kills.push(String(signal));
          if (signal === "SIGKILL") {
            child.stdout.end();
            child.stderr.end();
            child.emit("exit", null, signal);
            child.emit("close", null, signal);
          }
          return true;
        };
        return child;
      },
      observedAt: "2026-09-05",
      now: () => 1_000,
    });
    assert.equal(result.status, "interrupted");
    assert.equal(result.timedOut, true);
    assert.notEqual(result.status, "completed");
    assert.equal(result.ok, false);
    assert.equal(result.processDead, undefined);
    assert.equal(result.childDied, undefined);
    assert.deepEqual(kills, ["SIGTERM", "SIGKILL"]);
    assert.equal(result.observedChildExit, true);
    assert.equal((result.killRequest as { signal?: string } | undefined)?.signal, "SIGKILL");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed and interrupted runs keep partial usage and do not invent zeros", async () => {
  const dir = tempDir();
  try {
    const prompt = promptFile(dir);
    const failed = await dispatch({
      schema: REQUEST_SCHEMA,
      harness: "grok",
      role: "writer",
      model: "grok-4.6",
      permission: "edit",
      prompt_file: prompt,
      output_dir: join(dir, "fail"),
    }, {
      stdout: `${JSON.stringify({
        result: "boom",
        is_error: true,
        total_cost_usd: 0.04,
        modelUsage: { "grok-4.6-build": { inputTokens: 11, outputTokens: 2 } },
      })}\n`,
      exitCode: 0,
    });
    assert.equal(failed.result.status, "failed");
    assert.equal(failed.result.tokensIn, 11);
    assert.equal(failed.result.tokensOut, 2);
    assert.equal(failed.result.usagePartial, true);
    assert.equal(failed.result.costBasis, "provider-reported");
    assert.equal(failed.result.cacheReadTokens, undefined);
    assert.notEqual(failed.result.cacheReadTokens, 0);

    const kills: string[] = [];
    const interrupted = await runHarness({
      schema: REQUEST_SCHEMA,
      harness: "grok",
      role: "writer",
      model: "grok-4.6",
      permission: "edit",
      prompt_file: prompt,
      timeout_ms: 5,
      output_dir: join(dir, "int"),
    } as never, {
      platform: process.platform,
      env: { PATH: "/tmp/kxm-harness-bin" },
      existsSync: (path: string) => String(path).includes("grok"),
      spawnSync: () => grokAuth(),
      killGraceMs: 15,
      spawn: () => {
        const child = fakeChild({ hang: true });
        child.kill = (signal?: string) => {
          kills.push(String(signal));
          if (signal === "SIGTERM") {
            child.stdout.write(`${JSON.stringify({
              result: "partial",
              total_cost_usd: 0.02,
              modelUsage: { "grok-4.6-build": { inputTokens: 8, outputTokens: 1 } },
            })}\n`);
          }
          if (signal === "SIGKILL") {
            child.stdout.end();
            child.stderr.end();
            child.emit("exit", null, signal);
            child.emit("close", null, signal);
          }
          return true;
        };
        return child;
      },
      observedAt: "2026-09-05",
      now: () => 1_000,
    });
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.timedOut, true);
    assert.equal(interrupted.tokensIn, 8);
    assert.equal(interrupted.usagePartial, true);
    assert.equal(interrupted.reasoningTokens, undefined);
    assert.notEqual(interrupted.reasoningTokens, 0);
    assert.ok(kills.includes("SIGTERM"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("closed model claims cannot override transport or leak free-text sentinels", async () => {
  const dir = tempDir();
  const sentinel = "CLAIM-SECRET-SENTINEL-do-not-serialize";
  try {
    const prompt = promptFile(dir);
    const envelope = {
      status: "fail",
      summary: sentinel,
      notes_for_next_agent: sentinel,
      artifacts: ["a.ts", "b.ts"],
      completed: ["one"],
      deferred: ["two"],
      verification: { gate: "verify", passed: true },
      acceptance: { accepted: true },
      finalOutcome: "passed",
      critic: { verdict: "PASS" },
      verdict: "PASS",
      role: "writer",
      usage: { tokensIn: 0 },
      cost: { costUsd: 0 },
      transport: { status: "completed" },
    };
    const writer = await dispatch({
      schema: REQUEST_SCHEMA,
      harness: "grok",
      role: "writer",
      model: "grok-4.6",
      permission: "edit",
      prompt_file: prompt,
      output_dir: join(dir, "writer"),
    }, {
      stdout: `${JSON.stringify({
        result: JSON.stringify(envelope),
        is_error: false,
        modelUsage: { "grok-4.6-build": { inputTokens: 4, outputTokens: 4 } },
      })}\n`,
    });
    const serialized = JSON.stringify(writer.result);
    assert.doesNotMatch(serialized, /CLAIM-SECRET-SENTINEL/);
    assert.equal(writer.result.status, "completed");
    assert.equal(writer.result.ok, true);
    assert.equal(writer.result.finalOutcome, undefined);
    const claim = writer.result.modelClaim as Record<string, unknown>;
    assert.equal(claim.status, "fail");
    assert.equal(claim.verdict, undefined);
    assert.equal(claim.completedCount, 1);
    assert.equal(claim.deferredCount, 1);
    assert.equal(claim.artifactCount, 2);
    assert.ok(Number(claim.unrecognizedCount) >= 6);
    assert.equal(claim.verification, undefined);
    assert.equal(claim.acceptance, undefined);
    assert.equal(claim.summary, undefined);
    assert.ok(claim.path);
    assert.equal(readFileSync(String(claim.path), "utf8").includes(sentinel), true);

    const review = await dispatch({
      schema: REQUEST_SCHEMA,
      harness: "codex",
      role: "reviewer-cli",
      model: "gpt-5.6-sol",
      permission: "read-only",
      prompt_file: prompt,
      output_dir: join(dir, "review"),
    }, {
      stdout: [
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: JSON.stringify({ status: "done", verdict: "PASS", completedCount: 5001 }) },
        }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 4, output_tokens: 6 } }),
      ].join("\n"),
    }, codexAuth());
    const reviewClaim = review.result.modelClaim as Record<string, unknown>;
    assert.equal(reviewClaim.status, "done");
    assert.equal(reviewClaim.verdict, "PASS");
    assert.equal(reviewClaim.completedCount, 1000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("signaled close preserves null exit code and exact signal as interrupted without timeout", async () => {
  const dir = tempDir();
  try {
    const prompt = promptFile(dir);
    const result = await runHarness({
      schema: REQUEST_SCHEMA,
      harness: "grok",
      role: "writer",
      model: "grok-4.6",
      permission: "edit",
      prompt_file: prompt,
      output_dir: join(dir, "out"),
    } as never, {
      platform: process.platform,
      env: { PATH: "/tmp/kxm-harness-bin" },
      existsSync: (path: string) => String(path).includes("grok"),
      spawnSync: () => grokAuth(),
      spawn: () => {
        const child = fakeChild({ hang: true });
        queueMicrotask(() => {
          child.stdout.end();
          child.stderr.end();
          child.emit("exit", null, "SIGTERM");
          child.emit("close", null, "SIGTERM");
        });
        return child;
      },
      observedAt: "2026-09-05",
      now: () => 1_000,
    });
    assert.equal(result.exitCode, null);
    assert.equal(result.signal, "SIGTERM");
    assert.equal(result.status, "interrupted");
    assert.equal(result.timedOut, false);
    assert.equal(result.observedChildExit, true);
    assert.equal(result.ok, false);
    assert.equal(result.killRequest, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("observed exit without stdio close is not missing completion", { timeout: 1500 }, async () => {
  const dir = tempDir();
  try {
    const prompt = promptFile(dir);
    const kills: string[] = [];
    const result = await Promise.race([
      runHarness({
      schema: REQUEST_SCHEMA,
      harness: "grok",
      role: "writer",
      model: "grok-4.6",
      permission: "edit",
      prompt_file: prompt,
      output_dir: join(dir, "out"),
    } as never, {
      platform: process.platform,
      env: { PATH: "/tmp/kxm-harness-bin" },
      existsSync: (path: string) => String(path).includes("grok"),
      spawnSync: () => grokAuth(),
      killGraceMs: 25,
      spawn: () => {
        const child = fakeChild({ hang: true, keepPipesOpen: true });
        child.kill = (signal?: string) => {
          kills.push(String(signal));
          return true;
        };
        queueMicrotask(() => {
          child.stdout.write(`${JSON.stringify({
            result: "drained",
            modelUsage: { "grok-4.6-build": { inputTokens: 3, outputTokens: 1 } },
          })}\n`);
          child.emit("exit", 0, null);
        });
        return child;
      },
      observedAt: "2026-09-05",
      now: () => 1_000,
    }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("helper did not settle after observed exit")), 800);
      }),
    ]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, undefined);
    assert.equal(result.observedChildExit, true);
    assert.equal(result.status, "failed");
    assert.notEqual(result.status, "completed");
    assert.equal(result.errorCode, "stdio_incomplete");
    assert.equal(result.tokensIn, 3);
    assert.equal(result.usagePartial, true);
    assert.deepEqual(kills, []);
    assert.equal(result.processDead, undefined);
    assert.equal(result.childDied, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("valid JSON with exit 0 and unclosed pipes is stdio_incomplete not completed", { timeout: 1500 }, async () => {
  const dir = tempDir();
  try {
    const prompt = promptFile(dir);
    const kills: string[] = [];
    const result = await runHarness({
      schema: REQUEST_SCHEMA,
      harness: "grok",
      role: "writer",
      model: "grok-4.6",
      permission: "edit",
      prompt_file: prompt,
      output_dir: join(dir, "linger-json"),
    } as never, {
      platform: process.platform,
      env: { PATH: "/tmp/kxm-harness-bin" },
      existsSync: (path: string) => String(path).includes("grok"),
      spawnSync: () => grokAuth(),
      killGraceMs: 10,
      spawn: () => {
        const child = fakeChild({ hang: true, keepPipesOpen: true });
        child.kill = (signal?: string) => {
          kills.push(String(signal));
          return true;
        };
        queueMicrotask(() => {
          child.stdout.write(`${JSON.stringify({
            result: "ok",
            total_cost_usd: 0.5,
            usage: { input_tokens: 42, output_tokens: 2 },
          })}`);
          child.emit("exit", 0, null);
        });
        return child;
      },
      observedAt: "2026-09-05",
      now: () => 1_000,
    });
    assert.equal(result.status, "failed");
    assert.notEqual(result.status, "completed");
    assert.equal(result.stage, "run");
    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, undefined);
    assert.equal(result.errorCode, "stdio_incomplete");
    assert.equal(result.observedChildExit, true);
    assert.equal(result.costUsd, 0.5);
    assert.equal(result.tokensIn, 42);
    assert.equal(result.usagePartial, true);
    assert.deepEqual(kills, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("close with null exit and null signal is not completed even with valid JSON", { timeout: 1500 }, async () => {
  const dir = tempDir();
  try {
    const prompt = promptFile(dir);
    const kills: string[] = [];
    const result = await runHarness({
      schema: REQUEST_SCHEMA,
      harness: "grok",
      role: "writer",
      model: "grok-4.6",
      permission: "edit",
      prompt_file: prompt,
      output_dir: join(dir, "null-exit"),
    } as never, {
      platform: process.platform,
      env: { PATH: "/tmp/kxm-harness-bin" },
      existsSync: (path: string) => String(path).includes("grok"),
      spawnSync: () => grokAuth(),
      spawn: () => {
        const child = fakeChild({ hang: true });
        child.kill = (signal?: string) => {
          kills.push(String(signal));
          return true;
        };
        queueMicrotask(() => {
          child.stdout.write(`${JSON.stringify({
            result: "ok",
            total_cost_usd: 0.5,
            usage: { input_tokens: 42, output_tokens: 2 },
          })}`);
          child.stdout.end();
          child.stderr.end();
          child.emit("close", null, null);
        });
        return child;
      },
      observedAt: "2026-09-05",
      now: () => 1_000,
    });
    assert.equal(result.status, "failed");
    assert.notEqual(result.status, "completed");
    assert.equal(result.stage, "run");
    assert.equal(result.exitCode, null);
    assert.equal(result.signal, undefined);
    assert.equal(result.errorCode, "unknown_exit");
    assert.equal(result.observedChildExit, true);
    assert.equal(result.costUsd, 0.5);
    assert.equal(result.tokensIn, 42);
    assert.equal(result.usagePartial, true);
    assert.deepEqual(kills, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timeout records SIGTERM then SIGKILL and can settle without close or descendant-death claims", { timeout: 1500 }, async () => {
  const dir = tempDir();
  try {
    const prompt = promptFile(dir);
    const kills: string[] = [];
    const result = await Promise.race([
      runHarness({
        schema: REQUEST_SCHEMA,
        harness: "grok",
        role: "writer",
        model: "grok-4.6",
        permission: "edit",
        prompt_file: prompt,
        timeout_ms: 5,
        output_dir: join(dir, "out"),
      } as never, {
        platform: process.platform,
        env: { PATH: "/tmp/kxm-harness-bin" },
        existsSync: (path: string) => String(path).includes("grok"),
        spawnSync: () => grokAuth(),
        killGraceMs: 10,
        spawn: () => {
          const child = fakeChild({ hang: true, ignoreKill: true, keepPipesOpen: true });
          child.kill = (signal?: string) => {
            kills.push(String(signal));
            child.killed = true;
            return true;
          };
          return child;
        },
        observedAt: "2026-09-05",
        now: () => 1_000,
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("helper did not settle after timeout bound")), 800);
      }),
    ]);
    assert.equal(result.status, "interrupted");
    assert.equal(result.timedOut, true);
    assert.equal(result.ok, false);
    assert.equal(result.observedChildExit, false);
    assert.equal(result.exitCode, null);
    assert.deepEqual(kills, ["SIGTERM", "SIGKILL"]);
    assert.equal((result.killRequest as { signal?: string; escalated?: boolean } | undefined)?.signal, "SIGKILL");
    assert.equal((result.killRequest as { escalated?: boolean } | undefined)?.escalated, true);
    assert.equal(result.processDead, undefined);
    assert.equal(result.childDied, undefined);
    assert.equal(result.descendantsTerminated, undefined);
    assert.equal(result.descendantsKilled, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("closed public metadata cannot leak model free text via error, stopReason, or schema diagnostics", async () => {
  const dir = tempDir();
  const leak = "LEAK-SHORT-FREE-TEXT";
  const schemaLeak = `INJECT-SCHEMA-${leak}`;
  try {
    const prompt = promptFile(dir);
    const { result } = await dispatch({
      schema: REQUEST_SCHEMA,
      harness: "grok",
      role: "writer",
      model: "grok-4.6",
      permission: "edit",
      prompt_file: prompt,
      output_dir: join(dir, "out"),
    }, {
      stdout: `${JSON.stringify({
        result: leak,
        is_error: true,
        stop_reason: leak,
        extra_model_field: leak,
        error: { message: leak },
        modelUsage: { "grok-4.6-build": { inputTokens: 5, outputTokens: 2, secret: leak } },
        total_cost_usd: 0.03,
      })}\n`,
      stderr: leak,
      exitCode: 0,
    });
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /LEAK-SHORT-FREE-TEXT/);
    assert.equal(result.harnessError, undefined);
    assert.equal(result.stopReason, "unrecognized");
    assert.equal(result.errorCode, "model_error");
    assert.equal(result.status, "failed");
    assert.equal(result.tokensIn, 5);
    assert.equal(result.usagePartial, true);
    assert.equal(result.extra_model_field, undefined);
    assert.ok(result.errorPath);
    assert.equal(readFileSync(String(result.errorPath), "utf8").includes(leak), true);
    assert.equal(readFileSync(String(result.stderrPath), "utf8"), leak);
    assert.equal(result.modelClaim, undefined);

    const diagnosed = diagnoseHarnessResult({ schema: schemaLeak, ok: true }, "poison.json");
    assert.ok(diagnosed.diagnostic);
    assert.doesNotMatch(String(diagnosed.diagnostic), /LEAK-SHORT-FREE-TEXT/);
    assert.doesNotMatch(String(diagnosed.diagnostic), /INJECT-SCHEMA/);
    assert.match(String(diagnosed.diagnostic), /observed schema unrecognized/);
    assert.match(String(diagnosed.diagnostic), /poison\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review PASS remains a model claim and cannot become verify or acceptance", async () => {
  const dir = tempDir();
  try {
    const prompt = promptFile(dir);
    const { result } = await dispatch({
      schema: REQUEST_SCHEMA,
      harness: "codex",
      role: "reviewer-cli",
      model: "gpt-5.6-sol",
      permission: "read-only",
      prompt_file: prompt,
      output_dir: join(dir, "review"),
    }, {
      stdout: [
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "agent_message",
            text: JSON.stringify({
              status: "done",
              verdict: "PASS",
              verification: { passed: true },
              acceptance: { accepted: true },
            }),
          },
        }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 2, output_tokens: 2 } }),
      ].join("\n"),
    }, codexAuth());
    assert.equal(result.status, "completed");
    assert.equal((result.modelClaim as { verdict?: string }).verdict, "PASS");
    assert.equal(result.verification, undefined);
    assert.equal(result.acceptance, undefined);
    assert.equal((result.modelClaim as { verification?: unknown }).verification, undefined);
    assert.equal((result.modelClaim as { acceptance?: unknown }).acceptance, undefined);
    assert.equal((result.modelClaim as { claimSource?: string }).claimSource, "result");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Claude structured_output is the claim source while result stays the answer", async () => {
  const dir = tempDir();
  try {
    const prompt = promptFile(dir);
    const schemaPath = join(dir, "schema.json");
    writeFileSync(schemaPath, `${JSON.stringify({ type: "object", additionalProperties: false })}\n`);
    const { result } = await dispatch({
      schema: REQUEST_SCHEMA,
      harness: "claude",
      role: "reviewer-arch",
      model: "fable",
      permission: "read-only",
      prompt_file: prompt,
      output_schema: schemaPath,
      output_dir: join(dir, "structured"),
    }, {
      stdout: `${JSON.stringify({
        result: "ordinary answer text",
        structured_output: { verdict: "PASS", summary: "PRIVATE_REPORT_SENTINEL", findings: [] },
        is_error: false,
        usage: { input_tokens: 4, output_tokens: 2 },
        total_cost_usd: 0.1,
      })}\n`,
    }, claudeAuth());
    assert.equal(result.status, "completed");
    assert.equal((result.modelClaim as { verdict?: string }).verdict, "PASS");
    assert.equal((result.modelClaim as { claimSource?: string }).claimSource, "structured_output");
    assert.equal((result.modelClaim as { summary?: unknown }).summary, undefined);
    assert.equal(readFileSync(String(result.answerPath), "utf8"), "ordinary answer text");
    assert.equal(readFileSync(String((result.modelClaim as { path: string }).path), "utf8").includes("PRIVATE_REPORT_SENTINEL"), true);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /PRIVATE_REPORT_SENTINEL/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("post-spawn write failure keeps observed spend and is not a no-spend preflight", async () => {
  const dir = tempDir();
  try {
    const prompt = promptFile(dir);
    const result = await runHarness({
      schema: REQUEST_SCHEMA,
      harness: "grok",
      role: "writer",
      model: "grok-4.6",
      permission: "edit",
      prompt_file: prompt,
      output_dir: join(dir, "out"),
    } as never, {
      platform: process.platform,
      env: { PATH: "/tmp/kxm-harness-bin" },
      existsSync: (path: string) => String(path).includes("grok"),
      spawnSync: () => grokAuth(),
      spawn: () => fakeChild({
        stdout: `${JSON.stringify({
          result: "partial-before-write",
          modelUsage: { "grok-4.6-build": { inputTokens: 9, outputTokens: 4 } },
          total_cost_usd: 0.07,
        })}\n`,
      }),
      writeFileSync: (path: string, body: string | NodeJS.ArrayBufferView, options?: unknown) => {
        if (String(path).endsWith("answer.txt")) {
          throw new Error("EIO: answer sidecar");
        }
        writeFileSync(path, body, options as never);
      },
      observedAt: "2026-09-05",
      now: () => 1_000,
    });
    assert.equal(result.status, "failed");
    assert.equal(result.stage, "run");
    assert.notEqual(result.stage, "preflight");
    assert.equal(result.errorCode, "write_failed");
    assert.equal(result.tokensIn, 9);
    assert.equal(result.tokensOut, 4);
    assert.equal(result.costUsd, 0.07);
    assert.equal(result.usagePartial, true);
    assert.equal(result.observedChildExit, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("split stdout JSON after exit drains instead of empty_payload", { timeout: 1500 }, async () => {
  const dir = tempDir();
  try {
    const prompt = promptFile(dir);
    const kills: string[] = [];
    const result = await runHarness({
      schema: REQUEST_SCHEMA,
      harness: "grok",
      role: "writer",
      model: "grok-4.6",
      permission: "edit",
      prompt_file: prompt,
      output_dir: join(dir, "drain"),
    } as never, {
      platform: process.platform,
      env: { PATH: "/tmp/kxm-harness-bin" },
      existsSync: (path: string) => String(path).includes("grok"),
      spawnSync: () => grokAuth(),
      spawn: () => {
        const child = fakeChild({ hang: true });
        child.kill = (signal?: string) => {
          kills.push(String(signal));
          return true;
        };
        queueMicrotask(() => {
          child.stdout.write('{"result":');
          child.emit("exit", 0, null);
          setTimeout(() => {
            child.stdout.end('"ok","total_cost_usd":0.5,"usage":{"input_tokens":42,"output_tokens":2}}');
            child.stderr.end();
            child.emit("close", 0, null);
          }, 15);
        });
        return child;
      },
      observedAt: "2026-09-05",
      now: () => 1_000,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.errorCode, undefined);
    assert.notEqual(result.errorCode, "empty_payload");
    assert.equal(result.tokensIn, 42);
    assert.equal(result.tokensOut, 2);
    assert.equal(result.costUsd, 0.5);
    assert.equal(result.observedChildExit, true);
    assert.deepEqual(kills, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bounded linger after exit does not collect later output or signal the child", { timeout: 1500 }, async () => {
  const dir = tempDir();
  try {
    const prompt = promptFile(dir);
    const kills: string[] = [];
    const result = await Promise.race([
      runHarness({
        schema: REQUEST_SCHEMA,
        harness: "grok",
        role: "writer",
        model: "grok-4.6",
        permission: "edit",
        prompt_file: prompt,
        output_dir: join(dir, "linger"),
      } as never, {
        platform: process.platform,
        env: { PATH: "/tmp/kxm-harness-bin" },
        existsSync: (path: string) => String(path).includes("grok"),
        spawnSync: () => grokAuth(),
        killGraceMs: 20,
        spawn: () => {
          const child = fakeChild({ hang: true, keepPipesOpen: true });
          child.kill = (signal?: string) => {
            kills.push(String(signal));
            return true;
          };
          queueMicrotask(() => {
            child.stdout.write('{"result":');
            child.emit("exit", 0, null);
            setTimeout(() => {
              child.stdout.write('"ok","total_cost_usd":0.5,"usage":{"input_tokens":42,"output_tokens":2}}');
              child.stderr.end();
              child.emit("close", 0, null);
            }, 60);
          });
          return child;
        },
        observedAt: "2026-09-05",
        now: () => 1_000,
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("helper collected unlimited later output")), 800);
      }),
    ]);
    assert.equal(result.observedChildExit, true);
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "stdio_incomplete");
    assert.equal(result.tokensIn, undefined);
    assert.equal(result.costUsd, undefined);
    assert.deepEqual(kills, []);
    assert.equal(result.processDead, undefined);
    assert.equal(result.descendantsTerminated, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid usage object types do not leak or zero known cost", async () => {
  const dir = tempDir();
  const sentinel = "PRIVATE_SENTINEL";
  try {
    const prompt = promptFile(dir);
    const { result } = await dispatch({
      schema: REQUEST_SCHEMA,
      harness: "grok",
      role: "writer",
      model: "grok-4.6",
      permission: "edit",
      prompt_file: prompt,
      output_dir: join(dir, "usage"),
    }, {
      stdout: `${JSON.stringify({
        result: "ok",
        total_cost_usd: 0.5,
        usage: { input_tokens: { raw: sentinel }, output_tokens: 2, cache_read_input_tokens: "nope" },
        modelUsage: {
          "grok-4.6-build": { inputTokens: { raw: sentinel }, outputTokens: 2, costUSD: 0.5 },
          "aux-model": { inputTokens: { raw: sentinel }, outputTokens: 4, costUSD: 0.25, costBasis: "list" },
        },
      })}\n`,
    });
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /PRIVATE_SENTINEL/);
    assert.equal(result.status, "completed");
    assert.equal(typeof result.tokensIn, "undefined");
    assert.notEqual(result.tokensIn, 0);
    assert.equal(result.tokensOut, 2);
    assert.equal(result.costUsd, 0.5);
    assert.equal(result.cacheReadTokens, undefined);
    assert.notEqual(result.cacheReadTokens, 0);
    assert.equal(result.providerMetadata, undefined);
    const aux = result.auxiliaryUsage as Array<Record<string, unknown>> | undefined;
    assert.ok(Array.isArray(aux));
    assert.equal(aux.some((row) => JSON.stringify(row).includes(sentinel)), false);
    assert.equal(aux.some((row) => row.tokensOut === 4 && row.costUsd === 0.25), true);
    assert.equal(aux.some((row) => row.tokensIn === 0), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed optional text keeps known usage as run-stage failure", async () => {
  const dir = tempDir();
  const sentinel = "PRIVATE_SENTINEL";
  try {
    const prompt = promptFile(dir);
    const { result } = await dispatch({
      schema: REQUEST_SCHEMA,
      harness: "grok",
      role: "writer",
      model: "grok-4.6",
      permission: "edit",
      prompt_file: prompt,
      output_dir: join(dir, "text"),
    }, {
      stdout: `${JSON.stringify({
        text: { private: sentinel },
        total_cost_usd: 0.5,
        usage: { input_tokens: 42, output_tokens: 2 },
      })}\n`,
    });
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /PRIVATE_SENTINEL/);
    assert.equal(result.status, "failed");
    assert.equal(result.ok, false);
    assert.equal(result.stage, "run");
    assert.notEqual(result.stage, "preflight");
    assert.equal(result.errorCode, "normalization_failed");
    assert.equal(result.tokensIn, 42);
    assert.equal(result.tokensOut, 2);
    assert.equal(result.costUsd, 0.5);
    assert.equal(result.usagePartial, true);
    assert.equal(result.answerPath, undefined);
    assert.equal(result.observedChildExit, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stdin write failure is run-stage write_failed with retained usage", async () => {
  const dir = tempDir();
  try {
    const prompt = promptFile(dir);
    const result = await runHarness({
      schema: REQUEST_SCHEMA,
      harness: "codex",
      role: "reviewer-cli",
      model: "gpt-5.6-sol",
      permission: "read-only",
      prompt_file: prompt,
      output_dir: join(dir, "stdin-write"),
    } as never, {
      platform: process.platform,
      env: { PATH: "/tmp/kxm-harness-bin" },
      existsSync: (path: string) => String(path).includes("codex"),
      spawnSync: () => codexAuth(),
      spawn: () => {
        const child = fakeChild({ hang: true });
        child.stdin.write = (() => {
          throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
        }) as typeof child.stdin.write;
        queueMicrotask(() => {
          child.stdout.end([
            JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "partial" } }),
            JSON.stringify({ type: "turn.completed", usage: { input_tokens: 42, output_tokens: 2 } }),
          ].join("\n"));
          child.stderr.end();
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        });
        return child;
      },
      observedAt: "2026-09-05",
      now: () => 1_000,
    });
    assert.equal(result.status, "failed");
    assert.notEqual(result.status, "completed");
    assert.equal(result.stage, "run");
    assert.notEqual(result.stage, "preflight");
    assert.equal(result.errorCode, "write_failed");
    assert.equal(result.tokensIn, 42);
    assert.equal(result.tokensOut, 2);
    assert.equal(result.usagePartial, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stdin error after attach is not completed and does not throw unhandled", async () => {
  const dir = tempDir();
  try {
    const prompt = promptFile(dir);
    const result = await runHarness({
      schema: REQUEST_SCHEMA,
      harness: "codex",
      role: "reviewer-cli",
      model: "gpt-5.6-sol",
      permission: "read-only",
      prompt_file: prompt,
      output_dir: join(dir, "stdin-error"),
    } as never, {
      platform: process.platform,
      env: { PATH: "/tmp/kxm-harness-bin" },
      existsSync: (path: string) => String(path).includes("codex"),
      spawnSync: () => codexAuth(),
      spawn: () => {
        const child = fakeChild({ hang: true });
        const write = child.stdin.write.bind(child.stdin);
        child.stdin.write = ((chunk: string | Buffer, ...rest: unknown[]) => {
          const ok = write(chunk, ...rest as []);
          child.stdin.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" }));
          return ok;
        }) as typeof child.stdin.write;
        queueMicrotask(() => {
          child.stdout.end([
            JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }),
            JSON.stringify({ type: "turn.completed", usage: { input_tokens: 7, output_tokens: 1 } }),
          ].join("\n"));
          child.stderr.end();
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        });
        return child;
      },
      observedAt: "2026-09-05",
      now: () => 1_000,
    });
    assert.equal(result.status, "failed");
    assert.notEqual(result.status, "completed");
    assert.equal(result.stage, "run");
    assert.equal(result.errorCode, "write_failed");
    assert.equal(result.tokensIn, 7);
    assert.equal(result.usagePartial, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pid-record amend failure is run-stage write_failed with retained spend", async () => {
  const dir = tempDir();
  try {
    const prompt = promptFile(dir);
    const result = await runHarness({
      schema: REQUEST_SCHEMA,
      harness: "grok",
      role: "writer",
      model: "grok-4.6",
      permission: "edit",
      prompt_file: prompt,
      output_dir: join(dir, "pid-amend"),
    } as never, {
      platform: process.platform,
      env: { PATH: "/tmp/kxm-harness-bin" },
      existsSync: (path: string) => String(path).includes("grok"),
      spawnSync: () => grokAuth(),
      spawn: () => {
        const child = fakeChild({
          stdout: `${JSON.stringify({
            result: "ok",
            total_cost_usd: 0.5,
            usage: { input_tokens: 42, output_tokens: 2 },
          })}\n`,
        });
        (child as { pid?: number }).pid = 99;
        return child;
      },
      writeFileSync: (path: string, body: string | NodeJS.ArrayBufferView, options?: unknown) => {
        if (String(path).endsWith("dispatch.json")) {
          const parsed = JSON.parse(String(body)) as { pid?: number | null };
          if (parsed.pid != null) throw new Error("EIO pid amend");
        }
        writeFileSync(path, body, options as never);
      },
      observedAt: "2026-09-05",
      now: () => 1_000,
    });
    assert.equal(result.status, "failed");
    assert.notEqual(result.status, "completed");
    assert.equal(result.stage, "run");
    assert.notEqual(result.stage, "preflight");
    assert.equal(result.errorCode, "write_failed");
    assert.equal(result.tokensIn, 42);
    assert.equal(result.costUsd, 0.5);
    assert.equal(result.usagePartial, true);
    assert.equal(result.observedChildExit, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawn failure is stage spawn with no invented spend", async () => {
  const dir = tempDir();
  try {
    const prompt = promptFile(dir);
    const result = await runHarness({
      schema: REQUEST_SCHEMA,
      harness: "grok",
      role: "writer",
      model: "grok-4.6",
      permission: "edit",
      prompt_file: prompt,
      output_dir: join(dir, "out"),
    } as never, {
      platform: process.platform,
      env: { PATH: "/tmp/kxm-harness-bin" },
      existsSync: (path: string) => String(path).includes("grok"),
      spawnSync: () => grokAuth(),
      spawn: () => {
        throw Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
      },
      observedAt: "2026-09-05",
      now: () => 1_000,
    });
    assert.equal(result.status, "failed");
    assert.equal(result.stage, "spawn");
    assert.notEqual(result.stage, "preflight");
    assert.equal(result.errorCode, "spawn_failed");
    assert.equal(result.tokensIn, undefined);
    assert.equal(result.costUsd, undefined);
    assert.equal(result.usagePartial, undefined);
    assert.equal(result.observedChildExit, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("result consumers accept exactly v2 and leave obsolete files untouched", async () => {
  const dir = tempDir();
  try {
    const v1Path = join(dir, "old-v1.json");
    const v1 = {
      schema: "kxm.harness-result.v1",
      ok: true,
      finalOutcome: "passed",
      harness: "grok",
      costBasis: "list",
      costUsd: 0.1,
    };
    writeFileSync(v1Path, `${JSON.stringify(v1)}\n`);
    const original = readFileSync(v1Path, "utf8");
    const diagnosed = diagnoseHarnessResult(v1, v1Path);
    assert.ok(diagnosed.diagnostic);
    assert.match(String(diagnosed.diagnostic), /old-v1\.json/);
    assert.match(String(diagnosed.diagnostic), /kxm\.harness-result\.v1/);
    assert.match(String(diagnosed.diagnostic), /obsolete result schema/);
    assert.match(String(diagnosed.diagnostic), /kxm\.harness-result\.v2/);
    assert.equal(diagnosed.result, undefined);
    const listing = formatRunListing(v1, v1Path);
    assert.match(listing, /obsolete result schema/);
    assert.equal(readFileSync(v1Path, "utf8"), original);
    const v2Listing = formatRunListing({
      schema: "kxm.harness-result.v2",
      ok: true,
      harness: "grok",
      effectiveModel: "grok-4.6-build",
      latencyMs: 13,
      costBasis: "unknown",
    }, "fresh.json");
    assert.match(v2Listing, /ok/);
    assert.match(v2Listing, /unknown/);
    assert.doesNotMatch(v2Listing, /obsolete/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("just binary integration is optional when the binary is installed", (t) => {
  if (!justAvailable) {
    t.skip("just not installed; recipe-body quoting coverage does not require it");
    return;
  }
  if (!posixShell) {
    const sh = spawnSync("sh", ["-c", "echo ok"], { encoding: "utf8" });
    if (sh.status !== 0) {
      t.skip("just recipes need POSIX sh on Windows; extracted node -e covers quoting");
      return;
    }
  }
  const dir = tempDir();
  const capturePath = join(dir, "capture.json");
  const wrapper = join(dir, "capture-run");
  writeFileSync(wrapper, `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(captureBin)} "$@"\n`);
  chmodSync(wrapper, 0o755);
  const brief = `a"b\\c $d.md`;
  const cwd = "cwd; rm -rf / && echo `oops` | cat";
  const dashBrief = "-n.md";
  const newlineBrief = "line1\nline2.md";
  try {
    const ran = spawnSync("just", ["--set", "run", wrapper, "impl", brief, cwd], {
      encoding: "utf8",
      env: { ...process.env, KXM_CAPTURE: capturePath },
      cwd: process.cwd(),
    });
    assert.equal(ran.status, 0, `${ran.stderr}\n${ran.stdout}`);
    const captured = readCapture(capturePath);
    assert.deepEqual(captured.argv, ["-"]);
    assertPromptEnvelope(captured.stdin, brief, cwd);

    const dispatch = spawnSync("just", ["--set", "run", wrapper, "dispatch", `req"uest.json`], {
      encoding: "utf8",
      env: { ...process.env, KXM_CAPTURE: capturePath },
      cwd: process.cwd(),
    });
    assert.equal(dispatch.status, 0, dispatch.stderr);
    assert.deepEqual(readCapture(capturePath).argv, ["--", `req"uest.json`]);

    const dash = spawnSync("just", ["--set", "run", wrapper, "--", "impl", dashBrief, "."], {
      encoding: "utf8",
      env: { ...process.env, KXM_CAPTURE: capturePath },
      cwd: process.cwd(),
    });
    assert.equal(dash.status, 0, `${dash.stderr}\n${dash.stdout}`);
    assert.equal(
      (JSON.parse(readCapture(capturePath).stdin) as { prompt_file: string }).prompt_file,
      dashBrief,
    );

    const nl = spawnSync("just", ["--set", "run", wrapper, "--", "impl", newlineBrief, "."], {
      encoding: "utf8",
      env: { ...process.env, KXM_CAPTURE: capturePath },
      cwd: process.cwd(),
    });
    assert.equal(nl.status, 0, `${nl.stderr}\n${nl.stdout}`);
    assert.equal(
      (JSON.parse(readCapture(capturePath).stdin) as { prompt_file: string }).prompt_file,
      newlineBrief,
    );

    const logs = join(dir, ".kxm", "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, "billed.json"), `${JSON.stringify({
      schema: RESULT_SCHEMA, ok: true, harness: "pi", effectiveModel: "openrouter/nous", latencyMs: 12, costBasis: "billed", costUsd: 1.5,
    })}\n`);
    writeFileSync(join(logs, "absent.json"), `${JSON.stringify({
      schema: RESULT_SCHEMA, ok: false, harness: "grok", effectiveModel: "grok-4.6-build", latencyMs: 14,
    })}\n`);
    writeFileSync(join(logs, "old-v1.json"), `${JSON.stringify({
      schema: "kxm.harness-result.v1", ok: true, finalOutcome: "passed", harness: "grok", costUsd: 0.1,
    })}\n`);
    const runs = spawnSync("just", ["--working-directory", dir, "--justfile", resolve("justfile"), "runs"], {
      encoding: "utf8",
      cwd: process.cwd(),
    });
    assert.equal(runs.status, 0, runs.stderr);
    assert.match(runs.stdout, /billed \$1\.5000/);
    assert.match(runs.stdout, /unknown/);
    assert.match(runs.stdout, /obsolete result schema kxm\.harness-result\.v1/);
    assert.doesNotMatch(runs.stdout, /\$0\.0000/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Pi writer admits only Qwen edit and requires exact model auth before spawn", async () => {
  const dir = tempDir();
  try {
    const request = { schema: REQUEST_SCHEMA, harness: "pi", role: "writer", model: "openrouter/qwen/qwen3-coder-plus", permission: "edit", prompt_file: promptFile(dir), output_dir: join(dir, "out") };
    preflightRequest(request);
    for (const change of [{ permission: "read-only" }, { model: "openrouter/anthropic/fable" }, { model: "openrouter/openai/gpt-5.6-sol" }, { model: "openrouter/x-ai/grok-4.6" }, { model: "openrouter/qwen/unknown" }]) {
      assert.throws(() => preflightRequest({ ...request, ...change }), /pi writer/);
    }
    let calls = 0;
    let spawned = 0;
    const authArgs: string[][] = [];
    const deps = {
      env: { PATH: dir }, existsSync: () => true,
      spawnSync: (_command: string, args: string[]) => { authArgs.push(args); calls++; return { status: 0, stdout: JSON.stringify({ provider: "openrouter", status: "ready" }), stderr: "" }; },
      spawn: () => { spawned++; return fakeChild({ stdout: piLine(piAssistantEnd({ model: "qwen/qwen3-coder-plus" })) }); },
    };
    const result = await runHarness(request, deps);
    assert.equal(result.ok, true);
    assert.equal(spawned, 1);
    assert.equal(calls, 1);
    assert.deepEqual(authArgs[0], ["auth", "check", "--provider", "openrouter", "--model", "qwen/qwen3-coder-plus", "--json"]);
    for (const proof of ["openrouter ready", JSON.stringify({ provider: "other", status: "ready" }), JSON.stringify({ provider: "openrouter", status: "not_ready" })]) {
      await assert.rejects(() => runHarness({ ...request, output_dir: join(dir, `bad-${calls++}`) }, { ...deps, spawnSync: () => ({ status: 0, stdout: proof, stderr: "" }) }), /auth|readiness|ready/);
    }
    assert.equal(spawned, 1, "no model launch on missing exact auth proof");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Pi admits Nous Portal Hy4 experiment after provider auth and still refuses it as writer", async () => {
  const dir = tempDir();
  try {
    const experiment = {
      schema: REQUEST_SCHEMA,
      harness: "pi",
      role: "experiment",
      model: PI_NOUS_PORTAL_HY4,
      permission: "read-only",
      prompt_file: promptFile(dir),
      output_dir: join(dir, "out"),
    };
    preflightRequest(experiment);
    assert.deepEqual(piAuthCheckArgs(experiment), ["auth", "check", "--provider", "nous-portal"]);
    assert.throws(
      () => preflightRequest({ ...experiment, role: "writer", permission: "edit" }),
      /pi writer/,
    );
    let spawned = 0;
    const authArgs: string[][] = [];
    const deps = {
      env: { PATH: dir },
      existsSync: () => true,
      spawnSync: (_command: string, args: string[]) => {
        authArgs.push(args);
        return piAuth("nous-portal");
      },
      spawn: () => {
        spawned += 1;
        return fakeChild({
          stdout: [
            piLine({ type: "session", id: "nous-hy4" }),
            piLine(piAssistantEnd({ model: "nous-portal/tencent/hy4-preview" })),
          ].join(""),
        });
      },
    };
    const result = await runHarness(experiment, deps);
    assert.equal(result.ok, true);
    assert.equal(result.provider, "nous-portal");
    assert.equal(result.requestedModel, PI_NOUS_PORTAL_HY4);
    assert.equal(result.auth?.method, "nous-portal");
    assert.equal(spawned, 1);
    assert.deepEqual(authArgs[0], ["auth", "check", "--provider", "nous-portal"]);
    await assert.rejects(
      () => runHarness({ ...experiment, output_dir: join(dir, "logged-out") }, {
        ...deps,
        spawnSync: () => ({ status: 0, stdout: "nous-portal  not_ready\n", stderr: "" }),
      }),
      /Nous Portal/,
    );
    assert.equal(spawned, 1, "no model launch when Nous Portal auth is not ready");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
