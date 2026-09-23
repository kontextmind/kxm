import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { workerResult, agentWorker } from "../../plugins/kxm/src/envelope.ts";
import {
  BEHAVIORAL_HASH_VERSION,
  ROUTING_RECORD_SCHEMA,
  behavioralConfigHash,
  compareRoutingRecords,
  groupByBehavior,
  parseRoutingRecord,
  type RoutingRecord,
} from "../../plugins/kxm/src/routing.ts";
import { appendTelemetry, readRoutingRecords, readTelemetry, telemetryPath } from "../../plugins/kxm/src/telemetry.ts";

const SKILL_SHA = "a".repeat(64);

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestedModel: "pi/Kimi K3",
    effectiveModel: "pi/kimi-k3",
    reasoningEffort: "high",
    agentRole: "implementer",
    rolePromptSha256: "b".repeat(64),
    skills: [{ id: "flaky-gate-retry", contentSha256: SKILL_SHA }],
    contextPolicyVersion: "ctx-1",
    toolPolicyVersion: "tools-1",
    workflowDefinitionSha256: "c".repeat(64),
    verifierConfigSha256: "d".repeat(64),
    ...overrides,
  };
}

function routingRecord(overrides: Record<string, unknown> = {}): RoutingRecord {
  return parseRoutingRecord({
    schema: ROUTING_RECORD_SCHEMA,
    behavioralHashVersion: BEHAVIORAL_HASH_VERSION,
    behavioralSha256: behavioralConfigHash(config()),
    workflowRunId: "run_1",
    stageId: "implement",
    attempt: 2,
    requestedModel: "pi/kimi-k3",
    effectiveModel: "pi/kimi-k3",
    agentRole: "implementer",
    skills: [{ id: "flaky-gate-retry", contentSha256: SKILL_SHA }],
    contextItemIds: ["ctx_1", "ctx_2"],
    retries: 1,
    transitions: 0,
    tokensIn: 12_000,
    tokensOut: 3_000,
    costUsd: 0.042,
    humanInterventions: 0,
    verifierOutcome: "passed",
    finalOutcome: "accepted",
    ...overrides,
  });
}

test("behavioral hash is stable for identical configs and distinct otherwise", () => {
  const first = behavioralConfigHash(config());
  const second = behavioralConfigHash(config());
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(BEHAVIORAL_HASH_VERSION, 1);

  // Any behavioral difference changes the hash: model route, skills, tool
  // policy, context policy, workflow config, verifier config, role prompt.
  const differences = [
    config({ requestedModel: "claude/sonnet-4" }),
    config({ effectiveModel: "pi/fallback" }),
    config({ reasoningEffort: "low" }),
    config({ agentRole: "critic" }),
    config({ rolePromptSha256: "e".repeat(64) }),
    config({ skills: [{ id: "other-skill", contentSha256: SKILL_SHA }] }),
    config({ skills: [{ id: "flaky-gate-retry", contentSha256: "f".repeat(64) }] }),
    config({ contextPolicyVersion: "ctx-2" }),
    config({ toolPolicyVersion: "tools-2" }),
    config({ workflowDefinitionSha256: "0".repeat(64) }),
    config({ verifierConfigSha256: "1".repeat(64) }),
  ];
  const hashes = new Set(differences.map((difference) => behavioralConfigHash(difference)));
  assert.equal(hashes.size, differences.length + 1 - 1);
  assert.equal(hashes.has(first), false);

  // Non-behavioral fields (outcome telemetry) do not exist in the input type:
  // the hash is over configuration only.
  // Skill ordering is normalized.
  const reordered = behavioralConfigHash(config({
    skills: [
      { id: "zzz-skill", contentSha256: SKILL_SHA },
      { id: "aaa-skill", contentSha256: SKILL_SHA },
    ],
  }));
  const reorderedAgain = behavioralConfigHash(config({
    skills: [
      { id: "aaa-skill", contentSha256: SKILL_SHA },
      { id: "zzz-skill", contentSha256: SKILL_SHA },
    ],
  }));
  assert.equal(reordered, reorderedAgain);
  // Model names normalize (case/spacing).
  assert.equal(
    behavioralConfigHash(config({ requestedModel: "PI/KIMI K3" })),
    behavioralConfigHash(config({ requestedModel: "pi/kimi-k3" })),
  );
});

