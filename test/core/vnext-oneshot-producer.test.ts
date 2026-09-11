import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { before, after } from "node:test";
import { isolateSessionEnvironment } from "../helpers/session-env.ts";
let restoreSession: () => void;
before(() => { restoreSession = isolateSessionEnvironment(); });
after(() => { restoreSession(); });
import { fileURLToPath } from "node:url";
import { loadVnextProject } from "../../plugins/kxm/src/vnext-config.ts";
import {
  driveVnextRun,
  pinVnextCompiledPlan,
} from "../../plugins/kxm/src/vnext-engine.ts";
import {
  acceptVnextRun,
  closeVnextRuntimeContext,
  openVnextRuntimeContext,
} from "../../plugins/kxm/src/vnext-runtime.ts";
import {
  createVnextOneShotProducer,
  defaultSpawn,
  type VnextOneShotProcessResult,
  type VnextOneShotSpawn,
} from "../../plugins/kxm/src/vnext-oneshot-producer.ts";
import {
  parseClaudeOneShotUsage,
  parseCodexOneShotUsage,
  parseGenericOneShotUsage,
  parseKimiOneShotUsage,
  parseAgyOneShotUsage,
  resolveDispatchStatus,
} from "../../plugins/kxm/src/vnext-harness.ts";
import { loadPriceCatalog } from "../../plugins/kxm/src/prices.ts";
import { emitCodexArtifacts } from "../../scripts/emit-codex-artifacts.mjs";
import { makeGitRoot } from "../helpers/git-root.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Code review complete. passed" } }),
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

