import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadVnextProject } from "../plugins/kxm/src/vnext-config.ts";
import {
  driveVnextRun,
  pinVnextCompiledPlan,
} from "../plugins/kxm/src/vnext-engine.ts";
import {
  acceptVnextRun,
  closeVnextRuntimeContext,
  openVnextRuntimeContext,
} from "../plugins/kxm/src/vnext-runtime.ts";
import {
  createVnextOneShotProducer,
  defaultSpawn,
  type VnextOneShotProcessResult,
  type VnextOneShotSpawn,
} from "../plugins/kxm/src/vnext-oneshot-producer.ts";
import {
  parseClaudeOneShotUsage,
  parseCodexOneShotUsage,
  parseGenericOneShotUsage,
} from "../plugins/kxm/src/vnext-harness.ts";
import { loadPriceCatalog } from "../plugins/kxm/src/prices.ts";
import { emitCodexArtifacts } from "../scripts/emit-codex-artifacts.mjs";
import { makeGitRoot } from "./helpers/git-root.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = "rtm_01JDRIVER0000000000000000";

test("parseClaudeOneShotUsage parses valid JSON and errors", () => {
  const empty = parseClaudeOneShotUsage("", "some error");
  assert.equal(empty.isError, true);
  assert.equal(empty.errorMessage, "some error");

  const validJson = JSON.stringify({
    result: "Analysis complete. passed",
    total_cost_usd: 0.005,
    usage: {
      input_tokens: 500,
      output_tokens: 150,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 25,
    },
    modelUsage: {
      "claude-3-7-sonnet": {
        inputTokens: 500,
        outputTokens: 150,
        cacheReadInputTokens: 50,
        cacheCreationInputTokens: 25,
        costUSD: 0.005,
      },
    },
  });

  const parsed = parseClaudeOneShotUsage(validJson, "");
  assert.equal(parsed.isError, false);
  assert.equal(parsed.text, "Analysis complete. passed");
  assert.equal(parsed.usage?.tokensIn, 500);
  assert.equal(parsed.usage?.tokensOut, 150);
  assert.equal(parsed.usage?.cacheReadTokens, 50);
  assert.equal(parsed.usage?.cacheWriteTokens, 25);
  assert.equal(parsed.usage?.costUsd, 0.005);

  const errorJson = JSON.stringify({
    is_error: true,
    result: "quota exceeded",
  });
  const parsedError = parseClaudeOneShotUsage(errorJson, "");
  assert.equal(parsedError.isError, true);
  assert.equal(parsedError.errorMessage, "quota exceeded");
});

test("parseCodexOneShotUsage parses JSONL events and errors", () => {
  const empty = parseCodexOneShotUsage("", "codex crashed");
  assert.equal(empty.isError, true);
  assert.equal(empty.errorMessage, "codex crashed");

  const jsonl = [
    JSON.stringify({ type: "item.created", item: { type: "agent_message", text: "Code review complete. passed" } }),
    JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 800,
        output_tokens: 200,
        cached_input_tokens: 100,
        cache_write_input_tokens: 40,
        reasoning_output_tokens: 50,
      },
    }),
  ].join("\n");

  const parsed = parseCodexOneShotUsage(jsonl, "");
  assert.equal(parsed.isError, false);
  assert.equal(parsed.text, "Code review complete. passed");
  assert.equal(parsed.usage?.tokensIn, 800);
  assert.equal(parsed.usage?.tokensOut, 200);
  assert.equal(parsed.usage?.cacheReadTokens, 100);
  assert.equal(parsed.usage?.cacheWriteTokens, 40);

  const failureJsonl = [
    JSON.stringify({ type: "turn.failed", error: { message: "Rate limit exceeded" } }),
  ].join("\n");
  const parsedFailure = parseCodexOneShotUsage(failureJsonl, "");
  assert.equal(parsedFailure.isError, true);
  assert.equal(parsedFailure.errorMessage, "Rate limit exceeded");
});

test("parseGenericOneShotUsage handles JSON and plain text", () => {
  const jsonStr = JSON.stringify({ result: "done" });
  assert.equal(parseGenericOneShotUsage(jsonStr, "").text, "done");
  assert.equal(parseGenericOneShotUsage("plain text", "").text, "plain text");
});

