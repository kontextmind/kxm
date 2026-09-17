/**
 * Pure renderer for KXM panel surfaces.
 *
 * Rendering is a function of (sections, state, width) returning lines, exactly
 * like `renderMeshTui` for `kxm dash`. That is what makes a config surface
 * testable in CI without a PTY and lets the same rows appear inside the Pi TUI,
 * inside `kxm dash`, and in a plain-text audit dump.
 *
 * Every emitted line is fitted to `width`: one over-wide row corrupts the whole
 * frame, so fitting happens here rather than in each caller. The edit caret is
 * drawn as a text marker instead of a reverse-video block so a colourless theme
 * stays free of escape codes.
 */

import {
  groupedKxmTuiChoices,
  type KxmTuiChoice,
  type KxmTuiField,
  type KxmTuiSectionView,
  type KxmTuiStatus,
  type KxmTuiStep,
} from "../types/surface.ts";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { KXM_TUI_MARKS, alignRight, fitText, formatAge, padRight, progressBar, wrapPlain } from "./layout.ts";
import { pendingKey, visibleChoices, type KxmTuiPanelState, type KxmTuiPane } from "./panel.ts";
import { createPlainKxmTuiTheme, type KxmTuiTheme } from "./theme.ts";

const SECTION_PANE_RATIO = 1 / 3;
const MIN_PANE_WIDTH = 16;
const PROGRESS_WIDTH = 20;
const OUTPUT_TAIL = 6;
/** Below this, both panes would be unreadable, so only the focused one draws. */
const SPLIT_MIN_WIDTH = 76;

export interface KxmTuiRenderOptions {
  readonly title: string;
  readonly breadcrumb?: string;
  readonly footer?: string;
  readonly helpLines?: readonly string[];
  readonly nowMs?: number;
}

function statusMark(status: KxmTuiStatus | undefined, theme: KxmTuiTheme, fallback: string): string {
  switch (status) {
    case "ready":
      return theme.fg("success", KXM_TUI_MARKS.ready);
    case "available":
      return theme.fg("accent", KXM_TUI_MARKS.available);
    case "blocked":
      return theme.fg("error", KXM_TUI_MARKS.blocked);
    default:
      return theme.dim(fallback);
  }
}

function cursorMark(active: boolean, theme: KxmTuiTheme): string {
  return active ? theme.cursor(KXM_TUI_MARKS.cursor) : KXM_TUI_MARKS.blankCursor;
}

function paneSplit(width: number): { sections: number; fields: number } {
  const third = Math.max(MIN_PANE_WIDTH, Math.floor(width * SECTION_PANE_RATIO));
  const sections = Math.min(third, Math.max(MIN_PANE_WIDTH, Math.floor(width / 2)));
  return { sections, fields: Math.max(MIN_PANE_WIDTH, width - sections - 1) };
}

function fieldIsPending(state: KxmTuiPanelState, section: KxmTuiSectionView, field: KxmTuiField): boolean {
  return state.pending.includes(pendingKey({ source: section.source, sectionId: section.id, fieldId: field.id }));
}

function sectionRow(
  section: KxmTuiSectionView,
  focused: boolean,
  pane: KxmTuiPane,
  theme: KxmTuiTheme,
  width: number,
): string {
  const cursor = cursorMark(focused && pane === "sections", theme);
  const flag = section.notice ? theme.fg(section.noticeLevel === "error" ? "error" : "warning", "!") : " ";
  const count = section.fields.length;
  const unset = section.fields.filter((field) => field.kind !== "info" && field.value === undefined).length;
  const right = unset > 0 ? `${unset} unset / ${count}` : `${count} field${count === 1 ? "" : "s"}`;
  return fitText(alignRight(`${cursor} ${flag} ${section.title}`, right, width), width);
}

function choiceSuffix(choice: KxmTuiChoice): string {
  const parts: string[] = [];
  if (choice.detail) parts.push(choice.detail);
  if (choice.statusText) parts.push(choice.statusText);
  return parts.join(" · ");
}

