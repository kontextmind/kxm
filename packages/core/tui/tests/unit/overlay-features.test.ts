import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  evaluatePlanOptimizations,
  applyPlanOptimizations,
  type OptimizerTaskInput,
} from "../../src/tui/optimizer.ts";
import {
  filterHistoryEvents,
  renderWorkflowHistoryMarkdown,
  formatWorkflowHistoryJsonl,
  type HistoryEventItem,
} from "../../src/tui/history.ts";
import {
  exportWorkflowHistory,
} from "../../src/adapters/historyExport.ts";
import {
  reorderQueuedTasks,
  type QueuedTaskItem,
} from "../../src/tui/queue.ts";
import {
  evaluateRoleBudget,
  type RoleBudgetConfig,
  type RoleBudgetState,
} from "../../src/tui/roleBudget.ts";
import {
  filterModelOptions,
  type ModelOptionItem,
} from "../../src/tui/modelSelector.ts";

test("Plan Optimizer: detects concurrency fanout and cost downscaling proposals", () => {
  const tasks: OptimizerTaskInput[] = [
    {
      id: "t1",
      title: "Write core auth handler",
      stageId: "s1",
      role: "implementer",
      harness: "omp",
      model: "claude-3-5-sonnet",
      dependencies: [],
      category: "implementation",
    },
    {
      id: "t2",
      title: "Write documentation markdown",
      stageId: "s1",
      role: "doc-writer",
      harness: "omp",
      model: "claude-3-5-sonnet",
      dependencies: [],
      category: "docs",
    },
  ];

  const result = evaluatePlanOptimizations(tasks);
  assert.ok(result.proposals.length >= 2);
  const fanout = result.proposals.find((p) => p.category === "concurrency");
  assert.ok(fanout);
  assert.deepEqual(fanout.targetTaskIds, ["t1", "t2"]);

  const cost = result.proposals.find((p) => p.category === "cost");
  assert.ok(cost);
  assert.deepEqual(cost.targetTaskIds, ["t2"]);
  assert.equal(cost.suggestedModel, "qwen/qwen3-coder-plus");

  // Apply optimizations
  const applied = applyPlanOptimizations(tasks, result.proposals);
  assert.equal(applied.appliedCount, result.proposals.length);
  const updatedDocTask = applied.tasks.find((t) => t.id === "t2");
  assert.equal(updatedDocTask?.model, "qwen/qwen3-coder-plus");
});

