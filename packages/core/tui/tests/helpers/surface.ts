/**
 * Shared fixture for the terminal kit tests.
 *
 * The reference surface mirrors a real harness settings file — model selector,
 * provider, thinking level, numeric limits, boolean modes — so the contract,
 * the reducer, and the renderer are exercised against shapes an actual KXM
 * configuration panel must draw.
 */

import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  KXM_TUI_CLEAR_ACTION,
  KXM_TUI_SET_ACTION,
  type KxmTuiSectionView,
} from "../../src/types/surface.ts";
import {
  initialKxmTuiPanelState,
  reduceKxmTuiInput,
  type KxmTuiPanelState,
} from "../../src/tui/panel.ts";

export { initialKxmTuiPanelState };
export { stripTerminalSequences };

export const KEYS = {
  up: "\u001b[A",
  down: "\u001b[B",
  right: "\u001b[C",
  left: "\u001b[D",
  enter: "\r",
  escape: "\u001b",
  tab: "\t",
  backspace: "\u007f",
  pageUp: "\u001b[5~",
  pageDown: "\u001b[6~",
  ctrlC: "\u0003",
  delete: "\u001b[3~",
  home: "\u001bOH",
  end: "\u001b[F",
};

export const MODEL_CHOICES = [
  { id: "inherit", label: "inherit (Pi)", detail: "Leaves the setting unset.", action: KXM_TUI_CLEAR_ACTION },
  { id: "xai/grok-4.6", label: "grok-4.6", group: "xai", detail: "$2/M in", status: "ready" as const, action: KXM_TUI_SET_ACTION },
  { id: "anthropic/fable", label: "fable", group: "anthropic", detail: "$10/M in", status: "available" as const, action: KXM_TUI_SET_ACTION },
  { id: "nous-portal/tencent/hy4-preview", label: "hy4-preview", group: "nous-portal", detail: "unknown", status: "blocked" as const, statusText: "Portal not logged in", action: KXM_TUI_SET_ACTION },
];

export function referenceSurface(model: string = "xai/grok-4.6"): KxmTuiSectionView[] {
  return [
    {
      source: "kxm/config",
      id: "config",
      title: "configuration",
      order: 20,
      detail: "kxm.config.v1 · user scope",
      fields: [
        { id: "header", label: "harness", kind: "info", value: "pi (default)" },
        {
          id: "model",
          label: "model",
          kind: "choice",
          keyPath: "model",
          detail: "Admitted routes only. Auth is still verified at dispatch.",
          value: model,
          choices: MODEL_CHOICES,
        },
        {
          id: "provider",
          label: "provider",
          kind: "enum",
          keyPath: "provider",
          value: "xai",
          choices: [
            { id: "xai", label: "xai", action: KXM_TUI_SET_ACTION },
            { id: "anthropic", label: "anthropic", action: KXM_TUI_SET_ACTION },
            { id: "openrouter", label: "openrouter", action: KXM_TUI_SET_ACTION },
          ],
        },
        {
          id: "reasoning-effort",
          label: "thinking",
          kind: "enum",
          keyPath: "reasoningEffort",
          value: "high",
          choices: [
            { id: "low", label: "low", action: KXM_TUI_SET_ACTION },
            { id: "medium", label: "medium", action: KXM_TUI_SET_ACTION },
            { id: "high", label: "high", action: KXM_TUI_SET_ACTION },
          ],
        },
        { id: "max-turns", label: "max turns", kind: "text", keyPath: "maxTurns", value: "30", detail: "Integer 1 to 200." },
        { id: "context-window", label: "context", kind: "text", keyPath: "contextWindowTokens", placeholder: "128000" },
        { id: "yolo", label: "yolo", kind: "enum", keyPath: "yolo", value: "false", choices: [{ id: "true", label: "true" }, { id: "false", label: "false" }] },
      ],
    },
    {
      source: "kxm/gates",
      id: "gates",
      title: "gates",
      order: 40,
      fields: [
        { id: "test", label: "test gate", kind: "text", keyPath: "gates.test.argv", value: "npm test" },
      ],
    },
  ];
}

/** Visible column count of a rendered line, after styling is removed. */
export function visibleColumns(line: string): number {
  return stripTerminalSequences(line).length;
}

export function effect(
  state: KxmTuiPanelState,
  sections: readonly KxmTuiSectionView[],
  input: string,
) {
  return reduceKxmTuiInput(state, sections, input);
}

export function invokes(step: ReturnType<typeof effect>): string[] {
  return step.effects
    .filter((entry): entry is Extract<typeof entry, { type: "invoke" }> => entry.type === "invoke")
    .map((entry) => `${entry.invocation.fieldId}:${entry.invocation.action}:${entry.invocation.value ?? "-"}`);
}

export function drive(state: KxmTuiPanelState, inputs: readonly string[], sections: readonly KxmTuiSectionView[] = referenceSurface()): KxmTuiPanelState {
  return inputs.reduce<KxmTuiPanelState>((current, input) => effect(current, sections, input).state, state);
}

