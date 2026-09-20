import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { redactSecrets } from "../redact.ts";
import { defaultProjectName } from "../project-name.ts";
import { hasClientHubCredential, resolveClientHubAuthToken } from "../hub-env.ts";
import { agentWorker, type Worker } from "../envelope.ts";
import { MESH_TUI_PANELS, runMeshTui, type MeshTuiPanel } from "../tui.ts";
import { formatSessionBriefText, loadSessionBriefAsync, type SessionHubStatus } from "../session-work.ts";
import {
  HUB_BINDING_SCHEMA,
  HubBindingError,
  hubBindingFile,
  probeHubHealth,
  hubBindingScope,
  readHubBinding,
  removeHubBinding,
  validateHubUrl,
  writeHubBinding,
  type HubHealth,
} from "../hub-binding.ts";
import {
  classifyInstallRoot,
  type InstallProbe,
} from "../kxm-install-kind.ts";
import { kxmUserStateRoot } from "../bindings.ts";
import {
  fetchLatestKxmVersion,
  kxmReleaseAssetName,
  noticeFromVersions,
  readInstalledKxmVersion,
  readUpdateCache,
  writeUpdateCache,
  KxmUpdateConfigError,
  type KxmUpdateConfig,
  type KxmUpdateNotice,
} from "../kxm-update.ts";
import { loadKxmUpdateConfig } from "../kxm-update-config.ts";
import {
  clearSessionTokenFromDisk,
  mintSessionToken,
  parseSessionToken,
  persistSessionTokenToDisk,
  readSessionTokenFromDisk,
  sessionTokenPath,
} from "../commands.ts";
import { createSession, loadNamedWorkers, rosterNames, sessionAssetDirs, workflowAssetDirs, writeSession } from "../session.ts";
import {
  print,
  printWorker,
  hostMode,
  workspaceEnv,
  spawnScript,
  processExists,
  type Runtime,
} from "./types.ts";

