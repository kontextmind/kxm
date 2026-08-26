import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { canonicalWorkflowEvidenceKey, parseWorkflowDefinitions } from "./workflow.ts";
import { postWorkflowSignal, watchGithubChecks } from "./github-watch.ts";
import { buildRetrospective, writeRetrospective } from "./retrospective.ts";
import { redactSecrets } from "./redact.ts";
import type { WorkflowEvidenceInput, WorkflowJournalEntry, WorkflowRun } from "./workflow.ts";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  spawnHub?: (extraEnv: NodeJS.ProcessEnv) => number | Promise<number>;
  spawnWorker?: (extraEnv: NodeJS.ProcessEnv) => number | Promise<number>;
}

const repoRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

function spawnScript(scriptName: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<number> {
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, [join(repoRoot, "scripts", scriptName)], {
      stdio: "inherit",
      env: { ...process.env, ...extraEnv },
    });
    child.once("error", () => resolveExit(1));
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
}

interface ParsedArgs {
  json: boolean;
  dryRun: boolean;
  workspace?: string;
  command: string;
  rest: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  let json = false;
  let dryRun = false;
  let workspace: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--json") json = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--workspace") workspace = argv[++index];
    else if (arg.startsWith("--") && argv[index + 1] && !argv[index + 1]!.startsWith("--")) {
      flags[arg.slice(2)] = argv[++index]!;
    } else if (arg.startsWith("--")) {
      flags[arg.slice(2)] = true;
    } else {
      positionals.push(arg);
    }
  }
  return {
    json,
    dryRun,
    ...(workspace ? { workspace } : {}),
    command: positionals.join(" ").trim(),
    rest: positionals,
    flags,
  };
}

function usage(): string {
  return [
    "Usage: pi-mesh [--json] [--dry-run] [--workspace <dir>] <command>",
    "Commands: init | validate | status | hub | worker --name <name> --project <project> [--model <id>] | stop",
    "          workflow list | workflow get <runId> | workflow start <definitionId> --payload <JSON|@file>",
    "          signal | github watch | retrospective export <runId> | smoke",
  ].join("\n");
}

function parseEvidencePairs(values: string[]): WorkflowEvidenceInput {
  const evidence = new Map<string, string>();
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error("evidence must use <required-key>=<evidence> syntax");
    }
    const requirement = canonicalWorkflowEvidenceKey(value.slice(0, separator));
    const proof = value.slice(separator + 1).trim();
    if (!requirement || !proof) throw new Error("evidence must use <required-key>=<evidence> syntax");
    if (evidence.has(requirement)) throw new Error(`duplicate normalized evidence key: ${requirement}`);
    evidence.set(requirement, proof);
  }
  return Object.fromEntries(evidence);
}

function print(io: CliIo, jsonMode: boolean, payload: Record<string, unknown>, text: string): void {
  const safePayload = redactSecrets(JSON.stringify(payload));
  io.stdout(jsonMode ? `${safePayload}\n` : `${redactSecrets(text)}\n`);
}

function workspaceDirs(cwd: string, workspaceFlag: string | undefined, env: NodeJS.ProcessEnv) {
  const workdir = resolve(env.PI_MESH_WORKDIR?.trim() || cwd);
  const workspace = resolve(workdir, workspaceFlag || env.PI_MESH_WORKSPACE_DIR?.trim() || ".kxm");
  const derive = workspaceFlag !== undefined;
  return {
    workdir,
    workspace,
    config: derive ? join(workspace, "config") : resolve(workdir, env.PI_MESH_CONFIG_DIR?.trim() || join(workspace, "config")),
    logs: derive ? join(workspace, "logs") : resolve(workdir, env.PI_MESH_LOGS_DIR?.trim() || join(workspace, "logs")),
    assets: derive ? join(workspace, "assets") : resolve(workdir, env.PI_MESH_ASSETS_DIR?.trim() || join(workspace, "assets")),
    state: derive ? join(workspace, "state") : resolve(workdir, env.PI_MESH_STATE_DIR?.trim() || join(workspace, "state")),
  };
}

function maskEnvName(name: string): boolean {
  return /TOKEN|SECRET|KEY|PASSWORD/i.test(name);
}

