import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { probeHarnessesAsync } from "../harness.ts";
import { suggestWorkflowAndRoles } from "../suggest.ts";
import {
  createGoal,
  createTask,
  listGoals,
  listTasks,
  getTask,
  syncTaskWithTracker,
  goalFilePath,
  taskFilePath,
  type TaskStatus,
  type TrackerType,
} from "../task-manager.ts";
import { discoverKxmProjectRoot } from "../project-config.ts";
import { compileKxmWorkflow } from "../engine-compile.ts";
import {
  createStudioServer,
  DEFAULT_STUDIO_PORT,
  generateStudioLayout,
} from "../studio-layout.ts";
import { readSessionTokenFromDisk } from "../commands.ts";
import { print, printPlan, type Runtime } from "./types.ts";
import { cmdKxmRun, resolveKxmRunTarget } from "./project.ts";

export async function cmdSuggest(
  runtime: Runtime,
  promptParts: string[],
  probeHarnesses = probeHarnessesAsync,
): Promise<number> {
  try {
    const prompt = promptParts.join(" ").trim();
    if (!prompt) {
      print(runtime.io, runtime.json, { ok: false, command: "suggest", error: "prompt_required" }, "prompt must be non-empty");
      return 2;
    }
    // Native authentication probes may initialize state. A dry run must not invoke them.
    const inventory = runtime.dryRun ? undefined : await probeHarnesses({ env: runtime.env });
    const suggestion = suggestWorkflowAndRoles(prompt, { availableHarnesses: inventory?.harnesses });
    const execution = suggestion.execution;
    const text = [
      `Suggested Workflow: ${suggestion.workflowId} (${suggestion.area})`,
      `Template: ${suggestion.template}`,
      `Confidence: ${(suggestion.confidence * 100).toFixed(0)}%`,
      `Reasons: ${suggestion.reasons.join("; ")}`,
      `Suggested Skills: ${suggestion.suggestedSkills.join(", ") || "none"}`,
      "",
      "Install definition only (requires kxm init; does not execute):",
      `  ${suggestion.suggestedCommand}`,
      "",
      ...(execution.supported ? [
        "Suggested agent routing (not applied):",
        ...suggestion.roles.map((role) => `  ${role.agent}: ${role.harness} (${role.role}; use a configured compatible model)`),
        "Prerequisites:",
        ...execution.prerequisites.map((step) => `  ${step}`),
        `Create a run only (${execution.shell}; does not execute steps):`,
        `  ${execution.createCommand}`,
        "Then drive the returned run ID with live calls and inspect its result:",
        `  ${execution.driveCommand}`,
        `  ${execution.statusCommand}`,
        `  ${execution.receiptCommand}`,
      ] : [
        `Execution unavailable: ${execution.reason}`,
        ...execution.nextSteps.map((step) => `  ${step}`),
        ...(runtime.dryRun ? ["Harness authentication was not probed during --dry-run."] : []),
      ]),
    ].join("\n");

    print(runtime.io, runtime.json, {
      ok: execution.supported,
      command: "suggest",
      prompt,
      ...suggestion,
      ...(runtime.dryRun ? { dryRun: true } : {}),
      ...(!execution.supported ? { error: execution.error } : {}),
    }, text);
    return execution.supported ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    print(runtime.io, runtime.json, { ok: false, command: "suggest", error: "suggest_failed", detail: message }, `suggest failed: ${message}`);
    return 1;
  }
}

export async function cmdGoalCreate(
  runtime: Runtime,
  title: string,
  options: { area?: string | undefined; metric?: string[] | undefined; targetDate?: string | undefined },
): Promise<number> {
  try {
    const goal = createGoal(runtime.cwd, {
      title,
      area: options.area,
      successMetrics: options.metric,
      targetDate: options.targetDate,
    }, { dryRun: runtime.dryRun });
    if (runtime.dryRun) {
      printPlan(runtime, { command: "goal create", goal }, [{ action: "write", target: goalFilePath(runtime.cwd, goal.id) }], `create goal ${goal.title} (the id is assigned when it is created)`);
      return 0;
    }
    print(
      runtime.io,
      runtime.json,
      { ok: true, command: "goal create", goal },
      `Created goal ${goal.id}: ${goal.title}`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`goal create failed: ${message}\n`);
    return 1;
  }
}

