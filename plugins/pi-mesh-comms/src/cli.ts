import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflowDefinitions } from "./workflow.ts";
import { postWorkflowSignal, watchGithubChecks } from "./github-watch.ts";
import { buildRetrospective, writeRetrospective } from "./retrospective.ts";
import { redactSecrets } from "./redact.ts";
import type { WorkflowJournalEntry, WorkflowRun } from "./workflow.ts";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  spawnHub?: () => number | Promise<number>;
  spawnWorker?: () => number | Promise<number>;
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
    "Commands: init | validate | status | hub | worker | stop | workflow list | workflow get <runId>",
    "          workflow start | signal | github watch | retrospective export <runId> | smoke",
  ].join("\n");
}

function print(io: CliIo, jsonMode: boolean, payload: Record<string, unknown>, text: string): void {
  io.stdout(jsonMode ? `${JSON.stringify(payload)}\n` : `${text}\n`);
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

async function hubGet(url: string, fetchImpl: typeof fetch): Promise<{ ok: boolean; status: number; body: unknown }> {
  try {
    const response = await fetchImpl(url);
    const text = await response.text();
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

export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: CliIo = { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) },
  cwd = process.cwd(),
): Promise<number> {
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
    print(io, parsed.json, { ok: true, command: "init", created }, `initialized ${dirs.workspace}`);
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
    if (parsed.dryRun) {
      print(io, parsed.json, { ok: true, command: "hub", dryRun: true }, "would start hub");
      return 0;
    }
    return await (io.spawnHub ?? (() => spawnScript("pi-mesh-hub.mjs")))();
  }

  if (command === "worker") {
    if (parsed.dryRun) {
      print(io, parsed.json, { ok: true, command: "worker", dryRun: true, continue: parsed.flags["no-continue"] ? false : true }, "would start worker");
      return 0;
    }
    const extraEnv = parsed.flags["no-continue"] ? { PI_MESH_WORKER_CONTINUE: "false" } : {};
    return await (io.spawnWorker ?? (() => spawnScript("pi-mesh-worker.mjs", extraEnv)))();
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
    for (const file of pids) {
      const pid = Number(readFileSync(join(dirs.state, file), "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Stale pid files are ignored.
        }
      }
    }
    print(io, parsed.json, { ok: true, command: "stop", pidFiles: pids }, "signaled local hub/worker pid files");
    return 0;
  }

  if (command === "workflow") {
    const action = parsed.rest[1];
    if (action === "start") {
      if (!parsed.dryRun) {
        print(io, parsed.json, { ok: false, command: "workflow start", error: "live_start_rejected" }, "live workflow start is rejected; use signed webhook ingress or --dry-run");
        return 2;
      }
      print(io, parsed.json, { ok: true, command: "workflow start", dryRun: true }, "would POST a signed webhook to /v1/webhooks/<definitionId>");
      return 0;
    }
    if (action === "list" || action === "get") {
      print(io, parsed.json, { ok: false, command: `workflow ${action}`, error: "coordinator_session_required" }, "workflow list/get requires the assigned coordinator session");
      return 3;
    }
    io.stderr(`${usage()}\n`);
    return 2;
  }

  if (command === "signal") {
    const [runId, signalKey, status, summary, ...evidence] = parsed.rest.slice(1);
    if (!runId || !signalKey || !status || !summary) {
      io.stderr("Usage: pi-mesh signal <runId> <signalKey> <passed|warning|failed> <summary> [evidence...]\n");
      return 2;
    }
    if (status !== "passed" && status !== "warning" && status !== "failed") {
      io.stderr("status must be passed, warning, or failed\n");
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
        deliveryId: String(parsed.flags["delivery-id"] || `cli-signal:${runId}:${signalKey}`),
        fetchImpl,
      });
      print(io, parsed.json, { ok: true, command: "signal", duplicate: posted.duplicate }, "posted signed signal");
      return 0;
    } catch {
      print(io, parsed.json, { ok: false, command: "signal", error: "signal_failed" }, "signed signal failed");
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
    const signalKey = String(parsed.flags["signal-key"] || "");
    const repo = String(parsed.flags.repo || "");
    const pr = Number(parsed.flags.pr);
    if (!definitionId || !signalSecret || !runId || !signalKey || !repo || !Number.isInteger(pr)) {
      io.stderr("github watch requires PI_MESH_WORKFLOW_ID, PI_MESH_WORKFLOW_SIGNAL_SECRET, --run-id, --signal-key, --repo, --pr\n");
      return 2;
    }
    const result = await watchGithubChecks({
      serverUrl,
      definitionId,
      signalSecret,
      runId,
      signalKey,
      repo,
      pr,
      required: typeof parsed.flags.required === "string" ? String(parsed.flags.required).split(",") : [],
      timeoutMs: Number(parsed.flags["timeout-ms"] || 1_800_000),
      intervalMs: Number(parsed.flags["interval-ms"] || 15_000),
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
    const snapshotPath = String(parsed.flags.input || "");
    if (!snapshotPath || !existsSync(snapshotPath)) {
      print(io, parsed.json, { ok: false, command: "retrospective export", error: "snapshot_required" }, "retrospective export requires --input <run-snapshot.json> in v0.4");
      return 1;
    }
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as { run: WorkflowRun; journal: WorkflowJournalEntry[] };
    const doc = buildRetrospective(snapshot.run, snapshot.journal);
    const outDir = String(parsed.flags["out-dir"] || join(dirs.assets, "retrospectives"));
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
    print(io, parsed.json, { ok: true, skipped: true, reason: "real Pi credentials or binary unavailable in this command" }, "smoke skipped");
    return 0;
  }

  io.stderr(`${usage()}\n`);
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await runCli(process.argv.slice(2));
  process.exitCode = code;
}