test("Claude one-shot producer dispatches with stdin and calculates metered / unmetered cost", async () => {
  const fakeAuth = () => ({ detected: true, authenticated: true as const, issues: [] });
  const catalog = loadPriceCatalog(repoRoot);

  let capturedCommand = "";
  let capturedArgs: readonly string[] = [];
  let capturedInput: string | undefined;

  const mockSpawn: VnextOneShotSpawn = async (command, args, options) => {
    capturedCommand = command;
    capturedArgs = args;
    capturedInput = options.input;
    return {
      stdout: JSON.stringify({
        result: "Task completed successfully. passed",
        total_cost_usd: 0.0045,
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 50,
        },
      }),
      stderr: "",
      code: 0,
    };
  };

  const producer = createVnextOneShotProducer({
    defaultHarness: "claude",
    defaultModel: "claude-3-7-sonnet",
    priceCatalog: catalog,
    probeHarness: fakeAuth as any,
    spawnProcess: mockSpawn,
  });

  try {
    const controller = new AbortController();
    const result = await producer.produce({
      runId: "run_claude_1",
      stepId: "plan_step",
      stepAttempt: 1,
      assignmentId: "asg_c1",
      attemptId: "att_c1",
      agentId: "planner",
      capability: "secret",
      allowedOutcomes: ["passed", "failed"],
      signal: controller.signal,
      thinking: "high",
    });

    assert.equal(capturedCommand, "claude");
    assert.ok(capturedArgs.includes("-p"));
    assert.ok(capturedArgs.includes("--model"));
    assert.ok(capturedArgs.includes("claude-3-7-sonnet"));
    assert.ok(capturedArgs.includes("--effort"));
    assert.ok(capturedArgs.includes("high"));
    assert.ok(capturedArgs.includes("--output-format"));
    assert.ok(capturedArgs.includes("json"));
    assert.ok(capturedInput && capturedInput.includes("plan_step"));

    assert.equal(result.outcome, "passed");
    assert.equal(result.harness, "claude");
    assert.equal(result.provider, "anthropic");
    assert.equal(result.requestedModel, "claude-3-7-sonnet");
    assert.equal(result.thinking, "high");
    assert.equal(result.tokensIn, 1000);
    assert.equal(result.tokensOut, 200);
    assert.equal(result.cacheReadTokens, 100);
    assert.equal(result.cacheWriteTokens, 50);
    assert.equal(result.costBasis, "metered");
    assert.ok(typeof result.costUsd === "number" && result.costUsd > 0);
  } finally {
    await producer.close();
  }
});

test("Codex one-shot producer dispatches with JSONL output and unmetered subscription cost", async () => {
  const fakeAuth = () => ({ detected: true, authenticated: true as const, issues: [] });

  let capturedCommand = "";
  let capturedArgs: readonly string[] = [];
  let capturedInput: string | undefined;

  const mockSpawn: VnextOneShotSpawn = async (command, args, options) => {
    capturedCommand = command;
    capturedArgs = args;
    capturedInput = options.input;
    return {
      stdout: [
        JSON.stringify({ type: "item.created", item: { type: "agent_message", text: "Architecture verified. passed" } }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 1200,
            output_tokens: 300,
            cached_input_tokens: 200,
            cache_write_input_tokens: 0,
          },
        }),
      ].join("\n"),
      stderr: "",
      code: 0,
    };
  };

  // Empty catalog so Codex falls back to unmetered subscription pricing
  const emptyCatalog = {
    schema: "kxm.prices.v1" as const,
    date: "2026-09-08",
    sha256: "0000000000000000000000000000000000000000000000000000000000000000",
    currency: "USD",
    models: [],
  };

  const producer = createVnextOneShotProducer({
    defaultHarness: "codex",
    defaultModel: "gpt-5.6-sol",
    priceCatalog: emptyCatalog as any,
    probeHarness: fakeAuth as any,
    spawnProcess: mockSpawn,
  });

  try {
    const controller = new AbortController();
    const result = await producer.produce({
      runId: "run_codex_1",
      stepId: "review_step",
      stepAttempt: 1,
      assignmentId: "asg_cdx1",
      attemptId: "att_cdx1",
      agentId: "reviewer",
      capability: "secret",
      allowedOutcomes: ["passed", "failed"],
      signal: controller.signal,
      thinking: "medium",
    });

    assert.equal(capturedCommand, "codex");
    assert.ok(capturedArgs.includes("exec"));
    assert.ok(capturedArgs.includes("-m"));
    assert.ok(capturedArgs.includes("gpt-5.6-sol"));
    assert.ok(capturedArgs.includes("-c"));
    assert.ok(capturedArgs.includes('model_reasoning_effort="medium"'));
    assert.ok(capturedArgs.includes("--json"));
    assert.ok(capturedArgs.includes("-"));
    assert.ok(capturedInput && capturedInput.includes("review_step"));

    assert.equal(result.outcome, "passed");
    assert.equal(result.harness, "codex");
    assert.equal(result.provider, "openai");
    assert.equal(result.requestedModel, "gpt-5.6-sol");
    assert.equal(result.thinking, "medium");
    assert.equal(result.tokensIn, 1200);
    assert.equal(result.tokensOut, 300);
    assert.equal(result.cacheReadTokens, 200);
    assert.equal(result.costBasis, "unmetered");
    assert.equal(result.costUsd, null);
    assert.equal(result.priceRef, "subscription:codex");
  } finally {
    await producer.close();
  }
});

