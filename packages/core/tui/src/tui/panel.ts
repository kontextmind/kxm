/**
 * Pure state machine for a KXM panel surface.
 *
 * Navigation, editing, and choice filtering live here as a reducer so the whole
 * interaction is testable without a terminal — the same contract that keeps
 * `applyMeshTuiKey` in `kxm dash` testable. The component layer owns rendering
 * and the registry round-trip; nothing here touches the filesystem or a hub.
 *
 * There is deliberately no local echo of an edit. A typed or selected value is
 * emitted as an effect for the owning module to apply, and the field stays
 * pending until that owner republishes. A rejected value therefore comes back
 * with its reason instead of the panel showing a value that was never written.
 */

import {
  KXM_TUI_ABORT_ACTION,
  KXM_TUI_CLEAR_ACTION,
  KXM_TUI_SET_ACTION,
  fieldIsEditable,
  isSelectableField,
  type KxmTuiChoice,
  type KxmTuiField,
  type KxmTuiInvocation,
  type KxmTuiSectionView,
} from "../types/surface.ts";
import { decodeKxmTuiInput, deleteBackward, insertAt, normalizeInputText, type KxmTuiInput } from "./keys.ts";

export type KxmTuiPane = "sections" | "fields";
export type KxmTuiMode = "browse" | "edit" | "choices";

export interface KxmTuiPanelState {
  readonly pane: KxmTuiPane;
  readonly mode: KxmTuiMode;
  readonly sectionIndex: number;
  readonly fieldIndex: number;
  readonly choiceIndex: number;
  readonly draft: string;
  readonly caret: number;
  readonly filter: string;
  readonly filtering: boolean;
  readonly help: boolean;
  /** Keys of fields awaiting an owner reply: `source\u0000section\u0000field`. */
  readonly pending: readonly string[];
}

export type KxmTuiEffect =
  | { readonly type: "invoke"; readonly invocation: KxmTuiInvocation }
  | { readonly type: "quit" }
  | { readonly type: "notice"; readonly message: string };

export interface KxmTuiPanelStep {
  readonly state: KxmTuiPanelState;
  readonly effects: readonly KxmTuiEffect[];
}

const PANE_KEYS = new Set(["j", "k", "h", "l"]);

export function initialKxmTuiPanelState(sections: readonly KxmTuiSectionView[]): KxmTuiPanelState {
  return {
    pane: "sections",
    mode: "browse",
    sectionIndex: 0,
    fieldIndex: firstSelectableFieldIndex(sections[0]?.fields ?? []),
    choiceIndex: 0,
    draft: "",
    caret: 0,
    filter: "",
    filtering: false,
    help: false,
    pending: [],
  };
}

export function pendingKey(invocation: { source: string; sectionId: string; fieldId: string }): string {
  return `${invocation.source}\u0000${invocation.sectionId}\u0000${invocation.fieldId}`;
}

export function firstSelectableFieldIndex(fields: readonly KxmTuiField[]): number {
  const index = fields.findIndex(isSelectableField);
  return index < 0 ? 0 : index;
}

/** Choices left after the panel's filter, in display order. */
export function visibleChoices(field: KxmTuiField | undefined, filter: string): KxmTuiChoice[] {
  const choices = field?.choices ?? [];
  const needle = filter.trim().toLowerCase();
  if (!needle) return [...choices];
  return choices.filter((choice) =>
    `${choice.group ?? ""} ${choice.label} ${choice.id} ${choice.detail ?? ""}`.toLowerCase().includes(needle),
  );
}

export function currentSection(
  sections: readonly KxmTuiSectionView[],
  state: KxmTuiPanelState,
): KxmTuiSectionView | undefined {
  return sections[state.sectionIndex];
}

export function currentField(
  sections: readonly KxmTuiSectionView[],
  state: KxmTuiPanelState,
): KxmTuiField | undefined {
  return currentSection(sections, state)?.fields[state.fieldIndex];
}

/**
 * Re-clamp a state after an owner republished.
 *
 * Any republish is an answer, so nothing stays pending past it. A field that
 * grew an error, or is waiting for a typed line, keeps edit mode and the draft
 * so the typed value is not lost; otherwise edit mode ends.
 */