function choiceRows(field: KxmTuiField, state: KxmTuiPanelState, theme: KxmTuiTheme, width: number): string[] {
  const shown = visibleChoices(field, state.filter);
  const lines: string[] = [];
  if (state.filtering) {
    lines.push(fitText(`   ${theme.dim(`filter: ${state.filter || "(type to filter · esc clears)"}`)}`, width));
  }
  if (shown.length === 0) {
    lines.push(fitText(`   ${theme.dim("no match")}`, width));
    return lines;
  }
  let position = -1;
  for (const group of groupedKxmTuiChoices(field)) {
    const filtered = shown.filter((choice) => (choice.group ?? "") === group.group);
    if (filtered.length === 0) continue;
    if (group.group) lines.push(fitText(`   ${theme.key(group.group.toUpperCase())}`, width));
    for (const choice of filtered) {
      position += 1;
      lines.push(
        fitText(
          alignRight(
            `${cursorMark(position === state.choiceIndex, theme)} ${statusMark(choice.status, theme, KXM_TUI_MARKS.pending)} ${choice.label}`,
            choiceSuffix(choice),
            width,
          ),
          width,
        ),
      );
    }
  }
  return lines;
}

const STEP_MARKS: Record<KxmTuiStep["state"], string> = {
  pending: "·",
  satisfied: KXM_TUI_MARKS.passed,
  running: KXM_TUI_MARKS.active,
  done: KXM_TUI_MARKS.passed,
  failed: KXM_TUI_MARKS.failed,
};

function stepColor(state: KxmTuiStep["state"], theme: KxmTuiTheme): (text: string) => string {
  switch (state) {
    case "running":
      return (text) => theme.fg("accent", text);
    case "done":
      return (text) => theme.fg("success", text);
    case "failed":
      return (text) => theme.fg("error", text);
    default:
      return theme.dim;
  }
}

function stepRows(steps: readonly KxmTuiStep[], theme: KxmTuiTheme, width: number): string[] {
  return steps.map((step) => {
    const paint = stepColor(step.state, theme);
    return fitText(alignRight(`   ${paint(STEP_MARKS[step.state])} ${step.label}`, step.detail ?? "", width), width);
  });
}

function progressRow(field: KxmTuiField, theme: KxmTuiTheme, width: number): string {
  const progress = field.progress;
  if (!progress) return "";
  const ratio = progress.ratio;
  const right = ratio === undefined ? "working" : `${Math.round(ratio * 100)}%`;
  return fitText(alignRight(`   ${progress.label}`, `${progressBar(ratio, PROGRESS_WIDTH)} ${right}`, width), width);
}

function focusedFieldDetail(
  field: KxmTuiField,
  state: KxmTuiPanelState,
  theme: KxmTuiTheme,
  width: number,
): string[] {
  const lines: string[] = [];
  if (field.keyPath) lines.push(fitText(`   ${theme.dim(`key: ${field.keyPath}`)}`, width));
  for (const line of wrapPlain(field.detail ?? "", width - 3)) {
    if (line) lines.push(fitText(`   ${theme.dim(line)}`, width));
  }
  for (const line of wrapPlain(field.statusText ?? "", width - 3)) {
    if (line) lines.push(fitText(`   ${theme.fg("error", line)}`, width));
  }
  const progress = progressRow(field, theme, width);
  if (progress) lines.push(progress);
  if (field.steps?.length) lines.push(...stepRows(field.steps, theme, width));
  if (field.output?.length) {
    lines.push(...field.output.slice(-OUTPUT_TAIL).map((line) => fitText(`   ${theme.dim(line)}`, width)));
  }
  if (field.actions?.length) {
    lines.push(fitText(`   ${theme.key(field.actions.map((action) => `${action.key} ${action.label}`).join(" · "))}`, width));
  }
  if (state.mode === "choices") lines.push(...choiceRows(field, state, theme, width));
  if (state.mode === "edit" || field.awaitingInput) {
    const draft = state.mode === "edit" ? `${state.draft.slice(0, state.caret)}|${state.draft.slice(state.caret)}` : "|";
    lines.push(fitText(`   ${theme.dim("›")} ${draft}`, width));
  }
  return lines;
}

function fieldRows(
  section: KxmTuiSectionView,
  state: KxmTuiPanelState,
  theme: KxmTuiTheme,
  width: number,
  nowMs: number,
): string[] {
  const lines: string[] = [];
  section.fields.forEach((field, index) => {
    const focused = state.pane === "fields" && state.fieldIndex === index;
    if (field.kind === "info") {
      lines.push(fitText(`   ${theme.dim(field.label)}  ${theme.dim(field.value ?? field.placeholder ?? "")}`, width));
      return;
    }
    const pending = fieldIsPending(state, section, field);
    const mark = statusMark(field.status, theme, pending ? "◌" : KXM_TUI_MARKS.pending);
    const value = pending && field.value === undefined ? theme.dim("saving…") : field.value;
    const shown = value ?? theme.dim(field.placeholder ?? "not set");
    const age = field.updatedAt ? theme.dim(` (${formatAge(field.updatedAt, nowMs)})`) : "";
    lines.push(fitText(`${cursorMark(focused, theme)} ${mark} ${alignRight(field.label, `${shown}${age}`, width - 4)}`, width));
    if (focused) lines.push(...focusedFieldDetail(field, state, theme, width));
  });
  return lines;
}

