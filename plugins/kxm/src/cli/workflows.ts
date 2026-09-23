import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { stringify } from "yaml";
import { openReadOnlyDatabase } from "../sqlite.ts";
import { buildRetrospective, writeRetrospective } from "../retrospective.ts";
import { redactSecrets } from "../redact.ts";
import { postWorkflowSignal, watchGithubChecks } from "../github-watch.ts";
import {
  listWorkflowDefinitions,
  addWorkflowDefinition,
  removeWorkflowDefinition,
  modifyWorkflowDefinition,
  scaffoldWorkflowDefinition,
  WORKFLOW_TEMPLATES,
} from "../workflow-manager.ts";
import {
  canonicalWorkflowEvidenceKey,
  parseWorkflowDefinitions,
  workflowWebhookHeaders,
  type WorkflowEvidenceInput,
  type WorkflowJournalEntry,
  type WorkflowRun,
} from "../workflow.ts";
import { discoverKxmProjectRoot, kxmWorkflowWriteIssues } from "../project-config.ts";
import { ensureKxmSupervisor, kxmRuntimeRequest } from "../runtime-supervisor.ts";
import { projectRuntimeOwnsRun } from "../runtime-store.ts";
import type { WorkerOutcome } from "../envelope.ts";
import {
  print,
  printPlan,
  printWorker,
  gateOf,
  parseEvidencePairs,
  maskEnvName,
  type CliIo,
  type Runtime,
} from "./types.ts";
import { resolvePickItem, type PickCandidate } from "./roles.ts";

const CLI_NAME = "kxm";

export function localWorkflowSnapshot(dataPath: string, runId?: string): { runs: WorkflowRun[]; journal: WorkflowJournalEntry[] } {
  if (!existsSync(dataPath)) throw new Error("state_database_not_found");
  const database = openReadOnlyDatabase(dataPath);
  try {
    const rows = runId
      ? database.prepare("SELECT record FROM workflow_runs WHERE id = ?").all(runId)
      : database.prepare("SELECT record FROM workflow_runs ORDER BY rowid DESC LIMIT 200").all();
    const runs = (rows as Array<{ record: string }>).map((row) => JSON.parse(row.record) as WorkflowRun);
    const journal = runId
      ? (database.prepare("SELECT record FROM workflow_journal WHERE run_id = ? ORDER BY rowid").all(runId) as Array<{ record: string }>).map((row) => JSON.parse(row.record) as WorkflowJournalEntry)
      : [];
    return { runs, journal };
  } finally {
    database.close();
  }
}

