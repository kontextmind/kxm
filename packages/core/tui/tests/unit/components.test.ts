/**
 * KXM terminal kit tests: The renderer, the Pi component adapter, and the host adapters.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  KXM_TUI_SET_ACTION,
  type KxmTuiSectionView,
} from "../../src/types/surface.ts";
import { initialKxmTuiPanelState, reduceKxmTuiInput } from "../../src/tui/panel.ts";
import { renderKxmTuiPanel } from "../../src/tui/render.ts";
import { KxmTuiPanelComponent } from "../../src/tui/panelComponent.ts";
import { createKxmTuiRegistry } from "../../src/services/registry.ts";
import { renderKxmTuiPanelFrame, runKxmTuiPanel } from "../../src/adapters/terminal.ts";
import { createKxmTuiPiPanel } from "../../src/adapters/pi.ts";
import { createPlainKxmTuiTheme, createKxmTuiAnsiTheme } from "../../src/tui/theme.ts";
import { KEYS, drive, referenceSurface } from "../helpers/surface.ts";

test("render: a wide frame shows both panes, groups, statuses, and the key path", () => {
  const sections = referenceSurface();
  const state = drive(initialKxmTuiPanelState(sections), [KEYS.right, KEYS.enter], sections);
  const frame = renderKxmTuiPanel(sections, state, createPlainKxmTuiTheme(), {
    title: "kxm configure",
    breadcrumb: "model selector",
    footer: "esc back",
  }, 120);
  const text = frame.join("\n");
  assert.match(text, /kxm configure/u);
  assert.match(text, /SECTIONS/u);
  assert.match(text, /configuration/u);
  assert.match(text, /XAI/u);
  assert.match(text, /grok-4\.6/u);
  assert.match(text, /hy4-preview.*Portal not logged in/u);
  assert.match(text, /key: model/u);
  assert.match(text, /esc back/u);
  for (const line of frame) assert.ok(stripTerminalSequences(line).length <= 120, `over-wide: ${line}`);
});

test("render: narrow terminals collapse, help replaces the body, and colour stays optional", () => {
  const sections = referenceSurface();
  const state = { ...drive(initialKxmTuiPanelState(sections), [KEYS.right], sections), help: false };
  const narrow = renderKxmTuiPanel(sections, state, createKxmTuiAnsiTheme(true), { title: "kxm configure" }, 48);
  assert.equal(narrow.some((line) => /SECTIONS/u.test(line)), false, "only the focused pane draws");
  for (const line of narrow) assert.ok(stripTerminalSequences(line).length <= 48);
  assert.ok(narrow.some((line) => line.includes("\u001b[")), "the ANSI theme paints when colour is on");

  const help = renderKxmTuiPanel(sections, { ...state, help: true }, createPlainKxmTuiTheme(), { title: "t", helpLines: ["first line", "second line"] }, 60);
  assert.match(help.join("\n"), /first line/u);
  assert.match(help.join("\n"), /esc close help/u);
  const defaultHelp = renderKxmTuiPanel(sections, { ...state, help: true }, createPlainKxmTuiTheme(), { title: "t" }, 60);
  assert.match(defaultHelp.join("\n"), /no help published/u);
});

test("render: focused detail draws errors, progress, steps, output, and actions", () => {
  const sections: KxmTuiSectionView[] = [{
    source: "kxm/models",
    id: "models",
    title: "models",
    order: 10,
    notice: "catalog is 41 days old; prices may be wrong",
    noticeLevel: "error",
    fields: [
      {
        id: "refresh",
        label: "catalog refresh",
        kind: "text",
        value: "checked",
        statusText: "the last write was refused: unknown field",
        progress: { label: "fetching", ratio: 0.25 },
        steps: [
          { label: "read inventory", state: "done" },
          { label: "fetch prices", state: "running", detail: "openrouter" },
          { label: "write catalog", state: "pending" },
        ],
        output: ["line one", "line two"],
        actions: [{ key: "r", label: "retry", action: "retry" }],
        updatedAt: "2026-09-18T11:59:00.000Z",
      },
      { id: "note", label: "note", kind: "info" },
    ],
  }];
  const state = { ...initialKxmTuiPanelState(sections), pane: "fields" as const };
  const frame = renderKxmTuiPanel(sections, state, createPlainKxmTuiTheme(), { title: "kxm configure", nowMs: Date.parse("2026-09-18T12:00:00.000Z") }, 100);
  const text = frame.join("\n");
  assert.match(text, /catalog is 41 days old/u);
  assert.match(text, /the last write was refused/u);
  assert.match(text, /fetching\s+█+░+/u);
  assert.match(text, /✔ read inventory/u);
  assert.match(text, /▶ fetch prices\s+openrouter/u);
  assert.match(text, /· write catalog/u);
  assert.match(text, /line two/u);
  assert.match(text, /r retry/u);
  assert.match(text, /1m00s/u);
  assert.match(text, /note/u);
});

test("render: empty and pending states say so instead of lying", () => {
  const state = { ...initialKxmTuiPanelState([]), pane: "fields" as const, fieldIndex: 3 };
  const empty = renderKxmTuiPanel([], state, createPlainKxmTuiTheme(), { title: "kxm configure" }, 100);
  assert.match(empty.join("\n"), /no surface is published/u);
  const pending = renderKxmTuiPanel(
    referenceSurface(),
    { ...initialKxmTuiPanelState(referenceSurface()), pane: "fields", pending: ["kxm/config\u0000config\u0000context-window"] },
    createPlainKxmTuiTheme(),
    { title: "kxm configure" },
    100,
  );
  assert.match(pending.join("\n"), /saving…/u);
  const noMatch = renderKxmTuiPanel(
    referenceSurface(),
    { ...initialKxmTuiPanelState(referenceSurface()), pane: "fields", mode: "choices", fieldIndex: 1, filtering: true, filter: "zzz" },
    createPlainKxmTuiTheme(),
    { title: "kxm configure" },
    100,
  );
  assert.match(noMatch.join("\n"), /no match/u);
});

test("component: it renders, edits through the registry, and unsubscribes", async () => {
  const registry = createKxmTuiRegistry();
  let value = "high";
  registry.register({
    source: "kxm/config",
    listSections: () => [{
      source: "kxm/config",
      id: "config",
      title: "configuration",
      order: 10,
      fields: [{ id: "effort", label: "thinking", kind: "enum", value, choices: [{ id: "high", label: "high" }, { id: "low", label: "low" }] }],
    }],
    handlers: {
      [KXM_TUI_SET_ACTION]: ({ value: next }) => {
        if (next === "nope") throw new Error("refused");
        value = next ?? value;
      },
    },
  });
  let renders = 0;
  const panel = new KxmTuiPanelComponent({
    registry,
    theme: createPlainKxmTuiTheme(),
    title: "kxm configure",
    requestRender: () => {
      renders += 1;
    },
    onQuit: () => undefined,
    getWidth: () => 90,
  });
  const first = panel.render(90).map((line) => stripTerminalSequences(line));
  assert.ok(first.length > 2);
  assert.match(first.join("\n"), /thinking/u);
  assert.equal(panel.getSections().length, 1);

  panel.handleInput(KEYS.right);
  panel.handleInput(KEYS.enter);
  assert.deepEqual(panel.getState().pending, ["kxm/config\u0000config\u0000effort"]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(panel.render(90).map((line) => stripTerminalSequences(line)).join("\n"), /low/u);
  assert.ok(renders > 0);

  panel.focus("config", "effort");
  assert.equal(panel.getState().fieldIndex, 0);
  panel.focus("missing");
  panel.setStatus("custom notice");
  assert.match(panel.render(90).join("\n"), /custom notice/u);
  panel.handleInput("\u001b[5~");
  panel.handleInput("\u001b[6~");
  panel.invalidate();
  panel.dispose();
  panel.refresh();
});

test("component: mouse and unknown keys are tolerated, and quit is delegated", () => {
  const registry = createKxmTuiRegistry();
  registry.register({ source: "kxm/x", listSections: () => referenceSurface(), handlers: {} });
  let quit = 0;
  const panel = new KxmTuiPanelComponent({
    registry,
    theme: createKxmTuiAnsiTheme(true),
    title: "t",
    requestRender: () => undefined,
    onQuit: () => {
      quit += 1;
    },
  });
  panel.handleInput("q");
  assert.equal(quit, 1);
  panel.handleInput("\u001b[Z");
  assert.equal(panel.handleMouse?.({ type: "move", button: "none", x: 0, y: 0, screenX: 0, screenY: 0, width: 10, height: 2, shift: false, alt: false, ctrl: false }), undefined);
});

test("mount: a non-TTY caller gets one plain frame and exit code zero", async () => {
  const registry = createKxmTuiRegistry();
  registry.register({ source: "kxm/config", listSections: () => referenceSurface(), handlers: {} });
  const frames: string[] = [];
  const code = await runKxmTuiPanel({
    registry,
    title: "kxm configure",
    breadcrumb: "kxm.config.v1",
    stdout: (text) => frames.push(text),
    isTty: false,
    theme: createPlainKxmTuiTheme(),
    now: () => Date.parse("2026-09-18T12:00:00.000Z"),
  });
  assert.equal(code, 0);
  assert.equal(frames.length, 1);
  assert.match(frames[0] ?? "", /grok-4\.6/u);
  assert.equal(/\u001b/u.test(frames[0] ?? ""), false, "a piped frame must be plain text");
  const standalone = renderKxmTuiPanelFrame({ registry, title: "kxm configure", width: 80, nowMs: 1, footer: "f" });
  assert.match(standalone, /kxm configure/u);
});

test("mount: a terminal session quits through the panel and stops cleanly", async () => {
  const registry = createKxmTuiRegistry();
  registry.register({ source: "kxm/config", listSections: () => referenceSurface(), handlers: {} });
  const written: string[] = [];
  const fakeTerminal = {
    start(onInput: (data: string) => void) {
      setTimeout(() => onInput("q"), 5);
    },
    stop() {
      written.push("stopped");
    },
    drainInput: async () => undefined,
    write() {
      written.push("write");
    },
    get columns() {
      return 100;
    },
    get rows() {
      return 24;
    },
    get kittyProtocolActive() {
      return false;
    },
    moveBy() {
      return undefined;
    },
    hideCursor() {
      return undefined;
    },
    showCursor() {
      return undefined;
    },
    clearLine() {
      return undefined;
    },
    clearFromCursor() {
      return undefined;
    },
    clearScreen() {
      return undefined;
    },
    setTitle() {
      return undefined;
    },
    setProgress() {
      return undefined;
    },
  };
  const code = await runKxmTuiPanel({
    registry,
    title: "kxm configure",
    stdout: () => undefined,
    terminal: fakeTerminal,
    isTty: true,
    theme: createPlainKxmTuiTheme(),
    pollMs: 5_000,
  });
  assert.equal(code, 0);
  assert.ok(written.includes("stopped"));
});


test("adapters/pi: a Pi custom component renders, edits once, then closes", async () => {
  const registry = createKxmTuiRegistry();
  let value = "high";
  registry.register({
    source: "kxm/config",
    listSections: () => [{
      source: "kxm/config",
      id: "config",
      title: "configuration",
      order: 10,
      fields: [{ id: "effort", label: "thinking", kind: "enum", value, choices: [{ id: "high", label: "high" }, { id: "low", label: "low" }] }],
    }],
    handlers: {
      [KXM_TUI_SET_ACTION]: ({ value: next }) => {
        value = next ?? value;
      },
    },
  });
  let painted = 0;
  let closed: true | undefined;
  const component = createKxmTuiPiPanel({
    registry,
    tui: { requestRender: () => { painted += 1; } },
    theme: { fg: (_token, text) => text, bg: (_token, text) => text },
    title: "kxm configure",
    breadcrumb: "kxm.config.v1",
    width: () => 88,
    done: (result) => { closed = result; },
  });
  const lines = component.render(88).map((line) => stripTerminalSequences(line));
  assert.ok(lines.length > 1);
  assert.match(lines.join("\n"), /thinking/u);
  component.invalidate();

  component.handleInput(KEYS.right);
  component.handleInput(KEYS.down);
  component.handleInput(KEYS.enter);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(value, "low", "the owner applied the write");
  component.handleInput("q");
  assert.equal(closed, true);
  const before = painted;
  component.handleInput("q");
  assert.equal(painted, before, "input after close is dropped");
});
