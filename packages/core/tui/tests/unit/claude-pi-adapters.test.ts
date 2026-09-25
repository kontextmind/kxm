import assert from "node:assert/strict";
import test from "node:test";
import {
  formatClaudeTaskHud,
  formatClaudeUpcomingQueue,
  formatClaudeOptimizerReport,
  formatClaudeRoleBudget,
  formatClaudeWorkflowHistory,
} from "../../src/adapters/claude.ts";
import {
  createKxmTuiPiOverlay,
  renderPiWorkflowWidget,
} from "../../src/adapters/pi.ts";
import { createKxmTuiRegistry } from "../../src/services/registry.ts";
import { createPlainKxmTuiTheme } from "../../src/tui/theme.ts";
import { referenceSurface } from "../helpers/surface.ts";

test("Claude Code Adapter: formats terminal HUD, upcoming queue, optimizer, and budget", () => {
  // 1. Task HUD
  const hudBoxed = formatClaudeTaskHud({
    goal: "OAuth PKCE Refactor",
    stageName: "Implementation",
    stageIndex: 2,
    totalStages: 3,
    completedTasks: 3,
    totalTasks: 5,
    activeTaskTitle: "Validate refresh rotation",
    activeRole: "implementer",
    activeModel: "claude-3-5-sonnet",
    attempt: 2,
    maxAttempts: 3,
    elapsedSeconds: 24,
    autoDispatch: true,
  });

  assert.match(hudBoxed, /KXM TASK HUD/);
  assert.match(hudBoxed, /Goal: OAuth PKCE Refactor/);
  assert.match(hudBoxed, /Stage 2\/3: Implementation/);
  assert.match(hudBoxed, /\[██████░░░░\] 60%/);
  assert.match(hudBoxed, /Mode: \[AUTO\]/);
  assert.match(hudBoxed, /Active Task: Validate refresh rotation \(Attempt 2\/3\)/);

  const hudCompact = formatClaudeTaskHud({
    goal: "OAuth PKCE Refactor",
    stageName: "Implementation",
    stageIndex: 2,
    totalStages: 3,
    completedTasks: 3,
    totalTasks: 5,
    autoDispatch: false,
  }, true);
  assert.match(hudCompact, /\[KXM \[STEP\]\] OAuth PKCE Refactor/);

  // 2. Upcoming Queue
  const queueFormatted = formatClaudeUpcomingQueue([
    {
      id: "task_4",
      title: "Unit tests",
      stageId: "s2",
      role: "test-writer",
      harness: "pi",
      model: "qwen3",
      status: "pending",
      dependencies: ["task_3"],
      attempt: 1,
      maxAttempts: 3,
    },
    {
      id: "task_5",
      title: "API Docs",
      stageId: "s2",
      role: "doc-writer",
      harness: "omp",
      model: "gemini",
      status: "pending",
      dependencies: [],
      attempt: 1,
      maxAttempts: 3,
    },
  ]);
  assert.match(queueFormatted, /### KXM Upcoming Task Queue:/);
  assert.match(queueFormatted, /1\. \[PENDING\] \*\*Unit tests\*\* \(`task_4`\)/);
  assert.match(queueFormatted, /Requires: task_3/);
  assert.match(queueFormatted, /2\. \[PENDING\] \*\*API Docs\*\* \(`task_5`\)/);
  assert.match(queueFormatted, /Ready/);

  // 3. Optimizer Report
  const optReport = formatClaudeOptimizerReport({
    proposals: [
      {
        id: "opt_1",
        category: "concurrency",
        title: "Fanout Tests & Docs",
        description: "Execute task_4 and task_5 in parallel",
        targetTaskIds: ["task_4", "task_5"],
        projectedTimeSavingsSeconds: 30,
        projectedCostSavingsPercent: 0,
        selected: true,
      },
    ],
    totalProjectedTimeSavingsSeconds: 30,
    totalProjectedCostSavingsPercent: 25,
  });
  assert.match(optReport, /### KXM Plan Optimizer Proposals:/);
  assert.match(optReport, /Total Projected Savings: -30s execution time, -25% token cost/);
  assert.match(optReport, /⚡ \*\*Fanout Tests & Docs\*\*/);

  // 4. Role Budget
  const budgetLine = formatClaudeRoleBudget(
    {
      roleId: "implementer",
      type: "hybrid",
      runSpendCapUsd: 2.50,
      monthlySpendCapUsd: 35.00,
      onExhausted: "cascade_to_roster",
      fallbackModel: "qwen3-coder",
    },
    {
      roleId: "implementer",
      currentRunSpendUsd: 0.85,
      currentMonthlySpendUsd: 14.50,
      usedTokens: 500000,
      rolledOverTokens: 0,
      borrowedFromPoolUsd: 0,
    },
  );
  assert.match(budgetLine, /Role: implementer \(hybrid\)/);
  assert.match(budgetLine, /Run Spend: \$0.8500 \/ \$2.50/);
  assert.match(budgetLine, /Monthly Spend: \$14.50 \/ \$35.00/);
  assert.match(budgetLine, /On Exhausted: cascade_to_roster \(Fallback: qwen3-coder\)/);

  // 5. Workflow History
  const historyMd = formatClaudeWorkflowHistory("run_123", [
    {
      id: "ev_1",
      timestamp: "2026-09-25T19:00:00Z",
      category: "task",
      title: "Init task",
      status: "passed",
    },
  ]);
  assert.match(historyMd, /# KXM Workflow Retrospective: run_123/);
  assert.match(historyMd, /Init task/);
});

test("Pi Adapter: creates overlay and formats Pi widget lines", () => {
  const registry = createKxmTuiRegistry();
  registry.register({
    source: "kxm/pi-test",
    listSections: () => referenceSurface(),
    handlers: {},
  });

  const overlay = createKxmTuiPiOverlay({
    registry,
    tui: { requestRender: () => {} },
    theme: createPlainKxmTuiTheme() as any,
    title: "Pi Plan Overlay",
    goal: "Refactor Auth",
    autoDispatch: true,
  });

  assert.equal(overlay.getMode(), "expanded");
  assert.equal(overlay.isAutoDispatch(), true);

  // Render Pi widget
  const widgetLines = renderPiWorkflowWidget({
    goal: "Refactor Auth",
    stage: "Implementation",
    progressPercent: 65,
    activeTask: "task_3 (Validate tokens)",
    autoDispatch: true,
  });

  assert.equal(widgetLines.length, 2);
  assert.match(widgetLines[0]!, /\[KXM\] Goal: Refactor Auth ── Stage: Implementation/);
  assert.match(widgetLines[0]!, /65%/);
  assert.match(widgetLines[0]!, /\[AUTO\]/);
  assert.match(widgetLines[1]!, /Active: task_3 \(Validate tokens\)/);

  overlay.dispose();
});