export async function postWorkflowStart(input: {
  serverUrl: string;
  definitionId: string;
  secret: string;
  deliveryId: string;
  event?: string | undefined;
  payload: Record<string, unknown>;
  fetchImpl: typeof fetch;
}): Promise<{ status: number; runId?: string | undefined; duplicate: boolean }> {
  const payload = input.event && input.payload["event"] === undefined
    ? { ...input.payload, event: input.event }
    : input.payload;
  const body = JSON.stringify(payload);
  const response = await input.fetchImpl(`${input.serverUrl.replace(/\/$/, "")}/v1/webhooks/${encodeURIComponent(input.definitionId)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...workflowWebhookHeaders({
        secret: input.secret,
        scope: { definitionId: input.definitionId },
        deliveryId: input.deliveryId,
        body,
      }),
      ...(input.event ? { "x-github-event": input.event } : {}),
    },
    body,
  });
  const responseText = (await response.text()).slice(0, 8_000);
  let parsed: { runId?: string; duplicate?: boolean } = {};
  try {
    parsed = JSON.parse(responseText);
  } catch {
    // fallback
  }
  if (!response.ok) throw new Error(`workflow_start_http_${response.status}`);
  return {
    status: response.status,
    ...(parsed.runId ? { runId: parsed.runId } : {}),
    duplicate: parsed.duplicate === true,
  };
}

export async function postWorkflowDegradation(input: {
  serverUrl: string;
  authToken: string;
  runId: string;
  stageId: string;
  requirementKey: string;
  reason: string;
  fetchImpl: typeof fetch;
}): Promise<{ status: number; duplicate: boolean; approvalId?: string | undefined }> {
  const response = await input.fetchImpl(
    `${input.serverUrl.replace(/\/$/, "")}/v1/workflows/${encodeURIComponent(input.runId)}/degradations`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.authToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stageId: input.stageId,
        requirementKey: input.requirementKey,
        reason: input.reason,
      }),
    },
  );
  const responseText = (await response.text()).slice(0, 8_000);
  let parsed: { duplicate?: boolean; approval?: { id?: string } } = {};
  try {
    parsed = JSON.parse(responseText);
  } catch {
    // fallback
  }
  if (!response.ok) throw new Error(`workflow_degradation_http_${response.status}`);
  return {
    status: response.status,
    duplicate: parsed.duplicate === true,
    ...(parsed.approval?.id ? { approvalId: parsed.approval.id } : {}),
  };
}

export function activeWorkflowDefinition(runtime: Runtime, definitionId: string) {
  const inline = runtime.env.KXM_WEBHOOK_WORKFLOWS?.trim();
  const file = runtime.env.KXM_WEBHOOK_WORKFLOWS_FILE?.trim();
  if (inline && file) {
    throw new Error("configure only one of KXM_WEBHOOK_WORKFLOWS or KXM_WEBHOOK_WORKFLOWS_FILE");
  }
  if (!inline && !file) return undefined;
  let raw: string;
  if (file) {
    try {
      raw = readFileSync(resolve(runtime.cwd, file), "utf8");
    } catch {
      throw new Error("workflow definition file is unavailable");
    }
  } else {
    raw = inline!;
  }
  const definition = parseWorkflowDefinitions(raw, runtime.env).find((candidate) => candidate.id === definitionId);
  if (!definition) throw new Error(`workflow definition not found: ${definitionId}`);
  return definition;
}

export function workflowCredential(runtime: Runtime, definitionId: string, kind: "start" | "signal"): string | undefined {
  const definition = activeWorkflowDefinition(runtime, definitionId);
  if (definition) return kind === "start" ? definition.secret : definition.signalSecret ?? definition.secret;
  return kind === "start"
    ? runtime.env.KXM_WORKFLOW_SECRET?.trim()
    : runtime.env.KXM_WORKFLOW_SIGNAL_SECRET?.trim();
}

export function reportWorkflowConfigError(runtime: Runtime, error: unknown): number {
  const message = error instanceof Error ? redactSecrets(error.message) : "invalid workflow configuration";
  runtime.io.stderr(`${message}\n`);
  return 2;
}

export async function cmdWorkflowDefinitions(
  runtime: Runtime,
  options: { scope?: "all" | "global" | "local" | undefined },
): Promise<number> {
  const workflows = listWorkflowDefinitions({
    scope: options.scope,
    repoRoot: runtime.cwd,
    userConfigDir: runtime.env.KXM_USER_CONFIG_DIR,
  });
  if (runtime.json) {
    print(runtime.io, true, { ok: true, command: "workflow definitions", workflows }, "");
    return 0;
  }
  if (workflows.length === 0) {
    runtime.io.stdout("No workflow definitions found.\n");
    return 0;
  }
  const lines: string[] = ["WORKFLOW DEFINITIONS:"];
  for (const w of workflows) {
    const scopeTag = w.scope === "overridden" ? "[local override]" : `[${w.scope}]`;
    const rolesTag = w.roles.length > 0 ? `(roles: ${w.roles.join(", ")})` : "";
    lines.push(`  ${w.id.padEnd(24)} ${scopeTag.padEnd(16)} ${w.stepCount} steps ${rolesTag} ${w.description}`);
  }
  print(runtime.io, false, {}, `${lines.join("\n")}\n`);
  return 0;
}

export async function cmdWorkflowAdd(
  runtime: Runtime,
  workflowId: string | undefined,
  options: {
    file?: string | undefined;
    description?: string | undefined;
    scope?: "global" | "local" | undefined;
    overwrite?: boolean | undefined;
    pick?: string | boolean | undefined;
    template?: string | undefined;
  },
): Promise<number> {
  const scope = options.scope ?? "local";
  const refuse = (error: string, text: string): number => {
    print(runtime.io, runtime.json, { ok: false, command: "workflow add", error }, `workflow add failed: ${text}`);
    return 2;
  };
  let content: Record<string, unknown> | string | undefined;
  if (options.template !== undefined) {
    if (options.file !== undefined || options.pick !== undefined) {
      return refuse("workflow_add_conflict", "--template cannot be combined with --file or --pick");
    }
    if (!workflowId) return refuse("workflow_id_required", "usage: kxm workflow add <workflowId> --template <name>");
    const template = Object.hasOwn(WORKFLOW_TEMPLATES, options.template) ? WORKFLOW_TEMPLATES[options.template] : undefined;
    if (!template) {
      return refuse("workflow_template_unknown", `unknown template ${options.template}; choose ${Object.keys(WORKFLOW_TEMPLATES).join(", ")}`);
    }
    content = { ...template, ...(options.description ? { description: options.description } : {}) };
  } else if (!workflowId || options.pick) {
    const candidates: PickCandidate[] = Object.entries(WORKFLOW_TEMPLATES).map(([id, tmpl]) => ({
      id,
      description: String(tmpl.description ?? id),
      label: "template",
      payload: tmpl,
    }));
    if (scope === "local") {
      const globalDefs = listWorkflowDefinitions({ scope: "global", userConfigDir: runtime.env.KXM_USER_CONFIG_DIR });
      for (const gd of globalDefs) {
        if (!candidates.some((c) => c.id === gd.id)) {
          candidates.push({ id: gd.id, description: gd.description, label: "global" });
        }
      }
    }
    const picked = await resolvePickItem(runtime.io, `Select a workflow template to add (${scope})`, candidates, options.pick, runtime.env);
    if (!picked) {
      if (!workflowId) {
        runtime.io.stderr("workflow add failed: missing workflowId or pick selection\n");
        return 1;
      }
    } else {
      workflowId = picked.id;
      if (!options.file && picked.payload) {
        content = {
          ...picked.payload,
          ...(options.description ? { description: options.description } : {}),
        };
      }
    }
  }

  if (options.file) {
    const filePath = resolve(runtime.cwd, options.file);
    content = readFileSync(filePath, "utf8");
  } else if (!content) {
    content = scaffoldWorkflowDefinition(options.description || `Workflow ${workflowId}`);
  }

  try {
    const document = typeof content === "string" ? content : stringify(content);
    // A local workflow is read by the project loader, which refuses the whole
    // project over one bad file, so it is checked by that loader before it lands.
    let repoRoot = runtime.cwd;
    if (scope === "local") {
      const projectRoot = discoverKxmProjectRoot(runtime.cwd);
      if (!projectRoot) {
        return refuse("project_not_found", "local workflows belong to a KXM project; run kxm init at the repository root, or pass --scope global");
      }
      const issues = kxmWorkflowWriteIssues(projectRoot, workflowId!, document);
      if (issues.length > 0) {
        print(
          runtime.io,
          runtime.json,
          { ok: false, command: "workflow add", error: "workflow_invalid", issues },
          `workflow add failed: with this workflow the project would not load, so nothing was written\n${issues.map((entry) => `  ${entry.file}: ${entry.code}: ${entry.message}`).join("\n")}`,
        );
        return 2;
      }
      repoRoot = projectRoot;
    }
    const res = addWorkflowDefinition(workflowId!, document, {
      scope,
      repoRoot,
      userConfigDir: runtime.env.KXM_USER_CONFIG_DIR,
      overwrite: options.overwrite,
      dryRun: runtime.dryRun,
    });
    if (runtime.dryRun) {
      printPlan(runtime, { command: "workflow add", workflowId, ...res }, [{ action: "write", target: res.filePath }], `add workflow '${workflowId}' to ${res.scope}`);
      return 0;
    }
    print(
      runtime.io,
      runtime.json,
      { ok: true, command: "workflow add", workflowId, ...res },
      `Added workflow '${workflowId}' to ${res.scope} (${res.filePath})\n`,
    );
    return 0;
  } catch (err: unknown) {
    runtime.io.stderr(`workflow add failed: ${(err as Error).message}\n`);
    return 1;
  }
}

export async function cmdWorkflowRemove(
  runtime: Runtime,
  workflowId: string | undefined,
  options: { scope?: "global" | "local" | undefined; pick?: string | boolean | undefined },
): Promise<number> {
  const scope = options.scope ?? "local";
  if (!workflowId || options.pick) {
    const workflows = listWorkflowDefinitions({
      scope,
      repoRoot: runtime.cwd,
      userConfigDir: runtime.env.KXM_USER_CONFIG_DIR,
    });
    if (workflows.length === 0) {
      runtime.io.stdout(`No workflow definitions found in ${scope} scope to remove.\n`);
      return 0;
    }
    const candidates: PickCandidate[] = workflows.map((w) => ({
      id: w.id,
      description: w.description,
      label: w.scope,
    }));
    const picked = await resolvePickItem(runtime.io, `Select a workflow to remove (${scope})`, candidates, options.pick, runtime.env);
    if (!picked) {
      if (!workflowId) {
        runtime.io.stderr("workflow remove failed: missing workflowId or pick selection\n");
        return 1;
      }
    } else {
      workflowId = picked.id;
    }
  }

  try {
    const res = removeWorkflowDefinition(workflowId!, {
      scope,
      repoRoot: runtime.cwd,
      userConfigDir: runtime.env.KXM_USER_CONFIG_DIR,
      dryRun: runtime.dryRun,
    });
    if (runtime.dryRun) {
      printPlan(runtime, { command: "workflow remove", workflowId, ...res }, [{ action: "delete", target: res.filePath }], `remove workflow '${workflowId}' from ${res.scope}`);
      return 0;
    }
    print(
      runtime.io,
      runtime.json,
      { ok: true, command: "workflow remove", workflowId, ...res },
      `Removed workflow '${workflowId}' from ${res.scope}\n`,
    );
    return 0;
  } catch (err: unknown) {
    runtime.io.stderr(`workflow remove failed: ${(err as Error).message}\n`);
    return 1;
  }
}

export async function cmdWorkflowModify(
  runtime: Runtime,
  workflowId: string | undefined,
  options: {
    description?: string | undefined;
    scope?: "global" | "local" | undefined;
    pick?: string | boolean | undefined;
  },
): Promise<number> {
  if (!workflowId || options.pick) {
    const workflows = listWorkflowDefinitions({
      scope: options.scope,
      repoRoot: runtime.cwd,
      userConfigDir: runtime.env.KXM_USER_CONFIG_DIR,
    });
    if (workflows.length === 0) {
      runtime.io.stdout("No workflow definitions found to modify.\n");
      return 0;
    }
    const candidates: PickCandidate[] = workflows.map((w) => ({
      id: w.id,
      description: w.description,
      label: w.scope,
    }));
    const picked = await resolvePickItem(runtime.io, "Select a workflow to modify", candidates, options.pick, runtime.env);
    if (!picked) {
      if (!workflowId) {
        runtime.io.stderr("workflow modify failed: missing workflowId or pick selection\n");
        return 1;
      }
    } else {
      workflowId = picked.id;
    }
  }

  try {
    const res = modifyWorkflowDefinition(
      workflowId!,
      { ...(options.description ? { description: options.description } : {}) },
      {
        scope: options.scope,
        repoRoot: runtime.cwd,
        userConfigDir: runtime.env.KXM_USER_CONFIG_DIR,
        dryRun: runtime.dryRun,
      },
    );
    if (runtime.dryRun) {
      printPlan(runtime, { command: "workflow modify", workflowId, ...res }, [{ action: "write", target: res.filePath }], `modify workflow '${workflowId}' in ${res.scope}`);
      return 0;
    }
    print(
      runtime.io,
      runtime.json,
      { ok: true, command: "workflow modify", workflowId, ...res },
      `Modified workflow '${workflowId}' in ${res.scope}\n`,
    );
    return 0;
  } catch (err: unknown) {
    runtime.io.stderr(`workflow modify failed: ${(err as Error).message}\n`);
    return 1;
  }
}

export async function cmdWorkflowStart(runtime: Runtime, definitionIdArg: string | undefined, options: { payload?: string | undefined; deliveryId?: string | undefined; event?: string | undefined }): Promise<number> {
  const definitionId = definitionIdArg || runtime.env.KXM_WORKFLOW_ID?.trim();
  const deliveryId = String(options.deliveryId || `cli-${randomUUID()}`);
  const event = options.event;
  const payloadFlag = options.payload ?? "{}";
  if (!definitionId) {
    runtime.io.stderr("workflow start requires <definitionId> (or KXM_WORKFLOW_ID)\n");
    return 2;
  }
  let secret: string | undefined;
  try {
    secret = workflowCredential(runtime, definitionId, "start");
  } catch (error) {
    return reportWorkflowConfigError(runtime, error);
  }
  if (!secret) {
    runtime.io.stderr("workflow start requires KXM_WORKFLOW_SECRET when no active definition source is configured\n");
    return 2;
  }
  let payload: Record<string, unknown>;
  try {
    const raw = payloadFlag.startsWith("@") ? readFileSync(resolve(runtime.cwd, payloadFlag.slice(1)), "utf8") : payloadFlag;
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    payload = value as Record<string, unknown>;
  } catch {
    print(runtime.io, runtime.json, { ok: false, command: "workflow start", error: "invalid_payload" }, "workflow payload must be a JSON object or @file");
    return 2;
  }
  if (runtime.dryRun) {
    print(runtime.io, runtime.json, { ok: true, command: "workflow start", dryRun: true, definitionId, deliveryId, event }, "would POST a signed workflow webhook");
    return 0;
  }
  try {
    const response = await postWorkflowStart({ serverUrl: runtime.serverUrl, definitionId, secret, deliveryId, ...(event ? { event } : {}), payload, fetchImpl: runtime.fetchImpl });
    print(runtime.io, runtime.json, { ok: true, command: "workflow start", definitionId, deliveryId, ...response }, `started workflow ${response.runId ?? "accepted"}`);
    return 0;
  } catch {
    print(runtime.io, runtime.json, { ok: false, command: "workflow start", error: "workflow_start_failed" }, "signed workflow start failed");
    return 1;
  }
}

export async function cmdWorkflowDegrade(runtime: Runtime, runId: string, stageId: string, options: { requirement?: string | undefined; reason?: string | undefined }): Promise<number> {
  const requirementKey = options.requirement?.trim() ?? "";
  const reason = options.reason?.trim() ?? "";
  const adminToken = runtime.env.KXM_AUTH_TOKEN?.trim();
  if (!runId || !stageId || !requirementKey || !reason || !adminToken) {
    runtime.io.stderr("workflow degrade requires <runId> <stageId>, --requirement, --reason, and KXM_AUTH_TOKEN\n");
    return 2;
  }
  const worker = gateOf(runtime, "degrade");
  if (runtime.dryRun) {
    printWorker(
      runtime,
      worker,
      { ok: true, command: "workflow degrade", dryRun: true, runId, stageId, requirementKey },
      `would approve configured degraded quorum for ${runId}/${stageId}/${requirementKey}`,
    );
    return 0;
  }
  try {
    const result = await postWorkflowDegradation({
      serverUrl: runtime.serverUrl,
      authToken: adminToken,
      runId,
      stageId,
      requirementKey,
      reason,
      fetchImpl: runtime.fetchImpl,
    });
    printWorker(
      runtime,
      worker,
      { ok: true, command: "workflow degrade", runId, stageId, requirementKey, ...result },
      result.duplicate ? "degraded quorum was already approved" : "approved configured degraded quorum",
    );
    return 0;
  } catch {
    printWorker(
      runtime,
      worker,
      { ok: false, command: "workflow degrade", error: "workflow_degradation_failed", runId, stageId, requirementKey },
      "workflow degradation approval failed",
    );
    return 1;
  }
}

export async function cmdWorkflowInspect(runtime: Runtime, action: "list" | "get", runId?: string | undefined): Promise<number> {
  const dataPath = resolve(runtime.dirs.workdir, runtime.env.KXM_DATA_PATH?.trim() || join(runtime.dirs.state, "kxm.db"));
  if (action === "get" && !runId) {
    runtime.io.stderr(`Usage: ${CLI_NAME} workflow get <runId>\n`);
    return 2;
  }
  try {
    const snapshot = localWorkflowSnapshot(dataPath, runId);
    if (runId && snapshot.runs.length === 0) {
      print(runtime.io, runtime.json, { ok: false, command: "workflow get", error: "workflow_not_found" }, "workflow not found");
      return 1;
    }
    const value = action === "get"
      ? { ok: true, command: "workflow get", run: snapshot.runs[0], journal: snapshot.journal }
      : { ok: true, command: "workflow list", runs: snapshot.runs };
    print(runtime.io, runtime.json, value, action === "get" ? `workflow ${runId}` : `${snapshot.runs.length} workflow(s)`);
    return 0;
  } catch {
    print(runtime.io, runtime.json, { ok: false, command: `workflow ${action}`, error: "state_unavailable" }, "local workflow state is unavailable");
    return 1;
  }
}

export async function cmdSignal(runtime: Runtime, runId: string, signalKey: string, status: string, summary: string, evidenceArgs: string[], deliveryIdFlag?: string | undefined, recoveryAction?: string | undefined): Promise<number> {
  if (!runId || !signalKey || !status || !summary) {
    runtime.io.stderr(`Usage: ${CLI_NAME} gate signal <runId> <signalKey> <passed|warning|failed> <summary> [<required-key>=<evidence> ...]\n`);
    return 2;
  }
  if (status !== "passed" && status !== "warning" && status !== "failed") {
    runtime.io.stderr("status must be passed, warning, or failed\n");
    return 2;
  }
  let evidence: WorkflowEvidenceInput;
  try {
    evidence = parseEvidencePairs(evidenceArgs);
  } catch (error) {
    runtime.io.stderr(`${error instanceof Error ? error.message : "invalid evidence"}\n`);
    return 2;
  }
  const worker = gateOf(runtime, "signal");
  const projectRoot = discoverKxmProjectRoot(runtime.cwd);
  if (projectRoot && projectRuntimeOwnsRun(projectRoot, runId, runtime.env)) {
    if (runtime.dryRun) {
      printWorker(runtime, worker, { ok: true, command: "signal", dryRun: true, runId, signalKey, status, summary, evidence }, "would post signal to KXM run");
      return 0;
    }
    const deliveryId = String(deliveryIdFlag || `cli-signal:${randomUUID()}`);
    try {
      const supervisor = await ensureKxmSupervisor({ env: runtime.env });
      const posted = await kxmRuntimeRequest(
        supervisor,
        "POST",
        `/v1/runs/${encodeURIComponent(runId)}/signal?projectRoot=${encodeURIComponent(projectRoot)}`,
        { signalKey, status, summary, evidence, deliveryId, ...(recoveryAction ? { action: recoveryAction } : {}) },
      );
      printWorker(runtime, worker, { ok: true, command: "signal", runId, signalKey, status, unblocked: posted.unblocked === true, deliveryId }, "posted signal to KXM run");
      return 0;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "signal_failed";
      printWorker(runtime, worker, { ok: false, command: "signal", error: "signal_failed", detail: msg, deliveryId }, "signal to KXM run failed");
      return 1;
    }
  }

  const definitionId = runtime.env.KXM_WORKFLOW_ID?.trim();
  if (!definitionId) {
    runtime.io.stderr("signal requires KXM_WORKFLOW_ID\n");
    return 2;
  }
  let signalSecret: string | undefined;
  try {
    signalSecret = workflowCredential(runtime, definitionId, "signal");
  } catch (error) {
    return reportWorkflowConfigError(runtime, error);
  }
  if (!signalSecret) {
    runtime.io.stderr("signal requires KXM_WORKFLOW_SIGNAL_SECRET when no active definition source is configured\n");
    return 2;
  }
  if (runtime.dryRun) {
    printWorker(runtime, worker, { ok: true, command: "signal", dryRun: true, runId, signalKey, status, summary, evidence }, "would post signed signal");
    return 0;
  }
  const deliveryId = String(deliveryIdFlag || `cli-signal:${randomUUID()}`);
  try {
    const posted = await postWorkflowSignal({
      serverUrl: runtime.serverUrl,
      definitionId,
      signalSecret,
      runId,
      signalKey,
      status,
      summary,
      evidence,
      deliveryId,
      fetchImpl: runtime.fetchImpl,
    });
    printWorker(runtime, worker, { ok: true, command: "signal", duplicate: posted.duplicate, deliveryId }, "posted signed signal");
    return 0;
  } catch {
    printWorker(runtime, worker, { ok: false, command: "signal", error: "signal_failed", deliveryId }, "signed signal failed");
    return 1;
  }
}

export async function cmdGithubWatch(runtime: Runtime, options: {
  runId?: string | undefined;
  stageId?: string | undefined;
  signalKey?: string | undefined;
  repo?: string | undefined;
  pr?: string | undefined;
  required?: string | undefined;
  timeoutMs?: string | undefined;
  intervalMs?: string | undefined;
  deliveryId?: string | undefined;
}): Promise<number> {
  const token = runtime.env.GITHUB_TOKEN?.trim() || runtime.env.GH_TOKEN?.trim();
  const definitionId = runtime.env.KXM_WORKFLOW_ID?.trim();
  const runId = String(options.runId || "");
  const stageId = String(options.stageId || "");
  const signalKey = String(options.signalKey || "");
  const repo = String(options.repo || "");
  const pr = Number(options.pr);
  if (!definitionId || !runId || !stageId || !signalKey || !repo || !Number.isInteger(pr)) {
    runtime.io.stderr("github watch requires KXM_WORKFLOW_ID, --run-id, --stage-id, --signal-key, --repo, --pr\n");
    return 2;
  }
  let signalSecret: string | undefined;
  try {
    signalSecret = workflowCredential(runtime, definitionId, "signal");
  } catch (error) {
    return reportWorkflowConfigError(runtime, error);
  }
  if (!signalSecret) {
    runtime.io.stderr("github watch requires KXM_WORKFLOW_SIGNAL_SECRET when no active definition source is configured\n");
    return 2;
  }
  const result = await watchGithubChecks({
    serverUrl: runtime.serverUrl,
    definitionId,
    signalSecret,
    runId,
    stageId,
    signalKey,
    repo,
    pr,
    required: options.required
      ? [...new Set(String(options.required).split(",").map((name) => name.trim()).filter(Boolean))]
      : [],
    timeoutMs: Number(options.timeoutMs || 1_800_000),
    intervalMs: Number(options.intervalMs || 15_000),
    ...(options.deliveryId ? { deliveryId: options.deliveryId } : {}),
    ...(token ? { token } : {}),
    dryRun: runtime.dryRun,
    fetchImpl: runtime.fetchImpl,
    ...(runtime.io.now ? { now: runtime.io.now } : {}),
    ...(runtime.io.sleep ? { sleep: runtime.io.sleep } : {}),
  });
  const worker = gateOf(runtime, "github-watch");
  const payload = {
    ok: result.exitCode === 0,
    command: "github watch",
    posted: result.posted,
    status: result.status,
    summary: result.summary,
    evidence: result.evidence,
    deliveryId: result.deliveryId,
    skipped: result.skipped,
  };
  const outcome: WorkerOutcome = result.exitCode === 0
    ? (result.status === "warning" ? "warning" : "passed")
    : "failed";
  if (JSON.stringify(payload).includes(token ?? "___never___") || Object.keys(runtime.env).some((key) => maskEnvName(key) && JSON.stringify(payload).includes(String(runtime.env[key])))) {
    printWorker(runtime, worker, { ok: false, command: "github watch", error: "redaction_failure" }, "refusing to print a payload that contains a secret");
    return 1;
  }
  printWorker(runtime, worker, payload, result.summary, outcome);
  return result.exitCode;
}

export async function cmdRetrospectiveExport(runtime: Runtime, runId: string, options: { input?: string | undefined; outDir?: string | undefined }): Promise<number> {
  if (!runId) {
    runtime.io.stderr(`Usage: ${CLI_NAME} workflow export <runId>\n`);
    return 2;
  }
  const snapshotFlag = String(options.input || "");
  const snapshotPath = snapshotFlag ? resolve(runtime.cwd, snapshotFlag) : "";
  let snapshot: { run: WorkflowRun; journal: WorkflowJournalEntry[] };
  try {
    if (snapshotPath) {
      if (!existsSync(snapshotPath)) throw new Error("snapshot_missing");
      snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as typeof snapshot;
    } else {
      const dataPath = resolve(runtime.dirs.workdir, runtime.env.KXM_DATA_PATH?.trim() || join(runtime.dirs.state, "kxm.db"));
      const local = localWorkflowSnapshot(dataPath, runId);
      if (!local.runs[0]) throw new Error("workflow_not_found");
      snapshot = { run: local.runs[0], journal: local.journal };
    }
    if (snapshot.run.id !== runId) throw new Error("run_id_mismatch");
  } catch (error) {
    const reason = error instanceof Error ? error.message : "snapshot_invalid";
    print(runtime.io, runtime.json, { ok: false, command: "retrospective export", error: reason }, "retrospective source is invalid or unavailable");
    return 1;
  }
  const doc = buildRetrospective(snapshot.run, snapshot.journal);
  const outDir = resolve(runtime.cwd, String(options.outDir || join(runtime.dirs.assets, "retrospectives")));
  const assetsRoot = resolve(runtime.dirs.assets);
  const assetsPrefix = `${assetsRoot}${process.platform === "win32" ? "\\" : "/"}`;
  if (outDir !== assetsRoot && !outDir.startsWith(assetsPrefix)) {
    print(runtime.io, runtime.json, { ok: false, command: "retrospective export", error: "output_outside_workspace_assets" }, "retrospectives must stay under the workspace assets directory");
    return 2;
  }
  if (runtime.dryRun) {
    print(runtime.io, runtime.json, { ok: true, command: "retrospective export", dryRun: true, runId: doc.runId }, `would export ${doc.runId}`);
    return 0;
  }
  const written = writeRetrospective(outDir, doc);
  print(runtime.io, runtime.json, { ok: true, command: "retrospective export", ...written, reviewDecision: doc.reviewDecision }, `exported ${written.jsonPath}`);
  return 0;
}