test("routing records parse fail-closed and stay metadata-only", () => {
  const record = routingRecord();
  assert.equal(record.schema, "kxm.routing-record.v1");
  assert.equal(record.effectiveModel, "pi/kimi-k3");
  assert.deepEqual(record.skills, [{ id: "flaky-gate-retry", contentSha256: SKILL_SHA }]);

  assert.throws(() => parseRoutingRecord({ ...routingRecord(), schema: "kxm.routing-record.v0" }), /schema/);
  assert.throws(() => parseRoutingRecord({ ...routingRecord(), behavioralSha256: "nope" }), /sha256/);
  assert.throws(() => parseRoutingRecord({ ...routingRecord(), retries: -1 }), /retries/);
  assert.throws(() => parseRoutingRecord({ ...routingRecord(), costUsd: -0.5 }), /costUsd/);
  assert.throws(() => parseRoutingRecord({ ...routingRecord(), skills: [{ id: "x", contentSha256: "nothex" }] }), /sha256/);
  assert.throws(() => parseRoutingRecord({ ...routingRecord(), verifierOutcome: "maybe" }), /verifierOutcome/);
  assert.throws(() => parseRoutingRecord({ ...routingRecord(), finalOutcome: "sorta" }), /finalOutcome/);
  assert.throws(
    () => parseRoutingRecord({ ...routingRecord(), contextItemIds: Array.from({ length: 257 }, (_, index) => `ctx_${index}`) }),
    /at most 256/,
  );
  // Model names normalize on parse.
  assert.equal(parseRoutingRecord({ ...routingRecord(), requestedModel: "PI/Kimi K3" }).requestedModel, "pi/kimi-k3");
  // Provider-specific metadata is additive and bounded.
  const provider = parseRoutingRecord({ ...routingRecord(), providerMetadata: { provider: "kimi", cacheHitRate: 0.5 } });
  assert.deepEqual(provider.providerMetadata, { provider: "kimi", cacheHitRate: 0.5 });
  assert.throws(() => parseRoutingRecord({ ...routingRecord(), providerMetadata: { body: "raw private prompt text" } }), /providerMetadata/);
  assert.throws(() => parseRoutingRecord({ ...routingRecord(), providerMetadata: { prompt: "raw" } }), /providerMetadata/);
});

test("worker envelopes validate additive routing payloads", () => {
  const worker = agentWorker({ name: "coordinator", project: "kxm" });
  const record = routingRecord();
  const result = workerResult(worker, { command: "fix", ok: true, summary: "done", routing: record }) as { routing?: RoutingRecord };
  assert.equal(result.routing?.behavioralSha256, record.behavioralSha256);
  // Malformed routing payloads fail closed.
  assert.throws(
    () => workerResult(worker, { command: "fix", ok: true, summary: "done", routing: { ...record, schema: "bogus" } }),
    /schema/,
  );
});

test("comparisons compute verified completion, cost, and rework without raw bodies", () => {
  const shared = { behavioralSha256: behavioralConfigHash(config()) };
  const records = [
    routingRecord({ ...shared, workflowRunId: "run_1", finalOutcome: "accepted", costUsd: 0.1, retries: 0 }),
    routingRecord({ ...shared, workflowRunId: "run_2", finalOutcome: "accepted", costUsd: 0.2, retries: 1 }),
    routingRecord({ ...shared, workflowRunId: "run_3", finalOutcome: "failed", costUsd: 0.05, transitions: 2 }),
    routingRecord({ ...shared, workflowRunId: "run_4", finalOutcome: "pending", costUsd: 0.01 }),
  ];
  const comparison = compareRoutingRecords(records);
  assert.equal(comparison.runs, 4);
  assert.equal(comparison.verifiedCompletions, 2);
  assert.equal(comparison.failed, 1);
  assert.equal(comparison.reworkRate, 0.75);
  assert.equal(comparison.totalCostUsd, 0.36);
  assert.equal(comparison.missingCostRuns, 0);
  const missing = routingRecord({ ...shared, workflowRunId: "run_missing", finalOutcome: "accepted" });
  delete (missing as { costUsd?: number }).costUsd;
  const unknown = compareRoutingRecords([...records, missing]);
  assert.equal(unknown.totalCostUsd, null);
  assert.equal(unknown.missingCostRuns, 1);
  assert.equal(comparison.totalTokensIn, 48_000);
  // Mixed behavioral hashes are rejected: comparisons are per configuration.
  const challenger = routingRecord({ behavioralSha256: behavioralConfigHash(config({ requestedModel: "claude/sonnet-4" })) });
  assert.throws(() => compareRoutingRecords([...records, challenger]), /identical behavioral hashes/);
  // Champion/challenger grouping.
  const groups = groupByBehavior([...records, challenger, challenger]);
  assert.equal(groups.size, 2);
  assert.equal(groups.get(challenger.behavioralSha256)?.length, 2);
});

