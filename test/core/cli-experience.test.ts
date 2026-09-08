import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadKxmConfig,
  setKxmConfigValue,
  getKxmConfigValue,
  formatKxmConfig,
  KXM_CONFIG_SCHEMA,
  type KxmResolvedConfig,
} from "../../plugins/kxm/src/config.ts";
import { generateShellCompletion } from "../../plugins/kxm/src/autocomplete.ts";
import { suggestWorkflowAndRoles } from "../../plugins/kxm/src/suggest.ts";
import {
  createGoal,
  createTask,
  listGoals,
  listTasks,
  updateTaskStatus,
  syncTaskWithTracker,
  GOAL_SCHEMA,
  TASK_SCHEMA,
} from "../../plugins/kxm/src/task-manager.ts";
import { runCli as runCliImplementation, type CliIo } from "../../plugins/kxm/src/cli.ts";

function createSandbox(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "kxm-cli-exp-"));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

test("config: loads defaults and resolves user/repo overrides", () => {
  const sandbox = createSandbox();
  try {
    const config = loadKxmConfig(sandbox.dir, {
      userConfigDir: join(sandbox.dir, "user-config"),
    });
    assert.equal(config.schema, KXM_CONFIG_SCHEMA);
    assert.equal(config.dash.defaultScreen, "agents");
    assert.equal(config.sync.defaultTracker, "none");
    assert.equal(config.user.theme, "dark");
    assert.equal(config.improvement.promotionPolicy, "manual_pr");
    assert.equal(config.improvement.telemetryHalfLifeDays, 14);
    assert.equal(config.routing.shadowExecution.enabled, false);
    assert.equal(config.routing.shadowExecution.sampleRate, 0.05);
    assert.equal(config.routing.circuitBreaker?.mode, "soft_demotion");
    assert.equal(config.routing.circuitBreaker?.failureThreshold, 3);
    assert.equal(config.telemetry.federated, true);
    assert.equal(config.telemetry.anonymize, true);

    // Set repo-level config
    setKxmConfigValue(sandbox.dir, "user.preferredModel", "grok-4.6", { scope: "project" });
    setKxmConfigValue(sandbox.dir, "sync.defaultTracker", "github", { scope: "project" });
    setKxmConfigValue(sandbox.dir, "dash.defaultScreen", "workflows", { scope: "project" });
    setKxmConfigValue(sandbox.dir, "improvement.promotionPolicy", "critic_quorum", { scope: "project" });

    const reloaded = loadKxmConfig(sandbox.dir, {
      userConfigDir: join(sandbox.dir, "user-config"),
    });
    assert.equal(reloaded.user.preferredModel, "grok-4.6");
    assert.equal(reloaded.sync.defaultTracker, "github");
    assert.equal(reloaded.dash.defaultScreen, "workflows");
    assert.equal(reloaded.improvement.promotionPolicy, "critic_quorum");

    setKxmConfigValue(sandbox.dir, "improvement.promotionPolicy", "auto_threshold", { scope: "project" });
    setKxmConfigValue(sandbox.dir, "routing.shadowExecution.enabled", true, { scope: "project" });
    setKxmConfigValue(sandbox.dir, "routing.shadowExecution.sampleRate", 0.15, { scope: "project" });
    setKxmConfigValue(sandbox.dir, "routing.circuitBreaker.mode", "quarantine", { scope: "project" });
    setKxmConfigValue(sandbox.dir, "telemetry.federated", false, { scope: "project" });
    const reloaded2 = loadKxmConfig(sandbox.dir, {
      userConfigDir: join(sandbox.dir, "user-config"),
    });
    assert.equal(reloaded2.improvement.promotionPolicy, "auto_threshold");
    assert.equal(reloaded2.routing.shadowExecution.enabled, true);
    assert.equal(reloaded2.routing.shadowExecution.sampleRate, 0.15);
    assert.equal(reloaded2.routing.circuitBreaker?.mode, "quarantine");
    assert.equal(reloaded2.telemetry.federated, false);

    // Getter works for deep keys
    assert.equal(getKxmConfigValue(reloaded, "user.preferredModel"), "grok-4.6");
    assert.equal(getKxmConfigValue(reloaded, "dash.defaultScreen"), "workflows");
    assert.equal(getKxmConfigValue(reloaded, "non.existent.key"), undefined);

    // Formatter outputs valid text
    const text = formatKxmConfig(reloaded);
    assert.match(text, /preferredModel:\s*grok-4\.6/);
  } finally {
    sandbox.cleanup();
  }
});

