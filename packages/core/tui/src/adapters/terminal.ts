/**
 * Standalone driver for a KXM panel surface.
 *
 * `kxm dash` already owns its hub and SSE loop, so the kit does not duplicate
 * it. This is the small alternative for a local, file-backed surface — a config
 * or roster panel that repaints when an owner republishes and stops when the
 * operator leaves.
 *
 * A non-TTY caller gets one plain-text frame and exit code zero, which keeps
 * `--dry-run`, CI smoke, and piped output honest instead of pretending to be an
 * interactive session.
 */

import { ProcessTerminal, TuiAltScreen, stripTerminalSequences, type Terminal } from "@earendil-works/pi-tui";
import { KxmTuiPanelComponent } from "../tui/panelComponent.ts";
import { initialKxmTuiPanelState } from "../tui/panel.ts";
import { renderKxmTuiPanel } from "../tui/render.ts";
import type { KxmTuiRegistry } from "../services/registry.ts";
import { createDefaultKxmTuiTheme, createPlainKxmTuiTheme, type KxmTuiTheme } from "../tui/theme.ts";

export interface RunKxmTuiPanelInput {
  readonly registry: KxmTuiRegistry;
  readonly title: string;
  readonly breadcrumb?: string;
  readonly helpLines?: readonly string[];
  readonly stdout: (text: string) => void;
  readonly terminal?: Terminal;
  readonly isTty?: boolean;
  readonly theme?: KxmTuiTheme;
  readonly abort?: AbortSignal;
  /** Repaint interval for surfaces whose owners can change outside this process. */
  readonly pollMs?: number;
  readonly now?: () => number;
}

/** Draw one frame without a terminal. Used by `--dry-run` and CI smoke. */
export function renderKxmTuiPanelFrame(input: {
  registry: KxmTuiRegistry;
  title: string;
  theme?: KxmTuiTheme;
  width?: number;
  nowMs?: number;
  footer?: string;
}): string {
  const theme = input.theme ?? createPlainKxmTuiTheme();
  const lines = renderKxmTuiPanel(
    input.registry.getSections(),
    initialKxmTuiPanelState(input.registry.getSections()),
    theme,
    { title: input.title, footer: input.footer ?? "non-interactive frame", nowMs: input.nowMs ?? Date.now() },
    input.width ?? 100,
  );
  return `${lines.map((line) => stripTerminalSequences(line)).join("\n")}\n`;
}

/** Run a panel until it quits, the caller aborts, or one frame is enough. */
export async function runKxmTuiPanel(input: RunKxmTuiPanelInput): Promise<number> {
  const theme = input.theme ?? createDefaultKxmTuiTheme();
  const tty = input.isTty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!tty) {
    input.stdout(renderKxmTuiPanelFrame({
      registry: input.registry,
      title: input.title,
      theme,
      ...(input.now === undefined ? {} : { nowMs: input.now() }),
      ...(input.breadcrumb ? { footer: input.breadcrumb } : {}),
    }));
    return 0;
  }

  const terminal = input.terminal ?? new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let finished: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    input.abort?.removeEventListener("abort", stop);
    panel.dispose();
    tui.stop();
    finished();
  };
  const panel = new KxmTuiPanelComponent({
    registry: input.registry,
    theme,
    title: input.title,
    ...(input.breadcrumb ? { breadcrumb: input.breadcrumb } : {}),
    ...(input.helpLines ? { helpLines: input.helpLines } : {}),
    requestRender: () => tui.requestRender(),
    onQuit: stop,
    getWidth: () => terminal.columns,
  });
  input.abort?.addEventListener("abort", stop, { once: true });
  tui.setLayoutRoot(panel.root);
  tui.setFocus(panel);
  tui.start();
  timer = setInterval(() => panel.refresh(), input.pollMs ?? 2_000);
  timer.unref?.();
  await done;
  return stopped && input.abort?.aborted ? 130 : 0;
}
