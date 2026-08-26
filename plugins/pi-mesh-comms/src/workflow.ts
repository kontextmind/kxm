import {
  MAX_MESSAGE_TTL_MS,
  MIN_MESSAGE_TTL_MS,
  ProtocolError,
  requireString,
} from "./protocol.ts";

export type WorkflowCheckpointStatus = "passed" | "warning" | "failed";
export type WorkflowRunStatus = "running" | "waiting" | "completed" | "failed";
export type WorkflowStageStatus = "pending" | "in_progress" | "waiting" | WorkflowCheckpointStatus;
export type JournalCategory = "plan" | "decision" | "contradiction" | "error" | "lesson";
export type ImprovementArea = "harness" | "gates" | "implementation" | "workflow" | "documentation" | "security" | "other";

export interface WorkflowStageDefinition {
  id: string;
  label: string;
  instructions: string;
  requiredEvidence: string[];
  maxAttempts: number;
  area?: ImprovementArea;
}

export interface WebhookWorkflowDefinition {
  id: string;
  source: "jira" | "github" | "generic";
  project: string;
  target: string;
  secret: string;
  signalSecret?: string;
  event?: string;
  filter?: { path: string; equals: string };
  delivery: "steer" | "followUp";
  ttlMs?: number;
  promptTemplate: string;
  stages: WorkflowStageDefinition[];
}

export interface WorkflowStageState extends WorkflowStageDefinition {
  status: WorkflowStageStatus;
  attempts: number;
  summary?: string;
  evidence: string[];
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
}

export interface WorkflowWaitState {
  stageId: string;
  signalKey: string;
  summary: string;
  createdAt: string;
  expiresAt: string;
}

export interface WorkflowSignalReceipt {
  deliveryId: string;
  payloadHash: string;
  signalKey: string;
  stageId: string;
  status: WorkflowCheckpointStatus;
  messageId?: string;
  receivedAt: string;
}

