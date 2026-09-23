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
  updateTaskStatus,
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

export async function cmdSuggest(runtime: Runtime, promptParts: string[]): Promise<number> {
  try {
    const prompt = promptParts.join(" ").trim();
    if (!prompt) {
      runtime.io.stderr("prompt must be non-empty\n");
      return 2;
    }
    const inventory = await probeHarnessesAsync({ env: runtime.env });
    const availableHarnesses = inventory.harnesses.map((h) => ({
      harness: h.id,
      auth: h.authenticated === true ? "authenticated" : "unauthenticated",
    }));
    const suggestion = suggestWorkflowAndRoles(prompt, { availableHarnesses });

    const text = [
      `Suggested Workflow: ${suggestion.workflowId} (${suggestion.area})`,
      `Confidence: ${(suggestion.confidence * 100).toFixed(0)}%`,
      `Reasons: ${suggestion.reasons.join("; ")}`,
      `Suggested Skills: ${suggestion.suggestedSkills.join(", ") || "none"}`,
      `Roles:`,
      `  Planner:     ${suggestion.roles.planner.harness} (${suggestion.roles.planner.model})`,
      `  Writer:      ${suggestion.roles.writer.harness} (${suggestion.roles.writer.model})`,
      `  Critics:     ${suggestion.roles.critics.map((c) => `${c.harness}:${c.model}`).join(", ")}`,
      `  Verifier:    ${suggestion.roles.verifier.command}`,
      ``,
      `Execute with:`,
      `  ${suggestion.suggestedCommand}`,
    ].join("\n");

    print(runtime.io, runtime.json, { ok: true, command: "suggest", prompt, ...suggestion }, text);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`suggest failed: ${message}\n`);
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
    const workflow = task.assignedWorkflow ?? "default";
    if (runtime.dryRun) {
      const target = resolveKxmRunTarget(runtime, workflow);
      if (typeof target === "number") return target;
      const started = updateTaskStatus(runtime.cwd, taskId, "in_progress", { dryRun: true });
      printPlan(
        runtime,
        { command: "task run", taskId, ...target, status: started.status },
        [
          { action: "request", target: "POST kxm-runtime /v1/runs (starts the Runtime supervisor if it is not running)" },
          { action: "write", target: taskFilePath(runtime.cwd, taskId) },
        ],
        `run workflow ${workflow} for task ${taskId}, then mark it ${started.status}`,
      );
      return 0;
    }
    const exitCode = await cmdKxmRun(runtime, workflow, [task.objective]);
    if (exitCode === 0) {
      updateTaskStatus(runtime.cwd, taskId, "in_progress");
    }
    return exitCode;
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
