import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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
import {
  completionRcTarget,
  completionScriptPath,
  detectShell,
  installPathEntry,
  installShellCompletion,
  kxmBinDir,
} from "../../plugins/kxm/src/completion-install.ts";
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
import { PROMOTION_REQUIRED_EVALUATIONS } from "../../plugins/kxm/src/skills.ts";
import { DatabaseSync } from "../../plugins/kxm/src/sqlite.ts";
import { kxmRuntimePaths } from "../../plugins/kxm/src/runtime-store.ts";
import { kxmSupervisorStatus } from "../../plugins/kxm/src/runtime-supervisor.ts";

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

test("completion install: detects shell, writes script and rc stanza idempotently", () => {
  const sandbox = createSandbox();
  const home = join(sandbox.dir, "home");
  const config = join(sandbox.dir, "config");
  mkdirSync(home, { recursive: true });
  mkdirSync(config, { recursive: true });
  try {
    // detection from $SHELL
    assert.equal(detectShell({ SHELL: "/usr/bin/zsh" } as NodeJS.ProcessEnv), "zsh");
    assert.equal(detectShell({ SHELL: "/bin/bash" } as NodeJS.ProcessEnv), "bash");
    assert.equal(detectShell({ SHELL: "/usr/local/bin/fish" } as NodeJS.ProcessEnv), "fish");
    assert.equal(detectShell({} as NodeJS.ProcessEnv), "unknown");

    const env = { HOME: home, SHELL: "/bin/bash", KXM_USER_CONFIG_DIR: config } as NodeJS.ProcessEnv;

    // dry-run plans without writing
    const planned = installShellCompletion("auto", { env, homeDir: home, configDir: config, dryRun: true });
    assert.equal(planned.ok, true);
    assert.equal(planned.shell, "bash");
    assert.equal(planned.alreadyInstalled, false);
    assert.equal(existsSync(completionScriptPath("bash", { env, homeDir: home, configDir: config })), false);

    // real install writes the script and appends one rc stanza
    const first = installShellCompletion("auto", { env, homeDir: home, configDir: config });
    assert.equal(first.ok, true);
    assert.equal(first.rcModified, true);
    const scriptPath = completionScriptPath("bash", { env, homeDir: home, configDir: config });
    assert.equal(existsSync(scriptPath), true);
    assert.equal(readFileSync(scriptPath, "utf8"), generateShellCompletion("bash"));
    const rc = readFileSync(join(home, ".bashrc"), "utf8");
    assert.match(rc, /# kxm completion/);
    assert.match(rc, new RegExp(scriptPath.replaceAll("/", "\\/")));

    // second install is idempotent: no duplicate stanza, script unchanged
    const second = installShellCompletion("auto", { env, homeDir: home, configDir: config });
    assert.equal(second.ok, true);
    assert.equal(second.alreadyInstalled, true);
    assert.equal(second.rcModified, false);
    const rcAfter = readFileSync(join(home, ".bashrc"), "utf8");
    assert.equal(rcAfter.match(/# kxm completion/g)?.length, 1);

    // zsh uses .zshrc; fish writes only to the auto-loaded completions dir
    const zshHome = join(sandbox.dir, "zsh-home");
    mkdirSync(zshHome, { recursive: true });
    const zsh = installShellCompletion("zsh", { env: { ...env, HOME: zshHome, SHELL: "/bin/zsh" }, homeDir: zshHome, configDir: config });
    assert.equal(zsh.ok, true);
    assert.ok(zsh.rcFile?.endsWith(".zshrc"));

    const fishHome = join(sandbox.dir, "fish-home");
    mkdirSync(fishHome, { recursive: true });
    const fish = installShellCompletion("fish", { env: { ...env, HOME: fishHome, SHELL: "/usr/bin/fish" }, homeDir: fishHome, configDir: config });
    assert.equal(fish.ok, true);
    assert.equal(fish.rcFile, undefined);
    assert.equal(existsSync(join(fishHome, ".config", "fish", "completions", "kxm.fish")), true);

    // unknown shell fails closed with a reason
    const unknown = installShellCompletion("auto", { env: { ...env, SHELL: "/bin/tcsh" }, homeDir: home, configDir: config });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.reason, "shell_not_detected");
  } finally {
    sandbox.cleanup();
  }
});

test("completion install: PATH entry is added once and only when missing", () => {
  const sandbox = createSandbox();
  const home = join(sandbox.dir, "home");
  const binDir = join(sandbox.dir, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "kxm"), "#!/bin/sh\n", { mode: 0o755 });
  try {
    const env = { HOME: home, SHELL: "/bin/bash", PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv;

    // bin dir discovery via explicit entry point
    const found = kxmBinDir({ ...env, KXM_ENTRY: join(binDir, "kxm") });
    assert.equal(found, binDir);

    // already on PATH: nothing written
    const onPathEnv = { ...env, PATH: `${binDir}:/usr/bin:/bin`, KXM_ENTRY: join(binDir, "kxm") } as NodeJS.ProcessEnv;
    const noop = installPathEntry("bash", { env: onPathEnv, homeDir: home, binDir });
    assert.equal(noop.ok, true);
    assert.equal(noop.alreadyInstalled, true);
    assert.equal(noop.rcModified, false);

    // missing: appended once, idempotent on rerun
    const first = installPathEntry("bash", { env, homeDir: home, binDir });
    assert.equal(first.ok, true);
    assert.equal(first.rcModified, true);
    const rc = readFileSync(join(home, ".bashrc"), "utf8");
    assert.match(rc, /# kxm path/);
    assert.equal(rc.match(/# kxm path/g)?.length, 1);

    const second = installPathEntry("bash", { env, homeDir: home, binDir });
    assert.equal(second.alreadyInstalled, true);
    assert.equal(second.rcModified, false);
    assert.equal(readFileSync(join(home, ".bashrc"), "utf8").match(/# kxm path/g)?.length, 1);

    // dry-run never writes
    const otherHome = join(sandbox.dir, "home2");
    mkdirSync(otherHome, { recursive: true });
    const planned = installPathEntry("bash", { env, homeDir: otherHome, binDir, dryRun: true });
    assert.equal(planned.ok, true);
    assert.equal(existsSync(join(otherHome, ".bashrc")), false);
  } finally {
    sandbox.cleanup();
  }
});

test("cli completion install: executes cleanly with json and dry-run", async () => {
  const sandbox = createSandbox();
  const home = join(sandbox.dir, "home");
  const config = join(sandbox.dir, "config");
  const binDir = join(sandbox.dir, "bin");
  for (const dir of [home, config, binDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(binDir, "kxm"), "#!/bin/sh\n", { mode: 0o755 });
  try {
    const env = {
      HOME: home,
      SHELL: "/bin/bash",
      KXM_USER_CONFIG_DIR: config,
      KXM_ENTRY: join(binDir, "kxm"),
      PATH: "/usr/bin:/bin",
    } as NodeJS.ProcessEnv;

    // dry-run: plans, writes nothing
    const planIo = capture();
    assert.equal(await runCli(["completion", "install", "--dry-run"], env, planIo, sandbox.dir), 0);
    assert.match(planIo.read().stdout, /planned/);
    assert.equal(existsSync(join(home, ".bashrc")), false);

    // real run: installs script, rc stanza, and PATH entry
    const io = capture();
    assert.equal(await runCli(["completion", "install"], env, io, sandbox.dir), 0);
    assert.match(io.read().stdout, /completion: installed/);
    assert.match(io.read().stdout, new RegExp(`PATH entry for ${binDir.replaceAll("/", "\\/")} added`));
    assert.equal(existsSync(join(config, "completions", "kxm.bash")), true);

    // rerun is idempotent
    const againIo = capture();
    assert.equal(await runCli(["completion", "install"], env, againIo, sandbox.dir), 0);
    assert.match(againIo.read().stdout, /already installed/);

    // json mode carries the structured report
    const jsonIo = capture();
    assert.equal(await runCli(["completion", "install", "--json"], env, jsonIo, sandbox.dir), 0);
    const parsed = JSON.parse(jsonIo.read().stdout) as { ok: boolean; shell: string; path?: { binDir?: string } };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.shell, "bash");
    assert.equal(parsed.path?.binDir, binDir);

    // explicit --shell zsh works and legacy generation still works
    const zshIo = capture();
    assert.equal(await runCli(["completion", "zsh"], env, zshIo, sandbox.dir), 0);
    assert.match(zshIo.read().stdout, /#compdef kxm/);

    // --no-path skips PATH handling
    const noPathIo = capture();
    const noPathEnv = { ...env, HOME: join(sandbox.dir, "home3") } as NodeJS.ProcessEnv;
    mkdirSync(noPathEnv.HOME!, { recursive: true });
    assert.equal(await runCli(["completion", "install", "--no-path"], noPathEnv, noPathIo, sandbox.dir), 0);
    assert.doesNotMatch(noPathIo.read().stdout, /PATH entry/);
  } finally {
    sandbox.cleanup();
  }
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
      await runCli(["studio", "layout", "examples/project/.kxm/workflows/default.yaml"], {}, studioIo, sandbox.dir),
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

/** Every file and directory under `root`, keyed by relative path; files carry
 * their content digest so a rewrite with identical bytes still compares equal. */
function treeSnapshot(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      const key = relative(root, path);
      if (stat.isDirectory()) {
        entries[key] = "dir";
        walk(path);
      } else {
        entries[key] = stat.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : "other";
      }
    }
  };
  walk(root);
  return entries;
}

test("every mutating command under --dry-run leaves the workspace, state root, and hub untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-dry-run-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    HOME: join(root, "home"),
    KXM_STATE_HOME: state,
    KXM_USER_CONFIG_DIR: join(root, "user-config"),
    KXM_USER_TELEMETRY_DIR: join(root, "telemetry"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_STATE_HOME: join(root, "xdg-state"),
    KXM_SERVER_URL: "http://hub.kxm-dry-run.invalid",
    KXM_SKIP_COMPLETION_PROMPT: "1",
    KXM_SKIP_GUIDE_SETUP_PROMPT: "1",
    PATH: process.env.PATH,
  };
  const requests: string[] = [];
  const stubHub: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/v1/context/wiki/compile") {
      return Response.json({ audit: { pages: ["index.md"], contradictions: 0 }, pages: [{ path: ".kxm/knowledge/wiki/index.md", content: "# wiki\n" }] });
    }
    return Response.json({ ok: true });
  };
  const kxm = async (argv: string[]): Promise<{ code: number; out: string; err: string }> => {
    let out = "";
    let err = "";
    const code = await runCliImplementation(argv, env, { stdout: (text) => { out += text; }, stderr: (text) => { err += text; }, fetchImpl: stubHub }, project);
    return { code, out, err };
  };
  const seed = async (argv: string[]): Promise<Record<string, unknown>> => {
    const result = await kxm([...argv, "--json"]);
    assert.equal(result.code, 0, `seed ${argv.join(" ")}: ${result.err}`);
    return JSON.parse(result.out) as Record<string, unknown>;
  };
  try {
    // Real state for every command to plan against: a committed project with an
    // instruction file for `memory sync` to update (sync never creates one), a role,
    // a workflow, a tracked task, a skill candidate with passing evaluations, a
    // hub store, and a verified backup of it.
    assert.equal(spawnSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", project]).status, 0);
    await seed(["init", "--project-id", "prj_01JDRYRUN0000000000000000", "--name", "Dry Run"]);
    writeFileSync(join(project, "AGENTS.md"), "# Dry Run\n");
    assert.equal(spawnSync("git", ["-C", project, "add", "-A"]).status, 0);
    assert.equal(spawnSync("git", ["-C", project, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "init"]).status, 0);
    await seed(["role", "add", "seed-role", "--description", "seed"]);
    await seed(["workflow", "add", "seed-flow", "--description", "seed", "--scope", "global"]);
    const taskId = ((await seed(["task", "create", "Seed task", "--tracker", "github", "--issue", "1"])).task as { id: string }).id;
    writeFileSync(join(root, "SKILL.md"), "---\nname: seed-skill\ndescription: seed skill\n---\nDo the thing.\n");
    const skillId = ((await seed([
      "skills", "create", "--file", join(root, "SKILL.md"), "--name", "seed-skill", "--created-by", "author",
      "--receipt", "receipt:seed", "--harness", "pi", "--models", "pi/model",
    ])).metadata as { id: string }).id;
    for (const kind of PROMOTION_REQUIRED_EVALUATIONS) await seed(["skills", "evaluate", skillId, "--kind", kind, "--evaluator", "v1"]);
    // A WAL store, like every real hub store: a careless read-only open of one
    // leaves -wal/-shm sidecars behind, which the snapshot below would catch.
    mkdirSync(join(project, ".kxm", "state"), { recursive: true });
    const hubStore = new DatabaseSync(join(project, ".kxm", "state", "kxm.db"));
    hubStore.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE workflow_journal (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, category TEXT NOT NULL, area TEXT NOT NULL, record TEXT NOT NULL);`);
    const stage = { id: "review", label: "Review", instructions: "Review", requiredEvidence: [], maxAttempts: 2, autoResumeLimit: 1, status: "waiting", attempts: 1, evidence: {} };
    hubStore.prepare("INSERT INTO workflow_runs (id, record) VALUES (?, ?)").run("wf_dry_run", JSON.stringify({
      id: "wf_dry_run", definitionId: "audit-flow", source: "generic", deliveryId: "d1", payloadHash: "h1", project: "dry-run",
      targetAgentId: "agent_1", targetAgentName: "agent", messageId: "msg_1", status: "waiting", currentStage: "review", stages: [stage],
      waiting: { stageId: "review", signalKey: "audit_escalation", summary: "escalated", createdAt: "2026-09-23T00:00:00.000Z", expiresAt: "2026-09-24T00:00:00.000Z" },
      createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z",
    }));
    hubStore.close();
    await seed(["backup", "--out", join(root, "backup")]);

    const before = treeSnapshot(root);
    requests.length = 0;
    const planned: Array<[string[], string]> = [
      [["backup"], "write"],
      [["restore", join(root, "backup", "manifest.json")], "write"],
      [["config", "set", "user.theme", "light"], "write"],
      [["role", "add", "new-role"], "write"],
      [["role", "remove", "seed-role"], "delete"],
      [["role", "modify", "seed-role", "--add-skill", "extra"], "write"],
      [["role", "set-host", "writer", "grok"], "write"],
      [["role", "resume", `run_${"0".repeat(32)}`, "carry on"], "request"],
      [["role", "resume", "wf_dry_run", "carry on"], "write"],
      [["workflow", "add", "new-flow"], "write"],
      [["workflow", "remove", "seed-flow", "--scope", "global"], "delete"],
      [["workflow", "modify", "seed-flow", "--description", "changed", "--scope", "global"], "write"],
      [["goal", "create", "Ship it"], "write"],
      [["task", "create", "Another task"], "write"],
      [["task", "run", taskId], "request"],
      [["task", "sync", taskId], "write"],
      [["memory", "note", "a learned fact"], "write"],
      [["memory", "sync"], "write"],
      [["skills", "evaluate", skillId, "--kind", "functional", "--evaluator", "v2", "--fail"], "write"],
      [["skills", "promote", skillId, "--decided-by", "promoter", "--evidence", "receipt:seed"], "write"],
      [["skills", "reject", skillId, "--decided-by", "reviewer"], "move"],
      [["context", "promote", "dry-run", "prop_1", "--evidence", "receipt:seed"], "request"],
      [["context", "wiki-compile", "dry-run", "--out", join(project, "wiki")], "write"],
      [["session", "brief"], "write"],
      [["session", "brief", "--token"], "write"],
      [["auth", "token"], "write"],
      [["auth", "token", "--issue"], "write"],
      [["ssh", "run", "host.kxm-dry-run.invalid", "touch", "/tmp/x"], "ssh"],
      [["ssh", "file", "host.kxm-dry-run.invalid", "/tmp/x", "--content", "x"], "ssh"],
      [["ssh", "close", "host.kxm-dry-run.invalid"], "ssh"],
    ];
    for (const [argv, action] of planned) {
      const result = await kxm([...argv, "--dry-run", "--json"]);
      assert.equal(result.code, 0, `${argv.join(" ")}: ${result.err}`);
      const payload = JSON.parse(result.out) as { ok: boolean; dryRun: boolean; planned: Array<{ action: string }> };
      assert.equal(payload.dryRun, true, argv.join(" "));
      assert.ok(payload.planned.some((change) => change.action === action), `${argv.join(" ")} plans a ${action}`);
    }
    // Two answers without a plan: a read that would have to start the Runtime, and a
    // command that never learned --dry-run. Both refuse instead of acting.
    for (const argv of [["runs", "status", `run_${"0".repeat(32)}`], ["models"]]) {
      const result = await kxm([...argv, "--dry-run", "--json"]);
      assert.equal(result.code, 2, argv.join(" "));
      assert.equal((JSON.parse(result.err) as { error: string }).error, "dry_run_unsupported");
    }

    const after = treeSnapshot(root);
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((path) => before[path] !== after[path]);
    assert.deepEqual(changed, [], "paths a dry run created, changed, or removed");
    const hubReads = new Set(["GET /health", "POST /v1/context/wiki/compile"]);
    assert.deepEqual(requests.filter((request) => !hubReads.has(request)), []);
    assert.equal(kxmSupervisorStatus(kxmRuntimePaths({ env })).running, false);
  } finally {
    const supervisor = kxmSupervisorStatus(kxmRuntimePaths({ env }));
    if (supervisor.running && supervisor.pid) process.kill(supervisor.pid);
    rmSync(root, { recursive: true, force: true });
  }
});
