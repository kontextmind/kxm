import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  formatStageStepper,
  loadActiveWorkflowProgress,
  renderWorkflowTuiText,
  renderWorkflowWidgetLines,
  type WorkflowProgressState,
} from "../../plugins/kxm/src/workflow-tui.ts";
import {
  kxmSlashCompletions,
  parseKxmSlashArgs,
} from "../../plugins/kxm/src/session-work.ts";

test("formatStageStepper formats horizontal stepper with correct status icons", () => {
  // Empty
  assert.equal(formatStageStepper([]), "[idle]");
  assert.equal(formatStageStepper([], "plan"), "[▶ plan]");

  // Full progression
  const stages: WorkflowProgressState["stages"] = [
    { id: "implement", status: "passed", role: "writer" },
    { id: "review-arch", status: "running", role: "plan" },
    { id: "review-cli", status: "waiting", role: "review" },
    { id: "verify", status: "pending", role: "verify" },
  ];

  const stepper = formatStageStepper(stages, "review-arch");
  assert.equal(
    stepper,
    "[✔ implement] ──> [▶ review-arch] ──> [⧗ review-cli] ──> [○ verify]",
  );

  // Failed and cancelled icons
  const failedStages: WorkflowProgressState["stages"] = [
    { id: "test", status: "failed" },
    { id: "cleanup", status: "cancelled" },
  ];
  assert.equal(formatStageStepper(failedStages), "[✖ test] ──> [⊘ cleanup]");
});

test("renderWorkflowWidgetLines renders idle widget when state is missing", () => {
  const lines = renderWorkflowWidgetLines(undefined);
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /KXM Workflow/);
  assert.match(lines[1]!, /No active workflow running/);
});

test("renderWorkflowWidgetLines renders complete stepper, role, model, and token telemetry", () => {
  const state: WorkflowProgressState = {
    runId: "run_0123456789abcdef0123456789abcdef",
    workflowId: "feature-delivery",
    status: "running",
    currentStage: "review-arch",
    currentRole: "critic",
    attempt: 2,
    stages: [
      { id: "implement", status: "passed", role: "writer" },
      { id: "review-arch", status: "running", role: "critic" },
      { id: "verify", status: "pending", role: "tester" },
    ],
    metrics: {
      totalSpendUsd: 0.42,
      inputTokens: 14500,
      outputTokens: 2300,
      cacheReadTokens: 12000,
      latencyMs: 3200,
      harness: "grok",
      model: "grok-4.6",
      effort: "medium",
    },
  };

  const lines = renderWorkflowWidgetLines(state);
  assert.ok(lines.length >= 5);
  assert.match(lines[0]!, /KXM Workflow: feature-delivery \(run_0123456789ab\)/);
  assert.match(lines[1]!, /Stage: \[✔ implement\] ──> \[▶ review-arch\] ──> \[○ verify\]/);
  assert.match(lines[2]!, /Status: RUNNING \(Attempt 2\) · Role: critic/);
  assert.match(lines[3]!, /Model: grok:grok-4\.6 \(medium\) · Spend: \$0\.42/);
  assert.match(lines[4]!, /Tokens: In: 14\.5k \| Out: 2\.3k \| Cache: 12\.0k/);

  const banner = renderWorkflowTuiText(state);
  assert.ok(banner.includes("feature-delivery"));
});

