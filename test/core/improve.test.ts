import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  workflowDefinitionSha256?: string;
  rolePromptSha256?: string;
};

function sampleRoutingRecord(overrides: SampleRecordInput = {}): RoutingRecordV2 {
  const { workflowDefinitionSha256, rolePromptSha256, ...rest } = overrides;
  const providerMetadata: Record<string, string | number | boolean> = {
    workflowDefinitionSha256: workflowDefinitionSha256 ?? "wf_hash_sample",
    rolePromptSha256: rolePromptSha256 ?? "prompt_hash_1",
    ...(rest.providerMetadata ?? {}),
  };

  return {
    schema: "kxm.routing-record.v2",
    runId: "run_sample_1",
    stepId: "verify",
    assignmentId: "asg_sample_1",
    attemptId: "att_sample_1",
    project: "demo",
    agentRole: "verifier",
    behavioralSha256: "beh_hash_1",
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
    sampleRoutingRecord({ stepId: "plan", agentRole: "planner", rolePromptSha256: "p_plan", costUsd: 0.1, latencyMs: 1000, verifierOutcome: "passed" }),
    sampleRoutingRecord({ stepId: "plan", agentRole: "planner", rolePromptSha256: "p_plan", costUsd: 0.2, latencyMs: 1200, verifierOutcome: "passed" }),
    sampleRoutingRecord({ stepId: "plan", agentRole: "planner", rolePromptSha256: "p_plan", costUsd: 0.1, latencyMs: 800, verifierOutcome: "passed" }),
    sampleRoutingRecord({ stepId: "plan", agentRole: "planner", rolePromptSha256: "p_plan", costUsd: 0.2, latencyMs: 1000, verifierOutcome: "failed", finalOutcome: "failed", retries: 1 }),

    // Workflow step candidate: 2 records, 100% pass
    sampleRoutingRecord({ stepId: "package", agentRole: "worker", rolePromptSha256: "p_pkg", costUsd: 0.02, latencyMs: 300 }),
    sampleRoutingRecord({ stepId: "package", agentRole: "worker", rolePromptSha256: "p_pkg", costUsd: 0.02, latencyMs: 300 }),

    // Non-candidate: low recurrence (1 record)
    sampleRoutingRecord({ stepId: "one-off", agentRole: "worker", rolePromptSha256: "p_one" }),

    // Non-candidate: low pass rate (50% < 75%)
    sampleRoutingRecord({ stepId: "flaky", agentRole: "tester", rolePromptSha256: "p_flaky", verifierOutcome: "passed" }),
    sampleRoutingRecord({ stepId: "flaky", agentRole: "tester", rolePromptSha256: "p_flaky", verifierOutcome: "failed", finalOutcome: "failed" }),
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
    ];

    const report = buildImprovementReport(records, {
      projectRoot: tempDir,
      candidatesDir,
      minRecurrence: 2,
      minPassRate: 0.75,
    });

    assert.equal(report.schema, "kxm.improvement-report.v2");
    assert.equal(report.recordsCount, 4);
    assert.equal(report.candidates.length, 2);

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
    }

    // Assert writeImprovementReport
    const reportsDir = join(tempDir, "improvements");
    const writtenPath = writeImprovementReport(reportsDir, report);
    assert.equal(existsSync(writtenPath), true);
    const writtenReport = JSON.parse(readFileSync(writtenPath, "utf8"));
    assert.equal(writtenReport.schema, "kxm.improvement-report.v2");
    assert.equal(writtenReport.candidates.length, 2);

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

    // Run kxm improve report --json --file <telemetryFile>
    const jsonIo = capture();
    const jsonCode = await runCliImpl(
      ["improve", "report", "--json", "--file", telemetryFile],
      { KXM_LOGS_DIR: logs },
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

    // Verify candidate file exists under cwd/.kxm/candidates/
    const candidate = jsonOut.candidates[0];
    assert.equal(existsSync(join(cwd, ".kxm", "candidates", `${candidate.id}.json`)), true);
    assert.equal(existsSync(join(cwd, ".kxm", "candidates", `${candidate.id}.diff`)), true);

    // Run kxm improve report without --json (formatted text)
    const textIo = capture();
    const textCode = await runCliImpl(
      ["improve", "report", "--file", telemetryFile],
      { KXM_LOGS_DIR: logs },
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
    assert.doesNotMatch(rawFile, /prompt_hash|wf_hash_sample|run_sample_1/);
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
    proposedDiffPath: ".kxm/gates.yaml",
    status: "proposed",
    createdAt: new Date().toISOString(),
  };

  // manual_pr requires PR signoff
  const manualDec = evaluatePromotionPolicy(candidate, "manual_pr");
  assert.equal(manualDec.eligible, true);
  assert.equal(manualDec.authorized, false);
  assert.match(manualDec.reason, /Manual PR review/);

  // critic_quorum requires 2 critic approvals
  const unapprovedQuorum = evaluatePromotionPolicy(candidate, "critic_quorum", { criticApprovals: ["fable"] });
  assert.equal(unapprovedQuorum.authorized, false);

  const approvedQuorum = evaluatePromotionPolicy(candidate, "critic_quorum", { criticApprovals: ["fable", "astra"] });
  assert.equal(approvedQuorum.authorized, true);

  // auto_threshold requires recurrence >= 10 and passRate >= 0.95
  const autoApproved = evaluatePromotionPolicy(candidate, "auto_threshold", {
    autoThreshold: { minRuns: 10, minPassRate: 0.95 },
  });
  assert.equal(autoApproved.authorized, true);

  const autoFailing = evaluatePromotionPolicy(
    {
      ...candidate,
      baselineMetrics: { ...candidate.baselineMetrics, verifyPassRate: 0.80 },
    },
    "auto_threshold",
    { autoThreshold: { minRuns: 10, minPassRate: 0.95 } },
  );
  assert.equal(autoFailing.authorized, false);
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

