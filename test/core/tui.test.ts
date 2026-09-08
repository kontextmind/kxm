import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { Terminal } from "@earendil-works/pi-tui";
import { runCli as runCliImplementation, type CliIo } from "../../plugins/kxm/src/cli.ts";
import { applyMeshTuiKey, defaultMeshTuiView, loadLocalMeshSnapshot, KxmDashboard, renderMeshTui, runMeshTui, type MeshTuiSnapshot } from "../../plugins/kxm/src/tui.ts";

async function runCli(argv: string[], env: NodeJS.ProcessEnv, io: CliIo, cwd = process.cwd()): Promise<number> {
  const isolatedState = mkdtempSync(join(tmpdir(), "kxm-tui-state-"));
  try {
    return await runCliImplementation(argv, { KXM_STATE_HOME: isolatedState, ...env }, io, cwd);
  } finally {
    rmSync(isolatedState, { recursive: true, force: true });
  }
}

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: (text: string) => {
      stdout += text;
    },
    stderr: (text: string) => {
      stderr += text;
    },
    read: () => ({ stdout, stderr }),
  };
}

test("kxm dash dry-run does not open SSE", async () => {
  const io = capture();
  assert.equal(await runCli(["dash", "--json", "--dry-run"], {}, io), 0);
  const payload = JSON.parse(io.read().stdout) as { command: string; dryRun: boolean; transport: string };
  assert.equal(payload.command, "dash");
  assert.equal(payload.dryRun, true);
  assert.equal(payload.transport, "sse");
});

