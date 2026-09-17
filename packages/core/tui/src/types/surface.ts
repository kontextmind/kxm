/**
 * Shared declarative contract for KXM terminal surfaces.
 *
 * A surface is described, not drawn: an owner publishes sections and fields,
 * one renderer draws them all, and the owner still performs every write. That
 * keeps the panel from ever becoming a second source of truth for project,
 * roster, route, gate, role, or workflow configuration.
 *
 * Shapes are derived from the reviewed `doompi` config-panel pattern
 * (`SPC e c`), narrowed for this repository's fail-closed rules: values here
 * are validated before rendering, an unknown kind is refused rather than
 * guessed, and a rejected edit is reported back on the field that caused it.
 *
 * Bounds are protocol limits, not suggestions. Oversized payloads are
 * `invalid` so a surface cannot be used to exfiltrate a huge dump through a
 * terminal pane.
 */

export const KXM_TUI_CONTRACT_SCHEMA = "kxm.tui-contract.v1" as const;

export type KxmTuiFieldKind = "text" | "enum" | "choice" | "info";
export type KxmTuiStatus = "ready" | "available" | "blocked";
export type KxmTuiStepState = "pending" | "satisfied" | "running" | "done" | "failed";
export type KxmTuiNoticeLevel = "info" | "error";

export const KXM_TUI_FIELD_KINDS: readonly KxmTuiFieldKind[] = ["text", "enum", "choice", "info"];
export const KXM_TUI_STATUSES: readonly KxmTuiStatus[] = ["ready", "available", "blocked"];
export const KXM_TUI_STEP_STATES: readonly KxmTuiStepState[] = ["pending", "satisfied", "running", "done", "failed"];
export const KXM_TUI_NOTICE_LEVELS: readonly KxmTuiNoticeLevel[] = ["info", "error"];

/** Actions the panel offers on the focused field, sent back verbatim. */
export const KXM_TUI_SET_ACTION = "set";
export const KXM_TUI_CLEAR_ACTION = "clear";
export const KXM_TUI_ABORT_ACTION = "abort";

export const KXM_TUI_LIMITS = Object.freeze({
  sourceMax: 128,
  idMax: 128,
  choiceIdMax: 256,
  labelMax: 48,
  choiceLabelMax: 96,
  detailMax: 240,
  shortDetailMax: 96,
  stepDetailMax: 160,
  statusTextMax: 240,
  valueMax: 4096,
  keyPathMax: 128,
  outputLineMax: 512,
  outputMaxLines: 64,
  choicesMax: 128,
  actionsMax: 4,
  stepsMax: 24,
  fieldsMax: 64,
  sectionsMax: 32,
  orderMax: 1000,
});

const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;
const SOURCE_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9@/._:-]*$/;
const KEY_PATH_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.[\]-]*$/;
const ACTION_KEY_PATTERN = /^[A-Za-z0-9]$/;

/** One reason a published surface was refused. Renderers never see partial data. */
export interface KxmTuiIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface KxmTuiChoice {
  /** The value a selection writes. For models this is the full `provider/id`. */
  readonly id: string;
  readonly label: string;
  /** Right-aligned by the renderer: sizes, prices, provider names. */
  readonly detail?: string;
  /** A heading the cursor skips over, e.g. the provider of a model. */
  readonly group?: string;
  readonly status?: KxmTuiStatus;
  readonly statusText?: string;
  /** What Enter does here. A model that must be fetched carries its own action. */
  readonly action?: string;
}

export interface KxmTuiAction {
  readonly key: string;
  readonly label: string;
  readonly action: string;
}

export interface KxmTuiStep {
  readonly label: string;
  readonly state: KxmTuiStepState;
  readonly detail?: string;
}

export interface KxmTuiProgress {
  readonly label: string;
  /** 0..1. Omitted when the work has no measurable total. */
  readonly ratio?: number;
}

export interface KxmTuiField {
  readonly id: string;
  readonly label: string;
  readonly kind: KxmTuiFieldKind;
  /** Absent means unset; the renderer shows `placeholder` instead. */
  readonly value?: string;
  readonly placeholder?: string;
  readonly detail?: string;
  /** The configuration key this writes, shown so the file stays legible. */
  readonly keyPath?: string;
  /** When the underlying value was last read or written, as an ISO timestamp. */
  readonly updatedAt?: string;
  readonly status?: KxmTuiStatus;
  /** Doubles as the error line: a rejected edit returns as old value plus this. */
  readonly statusText?: string;
  readonly choices?: readonly KxmTuiChoice[];
  readonly actions?: readonly KxmTuiAction[];
  /** Work is running; the field dims and offers abort. */
  readonly busy?: boolean;
  readonly progress?: KxmTuiProgress;
  readonly steps?: readonly KxmTuiStep[];
  /** Tail of a running command's output, newest last. */
  readonly output?: readonly string[];
  /** The command is waiting for a typed line. */
  readonly awaitingInput?: boolean;
}

