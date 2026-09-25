import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  buildImprovementReport,
  classifyCandidateKind,
  formatImprovementReport,
  groupRoutingRecords,
  writeImprovementReport,
  evaluatePromotionPolicy,
  CANDIDATE_SCHEMA,
  type ImprovementCandidate,
  type PromotionReadiness,
} from "../../plugins/kxm/src/improve.ts";
import {
  ensureSkillFrontmatter,
  parseSkillFrontmatter,
  SkillLifecycle,
} from "../../plugins/kxm/src/skills.ts";
import {
  computeDecayedWeight,
  evaluateCircuitBreaker,
  type RoutingRecordV2,
} from "../../plugins/kxm/src/routing.ts";
import { exportAssignmentRoutingRecords } from "../../scripts/assignment-run.mjs";
import {
  exportFederatedTelemetry,
  readFederatedTelemetry,
} from "../../plugins/kxm/src/telemetry.ts";
import type { CliIo } from "../../plugins/kxm/src/cli.ts";
import { loadKxmProject } from "../../plugins/kxm/src/project-config.ts";
import {
  createKxmSimulatedProducer,
  driveKxmRun,
  pinKxmCompiledPlan,
} from "../../plugins/kxm/src/engine.ts";
import {
  acceptKxmRun,
  closeKxmRuntimeContext,
  openKxmRuntimeContext,
} from "../../plugins/kxm/src/runtime-service.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOME = "rtm_01JDRIVER0000000000000000";
const NODE = process.execPath;

function makeGitRoot(root: string): void {
  const initialized = spawnSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", root], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(initialized.status, 0, initialized.stderr);
}

type SampleRecordInput = Partial<RoutingRecordV2> & {
  workflowId?: string;
  askSha256?: string;
};

let sampleCounter = 0;

function sampleRoutingRecord(overrides: SampleRecordInput = {}): RoutingRecordV2 {
  sampleCounter += 1;
  const { workflowId, askSha256, providerMetadata: extraMetadata, ...rest } = overrides;
  const providerMetadata: Record<string, string | number | boolean> = {
    workflowId: workflowId ?? "wf_sample",
    askSha256: askSha256 ?? `sha256:${"1".repeat(64)}`,
    ...(extraMetadata ?? {}),
  };

  return {
    schema: "kxm.routing-record.v2",
    runId: `run_sample_${sampleCounter}`,
    stepId: "verify",
    assignmentId: "asg_sample_1",
    attemptId: `att_sample_${sampleCounter}`,
    project: "demo",
    agentRole: "verifier",
    behavioralSha256: `sha256:${"b".repeat(64)}`,
    harness: "pi",
    provider: "pi",
    requestedModel: "claude-3-5-sonnet",
    effectiveModel: "claude-3-5-sonnet",
    latencyMs: 500,
    costBasis: "metered",
    costUsd: 0.05,
    verifierOutcome: "passed",
    finalOutcome: "accepted",
    retries: 0,
    recordedAt: "2026-09-08T10:00:00.000Z",
    providerMetadata,
    ...rest,
  };
}

test("classifyCandidateKind maps steps and roles to candidate kinds correctly", () => {
  assert.equal(classifyCandidateKind("verify", "verifier"), "gate");
  assert.equal(classifyCandidateKind("test-check", "implementer"), "gate");
  assert.equal(classifyCandidateKind("lint", "agent"), "gate");
  assert.equal(classifyCandidateKind("plan", "planner"), "skill");
  assert.equal(classifyCandidateKind("review-arch", "critic"), "skill");
  assert.equal(classifyCandidateKind("repro-bug", "reviewer"), "skill");
  assert.equal(classifyCandidateKind("transform", "agent"), "workflow-step");
  assert.equal(classifyCandidateKind("deploy", "coordinator"), "workflow-step");
});

