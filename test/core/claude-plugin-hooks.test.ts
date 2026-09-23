import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mintSessionToken, persistSessionTokenToDisk } from "../../plugins/kxm/src/commands.ts";
import { removeTempDir } from "../helpers.ts";
import { isolatedMcpEnv } from "../helpers/mcp-spawn.ts";

const PLUGIN_DIR = resolve("plugins/kxm");
const MANIFEST_PATH = join(PLUGIN_DIR, ".claude-plugin", "plugin.json");
const { STATIC_GENERATED_ARTIFACTS } = await import(
  pathToFileURL(resolve("scripts/check-generated.mjs")).href,
) as { STATIC_GENERATED_ARTIFACTS: readonly string[] };

interface HookHandler {
  type: string;
  command?: string;
  args?: string[];
  timeout?: number;
  server?: string;
  tool?: string;
}

interface HookResult {
  status: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

interface Sandbox {
  root: string;
  home: string;
  stateHome: string;
  configDir: string;
  project: string;
}

function readManifestHooks(manifestPath = MANIFEST_PATH): Record<string, Array<{ matcher?: string; hooks: HookHandler[] }>> {
  return (JSON.parse(readFileSync(manifestPath, "utf8")) as { hooks: Record<string, Array<{ matcher?: string; hooks: HookHandler[] }>> }).hooks;
}

function sessionStartCommand(pluginRoot = PLUGIN_DIR): { command: string; args: string[] } {
  const handler = readManifestHooks(join(pluginRoot, ".claude-plugin", "plugin.json")).SessionStart?.[0]?.hooks[0];
  assert.ok(handler?.command && handler.args, "SessionStart hook must be an exec-form command");
  return { command: handler.command, args: handler.args.map((arg) => arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot)) };
}

function sandbox(prefix: string, withKxm = true): Sandbox {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const box = {
    root,
    home: join(root, "home"),
    stateHome: join(root, "state"),
    configDir: join(root, "config"),
    project: join(root, "project"),
  };
  for (const dir of [box.home, box.stateHome, box.configDir, box.project]) mkdirSync(dir, { recursive: true });
  if (withKxm) mkdirSync(join(box.project, ".kxm"), { recursive: true });
  return box;
}

/** Every hook spawn gets its own HOME, state and config, a hub URL nothing
 * listens on unless the test serves /health, and no inherited session or
 * attempt token, plugin option, or project override. */
function hookEnv(box: Sandbox, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE_PLUGIN_")) delete env[key];
  }
  for (const key of ["KXM_SESSION_TOKEN", "KXM_ATTEMPT_TOKEN", "KXM_PROJECT", "KXM_STATE_DIR", "KXM_DATA_PATH", "CLAUDE_PROJECT_DIR"]) delete env[key];
  return {
    ...env,
    HOME: box.home,
    KXM_STATE_HOME: box.stateHome,
    KXM_USER_CONFIG_DIR: box.configDir,
    XDG_CONFIG_HOME: join(box.home, ".config"),
    XDG_STATE_HOME: join(box.home, ".local", "state"),
    CLAUDE_PROJECT_DIR: box.project,
    CLAUDE_PLUGIN_OPTION_SERVER_URL: "http://127.0.0.1:1",
    ...extra,
  };
}

function runHook(box: Sandbox, env: NodeJS.ProcessEnv, pluginRoot = PLUGIN_DIR, stdin = "{}"): Promise<HookResult> {
  const { command, args } = sessionStartCommand(pluginRoot);
  assert.equal(command, "node");
  return new Promise((resolveResult, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, args, { cwd: box.root, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.once("error", reject);
    child.once("close", (status) => {
      clearTimeout(timer);
      resolveResult({ status, stdout, stderr, elapsedMs: Date.now() - started });
    });
    child.stdin.end(stdin);
  });
}

function additionalContext(result: HookResult): string {
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: unknown } };
  assert.equal(parsed.hookSpecificOutput?.hookEventName, "SessionStart");
  assert.equal(typeof parsed.hookSpecificOutput?.additionalContext, "string");
  return parsed.hookSpecificOutput!.additionalContext as string;
}

/** Status sections carry no blank line; the memory brief follows the first one. */
function statusSections(context: string): string {
  return context.split("\n\n")[0] ?? "";
}

function treeListing(...roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(`${path} ${statSync(path).size} ${statSync(path).mtimeMs}`);
    }
  };
  for (const root of roots) if (existsSync(root)) walk(root);
  return out.sort();
}

