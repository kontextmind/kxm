import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_BRIEF_SKIP_LABEL,
  buildSessionBrief,
  formatSessionBriefText,
  formatSessionStatusLine,
  itemFromChoice,
  kxmSlashCompletions,
  parseKxmSlashArgs,
  sessionBriefChoices,
  sessionBriefPickerEnabled,
} from "../plugins/kxm/src/session-work.ts";
import { parseHubInitOption } from "../plugins/kxm/src/hub-setup.ts";

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
  assert.equal(formatSessionStatusLine({
    activeTasks: 0,
    waitingTasks: 0,
    planCount: 0,
    inbox: 0,
    runTotal: 0,
  }), "kxm idle");
  assert.match(formatSessionStatusLine({
    activeTasks: 0,
    waitingTasks: 0,
    planCount: 0,
    inbox: 0,
    runTotal: 0,
  }, undefined, { online: true }), /hub:on/);
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

test("init --hub is opt-in and rejects SSH", () => {
  const local = parseHubInitOption(undefined);
  assert.equal(local.ok, true);
  if (local.ok) assert.equal(local.mode, "local");
  const existing = parseHubInitOption(true);
  assert.equal(existing.ok, true);
  if (existing.ok) assert.equal(existing.mode, "existing");
  const created = parseHubInitOption("new");
  assert.equal(created.ok, true);
  if (created.ok) assert.equal(created.mode, "new");
  const ssh = parseHubInitOption("ssh");
  assert.equal(ssh.ok, false);
  if (!ssh.ok) assert.equal(ssh.error, "hub_ssh_unsupported");
  const urlOnly = parseHubInitOption(undefined, "http://127.0.0.1:7331");
  assert.equal(urlOnly.ok, false);
});
