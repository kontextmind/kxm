/**
 * KXM terminal kit tests: Contract validation, input decoding, layout maths, and theming.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  KXM_TUI_LIMITS,
  fieldIsEditable,
  groupedKxmTuiChoices,
  isSelectableField,
  validateKxmTuiSurface,
  assertKxmTuiSurface,
  type KxmTuiField,
} from "../../src/types/surface.ts";
import {
  decodeKxmTuiInput,
  deleteBackward,
  insertAt,
  isControlInput,
  normalizeInputText,
} from "../../src/tui/keys.ts";
import {
  alignRight,
  fitText,
  formatAge,
  padRight,
  progressBar,
  wrapPlain,
} from "../../src/tui/layout.ts";
import {
  firstSelectableFieldIndex,
} from "../../src/tui/panel.ts";
import {
  createDefaultKxmTuiTheme,
  createKxmTuiAnsiTheme,
  createKxmTuiThemeFromPi,
  createPlainKxmTuiTheme,
} from "../../src/tui/theme.ts";
import {
  KEYS,
  referenceSurface,
  stripTerminalSequences,
  visibleColumns,
} from "../helpers/surface.ts";

test("contracts: a well-formed surface is accepted and ordered", () => {
  const sections = assertKxmTuiSurface(referenceSurface());
  assert.deepEqual(validateKxmTuiSurface(sections), []);
  assert.deepEqual(sections.map((section) => section.id), ["config", "gates"]);
});

test("contracts: invalid kinds, ids, orders, duplicates, and oversize are refused", () => {
  const cases: { label: string; value: unknown; code: string }[] = [
    { label: "not an array", value: {}, code: "invalid_list" },
    { label: "missing kind", value: [{ source: "kxm/x", id: "s", title: "t", order: 1, fields: [{ id: "a", label: "a" }] }], code: "required" },
    { label: "unknown kind", value: [{ source: "kxm/x", id: "s", title: "t", order: 1, fields: [{ id: "a", label: "a", kind: "slider" }] }], code: "invalid_choice" },
    { label: "bad field id", value: [{ source: "kxm/x", id: "s", title: "t", order: 1, fields: [{ id: "Bad Id", label: "a", kind: "text" }] }], code: "invalid_id" },
    { label: "bad key path", value: [{ source: "kxm/x", id: "s", title: "t", order: 1, fields: [{ id: "a", label: "a", kind: "text", keyPath: "a b" }] }], code: "invalid_key_path" },
    { label: "duplicate field", value: [{ source: "kxm/x", id: "s", title: "t", order: 1, fields: [{ id: "a", label: "a", kind: "text" }, { id: "a", label: "b", kind: "text" }] }], code: "duplicate_id" },
    { label: "duplicate section", value: [{ source: "kxm/x", id: "s", title: "t", order: 1, fields: [] }, { source: "kxm/x", id: "s", title: "t", order: 2, fields: [] }], code: "duplicate_section" },
    { label: "bad order", value: [{ source: "kxm/x", id: "s", title: "t", order: 5000, fields: [] }], code: "invalid_order" },
    { label: "bad source", value: [{ source: "not addressable", id: "s", title: "t", order: 1, fields: [] }], code: "invalid_source" },
    { label: "escape in value", value: [{ source: "kxm/x", id: "s", title: "t", order: 1, fields: [{ id: "a", label: "a", kind: "text", value: "a\u001bb" }] }], code: "control_character" },
    { label: "bad ratio", value: [{ source: "kxm/x", id: "s", title: "t", order: 1, fields: [{ id: "a", label: "a", kind: "text", progress: { label: "p", ratio: 4 } }] }], code: "invalid_ratio" },
    { label: "bad step state", value: [{ source: "kxm/x", id: "s", title: "t", order: 1, fields: [{ id: "a", label: "a", kind: "text", steps: [{ label: "s", state: "wip" }] }] }], code: "invalid_choice" },
    { label: "bad action key", value: [{ source: "kxm/x", id: "s", title: "t", order: 1, fields: [{ id: "a", label: "a", kind: "text", actions: [{ key: "yy", label: "confirm", action: "confirm" }] }] }], code: "invalid_action_key" },
    { label: "bad timestamp", value: [{ source: "kxm/x", id: "s", title: "t", order: 1, fields: [{ id: "a", label: "a", kind: "text", updatedAt: "yesterday" }] }], code: "invalid_timestamp" },
    { label: "non-string output", value: [{ source: "kxm/x", id: "s", title: "t", order: 1, fields: [{ id: "a", label: "a", kind: "text", output: [7] }] }], code: "invalid_string" },
    { label: "oversize label", value: [{ source: "kxm/x", id: "s", title: "t", order: 1, fields: [{ id: "a", label: "x".repeat(200), kind: "text" }] }], code: "too_long" },
    { label: "field not an object", value: [{ source: "kxm/x", id: "s", title: "t", order: 1, fields: ["nope"] }], code: "invalid_object" },
    { label: "section not an object", value: ["nope"], code: "invalid_object" },
  ];
  for (const entry of cases) {
    const issues = validateKxmTuiSurface(entry.value);
    assert.ok(issues.some((issue) => issue.code === entry.code), `${entry.label} expected ${entry.code}, got ${JSON.stringify(issues)}`);
  }
  assert.throws(() => assertKxmTuiSurface([{ source: "kxm/x", id: "s", title: "t", order: 1, fields: [{ id: "a", label: "a", kind: "nope" }] }]), /refused/u);
  assert.equal(validateKxmTuiSurface([{ source: "kxm/x", id: "s", title: "t", order: 1, fields: [] }])[0]?.code, undefined);
});

test("contracts: too many sections, choices, and actions are refused", () => {
  const tooManySections = Array.from({ length: KXM_TUI_LIMITS.sectionsMax + 1 }, (_unused, index) => ({
    source: "kxm/x",
    id: `s${index}`,
    title: `s${index}`,
    order: index,
    fields: [],
  }));
  assert.equal(validateKxmTuiSurface(tooManySections)[0]?.code, "too_many");
  const field: KxmTuiField = {
    id: "a",
    label: "a",
    kind: "choice",
    choices: Array.from({ length: KXM_TUI_LIMITS.choicesMax + 1 }, (_unused, index) => ({ id: `c${index}`, label: `c${index}` })),
  };
  const issues = validateKxmTuiSurface([{ source: "kxm/x", id: "s", title: "t", order: 1, fields: [field] }]);
  assert.ok(issues.some((issue) => issue.code === "invalid_list"));
});

test("contracts: selectability drives where the cursor may rest", () => {
  const surface = referenceSurface();
  const fields = surface[0]!.fields;
  assert.equal(isSelectableField(fields[0]), false, "info rows are labels");
  assert.equal(firstSelectableFieldIndex(fields), 1, "the cursor starts on the model row");
  assert.equal(fieldIsEditable(fields[0]), false);
  assert.equal(fieldIsEditable({ id: "x", label: "x", kind: "choice" }), false, "an empty choice list is not editable");
  assert.equal(fieldIsEditable({ id: "x", label: "x", kind: "info" }), false);
  assert.deepEqual(
    groupedKxmTuiChoices(fields[1]!).map((group) => group.group),
    ["", "xai", "anthropic", "nous-portal"],
  );
  assert.deepEqual(groupedKxmTuiChoices({ id: "y", label: "y", kind: "text" }), []);
});

test("keys: named keys, printable input, paste, and control bytes are separated", () => {
  assert.deepEqual(decodeKxmTuiInput(KEYS.up), { kind: "up" });
  assert.deepEqual(decodeKxmTuiInput(KEYS.pageDown), { kind: "pageDown" });
  assert.deepEqual(decodeKxmTuiInput(KEYS.ctrlC), { kind: "ctrlC" });
  assert.deepEqual(decodeKxmTuiInput(" "), { kind: "text", text: " " });
  assert.deepEqual(decodeKxmTuiInput("q"), { kind: "text", text: "q" });
  assert.deepEqual(decodeKxmTuiInput("\u001bOP"), { kind: "ignored" }, "a function key is not text");
  assert.deepEqual(decodeKxmTuiInput("grok-4.6"), { kind: "text", text: "grok-4.6" }, "pasted text stays intact");
  assert.deepEqual(decodeKxmTuiInput(""), { kind: "ignored" });
  assert.equal(isControlInput("\u001b[A"), true);
  assert.equal(isControlInput("a"), false);
  assert.equal(normalizeInputText("a\u001b[b\nc"), "a [b c", "escape and newlines become spaces");
  assert.equal(normalizeInputText("x".repeat(5000)).length, 4096);
});

test("keys: edits are surrogate-safe and bounded", () => {
  assert.equal(deleteBackward("ab🙂"), "ab");
  assert.equal(deleteBackward(""), "");
  const inserted = insertAt("🙂x", 1, "y");
  assert.deepEqual(inserted, { text: "🙂yx", caret: 2 });
  const capped = insertAt("a".repeat(4090), 4090, "aaaaaa");
  assert.equal(capped.text.length, 4096);
});

test("layout: width maths uses visible columns, not string length", () => {
  const styled = "\u001b[1mmodel\u001b[0m";
  assert.equal(fitText(styled, 5), styled);
  assert.equal(stripTerminalSequences(fitText(styled, 3)), "mo…");
  assert.equal(fitText("abcdef", 4), "abc…");
  assert.equal(fitText("abcd🙂ef", 4), "abc…", "plain truncation is grapheme-safe");
  assert.equal(stripTerminalSequences(fitText("\u001b[1mabcdef\u001b[0m", 4)), "abc…");
  assert.equal(fitText("abcdef", 0), "");
  assert.equal(visibleColumns(alignRight("left", "right", 12)), 12);
  assert.equal(alignRight("left", "right", 12), "left   right");
  assert.equal(alignRight("a", "b", 0), "");
  assert.equal(padRight("ab", 5), "ab   ");
  assert.equal(padRight("abcdef", 5), "abcdef");
  assert.deepEqual(wrapPlain("one two three", 7), ["one two", "three"]);
  assert.deepEqual(wrapPlain("", 10), []);
  assert.deepEqual(wrapPlain("x", 0), []);
});

test("layout: age, progress, and marks read the same everywhere", () => {
  const now = Date.parse("2026-09-18T12:00:00.000Z");
  assert.equal(formatAge("2026-09-18T11:59:48.000Z", now), "12s");
  assert.equal(formatAge("2026-09-18T11:56:00.000Z", now), "4m00s");
  assert.equal(formatAge("2026-09-18T09:45:00.000Z", now), "2h15m");
  assert.equal(formatAge("2026-09-15T12:00:00.000Z", now), "3d00h");
  assert.equal(formatAge("2026-09-18T12:00:05.000Z", now), "—", "clock skew is not 'just now'");
  assert.equal(formatAge(undefined, now), "—");
  assert.equal(formatAge("yesterday", now), "—");
  assert.equal(progressBar(0.5, 8), "████░░░░");
  assert.equal(progressBar(undefined, 4), "░░░░");
  assert.equal(progressBar(5, 4), "████");
});

test("theme: plain output carries no escape codes and the CLI palette colours", () => {
  const plain = createPlainKxmTuiTheme();
  assert.equal(plain.colored, false);
  assert.equal(plain.error("boom"), "boom");
  assert.equal(plain.headerBg("h"), "h");
  const ansi = createKxmTuiAnsiTheme(true);
  assert.equal(ansi.colored, true);
  assert.equal(ansi.accent("x"), "\u001b[1;36mx\u001b[0m");
  assert.equal(ansi.panelBg("x"), "\u001b[48;5;236mx\u001b[0m");
  assert.equal(createKxmTuiAnsiTheme(false).colored, false);
  assert.equal(createDefaultKxmTuiTheme({ NO_COLOR: "1" }).colored, false);
  assert.equal(createDefaultKxmTuiTheme({ KXM_TUI_NO_COLOR: "1" }).colored, false);
  assert.equal(createDefaultKxmTuiTheme({}).colored, true);
  const pi = createKxmTuiThemeFromPi({
    fg: (token, text) => `<${token}>${text}`,
    bg: (token, text) => `[${token}]${text}`,
  });
  assert.equal(pi.label("hi"), "<text>hi");
  assert.equal(pi.dim("hi"), "<muted>hi");
  assert.equal(pi.headerBg("hi"), "[selectedBg]hi");
  assert.equal(createKxmTuiThemeFromPi({ fg: (t, x) => x, bg: (t, x) => x }, false).colored, false);
});
