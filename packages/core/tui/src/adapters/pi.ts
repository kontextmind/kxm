/**
 * Pi TUI adapter.
 *
 * A Pi extension opens a surface with `ctx.ui.custom((tui, theme, keybindings,
 * done) => component)`. This binds the kit's panel to that shape: the host's
 * theme supplies colours, the host's renderer is asked to repaint after every
 * key, and closing the panel hands back the owner's last published value.
 *
 * Nothing here knows what a roster, a route, or a gate is. The registry does,
 * which is why the same adapter serves every KXM surface.
 */

import { KxmTuiPanelComponent } from "../tui/panelComponent.ts";
import type { KxmTuiRegistry } from "../services/registry.ts";
import { createKxmTuiThemeFromPi, type PiThemeLike } from "../tui/theme.ts";
import {
  createKxmTuiOmpOverlay,
  type KxmTuiOmpOverlayComponent,
  type KxmTuiOmpOverlayOptions,
} from "./omp.ts";

/** The renderer handle Pi passes to a custom component. */
export interface KxmTuiCustomTui {
  requestRender(): void;
}

/** The component shape Pi's `ctx.ui.custom` consumes. */
export interface KxmTuiCustomComponent {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
}

export interface KxmTuiPiPanelOptions {
  readonly registry: KxmTuiRegistry;
  readonly tui: KxmTuiCustomTui;
  readonly theme: PiThemeLike;
  readonly title: string;
  readonly breadcrumb?: string;
  readonly helpLines?: readonly string[];
  readonly width?: () => number;
  /** Called once when the operator leaves the panel. */
  readonly done?: (closed: true) => void;
}

export interface KxmTuiPiOverlayOptions extends KxmTuiOmpOverlayOptions {}
export type KxmTuiPiOverlayComponent = KxmTuiOmpOverlayComponent;

/**
 * Create a collapsible Task & Plan overlay for Pi.
 *
 * Reuses the differential rendering engine and OMP overlay model,
 * compatible with Pi's `ctx.ui.custom` hook and keybinding stack.
 */
export const createKxmTuiPiOverlay = createKxmTuiOmpOverlay;

/**
 * Format widget lines for Pi's `ctx.ui.setWidget`.
 */
export function renderPiWorkflowWidget(options: {
  readonly goal: string;
  readonly stage: string;
  readonly progressPercent: number;
  readonly activeTask?: string | undefined;
  readonly autoDispatch?: boolean | undefined;
}): string[] {
  const filled = Math.min(10, Math.max(0, Math.round((options.progressPercent / 100) * 10)));
  const bar = `[${"█".repeat(filled)}${"░".repeat(10 - filled)}] ${options.progressPercent}%`;
  const mode = options.autoDispatch ? "AUTO" : "STEP";
  const line1 = `[KXM] Goal: ${options.goal} ── Stage: ${options.stage} (${bar}) [${mode}]`;
  const line2 = options.activeTask ? `  Active: ${options.activeTask}` : `  Waiting for next dispatch (use /kxm progress)`;
  return [line1, line2];
}

/**
 * Build the object to return from `ctx.ui.custom`.
 *
 * The panel is disposed on close, so a reopened surface must be built again
 * rather than reused: Pi drops a custom component when it is closed.
 */
export function createKxmTuiPiPanel(options: KxmTuiPiPanelOptions): KxmTuiCustomComponent {
  let closed = false;
  const panel = new KxmTuiPanelComponent({
    registry: options.registry,
    theme: createKxmTuiThemeFromPi(options.theme),
    title: options.title,
    ...(options.breadcrumb === undefined ? {} : { breadcrumb: options.breadcrumb }),
    ...(options.helpLines === undefined ? {} : { helpLines: options.helpLines }),
    requestRender: () => options.tui.requestRender(),
    onQuit: () => {
      if (closed) return;
      closed = true;
      panel.dispose();
      options.done?.(true);
    },
    ...(options.width === undefined ? {} : { getWidth: options.width }),
  });
  return {
    render: (width) => panel.render(width),
    handleInput: (data) => {
      if (closed) return;
      panel.handleInput(data);
      options.tui.requestRender();
    },
    invalidate: () => panel.invalidate(),
  };
}
