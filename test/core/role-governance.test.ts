import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  TERMINAL_RECEIPT_SCHEMA,
  validateTerminalReceipt,
  ProtocolError,
} from "../../plugins/kxm/src/protocol.ts";
import {
  checkpointRun,
  escalateWorkflowStage,
  resumeWorkflowFromRuling,
  type WorkflowRun,
  type WorkflowStageState,
} from "../../plugins/kxm/src/workflow.ts";
import { runCli, type CliIo } from "../../plugins/kxm/src/cli.ts";

test("TerminalReceipt: schema validation, status enforcement, and failure modes", () => {
  // 1. Valid accepted receipt
  const validAccepted = validateTerminalReceipt({
    status: "accepted",
    seat: "writer",
    runId: "run_test123",
    stageId: "implement",
    timestamp: "2026-09-11T12:00:00.000Z",
    host: "grok",
    model: "grok-4.6",
    evidence: {
      verifiedFiles: ["plugins/kxm/src/role.ts"],
      gitHash: "abc1234",
      testSummary: { passed: 10, failed: 0, skipped: 0 },
    },
    metrics: {
      durationMs: 1250,
      tokensIn: 4000,
      tokensOut: 500,
      costUsd: 0.02,
    },
  });
  assert.equal(validAccepted.schema, TERMINAL_RECEIPT_SCHEMA);
  assert.equal(validAccepted.status, "accepted");
  assert.equal(validAccepted.seat, "writer");
  assert.equal(validAccepted.evidence?.gitHash, "abc1234");

  // 2. Valid audit_escalation receipt
  const validEscalation = validateTerminalReceipt({
    schema: "kxm.terminal-receipt.v1",
    status: "audit_escalation",
    seat: "critic-arch",
    runId: "run_test123",
    stageId: "review",
    timestamp: "2026-09-11T12:05:00.000Z",
    host: "pi",
    model: "anthropic/claude-fable-5.1",
    escalationReason: "Unresolved architectural boundary contradiction",
  });
  assert.equal(validEscalation.status, "audit_escalation");
  assert.equal(validEscalation.escalationReason, "Unresolved architectural boundary contradiction");

  // 3. Rejections on malformed inputs
  assert.throws(() => validateTerminalReceipt(null), ProtocolError);
  assert.throws(() => validateTerminalReceipt("invalid"), ProtocolError);
  assert.throws(
    () => validateTerminalReceipt({ status: "invalid_status", seat: "w", runId: "r", stageId: "s", timestamp: "t", host: "h", model: "m" }),
    /terminal receipt status must be one of/,
  );
  assert.throws(
    () => validateTerminalReceipt({ status: "accepted", seat: "", runId: "r", stageId: "s", timestamp: "t", host: "h", model: "m" }),
    /seat cannot be empty/,
  );
  assert.throws(
    () => validateTerminalReceipt({ schema: "wrong.schema", status: "accepted", seat: "w", runId: "r", stageId: "s", timestamp: "t", host: "h", model: "m" }),
    /terminal receipt schema must be/,
  );
});

test("Workflow governance: autoResumeLimit bounds retries and triggers audit escalation", () => {
  const stageDef: WorkflowStageState = {
    id: "review",
    label: "Architecture Review",
    instructions: "Verify architectural boundaries",
    requiredEvidence: ["review_signoff"],
    maxAttempts: 5,
    autoResumeLimit: 2,
    status: "in_progress",
    attempts: 0,
    evidence: {},
  };

  const run: WorkflowRun = {
    id: "run_audit_test",
    definitionId: "audit-test-flow",
    source: "generic",
    deliveryId: "del_1",
    payloadHash: "hash_1",
    project: "test",
    targetAgentId: "agent_1",
    targetAgentName: "test-agent",
    messageId: "msg_1",
    status: "running",
    currentStage: "review",
    stages: [stageDef],
    createdAt: "2026-09-11T12:00:00.000Z",
    updatedAt: "2026-09-11T12:00:00.000Z",
  };

  // Attempt 1: failure allows in-place retry since attempts (1) < autoResumeLimit (2)
  const checkpoint1 = checkpointRun(
    run,
    "review",
    "failed",
    "Missing review signoff",
    {},
    "2026-09-11T12:01:00.000Z",
  );
  assert.equal(checkpoint1.retry, true);
  assert.equal(run.status, "running");
  assert.equal(stageDef.attempts, 1);

  // Attempt 2: failure hits autoResumeLimit (2) -> triggers audit escalation
  const checkpoint2 = checkpointRun(
    run,
    "review",
    "failed",
    "Second failure on architecture check",
    {},
    "2026-09-11T12:02:00.000Z",
  );
  assert.equal(checkpoint2.retry, false);
  assert.equal(run.status, "waiting");
  assert.equal(run.waiting?.signalKey, "audit_escalation");
  assert.ok(stageDef.receipt);
  assert.equal(stageDef.receipt?.status, "audit_escalation");

  // Operator ruling unpauses and resumes the run
  const resumeRes = resumeWorkflowFromRuling(
    run,
    "Waive rule 42 for prototype slice; proceed to verification",
    "2026-09-11T12:03:00.000Z",
    { status: "passed", evidence: { review_signoff: "operator-waived" } },
  );
  assert.equal(resumeRes.stageId, "review");
  assert.equal(run.status, "completed");
  assert.equal(stageDef.status, "passed");
  assert.ok(stageDef.summary?.includes("Waive rule 42"));
});