test("groupRoutingRecords groups by (workflowHash, step, role, promptHash) and calculates metrics", () => {
  const records: RoutingRecordV2[] = [
    // Gate candidate: 3 records, 100% pass, mean cost 0.05, mean lat 600, rework 0
    sampleRoutingRecord({ stepId: "verify", agentRole: "verifier", costUsd: 0.04, latencyMs: 500 }),
    sampleRoutingRecord({ stepId: "verify", agentRole: "verifier", costUsd: 0.05, latencyMs: 600 }),
    sampleRoutingRecord({ stepId: "verify", agentRole: "verifier", costUsd: 0.06, latencyMs: 700 }),

    // Skill candidate: 4 records, 75% pass, rework 1
    sampleRoutingRecord({ stepId: "plan", agentRole: "planner", askSha256: "p_plan", costUsd: 0.1, latencyMs: 1000, verifierOutcome: "passed" }),
    sampleRoutingRecord({ stepId: "plan", agentRole: "planner", askSha256: "p_plan", costUsd: 0.2, latencyMs: 1200, verifierOutcome: "passed" }),
    sampleRoutingRecord({ stepId: "plan", agentRole: "planner", askSha256: "p_plan", costUsd: 0.1, latencyMs: 800, verifierOutcome: "passed" }),
    sampleRoutingRecord({ stepId: "plan", agentRole: "planner", askSha256: "p_plan", costUsd: 0.2, latencyMs: 1000, verifierOutcome: "failed", finalOutcome: "failed", retries: 1 }),

    // Workflow step candidate: 2 records, 100% pass
    sampleRoutingRecord({ stepId: "package", agentRole: "worker", askSha256: "p_pkg", costUsd: 0.02, latencyMs: 300 }),
    sampleRoutingRecord({ stepId: "package", agentRole: "worker", askSha256: "p_pkg", costUsd: 0.02, latencyMs: 300 }),

    // Non-candidate: low recurrence (1 record)
    sampleRoutingRecord({ stepId: "one-off", agentRole: "worker", askSha256: "p_one" }),

    // Non-candidate: low pass rate (50% < 75%)
    sampleRoutingRecord({ stepId: "flaky", agentRole: "tester", askSha256: "p_flaky", verifierOutcome: "passed" }),
    sampleRoutingRecord({ stepId: "flaky", agentRole: "tester", askSha256: "p_flaky", verifierOutcome: "failed", finalOutcome: "failed" }),
  ];

  const groups = groupRoutingRecords(records, { minRecurrence: 2, minPassRate: 0.75 });

  const verifyGroup = groups.find((g) => g.stepId === "verify");
  assert.ok(verifyGroup);
  assert.equal(verifyGroup.recurrence, 3);
  assert.equal(verifyGroup.meanCost, 0.05);
  assert.equal(verifyGroup.meanLatency, 600);
  assert.equal(verifyGroup.verifyPassRate, 1.0);
  assert.equal(verifyGroup.rework, 0);
  assert.equal(verifyGroup.isCandidate, true);
  assert.equal(verifyGroup.candidateKind, "gate");

  const planGroup = groups.find((g) => g.stepId === "plan");
  assert.ok(planGroup);
  assert.equal(planGroup.recurrence, 4);
  assert.equal(planGroup.verifyPassRate, 0.75);
  assert.equal(planGroup.rework, 1);
  assert.equal(planGroup.isCandidate, true);
  assert.equal(planGroup.candidateKind, "skill");

  const pkgGroup = groups.find((g) => g.stepId === "package");
  assert.ok(pkgGroup);
  assert.equal(pkgGroup.recurrence, 2);
  assert.equal(pkgGroup.verifyPassRate, 1.0);
  assert.equal(pkgGroup.isCandidate, true);
  assert.equal(pkgGroup.candidateKind, "workflow-step");

  const oneOffGroup = groups.find((g) => g.stepId === "one-off");
  assert.ok(oneOffGroup);
  assert.equal(oneOffGroup.isCandidate, false);

  const flakyGroup = groups.find((g) => g.stepId === "flaky");
  assert.ok(flakyGroup);
  assert.equal(flakyGroup.verifyPassRate, 0.5);
  assert.equal(flakyGroup.isCandidate, false);

  // A retry in the same run supersedes the earlier attempt: one run with rework is never a candidate.
  const [reworkGroup] = groupRoutingRecords([
    sampleRoutingRecord({ runId: "run_rw", stepId: "rework-step", agentRole: "worker", askSha256: "p_rw", verifierOutcome: undefined, finalOutcome: "accepted", retries: 0 }),
    sampleRoutingRecord({ runId: "run_rw", stepId: "rework-step", agentRole: "worker", askSha256: "p_rw", verifierOutcome: undefined, finalOutcome: "accepted", retries: 1 }),
  ]);
  assert.ok(reworkGroup);
  assert.equal(reworkGroup.recurrence, 2);
  assert.equal(reworkGroup.distinctRuns, 1);
  assert.equal(reworkGroup.verifyPassRate, 0.5);
  assert.equal(reworkGroup.isCandidate, false);

  // A step that writes a repository is reported, never proposed.
  const [writesGroup] = groupRoutingRecords([
    sampleRoutingRecord({ stepId: "apply", agentRole: "implementer", askSha256: "p_apply", providerMetadata: { stepWrites: true } }),
    sampleRoutingRecord({ stepId: "apply", agentRole: "implementer", askSha256: "p_apply", providerMetadata: { stepWrites: true } }),
  ]);
  assert.ok(writesGroup);
  assert.equal(writesGroup.writesRepository, true);
  assert.equal(writesGroup.isCandidate, false);
  assert.equal(writesGroup.excludedReason, "writes-repository");

  // The same step asked about different objectives recurs across runs but is not a repeated ask.
  const [askGroup] = groupRoutingRecords([
    sampleRoutingRecord({ stepId: "summarize", agentRole: "worker", askSha256: "p_sum", verifierOutcome: undefined, providerMetadata: { objectiveSha256: `sha256:${"c".repeat(64)}` } }),
    sampleRoutingRecord({ stepId: "summarize", agentRole: "worker", askSha256: "p_sum", verifierOutcome: undefined, providerMetadata: { objectiveSha256: `sha256:${"d".repeat(64)}` } }),
  ]);
  assert.ok(askGroup);
  assert.equal(askGroup.distinctRuns, 2);
  assert.equal(askGroup.askRecurrence, 1);
  assert.equal(askGroup.isCandidate, false);
  assert.equal(askGroup.excludedReason, "ask-not-repeated");

  // improvement.telemetryHalfLifeDays weights recency: it orders rows and never decides candidacy.
  const undated = sampleRoutingRecord({ stepId: "undated", agentRole: "worker", askSha256: "p_undated" });
  delete (undated as Partial<RoutingRecordV2>).recordedAt;
  const weighted = groupRoutingRecords([
    sampleRoutingRecord({ stepId: "older", agentRole: "worker", askSha256: "p_x", recordedAt: "2026-08-11T10:00:00.000Z" }),
    sampleRoutingRecord({ stepId: "older", agentRole: "worker", askSha256: "p_x", recordedAt: "2026-08-11T10:00:00.000Z" }),
    sampleRoutingRecord({ stepId: "older", agentRole: "worker", askSha256: "p_x", recordedAt: "2026-08-11T10:00:00.000Z" }),
    sampleRoutingRecord({ stepId: "recent", agentRole: "worker", askSha256: "p_y", recordedAt: "2026-09-08T10:00:00.000Z" }),
    sampleRoutingRecord({ stepId: "recent", agentRole: "worker", askSha256: "p_y", recordedAt: "2026-09-08T10:00:00.000Z" }),
    undated,
  ], { halfLifeDays: 14, now: Date.parse("2026-09-08T10:00:00Z") });
  const olderIndex = weighted.findIndex((g) => g.stepId === "older");
  const recentIndex = weighted.findIndex((g) => g.stepId === "recent");
  const older = weighted[olderIndex];
  const recent = weighted[recentIndex];
  assert.ok(older && recent);
  assert.equal(older.weightedRecurrence, 0.75);
  assert.equal(older.recurrence, 3);
  assert.equal(recent.weightedRecurrence, 2);
  assert.equal(older.isCandidate, true);
  assert.equal(recent.isCandidate, true);
  assert.ok(recentIndex < olderIndex, "the recent group sorts first despite lower raw recurrence");
  assert.equal(weighted.find((g) => g.stepId === "undated")?.undatedRecords, 1);
});