export function reconcileKxmTuiPanelState(
  state: KxmTuiPanelState,
  sections: readonly KxmTuiSectionView[],
): KxmTuiPanelState {
  const sectionIndex = Math.min(state.sectionIndex, Math.max(0, sections.length - 1));
  const fields = sections[sectionIndex]?.fields ?? [];
  let fieldIndex = Math.min(state.fieldIndex, Math.max(0, fields.length - 1));
  if (!isSelectableField(fields[fieldIndex])) fieldIndex = firstSelectableFieldIndex(fields);
  const field = fields[fieldIndex];
  const keepsEdit = state.mode === "edit" && (field?.statusText !== undefined || field?.awaitingInput === true);
  return {
    ...state,
    sectionIndex,
    fieldIndex,
    mode: keepsEdit ? "edit" : "browse",
    choiceIndex: 0,
    pending: [],
  };
}

export function focusedFieldIsEditable(
  sections: readonly KxmTuiSectionView[],
  state: KxmTuiPanelState,
): boolean {
  return fieldIsEditable(currentField(sections, state));
}

/**
 * Advance the panel by one input event.
 *
 * `sections` is the current published surface. The reducer never mutates it and
 * never calls an owner directly; it returns effects for the caller to run.
 */
export function reduceKxmTuiInput(
  state: KxmTuiPanelState,
  sections: readonly KxmTuiSectionView[],
  input: string,
): KxmTuiPanelStep {
  return reduceDecoded(state, sections, decodeKxmTuiInput(input));
}

function invokeEffect(
  state: KxmTuiPanelState,
  section: KxmTuiSectionView,
  field: KxmTuiField,
  action: string,
  value?: string,
): KxmTuiPanelStep {
  const invocation: KxmTuiInvocation = {
    source: section.source,
    sectionId: section.id,
    fieldId: field.id,
    action,
    ...(value === undefined ? {} : { value }),
  };
  const key = pendingKey(invocation);
  return {
    state: { ...state, pending: state.pending.includes(key) ? state.pending : [...state.pending, key] },
    effects: [{ type: "invoke", invocation }],
  };
}

function moveSection(
  state: KxmTuiPanelState,
  sections: readonly KxmTuiSectionView[],
  delta: number,
): KxmTuiPanelState {
  if (sections.length === 0) return state;
  const next = Math.max(0, Math.min(state.sectionIndex + delta, sections.length - 1));
  if (next === state.sectionIndex) return state;
  return {
    ...state,
    sectionIndex: next,
    fieldIndex: firstSelectableFieldIndex(sections[next]?.fields ?? []),
    mode: "browse",
    choiceIndex: 0,
    draft: "",
    caret: 0,
    filter: "",
    filtering: false,
  };
}

/** Info fields are labels, so the cursor steps over them to the next control. */
function moveField(
  state: KxmTuiPanelState,
  fields: readonly KxmTuiField[],
  delta: number,
): KxmTuiPanelState {
  const step = delta < 0 ? -1 : 1;
  let next = state.fieldIndex + step;
  while (next >= 0 && next < fields.length && !isSelectableField(fields[next])) next += step;
  if (next < 0 || next >= fields.length) return state;
  return {
    ...state,
    fieldIndex: next,
    mode: "browse",
    choiceIndex: 0,
    draft: "",
    caret: 0,
    filter: "",
    filtering: false,
  };
}

function moveChoice(state: KxmTuiPanelState, count: number, delta: number): KxmTuiPanelState {
  if (count === 0) return state;
  return { ...state, choiceIndex: Math.max(0, Math.min(state.choiceIndex + delta, count - 1)) };
}

function choiceAt(field: KxmTuiField, state: KxmTuiPanelState): KxmTuiChoice | undefined {
  const choices = visibleChoices(field, state.filter);
  return choices[Math.max(0, Math.min(state.choiceIndex, choices.length - 1))];
}