test("telemetry readers stay backward compatible and expose routing records", () => {
  const directory = mkdtempSync(join(tmpdir(), "kxm-routing-"));
  const path = telemetryPath(directory);
  try {
    const worker = agentWorker({ name: "coordinator", project: "kxm" });
    const legacy = { worker: { schema: "kxm.worker.v1", kind: "agent", driver: "code", name: "coordinator" }, command: "legacy", ok: true, summary: "old event without routing" };
    // A legacy event (pre-routing) reads exactly as before.
    const legacyResult = workerResult(worker, legacy);
    appendTelemetry(path, {
      schema: "kxm.telemetry.v1",
      recordedAt: "2026-01-01T00:00:00.000Z",
      host: "local",
      target: "project",
      envelope: legacyResult,
    });
    assert.equal(readTelemetry(path).length, 1);
    assert.equal(readRoutingRecords(path).length, 0);

    // A routing-bearing event flows through additively.
    const record = routingRecord();
    const routingResult = workerResult(worker, { command: "fix", ok: true, summary: "done", routing: record });
    appendTelemetry(path, {
      schema: "kxm.telemetry.v1",
      recordedAt: "2026-01-01T00:01:00.000Z",
      host: "local",
      target: "project",
      envelope: routingResult,
    });
    assert.equal(readTelemetry(path).length, 2);
    const routing = readRoutingRecords(path);
    assert.equal(routing.length, 1);
    assert.equal(routing[0]?.routing.behavioralSha256, record.behavioralSha256);
    assert.equal(JSON.stringify(routing).includes("raw prompt"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("kxm routing report aggregates telemetry by behavioral configuration", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-routing-cli-"));
  try {
    const logs = join(cwd, "logs");
    const path = telemetryPath(logs);
    const worker = agentWorker({ name: "coordinator", project: "kxm" });
    const champion = behavioralConfigHash(config());
    const challenger = behavioralConfigHash(config({ requestedModel: "claude/sonnet-4" }));
    for (const [hash, outcome, cost] of [
      [champion, "accepted", 0.1],
      [champion, "accepted", 0.15],
      [challenger, "failed", 0.4],
    ] as const) {
      appendTelemetry(path, {
        schema: "kxm.telemetry.v1",
        recordedAt: "2026-01-01T00:00:00.000Z",
        host: "local",
        target: "project",
        envelope: workerResult(worker, {
          command: "fix",
          ok: outcome === "accepted",
          summary: "done",
          outcome: outcome === "accepted" ? ("passed" as const) : ("failed" as const),
          routing: parseRoutingRecord({
            schema: ROUTING_RECORD_SCHEMA,
            behavioralHashVersion: 1,
            behavioralSha256: hash,
            finalOutcome: outcome,
            costUsd: cost,
          }),
        }),
      });
    }
    assert.match(readFileSync(path, "utf8"), /behavioralSha256/);

    const { runCli } = await import("../../plugins/kxm/src/cli.ts");
    let stdout = "";
    const io = {
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: () => undefined,
    };
    const exit = await runCli(["--json", "routing", "report", "--file", path], {}, io, cwd);
    assert.equal(exit, 0);
    const report = JSON.parse(stdout) as { configurations: Array<{ behavioralSha256: string; runs: number; verifiedCompletions: number }> };
    assert.equal(report.configurations.length, 2);
    const championRow = report.configurations.find((row) => row.behavioralSha256 === champion)!;
    assert.equal(championRow.runs, 2);
    assert.equal(championRow.verifiedCompletions, 2);

    // Also verify report object is present in JSON output
    const jsonOutput = JSON.parse(stdout) as { report: { schema: string; totalAttempts: number; rows: any[] } };
    assert.equal(jsonOutput.report.schema, "kxm.routing-report.v1");
    assert.equal(jsonOutput.report.totalAttempts, 3);
    assert.ok(jsonOutput.report.rows.length > 0);

    // Run in text mode to verify table formatting
    let textStdout = "";
    const textIo = {
      stdout: (text: string) => {
        textStdout += text;
      },
      stderr: () => undefined,
    };
    const textExit = await runCli(["routing", "report", "--file", path], {}, textIo, cwd);
    assert.equal(textExit, 0);
    assert.ok(textStdout.includes("Routing Telemetry Report"));
    assert.ok(textStdout.includes("Harness"));
    assert.ok(textStdout.includes("Model"));
    assert.ok(textStdout.includes("Pass%"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

