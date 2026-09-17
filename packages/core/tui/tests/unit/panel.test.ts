/**
 * KXM terminal kit tests: The panel reducer: navigation, editing, choices, and effects.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { KxmTuiSectionView } from "../../src/types/surface.ts";
import {
  firstSelectableFieldIndex,
  initialKxmTuiPanelState,
  reconcileKxmTuiPanelState,
  visibleChoices,
} from "../../src/tui/panel.ts";
import { KEYS, MODEL_CHOICES, drive, effect, invokes, referenceSurface } from "../helpers/surface.ts";

test("panel: navigation skips labels and switches panes and sections", () => {
  const sections = referenceSurface();
  const start = initialKxmTuiPanelState(sections);
  assert.equal(start.pane, "sections");
  assert.equal(start.fieldIndex, 1, "the info row is not focusable");

  const intoFields = effect(start, sections, KEYS.right);
  assert.equal(intoFields.state.pane, "fields");

  const entered = effect(intoFields.state, sections, KEYS.enter);
  assert.equal(entered.state.mode, "choices", "enter opens the model list");

  const back = effect(entered.state, sections, KEYS.escape);
  assert.equal(back.state.mode, "browse");

  const nextField = effect(intoFields.state, sections, KEYS.down);
  assert.equal(nextField.state.fieldIndex, 2);
  const sectionJump = effect(start, sections, KEYS.pageDown);
  assert.equal(sectionJump.state.sectionIndex, 1);
  assert.equal(effect(sectionJump.state, sections, KEYS.pageUp).state.sectionIndex, 0);
  assert.equal(effect(start, sections, KEYS.tab).state.pane, "fields");
  assert.equal(effect(intoFields.state, sections, KEYS.tab).state.pane, "sections");

  const hjkl = drive(start, ["l", "j", "k"], sections);
  assert.equal(hjkl.pane, "fields");
  assert.equal(hjkl.fieldIndex, 1);
  assert.equal(drive(start, ["d"], sections).fieldIndex, 1, "a lone key does not clear an unset row");
});

test("panel: quit paths and help are explicit", () => {
  const sections = referenceSurface();
  const start = initialKxmTuiPanelState(sections);
  assert.deepEqual(effect(start, sections, "q").effects, [{ type: "quit" }]);
  assert.deepEqual(effect(start, sections, KEYS.escape).effects, [{ type: "quit" }]);
  assert.deepEqual(effect(start, sections, KEYS.ctrlC).effects, [{ type: "quit" }]);
  assert.equal(effect(start, sections, "h").state.help, true);
  assert.equal(effect(effect(start, sections, "h").state, sections, "?").state.help, true, "help swallows keys");
  assert.equal(effect(effect(start, sections, "?").state, sections, KEYS.escape).state.help, false);
  assert.deepEqual(effect(drive(start, ["h"], sections), sections, KEYS.down).state.help, true);
});

test("panel: editing a value emits an invoke and never echoes locally", () => {
  const sections = referenceSurface();
  const focused = drive(initialKxmTuiPanelState(sections), [KEYS.right, KEYS.enter], sections);
  const maxTurns = effect({ ...focused, fieldIndex: 4, mode: "browse" }, sections, KEYS.enter);
  assert.equal(maxTurns.state.mode, "edit");
  const typed = effect(maxTurns.state, sections, "4");
  assert.equal(typed.state.draft, "304", "the caret is at the end of the current value");
  const committed = effect(typed.state, sections, KEYS.enter);
  assert.deepEqual(invokes(committed), ["max-turns:set:304"]);
  assert.equal(committed.state.mode, "browse");
  assert.equal(committed.state.draft, "");
  assert.equal(committed.state.pending.length, 1, "the row is pending, not rewritten");
  assert.equal(referenceSurface()[0]!.fields[4]!.value, "30", "the published surface is untouched");
  const reconciled = reconcileKxmTuiPanelState(committed.state, referenceSurface());
  assert.deepEqual(reconciled.pending, [], "a republish is the answer");
  assert.equal(effect(typed.state, sections, KEYS.escape).state.draft, "", "escape drops the draft");
  assert.deepEqual(effect({ ...maxTurns.state, draft: "  " }, sections, KEYS.enter).effects, [], "a blank commit writes nothing");
});

test("panel: caret editing, paste, and delete stay inside the draft", () => {
  const sections = referenceSurface();
  const editing = effect({ ...initialKxmTuiPanelState(sections), pane: "fields", fieldIndex: 4 }, sections, KEYS.enter);
  assert.equal(editing.state.draft, "30");
  assert.equal(editing.state.caret, 2);
  const home = effect(editing.state, sections, KEYS.home);
  assert.equal(home.state.caret, 0);
  const inserted = effect(home.state, sections, "1");
  assert.deepEqual({ draft: inserted.state.draft, caret: inserted.state.caret }, { draft: "130", caret: 1 });
  const right = effect(inserted.state, sections, KEYS.right);
  assert.equal(right.state.caret, 2);
  const deleted = effect(right.state, sections, KEYS.delete);
  assert.equal(deleted.state.draft, "13", "delete removes the unit under the caret");
  const back = effect(deleted.state, sections, KEYS.backspace);
  assert.equal(back.state.draft, "1");
  assert.equal(back.state.caret, 1);
  const cleared = effect(back.state, sections, KEYS.backspace);
  assert.equal(cleared.state.draft, "");
  assert.equal(cleared.state.caret, 0);
  assert.equal(effect(cleared.state, sections, KEYS.backspace).state.draft, "", "backspace at zero is a no-op");
  const pasted = effect(cleared.state, sections, "25\n");
  assert.equal(pasted.state.draft, "25");
  assert.equal(effect(pasted.state, sections, "\u001bOP").state.draft, "25", "a function key edits nothing");
  const end = effect(pasted.state, sections, KEYS.end);
  assert.equal(end.state.caret, 2);
});

test("panel: choice lists filter, respect blocked entries, and can clear", () => {
  const sections = referenceSurface();
  const focused = drive(initialKxmTuiPanelState(sections), [KEYS.right, KEYS.enter], sections);
  assert.equal(focused.mode, "choices");
  const filtered = effect(focused, sections, "grok");
  assert.equal(filtered.state.filter, "grok");
  const model = sections[0]!.fields[1]!;
  assert.deepEqual(visibleChoices(model, "grok").map((choice) => choice.id), ["xai/grok-4.6"]);
  assert.deepEqual(visibleChoices(model, "").map((choice) => choice.id), MODEL_CHOICES.map((choice) => choice.id));
  assert.deepEqual(visibleChoices(undefined, "x"), []);

  const cleared = effect({ ...focused, filter: "" }, sections, KEYS.enter);
  assert.deepEqual(invokes(cleared), ["model:clear:-"], "the inherit entry clears instead of writing");

  const toBlocked = drive(focused, [KEYS.down, KEYS.down, KEYS.down], sections);
  const blocked = effect(toBlocked, sections, KEYS.enter);
  assert.deepEqual(blocked.effects, [{ type: "notice", message: "Portal not logged in" }], "a blocked route is refused");
  assert.equal(blocked.state.mode, "choices");
  assert.equal(effect(toBlocked, sections, KEYS.pageDown).state.choiceIndex, 3, "page keys clamp");
  assert.equal(effect(toBlocked, sections, KEYS.pageUp).state.choiceIndex, 0);
  assert.equal(effect({ ...toBlocked, filter: "zz" }, sections, KEYS.down).state.choiceIndex, 3, "an empty list does not move");
  assert.equal(effect(toBlocked, sections, "z").state.filter, "z");
  assert.equal(effect({ ...focused, filter: "" }, sections, KEYS.backspace).state.filter, "");
});

test("panel: enum rows cycle and an empty list is refused", () => {
  const sections = referenceSurface();
  const provider = drive(initialKxmTuiPanelState(sections), [KEYS.right], sections);
  const stepped = effect({ ...provider, fieldIndex: 3, pane: "fields" }, sections, KEYS.enter);
  assert.deepEqual(invokes(stepped), ["reasoning-effort:set:low"], "the cycle wraps past the current value");
  const empty = effect({ ...provider, fieldIndex: 1, pane: "fields" }, sections, KEYS.enter);
  const enumOnly: KxmTuiSectionView[] = [{ source: "kxm/x", id: "s", title: "t", order: 1, fields: [{ id: "e", label: "e", kind: "enum" }] }];
  const narrowed = effect({ ...empty.state, fieldIndex: 0, mode: "browse", pending: [] }, enumOnly, KEYS.enter);
  assert.deepEqual(narrowed.effects, [{ type: "notice", message: "e has no values published" }]);
  const choiceOnly: KxmTuiSectionView[] = [{ source: "kxm/x", id: "s", title: "t", order: 1, fields: [{ id: "c", label: "c", kind: "choice" }] }];
  const noChoice = effect({ ...empty.state, fieldIndex: 0, mode: "browse", pending: [] }, choiceOnly, KEYS.enter);
  assert.deepEqual(noChoice.effects, [{ type: "notice", message: "c has nothing to offer yet" }]);
});

test("panel: choices are refused when the entry the cursor points at is gone", () => {
  const sections = referenceSurface();
  const focused = drive(initialKxmTuiPanelState(sections), [KEYS.right, KEYS.enter], sections);
  const filtered = { ...focused, filter: "nothing-matches" };
  assert.deepEqual(effect(filtered, sections, KEYS.enter).effects, []);
});

test("panel: owner actions and clears are addressed by key", () => {
  const sections: KxmTuiSectionView[] = [{
    source: "kxm/runs",
    id: "run",
    title: "run",
    order: 10,
    fields: [
      { id: "stage", label: "stage", kind: "text", value: "implement", actions: [{ key: "y", label: "confirm", action: "confirm" }] },
    ],
  }];
  const start = { ...initialKxmTuiPanelState(sections), pane: "fields" as const };
  assert.deepEqual(effect(start, sections, "y"), {
    state: { ...start, pending: ["kxm/runs\u0000run\u0000stage"] },
    effects: [{ type: "invoke", invocation: { source: "kxm/runs", sectionId: "run", fieldId: "stage", action: "confirm" } }],
  });
  assert.deepEqual(invokes(effect(start, sections, "x")), ["stage:clear:-"]);
  assert.deepEqual(effect(start, sections, "z").effects, []);
});

test("panel: a busy row aborts and reconcile clamps to what is published", () => {
  const busy: KxmTuiSectionView[] = [{
    source: "kxm/models",
    id: "models",
    title: "models",
    order: 10,
    fields: [{ id: "refresh", label: "refresh", kind: "text", busy: true, awaitingInput: true, statusText: "needs a choice" }],
  }];
  const start = { ...initialKxmTuiPanelState(busy), pane: "fields" as const };
  assert.deepEqual(invokes(effect(start, busy, KEYS.ctrlC)), ["refresh:abort:-"]);

  const clamped = reconcileKxmTuiPanelState({ ...start, fieldIndex: 9 }, busy);
  assert.equal(clamped.fieldIndex, 0);
  const empty = reconcileKxmTuiPanelState({ ...start, sectionIndex: 4, mode: "edit" }, []);
  assert.equal(empty.sectionIndex, 0);
  assert.equal(empty.fieldIndex, 0);
  assert.equal(empty.mode, "browse");
  const keepsDraft = reconcileKxmTuiPanelState({ ...start, mode: "edit", draft: "opus" }, busy);
  assert.equal(keepsDraft.mode, "edit", "a field with a reason keeps the draft");
  assert.equal(firstSelectableFieldIndex([]), 0);
});