export interface KxmTuiSection {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly order: number;
  /** Section-wide state: readiness, or why a write failed. */
  readonly notice?: string;
  readonly noticeLevel?: KxmTuiNoticeLevel;
  readonly fields: readonly KxmTuiField[];
}

/** A section as published by a named owner. */
export interface KxmTuiSectionView extends KxmTuiSection {
  readonly source: string;
}

export interface KxmTuiInvocation {
  readonly source: string;
  readonly sectionId: string;
  readonly fieldId: string;
  readonly action: string;
  readonly value?: string;
}

function issue(path: string, code: string, message: string): KxmTuiIssue {
  return { path, code, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(issues: KxmTuiIssue[], path: string, value: unknown, max: number, required: boolean): void {
  if (value === undefined) {
    if (required) issues.push(issue(path, "required", `${path} is required`));
    return;
  }
  if (typeof value !== "string" || value.length === 0) {
    issues.push(issue(path, "invalid_string", `${path} must be a non-empty string`));
    return;
  }
  if (value.length > max) {
    issues.push(issue(path, "too_long", `${path} exceeds ${max} characters`));
    return;
  }
  // Escape and control bytes must never reach a pane: they would break the
  // per-line SGR reset the renderer relies on.
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/u.test(value)) {
    issues.push(issue(path, "control_character", `${path} must not contain control characters`));
  }
}

function optionalEnum(issues: KxmTuiIssue[], path: string, value: unknown, allowed: readonly string[]): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !allowed.includes(value)) {
    issues.push(issue(path, "invalid_choice", `${path} must be one of ${allowed.join(", ")}`));
  }
}

function ratioField(issues: KxmTuiIssue[], path: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    issues.push(issue(path, "invalid_ratio", `${path} must be a finite number between 0 and 1`));
  }
}

function validateChoice(issues: KxmTuiIssue[], path: string, raw: unknown): void {
  if (!isPlainObject(raw)) {
    issues.push(issue(path, "invalid_object", `${path} must be an object`));
    return;
  }
  boundedText(issues, `${path}.id`, raw.id, KXM_TUI_LIMITS.choiceIdMax, true);
  if (typeof raw.id === "string" && /[\s]/u.test(raw.id)) {
    issues.push(issue(`${path}.id`, "invalid_choice_id", `${path}.id must not contain whitespace`));
  }
  boundedText(issues, `${path}.label`, raw.label, KXM_TUI_LIMITS.choiceLabelMax, true);
  boundedText(issues, `${path}.detail`, raw.detail, KXM_TUI_LIMITS.shortDetailMax, false);
  boundedText(issues, `${path}.group`, raw.group, KXM_TUI_LIMITS.shortDetailMax, false);
  boundedText(issues, `${path}.statusText`, raw.statusText, KXM_TUI_LIMITS.shortDetailMax, false);
  boundedText(issues, `${path}.action`, raw.action, KXM_TUI_LIMITS.idMax, false);
  optionalEnum(issues, `${path}.status`, raw.status, KXM_TUI_STATUSES);
}

function validateAction(issues: KxmTuiIssue[], path: string, raw: unknown): void {
  if (!isPlainObject(raw)) {
    issues.push(issue(path, "invalid_object", `${path} must be an object`));
    return;
  }
  if (typeof raw.key !== "string" || !ACTION_KEY_PATTERN.test(raw.key)) {
    issues.push(issue(`${path}.key`, "invalid_action_key", `${path}.key must be a single alphanumeric key`));
  }
  boundedText(issues, `${path}.label`, raw.label, KXM_TUI_LIMITS.shortDetailMax, true);
  boundedText(issues, `${path}.action`, raw.action, KXM_TUI_LIMITS.idMax, true);
}

function validateStep(issues: KxmTuiIssue[], path: string, raw: unknown): void {
  if (!isPlainObject(raw)) {
    issues.push(issue(path, "invalid_object", `${path} must be an object`));
    return;
  }
  boundedText(issues, `${path}.label`, raw.label, KXM_TUI_LIMITS.shortDetailMax, true);
  boundedText(issues, `${path}.detail`, raw.detail, KXM_TUI_LIMITS.stepDetailMax, false);
  optionalEnum(issues, `${path}.state`, raw.state, KXM_TUI_STEP_STATES);
  if (raw.state === undefined) issues.push(issue(`${path}.state`, "required", `${path}.state is required`));
}