test("One-shot producer fails closed when harness is unauthenticated or not detected", async () => {
  // 1. Not detected
  const notDetectedProbe = () => ({ detected: false, authenticated: false as const, issues: ["binary not found"] });
  const p1 = createVnextOneShotProducer({
    defaultHarness: "claude",
    probeHarness: notDetectedProbe as any,
  });
  await assert.rejects(
    p1.produce({
      runId: "run_fail_1",
      stepId: "s1",
      stepAttempt: 1,
      assignmentId: "asg_f1",
      attemptId: "att_f1",
      agentId: "planner",
      capability: "secret",
      allowedOutcomes: ["passed"],
      signal: new AbortController().signal,
    }),
    /claude_not_authenticated: claude harness not detected/,
  );

  // 2. Not authenticated
  const loggedOutProbe = () => ({ detected: true, authenticated: false as const, issues: ["not_authenticated"] });
  const p2 = createVnextOneShotProducer({
    defaultHarness: "codex",
    probeHarness: loggedOutProbe as any,
  });
  await assert.rejects(
    p2.produce({
      runId: "run_fail_2",
      stepId: "s1",
      stepAttempt: 1,
      assignmentId: "asg_f2",
      attemptId: "att_f2",
      agentId: "reviewer",
      capability: "secret",
      allowedOutcomes: ["passed"],
      signal: new AbortController().signal,
    }),
    /codex_not_authenticated: codex not authenticated/,
  );

  // 3. Inventory not authenticated
  const unauthInventory = {
    defaultHarness: "pi" as const,
    harnesses: [{ id: "claude", label: "Claude", default: false, mode: "either" as const, detected: true, authenticated: false, canUpdate: { self: false, extensions: false, models: false }, issues: ["logged_out"] }],
  };
  const p3 = createVnextOneShotProducer({
    defaultHarness: "claude",
    inventory: unauthInventory,
    probeHarness: (() => ({ detected: true, authenticated: true as const, issues: [] })) as any,
  });
  await assert.rejects(
    p3.produce({
      runId: "run_fail_3",
      stepId: "s1",
      stepAttempt: 1,
      assignmentId: "asg_f3",
      attemptId: "att_f3",
      agentId: "planner",
      capability: "secret",
      allowedOutcomes: ["passed"],
      signal: new AbortController().signal,
    }),
    /claude_not_authenticated: claude harness not authenticated in inventory/,
  );
});