function enterField(
  state: KxmTuiPanelState,
  section: KxmTuiSectionView,
  field: KxmTuiField | undefined,
): KxmTuiPanelStep {
  if (!field) return { state, effects: [] };
  if (field.kind === "choice") {
    if ((field.choices?.length ?? 0) === 0) {
      return { state, effects: [{ type: "notice", message: `${field.label} has nothing to offer yet` }] };
    }
    return { state: { ...state, mode: "choices", choiceIndex: 0 }, effects: [] };
  }
  if (field.kind === "enum") {
    const choices = field.choices ?? [];
    if (choices.length === 0) {
      return { state, effects: [{ type: "notice", message: `${field.label} has no values published` }] };
    }
    const current = choices.findIndex((choice) => choice.id === field.value);
    const next = choices[(current + 1) % choices.length]!;
    if (next.status === "blocked") {
      return { state, effects: [{ type: "notice", message: next.statusText ?? `${next.label} is unavailable` }] };
    }
    return invokeEffect(state, section, field, next.action ?? KXM_TUI_SET_ACTION, next.id);
  }
  if (field.kind !== "text") return { state, effects: [] };
  return { state: { ...state, mode: "edit", draft: field.value ?? "", caret: (field.value ?? "").length }, effects: [] };
}

function reduceDecoded(
  state: KxmTuiPanelState,
  sections: readonly KxmTuiSectionView[],
  decoded: KxmTuiInput,
): KxmTuiPanelStep {
  const section = sections[state.sectionIndex];
  const field = currentField(sections, state);

  if (decoded.kind === "ctrlC") {
    if (field?.busy && section) {
      return invokeEffect(state, section, field, KXM_TUI_ABORT_ACTION);
    }
    return { state, effects: [{ type: "quit" }] };
  }
  if (!section) return { state, effects: [{ type: "quit" }] };
  if (state.mode === "edit") return reduceEdit(state, section, field, decoded);
  if (state.mode === "choices") return reduceChoices(state, section, field, decoded);
  return reduceBrowse(state, sections, section, field, decoded);
}

/** Byte offset just before the caret, for slicing a surrogate-safe draft. */
function caretSource(text: string, caret: number): number {
  return Array.from(text).slice(0, caret).join("").length;
}

function reduceEdit(
  state: KxmTuiPanelState,
  section: KxmTuiSectionView,
  field: KxmTuiField | undefined,
  decoded: KxmTuiInput,
): KxmTuiPanelStep {
  if (!field) return { state: { ...state, mode: "browse" }, effects: [] };
  switch (decoded.kind) {
    case "escape":
      return { state: { ...state, mode: "browse", draft: "", caret: 0 }, effects: [] };
    case "enter": {
      const value = normalizeInputText(state.draft).trim();
      if (!value) return { state: { ...state, mode: "browse", draft: "", caret: 0 }, effects: [] };
      const step = invokeEffect(state, section, field, KXM_TUI_SET_ACTION, value);
      return { state: { ...step.state, mode: "browse", draft: "", caret: 0 }, effects: step.effects };
    }
    case "backspace": {
      if (state.caret === 0) return { state, effects: [] };
      const cut = caretSource(state.draft, state.caret);
      const before = deleteBackward(state.draft.slice(0, cut));
      const draft = `${before}${state.draft.slice(cut)}`;
      return { state: { ...state, draft, caret: Array.from(before).length }, effects: [] };
    }
    case "delete": {
      const units = Array.from(state.draft);
      const text = [...units.slice(0, state.caret), ...units.slice(state.caret + 1)].join("");
      return { state: { ...state, draft: text }, effects: [] };
    }
    case "left":
      return { state: { ...state, caret: Math.max(0, state.caret - 1) }, effects: [] };
    case "right":
      return { state: { ...state, caret: Math.min(Array.from(state.draft).length, state.caret + 1) }, effects: [] };
    case "home":
      return { state: { ...state, caret: 0 }, effects: [] };
    case "end":
      return { state: { ...state, caret: Array.from(state.draft).length }, effects: [] };
    case "text": {
      const text = decoded.text ?? "";
      if (!text) return { state, effects: [] };
      const inserted = insertAt(state.draft, state.caret, text);
      return { state: { ...state, draft: inserted.text, caret: inserted.caret }, effects: [] };
    }
    default:
      return { state, effects: [] };
  }
}