test("autocomplete: generates bash, zsh, and fish completion scripts", () => {
  const bash = generateShellCompletion("bash");
  assert.match(bash, /_kxm_completions\(\)/);
  assert.match(bash, /workflow/);
  assert.match(bash, /memory/);
  assert.match(bash, /context/);
  assert.match(bash, /dash/);
  assert.match(bash, /suggest/);
  assert.match(bash, /task/);
  assert.match(bash, /goal/);

  const zsh = generateShellCompletion("zsh");
  assert.match(zsh, /#compdef kxm/);
  assert.match(zsh, /_kxm\(\)/);

  const fish = generateShellCompletion("fish");
  assert.match(fish, /complete -c kxm/);
});

test("suggest: recommends workflow, area, roles, and skills based on prompt keywords", () => {
  // Test bug fix suggestion
  const bugSuggestion = suggestWorkflowAndRoles("Fix flaky playwright gate timeout in session test", {
    availableHarnesses: [
      { harness: "claude", auth: "active" },
      { harness: "grok", auth: "active" },
      { harness: "codex", auth: "active" },
    ],
  });
  assert.equal(bugSuggestion.workflowId, "software-engineering/bug-fix");
  assert.equal(bugSuggestion.area, "software-engineering");
  assert.equal(bugSuggestion.roles.planner.model, "fable");
  assert.equal(bugSuggestion.roles.writer.harness, "grok");
  assert.ok(bugSuggestion.reasons.length > 0);

  // Test security suggestion
  const secSuggestion = suggestWorkflowAndRoles("Remediate CVE vulnerability and sanitize prompt injection", {
    availableHarnesses: [{ harness: "claude", auth: "active" }],
  });
  assert.equal(secSuggestion.workflowId, "security-reliability/vulnerability-remediation");
  assert.equal(secSuggestion.area, "security-reliability");

  // Test pipeline/migration suggestion
  const dbSuggestion = suggestWorkflowAndRoles("Migrate SQLite tables to support foreign key cascading and WAL mode", {
    availableHarnesses: [{ harness: "codex", auth: "active" }],
  });
  assert.equal(dbSuggestion.workflowId, "data-analytics/pipeline-migration");
});

test("task-manager: creates goals, tasks, updates lifecycle, and syncs with trackers", () => {
  const sandbox = createSandbox();
  try {
    const goal = createGoal(sandbox.dir, {
      title: "Deliver KXM 0.6 Control Plane",
      area: "software-engineering",
      successMetrics: ["All verification gates green", "TUI and Web dashboards functional"],
    });
    assert.equal(goal.schema, GOAL_SCHEMA);
    assert.ok(goal.id.startsWith("goal_"));
    assert.equal(goal.status, "active");

    const goals = listGoals(sandbox.dir);
    assert.equal(goals.length, 1);
    assert.equal(goals[0]?.id, goal.id);

    const task = createTask(sandbox.dir, {
      goalId: goal.id,
      title: "Implement External Side-Effect Idempotency Ledger",
      objective: "Add SQLite external_effects table with preflight verification",
      acceptanceCriteria: [
        { description: "No duplicate PRs on crash recovery", required: true },
        { description: "CAS ledger tests pass", required: true },
      ],
      assignedWorkflow: "software-engineering/feature-implementation",
      trackerSync: {
        tracker: "github",
        issueKey: "127",
      },
    });
    assert.equal(task.schema, TASK_SCHEMA);
    assert.ok(task.id.startsWith("task_"));
    assert.equal(task.status, "todo");
    assert.equal(task.goalId, goal.id);

    const tasks = listTasks(sandbox.dir);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.id, task.id);

    // Update status
    const updated = updateTaskStatus(sandbox.dir, task.id, "in_progress", {
      workflowRunId: "run_01928abc",
    });
    assert.equal(updated.status, "in_progress");
    assert.equal(updated.workflowRunId, "run_01928abc");

    // Tracker sync simulation
    const synced = syncTaskWithTracker(sandbox.dir, task.id, {
      mockRemoteState: "open",
      commentReceipt: "Receipt sha256:abc verified",
    });
    assert.equal(synced.trackerSync?.syncStatus, "synced");
  } finally {
    sandbox.cleanup();
  }
});

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: (text: string) => { stdout += text; },
    stderr: (text: string) => { stderr += text; },
    read: () => ({ stdout, stderr }),
  };
}

