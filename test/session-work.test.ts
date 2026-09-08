import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SESSION_BRIEF_SCHEMA,
  SESSION_BRIEF_SKIP_LABEL,
  buildSessionBrief,
  estimateSessionCost,
  formatCostLine,
  formatSessionBriefText,
  formatSessionStatusLine,
  formatSessionWidget,
  formatShipLine,
  itemFromChoice,
  kxmSlashCompletions,
  parseKxmSlashArgs,
  readCachedSessionBrief,
  readGitShip,
  renderStatusLine,
  resolveSessionHubStatus,
  sessionBriefChoices,
  sessionBriefPickerEnabled,
  writeCachedSessionBrief,
} from "../plugins/kxm/src/session-work.ts";

test("session brief lists hub tasks and plans without message bodies", () => {
  const brief = buildSessionBrief({
    runs: [{
      id: "run_active",
      status: "running",
      definitionId: "default",
      project: "demo",
      currentStage: "implement",
      progress: { done: 2, total: 5 },
    }, {
      id: "run_wait",
      status: "waiting",
      definitionId: "fix",
      project: "demo",
      currentStage: "review",
    }],
    plans: [{
      id: "plan_1",
      runId: "run_active",
      summary: "Implement session brief from hub journal",
      createdAt: "2026-09-01T00:00:00.000Z",
    }],
    openMessageTotal: 3,
    runTotal: 2,
  });
  assert.equal(brief.stats.activeTasks, 2);
  assert.equal(brief.stats.waitingTasks, 1);
  assert.equal(brief.stats.planCount, 1);
  assert.match(brief.statusLine, /2 tasks/);
  assert.match(brief.statusLine, /inbox 3/);
  assert.equal(sessionBriefChoices(brief)[0], SESSION_BRIEF_SKIP_LABEL);
  assert.equal(itemFromChoice(brief, SESSION_BRIEF_SKIP_LABEL), undefined);
  const picked = itemFromChoice(brief, brief.tasks[0]?.label);
  assert.equal(picked?.runId, "run_active");
  assert.doesNotMatch(JSON.stringify(brief), /SECRET|body/i);
  assert.match(formatSessionBriefText(brief), /Tasks/);
});

test("session status line reports hub online and idle", () => {
  const empty = {
    activeTasks: 0,
    waitingTasks: 0,
    planCount: 0,
    inbox: 0,
    runTotal: 0,
  };
  assert.equal(formatSessionStatusLine(empty), "kxm idle");
  assert.match(formatSessionStatusLine(empty, undefined, { online: true }), /hub:on/);
  assert.match(formatSessionStatusLine(empty, undefined, undefined, { dirty: true, ahead: 0 }), /dirty/);
  assert.match(formatSessionStatusLine(empty, undefined, undefined, undefined, "0.5.2"), /upd 0\.5\.2/);
  assert.equal(formatShipLine({ dirty: true, ahead: 0 }), "ship dirty · commit after verify");
  assert.match(formatSessionWidget(empty, undefined, undefined, { dirty: false, ahead: 2 }).join("\n"), /2 local/);
});

test("session brief picker is TUI-only and can be disabled", () => {
  assert.equal(sessionBriefPickerEnabled({ mode: "tui", reason: "new" }), true);
  assert.equal(sessionBriefPickerEnabled({ mode: "tui", reason: "fork" }), true);
  assert.equal(sessionBriefPickerEnabled({ mode: "rpc", reason: "new" }), false);
  assert.equal(sessionBriefPickerEnabled({ mode: "tui", reason: "resume" }), false);
  assert.equal(sessionBriefPickerEnabled({ mode: "tui", reason: "new", env: { KXM_SESSION_BRIEF: "off" } }), false);
  assert.equal(parseKxmSlashArgs(undefined), "brief");
  assert.equal(parseKxmSlashArgs("hub"), "hub");
  assert.equal(parseKxmSlashArgs("nope"), "help");
  assert.deepEqual(kxmSlashCompletions("h").map((item) => item.value), ["hub", "help"]);
});

