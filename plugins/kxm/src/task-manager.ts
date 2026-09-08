import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";

export const GOAL_SCHEMA = "kxm.goal.v1" as const;
export const TASK_SCHEMA = "kxm.task.v1" as const;

export type GoalStatus = "active" | "achieved" | "abandoned";
export type TaskStatus = "todo" | "in_progress" | "blocked" | "in_review" | "done";
export type TrackerType = "github" | "jira" | "gitlab" | "none";

export interface GoalRecord {
  schema: typeof GOAL_SCHEMA;
  id: string;
  title: string;
  area: string;
  status: GoalStatus;
  successMetrics: string[];
  targetDate?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskAcceptanceCriterion {
  id?: string;
  description: string;
  required: boolean;
}

export interface TaskTrackerSync {
  tracker: TrackerType;
  issueKey: string;
  syncStatus: "synced" | "pending" | "failed";
  lastSyncedAt?: string;
}

export interface TaskRecord {
  schema: typeof TASK_SCHEMA;
  id: string;
  goalId?: string;
  title: string;
  objective: string;
  acceptanceCriteria: TaskAcceptanceCriterion[];
  status: TaskStatus;
  assignedWorkflow?: string;
  workflowRunId?: string;
  trackerSync?: TaskTrackerSync;
  createdAt: string;
  updatedAt: string;
}

function goalsDirectory(repoRoot: string): string {
  return resolve(repoRoot, ".kxm", "goals");
}

function tasksDirectory(repoRoot: string): string {
  return resolve(repoRoot, ".kxm", "tasks");
}

export function createGoal(
  repoRoot: string,
  input: {
    title: string;
    area?: string | undefined;
    successMetrics?: string[] | undefined;
    targetDate?: string | undefined;
  },
): GoalRecord {
  const dir = goalsDirectory(repoRoot);
  mkdirSync(dir, { recursive: true });

  const id = `goal_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const now = new Date().toISOString();
  const record: GoalRecord = {
    schema: GOAL_SCHEMA,
    id,
    title: input.title,
    area: input.area ?? "software-engineering",
    status: "active",
    successMetrics: input.successMetrics ?? [],
    ...(input.targetDate ? { targetDate: input.targetDate } : {}),
    createdAt: now,
    updatedAt: now,
  };

  const filePath = join(dir, `${id}.yaml`);
  writeFileSync(filePath, stringify(record).trim() + "\n", "utf8");
  return record;
}

export function listGoals(repoRoot: string): GoalRecord[] {
  const dir = goalsDirectory(repoRoot);
  if (!existsSync(dir)) return [];

  const goals: GoalRecord[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))) {
      try {
        const text = readFileSync(join(dir, entry.name), "utf8");
        const doc = parse(text) as GoalRecord;
        if (doc && doc.schema === GOAL_SCHEMA) goals.push(doc);
      } catch {
        // skip invalid
      }
    }
  }

  return goals.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function createTask(
  repoRoot: string,
  input: {
    goalId?: string | undefined;
    title: string;
    objective: string;
    acceptanceCriteria?: TaskAcceptanceCriterion[] | undefined;
    assignedWorkflow?: string | undefined;
    trackerSync?: {
      tracker: TrackerType;
      issueKey: string;
    } | undefined;
  },
): TaskRecord {
  const dir = tasksDirectory(repoRoot);
  mkdirSync(dir, { recursive: true });

  const id = `task_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const now = new Date().toISOString();
  const record: TaskRecord = {
    schema: TASK_SCHEMA,
    id,
    ...(input.goalId ? { goalId: input.goalId } : {}),
    title: input.title,
    objective: input.objective,
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    status: "todo",
    ...(input.assignedWorkflow ? { assignedWorkflow: input.assignedWorkflow } : {}),
    ...(input.trackerSync
      ? {
        trackerSync: {
          tracker: input.trackerSync.tracker,
          issueKey: input.trackerSync.issueKey,
          syncStatus: "pending",
        },
      }
      : {}),
    createdAt: now,
    updatedAt: now,
  };

  const filePath = join(dir, `${id}.yaml`);
  writeFileSync(filePath, stringify(record).trim() + "\n", "utf8");
  return record;
}

export function listTasks(
  repoRoot: string,
  options: { goalId?: string | undefined; status?: TaskStatus | undefined } = {},
): TaskRecord[] {
  const dir = tasksDirectory(repoRoot);
  if (!existsSync(dir)) return [];

  const tasks: TaskRecord[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))) {
      try {
        const text = readFileSync(join(dir, entry.name), "utf8");
        const doc = parse(text) as TaskRecord;
        if (doc && doc.schema === TASK_SCHEMA) {
          if (options.goalId && doc.goalId !== options.goalId) continue;
          if (options.status && doc.status !== options.status) continue;
          tasks.push(doc);
        }
      } catch {
        // skip invalid
      }
    }
  }

  return tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getTask(repoRoot: string, taskId: string): TaskRecord | undefined {
  const dir = tasksDirectory(repoRoot);
  const filePath = join(dir, `${taskId}.yaml`);
  if (!existsSync(filePath)) return undefined;
  try {
    const text = readFileSync(filePath, "utf8");
    const doc = parse(text) as TaskRecord;
    return doc && doc.schema === TASK_SCHEMA ? doc : undefined;
  } catch {
    return undefined;
  }
}

export function updateTaskStatus(
  repoRoot: string,
  taskId: string,
  status: TaskStatus,
  options: { workflowRunId?: string } = {},
): TaskRecord {
  const task = getTask(repoRoot, taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  task.status = status;
  if (options.workflowRunId) task.workflowRunId = options.workflowRunId;
  task.updatedAt = new Date().toISOString();

  const filePath = join(tasksDirectory(repoRoot), `${taskId}.yaml`);
  writeFileSync(filePath, stringify(task).trim() + "\n", "utf8");
  return task;
}

export function syncTaskWithTracker(
  repoRoot: string,
  taskId: string,
  options: {
    mockRemoteState?: string;
    commentReceipt?: string;
  } = {},
): TaskRecord {
  const task = getTask(repoRoot, taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }
  if (!task.trackerSync) {
    throw new Error(`Task ${taskId} does not have an associated issue board tracker`);
  }

  const now = new Date().toISOString();
  task.trackerSync.syncStatus = "synced";
  task.trackerSync.lastSyncedAt = now;
  task.updatedAt = now;

  const filePath = join(tasksDirectory(repoRoot), `${taskId}.yaml`);
  writeFileSync(filePath, stringify(task).trim() + "\n", "utf8");
  return task;
}