test("One-shot producer handles pre-aborted signal and abort during execution", async () => {
  const fakeAuth = () => ({ detected: true, authenticated: true as const, issues: [] });

  // 1. Pre-aborted signal
  const producer = createVnextOneShotProducer({
    defaultHarness: "claude",
    probeHarness: fakeAuth as any,
  });

  const abortedController = new AbortController();
  abortedController.abort();

  const preResult = await producer.produce({
    runId: "run_abort_1",
    stepId: "s1",
    stepAttempt: 1,
    assignmentId: "asg_ab1",
    attemptId: "att_ab1",
    agentId: "planner",
    capability: "secret",
    allowedOutcomes: ["passed", "cancelled"],
    signal: abortedController.signal,
  });
  assert.equal(preResult.outcome, "cancelled");

  // 2. Abort during execution
  const activeProducer = createVnextOneShotProducer({
    defaultHarness: "claude",
    probeHarness: fakeAuth as any,
    spawnProcess: async (_cmd, _args, options) => {
      return new Promise((resolve) => {
        options.signal?.addEventListener("abort", () => {
          resolve({ stdout: "", stderr: "aborted", code: null, error: new Error("process_aborted") });
        });
      });
    },
  });

  const activeController = new AbortController();
  setTimeout(() => activeController.abort(), 20);

  const activeResult = await activeProducer.produce({
    runId: "run_abort_2",
    stepId: "s2",
    stepAttempt: 1,
    assignmentId: "asg_ab2",
    attemptId: "att_ab2",
    agentId: "planner",
    capability: "secret",
    allowedOutcomes: ["passed", "cancelled"],
    signal: activeController.signal,
  });
  assert.equal(activeResult.outcome, "cancelled");
});