export async function hubGet(url: string, fetchImpl: typeof fetch): Promise<{ ok: boolean; status: number; body: unknown }> {
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

export function installProbeFrom(runtime: Runtime): InstallProbe {
  const partial = runtime.io.installProbe ?? {};
  return {
    moduleDir: partial.moduleDir ?? dirname(fileURLToPath(import.meta.url)),
    repoRoot: partial.repoRoot ?? resolve("."),
    homeDir: partial.homeDir ?? homedir(),
    platform: partial.platform ?? process.platform,
    env: partial.env ?? runtime.env,
  };
}

import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { homedir } from "node:os";

export function warnIgnoredProjectUpdateYaml(runtime: Runtime): void {
  const projectFile = join(runtime.dirs.workspace, "update.yaml");
  if (!existsSync(projectFile)) return;
  const userFile = join(kxmUserStateRoot({ env: runtime.env }), "update.yaml");
  runtime.io.stderr(`kxm: ignoring .kxm/update.yaml in ${runtime.dirs.workdir}; update settings are read only from ${userFile}\n`);
}

export async function refreshKxmUpdateNotice(runtime: Runtime, config?: KxmUpdateConfig): Promise<KxmUpdateNotice> {
  const resolved = config ?? loadKxmUpdateConfig(runtime.env);
  const current = readInstalledKxmVersion(resolve("."));
  const fetched = await fetchLatestKxmVersion(resolved.source, runtime.env, runtime.fetchImpl);
  const notice = noticeFromVersions(current, fetched.latest, resolved, fetched.error, fetched.asset);
  writeUpdateCache(runtime.dirs.state, notice);
  return notice;
}

export async function cmdStatus(runtime: Runtime): Promise<number> {
  const health = await hubGet(`${runtime.serverUrl}/health`, runtime.fetchImpl);
  const ready = await hubGet(`${runtime.serverUrl}/ready`, runtime.fetchImpl);
  // Scope on the status line deliberately: "attached across a network" and "attached on
  // this box" are otherwise indistinguishable, and only one of them ships a token.
  // Scope is a property of the URL actually contacted, not of whichever file the
  // binding came from: KXM_SERVER_URL overrides the binding, and labelling the binding
  // while probing an override would report "loopback" about a remote request.
  const effectiveScope = hubBindingScope(runtime.serverUrl);
  const overridden = Boolean(runtime.boundHubUrl && runtime.boundHubUrl !== runtime.serverUrl);
  const payload = {
    ok: health.ok && ready.ok,
    command: "hub view",
    target: { url: runtime.serverUrl, scope: effectiveScope, ...(overridden ? { source: "env" } : {}) },
    health: health.body,
    ready: ready.body,
  };
  print(runtime.io, runtime.json, payload,
    `hub health=${health.ok} ready=${ready.ok} · ${effectiveScope} hub${overridden ? " (KXM_SERVER_URL)" : ""}`);
  return payload.ok ? 0 : 1;
}

export async function cmdDash(runtime: Runtime, options: { screen?: string | undefined } = {}): Promise<number> {
  const requested = options.screen?.trim();
  if (requested && !(MESH_TUI_PANELS as readonly string[]).includes(requested)) {
    print(runtime.io, runtime.json, { ok: false, command: "dash", error: "unknown_screen" }, `unknown screen ${requested}; use agents, tasks, workflows, plans, inbox, procs, or spend`);
    return 2;
  }
  const screen = requested as MeshTuiPanel | undefined;
  const dataPath = resolve(runtime.dirs.workdir, runtime.env.KXM_DATA_PATH?.trim() || join(runtime.dirs.state, "kxm.db"));
  if (runtime.dryRun) {
    print(runtime.io, runtime.json, {
      ok: true,
      command: "dash",
      dryRun: true,
      serverUrl: runtime.serverUrl,
      transport: "sse",
      ...(screen ? { screen } : {}),
    }, "would start kxm dash");
    return 0;
  }
  if (runtime.json) {
    runtime.io.stderr("kxm dash does not support --json; use kxm hub view\n");
    return 2;
  }
  const project = defaultProjectName(runtime.dirs.workdir, runtime.env) || "project";
  const authToken = resolveClientHubAuthToken(runtime.env, project);
  return await runMeshTui({
    serverUrl: runtime.serverUrl,
    dataPath,
    stateDir: runtime.dirs.state,
    project,
    env: runtime.env,
    ...(authToken ? { authToken } : {}),
    ...(screen ? { screen } : {}),
    fetchImpl: runtime.fetchImpl,
    stdout: runtime.io.stdout,
    stdin: process.stdin,
    isTty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  });
}

export async function cmdHub(runtime: Runtime): Promise<number> {
  let refresh: Promise<unknown> | undefined;
  if (!runtime.dryRun) {
    const probe = installProbeFrom(runtime);
    if (classifyInstallRoot(probe).kind !== "source") {
      warnIgnoredProjectUpdateYaml(runtime);
      const cached = readUpdateCache(runtime.dirs.state);
      if (cached?.available) runtime.io.stderr(`${cached.message}\n`);
      let config: KxmUpdateConfig | undefined;
      try {
        config = loadKxmUpdateConfig(runtime.env);
      } catch (error) {
        if (error instanceof KxmUpdateConfigError) {
          const yamlPath = join(kxmUserStateRoot({ env: runtime.env }), "update.yaml");
          runtime.io.stderr(`kxm: ${error.message}; update check skipped; fix or remove ${yamlPath}\n`);
        } else {
          throw error;
        }
      }
      if (config) {
        refresh = refreshKxmUpdateNotice(runtime, config).then((notice) => {
          if (notice.available && !cached?.available) runtime.io.stderr(`${notice.message}\n`);
        }).catch(() => undefined);
      }
    }
  }
  const extraEnv = workspaceEnv(runtime);
  if (runtime.dryRun) {
    print(runtime.io, runtime.json, { ok: true, command: "hub start", dryRun: true, workspace: runtime.dirs.workspace }, "would start hub");
    return 0;
  }
  const code = await (runtime.io.spawnHub ?? ((launchEnv) => spawnScript("kxm-hub.mjs", launchEnv)))(extraEnv);
  if (refresh) await refresh;
  return code;
}

export function formatHubBindHealth(health: HubHealth): string {
  if (health === "on") return "health=on";
  if (health === "off") return "health=off (nothing answered; run kxm hub start)";
  return "health=unknown (no reply within 300 ms)";
}

/** Kept in one place so the JSON payload and the prose line cannot drift apart. */
const HUB_BIND_UNAUTHENTICATED_HINT =
  "export KXM_AUTH_TOKEN (or point KXM_STATE_HOME at the hub-env record that already holds one), then re-run; the hub itself requires a token beyond loopback";

export async function cmdHubBind(runtime: Runtime, rawUrl: string): Promise<number> {
  let url: string;
  try {
    url = validateHubUrl(rawUrl);
  } catch (error) {
    if (error instanceof HubBindingError) {
      print(
        runtime.io,
        runtime.json,
        { ok: false, command: "hub bind", error: "hub_url_invalid" },
        "hub bind needs an http or https URL without credentials, query, or fragment",
      );
      return 2;
    }
    throw error;
  }
  const scope = hubBindingScope(url);
  // A remote binding puts a bearer on a network path, so refuse it when this machine has
  // nothing to authenticate with. A stored-but-unusable URL reads later like a network
  // fault and the operator debugs the wrong thing. Loopback is unaffected.
  // The project that will actually authenticate: a record holding only another
  // project's token cannot authorise this one.
  const bindProject = defaultProjectName(runtime.dirs.workdir, runtime.env) || "project";
  let credentialReady = false;
  try {
    credentialReady = hasClientHubCredential(runtime.env, bindProject);
  } catch (error) {
    // A malformed record is its own readable failure. Letting it throw past here would
    // print neither the JSON payload nor the prose line an operator could act on.
    print(
      runtime.io,
      runtime.json,
      {
        ok: false,
        command: "hub bind",
        error: "hub_credential_unreadable",
        url,
        scope,
        nextAction: "repair_hub_env_record",
        hint: `${error instanceof Error ? error.message : String(error)}; no binding was written`,
      },
      `cannot read the hub credential: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
  if (scope === "remote" && !credentialReady) {
    print(
      runtime.io,
      runtime.json,
      {
        ok: false,
        command: "hub bind",
        error: "hub_bind_unauthenticated",
        url,
        scope,
        project: bindProject,
        // The hint is in the payload, not only in the prose line: under --json the prose
        // is suppressed, and a machine-readable refusal that names no next step is the
        // one kind of error that gets debugged by reading source.
        nextAction: "export_kxm_auth_token",
        hint: `${HUB_BIND_UNAUTHENTICATED_HINT} (needs a token for project ${bindProject})`,
      },
      `refusing to bind remote hub ${url} with no credential for project ${bindProject}; ${HUB_BIND_UNAUTHENTICATED_HINT}`,
    );
    return 2;
  }
  const file = hubBindingFile(runtime.env);
  if (runtime.dryRun) {
    print(runtime.io, runtime.json, { ok: true, command: "hub bind", dryRun: true, url, scope, file }, `would bind hub ${url} (${scope})`);
    return 0;
  }
  writeHubBinding({ schema: HUB_BINDING_SCHEMA, url, boundAt: new Date().toISOString() }, runtime.env);
  const { health, probeMs } = await probeHubHealth(url, runtime.fetchImpl);
  print(runtime.io, runtime.json, { ok: true, command: "hub bind", url, scope, file, health, probeMs },
    `bound hub ${url} · ${scope} · ${formatHubBindHealth(health)}${scope === "remote" ? " · token leaves this machine" : ""}`);
  return 0;
}

export async function cmdHubUnbind(runtime: Runtime): Promise<number> {
  const file = hubBindingFile(runtime.env);
  if (runtime.dryRun) {
    print(
      runtime.io,
      runtime.json,
      { ok: true, command: "hub unbind", dryRun: true, ...(runtime.boundHubUrl ? { url: runtime.boundHubUrl } : {}), file },
      `would unbind hub${runtime.boundHubUrl ? ` ${runtime.boundHubUrl}` : ""}`,
    );
    return 0;
  }
  let url: string | undefined;
  let malformed = false;
  try {
    url = readHubBinding(runtime.env)?.url;
  } catch (error) {
    if (error instanceof HubBindingError) malformed = true;
    else throw error;
  }
  if (!malformed && !url) {
    print(runtime.io, runtime.json, { ok: false, command: "hub unbind", error: "hub_not_bound" }, `no hub binding at ${file}`);
    return 1;
  }
  removeHubBinding(runtime.env);
  if (malformed) {
    print(runtime.io, runtime.json, { ok: true, command: "hub unbind", file }, "unbound hub (record was malformed)");
    return 0;
  }
  print(runtime.io, runtime.json, { ok: true, command: "hub unbind", url, file }, `unbound hub ${url}`);
  return 0;
}

export async function cmdWorker(runtime: Runtime, options: {
  name?: string | undefined;
  project?: string | undefined;
  model?: string | undefined;
  fallbackModels?: string | undefined;
  tools?: string | undefined;
  sessionIsolation?: string | undefined;
  continue?: boolean | undefined;
  freshStart?: boolean | undefined;
}): Promise<number> {
  const name = options.name?.trim() || runtime.env.KXM_AGENT_NAME?.trim();
  const project = options.project?.trim() || runtime.env.KXM_PROJECT?.trim();
  const model = options.model?.trim() || runtime.env.KXM_WORKER_MODEL?.trim();
  const fallbackModels = options.fallbackModels?.trim() || runtime.env.KXM_WORKER_FALLBACK_MODELS?.trim();
  const tools = options.tools?.trim() || runtime.env.KXM_WORKER_TOOLS?.trim();
  const sessionIsolation = options.sessionIsolation?.trim() || runtime.env.KXM_WORKER_SESSION_ISOLATION?.trim() || "off";
  if (sessionIsolation !== "workflow" && sessionIsolation !== "off") {
    runtime.io.stderr("worker --session-isolation must be workflow or off\n");
    return 2;
  }
  const extraEnv = {
    ...workspaceEnv(runtime),
    ...(name ? { KXM_AGENT_NAME: name } : {}),
    ...(project ? { KXM_PROJECT: project } : {}),
    ...(model ? { KXM_WORKER_MODEL: model } : {}),
    ...(fallbackModels ? { KXM_WORKER_FALLBACK_MODELS: fallbackModels } : {}),
    ...(tools ? { KXM_WORKER_TOOLS: tools } : {}),
    KXM_WORKER_SESSION_ISOLATION: sessionIsolation,
    ...(options.continue === false ? { KXM_WORKER_CONTINUE: "false" } : {}),
    ...(options.freshStart ? { KXM_WORKER_INITIAL_CONTINUE: "false" } : {}),
  };
  if (runtime.dryRun) {
    printWorker(runtime, agentWorker({
      name: name || "required",
      project: project || "required",
      ...(model ? { model } : {}),
    }), {
      ok: true,
      command: "worker",
      dryRun: true,
      workspace: runtime.dirs.workspace,
      name: name || "required",
      project: project || "required",
      model: model || "provider default",
      fallbackModels: fallbackModels || "none",
      tools: tools || "Pi defaults",
      sessionIsolation,
      continue: options.continue !== false,
      freshStart: Boolean(options.freshStart),
    }, "would start worker");
    return 0;
  }
  if (!name || !project) {
    runtime.io.stderr("worker requires --name and --project (or KXM_AGENT_NAME and KXM_PROJECT)\n");
    return 2;
  }
  return await (runtime.io.spawnWorker ?? ((launchEnv) => spawnScript("kxm-worker.mjs", launchEnv)))(extraEnv);
}

export async function cmdStop(runtime: Runtime, waitMsFlag?: string | undefined): Promise<number> {
  const pids = existsSync(runtime.dirs.state)
    ? readdirSync(runtime.dirs.state).filter((name) => name.endsWith(".pid"))
    : [];
  if (runtime.dryRun) {
    print(runtime.io, runtime.json, { ok: true, command: "stop", dryRun: true, pidFiles: pids }, "would signal pid files");
    return 0;
  }
  if (pids.length === 0) {
    print(runtime.io, runtime.json, { ok: false, command: "stop", error: "no_pid_files" }, "no hub/worker pid files found");
    return 1;
  }
  const requested: string[] = [];
  const ignored: string[] = [];
  const records = new Map<string, { pid: number; startedAt: string; generation?: string }>();
  const orphans: string[] = [];
  for (const file of pids) {
    try {
      const record = JSON.parse(readFileSync(join(runtime.dirs.state, file), "utf8")) as { version?: number; pid?: number; serverPid?: number; role?: string; startedAt?: string; generation?: string; controlFile?: string };
      const expectedControl = file === "hub.pid" ? "hub.stop" : file.startsWith("worker-") ? `${file.slice(0, -4)}.stop` : undefined;
      const expectedRole = file === "hub.pid" ? "hub" : file.startsWith("worker-") ? "worker" : undefined;
      if (record.version !== 1 || !Number.isInteger(record.pid) || record.pid! <= 0 || !record.startedAt || !expectedControl || record.controlFile !== expectedControl || record.role !== expectedRole) { ignored.push(file); continue; }
      if (!processExists(record.pid!)) {
        if (file === "hub.pid" && Number.isInteger(record.serverPid) && record.serverPid! > 0 && record.serverPid !== record.pid && processExists(record.serverPid!)) {
          try { process.kill(record.serverPid!, "SIGTERM"); } catch { /* racing exit */ }
          orphans.push(file);
          records.set(file, { pid: record.pid!, startedAt: record.startedAt, ...(record.generation ? { generation: record.generation } : {}) });
          continue;
        }
        ignored.push(file);
        continue;
      }
      writeFileSync(join(runtime.dirs.state, record.controlFile!), `${JSON.stringify({ startedAt: record.startedAt, ...(record.generation ? { generation: record.generation } : {}), requestedAt: new Date().toISOString() })}\n`, { encoding: "utf8", mode: 0o600 });
      requested.push(file); records.set(file, { pid: record.pid!, startedAt: record.startedAt, ...(record.generation ? { generation: record.generation } : {}) });
    } catch { ignored.push(file); }
  }
  if (requested.length === 0 && orphans.length === 0) { print(runtime.io, runtime.json, { ok: false, command: "stop", requested, ignored }, "no current managed processes found"); return 1; }
  const waitMs = Math.min(30_000, Math.max(100, Number(waitMsFlag || 5_000)));
  const deadline = Date.now() + waitMs;
  const stopped = new Set<string>();
  while (Date.now() <= deadline && stopped.size < requested.length) {
    for (const [file, record] of records) {
      try {
        const current = JSON.parse(readFileSync(join(runtime.dirs.state, file), "utf8")) as { pid?: number; startedAt?: string; generation?: string };
        if (current.pid !== record.pid || current.startedAt !== record.startedAt || current.generation !== record.generation || !processExists(record.pid)) stopped.add(file);
      } catch { stopped.add(file); }
    }
    if (stopped.size < requested.length) await (runtime.io.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))))(100);
  }
  const timedOut = requested.filter((file) => !stopped.has(file));
  const deadlineOrphans = Date.now() + Math.min(10_000, waitMs);
  for (const file of orphans) {
    while (Date.now() <= deadlineOrphans) {
      try {
        const current = JSON.parse(readFileSync(join(runtime.dirs.state, file), "utf8")) as { pid?: number; serverPid?: number };
        if (!Number.isInteger(current.serverPid) || !processExists(current.serverPid!)) break;
      } catch { break; }
      await (runtime.io.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))))(100);
    }
    try {
      const current = JSON.parse(readFileSync(join(runtime.dirs.state, file), "utf8")) as { pid?: number; serverPid?: number };
      if (Number.isInteger(current.serverPid) && processExists(current.serverPid!)) {
        try { process.kill(current.serverPid!, "SIGKILL"); } catch { /* racing exit */ }
      }
      rmSync(join(runtime.dirs.state, file), { force: true });
    } catch { /* claim already replaced or removed */ }
    stopped.add(file);
  }
  const ok = timedOut.length === 0;
  print(runtime.io, runtime.json, { ok, command: "stop", requested, stopped: [...stopped], timedOut, ...(orphans.length ? { orphans } : {}), ignored }, ok ? "managed processes stopped" : "stop request timed out");
  return ok ? 0 : 1;
}

export async function cmdSessionStatus(runtime: Runtime): Promise<number> {
  const stateDir = runtime.dirs.state;
  const names = existsSync(stateDir) ? readdirSync(stateDir) : [];
  const claims = [];
  for (const file of names.filter((name) => name.endsWith(".pid"))) {
    try {
      const record = JSON.parse(readFileSync(join(stateDir, file), "utf8")) as { pid?: number; role?: string; startedAt?: string; generation?: string };
      claims.push({
        file,
        role: record.role,
        pid: record.pid,
        startedAt: record.startedAt,
        live: Number.isInteger(record.pid) && record.pid! > 0 && processExists(record.pid!),
      });
    } catch {
      claims.push({ file, live: false, error: "invalid_pid_record" });
    }
  }
  const recoveries = [];
  for (const file of names.filter((name) => name.startsWith("worker-recovery-") && name.endsWith(".json"))) {
    try {
      const envelope = JSON.parse(readFileSync(join(stateDir, file), "utf8")) as {
        reason?: string;
        agentName?: string;
        project?: string;
        createdAt?: string;
        runId?: string | null;
        stageId?: string | null;
        freshSession?: boolean;
      };
      recoveries.push({
        file,
        reason: envelope.reason,
        agentName: envelope.agentName,
        project: envelope.project,
        createdAt: envelope.createdAt,
        runId: envelope.runId ?? undefined,
        stageId: envelope.stageId ?? undefined,
        freshSession: envelope.freshSession === true,
      });
    } catch {
      recoveries.push({ file, error: "invalid_recovery_envelope" });
    }
  }
  print(
    runtime.io,
    runtime.json,
    { ok: true, command: "session status", claims, recoveries },
    `${claims.length} session claim(s), ${recoveries.length} recovery envelope(s)`,
  );
  return 0;
}

export async function cmdAuthToken(runtime: Runtime, options: { status?: boolean | undefined; clear?: boolean | undefined; issue?: boolean | undefined } = {}): Promise<number> {
  if (options.clear) {
    const cleared = clearSessionTokenFromDisk({ userConfigDir: runtime.env.KXM_USER_CONFIG_DIR });
    print(
      runtime.io,
      runtime.json,
      { ok: true, command: "auth token", cleared },
      cleared ? "Session token cleared from disk." : "No session token file found to clear.",
    );
    return 0;
  }

  if (options.status) {
    const fromEnv = runtime.env.KXM_SESSION_TOKEN?.trim();
    if (fromEnv) {
      const parsed = parseSessionToken(fromEnv);
      print(
        runtime.io,
        runtime.json,
        {
          ok: true,
          command: "auth token",
          source: "env",
          valid: Boolean(parsed),
          ...(parsed ? { sessionId: parsed.sessionId, issuedAt: parsed.issuedAt, expiresAt: parsed.expiresAt } : {}),
        },
        parsed ? `Active session token from env (session=${parsed.sessionId})` : "Session token in env is invalid or expired",
      );
      return parsed ? 0 : 1;
    }

    const disk = readSessionTokenFromDisk({ userConfigDir: runtime.env.KXM_USER_CONFIG_DIR });
    if (disk) {
      print(
        runtime.io,
        runtime.json,
        {
          ok: true,
          command: "auth token",
          source: "disk",
          valid: true,
          sessionId: disk.payload.sessionId,
          issuedAt: disk.payload.issuedAt,
          expiresAt: disk.payload.expiresAt,
          path: sessionTokenPath(runtime.env.KXM_USER_CONFIG_DIR),
        },
        `Active session token on disk (session=${disk.payload.sessionId}, expires=${disk.payload.expiresAt ?? "never"})`,
      );
      return 0;
    }

    print(
      runtime.io,
      runtime.json,
      { ok: false, command: "auth token", error: "no_token", message: "No active session token found in env or disk" },
      "No active session token found in env or disk",
    );
    return 1;
  }

  let token: string;
  if (options.issue) {
    token = mintSessionToken({ preset: "operator" });
    persistSessionTokenToDisk(token, { userConfigDir: runtime.env.KXM_USER_CONFIG_DIR });
  } else {
    const existing = readSessionTokenFromDisk({ userConfigDir: runtime.env.KXM_USER_CONFIG_DIR });
    if (existing) {
      token = existing.token;
    } else {
      token = mintSessionToken({ preset: "operator" });
      persistSessionTokenToDisk(token, { userConfigDir: runtime.env.KXM_USER_CONFIG_DIR });
    }
  }

  print(runtime.io, runtime.json, { ok: true, command: "auth token", token }, token);
  return 0;
}

export async function cmdSessionBrief(runtime: Runtime, options: { status?: boolean | undefined; token?: boolean | undefined } = {}): Promise<number> {
  const existing = readSessionTokenFromDisk({ userConfigDir: runtime.env.KXM_USER_CONFIG_DIR });
  const sessionToken = existing ? existing.token : mintSessionToken({ preset: "operator" });
  if (!existing) {
    persistSessionTokenToDisk(sessionToken, { userConfigDir: runtime.env.KXM_USER_CONFIG_DIR });
  }
  if (options.token) {
    print(runtime.io, runtime.json, { ok: true, command: "session brief", sessionToken }, sessionToken);
    return 0;
  }

  const dataPath = resolve(runtime.dirs.workdir, runtime.env.KXM_DATA_PATH?.trim() || join(runtime.dirs.state, "kxm.db"));
  const env = {
    ...runtime.env,
    KXM_STATE_DIR: runtime.dirs.state,
    KXM_DATA_PATH: runtime.env.KXM_DATA_PATH?.trim() || dataPath,
  };

  let hub: SessionHubStatus | undefined;
  const targetUrl = runtime.env.KXM_SERVER_URL?.trim() || runtime.boundHubUrl || readHubBinding(runtime.env)?.url;
  if (targetUrl) {
    const { health } = await probeHubHealth(targetUrl, runtime.fetchImpl, 300);
    hub = {
      state: health,
      evidence: health === "unknown" ? "timeout" : "probed",
      online: health === "on",
      url: targetUrl,
      scope: hubBindingScope(targetUrl),
    };
  } else {
    hub = { state: "off", evidence: "unconfigured", online: false };
  }

  const brief = await loadSessionBriefAsync(runtime.dirs.workdir, env, undefined, hub, {
    fetchImpl: runtime.fetchImpl,
    sessionToken,
  });

  if (options.status) {
    print(runtime.io, runtime.json, brief, brief.statusLine);
    return 0;
  }
  print(
    runtime.io,
    runtime.json,
    brief,
    `${formatSessionBriefText(brief)}\n\nSession token: ${sessionToken}\n`,
  );
  return 0;
}

export async function cmdSessionStart(runtime: Runtime, options: { id?: string | undefined; workflow?: string | undefined; mix?: string | undefined }): Promise<number> {
  const id = options.id?.trim() || `session_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const workflowId = options.workflow?.trim();
  const mix = options.mix?.trim();
  if (workflowId && mix) {
    runtime.io.stderr("session start takes --workflow or --mix, not both\n");
    return 2;
  }
  if (!workflowId && !mix) {
    runtime.io.stderr("session start requires --workflow <id> or --mix <agent,gate,...>\n");
    return 2;
  }
  const project = runtime.env.KXM_PROJECT?.trim();
  let workers: Worker[];
  try {
    const names = mix
      ? mix.split(",").map((name) => name.trim()).filter(Boolean)
      : rosterNames(runtime.dirs.config);
    workers = loadNamedWorkers(runtime.dirs.config, names, project);
  } catch (error) {
    const errorName = error && typeof error === "object" && "name" in error ? String(error.name) : "";
    if (errorName !== "SessionConfigError") throw error;
    const message = error instanceof Error ? redactSecrets(error.message) : "invalid session configuration";
    runtime.io.stderr(`${message}\n`);
    return 2;
  }
  const session = createSession({
    id,
    host: hostMode(runtime),
    mode: workflowId ? "workflow" : "mix",
    workers,
    assetsDir: runtime.dirs.assets,
    ...(workflowId ? { workflowId } : {}),
  });
  const created = [
    ...sessionAssetDirs(runtime.dirs.assets, session.id),
    ...(workflowId ? workflowAssetDirs(runtime.dirs.assets, workflowId) : []),
  ];
  if (!runtime.dryRun) {
    for (const directory of created) mkdirSync(directory, { recursive: true });
    writeSession(runtime.dirs.assets, session);
  }
  print(runtime.io, runtime.json, {
    ok: true,
    command: "session start",
    dryRun: runtime.dryRun || undefined,
    session,
    created,
  }, `session ${session.id} (${session.mode})`);
  return 0;
}
