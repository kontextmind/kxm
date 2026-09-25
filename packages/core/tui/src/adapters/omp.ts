/**
 * OMP (Oh My Pi) overlay adapter.
 *
 * Provides a collapsible, differential-rendered task & plan overlay
 * designed for OMP's overlay stack and custom TUI components.
 *
 * Supports:
 * - Collapsed status HUD (single-line strip) vs Expanded 3-pane dashboard
 * - Interactive task reordering (Shift+Up / Shift+Down)
 * - Auto-dispatch flag toggling ('a' key)
 * - On-demand plan optimizer ('o' key)
 * - Full workflow history view ('h' key) with dual markdown + JSONL export ('x' key)
 */

import { KxmTuiPanelComponent } from "../tui/panelComponent.ts";
import type { KxmTuiRegistry } from "../services/registry.ts";
import { createKxmTuiThemeFromPi, type PiThemeLike, type KxmTuiTheme } from "../tui/theme.ts";
import type { KxmTuiCustomComponent, KxmTuiCustomTui } from "./pi.ts";

export type OverlayMode = "collapsed" | "expanded" | "history" | "optimizer";

export interface KxmTuiOmpOverlayOptions {
  readonly registry: KxmTuiRegistry;
  readonly tui: KxmTuiCustomTui;
  readonly theme: PiThemeLike | KxmTuiTheme;
  readonly title: string;
  readonly goal?: string | undefined;
  readonly initialMode?: OverlayMode | undefined;
  readonly autoDispatch?: boolean | undefined;
  readonly onToggleAutoDispatch?: ((auto: boolean) => void) | undefined;
  readonly onReorderTasks?: ((fromIndex: number, toIndex: number) => void) | undefined;
  readonly onRunOptimizer?: (() => Promise<{ savingsTokens: number; savingsSeconds: number } | void>) | undefined;
  readonly onExportHistory?: ((format: "both" | "md" | "jsonl") => Promise<{ mdPath?: string; jsonlPath?: string }>) | undefined;
  readonly width?: (() => number) | undefined;
  readonly done?: ((closed: true) => void) | undefined;
}

export interface KxmTuiOmpOverlayComponent extends KxmTuiCustomComponent {
  getMode(): OverlayMode;
  setMode(mode: OverlayMode): void;
  isAutoDispatch(): boolean;
  toggleAutoDispatch(): void;
  dispose(): void;
}

function resolveKxmTheme(theme: PiThemeLike | KxmTuiTheme): KxmTuiTheme {
  if ("headerBg" in theme && typeof (theme as KxmTuiTheme).headerBg === "function") {
    return theme as KxmTuiTheme;
  }
  return createKxmTuiThemeFromPi(theme as PiThemeLike);
}

export function createKxmTuiOmpOverlay(options: KxmTuiOmpOverlayOptions): KxmTuiOmpOverlayComponent {
  let closed = false;
  let mode: OverlayMode = options.initialMode ?? "expanded";
  let autoDispatch = Boolean(options.autoDispatch);
  const theme: KxmTuiTheme = resolveKxmTheme(options.theme);

  const panel = new KxmTuiPanelComponent({
    registry: options.registry,
    theme,
    title: options.title,
    ...(options.goal ? { breadcrumb: `Goal: ${options.goal}` } : {}),
    helpLines: [
      "[Ctrl+O/F2] Toggle Fold  [h] History  [a] Toggle Auto  [o] Optimize  [Shift+↑/↓] Reorder",
    ],
    requestRender: () => options.tui.requestRender(),
    onQuit: () => {
      if (closed) return;
      closed = true;
      panel.dispose();
      options.done?.(true);
    },
    ...(options.width === undefined ? {} : { getWidth: options.width }),
  });

  function renderCollapsed(width: number): string[] {
    const goalText = options.goal ? `Goal: ${options.goal}` : options.title;
    const modeBadge = autoDispatch ? theme.accent("[AUTO: ON]") : theme.dim("[STEP MODE]");
    const hint = theme.dim("[Ctrl+O to Expand]");
    const content = ` [KXM] ${goalText} ── ${modeBadge} ── ${hint}`;
    const pad = Math.max(0, width - content.length);
    return [content + " ".repeat(pad)];
  }

  function handleInput(data: string): void {
    if (closed) return;

    // Toggle collapse: Ctrl+O (\x0f) or F2 (\x1bOQ or \x1b[12~)
    if (data === "\x0f" || data === "\x1bOQ" || data === "\x1b[12~") {
      mode = mode === "collapsed" ? "expanded" : "collapsed";
      options.tui.requestRender();
      return;
    }

    // When collapsed, only toggle/expand is handled
    if (mode === "collapsed") {
      if (data === "\r" || data === " " || data === "o" || data === "O") {
        mode = "expanded";
        options.tui.requestRender();
      }
      return;
    }

    // Toggle Auto-dispatch flag
    if (data === "a" || data === "A") {
      autoDispatch = !autoDispatch;
      options.onToggleAutoDispatch?.(autoDispatch);
      options.tui.requestRender();
      return;
    }

    // History mode toggle
    if (data === "h" || data === "H") {
      mode = mode === "history" ? "expanded" : "history";
      options.tui.requestRender();
      return;
    }

    // Optimizer invocation
    if (data === "o" || data === "O") {
      mode = "optimizer";
      options.onRunOptimizer?.();
      options.tui.requestRender();
      return;
    }

    // Export history in both formats
    if ((data === "x" || data === "X") && mode === "history") {
      options.onExportHistory?.("both");
      options.tui.requestRender();
      return;
    }

    // Escape in sub-modes returns to expanded
    if (data === "\x1b" && mode !== "expanded") {
      mode = "expanded";
      options.tui.requestRender();
      return;
    }

    // Forward to underlying KXM panel component
    panel.handleInput(data);
    options.tui.requestRender();
  }

  return {
    getMode: () => mode,
    setMode: (nextMode: OverlayMode) => {
      mode = nextMode;
      options.tui.requestRender();
    },
    isAutoDispatch: () => autoDispatch,
    toggleAutoDispatch: () => {
      autoDispatch = !autoDispatch;
      options.onToggleAutoDispatch?.(autoDispatch);
      options.tui.requestRender();
    },
    render: (width: number) => {
      if (mode === "collapsed") {
        return renderCollapsed(width);
      }
      return panel.render(width);
    },
    handleInput,
    invalidate: () => panel.invalidate(),
    dispose: () => {
      if (closed) return;
      closed = true;
      panel.dispose();
      options.done?.(true);
    },
  };
}