function noticeRows(section: KxmTuiSectionView | undefined, theme: KxmTuiTheme, width: number): string[] {
  if (!section?.notice) return [];
  const token = section.noticeLevel === "error" ? "error" : "warning";
  return wrapPlain(section.notice, width - 2).map((line) => fitText(theme.fg(token, line), width));
}

function singlePaneLines(
  sections: readonly KxmTuiSectionView[],
  state: KxmTuiPanelState,
  theme: KxmTuiTheme,
  width: number,
  nowMs: number,
): string[] {
  const section = sections[state.sectionIndex];
  if (state.pane === "fields" && section) {
    return [
      fitText(theme.headerBg(alignRight(` ${section.title}`, section.source, width)), width),
      ...noticeRows(section, theme, width),
      ...fieldRows(section, state, theme, width, nowMs),
    ];
  }
  return [
    fitText(theme.headerBg(alignRight(" SECTIONS", `${sections.length}`, width)), width),
    ...sections.map((candidate, index) => sectionRow(candidate, index === state.sectionIndex, state.pane, theme, width)),
  ];
}

function twoPaneLines(
  sections: readonly KxmTuiSectionView[],
  state: KxmTuiPanelState,
  theme: KxmTuiTheme,
  width: number,
  nowMs: number,
): string[] {
  const split = paneSplit(width);
  const left: string[] = [fitText(theme.key(" SECTIONS"), split.sections)];
  sections.forEach((candidate, index) =>
    left.push(sectionRow(candidate, index === state.sectionIndex, state.pane, theme, split.sections)),
  );
  const right: string[] = [];
  const section = sections[state.sectionIndex];
  if (section) {
    right.push(fitText(alignRight(` ${section.title}`, section.source, split.fields), split.fields));
    if (section.detail) right.push(fitText(` ${theme.dim(section.detail)}`, split.fields));
    right.push(...noticeRows(section, theme, split.fields));
    right.push(...fieldRows(section, state, theme, split.fields, nowMs));
  } else {
    right.push(fitText(theme.dim("no surface is published"), split.fields));
  }
  const rows: string[] = [];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    rows.push(fitText(`${padRight(left[index] ?? "", split.sections)} ${right[index] ?? ""}`, width));
  }
  return rows;
}

/**
 * Draw one frame.
 *
 * Narrow terminals collapse to the focused pane instead of shrinking both, which
 * keeps a field label legible at 48 columns.
 */
export function renderKxmTuiPanel(
  sections: readonly KxmTuiSectionView[],
  state: KxmTuiPanelState,
  theme: KxmTuiTheme,
  options: KxmTuiRenderOptions,
  width = 120,
): string[] {
  const nowMs = options.nowMs ?? Date.now();
  const title = `${theme.cursor(options.title)}${options.breadcrumb ? `  ${theme.dim(options.breadcrumb)}` : ""}`;
  const header = [fitText(title, width)];
  if (state.help) {
    const help = (options.helpLines ?? ["no help published"]).flatMap((line) => wrapPlain(line, Math.max(1, width - 2)));
    return [...header, ...help.map((line) => fitText(line, width)), fitText(theme.dim("esc close help"), width)];
  }
  const body = width < SPLIT_MIN_WIDTH
    ? singlePaneLines(sections, state, theme, width, nowMs)
    : twoPaneLines(sections, state, theme, width, nowMs);
  const footer = options.footer ? [fitText(theme.dim(options.footer), width)] : [];
  return [...header, ...body, ...footer];
}

/** Render a frame to plain text, with all styling removed. */
export function renderKxmTuiPanelText(
  sections: readonly KxmTuiSectionView[],
  state: KxmTuiPanelState,
  options: KxmTuiRenderOptions,
  width = 120,
): string {
  return `${renderKxmTuiPanel(sections, state, createPlainKxmTuiTheme(), options, width)
    .map((line) => stripTerminalSequences(line))
    .join("\n")}\n`;
}