function redactConfiguredValues(text: string, env: NodeJS.ProcessEnv): string {
  let safe = text;
  for (const [name, value] of Object.entries(env)) {
    if (!maskEnvName(name) || !value || value.length < 4) continue;
    safe = safe.replaceAll(value, "[redacted]");
  }
  return redactSecrets(safe);
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function hubGet(url: string, fetchImpl: typeof fetch): Promise<{ ok: boolean; status: number; body: unknown }> {
  try {
    const response = await fetchImpl(url);
    const text = redactSecrets((await response.text()).slice(0, 8_000));
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Keep text for diagnostics without treating it as a secret.
    }
    return { ok: response.ok, status: response.status, body };
  } catch {
    return { ok: false, status: 0, body: { error: "hub_unreachable" } };
  }
}

function localWorkflowSnapshot(dataPath: string, runId?: string): { runs: WorkflowRun[]; journal: WorkflowJournalEntry[] } {
  if (!existsSync(dataPath)) throw new Error("state_database_not_found");
  const database = new DatabaseSync(dataPath, { readOnly: true });
  try {
    const rows = runId
      ? database.prepare("SELECT record FROM workflow_runs WHERE id = ?").all(runId) as Array<{ record: string }>
      : database.prepare("SELECT record FROM workflow_runs ORDER BY rowid DESC LIMIT 200").all() as Array<{ record: string }>;
    const runs = rows.map((row) => JSON.parse(row.record) as WorkflowRun);
    const journal = runId
      ? (database.prepare("SELECT record FROM workflow_journal WHERE run_id = ? ORDER BY rowid").all(runId) as Array<{ record: string }>).map((row) => JSON.parse(row.record) as WorkflowJournalEntry)
      : [];
    return { runs, journal };
  } finally { database.close(); }
}

