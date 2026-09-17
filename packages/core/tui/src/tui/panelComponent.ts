/**
 * Pi TUI adapter for a KXM panel surface.
 *
 * The pure renderer produces lines; this class turns them into real components
 * so the panel gets Pi's viewport, scrollbar, mouse, and differential
 * rendering, and so the same code path works inside a Pi extension
 * (`ctx.ui.custom`) and inside the standalone CLI.
 *
 * It owns only wiring: read the published surface, reduce a key into state and
 * effects, run effects through the registry, then repaint. Configuration rules
 * stay in the owning module, which is the whole point of publishing sections
 * instead of centralising them.
 */

import { Box, HStack, ScrollView, Text, TruncatedText, VStack, type Component, type TuiMouseEvent, type TuiMouseEventResult, Key, matchesKey } from "@earendil-works/pi-tui";
import type { KxmTuiSectionView } from "../types/surface.ts";
import { fitText } from "./layout.ts";
import {
  initialKxmTuiPanelState,
  reduceKxmTuiInput,
  reconcileKxmTuiPanelState,
  type KxmTuiEffect,
  type KxmTuiPanelState,
} from "./panel.ts";
import { renderKxmTuiPanel } from "./render.ts";
import type { KxmTuiRegistry } from "../services/registry.ts";
import type { KxmTuiTheme } from "./theme.ts";

export interface KxmTuiPanelComponentOptions {
  readonly registry: KxmTuiRegistry;
  readonly theme: KxmTuiTheme;
  readonly title: string;
  readonly breadcrumb?: string;
  readonly helpLines?: readonly string[];
  readonly requestRender: () => void;
  readonly onQuit: () => void;
  readonly getWidth?: () => number;
  /** Extra footer text, e.g. a hub URL or a dirty-file warning. */
  readonly statusText?: () => string | undefined;
}

export const KXM_TUI_PANEL_HELP: readonly string[] = Object.freeze([
  "↑↓ move · ←→ or Tab panes · PgUp/PgDn section · enter edit or open list",
  "type to filter a list · x clears a value · esc backs out · q quit · h help",
]);

function rowsComponent(): { stack: VStack; scroll: ScrollView; fill: (rows: string[]) => void } {
  const stack = new VStack([], { gap: 0 });
  const scroll = new ScrollView(stack, { primary: true, overscroll: "contain", scrollbar: "auto" });
  const fill = (rows: string[]): void => {
    stack.clear();
    for (const row of rows) stack.addChild(new TruncatedText(row, 0, 0));
  };
  return { stack, scroll, fill };
}

export class KxmTuiPanelComponent implements Component {
  readonly root = new VStack([], { gap: 0 });
  private readonly options: KxmTuiPanelComponentOptions;
  private readonly body = rowsComponent();
  private sections: readonly KxmTuiSectionView[];
  private state: KxmTuiPanelState;
  private notice: string | undefined;
  private unsubscribe: () => void;

  constructor(options: KxmTuiPanelComponentOptions) {
    this.options = options;
    this.sections = options.registry.getSections();
    this.state = initialKxmTuiPanelState(this.sections);
    this.unsubscribe = options.registry.subscribe(() => this.refresh());
    this.rebuild();
  }

  getState(): KxmTuiPanelState {
    return this.state;
  }

  getSections(): readonly KxmTuiSectionView[] {
    return this.sections;
  }

  /** Point the cursor at a field, e.g. after opening a named section. */
  focus(sectionId: string, fieldId?: string): void {
    const sectionIndex = this.sections.findIndex((section) => section.id === sectionId);
    if (sectionIndex < 0) return;
    const fields = this.sections[sectionIndex]?.fields ?? [];
    const fieldIndex = fieldId ? Math.max(0, fields.findIndex((field) => field.id === fieldId)) : this.state.fieldIndex;
    this.state = { ...this.state, pane: "fields", sectionIndex, fieldIndex };
    this.rebuild();
    this.options.requestRender();
  }

  setStatus(message: string | undefined): void {
    this.notice = message;
    this.rebuild();
    this.options.requestRender();
  }

  refresh(): void {
    const next = this.options.registry.getSections();
    this.sections = next;
    this.state = reconcileKxmTuiPanelState(this.state, next);
    this.rebuild();
    this.options.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
      this.body.scroll.scrollBy(-(this.viewport() - 2));
      this.options.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
      this.body.scroll.scrollBy(this.viewport() - 2);
      this.options.requestRender();
      return;
    }
    const step = reduceKxmTuiInput(this.state, this.sections, data);
    this.state = step.state;
    for (const effect of step.effects) this.run(effect);
    this.rebuild();
    this.options.requestRender();
  }

  private viewport(): number {
    const height = this.body.scroll.viewportHeight;
    return height > 3 ? height : 10;
  }

  private run(effect: KxmTuiEffect): void {
    if (effect.type === "quit") {
      this.options.onQuit();
      return;
    }
    if (effect.type === "notice") {
      this.notice = effect.message;
      return;
    }
    this.notice = undefined;
    void this.options.registry.invoke(effect.invocation).then((result) => {
      if (!result.ok) this.setStatus(result.message ?? "the owner refused that change");
      else if (this.notice === undefined) this.setStatus(undefined);
    });
  }

  private footer(): string {
    const status = this.notice ?? this.options.statusText?.();
    const base = "↑↓ · ←→ panes · enter edit · x clear · esc back · h help · q quit";
    return status ? `${base}  ${status}` : base;
  }

  private rebuild(): void {
    const theme = this.options.theme;
    const width = this.options.getWidth?.() ?? 120;
    const title = new Box(1, 0, theme.headerBg);
    title.addChild(new HStack([
      { component: new Text(theme.cursor(this.options.title), 0, 0), basis: 12, shrink: 1, minSize: 6 },
      {
        component: new Text(
          this.options.breadcrumb ? theme.dim(fitText(this.options.breadcrumb, Math.max(4, width - 16))) : "",
          0,
          0,
        ),
        grow: 1,
        shrink: 1,
        minSize: 8,
      },
    ], { gap: 2 }));
    this.body.fill(
      renderKxmTuiPanel(this.sections, this.state, theme, {
        title: this.options.title,
        ...(this.options.breadcrumb ? { breadcrumb: this.options.breadcrumb } : {}),
        helpLines: this.options.helpLines ?? KXM_TUI_PANEL_HELP,
        footer: this.footer(),
      }, width),
    );
    // No horizontal padding: the renderer already fits every row to the
    // requested width, and a padded Box would push the last column over and
    // make the row wrapper truncate the value it exists to show.
    const panel = new Box(0, 0, theme.panelBg);
    panel.addChild(this.body.scroll);
    this.root.clear();
    this.root.addChild(title, { basis: "auto", shrink: 0 });
    this.root.addChild(panel, { basis: "auto", grow: 1, shrink: 1, minSize: 1 });
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.root.handleMouse?.(event);
  }

  invalidate(): void {
    this.root.invalidate();
  }

  render(width: number): string[] {
    return this.root.render(width);
  }

  dispose(): void {
    this.unsubscribe();
    this.unsubscribe = () => undefined;
  }
}

/** Build a panel component and its initial state for a non-TTY snapshot. */
export function createKxmTuiPanelComponent(options: KxmTuiPanelComponentOptions): KxmTuiPanelComponent {
  return new KxmTuiPanelComponent(options);
}