export async function cmdGoalList(runtime: Runtime): Promise<number> {
  try {
    const goals = listGoals(runtime.cwd);
    const text = goals.length === 0
      ? "No goals recorded in .kxm/goals/"
      : goals.map((g) => `[${g.status}] ${g.id}: ${g.title} (${g.area})`).join("\n");
    print(runtime.io, runtime.json, { ok: true, command: "goal list", count: goals.length, goals }, text);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`goal list failed: ${message}\n`);
    return 1;
  }
}

export async function cmdTaskCreate(
  runtime: Runtime,
  title: string,
  options: { goal?: string | undefined; objective?: string | undefined; workflow?: string | undefined; tracker?: string | undefined; issue?: string | undefined },
): Promise<number> {
  try {
    const task = createTask(runtime.cwd, {
      title,
      goalId: options.goal,
      objective: options.objective ?? title,
      assignedWorkflow: options.workflow,
      trackerSync: options.tracker && options.issue
        ? { tracker: options.tracker as TrackerType, issueKey: options.issue }
        : undefined,
    }, { dryRun: runtime.dryRun });
    if (runtime.dryRun) {
      printPlan(runtime, { command: "task create", task }, [{ action: "write", target: taskFilePath(runtime.cwd, task.id) }], `create task ${task.title} [${task.status}] (the id is assigned when it is created)`);
      return 0;
    }
    print(
      runtime.io,
      runtime.json,
      { ok: true, command: "task create", task },
      `Created task ${task.id}: ${task.title} [${task.status}]`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`task create failed: ${message}\n`);
    return 1;
  }
}

export async function cmdTaskList(
  runtime: Runtime,
  options: { goal?: string | undefined; status?: string | undefined },
): Promise<number> {
  try {
    const tasks = listTasks(runtime.cwd, {
      goalId: options.goal,
      status: options.status as TaskStatus | undefined,
    });
    const text = tasks.length === 0
      ? "No tasks recorded in .kxm/tasks/"
      : tasks.map((t) => `[${t.status}] ${t.id}: ${t.title}${t.assignedWorkflow ? ` -> ${t.assignedWorkflow}` : ""}`).join("\n");
    print(runtime.io, runtime.json, { ok: true, command: "task list", count: tasks.length, tasks }, text);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`task list failed: ${message}\n`);
    return 1;
  }
}

export async function cmdTaskGet(runtime: Runtime, taskId: string): Promise<number> {
  try {
    const task = getTask(runtime.cwd, taskId);
    if (!task) {
      runtime.io.stderr(`Task ${taskId} not found\n`);
      return 1;
    }
    const text = [
      `Task: ${task.id}`,
      `Title: ${task.title}`,
      `Status: ${task.status}`,
      `Objective: ${task.objective}`,
      task.assignedWorkflow ? `Workflow: ${task.assignedWorkflow}` : "",
      task.workflowRunId ? `Active Run: ${task.workflowRunId}` : "",
      task.trackerSync ? `Tracker: ${task.trackerSync.tracker} (#${task.trackerSync.issueKey}) [${task.trackerSync.syncStatus}]` : "",
    ].filter(Boolean).join("\n");
    print(runtime.io, runtime.json, { ok: true, command: "task get", task }, text);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`task get failed: ${message}\n`);
    return 1;
  }
}

export async function cmdTaskRun(runtime: Runtime, taskId: string): Promise<number> {
  try {
    const task = getTask(runtime.cwd, taskId);
    if (!task) {
      runtime.io.stderr(`Task ${taskId} not found\n`);
      return 1;
    }
    const workflow = task.assignedWorkflow;
    if (runtime.dryRun) {
      const target = resolveKxmRunTarget(runtime, workflow, true);
      if (typeof target === "number") return target;
      printPlan(
        runtime,
        { command: "task run", taskId, ...target, status: task.status, execution: { status: "not_started", mode: "live" } },
        [
          { action: "request", target: "POST kxm-runtime /v1/runs (starts the Runtime supervisor if it is not running)" },
        ],
        `create workflow ${target.workflowId} for task ${taskId}; task status stays ${task.status} until work actually starts`,
      );
      return 0;
    }
    return await cmdKxmRun(runtime, workflow, [task.objective], true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`task run failed: ${message}\n`);
    return 1;
  }
}

export async function cmdTaskSync(runtime: Runtime, taskId: string): Promise<number> {
  try {
    const synced = syncTaskWithTracker(runtime.cwd, taskId, { dryRun: runtime.dryRun });
    if (runtime.dryRun) {
      printPlan(runtime, { command: "task sync", task: synced }, [{ action: "write", target: taskFilePath(runtime.cwd, taskId) }], `mark task ${taskId} synced with ${synced.trackerSync?.tracker} #${synced.trackerSync?.issueKey}`);
      return 0;
    }
    print(
      runtime.io,
      runtime.json,
      { ok: true, command: "task sync", task: synced },
      `Synced task ${taskId} with ${synced.trackerSync?.tracker} #${synced.trackerSync?.issueKey}`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`task sync failed: ${message}\n`);
    return 1;
  }
}