test("CLI commands: kxm role resume resumes an audit-escalated run in database", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const tempRepoDir = mkdtempSync(join(tmpdir(), "kxm-cli-resume-"));
  const tempStateDir = join(tempRepoDir, ".kxm", "state");
  mkdirSync(tempStateDir, { recursive: true });
  const dbPath = join(tempStateDir, "kxm.db");

  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      definition_id TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      record TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_journal (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      category TEXT NOT NULL,
      area TEXT NOT NULL,
      record TEXT NOT NULL
    );
  `);

  const runId = "wf_run_audit_123";
  const stageDef: WorkflowStageState = {
    id: "review",
    label: "Review",
    instructions: "Review code",
    requiredEvidence: [],
    maxAttempts: 2,
    autoResumeLimit: 1,
    status: "waiting",
    attempts: 1,
    evidence: {},
  };
  const waitingRun: WorkflowRun = {
    id: runId,
    definitionId: "audit-flow",
    source: "generic",
    deliveryId: "del_1",
    payloadHash: "hash_1",
    project: "test",
    targetAgentId: "agent_1",
    targetAgentName: "test-agent",
    messageId: "msg_1",
    status: "waiting",
    currentStage: "review",
    stages: [stageDef],
    waiting: {
      stageId: "review",
      signalKey: "audit_escalation",
      summary: "Escalated for audit",
      createdAt: "2026-09-11T12:00:00.000Z",
      expiresAt: "2026-09-12T12:00:00.000Z",
    },
    createdAt: "2026-09-11T12:00:00.000Z",
    updatedAt: "2026-09-11T12:00:00.000Z",
  };

  db.prepare("INSERT INTO workflow_runs (id, definition_id, delivery_id, record) VALUES (?, ?, ?, ?)").run(
    runId,
    "audit-flow",
    "del_1",
    JSON.stringify(waitingRun),
  );
  db.close();

  try {
    let stdoutText = "";
    let stderrText = "";
    const mockIo: CliIo = {
      stdout: (chunk: string) => { stdoutText += chunk; },
      stderr: (chunk: string) => { stderrText += chunk; },
    };

    const resumeCode = await runCli(
      ["role", "resume", runId, "Waive architecture check; approved by lead", "--json"],
      process.env,
      mockIo,
      tempRepoDir,
    );
    assert.equal(resumeCode, 0);
    const parsed = JSON.parse(stdoutText);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, "role resume");
    assert.equal(parsed.runId, runId);
    assert.equal(parsed.stageId, "review");
    assert.ok(parsed.ruling.includes("Waive architecture check"));

    // Verify database was updated
    const checkDb = new DatabaseSync(dbPath);
    const row = checkDb.prepare("SELECT record FROM workflow_runs WHERE id = ?").get(runId) as { record: string };
    assert.ok(row);
    const updated = JSON.parse(row.record) as WorkflowRun;
    assert.equal(updated.status, "completed");

    const journalRows = checkDb.prepare("SELECT record FROM workflow_journal WHERE run_id = ?").all(runId) as Array<{ record: string }>;
    assert.equal(journalRows.length, 1);
    assert.ok(journalRows[0]!.record.includes("Waive architecture check"));
    checkDb.close();
  } finally {
    rmSync(tempRepoDir, { recursive: true, force: true });
  }
});