test("non-TTY dashboard prefers the authenticated metadata-only ops snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-tui-ops-"));
  const requested: string[] = [];
  let output = "";
  const agent = {
    id: "agt_tui",
    name: "kxm-tui-test",
    purpose: "Read-only mesh observer TUI",
    project: "test-project",
    model: "kxm-tui",
    connectedAt: "2026-08-27T13:59:00.000Z",
    lastSeenAt: "2026-08-27T13:59:00.000Z",
    online: true,
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith("/health")) return new Response(JSON.stringify({ ok: true, agents: 1 }));
    if (url.endsWith("/ready")) return new Response(JSON.stringify({ ok: true, storage: "sqlite" }));
    if (url.includes("/v1/ops/snapshot")) {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer admin-token");
      return new Response(JSON.stringify({
        project: "test-project",
        fetchedAt: "2026-08-27T14:00:00.000Z",
        agents: [{ ...agent, id: "agt_worker", name: "worker", model: "model", purpose: "reviewer" }],
        openMessages: [{
          id: "msg_ops_live",
          status: "delivered",
          fromName: "sender",
          toName: "worker",
          delivery: "followUp",
          createdAt: "2026-08-27T13:59:00.000Z",
        }],
        openMessageTotal: 1,
        runs: [{ id: "run_ops_live", status: "running", definitionId: "review", project: "test-project" }],
        runTotal: 1,
      }));
    }
    if (url.endsWith("/v1/agents/register")) {
      return new Response(JSON.stringify({ agent, agentKey: "agent-key" }));
    }
    if (url.includes("/v1/agents/agt_tui") && init?.method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  try {
    const code = await runMeshTui({
      serverUrl: "http://hub.test",
      dataPath: join(root, "missing.db"),
      stateDir: join(root, "state"),
      project: "test-project",
      authToken: "admin-token",
      fetchImpl,
      stdout: (text) => { output += text; },
      isTty: false,
      now: () => new Date("2026-08-27T14:00:00.000Z"),
    });
    assert.equal(code, 0);
    assert.match(output, /kxm dash/);
    assert.match(output, /worker/);
    assert.match(output, /reviewer/);
    assert.match(output, /sender → worker/);
    assert.doesNotMatch(output, /message body|password/i);
    assert.ok(requested.some((url) => url.includes("/v1/ops/snapshot")));
    assert.equal(requested.some((url) => url.endsWith("/v1/agents/register")), false, "admin ops mode must not register a synthetic observer agent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dashboard falls back to the legacy presence stream when ops auth is unavailable", async () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-tui-legacy-"));
  const agent = {
    id: "agt_legacy",
    name: "legacy-worker",
    purpose: "reviewer",
    project: "test-project",
    model: "model",
    connectedAt: "2026-08-27T13:59:00.000Z",
    lastSeenAt: "2026-08-27T13:59:00.000Z",
    online: true,
  };
  const observer = { ...agent, id: "agt_observer", name: "kxm-tui-test", model: "kxm-tui" };
  let registered = false;
  let unregistered = false;
  let output = "";
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health")) return new Response(JSON.stringify({ ok: true, agents: 1 }));
    if (url.endsWith("/ready")) return new Response(JSON.stringify({ ok: true, storage: "sqlite" }));
    if (url.includes("/v1/ops/snapshot")) return new Response(JSON.stringify({ error: "admin token required" }), { status: 503 });
    if (url.endsWith("/v1/agents/register")) {
      registered = true;
      return new Response(JSON.stringify({ agent: observer, agentKey: "agent-key" }));
    }
    if (url.endsWith("/v1/agents")) return new Response(JSON.stringify({ agents: [agent, observer] }));
    if (url.includes("/v1/agents/agt_observer") && init?.method === "DELETE") {
      unregistered = true;
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  try {
    assert.equal(await runMeshTui({
      serverUrl: "http://hub.test",
      dataPath: join(root, "missing.db"),
      stateDir: join(root, "state"),
      project: "test-project",
      fetchImpl,
      stdout: (text) => { output += text; },
      isTty: false,
      now: () => new Date("2026-08-27T14:00:00.000Z"),
    }), 0);
    assert.equal(registered, true);
    assert.equal(unregistered, true);
    assert.match(output, /legacy-worker/);
    assert.doesNotMatch(output, /kxm-tui-test/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interactive dashboard registers a legacy observer when ops access is lost mid-session", async () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-tui-transition-"));
  const abort = new AbortController();
  const encoder = new TextEncoder();
  let opsEventCalls = 0;
  let registered = false;
  let legacyOpened = false;
  const agent = {
    id: "agt_transition",
    name: "worker",
    purpose: "reviewer",
    project: "test-project",
    model: "model",
    connectedAt: "2026-08-27T13:59:00.000Z",
    lastSeenAt: "2026-08-27T13:59:00.000Z",
    online: true,
  };
  const observer = { ...agent, id: "agt_transition_observer", name: "kxm-tui-transition", model: "kxm-tui" };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health")) return new Response(JSON.stringify({ ok: true, agents: 1 }));
    if (url.endsWith("/ready")) return new Response(JSON.stringify({ ok: true, storage: "sqlite" }));
    if (url.includes("/v1/ops/snapshot")) return new Response(JSON.stringify({
      project: "test-project",
      fetchedAt: "2026-08-27T14:00:00.000Z",
      agents: [agent],
      openMessages: [],
      openMessageTotal: 0,
      runs: [],
      runTotal: 0,
    }));
    if (url.includes("/v1/ops/events")) {
      opsEventCalls += 1;
      if (opsEventCalls === 1) {
        return new Response(`event: ready\ndata: ${JSON.stringify({ type: "ops", project: "test-project", topic: "agents", at: "2026-08-27T14:00:00.000Z" })}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(JSON.stringify({ error: "rotated" }), { status: 403 });
    }
    if (url.endsWith("/v1/agents/register")) {
      registered = true;
      return new Response(JSON.stringify({ agent: observer, agentKey: "agent-key" }));
    }
    if (url.endsWith("/v1/agents")) return new Response(JSON.stringify({ agents: [agent, observer] }));
    if (url.includes("/v1/events?")) {
      assert.match(url, /presenceOnly=true/);
      legacyOpened = true;
      queueMicrotask(() => abort.abort());
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        },
      }), { headers: { "content-type": "text/event-stream", "x-kxm-events-mode": "presence" } });
    }
    if (url.includes("/v1/agents/agt_transition_observer") && init?.method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const terminal: Terminal = {
    columns: 100,
    rows: 30,
    kittyProtocolActive: false,
    start() {},
    stop() {},
    async drainInput() {},
    write() {},
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
  };
  try {
    assert.equal(await runMeshTui({
      serverUrl: "http://hub.test",
      dataPath: join(root, "missing.db"),
      stateDir: join(root, "state"),
      project: "test-project",
      authToken: "rotating-token",
      fetchImpl,
      stdout: () => undefined,
      isTty: true,
      terminal,
      abort: abort.signal,
      reconnectMs: 1,
      now: () => new Date("2026-08-27T14:00:00.000Z"),
    }), 0);
    assert.ok(opsEventCalls >= 2);
    assert.equal(registered, true);
    assert.equal(legacyOpened, true);
  } finally {
    abort.abort();
    rmSync(root, { recursive: true, force: true });
  }
});

const snapshot: MeshTuiSnapshot = {
  serverUrl: "http://127.0.0.1:7331",
  healthOk: true,
  readyOk: true,
  storage: "sqlite",
  onlineCount: 1,
  transport: "sse",
  fetchedAt: "2026-08-27T14:00:00.000Z",
  agents: [{
    id: "agt_1",
    name: "fable",
    purpose: "critic",
    project: "payk12",
    model: "claude-fable-5-1",
    connectedAt: "2026-08-27T13:00:00.000Z",
    lastSeenAt: "2026-08-27T13:59:50.000Z",
    online: true,
  }],
  openMessages: [{
    id: "msg_secret",
    status: "delivered",
    fromName: "pi-80804",
    toName: "fable",
    delivery: "followUp",
    createdAt: "2026-08-27T13:59:00.000Z",
  }],
  openMessageTotal: 1,
  runs: [{ id: "run_hidden", status: "running", definitionId: "review", project: "payk12" }],
  runTotal: 1,
  plans: [],
  pids: [],
};

test("renderMeshTui omits message bodies, hides observer identities, and shows agent state", () => {
  const frame = renderMeshTui({
    ...snapshot,
    onlineCount: 2,
    agents: [...snapshot.agents, {
      id: "agt_observer",
      name: "kxm-tui-123",
      purpose: "Read-only mesh observer TUI",
      project: "payk12",
      model: "kxm-tui",
      connectedAt: "2026-08-27T13:59:59.000Z",
      lastSeenAt: "2026-08-27T13:59:59.000Z",
      online: true,
    }],
  });
  assert.match(frame, /kxm dash/);
  assert.match(frame, /fable/);
  assert.match(frame, /live/);
  assert.doesNotMatch(frame, /secret body|password/i);
  assert.doesNotMatch(frame, /msg content/);
  assert.doesNotMatch(frame, /kxm-tui-123/, "the observer must not pollute agent rows or counts");
  assert.match(frame, /1\/1 online/);
  assert.doesNotMatch(frame, /\u001b\[/, "non-TTY snapshot must not contain ANSI controls");
});

test("number keys switch tabs instead of stacking panels", () => {
  const initial = defaultMeshTuiView();
  assert.equal(initial.tab, "agents");
  assert.doesNotMatch(renderMeshTui(snapshot, initial), /run_hidden/);
  const changed = applyMeshTuiKey(initial, "3");
  assert.notEqual(changed, "quit");
  if (changed === "quit") assert.fail("tab shortcut unexpectedly quit");
  assert.equal(changed.tab, "workflows");
  assert.match(renderMeshTui(snapshot, changed), /run_hidden/);
  assert.equal(applyMeshTuiKey(initial, "\u001b"), "quit");
  const help = { ...initial, help: true };
  assert.deepEqual(applyMeshTuiKey(help, "\u001b"), { ...help, help: false });
});

test("inbox tab reports capped open-message totals", () => {
  const frame = renderMeshTui({ ...snapshot, openMessageTotal: 10 }, defaultMeshTuiView("inbox"));
  assert.match(frame, /Inbox 1\/10/);
});

test("dashboard respects narrow terminal width", () => {
  const frame = renderMeshTui(snapshot, defaultMeshTuiView(), 60);
  for (const line of frame.trimEnd().split("\n")) assert.ok(line.length <= 60, `${line.length}: ${line}`);
  assert.match(frame, /Agents/);
  assert.doesNotMatch(frame, /PANELS/);
  assert.match(frame, /h help/);
});

test("interactive dashboard uses the shared key reducer", () => {
  let renders = 0;
  let quit = false;
  const dashboard = new KxmDashboard(snapshot, defaultMeshTuiView(), false, () => renders++, () => {
    quit = true;
  });
  dashboard.handleInput("3");
  assert.match(dashboard.render(100).join("\n"), /run_hidden/);
  dashboard.handleInput("1");
  assert.doesNotMatch(dashboard.render(100).join("\n"), /run_hidden/);
  dashboard.handleInput("h");
  dashboard.handleInput("\u001b");
  assert.equal(quit, false, "escape closes help before quitting");
  dashboard.handleInput("\u001b");
  assert.equal(quit, true);
  assert.ok(renders >= 4);
});

test("SQLite snapshot projects message metadata without retaining bodies", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-tui-privacy-"));
  const dataPath = join(root, "kxm.db");
  const stateDir = join(root, "state");
  const database = new DatabaseSync(dataPath);
  try {
    database.exec("CREATE TABLE agents (record TEXT NOT NULL); CREATE TABLE messages (record TEXT NOT NULL); CREATE TABLE workflow_runs (record TEXT NOT NULL);");
    database.prepare("INSERT INTO messages(record) VALUES (?)").run(JSON.stringify({
      id: "msg_private",
      status: "delivered",
      from: "agt_1",
      fromName: "sender",
      to: "agt_2",
      toName: "recipient",
      delivery: "followUp",
      content: "SECRET BODY MUST NOT LOAD",
      createdAt: "2026-08-27T13:59:00.000Z",
      expiresAt: "2026-08-28T13:59:00.000Z",
      hops: 0,
      maxHops: 5,
    }));
  } finally {
    database.close();
  }
  try {
    const local = loadLocalMeshSnapshot(dataPath, stateDir);
    assert.equal(local.openMessageTotal, 1);
    assert.equal(local.openMessages[0]?.id, "msg_private");
    assert.doesNotMatch(JSON.stringify(local), /SECRET BODY MUST NOT LOAD/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dashboard supports interactive access control plane actions (a/r/d/s/c)", () => {
  const initial = defaultMeshTuiView("workflows");
  const approved = applyMeshTuiKey(initial, "a", 3);
  assert.notEqual(approved, "quit");
  if (approved !== "quit") {
    assert.equal(approved.lastAction?.action, "approve");
    assert.match(approved.statusMessage ?? "", /APPROVE/);
  }

  const rejected = applyMeshTuiKey(initial, "r", 3);
  assert.notEqual(rejected, "quit");
  if (rejected !== "quit") {
    assert.equal(rejected.lastAction?.action, "reject");
    assert.match(rejected.statusMessage ?? "", /REJECT/);
  }

  const degraded = applyMeshTuiKey(initial, "d", 3);
  assert.notEqual(degraded, "quit");
  if (degraded !== "quit") {
    assert.equal(degraded.lastAction?.action, "degrade");
    assert.match(degraded.statusMessage ?? "", /DEGRADE/);
  }

  const signalled = applyMeshTuiKey(initial, "s", 3);
  assert.notEqual(signalled, "quit");
  if (signalled !== "quit") {
    assert.equal(signalled.lastAction?.action, "signal");
    assert.match(signalled.statusMessage ?? "", /SIGNAL/);
  }

  const cancelled = applyMeshTuiKey(initial, "c", 3);
  assert.notEqual(cancelled, "quit");
  if (cancelled !== "quit") {
    assert.equal(cancelled.lastAction?.action, "cancel");
    assert.match(cancelled.statusMessage ?? "", /CANCEL/);
  }
});