test("Workflow History: filters by category and search query, exports both Markdown and JSONL", () => {
  const events: HistoryEventItem[] = [
    {
      id: "ev_1",
      timestamp: "2026-09-25T18:40:00.000Z",
      category: "task",
      title: "PKCE implementation",
      status: "passed",
      role: "implementer",
      harness: "omp",
      model: "claude-sonnet",
      durationMs: 14000,
      costUsd: 0.02,
      artifacts: ["src/auth/pkce.ts"],
    },
    {
      id: "ev_2",
      timestamp: "2026-09-25T18:41:00.000Z",
      category: "gate",
      title: "Security critic gate",
      status: "passed",
      role: "critic",
      harness: "pi",
      model: "gemini-2.5-pro",
    },
  ];

  // Filtering
  const taskOnly = filterHistoryEvents(events, { category: "task" });
  assert.equal(taskOnly.length, 1);
  assert.equal(taskOnly[0]?.id, "ev_1");

  const searchFilter = filterHistoryEvents(events, { query: "critic" });
  assert.equal(searchFilter.length, 1);
  assert.equal(searchFilter[0]?.id, "ev_2");

  // Dual Export
  const tmp = mkdtempSync(join(tmpdir(), "kxm-history-export-"));
  try {
    const exported = exportWorkflowHistory("run_test123", events, tmp);
    const md = readFileSync(exported.mdPath, "utf8");
    assert.match(md, /# KXM Workflow Retrospective: run_test123/);
    assert.match(md, /PKCE implementation/);
    assert.match(md, /`src\/auth\/pkce.ts`/);

    const jsonl = readFileSync(exported.jsonlPath, "utf8");
    assert.match(jsonl, /"schema":"kxm.workflow-history-event.v1"/);
    assert.match(jsonl, /"runId":"run_test123"/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("Task Queue: reorders tasks safely and prevents prerequisite violations", () => {
  const tasks: QueuedTaskItem[] = [
    {
      id: "task_a",
      title: "Task A",
      stageId: "s1",
      role: "impl",
      harness: "omp",
      model: "sonnet",
      status: "pending",
      dependencies: [],
      attempt: 1,
      maxAttempts: 3,
    },
    {
      id: "task_b",
      title: "Task B",
      stageId: "s1",
      role: "impl",
      harness: "omp",
      model: "sonnet",
      status: "pending",
      dependencies: ["task_a"],
      attempt: 1,
      maxAttempts: 3,
    },
    {
      id: "task_c",
      title: "Task C",
      stageId: "s1",
      role: "impl",
      harness: "omp",
      model: "sonnet",
      status: "pending",
      dependencies: [],
      attempt: 1,
      maxAttempts: 3,
    },
  ];

  // Moving task_c from index 2 to index 0 is valid (task_c has no deps)
  const validMove = reorderQueuedTasks(tasks, 2, 0);
  assert.equal(validMove.success, true);
  assert.equal(validMove.tasks[0]?.id, "task_c");

  // Moving task_b before task_a violates dependency constraint
  const invalidMove = reorderQueuedTasks(tasks, 1, 0);
  assert.equal(invalidMove.success, false);
  assert.match(invalidMove.warning ?? "", /Prerequisite violation/);
});

test("Role Budget: evaluates spend caps and triggers rollover cascades", () => {
  const config: RoleBudgetConfig = {
    roleId: "implementer",
    type: "hybrid",
    runSpendCapUsd: 2.00,
    monthlySpendCapUsd: 30.00,
    onExhausted: "cascade_to_roster",
    fallbackModel: "qwen3-coder-plus",
    fallbackHarness: "pi",
  };

  const withinBudgetState: RoleBudgetState = {
    roleId: "implementer",
    currentRunSpendUsd: 0.50,
    currentMonthlySpendUsd: 10.00,
    usedTokens: 100000,
    rolledOverTokens: 0,
    borrowedFromPoolUsd: 0,
  };

  // Within budget
  const okEval = evaluateRoleBudget(config, withinBudgetState, 0.10);
  assert.equal(okEval.status, "ok");
  assert.equal(okEval.nextAction, "proceed");

  // Exceeds run cap -> triggers cascade to fallbackModel
  const exhaustedState: RoleBudgetState = {
    ...withinBudgetState,
    currentRunSpendUsd: 1.95,
  };
  const cascadeEval = evaluateRoleBudget(config, exhaustedState, 0.20);
  assert.equal(cascadeEval.status, "exhausted");
  assert.equal(cascadeEval.nextAction, "cascade");
  assert.equal(cascadeEval.fallbackModel, "qwen3-coder-plus");
  assert.equal(cascadeEval.fallbackHarness, "pi");
});

test("Model Selector: filters by query and provider", () => {
  const models: ModelOptionItem[] = [
    {
      id: "claude-3-5-sonnet",
      selector: "anthropic/claude-3-5-sonnet",
      name: "Claude 3.5 Sonnet",
      provider: "anthropic",
      harness: "omp",
      contextWindow: 200000,
      reasoning: true,
      cost: { inputPerMillion: 3, outputPerMillion: 15 },
      authStatus: "ready",
    },
    {
      id: "qwen3-coder-plus",
      selector: "openrouter/qwen/qwen3-coder-plus",
      name: "Qwen3 Coder Plus",
      provider: "openrouter",
      harness: "pi",
      contextWindow: 128000,
      reasoning: true,
      cost: { inputPerMillion: 1, outputPerMillion: 3 },
      authStatus: "ready",
    },
  ];

  const sonnetMatch = filterModelOptions(models, "sonnet");
  assert.equal(sonnetMatch.length, 1);
  assert.equal(sonnetMatch[0]?.id, "claude-3-5-sonnet");

  const piMatch = filterModelOptions(models, undefined, "pi");
  assert.equal(piMatch.length, 1);
  assert.equal(piMatch[0]?.id, "qwen3-coder-plus");
});
