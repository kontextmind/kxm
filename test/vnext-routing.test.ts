import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { makeGitRoot } from "./helpers/git-root.ts";
import { loadVnextProject } from "../plugins/kxm/src/vnext-config.ts";
import {
  createVnextSimulatedProducer,
  driveVnextRun,
  pinVnextCompiledPlan,
  startVnextRun,
  stepVnextRun,
} from "../plugins/kxm/src/vnext-engine.ts";
import {
  acceptVnextRun,
  closeVnextRuntimeContext,
  openVnextRuntimeContext,
} from "../plugins/kxm/src/vnext-runtime.ts";
import {
  ROUTING_RECORD_V2_SCHEMA,
  type RoutingRecordV2,
  parseRoutingRecordV2,
} from "../plugins/kxm/src/routing.ts";
import {
  loadPriceCatalog,
  findModelPrice,
  calculateModelCost,
  hashPriceCatalog,
} from "../plugins/kxm/src/prices.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
    const bundle = loadVnextProject(env.root);
    const context = openVnextRuntimeContext(env.root, { stateRoot: env.stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "default", prompt: "default run" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);

      const producer = createVnextSimulatedProducer(async () => {
        return { outcome: "passed" };
      });

      const result = await driveVnextRun(context, accepted.run.runId, producer, { allowLimits: true });
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
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    env.cleanup();
  }
});

test("D5 Gate: missing costBasis is rejected during attempt settlement", async () => {
  const env = setupRoutingEnv("kxm-d5-missing-costbasis-");
  try {
    const bundle = loadVnextProject(env.root);
    const context = openVnextRuntimeContext(env.root, { stateRoot: env.stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "default", prompt: "default run" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      startVnextRun(context, accepted.run.runId, { allowLimits: true });

      // Producer explicitly omits or passes undefined costBasis
      const producer = createVnextSimulatedProducer(async () => {
        return { outcome: "passed", costBasis: undefined } as any;
      });

      await assert.rejects(
        async () => {
          await stepVnextRun(context, accepted.run.runId, producer);
        },
        /costBasis/,
      );
    } finally {
      closeVnextRuntimeContext(context);
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

    const bundle = loadVnextProject(env.root);
    const context = openVnextRuntimeContext(env.root, { stateRoot: env.stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "default", prompt: "metered cost run" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      startVnextRun(context, accepted.run.runId, { allowLimits: true });

      // First step incurs metered cost of 0.75, exceeding the 0.50 maxModelCost limit
      const producer = createVnextSimulatedProducer(async (req) => {
        return {
          outcome: "passed",
          costBasis: "metered",
          costUsd: 0.75,
          tokensIn: 1000,
          tokensOut: 500,
        };
      });

      // First step executes and settles
      const step1 = await stepVnextRun(context, accepted.run.runId, producer);
      assert.equal(step1.state.status, "running");

      // Next step dispatch should be refused due to exceeding maxModelCost
      const step2 = await stepVnextRun(context, accepted.run.runId, producer);
      assert.equal(step2.state.status, "failed");
      assert.equal(step2.state.failureReason, "budget_model_cost");
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    env.cleanup();
  }
});

test("D5 Price Catalog: loads, verifies hash, and resolves models", () => {
  const catalog = loadPriceCatalog(repoRoot);
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

test("D5 Price Catalog: calculates metered cost with context tiers", () => {
  const catalog = loadPriceCatalog(repoRoot);
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