async function runCli(argv: string[], env: NodeJS.ProcessEnv, io: CliIo, cwd = process.cwd()): Promise<number> {
  const isolatedLogs = mkdtempSync(join(tmpdir(), "kxm-cli-exp-run-"));
  try {
    return await runCliImplementation(argv, { KXM_LOGS_DIR: isolatedLogs, KXM_STATE_HOME: isolatedLogs, ...env }, io, cwd);
  } finally {
    rmSync(isolatedLogs, { recursive: true, force: true });
  }
}

test("cli commands: completion, config, suggest, goal, task, and studio layout execute cleanly", async () => {
  const sandbox = createSandbox();
  try {
    // 1. Completion
    const bashIo = capture();
    assert.equal(await runCli(["completion", "bash"], {}, bashIo, sandbox.dir), 0);
    assert.match(bashIo.read().stdout, /_kxm_completions/);

    const zshIo = capture();
    assert.equal(await runCli(["completion", "zsh"], {}, zshIo, sandbox.dir), 0);
    assert.match(zshIo.read().stdout, /#compdef kxm/);

    const fishIo = capture();
    assert.equal(await runCli(["completion", "fish"], {}, fishIo, sandbox.dir), 0);
    assert.match(fishIo.read().stdout, /complete -c kxm/);

    const invalidIo = capture();
    assert.equal(await runCli(["completion", "invalid"], {}, invalidIo, sandbox.dir), 1);
    assert.match(invalidIo.read().stderr, /unsupported shell/);

    // 2. Config
    const configListIo = capture();
    assert.equal(await runCli(["config", "list"], {}, configListIo, sandbox.dir), 0);
    assert.match(configListIo.read().stdout, /dash:/);

    const configSetIo = capture();
    assert.equal(await runCli(["config", "set", "user.theme", "light", "--scope", "project"], {}, configSetIo, sandbox.dir), 0);
    assert.match(configSetIo.read().stdout, /Set user\.theme = light/);

    const configGetIo = capture();
    assert.equal(await runCli(["config", "get", "user.theme"], {}, configGetIo, sandbox.dir), 0);
    assert.match(configGetIo.read().stdout, /light/);

    // 3. Suggest
    const suggestIo = capture();
    assert.equal(await runCli(["suggest", "Fix", "critical", "flaky", "test", "timeout"], {}, suggestIo, sandbox.dir), 0);
    assert.match(suggestIo.read().stdout, /Suggested Workflow/);

    const emptySuggestIo = capture();
    assert.equal(await runCli(["suggest"], {}, emptySuggestIo, sandbox.dir), 2);

    // 4. Goal
    const goalCreateIo = capture();
    assert.equal(
      await runCli(["goal", "create", "Release 0.6.0 MVP", "--area", "software-engineering", "--metric", "All tests green", "--target-date", "2026-09-08"], {}, goalCreateIo, sandbox.dir),
      0,
    );
    assert.match(goalCreateIo.read().stdout, /Created goal/);

    const goalListIo = capture();
    assert.equal(await runCli(["goal", "list"], {}, goalListIo, sandbox.dir), 0);
    assert.match(goalListIo.read().stdout, /Release 0\.6\.0 MVP/);

    // 5. Task
    const taskCreateIo = capture();
    assert.equal(
      await runCli(
        ["task", "create", "Cut 0.6.0 Release", "--objective", "Bump version and verify", "--workflow", "software-engineering/feature-implementation", "--tracker", "github", "--issue", "127"],
        {},
        taskCreateIo,
        sandbox.dir,
      ),
      0,
    );
    assert.match(taskCreateIo.read().stdout, /Created task task_/);
    const taskIdMatch = taskCreateIo.read().stdout.match(/Created task (task_[a-f0-9]+)/);
    assert.ok(taskIdMatch);
    const taskId = taskIdMatch[1]!;

    const taskListIo = capture();
    assert.equal(await runCli(["task", "list"], {}, taskListIo, sandbox.dir), 0);
    assert.match(taskListIo.read().stdout, /Cut 0\.6\.0 Release/);

    const taskGetIo = capture();
    assert.equal(await runCli(["task", "get", taskId], {}, taskGetIo, sandbox.dir), 0);
    assert.match(taskGetIo.read().stdout, /Title: Cut 0\.6\.0 Release/);

    const taskSyncIo = capture();
    assert.equal(await runCli(["task", "sync", taskId], {}, taskSyncIo, sandbox.dir), 0);
    assert.match(taskSyncIo.read().stdout, /Synced task/);

    const taskGetMissingIo = capture();
    assert.equal(await runCli(["task", "get", "task_nonexistent"], {}, taskGetMissingIo, sandbox.dir), 1);

    const taskRunMissingIo = capture();
    assert.equal(await runCli(["task", "run", "task_nonexistent"], {}, taskRunMissingIo, sandbox.dir), 1);

    // JSON mode coverage
    const configJsonIo = capture();
    assert.equal(await runCli(["--json", "config", "list"], {}, configJsonIo, sandbox.dir), 0);
    assert.match(configJsonIo.read().stdout, /"ok":\s*true/);

    const configGetJsonIo = capture();
    assert.equal(await runCli(["--json", "config", "get", "user.theme"], {}, configGetJsonIo, sandbox.dir), 0);
    assert.match(configGetJsonIo.read().stdout, /"value":\s*"light"/);

    const goalJsonIo = capture();
    assert.equal(await runCli(["--json", "goal", "list"], {}, goalJsonIo, sandbox.dir), 0);
    assert.match(goalJsonIo.read().stdout, /"count":/);

    const taskJsonIo = capture();
    assert.equal(await runCli(["--json", "task", "list"], {}, taskJsonIo, sandbox.dir), 0);
    assert.match(taskJsonIo.read().stdout, /"count":/);

    const taskGetJsonIo = capture();
    assert.equal(await runCli(["--json", "task", "get", taskId], {}, taskGetJsonIo, sandbox.dir), 0);
    assert.match(taskGetJsonIo.read().stdout, /"command":\s*"task get"/);

    const taskSyncJsonIo = capture();
    assert.equal(await runCli(["--json", "task", "sync", taskId], {}, taskSyncJsonIo, sandbox.dir), 0);
    assert.match(taskSyncJsonIo.read().stdout, /"command":\s*"task sync"/);

    const suggestJsonIo = capture();
    assert.equal(await runCli(["--json", "suggest", "Migrate", "database", "sqlite"], {}, suggestJsonIo, sandbox.dir), 0);
    assert.match(suggestJsonIo.read().stdout, /"workflowId":/);

    // Filter task list
    const filteredListIo = capture();
    assert.equal(await runCli(["task", "list", "--status", "todo"], {}, filteredListIo, sandbox.dir), 0);

    // 6. Studio layout
    const studioIo = capture();
    assert.equal(
      await runCli(["studio", "layout", "examples/vnext/.kxm/workflows/default.yaml"], {}, studioIo, sandbox.dir),
      0,
    );
    assert.match(studioIo.read().stdout, /workflowId/);
    assert.match(studioIo.read().stdout, /stepper/);
  } finally {
    sandbox.cleanup();
  }
});

test("task-manager error branches: nonexistent tasks and missing tracker sync fail safely", () => {
  const sandbox = createSandbox();
  try {
    assert.throws(() => updateTaskStatus(sandbox.dir, "task_none", "done"), /not found/);
    assert.throws(() => syncTaskWithTracker(sandbox.dir, "task_none"), /not found/);

    const noSyncTask = createTask(sandbox.dir, {
      title: "No Sync",
      objective: "Obj",
    });
    assert.throws(() => syncTaskWithTracker(sandbox.dir, noSyncTask.id), /does not have an associated issue board tracker/);

    const listWithFilter = listTasks(sandbox.dir, { status: "blocked" });
    assert.equal(listWithFilter.length, 0);
  } finally {
    sandbox.cleanup();
  }
});