async function postWorkflowStart(input: { serverUrl: string; definitionId: string; secret: string; deliveryId: string; event?: string; payload: Record<string, unknown>; fetchImpl: typeof fetch }): Promise<{ status: number; runId?: string; duplicate?: boolean }> {
  const payload = input.event && input.payload.event === undefined ? { ...input.payload, event: input.event } : input.payload;
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", input.secret).update(body).digest("hex")}`;
  const response = await input.fetchImpl(`${input.serverUrl.replace(/\/$/, "")}/v1/webhooks/${encodeURIComponent(input.definitionId)}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": signature, "x-mesh-delivery-id": input.deliveryId, ...(input.event ? { "x-github-event": input.event } : {}) },
    body,
  });
  const responseText = (await response.text()).slice(0, 8_000);
  let parsed: { run?: { id?: string }; duplicate?: boolean } = {};
  try { parsed = JSON.parse(responseText) as typeof parsed; } catch { /* bounded adapter error */ }
  if (!response.ok) throw new Error(`workflow_start_http_${response.status}`);
  return { status: response.status, ...(parsed.run?.id ? { runId: parsed.run.id } : {}), duplicate: parsed.duplicate === true };
}

export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: CliIo = { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) },
  cwd = process.cwd(),
): Promise<number> {
  const originalStdout = io.stdout;
  const originalStderr = io.stderr;
  io = { ...io, stdout: (text) => originalStdout(redactConfiguredValues(text, env)), stderr: (text) => originalStderr(redactConfiguredValues(text, env)) };
  const parsed = parseArgs(argv);
  const command = parsed.rest[0];
  if (!command || command === "help" || parsed.flags.help) {
    io.stdout(`${usage()}\n`);
    return command ? 0 : 2;
  }
  const dirs = workspaceDirs(cwd, parsed.workspace, env);
  const serverUrl = env.PI_MESH_SERVER_URL?.trim() || "http://127.0.0.1:7331";
  const fetchImpl = io.fetchImpl ?? fetch;

  if (command === "init") {
    const created: string[] = [];
    for (const directory of [dirs.config, dirs.logs, dirs.assets, dirs.state, join(dirs.assets, "retrospectives")]) {
      if (parsed.dryRun) created.push(directory);
      else {
        mkdirSync(directory, { recursive: true });
        created.push(directory);
      }
    }
    const templateConfig = join(repoRoot, ".kxm", "config");
    if (!parsed.dryRun && existsSync(templateConfig)) cpSync(templateConfig, dirs.config, { recursive: true, force: false, errorOnExist: false });
    print(io, parsed.json, { ok: true, command: "init", created, templates: existsSync(templateConfig) }, `initialized ${dirs.workspace}`);
    return 0;
  }

  if (command === "validate") {
    const file = String(parsed.flags.file || env.PI_MESH_WEBHOOK_WORKFLOWS_FILE || join(dirs.config, "workflows", "v04-dogfood.json"));
    if (!existsSync(file)) {
      print(io, parsed.json, { ok: false, command: "validate", error: "file_not_found" }, `workflow file not found: ${file}`);
      return 1;
    }
    try {
      const raw = readFileSync(file, "utf8");
      const definitions = parseWorkflowDefinitions(raw, env);
      const secretEnvs = definitions.map((definition) => ({
        id: definition.id,
        secretConfigured: Boolean(definition.secret),
        signalSecretConfigured: Boolean(definition.signalSecret),
      }));
      print(io, parsed.json, { ok: true, command: "validate", file, workflows: secretEnvs }, `validated ${definitions.length} workflow(s)`);
      return 0;
    } catch (error) {
      const message = error instanceof Error ? redactSecrets(error.message) : "invalid_workflow";
      print(io, parsed.json, { ok: false, command: "validate", error: message }, message);
      return 1;
    }
  }

  if (command === "status") {
    const health = await hubGet(`${serverUrl}/health`, fetchImpl);
    const ready = await hubGet(`${serverUrl}/ready`, fetchImpl);
    const payload = { ok: health.ok && ready.ok, command: "status", health: health.body, ready: ready.body };
    print(io, parsed.json, payload, `hub health=${health.ok} ready=${ready.ok}`);
    return payload.ok ? 0 : 1;
  }

  if (command === "hub") {
    const extraEnv = { PI_MESH_WORKDIR: dirs.workdir, PI_MESH_WORKSPACE_DIR: dirs.workspace, PI_MESH_CONFIG_DIR: dirs.config, PI_MESH_LOGS_DIR: dirs.logs, PI_MESH_ASSETS_DIR: dirs.assets, PI_MESH_STATE_DIR: dirs.state };
    if (parsed.dryRun) {
      print(io, parsed.json, { ok: true, command: "hub", dryRun: true, workspace: dirs.workspace }, "would start hub");
      return 0;
    }
    return await (io.spawnHub ?? ((launchEnv) => spawnScript("pi-mesh-hub.mjs", launchEnv)))(extraEnv);
  }

  if (command === "worker") {
    const name = typeof parsed.flags.name === "string" ? parsed.flags.name.trim() : env.PI_MESH_AGENT_NAME?.trim();
    const project = typeof parsed.flags.project === "string" ? parsed.flags.project.trim() : env.PI_MESH_PROJECT?.trim();
    const model = typeof parsed.flags.model === "string" ? parsed.flags.model.trim() : env.PI_MESH_WORKER_MODEL?.trim();
    const extraEnv = { PI_MESH_WORKDIR: dirs.workdir, PI_MESH_WORKSPACE_DIR: dirs.workspace, PI_MESH_CONFIG_DIR: dirs.config, PI_MESH_LOGS_DIR: dirs.logs, PI_MESH_ASSETS_DIR: dirs.assets, PI_MESH_STATE_DIR: dirs.state, ...(name ? { PI_MESH_AGENT_NAME: name } : {}), ...(project ? { PI_MESH_PROJECT: project } : {}), ...(model ? { PI_MESH_WORKER_MODEL: model } : {}), ...(parsed.flags["no-continue"] ? { PI_MESH_WORKER_CONTINUE: "false" } : {}) };
    if (parsed.dryRun) {
      print(io, parsed.json, { ok: true, command: "worker", dryRun: true, workspace: dirs.workspace, name: name || "required", project: project || "required", model: model || "provider default", continue: parsed.flags["no-continue"] ? false : true }, "would start worker");
      return 0;
    }
    if (!name || !project) { io.stderr("worker requires --name and --project (or PI_MESH_AGENT_NAME and PI_MESH_PROJECT)\n"); return 2; }
    return await (io.spawnWorker ?? ((launchEnv) => spawnScript("pi-mesh-worker.mjs", launchEnv)))(extraEnv);
  }

  if (command === "stop") {
    const pids = existsSync(dirs.state)
      ? readdirSync(dirs.state).filter((name) => name.endsWith(".pid"))
      : [];
    if (parsed.dryRun) {
      print(io, parsed.json, { ok: true, command: "stop", dryRun: true, pidFiles: pids }, "would signal pid files");
      return 0;
    }
    if (pids.length === 0) {
      print(io, parsed.json, { ok: false, command: "stop", error: "no_pid_files" }, "no hub/worker pid files found");
      return 1;
    }
    const requested: string[] = [];
    const ignored: string[] = [];
    const records = new Map<string, { pid: number; startedAt: string }>();
    for (const file of pids) {
      try {
        const record = JSON.parse(readFileSync(join(dirs.state, file), "utf8")) as { version?: number; pid?: number; role?: string; startedAt?: string; controlFile?: string };
        const expectedControl = file === "hub.pid" ? "hub.stop" : file.startsWith("worker-") ? `${file.slice(0, -4)}.stop` : undefined;
        const expectedRole = file === "hub.pid" ? "hub" : file.startsWith("worker-") ? "worker" : undefined;
        if (record.version !== 1 || !Number.isInteger(record.pid) || record.pid! <= 0 || !record.startedAt || !expectedControl || record.controlFile !== expectedControl || record.role !== expectedRole || !processExists(record.pid!)) { ignored.push(file); continue; }
        writeFileSync(join(dirs.state, record.controlFile), `${JSON.stringify({ startedAt: record.startedAt, requestedAt: new Date().toISOString() })}\n`, { encoding: "utf8", mode: 0o600 });
        requested.push(file); records.set(file, { pid: record.pid!, startedAt: record.startedAt });
      } catch { ignored.push(file); }
    }
    if (requested.length === 0) { print(io, parsed.json, { ok: false, command: "stop", requested, ignored }, "no current managed processes found"); return 1; }
    const waitMs = Math.min(30_000, Math.max(100, Number(parsed.flags["wait-ms"] || 5_000)));
    const deadline = Date.now() + waitMs;
    const stopped = new Set<string>();
    while (Date.now() <= deadline && stopped.size < requested.length) {
      for (const [file, record] of records) {
        try {
          const current = JSON.parse(readFileSync(join(dirs.state, file), "utf8")) as { pid?: number; startedAt?: string };
          if (current.pid !== record.pid || current.startedAt !== record.startedAt || !processExists(record.pid)) stopped.add(file);
        } catch { stopped.add(file); }
      }
      if (stopped.size < requested.length) await (io.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))))(100);
    }
    const timedOut = requested.filter((file) => !stopped.has(file));
    const ok = timedOut.length === 0;
    print(io, parsed.json, { ok, command: "stop", requested, stopped: [...stopped], timedOut, ignored }, ok ? "managed processes stopped" : "stop request timed out");
    return ok ? 0 : 1;
  }

  if (command === "workflow") {
    const action = parsed.rest[1];
    if (action === "start") {
      const definitionId = parsed.rest[2] || env.PI_MESH_WORKFLOW_ID?.trim();
      const secret = env.PI_MESH_WORKFLOW_SECRET?.trim();
      const deliveryId = String(parsed.flags["delivery-id"] || `cli-${randomUUID()}`);
      const event = typeof parsed.flags.event === "string" ? parsed.flags.event : undefined;
      const payloadFlag = typeof parsed.flags.payload === "string" ? parsed.flags.payload : "{}";
      if (!definitionId || !secret) { io.stderr("workflow start requires <definitionId> (or PI_MESH_WORKFLOW_ID) and PI_MESH_WORKFLOW_SECRET\n"); return 2; }
      let payload: Record<string, unknown>;
      try {
        const raw = payloadFlag.startsWith("@") ? readFileSync(resolve(cwd, payloadFlag.slice(1)), "utf8") : payloadFlag;
        const value = JSON.parse(raw) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
        payload = value as Record<string, unknown>;
      } catch { print(io, parsed.json, { ok: false, command: "workflow start", error: "invalid_payload" }, "workflow payload must be a JSON object or @file"); return 2; }
      if (parsed.dryRun) { print(io, parsed.json, { ok: true, command: "workflow start", dryRun: true, definitionId, deliveryId, event }, "would POST a signed workflow webhook"); return 0; }
      try {
        const response = await postWorkflowStart({ serverUrl, definitionId, secret, deliveryId, ...(event ? { event } : {}), payload, fetchImpl });
        print(io, parsed.json, { ok: true, command: "workflow start", definitionId, deliveryId, ...response }, `started workflow ${response.runId ?? "accepted"}`);
        return 0;
      } catch { print(io, parsed.json, { ok: false, command: "workflow start", error: "workflow_start_failed" }, "signed workflow start failed"); return 1; }
    }
    if (action === "list" || action === "get") {
      const dataPath = resolve(dirs.workdir, env.PI_MESH_DATA_PATH?.trim() || join(dirs.state, "mesh.db"));
      const requestedId = action === "get" ? parsed.rest[2] : undefined;
      if (action === "get" && !requestedId) { io.stderr("Usage: pi-mesh workflow get <runId>\n"); return 2; }
      try {
        const snapshot = localWorkflowSnapshot(dataPath, requestedId);
        if (requestedId && snapshot.runs.length === 0) { print(io, parsed.json, { ok: false, command: "workflow get", error: "workflow_not_found" }, "workflow not found"); return 1; }
        const value = action === "get" ? { ok: true, command: "workflow get", run: snapshot.runs[0], journal: snapshot.journal } : { ok: true, command: "workflow list", runs: snapshot.runs };
        print(io, parsed.json, value, action === "get" ? `workflow ${requestedId}` : `${snapshot.runs.length} workflow(s)`);
        return 0;
      } catch { print(io, parsed.json, { ok: false, command: `workflow ${action}`, error: "state_unavailable" }, "local workflow state is unavailable"); return 1; }
    }
    io.stderr(`${usage()}\n`);
    return 2;
  }

  if (command === "signal") {
    const [runId, signalKey, status, summary, ...evidenceArgs] = parsed.rest.slice(1);
    if (!runId || !signalKey || !status || !summary) {
      io.stderr("Usage: pi-mesh signal <runId> <signalKey> <passed|warning|failed> <summary> [<required-key>=<evidence> ...]\n");
      return 2;
    }
    if (status !== "passed" && status !== "warning" && status !== "failed") {
      io.stderr("status must be passed, warning, or failed\n");
      return 2;
    }
    let evidence: WorkflowEvidenceInput;
    try {
      evidence = parseEvidencePairs(evidenceArgs);
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : "invalid evidence"}\n`);
      return 2;
    }
    const definitionId = env.PI_MESH_WORKFLOW_ID?.trim();
    const signalSecret = env.PI_MESH_WORKFLOW_SIGNAL_SECRET?.trim();
    if (!definitionId || !signalSecret) {
      io.stderr("signal requires PI_MESH_WORKFLOW_ID and PI_MESH_WORKFLOW_SIGNAL_SECRET\n");
      return 2;
    }
    if (parsed.dryRun) {
      print(io, parsed.json, { ok: true, command: "signal", runId, signalKey, status, summary, evidence }, "would post signed signal");
      return 0;
    }
    const deliveryId = String(parsed.flags["delivery-id"] || `cli-signal:${randomUUID()}`);
    try {
      const posted = await postWorkflowSignal({
        serverUrl,
        definitionId,
        signalSecret,
        runId,
        signalKey,
        status,
        summary,
        evidence,
        deliveryId,
        fetchImpl,
      });
      print(io, parsed.json, { ok: true, command: "signal", duplicate: posted.duplicate, deliveryId }, "posted signed signal");
      return 0;
    } catch {
      print(io, parsed.json, { ok: false, command: "signal", error: "signal_failed", deliveryId }, "signed signal failed");
      return 1;
    }
  }

  if (command === "github") {
    if (parsed.rest[1] !== "watch") {
      io.stderr(`${usage()}\n`);
      return 2;
    }
    const token = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim();
    const definitionId = env.PI_MESH_WORKFLOW_ID?.trim();
    const signalSecret = env.PI_MESH_WORKFLOW_SIGNAL_SECRET?.trim();
    const runId = String(parsed.flags["run-id"] || "");
    const stageId = String(parsed.flags["stage-id"] || "");
    const signalKey = String(parsed.flags["signal-key"] || "");
    const repo = String(parsed.flags.repo || "");
    const pr = Number(parsed.flags.pr);
    if (!definitionId || !signalSecret || !runId || !stageId || !signalKey || !repo || !Number.isInteger(pr)) {
      io.stderr("github watch requires PI_MESH_WORKFLOW_ID, PI_MESH_WORKFLOW_SIGNAL_SECRET, --run-id, --stage-id, --signal-key, --repo, --pr\n");
      return 2;
    }
    const result = await watchGithubChecks({
      serverUrl,
      definitionId,
      signalSecret,
      runId,
      stageId,
      signalKey,
      repo,
      pr,
      required: typeof parsed.flags.required === "string"
        ? [...new Set(String(parsed.flags.required).split(",").map((name) => name.trim()).filter(Boolean))]
        : [],
      timeoutMs: Number(parsed.flags["timeout-ms"] || 1_800_000),
      intervalMs: Number(parsed.flags["interval-ms"] || 15_000),
      ...(typeof parsed.flags["delivery-id"] === "string" ? { deliveryId: parsed.flags["delivery-id"] } : {}),
      ...(token ? { token } : {}),
      dryRun: parsed.dryRun,
      fetchImpl,
      ...(io.now ? { now: io.now } : {}),
      ...(io.sleep ? { sleep: io.sleep } : {}),
    });
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
    if (JSON.stringify(payload).includes(token ?? "___never___") || Object.keys(env).some((key) => maskEnvName(key) && JSON.stringify(payload).includes(String(env[key])))) {
      print(io, parsed.json, { ok: false, command: "github watch", error: "redaction_failure" }, "refusing to print a payload that contains a secret");
      return 1;
    }
    print(io, parsed.json, payload, result.summary);
    return result.exitCode;
  }

  if (command === "retrospective") {
    if (parsed.rest[1] !== "export") {
      io.stderr(`${usage()}\n`);
      return 2;
    }
    const runId = parsed.rest[2];
    if (!runId) {
      io.stderr("Usage: pi-mesh retrospective export <runId>\n");
      return 2;
    }
    const snapshotFlag = String(parsed.flags.input || "");
    const snapshotPath = snapshotFlag ? resolve(cwd, snapshotFlag) : "";
    let snapshot: { run: WorkflowRun; journal: WorkflowJournalEntry[] };
    try {
      if (snapshotPath) { if (!existsSync(snapshotPath)) throw new Error("snapshot_missing"); snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as typeof snapshot; }
      else { const dataPath = resolve(dirs.workdir, env.PI_MESH_DATA_PATH?.trim() || join(dirs.state, "mesh.db")); const local = localWorkflowSnapshot(dataPath, runId); if (!local.runs[0]) throw new Error("workflow_not_found"); snapshot = { run: local.runs[0], journal: local.journal }; }
      if (snapshot.run.id !== runId) throw new Error("run_id_mismatch");
    } catch (error) { const reason = error instanceof Error ? error.message : "snapshot_invalid"; print(io, parsed.json, { ok: false, command: "retrospective export", error: reason }, "retrospective source is invalid or unavailable"); return 1; }
    const doc = buildRetrospective(snapshot.run, snapshot.journal);
    const outDir = resolve(cwd, String(parsed.flags["out-dir"] || join(dirs.assets, "retrospectives")));
    const assetsRoot = resolve(dirs.assets);
    const assetsPrefix = `${assetsRoot}${process.platform === "win32" ? "\\" : "/"}`;
    if (outDir !== assetsRoot && !outDir.startsWith(assetsPrefix)) { print(io, parsed.json, { ok: false, command: "retrospective export", error: "output_outside_workspace_assets" }, "retrospectives must stay under the workspace assets directory"); return 2; }
    if (parsed.dryRun) {
      print(io, parsed.json, { ok: true, command: "retrospective export", dryRun: true, runId: doc.runId }, `would export ${doc.runId}`);
      return 0;
    }
    const written = writeRetrospective(outDir, doc);
    print(io, parsed.json, { ok: true, command: "retrospective export", ...written, reviewDecision: doc.reviewDecision }, `exported ${written.jsonPath}`);
    return 0;
  }

  if (command === "smoke") {
    if (env.PI_MESH_SMOKE !== "1" && !parsed.flags["real-pi"]) {
      print(io, parsed.json, { ok: true, skipped: true, reason: "PI_MESH_SMOKE is not 1" }, "smoke skipped");
      return 0;
    }
    return await spawnScript("smoke-multi-pi.mjs", { PI_MESH_SMOKE: "1", PI_MESH_WORKDIR: dirs.workdir, PI_MESH_WORKSPACE_DIR: dirs.workspace, PI_MESH_CONFIG_DIR: dirs.config, PI_MESH_LOGS_DIR: dirs.logs, PI_MESH_ASSETS_DIR: dirs.assets, PI_MESH_STATE_DIR: dirs.state });
  }

  io.stderr(`${usage()}\n`);
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await runCli(process.argv.slice(2));
  process.exitCode = code;
}