export async function cmdStudioLayout(runtime: Runtime, workflowPath?: string | undefined): Promise<number> {
  try {
    const projectRoot = discoverKxmProjectRoot(runtime.cwd) ?? runtime.cwd;
    let filePath = workflowPath;
    if (!filePath) {
      filePath = resolve(projectRoot, ".kxm", "workflows", "default.yaml");
    }
    let yamlContent: string;
    let workflowId = "default";
    if (existsSync(filePath)) {
      yamlContent = readFileSync(filePath, "utf8");
    } else {
      yamlContent = `schema: kxm.workflow.v1
description: Feature implementation workflow
coordinator: coordinator
limits:
  maxTransitions: 12
steps:
  - id: plan
    kind: agent
    agent: planner
    maxAttempts: 2
    on:
      passed: implement
      failed:
        target: $terminal
        terminalStatus: failed
  - id: implement
    kind: agent
    agent: writer
    maxAttempts: 3
    on:
      passed: verify
      failed:
        target: $terminal
        terminalStatus: failed
  - id: verify
    kind: gate
    gate: verify-gate
    expect: pass
    maxAttempts: 2
    on:
      passed:
        target: $terminal
        terminalStatus: completed
      failed:
        target: implement
        maxTransitions: 2
`;
    }
    const parsedYaml = parseYaml(yamlContent) as any;
    const plan = compileKxmWorkflow({ id: workflowId, value: parsedYaml });
    const layout = generateStudioLayout(plan);
    print(runtime.io, runtime.json, { ok: true, command: "studio layout", layout }, JSON.stringify(layout, null, 2));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`studio layout failed: ${message}\n`);
    return 1;
  }
}

export async function cmdStudioServe(
  runtime: Runtime,
  options: { port?: string | undefined; host?: string | undefined; token?: string | undefined },
): Promise<number> {
  const port = options.port ? parseInt(options.port, 10) : DEFAULT_STUDIO_PORT;
  const host = options.host ?? "127.0.0.1";
  const sessionToken = options.token
    ?? runtime.env.KXM_SESSION_TOKEN
    ?? readSessionTokenFromDisk({ userConfigDir: runtime.env.KXM_USER_CONFIG_DIR })?.token;

  if (runtime.dryRun) {
    print(
      runtime.io,
      runtime.json,
      { ok: true, command: "studio serve", dryRun: true, port, host },
      `would start studio server on http://${host}:${port}`,
    );
    return 0;
  }

  try {
    const serverHandle = createStudioServer({
      port,
      host,
      projectRoot: runtime.cwd,
      sessionToken,
      planProvider: () => {
        try {
          const wfDir = join(runtime.cwd, ".kxm", "workflows");
          const defaultPath = join(wfDir, "default.yaml");
          let targetPath = existsSync(defaultPath) ? defaultPath : undefined;
          if (!targetPath && existsSync(wfDir)) {
            const yml = readdirSync(wfDir).find((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
            if (yml) targetPath = join(wfDir, yml);
          }
          if (targetPath && existsSync(targetPath)) {
            const raw = readFileSync(targetPath, "utf8");
            const parsed = parseYaml(raw) as any;
            const wfId = basename(targetPath).replace(/\.(yaml|yml)$/, "");
            return compileKxmWorkflow({ id: wfId, value: parsed });
          }
        } catch {
          // fallback
        }
        return undefined;
      },
    });
    const actualPort = await serverHandle.listen();
    const info = {
      ok: true,
      command: "studio serve",
      port: actualPort,
      host,
      url: `http://${host}:${actualPort}`,
    };
    print(
      runtime.io,
      runtime.json,
      info,
      `KXM Web Studio listening on http://${host}:${actualPort} (Decision Q8 & D14)\nPress Ctrl+C to stop.\n`,
    );

    if (runtime.env.KXM_STUDIO_ONCE) {
      await serverHandle.close();
      return 0;
    }

    await new Promise<void>((resolveClose) => {
      const shutdown = async () => {
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
        await serverHandle.close();
        resolveClose();
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`studio serve failed: ${message}\n`);
    return 1;
  }
}
