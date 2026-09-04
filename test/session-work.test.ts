import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_BRIEF_SKIP_LABEL,
  buildSessionBrief,
  formatSessionBriefText,
  formatSessionStatusLine,
  formatSessionWidget,
  formatShipLine,
  itemFromChoice,
  kxmSlashCompletions,
  parseKxmSlashArgs,
  sessionBriefChoices,
  sessionBriefPickerEnabled,
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