test("loadActiveWorkflowProgress returns undefined when state DB is absent", () => {
  const emptyDir = mkdtempSync(join(tmpdir(), "kxm-tui-absent-"));
  try {
    assert.equal(loadActiveWorkflowProgress(emptyDir), undefined);
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

test("loadActiveWorkflowProgress loads active run from DB and aggregates telemetry spend", () => {
  const testDir = mkdtempSync(join(tmpdir(), "kxm-tui-live-"));
  try {
    const kxmDir = join(testDir, ".kxm");
    const stateDir = join(kxmDir, "state");
    const logsDir = join(kxmDir, "logs");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(logsDir, { recursive: true });

    const db = new DatabaseSync(join(stateDir, "kxm.db"));
    db.exec(`
      CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        record TEXT NOT NULL
      );
    `);

    const runId = "run_abc12300000000000000000000000000";
    const runRecord = {
      id: runId,
      definitionId: "audit-pipeline",
      status: "running",
      currentStage: "review-arch",
      targetAgentName: "critic",
      stages: [
        { id: "implement", status: "passed", role: "writer", attempts: 1 },
        { id: "review-arch", status: "running", role: "critic", attempts: 1 },
        { id: "verify", status: "pending", role: "verify", attempts: 0 },
      ],
      updatedAt: new Date().toISOString(),
    };

    db.prepare("INSERT INTO workflow_runs (id, status, record) VALUES (?, ?, ?)").run(
      runId,
      "running",
      JSON.stringify(runRecord),
    );
    db.close();

    // Write telemetry log
    const telemEvent1 = {
      timestamp: new Date().toISOString(),
      routing: {
        schema: "kxm.routing-record.v2",
        runId,
        stage: "implement",
        harness: "grok",
        model: "grok-4.6",
        thinking: "medium",
        costUsd: 0.15,
        latencyMs: 1200,
        tokens: { input: 5000, output: 800, cacheRead: 2000 },
      },
    };
    const telemEvent2 = {
      timestamp: new Date().toISOString(),
      routing: {
        schema: "kxm.routing-record.v2",
        runId,
        stage: "review-arch",
        harness: "claude",
        model: "fable",
        thinking: "high",
        costUsd: 0.25,
        latencyMs: 1800,
        tokens: { input: 6000, output: 1200, cacheRead: 3000 },
      },
    };
    writeFileSync(
      join(logsDir, "telemetry.jsonl"),
      JSON.stringify(telemEvent1) + "\n" + JSON.stringify(telemEvent2) + "\n",
      "utf8",
    );

    const progress = loadActiveWorkflowProgress(testDir);
    assert.ok(progress);
    assert.equal(progress.runId, runId);
    assert.equal(progress.workflowId, "audit-pipeline");
    assert.equal(progress.status, "running");
    assert.equal(progress.currentStage, "review-arch");
    assert.equal(progress.currentRole, "critic");
    assert.equal(progress.stages.length, 3);

    // Verify aggregated metrics
    assert.ok(progress.metrics);
    assert.equal(progress.metrics.totalSpendUsd, 0.4);
    assert.equal(progress.metrics.inputTokens, 11000);
    assert.equal(progress.metrics.outputTokens, 2000);
    assert.equal(progress.metrics.cacheReadTokens, 5000);
    assert.equal(progress.metrics.harness, "claude");
    assert.equal(progress.metrics.model, "fable");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("session-work parses /kxm progress and workflow slash subcommands", () => {
  assert.equal(parseKxmSlashArgs("progress"), "progress");
  assert.equal(parseKxmSlashArgs("workflow"), "workflow");
  assert.deepEqual(kxmSlashCompletions("pro"), [{ value: "progress", label: "progress" }]);
  assert.deepEqual(kxmSlashCompletions("work"), [{ value: "workflow", label: "workflow" }]);
});

test("Pi extension registers /kxm progress and /workflow commands", async () => {
  const commands = new Map<string, { handler: (args: string | undefined, ctx: any) => Promise<void> }>();
  const fakePi = {
    on() {},
    registerTool() {},
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    sendMessage() {},
    getSessionName() { return "test-session"; },
  };

  const piMeshExtension = (await import("../../plugins/kxm/src/extension.ts")).default;
  piMeshExtension(fakePi as any);

  assert.ok(commands.has("kxm"), "Expected kxm command to be registered");
  assert.ok(commands.has("workflow"), "Expected workflow command to be registered");

  const widgets: Array<{ key: string; lines: string[] | undefined }> = [];
  const notices: Array<{ message: string; type: string }> = [];
  const ctx = {
    cwd: "/nonexistent",
    ui: {
      setWidget(key: string, lines: string[] | undefined) {
        widgets.push({ key, lines });
      },
      notify(message: string, type: string) {
        notices.push({ message, type });
      },
    },
  };

  // 1. /kxm progress with no active run
  await commands.get("kxm")!.handler("progress", ctx);
  assert.ok(notices.some((n) => n.message.includes("no active workflow run")));

  // 2. /workflow with no active run
  await commands.get("workflow")!.handler("", ctx);
  assert.ok(notices.some((n) => n.message.includes("no active workflow run")));
});

