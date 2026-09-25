import assert from "node:assert/strict";
import test from "node:test";
import { createKxmTuiOmpOverlay } from "../../src/adapters/omp.ts";
import { createKxmTuiRegistry } from "../../src/services/registry.ts";
import { createPlainKxmTuiTheme } from "../../src/tui/theme.ts";
import { referenceSurface } from "../helpers/surface.ts";

test("OMP overlay adapter: toggles collapse, auto-dispatch, history, and runs optimizer/export", async () => {
  const registry = createKxmTuiRegistry();
  registry.register({
    source: "kxm/test",
    listSections: () => referenceSurface(),
    handlers: {},
  });

  let renders = 0;
  const mockTui = {
    requestRender: () => {
      renders++;
    },
  };

  let autoState = false;
  let optimizerCalled = false;
  let exportFormat: string | undefined;

  const overlay = createKxmTuiOmpOverlay({
    registry,
    tui: mockTui,
    theme: createPlainKxmTuiTheme() as any,
    title: "Plan & Task Overlay",
    goal: "Implement Auth PKCE",
    autoDispatch: false,
    onToggleAutoDispatch: (val) => {
      autoState = val;
    },
    onRunOptimizer: async () => {
      optimizerCalled = true;
      return { savingsTokens: 1000, savingsSeconds: 30 };
    },
    onExportHistory: async (format) => {
      exportFormat = format;
      return { mdPath: "retro.md", jsonlPath: "audit.jsonl" };
    },
  });

  // Default mode is expanded
  assert.equal(overlay.getMode(), "expanded");
  const expandedLines = overlay.render(100);
  assert.ok(expandedLines.length > 3);

  // Toggle to collapsed via Ctrl+O (\x0f)
  overlay.handleInput("\x0f");
  assert.equal(overlay.getMode(), "collapsed");
  const collapsedLines = overlay.render(100);
  assert.equal(collapsedLines.length, 1);
  assert.match(collapsedLines[0]!, /\[KXM\] Goal: Implement Auth PKCE/);
  assert.match(collapsedLines[0]!, /\[STEP MODE\]/);

  // Expand back via Enter
  overlay.handleInput("\r");
  assert.equal(overlay.getMode(), "expanded");

  // Toggle auto-dispatch via 'a'
  overlay.handleInput("a");
  assert.equal(overlay.isAutoDispatch(), true);
  assert.equal(autoState, true);

  // Toggle history mode via 'h'
  overlay.handleInput("h");
  assert.equal(overlay.getMode(), "history");

  // Trigger history export in history mode via 'x'
  overlay.handleInput("x");
  assert.equal(exportFormat, "both");

  // Escape returns to expanded
  overlay.handleInput("\x1b");
  assert.equal(overlay.getMode(), "expanded");

  // Invoke optimizer via 'o'
  overlay.handleInput("o");
  assert.equal(overlay.getMode(), "optimizer");
  assert.equal(optimizerCalled, true);

  overlay.dispose();
});