test("Gate 1: blackholed hub URL returns in under a second with unknown", async () => {
  const abortingFetch: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    });
  });

  const start = Date.now();
  const hub = await resolveSessionHubStatus("http://10.255.255.1:7331", abortingFetch, 300);
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 1000, `Expected elapsed < 1000ms, got ${elapsed}ms`);
  assert.equal(hub.state, "unknown");
  assert.equal(hub.evidence, "timeout");
  assert.equal(hub.online, false);

  const statusLine = renderStatusLine({ activeTasks: 0, waitingTasks: 0, planCount: 0, inbox: 0, runTotal: 0 }, undefined, hub);
  assert.match(statusLine, /kxm hub:unknown/);
});

test("Gate 2: fresh branch with two local commits renders 2 local", () => {
  const repo = mkdtempSync(join(tmpdir(), "kxm-git-test-"));
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Test"]);
    git(["config", "user.email", "test@example.com"]);
    writeFileSync(join(repo, "file1.txt"), "hello");
    git(["add", "file1.txt"]);
    git(["commit", "-m", "initial"]);

    git(["checkout", "-b", "feat/my-branch"]);
    writeFileSync(join(repo, "file2.txt"), "c1");
    git(["add", "file2.txt"]);
    git(["commit", "-m", "commit 1"]);
    writeFileSync(join(repo, "file3.txt"), "c2");
    git(["add", "file3.txt"]);
    git(["commit", "-m", "commit 2"]);

    const ship = readGitShip(repo);
    assert.deepEqual(ship, { dirty: false, ahead: 2 });

    const statusLine = renderStatusLine({ activeTasks: 0, waitingTasks: 0, planCount: 0, inbox: 0, runTotal: 0 }, undefined, undefined, ship);
    assert.match(statusLine, /2 local/);

    const widget = formatSessionWidget({ activeTasks: 0, waitingTasks: 0, planCount: 0, inbox: 0, runTotal: 0 }, undefined, undefined, ship);
    assert.match(widget.join("\n"), /ship 2 local · PR after CI/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Gate 3: three callers produce identical lines and never exceed 80 columns", () => {
  const ship = { dirty: false, ahead: 1 };
  const brief = buildSessionBrief({
    runs: [{
      id: "run_active",
      status: "running",
      definitionId: "default",
      project: "demo",
      currentStage: "implement",
      progress: { done: 2, total: 5 },
    }],
    plans: [{
      id: "plan_1",
      runId: "run_active",
      summary: "Implement session brief contract and render status line properly",
      createdAt: "2026-09-01T00:00:00.000Z",
    }],
    openMessageTotal: 2,
    runTotal: 1,
  }, undefined, { state: "on", evidence: "probed", online: true }, ship, undefined, "$0.42 sess · claude/fable");

  // Caller 1: Claude plugin / CLI kxm session brief --status
  const cliStatusLine = brief.statusLine;

  // Caller 2: Pi status slot in applySessionChrome (ctx.ui.setStatus)
  const piStatusSlot = renderStatusLine(brief);

  // Caller 3: /kxm status slash command (ctx.ui.notify)
  const slashStatusCommand = renderStatusLine(brief.stats, undefined, brief.hub, ship, undefined, brief.cost);

  assert.equal(cliStatusLine, piStatusSlot);
  assert.equal(piStatusSlot, slashStatusCommand);
  assert.ok(cliStatusLine.length <= 80);

  // Overflow truncation: very long plan/task details must truncate to <= 80 chars
  const longBrief = buildSessionBrief({
    runs: [{
      id: "run_long",
      status: "running",
      definitionId: "a_very_long_definition_name_that_could_easily_overflow_the_eighty_column_limit",
      project: "demo",
      currentStage: "implement_extremely_complex_feature_with_lots_of_details",
      progress: { done: 10, total: 20 },
    }],
    plans: [{
      id: "plan_long",
      runId: "run_long",
      summary: "This is an extraordinarily verbose plan description that definitely exceeds 80 characters on its own",
      createdAt: "2026-09-01T00:00:00.000Z",
    }],
    openMessageTotal: 5,
    runTotal: 2,
  }, {
    kind: "plan",
    id: "plan_long",
    runId: "run_long",
    label: "Plan very long",
    detail: "This is an extraordinarily verbose plan description that definitely exceeds 80 characters on its own",
    prompt: "prompt",
  }, { state: "on", evidence: "probed", online: true }, { dirty: true, ahead: 10 }, "1.2.3", "$100.00 sess · $50.00 run · claude/fable");

  assert.ok(longBrief.statusLine.length <= 80);
  assert.ok(longBrief.statusLine.endsWith("…"));
  assert.equal(renderStatusLine(longBrief), longBrief.statusLine);
});

test("session brief caches at .kxm/state/session-brief.json with 5s TTL", () => {
  const tmp = mkdtempSync(join(tmpdir(), "kxm-cache-test-"));
  const stateDir = join(tmp, ".kxm", "state");
  try {
    const brief = buildSessionBrief({
      runs: [],
      plans: [],
      openMessageTotal: 0,
      runTotal: 0,
    });
    brief.statusLine = "cached-status-line";

    writeCachedSessionBrief(stateDir, brief);
    const cachedFile = join(stateDir, "session-brief.json");
    assert.ok(existsSync(cachedFile));

    const read = readCachedSessionBrief(stateDir);
    assert.ok(read);
    assert.equal(read.statusLine, "cached-status-line");
    assert.equal(read.schema, SESSION_BRIEF_SCHEMA);

    // Stale cache test: modify generatedAt to be 10 seconds ago (TTL is 5s)
    const expiredBrief = {
      ...brief,
      generatedAt: new Date(Date.now() - 10000).toISOString(),
    };
    writeFileSync(cachedFile, JSON.stringify(expiredBrief));
    const expiredRead = readCachedSessionBrief(stateDir);
    assert.equal(expiredRead, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("formatCostLine handles metered and unmetered costs", () => {
  assert.equal(
    formatCostLine({ sessionCostUsd: 0.42, runCostUsd: 0.08, harness: "claude", model: "fable" }),
    "$0.42 sess · $0.08 run · claude/fable",
  );
  assert.equal(
    formatCostLine({ harness: "claude", model: "fable" }),
    "unknown",
  );
  assert.equal(
    formatCostLine({ sessionCostUsd: 1.5 }),
    "$1.50 sess",
  );
  assert.equal(formatCostLine(undefined), undefined);
});

test("estimateSessionCost reads telemetry.jsonl", () => {
  const tmp = mkdtempSync(join(tmpdir(), "kxm-cost-test-"));
  try {
    // Empty state dir
    assert.equal(estimateSessionCost(tmp), undefined);

    // Telemetry with metered records
    const telemetryFile = join(tmp, "telemetry.jsonl");
    const rec1 = {
      schema: "kxm.routing-record.v1",
      recordedAt: new Date().toISOString(),
      costBasis: "metered",
      costUsd: 0.25,
      harness: "claude",
      effectiveModel: "fable",
    };
    const rec2 = {
      schema: "kxm.routing-record.v1",
      recordedAt: new Date().toISOString(),
      costBasis: "metered",
      costUsd: 0.17,
      harness: "claude",
      effectiveModel: "fable",
    };
    writeFileSync(telemetryFile, `${JSON.stringify(rec1)}\n${JSON.stringify(rec2)}\n`);
    assert.equal(estimateSessionCost(tmp), "$0.42 sess · claude/fable");

    // Unmetered records only
    const rec3 = {
      schema: "kxm.routing-record.v1",
      recordedAt: new Date().toISOString(),
      costBasis: "unmetered",
      harness: "codex",
      effectiveModel: "gpt-5.6-sol",
    };
    writeFileSync(telemetryFile, `${JSON.stringify(rec3)}\n`);
    assert.equal(estimateSessionCost(tmp), "unknown");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

