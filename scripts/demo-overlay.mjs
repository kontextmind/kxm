#!/usr/bin/env node

/**
 * Interactive Demo for KXM Task & Plan TUI Overlay.
 *
 * Demonstrates:
 * - Collapsible overlay (Ctrl+O or F2 to toggle collapsed strip vs 3-pane view)
 * - Auto-Dispatch toggle (press 'a')
 * - Full Workflow History view (press 'h')
 * - Dual History Export (press 'x' in history view)
 * - Plan Optimizer (press 'o')
 * - Task Reordering & navigation
 */

import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { createKxmTuiRegistry } from "../packages/core/tui/dist/index.js";
import { createKxmTuiOmpOverlay } from "../packages/core/tui/dist/index.js";
import { createDefaultKxmTuiTheme } from "../packages/core/tui/dist/index.js";
import { exportWorkflowHistory } from "../packages/core/tui/dist/index.js";
import { evaluatePlanOptimizations, applyPlanOptimizations } from "../packages/core/tui/dist/index.js";

const registry = createKxmTuiRegistry();

// Register mock workflow tasks and stages
registry.register({
  source: "kxm/demo",
  listSections: () => [
    {
      id: "active_stage",
      title: "Stage 2: Implementation (Active)",
      fields: [
        {
          id: "task_1",
          label: "● task_1: Generate PKCE verifier",
          value: "Passed (omp/claude-sonnet) ⏱ 12s",
          status: "saved",
        },
        {
          id: "task_2",
          label: "● task_2: Exchange route /v1/auth/exchange",
          value: "Passed (omp/claude-sonnet) ⏱ 28s",
          status: "saved",
        },
        {
          id: "task_3",
          label: "◐ task_3: Validate refresh rotation",
          value: "Attempt 2/3 (pi/qwen3) ⏱ 14s",
          status: "busy",
        },
      ],
    },
    {
      id: "upcoming_queue",
      title: "Upcoming Tasks & Lookahead",
      fields: [
        {
          id: "task_4",
          label: "◌ task_4: Write unit tests",
          value: "Role: implementer (pi/qwen3) [Requires: task_3]",
        },
        {
          id: "task_5",
          label: "◌ task_5: Document auth endpoints",
          value: "Role: doc-writer (omp/gemini) [Ready]",
        },
        {
          id: "task_6",
          label: "◌ task_6: Security critic audit",
          value: "Role: security-critic (claude) [Requires: task_4]",
        },
      ],
    },
  ],
  handlers: {},
});

const terminal = new ProcessTerminal();
const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
const theme = createDefaultKxmTuiTheme();

let finished = false;

const overlay = createKxmTuiOmpOverlay({
  registry,
  tui: {
    requestRender: () => {
      tui.requestRender();
    },
  },
  theme: theme,
  title: "KXM Task & Plan Overlay Demo",
  goal: "Implement OAuth PKCE & Token Refresh (#14)",
  autoDispatch: false,
  onToggleAutoDispatch: (auto) => {
    // notified
  },
  onRunOptimizer: async () => {
    const sampleTasks = [
      {
        id: "task_4",
        title: "Write unit tests",
        stageId: "s2",
        role: "implementer",
        harness: "pi",
        model: "claude-3-5-sonnet",
        dependencies: [],
        category: "test",
      },
      {
        id: "task_5",
        title: "Document auth endpoints",
        stageId: "s2",
        role: "doc-writer",
        harness: "omp",
        model: "claude-3-5-sonnet",
        dependencies: [],
        category: "docs",
      },
    ];
    const result = evaluatePlanOptimizations(sampleTasks);
    // proposal computed
  },
  onExportHistory: async (format) => {
    const sampleEvents = [
      {
        id: "ev_1",
        timestamp: new Date().toISOString(),
        category: "task",
        title: "Generate PKCE verifier",
        status: "passed",
        role: "implementer",
        harness: "omp",
        model: "claude-sonnet",
        durationMs: 12000,
        costUsd: 0.018,
        artifacts: ["src/auth/pkce.ts"],
      },
      {
        id: "ev_2",
        timestamp: new Date().toISOString(),
        category: "task",
        title: "Validate refresh rotation",
        status: "passed",
        role: "implementer",
        harness: "pi",
        model: "qwen3-coder",
        durationMs: 14000,
        costUsd: 0.003,
      },
    ];
    return exportWorkflowHistory("run_demo_8f3a", sampleEvents, ".kxm/assets/retrospectives");
  },
  done: () => {
    finished = true;
    tui.stop();
    process.exit(0);
  },
});

tui.start({
  render: (width) => overlay.render(width),
  handleInput: (data) => {
    // q to quit demo
    if (data === "q" || data === "\x03") {
      overlay.dispose();
      return;
    }
    overlay.handleInput(data);
  },
  invalidate: () => overlay.invalidate(),
});

process.on("SIGINT", () => {
  overlay.dispose();
});
