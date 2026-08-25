import assert from "node:assert/strict";
import test from "node:test";
import {
  checkpointRun,
  improvementReport,
  parseWorkflowDefinitions,
  renderWorkflowPrompt,
  valueAtPath,
  type WorkflowJournalEntry,
  type WorkflowRun,
} from "../plugins/pi-mesh-comms/src/workflow.ts";

function definitionJson(): string {
  return JSON.stringify([{
    id: "jira-development",
    source: "jira",
    project: "product",
    target: "coordinator",
    secret: "a-long-webhook-secret",
    event: "jira:issue_updated",
    filter: { path: "issue.fields.status.name", equals: "In Progress" },
    promptTemplate: "Work {{issue.key}}: {{issue.fields.summary}}",
    stages: [{
      id: "reproduce",
      instructions: "Reproduce the issue",
      requiredEvidence: ["steps", "failing test"],
      maxAttempts: 2,
    }, {
      id: "implement",
      label: "Implementation",
      instructions: "Implement the reviewed plan",
    }],
  }]);
}

test("workflow definitions, path lookup, and prompt templates are validated", () => {
  const [definition] = parseWorkflowDefinitions(definitionJson());
  assert.equal(definition!.delivery, "followUp");
  assert.equal(definition!.stages[0]!.label, "reproduce");
  const payload = { issue: { key: "ABC-12", fields: { summary: "Broken login" } } };
  assert.equal(valueAtPath(payload, "issue.key"), "ABC-12");
  assert.equal(valueAtPath(payload, "issue.missing"), undefined);
  assert.equal(renderWorkflowPrompt(definition!.promptTemplate, payload), "Work ABC-12: Broken login");
  assert.throws(() => parseWorkflowDefinitions("{}"), /JSON array/);
  assert.throws(() => parseWorkflowDefinitions(JSON.stringify([{ ...JSON.parse(definitionJson())[0], secret: "short" }])), /16 characters/);
  assert.equal(parseWorkflowDefinitions(undefined).length, 0);
  const fromEnvironment = JSON.parse(definitionJson())[0];
  delete fromEnvironment.secret;
  fromEnvironment.secretEnv = "TEST_WEBHOOK_SECRET";
  assert.equal(
    parseWorkflowDefinitions(JSON.stringify([fromEnvironment]), { TEST_WEBHOOK_SECRET: "environment-secret-value" })[0]!.secret,
    "environment-secret-value",
  );
  assert.throws(
    () => parseWorkflowDefinitions(JSON.stringify([{ ...fromEnvironment, secret: "also-a-literal-secret" }]), {
      TEST_WEBHOOK_SECRET: "environment-secret-value",
    }),
    /only one of secret or secretEnv/,
  );
  assert.throws(
    () => parseWorkflowDefinitions(JSON.stringify([{ ...JSON.parse(definitionJson())[0], ttlMs: 10 }])),
    /ttlMs must be an integer/,
  );
  assert.equal(renderWorkflowPrompt("Object {{issue.fields}} missing={{none}}", payload), 'Object {"summary":"Broken login"} missing=');
});

test("workflow checkpoints enforce order, retries, attempt limits, and completion", () => {
  const run: WorkflowRun = {
    id: "run-1",
    definitionId: "definition",
    source: "jira",
    deliveryId: "delivery",
    payloadHash: "hash",
    project: "product",
    targetAgentId: "agent",
    targetAgentName: "coordinator",
    messageId: "message",
    status: "running",
    currentStage: "reproduce",
    stages: [
      { id: "reproduce", label: "Reproduce", instructions: "Do it", requiredEvidence: [], maxAttempts: 2, status: "in_progress", attempts: 0, evidence: [] },
      { id: "implement", label: "Implement", instructions: "Do it", requiredEvidence: [], maxAttempts: 1, status: "pending", attempts: 0, evidence: [] },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  assert.throws(() => checkpointRun(run, "implement", "passed", "early", [], "2026-01-01T00:01:00.000Z"), /not currently active/);
  const retry = checkpointRun(run, "reproduce", "warning", "flaky reproduction", ["log"], "2026-01-01T00:01:00.000Z");
  assert.equal(retry.retry, true);
  const advanced = checkpointRun(run, "reproduce", "passed", "stable reproduction", ["test"], "2026-01-01T00:02:00.000Z");
  assert.equal(advanced.run.currentStage, "implement");
  const completed = checkpointRun(run, "implement", "passed", "implemented", ["commit"], "2026-01-01T00:03:00.000Z");
  assert.equal(completed.completed, true);
  assert.equal(run.status, "completed");
  assert.throws(() => checkpointRun(run, "implement", "passed", "again", [], "2026-01-01T00:04:00.000Z"), /workflow is completed/);
});

test("workflow checkpoints reject incomplete evidence and fail after exhausted retries", () => {
  const run: WorkflowRun = {
    id: "run-2",
    definitionId: "definition",
    source: "generic",
    deliveryId: "delivery",
    payloadHash: "hash",
    project: "product",
    targetAgentId: "agent",
    targetAgentName: "coordinator",
    messageId: "message",
    status: "running",
    currentStage: "gate",
    stages: [{
      id: "gate",
      label: "Gate",
      instructions: "Run checks",
      requiredEvidence: ["lint", "build"],
      maxAttempts: 2,
      status: "in_progress",
      attempts: 0,
      evidence: [],
    }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  assert.throws(
    () => checkpointRun(run, "gate", "passed", "not enough", ["lint"], "2026-01-01T00:01:00.000Z"),
    /requires at least 2 evidence items/,
  );
  assert.equal(run.stages[0]!.attempts, 0);
  assert.equal(checkpointRun(run, "gate", "failed", "first", ["log"], "2026-01-01T00:01:00.000Z").retry, true);
  const exhausted = checkpointRun(run, "gate", "failed", "second", ["log"], "2026-01-01T00:02:00.000Z");
  assert.equal(exhausted.retry, false);
  assert.equal(run.status, "failed");
  assert.equal(run.currentStage, undefined);
});

test("improvement reports group and prioritize learning evidence", () => {
  const base = {
    runId: "run",
    agentId: "agent",
    details: "detail",
    evidence: [],
    relatedEntryIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const entries: WorkflowJournalEntry[] = [
    { ...base, id: "1", category: "error", area: "gates", severity: "error", summary: "Lint missed generated files" },
    { ...base, id: "2", category: "lesson", area: "gates", severity: "warning", summary: "Run generated checks first" },
    { ...base, id: "3", category: "decision", area: "implementation", severity: "info", summary: "Use adapter" },
  ];
  const reports = improvementReport(entries);
  assert.equal(reports[0]!.area, "gates");
  assert.equal(reports[0]!.errors, 1);
  assert.equal(reports[0]!.priorities[0]!.id, "1");
  assert.equal(reports[1]!.area, "implementation");
});