test("buildImprovementReport emits valid kxm.candidate.v1 files and diffs", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "kxm-improve-report-"));
  try {
    const candidatesDir = join(tempDir, ".kxm", "candidates");
    const records: RoutingRecordV2[] = [
      sampleRoutingRecord({ stepId: "lint", agentRole: "verifier", costUsd: 0.01, latencyMs: 200 }),
      sampleRoutingRecord({ stepId: "lint", agentRole: "verifier", costUsd: 0.01, latencyMs: 250 }),
      sampleRoutingRecord({ stepId: "plan-arch", agentRole: "planner", costUsd: 0.15, latencyMs: 900 }),
      sampleRoutingRecord({ stepId: "plan-arch", agentRole: "planner", costUsd: 0.15, latencyMs: 950 }),
      sampleRoutingRecord({ stepId: "package", agentRole: "worker", costUsd: 0.02, latencyMs: 300 }),
      sampleRoutingRecord({ stepId: "package", agentRole: "worker", costUsd: 0.02, latencyMs: 300 }),
    ];

    const report = buildImprovementReport(records, {
      projectRoot: tempDir,
      candidatesDir,
      minRecurrence: 2,
      minPassRate: 0.75,
    });

    assert.equal(report.schema, "kxm.improvement-report.v2");
    assert.equal(report.recordsCount, 6);
    assert.equal(report.candidates.length, 3);

    // Validate candidates against schemas/candidate.schema.json
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const commonSchema = JSON.parse(
      readFileSync(resolve(repoRoot, "schemas/common.schema.json"), "utf8"),
    );
    ajv.addSchema(commonSchema);
    const schemaContent = JSON.parse(
      readFileSync(resolve(repoRoot, "schemas/candidate.schema.json"), "utf8"),
    );
    const validateCandidate = ajv.compile(schemaContent);

    for (const cand of report.candidates) {
      assert.equal(cand.schema, CANDIDATE_SCHEMA);
      assert.ok(cand.id.startsWith("cand_"));
      assert.ok(["gate", "skill", "workflow-step"].includes(cand.kind));
      assert.ok(cand.summary);
      assert.ok(cand.declaredOutcome);
      assert.ok(cand.measure);
      assert.ok(cand.proposedDiffPath);
      assert.equal(cand.status, "proposed");

      const valid = validateCandidate(cand);
      assert.equal(valid, true, JSON.stringify(validateCandidate.errors));

      // Assert candidate JSON file written to disk
      const jsonPath = join(candidatesDir, `${cand.id}.json`);
      assert.equal(existsSync(jsonPath), true);
      const onDisk = JSON.parse(readFileSync(jsonPath, "utf8")) as ImprovementCandidate;
      assert.equal(onDisk.id, cand.id);

      // Assert diff file written to disk
      const diffPath = join(candidatesDir, `${cand.id}.diff`);
      assert.equal(existsSync(diffPath), true);
      const diffContent = readFileSync(diffPath, "utf8");
      assert.match(diffContent, /^diff --git /);
      if (cand.kind === "workflow-step") {
        // The coded step replaces the model turn with a gate.
        assert.match(diffContent, /\+\s+kind: gate/);
        assert.doesNotMatch(diffContent, /\+\s+kind: agent/);
      }
      if (cand.kind === "skill") assert.match(cand.summary, /consolidation/);
    }
    assert.deepEqual(report.candidates.map((cand) => cand.kind).sort(), ["gate", "skill", "workflow-step"]);

    // Assert writeImprovementReport
    const reportsDir = join(tempDir, "improvements");
    const writtenPath = writeImprovementReport(reportsDir, report);
    assert.equal(existsSync(writtenPath), true);
    const writtenReport = JSON.parse(readFileSync(writtenPath, "utf8"));
    assert.equal(writtenReport.schema, "kxm.improvement-report.v2");
    assert.equal(writtenReport.candidates.length, 3);

    // Assert formatImprovementReport
    const text = formatImprovementReport(report);
    assert.match(text, /Improvement Report/);
    assert.match(text, /Emitted Coded-Repeat Candidates/);
    assert.match(text, /lint/);
    assert.match(text, /plan-arch/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("kxm improve report CLI reads telemetry routing records and emits candidates", async () => {
  const { runCli: runCliImpl } = await import("../../plugins/kxm/src/cli.ts");
  const cwd = mkdtempSync(join(tmpdir(), "kxm-improve-cli-"));
  const logs = mkdtempSync(join(tmpdir(), "kxm-improve-logs-"));
  try {
    makeGitRoot(cwd);
    const telemetryFile = join(logs, "telemetry.jsonl");
    const records = [
      { recordedAt: "2026-09-08T10:00:00.000Z", routing: sampleRoutingRecord({ stepId: "test-unit", agentRole: "verifier" }) },
      { recordedAt: "2026-09-08T10:01:00.000Z", routing: sampleRoutingRecord({ stepId: "test-unit", agentRole: "verifier" }) },
    ];
    writeFileSync(telemetryFile, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const capture = () => {
      let stdout = "";
      let stderr = "";
      return {
        stdout: (text: string) => { stdout += text; },
        stderr: (text: string) => { stderr += text; },
        read: () => ({ stdout, stderr }),
      };
    };

    // Run kxm improve report --json --file <telemetryFile>; isolated from the real user config and state.
    const env = { KXM_LOGS_DIR: logs, KXM_USER_CONFIG_DIR: logs, KXM_STATE_HOME: logs };
    const jsonIo = capture();
    const jsonCode = await runCliImpl(
      ["improve", "report", "--json", "--file", telemetryFile],
      env,
      jsonIo,
      cwd,
    );
    assert.equal(jsonCode, 0);
    const jsonOut = JSON.parse(jsonIo.read().stdout);
    assert.equal(jsonOut.ok, true);
    assert.equal(jsonOut.command, "improve");
    assert.equal(jsonOut.recordsCount, 2);
    assert.equal(jsonOut.candidatesCount, 1);
    assert.equal(existsSync(jsonOut.path), true);
    // --file reads only the named file.
    assert.deepEqual(jsonOut.sources, [{ kind: "file", path: telemetryFile, exists: true, records: 2, duplicatesDropped: 0 }]);

    // Verify candidate file exists under cwd/.kxm/candidates/
    const candidate = jsonOut.candidates[0];
    assert.equal(existsSync(join(cwd, ".kxm", "candidates", `${candidate.id}.json`)), true);
    assert.equal(existsSync(join(cwd, ".kxm", "candidates", `${candidate.id}.diff`)), true);

    // Run kxm improve report without --json (formatted text)
    const textIo = capture();
    const textCode = await runCliImpl(
      ["improve", "report", "--file", telemetryFile],
      env,
      textIo,
      cwd,
    );
    assert.equal(textCode, 0);
    assert.match(textIo.read().stdout, /Improvement Report/);
    assert.match(textIo.read().stdout, /test-unit/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(logs, { recursive: true, force: true });
  }
});

test("kxm improve report resolves Runtime-settled attempts from the event log and flags only same-ask cross-run repeats", async () => {
  const { runCli: runCliImpl } = await import("../../plugins/kxm/src/cli.ts");
  const root = mkdtempSync(join(tmpdir(), "kxm-improve-engine-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-improve-engine-state-"));
  const logs = mkdtempSync(join(tmpdir(), "kxm-improve-engine-logs-"));
  try {
    cpSync(join(repoRoot, "examples/project"), root, { recursive: true });
    cpSync(join(repoRoot, "test/fixtures/engine/agent-only.yaml"), join(root, ".kxm", "workflows", "agent-only.yaml"));
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

    const bundle = loadKxmProject(root);
    const context = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    const enginePath = context.eventStore.path;
    let firstPlanRecord: RoutingRecordV2 | undefined;
    try {
      const drive = async (
        workflowId: string,
        prompt: string,
        script: Parameters<typeof createKxmSimulatedProducer>[0],
      ): Promise<string> => {
        const accepted = acceptKxmRun(context, bundle, { workflowId, prompt });
        pinKxmCompiledPlan(context, bundle, accepted.run.runId);
        const driven = await driveKxmRun(context, accepted.run.runId, createKxmSimulatedProducer(script), { allowLimits: true });
        assert.equal(driven.state.status, "completed");
        return accepted.run.runId;
      };
      const live = () => ({ outcome: "passed", harness: "pi" });
      // R1 and R2: the same ask; R3: a simulated drive; R4: rework inside one run; R5: a different objective.
      const r1 = await drive("default", "Summarize the release notes", live);
      await drive("default", "Summarize the release notes", live);
      await drive("default", "Summarize the release notes", () => ({ outcome: "passed" }));
      let bCalls = 0;
      await drive("agent-only", "Rework loop", (request) => {
        if (request.stepId === "b" && bCalls++ === 0) return { outcome: "failed", harness: "pi" };
        return { outcome: "passed", harness: "pi" };
      });
      await drive("default", "Draft the migration guide", live);
      firstPlanRecord = context.eventStore.events(r1, 0, 10_000)
        .filter((event) => event.eventType === "routing.attempt.recorded")
        .map((event) => (event.payload as unknown as { routing: RoutingRecordV2 }).routing)
        .find((record) => record.stepId === "plan");
    } finally {
      closeKxmRuntimeContext(context);
    }
    assert.ok(firstPlanRecord);
    // The same attempt mirrored into telemetry is dropped in favour of the engine's copy.
    writeFileSync(join(logs, "telemetry.jsonl"), `${JSON.stringify({ eventType: "routing.attempt.recorded", payload: { routing: firstPlanRecord } })}\n`);

    const env = { KXM_STATE_HOME: stateRoot, KXM_LOGS_DIR: logs, KXM_USER_CONFIG_DIR: join(stateRoot, "user-config") };
    const capture = () => {
      let stdout = "";
      let stderr = "";
      return {
        stdout: (text: string) => { stdout += text; },
        stderr: (text: string) => { stderr += text; },
        read: () => ({ stdout, stderr }),
      };
    };

    const jsonIo = capture();
    assert.equal(await runCliImpl(["improve", "report", "--json"], env, jsonIo, root), 0, jsonIo.read().stderr);
    const out = JSON.parse(jsonIo.read().stdout) as {
      ok: boolean;
      recordsCount: number;
      candidatesCount: number;
      candidates: Array<{ id: string }>;
      projectRoot: string | null;
      sources: Array<Record<string, unknown>>;
      report: {
        groups: Array<{ workflowHash: string; stepId: string; promptHash: string; recurrence: number; distinctRuns: number; askRecurrence: number; verifyPassRate: number; isCandidate: boolean; candidateKind?: string; excludedReason?: string }>;
        promotion: Array<Record<string, unknown>>;
      };
    };
    assert.equal(out.ok, true);
    assert.equal(out.recordsCount, 14);
    assert.ok(out.projectRoot);

    const engine = out.sources.find((source) => source.kind === "engine");
    assert.ok(engine);
    assert.equal(engine.path, enginePath);
    assert.equal(engine.exists, true);
    assert.equal(engine.records, 14);
    assert.equal(engine.excludedSimulated, 3);
    assert.equal(engine.skippedInvalid, 0);
    assert.equal(engine.undecided, 0);
    const telemetry = out.sources.find((source) => source.kind === "telemetry");
    assert.ok(telemetry);
    assert.equal(telemetry.records, 1);
    assert.equal(telemetry.duplicatesDropped, 1);

    const groups = out.report.groups;
    assert.equal(groups.length, 6);
    const group = (workflow: string, step: string) => {
      const found = groups.find((g) => g.workflowHash === workflow && g.stepId === step);
      assert.ok(found, `${workflow}/${step}`);
      return found;
    };
    const plan = group("default", "plan");
    assert.equal(plan.recurrence, 3);
    assert.equal(plan.distinctRuns, 3);
    assert.equal(plan.askRecurrence, 2, "R5 asked a different objective and does not raise the same-ask count");
    assert.equal(plan.verifyPassRate, 1);
    assert.equal(plan.isCandidate, true);
    assert.equal(plan.candidateKind, "skill");
    assert.equal(group("default", "ready").isCandidate, true);
    assert.equal(group("default", "implement").excludedReason, "writes-repository");
    const a = group("agent-only", "a");
    assert.equal(a.recurrence, 2);
    assert.equal(a.distinctRuns, 1);
    assert.equal(a.verifyPassRate, 0.5);
    assert.equal(a.isCandidate, false);
    assert.equal(group("agent-only", "b").verifyPassRate, 0.5);

    assert.equal(out.candidatesCount, 2);
    for (const candidate of out.candidates) {
      assert.equal(existsSync(join(root, ".kxm", "candidates", `${candidate.id}.json`)), true);
      assert.equal(existsSync(join(root, ".kxm", "candidates", `${candidate.id}.diff`)), true);
    }
    for (const g of groups) assert.match(g.promptHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(out.report.promotion.length, 2);
    for (const entry of out.report.promotion) {
      assert.equal(typeof entry.readyForReview, "boolean");
      assert.equal("authorized" in entry, false);
    }

    const textIo = capture();
    assert.equal(await runCliImpl(["improve", "report"], env, textIo, root), 0, textIo.read().stderr);
    assert.match(textIo.read().stdout, /Sources:/);
    assert.ok(textIo.read().stdout.includes(enginePath));

    // `kxm routing report` without --file ranks the same resolved records.
    const routingIo = capture();
    assert.equal(await runCliImpl(["--json", "routing", "report"], env, routingIo, root), 0, routingIo.read().stderr);
    const routing = JSON.parse(routingIo.read().stdout) as { file: string; report: { totalAttempts: number }; sources: Array<{ path: string }> };
    assert.equal(routing.report.totalAttempts, 14);
    assert.equal(routing.file, join(logs, "telemetry.jsonl"));
    assert.ok(routing.sources.some((source) => source.path === enginePath));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(logs, { recursive: true, force: true });
  }
});

test("skills frontmatter handling and patch emission on promotion", () => {
  const rawSkill = "Retry a flaky gate twice with jittered backoff.";
  const formatted = ensureSkillFrontmatter(rawSkill, "flaky-retry", "Retry flaky gates safely");
  assert.match(formatted, /^---\nname: flaky-retry\ndescription: Retry flaky gates safely\n---\n\n/);

  const parsed = parseSkillFrontmatter(formatted);
  assert.equal(parsed.frontmatter?.name, "flaky-retry");
  assert.equal(parsed.frontmatter?.description, "Retry flaky gates safely");
  assert.equal(parsed.body.trim(), "Retry a flaky gate twice with jittered backoff.");

  const root = mkdtempSync(join(tmpdir(), "kxm-skills-patch-"));
  try {
    const store = new SkillLifecycle(root);
    const candidate = store.create({
      name: "patch-promo",
      description: "Test patch promotion",
      content: formatted,
      createdBy: "agent_coder",
      sources: { runIds: ["run_1"] },
      compatibility: { harness: "pi", models: ["claude/*"] },
    });

    for (const kind of ["static-review", "sandbox", "functional", "safety"] as const) {
      store.evaluate(candidate.id, { kind, evaluatorVersion: "eval-1.0", passed: true });
    }

    const promoted = store.promote(candidate.id, {
      decidedBy: "admin_reviewer",
      reason: "passed evaluations",
      evidenceRefs: ["eval:sandbox"],
    });

    assert.ok(promoted.patch);
    assert.equal(existsSync(promoted.patchPath), true);
    assert.match(readFileSync(promoted.patchPath, "utf8"), /diff --git a\/\.kxm\/skills\/promoted/);
    // Candidate directory is not deleted
    assert.equal(store.list("candidate").length, 1);
    assert.equal(store.list("promoted").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("improve.yaml workflow completes on the KXM driver", async () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-improve-workflow-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-improve-workflow-state-"));
  try {
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

    const bundle = loadKxmProject(root);
    const context = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptKxmRun(context, bundle, {
        workflowId: "improve",
        prompt: "Propose improvements from telemetry routing records",
      });
      pinKxmCompiledPlan(context, bundle, accepted.run.runId);

      const visitedSteps: string[] = [];
      const producer = createKxmSimulatedProducer(async (req) => {
        visitedSteps.push(req.stepId);
        return { outcome: "passed" };
      });

      const result = await driveKxmRun(context, accepted.run.runId, producer, { allowLimits: true });
      assert.equal(result.state.status, "completed");
      assert.equal(result.handoff, undefined);

      // Verify execution path: report (agent) -> delivery (gate) -> ready (agent)
      assert.deepEqual(visitedSteps, ["report", "ready"]);

      const events = context.eventStore.events(accepted.run.runId, 0, 10_000);
      const stepEnteredEvents = events.filter((e) => e.eventType === "step.entered");
      assert.deepEqual(
        stepEnteredEvents.map((e) => e.payload.stepId),
        ["report", "delivery", "ready"],
      );
      assert.equal(events.some((e) => e.eventType === "effect.settled" && e.payload.outcome === "passed"), true);
    } finally {
      closeKxmRuntimeContext(context);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("computeDecayedWeight applies 14-day half-life exponential decay (Decision Q14)", () => {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  // At 0 days elapsed, weight is 1.0
  const w0 = computeDecayedWeight(now, 14, now);
  assert.equal(w0, 1.0);

  // At 14 days elapsed, weight is 0.5
  const w14 = computeDecayedWeight(now - 14 * dayMs, 14, now);
  assert.equal(Math.round(w14 * 1000) / 1000, 0.5);

  // At 28 days elapsed, weight is 0.25
  const w28 = computeDecayedWeight(now - 28 * dayMs, 14, now);
  assert.equal(Math.round(w28 * 1000) / 1000, 0.25);
});

test("evaluateCircuitBreaker soft-demotes or quarantines degraded routes (Decision Q13)", () => {
  const now = Date.now();
  const failingRecords: RoutingRecordV2[] = [
    sampleRoutingRecord({
      harness: "pi",
      effectiveModel: "flaky-model",
      verifierOutcome: "failed",
      finalOutcome: "failed",
      retries: 1,
      recordedAt: new Date(now - 60_000).toISOString(),
    }),
    sampleRoutingRecord({
      harness: "pi",
      effectiveModel: "flaky-model",
      verifierOutcome: "failed",
      finalOutcome: "failed",
      retries: 1,
      recordedAt: new Date(now - 120_000).toISOString(),
    }),
    sampleRoutingRecord({
      harness: "pi",
      effectiveModel: "flaky-model",
      verifierOutcome: "failed",
      finalOutcome: "failed",
      retries: 1,
      recordedAt: new Date(now - 180_000).toISOString(),
    }),
  ];

  // Soft demotion mode (default)
  const softStatus = evaluateCircuitBreaker(
    failingRecords,
    { harness: "pi", model: "flaky-model" },
    { mode: "soft_demotion", failureThreshold: 3, windowSeconds: 3600, penaltyMultiplier: 5.0 },
    now,
  );
  assert.equal(softStatus.status, "demoted");
  assert.equal(softStatus.penaltyMultiplier, 5.0);
  assert.equal(softStatus.consecutiveFailures, 3);

  // Quarantine mode
  const quarantineStatus = evaluateCircuitBreaker(
    failingRecords,
    { harness: "pi", model: "flaky-model" },
    { mode: "quarantine", failureThreshold: 3, windowSeconds: 3600 },
    now,
  );
  assert.equal(quarantineStatus.status, "quarantined");

  // Healthy route with passing record
  const passingRecords = [
    sampleRoutingRecord({
      harness: "grok",
      effectiveModel: "grok-4.6",
      verifierOutcome: "passed",
      finalOutcome: "accepted",
      retries: 0,
      recordedAt: new Date(now - 60_000).toISOString(),
    }),
  ];
  const healthyStatus = evaluateCircuitBreaker(
    passingRecords,
    { harness: "grok", model: "grok-4.6" },
    {},
    now,
  );
  assert.equal(healthyStatus.status, "healthy");
  assert.equal(healthyStatus.penaltyMultiplier, 1.0);
});

test("exportFederatedTelemetry and readFederatedTelemetry isolate code and prompts (Decision Q15)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "kxm-federated-telemetry-"));
  try {
    const records = [
      sampleRoutingRecord({
        harness: "grok",
        effectiveModel: "grok-4.6",
        latencyMs: 350,
        tokensIn: 800,
        tokensOut: 200,
        costUsd: 0.17,
        verifierOutcome: "passed",
      }),
      sampleRoutingRecord({
        harness: "claude",
        effectiveModel: "fable",
        latencyMs: 500,
        tokensIn: 1500,
        tokensOut: 400,
        costUsd: 0.45,
        verifierOutcome: "passed",
      }),
    ];

    const exported = exportFederatedTelemetry(records, tempDir);
    assert.equal(exported, 2);

    const readBack = readFederatedTelemetry(tempDir);
    assert.equal(readBack.length, 2);
    assert.equal(readBack[0]?.model, "grok-4.6");
    assert.equal(readBack[0]?.latencyMs, 350);
    assert.equal(readBack[0]?.costUsd, 0.17);

    // Ensure raw prompts, runIds, and project names are NOT in federated export
    const rawFile = readFileSync(join(tempDir, "telemetry", "model-metrics.jsonl"), "utf8");
    assert.doesNotMatch(rawFile, /wf_sample|run_sample_/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("evaluatePromotionPolicy enforces governed promotion policies (Decision Q11)", () => {
  const candidate: ImprovementCandidate = {
    schema: CANDIDATE_SCHEMA,
    id: "cand_gate_test_01",
    kind: "gate",
    summary: "Promote test gate",
    evidenceRefs: ["ref_1"],
    baselineMetrics: {
      recurrence: 12,
      meanCost: 0.05,
      meanLatency: 400,
      verifyPassRate: 0.98,
      rework: 0,
    },
    declaredOutcome: "Deterministic verification",
    measure: "100% cost reduction",
    proposedDiffPath: ".kxm/candidates/cand_gate_test_01.diff",
    status: "proposed",
    createdAt: new Date().toISOString(),
  };
  const results: PromotionReadiness[] = [];
  const evaluate = (...args: Parameters<typeof evaluatePromotionPolicy>): PromotionReadiness => {
    const readiness = evaluatePromotionPolicy(...args);
    results.push(readiness);
    return readiness;
  };

  // manual_pr: ready for the operator's PR review.
  const manual = evaluate(candidate, "manual_pr");
  assert.equal(manual.readyForReview, true);
  assert.match(manual.reason, /operator PR applying \.kxm\/candidates\/cand_gate_test_01\.diff required/);

  // critic_quorum: two distinct, non-empty critic receipts.
  assert.equal(evaluate(candidate, "critic_quorum", { criticReceipts: ["fable", "astra"] }).readyForReview, true);
  assert.equal(evaluate(candidate, "critic_quorum", { criticReceipts: ["fable", "fable"] }).readyForReview, false);
  const noReceipts = evaluate(candidate, "critic_quorum", { criticReceipts: [] });
  assert.equal(noReceipts.readyForReview, false);
  assert.match(noReceipts.reason, /awaiting 2 distinct critic receipts \(have 0\)/);

  // auto_threshold: the candidate's distinct runs, not its raw recurrence, when known.
  const threshold = { minRuns: 10, minPassRate: 0.95 };
  assert.equal(evaluate(candidate, "auto_threshold", { autoThreshold: threshold }).readyForReview, true);
  assert.equal(evaluate(candidate, "auto_threshold", { autoThreshold: threshold, distinctRuns: 3 }).readyForReview, false);

  // With minCostSavings set, a group without cost samples is never ready.
  const costed = { ...threshold, minCostSavings: 0.5 };
  assert.equal(evaluate(candidate, "auto_threshold", { autoThreshold: costed, costSamples: 0 }).readyForReview, false);
  assert.equal(evaluate(
    { ...candidate, baselineMetrics: { ...candidate.baselineMetrics, meanCost: 0.6 } },
    "auto_threshold",
    { autoThreshold: costed, costSamples: 3 },
  ).readyForReview, true);

  const unknown = evaluate(candidate, "auto_merge");
  assert.equal(unknown.readyForReview, false);
  assert.equal(unknown.reason, "unknown promotion policy");

  // Readiness never authorizes.
  for (const readiness of results) {
    assert.equal(typeof readiness.readyForReview, "boolean");
    assert.equal("authorized" in readiness, false);
    assert.equal("eligible" in readiness, false);
  }
});

test("kxm routing benchmark command executes side-by-side comparison (Decision Q12)", async () => {
  const { runCli: runCliImpl } = await import("../../plugins/kxm/src/cli.ts");
  const capture = () => {
    let stdout = "";
    let stderr = "";
    return {
      stdout: (text: string) => { stdout += text; },
      stderr: (text: string) => { stderr += text; },
      read: () => ({ stdout, stderr }),
    };
  };

  const io = capture();
  const code = await runCliImpl(
    ["--json", "routing", "benchmark", "--arms", "grok/grok-4.6,claude/fable", "--runs", "1"],
    {},
    io,
  );
  assert.equal(code, 0);
  const json = JSON.parse(io.read().stdout);
  assert.equal(json.ok, true);
  assert.equal(json.command, "routing benchmark");
  assert.equal(json.arms.length, 2);
  assert.equal(json.arms[0].model, "grok-4.6");
  assert.equal(json.arms[1].model, "fable");

  const tableIo = capture();
  const tableCode = await runCliImpl(
    ["routing", "benchmark", "--arms", "grok/grok-4.6,claude/fable"],
    {},
    tableIo,
  );
  assert.equal(tableCode, 0);
  assert.match(tableIo.read().stdout, /Routing Benchmark Results/);
  assert.match(tableIo.read().stdout, /grok-4\.6/);
});

test("assignment routing export resolves outcomes from accepted.json and groups repeated briefs for kxm improve", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-routing-export-"));
  const hex = "ab".repeat(32);
  const record = (dirName: string, stageId: string, agentRole: string, reworkOf?: string) => ({
    schema: "kxm.routing-record.v1",
    behavioralHashVersion: 1,
    behavioralSha256: hex,
    workflowRunId: dirName,
    stageId,
    attempt: 1,
    requestedModel: "grok/grok-4.7",
    effectiveModel: "grok/grok-4.7",
    reasoningEffort: "medium",
    agentRole,
    rolePromptSha256: hex,
    skills: [],
    retries: 0,
    transitions: 0,
    humanInterventions: 0,
    finalOutcome: "pending",
    providerMetadata: { harness: stageId.startsWith("review") ? "codex" : "grok", ...(reworkOf ? { rework_of: reworkOf } : {}) },
  });
  const manifest = (kind: string, boundary: string) => ({
    kind,
    contract: { boundary, deliverables: ["out"], witness: { id: "verify" }, deferred: [] },
  });
  const writeAssignment = (task: string, id: string, kind: string, boundary: string, agentRole: string, reworkOf?: string, withRecord = true) => {
    const dir = join(root, task, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest(kind, boundary)));
    if (withRecord) writeFileSync(join(dir, "routing-record.json"), JSON.stringify(record(id, kind, agentRole, reworkOf)));
  };
  try {
    writeAssignment("task-a", "asg-writer-1", "implement", "W1", "writer");
    writeAssignment("task-a", "asg-writer-2", "repair", "W1", "writer", "asg-writer-1");
    writeAssignment("task-a", "asg-review-cli-1", "review-cli", "R", "reviewer-cli");
    writeAssignment("task-a", "asg-writer-3", "implement", "W1", "writer", undefined, false);
    writeFileSync(join(root, "task-a", "accepted.json"), JSON.stringify({
      schema: "kxm.task-accepted.v1",
      task_id: "task-a",
      writer: { assignment_id: "asg-writer-2" },
      critics: [{ assignment_id: "asg-review-cli-1" }],
    }));
    writeAssignment("task-b", "asg-writer-1", "implement", "W2", "writer");
    writeAssignment("task-b", "asg-review-cli-1", "review-cli", "R", "reviewer-cli");
    writeFileSync(join(root, "task-b", "accepted.json"), JSON.stringify({
      schema: "kxm.task-accepted.v1",
      task_id: "task-b",
      writer: { assignment_id: "asg-writer-1" },
      critics: [{ assignment_id: "asg-review-cli-1" }],
    }));

    const a = exportAssignmentRoutingRecords({ taskDir: join(root, "task-a") });
    const b = exportAssignmentRoutingRecords({ taskDir: join(root, "task-b") });
    const byId = (rows: Array<Record<string, any>>, id: string) => rows.find((row) => row.providerMetadata.assignmentId === id);
    const a1 = byId(a.records, "asg-writer-1");
    const a2 = byId(a.records, "asg-writer-2");
    const aReview = byId(a.records, "asg-review-cli-1");
    const bReview = byId(b.records, "asg-review-cli-1");
    const bWriter = byId(b.records, "asg-writer-1");
    assert.ok(a1);
    assert.ok(a2);
    assert.ok(aReview);
    assert.ok(bReview);
    assert.ok(bWriter);
    assert.equal(a1.finalOutcome, "failed");
    assert.equal(a1.providerMetadata.supersededBy, "asg-writer-2");
    assert.equal(a2.finalOutcome, "accepted");
    assert.equal(aReview.finalOutcome, "accepted");
    assert.equal(bReview.finalOutcome, "accepted");
    assert.ok(a.records.every((row) => row.workflowRunId === "task-a"));
    assert.equal(a1.providerMetadata.stepWrites, true);
    assert.equal(aReview.providerMetadata.stepWrites, false);
    assert.equal(aReview.providerMetadata.askSha256, bReview.providerMetadata.askSha256);
    assert.equal(aReview.providerMetadata.objectiveSha256, bReview.providerMetadata.objectiveSha256);
    assert.notEqual(a2.providerMetadata.objectiveSha256, bWriter.providerMetadata.objectiveSha256);
    assert.deepEqual(a.skipped, [{ assignment_id: "asg-writer-3", reason: "no_routing_record" }]);

    const groups = groupRoutingRecords([...(a.records as RoutingRecordV2[]), ...(b.records as RoutingRecordV2[])]);
    const review = groups.find((group) => group.stepId === "review-cli");
    assert.ok(review);
    assert.equal(review.askRecurrence, 2);
    assert.equal(review.verifyPassRate, 1);
    assert.equal(review.isCandidate, true);
    assert.ok(review.candidateId);
    assert.equal(groups.some((group) => group.stepId !== "review-cli" && group.isCandidate), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

