/**
 * Work types are the five project workflows, the intake source kinds, and
 * plain peer attach. Each runs once against a non-cloud loopback bind and
 * once against `kxm hub bind --cloud`.
 *
 * Land merge and release (and the other land stages that would leave the
 * machine: verify runs `npm run verify`, rebase calls `gh` and `git fetch`)
 * are local stubs. Docs and milestone run `scripts/pr-land.mjs` itself, which
 * returns before any remote call when the roadmap generator and state file
 * are absent. The stub log is the proof those destructive stages never
 * started pr-land.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Agent, createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runCli, type CliIo } from "../../plugins/kxm/src/cli.ts";
import { createMeshHub, type MeshHub } from "../../plugins/kxm/src/hub.ts";
import { readHubBinding } from "../../plugins/kxm/src/hub-binding.ts";
import { resolveAgentHubAuthToken, resolveClientHubAuthToken, writeHubEnvRecord } from "../../plugins/kxm/src/hub-env.ts";
import {
  acceptKxmIntakeMessage,
  bindKxmCoordinator,
  type KxmIntakeSourceKind,
} from "../../plugins/kxm/src/intake.ts";
import { closeKxmRuntimeContext, openKxmRuntimeContext } from "../../plugins/kxm/src/runtime-service.ts";
import { kxmRuntimePaths } from "../../plugins/kxm/src/runtime-store.ts";
import { kxmSupervisorStatus } from "../../plugins/kxm/src/runtime-supervisor.ts";

const REMOTE = "remote-admin-token-value";
const ADMIN = "local-admin-token-value";
const LOCAL_PROJECT_TOKEN = "local-project-token-value";
const DECOY = "local-decoy-token-value";
const LOCAL_PROJECT = "prj_localworkflow0001";
const CLOUD_PROJECT = "prj_cloudworkflow0001";
const PACKAGE_NAME = "@kontextmind/kxm";
const WORKFLOWS = ["default", "implement-only", "review-arch-only", "review-cli-only", "land"] as const;
const INTAKE_KINDS = ["adapter", "hub", "operator", "peer", "schedule"] as const satisfies readonly KxmIntakeSourceKind[];
const REPO = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PR_LAND = join(REPO, "scripts", "pr-land.mjs");

const STUB = `import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
function flag(name) {
  const index = args.indexOf("--" + name);
  if (index < 0 || index + 1 >= args.length) return "";
  return args[index + 1];
}

const stage = flag("stage");
const log = flag("log");
const prLand = flag("pr-land");

if (stage === "docs" || stage === "milestone") {
  const result = spawnSync(process.execPath, [prLand, "--stage", stage, "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  if (log) appendFileSync(log, stage + " real exit=" + String(result.status ?? "null") + "\\n");
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status === 0 ? 0 : 1);
}

const stubbed = new Set(["test", "verify", "rebase", "merge", "release"]);
if (!stubbed.has(stage)) {
  process.stderr.write("unexpected stage " + stage + "\\n");
  process.exit(1);
}
if (log) appendFileSync(log, stage + " stubbed-no-remote\\n");
process.stdout.write(JSON.stringify({ stage, ok: true, stub: true }) + "\\n");
process.exit(0);
`;

interface HubCall {
  method: string;
  path: string;
  auth: string;
  body: string;
  status: number;
}

function capture(): CliIo & { read(): { stdout: string; stderr: string } } {
  let stdout = "";
  let stderr = "";
  return {
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
    read: () => ({ stdout, stderr }),
  };
}

function gitRoot(root: string): void {
  const initialized = spawnSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", root], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
}

// One socket per upstream request. Node's global agent reuses keep-alive
// sockets; after the hub's idle timeout the next probe writes to a dead
// socket, gets ECONNRESET, and this proxy used to answer HTTP 502. `kxm hub
// bind` correctly refuses that 502 as "not a hub". A fresh connection does
// not reuse the dead socket. Coverage, which stalled the event loop on the
// release run, is what made the window wide enough to flake.
const upstreamAgent = new Agent({ keepAlive: false });
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);
const RETRYABLE_UPSTREAM = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ECONNABORTED"]);

function upstreamHeaders(headers: IncomingMessage["headers"], targetPort: number): OutgoingHttpHeaders {
  const forwarded: OutgoingHttpHeaders = { host: `127.0.0.1:${targetPort}` };
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name.toLowerCase() === "host" || HOP_BY_HOP.has(name.toLowerCase())) continue;
    forwarded[name] = value;
  }
  return forwarded;
}

function forwardUpstream(
  targetPort: number,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  entry: HubCall,
  attempt: number,
): void {
  const upstream = httpRequest({
    agent: upstreamAgent,
    hostname: "127.0.0.1",
    port: targetPort,
    method: req.method,
    path: req.url,
    headers: upstreamHeaders(req.headers, targetPort),
  }, (up) => {
    entry.status = up.statusCode ?? 0;
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  const retry = (error: NodeJS.ErrnoException): void => {
    // A transport reset is not an HTTP 502 from a non-hub. Retry once on a
    // new socket; a real upstream status (including 502) is still forwarded.
    if (attempt === 0 && !res.headersSent && RETRYABLE_UPSTREAM.has(error.code ?? "")) {
      forwardUpstream(targetPort, req, res, body, entry, attempt + 1);
      return;
    }
    if (!res.headersSent) res.statusCode = 502;
    res.end();
  };
  upstream.on("error", retry);
  upstream.end(body);
}

function startProxy(targetPort: number): Promise<{ url: string; seen: HubCall[]; close(): Promise<void> }> {
  const seen: HubCall[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const entry: HubCall = {
        method: req.method ?? "",
        path: req.url ?? "",
        auth: typeof req.headers.authorization === "string" ? req.headers.authorization : "",
        body: body.toString("utf8"),
        status: 0,
      };
      seen.push(entry);
      forwardUpstream(targetPort, req, res, body, entry, 0);
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        seen,
        close: () => new Promise((done) => { server.close(() => done()); }),
      });
    });
  });
}

const LOOPBACK_NO_PROXY = ["127.0.0.1", "localhost", "::1"];

function bypassLoopbackProxy(): () => void {
  // Undici's EnvHttpProxyAgent forwards every host, including 127.0.0.1, when
  // NO_PROXY is empty. A runner HTTP_PROXY then returns 502 for loopback, and
  // hub bind treats that as "not a kxm hub". Pin the bypass for this test.
  const keys = ["NO_PROXY", "no_proxy"] as const;
  const saved = new Map<string, string | undefined>(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    const have = new Set((process.env[key] ?? "").split(/[,\s]+/).filter((part) => part.length > 0));
    for (const host of LOOPBACK_NO_PROXY) have.add(host);
    process.env[key] = [...have].join(",");
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function waitForProxiedHub(proxyUrl: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${proxyUrl}/health`, { redirect: "manual" });
      const text = await response.text();
      if (response.status === 200) {
        const body = JSON.parse(text) as { ok?: unknown; agents?: unknown };
        if (body.ok === true && typeof body.agents === "number") return;
      }
      last = `HTTP ${response.status} ${text.slice(0, 160)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`proxied hub /health was not the kxm shape: ${last}`);
}

function yamlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function writeProject(cwd: string, projectId: string, gateLog: string): void {
  // Canonical files on main. implement-only, review-arch-only, and
  // review-cli-only remain aliases of writer-only, reviewer-arch-only, and
  // reviewer-cli-only, which is what WORKFLOWS drives.
  for (const name of ["default", "writer-only", "reviewer-arch-only", "reviewer-cli-only", "land"]) {
    const source = join(REPO, ".kxm", "workflows", `${name}.yaml`);
    writeFileSync(join(cwd, ".kxm", "workflows", `${name}.yaml`), readFileSync(source));
  }
  for (const name of ["planner", "writer", "reviewer-arch", "reviewer-cli"]) {
    writeFileSync(
      join(cwd, ".kxm", "agents", `${name}.yaml`),
      readFileSync(join(REPO, ".kxm", "agents", `${name}.yaml`)),
    );
  }
  mkdirSync(join(cwd, "scripts"), { recursive: true });
  writeFileSync(join(cwd, "scripts", "work-type-gate.mjs"), STUB, { mode: 0o700 });
  writeFileSync(join(cwd, "package.json"), `${JSON.stringify({ name: PACKAGE_NAME })}\n`);
  const node = "node";
  const stub = "scripts/work-type-gate.mjs";
  const log = yamlQuote(gateLog);
  const prLand = yamlQuote(PR_LAND);
  const command = (stage: string, real: boolean): string => real
    ? `    argv: [${node}, ${stub}, --stage, ${stage}, --log, ${log}, --pr-land, ${prLand}]\n`
    : `    argv: [${node}, ${stub}, --stage, ${stage}, --log, ${log}]\n`;
  writeFileSync(join(cwd, ".kxm", "gates.yaml"), `schema: kxm.gate-registry.v1
gates:
  test:
    kind: command
${command("test", false)}    timeoutMs: 60000
  land-verify:
    kind: command
${command("verify", false)}    timeoutMs: 60000
  land-docs:
    kind: command
${command("docs", true)}    timeoutMs: 60000
  land-rebase:
    kind: command
${command("rebase", false)}    timeoutMs: 60000
  land-merge:
    kind: command
${command("merge", false)}    timeoutMs: 60000
  land-release:
    kind: command
${command("release", false)}    timeoutMs: 60000
  land-milestone:
    kind: command
${command("milestone", true)}    timeoutMs: 60000
`);
}

function acceptIntake(cwd: string, projectId: string, env: NodeJS.ProcessEnv, token: string): void {
  // Intake persists in its own state root. Sharing the supervisor registry
  // would pin a different home runtime and make `kxm run` fail closed.
  const state = mkdtempSync(join(tmpdir(), "kxm-intake-state-"));
  const context = openKxmRuntimeContext(cwd, { stateRoot: state, homeRuntimeId: "rtm_worktypeintake00000001" });
  try {
    const bound = bindKxmCoordinator(context, {
      role: "coordinator",
      authority: { repositoryAccess: "none", effects: ["message-read"] },
      actor: { kind: "human", id: "root" },
    });
    assert.equal(bound.coordinator.projectId, projectId);
    for (const kind of INTAKE_KINDS) {
      const accepted = acceptKxmIntakeMessage(context, {
        coordinatorId: bound.coordinator.coordinatorId,
        idempotencyKey: `${kind}-once`,
        content: `${kind} intake for ${projectId}`,
        source: { kind, id: `${kind}-source` },
      });
      assert.equal(accepted.duplicate, false);
      assert.equal(accepted.message.source.kind, kind);
      assert.equal(accepted.message.source.id, `${kind}-source`);
      assert.equal(accepted.message.projectId, projectId);
      assert.equal(accepted.message.projectId === PACKAGE_NAME, false);
      assert.equal(resolveClientHubAuthToken(env, projectId), token);
      assert.equal(resolveAgentHubAuthToken(env, projectId), token);
    }
  } finally {
    closeKxmRuntimeContext(context);
    rmSync(state, { recursive: true, force: true });
  }
}

async function driveWorkflow(env: NodeJS.ProcessEnv, cwd: string, workflowId: string, projectId: string): Promise<void> {
  const created = capture();
  assert.equal(
    await runCli(["run", workflowId, "--json", `${workflowId} work type`], env, created, cwd),
    0,
    created.read().stderr || created.read().stdout,
  );
  const createdBody = JSON.parse(created.read().stdout) as { run?: { runId?: string } };
  const runId = createdBody.run?.runId;
  assert.equal(typeof runId, "string");
  const driven = capture();
  assert.equal(
    await runCli(["runs", "drive", runId!, "--simulated", "--wait", "--timeout-ms", "120000", "--json"], env, driven, cwd),
    0,
    driven.read().stderr || driven.read().stdout,
  );
  const receipt = JSON.parse(driven.read().stdout) as {
    verified?: boolean;
    receipt?: { projectId?: string; settlement?: { kind?: string; status?: string } };
  };
  assert.equal(receipt.verified, true, driven.read().stdout);
  assert.equal(receipt.receipt?.projectId, projectId);
  assert.equal(receipt.receipt?.settlement?.kind, "terminal");
  assert.equal(receipt.receipt?.settlement?.status, "completed");
}

async function stopSupervisor(env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
  await runCli(["runtime", "stop", "--json"], env, capture(), cwd);
  const paths = kxmRuntimePaths({ env });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const status = kxmSupervisorStatus(paths);
    let alive = false;
    if (status.pid !== undefined) {
      try {
        process.kill(status.pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (!status.running && !alive) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("runtime supervisor did not exit");
}

function callsSince(seen: HubCall[], start: number, path: string): HubCall[] {
  return seen.slice(start).filter((call) => call.path.split("?")[0] === path);
}

async function waitForCall(seen: HubCall[], start: number, path: string): Promise<HubCall[]> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const found = callsSince(seen, start, path);
    if (found.length > 0 && found.every((call) => call.status !== 0)) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const found = callsSince(seen, start, path);
  assert.ok(found.length > 0, `no ${path} call; saw ${seen.slice(start).map((call) => call.path).join(" ")}`);
  return found;
}

function assertBearer(calls: HubCall[], token: string, projectId: string): void {
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.auth, `Bearer ${token}`, `${call.method} ${call.path} -> ${call.status} auth ${call.auth}`);
    assert.ok(call.status >= 200 && call.status < 300, `${call.path} HTTP ${call.status}`);
    if (call.body.length > 0) {
      const parsed = JSON.parse(call.body) as { project?: string };
      if (parsed.project !== undefined) assert.equal(parsed.project, projectId);
    }
  }
}

const ENV_KEYS = ["KXM_AUTH_TOKEN", "KXM_SERVER_URL", "KXM_PROJECT", "KXMD_HUB_TOKEN", "KXM_RUNTIME_SYNC_INTERVAL_MS"] as const;

function pushProcessEnv(patch: Record<string, string | undefined>): () => void {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) process.env[key] = value;
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test("project workflows, intake kinds, and peer attach use the mode credential", { timeout: 180_000 }, async () => {
  const hub: MeshHub = createMeshHub({
    port: 0,
    host: "127.0.0.1",
    authToken: REMOTE,
    projectTokens: { [LOCAL_PROJECT]: LOCAL_PROJECT_TOKEN },
    shutdownGraceMs: 50,
  });
  const address = await hub.start();
  const hubPort = Number(new URL(address.url).port);
  const proxy = await startProxy(hubPort);
  const restoreProxyBypass = bypassLoopbackProxy();
  const restoreEnv = pushProcessEnv({ KXM_RUNTIME_SYNC_INTERVAL_MS: "250" });
  const temps: string[] = [];
  try {
    await waitForProxiedHub(proxy.url);
    await exerciseMode({
      mode: "local",
      projectId: LOCAL_PROJECT,
      token: LOCAL_PROJECT_TOKEN,
      proxyUrl: proxy.url,
      seen: proxy.seen,
      temps,
      bindArgs: ["hub", "--json", "bind", proxy.url],
      cloud: false,
    });
    await exerciseMode({
      mode: "cloud",
      projectId: CLOUD_PROJECT,
      token: REMOTE,
      proxyUrl: proxy.url,
      seen: proxy.seen,
      temps,
      bindArgs: ["hub", "--json", "bind", "--cloud", "--token-env", "KXMD_HUB_TOKEN", proxy.url],
      cloud: true,
    });
  } finally {
    restoreEnv();
    restoreProxyBypass();
    await proxy.close();
    await hub.close();
    for (const path of temps) rmSync(path, { recursive: true, force: true });
  }
});

async function exerciseMode(input: {
  mode: "local" | "cloud";
  projectId: string;
  token: string;
  proxyUrl: string;
  seen: HubCall[];
  temps: string[];
  bindArgs: string[];
  cloud: boolean;
}): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), `kxm-${input.mode}-work-`));
  const state = mkdtempSync(join(tmpdir(), `kxm-${input.mode}-work-state-`));
  input.temps.push(cwd, state);
  const gateLog = join(state, "gates.log");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    KXM_STATE_HOME: state,
    KXM_AGENT_NAME: "reviewer",
    KXMD_HUB_TOKEN: REMOTE,
  };
  const restore = pushProcessEnv({
    KXM_RUNTIME_SYNC_INTERVAL_MS: "250",
    ...(input.cloud ? { KXMD_HUB_TOKEN: REMOTE } : {}),
  });
  try {
    gitRoot(cwd);
    const init = capture();
    assert.equal(
      await runCli(["init", "--json", "--name", "Work Types", "--project-id", input.projectId], env, init, cwd),
      0,
      init.read().stderr,
    );
    writeProject(cwd, input.projectId, gateLog);
    writeHubEnvRecord({
      schema: "kxm.hub-env.v1",
      createdAt: "2026-09-27T00:00:00.000Z",
      authToken: ADMIN,
      projectTokens: { [input.projectId]: input.cloud ? DECOY : LOCAL_PROJECT_TOKEN },
    }, env);

    await waitForProxiedHub(input.proxyUrl);
    const bound = capture();
    assert.equal(await runCli(input.bindArgs, env, bound, cwd), 0, bound.read().stderr);
    const binding = readHubBinding(env);
    assert.equal(binding?.url, input.proxyUrl);
    assert.equal(binding?.cloud === true, input.cloud);
    const bindingText = ["hub-binding.json", "hub-binding.cloud.json"]
      .map((name) => join(state, name))
      .filter((file) => existsSync(file))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    assert.ok(bindingText.length > 0);
    assert.equal(bindingText.includes(REMOTE), false);
    assert.equal(bindingText.includes(ADMIN), false);
    assert.equal(bindingText.includes(LOCAL_PROJECT_TOKEN), false);
    assert.equal(bindingText.includes(DECOY), false);

    acceptIntake(cwd, input.projectId, env, input.token);

    const mark = input.seen.length;
    for (const workflowId of WORKFLOWS) {
      await driveWorkflow(env, cwd, workflowId, input.projectId);
    }

    const presence = await waitForCall(input.seen, mark, "/v1/runtime/presence");
    assertBearer(presence, input.token, input.projectId);
    const synced = callsSince(input.seen, mark, "/v1/sync/events");
    if (synced.length > 0) assertBearer(synced, input.token, input.projectId);

    const listed = capture();
    assert.equal(await runCli(["peer", "--json", "list"], env, listed, cwd), 0, listed.read().stderr);
    const registered = callsSince(input.seen, mark, "/v1/agents/register");
    assertBearer(registered, input.token, input.projectId);
    assert.equal(listed.read().stdout.includes(PACKAGE_NAME), false);
    assert.match(listed.read().stdout, new RegExp(input.projectId));

    const lines = readFileSync(gateLog, "utf8").trim().split("\n");
    assert.deepEqual(lines, [
      "test stubbed-no-remote",
      "verify stubbed-no-remote",
      "docs real exit=0",
      "rebase stubbed-no-remote",
      "merge stubbed-no-remote",
      "release stubbed-no-remote",
      "milestone real exit=0",
    ]);
    assert.equal(existsSync(join(cwd, ".kxm", "logs", "land-release-context.json")), false);
    const gates = readFileSync(join(cwd, ".kxm", "gates.yaml"), "utf8");
    assert.match(gates, /land-merge:[\s\S]*work-type-gate\.mjs/);
    assert.match(gates, /land-release:[\s\S]*work-type-gate\.mjs/);
    assert.equal(gates.includes("pr-land.mjs"), true);
    const mergeBlock = gates.slice(gates.indexOf("land-merge:"), gates.indexOf("land-release:"));
    const releaseBlock = gates.slice(gates.indexOf("land-release:"), gates.indexOf("land-milestone:"));
    assert.equal(mergeBlock.includes("pr-land.mjs"), false);
    assert.equal(releaseBlock.includes("pr-land.mjs"), false);
  } finally {
    try {
      await stopSupervisor(env, cwd);
    } catch {
      // A phase that failed before the supervisor started has nothing to stop.
    }
    restore();
  }
}