export interface WorkflowRun {
  id: string;
  definitionId: string;
  source: WebhookWorkflowDefinition["source"];
  deliveryId: string;
  payloadHash: string;
  event?: string;
  project: string;
  targetAgentId: string;
  targetAgentName: string;
  messageId: string;
  status: WorkflowRunStatus;
  currentStage?: string;
  waiting?: WorkflowWaitState;
  signalReceipts?: WorkflowSignalReceipt[];
  stages: WorkflowStageState[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface WorkflowJournalEntry {
  id: string;
  runId: string;
  agentId: string;
  category: JournalCategory;
  area: ImprovementArea;
  severity: "info" | "warning" | "error";
  summary: string;
  details?: string;
  evidence: string[];
  relatedEntryIds: string[];
  createdAt: string;
}

export interface ImprovementAreaReport {
  area: ImprovementArea;
  total: number;
  errors: number;
  contradictions: number;
  lessons: number;
  priorities: WorkflowJournalEntry[];
}

export function improvementReport(entries: WorkflowJournalEntry[]): ImprovementAreaReport[] {
  const areas: ImprovementArea[] = [
    "harness",
    "gates",
    "implementation",
    "workflow",
    "documentation",
    "security",
    "other",
  ];
  const severityWeight = { error: 3, warning: 2, info: 1 } as const;
  return areas.map((area) => {
    const matching = entries.filter((entry) => entry.area === area);
    const priorities = [...matching]
      .filter((entry) => entry.category === "error" || entry.category === "contradiction" || entry.category === "lesson")
      .sort((left, right) => severityWeight[right.severity] - severityWeight[left.severity])
      .slice(0, 10);
    return {
      area,
      total: matching.length,
      errors: matching.filter((entry) => entry.category === "error").length,
      contradictions: matching.filter((entry) => entry.category === "contradiction").length,
      lessons: matching.filter((entry) => entry.category === "lesson").length,
      priorities,
    };
  }).filter((report) => report.total > 0);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }
  return value.map((item) => (item as string).trim());
}

export function parseWorkflowDefinitions(
  raw: string | undefined,
  environment: Record<string, string | undefined> = process.env,
): WebhookWorkflowDefinition[] {
  if (!raw?.trim()) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("PI_MESH_WEBHOOK_WORKFLOWS must be a JSON array");
  const ids = new Set<string>();
  return parsed.map((entry, definitionIndex) => {
    const value = object(entry, `workflow ${definitionIndex}`);
    const id = requireString(value.id, "workflow.id", { max: 64 });
    if (ids.has(id)) throw new Error(`duplicate workflow id: ${id}`);
    ids.add(id);
    const source = value.source ?? "generic";
    if (source !== "jira" && source !== "github" && source !== "generic") {
      throw new Error(`workflow ${id} source must be jira, github, or generic`);
    }
    const delivery = value.delivery ?? "followUp";
    if (delivery !== "steer" && delivery !== "followUp") {
      throw new Error(`workflow ${id} delivery must be steer or followUp`);
    }
    const secretEnv = value.secretEnv === undefined
      ? undefined
      : requireString(value.secretEnv, "workflow.secretEnv", { max: 128 });
    if (value.secret !== undefined && secretEnv) {
      throw new Error(`workflow ${id} must configure only one of secret or secretEnv`);
    }
    const secret = requireString(secretEnv ? environment[secretEnv] : value.secret, "workflow.secret", { max: 512 });
    if (secret.length < 16) throw new Error(`workflow ${id} secret must contain at least 16 characters`);
    const signalSecretEnv = value.signalSecretEnv === undefined
      ? undefined
      : requireString(value.signalSecretEnv, "workflow.signalSecretEnv", { max: 128 });
    if (value.signalSecret !== undefined && signalSecretEnv) {
      throw new Error(`workflow ${id} must configure only one of signalSecret or signalSecretEnv`);
    }
    const signalSecret = signalSecretEnv
      ? requireString(environment[signalSecretEnv], "workflow.signalSecret", { max: 512 })
      : value.signalSecret === undefined
        ? undefined
        : requireString(value.signalSecret, "workflow.signalSecret", { max: 512 });
    if (signalSecret && signalSecret.length < 16) {
      throw new Error(`workflow ${id} signalSecret must contain at least 16 characters`);
    }
    if (!Array.isArray(value.stages) || value.stages.length === 0 || value.stages.length > 32) {
      throw new Error(`workflow ${id} must define between 1 and 32 stages`);
    }
    const stageIds = new Set<string>();
    const stages = value.stages.map((stageEntry, stageIndex) => {
      const stage = object(stageEntry, `workflow ${id} stage ${stageIndex}`);
      const stageId = requireString(stage.id, "stage.id", { max: 64 });
      if (stageIds.has(stageId)) throw new Error(`duplicate stage id ${stageId} in workflow ${id}`);
      stageIds.add(stageId);
      const maxAttempts = stage.maxAttempts ?? 3;
      if (!Number.isInteger(maxAttempts) || (maxAttempts as number) < 1 || (maxAttempts as number) > 20) {
        throw new Error(`stage ${stageId} maxAttempts must be an integer between 1 and 20`);
      }
      const area = stage.area
        ? requireString(stage.area, "stage.area", { max: 24 }) as ImprovementArea
        : undefined;
      if (area && !["harness", "gates", "implementation", "workflow", "documentation", "security", "other"].includes(area)) {
        throw new Error(`stage ${stageId} area is invalid`);
      }
      return {
        id: stageId,
        label: requireString(stage.label ?? stageId, "stage.label", { max: 128 }),
        instructions: requireString(stage.instructions, "stage.instructions", { max: 4_000 }),
        requiredEvidence: stringArray(stage.requiredEvidence ?? [], "stage.requiredEvidence"),
        maxAttempts: maxAttempts as number,
        ...(area ? { area } : {}),
      };
    });
    let filter: WebhookWorkflowDefinition["filter"];
    if (value.filter !== undefined) {
      const candidate = object(value.filter, `workflow ${id} filter`);
      filter = {
        path: requireString(candidate.path, "filter.path", { max: 256 }),
        equals: requireString(candidate.equals, "filter.equals", { max: 512 }),
      };
    }
    if (
      value.ttlMs !== undefined
      && (!Number.isInteger(value.ttlMs)
        || (value.ttlMs as number) < MIN_MESSAGE_TTL_MS
        || (value.ttlMs as number) > MAX_MESSAGE_TTL_MS)
    ) {
      throw new Error(`workflow ${id} ttlMs must be an integer between ${MIN_MESSAGE_TTL_MS} and ${MAX_MESSAGE_TTL_MS}`);
    }
    return {
      id,
      source,
      project: requireString(value.project, "workflow.project", { max: 128 }),
      target: requireString(value.target, "workflow.target", { max: 80 }),
      secret,
      ...(signalSecret ? { signalSecret } : {}),
      ...(value.event ? { event: requireString(value.event, "workflow.event", { max: 128 }) } : {}),
      ...(filter ? { filter } : {}),
      delivery,
      ...(value.ttlMs !== undefined ? { ttlMs: value.ttlMs as number } : {}),
      promptTemplate: requireString(value.promptTemplate, "workflow.promptTemplate", { max: 20_000 }),
      stages,
    };
  });
}

export function valueAtPath(payload: unknown, path: string): unknown {
  let current = payload;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function renderWorkflowPrompt(template: string, payload: unknown): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, path: string) => {
    const value = valueAtPath(payload, path);
    if (value === undefined || value === null) return "";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}

export function checkpointRun(
  run: WorkflowRun,
  stageId: string,
  status: WorkflowCheckpointStatus,
  summary: string,
  evidence: string[],
  timestamp: string,
): { retry: boolean; completed: boolean; run: WorkflowRun } {
  if (run.status !== "running") throw new ProtocolError(409, `workflow is ${run.status}`, "workflow_terminal");
  const stage = run.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new ProtocolError(404, `workflow stage not found: ${stageId}`, "workflow_stage_not_found");
  if (stage.id !== run.currentStage || stage.status !== "in_progress") {
    throw new ProtocolError(409, `stage ${stageId} is not currently active`, "workflow_stage_out_of_order");
  }
  if (status === "passed" && evidence.length < stage.requiredEvidence.length) {
    throw new ProtocolError(
      400,
      `stage ${stageId} requires at least ${stage.requiredEvidence.length} evidence items`,
      "workflow_evidence_incomplete",
    );
  }
  stage.attempts += 1;
  stage.summary = summary;
  stage.evidence = evidence;
  stage.updatedAt = timestamp;
  run.updatedAt = timestamp;
  if (status !== "passed") {
    stage.status = status;
    if (stage.attempts >= stage.maxAttempts) {
      stage.completedAt = timestamp;
      run.status = "failed";
      delete run.currentStage;
      return { retry: false, completed: false, run };
    }
    stage.status = "in_progress";
    return { retry: true, completed: false, run };
  }
  stage.status = "passed";
  stage.completedAt = timestamp;
  const next = run.stages.find((candidate) => candidate.status === "pending");
  if (next) {
    next.status = "in_progress";
    next.startedAt = timestamp;
    next.updatedAt = timestamp;
    run.currentStage = next.id;
    return { retry: false, completed: false, run };
  }
  run.status = "completed";
  delete run.currentStage;
  run.completedAt = timestamp;
  return { retry: false, completed: true, run };
}

export function waitForWorkflowSignal(
  run: WorkflowRun,
  stageId: string,
  signalKey: string,
  summary: string,
  timestamp: string,
  expiresAt: string,
): WorkflowRun {
  if (run.status !== "running") throw new ProtocolError(409, `workflow is ${run.status}`, "workflow_not_running");
  const stage = run.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new ProtocolError(404, `workflow stage not found: ${stageId}`, "workflow_stage_not_found");
  if (stage.id !== run.currentStage || stage.status !== "in_progress") {
    throw new ProtocolError(409, `stage ${stageId} is not currently active`, "workflow_stage_out_of_order");
  }
  if (Date.parse(expiresAt) <= Date.parse(timestamp)) {
    throw new ProtocolError(400, "workflow signal expiry must be in the future", "workflow_wait_invalid");
  }
  stage.status = "waiting";
  stage.updatedAt = timestamp;
  run.status = "waiting";
  run.waiting = { stageId, signalKey, summary, createdAt: timestamp, expiresAt };
  run.updatedAt = timestamp;
  return run;
}

export function resumeWorkflowFromSignal(
  run: WorkflowRun,
  signalKey: string,
  status: WorkflowCheckpointStatus,
  summary: string,
  evidence: string[],
  timestamp: string,
): { retry: boolean; completed: boolean; run: WorkflowRun; stageId: string } {
  if (run.status !== "waiting" || !run.waiting) {
    throw new ProtocolError(409, `workflow is ${run.status}`, "workflow_not_waiting");
  }
  if (run.waiting.signalKey !== signalKey) {
    throw new ProtocolError(409, `workflow is waiting for ${run.waiting.signalKey}`, "workflow_signal_mismatch");
  }
  const stageId = run.waiting.stageId;
  const stage = run.stages.find((candidate) => candidate.id === stageId);
  if (!stage || stage.id !== run.currentStage || stage.status !== "waiting") {
    throw new ProtocolError(409, "workflow wait state is inconsistent", "workflow_wait_inconsistent");
  }
  if (status === "passed" && evidence.length < stage.requiredEvidence.length) {
    throw new ProtocolError(
      400,
      `stage ${stageId} requires at least ${stage.requiredEvidence.length} evidence items`,
      "workflow_evidence_incomplete",
    );
  }
  run.status = "running";
  stage.status = "in_progress";
  delete run.waiting;
  const result = checkpointRun(run, stageId, status, summary, evidence, timestamp);
  return { ...result, stageId };
}
