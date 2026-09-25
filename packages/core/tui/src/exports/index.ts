/**
 * Public surface of `@kontextmind/tui`.
 *
 * One declarative surface model, one renderer, one input decoder, one
 * contribution registry, and thin host adapters, so `kxm dash`, the
 * configuration surfaces, and any host adapter draw the same controls and fail
 * the same way.
 *
 * Layers:
 * - `types/`    the published-surface contract and its validation
 * - `tui/`      pure controls: input decoding, layout, theme, reducer, renderer
 * - `services/` the registry that routes every write to its owner
 * - `adapters/` host bindings: a standalone terminal session and the Pi TUI
 * - `exports/`  what leaves the package; anything unexported may be reshaped
 *
 * Import discipline: this entry is Pi-bound because the components render with
 * `@earendil-works/pi-tui`. It is never re-exported from
 * `@kontextmind/kxm/core`, whose closure must stay free of Pi and commander.
 */

export * from "../types/surface.ts";
export * from "../tui/keys.ts";
export * from "../tui/layout.ts";
export * from "../tui/theme.ts";
export * from "../tui/panel.ts";
export * from "../tui/render.ts";
export * from "../tui/panelComponent.ts";
export * from "../tui/optimizer.ts";
export * from "../tui/history.ts";
export * from "../tui/queue.ts";
export * from "../tui/roleBudget.ts";
export * from "../tui/modelSelector.ts";
export * from "../services/registry.ts";
export * from "../adapters/terminal.ts";
export * from "../adapters/pi.ts";
export * from "../adapters/omp.ts";
export * from "../adapters/claude.ts";
export * from "../adapters/historyExport.ts";