function validateField(issues: KxmTuiIssue[], path: string, raw: unknown): void {
  if (!isPlainObject(raw)) {
    issues.push(issue(path, "invalid_object", `${path} must be an object`));
    return;
  }
  boundedText(issues, `${path}.id`, raw.id, KXM_TUI_LIMITS.idMax, true);
  if (typeof raw.id === "string" && !ID_PATTERN.test(raw.id)) {
    issues.push(issue(`${path}.id`, "invalid_id", `${path}.id must match ${ID_PATTERN}`));
  }
  boundedText(issues, `${path}.label`, raw.label, KXM_TUI_LIMITS.labelMax, true);
  if (raw.kind === undefined) {
    issues.push(issue(`${path}.kind`, "required", `${path}.kind is required`));
  } else {
    optionalEnum(issues, `${path}.kind`, raw.kind, KXM_TUI_FIELD_KINDS);
  }
  boundedText(issues, `${path}.value`, raw.value, KXM_TUI_LIMITS.valueMax, false);
  boundedText(issues, `${path}.placeholder`, raw.placeholder, KXM_TUI_LIMITS.shortDetailMax, false);
  boundedText(issues, `${path}.detail`, raw.detail, KXM_TUI_LIMITS.detailMax, false);
  boundedText(issues, `${path}.statusText`, raw.statusText, KXM_TUI_LIMITS.statusTextMax, false);
  if (raw.updatedAt !== undefined) {
    boundedText(issues, `${path}.updatedAt`, raw.updatedAt, 64, false);
    if (typeof raw.updatedAt === "string" && !Number.isFinite(Date.parse(raw.updatedAt))) {
      issues.push(issue(`${path}.updatedAt`, "invalid_timestamp", `${path}.updatedAt must be an ISO timestamp`));
    }
  }
  optionalEnum(issues, `${path}.status`, raw.status, KXM_TUI_STATUSES);
  if (raw.keyPath !== undefined) {
    boundedText(issues, `${path}.keyPath`, raw.keyPath, KXM_TUI_LIMITS.keyPathMax, false);
    if (typeof raw.keyPath === "string" && !KEY_PATH_PATTERN.test(raw.keyPath)) {
      issues.push(issue(`${path}.keyPath`, "invalid_key_path", `${path}.keyPath must be a dotted config key`));
    }
  }
  for (const listKey of ["busy", "awaitingInput"] as const) {
    if (raw[listKey] !== undefined && typeof raw[listKey] !== "boolean") {
      issues.push(issue(`${path}.${listKey}`, "invalid_boolean", `${path}.${listKey} must be a boolean`));
    }
  }
  if (raw.progress !== undefined) {
    if (!isPlainObject(raw.progress)) {
      issues.push(issue(`${path}.progress`, "invalid_object", `${path}.progress must be an object`));
    } else {
      boundedText(issues, `${path}.progress.label`, raw.progress.label, KXM_TUI_LIMITS.shortDetailMax, true);
      ratioField(issues, `${path}.progress.ratio`, raw.progress.ratio);
    }
  }
  for (const [listKey, max, check] of [
    ["choices", KXM_TUI_LIMITS.choicesMax, validateChoice],
    ["actions", KXM_TUI_LIMITS.actionsMax, validateAction],
    ["steps", KXM_TUI_LIMITS.stepsMax, validateStep],
  ] as const) {
    const list = raw[listKey];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > max) {
      issues.push(issue(`${path}.${listKey}`, "invalid_list", `${path}.${listKey} must be an array of at most ${max}`));
      continue;
    }
    list.forEach((entry, index) => check(issues, `${path}.${listKey}[${index}]`, entry));
  }
  const output = raw.output;
  if (output !== undefined) {
    if (!Array.isArray(output) || output.length > KXM_TUI_LIMITS.outputMaxLines) {
      issues.push(issue(`${path}.output`, "invalid_list", `${path}.output must be an array of at most ${KXM_TUI_LIMITS.outputMaxLines} lines`));
    } else {
      output.forEach((line, index) => {
        if (typeof line !== "string") issues.push(issue(`${path}.output[${index}]`, "invalid_string", "output lines must be strings"));
        else if (line.length > KXM_TUI_LIMITS.outputLineMax) issues.push(issue(`${path}.output[${index}]`, "too_long", "output line is too long"));
      });
    }
  }
}

