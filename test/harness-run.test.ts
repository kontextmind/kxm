import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  NATIVE_PI_BRAKE_PROVIDERS,
  REQUEST_SCHEMA,
  RESULT_SCHEMA,
  ROUTING_INT_CAP,
  buildArgv,
  clampEffort,
  formatRunCost,
  normalizeClaudeOrGrok,
  normalizeCodex,
  normalizePi,
  parseAuth,
  preflightRequest,
  resolveLauncher,
  resolveModelUsage,
  runHarness,
  unsupportedLauncherMessage,
} from "../scripts/harness-run.mjs";

const authFixtures = JSON.parse(
  readFileSync(resolve("test/fixtures/harness/auth-fixtures.json"), "utf8"),
) as Record<string, Record<string, unknown>>;

function authFixture(name: string): Record<string, unknown> {
  const fixture = authFixtures[name];
  assert(fixture, `missing auth fixture ${name}`);
  return fixture;
}
const printArgv = resolve("test/fixtures/harness/print-argv.mjs");
const helper = resolve("scripts/harness-run.mjs");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "kxm-harness-"));
}

function promptFile(dir: string, body = "brief"): string {
  const path = join(dir, "brief.md");
  writeFileSync(path, body);
  return path;
}

function fakeChild(options: {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  hang?: boolean;
} = {}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    kill: (signal?: string) => void;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  let closed = false;
  const close = (code: number | null) => {
    if (closed) return;
    closed = true;
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code);
  };
  child.kill = () => close(null);
  queueMicrotask(() => {
    if (options.hang) return;
    if (options.stdout) child.stdout.write(options.stdout);
    if (options.stderr) child.stderr.write(options.stderr);
    close(options.exitCode ?? 0);
  });
  return child;
}

function grokAuth() {
  const fixture = authFixture("grok");
  return { status: 0, stdout: String(fixture.stdout), stderr: "", error: undefined };
}

function claudeAuth() {
  const fixture = authFixture("claude");
  return {
    status: 0,
    stdout: `${JSON.stringify({
      loggedIn: fixture.loggedIn,
      authMethod: fixture.authMethod,
      apiProvider: fixture.apiProvider,
      subscriptionType: fixture.subscriptionType,
    })}\n`,
    stderr: "",
    error: undefined,
  };
}

function codexAuth() {
  const fixture = authFixture("codex");
  return { status: 0, stdout: String(fixture.stdout), stderr: String(fixture.stderr), error: undefined };
}

function piAuth() {
  return { status: 0, stdout: "openrouter  ready\n", stderr: "", error: undefined };
}

async function dispatch(request: Record<string, unknown>, assignment: {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  hang?: boolean;
}, auth = grokAuth(), extras: Record<string, unknown> = {}) {
  const spawns: Array<{ command: string; argv: string[]; options: { shell?: boolean } }> = [];
  const result = await runHarness(request as never, {
    platform: extras.platform ?? process.platform,
    env: { PATH: extras.pathEnv ?? "/tmp/kxm-harness-bin", ...(extras.env as object ?? {}) },
    existsSync: extras.existsSync ?? ((path: string) => String(path).includes(String(request.harness))),
    spawnSync: () => auth,
    spawn: (command: string, argv: string[], options: { shell?: boolean }) => {
      spawns.push({ command, argv, options });
      return fakeChild(assignment);
    },
    observedAt: "2026-09-05",
    now: () => 1_000,
    ...extras,
  });
  return { result, spawns };
}

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
      { harness: "gemini", role: "planner", model: "gemini-3", permission: "read-only", prompt_file: prompt },
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
  assert(codex.includes("--json"));
  assert.equal(codex.at(-1), "-");
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
    assert.match(String(result.harnessError), /aborted/);
    assert.equal(result.finalOutcome, "failed");
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
    assert.match(String(codexErr.result.harnessError), /exploded|turn/);

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
    assert.match(String(empty.result.harnessError), /empty JSON payload/);
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
    assert.equal(result.costBasis, "list");
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
    () => resolveLauncher("C:\\\\Tools\\\\grok.cmd", { platform: "win32", existsSync: () => true }),
    /unsupported-launcher/,
  );
  assert.throws(
    () => resolveLauncher("C:\\\\Tools\\\\grok.bat", { platform: "win32", existsSync: () => true }),
    /unsupported-launcher/,
  );
  assert.throws(
    () => resolveLauncher("C:\\\\Tools\\\\grok.ps1", { platform: "win32", existsSync: () => true }),
    /unsupported-launcher/,
  );
  assert.throws(
    () => resolveLauncher("grok", {
      platform: "win32",
      pathEnv: "C:\\\\Tools",
      existsSync: exists,
    }),
    /unsupported-launcher/,
  );
  const exe = resolveLauncher("C:\\\\Tools\\\\grok.exe", { platform: "win32", existsSync: () => true });
  assert.equal(exe, "C:\\\\Tools\\\\grok.exe");
  assert.match(unsupportedLauncherMessage("pi.cmd", "win32"), /pi.cmd/);
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
    { ok: true, harness: "claude", effectiveModel: "claude-fable-5-1", latencyMs: 10, costBasis: "unmetered", providerReportedCostUsd: 2.7499 },
    { ok: true, harness: "pi", effectiveModel: "openrouter/nous", latencyMs: 11, costBasis: "list", costUsd: 0.08 },
    { ok: true, harness: "pi", effectiveModel: "openrouter/nous", latencyMs: 12, costBasis: "billed", costUsd: 1.5 },
    { ok: true, harness: "grok", effectiveModel: "grok-4.6-build", latencyMs: 13, costBasis: "unknown" },
    { ok: false, harness: "grok", effectiveModel: "grok-4.6-build", latencyMs: 14 },
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
  assert.doesNotMatch(stdout, /\$0\.0000/);
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
      ok: true, harness: "pi", effectiveModel: "openrouter/nous", latencyMs: 12, costBasis: "billed", costUsd: 1.5,
    })}\n`);
    writeFileSync(join(logs, "absent.json"), `${JSON.stringify({
      ok: false, harness: "grok", effectiveModel: "grok-4.6-build", latencyMs: 14,
    })}\n`);
    const runs = spawnSync("just", ["--working-directory", dir, "--justfile", resolve("justfile"), "runs"], {
      encoding: "utf8",
      cwd: process.cwd(),
    });
    assert.equal(runs.status, 0, runs.stderr);
    assert.match(runs.stdout, /billed \$1\.5000/);
    assert.match(runs.stdout, /unknown/);
    assert.doesNotMatch(runs.stdout, /\$0\.0000/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
