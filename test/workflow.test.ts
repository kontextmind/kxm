import assert from "node:assert/strict";
import test from "node:test";
import {
  checkpointRun,
  improvementReport,
  parseWorkflowDefinitions,
  renderWorkflowPrompt,
  resumeWorkflowFromSignal,
  valueAtPath,
  waitForWorkflowSignal,
  type WorkflowJournalEntry,
  type WorkflowRun,
} from "../plugins/kxm-mesh/src/workflow.ts";

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
  const normalizedRequirements = JSON.parse(definitionJson())[0];
  normalizedRequirements.stages[0].requiredEvidence = ["  Local   Review ", "GitHub.Check:CI"];
  assert.deepEqual(
    parseWorkflowDefinitions(JSON.stringify([normalizedRequirements]))[0]!.stages[0]!.requiredEvidence,
    ["local review", "github.check:ci"],
  );
  normalizedRequirements.stages[0].requiredEvidence = ["Review", " review "];
  assert.throws(
    () => parseWorkflowDefinitions(JSON.stringify([normalizedRequirements])),
    /requiredEvidence keys must be unique/,
  );
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
  fromEnvironment.signalSecretEnv = "TEST_SIGNAL_SECRET";
  assert.equal(
    parseWorkflowDefinitions(JSON.stringify([fromEnvironment]), {
      TEST_WEBHOOK_SECRET: "environment-secret-value",
      TEST_SIGNAL_SECRET: "separate-signal-secret-value",
    })[0]!.signalSecret,
    "separate-signal-secret-value",
  );
  assert.throws(
    () => parseWorkflowDefinitions(JSON.stringify([fromEnvironment]), {
      TEST_WEBHOOK_SECRET: "environment-secret-value",
    }),
    /workflow.signalSecret must be a string/,
  );
  assert.throws(
    () => parseWorkflowDefinitions(JSON.stringify([{ ...fromEnvironment, secret: "also-a-literal-secret" }]), {
      TEST_WEBHOOK_SECRET: "environment-secret-value",
      TEST_SIGNAL_SECRET: "separate-signal-secret-value",
    }),
    /only one of secret or secretEnv/,
  );
  assert.throws(
    () => parseWorkflowDefinitions(JSON.stringify([{ ...fromEnvironment, signalSecret: "also-a-signal-secret" }]), {
      TEST_WEBHOOK_SECRET: "environment-secret-value",
      TEST_SIGNAL_SECRET: "separate-signal-secret-value",
    }),
    /only one of signalSecret or signalSecretEnv/,
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
  assert.throws(() => checkpointRun(run, "implement", "passed", "early", {}, "2026-01-01T00:01:00.000Z"), /not currently active/);
  const retry = checkpointRun(run, "reproduce", "warning", "flaky reproduction", { log: "first attempt" }, "2026-01-01T00:01:00.000Z");
  assert.equal(retry.retry, true);
  const advanced = checkpointRun(run, "reproduce", "passed", "stable reproduction", {
    steps: "documented reproduction steps",
    "failing test": "test/reproduction.test.ts",
  }, "2026-01-01T00:02:00.000Z");
  assert.equal(advanced.run.currentStage, "implement");
  const completed = checkpointRun(run, "implement", "passed", "implemented", {}, "2026-01-01T00:03:00.000Z");
  assert.equal(completed.completed, true);
  assert.equal(run.status, "completed");
  assert.throws(() => checkpointRun(run, "implement", "passed", "again", {}, "2026-01-01T00:04:00.000Z"), /workflow is completed/);
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
    () => checkpointRun(run, "gate", "passed", "unrelated volume", {
      one: "lint passed",
      two: "build passed",
      three: "extra evidence",
    }, "2026-01-01T00:01:00.000Z"),
    /missing required evidence: lint, build/,
  );
  assert.throws(
    () => checkpointRun(run, "gate", "passed", "duplicate aliases", {
      Lint: "first",
      " lint ": "second",
      build: "pass",
    }, "2026-01-01T00:01:00.000Z"),
    /duplicate normalized requirement identity: lint/,
  );
  assert.equal(run.stages[0]!.attempts, 0);
  assert.equal(checkpointRun(run, "gate", "failed", "first", { log: "failure" }, "2026-01-01T00:01:00.000Z").retry, true);
  const exhausted = checkpointRun(run, "gate", "failed", "second", { log: "failure" }, "2026-01-01T00:02:00.000Z");
  assert.equal(exhausted.retry, false);
  assert.equal(run.status, "failed");
  assert.equal(run.currentStage, undefined);
});

test("workflow signal waits preserve stage order and resume through normal checkpoint rules", () => {
  const run: WorkflowRun = {
    id: "run-signal",
    definitionId: "definition",
    source: "github",
    deliveryId: "delivery",
    payloadHash: "hash",
    project: "product",
    targetAgentId: "agent",
    targetAgentName: "coordinator",
    messageId: "message",
    status: "running",
    currentStage: "checks",
    stages: [{
      id: "checks",
      label: "Checks",
      instructions: "Wait for CI",
      requiredEvidence: ["local-review", "github.check:ci"],
      maxAttempts: 2,
      status: "in_progress",
      attempts: 0,
      evidence: [],
    }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  waitForWorkflowSignal(
    run,
    "checks",
    "github-pr-42-checks",
    "GitHub Actions is running",
    "2026-01-01T00:01:00.000Z",
    "2026-01-02T00:01:00.000Z",
    { " Local-Review ": "review artifact" },
  );
  assert.equal(run.status, "waiting");
  assert.equal(run.stages[0]!.status, "waiting");
  assert.throws(
    () => resumeWorkflowFromSignal(run, "wrong-key", "passed", "done", { "github.check:ci": "url" }, "2026-01-01T00:02:00.000Z"),
    /waiting for github-pr-42-checks/,
  );
  assert.throws(
    () => resumeWorkflowFromSignal(run, "github-pr-42-checks", "passed", "done", {
      "workflow.run": "run-signal",
      "workflow.stage": "checks",
      "workflow.signal": "github-pr-42-checks",
      "unrelated-1": "a",
      "unrelated-2": "b",
    }, "2026-01-01T00:02:00.000Z"),
    /missing required evidence: github\.check:ci/,
  );
  assert.equal(run.status, "waiting");
  const retry = resumeWorkflowFromSignal(
    run,
    "github-pr-42-checks",
    "failed",
    "test failed",
    { "github.check:ci": "https://ci.example/failure" },
    "2026-01-01T00:02:00.000Z",
  );
  assert.equal(retry.retry, true);
  assert.equal(run.status, "running");
  assert.equal(run.waiting, undefined);
  assert.deepEqual(run.stages[0]!.evidence, {
    "local-review": ["review artifact"],
  });
  waitForWorkflowSignal(
    run,
    "checks",
    "github-pr-42-checks-rerun",
    "CI rerun",
    "2026-01-01T00:03:00.000Z",
    "2026-01-02T00:03:00.000Z",
  );
  const completed = resumeWorkflowFromSignal(
    run,
    "github-pr-42-checks-rerun",
    "passed",
    "all checks passed",
    { " GitHub.Check:CI ": "https://ci.example/success" },
    "2026-01-01T00:04:00.000Z",
  );
  assert.equal(completed.completed, true);
  assert.equal(run.status, "completed");
  assert.deepEqual(run.stages[0]!.evidence, {
    "local-review": ["review artifact"],
    "github.check:ci": ["https://ci.example/success"],
  });
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