function validateSection(issues: KxmTuiIssue[], path: string, raw: unknown): void {
  if (!isPlainObject(raw)) {
    issues.push(issue(path, "invalid_object", `${path} must be an object`));
    return;
  }
  boundedText(issues, `${path}.id`, raw.id, KXM_TUI_LIMITS.idMax, true);
  if (typeof raw.id === "string" && !ID_PATTERN.test(raw.id)) {
    issues.push(issue(`${path}.id`, "invalid_id", `${path}.id must match ${ID_PATTERN}`));
  }
  boundedText(issues, `${path}.title`, raw.title, KXM_TUI_LIMITS.labelMax, true);
  boundedText(issues, `${path}.detail`, raw.detail, KXM_TUI_LIMITS.shortDetailMax, false);
  boundedText(issues, `${path}.notice`, raw.notice, KXM_TUI_LIMITS.detailMax, false);
  optionalEnum(issues, `${path}.noticeLevel`, raw.noticeLevel, KXM_TUI_NOTICE_LEVELS);
  if (typeof raw.order !== "number" || !Number.isInteger(raw.order) || raw.order < 0 || raw.order > KXM_TUI_LIMITS.orderMax) {
    issues.push(issue(`${path}.order`, "invalid_order", `${path}.order must be an integer between 0 and ${KXM_TUI_LIMITS.orderMax}`));
  }
  if (!Array.isArray(raw.fields) || raw.fields.length > KXM_TUI_LIMITS.fieldsMax) {
    issues.push(issue(`${path}.fields`, "invalid_list", `${path}.fields must be an array of at most ${KXM_TUI_LIMITS.fieldsMax}`));
    return;
  }
  const seen = new Set<string>();
  raw.fields.forEach((field, index) => {
    const fieldPath = `${path}.fields[${index}]`;
    validateField(issues, fieldPath, field);
    if (isPlainObject(field) && typeof field.id === "string") {
      if (seen.has(field.id)) issues.push(issue(`${fieldPath}.id`, "duplicate_id", `${field.id} is published twice in ${path}`));
      seen.add(field.id);
    }
  });
}

/** Validate a full published surface. Returns issues; an empty array is a pass. */
export function validateKxmTuiSurface(sections: unknown): KxmTuiIssue[] {
  if (!Array.isArray(sections)) return [issue("sections", "invalid_list", "sections must be an array")];
  if (sections.length > KXM_TUI_LIMITS.sectionsMax) {
    return [issue("sections", "too_many", `sections must number at most ${KXM_TUI_LIMITS.sectionsMax}`)];
  }
  const issues: KxmTuiIssue[] = [];
  const seenSources = new Map<string, Set<string>>();
  sections.forEach((section, index) => {
    const path = `sections[${index}]`;
    validateSection(issues, path, section);
    if (!isPlainObject(section)) return;
    boundedText(issues, `${path}.source`, section.source, KXM_TUI_LIMITS.sourceMax, true);
    if (typeof section.source === "string" && !SOURCE_PATTERN.test(section.source)) {
      issues.push(issue(`${path}.source`, "invalid_source", `${path}.source must be an addressable owner id`));
    }
    if (typeof section.source === "string" && typeof section.id === "string") {
      const ids = seenSources.get(section.source) ?? new Set<string>();
      seenSources.set(section.source, ids);
      if (ids.has(section.id)) issues.push(issue(`${path}.id`, "duplicate_section", `${section.source}/${section.id} is published twice`));
      ids.add(section.id);
    }
  });
  return issues;
}

/** Throwing variant for owners that must not publish a half-valid surface. */
export function assertKxmTuiSurface(sections: unknown): KxmTuiSectionView[] {
  const issues = validateKxmTuiSurface(sections);
  if (issues.length > 0) {
    const first = issues[0]!;
    throw new Error(`kxm tui surface refused (${issues.length} issue(s)): ${first.path} ${first.code}: ${first.message}`);
  }
  return (sections as unknown[]).slice().sort((a, b) => sectionOrder(a) - sectionOrder(b)) as KxmTuiSectionView[];
}

function sectionOrder(value: unknown): number {
  return isPlainObject(value) && typeof value.order === "number" ? value.order : Number.MAX_SAFE_INTEGER;
}

/** `info` rows are labels, so the cursor never rests on one. */
export function isSelectableField(field: KxmTuiField | undefined): boolean {
  return field !== undefined && field.kind !== "info";
}

/** Whether a field can be entered for editing or a choice list. */
export function fieldIsEditable(field: KxmTuiField | undefined): boolean {
  if (!isSelectableField(field)) return false;
  const editable = field as KxmTuiField;
  return editable.kind === "text" || editable.kind === "enum" || (editable.kind === "choice" && (editable.choices?.length ?? 0) > 0);
}

/** Choices sorted into display groups, in first-seen order. */
export function groupedKxmTuiChoices(field: KxmTuiField): { readonly group: string; readonly choices: readonly KxmTuiChoice[] }[] {
  const choices = field.choices ?? [];
  if (choices.length === 0) return [];
  if (choices.every((choice) => choice.group === undefined)) return [{ group: "", choices }];
  const groups: { group: string; choices: KxmTuiChoice[] }[] = [];
  const index = new Map<string, KxmTuiChoice[]>();
  for (const choice of choices) {
    const group = choice.group ?? "";
    let bucket = index.get(group);
    if (!bucket) {
      bucket = [];
      index.set(group, bucket);
      groups.push({ group, choices: bucket });
    }
    bucket.push(choice);
  }
  return groups;
}