test("Claude one-shot producer isolates stdin execution and separates reported estimates from billed cost", async () => {
  const fakeAuth = () => ({ detected: true, authenticated: true as const, authMethod: "claude.ai", issues: [] });
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
        result: '{"outcome":"passed","summary":"Task completed successfully."}',
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
    for (const flag of ["--safe-mode", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]) assert.ok(capturedArgs.includes(flag));
    assert.equal(capturedArgs[capturedArgs.indexOf("--tools") + 1], "Read,Glob,Grep");
    assert.equal(capturedArgs[capturedArgs.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
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
    assert.equal(result.costBasis, "unmetered");
    assert.equal(result.costUsd, null);
    assert.equal(result.providerMetadata?.providerReportedCostUsd, 0.0045);
    assert.equal(result.contextTokens, null);
    assert.equal(result.effectiveModel, "unknown");
  } finally {
    await producer.close();
  }
});

test("Codex one-shot producer dispatches with JSONL output and unmetered subscription cost", async () => {
  const fakeAuth = () => ({ detected: true, authenticated: true as const, authMethod: "ChatGPT", issues: [] });

  let capturedCommand = "";
  let capturedArgs: readonly string[] = [];
  let capturedInput: string | undefined;

  const mockSpawn: VnextOneShotSpawn = async (command, args, options) => {
    capturedCommand = command;
    capturedArgs = args;
    capturedInput = options.input;
    return {
      stdout: [
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"outcome":"passed","summary":"Architecture verified."}' } }),
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
    assert.equal(capturedArgs[capturedArgs.indexOf("--sandbox") + 1], "read-only");
    assert.ok(capturedArgs.includes("--ignore-user-config"));
    assert.ok(capturedArgs.includes('approval_policy="never"'));
    assert.ok(!capturedArgs.includes("--full-auto"));
    assert.ok(!capturedArgs.includes("--dangerously-bypass-approvals-and-sandbox"));
    assert.ok(!capturedArgs.includes("--ignore-rules"));
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

for (const cacheReadTokens of [10, 1_000_001]) {
test(`One-shot producer settles in engine with ${cacheReadTokens} cumulative cache-read tokens`, async () => {
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
          result: '{"outcome":"passed"}',
          total_cost_usd: 0.002,
          usage: { input_tokens: 300, output_tokens: 80, cache_read_input_tokens: cacheReadTokens, cache_creation_input_tokens: 5 },
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
        assert.equal(routing.cacheReadTokens, cacheReadTokens > 1_000_000 ? null : cacheReadTokens);
        if (cacheReadTokens > 1_000_000) {
          assert.equal(routing.providerMetadata.rawCacheReadTokens, cacheReadTokens);
        }
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
}

test("Codex artifacts: skills directory and AGENTS.md block are emitted and match check", () => {
  const result = emitCodexArtifacts(repoRoot);

  // Check that the suite manifest exists
  assert.ok(existsSync(join(repoRoot, "plugins", "kxm", "skill-suite.json")));

  // Load the suite manifest to verify it covers all expected skills
  const suiteManifest = JSON.parse(readFileSync(join(repoRoot, "plugins", "kxm", "skill-suite.json"), "utf8"));
  assert.ok(Array.isArray(suiteManifest.skills));
  assert.ok(suiteManifest.skills.length > 0);

  // Check that all skills from the manifest exist in both authored and generated locations
  for (const skill of suiteManifest.skills) {
    const authoredSkillPath = join(repoRoot, "plugins", "kxm", "skills", skill.name, "SKILL.md");
    const generatedSkillPath = join(repoRoot, ".agents", "skills", skill.name, "SKILL.md");

    assert.ok(existsSync(authoredSkillPath), `Authored skill file should exist: ${authoredSkillPath}`);
    assert.ok(existsSync(generatedSkillPath), `Generated skill file should exist: ${generatedSkillPath}`);
  }

  // Check that the protocol reference exists if it's part of a skill
  if (existsSync(join(repoRoot, "plugins", "kxm", "skills", "kxm", "references", "protocol.md"))) {
    assert.ok(existsSync(join(repoRoot, ".agents", "skills", "kxm", "references", "protocol.md")));
  }

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
      capturedInput = opts.input ?? args.at(-1);
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
    assert.ok(capturedInput?.startsWith("Custom prompt text\n\nReturn a final JSON object"));
    assert.ok(capturedInput?.includes('["passed","failed"]'));
  } finally {
    await producer.close();
  }

  // Pi's RPC producer is separate; a generic one-shot cannot inherit its permissions.
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
  await assert.rejects(argProducer.produce({
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
  }), /permission_profile_unaudited/);
  assert.deepEqual(capturedArgs, []);
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

test("One-shot rejects unprofiled executables and preserves native option resolution", async () => {
  const fakeAuth = () => ({ detected: true, authenticated: true as const, issues: [] });

  // Authenticated custom inventory cannot authorize arbitrary executable permissions.
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
          "--", // Node must treat the test harness flags as script arguments.
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
    await assert.rejects(producer.produce({
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
    }), /permission_profile_unaudited/);
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

test("parseKimiOneShotUsage parses stream-json events, plain text, and errors", () => {
  // Multiple stream-json lines with assistant chunks
  const streamOutput = [
    JSON.stringify({ role: "meta", type: "system.version", version: "0.41.0" }),
    JSON.stringify({ role: "assistant", content: "First part of answer." }),
    JSON.stringify({ role: "assistant", content: "Second part of answer." }),
    JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: "s1" }),
  ].join("\n");

  const parsed = parseKimiOneShotUsage(streamOutput, "");
  assert.equal(parsed.isError, false);
  assert.equal(parsed.text, "First part of answer.\nSecond part of answer.");
  assert.equal(parsed.usage?.tokensIn, null);
  assert.equal(parsed.usage?.tokensOut, null);
  assert.equal(parsed.usage?.cacheReadTokens, null);

  // Error stream
  const errorOutput = JSON.stringify({ role: "error", message: "model rate limit reached" });
  const errorParsed = parseKimiOneShotUsage(errorOutput, "");
  assert.equal(errorParsed.isError, true);
  assert.equal(errorParsed.errorMessage, "model rate limit reached");

  // Fallback plain text
  const plainParsed = parseKimiOneShotUsage("Plain text answer from kimi", "");
  assert.equal(plainParsed.text, "Plain text answer from kimi");
  assert.equal(plainParsed.isError, false);
  assert.equal(plainParsed.usage?.tokensIn, null);
});

test("parseAgyOneShotUsage parses Antigravity JSON payload, usage, and errors", () => {
  const successOutput = JSON.stringify({
    conversation_id: "agy-conv-123",
    status: "SUCCESS",
    response: "Analysis complete. All requirements satisfied.",
    duration_seconds: 2.5,
    num_turns: 1,
    usage: {
      input_tokens: 45,
      output_tokens: 30,
      cache_read_tokens: 15,
      total_tokens: 90,
    },
  });

  const parsed = parseAgyOneShotUsage(successOutput, "");
  assert.equal(parsed.isError, false);
  assert.equal(parsed.text, "Analysis complete. All requirements satisfied.");
  assert.equal(parsed.usage?.tokensIn, 45);
  assert.equal(parsed.usage?.tokensOut, 30);
  assert.equal(parsed.usage?.cacheReadTokens, 15);
  assert.equal(parsed.usage?.contextTokens, 90);

  // Error output
  const errorOutput = JSON.stringify({
    conversation_id: "agy-err",
    status: "ERROR",
    error: "timeout waiting for response",
    response: "",
  });
  const errorParsed = parseAgyOneShotUsage(errorOutput, "");
  assert.equal(errorParsed.isError, true);
  assert.equal(errorParsed.errorMessage, "timeout waiting for response");

  // Fallback plain text
  const plainParsed = parseAgyOneShotUsage("Plain text agy response", "");
  assert.equal(plainParsed.text, "Plain text agy response");
  assert.equal(plainParsed.usage?.tokensIn, null);
});

test("Kimi one-shot execution refuses unaudited permissions despite authentication", async () => {
  const fakeAuth = () => ({ detected: true, authenticated: true as const, issues: [] });

  let capturedArgs: readonly string[] = [];
  const kimiProducer = createVnextOneShotProducer({
    defaultHarness: "kimi",
    probeHarness: fakeAuth as any,
    spawnProcess: async (cmd, args) => {
      capturedArgs = args;
      return {
        stdout: [
          JSON.stringify({ role: "meta", type: "system.version", version: "0.41.0" }),
          JSON.stringify({ role: "assistant", content: '{"outcome": "passed"}' }),
        ].join("\n"),
        stderr: "",
        code: 0,
      };
    },
  });

  try {
    await assert.rejects(kimiProducer.produce({
      runId: "run_kimi_1",
      stepId: "step_kimi",
      stepAttempt: 1,
      assignmentId: "asg_kimi",
      attemptId: "att_kimi",
      agentId: "portability_reviewer",
      capability: "secret",
      allowedOutcomes: ["passed", "failed"],
      model: "kimi-k2",
      prompt: "Review Windows path portability",
      signal: new AbortController().signal,
    }), /permission_profile_unaudited/);
    assert.deepEqual(capturedArgs, []);
  } finally {
    await kimiProducer.close();
  }
});

test("AGY subscription auth does not authorize an unaudited one-shot permission profile", async () => {
  const fakeAuth = () => ({ detected: true, authenticated: true as const, authMethod: "antigravity-oauth", issues: [] });

  let capturedArgs: readonly string[] = [];
  const agyProducer = createVnextOneShotProducer({
    defaultHarness: "agy",
    probeHarness: fakeAuth as any,
    spawnProcess: async (cmd, args) => {
      capturedArgs = args;
      return {
        stdout: JSON.stringify({
          conversation_id: "agy-conv-test",
          status: "SUCCESS",
          response: '{"outcome": "passed"}',
          usage: {
            input_tokens: 50,
            output_tokens: 25,
            cache_read_tokens: 10,
            total_tokens: 85,
          },
        }),
        stderr: "",
        code: 0,
      };
    },
  });

  try {
    await assert.rejects(agyProducer.produce({
      runId: "run_agy_1",
      stepId: "step_agy",
      stepAttempt: 1,
      assignmentId: "asg_agy",
      attemptId: "att_agy",
      agentId: "writer",
      capability: "secret",
      allowedOutcomes: ["passed", "failed"],
      model: "gemini-3.8-flash-high",
      thinking: "medium",
      prompt: "Implement feature in repository",
      signal: new AbortController().signal,
    }), /permission_profile_unaudited/);
    assert.deepEqual(capturedArgs, []);
  } finally {
    await agyProducer.close();
  }
});

test("Gemini CLI is non-dispatchable and fails closed with clear message", async () => {
  const fakeAuth = () => ({ detected: true, authenticated: true as const, issues: [] });

  const geminiProducer = createVnextOneShotProducer({
    defaultHarness: "legacy-gemini",
    probeHarness: fakeAuth as any,
    spawnProcess: async () => ({ stdout: "", stderr: "", code: 0 }),
  });

  await assert.rejects(
    async () => {
      await geminiProducer.produce({
        runId: "run_gemini_1",
        stepId: "step_gemini",
        stepAttempt: 1,
        assignmentId: "asg_gem",
        attemptId: "att_gem",
        agentId: "writer",
        capability: "secret",
        allowedOutcomes: ["passed"],
        signal: new AbortController().signal,
      });
    },
    /oneshot_harness_unsupported: legacy-gemini/,
  );
  await geminiProducer.close();
});

test("resolveDispatchStatus calculates dispatch availability and reason accurately", () => {
  const catalogEntryWithOneShot = {
    id: "claude",
    label: "Test fixture",
    default: false,
    mode: "either" as const,
    commands: ["test"],
    versionArgs: ["--version"],
    update: { self: [] },
    oneShot: {
      argv: ["-p"],
      promptVia: "arg" as const,
      outputFormat: "json" as const,
      usageParser: () => ({ text: "", usage: {} }),
    },
  };

  const catalogEntryWithoutOneShot = {
    id: "legacy-gemini",
    label: "Legacy Gemini CLI",
    default: false,
    mode: "either" as const,
    commands: ["gemini"],
    versionArgs: ["--version"],
    update: { self: [] },
  };

  // Undetected
  const notDetected = resolveDispatchStatus(catalogEntryWithOneShot, false, true, []);
  assert.equal(notDetected.status, "no");
  assert.equal(notDetected.reason, "not_detected");

  // No headless mode
  const noHeadless = resolveDispatchStatus(catalogEntryWithoutOneShot, true, true, []);
  assert.equal(noHeadless.status, "no");
  assert.equal(noHeadless.reason, "no_headless_mode");

  // Not authenticated
  const unauthenticated = resolveDispatchStatus(catalogEntryWithOneShot, true, false, ["not_authenticated"]);
  assert.equal(unauthenticated.status, "no");
  assert.equal(unauthenticated.reason, "not_authenticated");

  // Auth unknown
  const authUnknown = resolveDispatchStatus(catalogEntryWithOneShot, true, null, ["auth_unknown"]);
  assert.equal(authUnknown.status, "no");
  assert.equal(authUnknown.reason, "auth_unknown");

  // Ready and dispatchable
  const ready = resolveDispatchStatus(catalogEntryWithOneShot, true, true, []);
  assert.equal(ready.status, "yes");
  assert.equal(ready.supported, true);
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

test.skip("Kimi live one-shot deferred: permission profile unaudited", async () => {
  const producer = createVnextOneShotProducer({ defaultHarness: "kimi" });
  try {
    const controller = new AbortController();
    const result = await producer.produce({
      runId: "smoke_kimi_1",
      stepId: "smoke_step",
      stepAttempt: 1,
      assignmentId: "asg_smoke_kimi",
      attemptId: "att_smoke_kimi",
      agentId: "portability",
      capability: "secret",
      allowedOutcomes: ["completed"],
      prompt: "respond with completed",
      signal: controller.signal,
    });
    assert.equal(result.harness, "kimi");
  } finally {
    await producer.close();
  }
});

test.skip("AGY live one-shot deferred: permission profile unaudited", async () => {
  const producer = createVnextOneShotProducer({ defaultHarness: "agy" });
  try {
    const controller = new AbortController();
    const result = await producer.produce({
      runId: "smoke_agy_1",
      stepId: "smoke_step",
      stepAttempt: 1,
      assignmentId: "asg_smoke_agy",
      attemptId: "att_smoke_agy",
      agentId: "writer",
      capability: "secret",
      model: "gemini-3.8-flash-high",
      allowedOutcomes: ["completed"],
      prompt: "respond with completed",
      signal: controller.signal,
    });
    assert.equal(result.harness, "agy");
  } finally {
    await producer.close();
  }
});
