import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { makeGitRoot } from "../helpers/git-root.ts";
import { loadKxmProject } from "../../plugins/kxm/src/project-config.ts";
import {
  createKxmSimulatedProducer,
  driveKxmRun,
  pinKxmCompiledPlan,
  startKxmRun,
  stepKxmRun,
} from "../../plugins/kxm/src/engine.ts";
import { kxmAttemptFinalOutcome } from "../../plugins/kxm/src/engine-plan.ts";
import {
  acceptKxmRun,
  closeKxmRuntimeContext,
  openKxmRuntimeContext,
} from "../../plugins/kxm/src/runtime-service.ts";
import {
  ROUTING_RECORD_V2_SCHEMA,
  type RoutingRecordV2,
  parseRoutingRecordV2,
  generateRoutingReport,
  formatRoutingReport,
  ROUTING_REPORT_SCHEMA,
} from "../../plugins/kxm/src/routing.ts";
import {
  loadPriceCatalog,
  findModelPrice,
  calculateModelCost,
  hashPriceCatalog,
} from "../../plugins/kxm/src/prices.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOME = "rtm_01JROUTING00000000000000";
const NODE = process.execPath;

interface RoutingTestEnv {
  root: string;
  stateRoot: string;
  cleanup: () => void;
}

function setupRoutingEnv(prefix = "kxm-routing-"): RoutingTestEnv {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const stateRoot = mkdtempSync(join(tmpdir(), `${prefix}state-`));
  cpSync(join(repoRoot, "examples/project"), root, { recursive: true });

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
    argv: [${JSON.stringify(NODE)}, ${JSON.stringify(gateScriptPath)}]
    timeoutMs: 3600000
  scm-delivery:
    kind: command
    argv: [${JSON.stringify(NODE)}, ${JSON.stringify(gateScriptPath)}]
    timeoutMs: 1800000
`,
  );

  spawnSync("git", ["-C", root, "add", "-A"], { windowsHide: true });
  spawnSync(
    "git",
    ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "init"],
    { windowsHide: true },
  );

  return {
    root,
    stateRoot,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    },
  };
}

test("D5 Gate: N attempts leave N routing records with required costBasis", async () => {
  const env = setupRoutingEnv("kxm-d5-n-attempts-");
  try {
    const bundle = loadKxmProject(env.root);
    const context = openKxmRuntimeContext(env.root, { stateRoot: env.stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptKxmRun(context, bundle, { workflowId: "default", prompt: "default run" });
      pinKxmCompiledPlan(context, bundle, accepted.run.runId);

      const producer = createKxmSimulatedProducer(async () => {
        return { outcome: "passed" };
      });

      const result = await driveKxmRun(context, accepted.run.runId, producer, { allowLimits: true });
      assert.equal(result.state.status, "completed");

      const events = context.eventStore.events(accepted.run.runId, 0, 1000);
      const routingEvents = events.filter((e) => e.eventType === "routing.attempt.recorded");

      // default.yaml has 3 agent steps: plan, implement, and ready
      assert.equal(routingEvents.length, 3, "N attempts leave N routing records");

      for (const event of routingEvents) {
        const payload = event.payload as { routing: RoutingRecordV2 };
        assert.ok(payload.routing, "payload contains routing record");
        assert.equal(payload.routing.schema, ROUTING_RECORD_V2_SCHEMA);
        assert.equal(payload.routing.costBasis, "unmetered");
        assert.equal(typeof payload.routing.latencyMs, "number");
        assert.ok(payload.routing.latencyMs >= 0);
        assert.equal(payload.routing.runId, accepted.run.runId);
      }

      const routingOf = (runId: string): RoutingRecordV2[] => context.eventStore.events(runId, 0, 1000)
        .filter((e) => e.eventType === "routing.attempt.recorded")
        .map((e) => (e.payload as { routing: RoutingRecordV2 }).routing);

      // Run 2: the same workflow and prompt in a new run.
      const second = acceptKxmRun(context, bundle, { workflowId: "default", prompt: "default run" });
      pinKxmCompiledPlan(context, bundle, second.run.runId);
      assert.equal((await driveKxmRun(context, second.run.runId, producer, { allowLimits: true })).state.status, "completed");

      // The engine reserves the ask-identity keys: stable across runs for the same
      // step and agent, and never derived from anything a run chose.
      const byStep = [routingOf(accepted.run.runId), routingOf(second.run.runId)].map((records) => {
        assert.deepEqual(records.map((record) => record.stepId), ["plan", "implement", "ready"]);
        return Object.fromEntries(records.map((record) => [record.stepId, record])) as Record<string, RoutingRecordV2>;
      });
      for (const records of byStep) {
        for (const [stepId, role, writes] of [["plan", "planner", false], ["implement", "implementer", true], ["ready", "planner", false]] as const) {
          const record = records[stepId]!;
          assert.equal(record.providerMetadata?.workflowId, "default");
          assert.match(String(record.providerMetadata?.askSha256), /^sha256:[a-f0-9]{64}$/);
          assert.equal(record.providerMetadata?.stepWrites, writes, `${stepId} stepWrites`);
          assert.equal(record.agentRole, role, `${stepId} agentRole`);
          assert.equal(record.finalOutcome, undefined, "forward edges and completed terminals are undecided at record time");
        }
        assert.notEqual(records.plan!.providerMetadata?.askSha256, records.ready!.providerMetadata?.askSha256);
      }
      for (const stepId of ["plan", "implement", "ready"]) {
        assert.equal(byStep[0]![stepId]!.providerMetadata?.askSha256, byStep[1]![stepId]!.providerMetadata?.askSha256, `${stepId} askSha256 is stable across runs`);
        assert.equal(byStep[0]![stepId]!.providerMetadata?.objectiveSha256, byStep[1]![stepId]!.providerMetadata?.objectiveSha256);
        assert.equal(byStep[0]![stepId]!.providerMetadata?.objectiveSha256, accepted.run.promptSha256);
      }

      // Run 3: plan returns 'blocked', a terminal failure edge.
      const blocked = acceptKxmRun(context, bundle, { workflowId: "default", prompt: "blocked run" });
      pinKxmCompiledPlan(context, bundle, blocked.run.runId);
      const blockedProducer = createKxmSimulatedProducer(async (request) => ({ outcome: request.stepId === "plan" ? "blocked" : "passed" }));
      await driveKxmRun(context, blocked.run.runId, blockedProducer, { allowLimits: true });
      const blockedPlan = routingOf(blocked.run.runId).find((record) => record.stepId === "plan");
      assert.equal(blockedPlan?.finalOutcome, "failed");

      // Run 4: the producer throws on plan.
      const thrown = acceptKxmRun(context, bundle, { workflowId: "default", prompt: "throwing run" });
      pinKxmCompiledPlan(context, bundle, thrown.run.runId);
      const throwingProducer = createKxmSimulatedProducer(async (request) => {
        if (request.stepId === "plan") throw new Error("producer_error");
        return { outcome: "passed" };
      });
      await driveKxmRun(context, thrown.run.runId, throwingProducer, { allowLimits: true });
      const thrownPlan = routingOf(thrown.run.runId).find((record) => record.stepId === "plan");
      assert.equal(thrownPlan?.finalOutcome, "failed");
      assert.equal(thrownPlan?.agentRole, "planner");
      assert.equal(thrownPlan?.providerMetadata?.workflowId, "default");

      for (const runId of [accepted.run.runId, second.run.runId, blocked.run.runId, thrown.run.runId]) {
        for (const record of routingOf(runId)) assert.deepEqual(parseRoutingRecordV2(record), record);
      }

      const transitions = {
        retry: { to: "step", target: "plan", edge: "back" },
        next: { to: "step", target: "ready", edge: "forward" },
        done: { to: "terminal", terminalStatus: "completed" },
      } as const;
      assert.equal(kxmAttemptFinalOutcome({ transitions }, { resultClass: "outcome", outcome: "retry" }), "blocked");
      assert.equal(kxmAttemptFinalOutcome({ transitions }, { resultClass: "outcome", outcome: "next" }), undefined);
      assert.equal(kxmAttemptFinalOutcome({ transitions }, { resultClass: "outcome", outcome: "done" }), undefined);
      assert.equal(kxmAttemptFinalOutcome({ transitions }, { resultClass: "outcome", outcome: "missing" }), "failed");
      assert.equal(kxmAttemptFinalOutcome({ transitions }, { resultClass: "producer_rejected" }), "failed");
    } finally {
      closeKxmRuntimeContext(context);
    }
  } finally {
    env.cleanup();
  }
});

test("D5 Gate: missing costBasis is rejected during attempt settlement", async () => {
  const env = setupRoutingEnv("kxm-d5-missing-costbasis-");
  try {
    const bundle = loadKxmProject(env.root);
    const context = openKxmRuntimeContext(env.root, { stateRoot: env.stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptKxmRun(context, bundle, { workflowId: "default", prompt: "default run" });
      pinKxmCompiledPlan(context, bundle, accepted.run.runId);
      startKxmRun(context, accepted.run.runId, { allowLimits: true });

      // Producer explicitly omits or passes undefined costBasis
      const producer = createKxmSimulatedProducer(async () => {
        return { outcome: "passed", costBasis: undefined } as any;
      });

      await assert.rejects(
        async () => {
          await stepKxmRun(context, accepted.run.runId, producer);
        },
        /costBasis/,
      );
    } finally {
      closeKxmRuntimeContext(context);
    }
  } finally {
    env.cleanup();
  }
});

test("D5 Gate: a run past its metered cap refuses the next dispatch", async () => {
  const env = setupRoutingEnv("kxm-d5-metered-cap-");
  try {
    // Add maxModelCost to default workflow in test env
    const workflowPath = join(env.root, ".kxm", "workflows", "default.yaml");
    const existing = readFileSync(workflowPath, "utf8");
    const updated = existing.replace("limits:\n", "limits:\n  maxModelCost: 0.50\n");
    writeFileSync(workflowPath, updated);
    spawnSync("git", ["-C", env.root, "add", "-A"], { windowsHide: true });
    spawnSync(
      "git",
      ["-C", env.root, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "update limits"],
      { windowsHide: true },
    );

    const bundle = loadKxmProject(env.root);
    const context = openKxmRuntimeContext(env.root, { stateRoot: env.stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptKxmRun(context, bundle, { workflowId: "default", prompt: "metered cost run" });
      pinKxmCompiledPlan(context, bundle, accepted.run.runId);
      startKxmRun(context, accepted.run.runId, { allowLimits: true });

      // First step incurs metered cost of 0.75, exceeding the 0.50 maxModelCost limit
      const producer = createKxmSimulatedProducer(async (req) => {
        return {
          outcome: "passed",
          costBasis: "metered",
          costUsd: 0.75,
          tokensIn: 1000,
          tokensOut: 500,
        };
      });

      // First step executes and settles
      const step1 = await stepKxmRun(context, accepted.run.runId, producer);
      assert.equal(step1.state.status, "running");

      // Next step dispatch should be refused due to exceeding maxModelCost
      const step2 = await stepKxmRun(context, accepted.run.runId, producer);
      assert.equal(step2.state.status, "failed");
      assert.equal(step2.state.failureReason, "budget_model_cost");
    } finally {
      closeKxmRuntimeContext(context);
    }
  } finally {
    env.cleanup();
  }
});

test("D5 Price Catalog: loads, verifies hash, and resolves models", () => {
  const catalog = loadPriceCatalog(join(repoRoot, "test/fixtures/prices/catalog.yaml"));
  assert.ok(catalog, "catalog loaded from repo root");
  assert.equal(catalog.schema, "kxm.prices.v1");
  assert.equal(catalog.date, "2026-09-08");

  // Verify hash matches content
  const expectedHash = hashPriceCatalog(catalog);
  assert.equal(catalog.sha256, expectedHash, "catalog sha256 matches canonical hash");

  // Verify Claude, Codex, Grok, GLM, Kimi, Qwen are present
  const claude = findModelPrice(catalog, "fable");
  assert.ok(claude, "fable found via alias");
  assert.equal(claude.provider, "anthropic");

  const codex = findModelPrice(catalog, "gpt-5.6-sol");
  assert.ok(codex, "gpt-5.6-sol found");
  assert.equal(codex.provider, "openai");

  const grok = findModelPrice(catalog, "grok-4.6");
  assert.ok(grok, "grok-4.6 found");
  assert.equal(grok.provider, "xai");

  const glm = findModelPrice(catalog, "glm-4-plus");
  assert.ok(glm, "glm-4-plus found");
  assert.equal(glm.provider, "zhipu");

  const kimi = findModelPrice(catalog, "kimi-k1.5");
  assert.ok(kimi, "kimi-k1.5 found");
  assert.equal(kimi.provider, "moonshot");

  const qwen = findModelPrice(catalog, "openrouter/qwen/qwen3-coder-plus");
  assert.ok(qwen, "qwen3-coder-plus found via alias");
  assert.equal(qwen.provider, "alibaba");

  // Unlisted model returns undefined (unknown)
  const unknown = findModelPrice(catalog, "unlisted-model-1234");
  assert.equal(unknown, undefined, "unlisted model returns undefined");
});

test("D5 Price Catalog: estimates cost from complete usage and observed context", () => {
  const catalog = loadPriceCatalog(join(repoRoot, "test/fixtures/prices/catalog.yaml"));
  assert.ok(catalog);

  // Grok 4.6: $2.00 / 1M input, $10.00 / 1M output, $0.50 / 1M cache read
  // 100,000 in, 10,000 out, 50,000 cache read
  // cost = (100k/1M)*2.00 + (10k/1M)*10.00 + (50k/1M)*0.50
  //      = 0.20 + 0.10 + 0.025 = 0.325
  const result = calculateModelCost(catalog, {
    model: "grok-4.6",
    tokensIn: 100_000,
    tokensOut: 10_000,
    cacheReadTokens: 50_000,
    cacheWriteTokens: 0,
    contextTokens: 25_000,
  });
  assert.ok(result);
  assert.equal(result.costUsd, 0.325);
  assert.equal(result.priceRef, "2026-09-08#xai/grok-4.6");

  // Unknown model returns undefined
  const unknown = calculateModelCost(catalog, { model: "unknown-model", tokensIn: 1000 });
  assert.equal(unknown, undefined);
});

test("D5 Routing Parser: validates v2 schema fields and fails closed", () => {
  const valid = {
    schema: ROUTING_RECORD_V2_SCHEMA,
    recordedAt: new Date().toISOString(),
    project: "kxm",
    runId: "run_123",
    stepId: "plan",
    assignmentId: "asg_123",
    attemptId: "att_123",
    harness: "pi",
    provider: "xai",
    requestedModel: "grok-4.6",
    effectiveModel: "grok-4.6",
    behavioralSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    latencyMs: 1500,
    costBasis: "metered",
    costUsd: 0.15,
    retries: 0,
  };
  const parsed = parseRoutingRecordV2(valid);
  assert.equal(parsed.schema, ROUTING_RECORD_V2_SCHEMA);
  assert.equal(parsed.costBasis, "metered");
  assert.equal(parsed.costUsd, 0.15);

  // Metered missing costUsd fails
  assert.throws(() => {
    parseRoutingRecordV2({ ...valid, costUsd: undefined });
  }, /costUsd/);

  // Negative costUsd fails
  assert.throws(() => {
    parseRoutingRecordV2({ ...valid, costUsd: -1 });
  }, /costUsd/);

  // Negative latencyMs fails
  assert.throws(() => {
    parseRoutingRecordV2({ ...valid, latencyMs: -10 });
  }, /latencyMs/);

  // Invalid costBasis fails
  assert.throws(() => {
    parseRoutingRecordV2({ ...valid, costBasis: "invalid-basis" });
  }, /costBasis/);
});

test("E3 Gate: Routing Report groups by (harness, model, thinking, role), computes metrics, and ranks quality first", () => {
  const records: RoutingRecordV2[] = [
    // Route A: pi / grok-4.6 / medium / implement - 2 attempts, both pass, 0 transitions, metered $0.05 each
    {
      schema: ROUTING_RECORD_V2_SCHEMA,
      recordedAt: "2026-09-08T00:00:00.000Z",
      project: "kxm",
      runId: "run-1",
      stepId: "impl",
      assignmentId: "asg-1",
      attemptId: "att-1",
      harness: "pi",
      provider: "xai",
      requestedModel: "grok-4.6",
      effectiveModel: "grok-4.6",
      thinking: "medium",
      agentRole: "implement",
      behavioralSha256: "a".repeat(64),
      latencyMs: 1000,
      tokensIn: 5000,
      tokensOut: 1000,
      contextTokens: 5000,
      costBasis: "metered",
      costUsd: 0.05,
      verifierOutcome: "passed",
      finalOutcome: "accepted",
      retries: 0,
      transitions: 0,
    },
    {
      schema: ROUTING_RECORD_V2_SCHEMA,
      recordedAt: "2026-09-08T00:01:00.000Z",
      project: "kxm",
      runId: "run-2",
      stepId: "impl",
      assignmentId: "asg-2",
      attemptId: "att-2",
      harness: "pi",
      provider: "xai",
      requestedModel: "grok-4.6",
      effectiveModel: "grok-4.6",
      thinking: "medium",
      agentRole: "implement",
      behavioralSha256: "a".repeat(64),
      latencyMs: 2000,
      tokensIn: 7000,
      tokensOut: 1200,
      contextTokens: 7000,
      costBasis: "metered",
      costUsd: 0.05,
      verifierOutcome: "passed",
      finalOutcome: "accepted",
      retries: 0,
      transitions: 0,
    },
    // Route B: claude / fable / medium / plan - 2 attempts, both pass, 1 back-edge re-entry (transitions: 1), unmetered
    {
      schema: ROUTING_RECORD_V2_SCHEMA,
      recordedAt: "2026-09-08T00:02:00.000Z",
      project: "kxm",
      runId: "run-3",
      stepId: "plan",
      assignmentId: "asg-3",
      attemptId: "att-3",
      harness: "claude",
      provider: "anthropic",
      requestedModel: "fable",
      effectiveModel: "fable",
      thinking: "medium",
      agentRole: "plan",
      behavioralSha256: "b".repeat(64),
      latencyMs: 3000,
      tokensIn: 10000,
      tokensOut: 2000,
      contextTokens: 10000,
      costBasis: "unmetered",
      verifierOutcome: "passed",
      finalOutcome: "accepted",
      retries: 0,
      transitions: 0,
    },
    {
      schema: ROUTING_RECORD_V2_SCHEMA,
      recordedAt: "2026-09-08T00:03:00.000Z",
      project: "kxm",
      runId: "run-4",
      stepId: "plan",
      assignmentId: "asg-4",
      attemptId: "att-4",
      harness: "claude",
      provider: "anthropic",
      requestedModel: "fable",
      effectiveModel: "fable",
      thinking: "medium",
      agentRole: "plan",
      behavioralSha256: "b".repeat(64),
      latencyMs: 4000,
      tokensIn: 12000,
      tokensOut: 2500,
      contextTokens: 12000,
      costBasis: "unmetered",
      verifierOutcome: "passed",
      finalOutcome: "accepted",
      retries: 0,
      transitions: 1, // back-edge re-entry
    },
    // Route C: pi / qwen3-coder-plus / none / implement - 1 attempt, failed, quota exhausted, unknown cost
    {
      schema: ROUTING_RECORD_V2_SCHEMA,
      recordedAt: "2026-09-08T00:04:00.000Z",
      project: "kxm",
      runId: "run-5",
      stepId: "impl",
      assignmentId: "asg-5",
      attemptId: "att-5",
      harness: "pi",
      provider: "alibaba",
      requestedModel: "qwen3-coder-plus",
      effectiveModel: "qwen3-coder-plus",
      thinking: "none",
      agentRole: "implement",
      behavioralSha256: "c".repeat(64),
      latencyMs: 500,
      tokensIn: 2000,
      tokensOut: 100,
      contextTokens: 2000,
      costBasis: "unknown",
      verifierOutcome: "failed",
      finalOutcome: "failed",
      retries: 1,
      transitions: 0, // intra-stage retry does not count as rework
      providerMetadata: {
        quota_exhausted: true,
      },
    },
  ];

  const report = generateRoutingReport(records, {
    now: () => "2026-09-08T01:00:00.000Z",
  });

  assert.equal(report.schema, ROUTING_REPORT_SCHEMA);
  assert.equal(report.totalAttempts, 5);
  assert.equal(report.rows.length, 3);

  // Group 1 (ranked #1): pi / grok-4.6 / medium / implement
  // verifyPassRate 1.0, reworkRate 0.0 beats Route B's reworkRate 0.5
  const rowA = report.rows[0]!;
  assert.equal(rowA.harness, "pi");
  assert.equal(rowA.model, "grok-4.6");
  assert.equal(rowA.thinking, "medium");
  assert.equal(rowA.role, "implement");
  assert.equal(rowA.attempts, 2);
  assert.equal(rowA.verifyPassRate, 1.0);
  assert.equal(rowA.reworkRate, 0.0);
  assert.equal(rowA.latencyP50Ms, 1500);
  assert.equal(rowA.latencyP95Ms, 1950);
  assert.equal(rowA.medianContextTokens, 6000);
  assert.equal(rowA.meteredCostUsd, 0.1);
  assert.equal(rowA.costPerAcceptedUsd, 0.05);
  assert.equal(rowA.unmeteredAttempts, 0);
  assert.equal(rowA.unknownCostAttempts, 0);
  assert.equal(rowA.quotaExhaustedAttempts, 0);
  assert.equal(rowA.flagged, false);

  // Group 2 (ranked #2): claude / fable / medium / plan
  // verifyPassRate 1.0, reworkRate 0.5
  const rowB = report.rows[1]!;
  assert.equal(rowB.harness, "claude");
  assert.equal(rowB.model, "fable");
  assert.equal(rowB.attempts, 2);
  assert.equal(rowB.verifyPassRate, 1.0);
  assert.equal(rowB.reworkRate, 0.5); // 1 out of 2 had transitions > 0
  assert.equal(rowB.latencyP50Ms, 3500);
  assert.equal(rowB.latencyP95Ms, 3950);
  assert.equal(rowB.medianContextTokens, 11000);
  assert.equal(rowB.unmeteredAttempts, 2);
  assert.equal(rowB.unknownCostAttempts, 0);
  assert.equal(rowB.quotaExhaustedAttempts, 0);
  assert.equal(rowB.flagged, false);

  // Group 3 (ranked #3): pi / qwen3-coder-plus / none / implement
  // verifyPassRate 0.0, reworkRate 0.0 (retries > 0 but transitions === 0)
  const rowC = report.rows[2]!;
  assert.equal(rowC.harness, "pi");
  assert.equal(rowC.model, "qwen3-coder-plus");
  assert.equal(rowC.attempts, 1);
  assert.equal(rowC.verifyPassRate, 0.0);
  assert.equal(rowC.reworkRate, 0.0);
  assert.equal(rowC.unmeteredAttempts, 0);
  assert.equal(rowC.unknownCostAttempts, 1);
  assert.equal(rowC.quotaExhaustedAttempts, 1);
  assert.equal(rowC.flagged, true);
});

test("E3 Gate: unknown cost is never ranked cheaper than metered cost", () => {
  const records: RoutingRecordV2[] = [
    // Route X: quality 1.0, metered cost $0.50
    {
      schema: ROUTING_RECORD_V2_SCHEMA,
      recordedAt: "2026-09-08T00:00:00.000Z",
      project: "kxm",
      runId: "run-x",
      stepId: "step",
      assignmentId: "asg-x",
      attemptId: "att-x",
      harness: "pi",
      provider: "p",
      requestedModel: "model-metered",
      effectiveModel: "model-metered",
      thinking: "medium",
      agentRole: "implement",
      behavioralSha256: "x".repeat(64),
      latencyMs: 1000,
      costBasis: "metered",
      costUsd: 0.50,
      verifierOutcome: "passed",
      finalOutcome: "accepted",
      retries: 0,
    },
    // Route Y: quality 1.0, unknown cost (flagged, never ranked cheaper)
    {
      schema: ROUTING_RECORD_V2_SCHEMA,
      recordedAt: "2026-09-08T00:00:00.000Z",
      project: "kxm",
      runId: "run-y",
      stepId: "step",
      assignmentId: "asg-y",
      attemptId: "att-y",
      harness: "pi",
      provider: "p",
      requestedModel: "model-unknown",
      effectiveModel: "model-unknown",
      thinking: "medium",
      agentRole: "implement",
      behavioralSha256: "y".repeat(64),
      latencyMs: 1000,
      costBasis: "unknown",
      verifierOutcome: "passed",
      finalOutcome: "accepted",
      retries: 0,
    },
  ];

  const report = generateRoutingReport(records);
  assert.equal(report.rows.length, 2);
  // Metered route ranks before unknown route despite having $0.50 vs unknown cost
  assert.equal(report.rows[0]?.model, "model-metered");
  assert.equal(report.rows[1]?.model, "model-unknown");
  assert.equal(report.rows[1]?.flagged, true);
});

test("E3 Gate: Report formatting and snapshot test", () => {
  const catalog = loadPriceCatalog(join(repoRoot, "test/fixtures/prices/catalog.yaml"));
  const records: RoutingRecordV2[] = [
    {
      schema: ROUTING_RECORD_V2_SCHEMA,
      recordedAt: "2026-09-08T00:00:00.000Z",
      project: "kxm",
      runId: "run-1",
      stepId: "impl",
      assignmentId: "asg-1",
      attemptId: "att-1",
      harness: "grok",
      provider: "xai",
      requestedModel: "grok-4.6",
      effectiveModel: "grok-4.6",
      thinking: "medium",
      agentRole: "implement",
      behavioralSha256: "1".repeat(64),
      latencyMs: 1200,
      tokensIn: 10000,
      tokensOut: 2000,
      contextTokens: 10000,
      costBasis: "metered",
      costUsd: 0.04,
      verifierOutcome: "passed",
      finalOutcome: "accepted",
      retries: 0,
      transitions: 0,
    },
    {
      schema: ROUTING_RECORD_V2_SCHEMA,
      recordedAt: "2026-09-08T00:01:00.000Z",
      project: "kxm",
      runId: "run-2",
      stepId: "plan",
      assignmentId: "asg-2",
      attemptId: "att-2",
      harness: "claude",
      provider: "anthropic",
      requestedModel: "fable",
      effectiveModel: "fable",
      thinking: "medium",
      agentRole: "plan",
      behavioralSha256: "2".repeat(64),
      latencyMs: 2500,
      tokensIn: 20000,
      tokensOut: 4000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      contextTokens: 20000,
      costBasis: "unmetered",
      verifierOutcome: "passed",
      finalOutcome: "accepted",
      retries: 0,
      transitions: 1,
    },
    {
      schema: ROUTING_RECORD_V2_SCHEMA,
      recordedAt: "2026-09-08T00:02:00.000Z",
      project: "kxm",
      runId: "run-3",
      stepId: "review",
      assignmentId: "asg-3",
      attemptId: "att-3",
      harness: "pi",
      provider: "openai",
      requestedModel: "gpt-5.6-sol",
      effectiveModel: "gpt-5.6-sol",
      thinking: "low",
      agentRole: "review",
      behavioralSha256: "3".repeat(64),
      latencyMs: 800,
      tokensIn: 5000,
      tokensOut: 500,
      contextTokens: 5000,
      costBasis: "unknown",
      verifierOutcome: "passed",
      finalOutcome: "accepted",
      retries: 0,
      transitions: 0,
    },
  ];

  const report = generateRoutingReport(records, {
    catalog,
    includeEquivalentListCost: true,
  });

  const formatted = formatRoutingReport(report, { equivalentListCost: true });
  assert.ok(formatted.includes("Routing Telemetry Report (3 attempt(s) across 3 route(s), quality-first ranking)"));
  assert.ok(formatted.includes("Harness    Model"));
  assert.ok(formatted.includes("ListEquiv($)"));
  assert.ok(formatted.includes("grok       grok-4.6"));
  assert.ok(formatted.includes("claude     fable"));
  assert.ok(formatted.includes("pi         gpt-5.6-sol"));
  assert.ok(formatted.includes("* = unknown-cost attempts present (never ranked cheapest)"));

  // Check equivalent list cost calculation for unmetered fable route
  // Fable list prices: input $3.00/1M, output $15.00/1M
  // 20,000 in * $3.00/1M = $0.06; 4,000 out * $15.00/1M = $0.06; total = $0.12
  const fableRow = report.rows.find((r) => r.model === "fable");
  assert.ok(fableRow);
  assert.equal(fableRow.equivalentListCostUsd, 0.12);
});

test("Dynamic effort stepping sets low thinking on attempt 1 and medium on attempt 2 (Decision Q10)", async () => {
  const env = setupRoutingEnv("kxm-effort-stepping-");
  try {
    const bundle = loadKxmProject(env.root);
    const context = openKxmRuntimeContext(env.root, { stateRoot: env.stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptKxmRun(context, bundle, { workflowId: "default", prompt: "effort stepping test" });
      pinKxmCompiledPlan(context, bundle, accepted.run.runId);
      startKxmRun(context, accepted.run.runId, { allowLimits: true });

      const observedThinking: Array<string | undefined> = [];
      const producer = createKxmSimulatedProducer(async (req) => {
        observedThinking.push(req.thinking);
        return { outcome: "passed", costBasis: "metered", costUsd: 0.05 };
      });

      await stepKxmRun(context, accepted.run.runId, producer);
      assert.equal(observedThinking[0], "low");
    } finally {
      closeKxmRuntimeContext(context);
    }
  } finally {
    env.cleanup();
  }
});