function reduceChoices(
  state: KxmTuiPanelState,
  section: KxmTuiSectionView,
  field: KxmTuiField | undefined,
  decoded: KxmTuiInput,
): KxmTuiPanelStep {
  if (!field) return { state: { ...state, mode: "browse" }, effects: [] };
  const choices = visibleChoices(field, state.filter);
  switch (decoded.kind) {
    case "escape":
      return { state: { ...state, mode: "browse", filter: "", filtering: false, choiceIndex: 0 }, effects: [] };
    case "up":
      return { state: moveChoice(state, choices.length, -1), effects: [] };
    case "down":
      return { state: moveChoice(state, choices.length, 1), effects: [] };
    case "pageUp":
      return { state: moveChoice(state, choices.length, -8), effects: [] };
    case "pageDown":
      return { state: moveChoice(state, choices.length, 8), effects: [] };
    case "enter": {
      const choice = choiceAt(field, state);
      if (!choice) return { state, effects: [] };
      if (choice.status === "blocked") {
        return { state, effects: [{ type: "notice", message: choice.statusText ?? `${choice.label} is unavailable` }] };
      }
      const clearing = (choice.action ?? KXM_TUI_SET_ACTION) === KXM_TUI_CLEAR_ACTION;
      const step = invokeEffect(
        state,
        section,
        field,
        choice.action ?? KXM_TUI_SET_ACTION,
        clearing ? undefined : choice.id,
      );
      return { state: { ...step.state, mode: "browse", filter: "", filtering: false }, effects: step.effects };
    }
    case "backspace": {
      if (state.filter.length === 0) return { state: { ...state, filtering: false }, effects: [] };
      return { state: { ...state, filter: deleteBackward(state.filter), choiceIndex: 0 }, effects: [] };
    }
    case "text": {
      const text = normalizeInputText(decoded.text ?? "");
      if (!text) return { state, effects: [] };
      return { state: { ...state, filtering: true, filter: `${state.filter}${text}`, choiceIndex: 0 }, effects: [] };
    }
    default:
      return { state, effects: [] };
  }
}

function reduceBrowse(
  state: KxmTuiPanelState,
  sections: readonly KxmTuiSectionView[],
  section: KxmTuiSectionView,
  field: KxmTuiField | undefined,
  decoded: KxmTuiInput,
): KxmTuiPanelStep {
  if (state.help && (decoded.kind === "escape" || decoded.kind === "enter")) {
    return { state: { ...state, help: false }, effects: [] };
  }
  if (state.help) return { state, effects: [] };

  if (decoded.kind === "text") {
    const key = decoded.text ?? "";
    if (key === "q") return { state, effects: [{ type: "quit" }] };
    if (key === "h" || key === "?") return { state: { ...state, help: true }, effects: [] };
    const action = field?.actions?.find((candidate) => candidate.key === key);
    if (action && field) return invokeEffect(state, section, field, action.action);
    if ((key === "x" || key === "d") && field && field.value !== undefined && field.kind !== "info") {
      return invokeEffect(state, section, field, KXM_TUI_CLEAR_ACTION);
    }
    if (PANE_KEYS.has(key)) {
      if (key === "h") return { state: { ...state, pane: "sections" }, effects: [] };
      if (key === "l") return { state: { ...state, pane: "fields" }, effects: [] };
      const delta = key === "k" ? -1 : 1;
      return {
        state: state.pane === "fields" ? moveField(state, section.fields, delta) : moveSection(state, sections, delta),
        effects: [],
      };
    }
    return { state, effects: [] };
  }

  switch (decoded.kind) {
    case "escape":
      return state.pane === "fields"
        ? { state: { ...state, pane: "sections", mode: "browse" }, effects: [] }
        : { state, effects: [{ type: "quit" }] };
    case "tab":
      return { state: { ...state, pane: state.pane === "fields" ? "sections" : "fields" }, effects: [] };
    case "right":
      return { state: { ...state, pane: "fields" }, effects: [] };
    case "left":
      return { state: { ...state, pane: "sections" }, effects: [] };
    case "up":
      return { state: state.pane === "fields" ? moveField(state, section.fields, -1) : moveSection(state, sections, -1), effects: [] };
    case "down":
      return { state: state.pane === "fields" ? moveField(state, section.fields, 1) : moveSection(state, sections, 1), effects: [] };
    case "pageUp":
      return { state: moveSection(state, sections, -1), effects: [] };
    case "pageDown":
      return { state: moveSection(state, sections, 1), effects: [] };
    case "enter":
      return state.pane === "fields" ? enterField(state, section, field) : { state: { ...state, pane: "fields" }, effects: [] };
    default:
      return { state, effects: [] };
  }
}