function seedLegacyDb(project: string, rows: { runs?: object[]; messages?: object[]; journal?: object[] }): void {
  const stateDir = join(project, ".kxm", "state");
  mkdirSync(stateDir, { recursive: true });
  const database = new DatabaseSync(join(stateDir, "kxm.db"));
  try {
    database.exec([
      "CREATE TABLE agents (record TEXT NOT NULL);",
      "CREATE TABLE messages (record TEXT NOT NULL);",
      "CREATE TABLE workflow_runs (record TEXT NOT NULL);",
      "CREATE TABLE workflow_journal (category TEXT NOT NULL, record TEXT NOT NULL);",
    ].join(" "));
    for (const run of rows.runs ?? []) database.prepare("INSERT INTO workflow_runs(record) VALUES (?)").run(JSON.stringify(run));
    for (const message of rows.messages ?? []) database.prepare("INSERT INTO messages(record) VALUES (?)").run(JSON.stringify(message));
    for (const entry of rows.journal ?? []) database.prepare("INSERT INTO workflow_journal(category, record) VALUES ('plan', ?)").run(JSON.stringify(entry));
  } finally {
    database.close();
  }
}

function seedRuntime(stateHome: string, registry: Array<[projectId: string, key: string]>, runs: Record<string, Array<[runId: string, projectId: string, status: string]>>): void {
  const runtimeDir = join(stateHome, "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const registryDb = new DatabaseSync(join(runtimeDir, "registry.db"));
  try {
    registryDb.exec("CREATE TABLE projects (project_id TEXT PRIMARY KEY, project_root TEXT NOT NULL, project_key TEXT NOT NULL UNIQUE)");
    for (const [projectId, key] of registry) {
      registryDb.prepare("INSERT INTO projects VALUES (?, ?, ?)").run(projectId, `/nowhere/${key}`, key);
    }
  } finally {
    registryDb.close();
  }
  for (const [key, rows] of Object.entries(runs)) {
    const dir = join(runtimeDir, "projects", key);
    mkdirSync(dir, { recursive: true });
    const eventDb = new DatabaseSync(join(dir, "run-events.db"));
    try {
      eventDb.exec("CREATE TABLE runs (run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workflow_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
      for (const [runId, projectId, status] of rows) {
        eventDb.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)").run(runId, projectId, "wf-runtime", status, "2026-09-20T00:00:00.000Z", "2026-09-20T00:00:00.000Z");
      }
    } finally {
      eventDb.close();
    }
  }
}

function message(id: string, project: string, toName: string, status = "queued"): object {
  return {
    id,
    project,
    from: "agt_sender",
    fromName: "sender",
    to: `agt_${toName}`,
    toName,
    content: "SECRET MESSAGE BODY",
    delivery: "followUp",
    hops: 0,
    maxHops: 5,
    status,
    createdAt: "2026-09-20T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

function listMcpTools(): Promise<string[]> {
  const isolated = isolatedMcpEnv();
  const child = spawn(process.execPath, [join(PLUGIN_DIR, "dist", "mcp-server.js")], {
    cwd: isolated.cwd,
    env: isolated.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const send = (body: object): void => { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...body })}\n`); };
  return new Promise<string[]>((resolveTools, reject) => {
    child.once("error", reject);
    lines.on("line", (line) => {
      const response = JSON.parse(line) as { id?: number; result?: { tools?: Array<{ name: string }> } };
      if (response.id === 1) {
        send({ method: "notifications/initialized" });
        send({ id: 2, method: "tools/list", params: {} });
      } else if (response.id === 2) {
        resolveTools((response.result?.tools ?? []).map((tool) => tool.name));
      }
    });
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "hook-test", version: "1.0.0" } } });
  }).finally(() => {
    lines.close();
    child.kill();
    isolated.cleanup();
  });
}

test("claude hook runs from a copied plugin directory without the repo root", async () => {
  const box = sandbox("kxm-hook-copy-");
  try {
    const copy = join(box.root, "plugin-cache", "kxm");
    cpSync(PLUGIN_DIR, copy, { recursive: true });
    const result = await runHook(box, hookEnv(box), copy);
    const context = additionalContext(result);
    assert.match(context, /^KXM project project · hub off at http:\/\/127\.0\.0\.1:1/);
    assert.ok(result.elapsedMs < 5_000, `hook took ${result.elapsedMs} ms, over the 5 s manifest timeout`);
  } finally {
    removeTempDir(box.root);
  }
});

test("claude session-start hook is silent and writes nothing outside a KXM project", async () => {
  const box = sandbox("kxm-hook-silent-", false);
  try {
    const before = treeListing(box.home, box.stateHome, box.configDir, box.project);
    const result = await runHook(box, hookEnv(box, { CLAUDE_PLUGIN_OPTION_AGENT_NAME: "claude" }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.deepEqual(treeListing(box.home, box.stateHome, box.configDir, box.project), before);
    assert.equal(existsSync(join(box.configDir, "session.token")), false);
    assert.equal(existsSync(join(box.home, ".config", "kxm", "session.token")), false);
  } finally {
    removeTempDir(box.root);
  }
});

test("claude session-start status sections stay within 1500 chars and never contain a session token", async () => {
  const box = sandbox("kxm-hook-cap-");
  try {
    const token = mintSessionToken({ preset: "operator" });
    persistSessionTokenToDisk(token, { userConfigDir: box.configDir });
    seedLegacyDb(box.project, {
      runs: Array.from({ length: 20 }, (_, index) => ({
        id: `run_${String(index).padStart(2, "0")}`,
        definitionId: `wf-${"long-definition-".repeat(40)}${index}`,
        project: "alpha",
        status: "running",
        currentStage: "build",
        targetAgentName: "claude",
        updatedAt: new Date(Date.UTC(2026, 8, 20, 0, index)).toISOString(),
      })),
    });
    const result = await runHook(box, hookEnv(box, { CLAUDE_PLUGIN_OPTION_PROJECT: "alpha", CLAUDE_PLUGIN_OPTION_AGENT_NAME: "claude" }));
    const status = statusSections(additionalContext(result));
    assert.ok(status.length <= 1500, `status sections are ${status.length} chars`);
    assert.ok(status.endsWith("…"), "over-long status sections are hard-truncated");
    assert.match(status, /^KXM project alpha · hub off/);
    assert.equal(result.stdout.includes(token), false, "the session token must never reach stdout");
    assert.equal(existsSync(join(box.project, ".kxm", "state", "session-brief.json")), false);
  } finally {
    removeTempDir(box.root);
  }
});

test("claude session-start hook probes the plugin server_url option", async () => {
  const box = sandbox("kxm-hook-health-");
  const server = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(404).end();
  });
  try {
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const context = additionalContext(await runHook(box, hookEnv(box, { CLAUDE_PLUGIN_OPTION_SERVER_URL: url })));
    assert.ok(context.includes(`hub on at ${url}`), context);
    assert.doesNotMatch(context, /The KXM hub is/);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    removeTempDir(box.root);
  }
});

test("claude session-start context omits other projects runs and requests", async () => {
  const box = sandbox("kxm-hook-scope-");
  try {
    writeFileSync(join(box.project, ".kxm", "project.yaml"), "id: proj_alpha\n");
    seedLegacyDb(box.project, {
      runs: [
        { id: "run_alpha_mine", definitionId: "wf-alpha", project: "alpha", status: "running", currentStage: "build", targetAgentName: "claude", updatedAt: "2026-09-21T00:00:00.000Z" },
        { id: "run_alpha_done", definitionId: "wf-alpha", project: "alpha", status: "completed", updatedAt: "2026-09-22T00:00:00.000Z" },
        { id: "run_beta_live", definitionId: "wf-beta", project: "beta", status: "running", targetAgentName: "claude", updatedAt: "2026-09-23T00:00:00.000Z" },
      ],
      messages: [
        message("msg_alpha_claude_1", "alpha", "claude"),
        message("msg_alpha_claude_2", "alpha", "claude", "delivered"),
        message("msg_alpha_claude_replied", "alpha", "claude", "replied"),
        message("msg_alpha_other", "alpha", "other"),
        message("msg_beta_claude", "beta", "claude"),
      ],
      journal: [{ id: "jr_1", runId: "run_beta_live", category: "plan", summary: "SECRET PLAN TEXT", createdAt: "2026-09-23T00:00:00.000Z" }],
    });
    seedRuntime(box.stateHome, [["proj_alpha", "key_alpha"], ["proj_beta", "key_beta"]], {
      key_alpha: [["rt_alpha_live", "proj_alpha", "waiting"], ["rt_stray_beta", "proj_beta", "running"]],
      key_beta: [["rt_beta_live", "proj_beta", "running"]],
      key_unregistered: [["rt_unregistered", "proj_alpha", "running"]],
    });
    const projectTree = treeListing(join(box.project, ".kxm"));

    const context = additionalContext(await runHook(box, hookEnv(box, {
      CLAUDE_PLUGIN_OPTION_PROJECT: "alpha",
      CLAUDE_PLUGIN_OPTION_AGENT_NAME: "claude",
    })));
    const status = statusSections(context);
    assert.match(status, /^KXM project alpha · hub off/);
    assert.match(status, /- run_alpha_mine wf-alpha running stage=build \(assigned to you\)/);
    assert.match(status, /- rt_alpha_live wf-runtime waiting/);
    assert.match(status, /Open peer requests to claude: 2/);
    for (const hidden of ["run_alpha_done", "run_beta_live", "rt_stray_beta", "rt_beta_live", "rt_unregistered", "SECRET"]) {
      assert.equal(context.includes(hidden), false, `${hidden} leaked into the context`);
    }
    assert.deepEqual(treeListing(join(box.project, ".kxm")), projectTree, "the hook writes nothing under .kxm");
  } finally {
    removeTempDir(box.root);
  }
});

test("claude session-start hook asks the user to clear an expired session token file", async () => {
  const box = sandbox("kxm-hook-expired-");
  try {
    const token = mintSessionToken({ preset: "operator", expiresAt: "2020-01-01T00:00:00.000Z" });
    persistSessionTokenToDisk(token, { userConfigDir: box.configDir });
    const result = await runHook(box, hookEnv(box));
    const context = additionalContext(result);
    assert.ok(context.includes("Ask the user to run `kxm session token --clear`"), context);
    assert.ok(context.includes("No active session token found"), context);
    assert.equal(context.includes("--issue"), false);
    assert.equal(context.includes("shows its expiry"), false);
    assert.equal(result.stdout.includes(token), false);
  } finally {
    removeTempDir(box.root);
  }
});

test("claude session-start hook asks the user to fix an invalid KXM_SESSION_TOKEN in the launch environment", async () => {
  const box = sandbox("kxm-hook-env-token-");
  try {
    const token = mintSessionToken({ preset: "operator", expiresAt: "2020-01-01T00:00:00.000Z" });
    const result = await runHook(box, hookEnv(box, { KXM_SESSION_TOKEN: token }));
    const context = additionalContext(result);
    assert.ok(context.includes("unset or replace KXM_SESSION_TOKEN"), context);
    assert.equal(context.includes("session token --clear"), false);
    assert.equal(result.stdout.includes(token), false);
  } finally {
    removeTempDir(box.root);
  }
});

test("plugin hooks use exec form under CLAUDE_PLUGIN_ROOT with bounded timeouts", async () => {
  const hooks = readManifestHooks();
  assert.ok(hooks.SessionStart?.length, "the plugin registers a SessionStart hook");
  assert.equal(JSON.stringify(hooks).includes("${user_config."), false, "hooks read plugin options from CLAUDE_PLUGIN_OPTION_* only");
  let mcpTools: string[] | undefined;
  for (const [event, groups] of Object.entries(hooks)) {
    for (const handler of groups.flatMap((group) => group.hooks)) {
      assert.equal(typeof handler.timeout, "number", `${event} hook needs a timeout`);
      assert.ok(handler.timeout! > 0 && handler.timeout! <= 10, `${event} hook timeout ${handler.timeout} exceeds 10 s`);
      if (handler.type === "command") {
        assert.equal(handler.command, "node", `${event} command hook must run node in exec form`);
        const script = handler.args?.[0] ?? "";
        assert.ok(script.startsWith("${CLAUDE_PLUGIN_ROOT}/dist/"), `${event} hook script ${script} is not a bundled dist file`);
        const artifact = `plugins/kxm/${script.slice("${CLAUDE_PLUGIN_ROOT}/".length)}`;
        assert.ok(STATIC_GENERATED_ARTIFACTS.includes(artifact), `${artifact} is not a generated artifact`);
        assert.ok(existsSync(resolve(artifact)), `${artifact} was not built`);
      } else if (handler.type === "mcp_tool") {
        assert.equal(handler.server, "plugin:kxm:kxm");
        mcpTools ??= await listMcpTools();
        assert.ok(mcpTools.includes(handler.tool ?? ""), `${event} hook calls ${handler.tool}, which dist/mcp-server.js does not list`);
      } else {
        assert.fail(`${event} hook type ${handler.type} is not command or mcp_tool`);
      }
    }
  }
});
