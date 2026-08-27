import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runCli } from "../plugins/kxm-mesh/src/cli.ts";
import { applyMeshTuiKey, defaultMeshTuiView, loadLocalMeshSnapshot, MeshDashboard, renderMeshTui, type MeshTuiSnapshot } from "../plugins/kxm-mesh/src/tui.ts";

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

test("mesh tui dry-run does not open SSE", async () => {
  const io = capture();
  assert.equal(await runCli(["mesh", "--json", "--dry-run", "tui"], {}, io), 0);
  const payload = JSON.parse(io.read().stdout) as { command: string; dryRun: boolean; transport: string };
  assert.equal(payload.command, "tui");
  assert.equal(payload.dryRun, true);
  assert.equal(payload.transport, "sse");
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
    model: "claude-fable-5",
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
  assert.match(frame, /fable/);
  assert.match(frame, /live/);
  assert.match(frame, /delivered/);
  assert.doesNotMatch(frame, /secret body|password/i);
  assert.doesNotMatch(frame, /msg content/);
  assert.doesNotMatch(frame, /kxm-tui-123/, "the observer must not pollute agent rows or counts");
  assert.match(frame, /1\/1 online/);
  assert.doesNotMatch(frame, /\u001b\[/, "non-TTY snapshot must not contain ANSI controls");
});

test("panel shortcuts toggle the requested dashboard panel", () => {
  const initial = defaultMeshTuiView();
  assert.doesNotMatch(renderMeshTui(snapshot, initial), /run_hidden/);
  const changed = applyMeshTuiKey(initial, "3");
  assert.notEqual(changed, "quit");
  if (changed === "quit") assert.fail("panel shortcut unexpectedly quit");
  assert.match(renderMeshTui(snapshot, changed), /run_hidden/);
  const stillOpen = applyMeshTuiKey(changed, "3");
  assert.notEqual(stillOpen, "quit");
  if (stillOpen === "quit") assert.fail("panel shortcut unexpectedly quit");
  assert.equal(stillOpen.open.runs, true, "number keys reveal rather than hide an open panel");
  assert.equal(applyMeshTuiKey(initial, "\u001b"), "quit");
  const help = { ...initial, help: true };
  assert.deepEqual(applyMeshTuiKey(help, "\u001b"), { ...help, help: false });
});

test("dashboard reports capped totals without undercounting", () => {
  const frame = renderMeshTui({ ...snapshot, openMessageTotal: 10 });
  assert.match(frame, /Messages \(1\/10\)/);
  assert.match(frame, /… \+9 more/);
});

test("dashboard respects narrow terminal width", () => {
  const frame = renderMeshTui(snapshot, defaultMeshTuiView(), 60);
  for (const line of frame.trimEnd().split("\n")) assert.ok(line.length <= 60, `${line.length}: ${line}`);
  assert.match(frame, /Agents/);
  assert.doesNotMatch(frame, /PANELS/, "sidebar is hidden below the responsive breakpoint");
  assert.match(frame, /h help/, "narrow layout keeps help discoverable");
});

test("interactive dashboard uses the shared key reducer", () => {
  let renders = 0;
  let quit = false;
  const dashboard = new MeshDashboard(snapshot, defaultMeshTuiView(), false, () => renders++, () => {
    quit = true;
  });
  dashboard.handleInput("3");
  assert.match(dashboard.render(100).join("\n"), /run_hidden/);
  dashboard.handleInput(" ");
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
  const dataPath = join(root, "mesh.db");
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