test("One-shot producer executes end-to-end inside vNext engine driver", async () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-oneshot-driver-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-oneshot-driver-state-"));
  try {
    cpSync(join(repoRoot, "examples/vnext"), root, { recursive: true });
    makeGitRoot(root);
    makeGitRoot(join(root, "repositories", "api"));
    makeGitRoot(join(root, "repositories", "web"));

    const gateScriptPath = join(root, "gate-script.cjs");
    writeFileSync(gateScriptPath, "process.exit(0);\n");

    writeFileSync(
      join(root, ".kxm", "gates.yaml"),
      `schema: kxm.gate-registry.v1
gates:
  test:
    kind: command
    argv: [${JSON.stringify(process.execPath)}, ${JSON.stringify(gateScriptPath)}]
    timeoutMs: 3600000
  scm-delivery:
    kind: command
    argv: [${JSON.stringify(process.execPath)}, ${JSON.stringify(gateScriptPath)}]
    timeoutMs: 1800000
`,
    );

    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });

    const fakeAuth = () => ({ detected: true, authenticated: true as const, issues: [] });
    const producer = createVnextOneShotProducer({
      projectRoot: root,
      defaultHarness: "claude",
      defaultModel: "claude-3-7-sonnet",
      probeHarness: fakeAuth as any,
      spawnProcess: async () => ({
        stdout: JSON.stringify({
          result: "Step passed successfully.",
          total_cost_usd: 0.002,
          usage: { input_tokens: 300, output_tokens: 80, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
        }),
        stderr: "",
        code: 0,
      }),
    });

    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "default", prompt: "test prompt" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);

      const result = await driveVnextRun(context, accepted.run.runId, producer, { allowLimits: true });
      assert.equal(result.state.status, "completed");

      // Verify routing records recorded harness: claude
      const events = context.eventStore.events(accepted.run.runId, 0, 100);
      const routingEvents = events.filter((e) => e.eventType === "routing.attempt.recorded");
      assert.ok(routingEvents.length > 0);
      for (const ev of routingEvents) {
        const routing = (ev.payload as any).routing;
        assert.equal(routing.harness, "claude");
      }
    } finally {
      await producer.close();
      closeVnextRuntimeContext(context);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("Codex artifacts: skills directory and AGENTS.md block are emitted and match check", () => {
  const result = emitCodexArtifacts(repoRoot);
  assert.ok(existsSync(join(repoRoot, ".agents", "skills", "kxm", "SKILL.md")));
  assert.ok(existsSync(join(repoRoot, ".agents", "skills", "kxm-session", "SKILL.md")));
  assert.ok(existsSync(join(repoRoot, ".agents", "skills", "kxm", "references", "protocol.md")));

  const agentsContent = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
  assert.ok(agentsContent.includes("<!-- kxm:codex:commands:start -->"));
  assert.ok(agentsContent.includes("<!-- kxm:codex:commands:end -->"));
  assert.ok(agentsContent.includes("kxm peer send"));
  assert.ok(agentsContent.includes("kxm workflow checkpoint"));
});

test("One-shot producer handles resolveHarness, resolveModel, custom harness, explicit prompt, and defaultSpawn", async () => {
  const fakeAuth = () => ({ detected: true, authenticated: true as const, issues: [] });

  let capturedInput: string | undefined;
  const producer = createVnextOneShotProducer({
    resolveHarness: (agentId) => (agentId === "custom_agent" ? "grok" : undefined),
    resolveModel: (agentId) => {
      if (agentId === "custom_agent") {
        return { harness: "grok", provider: "xai", model: "grok-4.6", thinking: "medium" };
      }
      return undefined;
    },
    probeHarness: fakeAuth as any,
    spawnProcess: async (cmd, args, opts) => {
      capturedInput = opts.input;
      return {
        stdout: JSON.stringify({ result: '{"outcome": "passed"}' }),
        stderr: "",
        code: 0,
      };
    },
  });

  try {
    const res = await producer.produce({
      runId: "run_custom_1",
      stepId: "step_custom",
      stepAttempt: 1,
      assignmentId: "asg_cust",
      attemptId: "att_cust",
      agentId: "custom_agent",
      capability: "secret",
      allowedOutcomes: ["passed", "failed"],
      prompt: "Custom prompt text",
      signal: new AbortController().signal,
    });

    assert.equal(res.harness, "grok");
    assert.equal(res.provider, "xai");
    assert.equal(res.requestedModel, "grok-4.6");
    assert.equal(res.outcome, "passed");
    assert.equal(capturedInput, "Custom prompt text");
  } finally {
    await producer.close();
  }

  // Test promptVia === "arg" branch (like pi)
  let capturedArgs: readonly string[] = [];
  const argProducer = createVnextOneShotProducer({
    defaultHarness: "pi",
    probeHarness: fakeAuth as any,
    spawnProcess: async (cmd, args) => {
      capturedArgs = args;
      return {
        stdout: JSON.stringify({ result: "done" }),
        stderr: "",
        code: 0,
      };
    },
  });
  await argProducer.produce({
    runId: "run_arg_1",
    stepId: "s1",
    stepAttempt: 1,
    assignmentId: "asg_arg",
    attemptId: "att_arg",
    agentId: "planner",
    capability: "secret",
    allowedOutcomes: ["completed"],
    prompt: "Prompt in args",
    signal: new AbortController().signal,
  });
  assert.ok(capturedArgs.includes("Prompt in args"));
  await argProducer.close();
});

test("defaultSpawn handles standard process execution, stdin piping, and exit codes", async () => {
  // Test stdout, stderr, stdin
  const res1 = await defaultSpawn(
    process.execPath,
    ["-e", "process.stdin.pipe(process.stdout); console.error('test_err')"],
    { input: "piped input" },
  );
  assert.equal(res1.stdout, "piped input");
  assert.equal(res1.stderr.trim(), "test_err");
  assert.equal(res1.code, 0);
  assert.equal(res1.error, undefined);

  // Test without input (input undefined)
  const res2 = await defaultSpawn(
    process.execPath,
    ["-e", "console.log('no input')"],
    {},
  );
  assert.equal(res2.stdout.trim(), "no input");
  assert.equal(res2.code, 0);

  // Test timeout
  const res3 = await defaultSpawn(
    process.execPath,
    ["-e", "setTimeout(() => {}, 5000)"],
    { timeoutMs: 50 },
  );
  assert.ok(res3.error);

  // Test pre-aborted signal
  const preAborted = new AbortController();
  preAborted.abort();
  const res4 = await defaultSpawn(
    process.execPath,
    ["-e", "console.log('never')"],
    { signal: preAborted.signal },
  );
  assert.ok(res4.error);

  // Test signal abort while running
  const abortWhileRunning = new AbortController();
  setTimeout(() => abortWhileRunning.abort(), 30);
  const res5 = await defaultSpawn(
    process.execPath,
    ["-e", "setTimeout(() => {}, 5000)"],
    { signal: abortWhileRunning.signal },
  );
  assert.ok(res5.error);

  // Test spawn error (invalid executable)
  const res6 = await defaultSpawn("/invalid/path/to/binary_kxm", [], {});
  assert.ok(res6.error);
});

test("One-shot producer defaultSpawn integration and option fallbacks", async () => {
  const fakeAuth = () => ({ detected: true, authenticated: true as const, issues: [] });

  // Custom inventory pointing to node to test end-to-end defaultSpawn execution
  const customInventory = {
    defaultHarness: "node_test" as any,
    harnesses: [
      {
        id: "node_test",
        displayName: "Node Test Harness",
        detected: true,
        authenticated: true,
        issues: [],
      },
    ],
  };

  const customCatalog = [
    {
      id: "node_test",
      displayName: "Node Test Harness",
      commands: [process.execPath],
      aliases: [],
      models: ["eval"],
      defaultModel: "eval",
      oneShot: {
        argv: [
          "-e",
          "process.stdout.write(JSON.stringify({ result: '{\\\"outcome\\\": \\\"passed\\\"}', usage: { input_tokens: 15, output_tokens: 25 } }))",
        ],
        promptVia: "stdin" as const,
        outputFormat: "json" as const,
        usageParser: parseGenericOneShotUsage,
      },
    },
  ];

  const producer = createVnextOneShotProducer({
    defaultHarness: "node_test",
    inventory: customInventory as any,
    catalog: customCatalog as any,
    probeHarness: fakeAuth as any,
  });

  try {
    const res = await producer.produce({
      runId: "run_default_spawn_1",
      stepId: "step_ds",
      stepAttempt: 1,
      assignmentId: "asg_ds",
      attemptId: "att_ds",
      agentId: "evaluator",
      capability: "secret",
      allowedOutcomes: ["passed", "failed"],
      prompt: "test default spawn",
      signal: new AbortController().signal,
    });

    assert.equal(res.harness, "node_test");
    assert.equal(res.outcome, "passed");
    assert.equal(res.tokensIn, null);
    assert.equal(res.tokensOut, null);
  } finally {
    await producer.close();
  }

  // Test resolveModel returning harness when request.harness and resolveHarness are omitted
  let capturedModelOpts: any;
  const resolveModelProducer = createVnextOneShotProducer({
    resolveModel: () => ({ harness: "claude", provider: "anthropic", model: "fable" }),
    probeHarness: fakeAuth as any,
    spawnProcess: async (cmd, args) => {
      capturedModelOpts = args;
      return { stdout: JSON.stringify({ result: "ok" }), stderr: "", code: 0 };
    },
  });
  await resolveModelProducer.produce({
    runId: "run_res_1",
    stepId: "s1",
    stepAttempt: 1,
    assignmentId: "asg_res",
    attemptId: "att_res",
    agentId: "planner",
    capability: "secret",
    allowedOutcomes: ["passed"],
    prompt: "check resolveModel",
    signal: new AbortController().signal,
  });
  await resolveModelProducer.close();

  // Test model spec with slash e.g. "openai/o3"
  const slashProducer = createVnextOneShotProducer({
    defaultHarness: "codex",
    probeHarness: fakeAuth as any,
    spawnProcess: async () => {
      return { stdout: JSON.stringify({ result: "done" }), stderr: "", code: 0 };
    },
  });
  const slashRes = await slashProducer.produce({
    runId: "run_slash_1",
    stepId: "s1",
    stepAttempt: 1,
    assignmentId: "asg_slash",
    attemptId: "att_slash",
    agentId: "reviewer",
    capability: "secret",
    allowedOutcomes: ["completed"],
    model: "custom-lab/custom-model",
    provider: "custom-lab",
    prompt: "check slash model",
    signal: new AbortController().signal,
  });
  assert.equal(slashRes.provider, "custom-lab");
  assert.equal(slashRes.requestedModel, "custom-model");
  await slashProducer.close();
});

// Opt-in real test behind KXM_SMOKE
const smokeTest = process.env.KXM_SMOKE ? test : test.skip;
smokeTest("real Claude one-shot dispatch behind KXM_SMOKE", async () => {
  const producer = createVnextOneShotProducer({ defaultHarness: "claude" });
  try {
    const controller = new AbortController();
    const result = await producer.produce({
      runId: "smoke_oneshot_1",
      stepId: "smoke_step",
      stepAttempt: 1,
      assignmentId: "asg_smoke",
      attemptId: "att_smoke",
      agentId: "planner",
      capability: "secret",
      allowedOutcomes: ["passed"],
      signal: controller.signal,
    });
    assert.equal(result.harness, "claude");
  } finally {
    await producer.close();
  }
});
